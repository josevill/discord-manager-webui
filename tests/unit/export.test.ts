import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscordRestClient } from "../../src/discord/client.js";
import { materializeExportAssets, stateToConfig } from "../../src/state/export.js";
import type { GuildState } from "../../src/state/types.js";

const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

function fixtureState(overrides: Partial<GuildState> = {}): GuildState {
  return {
    guild: {
      id: "guild1",
      name: "Live Guild",
      description: "from discord",
      icon: null,
      banner: null,
      splash: null,
      preferred_locale: "en-US",
      verification_level: 1,
      default_message_notifications: 1,
      explicit_content_filter: 0,
      afk_channel_id: null,
      afk_timeout: 300,
      system_channel_id: "ch1",
      system_channel_flags: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      premium_progress_bar_enabled: false,
      premium_tier: 0,
      features: ["COMMUNITY"],
    },
    roles: [
      {
        id: "guild1",
        name: "@everyone",
        color: 0,
        hoist: false,
        position: 0,
        permissions: "0",
        managed: false,
        mentionable: false,
      },
      {
        id: "r1",
        name: "Member",
        color: 0xff0000,
        hoist: true,
        position: 2,
        permissions: "1024",
        managed: false,
        mentionable: true,
      },
      {
        id: "botrole",
        name: "Bot",
        color: 0,
        hoist: false,
        position: 10,
        permissions: "8",
        managed: true,
        mentionable: false,
      },
    ],
    channels: [
      {
        id: "cat1",
        type: 4,
        name: "Info",
        position: 0,
        parent_id: null,
        permission_overwrites: [],
      },
      {
        id: "ch1",
        type: 0,
        name: "general",
        position: 0,
        parent_id: "cat1",
        permission_overwrites: [
          {
            id: "r1",
            type: 0,
            allow: "1024",
            deny: "0",
          },
        ],
        topic: "hello",
        nsfw: false,
        rate_limit_per_user: 5,
      },
    ],
    emojis: [],
    stickers: [],
    webhooks: [],
    autoModRules: [],
    welcomeScreen: {
      description: "Welcome!",
      welcome_channels: [
        {
          channel_id: "ch1",
          description: "Chat here",
          emoji_id: null,
          emoji_name: "👋",
        },
      ],
    },
    onboarding: {
      enabled: true,
      mode: 0,
      default_channel_ids: ["ch1"],
      prompts: [
        {
          type: 0,
          title: "Pick a role",
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            {
              title: "Member path",
              description: null,
              emoji_id: null,
              emoji_name: null,
              channel_ids: ["ch1"],
              role_ids: ["r1"],
            },
          ],
        },
      ],
    },
    vanityUrl: null,
    widget: { enabled: false, channel_id: null },
    botRoleIds: ["botrole"],
    warnings: [],
    ...overrides,
  };
}

describe("stateToConfig", () => {
  it("maps roles, channels, welcome_screen, and onboarding by name", () => {
    const config = stateToConfig(fixtureState());

    expect(config.guild.name).toBe("Live Guild");
    expect(config.guild.system_channel).toBe("general");

    expect(config.roles.map((r) => r.name)).toEqual(["Member", "@everyone"]);
    expect(config.roles.find((r) => r.name === "Bot")).toBeUndefined();

    expect(config.categories).toHaveLength(1);
    expect(config.categories[0]?.name).toBe("Info");

    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]).toMatchObject({
      name: "general",
      type: "text",
      category: "Info",
      topic: "hello",
      slowmode: 5,
    });
    expect(config.channels[0]?.permission_overwrites[0]?.role).toBe("Member");

    expect(config.welcome_screen).toMatchObject({
      enabled: true,
      description: "Welcome!",
      welcome_channels: [
        {
          channel: "general",
          description: "Chat here",
          emoji_name: "👋",
        },
      ],
    });

    expect(config.onboarding).toMatchObject({
      enabled: true,
      mode: 0,
      default_channel_ids: ["general"],
    });
    expect(config.onboarding?.prompts[0]).toMatchObject({
      title: "Pick a role",
      options: [
        {
          title: "Member path",
          channel_ids: ["general"],
          role_ids: ["Member"],
        },
      ],
    });

    expect(config.widget).toEqual({ enabled: false, channel: null });
  });

  it("omits welcome_screen and onboarding when absent", () => {
    const config = stateToConfig(
      fixtureState({ welcomeScreen: null, onboarding: null, widget: null }),
    );
    expect(config.welcome_screen).toBeUndefined();
    expect(config.onboarding).toBeUndefined();
    expect(config.widget).toBeUndefined();
  });
});

describe("materializeExportAssets (round-trip)", () => {
  const emojiBytes = Buffer.from([10, 20, 30]);
  const stickerBytes = Buffer.from([40, 50, 60]);
  const iconBytes = Buffer.from([70, 80, 90]);

  function stateWithAssets(): GuildState {
    return fixtureState({
      guild: {
        ...fixtureState().guild,
        icon: sha1(iconBytes),
        banner: null,
        splash: null,
      },
      emojis: [{ id: "em1", name: "pepe", roles: [], animated: false }],
      stickers: [
        {
          id: "st1",
          name: "wave sticker",
          description: "hi",
          tags: "hello",
          type: 2,
          format_type: 1,
        },
      ],
    });
  }

  function fakeClient(urlToBytes: Map<string, Buffer>): DiscordRestClient {
    return {
      fetchAssetBytes: async (url: string) => urlToBytes.get(url) ?? null,
    } as unknown as DiscordRestClient;
  }

  it("downloads emoji/sticker/guild-icon images into assetsDir and rewrites refs", async () => {
    const state = stateWithAssets();
    const client = fakeClient(
      new Map([
        ["https://cdn.discordapp.com/emojis/em1.png", emojiBytes],
        ["https://media.discordapp.net/stickers/st1.png", stickerBytes],
        [`https://cdn.discordapp.com/icons/guild1/${sha1(iconBytes)}.png`, iconBytes],
      ]),
    );
    const dir = mkdtempSync(join(tmpdir(), "dm-export-assets-"));
    try {
      const assetsDir = join(dir, "assets");
      const { config, warnings, written } = await materializeExportAssets({
        client,
        state,
        assetsDir,
      });

      expect(warnings).toEqual([]);
      expect(written).toBe(3);
      expect(config.emojis[0]?.image).toBe("assets/emoji-pepe.png");
      expect(config.stickers[0]?.image).toBe("assets/sticker-wave-sticker.png");
      expect(config.guild.icon).toBe("assets/guild-icon.png");

      expect(readFileSync(join(assetsDir, "emoji-pepe.png"))).toEqual(emojiBytes);
      // name is sanitized for the file name only — config identity stays the real name
      expect(readFileSync(join(assetsDir, "sticker-wave-sticker.png"))).toEqual(stickerBytes);
      expect(config.stickers[0]?.name).toBe("wave sticker");
      expect(readFileSync(join(assetsDir, "guild-icon.png"))).toEqual(iconBytes);

      // Re-applicable: every image ref is a path that resolves relative to the config dir
      for (const ref of [config.emojis[0]!.image, config.stickers[0]!.image, config.guild.icon!]) {
        expect(ref.startsWith("assets/")).toBe(true);
        expect(existsSync(join(dir, ref))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to CDN URLs with warnings when downloads fail", async () => {
    const state = stateWithAssets();
    const client = fakeClient(new Map()); // every download fails
    const dir = mkdtempSync(join(tmpdir(), "dm-export-assets-"));
    try {
      const assetsDir = join(dir, "assets");
      const { config, warnings } = await materializeExportAssets({
        client,
        state,
        assetsDir,
      });

      expect(config.emojis[0]?.image).toBe("https://cdn.discordapp.com/emojis/em1.png");
      expect(config.stickers[0]?.image).toBe("https://media.discordapp.net/stickers/st1.png");
      expect(config.guild.icon).toBeUndefined();
      expect(warnings).toEqual([
        "emoji pepe: image download failed; kept CDN URL in config",
        "sticker wave sticker: image download failed; kept media CDN URL in config",
        "guild icon: download failed; left unmanaged in config",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the .json extension for Lottie stickers", async () => {
    const state = stateWithAssets();
    state.stickers[0]!.format_type = 3; // Lottie
    state.stickers[0]!.name = "doodle";
    const client = fakeClient(
      new Map([["https://media.discordapp.net/stickers/st1.json", Buffer.from("{}")]]),
    );
    const dir = mkdtempSync(join(tmpdir(), "dm-export-assets-"));
    try {
      const { config } = await materializeExportAssets({
        client,
        state,
        assetsDir: join(dir, "assets"),
      });
      expect(config.stickers[0]?.image).toBe("assets/sticker-doodle.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
