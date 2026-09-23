import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/config/schema.js";
import { ServerConfigSchema } from "../../src/config/schema.js";
import { buildActionPlan, collectUrlAssets } from "../../src/reconcile/plan.js";
import type { GuildState } from "../../src/state/types.js";

function baseState(overrides: Partial<GuildState> = {}): GuildState {
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
      system_channel_id: "sys1",
      system_channel_flags: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      premium_progress_bar_enabled: false,
      premium_tier: 0,
      features: [],
    },
    roles: [
      {
        id: "guild1",
        name: "@everyone",
        color: 0,
        hoist: false,
        position: 0,
        permissions: "0",
        managed: false,
        mentionable: false,
      },
      {
        id: "botrole",
        name: "Discord Manager",
        color: 0,
        hoist: false,
        position: 10,
        permissions: "8",
        managed: true,
        mentionable: false,
      },
    ],
    channels: [
      {
        id: "sys1",
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

function cfg(raw: unknown): ServerConfig {
  return ServerConfigSchema.parse(raw);
}

describe("diff / plan", () => {
  it("plans role CREATE when missing", () => {
    const plan = buildActionPlan({
      config: cfg({
        roles: [{ name: "Member", permissions: "1024", position: 1 }],
      }),
      state: baseState(),
    });
    const create = plan.actions.find(
      (a) => a.type === "CREATE" && a.domain === "role" && a.resource === "Member",
    );
    expect(create).toBeTruthy();
    expect(create?.payload).toMatchObject({ name: "Member" });
  });

  it("plans role UPDATE when permissions differ", () => {
    const state = baseState({
      roles: [
        ...baseState().roles,
        {
          id: "r2",
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
    const plan = buildActionPlan({
      config: cfg({
        roles: [{ name: "Member", permissions: "1024" }],
      }),
      state,
    });
    expect(
      plan.actions.some(
        (a) => a.type === "UPDATE" && a.domain === "role" && a.resource === "Member",
      ),
    ).toBe(true);
  });

  it("skips managed role name conflicts", () => {
    const plan = buildActionPlan({
      config: cfg({
        roles: [{ name: "Discord Manager", permissions: "8" }],
      }),
      state: baseState(),
    });
    const skip = plan.actions.find((a) => a.type === "SKIP" && a.resource === "Discord Manager");
    expect(skip?.skipReason).toMatch(/managed/i);
  });

  it("creates roles even when desired position is above bot, and skips position placement", () => {
    const plan = buildActionPlan({
      config: cfg({
        roles: [{ name: "AboveBot", permissions: "8", position: 50 }],
      }),
      state: baseState(),
    });
    const create = plan.actions.find((a) => a.type === "CREATE" && a.resource === "AboveBot");
    expect(create).toBeDefined();
    const posSkip = plan.actions.find(
      (a) =>
        a.type === "SKIP" &&
        a.resource === "AboveBot" &&
        a.skipReason?.includes("at/above bot highest"),
    );
    expect(posSkip).toBeDefined();
    expect(plan.actions.some((a) => a.domain === "role_positions")).toBe(false);
  });

  it("plans category and channel creates with dependencies", () => {
    const plan = buildActionPlan({
      config: cfg({
        categories: [{ name: "Info" }],
        channels: [{ name: "welcome", category: "Info", type: "text" }],
      }),
      state: baseState(),
    });
    expect(plan.actions.some((a) => a.domain === "category" && a.type === "CREATE")).toBe(true);
    const ch = plan.actions.find((a) => a.domain === "channel" && a.type === "CREATE");
    expect(ch?.dependencies).toContain("category:Info");
  });

  it("treats channel parent change as UPDATE", () => {
    const state = baseState({
      channels: [
        {
          id: "cat1",
          type: 4,
          name: "A",
          position: 0,
          parent_id: null,
          permission_overwrites: [],
        },
        {
          id: "cat2",
          type: 4,
          name: "B",
          position: 1,
          parent_id: null,
          permission_overwrites: [],
        },
        {
          id: "ch1",
          type: 0,
          name: "general",
          position: 0,
          parent_id: "cat1",
          permission_overwrites: [],
          topic: null,
        },
        {
          id: "sys1",
          type: 0,
          name: "system",
          position: 2,
          parent_id: null,
          permission_overwrites: [],
        },
      ],
    });
    const plan = buildActionPlan({
      config: cfg({
        categories: [{ name: "A" }, { name: "B" }],
        channels: [{ name: "general", category: "B", type: "text" }],
      }),
      state,
    });
    const update = plan.actions.find(
      (a) => a.type === "UPDATE" && a.domain === "channel" && a.resource === "general",
    );
    expect(update).toBeTruthy();
  });

  it("skips vanity when boost tier insufficient", () => {
    const plan = buildActionPlan({
      config: cfg({ vanity_url_code: "cool" }),
      state: baseState(),
    });
    expect(plan.actions.some((a) => a.type === "SKIP" && a.domain === "vanity_url")).toBe(true);
  });

  it("skips welcome screen without COMMUNITY", () => {
    const plan = buildActionPlan({
      config: cfg({
        channels: [{ name: "hi", type: "text" }],
        welcome_screen: {
          enabled: true,
          welcome_channels: [{ channel: "hi", description: "x" }],
        },
      }),
      state: baseState(),
    });
    expect(plan.actions.some((a) => a.type === "SKIP" && a.skipReason?.includes("Community"))).toBe(
      true,
    );
  });

  it("clears system channel before deleting it when pruning", () => {
    const state = baseState();
    const plan = buildActionPlan({
      config: cfg({
        channels: [{ name: "other", type: "text" }],
      }),
      state,
      prune: true,
    });
    const guildClear = plan.actions.find(
      (a) =>
        a.domain === "guild" &&
        a.type === "UPDATE" &&
        a.payload &&
        typeof a.payload === "object" &&
        "system_channel_id" in (a.payload as object),
    );
    expect(guildClear).toBeTruthy();
    expect(plan.actions.some((a) => a.type === "DELETE" && a.resource === "general")).toBe(true);
  });

  it("is idempotent when state matches config", () => {
    const state = baseState({
      roles: [
        ...baseState().roles,
        {
          id: "r2",
          name: "Member",
          color: 0x57f287,
          hoist: false,
          position: 1,
          permissions: "1024",
          managed: false,
          mentionable: false,
        },
      ],
      channels: [
        {
          id: "cat1",
          type: 4,
          name: "Community",
          position: 0,
          parent_id: null,
          permission_overwrites: [],
        },
        {
          id: "ch1",
          type: 0,
          name: "general",
          position: 0,
          parent_id: "cat1",
          permission_overwrites: [],
          topic: "hi",
          nsfw: false,
          rate_limit_per_user: 0,
        },
      ],
      guild: {
        ...baseState().guild,
        system_channel_id: "ch1",
      },
    });
    const plan = buildActionPlan({
      config: cfg({
        roles: [
          {
            name: "Member",
            color: 0x57f287,
            permissions: "1024",
            hoist: false,
            mentionable: false,
          },
        ],
        categories: [{ name: "Community" }],
        channels: [
          {
            name: "general",
            category: "Community",
            type: "text",
            topic: "hi",
            nsfw: false,
            slowmode: 0,
          },
        ],
      }),
      state,
      prune: false,
    });
    const mutating = plan.actions.filter((a) => a.type !== "SKIP");
    // No positions configured → no role_positions/channel_positions batches; no diffs.
    expect(mutating.length).toBe(0);
  });
});

describe("P0 idempotency regressions", () => {
  const everyone = (over: Partial<GuildState["roles"][number]> = {}) => ({
    id: "guild1",
    name: "@everyone",
    color: 0,
    hoist: false,
    position: 0,
    permissions: "0",
    managed: false,
    mentionable: false,
    ...over,
  });
  const botRole = {
    id: "botrole",
    name: "Discord Manager",
    color: 0,
    hoist: false,
    position: 10,
    permissions: "8",
    managed: true,
    mentionable: false,
  };
  const role = (over: Partial<GuildState["roles"][number]>) => ({
    id: "r0",
    name: "Role",
    color: 0,
    hoist: false,
    position: 1,
    permissions: "0",
    managed: false,
    mentionable: false,
    ...over,
  });
  const channel = (over: Partial<GuildState["channels"][number]>) => ({
    id: "ch0",
    type: 0,
    name: "general",
    position: 0,
    parent_id: null,
    permission_overwrites: [],
    ...over,
  });

  describe("overwrites (Discord PATCH merge semantics)", () => {
    it("does not flag live overwrites on roles the config does not define", () => {
      const state = baseState({
        roles: [
          everyone(),
          botRole,
          role({ id: "member1", name: "Member", permissions: "1024" }),
          // integration-style role: present in live, absent from config
          role({ id: "fido", name: "Fido Bot" }),
        ],
        channels: [
          channel({
            id: "ch1",
            permission_overwrites: [
              { id: "member1", type: 0, allow: "1024", deny: "0" },
              { id: "fido", type: 0, allow: "1024", deny: "0" },
            ],
          }),
        ],
      });
      const plan = buildActionPlan({
        config: cfg({
          roles: [{ name: "Member", permissions: "1024" }],
          channels: [
            {
              name: "general",
              type: "text",
              permission_overwrites: [{ role: "Member", allow: ["VIEW_CHANNEL"], deny: [] }],
            },
          ],
        }),
        state,
      });
      expect(plan.actions.some((a) => a.domain === "channel" && a.type === "UPDATE")).toBe(false);
    });

    it("emits a zeroed overwrite to delete a removed config-defined role overwrite", () => {
      const state = baseState({
        roles: [everyone(), botRole, role({ id: "member1", name: "Member", permissions: "1024" })],
        channels: [
          channel({
            id: "ch1",
            permission_overwrites: [{ id: "member1", type: 0, allow: "1024", deny: "0" }],
          }),
        ],
      });
      // Config keeps the Member role but drops its overwrite from this channel.
      const plan = buildActionPlan({
        config: cfg({
          roles: [{ name: "Member", permissions: "1024" }],
          channels: [
            {
              name: "general",
              type: "text",
              permission_overwrites: [{ role: "@everyone", allow: ["VIEW_CHANNEL"], deny: [] }],
            },
          ],
        }),
        state,
      });
      const update = plan.actions.find((a) => a.domain === "channel" && a.type === "UPDATE");
      expect(update).toBeTruthy();
      const overwrites = (update!.payload as { permission_overwrites: unknown[] })
        .permission_overwrites as { id: string; allow: string; deny: string }[];
      expect(overwrites.some((o) => o.id === "member1" && o.allow === "0" && o.deny === "0")).toBe(
        true,
      );
    });

    it("flags a desired overwrite missing from live", () => {
      const state = baseState({
        roles: [everyone(), botRole, role({ id: "member1", name: "Member" })],
        channels: [channel({ id: "ch1" })],
      });
      const plan = buildActionPlan({
        config: cfg({
          channels: [
            {
              name: "general",
              type: "text",
              permission_overwrites: [{ role: "Member", allow: ["VIEW_CHANNEL"], deny: [] }],
            },
          ],
        }),
        state,
      });
      expect(plan.actions.some((a) => a.domain === "channel" && a.type === "UPDATE")).toBe(true);
    });
  });

  describe("@everyone role", () => {
    it("ignores color/hoist/mentionable drift (payload cannot set them)", () => {
      const state = baseState({
        roles: [
          everyone({ color: 0xff0000, hoist: true, mentionable: true, permissions: "0" }),
          botRole,
        ],
      });
      const plan = buildActionPlan({
        config: cfg({ roles: [{ name: "@everyone", permissions: "0" }] }),
        state,
      });
      expect(plan.actions.some((a) => a.domain === "role" && a.type !== "SKIP")).toBe(false);
    });

    it("still updates when permissions differ", () => {
      const state = baseState({
        roles: [everyone({ permissions: "0" }), botRole],
      });
      const plan = buildActionPlan({
        config: cfg({ roles: [{ name: "@everyone", permissions: ["VIEW_CHANNEL"] }] }),
        state,
      });
      const update = plan.actions.find(
        (a) => a.domain === "role" && a.type === "UPDATE" && a.resource === "@everyone",
      );
      expect(update).toBeTruthy();
      expect(update!.payload).toEqual({ permissions: "1024" });
    });
  });

  describe("channel prune", () => {
    it("prunes a same-name channel under an unmanaged category", () => {
      const state = baseState({
        channels: [
          channel({ id: "catA", type: 4, name: "Kept" }),
          channel({ id: "catB", type: 4, name: "Unmanaged" }),
          channel({ id: "chKept", name: "general", parent_id: "catA" }),
          channel({ id: "chUnmanaged", name: "general", parent_id: "catB" }),
        ],
      });
      const plan = buildActionPlan({
        config: cfg({
          categories: [{ name: "Kept" }],
          channels: [{ name: "general", category: "Kept", type: "text" }],
        }),
        state,
        prune: true,
      });
      const deletes = plan.actions.filter((a) => a.domain === "channel" && a.type === "DELETE");
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.targetId).toBe("chUnmanaged");
    });
  });

  describe("auto-mod rules", () => {
    const liveRule = (over: Partial<GuildState["autoModRules"][number]> = {}) => ({
      id: "am1",
      name: "No Links",
      enabled: true,
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { key_word_list: ["discord.gg"] },
      actions: [{ type: 1, metadata: { custom_message: "No links!" } }],
      exempt_roles: ["member1"],
      exempt_channels: [],
      ...over,
    });
    const ruleConfig = {
      name: "No Links",
      enabled: true,
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { key_word_list: ["discord.gg"] },
      actions: [{ type: 1, metadata: { custom_message: "No links!" } }],
      exempt_roles: ["Member"],
      exempt_channels: [],
    };
    const stateWith = (rule: GuildState["autoModRules"][number]) =>
      baseState({
        roles: [everyone(), botRole, role({ id: "member1", name: "Member" })],
        autoModRules: [rule],
      });

    it("skips UPDATE when the rule matches live state", () => {
      const plan = buildActionPlan({
        config: cfg({ auto_mod: { rules: [ruleConfig] } }),
        state: stateWith(liveRule()),
      });
      expect(plan.actions.filter((a) => a.domain === "auto_mod_rule")).toHaveLength(0);
    });

    it.each([
      ["trigger_metadata", { trigger_metadata: { key_word_list: ["invite.gg"] } }],
      ["actions", { actions: [{ type: 1, metadata: { custom_message: "changed" } }] }],
      ["enabled", { enabled: false }],
      ["exempt_roles", { exempt_roles: [] }],
    ] as [string, Partial<GuildState["autoModRules"][number]>][])(
      "flags UPDATE when %s differs",
      (_label, over) => {
        const plan = buildActionPlan({
          config: cfg({ auto_mod: { rules: [ruleConfig] } }),
          state: stateWith(liveRule(over)),
        });
        expect(plan.actions.some((a) => a.domain === "auto_mod_rule" && a.type === "UPDATE")).toBe(
          true,
        );
      },
    );
  });

  describe("welcome screen / onboarding", () => {
    const communityState = (over: Partial<GuildState> = {}): GuildState =>
      baseState({
        guild: { ...baseState().guild, features: ["COMMUNITY"] },
        channels: [channel({ id: "ch1", name: "rules" })],
        ...over,
      });
    const welcomeConfig = {
      welcome_screen: {
        enabled: true,
        description: "Welcome to Acme",
        welcome_channels: [{ channel: "rules", description: "Start here" }],
      },
    };

    it("skips UPDATE when welcome screen matches", () => {
      const plan = buildActionPlan({
        config: cfg(welcomeConfig),
        state: communityState({
          welcomeScreen: {
            description: "Welcome to Acme",
            welcome_channels: [
              { channel_id: "ch1", description: "Start here", emoji_id: null, emoji_name: null },
            ],
          },
        }),
      });
      expect(plan.actions.filter((a) => a.domain === "welcome_screen")).toHaveLength(0);
    });

    it("flags UPDATE when description or channels differ", () => {
      const drifted = communityState({
        welcomeScreen: {
          description: "old",
          welcome_channels: [
            { channel_id: "ch1", description: "Start here", emoji_id: null, emoji_name: null },
          ],
        },
      });
      const plan = buildActionPlan({ config: cfg(welcomeConfig), state: drifted });
      expect(plan.actions.some((a) => a.domain === "welcome_screen" && a.type === "UPDATE")).toBe(
        true,
      );
    });

    it("emits UPDATE when config has a welcome screen but live has none", () => {
      const plan = buildActionPlan({
        config: cfg(welcomeConfig),
        state: communityState({ welcomeScreen: null }),
      });
      expect(plan.actions.some((a) => a.domain === "welcome_screen" && a.type === "UPDATE")).toBe(
        true,
      );
    });

    it("skips onboarding when it matches live", () => {
      const state = communityState();
      const livePrompt = {
        type: 1,
        title: "What do you want to do?",
        single_select: false,
        required: false,
        in_onboarding: true,
        options: [
          {
            title: "Chat",
            description: null,
            emoji_id: null,
            emoji_name: null,
            channel_ids: ["ch1"],
            role_ids: [],
          },
        ],
      };
      state.onboarding = {
        enabled: true,
        mode: 0,
        default_channel_ids: ["ch1"],
        prompts: [livePrompt],
      };
      const plan = buildActionPlan({
        config: cfg({
          onboarding: {
            enabled: true,
            mode: 0,
            default_channel_ids: ["rules"],
            prompts: [
              {
                type: 1,
                title: "What do you want to do?",
                options: [{ title: "Chat", channel_ids: ["rules"], role_ids: [] }],
              },
            ],
          },
        }),
        state,
      });
      expect(plan.actions.filter((a) => a.domain === "onboarding")).toHaveLength(0);
    });
  });

  describe("guild assets", () => {
    it("skips icon upload when the live hash matches the local file", () => {
      const dir = mkdtempSync(join(tmpdir(), "dm-diff-icon-"));
      try {
        const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
        writeFileSync(join(dir, "icon.png"), iconBytes);
        const hash = createHash("sha1").update(iconBytes).digest("hex");

        const matching = buildActionPlan({
          config: cfg({ guild: { icon: "icon.png" } }),
          state: baseState({ guild: { ...baseState().guild, icon: hash } }),
          baseDir: dir,
        });
        expect(matching.actions.filter((a) => a.domain === "guild")).toHaveLength(0);

        const drifted = buildActionPlan({
          config: cfg({ guild: { icon: "icon.png" } }),
          state: baseState({ guild: { ...baseState().guild, icon: "deadbeef" } }),
          baseDir: dir,
        });
        const update = drifted.actions.find((a) => a.domain === "guild" && a.type === "UPDATE");
        expect(update).toBeTruthy();
        expect((update!.payload as Record<string, unknown>).icon).toBe("__asset__:icon.png");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("guild channel references", () => {
    const stateWith = (systemId: string | null, rulesId: string | null) =>
      baseState({
        channels: [
          channel({ id: "ch_logs", name: "logs" }),
          channel({ id: "ch_rules", name: "rules" }),
          channel({ id: "ch_old", name: "oldrules" }),
        ],
        guild: {
          ...baseState().guild,
          system_channel_id: systemId,
          rules_channel_id: rulesId,
        },
      });

    it("updates drifted references with name resolution", () => {
      const plan = buildActionPlan({
        config: cfg({ guild: { system_channel: "logs", rules_channel: "oldrules" } }),
        state: stateWith("ch_logs", "ch_rules"),
      });
      const update = plan.actions.find(
        (a) =>
          a.domain === "guild" &&
          a.type === "UPDATE" &&
          "rules_channel_id" in ((a.payload as object) ?? {}),
      );
      expect(update).toBeTruthy();
      expect((update!.payload as Record<string, unknown>).rules_channel_id).toBe(
        "__resolve_channel__:oldrules",
      );
      expect(update!.dependencies).toContain("channel:oldrules");
    });

    it("is a no-op when references already match", () => {
      const plan = buildActionPlan({
        config: cfg({ guild: { system_channel: "logs", rules_channel: "oldrules" } }),
        state: stateWith("ch_logs", "ch_old"),
      });
      expect(plan.actions.filter((a) => a.domain === "guild")).toHaveLength(0);
    });

    it("clears a reference set to null in config", () => {
      const plan = buildActionPlan({
        config: cfg({ guild: { rules_channel: null } }),
        state: stateWith("ch_logs", "ch_rules"),
      });
      const update = plan.actions.find((a) => a.domain === "guild" && a.type === "UPDATE");
      expect(update).toBeTruthy();
      expect((update!.payload as Record<string, unknown>).rules_channel_id).toBe(null);
    });
  });

  describe("channel positions (batch reorder)", () => {
    const orderedState = (aPos: number, bPos: number) =>
      baseState({
        channels: [
          channel({ id: "cat1", type: 4, name: "Info", position: 0 }),
          channel({ id: "ch_a", name: "a", parent_id: "cat1", position: aPos }),
          channel({ id: "ch_b", name: "b", parent_id: "cat1", position: bPos }),
        ],
      });

    it("emits a batch reorder when order differs from config positions", () => {
      // live: b(0) before a(1); config wants a(0) before b(1)
      const plan = buildActionPlan({
        config: cfg({
          categories: [{ name: "Info" }],
          channels: [
            { name: "a", category: "Info", type: "text", position: 0 },
            { name: "b", category: "Info", type: "text", position: 1 },
          ],
        }),
        state: orderedState(1, 0),
      });
      const batch = plan.actions.find((a) => a.domain === "channel_positions");
      expect(batch).toBeTruthy();
      expect(batch!.endpoint).toBe("/guilds/guild1/channels");
      expect(batch!.method).toBe("PATCH");
      expect(batch!.payload).toEqual([
        { id: "ch_a", position: 0 },
        { id: "ch_b", position: 1 },
      ]);
    });

    it("is a no-op when live order already matches", () => {
      const plan = buildActionPlan({
        config: cfg({
          categories: [{ name: "Info" }],
          channels: [
            { name: "a", category: "Info", type: "text", position: 0 },
            { name: "b", category: "Info", type: "text", position: 1 },
          ],
        }),
        state: orderedState(0, 1),
      });
      expect(plan.actions.filter((a) => a.domain === "channel_positions")).toHaveLength(0);
    });

    it("keeps unmanaged channels in the batch so Discord cannot renumber them", () => {
      const state = baseState({
        channels: [
          channel({ id: "cat1", type: 4, name: "Info", position: 0 }),
          channel({ id: "ch_a", name: "a", parent_id: "cat1", position: 1 }),
          channel({ id: "ch_b", name: "b", parent_id: "cat1", position: 0 }),
          channel({ id: "ch_x", name: "x", parent_id: "cat1", position: 2 }), // unmanaged
        ],
      });
      const plan = buildActionPlan({
        config: cfg({
          categories: [{ name: "Info" }],
          channels: [
            { name: "a", category: "Info", type: "text", position: 0 },
            { name: "b", category: "Info", type: "text", position: 1 },
          ],
        }),
        state,
      });
      const batch = plan.actions.find((a) => a.domain === "channel_positions");
      expect(batch!.payload).toEqual([
        { id: "ch_a", position: 0 },
        { id: "ch_b", position: 1 },
        { id: "ch_x", position: 2 },
      ]);
    });
  });

  describe("role positions", () => {
    it("omits the batch when live positions already match", () => {
      const plan = buildActionPlan({
        config: cfg({ roles: [{ name: "Member", permissions: "1024", position: 1 }] }),
        state: baseState({
          roles: [
            everyone(),
            botRole,
            role({ id: "r2", name: "Member", position: 1, permissions: "1024" }),
          ],
        }),
      });
      expect(plan.actions.filter((a) => a.domain === "role_positions")).toHaveLength(0);
    });

    it("emits the batch when live positions differ", () => {
      const plan = buildActionPlan({
        config: cfg({ roles: [{ name: "Member", permissions: "1024", position: 2 }] }),
        state: baseState({
          roles: [
            everyone(),
            botRole,
            role({ id: "r2", name: "Member", position: 1, permissions: "1024" }),
          ],
        }),
      });
      expect(plan.actions.some((a) => a.domain === "role_positions" && a.type === "UPDATE")).toBe(
        true,
      );
    });
  });
});

describe("P0 asset-diff regressions (role icon / emoji image / webhook avatar)", () => {
  const everyone = {
    id: "guild1",
    name: "@everyone",
    color: 0,
    hoist: false,
    position: 0,
    permissions: "0",
    managed: false,
    mentionable: false,
  };
  const botRole = {
    id: "botrole",
    name: "Discord Manager",
    color: 0,
    hoist: false,
    position: 10,
    permissions: "8",
    managed: true,
    mentionable: false,
  };
  const member = (over: Partial<GuildState["roles"][number]> = {}) => ({
    id: "r2",
    name: "Member",
    color: 0,
    hoist: false,
    position: 1,
    permissions: "0",
    managed: false,
    mentionable: false,
    unicode_emoji: null,
    icon: null,
    ...over,
  });
  const rolesWith = (...roles: GuildState["roles"][number][]) =>
    baseState({ roles: [everyone, botRole, ...roles] });
  const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");
  const withAsset = (file: string, bytes: Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), "dm-diff-asset-"));
    writeFileSync(join(dir, file), bytes);
    return { dir, hash: sha1(bytes) };
  };

  describe("role unicode_emoji / icon", () => {
    it("is a no-op when unicode_emoji matches live", () => {
      const plan = buildActionPlan({
        config: cfg({ roles: [{ name: "Member", unicode_emoji: "🦊" }] }),
        state: rolesWith(member({ unicode_emoji: "🦊" })),
      });
      expect(plan.actions.filter((a) => a.domain === "role")).toHaveLength(0);
    });

    it("flags UPDATE when unicode_emoji differs", () => {
      const plan = buildActionPlan({
        config: cfg({ roles: [{ name: "Member", unicode_emoji: "🦊" }] }),
        state: rolesWith(member({ unicode_emoji: null })),
      });
      const update = plan.actions.find(
        (a) => a.domain === "role" && a.type === "UPDATE" && a.resource === "Member",
      );
      expect(update).toBeTruthy();
      expect((update!.payload as Record<string, unknown>).unicode_emoji).toBe("🦊");
    });

    it("clears unicode_emoji when config sets null", () => {
      const plan = buildActionPlan({
        config: cfg({ roles: [{ name: "Member", unicode_emoji: null }] }),
        state: rolesWith(member({ unicode_emoji: "🦊" })),
      });
      const update = plan.actions.find(
        (a) => a.domain === "role" && a.type === "UPDATE" && a.resource === "Member",
      );
      expect(update).toBeTruthy();
      expect((update!.payload as Record<string, unknown>).unicode_emoji).toBeNull();
    });

    it("skips icon upload when the live hash matches the local file", () => {
      const { dir, hash } = withAsset("role-icon.png", Buffer.from([1, 2, 3, 4, 5]));
      try {
        const plan = buildActionPlan({
          config: cfg({ roles: [{ name: "Member", icon: "role-icon.png" }] }),
          state: rolesWith(member({ icon: hash })),
          baseDir: dir,
        });
        expect(plan.actions.filter((a) => a.domain === "role")).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits an icon upload when the live hash differs or is missing", () => {
      const { dir } = withAsset("role-icon.png", Buffer.from([9, 9, 9]));
      try {
        for (const live of ["deadbeef", null]) {
          const plan = buildActionPlan({
            config: cfg({ roles: [{ name: "Member", icon: "role-icon.png" }] }),
            state: rolesWith(member({ icon: live })),
            baseDir: dir,
          });
          const update = plan.actions.find(
            (a) => a.domain === "role" && a.type === "UPDATE" && a.resource === "Member",
          );
          expect(update).toBeTruthy();
          expect((update!.payload as Record<string, unknown>).icon).toBe("__asset__:role-icon.png");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("assumes URL-valued icons unchanged (no perpetual diff, no crash)", () => {
      const plan = buildActionPlan({
        config: cfg({
          roles: [{ name: "Member", icon: "https://example.com/icon.png" }],
        }),
        state: rolesWith(member({ icon: "deadbeef" })),
      });
      expect(plan.actions.filter((a) => a.domain === "role")).toHaveLength(0);
    });
  });

  describe("emoji image diff", () => {
    const emojiState = (over: Partial<NonNullable<GuildState["emojis"][number]>> = {}) =>
      baseState({
        roles: [everyone, botRole, member()],
        emojis: [
          {
            id: "em1",
            name: "pepe",
            roles: [],
            animated: false,
            imageHash: "0".repeat(40),
            ...over,
          },
        ],
      });

    it("is a no-op when roles and image hash match", () => {
      const { dir, hash } = withAsset("pepe.png", Buffer.from([7, 7, 7]));
      try {
        const plan = buildActionPlan({
          config: cfg({ emojis: [{ name: "pepe", image: "pepe.png" }] }),
          state: emojiState({ imageHash: hash }),
          baseDir: dir,
        });
        expect(plan.actions.filter((a) => a.domain === "emoji")).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("re-uploads when the image hash differs", () => {
      const { dir } = withAsset("pepe.png", Buffer.from([7, 7, 7]));
      try {
        const plan = buildActionPlan({
          config: cfg({ emojis: [{ name: "pepe", image: "pepe.png" }] }),
          state: emojiState({ imageHash: "d".repeat(40) }),
          baseDir: dir,
        });
        const update = plan.actions.find(
          (a) => a.domain === "emoji" && a.type === "UPDATE" && a.resource === "pepe",
        );
        expect(update).toBeTruthy();
        const payload = update!.payload as Record<string, unknown>;
        expect(payload.image).toBe("__asset__:pepe.png");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not re-upload the image when only roles differ", () => {
      const { dir, hash } = withAsset("pepe.png", Buffer.from([7, 7, 7]));
      try {
        const plan = buildActionPlan({
          config: cfg({ emojis: [{ name: "pepe", image: "pepe.png", roles: ["Member"] }] }),
          state: emojiState({ imageHash: hash, roles: [] }),
          baseDir: dir,
        });
        const update = plan.actions.find(
          (a) => a.domain === "emoji" && a.type === "UPDATE" && a.resource === "pepe",
        );
        expect(update).toBeTruthy();
        const payload = update!.payload as Record<string, unknown>;
        expect(payload.roles).toEqual(["__resolve_role__:Member"]);
        expect("image" in payload).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("assumes image unchanged when the live hash is unknown", () => {
      const { dir } = withAsset("pepe.png", Buffer.from([7, 7, 7]));
      try {
        const plan = buildActionPlan({
          config: cfg({ emojis: [{ name: "pepe", image: "pepe.png" }] }),
          state: emojiState({ imageHash: null }),
          baseDir: dir,
        });
        expect(plan.actions.filter((a) => a.domain === "emoji")).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("assumes image unchanged for URL-valued config images", () => {
      const plan = buildActionPlan({
        config: cfg({
          emojis: [{ name: "pepe", image: "https://cdn.example/p.png" }],
        }),
        state: emojiState({ imageHash: "d".repeat(40) }),
      });
      expect(plan.actions.filter((a) => a.domain === "emoji")).toHaveLength(0);
    });
  });

  describe("webhook avatar diff", () => {
    const whState = (avatar: string | null) =>
      baseState({
        channels: [
          {
            id: "sys1",
            type: 0,
            name: "general",
            position: 0,
            parent_id: null,
            permission_overwrites: [],
          },
        ],
        webhooks: [{ id: "wh1", name: "alerts", channel_id: "sys1", avatar }],
      });

    it("is a no-op when name, channel, and avatar hash match", () => {
      const { dir, hash } = withAsset("avatar.png", Buffer.from([5, 5, 5]));
      try {
        const plan = buildActionPlan({
          config: cfg({
            webhooks: [{ name: "alerts", channel: "general", avatar: "avatar.png" }],
          }),
          state: whState(hash),
          baseDir: dir,
        });
        expect(plan.actions.filter((a) => a.domain === "webhook")).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits an avatar upload when the live hash differs", () => {
      const { dir } = withAsset("avatar.png", Buffer.from([5, 5, 5]));
      try {
        const plan = buildActionPlan({
          config: cfg({
            webhooks: [{ name: "alerts", channel: "general", avatar: "avatar.png" }],
          }),
          state: whState("d".repeat(40)),
          baseDir: dir,
        });
        const update = plan.actions.find(
          (a) => a.domain === "webhook" && a.type === "UPDATE" && a.resource === "alerts",
        );
        expect(update).toBeTruthy();
        expect((update!.payload as Record<string, unknown>).avatar).toBe("__asset__:avatar.png");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits an avatar upload when live has no avatar", () => {
      const { dir } = withAsset("avatar.png", Buffer.from([5, 5, 5]));
      try {
        const plan = buildActionPlan({
          config: cfg({
            webhooks: [{ name: "alerts", channel: "general", avatar: "avatar.png" }],
          }),
          state: whState(null),
          baseDir: dir,
        });
        const update = plan.actions.find(
          (a) => a.domain === "webhook" && a.type === "UPDATE" && a.resource === "alerts",
        );
        expect(update).toBeTruthy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not manage the avatar when config omits it", () => {
      const plan = buildActionPlan({
        config: cfg({ webhooks: [{ name: "alerts", channel: "general" }] }),
        state: whState("d".repeat(40)),
      });
      expect(plan.actions.filter((a) => a.domain === "webhook")).toHaveLength(0);
    });

    it("assumes URL-valued avatars unchanged", () => {
      const plan = buildActionPlan({
        config: cfg({
          webhooks: [{ name: "alerts", channel: "general", avatar: "https://example.com/a.png" }],
        }),
        state: whState("d".repeat(40)),
      });
      expect(plan.actions.filter((a) => a.domain === "webhook")).toHaveLength(0);
    });
  });

  describe("sticker diff", () => {
    const stickerState = (stickers: NonNullable<GuildState["stickers"]>) => baseState({ stickers });
    const live = (over: Partial<NonNullable<GuildState["stickers"]>[number]> = {}) => ({
      id: "st1",
      name: "wave",
      description: "old desc",
      tags: "hello",
      type: 2,
      format_type: 1,
      ...over,
    });

    it("plans CREATE for a missing sticker with an __asset__ image payload", () => {
      const plan = buildActionPlan({
        config: cfg({
          stickers: [{ name: "hype", description: "Fresh", tags: "fun", image: "hype.png" }],
        }),
        state: stickerState([]),
      });
      const create = plan.actions.find(
        (a) => a.type === "CREATE" && a.domain === "sticker" && a.resource === "hype",
      );
      expect(create).toBeTruthy();
      expect(create!.endpoint).toBe("/guilds/guild1/stickers");
      expect(create!.payload).toMatchObject({
        name: "hype",
        description: "Fresh",
        tags: "fun",
        image: "__asset__:hype.png",
      });
    });

    it("is a no-op when name, description, tags, and image hash all match", () => {
      const { dir, hash } = withAsset("wave.png", Buffer.from([1, 1, 1]));
      try {
        const plan = buildActionPlan({
          config: cfg({
            stickers: [{ name: "wave", description: "old desc", tags: "hello", image: "wave.png" }],
          }),
          state: stickerState([live({ imageHash: hash })]),
          baseDir: dir,
        });
        expect(plan.actions.filter((a) => a.domain === "sticker")).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits UPDATE only for the drifted text fields (image is not PATCHable)", () => {
      const { dir, hash } = withAsset("wave.png", Buffer.from([1, 1, 1]));
      try {
        const plan = buildActionPlan({
          config: cfg({
            stickers: [{ name: "wave", description: "new desc", tags: "hey", image: "wave.png" }],
          }),
          state: stickerState([live({ imageHash: hash })]),
          baseDir: dir,
        });
        const update = plan.actions.find(
          (a) => a.type === "UPDATE" && a.domain === "sticker" && a.resource === "wave",
        );
        expect(update).toBeTruthy();
        expect(update!.method).toBe("PATCH");
        expect(update!.endpoint).toBe("/guilds/guild1/stickers/st1");
        expect(update!.payload).toEqual({ description: "new desc", tags: "hey" });
        expect(plan.actions.filter((a) => a.domain === "sticker")).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits an advisory SKIP when the image hash differs (image is immutable)", () => {
      const { dir } = withAsset("wave.png", Buffer.from([2, 2, 2]));
      try {
        const plan = buildActionPlan({
          config: cfg({
            stickers: [{ name: "wave", description: "old desc", tags: "hello", image: "wave.png" }],
          }),
          state: stickerState([live({ imageHash: "d".repeat(40) })]),
          baseDir: dir,
        });
        const skip = plan.actions.find(
          (a) => a.type === "SKIP" && a.domain === "sticker" && a.resource === "wave",
        );
        expect(skip).toBeTruthy();
        expect(skip!.skipReason).toContain("cannot update a sticker");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not warn about the image when either hash is unknown", () => {
      const { dir } = withAsset("wave.png", Buffer.from([2, 2, 2]));
      try {
        const plan = buildActionPlan({
          config: cfg({
            stickers: [{ name: "wave", description: "old desc", tags: "hello", image: "wave.png" }],
          }),
          state: stickerState([live({ imageHash: null })]),
          baseDir: dir,
        });
        expect(plan.actions.filter((a) => a.domain === "sticker")).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("plans DELETE for live stickers not in config when pruning", () => {
      const plan = buildActionPlan({
        config: cfg({ stickers: [] }),
        state: stickerState([live()]),
        prune: true,
      });
      const del = plan.actions.find(
        (a) => a.type === "DELETE" && a.domain === "sticker" && a.resource === "wave",
      );
      expect(del).toBeTruthy();
      expect(del!.endpoint).toBe("/guilds/guild1/stickers/st1");
    });

    it("does not delete without prune", () => {
      const plan = buildActionPlan({
        config: cfg({ stickers: [] }),
        state: stickerState([live()]),
        prune: false,
      });
      expect(plan.actions.filter((a) => a.domain === "sticker")).toHaveLength(0);
    });
  });

  describe("URL-valued assets with pre-fetched hashes", () => {
    const iconUrl = "https://cdn.example/icon.png";

    it("skips the guild icon upload when the URL hash matches the live hash", () => {
      const plan = buildActionPlan({
        config: cfg({ guild: { icon: iconUrl } }),
        state: baseState({ guild: { ...baseState().guild, icon: "a".repeat(40) } }),
        urlAssetHashes: new Map([[iconUrl, "a".repeat(40)]]),
      });
      expect(plan.actions.filter((a) => a.domain === "guild")).toHaveLength(0);
    });

    it("re-uploads the guild icon when the URL hash differs from live", () => {
      const plan = buildActionPlan({
        config: cfg({ guild: { icon: iconUrl } }),
        state: baseState({ guild: { ...baseState().guild, icon: "b".repeat(40) } }),
        urlAssetHashes: new Map([[iconUrl, "a".repeat(40)]]),
      });
      const update = plan.actions.find((a) => a.type === "UPDATE" && a.domain === "guild");
      expect(update).toBeTruthy();
      expect((update!.payload as Record<string, unknown>).icon).toBe(`__asset__:${iconUrl}`);
    });

    it("treats failed URL downloads (null) as unhashable → re-upload attempt", () => {
      const plan = buildActionPlan({
        config: cfg({ guild: { icon: iconUrl } }),
        state: baseState({ guild: { ...baseState().guild, icon: "b".repeat(40) } }),
        urlAssetHashes: new Map([[iconUrl, null]]),
      });
      const update = plan.actions.find((a) => a.type === "UPDATE" && a.domain === "guild");
      expect(update).toBeTruthy();
    });

    it("detects emoji image drift via the pre-fetched URL hash", () => {
      const plan = buildActionPlan({
        config: cfg({
          emojis: [{ name: "pepe", image: "https://cdn.example/p.png" }],
        }),
        state: baseState({
          emojis: [
            { id: "em1", name: "pepe", roles: [], animated: false, imageHash: "b".repeat(40) },
          ],
        }),
        urlAssetHashes: new Map([["https://cdn.example/p.png", "a".repeat(40)]]),
      });
      const update = plan.actions.find(
        (a) => a.type === "UPDATE" && a.domain === "emoji" && a.resource === "pepe",
      );
      expect(update).toBeTruthy();
      expect((update!.payload as Record<string, unknown>).image).toBe(
        "__asset__:https://cdn.example/p.png",
      );
    });

    it("collectUrlAssets gathers every URL image field exactly once", () => {
      const urls = collectUrlAssets(
        cfg({
          guild: { icon: iconUrl },
          roles: [
            { name: "Member", icon: iconUrl },
            { name: "Other", icon: "local.png" },
          ],
          emojis: [{ name: "pepe", image: "https://x/y.png" }],
          stickers: [{ name: "hype", tags: "t", image: "https://x/y.png" }],
          webhooks: [{ name: "w", channel: "general", avatar: iconUrl }],
        }),
      );
      expect(urls).toEqual([iconUrl, "https://x/y.png"]);
    });
  });
});
