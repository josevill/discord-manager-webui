/**
 * Discord permission flags as bigint. Permissions must never use Number —
 * values exceed Number.MAX_SAFE_INTEGER (2^53).
 */
export const PermissionFlags = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  /** @deprecated alias */
  MANAGE_EMOJIS_AND_STICKERS: 1n << 30n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  REQUEST_TO_SPEAK: 1n << 32n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  USE_EMBEDDED_ACTIVITIES: 1n << 39n,
  MODERATE_MEMBERS: 1n << 40n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n,
  USE_SOUNDBOARD: 1n << 42n,
  CREATE_GUILD_EXPRESSIONS: 1n << 43n,
  CREATE_EVENTS: 1n << 44n,
  USE_EXTERNAL_SOUNDS: 1n << 45n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SEND_POLLS: 1n << 49n,
  USE_EXTERNAL_APPS: 1n << 50n,
} as const;

export type PermissionFlagName = keyof typeof PermissionFlags;

const FLAG_NAMES = new Set(Object.keys(PermissionFlags));

export function parsePermissionInput(input: string | number | bigint | string[]): bigint {
  if (typeof input === "bigint") return input;
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input)) {
      throw new Error(`Permission number ${input} is not a safe integer; use a string instead`);
    }
    return BigInt(input);
  }
  if (Array.isArray(input)) {
    return flagsToBitfield(input);
  }
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  // comma / space separated flag names
  const parts = trimmed.split(/[\s,|]+/).filter(Boolean);
  return flagsToBitfield(parts);
}

export function flagsToBitfield(flags: string[]): bigint {
  let result = 0n;
  for (const flag of flags) {
    const upper = flag.toUpperCase() as PermissionFlagName;
    if (!FLAG_NAMES.has(upper)) {
      throw new Error(`Unknown permission flag: ${flag}`);
    }
    result |= PermissionFlags[upper];
  }
  return result;
}

export function bitfieldToFlags(bitfield: bigint | string): PermissionFlagName[] {
  const bits = typeof bitfield === "string" ? BigInt(bitfield) : bitfield;
  const flags: PermissionFlagName[] = [];
  for (const [name, value] of Object.entries(PermissionFlags)) {
    if (name === "MANAGE_EMOJIS_AND_STICKERS") continue; // alias
    if ((bits & value) === value) {
      flags.push(name as PermissionFlagName);
    }
  }
  return flags;
}

export function permissionToString(value: string | number | bigint | string[]): string {
  return parsePermissionInput(value).toString();
}

export function permissionsEqual(
  a: string | number | bigint | string[],
  b: string | number | bigint | string[],
): boolean {
  return parsePermissionInput(a) === parsePermissionInput(b);
}

/** Recommended bot invite permissions (almost everything except Administrator). */
export const RECOMMENDED_BOT_PERMISSIONS =
  PermissionFlags.MANAGE_GUILD |
  PermissionFlags.MANAGE_ROLES |
  PermissionFlags.MANAGE_CHANNELS |
  PermissionFlags.KICK_MEMBERS |
  PermissionFlags.BAN_MEMBERS |
  PermissionFlags.MANAGE_WEBHOOKS |
  PermissionFlags.MANAGE_GUILD_EXPRESSIONS |
  PermissionFlags.VIEW_AUDIT_LOG |
  PermissionFlags.MODERATE_MEMBERS |
  PermissionFlags.MANAGE_MESSAGES |
  PermissionFlags.MENTION_EVERYONE |
  PermissionFlags.CREATE_GUILD_EXPRESSIONS |
  PermissionFlags.VIEW_CHANNEL |
  PermissionFlags.SEND_MESSAGES |
  PermissionFlags.READ_MESSAGE_HISTORY;
