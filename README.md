# Everly — MDR Carrier Representative Agent

An AI voice agent built on [Vapi](https://vapi.ai) that calls freight carriers on behalf of **My Dray Rate (MDR)**, a drayage marketplace, to follow up on loads that haven't gotten enough email quote responses. Everly runs MDR's own "Carrier Bid Follow-Up" playbook: she calls eligible carriers, collects a rate quote through a structured conversation, reads it back for confirmation, and submits it back into MDR.

## Status

Currently in dev phase — built and verified end-to-end against mock data and a personal Vapi/Twilio account. Not yet connected to MDR's real load/carrier data or a production phone number. See [build-plan.md](build-plan.md) for the phased rollout status.

## Architecture

Three layers that only talk to each other through MongoDB and the Vapi API:

- **`src/assistant/`** — Everly's conversational script and function-calling tools, pushed to Vapi via its API.
- **`src/orchestration/`** — the decision engine: which loads need outreach, which carriers to call and when, timezone-aware calling windows, and stop conditions.
- **`src/server/`** — the Express webhook receiver that Vapi calls back into during and after each call, to capture quotes, declines, callbacks, escalations, and call recordings/transcripts.

Full architecture details are in [CLAUDE.md](CLAUDE.md).

## Setup

```bash
npm install
cp .env.example .env   # fill in VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, MONGODB_URI
npm run assistant:create   # creates/updates the Everly assistant in Vapi
npm run db:seed            # seeds mock loads/carriers into MongoDB (dev only)
```

## Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — run after any change |
| `npm run db:seed` | Wipes and reseeds mock loads/carriers (dev only) |
| `npm run assistant:create` | Creates or updates the Everly assistant in Vapi |
| `npm run dispatch:run` | Runs a single orchestration cycle (eligibility scan → queue → dial) |
| `npm run server:dev` | Starts the webhook receiver on `$PORT` (default 3000), with reload |

There is no automated test suite yet — verification has been done by running these scripts against the live Vapi API and a real MongoDB cluster. See [CLAUDE.md](CLAUDE.md) for details.

## Documentation

- [project-info.md](project-info.md) — full spec digest from MDR's source playbook
- [build-plan.md](build-plan.md) — architecture, phased build plan, current status
- [requirements-tracker.md](requirements-tracker.md) — confirmed config values and what's still needed from the client
- [call-flow.md](call-flow.md) — Mermaid diagram of the end-to-end call flow
- [twilio-setup.md](twilio-setup.md) — Twilio account/number setup steps
- [CLAUDE.md](CLAUDE.md) — guidance for AI coding agents working in this repo
