# Carrier Representative Agent — Project Info

## Client & Platform

- **Client / Platform**: My Dray Rate (**MDR**) — an AI-powered **drayage** marketplace and operations platform.
- **Domain**: Drayage = short-haul container trucking between ports/rail ramps and warehouses, terminals, or consignees. Optional add-on services: **Transload** and **Final Mile**.
- **Bigger picture**: MDR's long-term vision is a full "AI Workforce" — a suite of ~12 independent, toggleable voice/AI agents (Carrier Recruiting, Rate Update, Bid Confirmation, Quote Follow-Up, Customer Service, Dispatch, Appointment Scheduling, Collections, Sales Development, Ocean Freight, Warehouse Sourcing, Contact Verification), each configurable per customer with business hours, escalation rules, approval requirements, and company-specific instructions.
- **This project** is the **first agent** MDR wants built, referred to by the client as the **"Carrier Representative"**. It maps directly onto the blueprint's **"AI Bid Confirmation Agent"** and is fully specified in a second document as the **"Carrier Bid Follow-Up"** agent.

## Source documents

1. `MDR_AI_Workforce_and_Voice_Agent_Blueprint (1).pdf` — high-level platform spec covering all ~12 planned AI agents and global settings (master on/off, business hours, voice selection, escalation rules, approval requirements, call recording, max call attempts, exclusion lists).
2. `MDR_AI_Voice_Agent_Bid_Follow_Up_Script_Updated.pdf` (v. July 12, 2026) — **production-ready developer playbook** for this specific agent: full call script, decision logic, data schema, guardrails, escalation script, QA criteria, recommended settings, and test scenarios.

## Agent purpose

> When a load has fewer valid carrier quotes than the required threshold, the agent calls eligible carriers who haven't responded to the emailed bid invitation, presents the load, collects a complete and usable rate, confirms all assumptions/accessorials, and submits the quote into MDR — without misrepresenting the shipment or pressuring the carrier.

## Activation logic

1. A load is posted in MDR; eligible carriers receive an **email invitation** to quote.
2. MDR counts only **valid, non-duplicate** quotes that meet the load's requirements.
3. After a configurable **email-response window** expires, MDR compares the valid quote count to the **user-set threshold**.
4. If the threshold is **not** met, the AI voice agent calls eligible carriers who have not submitted a valid quote.
5. **Stop conditions** — the agent stops outreach when:
   - the quote threshold is reached,
   - the bid closes,
   - the shipment is covered,
   - the user pauses outreach, or
   - no eligible carriers remain.

Example: broker requests 5 quotes → 3 arrive by email → after the wait period, the agent calls non-responding carriers until 2 more valid quotes arrive or another stop condition is hit.

## Required inputs before any call

- **Load identity**: MDR load/bid number (customer-facing reference only if permitted)
- **Equipment**: container size/type, chassis requirement, overweight/tri-axle, reefer, hazmat, ISO tank, flat rack, open top, etc.
- **Routing**: port/rail ramp, pickup terminal, delivery city/state/ZIP, return location, final-mile destination
- **Timing**: vessel/rail availability, earliest pickup, last free day (LFD), appointment requirements, delivery window, bid expiration, expected start date
- **Cargo**: commodity, gross/container weight, hazmat details, temperature, value, special handling
- **Service scope**: drayage only, drayage+transload, drayage+final mile, or full combined scope
- **Operational assumptions**: live load/unload or drop, free time, storage expectations, chassis source, pre-pull, yard storage, container count/frequency
- **Pricing rules**: line-item vs all-in pricing, currency, accessorial schedule, fuel treatment, whether target pricing may be shared
- **Carrier eligibility**: approved authority, insurance, equipment, geography, safety/fraud screening, service history, do-not-call status
- **Disclosure settings**: approved AI/identity statement, recording disclosure, whether broker/shipper name may be stated, firm vs. forecasted load
- **Warehouse storage** (if applicable): pallet count/dimensions, storage start date/duration, storage class (ambient/refrigerated/bonded/hazmat), pricing basis (per pallet per day/month)

## Standard call flow

1. Confirm the correct carrier and contact.
2. Identify MDR and state the purpose of the call.
3. Confirm the carrier handles the lane and equipment.
4. Give a concise load summary.
5. Ask for interest before reading every detail.
6. Collect the complete drayage rate and required accessorials (fuel surcharge, chassis, pre-pull, yard storage, detention, layover, overweight, hazmat, reefer, tolls/port fees, split/stop, bobtail, scale/permit, weekend/after-hours, demurrage/per diem, other).
7. Collect transload and/or final-mile pricing when those are in scope.
8. Confirm capacity, assumptions, rate validity, and contact info.
9. **Read back the quote and get explicit verbal confirmation.**
10. Submit the quote into MDR and explain that selection is **not guaranteed**.

Full scripted dialogue trees exist for: opening/correct-contact, permission/qualification, concise load presentation, drayage pricing capture, optional transload script, warehouse storage pricing script, optional final-mile script, quote read-back & submission, ~12 common objections (e.g. "just email it to me," "what's the target rate?," "is the load awarded?," "your rate is too low," "remove us from calls"), voicemail/callback scripts, and a human-escalation script with warm transfer.

## Guardrails (hard constraints)

- Never state or imply the load is awarded when it's only open for bids.
- Never promise guaranteed volume, payment terms, detention approval, or selection unless explicitly authorized.
- Never alter a carrier's stated rate or negotiate below its floor without explicit authority.
- Never invent shipment facts (LFD, terminal status, cargo weight, customer identity, etc.).
- Never pressure with false scarcity, fake competing rates, or fabricated deadlines.
- Never accept a quote from an unverified/ineligible carrier without flagging for escalation.
- Never ask for banking info, passwords, or one-time codes.
- Never expose another carrier's identity or confidential rate.
- Must honor opt-outs and calling-hour restrictions immediately.
- **The AI must never dispatch a carrier or issue a rate confirmation** — a separate authorized human workflow handles award and dispatch.

## Escalation triggers

Negotiation beyond authority, legal/compliance questions, customer identity disputes, unusual/complex equipment or project cargo, uncertain terminal rules, aggressive callers, rate contradictions, system failures, or explicit carrier request for a human.

## Data to capture per call (→ MDR)

Bid ID, shipment ID, posting user ID; carrier legal name/DBA/MC-USDOT/contact info; call result (connected, voicemail, wrong number, callback, quote received, conditional quote, declined, do-not-call, escalation); lane and service scope quoted; every priced line item (amount, currency, included/excluded, calculation method, trigger); estimated all-in total; capacity, rate validity/expiration, assumptions; decline reason (standardized taxonomy + free text); carrier questions and follow-up owner; consent/disclosure status, recording link, transcript, summary, sentiment, quality score; agent/prompt version and all system actions taken.

## Decline reason taxonomy

Lane not serviced, no capacity, equipment unavailable, timing/appointment conflict, rate not workable, terminal not serviced, overweight/hazmat/reefer unsupported, no chassis availability, transload/final-mile unavailable, insurance/compliance limitation, customer/broker restriction, insufficient shipment info, bid already closed, duplicate request, carrier not interested, other (requires note).

## Configurable settings (Appendix A — needed per client account)

| Setting | Purpose |
|---|---|
| Required quote threshold | # of valid quotes needed before outreach stops |
| Email wait time | Delay after bid email before voice outreach begins |
| Bid close time | Hard deadline for accepting quotes |
| Maximum call attempts | Per carrier, per bid |
| Calling window | Carrier-local allowed days/hours |
| Voicemail allowed | Yes/No + approved voicemail template |
| AI disclosure & recording policy | Jurisdiction-aware |
| Share posting party identity | Always / after qualification / only if asked / never during bidding |
| Share target rate | Never / exact / range / only after first carrier rate |
| Negotiation authority | None / ask for best rate / approved target-range |
| Partial quote handling | Allow or reject drayage-only / transload-only / final-mile-only quotes |
| Auto-submit confidence | Minimum transcription & field-validation score |
| Human approval | Required for all quotes / exceptions only / fully automated |
| Notifications | Real-time / threshold-reached / exceptions only / daily summary |
| Carrier preference learning | Remember preferred lanes, equipment, contact times, opt-outs |

## Call quality / acceptance criteria

Identity & disclosure, accuracy (matches current MDR record), completeness (all required pricing fields captured), confirmation (explicit read-back before submission), no false award claims, operational usefulness (broker doesn't need to re-call for basic terms), carrier experience (concise, interruptible), compliance (calling windows, opt-outs, recording rules), auditability (transcript/summary/versions saved), fail-safe behavior (low-confidence or contradictory data triggers human review, not silent submission).

## What needs to be built

1. **Orchestration/decision engine** — implements activation logic, carrier eligibility/ranking, attempt cadence, quote validation, duplicate control, threshold counting, and all stop conditions.
2. **Voice AI conversation layer** — runs the scripted call flow (recommend a platform like Vapi or Retell AI that bundles telephony + STT + LLM + TTS + function-calling + recording/transcripts).
3. **MDR integration** — read loads/carriers/email-response status; write quotes, decline reasons, callbacks, transcripts back to MDR.
4. **Data store** — schema per the "Data to capture per call" section above; needs to support the full structured quote/accessorial breakdown.
5. **Admin/config layer** — implements the Appendix A settings per customer account.
6. **Escalation/handoff mechanism** — warm transfer to a human rep with conversation summary.
7. **QA/test suite** — covering the ~29 minimum test scenarios in Appendix B (standard quote, mismatched totals, hazmat missing docs, DNC request, voicemail, bid closes mid-call, threshold reached mid-call, low-confidence transcription, system outage during submission, etc.).

## Open questions for the client

1. Does MDR have an existing API/webhook for reading loads/carriers and writing quotes back, or does that integration need to be built?
2. What should the Appendix A settings default to for this first deployment (quote threshold, email-wait time, max attempts, calling window, disclosure policy, negotiation authority, target-rate sharing)?
3. Voice platform / outbound phone number — already provisioned, or ours to set up?
4. Has MDR's legal/compliance team approved the AI-disclosure and call-recording language, or is that still open?

## Status

Requirements are well-specified (the second PDF is essentially a production-ready spec). Not yet started: technical architecture decisions, MDR system access, and account-specific configuration values.
