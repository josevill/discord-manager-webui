#!/usr/bin/env tsx
/**
 * Cleanup leftover e2e-* resources from a disposable guild.
 * Usage: DISCORD_TOKEN=... DISCORD_GUILD_ID=... npm run e2e:cleanup
 */
import { config as loadEnv } from "dotenv";
import { DiscordRestClient, fetchGuildState } from "../src/discord/client.js";

loadEnv({ quiet: true });

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) {
  console.error("DISCORD_TOKEN and DISCORD_GUILD_ID required");
  process.exit(1);
}

const prefix = process.argv[2] ?? "e2e-";
const client = new DiscordRestClient(token);
const state = await fetchGuildState(client, guildId);

let deleted = 0;
for (const ch of [...state.channels].sort((a, b) => {
  // delete children before categories
  if (a.type === 4 && b.type !== 4) return 1;
  if (a.type !== 4 && b.type === 4) return -1;
  return 0;
})) {
  if (ch.name.startsWith(prefix)) {
    try {
      await client.delete(`/channels/${ch.id}`);
      console.log(`deleted channel ${ch.name}`);
      deleted += 1;
    } catch (e) {
      console.warn(`fail channel ${ch.name}: ${e}`);
    }
  }
}

for (const role of state.roles
  .filter((r) => r.name.startsWith(prefix) && !r.managed)
  .sort((a, b) => b.position - a.position)) {
  try {
    await client.delete(`/guilds/${guildId}/roles/${role.id}`);
    console.log(`deleted role ${role.name}`);
    deleted += 1;
  } catch (e) {
    console.warn(`fail role ${role.name}: ${e}`);
  }
}

console.log(`Cleanup done (${deleted} resources).`);
