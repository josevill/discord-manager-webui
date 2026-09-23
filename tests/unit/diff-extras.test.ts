import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/config/schema.js";
import { ServerConfigSchema } from "../../src/config/schema.js";
import {
  diffAutoMod,
  diffChannelPositions,
  diffGuild,
  diffRoles,
  diffWelcomeAndOnboarding,
} from "../../src/reconcile/diff.js";
import { buildActionPlan } from "../../src/reconcile/plan.js";
import type { GuildState } from "../../src/state/types.js";

function cfg(raw: unknown): ServerConfig {
  return ServerConfigSchema.parse(raw);
}

const everyone = {
  id: "guild1",
  name: "@everyone",
  color: 0,
  hoist: false,
  position: 0,
  permissions: "0",
  managed: false,
  mentionable: false,
} as const;

const botRole = {
  id: "botrole",
  name: "Discord Manager",
  color: 0,
  hoist: false,
  position: 10,
  permissions: "8",
  managed: true,
  mentionable: false,
} as const;

function state(overrides: Partial<GuildState> = {}): GuildState {
  return {
    guild: {
      id: "guild1",
      name: "Test",
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
      premium_tier: 0,
      features: [],
    },
    roles: [everyone, botRole],
    channels: [
      {
        id: "general1",
        type: 0,
        name: "general",
        position: 0,
        parent_id: null,
        permission_overwrites: [],
      },
    ],
    emojis: [],
    stickers: [],
    webhooks: [],
    autoModRules: [],
    welcomeScreen: null,
    onboarding: null,
    vanityUrl: null,
    widget: null,
    botRoleIds: ["botrole"],
    warnings: [],
    ...overrides,
  };
}

function ctx(raw: unknown, s: GuildState, extra: { prune?: boolean; baseDir?: string } = {}) {
  return {
    config: cfg(raw),
    state: s,
    baseDir: extra.baseDir ?? "/tmp",
    prune: extra.prune ?? false,
  };
}

describe("diffGuild — scalar + asset fields", () => {
  it("emits one UPDATE carrying every drifted scalar field", () => {
    const actions = diffGuild(
      ctx(
        {
          guild: {
            description: "new desc",
            preferred_locale: "de-DE",
            verification_level: 2,
            default_message_notifications: 1,
            explicit_content_filter: 1,
            afk_timeout: 600,
            system_channel_flags: 1,
            premium_progress_bar_enabled: true,
          },
        },
        state(),
      ),
    );
    expect(actions).toHaveLength(1);
    const a = actions[0]!;
    expect(a.type).toBe("UPDATE");
    expect(a.payload).toEqual({
      description: "new desc",
      preferred_locale: "de-DE",
      verification_level: 2,
      default_message_notifications: 1,
      explicit_content_filter: 1,
      afk_timeout: 600,
      system_channel_flags: 1,
      premium_progress_bar_enabled: true,
    });
  });

  it("uploads banner when the live hash differs, and splash from invite_splash", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-diff-guild-assets-"));
    try {
      writeFileSync(join(dir, "banner.png"), Buffer.from([1, 2]));
      writeFileSync(join(dir, "splash.png"), Buffer.from([3, 4]));
      const actions = diffGuild(
        ctx(
          { guild: { banner: "banner.png" }, invite_splash: "splash.png" },
          state({ guild: { ...state().guild, banner: "c0ffee" } }),
          { baseDir: dir },
        ),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]!.payload).toEqual({
        banner: "__asset__:banner.png",
        splash: "__asset__:splash.png",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a data: URI icon whose bytes match the live hash, and handles unhashable data:", () => {
    const bytes = Buffer.from([9, 9, 9]);
    const b64 = bytes.toString("base64");
    const hash = createHash("sha1").update(bytes).digest("hex");
    const uri = `data:image/png;base64,${b64}`;

    // Matching live hash → no action.
    const match = diffGuild(
      ctx({ guild: { icon: uri } }, state({ guild: { ...state().guild, icon: hash } })),
    );
    expect(match).toHaveLength(0);

    // Drifted live hash → re-upload with the data: URI.
    const drift = diffGuild(
      ctx({ guild: { icon: uri } }, state({ guild: { ...state().guild, icon: "0000" } })),
    );
    expect(drift[0]!.payload).toEqual({ icon: `__asset__:${uri}` });

    // Unhashable data: value (no base64 body) → assume unknown, still upload.
    const noBody = diffGuild(ctx({ guild: { icon: "data:image/png" } }, state()));
    expect(noBody[0]!.payload).toEqual({ icon: "__asset__:data:image/png" });
  });

  it("emits nothing when the config matches live state", () => {
    const actions = diffGuild(
      ctx(
        {
          guild: {
            description: null,
            preferred_locale: "en-US",
            verification_level: 0,
            default_message_notifications: 0,
            explicit_content_filter: 0,
            afk_timeout: 300,
            system_channel_flags: 0,
            premium_progress_bar_enabled: false,
          },
        },
        state(),
      ),
    );
    expect(actions).toHaveLength(0);
  });
});

describe("diffRoles — guards and prune", () => {
  it("silently skips @everyone when the guild has no @everyone role", () => {
    const actions = diffRoles(
      ctx({ roles: [{ name: "@everyone", permissions: "1024" }] }, state({ roles: [botRole] })),
    );
    expect(actions.filter((a) => a.resource === "@everyone")).toHaveLength(0);
  });

  it("skips UPDATE when the existing role sits at/above the bot position", () => {
    const s = state({
      roles: [
        everyone,
        botRole,
        {
          id: "high",
          name: "High",
          color: 0,
          hoist: false,
          position: 10, // == maxBotPos
          permissions: "0",
          managed: false,
          mentionable: false,
        },
      ],
    });
    const actions = diffRoles(ctx({ roles: [{ name: "High", permissions: "1024" }] }, s));
    const high = actions.find((a) => a.resource === "High");
    expect(high?.type).toBe("SKIP");
    expect(high?.skipReason).toMatch(/at\/above bot position/);
  });

  it("flags hoist and mentionable drift as UPDATE", () => {
    const s = state({
      roles: [
        everyone,
        botRole,
        {
          id: "r1",
          name: "Member",
          color: 0,
          hoist: false,
          position: 1,
          permissions: "0",
          managed: false,
          mentionable: false,
        },
      ],
    });
    const actions = diffRoles(
      ctx({ roles: [{ name: "Member", hoist: true, mentionable: true }] }, s),
    );
    const update = actions.find((a) => a.type === "UPDATE" && a.resource === "Member");
    expect(update).toBeTruthy();
    expect(update!.payload).toMatchObject({ hoist: true, mentionable: true });
  });

  it("prunes extra non-managed roles highest-first and protects roles above the bot", () => {
    const s = state({
      roles: [
        everyone,
        botRole,
        {
          id: "low",
          name: "OldLow",
          color: 0,
          hoist: false,
          position: 1,
          permissions: "0",
          managed: false,
          mentionable: false,
        },
        {
          id: "mid",
          name: "OldMid",
          color: 0,
          hoist: false,
          position: 5,
          permissions: "0",
          managed: false,
          mentionable: false,
        },
        {
          id: "up",
          name: "OldUp",
          color: 0,
          hoist: false,
          position: 10, // == maxBotPos → cannot delete
          permissions: "0",
          managed: false,
          mentionable: false,
        },
      ],
    });
    const actions = diffRoles(ctx({}, s, { prune: true }));
    const deletes = actions.filter((a) => a.type === "DELETE" && a.domain === "role");
    expect(deletes.map((d) => d.resource)).toEqual(["OldMid", "OldLow"]); // highest first
    const skipped = actions.find((a) => a.type === "SKIP" && a.resource === "OldUp");
    expect(skipped?.skipReason).toMatch(/above bot position/);
    // Managed bot role is never pruned.
    expect(actions.some((a) => a.resource === "Discord Manager")).toBe(false);
  });
});

describe("diffChannelPositions — top level + category guards", () => {
  it("emits a batch reorder for top-level channels", () => {
    const s = state({
      channels: [
        { id: "a1", type: 0, name: "aaa", position: 1, parent_id: null, permission_overwrites: [] },
        { id: "b2", type: 0, name: "bbb", position: 0, parent_id: null, permission_overwrites: [] },
      ],
    });
    // Desired: aaa at 0, bbb at 1 → live order (bbb, aaa) must be rewritten.
    const actions = diffChannelPositions(
      ctx(
        {
          channels: [
            { name: "aaa", type: "text", position: 0 },
            { name: "bbb", type: "text", position: 1 },
          ],
        },
        s,
      ),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.resource).toBe("channel_positions:top level");
    expect(actions[0]!.payload).toEqual([
      { id: "a1", position: 0 },
      { id: "b2", position: 1 },
    ]);
  });

  it("is a no-op when a live category key has no matching state entry (orphan guard)", () => {
    // Config positions channels under a category that does not exist live:
    // the group resolves to an empty positioned list → no action.
    const s = state({
      channels: [
        {
          id: "a1",
          type: 0,
          name: "aaa",
          position: 0,
          parent_id: "ghost-cat",
          permission_overwrites: [],
        },
      ],
    });
    const actions = diffChannelPositions(
      ctx(
        {
          categories: [],
          channels: [{ name: "aaa", type: "text", category: "GhostCat", position: 0 }],
        },
        s,
      ),
    );
    expect(actions.filter((a) => a.domain === "channel_positions")).toHaveLength(0);
  });
});

describe("diffWebhooks — update and prune", () => {
  const withWebhooks = (hooks: GuildState["webhooks"], channels: GuildState["channels"]) =>
    state({ webhooks: hooks, channels });

  it("emits UPDATE when the webhook moved to another live channel", () => {
    const s = withWebhooks(
      [{ id: "w1", name: "Hook", channel_id: "general1" }],
      [
        {
          id: "general1",
          type: 0,
          name: "general",
          position: 0,
          parent_id: null,
          permission_overwrites: [],
        },
        {
          id: "alerts1",
          type: 0,
          name: "alerts",
          position: 1,
          parent_id: null,
          permission_overwrites: [],
        },
      ],
    );
    const plan = buildActionPlan({
      config: cfg({
        channels: [
          { name: "general", type: "text" },
          { name: "alerts", type: "text" },
        ],
        webhooks: [{ name: "Hook", channel: "alerts" }],
      }),
      state: s,
    });
    const update = plan.actions.find((a) => a.domain === "webhook" && a.type === "UPDATE");
    expect(update).toBeTruthy();
    expect(update!.payload).toMatchObject({ name: "Hook", channel_id: "alerts1" });
    expect(update!.dependencies).toContain("channel:alerts");
  });

  it("prunes webhooks whose (channel, name) key is absent from config", () => {
    const s = withWebhooks(
      [
        { id: "w1", name: "Keep", channel_id: "general1" },
        { id: "w2", name: "Drop", channel_id: "general1" },
      ],
      [
        {
          id: "general1",
          type: 0,
          name: "general",
          position: 0,
          parent_id: null,
          permission_overwrites: [],
        },
      ],
    );
    const plan = buildActionPlan({
      config: cfg({
        channels: [{ name: "general", type: "text" }],
        webhooks: [{ name: "Keep", channel: "general" }],
      }),
      state: s,
      prune: true,
    });
    const del = plan.actions.find((a) => a.domain === "webhook" && a.type === "DELETE");
    expect(del?.resource).toBe("Drop");
    expect(del?.targetId).toBe("w2");
  });
});

describe("diffAutoMod — drift dimensions", () => {
  const ruleState = (over: Partial<GuildState["autoModRules"][number]> = {}) =>
    state({
      roles: [
        everyone,
        botRole,
        {
          id: "mod1",
          name: "Moderator",
          color: 0,
          hoist: false,
          position: 1,
          permissions: "0",
          managed: false,
          mentionable: false,
        },
      ],
      autoModRules: [
        {
          id: "m1",
          name: "R",
          enabled: true,
          event_type: 1,
          trigger_type: 1,
          trigger_metadata: { keyword_filter: ["bad"] },
          actions: [{ type: 1 }],
          exempt_roles: [],
          exempt_channels: [],
          ...over,
        },
      ],
      channels: [
        {
          id: "general1",
          type: 0,
          name: "general",
          position: 0,
          parent_id: null,
          permission_overwrites: [],
        },
        {
          id: "alerts1",
          type: 0,
          name: "alerts",
          position: 1,
          parent_id: null,
          permission_overwrites: [],
        },
      ],
    });

  const baseRule = {
    name: "R",
    event_type: 1,
    trigger_type: 1,
    trigger_metadata: { keyword_filter: ["bad"] },
    actions: [{ type: 1 }],
  };

  it("flags event_type, trigger_type, and trigger_metadata drift", () => {
    for (const rule of [
      { ...baseRule, event_type: 2 },
      { ...baseRule, trigger_type: 3 },
      { ...baseRule, trigger_metadata: { keyword_filter: ["other"] } },
    ]) {
      const actions = diffAutoMod(ctx({ auto_mod: { rules: [rule] } }, ruleState()));
      expect(
        actions.some((a) => a.domain === "auto_mod_rule" && a.type === "UPDATE"),
        JSON.stringify(rule),
      ).toBe(true);
    }
  });

  it("flags action-type, action-channel, duration, and custom_message drift", () => {
    const drifts = [
      // action type differs
      { ...baseRule, actions: [{ type: 2 }] },
      // metadata channel points at a different live channel
      { ...baseRule, actions: [{ type: 1, metadata: { channel: "alerts" } }] },
      // metadata channel not resolvable live (created in this plan) → assume may differ
      { ...baseRule, actions: [{ type: 1, metadata: { channel: "brand-new" } }] },
      // duration drift
      { ...baseRule, actions: [{ type: 1, metadata: { duration_seconds: 60 } }] },
      // custom message drift
      { ...baseRule, actions: [{ type: 1, metadata: { custom_message: "hi" } }] },
      // action count drift
      { ...baseRule, actions: [{ type: 1 }, { type: 2 }] },
    ];
    for (const rule of drifts) {
      const actions = diffAutoMod(ctx({ auto_mod: { rules: [rule] } }, ruleState()));
      expect(
        actions.some((a) => a.domain === "auto_mod_rule" && a.type === "UPDATE"),
        JSON.stringify(rule),
      ).toBe(true);
    }
  });

  it("matches live action channel via channel_id and exempts via role/channel sets", () => {
    // Live action channel_id matches the config's channel reference → no drift.
    const matching = diffAutoMod(
      ctx(
        {
          auto_mod: {
            rules: [
              {
                ...baseRule,
                actions: [{ type: 1, metadata: { channel: "general" } }],
                exempt_roles: ["Moderator"],
                exempt_channels: ["alerts"],
              },
            ],
          },
        },
        ruleState({
          actions: [{ type: 1, metadata: { channel_id: "general1" } }],
          exempt_roles: ["mod1"],
          exempt_channels: ["alerts1"],
        }),
      ),
    );
    expect(matching.filter((a) => a.type === "UPDATE")).toHaveLength(0);

    // exempt set drift → UPDATE whose payload carries __resolve__ placeholders.
    const drifted = diffAutoMod(
      ctx(
        {
          auto_mod: {
            rules: [{ ...baseRule, exempt_roles: ["Moderator"], exempt_channels: ["general"] }],
          },
        },
        ruleState({ exempt_roles: ["mod1"], exempt_channels: ["alerts1"] }),
      ),
    );
    const update = drifted.find((a) => a.type === "UPDATE");
    expect(update).toBeTruthy();
    expect(update!.payload).toMatchObject({
      exempt_roles: ["__resolve_role__:Moderator"],
      exempt_channels: ["__resolve_channel__:general"],
    });
  });

  it("creates missing rules with placeholder-carrying payload", () => {
    const actions = diffAutoMod(
      ctx(
        {
          auto_mod: {
            rules: [
              {
                name: "S",
                event_type: 1,
                trigger_type: 1,
                actions: [{ type: 2, metadata: { channel: "general" } }],
                exempt_channels: ["general"],
              },
            ],
          },
        },
        ruleState(),
      ),
    );
    const create = actions.find((a) => a.type === "CREATE");
    expect(create).toBeTruthy();
    expect(create!.resource).toBe("S");
    expect(create!.payload).toMatchObject({
      actions: [{ type: 2, metadata: { channel_id: "__resolve_channel__:general" } }],
      exempt_channels: ["__resolve_channel__:general"],
    });
  });
});

describe("onboarding differ — prompt-level drift", () => {
  const withOnboarding = (over: Partial<NonNullable<GuildState["onboarding"]>> = {}) =>
    state({
      guild: { ...state().guild, features: ["COMMUNITY"] },
      roles: [
        everyone,
        botRole,
        {
          id: "mod1",
          name: "Moderator",
          color: 0,
          hoist: false,
          position: 1,
          permissions: "0",
          managed: false,
          mentionable: false,
        },
      ],
      onboarding: {
        enabled: true,
        mode: 0,
        default_channel_ids: ["general1"],
        prompts: [
          {
            type: 0,
            title: "T",
            single_select: true,
            required: false,
            in_onboarding: true,
            options: [
              {
                title: "O",
                description: "d",
                emoji_id: null,
                emoji_name: "👋",
                channel_ids: ["general1"],
                role_ids: [],
              },
            ],
          },
        ],
        ...over,
      },
    });

  const baseOnboarding = {
    enabled: true,
    mode: 0,
    default_channel_ids: ["general"],
    prompts: [
      {
        type: 0,
        title: "T",
        single_select: true,
        required: false,
        in_onboarding: true,
        options: [
          {
            title: "O",
            description: "d",
            emoji_name: "👋",
            channel_ids: ["general"],
            role_ids: [],
          },
        ],
      },
    ],
  };

  it("skips when the onboarding matches live state", () => {
    const s = withOnboarding();
    s.channels.push({
      id: "general1",
      type: 0,
      name: "general",
      position: 0,
      parent_id: null,
      permission_overwrites: [],
    });
    const actions = diffWelcomeAndOnboarding(ctx({ onboarding: baseOnboarding }, s));
    expect(actions.filter((a) => a.domain === "onboarding")).toHaveLength(0);
  });

  it("flags prompt-field, option-field, channel, and role drift", () => {
    const drifts = [
      { ...baseOnboarding, mode: 1 },
      {
        ...baseOnboarding,
        prompts: [{ ...baseOnboarding.prompts[0]!, title: "Other" }],
      },
      {
        ...baseOnboarding,
        prompts: [{ ...baseOnboarding.prompts[0]!, single_select: false }],
      },
      {
        ...baseOnboarding,
        prompts: [{ ...baseOnboarding.prompts[0]!, in_onboarding: false }],
      },
      {
        ...baseOnboarding,
        prompts: [
          {
            ...baseOnboarding.prompts[0]!,
            options: [{ ...baseOnboarding.prompts[0]!.options[0]!, description: "e" }],
          },
        ],
      },
      {
        ...baseOnboarding,
        prompts: [
          {
            ...baseOnboarding.prompts[0]!,
            options: [{ ...baseOnboarding.prompts[0]!.options[0]!, channel_ids: ["alerts"] }],
          },
        ],
      },
      {
        ...baseOnboarding,
        prompts: [
          {
            ...baseOnboarding.prompts[0]!,
            options: [{ ...baseOnboarding.prompts[0]!.options[0]!, role_ids: ["Moderator"] }],
          },
        ],
      },
      // Option count drift.
      {
        ...baseOnboarding,
        prompts: [
          {
            ...baseOnboarding.prompts[0]!,
            options: [
              baseOnboarding.prompts[0]!.options[0]!,
              { title: "O2", channel_ids: [], role_ids: [] },
            ],
          },
        ],
      },
    ];
    for (const ob of drifts) {
      const s = withOnboarding();
      s.channels.push({
        id: "alerts1",
        type: 0,
        name: "alerts",
        position: 1,
        parent_id: null,
        permission_overwrites: [],
      });
      const actions = diffWelcomeAndOnboarding(ctx({ onboarding: ob }, s));
      expect(
        actions.some((a) => a.domain === "onboarding" && a.type === "UPDATE"),
        JSON.stringify(ob),
      ).toBe(true);
    }
  });

  it("emits the onboarding UPDATE payload with resolved placeholders", () => {
    const s = withOnboarding({ prompts: [] });
    s.channels.push({
      id: "general1",
      type: 0,
      name: "general",
      position: 0,
      parent_id: null,
      permission_overwrites: [],
    });
    const actions = diffWelcomeAndOnboarding(
      ctx(
        {
          onboarding: {
            enabled: true,
            mode: 0,
            default_channel_ids: ["general"],
            prompts: [
              {
                type: 0,
                title: "T",
                single_select: true,
                required: false,
                in_onboarding: true,
                options: [{ title: "O", channel_ids: ["general"], role_ids: ["Moderator"] }],
              },
            ],
          },
        },
        s,
      ),
    );
    const update = actions.find((a) => a.domain === "onboarding" && a.type === "UPDATE");
    expect(update).toBeTruthy();
    const p = update!.payload as Record<string, unknown>;
    expect(p.default_channel_ids).toEqual(["__resolve_channel__:general"]);
    const prompts = p.prompts as Record<string, unknown>[];
    expect(prompts[0]!.options).toEqual([
      {
        title: "O",
        channel_ids: ["__resolve_channel__:general"],
        role_ids: ["__resolve_role__:Moderator"],
      },
    ]);
  });

  it("treats a live onboarding with a different prompt count as drifted", () => {
    const s = withOnboarding({ prompts: [] });
    s.channels.push({
      id: "general1",
      type: 0,
      name: "general",
      position: 0,
      parent_id: null,
      permission_overwrites: [],
    });
    const actions = diffWelcomeAndOnboarding(ctx({ onboarding: baseOnboarding }, s));
    expect(actions.some((a) => a.domain === "onboarding" && a.type === "UPDATE")).toBe(true);
  });
});

describe("welcome screen — channel-level drift", () => {
  const community = (over: Partial<GuildState> = {}) =>
    state({
      guild: { ...state().guild, features: ["COMMUNITY"] },
      channels: [
        {
          id: "general1",
          type: 0,
          name: "general",
          position: 0,
          parent_id: null,
          permission_overwrites: [],
        },
        {
          id: "about1",
          type: 0,
          name: "about",
          position: 1,
          parent_id: null,
          permission_overwrites: [],
        },
      ],
      ...over,
    });

  it("flags welcome channels referencing a channel created in this plan", () => {
    const actions = diffWelcomeAndOnboarding(
      ctx(
        {
          welcome_screen: {
            enabled: true,
            welcome_channels: [{ channel: "brand-new", description: "hi" }],
          },
        },
        community(),
      ),
    );
    expect(actions.some((a) => a.domain === "welcome_screen" && a.type === "UPDATE")).toBe(true);
  });

  it("flags description and channel drift against a matching live screen", () => {
    const drifted = (over: { description?: string; channel?: string } = {}) =>
      diffWelcomeAndOnboarding(
        ctx(
          {
            welcome_screen: {
              enabled: true,
              description: over.description ?? "hi",
              welcome_channels: [
                {
                  channel: over.channel ?? "general",
                  description: over.description ?? "hi",
                },
              ],
            },
          },
          community({
            welcomeScreen: {
              enabled: true,
              description: "hi",
              welcome_channels: [{ channel_id: "general1", description: "hi" }],
            },
          } as unknown as Partial<GuildState>),
        ),
      );

    // No drift.
    expect(drifted().filter((a) => a.domain === "welcome_screen")).toHaveLength(0);
    // Description drift.
    expect(
      drifted({ description: "bye" }).some(
        (a) => a.domain === "welcome_screen" && a.type === "UPDATE",
      ),
    ).toBe(true);
    // Channel drift (live points at a different channel).
    expect(
      drifted({ channel: "about" }).some(
        (a) => a.domain === "welcome_screen" && a.type === "UPDATE",
      ),
    ).toBe(true);
  });

  it("flags a welcome screen whose live channel list length differs", () => {
    const actions = diffWelcomeAndOnboarding(
      ctx(
        {
          welcome_screen: {
            enabled: true,
            welcome_channels: [
              { channel: "general", description: "hi" },
              { channel: "about", description: "yo" },
            ],
          },
        },
        community({
          welcomeScreen: {
            enabled: true,
            description: null,
            welcome_channels: [{ channel_id: "general1", description: "hi" }],
          },
        } as unknown as Partial<GuildState>),
      ),
    );
    expect(actions.some((a) => a.domain === "welcome_screen" && a.type === "UPDATE")).toBe(true);
  });
});
