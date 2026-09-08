/**
 * Builds a single short, plain-language sentence summarizing the most recent
 * MEANINGFUL prior call attempt with this real carrier, for the
 * {{callMemory}} prompt variable — or "" if there's no prior history at all
 * (first-time contact).
 *
 * Hard rules (mirrored in prompt.ts's "Call memory" guardrails):
 *  - Never invent details not present in stored data.
 *  - Never imply the carrier answered/connected if they didn't.
 *  - Reference only the single most recent meaningful attempt, not a history dump.
 *
 * Cross-load: MDR issues a fresh `outreach_id` per load invitation, even for
 * the same real carrier — so it's not a stable "this is the same company"
 * key by itself. `CallAttempt.carrierId` stores MDR's own stable per-company
 * `carrier_id` instead (a separate field from `outreachId`, which is what
 * cadence/MAX_CALL_ATTEMPTS stay scoped by — see CallAttempt.ts's field
 * comments), so this module can query CallAttempt directly by carrier_id —
 * a carrier who quoted a completely different load last week is still
 * recognized here, with no need to look anything up via Carrier first.
 */
import { CallAttempt, Quote } from "../db/models/index.js";
import { humanizeReason } from "./webhookHandlers.js";
import { isValidTimezone } from "./callingWindow.js";

const MEANINGFUL_STATUSES = new Set(["completed"]);
const MEANINGFUL_RESULTS = new Set(["do_not_call"]);

function isMeaningful(attempt: any): boolean {
  return MEANINGFUL_STATUSES.has(attempt.status) || MEANINGFUL_RESULTS.has(attempt.callResult);
}

// This runs before every single dial (dispatch.ts), so it must stay cheap
// regardless of how long a carrier's real history gets over months/years of
// operation — buildCallMemory only ever needs the SINGLE most recent
// meaningful attempt, so there's no reason to ever pull more than a small,
// fixed, recent window. A carrier whose last 25 attempts (roughly 6+ loads'
// worth, even in a worst case of zero meaningful contact each time) contain
// no real conversation is, for the purpose of this one sentence, no
// different from one with no history at all — going back further wouldn't
// produce a more useful thing to say.
const HISTORY_LOOKBACK_LIMIT = 25;

/**
 * Most recent CallAttempts across every load tied to this same real carrier,
 * newest-first by actual time (bounded — see HISTORY_LOOKBACK_LIMIT above).
 * attemptNumber is only meaningful within a single load's cadence, so real
 * timestamps are what "most recent" has to mean once loads are mixed
 * together.
 *
 * Never returns a not-yet-finished attempt ("scheduled"/"in_progress") —
 * something that hasn't happened yet can never legitimately be "history,"
 * for any call. This is what actually prevents a real carrier from ever
 * seeing their own in-progress call reflected back as a past failed one —
 * not just for the current call's own attempt (see excludeAttemptId below),
 * but also for the rarer case of a genuinely different, still-in-progress
 * sibling attempt on a different load for this same real carrier, dialed in
 * the same narrow window (possible with dispatch running on a schedule
 * across many loads) — excluding one specific id wouldn't have caught that.
 *
 * excludeAttemptId: extra, cheap defense-in-depth for the current call's own
 * attempt specifically, on top of the status filter above — harmless if
 * omitted, and redundant in the common case, but kept since dispatch.ts
 * already has the id on hand to pass in.
 */
async function findCrossLoadAttempts(mdrCarrierId: number, excludeAttemptId?: unknown): Promise<any[]> {
  const filter: Record<string, unknown> = {
    carrierId: String(mdrCarrierId),
    status: { $nin: ["scheduled", "in_progress"] },
  };
  if (excludeAttemptId) filter._id = { $ne: excludeAttemptId };
  return CallAttempt.find(filter)
    .sort({ startedAt: -1, createdAt: -1 })
    .limit(HISTORY_LOOKBACK_LIMIT);
}

/**
 * Same "meaningful" definition buildCallMemory uses internally, exposed so
 * dispatch.ts can pick between FOLLOW_UP_FIRST_MESSAGE and
 * FOLLOW_UP_UNANSWERED_FIRST_MESSAGE (src/assistant/prompt.ts) without
 * duplicating this logic.
 */
export async function hasMeaningfulPriorContact(mdrCarrierId: number, excludeAttemptId?: unknown): Promise<boolean> {
  const attempts = await findCrossLoadAttempts(mdrCarrierId, excludeAttemptId);
  return attempts.some(isMeaningful);
}

function relativeDay(date: Date | undefined): string {
  if (!date) return "recently";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return "a while back";
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).trim() + "…" : text;
}

/** "this load" if the attempt belongs to the load we're calling about right now, otherwise "a different load" — never left ambiguous, since claiming "this load" for a different one would be inventing context. */
function loadPhrase(attempt: any, currentLoadId: string): string {
  return attempt.loadId === currentLoadId ? "this load" : "a different load";
}

async function describeMeaningfulAttempt(attempt: any, currentLoadId: string): Promise<string> {
  const when = relativeDay(attempt.startedAt ?? attempt.createdAt);
  const about = loadPhrase(attempt, currentLoadId);

  if (attempt.callResult === "quote_received" || attempt.callResult === "conditional_quote") {
    const quote = await Quote.findOne({ callAttemptId: attempt._id }).lean();
    if (quote?.baseRate) {
      const qualifier = attempt.callResult === "conditional_quote" ? "a conditional quote of" : "a quote of";
      const fsc = quote.fsc ? ` plus a ${quote.fsc}% fuel surcharge` : "";
      return `We spoke ${when} about ${about} and you gave ${qualifier} $${quote.baseRate}${fsc}.`;
    }
    // Quote doc missing/incomplete — fall back below rather than fabricate a number.
  }

  if (attempt.callResult === "declined") {
    const reason = attempt.declineReason ? humanizeReason(attempt.declineReason) : null;
    return reason
      ? `We spoke ${when} about ${about} and you declined, citing: ${reason}.`
      : `We spoke ${when} about ${about} and it wasn't a fit at that time.`;
  }

  if (attempt.callResult === "callback") {
    // attempt.timezone is MDR's confirmed real carrier timezone, stored fresh
    // at dial time (see dispatch.ts) — the same source of truth used
    // everywhere else callback times are computed or spoken (schedule_callback,
    // {{currentTime}}). Without a timeZone here, toLocaleString silently
    // resolves to the server host's zone instead of the carrier's own — a
    // real call (2026-09-04, outreach 366) showed this speaking "7:35 AM" for
    // a callbackAt that was actually 1:05 PM in the carrier's real timezone
    // (Asia/Kolkata), contradicting the correctly-computed {{currentTime}} in
    // the very same call and confusing the carrier.
    const hasValidTimezone = isValidTimezone(attempt.timezone);
    const time = attempt.callbackAt
      ? ` around ${attempt.callbackAt.toLocaleString("en-US", {
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          ...(hasValidTimezone ? { timeZone: attempt.timezone } : {}),
        })}${attempt.callbackTimeZone ? ` (${attempt.callbackTimeZone})` : ""}`
      : "";
    return `We spoke ${when} about ${about} and you asked us to call back${time}.`;
  }

  if (attempt.callResult === "do_not_call") {
    // Defensive only — dispatch.ts's stop_call gate should already prevent
    // this call from firing live in the normal case.
    return `We spoke ${when} about ${about} and you asked not to be contacted about it again.`;
  }

  // connected / escalation / wrong_number / anything else with a real
  // conversation: fall back to Vapi's own auto-generated summary — grounded
  // in the real transcript, zero fabrication risk.
  if (attempt.summary) {
    // Vapi's own summary is written in third person about "the AI
    // assistant" / "the user" — awkward to speak verbatim in a first-person
    // call. Framed as raw background notes to extract one fact from, not a
    // line to recite, since a real call showed the model otherwise
    // defaulting to a vague "we spoke before" instead of pulling out an
    // actual detail from it.
    return `We spoke ${when} about ${about}. Background notes from that call (pull out one concrete detail, do not recite this verbatim): ${truncate(attempt.summary, 200)}`;
  }

  return `We spoke ${when} about ${about}.`;
}

function describeUnconnectedHistory(mostRecent: any, currentLoadId: string): string {
  const when = relativeDay(mostRecent.startedAt ?? mostRecent.createdAt);
  const about = loadPhrase(mostRecent, currentLoadId);
  if (mostRecent.status === "voicemail") {
    return `I left a voicemail ${when} about ${about}.`;
  }
  // no_answer covers both true no-answer and busy — accurate and
  // non-fabricating either way.
  return `I tried reaching you ${when} about ${about} but wasn't able to get through.`;
}

export async function buildCallMemory(mdrCarrierId: number, currentLoadId: string, excludeAttemptId?: unknown): Promise<string> {
  const allAttempts = await findCrossLoadAttempts(mdrCarrierId, excludeAttemptId);
  if (allAttempts.length === 0) return "";

  // Already sorted newest-first — find the first meaningful one scanning
  // forward. This naturally surfaces the last real conversation even if more
  // recent attempts (on this or another load) went unanswered, without
  // mentioning those unanswered attempts alongside it.
  const mostRecentMeaningful = allAttempts.find(isMeaningful);

  if (mostRecentMeaningful) {
    return await describeMeaningfulAttempt(mostRecentMeaningful, currentLoadId);
  }

  return describeUnconnectedHistory(allAttempts[0], currentLoadId);
}
