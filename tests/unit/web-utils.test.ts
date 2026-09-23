import { describe, expect, it } from "vitest";
import {
  formatPlanForDisplay,
  parsePlanView,
  permissionValueToFlags,
} from "../../web/src/utils.js";

describe("permissionValueToFlags", () => {
  it("decodes ADMINISTRATOR bitfield string", () => {
    expect(permissionValueToFlags("8")).toContain("ADMINISTRATOR");
  });

  it("decodes numeric bitfields", () => {
    expect(permissionValueToFlags(8)).toContain("ADMINISTRATOR");
  });

  it("passes through flag arrays", () => {
    expect(permissionValueToFlags(["VIEW_CHANNEL", "SEND_MESSAGES"])).toEqual([
      "VIEW_CHANNEL",
      "SEND_MESSAGES",
    ]);
  });

  it("returns empty for undefined", () => {
    expect(permissionValueToFlags(undefined)).toEqual([]);
  });
});

describe("formatPlanForDisplay", () => {
  it("surfaces skipReason as reason on SKIP actions", () => {
    const json = formatPlanForDisplay({
      actions: [
        {
          type: "SKIP",
          resource: "Admin",
          reason: "skipped",
          skipReason: "Desired position 10 is at/above bot highest role position 4",
        },
      ],
      warnings: ["Admin: Desired position 10 is at/above bot highest role position 4"],
    });
    const parsed = JSON.parse(json) as {
      actions: { reason: string; skipReason: string }[];
    };
    expect(parsed.actions[0]!.reason).toContain("at/above bot");
    expect(parsed.actions[0]!.skipReason).toContain("at/above bot");
  });
});

describe("parsePlanView", () => {
  it("parses ActionPlan actions and prefers skipReason", () => {
    const view = parsePlanView({
      actions: [
        {
          type: "CREATE",
          domain: "channel",
          resource: "channel-10",
          reason: "Channel channel-10 not found in category Community",
        },
        {
          type: "SKIP",
          domain: "role",
          resource: "Admin",
          reason: "skipped",
          skipReason: "Existing role position 1 is at/above bot position 1",
        },
      ],
      summary: { creates: 1, updates: 0, deletes: 0, skips: 1 },
      dry_run: true,
      warnings: ["Admin: Existing role position 1 is at/above bot position 1"],
    });

    expect(view).toEqual({
      kind: "plan",
      dryRun: true,
      summary: { creates: 1, updates: 0, deletes: 0, skips: 1 },
      actions: [
        {
          type: "CREATE",
          domain: "channel",
          resource: "channel-10",
          reason: "Channel channel-10 not found in category Community",
        },
        {
          type: "SKIP",
          domain: "role",
          resource: "Admin",
          reason: "Existing role position 1 is at/above bot position 1",
        },
      ],
    });
  });

  it("parses execute results", () => {
    const view = parsePlanView({
      applied: 2,
      skipped: 1,
      failed: [{ resource: "Admin", type: "UPDATE", error: "Missing permission" }],
    });

    expect(view).toEqual({
      kind: "execute",
      applied: 2,
      skipped: 1,
      failed: [{ resource: "Admin", type: "UPDATE", error: "Missing permission" }],
    });
  });

  it("returns null for unrecognized payloads", () => {
    expect(parsePlanView({ op: "noop" })).toBeNull();
    expect(parsePlanView(null)).toBeNull();
  });
});
