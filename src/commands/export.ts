import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { DiscordRestClient, fetchGuildState } from "../discord/client.js";
import { writeStateCache } from "../state/backup.js";
import { materializeExportAssets } from "../state/export.js";
import { getGuildId, getToken } from "./util.js";

export async function runExport(options: {
  guild?: string;
  token?: string;
  output?: string;
}): Promise<number> {
  const token = getToken(options.token);
  const guildId = getGuildId(options.guild);
  const client = new DiscordRestClient(token);
  const state = await fetchGuildState(client, guildId);

  for (const w of state.warnings) {
    console.warn(`warn: ${w}`);
  }

  writeStateCache(guildId, state);

  // Round-trip: download emoji/sticker/guild-asset images next to the output
  // config so the exported YAML re-applies without manual edits.
  const baseDir = options.output
    ? dirname(isAbsolute(options.output) ? options.output : resolve(process.cwd(), options.output))
    : process.cwd();
  const assetsDir = join(baseDir, "assets");
  const { config, warnings: assetWarnings } = await materializeExportAssets({
    client,
    state,
    assetsDir,
  });
  for (const w of assetWarnings) {
    console.warn(`warn: ${w}`);
  }
  if (
    state.emojis.length + state.stickers.length > 0 ||
    state.guild.icon ||
    state.guild.banner ||
    state.guild.splash
  ) {
    console.log(`Asset images written → ${assetsDir}`);
  }

  const yaml = stringifyYaml(config, { lineWidth: 100 });

  if (options.output) {
    writeFileSync(options.output, yaml);
    console.log(`Exported guild ${guildId} → ${options.output}`);
  } else {
    console.log(yaml);
  }
  return 0;
}
