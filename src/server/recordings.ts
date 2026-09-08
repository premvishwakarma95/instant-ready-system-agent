/**
 * Proxies Vapi's own recording-download endpoint so a call recording is
 * actually playable by whoever we hand this URL to (MDR, specifically —
 * see the Call Log API's recording_url field in webhookHandlers.ts).
 *
 * The raw URL Vapi gives us in end-of-call-report (artifact.recording.
 * stereoUrl, stored as CallAttempt.recordingUrl) points directly at a
 * private Cloudflare R2 bucket and cannot be played by anyone without
 * credentials — confirmed empirically (2026-09-01): loading it directly
 * returns <Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>.
 * Per Vapi's docs, actual playback requires calling Vapi's own
 * GET /call/{id}/stereo-recording with a private API key, which responds
 * with a 302 redirect to a short-lived signed URL. MDR must never see that
 * key directly, so this route makes that call server-side (fetch follows
 * the redirect automatically) and streams the audio back.
 *
 * Gated by the same shared TEST_DISPATCH_API_KEY secret used elsewhere in
 * this app, but as a query param (?key=...) rather than a header — this
 * URL needs to work as a plain clickable link / <audio src> in MDR's own
 * dashboard, and browsers can't attach custom headers to those.
 *
 * Two ways to use the same URL: as-is, it plays inline (no Content-
 * Disposition header — the default for audio/wav in a browser or <audio>
 * tag); add &download=1 to instead get a Content-Disposition: attachment
 * header, which makes a browser prompt to save the file rather than play
 * it. Same underlying stream either way.
 */
import { Router } from "express";
import { Readable } from "node:stream";
import { env } from "../config/env.js";

export const recordingsRouter = Router();

recordingsRouter.get("/:vapiCallId", async (req, res) => {
  const expectedKey = process.env.TEST_DISPATCH_API_KEY;
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(401).json({ ok: false, error: "Missing or invalid key" });
    return;
  }

  const { vapiCallId } = req.params;

  let vapiResponse;
  try {
    vapiResponse = await fetch(`https://api.vapi.ai/call/${vapiCallId}/stereo-recording`, {
      headers: { Authorization: `Bearer ${env.vapiApiKey}` },
    });
  } catch (err) {
    console.error(`recordings: failed to reach Vapi for call ${vapiCallId}:`, err);
    res.status(502).json({ ok: false, error: "Failed to reach Vapi" });
    return;
  }

  if (!vapiResponse.ok || !vapiResponse.body) {
    console.error(`recordings: Vapi returned ${vapiResponse.status} for call ${vapiCallId}`);
    res.status(vapiResponse.status).json({ ok: false, error: `Vapi returned ${vapiResponse.status}` });
    return;
  }

  res.setHeader("Content-Type", vapiResponse.headers.get("content-type") ?? "audio/wav");
  if (req.query.download) {
    res.setHeader("Content-Disposition", `attachment; filename="${vapiCallId}.wav"`);
  }
  Readable.fromWeb(vapiResponse.body as any).pipe(res);
});
