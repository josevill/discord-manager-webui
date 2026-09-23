export type ChannelTypeName =
  | "text"
  | "voice"
  | "announcement"
  | "forum"
  | "media"
  | "stage"
  | "category";

export interface ConfigOverwrite {
  role: string;
  allow?: string | number | string[];
  deny?: string | number | string[];
}

export interface ConfigRole {
  name: string;
  color?: number | string;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string | number | string[];
  position?: number;
  icon?: string | null;
  unicode_emoji?: string | null;
}

export interface ConfigCategory {
  name: string;
  position?: number;
  permission_overwrites?: ConfigOverwrite[];
}

export interface ConfigChannel {
  name: string;
  type?: ChannelTypeName;
  category?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  slowmode?: number;
  bitrate?: number;
  user_limit?: number;
  rtc_region?: string | null;
  position?: number;
  default_auto_archive_duration?: number;
  default_forum_layout?: number;
  default_sort_order?: number;
  default_thread_rate_limit_per_user?: number;
  permission_overwrites?: ConfigOverwrite[];
}

export interface ConfigEmoji {
  name: string;
  image: string;
  roles?: string[];
}

export interface ConfigSticker {
  name: string;
  description?: string;
  tags: string;
  image: string;
}

export interface ConfigWebhook {
  name: string;
  channel: string;
  avatar?: string | null;
}

export interface ConfigAutoModAction {
  type: number;
  metadata?: {
    channel?: string;
    duration_seconds?: number;
    custom_message?: string;
  };
}

export interface ConfigAutoModRule {
  name: string;
  enabled?: boolean;
  event_type: number;
  trigger_type: number;
  trigger_metadata?: Record<string, unknown>;
  actions: ConfigAutoModAction[];
  exempt_roles?: string[];
  exempt_channels?: string[];
}

export interface ServerConfig {
  guild?: {
    name?: string;
    description?: string | null;
    icon?: string | null;
    banner?: string | null;
    splash?: string | null;
    preferred_locale?: string;
    verification_level?: number;
    default_message_notifications?: number;
    explicit_content_filter?: number;
    afk_timeout?: number;
    afk_channel?: string | null;
    system_channel?: string | null;
    system_channel_flags?: number;
    rules_channel?: string | null;
    public_updates_channel?: string | null;
    premium_progress_bar_enabled?: boolean;
  };
  roles?: ConfigRole[];
  categories?: ConfigCategory[];
  channels?: ConfigChannel[];
  emojis?: ConfigEmoji[];
  stickers?: ConfigSticker[];
  webhooks?: ConfigWebhook[];
  auto_mod?: { rules?: ConfigAutoModRule[] };
  welcome_screen?: unknown;
  onboarding?: unknown;
  vanity_url_code?: string | null;
  widget?: unknown;
  invite_splash?: string | null;
}

export interface ValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface MetaResponse {
  channelTypes: string[];
  permissionFlags: string[];
  configPath: string;
  discordConfigured: boolean;
}

export type Selection =
  | { kind: "guild" }
  | { kind: "role"; index: number }
  | { kind: "category"; index: number }
  | { kind: "channel"; index: number }
  | { kind: "emoji"; index: number }
  | { kind: "webhook"; index: number }
  | { kind: "autoMod"; index: number }
  | null;
