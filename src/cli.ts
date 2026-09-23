#!/usr/bin/env node
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { runApply } from "./commands/apply.js";
import { runExport } from "./commands/export.js";
import { runDiff, runPlan } from "./commands/plan.js";
import { runState } from "./commands/state.js";
import { runUi } from "./commands/ui.js";
import { runValidate } from "./commands/validate.js";
import { runWatch } from "./commands/watch.js";
import { RECOMMENDED_BOT_PERMISSIONS } from "./discord/permissions.js";

loadEnv({ quiet: true });

const program = new Command();

program
  .name("discord-manager")
  .description("Declarative Discord server reconciliation CLI")
  .version("1.0.0");

program
  .command("validate")
  .description("Validate a server config file")
  .argument("<config>", "Path to YAML/JSON config")
  .action(async (config: string) => {
    process.exitCode = runValidate(config);
  });

program
  .command("export")
  .description("Export live guild state to YAML")
  .option("-g, --guild <id>", "Guild ID")
  .option("-t, --token <token>", "Bot token")
  .option("-o, --output <file>", "Output file (default: stdout)")
  .action(async (opts) => {
    try {
      process.exitCode = await runExport(opts);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  });

program
  .command("plan")
  .description("Show the action plan to reconcile config to guild")
  .argument("<config>", "Path to YAML/JSON config")
  .option("-g, --guild <id>", "Guild ID")
  .option("-t, --token <token>", "Bot token")
  .option("--prune", "Delete resources not in config", false)
  .option("--json", "Output JSON", false)
  .action(async (config: string, opts) => {
    try {
      process.exitCode = await runPlan({ config, ...opts });
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  });

program
  .command("diff")
  .description("Alias for plan")
  .argument("<config>", "Path to YAML/JSON config")
  .option("-g, --guild <id>", "Guild ID")
  .option("-t, --token <token>", "Bot token")
  .option("--prune", "Delete resources not in config", false)
  .option("--json", "Output JSON", false)
  .action(async (config: string, opts) => {
    try {
      process.exitCode = await runDiff({ config, ...opts });
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  });

program
  .command("state")
  .description("Show cached guild state (last fetched by export/apply/UI)")
  .option("-g, --guild <id>", "Show details for one guild")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      process.exitCode = await runState({ guild: opts.guild, json: opts.json });
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  });

program
  .command("apply")
  .description("Apply config to guild")
  .argument("<config>", "Path to YAML/JSON config")
  .option("-g, --guild <id>", "Guild ID")
  .option("-t, --token <token>", "Bot token")
  .option("--prune", "Delete resources not in config", false)
  .option("--dry-run", "Print plan without applying", false)
  .option("-y, --yes", "Skip DELETE confirmation", false)
  .option("--keep <n>", "Retention: keep only the latest N backups / rotated audit logs", (v) =>
    Number(v),
  )
  .option("--no-backup", "Skip pre-apply backup")
  .option("--no-audit", "Skip mutation audit log")
  .option("--json", "Output plan as JSON", false)
  .action(async (config: string, opts) => {
    try {
      process.exitCode = await runApply({
        config,
        guild: opts.guild,
        token: opts.token,
        prune: opts.prune,
        dryRun: opts.dryRun,
        yes: opts.yes,
        keep: opts.keep,
        backup: opts.backup,
        audit: opts.audit,
        json: opts.json,
      });
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  });

program
  .command("watch")
  .description("Watch config file and reconcile on changes")
  .argument("<config>", "Path to YAML/JSON config")
  .option("-g, --guild <id>", "Guild ID")
  .option("-t, --token <token>", "Bot token")
  .option("--prune", "Delete resources not in config", false)
  .option("--auto", "Auto-apply without prompts", false)
  .option("--yes", "Skip DELETE confirmation", false)
  .option("--interval <seconds>", "Poll interval seconds", (v) => Number(v))
  .option("--keep <n>", "Retention: keep only the latest N backups / rotated audit logs", (v) =>
    Number(v),
  )
  .option(
    "--gateway",
    "Listen for Gateway drift advisories (requires the optional discord.js dep)",
    false,
  )
  .action(async (config: string, opts) => {
    try {
      process.exitCode = await runWatch({ config, ...opts });
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  });

program
  .command("invite-url")
  .description("Print an OAuth2 bot invite URL")
  .option("-c, --client-id <id>", "Application client ID", process.env.DISCORD_CLIENT_ID)
  .option("--administrator", "Use Administrator permission", false)
  .action((opts) => {
    const clientId = opts.clientId;
    if (!clientId) {
      console.error("Provide --client-id or DISCORD_CLIENT_ID");
      process.exitCode = 1;
      return;
    }
    const perms = opts.administrator ? "8" : RECOMMENDED_BOT_PERMISSIONS.toString();
    const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${perms}`;
    console.log(url);
  });

program
  .command("ui")
  .description("Open the local visual config builder WebUI")
  .argument("<config>", "Path to YAML/JSON config")
  .option("-p, --port <port>", "HTTP port", (v) => Number(v), 3847)
  .option("-H, --host <host>", "Bind host", "127.0.0.1")
  .option("-g, --guild <id>", "Guild ID (for Plan/Apply)")
  .option("-t, --token <token>", "Bot token (for Plan/Apply)")
  .action(async (config: string, opts) => {
    try {
      process.exitCode = await runUi({
        config,
        port: opts.port,
        host: opts.host,
        guild: opts.guild,
        token: opts.token,
      });
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
