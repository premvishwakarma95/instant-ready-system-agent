/**
 * "Known contact" lookup for the Opening flow (see prompt.ts's "Opening —
 * correct contact"). Cross-load: keyed on MDR's stable carrier_id, not
 * outreach_id, since a carrier is only "known" if WE confirmed their
 * contact on a genuinely prior call — possibly for a different load, since
 * outreach_id is reissued fresh per invitation. Deliberately does NOT read
 * MDR's own contact_name field — confirmed empirically (2026-09-11, in the
 * sibling Carrier-Representative-Agent project) that a successful
 * updateCarrierDetail write does not come back through
 * getSelectCarrierDetails/getSpecificCarrier, so MDR's copy can't be
 * trusted as the "did we already confirm this" signal. This local record is
 * the only source of truth for that.
 */
import { CallAttempt } from "../db/models/index.js";

export interface KnownContact {
  name: string;
  phone?: string;
}

/**
 * Most recent confirmed contact for this real carrier, or null if none
 * exists yet. excludeAttemptId excludes the attempt just created for the
 * current dial (in_progress, no confirmedContactName yet), to avoid a
 * genuinely first-ever call seeing its own not-yet-happened attempt
 * reflected back at it.
 */
export async function getKnownContact(mdrCarrierId: number, excludeAttemptId?: unknown): Promise<KnownContact | null> {
  const query: Record<string, unknown> = {
    carrierId: String(mdrCarrierId),
    confirmedContactName: { $exists: true, $ne: null },
  };
  if (excludeAttemptId) {
    query._id = { $ne: excludeAttemptId };
  }

  // Sorted by createdAt (Mongoose's own insertion timestamp), not startedAt —
  // startedAt is set by dispatch.ts at dial time and can legitimately be
  // backdated for cadence/testing purposes, which would otherwise make an
  // older confirmation look "more recent" than a real later one. createdAt
  // reflects true insertion order and is never touched by anything else in
  // this codebase.
  const attempt = await CallAttempt.findOne(query).sort({ createdAt: -1 }).select("confirmedContactName confirmedContactPhone").lean();

  if (!attempt?.confirmedContactName) return null;
  return {
    name: attempt.confirmedContactName,
    phone: attempt.confirmedContactPhone || undefined,
  };
}
