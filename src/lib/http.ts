/** Thin fetch wrapper: query building, timeouts, and readable API errors. */

import { ApiError, CliError } from "./errors.js";

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  /** Milliseconds; defaults to 60s. */
  timeoutMs?: number;
  /** Return undefined instead of throwing on this status (e.g. 404). */
  allowStatus?: number[];
}

export function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Perform a request and parse the JSON body. */
export async function request<T>(
  base: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(base, path, options.query);
  const method = options.method ?? "GET";

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders(options.token),
    ...options.headers,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new CliError(
      `Cannot reach ${url}: ${reason}`,
      "Check your connection, or override the endpoint with --aip-endpoint / --bitagent-api.",
    );
  }

  const text = await response.text().catch(() => "");

  if (!response.ok) {
    if (options.allowStatus?.includes(response.status)) return undefined as T;
    throw new ApiError(response.status, extractDetail(text) || response.statusText, url);
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(`Unexpected non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

/**
 * Open an SSE stream and yield each `data:` payload as a parsed object.
 * Lines that are not valid JSON are yielded as `{ raw }`.
 */
export async function* streamSse(
  base: string,
  path: string,
  options: RequestOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const url = buildUrl(base, path, options.query);
  const response = await fetch(url, {
    method: options.method ?? "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...authHeaders(options.token),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
  }).catch((e: unknown) => {
    throw new CliError(`Cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new ApiError(response.status, extractDetail(text) || response.statusText, url);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        yield JSON.parse(raw) as Record<string, unknown>;
      } catch {
        yield { raw };
      }
    }
  }
}

/** Pull a human message out of a FastAPI / gateway error body. */
function extractDetail(text: string): string {
  if (!text) return "";
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "string") return body;
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const detail = record.detail ?? record.message ?? record.error;
      if (typeof detail === "string") return detail;
      if (Array.isArray(detail)) {
        // FastAPI validation errors: [{loc, msg, type}, ...]
        return detail
          .map((item) => {
            const entry = item as { loc?: unknown[]; msg?: string };
            const field = (entry.loc ?? []).slice(1).join(".") || "body";
            return entry.msg ? `${field}: ${entry.msg}` : JSON.stringify(item);
          })
          .join("; ");
      }
      if (detail) return JSON.stringify(detail);
    }
  } catch {
    // Not JSON — fall through to the plain-text path below.
  }
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
