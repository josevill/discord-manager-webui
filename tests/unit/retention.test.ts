import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditSession, rotateAuditLog } from "../../src/state/audit.js";
import {
  listStateCaches,
  pruneOldBackups,
  readStateCache,
  writeStateCache,
} from "../../src/state/backup.js";
import type { GuildState } from "../../src/state/types.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "dm-retention-"));
});

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function fakeState(guildId: string): GuildState {
  return {
    guild: {
      id: guildId,
      name: "t",
      icon: null,
      splash: null,
      banner: null,
      description: null,
      system_channel_id: null,
      rules_channel_id: null,
      public_updates_channel_id: null,
      afk_channel_id: null,
      afk_timeout: 0,
      verification_level: 0,
      explicit_content_filter: 0,
      default_message_notifications: 0,
      features: [],
      preferred_locale: "en-US",
      system_channel_flags: 0,
      premium_progress_bar_enabled: false,
      premium_tier: 0,
    },
    roles: [],
    channels: [],
    emojis: [],
    stickers: [],
    webhooks: [],
    autoModRules: [],
    welcomeScreen: null,
    onboarding: null,
    vanityUrl: null,
    widget: null,
    botRoleIds: [],
    warnings: [],
  };
}

describe("pruneOldBackups", () => {
  it("keeps the latest N backups and deletes older ones", () => {
    const dir = join(dataDir, "backups");
    mkdirSync(dir, { recursive: true });
    const stamps = [
      "2026-01-01T00-00-00-000Z",
      "2026-01-02T00-00-00-000Z",
      "2026-01-03T00-00-00-000Z",
      "2026-01-04T00-00-00-000Z",
      "2026-01-05T00-00-00-000Z",
    ];
    for (const s of stamps) writeFileSync(join(dir, `g1_${s}.jsonl`), "x");
    // Other guild + non-backup files must be untouched.
    writeFileSync(join(dir, "g2_2020-01-01T00-00-00-000Z.jsonl"), "x");
    writeFileSync(join(dir, "g1-not-a-backup.json"), "x");

    const deleted = pruneOldBackups("g1", 2, dataDir);

    expect(deleted).toHaveLength(3);
    const remaining = readdirSync(dir);
    expect(remaining).toEqual(
      expect.arrayContaining([
        "g1_2026-01-04T00-00-00-000Z.jsonl",
        "g1_2026-01-05T00-00-00-000Z.jsonl",
        "g2_2020-01-01T00-00-00-000Z.jsonl",
        "g1-not-a-backup.json",
      ]),
    );
    expect(remaining).toHaveLength(4);
  });

  it("is a no-op when there are fewer backups than keep", () => {
    const dir = join(dataDir, "backups");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "g1_2026-01-01T00-00-00-000Z.jsonl"), "x");
    expect(pruneOldBackups("g1", 10, dataDir)).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("rejects keep < 1 and missing dirs", () => {
    const dir = join(dataDir, "backups");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "g1_2026-01-01T00-00-00-000Z.jsonl"), "x");
    expect(pruneOldBackups("g1", 0, dataDir)).toEqual([]);
    expect(pruneOldBackups("g1", NaN, dataDir)).toEqual([]);
    expect(pruneOldBackups("missing", 1, join(dataDir, "nope"))).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("audit log rotation", () => {
  function seedLiveLog(guildId: string, size: number): string {
    const dir = join(dataDir, "audit");
    mkdirSync(dir, { recursive: true });
    const live = join(dir, `${guildId}.jsonl`);
    writeFileSync(live, "x".repeat(size));
    return live;
  }

  it("rotates the live log past maxBytes and starts a fresh file", () => {
    seedLiveLog("g9", 100);
    const { rotatedTo } = rotateAuditLog("g9", { keep: 3, maxBytes: 10 }, dataDir);
    expect(rotatedTo).toBeDefined();
    expect(readdirSync(join(dataDir, "audit"))).toContain(basename(rotatedTo!));
    expect(readFileSync(rotatedTo!, "utf8")).toHaveLength(100);
    expect(readdirSync(join(dataDir, "audit"))).not.toContain("g9.jsonl");
  });

  it("does not rotate under the threshold", () => {
    seedLiveLog("g9", 10);
    expect(rotateAuditLog("g9", { keep: 3, maxBytes: 100 }, dataDir)).toEqual({});
    expect(readdirSync(join(dataDir, "audit"))).toEqual(["g9.jsonl"]);
  });

  it("prunes rotated logs down to the latest keep", () => {
    const dir = join(dataDir, "audit");
    mkdirSync(dir, { recursive: true });
    for (const s of [
      "2026-01-01T00-00-00-000Z",
      "2026-01-02T00-00-00-000Z",
      "2026-01-03T00-00-00-000Z",
    ]) {
      writeFileSync(join(dir, `g9.${s}.jsonl`), "old");
    }
    writeFileSync(join(dir, "g9.jsonl"), "live");
    // Another guild's rotated log must survive.
    writeFileSync(join(dir, "other.2020-01-01T00-00-00-000Z.jsonl"), "x");

    rotateAuditLog("g9", { keep: 1, maxBytes: Number.MAX_SAFE_INTEGER }, dataDir);

    expect(readdirSync(dir).sort()).toEqual([
      "g9.2026-01-03T00-00-00-000Z.jsonl",
      "g9.jsonl",
      "other.2020-01-01T00-00-00-000Z.jsonl",
    ]);
  });

  it("createAuditSession rotates before appending run_start and keeps the live log append-only", () => {
    const live = seedLiveLog("g7", 50);
    const session = createAuditSession({
      guildId: "g7",
      source: "cli",
      dataDir,
      rotation: { keep: 2, maxBytes: 10 },
    });
    session.end({ applied: 0, skipped: 1, failed: 0 });

    const files = readdirSync(join(dataDir, "audit"));
    expect(files).toContain("g7.jsonl");
    const rotated = files.filter((f) => f !== "g7.jsonl");
    expect(rotated).toHaveLength(1);
    // Old content landed in the rotated file; new records in the live file.
    expect(readFileSync(join(dataDir, "audit", rotated[0]!), "utf8")).toHaveLength(50);
    const liveLines = readFileSync(live, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(liveLines.map((r) => r.type)).toEqual(["run_start", "run_end"]);
  });
});

describe("state cache read API", () => {
  it("writeStateCache → readStateCache round-trips and lists entries", () => {
    writeStateCache("cache-1", fakeState("cache-1"), dataDir);
    const state = readStateCache("cache-1", dataDir);
    expect(state).not.toBeNull();
    expect(state!.guild.id).toBe("cache-1");

    const entries = listStateCaches(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.guildId).toBe("cache-1");
    expect(entries[0]!.fetchedAt).toBeTruthy();
    expect(entries[0]!.sizeBytes).toBeGreaterThan(0);
  });

  it("readStateCache returns null for unknown/corrupt entries and list handles missing dir", () => {
    expect(readStateCache("nope", dataDir)).toBeNull();
    const dir = join(dataDir, "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(readStateCache("bad", dataDir)).toBeNull();
    expect(listStateCaches(join(dataDir, "missing"))).toEqual([]);
    // Corrupt files are listed (metadata only) but not parseable.
    expect(listStateCaches(dataDir).map((e) => e.guildId)).toEqual(["bad"]);
  });
});
