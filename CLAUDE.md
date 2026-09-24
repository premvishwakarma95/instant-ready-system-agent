# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Everly** — an AI voice agent built on Vapi that calls freight carriers on behalf of My Dray Rate (MDR), a drayage marketplace, to collect rate quotes on loads that haven't gotten enough email responses. This repo implements MDR's own "Carrier Bid Follow-Up" playbook (the two PDFs in the repo root) as a working system: a Vapi assistant + an Express service that decides who to call, when, and writes results back to MDR's real API.

## Commands

```bash
npm install               # install deps
npm run typecheck         # tsc --noEmit — run this after any change, no test suite exists yet
npm run server:dev        # starts the Express webhook/dispatch server on $PORT (default 3000), with reload
npm run db:reset          # clears local CallAttempt + Quote only (dev-only) — Load/Carrier/WebhookResponse are left in place
npm run assistant:create  # creates the Everly assistant in Vapi, or updates it if EVERLY_ASSISTANT_ID is set in .env
```

There is no standalone dispatch script anymore. Trigger a dispatch cycle manually:
```bash
curl -X POST http://localhost:3000/dispatch/run              # runs for real
curl -X POST "http://localhost:3000/dispatch/run?dryRun=true" # full decision pipeline, zero side effects (reports would_dial)
```
The same logic also runs on a `node-cron` schedule inside `src/server/index.ts` — both the route and the cron job call the same exported `runDispatchCycle()`, one implementation. The cron job is **enabled** (`*/5 * * * *`, every 5 minutes) as of 2026-09; the manual route above still works too, for one-off testing.

There is no mock MDR service and no `/simulator` UI in this repo anymore (both removed) — dispatch talks to MDR's real staging API directly. There is no lint config and no automated test suite — verification is done by running the actual scripts above against the live Vapi API, MDR's real staging API, and a real MongoDB Atlas cluster. Prefer a throwaway script (delete it after) or a real live call over trusting typecheck alone — this repo has already caught real bugs (a timezone calculation error, a Mongoose `updateOne`-on-`createdAt` no-op, a cross-load call-memory self-reference bug) that typechecking did not.

## Required environment (`.env`)

`VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `EVERLY_ASSISTANT_ID` (set after first `assistant:create` run), `AGENT_NAME` (dashboard display name only, never spoken on calls — defaults to `"Everly-(IRS)"` if unset; set it per environment, e.g. `Agent 2 (staging)`/`Agent 2 (production)`, so separate Vapi assistants aren't confused for one another), `ORCHESTRATION_WEBHOOK_URL` (public URL — ngrok in dev — that Vapi calls back into for tool-calls/end-of-call-report), `MONGODB_URI`, `MDR_API_BASE_URL` (MDR's real staging API: `https://staging.mydrayrate.com/api`), `MDR_API_KEY`, `PORT` (default 3000), `TEST_DISPATCH_API_KEY` (shared secret required as the `x-api-key` header on the two real MDR webhook routes, `POST /webhooks/mdr/capture` and `POST /webhooks/mdr/update-flags`), `CALLING_WINDOW_DAYS`/`CALLING_WINDOW_START_HOUR`/`CALLING_WINDOW_END_HOUR` (real values: Mon-Fri, 8-17 — sometimes temporarily widened to 0-24 in `.env` for live testing; always confirm which is currently set before trusting a dispatch run to reflect real calling hours), `TWILIO_ACCOUNT_SID`/`TWILIO_API_KEY_SID`/`TWILIO_API_SECRET` (read-only reconciliation of a call's real billed price via `src/twilio/client.ts` — Vapi places the call itself, this project never manages Twilio numbers/calls directly).

`MDR_WEBHOOK_SECRET` is dead — dropped from `.env`/`.env.example` entirely, confirmed unused anywhere in `src/`. `.env.example` is up to date with the real required set above; go by it (and the real `.env`) rather than any older doc that still mentions the removed mock-MDR setup or `MDR_WEBHOOK_SECRET`.

## Architecture

MDR's integration is push-based: MDR calls Everly's own webhook with the load + invited carriers, and Everly writes results back through MDR's own per-outreach endpoints — there is no MDR polling and no separate orchestration layer. Dispatch decision logic lives directly in `src/server/`.

Six directories under `src/`, talking to each other only through the MDR API, the inbound webhook, and MongoDB:

1. **`src/assistant/`** — defines Everly herself. `prompt.ts` is the entire conversational script (playbook-derived, heavily hand-tuned through many live-call iterations — treat edits here as high-risk, keep them additive) with `{{variable}}` placeholders. `{{quoteId}}` is the ONLY reference number ever spoken to a carrier (always as "shipment {{quoteId}}", never "quote," "quote ID," or "ID" alone) — `{{loadId}}` is internal-only and must never be read aloud; a real call exposed both numbers before this was tightened (2026-09-23), see the "Shipment details for this call" section. `tools.ts` defines 11 custom function-calling tools (see below) plus Vapi's native `endCall`. `create.ts` pushes both to Vapi via `POST`/`PATCH /assistant`, using `AGENT_NAME` (env) for the assistant's dashboard display name.

2. **`src/mdr/`** — the real MDR API client. `client.ts` is a thin fetch wrapper (`Authorization: Bearer MDR_API_KEY`) against `MDR_API_BASE_URL`, plus a `postForm` variant for MDR's form-data-only endpoints; both surface the real underlying `fetch()` failure reason (DNS/connection-reset/TLS/timeout, via `.cause`) instead of a generic "fetch failed" message. `api.ts` implements MDR's confirmed staging endpoints — writes keyed on `outreach_id`, lookups keyed on `carrier_id`/`load_id`:
   - `getAllCarriers(loadId)` / `getAllCarriersBatch(loadId, batch)` — `GET /voice/load/{loadId}`, paginated (batch size 25)
   - `getSpecificCarrier(loadId, carrierId)` — `GET /voice/load/{loadId}/carrier/{carrierId}` — **confirmed dead for this flow, 404s.** Not called anywhere live; `getSelectCarrierDetails` below is the real fresh-carrier lookup.
   - `getSelectCarrierDetails(loadId, carrierId)` — `GET /voice/select/load/{loadId}/carrier/{carrierId}` — the actual fresh per-carrier lookup `dispatch.ts` uses before every dial.
   - `declineCarrier(outreachId, reason)` — `POST /voice/decline`
   - `stopCarrier(outreachId, reason)` — `POST /voice/stop`
   - `resendInvitationEmail(outreachId)` — `POST /voice/email-resend`
   - `updateCarrierDetail(outreachId, name, phone?)` — `POST /voice/update-carrier-detail` (form-data) — used by `confirm_contact`; a successful write here doesn't reliably come back through `getSelectCarrierDetails` afterward (see `contactMemory.ts` below).
   - `addAccessorial(outreachId, name, price)` — `POST /voice/add-accessorials`
   - `addWarehouse(outreachId, address)` — `POST /voice/add-warehouse`
   - `submitCallResult(payload)` — `POST /voice/call-result` (mid-call, returns MDR's calculated total)
   - `submitCallFinalResult(payload)` — `POST /voice/call-final-result` (after carrier confirms)
   - `submitCallLog(payload)` — `POST /voice/call-logs` — called once per ended call (connected or not) so MDR has a record of every attempt, not just successful ones; status is computed by `callOutcome.ts`'s `mapToMdrCallLogStatus`.
   - `closeCall(outreachId)` — `POST /voice/call-closed` (form-data) — client-provided endpoint (2026-09-18): signals the outreach's calling effort is over with no resolution. Called once, right after the call-log push, only when this was the final allowed attempt (`MAX_CALL_ATTEMPTS`) AND the call-log status was neither `DECLINED` nor `ACCEPTED` — see `webhookHandlers.ts` below.

   Known quirk: MDR's staging backend 500s if `acc_types` is sent as a real JSON array — it must be JSON-stringified first (`serializeAccTypes` in `api.ts`).

3. **`src/vapi/`** — the real Vapi API client, same thin-wrapper pattern as `mdr/`. `client.ts` is the fetch wrapper; `calls.ts` has `createOutboundCall()` (places the real call, supports a per-call `assistantOverrides.firstMessage` override) and `getCall()` (reconciliation lookup by call id).

4. **`src/db/`** — Mongoose models and connection. See Data model below.

5. **`src/server/`** — the whole decision + webhook layer, one Express app:
   - `mdrWebhook.ts` — `POST /webhooks/mdr/capture`: raw-captures every payload into `WebhookResponse` first (audit safety net, never blocks), then upserts the local `Load` from `req.body.load` and calls `getAllCarriers` to upsert local `Carrier` records.
   - `dispatch.ts` — `POST /dispatch/run` (optional `?dryRun=true`) plus the exported `runDispatchCycle(dryRun)`. For every open local `Load` and every non-`stop_call` local `Carrier`: re-fetches fresh MDR carrier state, checks close/threshold/stop/timezone validity, computes the next due attempt via `cadence.ts`, checks `callingWindow.ts` (skipped for attempt 1 — see `cadence.ts` below), looks up `contactMemory.ts`'s `getKnownContact()` to pick `FIRST_MESSAGE` vs `KNOWN_CONTACT_FIRST_MESSAGE`, creates a `CallAttempt` (idempotent via a unique `{loadId, outreachId, attemptNumber}` index — a duplicate-key race loser is treated as "already claimed," not an error), and calls `createOutboundCall`. `processLoad`'s carrier-selection aggregation only considers carriers with **at least one existing** `CallAttempt` — attempt 1 is placed synchronously, once, straight off `mdrWebhook.ts`'s webhook (see that file), never through this cron loop.
   - `cadence.ts` — the confirmed attempt cadence as pure functions: attempt 1 is due immediately, right now, with no calling-window gate at all (2026-09-24, explicit instruction — closes a real gap where a first attempt deferred to the next window-open would leave that carrier permanently invisible to `processLoad`'s ≥1-attempt aggregation, since nothing else would ever retry it); attempt 2: +1hr from attempt 1, still window-gated; attempt 3: +2hr from attempt 2, still window-gated; attempt 4: next business morning. `MAX_CALL_ATTEMPTS = 4`.
   - `callingWindow.ts` — timezone-aware calling-hours logic: `isWithinCallingWindow`, `nextCallingWindowOpen`/`nextBusinessMorning` (walk forward day-by-day and always return a freshly-built `CALLING_WINDOW_START_HOUR:00` local instant, never a timestamp carried forward with a leftover minute from `from` — a real bug fixed 2026-09-24, ported from the sibling Carrier-Representative-Agent repo, where the old 30-minutes-at-a-time search could land a Tuesday-morning attempt at 8:10 instead of a clean 8:00), `wallClockToUtc` (interprets an LLM-supplied wall-clock callback time against the carrier's real MDR-sourced timezone, ignoring any offset embedded in the model's string — MDR's value is always the source of truth, never a carrier-stated one), `formatCallingWindow`. **A carrier-named `schedule_callback` time is never checked against this window** (removed 2026-09-24, ported from the same sibling repo) — `dispatch.ts`'s `isCallbackDriven` branch dials it exactly as given, unchecked, on the reasoning that the carrier naming their own availability is a stronger signal than the default window policy exists to protect. This is a real safety-relevant behavior change (a misparsed time could now get dialed at any hour) — confirm intent before assuming it should carry to every environment.
   - `contactMemory.ts` — `getKnownContact(carrierId, excludeAttemptId)`: looks up the most recent confirmed pricing/dispatch contact for this real carrier, queried **cross-load** by MDR's stable `carrier_id` (same reasoning as the old call-memory lookup it replaced — see Data model below). Deliberately reads our own `CallAttempt.confirmedContactName` rather than MDR's `contact_name` field — confirmed empirically that a successful `update-carrier-detail` write doesn't come back through `getSelectCarrierDetails`/`getSpecificCarrier`, so MDR's copy can't be trusted as the "did we already confirm this" signal. **`callMemory.ts` (the prior "what did we discuss last time" feature) was removed entirely per client direction (2026-09-14)** — there is no `{{callMemory}}` variable and no follow-up-specific first message anymore; `contactMemory.ts` only tracks *who* the confirmed contact is, not what was discussed.
   - `callVariables.ts` — maps a `Load` + fresh MDR carrier detail + an optional known-contact name into every `{{variable}}` referenced in `prompt.ts`, including `{{knownContactName}}` (ours, confirmed by us) and `{{mdrContactName}}` (MDR's own on-file value, a secondary reference signal only — see `prompt.ts`'s "Opening — correct contact"). Keep this in sync with `prompt.ts` when either changes.
   - `callOutcome.ts` — classifies Vapi's `endedReason` into an internal status (`completed`/`voicemail`/`no_answer`/`failed`, explicit allowlist, unrecognized reasons default to `failed` and are logged), writes transcript/recording/summary onto the `CallAttempt`.
   - `webhookHandlers.ts` — `POST /vapi/tool-calls` handling for both Vapi message types: `tool-calls` (routes each of the 11 custom tools, see below) and `end-of-call-report` (post-call transcript/summary/recording, plus the MDR call-log/call-closed push described next). Resolves load/carrier/attempt context server-side by matching `message.call.id` against `CallAttempt.vapiCallId` — tool schemas deliberately never expose `loadId`/`carrierId`/`outreachId` as LLM-supplied parameters, since the model has no reliable way to know these; follow this pattern for any new tool. Every MDR call in this file uses `attempt.outreachId`, never `attempt.carrierId` (see `CallAttempt.ts`'s field comments for why the two are stored separately). `submit_quote`/`log_decline`/`record_do_not_call`, and the max-attempts-exhausted path below, each also flip local `Load.is_load_close = true` (this flow guarantees one carrier per load, so any of these outcomes closes the whole load, not just this carrier).

     `handleEndOfCallReport` computes `mapToMdrCallLogStatus(attempt)` once up front and pushes it via `submitCallLog` (call-log). If this was the call's `MAX_CALL_ATTEMPTS`-th attempt AND that status was neither `DECLINED` nor `ACCEPTED`, it then also calls `closeCall(attempt.outreachId)` (call-closed) — guarded by its own dedicated `CallAttempt.mdrCallClosedAt` field, deliberately separate from `mdrCallLogSubmittedAt`, since the two MDR pushes are independent actions with different success conditions (reusing one guard for both would either duplicate-fire or under-fire depending on which action's condition holds).
   - `index.ts` — mounts `mdrWebhook.ts` at `/webhooks/mdr` and `dispatch.ts` at `/dispatch`, defines `POST /vapi/tool-calls` and `GET /health`, plus the `node-cron` registration (enabled, every 5 minutes — see Commands above).

6. **`src/config/`** — `env.ts`, a small required-env accessor. `mdrAccountId` is currently dead code (read but unused anywhere else) — safe to remove if you're in this file.

## Assistant tools (`src/assistant/tools.ts`)

11 custom function-calling tools, all routed through `POST /vapi/tool-calls` → `webhookHandlers.ts`'s `dispatchTool`, plus Vapi's native `endCall`:

| Tool | MDR write-through |
|---|---|
| `calculate_quote` | `submitCallResult` (call-result) — returns MDR's calculated total before read-back |
| `submit_quote` | `submitCallFinalResult` (call-final-result); also flips local `Carrier.stop_call = true` and `Load.is_load_close = true` |
| `log_decline` | `declineCarrier` (decline); flips local `Carrier.stop_call = true` and `Load.is_load_close = true` |
| `record_do_not_call` | `stopCarrier` (stop); flips local `Carrier.stop_call = true` and `Load.is_load_close = true` |
| `resend_email` | `resendInvitationEmail`; flips local `Carrier.stop_call = true` |
| `confirm_email_quote` | local only — reinstated 2026-09 for a carrier who explicitly says they'll confirm/quote by email instead of on the call; writes `CallAttempt.callResult`. See "I'll confirm/quote by email" in `prompt.ts`'s Common objections. |
| `resume_phone_quote` | local only — undoes an earlier `confirm_email_quote` if the carrier changes their mind mid-call and wants to continue on the phone. |
| `add_accessorial` | `addAccessorial` |
| `add_warehouse` | `addWarehouse` |
| `schedule_callback` | local only — MDR has no callback endpoint; writes `CallAttempt.callbackAt`/`callResult`. **Not validated against the calling window** (removed 2026-09-24 — see `callingWindow.ts` above); `dispatch.ts` dials the carrier-named time exactly as given. |
| `confirm_contact` | `updateCarrierDetail` (`POST /voice/update-carrier-detail`, form-data — see `client.ts`'s `postForm`); writes `CallAttempt.confirmedContactName`/`confirmedContactPhone` (what `contactMemory.ts` actually reads back cross-load) and mirrors `Carrier.contact_name`/`phone` locally. Called only when there's an actual new/corrected name to save — see `prompt.ts`'s "Opening — correct contact" for the full known/unknown-contact branching, including the mandatory phone read-back and the `contactOnThisCall` flag (reported to MDR's call-log as `WRONG_CONTACT` when false). |

There is **no dedicated escalation tool and no live-transfer capability** — `prompt.ts`'s "Human follow-up" section explicitly reuses `schedule_callback` as the human-handoff mechanism (state the issue out loud, schedule a callback, a human at MDR follows up). Don't add `escalate_to_human`/`update_contact` — they were tried and deliberately removed; this table is the current, real tool set.

## Data model (`src/db/models/`)

- **`CallAttempt`** — Everly's own operational/audit record, one per dial attempt. `loadId`/`outreachId`/`carrierId` are all plain strings (MDR's external ids), not ObjectId refs. `outreachId` is what cadence/`MAX_CALL_ATTEMPTS` and every MDR write endpoint are scoped by (reissued fresh per load invitation, even for the same real carrier); `carrierId` is MDR's stable per-company id, used only by `contactMemory.ts` for cross-load known-contact lookups — don't conflate the two. `confirmedContactName`/`confirmedContactPhone` are set by the `confirm_contact` tool and are the actual source of truth `contactMemory.ts` reads from (MDR's own `contact_name` doesn't reliably reflect a successful write-back — see `contactMemory.ts`'s header comment). `mdrCallLogSubmittedAt`/`mdrCallClosedAt` are separate idempotency guards for the two independent post-call MDR pushes (call-log, call-closed — see `webhookHandlers.ts` above); don't collapse them into one field. Unique compound index `{loadId, outreachId, attemptNumber}` backs idempotency; a second index `{carrierId, startedAt}` backs the cross-load known-contact query.
- **`Carrier`** — a **local model** (re-added; not API-only), upserted from `getAllCarriers` on every webhook capture. Field names mirror MDR's real "Get All Carriers" response (`outreach_id`, `load_id`, `carrier_id`, `stop_call`, `calling_window`, etc.).
- **`Load`** — local cache, upserted from MDR's real load-webhook payload — MDR has no `GET /loads` to re-fetch from, so this is the only copy.
- **`Quote`** — Everly's own audit copy, written before the MDR write so a failed/flaky submission still leaves proof of what was captured. Field names/shape mirror MDR's real call-result/call-final-result request shape (`baseRate`, `fsc`, `storageRate`, `finalmileRate`, etc.).
- **`WebhookResponse`** — raw-capture safety net for every inbound webhook payload, kept regardless of structured extraction. Not cleared by `db:reset`.

There is **no `Escalation` model** — it was removed (nothing in the app ever wrote to it); escalation is handled via `schedule_callback` (see Assistant tools above).

**Mongoose gotcha**: `Model.updateOne()` silently no-ops when setting a `timestamps`-managed `createdAt` field (reports `modifiedCount: 1` but the value doesn't persist). If you need to backdate a timestamp in a test script, use the raw driver: `Model.collection.updateOne(...)`.

## Project documentation (repo root, not code)

Several of these are currently **stale**, still describing the removed mock-MDR/4-endpoint design — check the file itself before trusting it, or ask for it to be refreshed, rather than assuming it's current:

- `project-info.md` — spec digest from MDR's two source PDFs; historical record of the original ask, not of what was actually built.
- `build-plan.md`, `requirements-tracker.md`, `test-cases.md`, `README.md` — **stale**: still reference `src/mock-mdr-api/`, `src/mdr-simulator-ui/`, `src/orchestration/`, `npm run dispatch:run`/`mock-mdr:dev`, the old 4-endpoint MDR design, and tools that don't exist (`escalate_to_human`, `update_contact`).
- `call-flow.md` — accurate at a conceptual/playbook level; its escalation node implies live transfer, which doesn't exist (see Assistant tools above — `schedule_callback` is the real mechanism).

`twilio-setup.md` no longer exists (removed once the Twilio integration it described was actually built — see `src/twilio/` and the required-environment section above) — a dangling reference to it in an older doc means that doc is stale, not that the file is missing by mistake.

(No `client-proposal.md` exists in the repo despite being referenced in older docs — treat that as a dangling reference, not a missing file to look for.)
