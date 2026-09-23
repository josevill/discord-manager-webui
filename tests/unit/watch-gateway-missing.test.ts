import { describe, expect, it, vi } from "vitest";

const { runApplyMock } = vi.hoisted(() => ({ runApplyMock: vi.fn() }));

vi.mock("chokidar", () => ({
  watch: vi.fn(() => ({ on: vi.fn(), close: () => Promise.resolve() })),
}));
// Simulate the optional dependency being absent (e.g. `npm install --omit=optional`).
vi.mock("discord.js", async () => {
  throw Object.assign(new Error("Cannot find package 'discord.js'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});
vi.mock("../../src/commands/apply.js", () => ({
  runApply: (...args: unknown[]) => runApplyMock(...args),
}));

import { runWatch } from "../../src/commands/watch.js";

describe("runWatch --gateway without discord.js installed", () => {
  it("fails fast with an install hint before any reconcile runs", async () => {
    runApplyMock.mockResolvedValue(0);
    await expect(
      runWatch({ config: "x.yaml", guild: "123", token: "test-token", gateway: true }),
    ).rejects.toThrow(/discord\.js is required for --gateway.*npm install discord\.js/s);
    // Fail fast: no apply happened before the error surfaced.
    expect(runApplyMock).not.toHaveBeenCalled();
  });
});
