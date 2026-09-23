import type {
  DiscordAutoModRule,
  DiscordChannel,
  DiscordEmoji,
  DiscordRole,
  DiscordWebhook,
} from "../state/types.js";

export function findRoleByName(roles: DiscordRole[], name: string): DiscordRole | undefined {
  return roles.find((r) => r.name === name && !r.managed);
}

export function findManagedRoleByName(roles: DiscordRole[], name: string): DiscordRole | undefined {
  return roles.find((r) => r.name === name && r.managed);
}

export function findCategoryByName(
  channels: DiscordChannel[],
  name: string,
): DiscordChannel | undefined {
  return channels.find((c) => c.type === 4 && c.name === name);
}

export function findChannelByNameAndParent(
  channels: DiscordChannel[],
  name: string,
  parentId: string | null,
): DiscordChannel | undefined {
  return channels.find(
    (c) => c.type !== 4 && c.name === name && (c.parent_id ?? null) === parentId,
  );
}

export function findChannelByNameFallback(
  channels: DiscordChannel[],
  name: string,
): DiscordChannel | undefined {
  return channels.find((c) => c.type !== 4 && c.name === name);
}

export function findEmojiByName(emojis: DiscordEmoji[], name: string): DiscordEmoji | undefined {
  return emojis.find((e) => e.name === name);
}

export function findWebhookByNameAndChannel(
  webhooks: DiscordWebhook[],
  name: string,
  channelId: string,
): DiscordWebhook | undefined {
  return webhooks.find((w) => w.name === name && w.channel_id === channelId);
}

export function findWebhookByName(
  webhooks: DiscordWebhook[],
  name: string,
): DiscordWebhook | undefined {
  return webhooks.find((w) => w.name === name);
}

export function findAutoModByName(
  rules: DiscordAutoModRule[],
  name: string,
): DiscordAutoModRule | undefined {
  return rules.find((r) => r.name === name);
}

export function botHighestPosition(roles: DiscordRole[], botRoleIds: string[]): number {
  let max = 0;
  for (const id of botRoleIds) {
    const role = roles.find((r) => r.id === id);
    if (role && role.position > max) max = role.position;
  }
  return max;
}

export function categoryIdByName(
  channels: DiscordChannel[],
  name: string | null | undefined,
  pendingCreates: Map<string, string>,
): string | null {
  if (!name) return null;
  const key = `category:${name}`;
  if (pendingCreates.has(key)) return pendingCreates.get(key)!;
  return findCategoryByName(channels, name)?.id ?? null;
}
