import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  DISCORD_TYPE_TO_CHANNEL,
  type ServerConfig,
  ServerConfigSchema,
} from "../config/schema.js";
import type { DiscordRestClient } from "../discord/client.js";
import { bitfieldToFlags } from "../discord/permissions.js";
import type { GuildState } from "../state/types.js";

/** Sticker format_type → file extension served by the media CDN. */
export const STICKER_FORMAT_EXT: Record<number, string> = {
  1: "png",
  2: "apng",
  3: "json",
  4: "gif",
};

/** Media-CDN URL for a sticker image (works for guild stickers, no auth). */
export function stickerImageUrl(sticker: { id: string; format_type: number }): string {
  const ext = STICKER_FORMAT_EXT[sticker.format_type] ?? "png";
  return `https://media.discordapp.net/stickers/${sticker.id}.${ext}`;
}

/** CDN URL for an emoji image (auth-gated; `client.fetchAssetBytes` adds the token). */
export function emojiImageUrl(emoji: { id: string; animated?: boolean }): string {
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}`;
}

/** CDN URL candidates for a guild asset hash (animated assets may be webp or gif). */
function guildAssetUrls(
  kind: "icons" | "banners" | "splashes",
  guildId: string,
  hash: string,
): string[] {
  const animated = hash.startsWith("a_");
  const base = `https://cdn.discordapp.com/${kind}/${guildId}/${hash}`;
  return animated ? [`${base}.webp`, `${base}.gif`] : [`${base}.png`];
}

/** Make an arbitrary sticker name safe as a file name. */
function safeFileName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  return s.length > 0 ? s : "unnamed";
}

export interface MaterializeAssetsOptions {
  client: DiscordRestClient;
  state: GuildState;
  /** Absolute path of the directory to write images into (e.g. `<config dir>/assets`). */
  assetsDir: string;
}

export interface MaterializeAssetsResult {
  config: ServerConfig;
  warnings: string[];
  /** Number of asset files written into assetsDir. */
  written: number;
}

/**
 * Make an exported config re-applicable (round-trip):
 * `stateToConfig` references emoji/sticker images by CDN URL or `sticker:<id>`
 * placeholders, neither of which the apply executor can resolve. This downloads
 * every image into `assetsDir` and rewrites the config to config-relative
 * paths (`assets/…`), and adds guild icon/banner/splash.
 *
 * Failure policy: never hard-fail the export. Emoji whose download fails keep
 * the CDN URL (the executor can download it with the token); stickers fall
 * back to the public media-CDN URL; guild assets are simply left unmanaged.
 */
export async function materializeExportAssets(
  opts: MaterializeAssetsOptions,
): Promise<MaterializeAssetsResult> {
  const { client, state, assetsDir } = opts;
  const warnings: string[] = [];
  let written = 0;
  const config = stateToConfig(state);

  const download = async (urls: string[]): Promise<Buffer | null> => {
    for (const url of urls) {
      const buf = await client.fetchAssetBytes(url);
      if (buf) return buf;
    }
    return null;
  };

  const writeFile = (name: string, buf: Buffer): string => {
    const rel = `assets/${name}`;
    writeFileSync(join(assetsDir, name), buf);
    written += 1;
    return rel;
  };

  mkdirSync(assetsDir, { recursive: true });

  // Emojis: rewrite image → assets/emoji-<name>.<ext>.
  for (let i = 0; i < state.emojis.length; i++) {
    const e = state.emojis[i]!;
    const entry = config.emojis[i];
    if (!entry) continue; // stateToConfig maps 1:1, but stay defensive
    const ext = e.animated ? "gif" : "png";
    const buf = await download([emojiImageUrl(e)]);
    if (buf) {
      entry.image = writeFile(`emoji-${safeFileName(e.name)}.${ext}`, buf);
    } else {
      entry.image = emojiImageUrl(e); // re-applicable: executor downloads with token
      warnings.push(`emoji ${e.name}: image download failed; kept CDN URL in config`);
    }
  }

  // Stickers: rewrite image → assets/sticker-<name>.<ext> (fallback: media CDN URL).
  for (let i = 0; i < state.stickers.length; i++) {
    const s = state.stickers[i]!;
    const entry = config.stickers[i];
    if (!entry) continue;
    const ext = STICKER_FORMAT_EXT[s.format_type] ?? "png";
    const buf = await download([stickerImageUrl(s)]);
    if (buf) {
      entry.image = writeFile(`sticker-${safeFileName(s.name)}.${ext}`, buf);
    } else {
      entry.image = stickerImageUrl(s); // public CDN, no auth needed
      warnings.push(`sticker ${s.name}: image download failed; kept media CDN URL in config`);
    }
  }

  // Guild icon / banner / splash: hash-prefixed CDN paths, unmanaged on failure.
  const kindFor: ["icons" | "banners" | "splashes", "icon" | "banner" | "splash"][] = [
    ["icons", "icon"],
    ["banners", "banner"],
    ["splashes", "splash"],
  ];
  for (const [kind, field] of kindFor) {
    const hash = state.guild[field];
    if (!hash) continue;
    const buf = await download(guildAssetUrls(kind, state.guild.id, hash));
    if (buf) {
      const ext = hash.startsWith("a_") ? "webp" : "png";
      config.guild[field] = writeFile(`guild-${field}.${ext}`, buf);
    } else {
      warnings.push(`guild ${field}: download failed; left unmanaged in config`);
    }
  }

  return { config, warnings, written };
}

type OnboardingPrompt = NonNullable<ServerConfig["onboarding"]>["prompts"][number];

function mapOnboardingPrompts(
  prompts: unknown[],
  roleById: Map<string, { name: string }>,
  channelById: Map<string, { name: string }>,
): OnboardingPrompt[] {
  const mapped: OnboardingPrompt[] = [];
  for (const raw of prompts) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.type !== "number" || typeof p.title !== "string") continue;
    const optionsRaw = Array.isArray(p.options) ? p.options : [];
    const options: OnboardingPrompt["options"] = [];
    for (const optRaw of optionsRaw) {
      if (!optRaw || typeof optRaw !== "object") continue;
      const o = optRaw as Record<string, unknown>;
      if (typeof o.title !== "string") continue;
      const channelIds = Array.isArray(o.channel_ids)
        ? o.channel_ids.map((id) =>
            typeof id === "string" ? (channelById.get(id)?.name ?? id) : String(id),
          )
        : [];
      const roleIds = Array.isArray(o.role_ids)
        ? o.role_ids.map((id) =>
            typeof id === "string" ? (roleById.get(id)?.name ?? id) : String(id),
          )
        : [];
      options.push({
        title: o.title,
        description:
          typeof o.description === "string" || o.description === null
            ? (o.description as string | null)
            : undefined,
        emoji_id:
          typeof o.emoji_id === "string" || o.emoji_id === null
            ? (o.emoji_id as string | null)
            : undefined,
        emoji_name:
          typeof o.emoji_name === "string" || o.emoji_name === null
            ? (o.emoji_name as string | null)
            : undefined,
        channel_ids: channelIds,
        role_ids: roleIds,
      });
    }
    if (options.length === 0) continue;
    mapped.push({
      type: p.type,
      title: p.title,
      single_select: Boolean(p.single_select),
      required: Boolean(p.required),
      in_onboarding: p.in_onboarding !== false,
      options,
    });
  }
  return mapped;
}

/** Convert live GuildState into a ServerConfig-shaped object for export. */
export function stateToConfig(state: GuildState): ServerConfig {
  const roleById = new Map(state.roles.map((r) => [r.id, r]));
  const channelById = new Map(state.channels.map((c) => [c.id, c]));

  const categories = state.channels
    .filter((c) => c.type === 4)
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      name: c.name,
      position: c.position,
      permission_overwrites: c.permission_overwrites
        .filter((o) => o.type === 0)
        .map((o) => ({
          role: roleById.get(o.id)?.name ?? o.id,
          allow: bitfieldToFlags(o.allow),
          deny: bitfieldToFlags(o.deny),
        })),
    }));

  const channels = state.channels
    .filter((c) => c.type !== 4)
    .sort((a, b) => a.position - b.position)
    .map((c) => {
      const typeName = DISCORD_TYPE_TO_CHANNEL[c.type] ?? "text";
      const parent = c.parent_id ? channelById.get(c.parent_id) : undefined;
      return {
        name: c.name,
        type: typeName,
        category: parent?.name ?? null,
        topic: c.topic ?? null,
        nsfw: Boolean(c.nsfw),
        slowmode: c.rate_limit_per_user ?? 0,
        bitrate: c.bitrate,
        user_limit: c.user_limit,
        rtc_region: c.rtc_region ?? null,
        position: c.position,
        permission_overwrites: c.permission_overwrites
          .filter((o) => o.type === 0)
          .map((o) => ({
            role: roleById.get(o.id)?.name ?? o.id,
            allow: bitfieldToFlags(o.allow),
            deny: bitfieldToFlags(o.deny),
          })),
      };
    });

  const roles = state.roles
    .filter((r) => !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions,
      position: r.position,
      unicode_emoji: r.unicode_emoji ?? null,
    }));

  const raw: Record<string, unknown> = {
    guild: {
      name: state.guild.name,
      description: state.guild.description,
      preferred_locale: state.guild.preferred_locale,
      verification_level: state.guild.verification_level,
      default_message_notifications: state.guild.default_message_notifications,
      explicit_content_filter: state.guild.explicit_content_filter,
      afk_timeout: state.guild.afk_timeout,
      system_channel_flags: state.guild.system_channel_flags,
      premium_progress_bar_enabled: state.guild.premium_progress_bar_enabled,
      afk_channel: state.guild.afk_channel_id
        ? (channelById.get(state.guild.afk_channel_id)?.name ?? null)
        : null,
      system_channel: state.guild.system_channel_id
        ? (channelById.get(state.guild.system_channel_id)?.name ?? null)
        : null,
      rules_channel: state.guild.rules_channel_id
        ? (channelById.get(state.guild.rules_channel_id)?.name ?? null)
        : null,
      public_updates_channel: state.guild.public_updates_channel_id
        ? (channelById.get(state.guild.public_updates_channel_id)?.name ?? null)
        : null,
    },
    roles,
    categories,
    channels,
    emojis: state.emojis.map((e) => ({
      name: e.name,
      image: `https://cdn.discordapp.com/emojis/${e.id}.png`,
      roles: e.roles.map((id) => roleById.get(id)?.name ?? id),
    })),
    stickers: state.stickers.map((s) => ({
      name: s.name,
      description: s.description ?? "",
      tags: s.tags,
      image: `sticker:${s.id}`,
    })),
    webhooks: state.webhooks.map((w) => ({
      name: w.name,
      channel: channelById.get(w.channel_id)?.name ?? w.channel_id,
      avatar: null,
    })),
    auto_mod: {
      rules: state.autoModRules.map((r) => ({
        name: r.name,
        enabled: r.enabled,
        event_type: r.event_type,
        trigger_type: r.trigger_type,
        trigger_metadata: r.trigger_metadata,
        actions: r.actions.map((a) => ({
          type: a.type,
          metadata: a.metadata
            ? {
                channel: a.metadata.channel_id
                  ? (channelById.get(String(a.metadata.channel_id))?.name ??
                    String(a.metadata.channel_id))
                  : undefined,
                duration_seconds: a.metadata.duration_seconds as number | undefined,
              }
            : undefined,
        })),
        exempt_roles: r.exempt_roles.map((id) => roleById.get(id)?.name ?? id),
        exempt_channels: r.exempt_channels.map((id) => channelById.get(id)?.name ?? id),
      })),
    },
    vanity_url_code: state.vanityUrl,
  };

  if (state.welcomeScreen) {
    raw.welcome_screen = {
      enabled: true,
      description: state.welcomeScreen.description,
      welcome_channels: state.welcomeScreen.welcome_channels.map((wc) => ({
        channel: channelById.get(wc.channel_id)?.name ?? wc.channel_id,
        description: wc.description,
        emoji_id: wc.emoji_id,
        emoji_name: wc.emoji_name,
      })),
    };
  }

  if (state.onboarding) {
    raw.onboarding = {
      enabled: state.onboarding.enabled,
      mode: state.onboarding.mode,
      default_channel_ids: state.onboarding.default_channel_ids.map(
        (id) => channelById.get(id)?.name ?? id,
      ),
      prompts: mapOnboardingPrompts(state.onboarding.prompts, roleById, channelById),
    };
  }

  if (state.widget) {
    raw.widget = {
      enabled: state.widget.enabled,
      channel: state.widget.channel_id
        ? (channelById.get(state.widget.channel_id)?.name ?? null)
        : null,
    };
  }

  return ServerConfigSchema.parse(raw);
}

export function exportStateToYaml(state: GuildState): string {
  return stringifyYaml(stateToConfig(state), { lineWidth: 100 });
}
