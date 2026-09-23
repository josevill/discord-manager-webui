import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditLine, createAuditSession, redactPayload } from "../../src/state/audit.js";
import type { Action } from "../../src/state/types.js";

describe("redactPayload", () => {
  it("redacts data: URIs and __asset__: paths", () => {
    expect(redactPayload("data:image/png;base64,AAAA")).toBe("[REDACTED]");
    expect(redactPayload("__asset__:./icon.png")).toBe("[REDACTED]");
    expect(redactPayload("plain")).toBe("plain");
  });

  it("redacts nested payloads", () => {
    const out = redactPayload({
      name: "role",
      image: "data:image/png;base64,XYZ",
      nested: { avatar: "__asset__:./a.png", ok: 1 },
      list: ["data:image/gif;base64,G", "keep"],
    }) as Record<string, unknown>;
    expect(out.name).toBe("role");
    expect(out.image).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).avatar).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect(out.list).toEqual(["[REDACTED]", "keep"]);
  });
});

describe("createAuditSession", () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes run_start, action, and run_end lines", () => {
    dataDir = mkdtempSync(join(tmpdir(), "dm-audit-"));
    const session = createAuditSession({
      guildId: "guild-1",
      source: "cli",
      configPath: "cfg.yaml",
      prune: false,
      backupPath: "/tmp/backup.jsonl",
      dataDir,
    });

    const action: Action = {
      type: "CREATE",
      domain: "role",
      resource: "Mod",
      endpoint: "/guilds/guild-1/roles",
      method: "POST",
      payload: { name: "Mod", icon: "data:image/png;base64,SECRET" },
      reason: "create role",
      dependencies: [],
    };

    session.recordAction({
      action,
      outcome: "success",
      responseId: "role-99",
    });
    session.recordAction({
      action: { ...action, type: "UPDATE", resource: "Admin", targetId: "1" },
      outcome: "failure",
      error: "Missing Access",
    });
    session.end({ applied: 1, skipped: 0, failed: 1 });

    const path = join(dataDir, "audit", "guild-1.jsonl");
    expect(session.path).toBe(path);
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      type: "run_start",
      runId: session.runId,
      source: "cli",
      guildId: "guild-1",
      configPath: "cfg.yaml",
      prune: false,
      backupPath: "/tmp/backup.jsonl",
    });
    expect(lines[1]).toMatchObject({
      type: "action",
      outcome: "success",
      actionType: "CREATE",
      domain: "role",
      resource: "Mod",
      responseId: "role-99",
    });
    expect((lines[1]!.payload as { icon: string }).icon).toBe("[REDACTED]");
    expect(lines[2]).toMatchObject({
      type: "action",
      outcome: "failure",
      error: "Missing Access",
    });
    expect(lines[3]).toMatchObject({
      type: "run_end",
      applied: 1,
      skipped: 0,
      failed: 1,
    });
  });

  it("skips SKIP actions in recordAction", () => {
    dataDir = mkdtempSync(join(tmpdir(), "dm-audit-"));
    const session = createAuditSession({
      guildId: "g2",
      source: "ui",
      dataDir,
    });
    session.recordAction({
      action: {
        type: "SKIP",
        domain: "role",
        resource: "managed",
        endpoint: "/",
        method: "PATCH",
        payload: null,
        reason: "managed",
        dependencies: [],
        skipReason: "managed",
      },
      outcome: "success",
    });
    session.end({ applied: 0, skipped: 1, failed: 0 });

    const lines = readFileSync(join(dataDir, "audit", "g2.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("run_start");
    expect(JSON.parse(lines[1]!).type).toBe("run_end");
  });

  it("writes an interrupted run_end when the process exits before end()", () => {
    dataDir = mkdtempSync(join(tmpdir(), "dm-audit-"));
    const session = createAuditSession({ guildId: "g4", source: "cli", dataDir });
    const action: Action = {
      type: "CREATE",
      domain: "role",
      resource: "Mod",
      endpoint: "/guilds/g4/roles",
      method: "POST",
      payload: { name: "Mod" },
      reason: "create role",
      dependencies: [],
    };
    session.recordAction({ action, outcome: "success" });
    session.recordAction({
      action: { ...action, type: "DELETE", resource: "Old" },
      outcome: "failure",
      error: "boom",
    });

    // Simulate a hard exit (uncaught exception / process.exit): the exit
    // handler must append a run_end marker even though end() never ran.
    process.emit("exit", 0);

    const path = join(dataDir, "audit", "g4.jsonl");
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatchObject({
      type: "run_end",
      runId: session.runId,
      applied: 1,
      skipped: 0,
      failed: 1,
      interrupted: true,
    });

    // A late end() still writes a normal run_end and disarms the exit hook.
    session.end({ applied: 1, skipped: 0, failed: 1 });
    const after = readFileSync(path, "utf8").trim().split("\n").length;
    expect(after).toBe(5);
    process.emit("exit", 0); // no-op now: listener removed by end()
    expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(after);
  });

  it("end() is idempotent", () => {
    dataDir = mkdtempSync(join(tmpdir(), "dm-audit-"));
    const session = createAuditSession({ guildId: "g5", source: "cli", dataDir });
    session.end({ applied: 0, skipped: 0, failed: 0 });
    session.end({ applied: 9, skipped: 9, failed: 9 });
    const lines = readFileSync(join(dataDir, "audit", "g5.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ type: "run_end", applied: 0, skipped: 0, failed: 0 });
    expect(lines[1]).not.toHaveProperty("interrupted");
  });

  it("appendAuditLine creates directory and appends", () => {
    dataDir = mkdtempSync(join(tmpdir(), "dm-audit-"));
    const path = appendAuditLine(
      "g3",
      {
        type: "run_end",
        runId: "r1",
        timestamp: new Date().toISOString(),
        applied: 0,
        skipped: 0,
        failed: 0,
      },
      dataDir,
    );
    expect(path).toBe(join(dataDir, "audit", "g3.jsonl"));
    expect(readFileSync(path, "utf8").trim()).toContain('"run_end"');
  });
});
