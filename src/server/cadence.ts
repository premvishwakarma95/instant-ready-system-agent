/**
 * Confirmed attempt cadence:
 *   1st call: immediately, right now — not gated by the calling window at all
 *     (2026-09-24, explicit instruction). MDR's integration is push-based —
 *     it only hits our webhook once a load is genuinely ready for outreach
 *     calling, so MDR itself has already decided the timing is right by the
 *     time we see the carrier at all. Also closes a real gap: attempt 1 is
 *     only ever placed synchronously from the webhook itself (mdrWebhook.ts),
 *     a one-shot call — dispatch.ts's own cron catch-up loop (processLoad)
 *     deliberately only considers carriers with at least one existing
 *     attempt, so a first attempt deferred to a later window-open would leave
 *     that carrier permanently stuck at zero attempts with nothing left to
 *     retry it. Removed the earlier 30-minutes-after-email_sent_at gate
 *     (2026-08-20) for the same "MDR already decided the timing" reasoning.
 *   2nd call: 1 hour after the 1st, still gated by the calling window
 *   3rd call: 2 hours after the 2nd, still gated by the calling window
 *   4th call: next business morning (only if stop conditions still not met)
 * Max 4 attempts per carrier.
 */
import { nextCallingWindowOpen, nextBusinessMorning } from "./callingWindow.js";

export const MAX_CALL_ATTEMPTS = 4;

const OFFSET_MINUTES_FROM_PREVIOUS: Record<number, number> = {
  2: 60,
  3: 120,
};

export function computeAttemptSchedule(params: {
  attemptNumber: number;
  timezone: string;
  // Still accepted (dispatch.ts still validates and passes it — see its own
  // "invalid_email_sent_at" gate, kept as a data-quality check independent
  // of the timing decision) but no longer used for attempt-1 timing.
  emailSentAt: Date;
  previousAttemptAt?: Date;
}): Date {
  const { attemptNumber, timezone, previousAttemptAt } = params;

  if (attemptNumber === 1) {
    return new Date();
  }

  if (!previousAttemptAt) {
    throw new Error(`Attempt ${attemptNumber} requires previousAttemptAt`);
  }

  if (attemptNumber === 4) {
    return nextBusinessMorning(timezone, previousAttemptAt);
  }

  const offsetMinutes = OFFSET_MINUTES_FROM_PREVIOUS[attemptNumber];
  if (!offsetMinutes) {
    throw new Error(`Unsupported attempt number: ${attemptNumber}`);
  }
  const target = new Date(previousAttemptAt.getTime() + offsetMinutes * 60_000);
  return nextCallingWindowOpen(timezone, target);
}
