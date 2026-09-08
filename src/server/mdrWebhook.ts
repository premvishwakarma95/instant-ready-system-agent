/**
 * Receiver for MDR's real push webhook. Still raw-capturing everything as-is
 * into WebhookResponse (unchanged — kept as the safety net so no traffic is
 * ever lost, even if the structured extraction below has a bug or MDR
 * changes the shape). On top of that:
 *  1. Extracts `load` and upserts a structured Load record — see
 *     src/db/models/Load.ts for why field names mirror MDR's payload
 *     exactly.
 *  2. Calls MDR's real "Get All Carriers" endpoint for that load and upserts
 *     each carrier — see src/db/models/Carrier.ts / src/mdr/api.ts.
 *
 * Upsert (not insert) throughout, not blind create: MDR has been observed
 * sending the same load.posted webhook twice for the same load a couple
 * minutes apart (confirmed via real captured WebhookResponse data,
 * 2026-08-05) — a plain create() would produce duplicates.
 *
 * Neither extraction step blocks the raw capture above or the 200 response
 * to MDR — the WebhookResponse write already succeeded by that point, and we
 * don't want MDR retrying indefinitely over a bug or a live-API hiccup on
 * our side.
 *
 * Gated by the same x-api-key/TEST_DISPATCH_API_KEY shared secret as
 * POST /test/dispatch and POST /update-flags below (reused as-is, not a
 * separate key) — MDR's real signing/auth scheme for this webhook isn't
 * confirmed yet, so this shared secret is what MDR must send until then.
 *
 * The old /load-ready route (built against the previous mock-based
 * push-webhook design, fed only by the now-deleted src/mdr-simulator-ui/) has
 * been removed — MDR's real webhook posts here instead.
 */
import { Router } from "express";
import { Carrier, Load, WebhookResponse } from "../db/models/index.js";
import { getAllCarriers } from "../mdr/api.js";

export const mdrWebhookRouter = Router();

mdrWebhookRouter.post("/capture", async (req, res) => {
  const expectedKey = process.env.TEST_DISPATCH_API_KEY;
  if (!expectedKey || req.header("x-api-key") !== expectedKey) {
    res.status(401).json({ ok: false, error: "Missing or invalid x-api-key" });
    return;
  }

  // This is the very first thing that runs on every real MDR delivery — if
  // it throws unguarded, the rejection is unhandled and (default Node
  // behavior since v15) takes down the whole process, not just this
  // request. Everything below the raw capture is already individually
  // guarded; this closes the one gap before that.
  try {
    await WebhookResponse.create({ timestamp: new Date(), data: req.body });
  } catch (err) {
    console.error("webhook capture: failed to write raw WebhookResponse:", err);
    res.status(500).json({ ok: false, error: "Failed to record webhook" });
    return;
  }

  res.status(200).json({ ok: true });

  const load = req.body?.load;
  if (!load?.id) {
    console.warn("webhook capture: no load.id present, skipping Load extraction");
    return;
  }

  try {
    await Load.findOneAndUpdate({ id: load.id }, load, { upsert: true, setDefaultsOnInsert: true });
  } catch (err) {
    console.error(`webhook capture: failed to extract/upsert Load ${load.id}:`, err);
    return;
  }

  try {
    const { carriers } = await getAllCarriers(load.id);
    // Bulk upsert, not one findOneAndUpdate per carrier: a load can have
    // 100+ invited carriers, and firing that many concurrent round-trips at
    // once doesn't scale (and can exhaust the connection pool). bulkWrite
    // sends every carrier's upsert as a single command instead. Carrier.ts's
    // schema has no `default:` fields, so dropping setDefaultsOnInsert (not
    // available on bulkWrite) is a no-op change, not a behavior change.
    if (carriers.length > 0) {
      await Carrier.bulkWrite(
        carriers.map((carrier) => ({
          updateOne: {
            filter: { outreach_id: carrier.outreach_id },
            update: { $set: { ...carrier, load_id: load.id } },
            upsert: true,
          },
        }))
      );
    }
    console.log(`webhook capture: upserted ${carriers.length} carrier(s) for load ${load.id}`);
  } catch (err) {
    console.error(`webhook capture: failed to fetch/upsert carriers for load ${load.id}:`, err);
  }
});

/**
 * Receiver for MDR pushing a load-level flag change (is_load_close,
 * is_agent_call_on) without resending the whole load. Payload shape is our
 * own best guess, not yet confirmed against a real MDR contract — built to
 * mirror /capture's existing "event" + "load" convention (its own real
 * payloads carry a top-level event: "load.posted"). Expect this to need
 * adjusting once MDR provides the real spec.
 *
 * Deliberately does NOT upsert a missing Load — Load.quote_id is a required
 * schema field this payload never carries, so inserting a new document from
 * flags alone would either fail validation or need a fake placeholder value.
 * A flag update only makes sense for a load we already know about (from a
 * prior /capture), so a missing local Load is logged and skipped rather than
 * forcing an invalid partial insert.
 *
 * $set only the fields actually present — never a full Load replace like
 * /capture does, so a flags-only payload can't accidentally null out
 * everything else already known about the load.
 *
 * Gated by the same x-api-key/TEST_DISPATCH_API_KEY shared secret as
 * POST /test/dispatch and /capture above (reused as-is, not a separate key).
 */
const FLAG_UPDATE_EVENT = "load.flags_updated";

mdrWebhookRouter.post("/update-flags", async (req, res) => {
  const expectedKey = process.env.TEST_DISPATCH_API_KEY;
  if (!expectedKey || req.header("x-api-key") !== expectedKey) {
    res.status(401).json({ ok: false, error: "Missing or invalid x-api-key" });
    return;
  }

  try {
    await WebhookResponse.create({ timestamp: new Date(), data: req.body });
  } catch (err) {
    console.error("webhook update-flags: failed to write raw WebhookResponse:", err);
    res.status(500).json({ ok: false, error: "Failed to record webhook" });
    return;
  }

  res.status(200).json({ ok: true });

  const event = req.body?.event;
  if (event && event !== FLAG_UPDATE_EVENT) {
    // Not blocking on this — the exact event string is our own guess, not a
    // confirmed MDR contract, so a mismatch here is logged for visibility
    // rather than treated as a reason to drop otherwise-real flag data.
    console.warn(`webhook update-flags: unexpected event "${event}" (expected "${FLAG_UPDATE_EVENT}") — processing anyway`);
  }

  const load = req.body?.load;
  if (!load?.id) {
    console.warn("webhook update-flags: no load.id present, skipping");
    return;
  }

  const flags: Record<string, boolean> = {};
  if (typeof load.is_load_close === "boolean") flags.is_load_close = load.is_load_close;
  if (typeof load.is_agent_call_on === "boolean") flags.is_agent_call_on = load.is_agent_call_on;

  if (Object.keys(flags).length === 0) {
    console.warn(`webhook update-flags: no recognized flags present for load ${load.id}, skipping`);
    return;
  }

  try {
    const result = await Load.updateOne({ id: load.id }, { $set: flags });
    if (result.matchedCount === 0) {
      console.warn(`webhook update-flags: no local Load found for id ${load.id} — flags not applied`);
      return;
    }
    console.log(`webhook update-flags: updated load ${load.id} with`, flags);
  } catch (err) {
    console.error(`webhook update-flags: failed to update Load ${load.id}:`, err);
  }
});
