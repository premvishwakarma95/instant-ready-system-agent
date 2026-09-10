import express from "express";
import cron from "node-cron";
import { connectDB } from "../db/connection.js";
import { handleToolCalls, handleEndOfCallReport } from "./webhookHandlers.js";
import { mdrWebhookRouter } from "./mdrWebhook.js";
import { dispatchRouter, runDispatchCycle } from "./dispatch.js";
import { testDispatchRouter } from "./testDispatch.js";
import { recordingsRouter } from "./recordings.js";

// Last-resort safety net: every route handler in this codebase is already
// individually guarded, but this is the backstop for anything that still
// slips through (a future route, a timer, a stray unguarded promise) —
// log it and keep the process alive rather than let Node's default
// behavior (crash on unhandled rejection since v15; always-crash on
// uncaught exception) take down every in-flight call and the whole
// dispatch loop over one bad code path.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException (process kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection (process kept alive):", reason);
});

const app = express();
// Express's default body limit is 100kb — Vapi's webhook payloads carry the
// full conversation history (and, for end-of-call-report, the full artifact
// incl. transcript), which routinely exceeds that on longer calls and was
// being silently rejected with a 413 before ever reaching our handlers.
app.use(express.json({ limit: "10mb" }));

app.use("/webhooks/mdr", mdrWebhookRouter);
app.use("/dispatch", dispatchRouter);
app.use("/test", testDispatchRouter);
app.use("/recordings", recordingsRouter);

app.post("/vapi/tool-calls", async (req, res) => {
  const message = req.body.message;

  try {
    if (message?.type === "tool-calls") {
      const vapiCallId = message.call?.id;
      // Vapi's real toolCallList items are {id, type, function: {name, arguments}}
      // with arguments as a JSON string — not the flat {id, name, parameters}
      // shape handleToolCalls expects, so map/parse here.
      //
      // arguments is NOT reliably a string despite that — live traffic has been
      // observed sending it as an already-parsed object (confirmed via raw
      // ngrok request capture 2026-07-21), which crashed JSON.parse() with
      // "\"[object Object]\" is not valid JSON" on every call with non-empty
      // arguments (log_decline, submit_quote — anything but endCall's "{}").
      // Only parse when it's actually a string.
      const toolCallList = (message.toolCallList ?? []).map((call: any) => ({
        id: call.id,
        name: call.function?.name,
        parameters:
          typeof call.function?.arguments === "string"
            ? call.function.arguments
              ? JSON.parse(call.function.arguments)
              : {}
            : (call.function?.arguments ?? {}),
      }));
      const results = await handleToolCalls(toolCallList, vapiCallId);
      res.json({ results });
      return;
    }

    if (message?.type === "end-of-call-report") {
      await handleEndOfCallReport(message);
      res.status(200).json({ ok: true });
      return;
    }

    // Other server message types (status-update, speech-update, etc.) — ack and ignore.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Final Express error-handling middleware (4-arg signature — Express only
// treats it as an error handler if it has exactly 4 params). Catches
// anything routed here via next(err), most notably express.json()
// rejecting a malformed request body, so callers get a clean JSON 400/500
// instead of Express's default HTML error page.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled Express error:", err);
  if (res.headersSent) return;
  const status = err?.status ?? err?.statusCode ?? 500;
  res.status(status).json({ ok: false, error: err?.message ?? "Internal server error" });
});

const PORT = process.env.PORT ?? 3000;

/**
 * Runs one live dispatch cycle (never dry-run) and logs the outcome — the
 * scheduled counterpart to a person hitting POST /dispatch/run by hand.
 * Calls runDispatchCycle() directly rather than making an HTTP request to
 * this same server, so there's no self-network-call and no duplicated
 * orchestration logic (see dispatch.ts's header comment on that function).
 */
async function scheduledDispatchTick() {
  const result = await runDispatchCycle(false);
  if (result.ok) {
    console.log("Scheduled dispatch cycle:", result.summary);
  } else {
    console.error("Scheduled dispatch cycle failed:", result.error);
  }
}

async function main() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
  });

  // Run once immediately on startup so a restart doesn't leave a silent gap
  // until the first scheduled tick, then every 5 minutes after — frequent
  // enough that a due call isn't meaningfully delayed (cadence offsets and
  // the calling window are both hour-granularity), infrequent enough not to
  // hammer MDR's per-carrier lookup for no reason.
  // await scheduledDispatchTick();
  // cron.schedule("*/5 * * * *", scheduledDispatchTick);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
