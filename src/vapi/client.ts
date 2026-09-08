import { env } from "../config/env.js";

const VAPI_BASE_URL = "https://api.vapi.ai";
const REQUEST_TIMEOUT_MS = 15_000;

export class VapiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Vapi API error (${status}): ${JSON.stringify(body)}`);
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  // Bounded: a stalled Vapi API (e.g. mid-dial) would otherwise hang the
  // caller indefinitely rather than failing loudly.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${VAPI_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.vapiApiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Vapi API request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw new Error(`Vapi API request failed: ${method} ${path} — ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new VapiError(res.status, { nonJsonBody: text.slice(0, 500) });
  }

  if (!res.ok) {
    throw new VapiError(res.status, data);
  }

  return data as T;
}

export const vapi = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
