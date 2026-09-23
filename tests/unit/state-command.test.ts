import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runState } from "../../src/commands/state.js";
import type { GuildState } from "../../src/state/types.js";

let dataDir: string;

function seedState(guildId: string): void {
  const state = {
    guild: { id: guildId, name: `Guild ${guildId}` },
    roles: [
      { id: "r1", name: "Admin" },
      { id: "r2", name: "Bot" },
    ],
    channels: [
      { id: "c1", name: "general", type: 0 },
      { id: "c2", name: "cats", type: 4 },
    ],
    emojis: [{ id: "e1", name: "fire" }],
    stickers: [],
    webhooks: [],
    autoModRules: [],
    welcomeScreen: null,
    onboarding: null,
    vanityUrl: null,
    widget: null,
    botRoleIds: [],
    warnings: ["welcome-screen: 404"],
  } as unknown as GuildState;
  mkdirSync(join(dataDir, "state"), { recursive: true });
  writeFileSync(join(dataDir, "state", `${guildId}.json`), JSON.stringify(state));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "dm-state-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("runState", () => {
  it("lists cached guilds with fetched-at metadata", async () => {
    seedState("111");
    seedState("222");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runState({ dataDir })).toBe(0);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("111");
    expect(out).toContain("222");
    expect(out).toContain("discord-manager state --guild");
  });

  it("reports an empty cache dir without failing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runState({ dataDir })).toBe(0);
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("No cached guild state");
  });

  it("shows per-guild detail with counts and warnings", async () => {
    seedState("111");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runState({ guild: "111", dataDir })).toBe(0);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("Guild:      111");
    expect(out).toContain("2 roles");
    expect(out).toContain("1 categories");
    expect(out).toContain("2 channels");
    expect(out).toContain("1 emojis");
    expect(out).toContain("warn: welcome-screen: 404");
  });

  it("exits 1 for an unknown guild", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runState({ guild: "404", dataDir })).toBe(1);
    expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("No cached state");
  });

  it("emits JSON for both views", async () => {
    seedState("111");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runState({ json: true, dataDir })).toBe(0);
    const list = JSON.parse(log.mock.calls[0]![0] as string);
    expect(Array.isArray(list)).toBe(true);
    expect(list[0]!.guildId).toBe("111");

    log.mockClear();
    expect(await runState({ guild: "111", json: true, dataDir })).toBe(0);
    const detail = JSON.parse(log.mock.calls[0]![0] as string);
    expect(detail.counts.roles).toBe(2);
    expect(detail.warnings).toEqual(["welcome-screen: 404"]);
  });
});
