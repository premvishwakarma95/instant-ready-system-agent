/**
 * Classifies a call's Vapi endedReason into our CallAttempt.status taxonomy,
 * and applies the full outcome (status, transcript, recording, summary) onto
 * a CallAttempt document.
 *
 * Deliberately an allowlist, not a denylist: Vapi has 600+ possible
 * endedReason values (telephony-provider errors, SIP edge cases, etc.) and
 * new ones get added over time. Silently bucketing anything unrecognized
 * into "completed" would hide real failures as if the call went fine — safer
 * to default unrecognized reasons to "failed" and log them so they get
 * noticed and added here, than to assume the best.
 */
import type { HydratedDocument } from "mongoose";

const VOICEMAIL_REASONS = new Set(["voicemail"]);

const NO_ANSWER_REASONS = new Set([
  "customer-did-not-answer",
  "customer-busy",
  "twilio-reported-customer-misdialed",
  "call.ringing.sip-inbound-caller-hungup-before-call-connect",
]);

const NORMAL_COMPLETION_REASONS = new Set([
  "assistant-ended-call",
  "assistant-ended-call-with-hangup-task",
  "assistant-ended-call-after-message-spoken",
  "assistant-said-end-call-phrase",
  "assistant-forwarded-call",
  "customer-ended-call",
  "customer-ended-call-before-warm-transfer",
  "customer-ended-call-after-warm-transfer-attempt",
  "customer-ended-call-during-transfer",
  "exceeded-max-duration",
  "manually-canceled",
  "silence-timed-out",
  "call.in-progress.twilio-completed-call",
  "call.in-progress.sip-completed-call",
  "vonage-completed",
]);

export type CallStatus = "completed" | "voicemail" | "no_answer" | "failed";

export function classifyCallStatus(endedReason: string | undefined): CallStatus {
  if (!endedReason) return "completed";
  if (VOICEMAIL_REASONS.has(endedReason)) return "voicemail";
  if (NO_ANSWER_REASONS.has(endedReason)) return "no_answer";
  if (NORMAL_COMPLETION_REASONS.has(endedReason)) return "completed";
  console.warn(`Unrecognized Vapi endedReason "${endedReason}" — defaulting to status "failed". Consider adding it to src/server/callOutcome.ts.`);
  return "failed";
}

/**
 * Real conversation time only, in whole seconds — from Vapi's OWN reported
 * call-start/call-end timestamps (the call actually connecting to actually
 * ending), never this app's own dispatch-time/webhook-receipt-time
 * timestamps. Confirmed via a real completed call (2026-08-26): our own
 * startedAt/endedAt overstated the real duration by ~32% (57.6s vs Vapi's
 * real 43.8s) — ring/setup time on one end, webhook-delivery latency on the
 * other. Missing/invalid/non-positive input (never connected: no_answer,
 * failed, etc. — Vapi doesn't report real call timestamps for those) -> 0.
 */
function computeDurationSeconds(startedAt?: string, endedAt?: string): number {
  if (!startedAt || !endedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 1000);
}

/**
 * MM:SS, per MDR's Call Log API spec (e.g. "03:05") — built from the same
 * durationSeconds computed above, not a separate calculation. Zero-padded
 * to 2 digits each side; minutes are not capped (a 61-minute call renders
 * "61:00", not wrapped into an hours component — the spec only shows MM:SS).
 */
export function formatDurationMmSs(durationSeconds: number): string {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Maps our own CallAttempt.status/callResult onto MDR's fixed Call Log
 * status vocabulary (see MdrCallLogStatus in mdr/api.ts). Returns null for
 * outcomes with no honest equivalent even including CALL_DROPPED — the
 * caller should skip the MDR call-log push entirely in that case rather
 * than force a misleading value onto MDR's system:
 *   - "do_not_call": opted out of ALL future contact, a broader/different
 *     fact than DECLINED (which per MDR's own definition means declining
 *     THIS load specifically)
 *   - "failed": the call itself errored out — not a real conversation,
 *     nothing to honestly report as a business outcome
 *   - "wrong_number": no equivalent in MDR's list
 * "escalation" (human handoff, also via schedule_callback per this
 * codebase's design — see CLAUDE.md's Assistant tools section) maps to
 * FOLLOW_UP_REQUIRED alongside plain "callback", since both mean someone
 * needs to follow up. "conditional_quote" maps to ACCEPTED: MDR's own
 * definition of ACCEPTED is "if quoted by call", which is still true
 * whether or not conditions were attached to that quote. "connected" (a
 * real conversation happened but no tool ever fired — the carrier hung up
 * before reaching any conclusion) maps to CALL_DROPPED, confirmed on a real
 * test call (2026-08-31) where this previously fell through to null.
 */
export function mapToMdrCallLogStatus(attempt: HydratedDocument<any>): import("../mdr/api.js").MdrCallLogStatus | null {
  if (attempt.status === "no_answer") return "NO_ANSWER";
  if (attempt.status === "voicemail") return "LEFT_VOICEMAIL";

  switch (attempt.callResult) {
    case "declined":
      return "DECLINED";
    case "quote_received":
    case "conditional_quote":
      return "ACCEPTED";
    case "callback":
    case "escalation":
      return "FOLLOW_UP_REQUIRED";
    case "email_requested":
      return "EMAIL_REQUESTED";
    case "connected":
      return "CALL_DROPPED";
    default:
      return null;
  }
}

export function applyCallOutcome(
  attempt: HydratedDocument<any>,
  data: {
    endedReason?: string;
    transcript?: string;
    recordingUrl?: string;
    summary?: string;
    vapiStartedAt?: string;
    vapiEndedAt?: string;
  }
) {
  attempt.transcript = data.transcript;
  attempt.recordingUrl = data.recordingUrl;
  attempt.summary = data.summary;
  attempt.endedReason = data.endedReason;
  attempt.endedAt = new Date();
  attempt.durationSeconds = computeDurationSeconds(data.vapiStartedAt, data.vapiEndedAt);

  if (attempt.status === "in_progress") {
    attempt.status = classifyCallStatus(data.endedReason);
  }

  // callResult only gets set by a tool call (submit_quote, log_decline, etc.)
  // mid-conversation. If the call genuinely completed but no tool ever fired
  // — a real gap, since the prompt requires one — record that explicitly
  // rather than leaving callResult silently empty.
  if (!attempt.callResult) {
    if (attempt.status === "voicemail") attempt.callResult = "voicemail";
    else if (attempt.status === "completed") attempt.callResult = "connected";
  }
}
