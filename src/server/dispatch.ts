/**
 * Dispatch/orchestration trigger. For each open load, for each of its
 * not-stopped carriers, freshly re-checks MDR and either skips the carrier
 * (per the rules below) or — if it's actually due, per attempt cadence and
 * calling window — PLACES A REAL OUTBOUND VAPI CALL. This has real-world
 * side effects: it rings an actual phone and costs money. Error handling
 * here is layered rather than a single top-level try/catch: one bad carrier
 * (malformed timezone, a transient MDR API failure, a DB hiccup, a failed
 * dial) must never take down the rest of the run for every other carrier and
 * load. Every failure is caught at the narrowest point it can happen, logged
 * with enough context to act on, and recorded as a result entry — never
 * silently swallowed, never left to crash the process.
 *
 * processCarrier (below) has two callers, both exercising the exact same
 * checks:
 *   - processLoad, from this file's own POST /dispatch/run route (or the
 *     — currently disabled — cron), looping every open Load's every
 *     not-stopped Carrier.
 *   - mdrWebhook.ts's POST /webhooks/mdr/capture route, calling it directly
 *     for the single (load, carrier) pair a select.carrier.irs webhook just
 *     delivered — the "instant" trigger this agent is actually built around,
 *     with no queue and no separate cycle to wait for.
 *
 * Per carrier:
 *   1. Call MDR's real "Get Select Carrier Details" endpoint fresh — local DB
 *      state can be stale by the time this runs.
 *      a. fresh.is_load_close === true → stop processing this load
 *         entirely, mark it closed locally.
 *      b. fresh.carrier.stop_call === true → skip just this carrier.
 *      c. Otherwise → compute which attempt number is next (from existing
 *         CallAttempt records) and whether it's actually due yet, per the
 *         confirmed cadence and calling window. If due: create the
 *         CallAttempt (idempotent via the loadId+carrierId+attemptNumber
 *         unique index — a duplicate-key error means another run already
 *         claimed this slot, not a real failure) and dial via Vapi.
 */
import { Router } from "express";
import { Load, Carrier, CallAttempt } from "../db/models/index.js";
import { getSelectCarrierDetails } from "../mdr/api.js";
import { computeAttemptSchedule, MAX_CALL_ATTEMPTS } from "./cadence.js";
import { isWithinCallingWindow, isValidTimezone } from "./callingWindow.js";
import { buildCallVariables } from "./callVariables.js";
import { buildCallMemory, hasMeaningfulPriorContact } from "./callMemory.js";
import { createOutboundCall } from "../vapi/calls.js";
import { FIRST_MESSAGE, FOLLOW_UP_FIRST_MESSAGE, FOLLOW_UP_UNANSWERED_FIRST_MESSAGE } from "../assistant/prompt.js";
import { env } from "../config/env.js";

export const dispatchRouter = Router();

type Result = Record<string, unknown>;

// True while a cycle (from either the HTTP route or the cron scheduler in
// server/index.ts) is in flight. Each cycle enqueues calls with Vapi rather
// than waiting on live conversations, so it's normally fast — this flag is
// just cheap insurance against a slow MDR API making two cycles overlap,
// not a fix for an observed problem. Module-level, not per-request, since
// there's only ever one dispatch process running.
let cycleInProgress = false;

/**
 * The actual orchestration cycle: for every open load, for every one of its
 * not-stopped carriers, freshly re-check MDR and either skip or dial per the
 * rules in this file's header comment. Shared by both the manual HTTP route
 * below and the cron scheduler in server/index.ts — there is exactly one
 * implementation, so the two can never drift apart. Callers decide what to
 * do with a `{ ok: false, error }` result (the route 500s; the cron job just
 * logs it) rather than this function throwing, so a skipped-cycle-while-busy
 * or a top-level DB failure is always a normal returned value, not a thrown
 * error a caller could forget to catch.
 */
export async function runDispatchCycle(dryRun: boolean): Promise<
  { ok: true; dryRun: boolean; summary: Record<string, number>; results: Result[] } | { ok: false; error: string }
> {
  if (cycleInProgress) {
    return { ok: false, error: "A dispatch cycle is already in progress — skipping this run." };
  }
  cycleInProgress = true;

  try {
    const results: Result[] = [];

    // Top-level guard: even a failure before any load-specific work starts
    // (e.g. the DB connection itself is down) must still return a normal
    // result, not throw and risk leaving cycleInProgress stuck true.
    let loads;
    try {
      // Oldest-posted loads first (FIFO). is_agent_call_on: true is a strict
      // match (not $ne: false) — safe now that the DB is being cleared, so
      // every Load from here on is a fresh insert that gets the schema's
      // true default, per src/db/models/Load.ts.
      loads = await Load.find({ is_load_close: false, is_agent_call_on: true }).sort({ createdAt: 1 });
    } catch (err) {
      console.error("dispatch: failed to fetch open loads:", err);
      return { ok: false, error: `Failed to fetch open loads: ${(err as Error).message}` };
    }

    for (const load of loads) {
      try {
        await processLoad(load, results, dryRun);
      } catch (err) {
        // Should be unreachable — processLoad has its own internal handling —
        // but if something still escapes it, this load's failure must not
        // stop the remaining loads from being processed.
        console.error(`dispatch: unexpected failure processing load ${load.id}:`, err);
        results.push({ loadId: load.id, outcome: "error", error: (err as Error).message });
      }
    }

    const summary = results.reduce<Record<string, number>>((acc, r) => {
      const outcome = String(r.outcome);
      acc[outcome] = (acc[outcome] ?? 0) + 1;
      return acc;
    }, {});

    return { ok: true, dryRun, summary, results };
  } finally {
    cycleInProgress = false;
  }
}

dispatchRouter.post("/run", async (req, res) => {
  // ?dryRun=true runs the exact same eligibility/cadence/window pipeline
  // against real data but stops just short of creating a CallAttempt or
  // touching Vapi — reports "would_dial" instead. Lets the whole decision
  // engine be verified against real carriers with zero side effects.
  const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";
  const result = await runDispatchCycle(dryRun);
  res.status(result.ok ? 200 : 500).json(result);
});

async function processLoad(load: any, results: Result[], dryRun: boolean) {
  let carriers;
  try {
    // Attempt #1 always happens instantly, straight off the select.carrier.irs
    // webhook (see mdrWebhook.ts) — by the time this cron loop ever runs, every
    // eligible carrier already has that first CallAttempt. So this cycle's job
    // isn't "find carriers to call for the first time," it's "find carriers
    // whose first call didn't resolve anything and are still active" — hence
    // the $lookup + exactly-one-attempt filter below, instead of a plain
    // Carrier.find. carrier_id being unique per Carrier document is what makes
    // matching the $lookup on outreach_id alone safe (no need to also pin
    // loadId inside it). Pipeline-style $lookup (not localField/foreignField)
    // because Carrier.outreach_id is a Number but CallAttempt.outreachId is a
    // String — a plain localField/foreignField lookup does exact BSON-type
    // matching and would silently join zero rows.
    carriers = await Carrier.aggregate([
      { $match: { load_id: load.id, stop_call: false } },
      {
        $lookup: {
          from: "callattempts",
          let: { outreachId: { $toString: "$outreach_id" } },
          pipeline: [{ $match: { $expr: { $eq: ["$outreachId", "$$outreachId"] } } }],
          as: "callAttempts",
        },
      },
      { $match: { $expr: { $eq: [{ $size: "$callAttempts" }, 1] } } },
      { $sort: { rank: 1 } },
    ]);
  } catch (err) {
    console.error(`dispatch/run: failed to fetch carriers for load ${load.id}:`, err);
    results.push({ loadId: load.id, outcome: "error", error: `Failed to fetch carriers: ${(err as Error).message}` });
    return;
  }

  for (const carrier of carriers) {
    try {
      const stop = await processCarrier(load, carrier, results, dryRun);
      if (stop) return; // load was closed — abandon the rest of this load's carriers
    } catch (err) {
      // Same belt-and-suspenders as the load-level catch above — processCarrier
      // handles its own errors, but a carrier-level surprise still can't be
      // allowed to take out the rest of the loop.
      console.error(
        `dispatch/run: unexpected failure processing carrier (load ${load.id}, outreach_id ${carrier.outreach_id}):`,
        err
      );
      results.push({
        loadId: load.id,
        outreachId: carrier.outreach_id,
        outcome: "error",
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Returns true if the load was found closed and the caller should stop
 * processing it further. Exported so mdrWebhook.ts's /capture route can call
 * this directly for the single carrier a select.carrier.irs webhook just
 * told us about, instead of only ever running via processLoad's loop.
 */
export async function processCarrier(load: any, carrier: any, results: Result[], dryRun: boolean): Promise<boolean> {
  let fresh;
  try {
    fresh = await getSelectCarrierDetails(load.id, carrier.carrier_id);
  } catch (err) {
    console.error(
      `dispatch/run: MDR "Get Select Carrier Details" call failed (load ${load.id}, carrier ${carrier.carrier_id}):`,
      err
    );
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "mdr_api_error",
      error: (err as Error).message,
    });
    return false;
  }

  if (fresh.is_load_close) {
    try {
      await Load.updateOne({ id: load.id }, { is_load_close: true });
    } catch (err) {
      // The load IS closed per MDR — that fact matters more than our local
      // write succeeding, so we still report the closure, but flag that the
      // local record may now be stale until the next successful sync.
      console.error(`dispatch/run: failed to persist is_load_close for load ${load.id}:`, err);
      results.push({
        loadId: load.id,
        outcome: "load_closed_local_update_failed",
        error: (err as Error).message,
      });
      return true;
    }
    results.push({ loadId: load.id, outcome: "load_closed_skipping_rest" });
    return true;
  }

  // No quote-threshold stop condition here — unlike Everly's bid-follow-up
  // flow (where many carriers compete to fill a quote count), this agent
  // calls one already-selected carrier about one already-decided load; MDR's
  // Select Carrier Carrier Details response has no threshold_reached field
  // for this flow to even read.

  // MDR can toggle agent calling off for a load independent of close
  // status. === false (not a plain falsy check) so a missing/
  // undefined field — an older or partial MDR response — never gets
  // mistaken for "calling disabled" and blocks real carriers; only an
  // explicit false stops this load.
  if (fresh.response_summary?.is_agent_call_on === false) {
    try {
      await Load.updateOne({ id: load.id }, { is_agent_call_on: false });
    } catch (err) {
      // Same reasoning as the is_load_close persist above — the fact that
      // calling is off matters more than our local write succeeding, so we
      // still report it, but flag that the local record may now be stale
      // until the next successful sync.
      console.error(`dispatch/run: failed to persist is_agent_call_on for load ${load.id}:`, err);
      results.push({
        loadId: load.id,
        outcome: "agent_call_off_local_update_failed",
        error: (err as Error).message,
      });
      return true;
    }
    results.push({ loadId: load.id, outcome: "agent_call_off_skipping_rest" });
    return true;
  }

  if (fresh.carrier.stop_call) {
    // MDR is the one who discovered this, not our own record_do_not_call
    // tool call (a carrier can opt out through channels other than a call
    // we placed) — without this, our local copy stays stale at false
    // forever, and every future dispatch run pays for a redundant MDR
    // lookup to rediscover the same fact. Best-effort: doesn't affect the
    // skip decision above, which already happened off the fresh MDR value.
    try {
      await Carrier.updateOne(
        { outreach_id: carrier.outreach_id },
        { stop_call: true, stop_reason: fresh.carrier.stop_reason ?? "Stopped on MDR" }
      );
    } catch (err) {
      console.error(
        `dispatch/run: failed to sync local Carrier.stop_call for outreach_id ${carrier.outreach_id}:`,
        err
      );
    }
    results.push({ loadId: load.id, outreachId: carrier.outreach_id, outcome: "skipped_stop_call" });
    return false;
  }

  if (!isValidTimezone(fresh.carrier.carrier_timezone)) {
    console.error(
      `dispatch/run: invalid/missing carrier_timezone "${fresh.carrier.carrier_timezone}" (load ${load.id}, outreach_id ${carrier.outreach_id})`
    );
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "invalid_timezone",
      timezone: fresh.carrier.carrier_timezone,
    });
    return false;
  }

  // No email_sent_at validity check here — cadence.ts's computeAttemptSchedule
  // never actually reads this value (dead even in the Everly build it came
  // from, confirmed 2026-09-10: it's declared in that function's param type
  // but not destructured/used in the body — a leftover from before the
  // 30-minutes-after-email cadence was removed). Still constructed below
  // since computeAttemptSchedule's signature requires a Date, but its actual
  // value is never read.
  const emailSentAt = new Date(fresh.carrier.email_sent_at);

  let existingAttempts;
  try {
    existingAttempts = await CallAttempt.find({
      loadId: String(load.id),
      outreachId: String(carrier.outreach_id),
    }).sort({ attemptNumber: 1 });
  } catch (err) {
    console.error(
      `dispatch/run: failed to fetch CallAttempt history (load ${load.id}, outreach_id ${carrier.outreach_id}):`,
      err
    );
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "error",
      error: `Failed to fetch attempt history: ${(err as Error).message}`,
    });
    return false;
  }

  const nextAttemptNumber = existingAttempts.length + 1;
  if (nextAttemptNumber > MAX_CALL_ATTEMPTS) {
    results.push({ loadId: load.id, outreachId: carrier.outreach_id, outcome: "max_attempts_reached" });
    return false;
  }

  let scheduledFor;
  try {
    const lastAttempt = existingAttempts[existingAttempts.length - 1];
    // A carrier who agreed to a specific callback time (schedule_callback,
    // already validated against the calling window when it was captured —
    // see webhookHandlers.ts) overrides the normal cadence math entirely for
    // the next attempt: call then, not at a computed 30min/1hr/2hr/next-
    // business-morning offset.
    scheduledFor = lastAttempt?.callbackAt
      ? lastAttempt.callbackAt
      : computeAttemptSchedule({
          attemptNumber: nextAttemptNumber,
          timezone: fresh.carrier.carrier_timezone,
          emailSentAt,
          previousAttemptAt: lastAttempt?.startedAt ?? lastAttempt?.createdAt,
        });
  } catch (err) {
    console.error(
      `dispatch/run: failed to compute attempt schedule (load ${load.id}, outreach_id ${carrier.outreach_id}, attempt ${nextAttemptNumber}):`,
      err
    );
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "cadence_computation_error",
      attemptNumber: nextAttemptNumber,
      error: (err as Error).message,
    });
    return false;
  }

  const now = new Date();
  if (scheduledFor.getTime() > now.getTime()) {
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "not_due_yet",
      attemptNumber: nextAttemptNumber,
      dueAt: scheduledFor.toISOString(),
    });
    return false;
  }

  if (!isWithinCallingWindow(fresh.carrier.carrier_timezone, now)) {
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "outside_calling_window",
      timezone: fresh.carrier.carrier_timezone,
    });
    return false;
  }

  if (!env.vapiPhoneNumberId || !process.env.EVERLY_ASSISTANT_ID) {
    results.push({ loadId: load.id, outreachId: carrier.outreach_id, outcome: "not_configured" });
    return false;
  }

  const phone = fresh.carrier.phone;
  if (!phone) {
    results.push({ loadId: load.id, outreachId: carrier.outreach_id, outcome: "no_phone_number" });
    return false;
  }

  if (dryRun) {
    // Every check above (stop_call, timezone, attempt count, cadence
    // due-time, calling window, phone/config presence) has already run for
    // real — this is the one point where a
    // live run would create a CallAttempt and dial. Report what would have
    // happened instead, with zero DB writes and no Vapi call.
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "would_dial",
      attemptNumber: nextAttemptNumber,
      scheduledFor: scheduledFor.toISOString(),
      phone,
    });
    return false;
  }

  let attempt;
  try {
    attempt = await CallAttempt.create({
      loadId: String(load.id),
      outreachId: String(carrier.outreach_id),
      carrierId: String(fresh.carrier.carrier_id),
      attemptNumber: nextAttemptNumber,
      scheduledFor,
      status: "in_progress",
      startedAt: now,
      timezone: fresh.carrier.carrier_timezone,
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      // Another concurrent dispatch run already claimed this exact attempt
      // slot — not a real error, just a race we lost.
      results.push({ loadId: load.id, outreachId: carrier.outreach_id, outcome: "attempt_slot_already_claimed" });
      return false;
    }
    console.error(
      `dispatch/run: failed to create CallAttempt (load ${load.id}, outreach_id ${carrier.outreach_id}):`,
      err
    );
    results.push({ loadId: load.id, outreachId: carrier.outreach_id, outcome: "error", error: (err as Error).message });
    return false;
  }

  try {
    // Cross-load: keyed on MDR's stable carrier_id, not outreach_id (which
    // is per-load-invitation) — see callMemory.ts's header comment. This is
    // deliberately separate from existingAttempts above, which stays scoped
    // to (load, outreach_id) since cadence/MAX_CALL_ATTEMPTS are inherently
    // per-load concepts, not something to share across different loads.
    // attempt._id is excluded from both lookups — the attempt created just
    // above already exists in the DB at this point (in_progress, no
    // callResult yet), and without excluding it a genuinely first-ever call
    // would see its own not-yet-happened attempt reflected back as "prior
    // history" (a real bug caught via a live call, 2026-08-12).
    const callMemory = await buildCallMemory(fresh.carrier.carrier_id, String(load.id), attempt._id);
    const variableValues = buildCallVariables(load, fresh.carrier, callMemory, nextAttemptNumber === MAX_CALL_ATTEMPTS);
    const firstMessage = callMemory
      ? (await hasMeaningfulPriorContact(fresh.carrier.carrier_id, attempt._id))
        ? FOLLOW_UP_FIRST_MESSAGE
        : FOLLOW_UP_UNANSWERED_FIRST_MESSAGE
      : FIRST_MESSAGE;
    const call = await createOutboundCall({
      assistantId: process.env.EVERLY_ASSISTANT_ID as string,
      phoneNumberId: env.vapiPhoneNumberId,
      customerNumber: phone,
      variableValues,
      firstMessage,
    });

    attempt.vapiCallId = call.id;
    await attempt.save();

    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "dialed",
      attemptNumber: nextAttemptNumber,
      vapiCallId: call.id,
    });
  } catch (err) {
    console.error(
      `dispatch/run: failed to place Vapi call (load ${load.id}, outreach_id ${carrier.outreach_id}):`,
      err
    );
    attempt.status = "failed";
    try {
      await attempt.save();
    } catch (saveErr) {
      console.error(
        `dispatch/run: also failed to mark CallAttempt ${attempt.id} as failed:`,
        saveErr
      );
    }
    results.push({
      loadId: load.id,
      outreachId: carrier.outreach_id,
      outcome: "dial_failed",
      attemptNumber: nextAttemptNumber,
      error: (err as Error).message,
    });
  }

  return false;
}
