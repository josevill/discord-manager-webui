import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRestClient, fetchGuildState } from "../../src/discord/client.js";

const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function errorResponse(status: number, code?: number) {
  return {
    ok: false,
    status,
    headers: new Headers({ "Content-Type": "application/json" }),
    text: async () => JSON.stringify({ code: code ?? 0, message: "err" }),
    json: async () => ({ code: code ?? 0, message: "err" }),
  };
}

describe("DiscordRestClient.fetchAssetHash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the sha1 hex of the fetched bytes, authenticated for Discord CDN hosts", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DiscordRestClient("tok");
    const h = await client.fetchAssetHash("https://cdn.discordapp.com/emojis/e1.png");

    expect(h).toBe(sha1(bytes));
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.discordapp.com/emojis/e1.png", {
      headers: { Authorization: "Bot tok" },
    });
  });

  it("does not send the token to non-Discord asset hosts", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DiscordRestClient("tok");
    const h = await client.fetchAssetHash("https://cdn.example/x.png");

    expect(h).toBe(sha1(bytes));
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example/x.png", { headers: {} });
  });

  it("returns null for non-URL values without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new DiscordRestClient("tok");
    expect(await client.fetchAssetHash("local.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on HTTP errors or network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const client = new DiscordRestClient("tok");
    expect(await client.fetchAssetHash("https://cdn.example/x.png")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    expect(await client.fetchAssetHash("https://cdn.example/x.png")).toBeNull();
  });
});

describe("fetchGuildState emoji image hashes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads each emoji from the CDN (png/gif by animated flag) and stores imageHash; warns on failures", async () => {
    const imgA = Buffer.from([9, 8, 7]);
    const requested: string[] = [];

    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      requested.push(u);
      if (u.startsWith("https://cdn.discordapp.com/")) {
        if (u.includes("/e1.png")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "Content-Type": "image/png" }),
            arrayBuffer: async () =>
              imgA.buffer.slice(imgA.byteOffset, imgA.byteOffset + imgA.byteLength),
          };
        }
        return errorResponse(404); // e2 (animated → .gif) fails
      }
      if (u.endsWith("/guilds/g1?with_counts=false")) {
        return jsonResponse({
          id: "g1",
          name: "G",
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
        });
      }
      if (u.includes("/emojis")) {
        return jsonResponse([
          { id: "e1", name: "a", roles: [], animated: false },
          { id: "e2", name: "b", roles: [], animated: true },
        ]);
      }
      if (u.includes("/welcome-screen")) return errorResponse(404, 10069);
      if (u.includes("/onboarding")) {
        return jsonResponse({ enabled: false, mode: 0, prompts: [], default_channel_ids: [] });
      }
      if (u.includes("/vanity-url")) return jsonResponse({ code: null });
      if (u.includes("/widget")) return jsonResponse({ enabled: false, channel_id: null });
      if (u.endsWith("/users/@me")) return jsonResponse({ id: "bot" });
      if (u.includes("/members/bot")) return jsonResponse({ roles: [] });
      return jsonResponse([]); // channels / roles / stickers / webhooks / auto-mod
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DiscordRestClient("tok");
    const state = await fetchGuildState(client, "g1");

    expect(state.emojis[0]!.imageHash).toBe(sha1(imgA));
    expect(state.emojis[1]!.imageHash).toBeNull();
    expect(requested).toContain("https://cdn.discordapp.com/emojis/e1.png");
    expect(requested).toContain("https://cdn.discordapp.com/emojis/e2.gif");
    const warning = state.warnings.find((w) => w.startsWith("emoji image hashes:"));
    expect(warning).toBe(
      "emoji image hashes: 1 of 2 could not be fetched; image changes for those emojis are not detected",
    );
  });
});
