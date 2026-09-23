/**
 * Starts the UI server against a fresh copy of the example config.
 * Used by Playwright webServer.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startUiServer } from "../src/web/server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "tests/web/.tmp");
mkdirSync(fixtureDir, { recursive: true });
const configPath = join(fixtureDir, "server-config.yaml");
copyFileSync(join(root, "examples/server-config.yaml"), configPath);

// Ensure Plan/Apply stay gated during UI self-tests
delete process.env.DISCORD_TOKEN;
delete process.env.DISCORD_GUILD_ID;

const port = Number(process.env.PORT ?? 3847);
const staticDir = join(root, "web/dist");

const handle = await startUiServer({
  configPath,
  host: "127.0.0.1",
  port,
  staticDir,
});

console.log(`UI test server ready at ${handle.url}`);
console.log(`CONFIG=${configPath}`);

process.env.DISCORD_MANAGER_UI_CONFIG = configPath;

await new Promise<void>((resolveStop) => {
  const stop = () => {
    void handle.close().finally(() => resolveStop());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
