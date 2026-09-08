/**
 * Local audit copy of the quote Everly builds for a call — kept
 * independently of MDR's own copy so there's durable proof of exactly what
 * was captured and sent, even if MDR's write fails, is delayed, or their
 * system later shows something different. One record per CallAttempt
 * (upserted on callAttemptId): calculateQuote() in webhookHandlers.ts
 * creates/updates it with MDR's calculated rateCalculation as soon as
 * call-result comes back, and submitQuote() updates the same record with
 * the final confirmed fields once the carrier explicitly confirms and
 * call-final-result is sent — so a carrier who never confirms still leaves
 * a record of what was calculated, and a failed final MDR write still
 * leaves a record of what was submitted (mdrSubmissionStatus: "failed").
 *
 * Field names mirror MDR's real call-result/call-final-result request shape
 * (src/mdr/api.ts) in camelCase, not the old speculative submit_quote
 * schema (chassis/freeTime/detentionRate/capacity/transload/
 * warehouseStorage/finalMile/isConditional) — none of those map to
 * anything in the real API and have been dropped.
 */
import { Schema, model, Types } from "mongoose";

const quoteSchema = new Schema(
  {
    loadId: { type: String, required: true, index: true },
    carrierId: { type: String, required: true, index: true },
    callAttemptId: { type: Types.ObjectId, ref: "CallAttempt", required: true, unique: true },

    baseRate: Number,
    fsc: Number,
    accTypes: [Number],
    transloadRate: Number,
    finalmileRate: Number,
    finalmileFsc: Number,
    isWarehouse: Number, // 0 or 1, matches MDR's own representation
    storageRate: Number,
    warehouseId: Number,
    rateValidUntil: String,
    driverAvailable: String,
    details: String,
    allIn: Number, // 0 or 1 — derived from whether accTypes is empty, not asked

    carrierConfirmedReadBack: Boolean,

    // MDR's own calculated breakdown from call-result — see MdrCallResultResponse.
    rateCalculation: Schema.Types.Mixed,
    mdrQuoteId: Number,

    // Populated once call-final-result is actually sent — see submitQuote() in webhookHandlers.ts.
    mdrSubmissionStatus: { type: String, enum: ["submitted", "failed"], default: "failed", index: true },
    mdrError: String,
  },
  { timestamps: true }
);

export const Quote = model("Quote", quoteSchema);
