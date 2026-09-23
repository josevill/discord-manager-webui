import { loadConfig } from "../config/loader.js";
import { validateCrossReferences } from "../config/validate.js";
import { DiscordRestClient, fetchGuildState } from "../discord/client.js";
import { confirmDeletes, executePlan } from "../reconcile/execute.js";
import { buildActionPlan, formatPlanTable, urlAssetHashesFor } from "../reconcile/plan.js";
import { resolvedFromState } from "../reconcile/resolved.js";
import { type AuditSource, createAuditSession } from "../state/audit.js";
import { pruneOldBackups, writeBackup, writeStateCache } from "../state/backup.js";
import { getGuildId, getToken, printJson, promptYesNo } from "./util.js";

export async function runApply(options: {
  config: string;
  guild?: string;
  token?: string;
  prune?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** Retention: keep only the latest N backups + rotated audit logs. */
  keep?: number;
  /** Require confirmation for every actionable change, not just DELETEs. */
  confirmAll?: boolean;
  backup?: boolean;
  audit?: boolean;
  json?: boolean;
  source?: AuditSource;
}): Promise<number> {
  const source: AuditSource = options.source ?? "cli";
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
  writeStateCache(guildId, state);

  for (const w of state.warnings) console.warn(`warn: ${w}`);

  const plan = buildActionPlan({
    config: loaded.config,
    state,
    baseDir: loaded.baseDir,
    prune: options.prune ?? false,
    dryRun: options.dryRun ?? false,
    urlAssetHashes: await urlAssetHashesFor(client, loaded.config),
  });

  if (options.json) {
    printJson(plan);
  } else {
    console.log(formatPlanTable(plan));
  }

  const actionable = plan.actions.filter((a) => a.type !== "SKIP");
  if (actionable.length === 0) {
    console.log("Nothing to apply — guild already matches config.");
    return 0;
  }

  if (options.dryRun) {
    console.log("Dry-run complete; no changes applied.");
    return 0;
  }

  const ok = await confirmDeletes(plan, options.yes ?? false, promptYesNo, {
    all: options.confirmAll ?? false,
  });
  if (!ok) {
    console.log("Aborted.");
    return 1;
  }

  let backupPath: string | undefined;
  if (options.backup !== false) {
    backupPath = writeBackup(guildId, state);
    console.log(`Backup written: ${backupPath}`);
    if (options.keep && options.keep >= 1) {
      for (const deleted of pruneOldBackups(guildId, options.keep)) {
        console.log(`Backup rotated out: ${deleted}`);
      }
    }
  }

  const audit =
    options.audit !== false
      ? createAuditSession({
          guildId,
          source,
          configPath: options.config,
          prune: options.prune ?? false,
          backupPath,
          ...(options.keep && options.keep >= 1 ? { rotation: { keep: options.keep } } : {}),
        })
      : undefined;

  const result = await executePlan({
    client,
    plan,
    guildId,
    baseDir: loaded.baseDir,
    dryRun: false,
    initialResolved: resolvedFromState(state),
    onAction: (action, index, total) => {
      console.log(`[${index + 1}/${total}] ${action.type} ${action.domain} ${action.resource}`);
    },
    onActionResult: (info) => {
      if (!audit) return;
      if (info.status !== "success" && info.status !== "failure") return;
      if (info.action.type === "SKIP") return;
      audit.recordAction({
        action: info.action,
        outcome: info.status,
        error: info.error,
        responseId: info.responseId,
      });
    },
  });

  if (audit) {
    audit.end({
      applied: result.applied,
      skipped: result.skipped,
      failed: result.failed.length,
    });
    console.log(`Audit written: ${audit.path}`);
  }

  console.log(
    `Applied ${result.applied}, skipped ${result.skipped}, failed ${result.failed.length}`,
  );
  for (const f of result.failed) {
    console.error(`FAIL ${f.action.type} ${f.action.resource}: ${f.error}`);
  }

  return result.failed.length > 0 ? 1 : 0;
}
