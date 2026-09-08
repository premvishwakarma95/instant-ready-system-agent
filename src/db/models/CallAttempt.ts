import { Schema, model } from "mongoose";

const callAttemptSchema = new Schema(
  {
    // Plain strings, not ObjectId refs — loadId/outreachId/carrierId are
    // MDR's external ids (see src/mdr/api.ts), not local collections.
    // Load/Carrier data now lives in MDR's system.
    loadId: { type: String, required: true, index: true },
    // outreach_id: MDR's per-load-invitation id — reissued fresh every time
    // the same real carrier is invited to a different load. This is what
    // every MDR write endpoint (decline/stop/email-resend/etc.) is keyed on,
    // and what cadence/MAX_CALL_ATTEMPTS is scoped by, since "how many times
    // have we attempted THIS invitation" is inherently per-load.
    outreachId: { type: String, required: true, index: true },
    // carrier_id: MDR's stable per-company id — the SAME value across every
    // load a real carrier is ever invited to. Used by callMemory.ts to find
    // this carrier's history across loads, not just this one. Was previously
    // (incorrectly) not stored at all, with outreach_id stored under this
    // field name instead — a real carrier calling back after a genuinely
    // fresh first contact would see its own in-progress attempt reflected
    // back as "prior history" once the cross-load lookup had to reconstruct
    // carrier_id indirectly; storing it directly here avoids that class of
    // bug entirely. See callMemory.ts's header comment.
    carrierId: { type: String, required: true, index: true },
    attemptNumber: { type: Number, required: true }, // 1-4 per the confirmed cadence

    scheduledFor: { type: Date, required: true }, // when this attempt should fire, per cadence rules
    vapiCallId: String, // set once actually dialed

    // Carrier's real timezone, from the same fresh MDR "Get Specific Carrier"
    // response dispatch.ts already fetches before dialing — stored here so
    // the schedule_callback tool (fired mid-call, no fresh MDR round-trip
    // available) has an authoritative timezone to validate a proposed
    // callback time against, without trusting whatever zone the carrier says
    // out loud. See callingWindow.ts's header comment for why MDR's value is
    // always the source of truth, never a carrier-stated one.
    timezone: String,

    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed", "no_answer", "voicemail", "failed", "cancelled"],
      default: "scheduled",
      index: true,
    },

    callResult: {
      type: String,
      enum: [
        "connected",
        "voicemail",
        "wrong_number",
        "callback",
        "quote_received",
        "conditional_quote",
        "declined",
        "do_not_call",
        "escalation",
        // Set by resend_email — was previously untracked (that tool only
        // flipped Carrier.stop_call), so a call where the carrier asked to
        // quote by email was indistinguishable from a plain connected call
        // with nothing concluded. Needed to report MDR's own
        // EMAIL_REQUESTED call-log status accurately (see callOutcome.ts's
        // mapToMdrCallLogStatus).
        "email_requested",
      ],
    },

    // Audit trail — required per playbook Section 12 "Confirmation" / Section 13
    transcript: String,
    recordingUrl: String,
    summary: String,
    sentiment: String,
    qualityScore: Number,
    agentVersion: String,
    promptVersion: String,
    consentDisclosureDelivered: { type: Boolean, default: false },
    endedReason: String, // raw Vapi endedReason, useful for debugging call outcomes

    // Set by the log_decline / schedule_callback tool webhooks
    declineReason: String,
    declineNote: String,
    callbackAt: Date,
    callbackTimeZone: String,

    startedAt: Date,
    endedAt: Date,
    // Real conversation time only, in whole seconds — Vapi's own reported
    // startedAt/endedAt (call actually connected -> call actually ended),
    // NOT this document's own startedAt/endedAt above (dispatch-time and
    // webhook-receipt-time respectively, which include ring/setup time on
    // one end and webhook-processing latency on the other). Defaults to 0,
    // which is also what a never-connected attempt (no_answer/failed) ends
    // up with, since Vapi never reports real call timestamps for those.
    durationSeconds: { type: Number, default: 0 },
    // Set once MDR's Call Log API push succeeds — guards against sending
    // it twice for the same call. Vapi's end-of-call-report webhook is
    // fully awaited before we respond 200 (see index.ts), so a slow
    // response could cause Vapi to retry the same webhook and re-run
    // handleEndOfCallReport; MDR's own API already rejects a duplicate
    // call_id (confirmed empirically, 2026-08-31: a 409 "This call ID has
    // already been processed"), but that's a defense on their side, not a
    // reason to skip guarding our own retry attempt from firing at all.
    mdrCallLogSubmittedAt: Date,
  },
  { timestamps: true }
);

// A carrier should never have two concurrent/active attempts on the same load —
// this compound index backs the idempotency/locking requirement (Step 4.6).
// Scoped by outreachId, not carrierId — attempt numbering is inherently a
// per-load-invitation concept (see the field comments above).
callAttemptSchema.index({ loadId: 1, outreachId: 1, attemptNumber: 1 }, { unique: true });

// Backs callMemory.ts's cross-load history lookup (filter by carrierId,
// sort by startedAt desc, limited) — without this, MongoDB has to gather
// and sort every attempt this real carrier has ever had before it can hand
// back just the most recent few, even though the app only ever asks for a
// bounded slice. This lets it walk the index in the needed order directly.
callAttemptSchema.index({ carrierId: 1, startedAt: -1 });

export const CallAttempt = model("CallAttempt", callAttemptSchema);
