import { vapi } from "./client.js";

export async function createOutboundCall(params: {
  assistantId: string;
  phoneNumberId: string;
  customerNumber: string;
  variableValues: Record<string, string | number | boolean>;
  // Per-call override of the assistant's stored firstMessage — used when
  // there's prior call history for this load+carrier, so the opening line
  // itself (not just what the LLM says after it) reflects that. Omit for
  // the assistant's default (every first-time call).
  firstMessage?: string;
  // The confirmed contact name on file for this carrier (contactMemory.ts's
  // getKnownContact), if any — passed straight through to Deepgram as a
  // nova-3 keyterm boost so THIS specific name transcribes more reliably if
  // the same contact says it again on this call. Deliberately per-call and
  // dynamic, not a static list — we have no fixed set of expected names to
  // pre-register, only ever the one specific name we already have on file
  // for this one carrier. Omit when there's no known contact yet (first-time
  // calls have nothing to boost toward).
  knownContactName?: string;
}) {
  return vapi.post<{ id: string }>("/call", {
    assistantId: params.assistantId,
    phoneNumberId: params.phoneNumberId,
    customer: { number: params.customerNumber },
    assistantOverrides: {
      variableValues: params.variableValues,
      ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
      ...(params.knownContactName
        ? {
            transcriber: {
              provider: "deepgram",
              model: "nova-3",
              language: "en",
              keyterm: [params.knownContactName],
            },
          }
        : {}),
    },
  });
}

/**
 * Fetches a call's own authoritative record straight from Vapi — used for
 * reconciliation when our webhook never received (or received an incomplete)
 * end-of-call-report, e.g. because the tunnel/server was down at the time.
 * See src/orchestration/reconcile.ts.
 */
export function getCall(callId: string) {
  return vapi.get<{
    status: string;
    endedReason?: string;
    artifact?: { transcript?: string; recording?: { stereoUrl?: string } };
    summary?: string;
    analysis?: { summary?: string };
  }>(`/call/${callId}`);
}
