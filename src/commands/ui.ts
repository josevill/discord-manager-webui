import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startUiServer, type UiServerHandle } from "../web/server.js";

const DEFAULT_PORT = 3847;
const MAX_PORT_ATTEMPTS = 10;

/** Package root: walk up to the nearest directory with a package.json (works from both src/ and dist/). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the package root (package.json) above the ui command");
}

export function webDistDir(root: string = packageRoot()): string {
  return join(root, "web", "dist");
}

/**
 * Ensure the WebUI build (`web/dist`) exists, building it on first use so
 * `npm run ui` works without a separate build step. Returns true when the
 * dist is available.
 */
export async function ensureWebDist(root: string = packageRoot()): Promise<boolean> {
  const dist = join(webDistDir(root), "index.html");
  if (existsSync(dist)) return true;

  console.log("web/dist not found — building the WebUI (first run) …");
  const result = spawnSync(
    "npx",
    ["--no-install", "vite", "build", "--config", "web/vite.config.ts"],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (result.status !== 0 || !existsSync(dist)) {
    console.error("\nWebUI build failed. Run it manually with:");
    console.error("  npm run build:web");
    return false;
  }
  console.log("WebUI build complete.");
  return true;
}

/** Start the UI server, auto-incrementing the port on EADDRINUSE. */
export async function startUiServerWithFallback(options: {
  configPath: string;
  host?: string;
  port?: number;
  token?: string;
  guildId?: string;
}): Promise<UiServerHandle> {
  const host = options.host ?? "127.0.0.1";
  let port = options.port ?? DEFAULT_PORT;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      return await startUiServer({
        configPath: options.configPath,
        host,
        port,
        token: options.token,
        guildId: options.guildId,
      });
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EADDRINUSE") throw e;
      const used = port;
      port += 1;
      console.log(`Port ${used} is already in use — trying port ${port}…`);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not bind to any of ports ${options.port ?? DEFAULT_PORT}–${port - 1}`);
}

export async function runUi(options: {
  config: string;
  port?: number;
  host?: string;
  token?: string;
  guild?: string;
}): Promise<number> {
  const root = packageRoot();
  if (!(await ensureWebDist(root))) {
    return 1;
  }

  const configPath = resolve(process.cwd(), options.config);
  let handle: UiServerHandle;
  try {
    handle = await startUiServerWithFallback({
      configPath,
      port: options.port,
      host: options.host,
      token: options.token,
      guildId: options.guild,
    });
  } catch (e) {
    console.error(`Failed to start the UI server: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  console.log(`discord-manager UI listening on ${handle.url}`);
  console.log(`Config: ${configPath}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolveStop) => {
    const stop = () => {
      void handle.close().finally(() => resolveStop());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  return 0;
}
