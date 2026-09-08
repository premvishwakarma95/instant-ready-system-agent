# Carrier Representative Agent — Full Call Flow

End-to-end flow combining activation logic (Section 2), the call script (Sections 5–11, 18), and developer decision logic (Section 12) from MDR's playbook. Cross-reference: [project-info.md](project-info.md), [build-plan.md](build-plan.md).

```mermaid
flowchart TD
    N1[Load posted in MDR]
    N2[Email bid invite sent to eligible carriers]
    N3[Wait for configured email-response window]
    D1{Valid quote count meets threshold?}
    N4[No voice outreach needed]
    N5[Build or refresh eligible carrier queue]
    D2{Any eligible carrier left in queue?}
    N6[Stop: carrier pool exhausted]
    N7[Take next carrier, dial via Vapi within calling window]
    D3{Call connected?}
    D4{Voicemail allowed?}
    N8[Leave voicemail]
    N9[Log attempt, no voicemail]
    N10[Schedule next attempt per cadence]
    D5{Max attempts reached for carrier?}
    N11[Mark carrier exhausted for this bid]
    D6{Right person?}
    N12[Ask for correct contact]
    N13[Update contact record]
    N14[Transferred opening script]
    N15[Identify MDR and purpose]
    D7{Handles this lane and equipment?}
    N16[Answer clarifying question]
    N17[Log decline reason]
    N18[Load summary, ask interest]
    D8{Interested in quoting?}
    N19[Capture drayage rate and accessorials]
    D9{Transload in scope?}
    N20[Capture transload pricing]
    D10{Warehouse storage required?}
    N21[Capture storage pricing terms]
    D11{Final mile in scope?}
    N22[Capture final-mile pricing]
    D12{Data valid and complete?}
    N23[Mark quote conditional, continue capturing]
    N24[Escalate to human]
    D13{Live human available?}
    N25[Warm transfer with conversation summary]
    N26[Schedule callback]
    N27[Read back quote, request explicit confirmation]
    D14{Carrier confirms quote?}
    N28[Submit quote into MDR, note selection not guaranteed]
    N29[Post-call: log result, transcript, recording, versions]
    N30[Notify posting user per settings]
    D15{Stop condition met?}
    N31[Stop outreach for this load]

    N1 --> N2 --> N3 --> D1
    D1 -- Yes --> N4
    D1 -- No --> N5 --> D2
    D2 -- No --> N6
    D2 -- Yes --> N7 --> D3

    D3 -- No answer or busy --> D4
    D4 -- Yes --> N8 --> N10
    D4 -- No --> N9 --> N10
    N10 --> D5
    D5 -- No --> D2
    D5 -- Yes --> N11 --> D2

    D3 -- Connected --> D6
    D6 -- Wrong number --> N12 --> N13 --> D2
    D6 -- Transferred --> N14 --> N15
    D6 -- Correct person --> N15

    N15 --> D7
    D7 -- Needs clarification --> N16 --> D7
    D7 -- No --> N17
    D7 -- Yes --> N18 --> D8
    D8 -- Not interested --> N17
    D8 -- Yes --> N19
    N17 --> N29

    N19 --> D9
    D9 -- Yes --> N20 --> D10
    D9 -- No --> D11
    D10 -- Yes --> N21 --> D11
    D10 -- No --> D11

    D11 -- Yes --> N22 --> D12
    D11 -- No --> D12

    D12 -- Missing or unknown detail --> N23 --> D12
    D12 -- Contradiction or escalation trigger --> N24 --> D13
    D13 -- Yes --> N25 --> N29
    D13 -- No --> N26 --> N29

    D12 -- Valid and complete --> N27 --> D14
    D14 -- Wants changes --> N19
    D14 -- Confirms --> N28 --> N29

    N29 --> N30 --> D15
    D15 -- "Threshold reached / bid closed / paused" --> N31
    D15 -- No, continue --> D2
```

## Stage-by-stage notes

| Stage | Playbook section | What happens |
|---|---|---|
| Load posted → email sent → wait window | Section 2, Activation Logic | Existing MDR email flow; no voice agent involvement yet |
| Threshold check | Section 2 + Section 12 "Threshold counting" | Only valid, non-duplicate quotes covering the required scope count |
| Queue build | Section 12 "Pre-call eligibility" + "Carrier ranking" | Excludes already-quoted/DNC/ineligible carriers; ranks by lane/equipment match, service history, capacity — never by cheapest historical rate alone |
| Dial / no-answer handling | Section 11, Voicemail and Callback Scripts | Voicemail script used only if allowed and no sensitive shipment details included |
| Attempt cadence | Section 12 "Attempt cadence" | Suggested default: initial call + 1 retry + 1 final attempt before bid close, no repeated same-day calls |
| Wrong number / transfer | Section 5.1, Opening – Correct Contact | Agent asks for the right contact or continues with the transferred-opening script |
| Lane/equipment qualification | Section 5.2, Permission and Qualification | Declines here go straight to logging a decline reason (Section 14 taxonomy) |
| Load presentation & interest check | Section 5.3, Concise Load Presentation | Agent asks for interest before reading every detail |
| Pricing capture | Section 6 (drayage), Section 7/7.1 (transload/storage), Section 8 (final mile) | Full accessorial capture per the pricing field table |
| Validation | Section 12 "Quote validation" + Section 17 "Fail-safe behavior" | Missing/unknown details → marked conditional, call continues. Contradictions/disputes → real escalation |
| Escalation | Section 12 "Human escalation" + Section 16 | Warm transfer if a human is available, otherwise a scheduled callback |
| Read-back & submission | Section 9, Quote Read-Back and Submission | Explicit verbal confirmation required before any quote is submitted; carrier is told selection isn't guaranteed |
| Post-call logging | Section 13, Structured Data to Save in MDR | Full audit trail: transcript, recording, agent/prompt version, disclosure delivered |
| Stop-condition re-check | Section 12 "Stop conditions" | Runs after every single call, not just at the end of a batch — this is what prevents over-calling a load once it's covered |

## Not shown on the diagram (global override)

A **do-not-call request** can happen at any point in any call (Section 10's objection table: "Remove us from calls"). When it does, the agent immediately records the opt-out, ends the call, and the carrier is excluded from all future outreach for this and other loads — this short-circuits the flow from wherever it currently is, rather than following any of the branches above.
