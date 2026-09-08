# Build Plan — Architecture & Steps

Internal build reference (merged from the former technical-architecture.md + build-steps.md). Client-facing version: [client-proposal.md](client-proposal.md). Full spec: [project-info.md](project-info.md). Requirements/config status: [requirements-tracker.md](requirements-tracker.md).

## End-to-end flow

_Updated 2026-07-23 to match the current push-webhook architecture — see `src/mock-mdr-api/`, `src/mdr-simulator-ui/`, and `CLAUDE.md`'s Architecture section for the code this describes._

1. **Mock MDR API** (`src/mock-mdr-api/`) stands in for MDR's real system until the client builds theirs, exposing the same 4 endpoints MDR has confirmed plus a few extra dev-only routes.
2. **Simulator UI** (`src/mdr-simulator-ui/`, served at `/simulator`) stands in for MDR's actual system: fills in a load, its invited carriers, and account settings, then fires that payload at Everly's own webhook — the same way MDR will once their integration is live.
3. **Webhook intake** (`src/server/mdrWebhook.ts`) receives that payload and stores the load locally, since MDR's confirmed API has no `GET /loads` to re-fetch from later. Full carrier profiles (contacts, eligibility, quoted status) are not cached locally — they're fetched fresh from the MDR API whenever needed, since that data can change carrier-side at any time.
4. **Scheduler** (`npm run dispatch:run`, `src/orchestration/dispatcher.ts`), run repeatedly, for every locally-open load:
   - Re-checks whether the load should stop being worked at all (enough quotes already in, bid closed, MDR closed it for another reason, or no eligible carriers left) — `stopConditions.ts`.
   - Builds the eligible-carrier queue — excludes anyone already quoted, opted out, or failing MDR's eligibility checks, and ranks the rest — `queueBuilder.ts`.
   - For each eligible carrier, checks whether their next attempt is actually due right now per the confirmed cadence (1st call after the email-wait window, 2nd +1hr, 3rd +2hr, 4th next business morning) and within their local calling window — `cadence.ts` / `callingWindow.ts`.
5. **Placing the call** — when due, the **Vapi assistant (Everly)** dials the carrier and runs the scripted conversation, calling function tools in real time as the conversation produces structured data (quote captured, decline reason, callback requested, escalation needed).
6. Vapi sends **webhook events** back (`src/server/webhookHandlers.ts`): mid-call tool calls, and the end-of-call report (transcript, recording, summary).
7. A submitted quote is written to **both** MDR (source of truth, via the write-back API) and a local `Quote` audit copy (`src/db/models/Quote.ts`) — the local copy is written first, so a failed MDR write still leaves proof of what was captured.
8. Stop conditions are re-checked after **every single call**, not just at the end of a batch — this is what stops the scheduler from over-calling a load once it's covered.
9. If a call hits a guardrail condition (negotiation, legal/compliance question, unclear terminal rules, aggressive caller, tool failure, direct request for a human), the assistant uses `escalate_to_human` to log it and collect a callback time — there is no live transfer capability in this system.

Full diagram: [call-flow.md](call-flow.md).

## Components

### A. Orchestration service (the "brain")
The backend service that owns all decision logic — Vapi and MDR are both just APIs it talks to.
- **Load-eligibility scanner** — scheduled job (or event-driven, if MDR can push a webhook when a load's email window expires) that finds loads under threshold.
- **Carrier queue builder** — applies eligibility, ranking, dedup, and attempt-cadence rules from the playbook's Developer Decision Logic section.
- **Call dispatcher** — rate-limited, respects calling windows/time zones, calls the Vapi API to start each call.
- **Webhook receiver** — ingests Vapi's call events and tool-call payloads.
- **MDR API client** — reads loads/carriers/email-response status, writes quotes/declines/callbacks/transcripts back.
- **Stop-condition re-evaluator** — runs after every call to decide whether to keep dialing that load's queue.
- **Idempotency/locking** — ensures the same carrier is never dialed twice concurrently for the same load.

### B. Vapi assistant configuration (Everly)
- **System prompt** — the call script from the playbook (opening, permission/qualification, load presentation, pricing capture for every accessorial type, transload/warehouse-storage/final-mile branches, objection responses, read-back & confirmation, close) converted into assistant instructions, with the guardrails (no false award claims, no inventing facts, no negotiating below floor, never dispatch/confirm a rate) written directly into the instructions as hard constraints.
- **Dynamic call variables** — load-specific data (route, equipment, container size/type, weight, timing, cargo, service scope, accessorial policy) injected per call at dial time, so one assistant config serves every load.
- **Function-calling tools** — this is how free-form conversation becomes structured data:
  - `submit_quote` — base rate, fuel, chassis, accessorials, total, capacity, validity, explicit confirmation flag
  - `log_decline` — decline reason (from MDR's standardized taxonomy) + free-text note
  - `schedule_callback` — date/time, time zone
  - `escalate_to_human` — reason, captured question, preferred contact method
  - `record_do_not_call` — opt-out flag, scope (calls only vs. calls+email)
  - `update_contact` — wrong-number/redirect handling
- **Voicemail detection** — with the approved voicemail script, respecting the "no sensitive details in voicemail" rule.
- **Call recording & transcription** — enabled per MDR's disclosure/consent configuration. Note: Vapi's default retention is short (14 days on Pay-As-You-Go); we should route recordings to our own S3/GCS storage or pull them via webhook immediately after each call, since MDR's audit-trail requirement needs permanent storage.
- **Live transfer** — configured as a tool so the assistant can hand off to a human number mid-call when a guardrail condition fires.

### C. Data store
A database mirroring the schema from the playbook's "Structured Data to Save in MDR" section — this is our source of truth for dedup and stop-condition checks even if MDR sync has latency:
- `loads`, `carriers`, `call_attempts`, `quotes`, `quote_line_items`, `decline_reasons`, `escalations`
- Every call attempt logged with result, timestamps, transcript link, recording link, agent/prompt version — for auditability per the playbook's requirements.

### D. MDR integration layer
- A thin API client wrapping whatever MDR exposes (REST/GraphQL/webhooks) for reads (loads, carriers, email-response status) and writes (quotes, declines, callbacks, transcripts).
- Falls back to polling if MDR has no real-time push mechanism.
- Built as a swappable module — mocked against local test data first, then pointed at MDR's real API once access is granted, so the rest of the system doesn't have to wait on that access to be built and tested.

### E. Config/admin layer
- Stores MDR's chosen values (quote threshold, email wait time, max attempts, calling window, voicemail policy, disclosure/recording language, target-rate sharing, negotiation authority, auto-submit confidence, notifications) per account — must support per-broker/shipper overrides, not just one global default, per the client's explicit ask.
- Orchestration service and Vapi assistant read from this at call time, so changing a setting doesn't require a code deploy.

### F. Escalation / warm transfer
- Vapi supports live call transfer to a phone number — configure this as a tool the assistant can invoke when guardrail-triggering conditions occur.
- Transfer includes a spoken summary handoff per the script.
- If no human is available live, falls back to `schedule_callback`.

## Phases & Steps

Each phase's steps keep their original numbering (Step 1, Step 2, ...) for cross-reference stability with [requirements-tracker.md](requirements-tracker.md), even where that means a phase's steps aren't strictly sequential (e.g., Step 7 belongs to Phase 1 even though Step 6 — a different phase — comes before it numerically).

### Phase 0 — Foundations & Accounts
**Goal**: Vapi, Twilio, repo, hosting all in place. **Blocked by**: Twilio KYC timing (external). **Done when**: accounts exist, credentials in `.env`.

**Step 1 — Accounts & environment setup**
1.1. Create the Vapi account and get an API key. **Done** — key received and verified working, stored in local `.env`.
1.2. Decide the phone number source (new Vapi-provisioned number vs. Twilio/existing MDR number) and provision it. Area code 757 confirmed by client; Twilio account still pending — see [twilio-setup.md](twilio-setup.md).
1.3. Set up the backend repo, language/framework, and hosting environment.
1.4. Set up the database (schema comes in Step 3).
1.5. Set up a staging environment with mock load/carrier data so nothing is blocked on MDR API access.

### Phase 1 — Core Build (against mock data)
**Goal**: Everly + orchestration engine fully working. **Blocked by**: nothing — pure build time. **Done when**: simulated load-to-quote cycle works end to end, including stop conditions and escalation.

**Step 2 — Build the Vapi assistant (Everly)**
2.1. Convert the playbook's call-flow sections into the assistant's system prompt (opening, permission/qualification, load presentation, pricing capture, transload/warehouse-storage/final-mile branches, objections, read-back & confirmation, close).
2.2. Define the dynamic call variables (route, equipment, timing, cargo, service scope, etc.) injected per call.
2.3. Define the function-calling tool schemas: `submit_quote`, `log_decline`, `schedule_callback`, `escalate_to_human`, `record_do_not_call`, `update_contact`.
2.4. Write the prohibited-behavior guardrails directly into the assistant instructions (no false award claims, no inventing facts, no negotiating below floor, no dispatch/rate confirmation).
2.5. Configure voicemail detection and the approved voicemail script.
2.6. Enable call recording and transcription per the disclosure policy (route to owned storage — see Component B above).
2.7. Test manually with mock load data using Vapi's own test-call tooling — no orchestration service needed yet.

**Step 3 — Data model**
3.1. Design the schema: `loads`, `carriers`, `call_attempts`, `quotes`, `quote_line_items`, `decline_reasons`, `escalations`.
3.2. Build migrations.
3.3. Seed mock loads and carriers for development/testing.

**Step 4 — Orchestration service skeleton** ✅ done, verified against live Vapi + Atlas
4.1. ✅ Load-eligibility scanner — `src/orchestration/eligibility.ts`
4.2. ✅ Carrier queue builder (eligibility filters + ranking) — `src/orchestration/queueBuilder.ts`
4.3. ✅ Call dispatcher (cadence + timezone-aware calling window + real Vapi dial) — `src/orchestration/dispatcher.ts`, `src/orchestration/callingWindow.ts`, `src/orchestration/cadence.ts`
4.4. ✅ Webhook receiver (tool-calls + end-of-call-report) — `src/server/index.ts`, `src/server/webhookHandlers.ts`
4.5. ✅ Stop-condition re-evaluator — `src/orchestration/stopConditions.ts`
4.6. ✅ Idempotency/locking — unique `(loadId, carrierId, attemptNumber)` index on `CallAttempt`, verified a re-run doesn't double-dial

**Step 5 — End-to-end test against mock data** ✅ done
5.1. ✅ Verified the full loop live: dialed a real (fictional-number) test call via Vapi, received the `submit_quote` tool-call webhook, wrote a valid `Quote`, then verified `end-of-call-report` correctly filled in transcript/recording/summary
5.2. ✅ Verified idempotency (immediate re-run created zero duplicate attempts) and the threshold→stop transition (adding quotes up to the threshold correctly flips the quote-status endpoint's `allowCalling` to `false`)

**Step 7 — Guardrails & escalation** 🔵 mostly done
7.1. ✅ Incomplete/unconfirmed `submit_quote` calls are marked `pending_review` instead of auto-valid
7.2. ⏸ Live warm-transfer — blocked on Frank providing a real human transfer number; `escalate_to_human` currently logs an `Escalation` record but has no number to transfer to yet
7.3. ✅ `schedule_callback` tool implemented and verified

### Phase 2 — MDR Integration
**Goal**: Swap mock data for MDR's real system. **Blocked by**: MDR API docs/credentials delivered. **Done when**: a real load flows through and a quote writes back successfully in staging.

**Step 6 — Integrate the real MDR API** 🔵 built against a mock of the client's own proposed spec, not the real API yet
6.1. ⏸ Get final API docs and credentials from MDR — client sent `Everly_MDR_API_Workload_Timeline_Estimation.pdf` (their own proposed 7-endpoint spec, ~12-15 dev days on their side); we sent back clarifying questions (see [requirements-tracker.md](requirements-tracker.md)), call pending.
6.2. ✅ (against the mock) Built the MDR read client — `src/mdr/api.ts`/`client.ts` — covering all 7 proposed endpoints, plus a mock-only mock service (`src/mock-mdr-api/`) implementing them with fake data so orchestration could be built and verified without waiting on the client.
6.3. ✅ (against the mock) Build the MDR write-back client — `submit_quote` and `record_do_not_call` in `webhookHandlers.ts` now POST/PATCH through `src/mdr/api.ts`, per the narrowed scope in [requirements-tracker.md](requirements-tracker.md).
6.4. ✅ (against the mock) Swapped the mock data layer — `eligibility.ts`, `queueBuilder.ts`, `callVariables.ts`, `stopConditions.ts`, `dispatcher.ts` all read through `src/mdr/api.ts` now, not local Mongoose `Load`/`Carrier`/`Quote` models (removed). Swapping to the real API once the client delivers it is a `MDR_API_BASE_URL`/`MDR_API_KEY` env change only. **Remaining before this step is truly done**: the mock's `invitedCarrierIds` and `bidEmailSentAt` fields are GAP-FILL guesses (see `src/mock-mdr-api/README.md`) for gaps in the client's spec that are still pending their answer — reconcile field shapes once confirmed.

### Phase 3 — Configuration & Compliance Lock-In
**Goal**: Every open business/legal decision finalized. **Blocked by**: Frank + MDR legal. **Done when**: no config placeholders left; legal has signed off, **including TCPA consent basis for AI-voice calls to carrier numbers**.

**Step 8 — Configuration layer**
8.1. Build the settings table for MDR's config values (threshold, wait time, calling window, disclosure policy, negotiation authority, etc.), with per-account override support.
8.2. Wire those settings into both the orchestration service and the Vapi call variables.
8.3. Load in the client's confirmed default values — see [requirements-tracker.md](requirements-tracker.md).

### Phase 4 — QA
**Goal**: Prove correct behavior under the playbook's test scenarios. **Blocked by**: Phases 2+3 complete, MDR reviewer named. **Done when**: MDR has reviewed and approved sample output.

**Step 9 — QA**
9.1. Run every scenario from the playbook's Appendix B test list end-to-end in staging.
9.2. Fix issues found.
9.3. Get MDR sign-off on a batch of sample call transcripts/recordings.

### Phase 5 — Pilot & Rollout
**Goal**: Prove it in the real world. **Blocked by**: everything above, real test carrier contacts. **Done when**: MDR comfortable running unsupervised.

**Step 10 — Pilot & rollout**
10.1. Run a limited pilot on a small number of real loads with human review of every call.
10.2. Monitor results, adjust script/logic/settings as needed.
10.3. Expand to full rollout once the pilot is clean.

## Open technical decisions to confirm

- **Hosting**: where does the orchestration service run — MDR's infrastructure, ours, or a shared cloud environment?
- **Time zones**: carrier-local calling windows require per-carrier time zone data from MDR.
- **Observability**: logging/alerting for failed calls, MDR API outages, and low-confidence transcriptions that should trigger human review instead of auto-submission.
- **Backend stack**: Node/TypeScript vs. Python for the orchestration service (leaning Node since Vapi's SDK/webhooks are most natural there) — not yet confirmed.
- **Repo**: this directory isn't a git repo yet — not yet confirmed whether/when to initialize one.
- **Vapi account scope**: confirmed — the client's Vapi account (accessed via the provided API key) is separate from any personal/other accounts; it currently has one pre-existing assistant ("Riley," unused/likely a default onboarding template) and zero phone numbers configured.
