/**
 * Handles Vapi's two server message types relevant to us:
 *  - "tool-calls": Everly invoked one of the function tools mid-call
 *  - "end-of-call-report": the call ended; transcript/recording/summary arrive here
 *
 * Payload shapes verified against docs.vapi.ai/server-url/events.
 *
 * loadId/carrierId/callAttemptId are never trusted from the LLM's tool-call
 * arguments (see comment in src/assistant/tools.ts) — they're resolved here
 * from the CallAttempt matching the webhook's vapiCallId instead.
 *
 * STATUS (2026-08-06): all tools write through to MDR's real API (see
 * src/mdr/api.ts). calculate_quote/submit_quote map to call-result/
 * call-final-result respectively — see the Quote model's header comment for
 * how a quote record is built up across the two calls. The stop-condition
 * re-check after a tool call is still disabled — that belongs to the
 * orchestration-flow rebuild, not this file.
 */
import { CallAttempt, Quote, Carrier } from "../db/models/index.js";
import { applyCallOutcome, formatDurationMmSs, mapToMdrCallLogStatus } from "./callOutcome.js";
import { MAX_CALL_ATTEMPTS } from "./cadence.js";
import { isWithinCallingWindow, isValidTimezone, formatCallingWindow, wallClockToUtc } from "./callingWindow.js";
import {
  declineCarrier as mdrDeclineCarrier,
  stopCarrier as mdrStopCarrier,
  resendInvitationEmail as mdrResendInvitationEmail,
  addAccessorial as mdrAddAccessorial,
  addWarehouse as mdrAddWarehouse,
  submitCallResult as mdrSubmitCallResult,
  submitCallFinalResult as mdrSubmitCallFinalResult,
  submitCallLog as mdrSubmitCallLog,
} from "../mdr/api.js";
import { ORCHESTRATION_WEBHOOK_URL } from "../assistant/tools.js";
import type { HydratedDocument } from "mongoose";

/**
 * Builds the publicly-playable recording URL sent to MDR in the Call Log
 * API's data.recording_url — see recordings.ts's header comment for why the
 * raw CallAttempt.recordingUrl (a private R2 path) can't be used directly.
 * Derives the base from ORCHESTRATION_WEBHOOK_URL (same public host Vapi
 * already calls back into) rather than a separate env var.
 */
function buildPlayableRecordingUrl(vapiCallId: string): string {
  const base = new URL(ORCHESTRATION_WEBHOOK_URL).origin;
  const key = process.env.TEST_DISPATCH_API_KEY ?? "";
  return `${base}/recordings/${vapiCallId}?key=${key}`;
}

/** "lane_not_serviced" -> "Lane not serviced" — MDR's reason fields are free text, not our fixed enum. */
export function humanizeReason(reason: string): string {
  const text = reason.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type ToolCall = { id: string; name: string; parameters: Record<string, any> };
type CallContext = { attempt: HydratedDocument<any> };

export async function handleToolCalls(toolCallList: ToolCall[], vapiCallId: string) {
  const attempt = await CallAttempt.findOne({ vapiCallId });
  if (!attempt) {
    console.warn(`No CallAttempt found for vapiCallId ${vapiCallId} — cannot resolve call context`);
    return toolCallList.map((call) => ({
      toolCallId: call.id,
      name: call.name,
      result: JSON.stringify({ error: "Unknown call — no matching CallAttempt" }),
    }));
  }

  const context: CallContext = { attempt };
  const results = [];
  for (const call of toolCallList) {
    try {
      const result = await dispatchTool(call.name, call.parameters, context);
      results.push({ toolCallId: call.id, name: call.name, result: JSON.stringify(result) });
    } catch (err) {
      // Previously silent — a real submit_quote failure (server 404 during a
      // dispatch cron collision, 2026-07-25) went completely unlogged here,
      // discoverable only via Vapi's own call message history days later.
      console.error(`Tool call ${call.name} failed for vapiCallId ${vapiCallId}:`, err);
      results.push({
        toolCallId: call.id,
        name: call.name,
        result: JSON.stringify({ error: (err as Error).message }),
      });
    }
  }
  return results;
}

async function dispatchTool(name: string, params: Record<string, any>, context: CallContext) {
  switch (name) {
    case "calculate_quote":
      return calculateQuote(params, context);
    case "submit_quote":
      return submitQuote(params, context);
    case "log_decline":
      return logDecline(params, context);
    case "schedule_callback":
      return scheduleCallback(params, context);
    case "record_do_not_call":
      return recordDoNotCall(params, context);
    case "resend_email":
      return resendEmail(params, context);
    case "confirm_email_quote":
      return confirmEmailQuote(params, context);
    case "resume_phone_quote":
      return resumePhoneQuote(params, context);
    case "add_accessorial":
      return addAccessorialTool(params, context);
    case "add_warehouse":
      return addWarehouseTool(params, context);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Defensive coercion for numeric fields the LLM supplies. The tool schema
 * says "number", but that's not runtime-enforced — a stringified value
 * (or a missing one) must throw here rather than silently reach MDR as
 * NaN, which JSON.stringify turns into a bare `null` with no error at all.
 */
function toNumber(value: unknown, fieldName: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid numeric value for ${fieldName}: ${JSON.stringify(value)}`);
  }
  return num;
}

function toOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return toNumber(value, fieldName);
}

/** MDR's is_warehouse/all_in fields are strictly 0 or 1, not just "any number." */
function toBinaryFlag(value: unknown, fieldName: string): 0 | 1 {
  const num = toNumber(value, fieldName);
  if (num !== 0 && num !== 1) {
    throw new Error(`Invalid value for ${fieldName}: expected 0 or 1, got ${JSON.stringify(value)}`);
  }
  return num;
}

/** Coerced/validated calculate_quote / submit_quote fields — shared shape both MDR and the local Quote record derive from. */
function parseQuoteFields(params: any) {
  return {
    base_rate: toNumber(params.base_rate, "base_rate"),
    fsc: toNumber(params.fsc, "fsc"),
    acc_types: Array.isArray(params.acc_types)
      ? params.acc_types.map((id: unknown, i: number) => toNumber(id, `acc_types[${i}]`))
      : [],
    transload_rate: toOptionalNumber(params.transload_rate, "transload_rate"),
    finalmile_rate: toOptionalNumber(params.finalmile_rate, "finalmile_rate"),
    finalmile_fsc: toOptionalNumber(params.finalmile_fsc, "finalmile_fsc"),
    is_warehouse: toBinaryFlag(params.is_warehouse, "is_warehouse"),
    storage_rate: toOptionalNumber(params.storage_rate, "storage_rate"),
    warehouse_id: toOptionalNumber(params.warehouse_id, "warehouse_id"),
    rate_valid_until: String(params.rate_valid_until ?? ""),
    driver_available: String(params.driver_available ?? ""),
    details: params.details ? String(params.details) : undefined,
  };
}

type ParsedQuoteFields = ReturnType<typeof parseQuoteFields>;

/** Maps parsed calculate_quote/submit_quote fields to MDR's call-result/call-final-result request shape. */
function buildQuotePayload(outreachId: number, fields: ParsedQuoteFields) {
  return { outreach_id: outreachId, ...fields };
}

/** Same fields, reshaped for the local Quote record (camelCase, no outreach_id). */
function buildLocalQuoteFields(fields: ParsedQuoteFields) {
  return {
    baseRate: fields.base_rate,
    fsc: fields.fsc,
    accTypes: fields.acc_types,
    transloadRate: fields.transload_rate,
    finalmileRate: fields.finalmile_rate,
    finalmileFsc: fields.finalmile_fsc,
    isWarehouse: fields.is_warehouse,
    storageRate: fields.storage_rate,
    warehouseId: fields.warehouse_id,
    rateValidUntil: fields.rate_valid_until,
    driverAvailable: fields.driver_available,
    details: fields.details,
  };
}

async function calculateQuote(params: any, { attempt }: CallContext) {
  // No fallback here — the whole point of this call is MDR's calculated
  // total, so a failure has to be visible to Everly, not swallowed. This
  // includes toNumber() throwing on a malformed field — better to surface
  // that to Everly (who can re-ask/retry) than send bad data to MDR.
  const fields = parseQuoteFields(params);
  const result = await mdrSubmitCallResult(buildQuotePayload(Number(attempt.outreachId), fields));
  const data = result.rate_calculation.original.data;

  // Draft record, upserted per call attempt — durable proof of what was
  // calculated even if the carrier never confirms. submitQuote() below
  // updates this same record once they do.
  await Quote.findOneAndUpdate(
    { callAttemptId: attempt._id },
    {
      loadId: attempt.loadId,
      carrierId: attempt.outreachId,
      callAttemptId: attempt._id,
      ...buildLocalQuoteFields(fields),
      rateCalculation: result.rate_calculation,
      mdrQuoteId: data.quote_id,
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return {
    ok: true,
    finalRate: data.final_rate,
    breakdown: data.rate_breakdown,
    accessorialCharges: data.accessorial_charges,
  };
}

async function submitQuote(params: any, { attempt }: CallContext) {
  const fields = parseQuoteFields(params);
  const allIn = fields.acc_types.length > 0 ? 0 : 1;

  // Local audit copy first — durable proof of exactly what was captured and
  // confirmed, even if the MDR write below fails.
  const localQuote = await Quote.findOneAndUpdate(
    { callAttemptId: attempt._id },
    {
      loadId: attempt.loadId,
      carrierId: attempt.outreachId,
      callAttemptId: attempt._id,
      ...buildLocalQuoteFields(fields),
      allIn,
      carrierConfirmedReadBack: Boolean(params.carrierConfirmedReadBack),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  attempt.callResult = "quote_received";
  await attempt.save();

  try {
    await mdrSubmitCallFinalResult({ ...buildQuotePayload(Number(attempt.outreachId), fields), all_in: allIn });
    localQuote.mdrSubmissionStatus = "submitted";
    await localQuote.save();
  } catch (err) {
    console.error(`submit_quote: MDR call-final-result write-back failed for carrier ${attempt.outreachId}:`, err);
    localQuote.mdrSubmissionStatus = "failed";
    localQuote.mdrError = (err as Error).message;
    await localQuote.save();
    // Unlike log_decline/record_do_not_call — where the local capture IS
    // the durable source of truth regardless of MDR sync — the entire
    // point of submit_quote is the MDR record itself; the broker reviews
    // quotes there, not our local DB. `ok: true` here would tell the LLM
    // this succeeded (a real call showed it doing exactly that: declaring
    // "I'm submitting your quote" to the carrier despite this failing) and
    // violate the prompt's own "never claim success on a failed tool call"
    // rule. ok: false makes the failure impossible for the LLM to miss.
    return { ok: false, error: "MDR submission failed", mdrSync: "failed", quoteId: localQuote.id };
  }

  // A carrier who's successfully quoted this load has no reason to be
  // called again for it — same reasoning as log_decline/record_do_not_call/
  // resend_email: without this, dispatch.ts's cadence has nothing that
  // knows a quote already came in, so attempts 2-4 would otherwise still
  // get scheduled and dialed. Only on a successful MDR write — a failed
  // submission means no quote actually exists yet, so this carrier still
  // needs to be reachable. Best-effort, same non-blocking pattern as the
  // others.
  try {
    await Carrier.updateOne(
      { outreach_id: Number(attempt.outreachId) },
      { stop_call: true, stop_reason: "Quote submitted" }
    );
  } catch (err) {
    console.error(`submit_quote: failed to update local Carrier.stop_call for ${attempt.outreachId}:`, err);
  }

  return { ok: true, mdrSync: "ok", quoteId: localQuote.id };
}

async function logDecline(params: any, { attempt }: CallContext) {
  attempt.callResult = "declined";
  attempt.declineReason = params.reason;
  attempt.declineNote = params.note;
  await attempt.save();

  // Local record is durable regardless of MDR's API being reachable — the
  // MDR write-back is attempted but its failure doesn't erase what Everly
  // already captured on the call.
  const reasonText = params.reason === "other" && params.note ? params.note : humanizeReason(params.reason);
  let mdrSync: "ok" | "failed" = "ok";
  try {
    await mdrDeclineCarrier(Number(attempt.outreachId), reasonText);
  } catch (err) {
    console.error(`log_decline: MDR decline write-back failed for carrier ${attempt.outreachId}:`, err);
    mdrSync = "failed";
  }

  // Each local Carrier record is already scoped to one (carrier, load) pair
  // — outreach_id is the unique key, and a carrier gets a fresh outreach_id
  // per load invitation — so this only stops further attempts on THIS load,
  // not future different loads for the same company. Without this,
  // dispatch.ts's cadence has nothing that checks callResult/decline status,
  // so attempts 2-4 would otherwise still get scheduled and dialed after a
  // carrier already said no. Best-effort, same pattern as
  // record_do_not_call: dispatch.ts still re-checks fresh against MDR before
  // ever dialing, so this is belt-and-suspenders, not the sole gate.
  try {
    await Carrier.updateOne(
      { outreach_id: Number(attempt.outreachId) },
      { stop_call: true, stop_reason: reasonText }
    );
  } catch (err) {
    console.error(`log_decline: failed to update local Carrier.stop_call for ${attempt.outreachId}:`, err);
  }

  return { ok: true, mdrSync };
}

async function scheduleCallback(params: any, { attempt }: CallContext) {
  // attempt.timezone is MDR's own carrier_timezone, captured fresh when this
  // attempt was dialed (see dispatch.ts) — the authority for both parsing
  // and the window check, not carrierTimeZone (whatever the carrier says out
  // loud, only stored for reference) and not any offset embedded in
  // callbackDateTime itself (the LLM can't be trusted to get that right —
  // see wallClockToUtc's header comment). Falls back to native parsing only
  // when there's no valid stored zone to interpret wall-clock digits against.
  const hasValidTimezone = isValidTimezone(attempt.timezone);
  let proposed: Date;
  try {
    proposed = hasValidTimezone ? wallClockToUtc(params.callbackDateTime, attempt.timezone) : new Date(params.callbackDateTime);
  } catch (err) {
    throw new Error(`Invalid callbackDateTime: ${JSON.stringify(params.callbackDateTime)} (${(err as Error).message})`);
  }
  if (Number.isNaN(proposed.getTime())) {
    throw new Error(`Invalid callbackDateTime: ${JSON.stringify(params.callbackDateTime)}`);
  }

  if (hasValidTimezone && !isWithinCallingWindow(attempt.timezone, proposed)) {
    return {
      ok: false,
      error: "outside_calling_window",
      message:
        `That time is outside our calling window. We're able to call ${formatCallingWindow()}. ` +
        "Please ask for a different time within that window, then call schedule_callback again.",
    };
  }

  attempt.callResult = "callback";
  attempt.callbackAt = proposed;
  attempt.callbackTimeZone = params.carrierTimeZone;
  await attempt.save();
  return { ok: true };
}

async function recordDoNotCall(_params: any, { attempt }: CallContext) {
  attempt.callResult = "do_not_call";
  await attempt.save();

  // MDR's /voice/stop has no email-vs-calls distinction — it always means
  // "stop calling," which is also the only thing this system manages
  // (bid emails are MDR's own domain, not asked about on the call).
  const reasonText = "Requested no further calls";
  let mdrSync: "ok" | "failed" = "ok";
  try {
    await mdrStopCarrier(Number(attempt.outreachId), reasonText);
  } catch (err) {
    console.error(`record_do_not_call: MDR stop write-back failed for carrier ${attempt.outreachId}:`, err);
    mdrSync = "failed";
  }

  // Keep our own copy truthful too — dispatch.ts always re-checks fresh
  // against MDR before dialing regardless (that's the real safety gate),
  // but leaving stop_call stale here means our own DB silently drifts from
  // reality after every opt-out. Best-effort: doesn't affect the tool's
  // success if it fails.
  try {
    await Carrier.updateOne({ outreach_id: Number(attempt.outreachId) }, { stop_call: true, stop_reason: reasonText });
  } catch (err) {
    console.error(`record_do_not_call: failed to update local Carrier.stop_call for ${attempt.outreachId}:`, err);
  }

  return { ok: true, mdrSync };
}

async function resendEmail(_params: any, { attempt }: CallContext) {
  // No fallback here — unlike decline/stop, there's no local state to fall
  // back on if this fails, so let a failure propagate to handleToolCalls'
  // outer catch and get reported to Everly rather than being swallowed.
  //
  // Deliberately does NOT touch callResult/Carrier.stop_call — a resend on
  // its own is not a decision to quote by email (e.g. Opening's "haven't
  // received it" branch). See confirmEmailQuote below, which is the
  // separate tool call that actually records that decision — a real call
  // (2026-09-02) showed conflating the two (via a quoting_by_email flag on
  // this same tool) missed the "use the email I already have" case
  // entirely, since that path never calls resend_email at all.
  const result = await mdrResendInvitationEmail(Number(attempt.outreachId));
  return { ok: true, message: result.message };
}

async function confirmEmailQuote(_params: any, { attempt }: CallContext) {
  // Recorded here so this call can be told apart from a plain connected
  // call with nothing concluded — needed for MDR's own EMAIL_REQUESTED
  // call-log status at end-of-call. See mapToMdrCallLogStatus in
  // callOutcome.ts.
  attempt.callResult = "email_requested";
  await attempt.save();

  // Choosing to quote by email means this carrier isn't expecting another
  // phone call for this load — same reasoning as log_decline/
  // record_do_not_call: without this, dispatch.ts's cadence has nothing
  // that knows they already chose a different channel, so attempts 2-4
  // would otherwise still get scheduled and dialed. Best-effort — doesn't
  // affect this tool's own success if it fails, and dispatch.ts still
  // re-checks fresh against MDR before ever dialing regardless.
  try {
    await Carrier.updateOne(
      { outreach_id: Number(attempt.outreachId) },
      { stop_call: true, stop_reason: "Chose to submit quote by email" }
    );
  } catch (err) {
    console.error(`confirm_email_quote: failed to update local Carrier.stop_call for ${attempt.outreachId}:`, err);
  }

  return { ok: true };
}

async function resumePhoneQuote(_params: any, { attempt }: CallContext) {
  // Undoes confirmEmailQuote's callResult — a carrier who reverses back to
  // phone hasn't actually decided anything final yet; if a real quote gets
  // collected and submitted after this, submit_quote overwrites callResult
  // again as normal. If instead the call ends before that (e.g. it drops
  // mid-collection), clearing this back to unset lets applyCallOutcome's
  // own end-of-call fallback classify it normally (typically "connected",
  // which maps to CALL_DROPPED in MDR's call log — see
  // mapToMdrCallLogStatus) instead of leaving the stale "email_requested"
  // value from the decision they walked back. Per client direction
  // (2026-09-02): only report EMAIL_REQUESTED for an actual final decision
  // to quote by email, never a reversed one.
  attempt.callResult = undefined;
  await attempt.save();

  // Symmetric with confirmEmailQuote's stop_call flip — they may still get
  // a real quote submitted on a future automated attempt if this call
  // doesn't finish one, so don't leave them marked as having chosen a
  // different channel. Best-effort, same reasoning as confirmEmailQuote.
  try {
    await Carrier.updateOne(
      { outreach_id: Number(attempt.outreachId) },
      { stop_call: false, stop_reason: null }
    );
  } catch (err) {
    console.error(`resume_phone_quote: failed to reset local Carrier.stop_call for ${attempt.outreachId}:`, err);
  }

  return { ok: true };
}

async function addAccessorialTool(params: any, { attempt }: CallContext) {
  // Same reasoning as resendEmail — the whole point of this call is the
  // MDR-assigned id; a failure has to be visible, not silently absorbed.
  const price = toNumber(params.price, "price");
  const result = await mdrAddAccessorial(Number(attempt.outreachId), params.name, price);
  return { ok: true, accessorial: result.accessorials };
}

async function addWarehouseTool(params: any, { attempt }: CallContext) {
  const result = await mdrAddWarehouse(Number(attempt.outreachId), params.address);
  return { ok: true, warehouse: result.warehouse };
}

export async function handleEndOfCallReport(message: any) {
  const vapiCallId = message.call?.id;
  const attempt = await CallAttempt.findOne({ vapiCallId });
  if (!attempt) {
    console.warn(`No CallAttempt found for vapiCallId ${vapiCallId} — ignoring end-of-call-report`);
    return;
  }

  applyCallOutcome(attempt, {
    endedReason: message.endedReason,
    transcript: message.artifact?.transcript,
    recordingUrl: message.artifact?.recording?.stereoUrl,
    summary: message.summary ?? message.analysis?.summary,
    // Vapi's OWN call-connect/call-end timestamps, not this webhook's
    // arrival time — see computeDurationSeconds in callOutcome.ts.
    vapiStartedAt: message.startedAt,
    vapiEndedAt: message.endedAt,
  });

  await attempt.save();

  // MDR's Call Log API (spec received 2026-08-27) — logs ended calls to
  // MDR's own system, restricted to their fixed 6-value status vocabulary
  // (see mapToMdrCallLogStatus's header comment for what's covered and
  // what's deliberately skipped). Fires for /test/dispatch calls too (same
  // handleEndOfCallReport path, no special-casing) per explicit
  // instruction. Best-effort: MDR's own logging is auxiliary, must never
  // block or fail this webhook's own processing above.
  //
  // Guarded by mdrCallLogSubmittedAt so this only ever fires once per call —
  // this whole handler is fully awaited before responding 200 to Vapi, so a
  // slow response here could cause Vapi to retry the same end-of-call-report
  // webhook and re-run this function for the same call.
  if (attempt.mdrCallLogSubmittedAt) {
    console.log(`end-of-call-report: call log already submitted to MDR for outreach_id ${attempt.outreachId} at ${attempt.mdrCallLogSubmittedAt.toISOString()} — skipping duplicate push`);
  } else {
    const mdrCallLogStatus = mapToMdrCallLogStatus(attempt);
    if (mdrCallLogStatus) {
      try {
        const result = await mdrSubmitCallLog({
          outreach_id: Number(attempt.outreachId),
          call_id: vapiCallId,
          status: mdrCallLogStatus,
          duration: formatDurationMmSs(attempt.durationSeconds ?? 0),
          data: {
            direction: "outbound",
            started_at: message.startedAt,
            ended_at: message.endedAt,
            // Not attempt.recordingUrl directly — that's a private R2 path
            // Vapi itself requires an authenticated API call to play (see
            // recordings.ts). This points at our own proxy instead, which
            // is actually playable.
            recording_url: attempt.recordingUrl ? buildPlayableRecordingUrl(vapiCallId) : undefined,
            transcript: attempt.transcript,
            provider: "vapi",
            call_result: attempt.callResult,
            ended_reason: attempt.endedReason,
          },
        });
        attempt.mdrCallLogSubmittedAt = new Date();
        await attempt.save();
        console.log(`end-of-call-report: submitted call log to MDR for outreach_id ${attempt.outreachId} (status=${mdrCallLogStatus}):`, result);
      } catch (err) {
        console.error(`end-of-call-report: failed to submit call log to MDR for outreach_id ${attempt.outreachId}:`, err);
      }
    } else {
      console.log(
        `end-of-call-report: no MDR call-log status equivalent for outreach_id ${attempt.outreachId} (status=${attempt.status}, callResult=${attempt.callResult}) — skipping call-log push`
      );
    }
  }

  // Stop-condition re-check disabled pending rebuild — see the PENDING
  // REBUILD note at the top of this file.

  // dispatch.ts's MAX_CALL_ATTEMPTS cap already stops scheduling a 5th
  // attempt on its own — this doesn't change that gating. It just makes the
  // local Carrier record honestly reflect "we're done calling this carrier
  // for this load" right away, instead of only becoming apparent the next
  // time someone happens to run dispatch and sees max_attempts_reached.
  // Local-only, deliberately no MDR write-through: unlike decline/opt-out/
  // quote (which are facts the carrier told us that MDR should also know),
  // running out of attempts is purely an internal cadence fact — the
  // carrier didn't say anything, so there's nothing to report to MDR.
  if (attempt.attemptNumber >= MAX_CALL_ATTEMPTS) {
    try {
      await Carrier.updateOne(
        { outreach_id: Number(attempt.outreachId) },
        { stop_call: true, stop_reason: "Max call attempts reached" }
      );
    } catch (err) {
      console.error(`end-of-call-report: failed to update local Carrier.stop_call for ${attempt.outreachId}:`, err);
    }
  }
}
