import type { GuildState } from "../state/types.js";

/** Build name→snowflake map from a fetched GuildState for executor seeding. */
export function resolvedFromState(state: GuildState): Map<string, string> {
  const map = new Map<string, string>();
  for (const role of state.roles) {
    map.set(`role:${role.name}`, role.id);
    if (role.name === "@everyone" || role.id === state.guild.id) {
      map.set("role:@everyone", role.id);
    }
  }
  for (const ch of state.channels) {
    if (ch.type === 4) {
      map.set(`category:${ch.name}`, ch.id);
    } else {
      map.set(`channel:${ch.name}`, ch.id);
    }
  }
  for (const e of state.emojis) {
    map.set(`emoji:${e.name}`, e.id);
  }
  for (const w of state.webhooks) {
    map.set(`webhook:${w.name}`, w.id);
  }
  for (const r of state.autoModRules) {
    map.set(`auto_mod_rule:${r.name}`, r.id);
  }
  return map;
}
