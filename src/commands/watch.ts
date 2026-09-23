import { watch as chokidarWatch } from "chokidar";
import { runApply } from "../commands/apply.js";
import { getGuildId, getToken } from "./util.js";

export async function runWatch(options: {
  config: string;
  guild?: string;
  token?: string;
  prune?: boolean;
  auto?: boolean;
  interval?: number;
  gateway?: boolean;
  yes?: boolean;
  keep?: number;
}): Promise<number> {
  const token = getToken(options.token);
  const guildId = getGuildId(options.guild);
  let running = false;
  let pending = false;

  // Fail fast, before any reconcile: --gateway needs the optional discord.js
  // dependency. It is loaded lazily here (dynamic import) so the heavy
  // module stays out of every non-gateway run.
  let gateway: typeof import("discord.js");
  if (options.gateway) {
    try {
      gateway = await import("discord.js");
    } catch {
      throw new Error(
        "discord.js is required for --gateway but is not installed. " +
          "It is an optional dependency — install it with: npm install discord.js",
      );
    }
  }

  const reconcile = async (reason: string) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      // Semantics: without --auto/--yes, watch prints the plan and prompts
      // before applying ANY change; with either flag it applies unattended.
      const unattended = Boolean(options.auto || options.yes);
      const interactive = !unattended;
      if (interactive && !process.stdin.isTTY) {
        console.log(
          `\n── reconcile (${reason}) skipped: interactive confirmation needs a TTY; use --auto or --yes to apply unattended ──`,
        );
        return;
      }
      console.log(`\n── reconcile (${reason}) ──`);
      await runApply({
        config: options.config,
        guild: guildId,
        token,
        prune: options.prune,
        yes: unattended,
        confirmAll: interactive,
        keep: options.keep,
        backup: true,
        source: "watch",
      });
    } finally {
      running = false;
      if (pending) {
        pending = false;
        await reconcile("queued");
      }
    }
  };

  // Initial run
  await reconcile("startup");

  const watcher = chokidarWatch(options.config, { ignoreInitial: true });
  let debounce: NodeJS.Timeout | undefined;
  watcher.on("all", (event) => {
    console.log(`Config ${event}; debouncing…`);
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void reconcile("config-change");
    }, 500);
  });

  if (options.interval && options.interval > 0) {
    setInterval(() => {
      void reconcile(`interval-${options.interval}s`);
    }, options.interval * 1000);
  }

  if (options.gateway) {
    const { Client, Events, GatewayIntentBits } = gateway!;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildWebhooks,
      ],
    });

    const advisory = (event: string, detail: string) => {
      console.log(`[drift advisory] ${event}: ${detail} (guild ${guildId})`);
    };

    client.on(Events.ChannelCreate, (ch) => {
      if ("guild" in ch && ch.guild?.id === guildId) {
        advisory("CHANNEL_CREATE", ch.name);
      }
    });
    client.on(Events.ChannelUpdate, (_o, ch) => {
      if ("guild" in ch && ch.guild?.id === guildId) {
        advisory("CHANNEL_UPDATE", ch.name);
      }
    });
    client.on(Events.ChannelDelete, (ch) => {
      if ("guild" in ch && ch.guild?.id === guildId) {
        advisory("CHANNEL_DELETE", "id" in ch ? ch.id : "?");
      }
    });
    client.on(Events.GuildRoleCreate, (role) => {
      if (role.guild.id === guildId) advisory("GUILD_ROLE_CREATE", role.name);
    });
    client.on(Events.GuildRoleUpdate, (_o, role) => {
      if (role.guild.id === guildId) advisory("GUILD_ROLE_UPDATE", role.name);
    });
    client.on(Events.GuildRoleDelete, (role) => {
      if (role.guild.id === guildId) advisory("GUILD_ROLE_DELETE", role.name);
    });
    client.on(Events.GuildUpdate, (o, n) => {
      if (n.id === guildId) advisory("GUILD_UPDATE", `${o.name} → ${n.name}`);
    });
    client.on(Events.GuildEmojiCreate, (emoji) => {
      if (emoji.guild.id === guildId) advisory("GUILD_EMOJI_CREATE", emoji.name ?? emoji.id);
    });
    client.on(Events.GuildEmojiUpdate, (emoji) => {
      if (emoji.guild.id === guildId) advisory("GUILD_EMOJI_UPDATE", emoji.name ?? emoji.id);
    });
    client.on(Events.GuildEmojiDelete, (emoji) => {
      if (emoji.guild.id === guildId) advisory("GUILD_EMOJI_DELETE", emoji.id);
    });
    client.on(Events.WebhooksUpdate, (channel) => {
      if (channel.guild?.id === guildId) {
        advisory("WEBHOOKS_UPDATE", channel.name);
      }
    });

    await client.login(token);
    console.log("Gateway connected (advisory drift mode).");
  }

  console.log(`Watching ${options.config}… (Ctrl+C to stop)`);
  await new Promise(() => {
    /* run forever */
  });
  return 0;
}
