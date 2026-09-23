export type ActionType = "CREATE" | "UPDATE" | "DELETE" | "SKIP";

export type ActionDomain =
  | "guild"
  | "role"
  | "category"
  | "channel"
  | "permission_overwrite"
  | "emoji"
  | "sticker"
  | "webhook"
  | "auto_mod_rule"
  | "welcome_screen"
  | "onboarding"
  | "vanity_url"
  | "widget"
  | "role_positions"
  | "channel_positions";

export interface Action {
  type: ActionType;
  domain: ActionDomain;
  resource: string;
  endpoint: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  payload: Record<string, unknown> | unknown[] | null;
  reason: string;
  dependencies: string[];
  /** Existing Discord snowflake when updating/deleting */
  targetId?: string;
  /** Warning / skip detail */
  skipReason?: string;
}

export interface ActionPlan {
  actions: Action[];
  summary: {
    creates: number;
    updates: number;
    deletes: number;
    skips: number;
  };
  dry_run: boolean;
  warnings: string[];
}

export interface DiscordOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
  icon?: string | null;
  unicode_emoji?: string | null;
  tags?: Record<string, unknown>;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  position: number;
  parent_id: string | null;
  permission_overwrites: DiscordOverwrite[];
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  bitrate?: number;
  user_limit?: number;
  rtc_region?: string | null;
  default_auto_archive_duration?: number | null;
  default_forum_layout?: number | null;
  default_sort_order?: number | null;
  default_thread_rate_limit_per_user?: number | null;
}

export interface DiscordEmoji {
  id: string;
  name: string;
  roles: string[];
  animated?: boolean;
  available?: boolean;
  /**
   * sha1 (hex) of the emoji image bytes. Not part of the Discord API response
   * — computed by `fetchGuildState` by downloading the emoji from the CDN.
   * Used by `diffEmojis` to detect image changes. null when the fetch failed.
   */
  imageHash?: string | null;
}

export interface DiscordSticker {
  id: string;
  name: string;
  description: string | null;
  tags: string;
  type: number;
  format_type: number;
  guild_id?: string;
  available?: boolean;
  /**
   * sha1 (hex) of the sticker image bytes. Not part of the Discord API response
   * — computed by `fetchGuildState` by downloading the sticker from the media
   * CDN (`https://media.discordapp.net/stickers/<id>.<ext>`). Used to detect
   * image changes (advisory only: Discord cannot update a sticker image).
   * null when the fetch failed.
   */
  imageHash?: string | null;
}

export interface DiscordWebhook {
  id: string;
  name: string;
  channel_id: string;
  guild_id?: string;
  avatar?: string | null;
  token?: string;
}

export interface DiscordAutoModRule {
  id: string;
  name: string;
  enabled: boolean;
  event_type: number;
  trigger_type: number;
  trigger_metadata: Record<string, unknown>;
  actions: {
    type: number;
    metadata?: Record<string, unknown>;
  }[];
  exempt_roles: string[];
  exempt_channels: string[];
}

export interface DiscordWelcomeScreen {
  description: string | null;
  welcome_channels: {
    channel_id: string;
    description: string;
    emoji_id: string | null;
    emoji_name: string | null;
  }[];
}

export interface DiscordOnboarding {
  prompts: unknown[];
  default_channel_ids: string[];
  enabled: boolean;
  mode: number;
}

export interface DiscordGuild {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  splash: string | null;
  preferred_locale: string;
  verification_level: number;
  default_message_notifications: number;
  explicit_content_filter: number;
  afk_channel_id: string | null;
  afk_timeout: number;
  system_channel_id: string | null;
  system_channel_flags: number;
  rules_channel_id: string | null;
  public_updates_channel_id: string | null;
  premium_progress_bar_enabled: boolean;
  premium_tier: number;
  features: string[];
  owner_id?: string;
}

export interface DiscordWidget {
  enabled: boolean;
  channel_id: string | null;
}

export interface GuildState {
  guild: DiscordGuild;
  roles: DiscordRole[];
  channels: DiscordChannel[];
  emojis: DiscordEmoji[];
  stickers: DiscordSticker[];
  webhooks: DiscordWebhook[];
  autoModRules: DiscordAutoModRule[];
  welcomeScreen: DiscordWelcomeScreen | null;
  onboarding: DiscordOnboarding | null;
  vanityUrl: string | null;
  widget: DiscordWidget | null;
  /** Bot member's role IDs in this guild */
  botRoleIds: string[];
  warnings: string[];
}

export function summarizePlan(actions: Action[], dryRun = false): ActionPlan {
  return {
    actions,
    summary: {
      creates: actions.filter((a) => a.type === "CREATE").length,
      updates: actions.filter((a) => a.type === "UPDATE").length,
      deletes: actions.filter((a) => a.type === "DELETE").length,
      skips: actions.filter((a) => a.type === "SKIP").length,
    },
    dry_run: dryRun,
    warnings: actions
      .filter((a) => a.type === "SKIP" && a.skipReason)
      .map((a) => `${a.resource}: ${a.skipReason}`),
  };
}
