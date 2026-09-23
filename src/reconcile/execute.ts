import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveAssetPath } from "../config/loader.js";
import { type DiscordRestClient, isDiscordAssetHost } from "../discord/client.js";
import type { Action, ActionPlan } from "../state/types.js";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
};

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Copy a Buffer into a fresh-ArrayBuffer Uint8Array (satisfies BlobPart). */
function bufferToBlobPart(buf: Buffer): Uint8Array<ArrayBuffer> {
  const u8 = new Uint8Array(buf.byteLength);
  u8.set(buf);
  return u8;
}

export interface AssetBytes {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Load an asset value (local path, `data:` URI, or `http(s)` URL) into raw
 * bytes plus a filename/content-type suitable for upload. URL assets are
 * downloaded; the bot token is only sent to Discord-owned CDN hosts.
 */
export async function loadAssetBytes(
  baseDir: string,
  asset: string,
  token?: string,
): Promise<AssetBytes> {
  if (asset.startsWith("data:")) {
    const sep = asset.indexOf(";base64,");
    if (sep < 0) throw new Error(`Unsupported data: URI for asset ${asset}`);
    const contentType = asset.slice(5, sep) || "image/png";
    const bytes = Buffer.from(asset.slice(sep + ";base64,".length), "base64");
    return { bytes, filename: "asset", contentType };
  }
  if (/^https?:\/\//i.test(asset)) {
    const headers: Record<string, string> = {};
    if (token && isDiscordAssetHost(asset)) headers.Authorization = `Bot ${token}`;
    let res: Response;
    try {
      res = await fetch(asset, { headers });
    } catch (e) {
      throw new Error(`Cannot download asset ${asset}: ${String(e)}`);
    }
    if (!res.ok) {
      throw new Error(`Cannot download asset ${asset}: HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const responseCt = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    let urlName = "";
    let urlExt = "";
    try {
      const pathname = new URL(asset).pathname;
      urlName = basename(pathname);
      urlExt = extOf(urlName);
    } catch {
      /* keep defaults */
    }
    const contentType = (responseCt || MIME_BY_EXT[urlExt]) ?? "image/png";
    return {
      bytes,
      filename: urlName || `asset.${urlExt || "png"}`,
      contentType,
    };
  }
  const path = resolveAssetPath(baseDir, asset);
  const bytes = readFileSync(path);
  const ext = extOf(basename(path));
  return { bytes, filename: basename(path), contentType: MIME_BY_EXT[ext] ?? "image/png" };
}

/** Load an asset value and encode it as a base64 `data:` URI for upload. */
export async function loadAssetDataUri(
  baseDir: string,
  asset: string,
  token?: string,
): Promise<string> {
  const { bytes, contentType } = await loadAssetBytes(baseDir, asset, token);
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

export interface ActionResultInfo {
  action: Action;
  index: number;
  total: number;
  status: "success" | "failure" | "skip";
  error?: string;
  responseId?: string;
}

export interface ExecuteOptions {
  client: DiscordRestClient;
  plan: ActionPlan;
  guildId: string;
  baseDir: string;
  dryRun?: boolean;
  /** Pre-seed name→id map from live guild state */
  initialResolved?: Map<string, string>;
  onAction?: (action: Action, index: number, total: number) => void;
  /** Called after each action settles (including SKIP / dry-run as "skip") */
  onActionResult?: (info: ActionResultInfo) => void;
  /**
   * Abort the run (e.g. WebUI client disconnect / user cancel). Checked
   * between actions: once aborted, no further API calls are issued and the
   * run ends with partial counts. An in-flight request is not interrupted.
   */
  signal?: AbortSignal;
}

export interface ExecuteResult {
  applied: number;
  skipped: number;
  failed: { action: Action; error: string }[];
  resolved: Map<string, string>;
}

/**
 * Resolve `__resolve_*__` and `__asset__:` placeholders in payloads/endpoints.
 * Async because `__asset__:` values may be `http(s)` URLs that must be
 * downloaded before upload.
 */
export async function resolvePlaceholders(
  value: unknown,
  resolved: Map<string, string>,
  baseDir: string,
  token?: string,
): Promise<unknown> {
  if (typeof value === "string") {
    if (value.startsWith("__asset__:")) {
      return loadAssetDataUri(baseDir, value.slice("__asset__:".length), token);
    }
    if (value.startsWith("__resolve_role__:")) {
      const name = value.slice("__resolve_role__:".length);
      const id = resolved.get(`role:${name}`);
      if (!id) throw new Error(`Unresolved role reference: ${name}`);
      return id;
    }
    if (value.startsWith("__resolve_category__:")) {
      const name = value.slice("__resolve_category__:".length);
      const id = resolved.get(`category:${name}`);
      if (!id) throw new Error(`Unresolved category reference: ${name}`);
      return id;
    }
    if (value.startsWith("__resolve_channel__:")) {
      const name = value.slice("__resolve_channel__:".length);
      const id = resolved.get(`channel:${name}`);
      if (!id) throw new Error(`Unresolved channel reference: ${name}`);
      return id;
    }
    if (value.startsWith("__resolve_channel_webhooks__:")) {
      const name = value.slice("__resolve_channel_webhooks__:".length);
      const id = resolved.get(`channel:${name}`);
      if (!id) throw new Error(`Unresolved channel for webhook: ${name}`);
      return `/channels/${id}/webhooks`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolvePlaceholders(v, resolved, baseDir, token)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = await resolvePlaceholders(v, resolved, baseDir, token);
    }
    return out;
  }
  return value;
}

export async function executePlan(options: ExecuteOptions): Promise<ExecuteResult> {
  const { client, plan, baseDir } = options;
  const resolved = new Map<string, string>(options.initialResolved ?? []);
  const failed: ExecuteResult["failed"] = [];
  let applied = 0;
  let skipped = 0;

  // Seed resolved map from existing target IDs in plan
  for (const action of plan.actions) {
    if (action.targetId) {
      if (
        action.domain === "role" ||
        action.domain === "category" ||
        action.domain === "channel" ||
        action.domain === "sticker"
      ) {
        resolved.set(`${action.domain}:${action.resource}`, action.targetId);
      }
      if (action.domain === "emoji") resolved.set(`emoji:${action.resource}`, action.targetId);
      if (action.domain === "webhook") resolved.set(`webhook:${action.resource}`, action.targetId);
    }
  }

  const total = plan.actions.length;

  for (let i = 0; i < plan.actions.length; i++) {
    if (options.signal?.aborted) break;
    const action = plan.actions[i]!;
    options.onAction?.(action, i, total);

    if (action.type === "SKIP") {
      skipped += 1;
      options.onActionResult?.({ action, index: i, total, status: "skip" });
      continue;
    }

    if (options.dryRun || plan.dry_run) {
      skipped += 1;
      options.onActionResult?.({ action, index: i, total, status: "skip" });
      continue;
    }

    const unmet = action.dependencies.filter((dep) => !resolved.has(dep));
    if (unmet.length > 0) {
      const skipReason = `Skipped because dependency ${unmet[0]} was not created`;
      const skippedAction: Action = {
        ...action,
        type: "SKIP",
        reason: "skipped",
        skipReason,
        payload: action.payload,
      };
      skipped += 1;
      options.onActionResult?.({
        action: skippedAction,
        index: i,
        total,
        status: "skip",
      });
      continue;
    }

    try {
      let endpoint = action.endpoint;
      if (endpoint.startsWith("__resolve_channel_webhooks__:")) {
        endpoint = (await resolvePlaceholders(endpoint, resolved, baseDir, client.token)) as string;
      }

      // Sticker CREATE is a multipart image upload (Discord rejects JSON bodies
      // with 50035), so it bypasses the generic JSON request path.
      if (action.domain === "sticker" && action.method === "POST") {
        const p = action.payload as Record<string, unknown>;
        const imageRef = String(p.image ?? "");
        if (!imageRef.startsWith("__asset__:")) {
          throw new Error(`Sticker ${action.resource}: image must be an __asset__ reference`);
        }
        const asset = await loadAssetBytes(
          baseDir,
          imageRef.slice("__asset__:".length),
          client.token,
        );
        const form = new FormData();
        form.append("name", String(p.name ?? action.resource));
        form.append("description", String(p.description ?? ""));
        form.append("tags", String(p.tags ?? ""));
        form.append(
          "file",
          new Blob([bufferToBlobPart(asset.bytes)], { type: asset.contentType }),
          asset.filename,
        );
        const stickerRes = await client.postMultipart<{ id?: string }>(endpoint, form);
        if (stickerRes?.id) resolved.set(`sticker:${action.resource}`, stickerRes.id);
        applied += 1;
        options.onActionResult?.({
          action,
          index: i,
          total,
          status: "success",
          responseId: stickerRes?.id,
        });
        continue;
      }

      const payload = action.payload
        ? ((await resolvePlaceholders(action.payload, resolved, baseDir, client.token)) as
            | Record<string, unknown>
            | unknown[])
        : undefined;

      // Clean nested undefined channel keys in auto-mod metadata
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        sanitizePayload(payload);
      }

      let response: { id?: string; name?: string } | undefined;

      switch (action.method) {
        case "POST":
          response = await client.post(endpoint, payload);
          break;
        case "PATCH":
          response = await client.patch(endpoint, payload);
          break;
        case "PUT":
          response = await client.put(endpoint, payload);
          break;
        case "DELETE":
          await client.delete(endpoint);
          break;
        default:
          break;
      }

      if (action.type === "CREATE" && response?.id) {
        if (action.domain === "role") resolved.set(`role:${action.resource}`, response.id);
        if (action.domain === "category") {
          resolved.set(`category:${action.resource}`, response.id);
        }
        if (action.domain === "channel") {
          resolved.set(`channel:${action.resource}`, response.id);
        }
        if (action.domain === "emoji") resolved.set(`emoji:${action.resource}`, response.id);
        if (action.domain === "sticker") resolved.set(`sticker:${action.resource}`, response.id);
        if (action.domain === "webhook") {
          resolved.set(`webhook:${action.resource}`, response.id);
        }
        if (action.domain === "auto_mod_rule") {
          resolved.set(`auto_mod_rule:${action.resource}`, response.id);
        }
      }

      // Also register UPDATE targets
      if (action.targetId) {
        if (action.domain === "role") resolved.set(`role:${action.resource}`, action.targetId);
        if (action.domain === "category") {
          resolved.set(`category:${action.resource}`, action.targetId);
        }
        if (action.domain === "channel") {
          resolved.set(`channel:${action.resource}`, action.targetId);
        }
      }

      applied += 1;
      options.onActionResult?.({
        action,
        index: i,
        total,
        status: "success",
        responseId: response?.id,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ action, error });
      // CREATE failures leave the resource unresolved so dependents skip cleanly
      options.onActionResult?.({
        action,
        index: i,
        total,
        status: "failure",
        error,
      });
      // Continue with remaining non-dependent actions; dependency failures will surface
    }
  }

  return { applied, skipped, failed, resolved };
}

function sanitizePayload(obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) {
      delete obj[k];
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object") {
          sanitizePayload(item as Record<string, unknown>);
          // clean auto-mod action metadata.channel leftover
          const meta = (item as { metadata?: Record<string, unknown> }).metadata;
          if (meta && "channel" in meta) delete meta.channel;
        }
      }
    } else if (v && typeof v === "object") {
      sanitizePayload(v as Record<string, unknown>);
    }
  }
}

export interface ConfirmOptions {
  /** When true, confirm any actionable change, not just DELETEs. */
  all?: boolean;
}

export async function confirmDeletes(
  plan: ActionPlan,
  yes: boolean,
  ask: (question: string) => Promise<boolean>,
  options: ConfirmOptions = {},
): Promise<boolean> {
  if (yes) return true;
  const pending = options.all
    ? plan.actions.filter((a) => a.type !== "SKIP")
    : plan.actions.filter((a) => a.type === "DELETE");
  if (pending.length === 0) return true;
  if (!process.stdin.isTTY) {
    const kind = options.all ? "action" : "DELETE";
    throw new Error(`${pending.length} ${kind}(s) require confirmation; re-run with --yes`);
  }
  const names = pending
    .slice(0, 5)
    .map((a) => `${a.type} ${a.domain}:${a.resource}`)
    .join(", ");
  const extra = pending.length > 5 ? `, … and ${pending.length - 5} more` : "";
  return ask(`About to apply ${pending.length} action(s): ${names}${extra}. Continue? [y/N] `);
}
