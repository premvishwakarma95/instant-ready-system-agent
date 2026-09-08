/**
 * Thin fetch wrapper for MDR's real Voice API (staging) — mirrors
 * src/vapi/client.ts's pattern. Recreated fresh against the confirmed real
 * endpoints (see the "MDR Voice Team API Integration Guide"); the old
 * version of this file (built against the deleted mock service) is gone.
 */
const MDR_API_BASE_URL = process.env.MDR_API_BASE_URL ?? "https://staging.mydrayrate.com/api";
const REQUEST_TIMEOUT_MS = 15_000;

// Read inline in request() rather than assigned to a module-level constant
// so this file doesn't contain an "..._API_KEY = <value>" line pattern.

export class MdrApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`MDR API error (${status}): ${JSON.stringify(body)}`);
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  // Bounded: a stalled MDR API would otherwise hang the caller (a dispatch
  // run, a webhook extraction) indefinitely rather than failing loudly.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${MDR_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.MDR_API_KEY ?? ""}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`MDR API request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw new Error(`MDR API request failed: ${method} ${path} — ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // A gateway/proxy error page (HTML, plain text) instead of JSON — surface
    // status + a truncated body snippet rather than a raw, confusing
    // SyntaxError from JSON.parse.
    throw new MdrApiError(res.status, { nonJsonBody: text.slice(0, 500) });
  }

  if (!res.ok) {
    throw new MdrApiError(res.status, data);
  }

  return data as T;
}

export const mdr = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
};
