import {
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GuildState } from "./types.js";

export function getDataDir(): string {
  return join(homedir(), ".discord-manager");
}

export function stateCachePath(guildId: string, dataDir?: string): string {
  return join(dataDir ?? getDataDir(), "state", `${guildId}.json`);
}

export function writeStateCache(guildId: string, state: GuildState, dataDir?: string): string {
  const path = stateCachePath(guildId, dataDir);
  mkdirSync(join(dataDir ?? getDataDir(), "state"), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

export interface StateCacheEntry {
  guildId: string;
  path: string;
  /** File mtime as ISO timestamp (last time export/apply/UI fetch cached it). */
  fetchedAt: string;
  sizeBytes: number;
}

export function readStateCache(guildId: string, dataDir?: string): GuildState | null {
  try {
    return JSON.parse(readFileSync(stateCachePath(guildId, dataDir), "utf8")) as GuildState;
  } catch {
    return null;
  }
}

export function listStateCaches(dataDir?: string): StateCacheEntry[] {
  const dir = join(dataDir ?? getDataDir(), "state");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: StateCacheEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let st: Stats | null = null;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    out.push({
      guildId: name.slice(0, -".json".length),
      path,
      fetchedAt: st.mtime.toISOString(),
      sizeBytes: st.size,
    });
  }
  return out.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

export function backupDir(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), "backups");
}

/**
 * Retention: keep only the latest `keep` backups for a guild, deleting
 * older ones. Backup filenames embed an ISO timestamp, so lexicographic
 * order is chronological order. Returns the deleted paths (best effort —
 * unlink failures are skipped, not thrown).
 */
export function pruneOldBackups(guildId: string, keep: number, dataDir?: string): string[] {
  if (!Number.isInteger(keep) || keep < 1) return [];
  const dir = backupDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = `${guildId}_`;
  const files = names.filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl")).sort();
  const toDelete = files.slice(0, Math.max(0, files.length - keep)).map((n) => join(dir, n));
  for (const p of toDelete) {
    try {
      unlinkSync(p);
    } catch {
      // best effort — a missing file is fine
    }
  }
  return toDelete;
}

export function writeBackup(guildId: string, state: GuildState): string {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${guildId}_${stamp}.jsonl`);
  const lines = [
    JSON.stringify({ type: "meta", timestamp: new Date().toISOString(), guildId }),
    JSON.stringify({ type: "guild", data: state.guild }),
    ...state.roles.map((r) => JSON.stringify({ type: "role", data: r })),
    ...state.channels.map((c) => JSON.stringify({ type: "channel", data: c })),
    ...state.emojis.map((e) => JSON.stringify({ type: "emoji", data: e })),
    ...state.stickers.map((s) => JSON.stringify({ type: "sticker", data: s })),
    ...state.webhooks.map((w) => JSON.stringify({ type: "webhook", data: w })),
    ...state.autoModRules.map((a) => JSON.stringify({ type: "auto_mod_rule", data: a })),
    JSON.stringify({ type: "welcome_screen", data: state.welcomeScreen }),
    JSON.stringify({ type: "onboarding", data: state.onboarding }),
    JSON.stringify({ type: "vanity_url", data: state.vanityUrl }),
    JSON.stringify({ type: "widget", data: state.widget }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}
