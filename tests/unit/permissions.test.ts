import { describe, expect, it } from "vitest";
import {
  bitfieldToFlags,
  flagsToBitfield,
  PermissionFlags,
  parsePermissionInput,
  permissionsEqual,
  permissionToString,
} from "../../src/discord/permissions.js";

describe("permissions", () => {
  it("parses named flags to bigint string", () => {
    const bits = flagsToBitfield(["VIEW_CHANNEL", "SEND_MESSAGES"]);
    expect(bits).toBe(PermissionFlags.VIEW_CHANNEL | PermissionFlags.SEND_MESSAGES);
    expect(permissionToString(["VIEW_CHANNEL", "SEND_MESSAGES"])).toBe(bits.toString());
  });

  it("parses large permission strings as bigint (not Number)", () => {
    // Includes bits well above 2^32 (MODERATE_MEMBERS, CREATE_GUILD_EXPRESSIONS, …)
    const large = (
      PermissionFlags.CREATE_GUILD_EXPRESSIONS |
      PermissionFlags.MODERATE_MEMBERS |
      PermissionFlags.MANAGE_GUILD_EXPRESSIONS |
      PermissionFlags.VIEW_CHANNEL
    ).toString();
    const bits = parsePermissionInput(large);
    expect(typeof bits).toBe("bigint");
    expect(bits.toString()).toBe(large);
    expect(bits & PermissionFlags.CREATE_GUILD_EXPRESSIONS).toBe(
      PermissionFlags.CREATE_GUILD_EXPRESSIONS,
    );
  });

  it("rejects unknown flags", () => {
    expect(() => parsePermissionInput(["NOT_A_REAL_FLAG"])).toThrow(/Unknown permission flag/);
  });

  it("compares permissions equally across representations", () => {
    expect(permissionsEqual("1024", ["VIEW_CHANNEL"])).toBe(true);
    expect(permissionsEqual("8", ["ADMINISTRATOR"])).toBe(true);
  });

  it("round-trips bitfield to flags", () => {
    const flags = ["KICK_MEMBERS", "BAN_MEMBERS", "VIEW_CHANNEL"] as const;
    const bits = flagsToBitfield([...flags]);
    const back = bitfieldToFlags(bits);
    for (const f of flags) {
      expect(back).toContain(f);
    }
  });

  it("rejects unsafe numbers", () => {
    expect(() => parsePermissionInput(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
  });
});
