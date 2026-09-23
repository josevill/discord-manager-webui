import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchGuildStateMock, buildActionPlanMock, urlAssetHashesForMock, executePlanMock } =
  vi.hoisted(() => ({
    fetchGuildStateMock: vi.fn(),
    buildActionPlanMock: vi.fn(),
    urlAssetHashesForMock: vi.fn(),
    executePlanMock: vi.fn(),
  }));

vi.mock("../../src/discord/client.js", () => ({
  DiscordRestClient: class {},
  fetchGuildState: (...a: unknown[]) => fetchGuildStateMock(...a),
}));
vi.mock("../../src/reconcile/plan.js", () => ({
  buildActionPlan: (...a: unknown[]) => buildActionPlanMock(...a),
  urlAssetHashesFor: (...a: unknown[]) => urlAssetHashesForMock(...a),
}));
vi.mock("../../src/reconcile/execute.js", () => ({
  executePlan: (...a: unknown[]) => executePlanMock(...a),
}));

import type { Action, ActionPlan } from "../../src/state/types.js";
import { createUiApp, MAX_ASSET_BYTES } from "../../src/web/server.js";

// Minimal GuildState shape so the (unmocked) resolvedFromState can run.
const FAKE_STATE = {
  guild: { id: "guild-1" },
  roles: [],
  channels: [],
  emojis: [],
  webhooks: [],
  autoModRules: [],
  warnings: [],
};

function actionPlan(actions: Action[]): ActionPlan {
  return {
    actions,
    summary: {
      creates: actions.filter((a) => a.type === "CREATE").length,
      updates: actions.filter((a) => a.type === "UPDATE").length,
      deletes: actions.filter((a) => a.type === "DELETE").length,
      skips: actions.filter((a) => a.type === "SKIP").length,
    },
    dry_run: false,
    warnings: [],
  };
}

const ROLE_ACTION: Action = {
  type: "CREATE",
  domain: "role",
  resource: "Mod",
  endpoint: "/guilds/guild-1/roles",
  method: "POST",
  payload: { name: "Mod" },
  reason: "Role Mod not found",
  dependencies: [],
};
const CHANNEL_ACTION: Action = {
  type: "UPDATE",
  domain: "channel",
  resource: "general",
  endpoint: "/channels/1",
  method: "PATCH",
  payload: { topic: "hi" },
  reason: "Channel fields differ",
  dependencies: [],
  targetId: "1",
};

function makeApp() {
  return createUiApp({
    configPath: "/tmp/dm-test-config.yaml",
    token: "test-token",
    guildId: "guild-1",
  });
}

// Inline config so the handler never reads (the absent) file on disk.
const INLINE_CONFIG = { roles: [], categories: [], channels: [] };

function applyRequest(
  app: ReturnType<typeof makeApp>,
  body: Record<string, unknown> = {
    confirm: true,
    dryRun: true,
    config: INLINE_CONFIG,
  },
  init?: RequestInit,
) {
  return app.request("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Consume an SSE response body into parsed events (ping comments dropped). */
async function readSse(res: Response): Promise<SseEvent[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    const event = frame.match(/^event: (.*)$/m)?.[1] ?? "message";
    const dataLine = frame.match(/^data: (.*)$/m)?.[1];
    if (!dataLine) continue; // heartbeat comment
    events.push({ event, data: JSON.parse(dataLine) });
  }
  return events;
}

function defaultExecuteMock() {
  executePlanMock.mockImplementation(
    async ({
      onActionResult,
    }: {
      onActionResult?: (info: {
        action: Action;
        index: number;
        total: number;
        status: "success" | "failure" | "skip";
        error?: string;
      }) => void;
    }) => {
      const plan = buildActionPlanMock() as ActionPlan;
      plan.actions.forEach((action, index) => {
        onActionResult?.({
          action,
          index,
          total: plan.actions.length,
          status: "success",
        });
      });
      return {
        applied: plan.actions.length,
        skipped: 0,
        failed: [] as { action: Action; error: string }[],
        resolved: new Map<string, string>(),
      };
    },
  );
}

describe("/api/apply SSE streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    urlAssetHashesForMock.mockResolvedValue({});
    fetchGuildStateMock.mockResolvedValue(FAKE_STATE);
    buildActionPlanMock.mockReturnValue(actionPlan([ROLE_ACTION, CHANNEL_ACTION]));
    defaultExecuteMock();
  });

  it("streams start, per-action progress, and a final done event", async () => {
    const app = makeApp();
    const res = await applyRequest(app, {
      confirm: true,
      dryRun: false,
      backup: false,
      audit: false,
      config: INLINE_CONFIG,
    });

    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["start", "action", "action", "done"]);
    expect(events[0]!.data).toMatchObject({ total: 2, actionable: 2, dryRun: false });
    expect(events[1]!.data).toMatchObject({
      index: 0,
      total: 2,
      status: "success",
      type: "CREATE",
      domain: "role",
      resource: "Mod",
    });
    expect(events[2]!.data).toMatchObject({
      index: 1,
      total: 2,
      type: "UPDATE",
      resource: "general",
    });
    expect(events[3]!.data).toMatchObject({
      ok: true,
      result: { applied: 2, skipped: 0, failed: [] },
    });
  });

  it("streams failures with the error text and ok:false on done", async () => {
    executePlanMock.mockImplementation(
      async ({
        onActionResult,
      }: {
        onActionResult?: (info: {
          action: Action;
          index: number;
          total: number;
          status: "success" | "failure" | "skip";
          error?: string;
        }) => void;
      }) => {
        const plan = buildActionPlanMock() as ActionPlan;
        plan.actions.forEach((action, index) => {
          onActionResult?.({
            action,
            index,
            total: plan.actions.length,
            status: "failure",
            error: "Missing Permissions",
          });
        });
        return {
          applied: 0,
          skipped: 0,
          failed: plan.actions.map((action) => ({ action, error: "Missing Permissions" })),
          resolved: new Map<string, string>(),
        };
      },
    );

    const app = makeApp();
    const res = await applyRequest(app, {
      confirm: true,
      dryRun: false,
      backup: false,
      audit: false,
      config: INLINE_CONFIG,
    });
    const events = await readSse(res);
    expect(events[1]!.data).toMatchObject({ status: "failure", error: "Missing Permissions" });
    expect(events[3]!.data).toMatchObject({
      ok: false,
      result: {
        failed: [
          { resource: "Mod", type: "CREATE", error: "Missing Permissions" },
          { resource: "general", type: "UPDATE", error: "Missing Permissions" },
        ],
      },
    });
  });

  it("emits an error event and releases the lock when the run throws", async () => {
    const app = makeApp();
    fetchGuildStateMock.mockRejectedValue(new Error("fetch blew up"));

    const res = await applyRequest(app, {
      confirm: true,
      dryRun: false,
      backup: false,
      audit: false,
      config: INLINE_CONFIG,
    });
    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["error"]);
    expect(events[0]!.data).toMatchObject({ error: "fetch blew up" });
    expect(executePlanMock).not.toHaveBeenCalled();

    // Lock released: a fresh apply goes through.
    fetchGuildStateMock.mockResolvedValue(FAKE_STATE);
    const again = await applyRequest(app, {
      confirm: true,
      dryRun: true,
      config: INLINE_CONFIG,
    });
    const events2 = await readSse(again);
    expect(events2.map((e) => e.event)).toEqual(["start", "done"]);
  });

  it("dry-run streams start + done without executing", async () => {
    const app = makeApp();
    const res = await applyRequest(app);
    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["start", "done"]);
    expect(events[1]!.data).toMatchObject({ ok: true, dryRun: true });
    expect(executePlanMock).not.toHaveBeenCalled();
  });

  it("aborts execution when the client disconnects, then releases the lock", async () => {
    const app = makeApp();
    // Executor waits until the server hands it an aborted signal (simulated
    // by cancelling the response body = client disconnect).
    executePlanMock.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        applied: 0,
        skipped: (buildActionPlanMock() as ActionPlan).actions.length,
        failed: [] as { action: Action; error: string }[],
        resolved: new Map<string, string>(),
      };
    });

    const res = await applyRequest(app, {
      confirm: true,
      dryRun: false,
      backup: false,
      audit: false,
      config: INLINE_CONFIG,
    });
    // Let the handler reach executePlan (onAbort registered), then "hang up".
    await new Promise((r) => setTimeout(r, 25));
    expect(executePlanMock).toHaveBeenCalledTimes(1);
    const signalArg = (executePlanMock.mock.calls[0]![0] as { signal?: AbortSignal }).signal;
    expect(signalArg).toBeInstanceOf(AbortSignal);
    expect(signalArg?.aborted).toBe(false);

    await res.body!.cancel();
    await vi.waitFor(() => expect(signalArg?.aborted).toBe(true));
    expect(signalArg?.aborted).toBe(true);

    // Lock released after the aborted run settles.
    await vi.waitFor(async () => {
      const again = await applyRequest(app, {
        confirm: true,
        dryRun: true,
        config: INLINE_CONFIG,
      });
      const events = await readSse(again);
      expect(events.map((e) => e.event)).toEqual(["start", "done"]);
    });
  });
});

describe("/api/assets upload", () => {
  let tmpRoot: string;

  function assetsApp() {
    tmpRoot = mkdtempSync(join(tmpdir(), "dm-assets-"));
    return createUiApp({
      configPath: join(tmpRoot, "config.yaml"),
      token: "test-token",
      guildId: "guild-1",
    });
  }

  function pngBytes(tag: string): Buffer {
    return Buffer.from(`fake-png-${tag}`);
  }

  async function upload(app: ReturnType<typeof assetsApp>, name: string, bytes: Buffer) {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name));
    return app.request("/api/assets", { method: "POST", body: form });
  }

  it("writes the file into <config dir>/assets and returns the relative path", async () => {
    const app = assetsApp();
    const res = await upload(app, "icon.png", pngBytes("a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("assets/icon.png");
    const onDisk = readFileSync(join(tmpRoot, "assets", "icon.png"));
    expect(onDisk.equals(pngBytes("a"))).toBe(true);
  });

  it("keeps the same name for identical bytes and suffixes on content change", async () => {
    const app = assetsApp();
    await upload(app, "icon.png", pngBytes("a"));

    // Identical bytes → same path, no duplicate.
    const again = await upload(app, "icon.png", pngBytes("a"));
    const againBody = (await again.json()) as { path: string };
    expect(againBody.path).toBe("assets/icon.png");

    // Different bytes → suffixed name so other references aren't clobbered.
    const changed = await upload(app, "icon.png", pngBytes("b"));
    const changedBody = (await changed.json()) as { path: string };
    expect(changedBody.path).toBe("assets/icon-1.png");
    expect(readFileSync(join(tmpRoot, "assets", "icon-1.png")).equals(pngBytes("b"))).toBe(true);
  });

  it("sanitizes traversal-ish names", async () => {
    const app = assetsApp();
    const res = await upload(app, "../../evil.png", pngBytes("x"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("assets/evil.png");
    expect(statSync(join(tmpRoot, "assets", "evil.png")).isFile()).toBe(true);
    expect(existsSync(join(tmpRoot, "evil.png"))).toBe(false);
  });

  it("rejects unsupported types, missing files, and oversize uploads", async () => {
    const app = assetsApp();

    const badType = await upload(app, "script.js", Buffer.from("alert(1)"));
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: string }).error).toContain("png");

    const noFile = await app.request("/api/assets", {
      method: "POST",
      body: new FormData(),
    });
    expect(noFile.status).toBe(400);

    const big = await upload(app, "big.png", Buffer.alloc(MAX_ASSET_BYTES + 1));
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toContain("limit");
  });

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe("/api/apply pre-stream JSON errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    urlAssetHashesForMock.mockResolvedValue({});
    buildActionPlanMock.mockReturnValue(actionPlan([]));
    defaultExecuteMock();
  });

  it("rejects a concurrent apply with 409 and releases the lock afterwards", async () => {
    const app = makeApp();
    let resolveState!: (s: unknown) => void;
    fetchGuildStateMock.mockReturnValue(
      new Promise((r) => {
        resolveState = r;
      }),
    );

    const first = applyRequest(app); // in flight; holds the lock
    await new Promise((r) => setTimeout(r, 10));

    const second = await applyRequest(app);
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as {
      code?: string;
      error?: string;
    };
    expect(secondBody.code).toBe("APPLY_IN_PROGRESS");

    resolveState({ warnings: [] });
    const firstResp = await first;
    const firstEvents = await readSse(firstResp);
    expect(firstEvents.map((e) => e.event)).toEqual(["start", "done"]);
    expect(firstEvents[1]!.data).toMatchObject({ ok: true, dryRun: true });

    // Lock released: a fresh apply goes through.
    fetchGuildStateMock.mockResolvedValue(FAKE_STATE);
    const third = await applyRequest(app);
    expect(third.status).toBe(200);
  });

  it("releases the lock when apply fails", async () => {
    const app = makeApp();
    fetchGuildStateMock.mockRejectedValue(new Error("fetch blew up"));

    const first = await applyRequest(app, {
      confirm: true,
      dryRun: false,
      backup: false,
      audit: false,
      config: INLINE_CONFIG,
    });
    const events = await readSse(first);
    expect(events.map((e) => e.event)).toEqual(["error"]);

    fetchGuildStateMock.mockResolvedValue(FAKE_STATE);
    const second = await applyRequest(app);
    expect(second.status).toBe(200);
  });

  it("still answers 400/503 as plain JSON before streaming", async () => {
    const app = makeApp();

    const noConfirm = await app.request("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: INLINE_CONFIG }),
    });
    expect(noConfirm.status).toBe(400);
    const noConfirmBody = (await noConfirm.json()) as { error: string };
    expect(noConfirmBody.error).toContain("confirm");

    const badSchema = await app.request("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, config: { roles: "nope" } }),
    });
    expect(badSchema.status).toBe(400);
    const badBody = (await badSchema.json()) as { schemaIssues?: unknown[] };
    expect(badBody.schemaIssues).toBeDefined();
  });
});
