import { createHash } from "node:crypto";
import type {
  DiscordAutoModRule,
  DiscordChannel,
  DiscordEmoji,
  DiscordGuild,
  DiscordOnboarding,
  DiscordRole,
  DiscordSticker,
  DiscordWebhook,
  DiscordWelcomeScreen,
  DiscordWidget,
  GuildState,
} from "../state/types.js";
import { DiscordApiError, RateLimitedClient } from "./rate-limit.js";

/**
 * Optional guild features often 404/403 on ordinary (non-Community / non-boosted)
 * servers. Those are expected — don't surface as export/plan warnings.
 */
export function isExpectedOptionalGuildError(
  resource: "welcome-screen" | "vanity-url",
  error: unknown,
): boolean {
  if (!(error instanceof DiscordApiError)) return false;
  if (resource === "welcome-screen") {
    // 10069 Unknown Guild Welcome Screen — no welcome screen / Community off
    return error.status === 404 && error.discordCode === 10069;
  }
  // 50001 Missing Access — vanity URL requires boost tier 3 (+ Manage Guild)
  return error.status === 403 && error.discordCode === 50001;
}

/** Run an async map with bounded concurrency (CDN fetches, etc.). */
async function mapConcurrently<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function warnUnlessExpected(
  warnings: string[],
  label: "welcome-screen" | "vanity-url",
  error: unknown,
): void {
  if (isExpectedOptionalGuildError(label, error)) return;
  warnings.push(`${label}: ${String(error)}`);
}

/**
 * Hosts that are Discord's own CDNs / API. The bot token is only ever sent to
 * these when downloading asset bytes — third-party asset URLs are fetched
 * anonymously so the token cannot leak to other hosts.
 */
export function isDiscordAssetHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "discordapp.com" ||
      host.endsWith(".discordapp.com") ||
      host === "discordcdn.com" ||
      host.endsWith(".discordcdn.com")
    );
  } catch {
    return false;
  }
}

export class DiscordRestClient {
  readonly http: RateLimitedClient;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
    this.http = new RateLimitedClient(token);
  }

  get<T>(path: string): Promise<T> {
    return this.http.request<T>({ method: "GET", path });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.http.request<T>({ method: "POST", path, body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.http.request<T>({ method: "PATCH", path, body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.http.request<T>({ method: "PUT", path, body });
  }

  delete<T = void>(path: string): Promise<T> {
    return this.http.request<T>({ method: "DELETE", path });
  }

  async getBotUserId(): Promise<string> {
    const me = await this.get<{ id: string }>("/users/@me");
    return me.id;
  }

  /**
   * Download an asset URL (CDN emoji/sticker/guild asset) and return the raw
   * bytes. The bot token is sent only to Discord-owned hosts (auth-gated emoji
   * CDN). Returns null for non-http(s) values or on any failure (callers treat
   * that as "unknown", not "different").
   */
  async fetchAssetBytes(url: string): Promise<Buffer | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    try {
      const headers: Record<string, string> = {};
      if (isDiscordAssetHost(url)) headers.Authorization = `Bot ${this.token}`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Download an asset URL and return the sha1 (hex) of the bytes — the same
   * hash convention Discord uses for asset fields. Returns null for non-http(s)
   * values or on any failure (callers treat that as "unknown", not "different").
   */
  async fetchAssetHash(url: string): Promise<string | null> {
    const buf = await this.fetchAssetBytes(url);
    if (!buf) return null;
    return createHash("sha1").update(buf).digest("hex");
  }

  /**
   * POST with a multipart/form-data body. Sticker image uploads require
   * multipart (Discord rejects JSON bodies with 50035); the `file` part carries
   * the image bytes with a `name`/`description`/`tags` text part alongside.
   */
  postMultipart<T>(path: string, form: FormData): Promise<T> {
    return this.http.request<T>({ method: "POST", path, formData: form });
  }
}

export async function fetchGuildState(
  client: DiscordRestClient,
  guildId: string,
): Promise<GuildState> {
  const warnings: string[] = [];

  const [guild, channels, roles, emojis, stickers, webhooks, autoModRules] = await Promise.all([
    client.get<DiscordGuild>(`/guilds/${guildId}?with_counts=false`),
    client.get<DiscordChannel[]>(`/guilds/${guildId}/channels`),
    client.get<DiscordRole[]>(`/guilds/${guildId}/roles`),
    client.get<DiscordEmoji[]>(`/guilds/${guildId}/emojis`),
    client.get<DiscordSticker[]>(`/guilds/${guildId}/stickers`).catch((e) => {
      warnings.push(`stickers: ${String(e)}`);
      return [] as DiscordSticker[];
    }),
    client.get<DiscordWebhook[]>(`/guilds/${guildId}/webhooks`).catch((e) => {
      warnings.push(`webhooks: ${String(e)}`);
      return [] as DiscordWebhook[];
    }),
    client.get<DiscordAutoModRule[]>(`/guilds/${guildId}/auto-moderation/rules`).catch((e) => {
      warnings.push(`auto-mod: ${String(e)}`);
      return [] as DiscordAutoModRule[];
    }),
  ]);

  const welcomeScreen = await client
    .get<DiscordWelcomeScreen>(`/guilds/${guildId}/welcome-screen`)
    .catch((e) => {
      warnUnlessExpected(warnings, "welcome-screen", e);
      return null;
    });

  const onboarding = await client
    .get<DiscordOnboarding>(`/guilds/${guildId}/onboarding`)
    .catch((e) => {
      warnings.push(`onboarding: ${String(e)}`);
      return null;
    });

  const vanity = await client
    .get<{ code: string | null }>(`/guilds/${guildId}/vanity-url`)
    .catch((e) => {
      warnUnlessExpected(warnings, "vanity-url", e);
      return null;
    });

  const widget = await client.get<DiscordWidget>(`/guilds/${guildId}/widget`).catch((e) => {
    warnings.push(`widget: ${String(e)}`);
    return null;
  });

  let botRoleIds: string[] = [];
  try {
    const botId = await client.getBotUserId();
    const member = await client.get<{ roles: string[] }>(`/guilds/${guildId}/members/${botId}`);
    botRoleIds = member.roles;
  } catch (e) {
    warnings.push(`bot member roles: ${String(e)}`);
  }

  // Emoji images have no hash in the API object, so diffing image changes
  // requires the content hash: download each emoji from the CDN (auth-gated)
  // and hash the bytes. Failures leave imageHash null → the diff then assumes
  // the image is unchanged rather than re-uploading forever.
  const hashedEmojis = await mapConcurrently(emojis, 8, (e) =>
    client
      .fetchAssetHash(`https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}`)
      .then((h) => {
        e.imageHash = h;
        return e;
      }),
  );
  const emojiHashFailures = hashedEmojis.filter((e) => e.imageHash === null).length;
  if (emojiHashFailures > 0) {
    warnings.push(
      `emoji image hashes: ${emojiHashFailures} of ${emojis.length} could not be fetched; image changes for those emojis are not detected`,
    );
  }

  // Sticker images are likewise not hashed in the API object. Guild stickers
  // (including bot-created ones, which come back as type 2) are served by the
  // media CDN at /stickers/<id>.<ext> without auth; hash the bytes the same
  // way as emojis. Image-change detection is advisory: Discord cannot update
  // a sticker's image, so a mismatch only surfaces as a plan warning.
  const stickerExt: Record<number, string> = { 1: "png", 2: "apng", 3: "json", 4: "gif" };
  const hashedStickers = await mapConcurrently(stickers, 8, (s) =>
    client
      .fetchAssetHash(
        `https://media.discordapp.net/stickers/${s.id}.${stickerExt[s.format_type] ?? "png"}`,
      )
      .then((h) => {
        s.imageHash = h;
        return s;
      }),
  );
  const stickerHashFailures = hashedStickers.filter((s) => s.imageHash === null).length;
  if (stickerHashFailures > 0) {
    warnings.push(
      `sticker image hashes: ${stickerHashFailures} of ${stickers.length} could not be fetched; image changes for those stickers are not detected`,
    );
  }

  return {
    guild,
    channels,
    roles,
    emojis: hashedEmojis,
    stickers: hashedStickers,
    webhooks,
    autoModRules,
    welcomeScreen,
    onboarding,
    vanityUrl: vanity?.code ?? null,
    widget,
    botRoleIds,
    warnings,
  };
}
