import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, resolveAssetPath } from "../../src/config/loader.js";
import { normalizeOverwriteBits, parseColor, ServerConfigSchema } from "../../src/config/schema.js";
import { validateCrossReferences } from "../../src/config/validate.js";
import { confirmDeletes } from "../../src/reconcile/execute.js";
import {
  categoryIdByName,
  findAutoModByName,
  findEmojiByName,
  findWebhookByName,
  findWebhookByNameAndChannel,
} from "../../src/reconcile/identity.js";
import { buildActionPlan, formatPlanTable } from "../../src/reconcile/plan.js";
import { resolvedFromState } from "../../src/reconcile/resolved.js";
import type { ActionPlan, GuildState } from "../../src/state/types.js";

function miniState(): GuildState {
  return {
    guild: {
      id: "g",
      name: "G",
      description: null,
      icon: null,
      banner: null,
      splash: null,
      preferred_locale: "en-US",
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      afk_channel_id: null,
      afk_timeout: 300,
      system_channel_id: null,
      system_channel_flags: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      premium_progress_bar_enabled: false,
      premium_tier: 3,
      features: ["COMMUNITY"],
    },
    roles: [
      {
        id: "g",
        name: "@everyone",
        color: 0,
        hoist: false,
        position: 0,
        permissions: "0",
        managed: false,
        mentionable: false,
      },
    ],
    channels: [
      {
        id: "cat",
        type: 4,
        name: "Cat",
        position: 0,
        parent_id: null,
        permission_overwrites: [],
      },
      {
        id: "ch",
        type: 0,
        name: "general",
        position: 0,
        parent_id: "cat",
        permission_overwrites: [],
      },
    ],
    emojis: [{ id: "e1", name: "wave", roles: [] }],
    stickers: [],
    webhooks: [{ id: "w1", name: "Hook", channel_id: "ch" }],
    autoModRules: [
      {
        id: "a1",
        name: "No Spam",
        enabled: true,
        event_type: 1,
        trigger_type: 3,
        trigger_metadata: {},
        actions: [{ type: 1 }],
        exempt_roles: [],
        exempt_channels: [],
      },
    ],
    welcomeScreen: null,
    onboarding: null,
    vanityUrl: null,
    widget: { enabled: false, channel_id: null },
    botRoleIds: [],
    warnings: [],
  };
}

describe("loader extras", () => {
  it("loads JSON configs", () => {
    const dir = join(tmpdir(), `dm-json-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify({ roles: [{ name: "R" }] }));
    const loaded = loadConfig(path);
    expect(loaded.config.roles[0]!.name).toBe("R");
  });

  it("resolves asset paths", () => {
    expect(resolveAssetPath("/base", "data:image/png;base64,xx")).toBe("data:image/png;base64,xx");
    expect(resolveAssetPath("/base", "img.png")).toBe("/base/img.png");
  });
});

describe("schema helpers", () => {
  it("normalizes overwrite bits from flag arrays", () => {
    const bits = normalizeOverwriteBits(["VIEW_CHANNEL"], ["SEND_MESSAGES"]);
    expect(bits.allow).toBe("1024");
    expect(bits.deny).toBe("2048");
  });

  it("parses colors", () => {
    expect(parseColor("#FF0000")).toBe(0xff0000);
    expect(parseColor("0x00FF00")).toBe(0x00ff00);
    expect(parseColor(1)).toBe(1);
  });
});

describe("validate extras", () => {
  it("validates onboarding and emoji role refs and guild channel refs", () => {
    const config = ServerConfigSchema.parse({
      roles: [{ name: "Member" }],
      channels: [{ name: "general", type: "text" }],
      emojis: [{ name: "ok_emoji", image: "./x.png", roles: ["MissingRole"] }],
      onboarding: {
        enabled: true,
        default_channel_ids: ["nope"],
        prompts: [
          {
            type: 0,
            title: "t",
            options: [
              {
                title: "o",
                channel_ids: ["nope"],
                role_ids: ["NopeRole"],
              },
            ],
          },
        ],
      },
      guild: {
        system_channel: "missing-sys",
      },
      widget: { enabled: true, channel: "missing-widget" },
      auto_mod: {
        rules: [
          {
            name: "R",
            event_type: 1,
            trigger_type: 1,
            actions: [{ type: 2, metadata: { channel: "missing-mod" } }],
            exempt_roles: ["Nope"],
            exempt_channels: ["nope"],
          },
        ],
      },
    });
    const result = validateCrossReferences(config);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(5);
  });

  it("accepts permission string on roles", () => {
    const config = ServerConfigSchema.parse({
      roles: [{ name: "X", permissions: "not-a-number-or-flag" }],
    });
    const result = validateCrossReferences(config);
    expect(result.ok).toBe(false);
  });
});

describe("identity extras", () => {
  it("finds emoji, webhook, automod, category ids", () => {
    const state = miniState();
    expect(findEmojiByName(state.emojis, "wave")?.id).toBe("e1");
    expect(findWebhookByName(state.webhooks, "Hook")?.id).toBe("w1");
    expect(findWebhookByNameAndChannel(state.webhooks, "Hook", "ch")?.id).toBe("w1");
    expect(findAutoModByName(state.autoModRules, "No Spam")?.id).toBe("a1");
    expect(categoryIdByName(state.channels, "Cat", new Map())).toBe("cat");
    expect(categoryIdByName(state.channels, "X", new Map([["category:X", "99"]]))).toBe("99");
    expect(categoryIdByName(state.channels, null, new Map())).toBeNull();
  });
});

describe("resolvedFromState", () => {
  it("seeds role/category/channel keys", () => {
    const map = resolvedFromState(miniState());
    expect(map.get("role:@everyone")).toBe("g");
    expect(map.get("category:Cat")).toBe("cat");
    expect(map.get("channel:general")).toBe("ch");
    expect(map.get("emoji:wave")).toBe("e1");
    expect(map.get("webhook:Hook")).toBe("w1");
    expect(map.get("auto_mod_rule:No Spam")).toBe("a1");
  });
});

describe("formatPlanTable", () => {
  it("renders summary and actions", () => {
    const plan = buildActionPlan({
      config: ServerConfigSchema.parse({
        roles: [{ name: "NewRole", permissions: "1024" }],
        vanity_url_code: "cool",
      }),
      state: miniState(),
      dryRun: true,
    });
    const text = formatPlanTable(plan);
    expect(text).toContain("Plan:");
    expect(text).toContain("dry-run");
    expect(text).toMatch(/CREATE|SKIP/);
  });
});

describe("confirmDeletes", () => {
  it("returns true when --yes or no deletes", async () => {
    const empty: ActionPlan = {
      actions: [],
      summary: { creates: 0, updates: 0, deletes: 0, skips: 0 },
      dry_run: false,
      warnings: [],
    };
    expect(await confirmDeletes(empty, false, async () => false)).toBe(true);

    const withDel: ActionPlan = {
      actions: [
        {
          type: "DELETE",
          domain: "role",
          resource: "X",
          endpoint: "/x",
          method: "DELETE",
          payload: null,
          reason: "t",
          dependencies: [],
        },
      ],
      summary: { creates: 0, updates: 0, deletes: 1, skips: 0 },
      dry_run: false,
      warnings: [],
    };
    expect(await confirmDeletes(withDel, true, async () => false)).toBe(true);
  });

  it("throws in non-TTY without --yes", async () => {
    const withDel: ActionPlan = {
      actions: [
        {
          type: "DELETE",
          domain: "role",
          resource: "X",
          endpoint: "/x",
          method: "DELETE",
          payload: null,
          reason: "t",
          dependencies: [],
        },
      ],
      summary: { creates: 0, updates: 0, deletes: 1, skips: 0 },
      dry_run: false,
      warnings: [],
    };
    await expect(confirmDeletes(withDel, false, async () => true)).rejects.toThrow(/--yes/);
  });

  it("with all: true prompts for non-DELETE actions and passes with --yes", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const withCreate: ActionPlan = {
        actions: [
          {
            type: "CREATE",
            domain: "channel",
            resource: "X",
            endpoint: "/x",
            method: "POST",
            payload: null,
            reason: "t",
            dependencies: [],
          },
        ],
        summary: { creates: 1, updates: 0, deletes: 0, skips: 0 },
        dry_run: false,
        warnings: [],
      };
      expect(await confirmDeletes(withCreate, true, async () => false, { all: true })).toBe(true);

      const asked = vi.fn(async (_q: string) => true);
      expect(await confirmDeletes(withCreate, false, asked, { all: true })).toBe(true);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(asked.mock.calls[0]![0]).toContain("About to apply 1 action(s)");

      const skipsOnly: ActionPlan = {
        actions: [
          {
            type: "SKIP",
            domain: "channel",
            resource: "X",
            endpoint: "/x",
            method: "PATCH",
            payload: null,
            reason: "t",
            dependencies: [],
          },
        ],
        summary: { creates: 0, updates: 0, deletes: 0, skips: 1 },
        dry_run: false,
        warnings: [],
      };
      expect(await confirmDeletes(skipsOnly, false, async () => false, { all: true })).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});

describe("diff webhooks / automod / widget / welcome", () => {
  it("plans webhook create, automod, widget, vanity, welcome when community", () => {
    const state = miniState();
    const plan = buildActionPlan({
      config: ServerConfigSchema.parse({
        channels: [{ name: "general", category: "Cat", type: "text" }],
        categories: [{ name: "Cat" }],
        webhooks: [{ name: "GitHub", channel: "general" }],
        auto_mod: {
          rules: [
            {
              name: "Links",
              event_type: 1,
              trigger_type: 1,
              trigger_metadata: { keyword_filter: ["bad"] },
              actions: [{ type: 1 }],
            },
          ],
        },
        welcome_screen: {
          enabled: true,
          welcome_channels: [{ channel: "general", description: "hi" }],
        },
        onboarding: {
          enabled: true,
          default_channel_ids: ["general"],
          prompts: [],
        },
        vanity_url_code: "cool",
        widget: { enabled: true, channel: "general" },
      }),
      state,
    });
    expect(plan.actions.some((a) => a.domain === "webhook" && a.type === "CREATE")).toBe(true);
    expect(plan.actions.some((a) => a.domain === "auto_mod_rule")).toBe(true);
    expect(plan.actions.some((a) => a.domain === "welcome_screen")).toBe(true);
    expect(plan.actions.some((a) => a.domain === "onboarding")).toBe(true);
    expect(plan.actions.some((a) => a.domain === "vanity_url" && a.type === "UPDATE")).toBe(true);
    expect(plan.actions.some((a) => a.domain === "widget")).toBe(true);
  });

  it("plans emoji create and prune deletes", () => {
    const state = miniState();
    const plan = buildActionPlan({
      config: ServerConfigSchema.parse({
        emojis: [{ name: "newemoji", image: "./x.png", roles: [] }],
      }),
      state,
      prune: true,
    });
    expect(plan.actions.some((a) => a.domain === "emoji" && a.type === "CREATE")).toBe(true);
    expect(
      plan.actions.some(
        (a) => a.domain === "emoji" && a.type === "DELETE" && a.resource === "wave",
      ),
    ).toBe(true);
  });
});
