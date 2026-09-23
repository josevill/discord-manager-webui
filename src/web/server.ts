import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadConfig, saveConfig } from "../config/loader.js";
import { type ServerConfig, ServerConfigSchema } from "../config/schema.js";
import { validateCrossReferences } from "../config/validate.js";
import { DiscordRestClient, fetchGuildState } from "../discord/client.js";
import { PermissionFlags } from "../discord/permissions.js";
import { executePlan } from "../reconcile/execute.js";
import { buildActionPlan, urlAssetHashesFor } from "../reconcile/plan.js";
import { resolvedFromState } from "../reconcile/resolved.js";
import { createAuditSession } from "../state/audit.js";
import { writeBackup, writeStateCache } from "../state/backup.js";
import { materializeExportAssets } from "../state/export.js";

const CHANNEL_TYPES = ["text", "voice", "announcement", "forum", "media", "stage"] as const;

const ASSET_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const MAX_ASSET_BYTES = 10 * 1024 * 1024; // Discord guild icon limit; generous for all uses

/** Sanitize an uploaded file name into a safe, collision-free assets/ entry. */
function safeAssetName(rawName: string | undefined | null): string {
  const base = basename(rawName ?? "").replace(/[^a-zA-Z0-9._-]/g, "-");
  const cleaned = base.replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : `asset-${Date.now()}`;
}

/** Find a non-colliding target path; same bytes under the same name is fine. */
async function pickAssetPath(assetsDir: string, name: string, bytes: Buffer): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 0; ; i++) {
    const candidateName = i === 0 ? name : `${stem}-${i}${ext}`;
    const candidate = join(assetsDir, candidateName);
    if (!existsSync(candidate)) return candidate;
    try {
      const existing = await readFile(candidate);
      if (existing.equals(bytes)) return candidate;
    } catch {
      // Unreadable file — treat as collision and keep suffixing.
    }
  }
}

export interface UiServerOptions {
  configPath: string;
  host?: string;
  port?: number;
  token?: string;
  guildId?: string;
  /** When set, serve the built SPA from this directory. */
  staticDir?: string;
}

export interface UiServerHandle {
  app: Hono;
  close: () => Promise<void>;
  port: number;
  host: string;
  url: string;
}

function resolveCredentials(opts: UiServerOptions): {
  token: string | undefined;
  guildId: string | undefined;
} {
  const token = opts.token || process.env.DISCORD_TOKEN;
  const guildId = opts.guildId || process.env.DISCORD_GUILD_ID;
  return {
    token: token?.trim() ? token : undefined,
    guildId: guildId?.trim() ? guildId : undefined,
  };
}

function parseConfigBody(body: unknown):
  | {
      ok: true;
      config: ServerConfig;
    }
  | {
      ok: false;
      schemaIssues: { path: string; message: string }[];
    } {
  const parsed = ServerConfigSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      schemaIssues: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    };
  }
  return { ok: true, config: parsed.data };
}

function defaultStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../../web/dist"), resolve(process.cwd(), "web/dist")];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return undefined;
}

export function createUiApp(options: UiServerOptions): Hono {
  const app = new Hono();
  const configPath = isAbsolute(options.configPath)
    ? options.configPath
    : resolve(process.cwd(), options.configPath);

  // In-flight mutex so two tabs can't run /api/apply at the same time.
  let applyInFlight = false;

  app.get("/api/health", (c) => {
    const creds = resolveCredentials(options);
    return c.json({
      ok: true,
      configPath,
      discordConfigured: Boolean(creds.token && creds.guildId),
    });
  });

  app.get("/api/meta", (c) => {
    const creds = resolveCredentials(options);
    const permissionFlags = Object.keys(PermissionFlags).filter(
      (k) => k !== "MANAGE_EMOJIS_AND_STICKERS",
    );
    return c.json({
      channelTypes: [...CHANNEL_TYPES],
      permissionFlags,
      configPath,
      discordConfigured: Boolean(creds.token && creds.guildId),
    });
  });

  app.get("/api/config", (c) => {
    try {
      const loaded = loadConfig(configPath);
      return c.json({
        config: loaded.config,
        raw: loaded.raw,
        path: loaded.path,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.put("/api/config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const configPayload =
      body && typeof body === "object" && "config" in body
        ? (body as { config: unknown }).config
        : body;
    const parsed = parseConfigBody(configPayload);
    if (!parsed.ok) {
      return c.json({ ok: false, schemaIssues: parsed.schemaIssues }, 400);
    }
    const cross = validateCrossReferences(parsed.config);
    if (!cross.ok) {
      return c.json({ ok: false, issues: cross.issues }, 400);
    }
    try {
      const saved = saveConfig(configPath, parsed.config);
      return c.json({
        ok: true,
        config: saved.config,
        raw: saved.raw,
        path: saved.path,
        issues: cross.issues,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/validate", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const configPayload =
      body && typeof body === "object" && "config" in body
        ? (body as { config: unknown }).config
        : body;
    const parsed = parseConfigBody(configPayload);
    if (!parsed.ok) {
      return c.json({
        ok: false,
        schemaIssues: parsed.schemaIssues,
        issues: [],
      });
    }
    const cross = validateCrossReferences(parsed.config);
    return c.json({
      ok: cross.ok,
      schemaIssues: [],
      issues: cross.issues,
    });
  });

  // Asset upload: multipart file → <config dir>/assets/<name>. The returned
  // path is relative to the config dir, which is how resolveAssetPath in the
  // CLI/executor resolves references like `assets/icon.png`.
  app.post("/api/assets", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Expected a multipart form with a `file` field" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Missing `file` field in the form" }, 400);
    }
    const name = safeAssetName(file.name);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (!ASSET_EXTENSIONS.has(ext)) {
      return c.json(
        { error: `Unsupported image type ".${ext || "?"}" — use png, jpg, jpeg, gif, or webp` },
        400,
      );
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength === 0) {
      return c.json({ error: "Uploaded file is empty" }, 400);
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      return c.json(
        { error: `Asset exceeds the ${MAX_ASSET_BYTES / (1024 * 1024)} MB limit` },
        400,
      );
    }
    try {
      const assetsDir = join(dirname(configPath), "assets");
      await mkdir(assetsDir, { recursive: true });
      const target = await pickAssetPath(assetsDir, name, bytes);
      await writeFile(target, bytes);
      return c.json({ ok: true, path: `assets/${basename(target)}` });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/fetch", async (c) => {
    const { token, guildId } = resolveCredentials(options);
    if (!token || !guildId) {
      return c.json(
        {
          error: "Discord credentials not configured. Set DISCORD_TOKEN and DISCORD_GUILD_ID.",
          code: "DISCORD_NOT_CONFIGURED",
        },
        503,
      );
    }
    try {
      const client = new DiscordRestClient(token);
      const state = await fetchGuildState(client, guildId);
      writeStateCache(guildId, state);
      // Round-trip: materialize emoji/sticker/guild-asset images next to the
      // config file so the fetched baseline re-applies without manual edits.
      const { config, warnings: assetWarnings } = await materializeExportAssets({
        client,
        state,
        assetsDir: join(dirname(configPath), "assets"),
      });
      const cross = validateCrossReferences(config);
      if (!cross.ok) {
        return c.json(
          {
            ok: false,
            error: "Fetched guild state failed cross-reference validation",
            issues: cross.issues,
            warnings: [...state.warnings, ...assetWarnings],
          },
          400,
        );
      }
      const saved = saveConfig(configPath, config);
      return c.json({
        ok: true,
        config: saved.config,
        raw: saved.raw,
        path: saved.path,
        warnings: [...state.warnings, ...assetWarnings],
        issues: cross.issues,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/plan", async (c) => {
    const { token, guildId } = resolveCredentials(options);
    if (!token || !guildId) {
      return c.json(
        {
          error: "Discord credentials not configured. Set DISCORD_TOKEN and DISCORD_GUILD_ID.",
          code: "DISCORD_NOT_CONFIGURED",
        },
        503,
      );
    }
    let body: { prune?: boolean; config?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body ok — use file on disk
    }
    try {
      let config: ServerConfig;
      let baseDir: string;
      if (body.config !== undefined) {
        const parsed = parseConfigBody(body.config);
        if (!parsed.ok) {
          return c.json({ ok: false, schemaIssues: parsed.schemaIssues }, 400);
        }
        const cross = validateCrossReferences(parsed.config);
        if (!cross.ok) {
          return c.json({ ok: false, issues: cross.issues }, 400);
        }
        config = parsed.config;
        baseDir = dirname(configPath);
      } else {
        const loaded = loadConfig(configPath);
        const cross = validateCrossReferences(loaded.config);
        if (!cross.ok) {
          return c.json({ ok: false, issues: cross.issues }, 400);
        }
        config = loaded.config;
        baseDir = loaded.baseDir;
      }
      const client = new DiscordRestClient(token);
      const state = await fetchGuildState(client, guildId);
      const plan = buildActionPlan({
        config,
        state,
        baseDir,
        prune: body.prune ?? false,
        dryRun: true,
        urlAssetHashes: await urlAssetHashesFor(client, config),
      });
      return c.json({ ok: true, plan, warnings: state.warnings });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/apply", async (c) => {
    const { token, guildId } = resolveCredentials(options);
    if (!token || !guildId) {
      return c.json(
        {
          error: "Discord credentials not configured. Set DISCORD_TOKEN and DISCORD_GUILD_ID.",
          code: "DISCORD_NOT_CONFIGURED",
        },
        503,
      );
    }
    let body: {
      confirm?: boolean;
      dryRun?: boolean;
      prune?: boolean;
      backup?: boolean;
      audit?: boolean;
      config?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.confirm && !body.dryRun) {
      return c.json({ error: "Apply requires confirm: true (or dryRun: true)" }, 400);
    }
    if (applyInFlight) {
      return c.json(
        {
          error: "Another apply is already in progress on this server; wait for it to finish.",
          code: "APPLY_IN_PROGRESS",
        },
        409,
      );
    }
    // Validate config before streaming so bad input stays a plain JSON error.
    let config: ServerConfig;
    let baseDir: string;
    try {
      if (body.config !== undefined) {
        const parsed = parseConfigBody(body.config);
        if (!parsed.ok) {
          return c.json({ ok: false, schemaIssues: parsed.schemaIssues }, 400);
        }
        const cross = validateCrossReferences(parsed.config);
        if (!cross.ok) {
          return c.json({ ok: false, issues: cross.issues }, 400);
        }
        config = parsed.config;
        baseDir = dirname(configPath);
      } else {
        const loaded = loadConfig(configPath);
        const cross = validateCrossReferences(loaded.config);
        if (!cross.ok) {
          return c.json({ ok: false, issues: cross.issues }, 400);
        }
        config = loaded.config;
        baseDir = loaded.baseDir;
      }
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    applyInFlight = true;

    // A long apply is one open HTTP request, but the response is an SSE
    // stream: `start` (plan built), one `action` event per settled action,
    // `done` (final result) or `error`. Heartbeat pings keep idle proxies
    // from dropping the connection; client disconnect aborts the executor
    // so no further Discord API calls are issued.
    const execAbort = new AbortController();
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      const ping = setInterval(() => {
        void stream.write(": ping\n\n");
      }, 15_000);
      try {
        stream.onAbort(() => execAbort.abort());

        const client = new DiscordRestClient(token);
        const state = await fetchGuildState(client, guildId);
        writeStateCache(guildId, state);
        const dryRun = Boolean(body.dryRun);
        const plan = buildActionPlan({
          config,
          state,
          baseDir,
          prune: body.prune ?? false,
          dryRun,
          urlAssetHashes: await urlAssetHashesFor(client, config),
        });
        await send("start", {
          total: plan.actions.length,
          actionable: plan.actions.filter((a) => a.type !== "SKIP").length,
          dryRun,
        });
        if (execAbort.signal.aborted) return; // client went away mid-fetch

        if (dryRun) {
          await send("done", { ok: true, dryRun: true, plan, warnings: state.warnings });
          return;
        }

        let backupPath: string | undefined;
        if (body.backup !== false) {
          backupPath = writeBackup(guildId, state);
        }
        const audit =
          body.audit !== false
            ? createAuditSession({
                guildId,
                source: "ui",
                configPath,
                prune: body.prune ?? false,
                backupPath,
              })
            : undefined;

        const result = await executePlan({
          client,
          plan,
          guildId,
          baseDir,
          dryRun: false,
          initialResolved: resolvedFromState(state),
          signal: execAbort.signal,
          onActionResult: (info) => {
            if (audit && (info.status === "success" || info.status === "failure")) {
              if (info.action.type !== "SKIP") {
                audit.recordAction({
                  action: info.action,
                  outcome: info.status,
                  error: info.error,
                  responseId: info.responseId,
                });
              }
            }
            void send("action", {
              index: info.index,
              total: info.total,
              status: info.status,
              type: info.action.type,
              domain: info.action.domain,
              resource: info.action.resource,
              ...(info.error !== undefined ? { error: info.error } : {}),
            });
          },
        });

        if (audit) {
          audit.end({
            applied: result.applied,
            skipped: result.skipped,
            failed: result.failed.length,
          });
        }
        await send("done", {
          ok: result.failed.length === 0,
          cancelled: execAbort.signal.aborted,
          plan,
          result: {
            applied: result.applied,
            skipped: result.skipped,
            failed: result.failed.map((f) => ({
              resource: f.action.resource,
              type: f.action.type,
              error: f.error,
            })),
          },
          warnings: state.warnings,
          ...(audit ? { auditPath: audit.path } : {}),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await send("error", { error: message }).catch(() => {});
      } finally {
        clearInterval(ping);
        applyInFlight = false;
      }
    });
  });

  const staticDir = options.staticDir ?? defaultStaticDir();
  if (staticDir) {
    app.use("/*", serveStatic({ root: staticDir }));
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) return next();
      return serveStatic({ root: staticDir, path: "./index.html" })(c, next);
    });
  }

  return app;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3847;
  const app = createUiApp(options);

  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  // serve() listens immediately; await the bind so EADDRINUSE is a
  // rejectable error instead of an unhandled 'error' event.
  await new Promise<void>((resolveStart, rejectStart) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      rejectStart(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveStart();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    app,
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}
