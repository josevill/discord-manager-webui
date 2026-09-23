import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveAssetPath } from "../config/loader.js";
import type { ServerConfig } from "../config/schema.js";
import { CHANNEL_TYPE_TO_DISCORD, normalizeOverwriteBits, parseColor } from "../config/schema.js";
import { permissionsEqual, permissionToString } from "../discord/permissions.js";
import type {
  Action,
  DiscordAutoModRule,
  DiscordChannel,
  DiscordEmoji,
  DiscordOverwrite,
  DiscordRole,
  DiscordWebhook,
  GuildState,
} from "../state/types.js";
import {
  botHighestPosition,
  findAutoModByName,
  findCategoryByName,
  findChannelByNameAndParent,
  findChannelByNameFallback,
  findEmojiByName,
  findManagedRoleByName,
  findRoleByName,
  findWebhookByName,
  findWebhookByNameAndChannel,
} from "./identity.js";

export interface DiffContext {
  config: ServerConfig;
  state: GuildState;
  baseDir: string;
  /** When true, resources in live state not in config are deleted */
  prune: boolean;
  /**
   * Pre-fetched sha1 hashes for `http(s)://`-valued asset fields in the config
   * (see `urlAssetHashesFor` in plan.ts). Without it, URL assets are
   * unhashable and assumed unchanged.
   */
  urlAssetHashes?: Map<string, string | null>;
}

type OverwriteEntry = { id: string; type: 0; allow: string; deny: string };

function skip(domain: Action["domain"], resource: string, reason: string): Action {
  return {
    type: "SKIP",
    domain,
    resource,
    endpoint: "",
    method: "GET",
    payload: null,
    reason: "skipped",
    dependencies: [],
    skipReason: reason,
  };
}

/**
 * sha1 (hex) of an asset value — Discord asset hashes are the sha1 of the
 * image bytes. Local paths are read from disk; `http(s)` URLs are looked up in
 * the pre-fetched `urlAssetHashes` map (plan-time download). Returns null when
 * the hash cannot be computed (missing file, URL not pre-fetched) so callers
 * fall back to "assume unchanged".
 */
function assetHash(ctx: DiffContext, asset: string): string | null {
  if (asset.startsWith("data:")) {
    if (!asset.includes(";base64,")) return null;
    const b64 = asset.slice(asset.indexOf(";base64,") + ";base64,".length);
    try {
      return createHash("sha1").update(Buffer.from(b64, "base64")).digest("hex");
    } catch {
      return null;
    }
  }
  if (asset.startsWith("http://") || asset.startsWith("https://")) {
    return ctx.urlAssetHashes?.get(asset) ?? null;
  }
  try {
    const buf = readFileSync(resolveAssetPath(ctx.baseDir, asset));
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/** Deterministic JSON for deep-comparing live vs desired structures. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function diffGuild(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state } = ctx;
  const g = config.guild;
  const payload: Record<string, unknown> = {};
  const changes: string[] = [];

  if (g.name !== undefined && g.name !== state.guild.name) {
    payload.name = g.name;
    changes.push("name");
  }
  if (g.description !== undefined && g.description !== state.guild.description) {
    payload.description = g.description;
    changes.push("description");
  }
  if (g.preferred_locale !== undefined && g.preferred_locale !== state.guild.preferred_locale) {
    payload.preferred_locale = g.preferred_locale;
    changes.push("preferred_locale");
  }
  if (
    g.verification_level !== undefined &&
    g.verification_level !== state.guild.verification_level
  ) {
    payload.verification_level = g.verification_level;
    changes.push("verification_level");
  }
  if (
    g.default_message_notifications !== undefined &&
    g.default_message_notifications !== state.guild.default_message_notifications
  ) {
    payload.default_message_notifications = g.default_message_notifications;
    changes.push("default_message_notifications");
  }
  if (
    g.explicit_content_filter !== undefined &&
    g.explicit_content_filter !== state.guild.explicit_content_filter
  ) {
    payload.explicit_content_filter = g.explicit_content_filter;
    changes.push("explicit_content_filter");
  }
  if (g.afk_timeout !== undefined && g.afk_timeout !== state.guild.afk_timeout) {
    payload.afk_timeout = g.afk_timeout;
    changes.push("afk_timeout");
  }
  if (
    g.system_channel_flags !== undefined &&
    g.system_channel_flags !== state.guild.system_channel_flags
  ) {
    payload.system_channel_flags = g.system_channel_flags;
    changes.push("system_channel_flags");
  }
  if (
    g.premium_progress_bar_enabled !== undefined &&
    g.premium_progress_bar_enabled !== state.guild.premium_progress_bar_enabled
  ) {
    payload.premium_progress_bar_enabled = g.premium_progress_bar_enabled;
    changes.push("premium_progress_bar_enabled");
  }

  // Assets: skip the re-upload when the live asset hash matches the local file
  // (or the pre-fetched hash of a URL-valued asset).
  const assetChange = (value: string, live: string | null, field: string) => {
    const h = assetHash(ctx, value);
    if (h !== null && live !== null && h === live) return;
    payload[field] = `__asset__:${value}`;
    changes.push(field);
  };
  if (g.icon) assetChange(g.icon, state.guild.icon, "icon");
  if (g.banner) assetChange(g.banner, state.guild.banner, "banner");
  if (g.splash || config.invite_splash) {
    assetChange(g.splash ?? config.invite_splash!, state.guild.splash, "splash");
  }

  if (changes.length > 0) {
    actions.push({
      type: "UPDATE",
      domain: "guild",
      resource: state.guild.name,
      endpoint: `/guilds/${state.guild.id}`,
      method: "PATCH",
      payload,
      reason: `Guild fields differ: ${changes.join(", ")}`,
      dependencies: [],
      targetId: state.guild.id,
    });
  }

  return actions;
}

/**
 * Guild channel references (system/rules/public_updates/afk). Emitted as a
 * separate trailing action (see plan.ts) so `__resolve_channel__` placeholders
 * for channels created in the same plan are resolvable.
 */
export function diffGuildChannelRefs(ctx: DiffContext): Action[] {
  const { config, state } = ctx;
  const g = config.guild;
  const payload: Record<string, unknown> = {};
  const changes: string[] = [];
  const deps: string[] = [];

  const channelRef = (name: string | null | undefined, liveId: string | null, field: string) => {
    if (name === undefined) return;
    if (name === null) {
      if (liveId !== null) {
        payload[field] = null;
        changes.push(field);
      }
      return;
    }
    const ch = findChannelByNameFallback(state.channels, name);
    if (!ch || ch.id !== liveId) {
      payload[field] = `__resolve_channel__:${name}`;
      changes.push(field);
      deps.push(`channel:${name}`);
    }
  };

  channelRef(g.system_channel, state.guild.system_channel_id, "system_channel_id");
  channelRef(g.rules_channel, state.guild.rules_channel_id, "rules_channel_id");
  channelRef(
    g.public_updates_channel,
    state.guild.public_updates_channel_id,
    "public_updates_channel_id",
  );
  channelRef(g.afk_channel, state.guild.afk_channel_id, "afk_channel_id");

  if (changes.length > 0) {
    return [
      {
        type: "UPDATE",
        domain: "guild",
        resource: state.guild.name,
        endpoint: `/guilds/${state.guild.id}`,
        method: "PATCH",
        payload,
        reason: `Guild channel references differ: ${changes.join(", ")}`,
        dependencies: deps,
        targetId: state.guild.id,
      },
    ];
  }
  return [];
}

export function diffRoles(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state, prune } = ctx;
  const maxBotPos = botHighestPosition(state.roles, state.botRoleIds);
  const desiredNames = new Set(config.roles.map((r) => r.name));
  /** Roles that exist now or will be CREATE'd in this plan (not managed-conflict SKIPs). */
  const rolesThatWillExist = new Set<string>();

  for (const role of config.roles) {
    const managed = findManagedRoleByName(state.roles, role.name);
    if (managed && role.name !== "@everyone") {
      actions.push(skip("role", role.name, `Name conflicts with managed role ${managed.id}`));
      continue;
    }

    const existing = findRoleByName(state.roles, role.name);
    const everyone = state.roles.find((r) => r.name === "@everyone" || r.id === state.guild.id);

    if (role.name === "@everyone") {
      const target = everyone;
      if (!target) continue;
      rolesThatWillExist.add("@everyone");
      const payload = buildRolePayload(role, true);
      if (roleFieldsDiffer(target, role, ctx)) {
        actions.push({
          type: "UPDATE",
          domain: "role",
          resource: "@everyone",
          endpoint: `/guilds/${state.guild.id}/roles/${target.id}`,
          method: "PATCH",
          payload,
          reason: "@everyone permissions differ",
          dependencies: [],
          targetId: target.id,
        });
      }
      continue;
    }

    if (!existing) {
      // CREATE never sends position (see buildRolePayload); hierarchy is applied later
      // via role_positions. Always create so downstream __resolve_role__ refs work.
      actions.push({
        type: "CREATE",
        domain: "role",
        resource: role.name,
        endpoint: `/guilds/${state.guild.id}/roles`,
        method: "POST",
        payload: buildRolePayload(role, false),
        reason: "Role not found in guild",
        dependencies: [],
      });
      rolesThatWillExist.add(role.name);
    } else {
      rolesThatWillExist.add(role.name);
      if (existing.position >= maxBotPos && maxBotPos > 0 && existing.id !== state.guild.id) {
        actions.push(
          skip(
            "role",
            role.name,
            `Existing role position ${existing.position} is at/above bot position ${maxBotPos}`,
          ),
        );
        continue;
      }
      if (roleFieldsDiffer(existing, role, ctx)) {
        actions.push({
          type: "UPDATE",
          domain: "role",
          resource: role.name,
          endpoint: `/guilds/${state.guild.id}/roles/${existing.id}`,
          method: "PATCH",
          payload: buildRolePayload(role, false),
          reason: "Role fields differ",
          dependencies: [],
          targetId: existing.id,
        });
      }
    }
  }

  if (prune) {
    // Delete highest position first
    const extras = state.roles
      .filter(
        (r) =>
          !r.managed &&
          r.name !== "@everyone" &&
          r.id !== state.guild.id &&
          !desiredNames.has(r.name),
      )
      .sort((a, b) => b.position - a.position);

    for (const role of extras) {
      if (role.position >= maxBotPos && maxBotPos > 0) {
        actions.push(skip("role", role.name, `Cannot delete role above bot position`));
        continue;
      }
      actions.push({
        type: "DELETE",
        domain: "role",
        resource: role.name,
        endpoint: `/guilds/${state.guild.id}/roles/${role.id}`,
        method: "DELETE",
        payload: null,
        reason: "Role present in guild but not in config",
        dependencies: [],
        targetId: role.id,
      });
    }
  }

  // Batch role reorder only when the live hierarchy differs from the config —
  // re-emitting an identical PATCH every run breaks idempotency.
  const withPositions = config.roles.filter(
    (r) => r.position !== undefined && r.name !== "@everyone",
  );
  const placeable: typeof withPositions = [];
  for (const r of withPositions) {
    if (!rolesThatWillExist.has(r.name)) {
      actions.push(
        skip(
          "role",
          r.name,
          `Cannot apply position: role is unavailable (managed conflict or skipped)`,
        ),
      );
      continue;
    }
    if (maxBotPos > 0 && r.position! >= maxBotPos) {
      actions.push(
        skip(
          "role",
          r.name,
          `Desired position ${r.position} is at/above bot highest role position ${maxBotPos}`,
        ),
      );
      continue;
    }
    placeable.push(r);
  }
  if (placeable.length > 0) {
    const positionMismatch = placeable.some((r) => {
      const live = state.roles.find((x) => x.name === r.name);
      if (!live) return true; // role created in this plan — position not applied yet
      return live.position !== r.position;
    });
    if (positionMismatch) {
      actions.push({
        type: "UPDATE",
        domain: "role_positions",
        resource: "role_positions",
        endpoint: `/guilds/${state.guild.id}/roles`,
        method: "PATCH",
        payload: placeable.map((r) => ({
          id: `__resolve_role__:${r.name}`,
          position: r.position,
        })),
        reason: "Apply configured role hierarchy",
        dependencies: placeable.map((r) => `role:${r.name}`),
      });
    }
  }

  return actions;
}

function buildRolePayload(
  role: ServerConfig["roles"][number],
  isEveryone: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (!isEveryone) {
    payload.name = role.name;
    if (role.color !== undefined) payload.color = parseColor(role.color) ?? 0;
    if (role.hoist !== undefined) payload.hoist = role.hoist;
    if (role.mentionable !== undefined) payload.mentionable = role.mentionable;
    if (role.unicode_emoji !== undefined) payload.unicode_emoji = role.unicode_emoji;
    if (role.icon) payload.icon = `__asset__:${role.icon}`;
  }
  if (role.permissions !== undefined) {
    payload.permissions = permissionToString(role.permissions);
  }
  return payload;
}

/**
 * Role icon is an uploaded asset: the live `icon` field is the sha1 (hex) of
 * the icon bytes. Compare against the local file (or pre-fetched URL) hash;
 * unhashable values are assumed unchanged so they cannot produce a perpetual
 * diff.
 */
function roleIconDiffer(
  existing: DiscordRole,
  desired: ServerConfig["roles"][number],
  ctx: DiffContext,
): boolean {
  if (!desired.icon) return false;
  const h = assetHash(ctx, desired.icon);
  if (h === null) return false;
  const live = existing.icon ?? null;
  return live === null || h !== live;
}

function roleFieldsDiffer(
  existing: DiscordRole,
  desired: ServerConfig["roles"][number],
  ctx: DiffContext,
): boolean {
  const isEveryone = desired.name === "@everyone";
  // For @everyone the payload only carries permissions — comparing any other
  // field would produce a diff the payload cannot fix (perpetual UPDATE).
  if (!isEveryone) {
    if (existing.name !== desired.name) return true;
    if (desired.color !== undefined) {
      const c = parseColor(desired.color) ?? 0;
      if (existing.color !== c) return true;
    }
    if (desired.hoist !== undefined && existing.hoist !== desired.hoist) return true;
    if (desired.mentionable !== undefined && existing.mentionable !== desired.mentionable) {
      return true;
    }
    if (
      desired.unicode_emoji !== undefined &&
      (existing.unicode_emoji ?? null) !== desired.unicode_emoji
    ) {
      return true;
    }
    if (roleIconDiffer(existing, desired, ctx)) return true;
  }
  if (
    desired.permissions !== undefined &&
    !permissionsEqual(existing.permissions, desired.permissions)
  ) {
    return true;
  }
  return false;
}

export function diffCategories(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state, prune } = ctx;
  const desired = new Set(config.categories.map((c) => c.name));

  for (const cat of config.categories) {
    const existing = findCategoryByName(state.channels, cat.name);
    const overwrites = buildOverwritePayload(cat.permission_overwrites, state.roles);

    if (!existing) {
      actions.push({
        type: "CREATE",
        domain: "category",
        resource: cat.name,
        endpoint: `/guilds/${state.guild.id}/channels`,
        method: "POST",
        payload: {
          name: cat.name,
          type: 4,
          position: cat.position,
          permission_overwrites: overwrites.map((o) => ({
            ...o,
            id: o.id.startsWith("__") ? o.id : o.id,
          })),
        },
        reason: "Category not found",
        dependencies: cat.permission_overwrites.map((o) => `role:${o.role}`),
      });
    } else {
      // Ordering is reconciled by the batch channel_positions action; comparing
      // raw `position` here churned forever (Discord renumbers on any move).
      const ow = diffOverwrites(existing.permission_overwrites, overwrites, ctx);
      if (ow.differs) {
        actions.push({
          type: "UPDATE",
          domain: "category",
          resource: cat.name,
          endpoint: `/channels/${existing.id}`,
          method: "PATCH",
          payload: {
            name: cat.name,
            permission_overwrites: ow.payload,
          },
          reason: "Category overwrites differ",
          dependencies: cat.permission_overwrites.map((o) => `role:${o.role}`),
          targetId: existing.id,
        });
      }
    }
  }

  if (prune) {
    for (const ch of state.channels.filter((c) => c.type === 4)) {
      if (!desired.has(ch.name)) {
        actions.push(...guardedChannelDelete(ctx, ch, "Category not in config"));
      }
    }
  }

  return actions;
}

export function diffChannels(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state, prune } = ctx;

  const desiredKeys = new Set(config.channels.map((c) => `${c.category ?? ""}::${c.name}`));

  for (const ch of config.channels) {
    const parentRef = ch.category
      ? (findCategoryByName(state.channels, ch.category)?.id ?? null)
      : null;
    // When category is being created in same plan, parent may be unresolved
    const existing =
      findChannelByNameAndParent(state.channels, ch.name, parentRef) ??
      (ch.category ? findChannelByNameFallback(state.channels, ch.name) : undefined);

    // If found by name alone but parent differs → UPDATE parent
    const discordType = CHANNEL_TYPE_TO_DISCORD[ch.type];
    const overwrites = buildOverwritePayload(ch.permission_overwrites, state.roles);
    const ow = existing ? diffOverwrites(existing.permission_overwrites, overwrites, ctx) : null;
    const payload: Record<string, unknown> = {
      name: ch.name,
      type: discordType,
      topic: ch.topic ?? undefined,
      nsfw: ch.nsfw,
      rate_limit_per_user: ch.slowmode,
      parent_id: ch.category ? `__resolve_category__:${ch.category}` : null,
      permission_overwrites: ow ? ow.payload : overwrites,
    };
    if (ch.bitrate !== undefined) payload.bitrate = ch.bitrate;
    if (ch.user_limit !== undefined) payload.user_limit = ch.user_limit;
    if (ch.rtc_region !== undefined) payload.rtc_region = ch.rtc_region;
    if (!existing && ch.position !== undefined) payload.position = ch.position;
    if (ch.default_auto_archive_duration !== undefined) {
      payload.default_auto_archive_duration = ch.default_auto_archive_duration;
    }
    if (ch.default_forum_layout !== undefined) {
      payload.default_forum_layout = ch.default_forum_layout;
    }
    if (ch.default_sort_order !== undefined) {
      payload.default_sort_order = ch.default_sort_order;
    }

    const deps = [
      ...(ch.category ? [`category:${ch.category}`] : []),
      ...ch.permission_overwrites.map((o) => `role:${o.role}`),
    ];

    if (!existing) {
      actions.push({
        type: "CREATE",
        domain: "channel",
        resource: ch.name,
        endpoint: `/guilds/${state.guild.id}/channels`,
        method: "POST",
        payload,
        reason: `Channel ${ch.name} not found in category ${ch.category ?? "(none)"}`,
        dependencies: deps,
      });
    } else if (channelFieldsDiffer(existing, ch, parentRef, Boolean(ow?.differs))) {
      actions.push({
        type: "UPDATE",
        domain: "channel",
        resource: ch.name,
        endpoint: `/channels/${existing.id}`,
        method: "PATCH",
        payload,
        reason: "Channel fields differ",
        dependencies: deps,
        targetId: existing.id,
      });
    }
  }

  if (prune) {
    // Prune decision is the (parentName, name) key only. A same-name channel in
    // an unmanaged category must be pruned even when the config has that name
    // under a different category.
    for (const ch of state.channels.filter((c) => c.type !== 4)) {
      const parentName = ch.parent_id
        ? (state.channels.find((c) => c.id === ch.parent_id)?.name ?? "")
        : "";
      if (!desiredKeys.has(`${parentName}::${ch.name}`)) {
        actions.push(...guardedChannelDelete(ctx, ch, "Channel not in config"));
      }
    }
  }

  return actions;
}

function channelFieldsDiffer(
  existing: DiscordChannel,
  desired: ServerConfig["channels"][number],
  parentId: string | null,
  overwritesDiffer: boolean,
): boolean {
  if (existing.name !== desired.name) return true;
  if (CHANNEL_TYPE_TO_DISCORD[desired.type] !== existing.type) return true;
  if ((existing.parent_id ?? null) !== parentId && desired.category) {
    // parent may still need resolve; if live parent name differs from desired category
    return true;
  }
  if (desired.topic !== undefined && (existing.topic ?? null) !== (desired.topic ?? null)) {
    return true;
  }
  if (desired.nsfw !== undefined && Boolean(existing.nsfw) !== desired.nsfw) return true;
  if (desired.slowmode !== undefined && (existing.rate_limit_per_user ?? 0) !== desired.slowmode) {
    return true;
  }
  if (desired.bitrate !== undefined && existing.bitrate !== desired.bitrate) return true;
  if (desired.user_limit !== undefined && existing.user_limit !== desired.user_limit) {
    return true;
  }
  // `position` is intentionally not compared per-channel: ordering is handled by
  // the batch channel_positions action (see diffChannelPositions).
  return overwritesDiffer;
}

function buildOverwritePayload(
  overwrites: ServerConfig["channels"][number]["permission_overwrites"] | undefined,
  roles: DiscordRole[],
): OverwriteEntry[] {
  if (!overwrites) return [];
  return overwrites.map((ow) => {
    const bits = normalizeOverwriteBits(ow.allow, ow.deny);
    const role =
      ow.role === "@everyone"
        ? roles.find((r) => r.name === "@everyone")
        : findRoleByName(roles, ow.role);
    return {
      id: role?.id ?? `__resolve_role__:${ow.role}`,
      type: 0 as const,
      allow: bits.allow,
      deny: bits.deny,
    };
  });
}

/**
 * Compare live vs desired overwrites.
 *
 * Discord's PATCH /channels merge semantics: the payload only upserts the
 * overwrites it contains — it never removes others. So:
 * - we only flag overwrites on roles the config defines (its `roles:` list);
 *   live overwrites for arbitrary roles (integrations, etc.) are out-of-band
 *   and must not produce a permanent diff;
 * - when a config-defined role's overwrite is absent from the desired set, we
 *   emit an explicit zeroed overwrite (allow "0", deny "0") — Discord's
 *   documented way to delete an overwrite — so the diff actually converges.
 */
function diffOverwrites(
  live: DiscordOverwrite[],
  desired: OverwriteEntry[],
  ctx: DiffContext,
): { differs: boolean; payload: OverwriteEntry[] } {
  const roleNames = new Map(ctx.state.roles.map((r) => [r.id, r.name]));
  const managedRoleNames = new Set(ctx.config.roles.map((r) => r.name));
  const resolvedDesired = desired.filter((d) => !d.id.startsWith("__"));
  const desiredById = new Map(resolvedDesired.map((d) => [d.id, d]));

  let differs = false;
  for (const d of resolvedDesired) {
    const e = live.find((o) => o.type === 0 && o.id === d.id);
    if (!e || !permissionsEqual(e.allow, d.allow) || !permissionsEqual(e.deny, d.deny)) {
      differs = true;
    }
  }

  const payload: OverwriteEntry[] = [...desired];
  for (const e of live.filter((o) => o.type === 0)) {
    if (desiredById.has(e.id)) continue;
    const name = roleNames.get(e.id);
    if (!name) continue; // member overwrites / unknown ids stay untouched
    if (!managedRoleNames.has(name)) continue; // not defined in config → out-of-band
    differs = true;
    payload.push({ id: e.id, type: 0, allow: "0", deny: "0" });
  }

  // Desired non-empty but channel has no overwrites at all (incl. all-unresolved)
  if (!differs && desired.length > 0 && live.length === 0) differs = true;

  return { differs, payload };
}

/**
 * Per-parent channel ordering, emitted as a single batch PATCH
 * (`/guilds/:id/channels`) analogous to role_positions. The payload always
 * covers every channel of the parent with contiguous 0..n-1 positions, which
 * sidesteps Discord's position-collision shifting (partial lists leave the
 * final ordering to Discord's fixup pass).
 *
 * Groups are computed on effective (post-apply) parentage: a config channel
 * that is moving categories in this plan is counted under its target category.
 */
export function diffChannelPositions(ctx: DiffContext): Action[] {
  const { config, state, prune } = ctx;
  const actions: Action[] = [];
  const guildId = state.guild.id;

  const prunedCatIds = new Set<string>();
  if (prune) {
    const desiredCats = new Set(config.categories.map((c) => c.name));
    for (const c of state.channels) {
      if (c.type === 4 && !desiredCats.has(c.name)) prunedCatIds.add(c.id);
    }
  }

  const effectiveParentId = (ch: DiscordChannel): string | null => {
    if (ch.type === 4) return null;
    const cfg = config.channels.find((c) => c.name === ch.name);
    if (!cfg) return ch.parent_id ?? null;
    if (!cfg.category) return null;
    return findCategoryByName(state.channels, cfg.category)?.id ?? null;
  };

  // Group live channels by effective parent ("top" for top-level).
  const groups = new Map<string, DiscordChannel[]>();
  const groupOf = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    return g;
  };
  for (const ch of state.channels) {
    if (prunedCatIds.has(ch.id)) continue; // being deleted this run
    if (ch.type === 4) {
      groupOf("top").push(ch);
      continue;
    }
    const parent = effectiveParentId(ch);
    if (parent !== null && prunedCatIds.has(parent)) continue;
    groupOf(parent ?? "top").push(ch);
  }

  interface Positioned {
    name: string;
    pos: number;
    id: string | null;
  }

  const positionedFor = (key: string): Positioned[] => {
    const out: Positioned[] = [];
    if (key === "top") {
      for (const c of config.categories) {
        if (c.position === undefined) continue;
        out.push({
          name: c.name,
          pos: c.position,
          id: findCategoryByName(state.channels, c.name)?.id ?? null,
        });
      }
      for (const ch of config.channels) {
        if (ch.category || ch.position === undefined) continue;
        out.push({
          name: ch.name,
          pos: ch.position,
          id: findChannelByNameAndParent(state.channels, ch.name, null)?.id ?? null,
        });
      }
    } else {
      const cat = state.channels.find((c) => c.id === key);
      if (!cat) return out;
      for (const ch of config.channels) {
        if (!ch.category || ch.position === undefined) continue;
        if (findCategoryByName(state.channels, ch.category)?.id !== key) continue;
        out.push({
          name: ch.name,
          pos: ch.position,
          id: findChannelByNameAndParent(state.channels, ch.name, key)?.id ?? null,
        });
      }
    }
    return out;
  };

  for (const [key, liveAll] of groups) {
    const positioned = positionedFor(key).filter((p) => p.id !== null);
    if (positioned.length === 0) continue;
    const positionedIds = new Set(positioned.map((p) => p.id as string));
    const liveSorted = [...liveAll].sort(
      (a, b) => a.position - b.position || a.id.localeCompare(b.id),
    );
    const rest = liveSorted.filter((c) => !positionedIds.has(c.id));
    const desiredIds = [
      ...[...positioned]
        .sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name))
        .map((p) => p.id as string),
      ...rest.map((c) => c.id),
    ];
    const liveIds = liveSorted.map((c) => c.id);
    if (desiredIds.length !== liveIds.length) continue; // safety: need full set
    if (desiredIds.every((id, i) => id === liveIds[i])) continue; // already ordered

    const label =
      key === "top" ? "top level" : (state.channels.find((c) => c.id === key)?.name ?? key);
    actions.push({
      type: "UPDATE",
      domain: "channel_positions",
      resource: `channel_positions:${label}`,
      endpoint: `/guilds/${guildId}/channels`,
      method: "PATCH",
      payload: desiredIds.map((id, i) => ({ id, position: i })),
      reason: `Channel order differs (${label})`,
      dependencies: [],
    });
  }

  return actions;
}

function guardedChannelDelete(ctx: DiffContext, ch: DiscordChannel, reason: string): Action[] {
  const actions: Action[] = [];
  const g = ctx.state.guild;
  const specialIds = [
    g.system_channel_id,
    g.rules_channel_id,
    g.public_updates_channel_id,
    g.afk_channel_id,
  ].filter(Boolean) as string[];

  if (specialIds.includes(ch.id)) {
    // Reassign guild settings away from this channel first
    const payload: Record<string, unknown> = {};
    if (g.system_channel_id === ch.id) payload.system_channel_id = null;
    if (g.rules_channel_id === ch.id) payload.rules_channel_id = null;
    if (g.public_updates_channel_id === ch.id) payload.public_updates_channel_id = null;
    if (g.afk_channel_id === ch.id) payload.afk_channel_id = null;
    actions.push({
      type: "UPDATE",
      domain: "guild",
      resource: g.name,
      endpoint: `/guilds/${g.id}`,
      method: "PATCH",
      payload,
      reason: `Clear special channel refs before deleting ${ch.name}`,
      dependencies: [],
      targetId: g.id,
    });
  }

  actions.push({
    type: "DELETE",
    domain: ch.type === 4 ? "category" : "channel",
    resource: ch.name,
    endpoint: `/channels/${ch.id}`,
    method: "DELETE",
    payload: null,
    reason,
    dependencies: [],
    targetId: ch.id,
  });
  return actions;
}

/**
 * Emoji images have no hash in the API object. `fetchGuildState` downloads
 * each emoji from the CDN and records the sha1 of the bytes as `imageHash`;
 * compare that against the local file hash (or pre-fetched URL hash). When
 * either side is unknown (CDN fetch failed / unhashable asset) the image is
 * assumed unchanged — re-uploading could never converge, so assuming equality
 * is what keeps apply idempotent.
 */
function emojiImageDiffer(ctx: DiffContext, existing: DiscordEmoji, image: string): boolean {
  const local = assetHash(ctx, image);
  if (local === null) return false;
  const live = existing.imageHash ?? null;
  if (live === null) return false;
  return local !== live;
}

export function diffEmojis(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state, prune } = ctx;
  const desired = new Set(config.emojis.map((e) => e.name));

  for (const emoji of config.emojis) {
    const existing = findEmojiByName(state.emojis, emoji.name);
    if (!existing) {
      actions.push({
        type: "CREATE",
        domain: "emoji",
        resource: emoji.name,
        endpoint: `/guilds/${state.guild.id}/emojis`,
        method: "POST",
        payload: {
          name: emoji.name,
          image: `__asset__:${emoji.image}`,
          roles: emoji.roles.map((r) => `__resolve_role__:${r}`),
        },
        reason: "Emoji not found",
        dependencies: emoji.roles.map((r) => `role:${r}`),
      });
    } else {
      // roles and image may differ
      const desiredRoleIds = new Set(
        emoji.roles.map((n) => findRoleByName(state.roles, n)?.id).filter(Boolean) as string[],
      );
      const current = new Set(existing.roles);
      const rolesDiffer =
        desiredRoleIds.size !== current.size || [...desiredRoleIds].some((id) => !current.has(id));
      const imageChanged = emojiImageDiffer(ctx, existing, emoji.image);
      if (rolesDiffer || imageChanged) {
        const payload: Record<string, unknown> = {
          name: emoji.name,
          roles: emoji.roles.map((r) => `__resolve_role__:${r}`),
        };
        if (imageChanged) payload.image = `__asset__:${emoji.image}`;
        actions.push({
          type: "UPDATE",
          domain: "emoji",
          resource: emoji.name,
          endpoint: `/guilds/${state.guild.id}/emojis/${existing.id}`,
          method: "PATCH",
          payload,
          reason:
            rolesDiffer && imageChanged
              ? "Emoji roles and image differ"
              : rolesDiffer
                ? "Emoji role restrictions differ"
                : "Emoji image differs",
          dependencies: emoji.roles.map((r) => `role:${r}`),
          targetId: existing.id,
        });
      }
    }
  }

  if (prune) {
    for (const e of state.emojis) {
      if (!desired.has(e.name)) {
        actions.push({
          type: "DELETE",
          domain: "emoji",
          resource: e.name,
          endpoint: `/guilds/${state.guild.id}/emojis/${e.id}`,
          method: "DELETE",
          payload: null,
          reason: "Emoji not in config",
          dependencies: [],
          targetId: e.id,
        });
      }
    }
  }

  return actions;
}

/**
 * Stickers (guild-scoped; identity = name, consistent with the rest of the
 * engine).
 *
 * - CREATE: `POST /guilds/:id/stickers` — Discord requires a multipart image
 *   upload, so the executor special-cases this domain (payload carries the
 *   `__asset__:` reference for plan readability).
 * - UPDATE: `PATCH /guilds/:id/stickers/:id` for name/description/tags.
 * - DELETE: prune only.
 * - Image: **immutable on Discord** — a sticker's image cannot be PATCHed.
 *   `fetchGuildState` hashes the CDN copy; when the config file's hash differs
 *   we emit an advisory SKIP (the fix is manual: delete + re-create, which
 *   changes the sticker id). Assuming "unchanged" when either hash is unknown
 *   keeps apply idempotent, same convention as emoji images.
 */
export function diffStickers(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state, prune } = ctx;
  const desired = new Set(config.stickers.map((s) => s.name));

  for (const sticker of config.stickers) {
    const existing = state.stickers.find((s) => s.name === sticker.name);
    if (!existing) {
      actions.push({
        type: "CREATE",
        domain: "sticker",
        resource: sticker.name,
        endpoint: `/guilds/${state.guild.id}/stickers`,
        method: "POST",
        payload: {
          name: sticker.name,
          description: sticker.description,
          tags: sticker.tags,
          image: `__asset__:${sticker.image}`,
        },
        reason: "Sticker not found",
        dependencies: [],
      });
      continue;
    }

    const payload: Record<string, unknown> = {};
    const changes: string[] = [];
    if (existing.name !== sticker.name) {
      payload.name = sticker.name;
      changes.push("name");
    }
    if ((existing.description ?? "") !== (sticker.description ?? "")) {
      payload.description = sticker.description;
      changes.push("description");
    }
    if (existing.tags !== sticker.tags) {
      payload.tags = sticker.tags;
      changes.push("tags");
    }
    if (changes.length > 0) {
      actions.push({
        type: "UPDATE",
        domain: "sticker",
        resource: sticker.name,
        endpoint: `/guilds/${state.guild.id}/stickers/${existing.id}`,
        method: "PATCH",
        payload,
        reason: `Sticker fields differ: ${changes.join(", ")}`,
        dependencies: [],
        targetId: existing.id,
      });
    }

    const local = assetHash(ctx, sticker.image);
    const live = existing.imageHash ?? null;
    if (local !== null && live !== null && local !== live) {
      actions.push(
        skip(
          "sticker",
          sticker.name,
          "Sticker image differs, but Discord cannot update a sticker's image — delete it (remove from config and prune, or delete in Discord) and re-create it to change the image",
        ),
      );
    }
  }

  if (prune) {
    for (const s of state.stickers) {
      if (!desired.has(s.name)) {
        actions.push({
          type: "DELETE",
          domain: "sticker",
          resource: s.name,
          endpoint: `/guilds/${state.guild.id}/stickers/${s.id}`,
          method: "DELETE",
          payload: null,
          reason: "Sticker not in config",
          dependencies: [],
          targetId: s.id,
        });
      }
    }
  }

  return actions;
}

/**
 * Webhook avatar is an uploaded asset: the live `avatar` field is the sha1
 * (hex) of the avatar bytes. Compare against the local file (or pre-fetched
 * URL) hash; unset config avatars and unhashable values are left alone.
 */
function webhookAvatarDiffer(
  ctx: DiffContext,
  existing: DiscordWebhook,
  avatar: string | null | undefined,
): boolean {
  if (!avatar) return false;
  const h = assetHash(ctx, avatar);
  if (h === null) return false;
  const live = existing.avatar ?? null;
  return live === null || h !== live;
}

export function diffWebhooks(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state, prune } = ctx;
  const desiredKeys = new Set(config.webhooks.map((w) => `${w.channel}::${w.name}`));

  for (const wh of config.webhooks) {
    const channel = findChannelByNameFallback(state.channels, wh.channel);
    const existing = channel
      ? (findWebhookByNameAndChannel(state.webhooks, wh.name, channel.id) ??
        findWebhookByName(state.webhooks, wh.name))
      : findWebhookByName(state.webhooks, wh.name);

    if (!existing) {
      actions.push({
        type: "CREATE",
        domain: "webhook",
        resource: wh.name,
        endpoint: `__resolve_channel_webhooks__:${wh.channel}`,
        method: "POST",
        payload: {
          name: wh.name,
          avatar: wh.avatar ? `__asset__:${wh.avatar}` : undefined,
          channel: wh.channel,
        },
        reason: "Webhook not found",
        dependencies: [`channel:${wh.channel}`],
      });
    } else {
      const avatarChanged = webhookAvatarDiffer(ctx, existing, wh.avatar);
      if (
        existing.name !== wh.name ||
        (channel && existing.channel_id !== channel.id) ||
        avatarChanged
      ) {
        actions.push({
          type: "UPDATE",
          domain: "webhook",
          resource: wh.name,
          endpoint: `/webhooks/${existing.id}`,
          method: "PATCH",
          payload: {
            name: wh.name,
            channel_id: channel ? channel.id : `__resolve_channel__:${wh.channel}`,
            avatar: wh.avatar ? `__asset__:${wh.avatar}` : undefined,
          },
          reason: "Webhook fields differ",
          dependencies: [`channel:${wh.channel}`],
          targetId: existing.id,
        });
      }
    }
  }

  if (prune) {
    for (const wh of state.webhooks) {
      const chName = state.channels.find((c) => c.id === wh.channel_id)?.name ?? "";
      if (!desiredKeys.has(`${chName}::${wh.name}`)) {
        actions.push({
          type: "DELETE",
          domain: "webhook",
          resource: wh.name,
          endpoint: `/webhooks/${wh.id}`,
          method: "DELETE",
          payload: null,
          reason: "Webhook not in config",
          dependencies: [],
          targetId: wh.id,
        });
      }
    }
  }

  return actions;
}

type AutoModRule = NonNullable<ServerConfig["auto_mod"]>["rules"][number];

function autoModRuleDiffer(
  existing: DiscordAutoModRule,
  desired: AutoModRule,
  state: GuildState,
): boolean {
  if (existing.enabled !== desired.enabled) return true;
  if (existing.event_type !== desired.event_type) return true;
  if (existing.trigger_type !== desired.trigger_type) return true;
  if (
    canonicalJson(existing.trigger_metadata ?? {}) !== canonicalJson(desired.trigger_metadata ?? {})
  ) {
    return true;
  }

  const liveActions = existing.actions ?? [];
  if (liveActions.length !== desired.actions.length) return true;
  for (let i = 0; i < desired.actions.length; i++) {
    const w = desired.actions[i]!;
    const l = liveActions[i]!;
    if (l.type !== w.type) return true;
    const wm = w.metadata ?? {};
    const lm = l.metadata ?? {};
    let wantChannelId: string | null = null;
    if (wm.channel) {
      const id = findChannelByNameFallback(state.channels, wm.channel)?.id;
      if (!id) return true; // channel created in this plan — assume may differ
      wantChannelId = id;
    }
    if (((lm.channel_id as string | undefined) ?? null) !== wantChannelId) return true;
    if (((lm.duration_seconds as number | undefined) ?? null) !== (wm.duration_seconds ?? null))
      return true;
    if (((lm.custom_message as string | undefined) ?? null) !== (wm.custom_message ?? null))
      return true;
  }

  const wantRoleIds = desired.exempt_roles.map((r) => findRoleByName(state.roles, r)?.id);
  const wantChannelIds = desired.exempt_channels.map(
    (c) => findChannelByNameFallback(state.channels, c)?.id,
  );
  if (wantRoleIds.some((id) => !id) || wantChannelIds.some((id) => !id)) return true;
  if (!sameSet(existing.exempt_roles, wantRoleIds as string[])) return true;
  if (!sameSet(existing.exempt_channels, wantChannelIds as string[])) return true;
  return false;
}

export function diffAutoMod(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state, prune } = ctx;
  const desired = new Set(config.auto_mod.rules.map((r) => r.name));

  for (const rule of config.auto_mod.rules) {
    const existing = findAutoModByName(state.autoModRules, rule.name);
    const payload = {
      name: rule.name,
      enabled: rule.enabled,
      event_type: rule.event_type,
      trigger_type: rule.trigger_type,
      trigger_metadata: rule.trigger_metadata,
      actions: rule.actions.map((a) => ({
        type: a.type,
        metadata: a.metadata
          ? {
              ...a.metadata,
              channel_id: a.metadata.channel
                ? `__resolve_channel__:${a.metadata.channel}`
                : undefined,
              channel: undefined,
            }
          : undefined,
      })),
      exempt_roles: rule.exempt_roles.map((r) => `__resolve_role__:${r}`),
      exempt_channels: rule.exempt_channels.map((c) => `__resolve_channel__:${c}`),
    };

    if (!existing) {
      actions.push({
        type: "CREATE",
        domain: "auto_mod_rule",
        resource: rule.name,
        endpoint: `/guilds/${state.guild.id}/auto-moderation/rules`,
        method: "POST",
        payload,
        reason: "Auto-mod rule not found",
        dependencies: [],
      });
    } else if (autoModRuleDiffer(existing, rule, state)) {
      actions.push({
        type: "UPDATE",
        domain: "auto_mod_rule",
        resource: rule.name,
        endpoint: `/guilds/${state.guild.id}/auto-moderation/rules/${existing.id}`,
        method: "PATCH",
        payload,
        reason: "Auto-mod rule fields differ",
        dependencies: [],
        targetId: existing.id,
      });
    }
  }

  if (prune) {
    for (const rule of state.autoModRules) {
      if (!desired.has(rule.name)) {
        actions.push({
          type: "DELETE",
          domain: "auto_mod_rule",
          resource: rule.name,
          endpoint: `/guilds/${state.guild.id}/auto-moderation/rules/${rule.id}`,
          method: "DELETE",
          payload: null,
          reason: "Auto-mod rule not in config",
          dependencies: [],
          targetId: rule.id,
        });
      }
    }
  }

  return actions;
}

type OnboardingConfig = NonNullable<ServerConfig["onboarding"]>;

function onboardingDiffer(
  live: NonNullable<GuildState["onboarding"]> | null,
  desired: OnboardingConfig,
  state: GuildState,
): boolean {
  if (!live) return true;
  if (live.enabled !== desired.enabled) return true;
  if (live.mode !== desired.mode) return true;

  const wantDefault = desired.default_channel_ids.map(
    (c) => findChannelByNameFallback(state.channels, c)?.id,
  );
  if (wantDefault.some((id) => !id)) return true;
  if ((live.default_channel_ids ?? []).join("|") !== (wantDefault as string[]).join("|"))
    return true;

  const livePrompts = (live.prompts ?? []) as Record<string, unknown>[];
  if (livePrompts.length !== desired.prompts.length) return true;
  for (let i = 0; i < desired.prompts.length; i++) {
    const d = desired.prompts[i]!;
    const l = livePrompts[i]!;
    if (!l || typeof l !== "object") return true;
    if (l.type !== d.type) return true;
    if (l.title !== d.title) return true;
    if (Boolean(l.single_select) !== d.single_select) return true;
    if (Boolean(l.required) !== d.required) return true;
    if ((l.in_onboarding ?? true) !== d.in_onboarding) return true;
    const liveOpts = (Array.isArray(l.options) ? l.options : []) as Record<string, unknown>[];
    if (liveOpts.length !== d.options.length) return true;
    for (let j = 0; j < d.options.length; j++) {
      const o = d.options[j]!;
      const lo = liveOpts[j]!;
      if (!lo || typeof lo !== "object") return true;
      if (lo.title !== o.title) return true;
      if ((lo.description ?? null) !== (o.description ?? null)) return true;
      if ((lo.emoji_id ?? null) !== (o.emoji_id ?? null)) return true;
      if ((lo.emoji_name ?? null) !== (o.emoji_name ?? null)) return true;
      const liveChans = (Array.isArray(lo.channel_ids) ? lo.channel_ids : []).map(String);
      const wantChans = o.channel_ids.map((c) => findChannelByNameFallback(state.channels, c)?.id);
      if (wantChans.some((id) => !id)) return true;
      if (liveChans.join("|") !== (wantChans as string[]).join("|")) return true;
      const liveRoles = (Array.isArray(lo.role_ids) ? lo.role_ids : []).map(String);
      const wantRoles = o.role_ids.map((r) => findRoleByName(state.roles, r)?.id);
      if (wantRoles.some((id) => !id)) return true;
      if (!sameSet(liveRoles, wantRoles as string[])) return true;
    }
  }
  return false;
}

export function diffWelcomeAndOnboarding(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state } = ctx;
  const isCommunity = state.guild.features.includes("COMMUNITY");

  if (config.welcome_screen || config.onboarding) {
    if (!isCommunity) {
      actions.push(
        skip(
          "welcome_screen",
          "community",
          "Guild is not Community; enable Community before welcome/onboarding",
        ),
      );
      return actions;
    }
  }

  if (config.welcome_screen) {
    const ws = config.welcome_screen;
    const payload = {
      enabled: ws.enabled,
      description: ws.description,
      welcome_channels: ws.welcome_channels.map((wc) => ({
        channel_id: `__resolve_channel__:${wc.channel}`,
        description: wc.description,
        emoji_id: wc.emoji_id ?? null,
        emoji_name: wc.emoji_name ?? null,
      })),
    };

    let differs = state.welcomeScreen === null;
    if (!differs && state.welcomeScreen) {
      if (
        ws.description !== undefined &&
        (state.welcomeScreen.description ?? null) !== (ws.description ?? null)
      ) {
        differs = true;
      }
      const resolved = ws.welcome_channels.map(
        (wc) => findChannelByNameFallback(state.channels, wc.channel)?.id,
      );
      if (resolved.some((id) => !id)) {
        differs = true; // channel created in this plan — assume may differ
      } else {
        const live = state.welcomeScreen.welcome_channels;
        if (live.length !== resolved.length) {
          differs = true;
        } else {
          for (let i = 0; i < live.length; i++) {
            const l = live[i]!;
            const w = ws.welcome_channels[i]!;
            if (l.channel_id !== resolved[i]) {
              differs = true;
              break;
            }
            if (l.description !== w.description) {
              differs = true;
              break;
            }
            if ((l.emoji_id ?? null) !== (w.emoji_id ?? null)) {
              differs = true;
              break;
            }
            if ((l.emoji_name ?? null) !== (w.emoji_name ?? null)) {
              differs = true;
              break;
            }
          }
        }
      }
    }

    if (differs) {
      actions.push({
        type: "UPDATE",
        domain: "welcome_screen",
        resource: "welcome_screen",
        endpoint: `/guilds/${state.guild.id}/welcome-screen`,
        method: "PATCH",
        payload,
        reason: "Welcome screen differs",
        dependencies: ws.welcome_channels.map((wc) => `channel:${wc.channel}`),
      });
    }
  }

  if (config.onboarding) {
    if (onboardingDiffer(state.onboarding, config.onboarding, state)) {
      actions.push({
        type: "UPDATE",
        domain: "onboarding",
        resource: "onboarding",
        endpoint: `/guilds/${state.guild.id}/onboarding`,
        method: "PUT",
        payload: {
          enabled: config.onboarding.enabled,
          mode: config.onboarding.mode,
          default_channel_ids: config.onboarding.default_channel_ids.map(
            (c) => `__resolve_channel__:${c}`,
          ),
          prompts: config.onboarding.prompts.map((p) => ({
            ...p,
            options: p.options.map((o) => ({
              ...o,
              channel_ids: o.channel_ids.map((c) => `__resolve_channel__:${c}`),
              role_ids: o.role_ids.map((r) => `__resolve_role__:${r}`),
            })),
          })),
        },
        reason: "Onboarding differs",
        dependencies: [],
      });
    }
  }

  return actions;
}

export function diffWidgetAndVanity(ctx: DiffContext): Action[] {
  const actions: Action[] = [];
  const { config, state } = ctx;

  if (config.vanity_url_code) {
    if (state.guild.premium_tier < 3) {
      actions.push(
        skip(
          "vanity_url",
          config.vanity_url_code,
          `Requires boost tier 3 (current: ${state.guild.premium_tier})`,
        ),
      );
    } else if (state.vanityUrl !== config.vanity_url_code) {
      actions.push({
        type: "UPDATE",
        domain: "vanity_url",
        resource: config.vanity_url_code,
        endpoint: `/guilds/${state.guild.id}/vanity-url`,
        method: "PATCH",
        payload: { code: config.vanity_url_code },
        reason: "Vanity URL differs",
        dependencies: [],
      });
    }
  }

  if (config.widget) {
    const channelId = config.widget.channel
      ? findChannelByNameFallback(state.channels, config.widget.channel)?.id
      : null;
    const needsUpdate =
      !state.widget ||
      state.widget.enabled !== config.widget.enabled ||
      (config.widget.channel && state.widget.channel_id !== channelId);
    if (needsUpdate) {
      actions.push({
        type: "UPDATE",
        domain: "widget",
        resource: "widget",
        endpoint: `/guilds/${state.guild.id}/widget`,
        method: "PATCH",
        payload: {
          enabled: config.widget.enabled,
          channel_id: config.widget.channel ? `__resolve_channel__:${config.widget.channel}` : null,
        },
        reason: "Widget settings differ",
        dependencies: config.widget.channel ? [`channel:${config.widget.channel}`] : [],
      });
    }
  }

  return actions;
}
