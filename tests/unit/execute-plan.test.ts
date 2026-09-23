import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordRestClient } from "../../src/discord/client.js";
import {
  confirmDeletes,
  executePlan,
  loadAssetDataUri,
  resolvePlaceholders,
} from "../../src/reconcile/execute.js";
import type { Action, ActionPlan } from "../../src/state/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function action(partial: Partial<Action> & Pick<Action, "type" | "domain" | "resource">): Action {
  return {
    endpoint: "/guilds/g1/x",
    method: "POST",
    payload: null,
    reason: "t",
    dependencies: [],
    ...partial,
  };
}

function plan(actions: Action[], dryRun = false): ActionPlan {
  return {
    actions,
    summary: {
      creates: actions.filter((a) => a.type === "CREATE").length,
      updates: actions.filter((a) => a.type === "UPDATE").length,
      deletes: actions.filter((a) => a.type === "DELETE").length,
      skips: actions.filter((a) => a.type === "SKIP").length,
    },
    dry_run: dryRun,
    warnings: [],
  };
}

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    token: "tok",
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    postMultipart: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as DiscordRestClient & Record<string, ReturnType<typeof vi.fn>>;
}

describe("resolvePlaceholders", () => {
  const resolved = new Map([
    ["role:Mod", "r1"],
    ["category:Cat", "c1"],
    ["channel:general", "ch1"],
  ]);

  it.each([
    ["__resolve_role__:Mod", "r1"],
    ["__resolve_category__:Cat", "c1"],
    ["__resolve_channel__:general", "ch1"],
  ])("resolves %s", async (input, expected) => {
    await expect(resolvePlaceholders(input, resolved, "/tmp")).resolves.toBe(expected);
  });

  it("resolves __resolve_channel_webhooks__ to the channel webhooks endpoint", async () => {
    await expect(
      resolvePlaceholders("__resolve_channel_webhooks__:general", resolved, "/tmp"),
    ).resolves.toBe("/channels/ch1/webhooks");
  });

  it.each([
    ["__resolve_role__:Ghost", /Unresolved role reference: Ghost/],
    ["__resolve_category__:Ghost", /Unresolved category reference: Ghost/],
    ["__resolve_channel__:Ghost", /Unresolved channel reference: Ghost/],
    ["__resolve_channel_webhooks__:Ghost", /Unresolved channel for webhook: Ghost/],
  ])("throws for unresolved %s", async (input, re) => {
    await expect(resolvePlaceholders(input, new Map(), "/tmp")).rejects.toThrow(re);
  });

  it("resolves placeholders nested in arrays and objects, dropping undefined", async () => {
    const out = (await resolvePlaceholders(
      {
        a: "__resolve_channel__:general",
        b: ["__resolve_role__:Mod", 42, true, null, "plain"],
        nested: { c: "__resolve_category__:Cat", d: undefined },
      },
      resolved,
      "/tmp",
    )) as Record<string, unknown>;
    expect(out).toEqual({
      a: "ch1",
      b: ["r1", 42, true, null, "plain"],
      nested: { c: "c1" },
    });
  });

  it("passes through plain strings, numbers, and null unchanged", async () => {
    await expect(resolvePlaceholders("plain", resolved, "/tmp")).resolves.toBe("plain");
    await expect(resolvePlaceholders(7, resolved, "/tmp")).resolves.toBe(7);
    await expect(resolvePlaceholders(null, resolved, "/tmp")).resolves.toBeNull();
  });

  it("resolves __asset__ local files to data URIs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-exec-resolve-"));
    try {
      writeFileSync(join(dir, "img.png"), Buffer.from([1, 2, 3]));
      await expect(resolvePlaceholders(`__asset__:img.png`, resolved, dir)).resolves.toBe(
        `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadAssetDataUri", () => {
  it("encodes a local file with its extension-derived mime type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-exec-datauri-"));
    try {
      writeFileSync(join(dir, "pic.gif"), Buffer.from([0, 1]));
      await expect(loadAssetDataUri(dir, "pic.gif")).resolves.toBe(
        `data:image/gif;base64,${Buffer.from([0, 1]).toString("base64")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes data: URIs through without touching disk", async () => {
    const uri = "data:image/png;base64,AA==";
    await expect(loadAssetDataUri("/nonexistent", uri)).resolves.toBe(uri);
  });
});

describe("executePlan — dependency-skip cascade", () => {
  it("skips dependents of a failed CREATE, and cascades to their dependents", async () => {
    const client = mockClient({
      post: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom")) // role Ghost
        .mockResolvedValue({ id: "ch9" }), // channel ok (independent)
    });

    const p = plan([
      action({
        type: "CREATE",
        domain: "role",
        resource: "Ghost",
        endpoint: "/guilds/g1/roles",
      }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "gated",
        dependencies: ["role:Ghost"],
      }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "grandchild",
        dependencies: ["channel:gated"],
      }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "ok",
      }),
    ]);

    const result = await executePlan({ client, plan: p, guildId: "g1", baseDir: "/tmp" });

    // The role failed, the two dependents were skipped, the independent one applied.
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.failed.map((f) => f.action.resource)).toEqual(["Ghost"]);
    expect(result.failed[0]!.error).toBe("boom");
    expect(client.post).toHaveBeenCalledTimes(2); // Ghost + ok; gated/grandchild never called
    expect(result.resolved.get("channel:ok")).toBe("ch9");
    expect(result.resolved.has("role:Ghost")).toBe(false);
    expect(result.resolved.has("channel:gated")).toBe(false);
  });

  it("reports the first unmet dependency in the skip reason and surfaces it to onActionResult", async () => {
    const client = mockClient();
    const p = plan([
      action({
        type: "CREATE",
        domain: "channel",
        resource: "gated",
        dependencies: ["role:A", "role:B"],
      }),
    ]);

    const seen: { status: string; skipReason?: string }[] = [];
    const result = await executePlan({
      client,
      plan: p,
      guildId: "g1",
      baseDir: "/tmp",
      initialResolved: new Map([["role:B", "rB"]]),
      onActionResult: (info) => {
        seen.push({ status: info.status, skipReason: info.action.skipReason });
      },
    });

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(seen).toEqual([
      { status: "skip", skipReason: "Skipped because dependency role:A was not created" },
    ]);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("satisfies dependencies with ids seeded from initialResolved / targetId", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({ id: "ch1" }),
      patch: vi.fn().mockResolvedValue({}),
    });
    const p = plan([
      action({
        type: "UPDATE",
        domain: "channel",
        resource: "general",
        endpoint: "/channels/999",
        method: "PATCH",
        payload: { topic: "__resolve_role__:Mod" },
        targetId: "999",
      }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "general2",
        payload: { name: "general2" },
        dependencies: ["channel:general"],
      }),
    ]);

    const result = await executePlan({
      client,
      plan: p,
      guildId: "g1",
      baseDir: "/tmp",
      initialResolved: new Map([["role:Mod", "r-mod"]]),
    });

    expect(result.failed).toEqual([]);
    expect(result.applied).toBe(2);
    expect(client.patch).toHaveBeenCalledWith("/channels/999", { topic: "r-mod" });
    // UPDATE targetId re-registered the channel so the dependent CREATE ran.
    expect(result.resolved.get("channel:general")).toBe("999");
  });
});

describe("executePlan — failure continuation", () => {
  it("records the failure and continues with independent actions", async () => {
    const order: string[] = [];
    const client = mockClient({
      post: vi.fn().mockImplementation(async (_: string, payload?: unknown) => {
        const name = (payload as { name?: string })?.name;
        order.push(name ?? "?");
        if (name === "bad") throw new Error("50033: Channel name already taken");
        return { id: `id-${name}` };
      }),
    });

    const p = plan([
      action({ type: "CREATE", domain: "channel", resource: "a", payload: { name: "a" } }),
      action({ type: "CREATE", domain: "channel", resource: "bad", payload: { name: "bad" } }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "after",
        payload: { name: "after" },
      }),
    ]);

    const statuses: string[] = [];
    const result = await executePlan({
      client,
      plan: p,
      guildId: "g1",
      baseDir: "/tmp",
      onActionResult: (info) => statuses.push(info.status),
    });

    expect(order).toEqual(["a", "bad", "after"]);
    expect(statuses).toEqual(["success", "failure", "success"]);
    expect(result.applied).toBe(2);
    expect(result.failed).toEqual([
      {
        action: p.actions[1]!,
        error: "50033: Channel name already taken",
      },
    ]);
    expect(result.resolved.get("channel:a")).toBe("id-a");
    expect(result.resolved.get("channel:after")).toBe("id-after");
  });

  it("unregisters nothing: a failed CREATE leaves dependents skipped, others still apply", async () => {
    const client = mockClient({
      post: vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue({ id: "x" }),
    });
    const p = plan([
      action({ type: "CREATE", domain: "role", resource: "R", endpoint: "/guilds/g1/roles" }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "C",
        payload: { name: "C" },
        dependencies: ["role:R"],
      }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "D",
        payload: { name: "D" },
      }),
    ]);
    const result = await executePlan({ client, plan: p, guildId: "g1", baseDir: "/tmp" });
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed.map((f) => f.action.resource)).toEqual(["R"]);
  });
});

describe("executePlan — dry run and method dispatch", () => {
  it("counts every actionable as a skip in dry-run mode without API calls", async () => {
    const client = mockClient();
    const p = plan(
      [
        action({ type: "CREATE", domain: "channel", resource: "a", payload: { name: "a" } }),
        action({
          type: "DELETE",
          domain: "role",
          resource: "b",
          method: "DELETE",
          endpoint: "/guilds/g1/roles/1",
        }),
      ],
      true, // dry_run in the plan itself
    );
    const result = await executePlan({ client, plan: p, guildId: "g1", baseDir: "/tmp" });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.failed).toEqual([]);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("honours the dryRun option even when the plan says otherwise", async () => {
    const client = mockClient();
    const p = plan([
      action({ type: "CREATE", domain: "channel", resource: "a", payload: { name: "a" } }),
    ]);
    const result = await executePlan({
      client,
      plan: p,
      guildId: "g1",
      baseDir: "/tmp",
      dryRun: true,
    });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("dispatches PUT and DELETE to the matching client methods", async () => {
    const client = mockClient({
      put: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    });
    const p = plan([
      action({
        type: "UPDATE",
        domain: "onboarding",
        resource: "onboarding",
        endpoint: "/guilds/g1/onboarding",
        method: "PUT",
        payload: { enabled: true },
      }),
      action({
        type: "DELETE",
        domain: "role",
        resource: "old",
        endpoint: "/guilds/g1/roles/42",
        method: "DELETE",
      }),
    ]);
    const result = await executePlan({ client, plan: p, guildId: "g1", baseDir: "/tmp" });
    expect(result.applied).toBe(2);
    expect(result.failed).toEqual([]);
    expect(client.put).toHaveBeenCalledWith("/guilds/g1/onboarding", { enabled: true });
    expect(client.delete).toHaveBeenCalledWith("/guilds/g1/roles/42");
  });

  it("registers created ids for each resolvable domain", async () => {
    const client = mockClient({
      post: vi
        .fn()
        .mockResolvedValueOnce({ id: "c1" })
        .mockResolvedValueOnce({ id: "r1" })
        .mockResolvedValueOnce({ id: "ch1" })
        .mockResolvedValueOnce({ id: "e1" })
        .mockResolvedValueOnce({ id: "w1" })
        .mockResolvedValueOnce({ id: "m1" }),
    });
    const p = plan([
      action({
        type: "CREATE",
        domain: "category",
        resource: "Cat",
        payload: { name: "Cat" },
      }),
      action({
        type: "CREATE",
        domain: "role",
        resource: "Mod",
        payload: { name: "Mod" },
      }),
      action({
        type: "CREATE",
        domain: "channel",
        resource: "general",
        payload: { name: "general" },
      }),
      action({
        type: "CREATE",
        domain: "emoji",
        resource: "wave",
        payload: { name: "wave" },
      }),
      action({
        type: "CREATE",
        domain: "webhook",
        resource: "Hook",
        payload: { name: "Hook" },
      }),
      action({
        type: "CREATE",
        domain: "auto_mod_rule",
        resource: "Rule",
        payload: { name: "Rule" },
      }),
    ]);
    const result = await executePlan({ client, plan: p, guildId: "g1", baseDir: "/tmp" });
    expect(result.failed).toEqual([]);
    expect(result.resolved.get("category:Cat")).toBe("c1");
    expect(result.resolved.get("role:Mod")).toBe("r1");
    expect(result.resolved.get("channel:general")).toBe("ch1");
    expect(result.resolved.get("emoji:wave")).toBe("e1");
    expect(result.resolved.get("webhook:Hook")).toBe("w1");
    expect(result.resolved.get("auto_mod_rule:Rule")).toBe("m1");
  });

  it("resolves a __resolve_channel_webhooks__ endpoint against a seeded channel", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({ id: "w1" }),
    });
    const p = plan([
      action({
        type: "CREATE",
        domain: "webhook",
        resource: "Hook",
        endpoint: "__resolve_channel_webhooks__:general",
        payload: { name: "Hook" },
      }),
    ]);
    const result = await executePlan({
      client,
      plan: p,
      guildId: "g1",
      baseDir: "/tmp",
      initialResolved: new Map([["channel:general", "ch-77"]]),
    });
    expect(result.failed).toEqual([]);
    expect(client.post).toHaveBeenCalledWith("/channels/ch-77/webhooks", { name: "Hook" });
  });

  it("sanitizes auto-mod action metadata (drops the name-keyed channel field)", async () => {
    const client = mockClient({
      patch: vi.fn().mockResolvedValue({}),
    });
    const p = plan([
      action({
        type: "UPDATE",
        domain: "auto_mod_rule",
        resource: "R",
        endpoint: "/guilds/g1/auto-moderation/rules/1",
        method: "PATCH",
        payload: {
          name: "R",
          actions: [
            {
              type: 2,
              metadata: { channel: "__resolve_channel__:alerts", channel_id: undefined },
            },
          ],
        },
      }),
    ]);
    await executePlan({
      client,
      plan: p,
      guildId: "g1",
      baseDir: "/tmp",
      initialResolved: new Map([["channel:alerts", "ch-1"]]),
    });
    expect(client.patch).toHaveBeenCalledWith("/guilds/g1/auto-moderation/rules/1", {
      name: "R",
      actions: [{ type: 2, metadata: {} }],
    });
  });

  it("passes undefined payloads through as no-body calls for DELETE", async () => {
    const client = mockClient();
    const p = plan([
      action({
        type: "DELETE",
        domain: "emoji",
        resource: "x",
        endpoint: "/guilds/g1/emojis/1",
        method: "DELETE",
      }),
    ]);
    const result = await executePlan({ client, plan: p, guildId: "g1", baseDir: "/tmp" });
    expect(result.applied).toBe(1);
    expect(client.delete).toHaveBeenCalledWith("/guilds/g1/emojis/1");
  });
});

describe("confirmDeletes — non-TTY guard", () => {
  const withDelete = (): ActionPlan =>
    plan([
      action({
        type: "DELETE",
        domain: "role",
        resource: "X",
        endpoint: "/guilds/g1/roles/1",
        method: "DELETE",
      }),
    ]);

  it("throws a --yes hint when stdin is not a TTY and --yes is absent", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(confirmDeletes(withDelete(), false, async () => true)).rejects.toThrow(
        /1 DELETE\(s\) require confirmation; re-run with --yes/,
      );
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it("does not prompt when the plan has no deletions", async () => {
    const ask = vi.fn(async () => false);
    const p = plan([
      action({ type: "CREATE", domain: "role", resource: "X", payload: { name: "X" } }),
    ]);
    await expect(confirmDeletes(p, false, ask)).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
