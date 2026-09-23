import { z } from "zod";
import { parsePermissionInput } from "../discord/permissions.js";

const ChannelTypeSchema = z.enum([
  "text",
  "voice",
  "announcement",
  "forum",
  "media",
  "stage",
  "category",
]);

export type ChannelTypeName = z.infer<typeof ChannelTypeSchema>;

export const CHANNEL_TYPE_TO_DISCORD: Record<ChannelTypeName, number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
};

export const DISCORD_TYPE_TO_CHANNEL: Record<number, ChannelTypeName> = {
  0: "text",
  2: "voice",
  4: "category",
  5: "announcement",
  13: "stage",
  15: "forum",
  16: "media",
};

const PermissionValueSchema = z.union([z.string(), z.number(), z.array(z.string())]);

const OverwriteSchema = z.object({
  role: z.string().min(1),
  allow: z
    .union([z.array(z.string()), PermissionValueSchema])
    .optional()
    .default([]),
  deny: z
    .union([z.array(z.string()), PermissionValueSchema])
    .optional()
    .default([]),
});

export type ConfigOverwrite = z.infer<typeof OverwriteSchema>;

const GuildSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(120).nullable().optional(),
  icon: z.string().nullable().optional(),
  banner: z.string().nullable().optional(),
  splash: z.string().nullable().optional(),
  preferred_locale: z.string().optional(),
  verification_level: z.number().int().min(0).max(4).optional(),
  default_message_notifications: z.number().int().min(0).max(1).optional(),
  explicit_content_filter: z.number().int().min(0).max(2).optional(),
  afk_timeout: z.number().int().optional(),
  afk_channel: z.string().nullable().optional(),
  system_channel: z.string().nullable().optional(),
  system_channel_flags: z.number().int().optional(),
  rules_channel: z.string().nullable().optional(),
  public_updates_channel: z.string().nullable().optional(),
  premium_progress_bar_enabled: z.boolean().optional(),
});

const RoleSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.union([z.number().int(), z.string()]).optional(),
  hoist: z.boolean().optional().default(false),
  mentionable: z.boolean().optional().default(false),
  permissions: PermissionValueSchema.optional(),
  position: z.number().int().optional(),
  icon: z.string().nullable().optional(),
  unicode_emoji: z.string().nullable().optional(),
});

const CategorySchema = z.object({
  name: z.string().min(1).max(100),
  position: z.number().int().optional(),
  permission_overwrites: z.array(OverwriteSchema).optional().default([]),
});

const ChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/i, "Channel names must be alphanumeric with - or _"),
  type: ChannelTypeSchema.default("text"),
  category: z.string().nullable().optional(),
  topic: z.string().max(1024).nullable().optional(),
  nsfw: z.boolean().optional().default(false),
  slowmode: z.number().int().min(0).max(21600).optional().default(0),
  bitrate: z.number().int().min(8000).max(384000).optional(),
  user_limit: z.number().int().min(0).max(99).optional(),
  rtc_region: z.string().nullable().optional(),
  position: z.number().int().optional(),
  default_auto_archive_duration: z.number().int().optional(),
  default_forum_layout: z.number().int().optional(),
  default_sort_order: z.number().int().optional(),
  default_thread_rate_limit_per_user: z.number().int().optional(),
  permission_overwrites: z.array(OverwriteSchema).optional().default([]),
});

const EmojiSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, "Emoji names must be alphanumeric + underscore"),
  image: z.string().min(1),
  roles: z.array(z.string()).optional().default([]),
});

const StickerSchema = z.object({
  name: z.string().min(2).max(30),
  description: z.string().max(100).optional().default(""),
  tags: z.string().max(200),
  image: z.string().min(1),
});

const WebhookSchema = z.object({
  name: z.string().min(1).max(80),
  channel: z.string().min(1),
  avatar: z.string().nullable().optional(),
});

const AutoModActionSchema = z.object({
  type: z.number().int(),
  metadata: z
    .object({
      channel: z.string().optional(),
      duration_seconds: z.number().int().optional(),
      custom_message: z.string().optional(),
    })
    .optional(),
});

const AutoModRuleSchema = z.object({
  name: z.string().min(1).max(100),
  enabled: z.boolean().optional().default(true),
  event_type: z.number().int(),
  trigger_type: z.number().int(),
  trigger_metadata: z.record(z.string(), z.unknown()).optional().default({}),
  actions: z.array(AutoModActionSchema).min(1),
  exempt_roles: z.array(z.string()).optional().default([]),
  exempt_channels: z.array(z.string()).optional().default([]),
});

const WelcomeChannelSchema = z.object({
  channel: z.string().min(1),
  description: z.string().max(140),
  emoji_id: z.string().nullable().optional(),
  emoji_name: z.string().nullable().optional(),
});

const WelcomeScreenSchema = z.object({
  enabled: z.boolean().optional().default(true),
  description: z.string().max(140).nullable().optional(),
  welcome_channels: z.array(WelcomeChannelSchema).max(5).optional().default([]),
});

const OnboardingOptionSchema = z.object({
  title: z.string().min(1).max(50),
  description: z.string().max(100).nullable().optional(),
  emoji_id: z.string().nullable().optional(),
  emoji_name: z.string().nullable().optional(),
  channel_ids: z.array(z.string()).optional().default([]),
  role_ids: z.array(z.string()).optional().default([]),
});

const OnboardingPromptSchema = z.object({
  type: z.number().int(),
  title: z.string().min(1).max(100),
  single_select: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),
  in_onboarding: z.boolean().optional().default(true),
  options: z.array(OnboardingOptionSchema).min(1),
});

const OnboardingSchema = z.object({
  enabled: z.boolean().optional().default(true),
  mode: z.number().int().min(0).max(1).optional().default(0),
  prompts: z.array(OnboardingPromptSchema).optional().default([]),
  default_channel_ids: z.array(z.string()).optional().default([]),
});

const WidgetSchema = z.object({
  enabled: z.boolean().optional().default(false),
  channel: z.string().nullable().optional(),
});

export const ServerConfigSchema = z.object({
  guild: GuildSchema.optional().default({}),
  roles: z.array(RoleSchema).optional().default([]),
  categories: z.array(CategorySchema).optional().default([]),
  channels: z.array(ChannelSchema).optional().default([]),
  emojis: z.array(EmojiSchema).optional().default([]),
  stickers: z.array(StickerSchema).optional().default([]),
  webhooks: z.array(WebhookSchema).optional().default([]),
  auto_mod: z
    .object({
      rules: z.array(AutoModRuleSchema).optional().default([]),
    })
    .optional()
    .default({ rules: [] }),
  welcome_screen: WelcomeScreenSchema.optional(),
  onboarding: OnboardingSchema.optional(),
  vanity_url_code: z.string().nullable().optional(),
  widget: WidgetSchema.optional(),
  invite_splash: z.string().nullable().optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ConfigRole = z.infer<typeof RoleSchema>;
export type ConfigCategory = z.infer<typeof CategorySchema>;
export type ConfigChannel = z.infer<typeof ChannelSchema>;

export function normalizeOverwriteBits(
  allow: ConfigOverwrite["allow"],
  deny: ConfigOverwrite["deny"],
): { allow: string; deny: string } {
  const allowBits = Array.isArray(allow)
    ? parsePermissionInput(allow)
    : parsePermissionInput(allow ?? "0");
  const denyBits = Array.isArray(deny)
    ? parsePermissionInput(deny)
    : parsePermissionInput(deny ?? "0");
  return { allow: allowBits.toString(), deny: denyBits.toString() };
}

export function parseColor(color: string | number | undefined): number | undefined {
  if (color === undefined) return undefined;
  if (typeof color === "number") return color;
  if (color.startsWith("0x") || color.startsWith("0X")) {
    return parseInt(color, 16);
  }
  if (color.startsWith("#")) {
    return parseInt(color.slice(1), 16);
  }
  return parseInt(color, 10);
}
