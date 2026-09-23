import { bitfieldToFlags } from "../../src/discord/permissions.js";
import type { ServerConfig } from "./types.js";

/** Fill in optional collections/objects so the UI can assume total shape. */
export function normalizeConfig(config: ServerConfig): ServerConfig {
  return {
    ...config,
    guild: config.guild ?? {},
    roles: config.roles ?? [],
    categories: config.categories ?? [],
    channels: config.channels ?? [],
    emojis: config.emojis ?? [],
    stickers: config.stickers ?? [],
    webhooks: config.webhooks ?? [],
    auto_mod: config.auto_mod ?? { rules: [] },
  };
}

/** Serialize config to YAML-ish preview without a heavy dependency in the browser. */
export function configToPreview(config: ServerConfig): string {
  try {
    return JSON.stringify(config, null, 2);
  } catch {
    return "";
  }
}

export function colorToHex(color: string | number | undefined): string {
  if (color === undefined) return "#99aab5";
  if (typeof color === "number") {
    return `#${color.toString(16).padStart(6, "0")}`;
  }
  if (color.startsWith("#")) return color;
  if (color.startsWith("0x") || color.startsWith("0X")) {
    return `#${color.slice(2).padStart(6, "0")}`;
  }
  const n = Number(color);
  if (!Number.isNaN(n)) return `#${n.toString(16).padStart(6, "0")}`;
  return "#99aab5";
}

export function hexToNumber(hex: string): number {
  const cleaned = hex.replace("#", "");
  return parseInt(cleaned, 16);
}

/** Normalize permission config values to flag names for checkbox editors. */
export function permissionValueToFlags(value: string | number | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "number") return bitfieldToFlags(BigInt(value));
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return bitfieldToFlags(trimmed);
  return trimmed.split(/[,\s]+/).filter(Boolean);
}

export type PlanActionType = "CREATE" | "UPDATE" | "DELETE" | "SKIP";

export interface PlanViewAction {
  type: PlanActionType;
  domain: string;
  resource: string;
  reason: string;
}

export interface PlanViewSummary {
  creates: number;
  updates: number;
  deletes: number;
  skips: number;
}

export type PlanView =
  | {
      kind: "plan";
      summary: PlanViewSummary;
      dryRun: boolean;
      actions: PlanViewAction[];
    }
  | {
      kind: "execute";
      applied: number;
      skipped: number;
      failed: { resource: string; type: string; error: string }[];
    };

const ACTION_TYPES: PlanActionType[] = ["CREATE", "UPDATE", "DELETE", "SKIP"];

function isActionType(value: unknown): value is PlanActionType {
  return typeof value === "string" && ACTION_TYPES.includes(value as PlanActionType);
}

function summarizeActions(actions: PlanViewAction[]): PlanViewSummary {
  return {
    creates: actions.filter((a) => a.type === "CREATE").length,
    updates: actions.filter((a) => a.type === "UPDATE").length,
    deletes: actions.filter((a) => a.type === "DELETE").length,
    skips: actions.filter((a) => a.type === "SKIP").length,
  };
}

/** Prefer skipReason on SKIP actions when displaying plan JSON. */
export function formatPlanForDisplay(plan: unknown): string {
  if (!plan || typeof plan !== "object") {
    return JSON.stringify(plan, null, 2);
  }
  const cloned = structuredClone(plan) as {
    actions?: Array<Record<string, unknown>>;
    warnings?: string[];
  };
  if (Array.isArray(cloned.actions)) {
    for (const action of cloned.actions) {
      if (action.type === "SKIP" && typeof action.skipReason === "string") {
        action.reason = action.skipReason;
      }
    }
  }
  return JSON.stringify(cloned, null, 2);
}

/** Parse API plan/apply payloads into a UI-friendly view model. */
export function parsePlanView(plan: unknown): PlanView | null {
  if (!plan || typeof plan !== "object") return null;
  const obj = plan as Record<string, unknown>;

  if (Array.isArray(obj.actions)) {
    const actions: PlanViewAction[] = [];
    for (const raw of obj.actions) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;
      if (!isActionType(a.type)) continue;
      const resource = typeof a.resource === "string" ? a.resource : "";
      const domain = typeof a.domain === "string" ? a.domain : "";
      const skipReason = typeof a.skipReason === "string" ? a.skipReason : undefined;
      const reason =
        (a.type === "SKIP" && skipReason) ||
        (typeof a.reason === "string" ? a.reason : "") ||
        skipReason ||
        "";
      actions.push({ type: a.type, domain, resource, reason });
    }
    if (actions.length === 0 && obj.actions.length > 0) return null;

    const summaryRaw = obj.summary;
    let summary: PlanViewSummary;
    if (summaryRaw && typeof summaryRaw === "object") {
      const s = summaryRaw as Record<string, unknown>;
      summary = {
        creates: typeof s.creates === "number" ? s.creates : 0,
        updates: typeof s.updates === "number" ? s.updates : 0,
        deletes: typeof s.deletes === "number" ? s.deletes : 0,
        skips: typeof s.skips === "number" ? s.skips : 0,
      };
    } else {
      summary = summarizeActions(actions);
    }

    return {
      kind: "plan",
      summary,
      dryRun: obj.dry_run === true,
      actions,
    };
  }

  if (
    typeof obj.applied === "number" ||
    typeof obj.skipped === "number" ||
    Array.isArray(obj.failed)
  ) {
    const failedRaw = Array.isArray(obj.failed) ? obj.failed : [];
    const failed: { resource: string; type: string; error: string }[] = [];
    for (const item of failedRaw) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      failed.push({
        resource: typeof f.resource === "string" ? f.resource : "",
        type: typeof f.type === "string" ? f.type : "",
        error: typeof f.error === "string" ? f.error : "",
      });
    }
    return {
      kind: "execute",
      applied: typeof obj.applied === "number" ? obj.applied : 0,
      skipped: typeof obj.skipped === "number" ? obj.skipped : 0,
      failed,
    };
  }

  return null;
}

let counter = 0;
export function uniqueName(prefix: string, existing: string[]): string {
  counter += 1;
  let name = `${prefix}-${counter}`;
  while (existing.includes(name)) {
    counter += 1;
    name = `${prefix}-${counter}`;
  }
  return name;
}
