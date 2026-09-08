/**
 * Maps a Load + fresh Carrier (from MDR's real "Get Specific Carrier"
 * response) into the {{variable}} placeholders referenced in
 * src/assistant/prompt.ts. Field mapping confirmed against real captured
 * MDR data (see project memory) — hazmat/reefer intentionally omitted (told
 * to ignore them); deliveryWindow/liveOrDrop/freeTime/chassisRequirement/
 * bidCloseTime intentionally dropped from prompt.ts entirely (confirmed no
 * source field exists); quoteId/shipmentType/targetRate added (confirmed
 * these should be spoken to the carrier).
 *
 * Keep this in sync whenever prompt.ts's placeholders change.
 */
import type { MdrCarrierDetail } from "../mdr/api.js";
import { greetingForTimezone, formatCurrentTime, isValidTimezone } from "./callingWindow.js";

function fallback(value: unknown, label = "unknown"): string {
  if (value === null || value === undefined || value === "") return label;
  return String(value);
}

/**
 * Nothing in this file or prompt.ts previously told Everly what today's
 * actual date is — a real call (2026-08-07) showed the LLM resolving
 * "this month" / "end of the year" to 2024 instead of 2026 for
 * driver_available/rate_valid_until, two full years off. Every relative
 * date question needs this as its anchor.
 *
 * Must be resolved in the carrier's own timezone, not the server's — a real
 * call (2026-09-04) showed a carrier in America/Anchorage (UTC-8) ask for a
 * callback "in 2 minutes" while it was still Sept 3rd in their own local
 * time, but this returned the server's Sept 4th (a bare `new Date()` with no
 * timeZone resolves to the server host's zone). The model combined that
 * server-side date with the carrier-timezone-aware {{currentTime}} below,
 * producing a wall-clock string one calendar day ahead of the carrier's
 * actual local "today" — wallClockToUtc then correctly interpreted that
 * wrong date against the carrier's real timezone, landing the callback a
 * full day late. Keep this in the same timezone as currentTime/greeting
 * below so the two anchors the model reasons from never disagree.
 */
function formatCurrentDate(timezone?: string): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

/**
 * MDR sends several numeric fields as unformatted strings/numbers (e.g. a
 * weight of "45445") — with no thousands separator, a real call showed this
 * read back digit-by-digit ("four five four four five pounds") instead of as
 * one number. Comma-formatting gives the voice model an unambiguous grouped
 * figure to read naturally, the same way any written dollar amount or
 * quantity normally would be. Falls back to the raw string for anything that
 * isn't actually numeric (rare, but MDR's docs already don't always match
 * what it sends — see Load.ts's header comment).
 */
function formatNumber(value: unknown, label = "unknown"): string {
  if (value === null || value === undefined || value === "") return label;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num.toLocaleString("en-US") : String(value);
}

/** hazmat/reefer arrive as boolean or string (per the webhook doc) — normalize either to plain "Yes"/"No" for speech. */
function yesNo(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && value.trim() !== "") {
    return ["true", "yes", "1"].includes(value.trim().toLowerCase()) ? "Yes" : "No";
  }
  return "unknown";
}

/**
 * Spoken summary of transload/warehouse/final-mile services, mirroring the
 * same "Additional Services" list MDR's own carrier-facing quote page shows
 * (e.g. "Transloading Required", "Warehouse Required (2 days, 5 pallets)",
 * "Final Mile Delivery Required") — purely descriptive, built from the same
 * transload/storage/final-mile flags already computed below for pricing
 * branching, not a new condition of its own.
 *
 * Deliberately does NOT return a plain "None" for a Drayage Only load. Three
 * real test calls showed Everly narrating that as "no transload, storage, or
 * final mile needed" in her load summary regardless of how the surrounding
 * prompt instructed her not to (client wants nothing said about these at all
 * for a Drayage Only load, not even that they're not needed) — a bare
 * "None" value reads to the model like any other field to summarize, and a
 * separate prose rule elsewhere in the prompt wasn't reliably remembered at
 * the point the model was actually generating the summary. Returning an
 * instruction directly as this field's own value (instead of just data)
 * puts the "don't mention this" rule exactly where the model is looking
 * right as it would otherwise narrate it, rather than requiring it to recall
 * a separate rule from elsewhere in the prompt.
 */
function renderAdditionalServices(params: {
  transloadNeeded: string;
  warehouseNeeded: string;
  storageNeeded: string;
  storageDays: string;
  storagePallets: string;
  finalMileNeeded: string;
}): string {
  if (params.transloadNeeded !== "yes") {
    return "N/A — do not mention transload, storage, or final mile in the summary at all, not even to say they are not needed";
  }
  const parts = ["Transloading required"];
  if (params.warehouseNeeded === "yes") {
    parts.push("warehouse required");
  }
  if (params.storageNeeded === "yes") {
    parts.push(`storage required (${params.storageDays} days, ${params.storagePallets} pallets)`);
  }
  if (params.finalMileNeeded === "yes") {
    parts.push("final-mile delivery required");
  }
  return parts.join("; ");
}

/**
 * Short, upfront service-type statement — per client direction (2026-09-02),
 * spoken in Permission and qualification BEFORE the phone-vs-email question,
 * not just later in the full Concise load presentation summary. The carrier
 * should know whether this is a simple Drayage Only move or a more involved
 * one (transload/final-mile/storage) before deciding how they want to quote
 * it. Deliberately pre-rendered as a complete statement (not left to the
 * model to compose from the raw transloadNeeded/finalMileNeeded/
 * storageNeeded booleans) — same reasoning as renderAdditionalServices
 * above, which exists for exactly this class of real-call failure.
 */
function renderServiceTypeSummary(params: {
  serviceScope: string;
  transloadNeeded: string;
  finalMileNeeded: string;
  storageNeeded: string;
  storageDays: string;
  storagePallets: string;
}): string {
  const base = `This is a ${params.serviceScope} load.`;
  if (params.transloadNeeded !== "yes") return base;

  const parts = ["Transloading"];
  if (params.finalMileNeeded === "yes") parts.push("Final Mile delivery");
  let detail = `This load requires ${parts.join(", and ")}`;
  if (params.storageNeeded === "yes") {
    detail += `, with storage for ${params.storageDays} days, ${params.storagePallets} pallets`;
  }
  return `${base} ${detail}.`;
}

/**
 * Renders the carrier's existing warehouses (from a fresh "Get Specific
 * Carrier" response) as a spoken-context string. The prompt tells Everly to
 * match against "the known list already given in your context for this
 * call" — this is that list; without it there's nothing to match against, so
 * every warehouse the carrier names would look "genuinely new" and get
 * re-registered as a duplicate.
 */
function renderKnownWarehouses(items: Array<{ id: number; address: string }>): string {
  if (!items || items.length === 0) return "none on file";
  return items.map((item) => `${item.address} (id ${item.id})`).join(", ");
}

/**
 * Same idea as renderKnownWarehouses, but for accessorials — includes the
 * on-file price too. A real call showed why this matters: the carrier named
 * "lumper fee," which already existed on file at $100, but this list didn't
 * include that price — Everly had no way to know the carrier's stated $40
 * differed from what was on file, and MDR has no "update price" endpoint
 * (only add_accessorial, which creates a new entry), so a price mismatch
 * genuinely can't be reconciled by reusing the old id. Showing the price
 * here lets Everly recognize the mismatch and explain it to the carrier
 * (see prompt.ts's accessorial-matching instructions) instead of silently
 * reusing a stale price or silently creating an unexplained duplicate.
 */
function renderKnownAccessorials(items: Array<{ id: number; name: string; price: string }>): string {
  if (!items || items.length === 0) return "none on file";
  return items.map((item) => `${item.name} (id ${item.id}, $${item.price})`).join(", ");
}

export function buildCallVariables(
  load: any,
  carrier: MdrCarrierDetail,
  callMemory: string = "",
  isFinalAttempt: boolean = false
) {
  // dispatch.ts already validates carrier_timezone before ever placing this
  // call (see its isValidTimezone gate), so this fallback is defensive-only —
  // never expected to actually trigger on a real dial.
  const currentDate = isValidTimezone(carrier.carrier_timezone)
    ? formatCurrentDate(carrier.carrier_timezone)
    : formatCurrentDate();
  const greeting = isValidTimezone(carrier.carrier_timezone) ? greetingForTimezone(carrier.carrier_timezone) : "Hello";
  const currentTime = isValidTimezone(carrier.carrier_timezone)
    ? formatCurrentTime(carrier.carrier_timezone)
    : "unknown";

  // Rendered as a complete statement, same reasoning as callMemory above —
  // Vapi substitutes {{attemptStatus}} as literal text, so a bare boolean
  // would leave the model to guess at phrasing. See prompt.ts's "Attempt
  // status" section and the schedule_callback final-attempt rule that reads
  // it — computed by dispatch.ts from nextAttemptNumber === MAX_CALL_ATTEMPTS.
  const attemptStatus = isFinalAttempt
    ? "This is the final allowed call to this carrier for this load — no further automated attempts will happen after this one."
    : "This is not the final allowed attempt — further automated attempts remain if needed.";

  // Four independent gates, per client clarification — do not conflate
  // them, each drives a different subset of the "Drayage pricing capture" /
  // "Storage & final-mile pricing" sections in prompt.ts:
  //   - transloadNeeded: is there a transload leg at all (transload_rate).
  //     Driven by service_type, NOT storage_needed/is_warehouse_needed — a
  //     load can transload without needing a warehouse or formal storage.
  //   - warehouseNeeded: does this load need a specific warehouse identified
  //     (is_warehouse/warehouse_id, plus the base-rate phrasing and the
  //     load-summary's "warehouse required" mention). Driven by the load's
  //     own is_warehouse_needed boolean (2026-08-22: replaced storage_needed
  //     as this gate's source per client direction — MDR guarantees this is
  //     never true for a Drayage Only load, so no extra service_type check
  //     is needed here).
  //   - storageNeeded: does this load need a separate storage rate quoted
  //     (storage_rate only — warehouse identification is its own gate above
  //     now). Driven by the load's own storage_needed boolean, independent
  //     of warehouseNeeded — a load can need one without the other.
  //   - finalMileNeeded: is there a final-mile leg on top of transload
  //     (finalmile_rate/finalmile_fsc). Driven by service_type; a load can
  //     transload (with or without storage/warehouse) without needing final
  //     mile.
  // service_type is a confirmed 3-value enum (per "Voice Webhook
  // Documentation" v1.0): "Drayage Only" / "Drayage + Transloading" /
  // "Drayage + Transloading + Final Mile" — exact match, not a substring
  // check, since it's a closed enum.
  const transloadNeeded =
    load.service_type === "Drayage + Transloading" || load.service_type === "Drayage + Transloading + Final Mile"
      ? "yes"
      : "no";
  const warehouseNeeded = load.is_warehouse_needed ? "yes" : "no";
  const storageNeeded = load.storage_needed ? "yes" : "no";
  const storageDays = fallback(load.storage_days);
  const storagePallets = fallback(load.storage_pallets);
  const finalMileNeeded = load.service_type === "Drayage + Transloading + Final Mile" ? "yes" : "no";

  return {
    currentDate,
    currentTime,
    greeting,

    // Populated by src/server/callMemory.ts, computed by dispatch.ts before
    // calling this function (requires an async DB lookup this function
    // deliberately doesn't do itself — see callMemory.ts's header comment).
    // Vapi substitutes {{callMemory}} as literal text before the model ever
    // sees the prompt — an empty string there would leave a dangling
    // fragment mid-sentence, not a value the model can branch on. Always
    // render a complete, unambiguous statement instead.
    callMemory: callMemory || "No prior contact — this is the first call to this carrier for this load.",
    attemptStatus,

    carrierName: fallback(carrier.company_name),
    carrierEmail: fallback(carrier.email),
    // No confirmed source for a real callback DID/number yet.
    callbackNumber: "TBD",

    quoteId: fallback(load.quote_id),
    loadId: fallback(load.id),

    origin: [load.origin_metro_location, load.origin_service_location].filter(Boolean).join(", ") || "unknown origin",
    destination: fallback(load.customer_location),
    pickupLocation: fallback(load.origin_service_location),
    deliveryLocation: fallback(load.customer_location),
    miles: formatNumber(load.distance),

    equipmentDescription: fallback(load.length),
    ssl: fallback(load.ssl),
    shipmentType: fallback(load.shipment_type),
    commodity: fallback(load.commodity),
    weight: formatNumber(load.cargo_weight),
    // Plain informational facts about the cargo — per client instruction,
    // these are spoken as-is and are NOT a branch condition for any other
    // question (unlike transloadNeeded/storageNeeded/finalMileNeeded below).
    hazmat: yesNo(load.hazmat),
    reefer: yesNo(load.reefer),

    pickupTiming: fallback(load.load_available_date),
    lastFreeDay: fallback(load.lfd_cut),

    containerQuantity: formatNumber(load.quantity),
    frequency: fallback(load.frequency_status),
    serviceScope: fallback(load.service_type),
    additionalServices: renderAdditionalServices({
      transloadNeeded,
      warehouseNeeded,
      storageNeeded,
      storageDays,
      storagePallets,
      finalMileNeeded,
    }),
    serviceTypeSummary: renderServiceTypeSummary({
      serviceScope: fallback(load.service_type),
      transloadNeeded,
      finalMileNeeded,
      storageNeeded,
      storageDays,
      storagePallets,
    }),
    targetRate: formatNumber(load.target_rate),
    // Percentage, not a dollar figure — no thousands-separator formatting
    // like targetRate above. MDR's own reference fuel surcharge for this
    // load, stated to the carrier alongside targetRate per client direction
    // (2026-08-31) — see prompt.ts's "Load details for this call" section.
    fsc: fallback(load.fsc),

    specialRequirements: fallback(load.notes, "none"),

    transloadNeeded,
    warehouseNeeded,
    storageNeeded,
    storageDays,
    storagePallets,
    finalMileNeeded,

    // The carrier's own known accessorials/warehouses, for the matching
    // logic described in the "Drayage pricing capture" / "Storage &
    // final-mile pricing" sections of prompt.ts.
    existingAccessorials: renderKnownAccessorials(carrier.accessorials),
    existingWarehouses: renderKnownWarehouses(carrier.warehouses),
  };
}
