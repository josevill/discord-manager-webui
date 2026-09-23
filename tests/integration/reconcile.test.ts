import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DiscordRestClient } from "../../src/discord/client.js";
import { executePlan, resolvePlaceholders } from "../../src/reconcile/execute.js";
import { writeBackup } from "../../src/state/backup.js";
import type { ActionPlan, GuildState } from "../../src/state/types.js";

describe("execute placeholders", () => {
  it("resolves role/category/channel refs", async () => {
    const resolved = new Map([
      ["role:Admin", "111"],
      ["category:Info", "222"],
      ["channel:general", "333"],
    ]);
    const payload = {
      permission_overwrites: [{ id: "__resolve_role__:Admin", allow: "0", deny: "0" }],
      parent_id: "__resolve_category__:Info",
      channel_id: "__resolve_channel__:general",
    };
    const out = (await resolvePlaceholders(payload, resolved, "/tmp")) as typeof payload;
    expect(out.permission_overwrites[0]!.id).toBe("111");
    expect(out.parent_id).toBe("222");
    expect(out.channel_id).toBe("333");
  });
});

describe("executePlan", () => {
  it("creates role and records resolved id", async () => {
    const post = vi.fn().mockResolvedValue({ id: "role99", name: "Member" });
    const client = {
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as DiscordRestClient;

    const plan: ActionPlan = {
      actions: [
        {
          type: "CREATE",
          domain: "role",
          resource: "Member",
          endpoint: "/guilds/g/roles",
          method: "POST",
          payload: { name: "Member", permissions: "1024" },
          reason: "test",
          dependencies: [],
        },
      ],
      summary: { creates: 1, updates: 0, deletes: 0, skips: 0 },
      dry_run: false,
      warnings: [],
    };

    const result = await executePlan({
      client,
      plan,
      guildId: "g",
      baseDir: "/tmp",
    });
    expect(result.applied).toBe(1);
    expect(result.resolved.get("role:Member")).toBe("role99");
    expect(post).toHaveBeenCalledOnce();
  });

  it("does not call API in dry-run", async () => {
    const post = vi.fn();
    const client = {
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as DiscordRestClient;
    const plan: ActionPlan = {
      actions: [
        {
          type: "CREATE",
          domain: "role",
          resource: "X",
          endpoint: "/guilds/g/roles",
          method: "POST",
          payload: { name: "X" },
          reason: "t",
          dependencies: [],
        },
      ],
      summary: { creates: 1, updates: 0, deletes: 0, skips: 0 },
      dry_run: true,
      warnings: [],
    };
    const result = await executePlan({ client, plan, guildId: "g", baseDir: "/tmp", dryRun: true });
    expect(result.applied).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("skips dependents when a role dependency was never resolved", async () => {
    const post = vi.fn().mockRejectedValue(new Error("create failed"));
    const patch = vi.fn();
    const client = {
      post,
      patch,
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as DiscordRestClient;

    const plan: ActionPlan = {
      actions: [
        {
          type: "CREATE",
          domain: "role",
          resource: "Admin",
          endpoint: "/guilds/g/roles",
          method: "POST",
          payload: { name: "Admin" },
          reason: "Role not found in guild",
          dependencies: [],
        },
        {
          type: "UPDATE",
          domain: "role_positions",
          resource: "role_positions",
          endpoint: "/guilds/g/roles",
          method: "PATCH",
          payload: [{ id: "__resolve_role__:Admin", position: 2 }],
          reason: "Apply configured role hierarchy",
          dependencies: ["role:Admin"],
        },
        {
          type: "CREATE",
          domain: "channel",
          resource: "rules",
          endpoint: "/guilds/g/channels",
          method: "POST",
          payload: {
            name: "rules",
            permission_overwrites: [{ id: "__resolve_role__:Admin", allow: "0", deny: "0" }],
          },
          reason: "Channel rules not found",
          dependencies: ["role:Admin"],
        },
      ],
      summary: { creates: 2, updates: 1, deletes: 0, skips: 0 },
      dry_run: false,
      warnings: [],
    };

    const results: { status: string; skipReason?: string; error?: string }[] = [];
    const out = await executePlan({
      client,
      plan,
      guildId: "g",
      baseDir: "/tmp",
      onActionResult: (info) => {
        results.push({
          status: info.status,
          skipReason: info.action.skipReason,
          error: info.error,
        });
      },
    });

    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]!.error).toBe("create failed");
    expect(out.skipped).toBe(2);
    expect(patch).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "skip")).toHaveLength(2);
    expect(results.some((r) => r.skipReason?.includes("role:Admin"))).toBe(true);
  });

  it("resolves role_positions after successful role CREATE", async () => {
    const post = vi.fn().mockResolvedValue({ id: "role99", name: "Admin" });
    const patch = vi.fn().mockResolvedValue([]);
    const client = {
      post,
      patch,
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as DiscordRestClient;

    const plan: ActionPlan = {
      actions: [
        {
          type: "CREATE",
          domain: "role",
          resource: "Admin",
          endpoint: "/guilds/g/roles",
          method: "POST",
          payload: { name: "Admin" },
          reason: "Role not found in guild",
          dependencies: [],
        },
        {
          type: "UPDATE",
          domain: "role_positions",
          resource: "role_positions",
          endpoint: "/guilds/g/roles",
          method: "PATCH",
          payload: [{ id: "__resolve_role__:Admin", position: 2 }],
          reason: "Apply configured role hierarchy",
          dependencies: ["role:Admin"],
        },
      ],
      summary: { creates: 1, updates: 1, deletes: 0, skips: 0 },
      dry_run: false,
      warnings: [],
    };

    const out = await executePlan({
      client,
      plan,
      guildId: "g",
      baseDir: "/tmp",
    });
    expect(out.applied).toBe(2);
    expect(out.failed).toHaveLength(0);
    expect(patch).toHaveBeenCalledWith("/guilds/g/roles", [{ id: "role99", position: 2 }]);
  });
});

describe("backup", () => {
  it("writes JSONL backup file", () => {
    const state: GuildState = {
      guild: {
        id: "g1",
        name: "T",
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
      roles: [],
      channels: [],
      emojis: [],
      stickers: [],
      webhooks: [],
      autoModRules: [],
      welcomeScreen: null,
      onboarding: null,
      vanityUrl: null,
      widget: null,
      botRoleIds: [],
      warnings: [],
    };
    const path = writeBackup("g1", state);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!).type).toBe("meta");
    expect(JSON.parse(lines[1]!).type).toBe("guild");
  });
});

// ---------------------------------------------------------------------------
// Idempotency acceptance test (P0 gate)
//
// plan(config, state) → executePlan against a mock client that applies
// mutations with Discord semantics → re-plan against the mutated state →
// assert zero non-SKIP actions. Covers roles, categories, channels,
// overwrites, auto-mod, welcome screen, widget, guild refs, and ordering.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "../../src/config/schema.js";
import { buildActionPlan } from "../../src/reconcile/plan.js";
import { resolvedFromState } from "../../src/reconcile/resolved.js";

/**
 * In-memory guild that applies mutations the way the Discord API does:
 * - PATCH /channels permission_overwrites is a merge (zeroed entry deletes)
 * - bulk channel position PATCH renumbers exactly as given
 * - role/channel creates land at position 0
 */
class MockDiscord {
  state: GuildState;
  private nextId = 90000;

  constructor(state: GuildState) {
    this.state = state;
  }

  private id(): string {
    this.nextId += 1;
    return String(this.nextId);
  }

  private guildId(): string {
    return this.state.guild.id;
  }

  async get<T>(_path: string): Promise<T> {
    throw new Error("mock: GET is not supported; re-plan from mock.state");
  }

  async post(path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (path === `/guilds/${this.guildId()}/roles`) {
      const role: DiscordRole = {
        id: this.id(),
        name: String(body?.name ?? ""),
        color: (body?.color as number) ?? 0,
        hoist: Boolean(body?.hoist),
        mentionable: Boolean(body?.mentionable),
        permissions: String(body?.permissions ?? "0"),
        position: 0,
        managed: false,
        unicode_emoji: (body?.unicode_emoji as string | null) ?? null,
        icon: dataUriSha1Hex(body?.icon),
      };
      this.state.roles.push(role);
      return role;
    }
    if (path === `/guilds/${this.guildId()}/emojis`) {
      const em: DiscordEmoji = {
        id: this.id(),
        name: String(body?.name ?? ""),
        roles: (body?.roles as string[]) ?? [],
        animated: false,
        imageHash: dataUriSha1Hex(body?.image),
      };
      this.state.emojis.push(em);
      return em;
    }
    const whMatch = path.match(/^\/channels\/(\w+)\/webhooks$/);
    if (whMatch) {
      const wh: DiscordWebhook = {
        id: this.id(),
        name: String(body?.name ?? ""),
        channel_id: whMatch[1]!,
        avatar: dataUriSha1Hex(body?.avatar),
      };
      this.state.webhooks.push(wh);
      return wh;
    }
    if (path === `/guilds/${this.guildId()}/channels`) {
      const parentId = (body?.parent_id as string | null) ?? null;
      const siblings = this.state.channels.filter((c) => (c.parent_id ?? null) === parentId);
      const ch: DiscordChannel = {
        id: this.id(),
        type: Number(body?.type ?? 0),
        name: String(body?.name ?? ""),
        position:
          typeof body?.position === "number"
            ? (body.position as number)
            : siblings.length > 0
              ? Math.max(...siblings.map((s) => s.position)) + 1
              : 0,
        parent_id: parentId,
        permission_overwrites: (
          (body?.permission_overwrites as Record<string, unknown>[]) ?? []
        ).map((o) => ({
          id: String(o.id),
          type: 0,
          allow: String(o.allow ?? "0"),
          deny: String(o.deny ?? "0"),
        })),
        topic: (body?.topic as string) ?? null,
        nsfw: Boolean(body?.nsfw),
        rate_limit_per_user: (body?.rate_limit_per_user as number) ?? 0,
      };
      this.state.channels.push(ch);
      return ch;
    }
    if (path === `/guilds/${this.guildId()}/auto-moderation/rules`) {
      const rule: DiscordAutoModRule = {
        id: this.id(),
        name: String(body?.name ?? ""),
        enabled: Boolean(body?.enabled),
        event_type: Number(body?.event_type ?? 0),
        trigger_type: Number(body?.trigger_type ?? 0),
        trigger_metadata: (body?.trigger_metadata as Record<string, unknown>) ?? {},
        actions: (body?.actions as DiscordAutoModRule["actions"]) ?? [],
        exempt_roles: (body?.exempt_roles as string[]) ?? [],
        exempt_channels: (body?.exempt_channels as string[]) ?? [],
      };
      this.state.autoModRules.push(rule);
      return rule;
    }
    throw new Error(`mock: unhandled POST ${path}`);
  }

  /** Sticker CREATE: multipart/form-data (Discord rejects JSON bodies here). */
  async postMultipart(path: string, form: FormData): Promise<unknown> {
    if (path === `/guilds/${this.guildId()}/stickers`) {
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("mock: sticker upload missing file part");
      const buf = Buffer.from(await file.arrayBuffer());
      const st: DiscordSticker = {
        id: this.id(),
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? "") || null,
        tags: String(form.get("tags") ?? ""),
        type: 2,
        format_type: 1,
        guild_id: this.guildId(),
        imageHash: createHash("sha1").update(buf).digest("hex"),
      };
      this.state.stickers.push(st);
      return st;
    }
    throw new Error(`mock: unhandled multipart POST ${path}`);
  }

  async patch(path: string, body?: unknown): Promise<unknown> {
    // Bulk channel reorder: PATCH /guilds/:id/channels with an array
    if (path === `/guilds/${this.guildId()}/channels` && Array.isArray(body)) {
      for (const item of body as { id: string; position: number }[]) {
        const ch = this.state.channels.find((c) => c.id === item.id);
        if (ch) ch.position = item.position;
      }
      return body;
    }
    // Bulk role reorder
    if (path === `/guilds/${this.guildId()}/roles` && Array.isArray(body)) {
      for (const item of body as { id: string; position: number }[]) {
        const role = this.state.roles.find((r) => r.id === item.id);
        if (role) role.position = item.position;
      }
      return body;
    }
    const roleMatch = path.match(/^\/guilds\/[^/]+\/roles\/(\w+)$/);
    if (roleMatch && body && typeof body === "object") {
      const role = this.state.roles.find((r) => r.id === roleMatch[1]);
      if (!role) throw new Error(`mock: unknown role ${roleMatch[1]}`);
      const b = body as Record<string, unknown>;
      if (b.name !== undefined) role.name = String(b.name);
      if (b.color !== undefined) role.color = Number(b.color);
      if (b.hoist !== undefined) role.hoist = Boolean(b.hoist);
      if (b.mentionable !== undefined) role.mentionable = Boolean(b.mentionable);
      if (b.permissions !== undefined) role.permissions = String(b.permissions);
      if (b.unicode_emoji !== undefined) role.unicode_emoji = (b.unicode_emoji as string) ?? null;
      if (b.icon !== undefined) role.icon = dataUriSha1Hex(b.icon);
      return role;
    }
    const emMatch = path.match(/^\/guilds\/[^/]+\/emojis\/(\w+)$/);
    if (emMatch && body && typeof body === "object") {
      const em = this.state.emojis.find((e) => e.id === emMatch[1]);
      if (!em) throw new Error(`mock: unknown emoji ${emMatch[1]}`);
      const b = body as Record<string, unknown>;
      if (b.name !== undefined) em.name = String(b.name);
      if (Array.isArray(b.roles)) em.roles = b.roles as string[];
      if (b.image !== undefined) em.imageHash = dataUriSha1Hex(b.image);
      return em;
    }
    const whPatchMatch = path.match(/^\/webhooks\/(\w+)$/);
    if (whPatchMatch && body && typeof body === "object") {
      const wh = this.state.webhooks.find((w) => w.id === whPatchMatch[1]);
      if (!wh) throw new Error(`mock: unknown webhook ${whPatchMatch[1]}`);
      const b = body as Record<string, unknown>;
      if (b.name !== undefined) wh.name = String(b.name);
      if (b.channel_id !== undefined) wh.channel_id = String(b.channel_id);
      if (b.avatar !== undefined) wh.avatar = dataUriSha1Hex(b.avatar);
      return wh;
    }
    const stPatchMatch = path.match(/^\/guilds\/[^^/]+\/stickers\/(\w+)$/);
    if (stPatchMatch && body && typeof body === "object") {
      const st = this.state.stickers.find((s) => s.id === stPatchMatch[1]);
      if (!st) throw new Error(`mock: unknown sticker ${stPatchMatch[1]}`);
      const b = body as Record<string, unknown>;
      if (b.name !== undefined) st.name = String(b.name);
      if (b.description !== undefined) st.description = String(b.description) || null;
      if (b.tags !== undefined) st.tags = String(b.tags);
      // Discord semantics: a sticker's image is immutable via PATCH.
      return st;
    }
    const chMatch = path.match(/^\/channels\/(\w+)$/);
    if (chMatch && body && typeof body === "object") {
      const ch = this.state.channels.find((c) => c.id === chMatch[1]);
      if (!ch) throw new Error(`mock: unknown channel ${chMatch[1]}`);
      const b = body as Record<string, unknown>;
      if (b.name !== undefined) ch.name = String(b.name);
      if (b.type !== undefined) ch.type = Number(b.type);
      if (b.topic !== undefined) ch.topic = (b.topic as string) ?? null;
      if (b.nsfw !== undefined) ch.nsfw = Boolean(b.nsfw);
      if (b.rate_limit_per_user !== undefined)
        ch.rate_limit_per_user = Number(b.rate_limit_per_user);
      if (b.parent_id !== undefined) ch.parent_id = (b.parent_id as string | null) ?? null;
      if (b.bitrate !== undefined) ch.bitrate = Number(b.bitrate);
      if (b.user_limit !== undefined) ch.user_limit = Number(b.user_limit);
      if (b.position !== undefined) ch.position = Number(b.position);
      // Discord merge semantics: upsert given overwrites; zeroed entry deletes.
      if (Array.isArray(b.permission_overwrites)) {
        const map = new Map(ch.permission_overwrites.map((o) => [o.id, o]));
        for (const o of b.permission_overwrites as { id: string; allow: string; deny: string }[]) {
          if (o.allow === "0" && o.deny === "0") map.delete(o.id);
          else map.set(o.id, { id: o.id, type: 0, allow: o.allow, deny: o.deny });
        }
        ch.permission_overwrites = [...map.values()];
      }
      return ch;
    }
    const amMatch = path.match(/^\/guilds\/[^/]+\/auto-moderation\/rules\/(\w+)$/);
    if (amMatch && body && typeof body === "object") {
      const rule = this.state.autoModRules.find((r) => r.id === amMatch[1]);
      if (!rule) throw new Error(`mock: unknown auto-mod rule ${amMatch[1]}`);
      const b = body as Record<string, unknown>;
      if (b.enabled !== undefined) rule.enabled = Boolean(b.enabled);
      if (b.event_type !== undefined) rule.event_type = Number(b.event_type);
      if (b.trigger_type !== undefined) rule.trigger_type = Number(b.trigger_type);
      if (b.trigger_metadata !== undefined)
        rule.trigger_metadata = b.trigger_metadata as Record<string, unknown>;
      if (b.actions !== undefined) rule.actions = b.actions as DiscordAutoModRule["actions"];
      if (b.exempt_roles !== undefined) rule.exempt_roles = b.exempt_roles as string[];
      if (b.exempt_channels !== undefined) rule.exempt_channels = b.exempt_channels as string[];
      return rule;
    }
    if (path === `/guilds/${this.guildId()}/welcome-screen` && body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      this.state.welcomeScreen = {
        description: (b.description as string | null) ?? null,
        welcome_channels: (b.welcome_channels as DiscordWelcomeScreen["welcome_channels"]) ?? [],
      };
      return this.state.welcomeScreen;
    }
    if (path === `/guilds/${this.guildId()}/widget` && body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      this.state.widget = {
        enabled: Boolean(b.enabled),
        channel_id: (b.channel_id as string | null) ?? null,
      };
      return this.state.widget;
    }
    if (path === `/guilds/${this.guildId()}` && body && typeof body === "object") {
      Object.assign(this.state.guild, body);
      return this.state.guild;
    }
    throw new Error(`mock: unhandled PATCH ${path}`);
  }

  async put(path: string, body?: unknown): Promise<unknown> {
    if (path === `/guilds/${this.guildId()}/onboarding` && body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      this.state.onboarding = {
        enabled: Boolean(b.enabled),
        mode: Number(b.mode ?? 0),
        default_channel_ids: (b.default_channel_ids as string[]) ?? [],
        prompts: (b.prompts as unknown[]) ?? [],
      };
      return this.state.onboarding;
    }
    throw new Error(`mock: unhandled PUT ${path}`);
  }

  async delete(path: string): Promise<unknown> {
    const chMatch = path.match(/^\/channels\/(\w+)$/);
    if (chMatch) {
      const target = this.state.channels.find((c) => c.id === chMatch[1]);
      if (!target) throw new Error(`mock: unknown channel ${chMatch[1]}`);
      this.state.channels = this.state.channels.filter(
        (c) => c.id !== target.id && (c.parent_id ?? null) !== target.id,
      );
      return null;
    }
    const amMatch = path.match(/^\/guilds\/[^/]+\/auto-moderation\/rules\/(\w+)$/);
    if (amMatch) {
      this.state.autoModRules = this.state.autoModRules.filter((r) => r.id !== amMatch[1]);
      return null;
    }
    const stMatch = path.match(/^\/guilds\/[^^/]+\/stickers\/(\w+)$/);
    if (stMatch) {
      const target = this.state.stickers.find((s) => s.id === stMatch[1]);
      if (!target) throw new Error(`mock: unknown sticker ${stMatch[1]}`);
      this.state.stickers = this.state.stickers.filter((s) => s.id !== target.id);
      return null;
    }
    throw new Error(`mock: unhandled DELETE ${path}`);
  }
}

type DiscordRole = import("../../src/state/types.js").DiscordRole;
type DiscordChannel = import("../../src/state/types.js").DiscordChannel;
type DiscordAutoModRule = import("../../src/state/types.js").DiscordAutoModRule;
type DiscordWelcomeScreen = import("../../src/state/types.js").DiscordWelcomeScreen;
type DiscordEmoji = import("../../src/state/types.js").DiscordEmoji;
type DiscordWebhook = import("../../src/state/types.js").DiscordWebhook;
type DiscordSticker = import("../../src/state/types.js").DiscordSticker;

/** Discord hashes asset uploads as sha1 (hex) of the image bytes. */
function dataUriSha1Hex(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  const i = value.indexOf(";base64,");
  if (i < 0) return null;
  return createHash("sha1")
    .update(Buffer.from(value.slice(i + ";base64,".length), "base64"))
    .digest("hex");
}

/** Live asset hashes that deliberately do NOT match the config files. */
const DRIFTED_HASH = "d".repeat(40);

function makeDriftedState(iconHash: string, waveStickerHash: string): GuildState {
  return {
    guild: {
      id: "g1",
      name: "Acme",
      description: null,
      icon: iconHash,
      banner: null,
      splash: null,
      preferred_locale: "en-US",
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      afk_channel_id: null,
      afk_timeout: 300,
      system_channel_id: "ch_logs",
      system_channel_flags: 0,
      rules_channel_id: "ch_old", // drifted: config points at "rules"
      public_updates_channel_id: null,
      premium_progress_bar_enabled: false,
      premium_tier: 0,
      features: ["COMMUNITY"],
    },
    roles: [
      {
        id: "g1",
        name: "@everyone",
        color: 0,
        hoist: false,
        position: 0,
        permissions: "0",
        managed: false,
        mentionable: false,
      },
      {
        id: "bot1",
        name: "Discord Manager",
        color: 0,
        hoist: false,
        position: 10,
        permissions: "8",
        managed: true,
        mentionable: false,
      },
      // Both roles drifted: wrong color/permissions/positions (order swapped)
      {
        id: "member1",
        name: "Member",
        color: 0,
        hoist: false,
        position: 2,
        permissions: "0",
        managed: false,
        mentionable: false,
        unicode_emoji: null,
        icon: null,
      },
      {
        id: "mods1",
        name: "Mods",
        color: 0x57f287,
        hoist: false,
        position: 1,
        permissions: "0",
        managed: false,
        mentionable: false,
      },
    ],
    channels: [
      {
        id: "cat1",
        type: 4,
        name: "Info",
        position: 5,
        parent_id: null,
        // Drifted overwrite: Mods should allow MANAGE_MESSAGES (8192), not VIEW_CHANNEL (1024)
        permission_overwrites: [{ id: "mods1", type: 0, allow: "1024", deny: "0" }],
      },
      {
        id: "ch_logs",
        type: 0,
        name: "logs",
        position: 1,
        parent_id: "cat1",
        topic: "old topic",
        nsfw: false,
        rate_limit_per_user: 0,
        permission_overwrites: [
          { id: "g1", type: 0, allow: "1024", deny: "0" },
          { id: "member1", type: 0, allow: "0", deny: "4096" },
          // Extra overwrite on a config-defined role the config does not declare here
          { id: "mods1", type: 0, allow: "1024", deny: "0" },
        ],
      },
      {
        id: "ch_rules",
        type: 0,
        name: "rules",
        position: 0,
        parent_id: "cat1",
        topic: "server rules",
        nsfw: false,
        rate_limit_per_user: 0,
        permission_overwrites: [],
      },
      {
        id: "ch_old",
        type: 0,
        name: "oldrules",
        position: 2,
        parent_id: "cat1",
        topic: "old",
        nsfw: false,
        rate_limit_per_user: 0,
        permission_overwrites: [],
      },
    ],
    emojis: [
      // Drifted image (live hash != config file hash) → plan 1 re-uploads.
      { id: "em_pepe", name: "pepe", roles: [], animated: false, imageHash: DRIFTED_HASH },
    ],
    stickers: [
      // Description drifted; image hash matches the config file → no image advisory.
      {
        id: "st_wave",
        name: "wave",
        description: "old desc",
        tags: "hello",
        type: 2,
        format_type: 1,
        guild_id: "g1",
        imageHash: waveStickerHash,
      },
    ],
    webhooks: [
      // Drifted avatar (live hash != config file hash) → plan 1 re-uploads.
      { id: "wh_alerts", name: "alerts", channel_id: "ch_logs", avatar: DRIFTED_HASH },
    ],
    autoModRules: [], // rule will be CREATEd in plan 1
    welcomeScreen: {
      description: "old welcome",
      welcome_channels: [
        { channel_id: "ch_old", description: "old", emoji_id: null, emoji_name: null },
      ],
    },
    onboarding: null,
    vanityUrl: null,
    widget: { enabled: false, channel_id: null },
    botRoleIds: ["bot1"],
    warnings: [],
  };
}

const ACCEPTANCE_CONFIG = ServerConfigSchema.parse({
  guild: {
    name: "Acme",
    icon: "icon.png",
    system_channel: "logs",
    rules_channel: "rules",
    afk_channel: null,
    public_updates_channel: null,
  },
  roles: [
    {
      name: "Member",
      color: 0x57f287,
      hoist: false,
      mentionable: false,
      permissions: ["VIEW_CHANNEL", "SEND_MESSAGES"],
      position: 1,
      unicode_emoji: "🦊",
      icon: "member-icon.png",
    },
    {
      name: "Mods",
      color: 0xed4245,
      hoist: true,
      mentionable: false,
      permissions: ["MANAGE_MESSAGES"],
      position: 2,
    },
  ],
  categories: [
    {
      name: "Info",
      position: 0,
      permission_overwrites: [{ role: "Mods", allow: ["MANAGE_MESSAGES"], deny: [] }],
    },
  ],
  channels: [
    {
      name: "logs",
      type: "text",
      category: "Info",
      topic: "system logs",
      nsfw: false,
      slowmode: 0,
      position: 0,
      permission_overwrites: [
        { role: "@everyone", allow: ["VIEW_CHANNEL"], deny: [] },
        { role: "Member", allow: [], deny: ["SEND_MESSAGES"] },
      ],
    },
    {
      name: "rules",
      type: "text",
      category: "Info",
      topic: "server rules",
      nsfw: false,
      slowmode: 0,
      position: 1,
    },
  ],
  emojis: [
    { name: "pepe", image: "pepe.png" }, // exists live, image drifted
    { name: "brand", image: "brand.png", roles: ["Member"] }, // new → CREATE
  ],
  stickers: [
    { name: "hype", description: "Fresh sticker", tags: "fun", image: "hype.png" }, // new → CREATE
    { name: "wave", description: "Updated wave", tags: "hello", image: "wave.png" }, // live desc drifted → UPDATE
  ],
  webhooks: [
    { name: "alerts", channel: "logs", avatar: "wh-avatar.png" }, // exists live, avatar drifted
  ],
  auto_mod: {
    rules: [
      {
        name: "No Links",
        enabled: true,
        event_type: 1,
        trigger_type: 1,
        trigger_metadata: { key_word_list: ["discord.gg"] },
        actions: [{ type: 1, metadata: { custom_message: "No links!" } }],
        exempt_roles: ["Mods"],
        exempt_channels: [],
      },
    ],
  },
  welcome_screen: {
    enabled: true,
    description: "Welcome to Acme",
    welcome_channels: [{ channel: "rules", description: "Start here" }],
  },
  widget: { enabled: true, channel: "logs" },
});

describe("idempotency acceptance (plan → apply → re-plan = no-op)", () => {
  it("second plan after applying the first contains zero non-SKIP actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-acceptance-"));
    const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    writeFileSync(join(dir, "icon.png"), iconBytes);
    const iconHash = createHash("sha1").update(iconBytes).digest("hex");
    // Asset files whose bytes the mock hashes exactly like Discord does.
    for (const [name, bytes] of [
      ["member-icon.png", Buffer.from([11, 12, 13])],
      ["pepe.png", Buffer.from([21, 22, 23])],
      ["brand.png", Buffer.from([31, 32, 33])],
      ["wh-avatar.png", Buffer.from([41, 42, 43])],
      ["wave.png", Buffer.from([51, 52, 53])],
      ["hype.png", Buffer.from([61, 62, 63])],
    ] as const) {
      writeFileSync(join(dir, name), bytes);
    }
    const waveHash = createHash("sha1")
      .update(Buffer.from([51, 52, 53]))
      .digest("hex");
    try {
      const initial = makeDriftedState(iconHash, waveHash);
      const config = ACCEPTANCE_CONFIG;

      const plan1 = buildActionPlan({ config, state: initial, baseDir: dir, prune: false });

      // Sanity: the first plan actually reconciles the drifted domains.
      expect(
        plan1.actions.some(
          (a) => a.type === "UPDATE" && a.domain === "role" && a.resource === "Member",
        ),
      ).toBe(true);
      expect(
        plan1.actions.some(
          (a) => a.type === "UPDATE" && a.domain === "role" && a.resource === "Mods",
        ),
      ).toBe(true);
      expect(plan1.actions.some((a) => a.type === "UPDATE" && a.domain === "role_positions")).toBe(
        true,
      );
      expect(
        plan1.actions.some(
          (a) => a.type === "UPDATE" && a.domain === "category" && a.resource === "Info",
        ),
      ).toBe(true);
      expect(
        plan1.actions.some(
          (a) => a.type === "UPDATE" && a.domain === "channel" && a.resource === "logs",
        ),
      ).toBe(true);
      expect(
        plan1.actions.some((a) => a.type === "UPDATE" && a.domain === "channel_positions"),
      ).toBe(true);
      expect(plan1.actions.some((a) => a.type === "CREATE" && a.domain === "auto_mod_rule")).toBe(
        true,
      );
      expect(plan1.actions.some((a) => a.type === "UPDATE" && a.domain === "welcome_screen")).toBe(
        true,
      );
      expect(plan1.actions.some((a) => a.type === "UPDATE" && a.domain === "widget")).toBe(true);
      // Drifted role assets: Member UPDATE carries unicode_emoji + icon upload.
      const memberUpdate = plan1.actions.find(
        (a) => a.type === "UPDATE" && a.domain === "role" && a.resource === "Member",
      );
      expect(memberUpdate!.payload).toMatchObject({
        unicode_emoji: "🦊",
        icon: "__asset__:member-icon.png",
      });
      // Drifted emoji image: UPDATE re-uploads; new emoji is CREATEd.
      expect(
        plan1.actions.some(
          (a) => a.type === "UPDATE" && a.domain === "emoji" && a.resource === "pepe",
        ),
      ).toBe(true);
      expect(
        (
          plan1.actions.find((a) => a.domain === "emoji" && a.resource === "pepe")!
            .payload as Record<string, unknown>
        ).image,
      ).toBe("__asset__:pepe.png");
      expect(
        plan1.actions.some(
          (a) => a.type === "CREATE" && a.domain === "emoji" && a.resource === "brand",
        ),
      ).toBe(true);
      // Drifted webhook avatar: UPDATE re-uploads.
      expect(
        plan1.actions.some(
          (a) => a.type === "UPDATE" && a.domain === "webhook" && a.resource === "alerts",
        ),
      ).toBe(true);
      expect(
        (
          plan1.actions.find((a) => a.domain === "webhook" && a.resource === "alerts")!
            .payload as Record<string, unknown>
        ).avatar,
      ).toBe("__asset__:wh-avatar.png");
      // Stickers: new one CREATEd (multipart image upload), drifted description UPDATEd.
      expect(
        plan1.actions.some(
          (a) => a.type === "CREATE" && a.domain === "sticker" && a.resource === "hype",
        ),
      ).toBe(true);
      expect(
        (
          plan1.actions.find((a) => a.domain === "sticker" && a.resource === "hype")!
            .payload as Record<string, unknown>
        ).image,
      ).toBe("__asset__:hype.png");
      const waveUpdate = plan1.actions.find(
        (a) => a.domain === "sticker" && a.resource === "wave" && a.type === "UPDATE",
      );
      expect(waveUpdate).toBeTruthy();
      expect(waveUpdate!.payload).toMatchObject({ description: "Updated wave" });
      // Drifted rules_channel ref, but icon hash matches → icon must not be re-uploaded.
      const guildRef = plan1.actions.find(
        (a) =>
          a.domain === "guild" &&
          a.type === "UPDATE" &&
          a.payload &&
          "rules_channel_id" in (a.payload as object),
      );
      expect(guildRef).toBeTruthy();
      expect(
        plan1.actions.some(
          (a) => a.domain === "guild" && a.payload && "icon" in ((a.payload as object) ?? {}),
        ),
      ).toBe(false);

      const mock = new MockDiscord(initial);
      const result = await executePlan({
        client: mock as unknown as DiscordRestClient,
        plan: plan1,
        guildId: "g1",
        baseDir: dir,
        initialResolved: resolvedFromState(initial),
      });
      expect(result.failed).toEqual([]);

      // Re-plan against the post-apply state: must be a no-op.
      const plan2 = buildActionPlan({ config, state: mock.state, baseDir: dir, prune: false });
      const nonSkip = plan2.actions.filter((a) => a.type !== "SKIP");
      expect(nonSkip).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
