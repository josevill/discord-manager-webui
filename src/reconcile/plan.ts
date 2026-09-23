import type { ServerConfig } from "../config/schema.js";
import type { DiscordRestClient } from "../discord/client.js";
import type { Action, ActionPlan, GuildState } from "../state/types.js";
import { summarizePlan } from "../state/types.js";
import {
  type DiffContext,
  diffAutoMod,
  diffCategories,
  diffChannelPositions,
  diffChannels,
  diffEmojis,
  diffGuild,
  diffGuildChannelRefs,
  diffRoles,
  diffStickers,
  diffWebhooks,
  diffWelcomeAndOnboarding,
  diffWidgetAndVanity,
} from "./diff.js";

export interface BuildPlanOptions {
  config: ServerConfig;
  state: GuildState;
  baseDir?: string;
  prune?: boolean;
  dryRun?: boolean;
  /**
   * Pre-fetched sha1 hashes for `http(s)://`-valued asset fields (see
   * `urlAssetHashesFor`). Without it, URL assets are assumed unchanged.
   */
  urlAssetHashes?: Map<string, string | null>;
}

export function buildActionPlan(options: BuildPlanOptions): ActionPlan {
  const ctx: DiffContext = {
    config: options.config,
    state: options.state,
    baseDir: options.baseDir ?? process.cwd(),
    prune: options.prune ?? false,
    urlAssetHashes: options.urlAssetHashes,
  };

  const actions: Action[] = [
    ...diffGuild(ctx),
    ...diffRoles(ctx),
    ...diffCategories(ctx),
    ...diffChannels(ctx),
    ...diffEmojis(ctx),
    ...diffStickers(ctx),
    ...diffWebhooks(ctx),
    ...diffAutoMod(ctx),
    ...diffWelcomeAndOnboarding(ctx),
    ...diffWidgetAndVanity(ctx),
    // Order-sensitive trailing actions: channel reorder uses a full snapshot of
    // per-parent positions, and guild channel refs need channels (created or
    // moved earlier in the plan) to be resolvable.
    ...diffChannelPositions(ctx),
    ...diffGuildChannelRefs(ctx),
  ];

  return summarizePlan(actions, options.dryRun ?? false);
}

export function formatPlanTable(plan: ActionPlan): string {
  const lines: string[] = [];
  lines.push(
    `Plan: ${plan.summary.creates} create, ${plan.summary.updates} update, ${plan.summary.deletes} delete, ${plan.summary.skips} skip`,
  );
  if (plan.dry_run) lines.push("(dry-run)");
  lines.push("");
  lines.push(`${pad("TYPE", 8)}${pad("DOMAIN", 22)}${pad("RESOURCE", 28)}REASON`);
  lines.push("-".repeat(90));
  for (const a of plan.actions) {
    const reason = a.skipReason ?? a.reason;
    lines.push(pad(a.type, 8) + pad(a.domain, 22) + pad(a.resource, 28) + truncate(reason, 60));
  }
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

function pad(s: string, n: number): string {
  return (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
}

/** Every `http(s)://`-valued image asset in the config, de-duplicated. */
export function collectUrlAssets(config: ServerConfig): string[] {
  const urls = new Set<string>();
  const add = (v: string | null | undefined) => {
    if (v && /^https?:\/\//i.test(v)) urls.add(v);
  };
  add(config.guild.icon);
  add(config.guild.banner);
  add(config.guild.splash);
  add(config.invite_splash);
  for (const r of config.roles) add(r.icon);
  for (const e of config.emojis) add(e.image);
  for (const s of config.stickers) add(s.image);
  for (const w of config.webhooks) add(w.avatar);
  return [...urls];
}

/**
 * Download + sha1 every URL-valued asset in the config (bounded concurrency)
 * so the diff can compare them against live asset hashes. Returns an empty map
 * when the config has no URL assets (no network traffic).
 */
export async function urlAssetHashesFor(
  client: DiscordRestClient,
  config: ServerConfig,
): Promise<Map<string, string | null>> {
  const urls = collectUrlAssets(config);
  const map = new Map<string, string | null>();
  if (urls.length === 0) return map;
  let next = 0;
  const workers = Array.from({ length: Math.min(8, urls.length) }, async () => {
    while (next < urls.length) {
      const i = next;
      next += 1;
      const url = urls[i]!;
      map.set(url, await client.fetchAssetHash(url));
    }
  });
  await Promise.all(workers);
  return map;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
