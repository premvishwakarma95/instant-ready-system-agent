# Everly Test Plan

Covers the 29 minimum test scenarios from Appendix B of `MDR_AI_Voice_Agent_Bid_Follow_Up_Script_Updated.pdf`. Test against the mock MDR API (`src/mock-mdr-api/`) and real Vapi calls to test numbers — not the client's real system.

## 1. How to start everything

Run each of these in its own terminal window (so you can see live output and notice if one dies):

**Terminal 1 — mock MDR API**
```bash
npm run mock-mdr:dev
```
Confirm it's up: `curl http://localhost:4000/health` → `{"ok":true,...}`

**Terminal 2 — webhook receiver**
```bash
npm run server:dev
```
Confirm it's up: `curl http://localhost:3000/health` → `{"ok":true}`

**Terminal 3 — public tunnel** (Vapi needs to reach the webhook receiver from the internet)

Use ngrok, not localtunnel — localtunnel (`loca.lt`) died silently 3 times during testing (see the postmortem in git history around 2026-07-17); ngrok's free tier held up cleanly. One-time setup: sign up free at ngrok.com, get your authtoken from the dashboard, then `npx ngrok config add-authtoken <token>`. Then each session:
```bash
npx ngrok http 3000
```
Get the public URL either from the terminal output or `curl -s http://localhost:4040/api/tunnels | python3 -m json.tool` (ngrok's local inspection API). It'll look like `https://<random>.ngrok-free.dev`. Still verify it before every test run, same discipline as before:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<your-ngrok-url>/health
```
Must return `200`.

**One-time per session — point Vapi at the tunnel**

Update `.env`:
```
ORCHESTRATION_WEBHOOK_URL=https://<your-ngrok-url>/vapi/tool-calls
```
Then push it to the assistant:
```bash
npm run assistant:create
```
Re-run this any time the tunnel URL changes.

## 2. Resetting between test runs

To start a scenario from a clean slate:
```bash
npm run db:reset                                    # clears local CallAttempt/Escalation
curl -X POST http://localhost:4000/mock/reset        # resets mock loads/carriers/quotes
```

## 3. Test carrier numbers

Currently seeded in `src/mock-mdr-api/data.ts`:

| Carrier | Number | Load(s) invited on |
|---|---|---|
| Pacific Coast Drayage LLC (`carrier-1`) | +91 95898 17903 | load-1001 |
| Norfolk Intermodal Transport Inc. (`carrier-2`) | +91 83490 86753 | load-1001, load-1002 |
| Gulf Cartage & Warehousing Co. (`carrier-3`) | +91 88711 48578 | load-1001 |

To trigger a call: run `npm run dispatch:run` after reset (Terminal 1/2/3 must all be up first). Watch Terminal 2 for incoming webhook events as the call happens.

## 4. Test cases

Status legend: ☐ not tested · ✅ pass · ❌ fail (note what broke)

### A. Core quote capture

**TC-01 — Standard 40-foot dry container drayage quote**
- Setup: default seed data (load-1001, any carrier)
- Steps: answer the call, act as a normal carrier, give a complete base rate + all-in total, confirm the read-back
- Expected: `submit_quote` fires once with `carrierConfirmedReadBack:true`, quote status `valid` in mock MDR, `CallAttempt.callResult = quote_received`
- Status: ☐

**TC-02 — Carrier quotes all-in rate (no line-item breakdown)**
- Steps: when asked for pricing, give only a single all-in number, decline to break it into base/fuel/chassis
- Expected: Everly accepts the all-in total, `isConditional` may be true if she can't get a full breakdown — check which
- Status: ☐

**TC-03 — Carrier quotes line items with a total mismatch**
- Steps: give base + fuel + chassis that don't sum to the "all-in" number you also state
- Expected: Everly should flag the mismatch and ask you to clarify before submitting — she should **not** silently submit contradictory numbers (Guardrails, Section 15)
- Status: ☐

**TC-04 — Carrier requires chassis clarification**
- Steps: when asked about chassis, say you're not sure if it's carrier-supplied or customer-supplied and ask Everly to clarify
- Expected: Everly explains it clearly rather than guessing/inventing the answer
- Status: ☐

**TC-05 — Overweight load requiring tri-axle and permits**
- Setup: temporarily set `equipment.overweight: true` on a mock load
- Steps: mention overweight/tri-axle/permit requirements when quoting
- Expected: captured in accessorials or notes, not dropped
- Status: ☐

**TC-06 — Hazmat load with missing UN/packing group**
- Setup: temporarily set `equipment.hazmat: true` on a mock load, leave hazmat details incomplete
- Steps: as carrier, ask about UN number/packing group; Everly doesn't have it
- Expected: Everly should escalate or flag as conditional rather than inventing hazmat details (Guardrails: "invent... missing shipment fact" is prohibited)
- Status: ☐

**TC-07 — Reefer load with genset and temperature monitoring**
- Setup: `equipment.reefer: true`
- Steps: quote reefer-specific accessorials (genset fee, temp monitoring)
- Expected: captured as accessorial line items
- Status: ☐

**TC-08 — Unknown last free day and conditional quote**
- Setup: omit `timing.lastFreeDay` from a mock load
- Steps: give a quote but state it's conditional on knowing the last free day
- Expected: `isConditional:true`, `conditionalOn` describes the missing info, quote status `pending_review` not `valid`
- Status: ☐

### B. Transload / warehouse storage / final mile

**TC-09 — Transload selected with floor-loaded cartons**
- Setup: `serviceScope: "drayage_transload"`
- Steps: quote transload pricing, mention floor-loaded (non-palletized) cartons
- Expected: `transload` object populated on the quote
- Status: ☐

**TC-10 — Warehouse storage selected with per-pallet daily pricing and free days**
- Setup: load-1002 already has `warehouseStorage.required: true`
- Steps: quote a per-pallet-per-day rate and free days
- Expected: `warehouseStorage.ratePerPalletPerDay` and `freeDays` populated
- Status: ☐

**TC-11 — Warehouse storage quoted monthly with partial-month proration**
- Steps: quote a monthly rate instead of daily, mention proration for partial months
- Expected: `ratePerPalletPerMonth` populated; proration detail captured in notes/minimumCharge if the schema doesn't have a dedicated field — check what's actually captured vs. lost
- Status: ☐

**TC-12 — Warehouse storage with separate receiving/put-away/retrieval/outbound handling fees**
- Steps: quote each handling fee separately
- Expected: captured as accessorials under `warehouseStorage`, not merged into one number
- Status: ☐

**TC-13 — Oversized or non-stackable pallets requiring a different storage rate**
- Steps: mention oversized/non-stackable pallets needing a special rate
- Expected: captured distinctly, not silently averaged into the standard rate
- Status: ☐

**TC-14 — Refrigerated, bonded, or hazmat storage requiring special pricing and escalation**
- Setup: `warehouseStorage.storageClass: "refrigerated"` (or bonded/hazmat)
- Steps: as carrier, indicate this needs special handling/approval
- Expected: Everly escalates rather than quoting standard storage pricing for a special class
- Status: ☐

**TC-15 — Final mile selected with liftgate and appointment**
- Setup: `serviceScope: "drayage_final_mile"`
- Steps: quote final-mile pricing including liftgate and appointment-scheduling requirements
- Expected: `finalMile` object populated with equipment type/accessorials
- Status: ☐

### C. Carrier-side / conversational edge cases

**TC-16 — Carrier already submitted by email**
- Setup: pre-seed a quote in the mock (`source:"email"`) for a carrier before dialing them
- Expected: that carrier should **not** be in `buildCarrierQueue`'s output — verify via a dry run of the queue builder, not just the live call
- Status: ☐

**TC-17 — Threshold reached during an active call**
- Setup: submit quotes for 2 of 3 carriers on load-1001 first (threshold is 3), then place the 3rd call live and submit a quote mid-call
- Expected: after the 3rd valid quote, `checkStopConditions` returns `threshold_met`; if a 4th call was somehow queued, it should be skipped
- Status: ☐

**TC-18 — Carrier asks for customer identity**
- Steps: ask Everly "who is the actual shipper/broker behind this load?"
- Expected: follows `disclosureSettings.shareBrokerIdentity` (currently `false` in mock data) — Everly should decline to share it
- Status: ☐

**TC-19 — Carrier asks for target rate when disclosure is disabled**
- Steps: ask "what's your target rate for this load?"
- Expected: per `pricingRules.targetRateShareable: false`, Everly should not reveal a target rate
- Status: ☐

**TC-20 — Carrier requests callback**
- Steps: say you can't talk now, ask for a callback at a specific time
- Expected: `schedule_callback` fires, `CallAttempt.callbackAt`/`callbackTimeZone` set, `callResult: callback`
- Status: ☐

**TC-21 — Wrong contact and referral**
- Steps: say you're not the right person, refer Everly to someone else (give a name/extension)
- Expected: `update_contact` fires with corrected info, or the call ends cleanly without a forced quote
- Status: ☐

**TC-22 — Voicemail**
- Steps: don't answer the call, let it go to voicemail
- Expected: `VOICEMAIL_MESSAGE` plays, `CallAttempt.status` becomes `voicemail`, `endedReason` reflects it
- Status: ☐

**TC-23 — Do-not-call request**
- Steps: ask to be removed from calls
- Expected: `record_do_not_call` fires **immediately** (before anything else in the conversation per the prompt rules), `updateDoNotCall` PATCHes the mock, and that carrier is excluded from `buildCarrierQueue` on any subsequent load
- Status: ☐

**TC-24 — Carrier becomes abusive**
- Steps: be rude/hostile on the call
- Expected: Everly stays professional, likely escalates (`escalate_to_human`) rather than continuing to push for a quote
- Status: ☐

**TC-25 — Low-confidence speech recognition**
- Steps: mumble numbers, talk over background noise, or speak very fast for the pricing section
- Expected: Everly should ask for clarification/repeat rather than guessing a number and submitting it as `valid` — hard to verify precisely without transcript confidence scores exposed, so check the transcript afterward for whether she asked to confirm ambiguous numbers
- Status: ☐

**TC-26 — Bid closes during call**
- Setup: while a call is live, manually set that load's `bidCloseAt` in `src/mock-mdr-api/data.ts` to a past time (or add a way to PATCH it) and let the change reload
- Expected: `checkStopConditions` on the next check returns `bid_closed`; ideally the call still finishes gracefully rather than erroring
- Status: ☐

**TC-27 — Duplicate revised quote**
- Steps: after a quote's already been submitted for a carrier on a load, call again (or simulate a second `submit_quote` in the same flow) with different numbers
- Expected: check whether the mock/real logic treats this as a new quote, a version bump, or a rejection — current mock's `POST /quotes` doesn't implement versioning/superseding yet, so this may reveal a gap worth fixing
- Status: ☐

### D. System / escalation

**TC-28 — Human transfer and summary handoff**
- Steps: explicitly ask to speak to a human
- Expected: `escalate_to_human` fires with `liveTransferOffered` — note there's no real transfer number configured yet (`build-plan.md` Step 7.2, blocked on Frank), so this should currently produce a logged `Escalation` without an actual transfer, not a crash
- Status: ☐

**TC-29 — System/API outage during quote submission**
- Setup: stop the mock MDR API (Terminal 1) mid-call, right before the carrier gives their quote
- Steps: complete the pricing conversation, let Everly attempt `submit_quote`
- Expected: `submitQuoteToMdr` throws, the tool-call result returns an error to Vapi rather than crashing the webhook server; `CallAttempt` should not silently show `quote_received` if the submission actually failed — check whether this holds
- Status: ☐

## 5. Known gaps going in (don't file these as new bugs — already tracked)

- No transfer number for live warm-transfer (TC-28) — `build-plan.md` Step 7.2
- Quote versioning/superseding not implemented in the mock (TC-27) — mock is a simplified stand-in, not the full spec
- `invitedCarrierIds`/`bidEmailSentAt` are GAP-FILL guesses pending the client's answer — see `src/mock-mdr-api/README.md`
