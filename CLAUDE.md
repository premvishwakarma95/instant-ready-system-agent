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
The same logic also runs on a `node-cron` schedule inside `src/server/index.ts` — both the route and the cron job call the same exported `runDispatchCycle()`, one implementation. The cron registration is currently **commented out** (pending go-ahead), so today dispatch only fires via the manual route above.

There is no mock MDR service and no `/simulator` UI in this repo anymore (both removed) — dispatch talks to MDR's real staging API directly. There is no lint config and no automated test suite — verification is done by running the actual scripts above against the live Vapi API, MDR's real staging API, and a real MongoDB Atlas cluster. Prefer a throwaway script (delete it after) or a real live call over trusting typecheck alone — this repo has already caught real bugs (a timezone calculation error, a Mongoose `updateOne`-on-`createdAt` no-op, a cross-load call-memory self-reference bug) that typechecking did not.

## Required environment (`.env`)

`VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `EVERLY_ASSISTANT_ID` (set after first `assistant:create` run), `ORCHESTRATION_WEBHOOK_URL` (public URL — ngrok in dev — that Vapi calls back into for tool-calls/end-of-call-report), `MONGODB_URI`, `MDR_API_BASE_URL` (MDR's real staging API: `https://staging.mydrayrate.com/api`), `MDR_API_KEY`, `MDR_WEBHOOK_SECRET`, `PORT` (default 3000), `CALLING_WINDOW_DAYS`/`CALLING_WINDOW_START_HOUR`/`CALLING_WINDOW_END_HOUR` (real values: Mon-Fri, 8-17 — sometimes temporarily widened to 0-24 in `.env` for live testing; always confirm which is currently set before trusting a dispatch run to reflect real calling hours).

**`.env.example` is currently stale** — it still documents the removed mock-MDR setup (`MOCK_MDR_PORT`, `MDR_ACCOUNT_ID`, a `localhost:4000` base URL). Go by the real `.env` and this file, not `.env.example`, until it's refreshed. Twilio vars are intentionally omitted until that integration starts — see `twilio-setup.md`.

## Architecture

MDR's integration is push-based: MDR calls Everly's own webhook with the load + invited carriers, and Everly writes results back through MDR's own per-outreach endpoints — there is no MDR polling and no separate orchestration layer. Dispatch decision logic lives directly in `src/server/`.

Six directories under `src/`, talking to each other only through the MDR API, the inbound webhook, and MongoDB:

1. **`src/assistant/`** — defines Everly herself. `prompt.ts` is the entire conversational script (playbook-derived, heavily hand-tuned through many live-call iterations — treat edits here as high-risk, keep them additive) with `{{variable}}` placeholders. `tools.ts` defines 8 custom function-calling tools (see below) plus Vapi's native `endCall`. `create.ts` pushes both to Vapi via `POST`/`PATCH /assistant`.

2. **`src/mdr/`** — the real MDR API client. `client.ts` is a thin fetch wrapper (`Authorization: Bearer MDR_API_KEY`) against `MDR_API_BASE_URL`. `api.ts` implements MDR's confirmed staging endpoints — writes keyed on `outreach_id`, the two lookups keyed on `carrier_id`/`load_id`:
   - `getAllCarriers(loadId)` / `getAllCarriersBatch(loadId, batch)` — `GET /voice/load/{loadId}`, paginated (batch size 25)
   - `getSpecificCarrier(loadId, carrierId)` — `GET /voice/load/{loadId}/carrier/{carrierId}`
   - `declineCarrier(outreachId, reason)` — `POST /voice/decline`
   - `stopCarrier(outreachId, reason)` — `POST /voice/stop`
   - `resendInvitationEmail(outreachId)` — `POST /voice/email-resend`
   - `addAccessorial(outreachId, name, price)` — `POST /voice/add-accessorials`
   - `addWarehouse(outreachId, address)` — `POST /voice/add-warehouse`
   - `submitCallResult(payload)` — `POST /voice/call-result` (mid-call, returns MDR's calculated total)
   - `submitCallFinalResult(payload)` — `POST /voice/call-final-result` (after carrier confirms)

   Known quirk: MDR's staging backend 500s if `acc_types` is sent as a real JSON array — it must be JSON-stringified first (`serializeAccTypes` in `api.ts`).

3. **`src/vapi/`** — the real Vapi API client, same thin-wrapper pattern as `mdr/`. `client.ts` is the fetch wrapper; `calls.ts` has `createOutboundCall()` (places the real call, supports a per-call `assistantOverrides.firstMessage` override) and `getCall()` (reconciliation lookup by call id).

4. **`src/db/`** — Mongoose models and connection. See Data model below.

5. **`src/server/`** — the whole decision + webhook layer, one Express app:
   - `mdrWebhook.ts` — `POST /webhooks/mdr/capture`: raw-captures every payload into `WebhookResponse` first (audit safety net, never blocks), then upserts the local `Load` from `req.body.load` and calls `getAllCarriers` to upsert local `Carrier` records.
   - `dispatch.ts` — `POST /dispatch/run` (optional `?dryRun=true`) plus the exported `runDispatchCycle(dryRun)`. For every open local `Load` and every non-`stop_call` local `Carrier`: re-fetches fresh MDR carrier state, checks close/threshold/stop/timezone/`email_sent_at` validity, computes the next due attempt via `cadence.ts`, checks `callingWindow.ts`, creates a `CallAttempt` (idempotent — a duplicate-key race loser is treated as "already claimed," not an error), and calls `createOutboundCall`.
   - `cadence.ts` — the confirmed attempt cadence as pure functions (attempt 1: 30 min after `email_sent_at`; attempt 2: +1hr; attempt 3: +2hr; attempt 4: next business morning). `MAX_CALL_ATTEMPTS = 4`.
   - `callingWindow.ts` — timezone-aware calling-hours logic: `isWithinCallingWindow`, `nextCallingWindowOpen`, `nextBusinessMorning`, `wallClockToUtc` (interprets an LLM-supplied wall-clock callback time against the carrier's real MDR-sourced timezone, ignoring any offset embedded in the model's string — MDR's value is always the source of truth, never a carrier-stated one), `formatCallingWindow`.
   - `callMemory.ts` — builds the `{{callMemory}}` prompt variable: a single natural-language sentence describing the most recent *meaningful* prior `CallAttempt` for this real carrier, queried **cross-load** by MDR's stable `carrier_id` (bounded to the last 25 attempts, backed by a `{carrierId, startedAt}` index — never a not-yet-finished attempt). Also exports `hasMeaningfulPriorContact()`, used to pick between `FOLLOW_UP_FIRST_MESSAGE`/`FOLLOW_UP_UNANSWERED_FIRST_MESSAGE` in `prompt.ts`.
   - `callVariables.ts` — maps a `Load` + fresh MDR carrier detail + `callMemory` into every `{{variable}}` referenced in `prompt.ts`. Keep these two files in sync when either changes.
   - `callOutcome.ts` — classifies Vapi's `endedReason` into an internal status (`completed`/`voicemail`/`no_answer`/`failed`, explicit allowlist, unrecognized reasons default to `failed` and are logged), writes transcript/recording/summary onto the `CallAttempt`.
   - `webhookHandlers.ts` — `POST /vapi/tool-calls` handling for both Vapi message types: `tool-calls` (routes each of the 8 custom tools, see below) and `end-of-call-report` (post-call transcript/summary/recording). Resolves load/carrier/attempt context server-side by matching `message.call.id` against `CallAttempt.vapiCallId` — tool schemas deliberately never expose `loadId`/`carrierId`/`outreachId` as LLM-supplied parameters, since the model has no reliable way to know these; follow this pattern for any new tool. Every MDR call in this file uses `attempt.outreachId`, never `attempt.carrierId` (see `CallAttempt.ts`'s field comments for why the two are stored separately).
   - `index.ts` — mounts `mdrWebhook.ts` at `/webhooks/mdr` and `dispatch.ts` at `/dispatch`, defines `POST /vapi/tool-calls` and `GET /health`, plus the (currently commented-out) cron registration.

6. **`src/config/`** — `env.ts`, a small required-env accessor. `mdrAccountId` is currently dead code (read but unused anywhere else) — safe to remove if you're in this file.

## Assistant tools (`src/assistant/tools.ts`)

8 custom function-calling tools, all routed through `POST /vapi/tool-calls` → `webhookHandlers.ts`'s `dispatchTool`, plus Vapi's native `endCall`:

| Tool | MDR write-through |
|---|---|
| `calculate_quote` | `submitCallResult` (call-result) — returns MDR's calculated total before read-back |
| `submit_quote` | `submitCallFinalResult` (call-final-result); also flips local `Carrier.stop_call = true` |
| `log_decline` | `declineCarrier` (decline); flips local `Carrier.stop_call = true` |
| `record_do_not_call` | `stopCarrier` (stop); flips local `Carrier.stop_call = true` |
| `resend_email` | `resendInvitationEmail`; flips local `Carrier.stop_call = true` |
| `add_accessorial` | `addAccessorial` |
| `add_warehouse` | `addWarehouse` |
| `schedule_callback` | local only — MDR has no callback endpoint; writes `CallAttempt.callbackAt`/`callResult` |

There is **no dedicated escalation tool and no live-transfer capability** — `prompt.ts`'s "Human follow-up" section explicitly reuses `schedule_callback` as the human-handoff mechanism (state the issue out loud, schedule a callback, a human at MDR follows up). Don't add `escalate_to_human`/`update_contact` — they were tried and deliberately removed; this table is the current, real tool set.

## Data model (`src/db/models/`)

- **`CallAttempt`** — Everly's own operational/audit record, one per dial attempt. `loadId`/`outreachId`/`carrierId` are all plain strings (MDR's external ids), not ObjectId refs. `outreachId` is what cadence/`MAX_CALL_ATTEMPTS` and every MDR write endpoint are scoped by (reissued fresh per load invitation, even for the same real carrier); `carrierId` is MDR's stable per-company id, used only by `callMemory.ts` for cross-load history — don't conflate the two. Unique compound index `{loadId, outreachId, attemptNumber}` backs idempotency; a second index `{carrierId, startedAt}` backs the cross-load memory query.
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
- `twilio-setup.md` — accurate, pure external account/number setup checklist, not yet acted on.

(No `client-proposal.md` exists in the repo despite being referenced in older docs — treat that as a dangling reference, not a missing file to look for.)
