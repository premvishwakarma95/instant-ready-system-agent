/**
 * Creates (or updates, if EVERLY_ASSISTANT_ID is set) the Everly assistant in Vapi.
 *
 * Usage:
 *   npm run assistant:create
 *
 * On first run this creates a new assistant and prints its ID — save that ID
 * into .env as EVERLY_ASSISTANT_ID so re-runs update the same assistant
 * instead of creating duplicates.
 */
import { vapi, VapiError } from "../vapi/client.js";
import { FIRST_MESSAGE, VOICEMAIL_MESSAGE, SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS, ORCHESTRATION_WEBHOOK_URL } from "./tools.js";

// "Wait for the carrier to speak first" mechanism — confirmed working across
// several real test calls (5s/15s/25s escalation firing correctly and
// ending the call when the carrier stays silent; correct immediate handoff
// to the model's real opening when the carrier speaks first or responds to
// a check-in). See git history for why this specific shape was landed on —
// two earlier "wait for carrier to speak first" attempts already failed on
// real calls (a hook firing near-instantly, and startSpeakingPlan.waitSeconds
// not gating the opening at all). Investigated the earlier hook failure
// properly this time by pulling the two real test calls' raw message
// timestamps from Vapi directly — the hook did NOT fire at ~220ms from call
// start as previously assumed; it fired at ~4.3-4.9s (roughly in line with
// timeoutSeconds: 3 plus ordinary call-setup lag), but in both calls the
// carrier's own speech had already landed 120-220ms EARLIER and didn't
// cancel it — a race between speech-finalization and the hook's timeout
// check, not the hook ignoring the timeoutSeconds value outright.
// A single hook with triggerMaxCount: 3 was tried next (timeoutSeconds: 10)
// to get 3 escalating check-ins from one hook's own repeat mechanism — a real
// call showed that doesn't actually repeat as documented: only 1 firing
// happened across a 43s call that had plenty of time left for 2 more.
//
// This attempt switches to Vapi's own documented pattern for this exact
// scenario instead: 3 SEPARATE customer.speech.timeout hooks, each firing
// once (triggerMaxCount: 1, not 3 — deliberately not copying the repeat
// count from Vapi's own doc example, since that's the exact mechanism just
// shown not to work), staggered 5s/15s/25s (client asked to move the first
// check-in from 10s to 5s; kept the same 10s gap between stages after that).
// The last hook's `do` list ends the call via a documented
// `{type:"tool", tool:{type:"endCall"}}` action, run right after its "say" —
// confirmed on a real call (endedReason: assistant-ended-call). firstMessage set to "" (not
// FIRST_MESSAGE) to match firstMessageMode: assistant-waits-for-user's
// documented usage — in this mode Vapi doesn't speak firstMessage at all
// regardless of its value; the model generates its own opening from the
// "## Opening — correct contact" section of prompt.ts once it's triggered to
// speak (by a hook firing, or the carrier speaking first) — prompt.ts is NOT
// touched for this test, so the {{greeting}} prefix (only wired into the
// FIRST_MESSAGE constant, not into that section's own instructions) will not
// be spoken in this mode — a known, accepted gap for this specific test, not
// a new bug.
// Tried making the closing line attempt-aware (different wording per attempt
// number, no callback promise on the real final attempt) — reverted per
// client instruction, back to one fixed message every time.
//
// (2026-08-21) The FIRST_MESSAGE-vs-"" claim in the paragraph above is now
// stale: dispatch.ts confirmed on a real call that a non-empty per-call
// firstMessage override IS spoken even under this firstMessageMode, so
// first-time calls now get FIRST_MESSAGE (with its {{greeting}} prefix)
// passed as that override — see dispatch.ts's firstMessage selection.
//
// (2026-08-21) Client reported carriers getting an unwanted "Hello? Are you
// there?" interruption — and worse, calls silently ending — in the MIDDLE of
// a live conversation, e.g. a carrier saying "hold on a moment" while
// checking a rate. Root cause: customer.speech.timeout fires on ANY silence
// gap anywhere in the call, not just the opening wait — that's what the
// event means — and triggerResetMode: "onUserSpeech" re-arms each hook's
// trigger count every time the carrier speaks, letting it fire again on the
// next silence gap later in the call. Vapi has no documented way to scope a
// hook to "only before the customer's first utterance" (no elapsed-time or
// turn-count filter exists). Per client direction: dropped the 15s/25s
// escalation and the endCall action entirely (removes the risk of a live
// call being cut off over a normal mid-conversation pause) and kept a single
// hook, raised from 5s to 30s — long enough that a normal mid-call pause
// (checking a rate, etc.) is unlikely to cross it, while still nudging a
// carrier who never responds at all after the opening.
//
// (2026-08-21) A real test call still ended at ~30s of mid-conversation
// silence even with the endCall action fully removed above — turned out to
// be a SEPARATE Vapi mechanism entirely: silenceTimeoutSeconds, a top-level
// assistant field (not part of hooks) that defaults to 30s and hangs up the
// whole call on its own if no caller audio is detected for that long
// (endedReason: "silence-timed-out"). The old 5s/15s/25s+endCall setup never
// surfaced this because our own endCall at 25s always won the race against
// this 30s default. Set explicitly to 60s per client direction — comfortably
// above the single 30s "Hello? Are you there?" hook above, so the nudge is
// just a check-in with no consequence, and the actual hang-up threshold sits
// well past a normal pause (checking a rate, etc.).
const assistantPayload = {
  name: "Everly",
  firstMessage: "",
  firstMessageMode: "assistant-waits-for-user",
  silenceTimeoutSeconds: 60,
  hooks: [
    {
      on: "customer.speech.timeout",
      options: { timeoutSeconds: 30, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
      do: [{ type: "say", exact: "Hello? Are you there?" }],
    },
  ],
  voicemailMessage: VOICEMAIL_MESSAGE,
  // Without this, Vapi never actually detects voicemail on its own — a real
  // test call (2026-09-01) confirmed the assistant just spoke its normal
  // live-call opening straight into a voicemail box and the call silently
  // timed out (endedReason: "silence-timed-out") instead of using
  // voicemailMessage above. First landed on provider: "twilio" (matches our
  // telephony provider) — that DID correctly classify the call as voicemail,
  // but two consecutive real test calls showed the assistant's normal
  // live-call opening still got spoken immediately and then hard-interrupted
  // mid-word once detection resolved, splicing it together with
  // voicemailMessage into one garbled recording. Per Vapi's own docs,
  // provider: "twilio" is legacy with no tuning controls; switched to
  // provider: "vapi" (their recommended option) specifically for
  // beepMaxAwaitSeconds, which holds the assistant silent — not speaking
  // FIRST_MESSAGE at all — until either the beep is detected (then speaks
  // cleanly right after) or this timeout passes. Kept at 20s per Vapi's own
  // guidance not to go below ~15-20s, since most voicemail greetings run
  // that long before the beep.
  voicemailDetection: {
    provider: "vapi",
    backoffPlan: { startAtSeconds: 2, frequencySeconds: 2.5, maxRetries: 5 },
    beepMaxAwaitSeconds: 20,
  },
  model: {
    provider: "openai",
    model: "gpt-4.1",
    temperature: 0.4,
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    tools: TOOLS,
  },
  // Vapi's native voice provider doesn't support a speed control at all —
  // switched to ElevenLabs specifically to fix reported speaking-speed issues
  // (PlayHT also supports speed, but isn't enabled on this account/plan —
  // every PlayHT preset returned "Couldn't Find PlayHT Voice"). speed<1
  // slows delivery. stability was previously raised to 0.6 to fix an
  // "erratic" complaint, but that overcorrected into flat/robotic-sounding
  // delivery (2026-07-25 client feedback) — lowered back down for more
  // natural expressiveness. voiceId switched again (2026-07-27) to another
  // ElevenLabs voice ID provided directly by the user, still searching for
  // one that sounds natural enough — not in Vapi's curated voice-library
  // browse list, which only surfaces a fixed preset subset, not ElevenLabs'
  // full catalog.
  voice: {
    provider: "11labs",
    voiceId: "gE0owC0H9C8SzfDyIUtB",
    // Switched to eleven_v3 (2026-07-27) — client explicitly wants the
    // audio-tag system ([excited], [sighs], [laughs], etc, see prompt.ts)
    // for genuine situational emotion, which ONLY eleven_v3 understands;
    // turbo_v2_5/multilingual_v2 would either strip those bracket tags or
    // read them aloud as literal text. Known risk accepted per client
    // request: v3 is ElevenLabs' alpha/research-preview model with no
    // published real-time latency guidance, and turbo_v2_5 was chosen
    // earlier specifically for low latency — watch turn latency on the next
    // real test call and be ready to revert if it's unacceptably slow.
    model: "eleven_v3",
    speed: 1.0,
    stability: 0.3,
    similarityBoost: 0.8,
    style: 0.65,
  },
  transcriber: {
    provider: "deepgram",
    model: "nova-3",
    language: "en",
  },
  // startSpeakingPlan (how patiently Everly waits before she starts talking)
  // didn't move numAssistantInterrupted at all on an earlier test call — the
  // transcript showed HER speech getting cut off mid-word ("...includes the
  // CHAS Next..."), which means that metric is about her getting
  // interrupted, not her interrupting the carrier.
  //
  // Reverted 5 -> 0.8 (2026-08-18): tried raising this to make Everly wait
  // for the carrier to speak first on outbound calls, confirmed not to work
  // on a real test call (only ~2.2s gap observed, not 5s) — Vapi's own docs
  // define waitSeconds as governing turn-taking "after the customer pauses
  // or finishes," not the opening of a call that hasn't started yet, so it
  // had no effect there and only added unwanted delay to every later turn.
  // No supported Vapi mechanism currently exists for delaying an outbound
  // call's opening line specifically — see project memory/git history for
  // the three confirmed-broken attempts (this one, the hook-based one, and
  // the assistant-waits-for-user one).
  startSpeakingPlan: {
    waitSeconds: 0.8,
    smartEndpointingPlan: { provider: "vapi" },
  },
  // The actual fix for that: stopSpeakingPlan controls how easily she gets
  // cut off once she's already talking. Default is very sensitive (any
  // sound counts), so background noise or a short "yeah"/"uh" from the
  // carrier was killing her mid-sentence. Requiring 2 real words before it
  // counts as a genuine interruption, plus a brief backoff before she
  // resumes, should stop the mid-word cutoffs seen in transcripts.
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.2,
    backoffSeconds: 1,
  },
  endCallMessage:
    "Thank you for your time today. Have a great rest of your day.",
  // Vapi's default is 600s (10 min) — too short for a real carrier-pricing
  // conversation with multiple accessorials/edge cases; a live test call was
  // force-ended by the platform mid-conversation before quote submission.
  maxDurationSeconds: 900,
  // Removed endCallPhrases (2026-07-25) — the prompt already has Everly give
  // her own natural sign-off before calling the endCall tool, which reliably
  // fires on every reviewed call. Having "goodbye" also configured as an
  // auto-hangup trigger phrase raced against endCallMessage above: the
  // moment Everly's own sign-off naturally included a word like "goodbye",
  // Vapi's phrase-detection hung up immediately, cutting endCallMessage off
  // mid-word ("...Have" then dead) instead of letting it finish. The
  // explicit endCall tool call is the reliable mechanism; this was a
  // redundant, actively harmful safety net. Explicitly set to [] rather than
  // omitted — Vapi's PATCH only updates fields present in the payload, so
  // omitting this would have silently left the old value in place (verified
  // this the hard way: the first attempt at this fix didn't actually clear it).
  endCallPhrases: [],
  // Explicit per client requirement ("record all calls where legally
  // permitted, store recordings/transcripts/summaries") — set explicitly
  // rather than relying on Vapi's account-level default.
  artifactPlan: {
    recordingEnabled: true,
    transcriptPlan: { enabled: true },
  },
  // Assistant-level server config — needed for lifecycle messages like
  // end-of-call-report, which aren't tied to a specific tool call.
  server: { url: ORCHESTRATION_WEBHOOK_URL },
  serverMessages: ["end-of-call-report", "status-update"],
};

async function main() {
  const existingId = process.env.EVERLY_ASSISTANT_ID;

  try {
    if (existingId) {
      const updated = await vapi.patch<{ id: string }>(
        `/assistant/${existingId}`,
        assistantPayload
      );
      console.log(`Updated existing Everly assistant: ${updated.id}`);
    } else {
      const created = await vapi.post<{ id: string }>("/assistant", assistantPayload);
      console.log(`Created Everly assistant: ${created.id}`);
      console.log(`Add this to .env: EVERLY_ASSISTANT_ID=${created.id}`);
    }
  } catch (err) {
    if (err instanceof VapiError) {
      console.error(`Vapi rejected the assistant payload (status ${err.status}):`);
      console.error(JSON.stringify(err.body, null, 2));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
