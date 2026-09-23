import type { MetaResponse, ServerConfig, ValidationIssue } from "./types.js";

async function parseJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function fetchHealth(): Promise<{
  ok: boolean;
  discordConfigured: boolean;
  configPath: string;
}> {
  const res = await fetch("/api/health");
  return parseJson(res);
}

export async function fetchMeta(): Promise<MetaResponse> {
  const res = await fetch("/api/meta");
  if (!res.ok) throw new Error("Failed to load meta");
  return parseJson(res);
}

export async function fetchConfig(): Promise<{
  config: ServerConfig;
  raw: string;
  path: string;
}> {
  const res = await fetch("/api/config");
  if (!res.ok) {
    const body = await parseJson<{ error?: string }>(res);
    throw new Error(body.error ?? "Failed to load config");
  }
  return parseJson(res);
}

export async function saveConfig(config: ServerConfig): Promise<{
  ok: boolean;
  config?: ServerConfig;
  raw?: string;
  issues?: ValidationIssue[];
  schemaIssues?: { path: string; message: string }[];
  error?: string;
}> {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  return parseJson(res);
}

export async function validateConfig(config: ServerConfig): Promise<{
  ok: boolean;
  issues: ValidationIssue[];
  schemaIssues?: { path: string; message: string }[];
}> {
  const res = await fetch("/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  return parseJson(res);
}

export async function postFetch(): Promise<{
  ok?: boolean;
  config?: ServerConfig;
  raw?: string;
  path?: string;
  warnings?: string[];
  error?: string;
  code?: string;
  issues?: ValidationIssue[];
}> {
  const res = await fetch("/api/fetch", { method: "POST" });
  return parseJson(res);
}

export async function postPlan(config: ServerConfig): Promise<{
  ok?: boolean;
  plan?: unknown;
  error?: string;
  code?: string;
  issues?: ValidationIssue[];
}> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  return parseJson(res);
}

export interface ApplyProgress {
  index: number;
  total: number;
  status: "success" | "failure" | "skip";
  type: string;
  domain: string;
  resource: string;
  error?: string;
}

export interface ApplyResult {
  ok?: boolean;
  plan?: unknown;
  error?: string;
  code?: string;
  dryRun?: boolean;
  cancelled?: boolean;
  result?: {
    applied?: number;
    skipped?: number;
    failed?: { resource: string; type: string; error: string }[];
  };
  warnings?: string[];
  auditPath?: string;
}

/** Thrown when /api/apply rejects with a JSON error before the SSE stream starts (400/409/503). */
export class ApplyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: {
      error?: string;
      code?: string;
      schemaIssues?: { path: string; message: string }[];
      issues?: ValidationIssue[];
    },
  ) {
    super(body.error ?? `Apply request failed (HTTP ${status})`);
    this.name = "ApplyRequestError";
  }
}

/**
 * Upload an image to the server's `<config dir>/assets/` and get back the
 * config-relative reference (e.g. `assets/icon.png`) to store on a field.
 */
export async function uploadAsset(
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/assets", { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      path?: string;
      error?: string;
    };
    if (res.ok && body.ok && typeof body.path === "string") {
      return { ok: true, path: body.path };
    }
    return { ok: false, error: body.error ?? `Upload failed (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null; // heartbeat comment or empty frame
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

/**
 * POST /api/apply and consume its SSE response. The server streams one
 * `action` event per settled plan action (progress) and ends with `done`
 * (final result) or `error`. Aborting `signal` cancels the request, which
 * the server treats as a client disconnect and stops executing further
 * Discord API calls.
 */
export async function postApplyStream(
  config: ServerConfig,
  opts: { confirm?: boolean; dryRun?: boolean; prune?: boolean },
  onProgress: (p: ApplyProgress) => void,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const res = await fetch("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, ...opts }),
    signal,
  });
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const sep = buf.indexOf("\n\n");
        if (sep < 0) break;
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        const { event, data } = parsed as {
          event: string;
          data: Record<string, unknown>;
        };
        if (event === "action") onProgress(data as unknown as ApplyProgress);
        else if (event === "done") return data as ApplyResult;
        else if (event === "error") {
          throw new Error(String((data as { error?: string }).error ?? "Apply failed"));
        }
        // "start" is informational (plan totals); progress denominators
        // arrive with the first action event
      }
    }
    throw new Error("Apply stream ended before the final result");
  }
  const body = (await res.json().catch(() => ({}))) as ApplyRequestError["body"];
  throw new ApplyRequestError(res.status, body);
}
