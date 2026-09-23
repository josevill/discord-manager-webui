import { loadConfig } from "../config/loader.js";
import { validateCrossReferences } from "../config/validate.js";
import { DiscordRestClient, fetchGuildState } from "../discord/client.js";
import { buildActionPlan, formatPlanTable, urlAssetHashesFor } from "../reconcile/plan.js";
import { getGuildId, getToken, printJson } from "./util.js";

export async function runPlan(options: {
  config: string;
  guild?: string;
  token?: string;
  prune?: boolean;
  json?: boolean;
}): Promise<number> {
  const loaded = loadConfig(options.config);
  const validation = validateCrossReferences(loaded.config);
  if (!validation.ok) {
    for (const i of validation.issues.filter((x) => x.level === "error")) {
      console.error(`ERROR ${i.path}: ${i.message}`);
    }
    return 1;
  }

  const client = new DiscordRestClient(getToken(options.token));
  const guildId = getGuildId(options.guild);
  const state = await fetchGuildState(client, guildId);

  for (const w of state.warnings) console.warn(`warn: ${w}`);

  const plan = buildActionPlan({
    config: loaded.config,
    state,
    baseDir: loaded.baseDir,
    prune: options.prune ?? false,
    dryRun: true,
    urlAssetHashes: await urlAssetHashesFor(client, loaded.config),
  });

  if (options.json) {
    printJson(plan);
  } else {
    console.log(formatPlanTable(plan));
  }
  return 0;
}

export async function runDiff(options: {
  config: string;
  guild?: string;
  token?: string;
  prune?: boolean;
  json?: boolean;
}): Promise<number> {
  return runPlan(options);
}
