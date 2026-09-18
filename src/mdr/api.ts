/**
 * Typed functions for MDR's real Voice API endpoints (see "MDR Voice Team
 * API Integration Guide"). Get All Carriers / Get Specific Carrier are
 * confirmed against live staging responses; the rest (decline/stop/
 * email-resend/add-accessorials/add-warehouse/call-result/call-final-result)
 * are built directly from the doc's request/response examples, not yet
 * exercised against staging.
 *
 * Get All Carriers / Get Specific Carrier's method is unconfirmed (the
 * doc's own table says GET, its detail section header says POST) — using
 * GET per the table, and confirmed working against real staging data.
 */
import { mdr } from "./client.js";

export interface MdrCallingWindow {
  startingTime: string;
  endTime: string;
}

export interface MdrCarrier {
  outreach_id: number;
  carrier_id: number;
  rank: number;
  carrier_timezone: string;
  calling_window: MdrCallingWindow;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  email_sent: boolean;
  email_sent_at: string;
  stop_call: boolean;
  stop_reason: string | null;
}

export interface MdrResponseSummary {
  threshold: number;
  total_carriers: number;
  responses_received: number;
  responses_remaining: number;
  threshold_reached: boolean;
  is_agent_call_on: boolean;
}

export interface MdrGetAllCarriersResponse {
  is_load_close: boolean;
  response_summary: MdrResponseSummary;
  batch: number;
  batch_size: number;
  carriers: MdrCarrier[];
}

/**
 * Fetches one batch of carriers for a load. Paginated — batch_size is 25
 * per the real response, undocumented in either PDF. Callers needing the
 * full list should keep incrementing `batch` until they've collected
 * response_summary.total_carriers carriers.
 */
export function getAllCarriersBatch(loadId: number, batch = 1): Promise<MdrGetAllCarriersResponse> {
  return mdr.get<MdrGetAllCarriersResponse>(`/voice/load/${loadId}?batch=${batch}`);
}

const MAX_CARRIER_BATCHES = 200; // 200 * batch_size(25) = 5000 carriers — far above any real load, just a runaway-loop backstop

/** Fetches every carrier for a load, looping through all batches. */
export async function getAllCarriers(loadId: number): Promise<MdrGetAllCarriersResponse> {
  const first = await getAllCarriersBatch(loadId, 1);
  const carriers = [...first.carriers];

  // total_carriers has been unreliable enough elsewhere in this API (string
  // vs number type mismatches on other fields) that a missing/non-numeric
  // value here shouldn't be trusted to drive a loop condition — treat it as
  // "just this first batch" instead of looping on NaN comparisons forever.
  const totalCarriers = Number(first.response_summary?.total_carriers);
  if (!Number.isFinite(totalCarriers)) {
    console.warn(`getAllCarriers: missing/invalid total_carriers for load ${loadId}, returning first batch only`);
    return first;
  }

  let batch = 1;
  while (carriers.length < totalCarriers && first.carriers.length > 0) {
    if (batch >= MAX_CARRIER_BATCHES) {
      console.error(`getAllCarriers: hit ${MAX_CARRIER_BATCHES}-batch safety cap for load ${loadId} — returning ${carriers.length}/${totalCarriers} carriers`);
      break;
    }
    batch += 1;
    const next = await getAllCarriersBatch(loadId, batch);
    if (next.carriers.length === 0) break;
    carriers.push(...next.carriers);
  }

  return { ...first, carriers };
}

export interface MdrAccessorial {
  name: string;
  price: string;
  id: number;
}

export interface MdrWarehouse {
  address: string;
  id: number;
}

export interface MdrCarrierDetail extends MdrCarrier {
  accessorials: MdrAccessorial[];
  warehouses: MdrWarehouse[];
}

export interface MdrGetSpecificCarrierResponse {
  is_load_close: boolean;
  response_summary: MdrResponseSummary;
  carrier: MdrCarrierDetail;
}

/**
 * Fresh, single-carrier lookup — used immediately before deciding whether to
 * call, since load/carrier state can change between when the local queue was
 * built and now (threshold met, carrier opted out, load closed, etc.).
 *
 * This is Everly's bid-follow-up endpoint. Confirmed 404 (MDR's own "Not
 * Found" HTML page, not JSON) when called for a select.carrier.irs load —
 * this agent's own flow uses getSelectCarrierDetails below instead.
 */
export function getSpecificCarrier(loadId: number, carrierId: number): Promise<MdrGetSpecificCarrierResponse> {
  return mdr.get<MdrGetSpecificCarrierResponse>(`/voice/load/${loadId}/carrier/${carrierId}`);
}

export interface MdrSelectResponseSummary {
  carrier_id: number;
  has_outreach: boolean;
  outreach_status: string;
  is_agent_call_on: boolean;
  call_attempt_count: number;
  last_call_result: string | null;
}

export interface MdrGetSelectCarrierDetailsResponse {
  is_load_close: boolean;
  response_summary: MdrSelectResponseSummary;
  carrier: MdrCarrierDetail;
}

/**
 * Fresh, single-carrier lookup for the IRS/Select Carrier flow — same
 * purpose as getSpecificCarrier above (re-check before ever dialing, since
 * local/webhook data can go stale), but a different endpoint and a different
 * response_summary shape (has_outreach/outreach_status/call_attempt_count/
 * last_call_result here, not threshold/total_carriers/responses_received/
 * responses_remaining/threshold_reached). Confirmed against the URL a real
 * select.carrier.irs webhook handed us directly in its own api.carrier_details
 * field (WebhookResponse _id 6aa0034639806b5760db053e) — getSpecificCarrier's
 * endpoint 404s for this flow's loads/carriers, this is the correct one.
 */
export function getSelectCarrierDetails(
  loadId: number,
  carrierId: number
): Promise<MdrGetSelectCarrierDetailsResponse> {
  return mdr.get<MdrGetSelectCarrierDetailsResponse>(`/voice/select/load/${loadId}/carrier/${carrierId}`);
}

export interface MdrActionResponse {
  success: boolean;
  message: string;
}

/** Doc 2.5 — use only when the carrier explicitly refuses this load. */
export function declineCarrier(outreachId: number, reason: string): Promise<MdrActionResponse> {
  return mdr.post<MdrActionResponse>("/voice/call-select-carrier-deny", { outreach_id: outreachId, reason });
}

/** Doc 2.6 — stop contacting this carrier (opted out, wrong number, blocked, invalid phone). */
export function stopCarrier(outreachId: number, reason: string): Promise<MdrActionResponse> {
  return mdr.post<MdrActionResponse>("/voice/stop", { outreach_id: outreachId, reason });
}

/** Doc 2.7 — carrier asked for the invitation email to be resent. */
export function resendInvitationEmail(outreachId: number): Promise<MdrActionResponse> {
  return mdr.post<MdrActionResponse>("/voice/email-resend", { outreach_id: outreachId });
}

/**
 * Updates MDR's own confirmed pricing/dispatch contact for this outreach
 * (client-provided endpoint, ported from the sibling Carrier-Representative-
 * Agent project, 2026-09-11) — form-data, not JSON, see client.ts's
 * postForm. phone is optional; MDR's own example sends it as an empty
 * string when unknown rather than omitting the field. Same endpoint as the
 * sibling project's bid-follow-up flow — not one of the "select carrier"
 * variants (unlike declineCarrier/submitCallResult/submitCallFinalResult
 * above), since this agent's carrier-contact record is the same shape MDR
 * exposes generically, not scoped to the select-carrier flow.
 */
export function updateCarrierDetail(outreachId: number, name: string, phone: string = ""): Promise<MdrActionResponse> {
  return mdr.postForm<MdrActionResponse>("/voice/update-carrier-detail", {
    outreach_id: String(outreachId),
    name,
    phone,
  });
}

export interface MdrAddAccessorialResponse {
  success: boolean;
  accessorials: MdrAccessorial;
}

/** Doc 2.8 — register an accessorial the carrier named that isn't already in their known list. */
export function addAccessorial(outreachId: number, name: string, price: number): Promise<MdrAddAccessorialResponse> {
  return mdr.post<MdrAddAccessorialResponse>("/voice/add-accessorials", {
    outreach_id: outreachId,
    accessorial: name,
    price,
  });
}

export interface MdrAddWarehouseResponse {
  success: boolean;
  warehouse: MdrWarehouse;
}

/** Doc 2.9 — register a warehouse address the carrier named that isn't already in their known list. */
export function addWarehouse(outreachId: number, address: string): Promise<MdrAddWarehouseResponse> {
  return mdr.post<MdrAddWarehouseResponse>("/voice/add-warehouse", { outreach_id: outreachId, address });
}

/**
 * Shared request shape for call-result (doc 2.3) and call-final-result (doc
 * 2.4) — same fields, MDR expects the full set resent to each, not just a
 * reference to the earlier call-result call.
 */
export interface MdrCallResultRequest {
  outreach_id: number;
  base_rate: number;
  fsc: number;
  acc_types: number[];
  transload_rate?: number;
  finalmile_rate?: number;
  finalmile_fsc?: number;
  is_warehouse: 0 | 1;
  storage_rate?: number;
  warehouse_id?: number;
  // Reintroduced per client direction (2026-09-14) — this agent's
  // confirmation flow asks for an "earliest available truck date" (see
  // prompt.ts's Drayage pricing capture), sent to MDR under the same field
  // name the classic bid-follow-up flow used for driver availability.
  driver_available: string;
  details?: string;
}

export interface MdrAccessorialCharge {
  accessorial_id: number;
  name: string;
  unit_price: string;
  quantity: string;
  total: number;
}

export interface MdrRateCalculationData {
  quote_id: number;
  carrier_id: number;
  carrier_name: string;
  carrier_email: string;
  quantity: string;
  base_rate: { rate_per_unit: string; quantity: string; total: number };
  fsc: { percentage: string; amount: number; calculation: string };
  accessorial_charges: MdrAccessorialCharge[];
  accessorial_total: number;
  transload_charges: unknown;
  final_rate: number;
  rate_breakdown: {
    base_rate_total: number;
    fsc_amount: number;
    accessorial_total: number;
    transload_total: number;
    grand_total: number;
  };
  driver_availability: string;
  details: string;
  existing_response: boolean;
}

export interface MdrCallResultResponse {
  success: boolean;
  // Flat, confirmed against a real call-select-carrier-result response
  // (2026-09-12) — the old /voice/call-result endpoint this was ported from
  // apparently wrapped this in a Laravel HTTP-client-shaped envelope
  // ({headers, original: {success, message, data}, exception}); the new
  // endpoint returns MdrRateCalculationData here directly, no wrapper.
  rate_calculation: MdrRateCalculationData;
}

/**
 * MDR's staging backend throws an uncaught server-side exception (500,
 * Laravel's default error page) when acc_types arrives as a real JSON
 * array. Sending the exact same value as a string — "[5,6]" or "[]" for
 * none — succeeds. Confirmed by isolation: identical payload, only this
 * field's JSON type changed, JSON vs multipart/form-data content-type made
 * no difference. This was the actual cause of the "call-result returns 500"
 * finding from 2026-08-06 — not a broken endpoint on MDR's side.
 */
function serializeAccTypes(accTypes: number[]): string {
  return JSON.stringify(accTypes);
}

/**
 * Doc 2.3 — call once mid-conversation, after the carrier has given their
 * rate, to get MDR's calculated total back. That calculated total (not
 * anything Everly computes herself) is what gets read back for
 * confirmation before submitCallFinalResult.
 */
export function submitCallResult(payload: MdrCallResultRequest): Promise<MdrCallResultResponse> {
  return mdr.post<MdrCallResultResponse>("/voice/call-select-carrier-result", {
    ...payload,
    acc_types: serializeAccTypes(payload.acc_types),
  });
}

export interface MdrCallFinalResultRequest extends MdrCallResultRequest {
  all_in: 0 | 1;
}

export interface MdrCallFinalResultResponse {
  success: boolean;
}

/** Doc 2.4 — call once, after the carrier explicitly confirms the calculated total. */
export function submitCallFinalResult(payload: MdrCallFinalResultRequest): Promise<MdrCallFinalResultResponse> {
  return mdr.post<MdrCallFinalResultResponse>("/voice/call-select-carrier-final-result", {
    ...payload,
    acc_types: serializeAccTypes(payload.acc_types),
  });
}

/**
 * MDR's own fixed business-outcome vocabulary for the Call Log API (spec
 * received 2026-08-27) plus CALL_DROPPED, added 2026-08-31 per explicit
 * instruction to cover a connected call the carrier hung up on before
 * reaching any conclusive outcome — confirmed on a real test call, MDR's
 * original 6 values had no honest equivalent for that case, plus
 * WRONG_CONTACT — the carrier who answered isn't who handles drayage
 * pricing and the real contact they named isn't reachable on this call
 * (see confirm_contact's contactOnThisCall in tools.ts). Mapped from our
 * CallAttempt.status/callResult in callOutcome.ts's mapToMdrCallLogStatus,
 * which still returns null (skip the push entirely) for outcomes that
 * remain a poor fit even with these values available (do_not_call, failed,
 * wrong_number) rather than force one of these onto something that doesn't
 * fit.
 */
export type MdrCallLogStatus =
  | "NO_ANSWER"
  | "LEFT_VOICEMAIL"
  | "FOLLOW_UP_REQUIRED"
  | "EMAIL_REQUESTED"
  | "ACCEPTED"
  | "DECLINED"
  | "CALL_DROPPED"
  | "WRONG_CONTACT";

export interface MdrCallLogRequest {
  outreach_id: number;
  call_id: string;
  status: MdrCallLogStatus;
  // MM:SS, per MDR's spec (e.g. "03:05") — see formatDurationMmSs in
  // callOutcome.ts, built from the same real Vapi timestamps as
  // CallAttempt.durationSeconds.
  duration: string;
  data?: Record<string, unknown>;
}

export interface MdrCallLogResponse {
  success?: boolean;
  [key: string]: unknown;
}

/**
 * Voice Team API Integration — Call Log API (spec received 2026-08-27, not
 * yet exercised against staging). Called once per ended call (connected or
 * not) so MDR's own system has a record of every attempt, not just
 * successful ones — separate from and in addition to the decline/stop/
 * call-result endpoints above, which report business outcomes rather than
 * raw call logs.
 */
export function submitCallLog(payload: MdrCallLogRequest): Promise<MdrCallLogResponse> {
  return mdr.post<MdrCallLogResponse>("/voice/call-logs", payload);
}

/**
 * Client-provided endpoint (2026-09-18) — signals that this outreach's
 * calling effort is over with no definitive resolution: this was the final
 * allowed attempt (see cadence.ts's MAX_CALL_ATTEMPTS) and the call-log
 * status pushed above was neither DECLINED nor ACCEPTED. Called once, right
 * after the call-log push, from the same end-of-call-report handler — see
 * webhookHandlers.ts. Form-data, not JSON, per the client-supplied example.
 */
export function closeCall(outreachId: number): Promise<MdrActionResponse> {
  return mdr.postForm<MdrActionResponse>("/voice/call-closed", {
    outreach_id: String(outreachId),
  });
}
