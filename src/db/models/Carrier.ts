/**
 * Local Carrier record, extracted from MDR's real "Get All Carriers"
 * endpoint (GET /voice/load/{load_id}?batch=1 — see src/mdr/api.ts). Field
 * names mirror MDR's response exactly, no renaming.
 *
 * `outreach_id` is the unique lookup key — it's what every MDR write
 * endpoint (call-result, decline, stop, email-resend, etc.) is keyed on, not
 * carrier_id. `load_id` is added on our side (not present in MDR's carrier
 * object itself) so a carrier record can be traced back to which load it was
 * fetched for, since this endpoint is always scoped to one load at a time.
 */
import { Schema, model } from "mongoose";

const carrierSchema = new Schema(
  {
    outreach_id: { type: Number, required: true, unique: true, index: true },
    load_id: { type: Number, required: true, index: true },
    carrier_id: { type: Number, required: true },
    rank: Number,
    carrier_timezone: String,
    calling_window: {
      startingTime: String,
      endTime: String,
    },
    company_name: String,
    contact_name: String,
    email: String,
    phone: String,
    email_sent: Boolean,
    email_sent_at: String,
    stop_call: Boolean,
    stop_reason: String,
  },
  { timestamps: true }
);

export const Carrier = model("Carrier", carrierSchema);
