/**
 * Local Load record, extracted from MDR's real load.posted webhook
 * (POST /webhooks/mdr/capture — see src/server/mdrWebhook.ts). Field names
 * mirror MDR's payload exactly, no renaming — see the real captured example
 * in WebhookResponse for the source of truth this was built against.
 *
 * Types match what MDR actually sends, not what their docs claim: quantity,
 * cargo_weight, and target_rate all arrive as strings despite being
 * documented as integer/number/decimal, so they're modeled as strings here
 * rather than force-coerced. id/quote_id/distance arrive as real numbers.
 *
 * `id` (MDR's internal load id, e.g. 962) is the unique lookup key — it's
 * what MDR's own API URLs are scoped by (see the webhook's `api.all_carriers`
 * link). `quote_id` is a separate field — the carrier-facing reference number
 * ("Quote Request #10796") Everly states on calls, not used for lookups.
 */
import { Schema, model } from "mongoose";

const loadSchema = new Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    quote_id: { type: Number, required: true },
    distance: Number,
    origin_metro_location: String,
    origin_service_location: String,
    lfd_cut: String,
    load_available_date: String,
    customer_name: String,
    customer_location: String,
    length: String,
    quantity: String,
    shipment_type: String,
    ssl: String,
    commodity: String,
    cargo_weight: String,
    hazmat: Boolean,
    reefer: Boolean,
    target_rate: String,
    // Fuel surcharge percentage — same string-not-number quirk as
    // target_rate/quantity/cargo_weight. Confirmed via a real capture
    // (WebhookResponse 6a95592b05bf606979e3478d, 2026-08-31) — not yet
    // wired into any prompt variable or quote logic.
    fsc: String,
    notes: String,
    frequency_status: String,
    freight_status: String,
    is_load_close: Boolean,
    // Local field, defaults to true on insert — distinct from MDR's own
    // live response_summary.is_agent_call_on (which dispatch.ts checks
    // fresh from MDR on every run, not from this stored value). Not yet
    // wired into any decision logic — management TBD.
    is_agent_call_on: { type: Boolean, default: true },
    service_type: String,
    // New field confirmed via a real capture (WebhookResponse
    // 6a8939c36687310a4669e7dd, 2026-08-22) — not yet used by any prompt
    // variable; see git history / project notes for what it should drive.
    is_warehouse_needed: Boolean,
    // Only present when service_type includes transloading (per the API
    // doc's own note: drayage-only loads omit these entirely rather than
    // sending null) — confirmed via a real capture with
    // service_type "Drayage + Transloading + Final Mile" (2026-08-05).
    storage_needed: Boolean,
    storage_days: Number,
    storage_pallets: Number,
    created_at: String,
  },
  { timestamps: true }
);

export const Load = model("Load", loadSchema);
