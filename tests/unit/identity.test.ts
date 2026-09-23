import { describe, expect, it } from "vitest";
import {
  botHighestPosition,
  findCategoryByName,
  findChannelByNameAndParent,
  findRoleByName,
} from "../../src/reconcile/identity.js";
import type { DiscordChannel, DiscordRole } from "../../src/state/types.js";

const roles: DiscordRole[] = [
  {
    id: "1",
    name: "@everyone",
    color: 0,
    hoist: false,
    position: 0,
    permissions: "0",
    managed: false,
    mentionable: false,
  },
  {
    id: "2",
    name: "Admin",
    color: 0xff0000,
    hoist: true,
    position: 5,
    permissions: "8",
    managed: false,
    mentionable: true,
  },
  {
    id: "3",
    name: "BotRole",
    color: 0,
    hoist: false,
    position: 4,
    permissions: "0",
    managed: true,
    mentionable: false,
  },
];

const channels: DiscordChannel[] = [
  {
    id: "c1",
    type: 4,
    name: "Info",
    position: 0,
    parent_id: null,
    permission_overwrites: [],
  },
  {
    id: "c2",
    type: 0,
    name: "general",
    position: 0,
    parent_id: "c1",
    permission_overwrites: [],
  },
  {
    id: "c3",
    type: 0,
    name: "general",
    position: 1,
    parent_id: null,
    permission_overwrites: [],
  },
];

describe("identity", () => {
  it("finds roles by name and skips managed when using findRoleByName", () => {
    expect(findRoleByName(roles, "Admin")?.id).toBe("2");
    expect(findRoleByName(roles, "BotRole")).toBeUndefined();
  });

  it("matches channels by name + parent", () => {
    expect(findChannelByNameAndParent(channels, "general", "c1")?.id).toBe("c2");
    expect(findChannelByNameAndParent(channels, "general", null)?.id).toBe("c3");
  });

  it("finds categories by name", () => {
    expect(findCategoryByName(channels, "Info")?.id).toBe("c1");
  });

  it("computes bot highest position", () => {
    expect(botHighestPosition(roles, ["3"])).toBe(4);
    expect(botHighestPosition(roles, ["2", "3"])).toBe(5);
  });
});
