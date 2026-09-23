import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runApplyMock } = vi.hoisted(() => ({ runApplyMock: vi.fn() }));

vi.mock("chokidar", () => ({
  watch: vi.fn(() => ({ on: vi.fn(), close: () => Promise.resolve() })),
}));

const clientInstances: unknown[] = [];
vi.mock("discord.js", () => ({
  Client: class {
    on = vi.fn();
    async login(_token: string) {
      clientInstances.push(this);
      return "token";
    }
  },
  GatewayIntentBits: { Guilds: 1, GuildModeration: 2, GuildEmojisAndStickers: 4, GuildWebhooks: 8 },
  Events: {},
}));
vi.mock("../../src/commands/apply.js", () => ({
  runApply: (...args: unknown[]) => runApplyMock(...args),
}));

import { runWatch } from "../../src/commands/watch.js";

const CONFIG = "examples/server-config.yaml";

function startWatch(extra: { auto?: boolean; yes?: boolean; gateway?: boolean } = {}): void {
  // Fire and forget: runWatch only exits via the final never-resolving wait.
  void runWatch({
    config: CONFIG,
    guild: "123",
    token: "test-token",
    ...extra,
  });
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe("runWatch", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    runApplyMock.mockResolvedValue(0);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it("--auto applies unattended (yes: true, no all-changes prompt)", async () => {
    startWatch({ auto: true });
    await tick();
    expect(runApplyMock).toHaveBeenCalledTimes(1);
    const opts = runApplyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.yes).toBe(true);
    expect(opts.confirmAll).toBe(false);
    expect(opts.source).toBe("watch");
    expect(opts.dryRun).toBeUndefined();
  });

  it("--yes also applies unattended", async () => {
    startWatch({ yes: true });
    await tick();
    const opts = runApplyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.yes).toBe(true);
    expect(opts.confirmAll).toBe(false);
  });

  it("interactive mode on a TTY prompts for ALL changes (confirmAll)", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    startWatch({});
    await tick();
    expect(runApplyMock).toHaveBeenCalledTimes(1);
    const opts = runApplyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.yes).toBe(false);
    expect(opts.confirmAll).toBe(true);
  });

  it("interactive mode without a TTY skips the reconcile instead of crashing", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    startWatch({});
    await tick();
    expect(runApplyMock).not.toHaveBeenCalled();
  });

  it("--gateway loads the (mocked) discord.js module lazily and logs in", async () => {
    clientInstances.length = 0;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    startWatch({ gateway: true });
    await tick();
    expect(clientInstances).toHaveLength(1);
  });
});
