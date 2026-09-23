#!/usr/bin/env npx tsx
/**
 * Start the local visual config builder.
 *
 *   npx tsx ui.ts
 *   npx tsx ui.ts examples/server-config.yaml
 *   npx tsx ui.ts path/to/config.yaml --port 4000
 *   npm run ui
 */
import { config as loadEnv } from "dotenv";
import { runUi } from "./src/commands/ui.js";

loadEnv({ quiet: true });

function usage(): never {
  console.error(`Usage: npx tsx ui.ts [config] [--port N] [--host HOST] [-g guild] [-t token]

Defaults:
  config  examples/server-config.yaml
  port    3847
  host    127.0.0.1
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let config = "examples/server-config.yaml";
  let port: number | undefined;
  let host: string | undefined;
  let guild: string | undefined;
  let token: string | undefined;

  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    config = args.shift()!;
  }

  while (args.length > 0) {
    const flag = args.shift()!;
    const value = args[0];
    switch (flag) {
      case "-h":
      case "--help":
        usage();
        break;
      case "-p":
      case "--port":
        if (!value) usage();
        port = Number(args.shift());
        break;
      case "-H":
      case "--host":
        if (!value) usage();
        host = args.shift();
        break;
      case "-g":
      case "--guild":
        if (!value) usage();
        guild = args.shift();
        break;
      case "-t":
      case "--token":
        if (!value) usage();
        token = args.shift();
        break;
      default:
        console.error(`Unknown option: ${flag}`);
        usage();
    }
  }

  return { config, port, host, guild, token };
}

const opts = parseArgs(process.argv.slice(2));
process.exitCode = await runUi(opts);
