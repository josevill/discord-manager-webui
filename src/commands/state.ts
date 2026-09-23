import { join } from "node:path";
import { getDataDir, listStateCaches, readStateCache, stateCachePath } from "../state/backup.js";
import { printJson } from "./util.js";

/**
 * Surface the state cache (`~/.discord-manager/state/<guildId>.json`), which
 * export / apply / WebUI fetch write on every live guild read. Without this
 * command the cache was written but read by nothing.
 */
export async function runState(options: {
  guild?: string;
  json?: boolean;
  /** Override data root (tests). Defaults to ~/.discord-manager */
  dataDir?: string;
}): Promise<number> {
  const { guild, json, dataDir } = options;

  if (guild) {
    const state = readStateCache(guild, dataDir);
    if (!state) {
      console.error(
        `No cached state for guild ${guild} (expected ${stateCachePath(guild, dataDir)}). ` +
          "Run export, apply, or the WebUI Fetch against that guild first.",
      );
      return 1;
    }
    const entry = listStateCaches(dataDir).find((c) => c.guildId === guild);
    const counts = {
      roles: state.roles.length,
      categories: state.channels.filter((c) => c.type === 4).length,
      channels: state.channels.length,
      emojis: state.emojis.length,
      stickers: state.stickers.length,
      webhooks: state.webhooks.length,
      autoModRules: state.autoModRules.length,
    };
    const info = {
      guildId: guild,
      fetchedAt: entry?.fetchedAt ?? null,
      sizeBytes: entry?.sizeBytes ?? null,
      path: entry?.path ?? null,
      counts,
      warnings: state.warnings,
    };
    if (json) {
      printJson(info);
      return 0;
    }
    console.log(`Guild:      ${guild}`);
    console.log(`Fetched at: ${info.fetchedAt ?? "unknown"}`);
    console.log(`File:       ${info.path ?? "?"} (${info.sizeBytes ?? "?"} bytes)`);
    console.log(
      `Counts:     ${counts.roles} roles, ${counts.categories} categories, ${counts.channels} channels, ` +
        `${counts.emojis} emojis, ${counts.stickers} stickers, ${counts.webhooks} webhooks, ` +
        `${counts.autoModRules} auto-mod rules`,
    );
    for (const w of state.warnings) console.log(`warn: ${w}`);
    return 0;
  }

  const caches = listStateCaches(dataDir);
  if (caches.length === 0) {
    if (json) {
      printJson([]);
      return 0;
    }
    console.log(
      `No cached guild state in ${join(dataDir ?? getDataDir(), "state")}. ` +
        "Run export, apply, or the WebUI Fetch against a guild first.",
    );
    return 0;
  }

  if (json) {
    printJson(caches);
    return 0;
  }

  console.log(`Cached guild state in ${join(dataDir ?? getDataDir(), "state")}:`);
  for (const c of caches) {
    console.log(`  ${c.guildId}  fetched ${c.fetchedAt}  (${c.sizeBytes} bytes)`);
  }
  console.log("Run: discord-manager state --guild <id> for per-guild details");
  return 0;
}
