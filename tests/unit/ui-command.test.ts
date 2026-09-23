import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWebDist, startUiServerWithFallback } from "../../src/commands/ui.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dm-ui-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ensureWebDist", () => {
  it("returns true without building when web/dist/index.html exists", async () => {
    const root = tmpDir();
    const dist = join(root, "web", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html></html>");
    await expect(ensureWebDist(root)).resolves.toBe(true);
  });

  it("returns false when the build cannot produce web/dist", async () => {
    // Empty root: `npx --no-install vite` finds no vite config/binary there.
    const root = tmpDir();
    await expect(ensureWebDist(root)).resolves.toBe(false);
  });
});

describe("startUiServerWithFallback", () => {
  it("auto-increments the port when the requested one is in use", async () => {
    // Block an ephemeral port.
    const blocker = createServer(() => {});
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const blockerPort = (blocker.address() as { port: number }).port;

    const handle = await startUiServerWithFallback({
      configPath: join(tmpDir(), "config.yaml"),
      port: blockerPort,
    });
    try {
      expect(handle.port).toBeGreaterThan(blockerPort);
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
      // The fallback port actually serves the API.
      const res = await fetch(`${handle.url}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it("rethrows non-EADDRINUSE errors", async () => {
    await expect(
      startUiServerWithFallback({
        configPath: "/definitely/not/a/real/path/config.yaml",
        host: "not-a-host",
      }),
    ).rejects.toBeDefined();
  });
});
