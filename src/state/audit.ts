import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./backup.js";
import type { Action, ActionDomain, ActionType } from "./types.js";

export type AuditSource = "cli" | "ui" | "watch";

export type AuditRunStart = {
  type: "run_start";
  runId: string;
  timestamp: string;
  source: AuditSource;
  guildId: string;
  configPath?: string;
  prune?: boolean;
  backupPath?: string;
};

export type AuditActionRecord = {
  type: "action";
  runId: string;
  timestamp: string;
  outcome: "success" | "failure";
  actionType: ActionType;
  domain: ActionDomain;
  resource: string;
  method: Action["method"];
  endpoint: string;
  targetId?: string;
  reason: string;
  error?: string;
  responseId?: string;
  payload: unknown;
};

export type AuditRunEnd = {
  type: "run_end";
  runId: string;
  timestamp: string;
  applied: number;
  skipped: number;
  failed: number;
  /**
   * True when this record was written by the best-effort `process.on("exit")`
   * handler because the process died (or exited) before the run's `end()` ran.
   * Counts are partial: `applied`/`failed` reflect actions recorded so far and
   * `skipped` is 0 (skips are never recorded individually).
   */
  interrupted?: boolean;
};

export type AuditRecord = AuditRunStart | AuditActionRecord | AuditRunEnd;

export interface AuditSessionOptions {
  guildId: string;
  source: AuditSource;
  configPath?: string;
  prune?: boolean;
  backupPath?: string;
  /** Override data root (tests). Defaults to ~/.discord-manager */
  dataDir?: string;
  /**
   * Retention: rotate the live audit log to `<guildId>.<stamp>.jsonl` once it
   * exceeds `maxBytes`, then keep only the latest `keep` rotated logs.
   * Omit to keep everything (default).
   */
  rotation?: AuditRotationOptions;
}

export interface AuditRotationOptions {
  /** Keep at most this many rotated `<guildId>.<stamp>.jsonl` files (oldest deleted). */
  keep: number;
  /** Rotate when the live log grows past this many bytes. Default: 5 MiB. */
  maxBytes?: number;
}

export const AUDIT_ROTATE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * File-level rotation for retention (called at session start, before the
 * new run's `run_start` is appended). If the live log for the guild exceeds
 * `maxBytes` it is renamed to `<guildId>.<stamp>.jsonl` and a fresh file is
 * started; rotated logs are then pruned to the latest `keep`. Each file
 * remains append-only — lines are never truncated or rewritten.
 */
export function rotateAuditLog(
  guildId: string,
  rotation: AuditRotationOptions,
  dataDir?: string,
): { rotatedTo?: string } {
  const dir = join(dataDir ?? getDataDir(), "audit");
  const live = auditLogPath(guildId, dataDir);
  let rotatedTo: string | undefined;
  try {
    if (statSync(live).size > (rotation.maxBytes ?? AUDIT_ROTATE_MAX_BYTES)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      rotatedTo = join(dir, `${guildId}.${stamp}.jsonl`);
      // Same-millisecond double rotation: never clobber an existing target.
      let n = 1;
      while (rotatedTo && existsSync(rotatedTo)) {
        rotatedTo = join(dir, `${guildId}.${stamp}-${n++}.jsonl`);
      }
      renameSync(live, rotatedTo);
    }
  } catch {
    // no live log yet — nothing to rotate
  }
  if (Number.isInteger(rotation.keep) && rotation.keep >= 1) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    const prefix = `${guildId}.`;
    const rotated = names
      .filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl") && n !== `${guildId}.jsonl`)
      .sort();
    for (const n of rotated.slice(0, Math.max(0, rotated.length - rotation.keep))) {
      try {
        unlinkSync(join(dir, n));
      } catch {
        // best effort
      }
    }
  }
  return rotatedTo ? { rotatedTo } : {};
}

export interface AuditSession {
  runId: string;
  path: string;
  recordAction: (input: {
    action: Action;
    outcome: "success" | "failure";
    error?: string;
    responseId?: string;
  }) => void;
  end: (counts: { applied: number; skipped: number; failed: number }) => void;
}

const REDACTED = "[REDACTED]";

export function auditLogPath(guildId: string, dataDir?: string): string {
  return join(dataDir ?? getDataDir(), "audit", `${guildId}.jsonl`);
}

export function appendAuditLine(guildId: string, record: AuditRecord, dataDir?: string): string {
  const dir = join(dataDir ?? getDataDir(), "audit");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${guildId}.jsonl`);
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  return path;
}

/**
 * Replace data: URIs and __asset__: placeholders so audit logs stay small and secret-free.
 */
export function redactPayload(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:") || value.startsWith("__asset__:")) {
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactPayload(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactPayload(v);
    }
    return out;
  }
  return value;
}

export function createAuditSession(options: AuditSessionOptions): AuditSession {
  const runId = randomUUID();
  const dataDir = options.dataDir;
  const path = auditLogPath(options.guildId, dataDir);

  if (options.rotation) {
    rotateAuditLog(options.guildId, options.rotation, dataDir);
  }

  let ended = false;
  let applied = 0;
  let failed = 0;

  appendAuditLine(
    options.guildId,
    {
      type: "run_start",
      runId,
      timestamp: new Date().toISOString(),
      source: options.source,
      guildId: options.guildId,
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.prune !== undefined ? { prune: options.prune } : {}),
      ...(options.backupPath !== undefined ? { backupPath: options.backupPath } : {}),
    },
    dataDir,
  );

  /**
   * Best-effort close on hard failure: if the process dies (uncaught
   * exception, process.exit, …) before `end()` runs, the `exit` event still
   * fires and we append an `interrupted: true` run_end so the JSONL pair is
   * complete. Not covered: SIGKILL / crashes (no user-space hook exists).
   */
  const onExit = () => {
    if (ended) return;
    try {
      appendAuditLine(
        options.guildId,
        {
          type: "run_end",
          runId,
          timestamp: new Date().toISOString(),
          applied,
          skipped: 0,
          failed,
          interrupted: true,
        },
        dataDir,
      );
    } catch {
      // best effort — never throw from an exit handler
    }
  };
  process.on("exit", onExit);

  return {
    runId,
    path,
    recordAction({ action, outcome, error, responseId }) {
      if (action.type === "SKIP") return;
      if (outcome === "success") applied += 1;
      else failed += 1;
      appendAuditLine(
        options.guildId,
        {
          type: "action",
          runId,
          timestamp: new Date().toISOString(),
          outcome,
          actionType: action.type,
          domain: action.domain,
          resource: action.resource,
          method: action.method,
          endpoint: action.endpoint,
          ...(action.targetId !== undefined ? { targetId: action.targetId } : {}),
          reason: action.reason,
          ...(error !== undefined ? { error } : {}),
          ...(responseId !== undefined ? { responseId } : {}),
          payload: redactPayload(action.payload),
        },
        dataDir,
      );
    },
    end({ applied, skipped, failed }) {
      if (ended) return;
      ended = true;
      process.removeListener("exit", onExit);
      appendAuditLine(
        options.guildId,
        {
          type: "run_end",
          runId,
          timestamp: new Date().toISOString(),
          applied,
          skipped,
          failed,
        },
        dataDir,
      );
    },
  };
}
