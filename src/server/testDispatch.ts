/**
 * On-demand testing endpoint for MDR — lets them trigger a real call for a
 * load/carrier set they provide, without waiting on the real webhook +
 * cadence + calling-window flow, and without needing anyone here to
 * manually intervene.
 *
 * Deliberately does NOT fork or modify the real dispatch pipeline — it
 * reuses dispatch.ts's exported processLoad() completely unchanged, so
 * calling window, cadence, threshold/stop_call/do-not-call checks, idempotent
 * CallAttempt creation, and every tool-call's real MDR write-through all
 * behave exactly as they do for a real dispatch cycle. The only thing this
 * route does on its own is get a load+its carriers into the DB and kick off
 * that same pipeline immediately instead of waiting for cron/cadence.
 *
 * Isolation from the real flow relies on one trick: the Load document this
 * writes to the DB is forced to is_load_close: true. runDispatchCycle()'s
 * only load-selection query is Load.find({is_load_close: false}) (see
 * dispatch.ts), so this load becomes permanently invisible to the real cron
 * and to a manually-triggered POST /dispatch/run — it can never be
 * reprocessed by the real flow. That forced-true value is only written to
 * the DB copy, though — the actual call placed by this route uses the load
 * object exactly as provided in the request body, so is_load_close there is
 * whatever the caller sent (processCarrier re-checks the real value fresh
 * from MDR anyway, independent of what's stored locally).
 *
 * Whether a call actually goes out is still governed by the real calling
 * window/day and cadence rules inside processLoad/processCarrier — this is
 * intentional, not a bug: testing is meant to exercise the same gating real
 * carriers experience, not bypass it.
 */
import { Router } from "express";
import { Load, Carrier, WebhookResponse } from "../db/models/index.js";
import { getAllCarriers } from "../mdr/api.js";
import { processLoad } from "./dispatch.js";

export const testDispatchRouter = Router();

testDispatchRouter.post("/dispatch", async (req, res) => {
  // Same ?dryRun=true convention as POST /dispatch/run — runs the full
  // pipeline (fresh MDR check, cadence, calling window) and reports what
  // it would have done, stopping just short of creating a CallAttempt or
  // touching Vapi.
  const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";

  const expectedKey = process.env.TEST_DISPATCH_API_KEY;
  if (!expectedKey || req.header("x-api-key") !== expectedKey) {
    res.status(401).json({ ok: false, error: "Missing or invalid x-api-key" });
    return;
  }

  const load = req.body?.load;
  if (!load?.id) {
    res.status(400).json({ ok: false, error: "Missing load.id in request body" });
    return;
  }

  try {
    await WebhookResponse.create({ timestamp: new Date(), data: req.body, source: "test" });
  } catch (err) {
    console.error("test/dispatch: failed to write raw WebhookResponse:", err);
    res.status(500).json({ ok: false, error: "Failed to record request" });
    return;
  }

  try {
    // Forced true on the PERSISTED copy only — see header comment. The
    // actual run below uses `load` (the raw request body value) instead.
    await Load.findOneAndUpdate(
      { id: load.id },
      { ...load, is_load_close: true },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error(`test/dispatch: failed to upsert Load ${load.id}:`, err);
    res.status(500).json({ ok: false, error: `Failed to upsert load: ${(err as Error).message}` });
    return;
  }

  try {
    const { carriers } = await getAllCarriers(load.id);
    // Same bulk-upsert approach as mdrWebhook.ts's fix — kept as a separate
    // copy here rather than a shared import, so nothing about the real
    // webhook capture flow needs to change to support this endpoint.
    if (carriers.length > 0) {
      await Carrier.bulkWrite(
        carriers.map((carrier: any) => ({
          updateOne: {
            filter: { outreach_id: carrier.outreach_id },
            update: { $set: { ...carrier, load_id: load.id } },
            upsert: true,
          },
        }))
      );
    }
  } catch (err) {
    console.error(`test/dispatch: failed to fetch/upsert carriers for load ${load.id}:`, err);
    res.status(500).json({ ok: false, error: `Failed to fetch/upsert carriers: ${(err as Error).message}` });
    return;
  }

  const results: Record<string, unknown>[] = [];
  try {
    await processLoad(load, results, dryRun);
  } catch (err) {
    console.error(`test/dispatch: unexpected failure processing load ${load.id}:`, err);
    results.push({ loadId: load.id, outcome: "error", error: (err as Error).message });
  }

  res.status(200).json({ ok: true, results });
});
