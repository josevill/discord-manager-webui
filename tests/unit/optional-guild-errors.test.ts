import { describe, expect, it } from "vitest";
import { isExpectedOptionalGuildError } from "../../src/discord/client.js";
import { DiscordApiError } from "../../src/discord/rate-limit.js";

describe("DiscordApiError.discordCode", () => {
  it("parses JSON error code", () => {
    const err = new DiscordApiError(
      404,
      "GET",
      "/guilds/1/welcome-screen",
      JSON.stringify({ message: "Unknown Guild Welcome Screen", code: 10069 }),
    );
    expect(err.discordCode).toBe(10069);
  });

  it("returns undefined for non-JSON body", () => {
    const err = new DiscordApiError(500, "GET", "/x", "not json");
    expect(err.discordCode).toBeUndefined();
  });
});

describe("isExpectedOptionalGuildError", () => {
  it("silences welcome-screen 10069", () => {
    const err = new DiscordApiError(
      404,
      "GET",
      "/guilds/1/welcome-screen",
      JSON.stringify({ message: "Unknown Guild Welcome Screen", code: 10069 }),
    );
    expect(isExpectedOptionalGuildError("welcome-screen", err)).toBe(true);
  });

  it("silences vanity-url Missing Access 50001", () => {
    const err = new DiscordApiError(
      403,
      "GET",
      "/guilds/1/vanity-url",
      JSON.stringify({ message: "Missing Access", code: 50001 }),
    );
    expect(isExpectedOptionalGuildError("vanity-url", err)).toBe(true);
  });

  it("still flags unexpected welcome-screen errors", () => {
    const err = new DiscordApiError(
      403,
      "GET",
      "/guilds/1/welcome-screen",
      JSON.stringify({ message: "Missing Access", code: 50001 }),
    );
    expect(isExpectedOptionalGuildError("welcome-screen", err)).toBe(false);
  });

  it("still flags unexpected vanity-url errors", () => {
    const err = new DiscordApiError(
      500,
      "GET",
      "/guilds/1/vanity-url",
      JSON.stringify({ message: "boom", code: 0 }),
    );
    expect(isExpectedOptionalGuildError("vanity-url", err)).toBe(false);
  });

  it("rejects non-DiscordApiError", () => {
    expect(isExpectedOptionalGuildError("welcome-screen", new Error("x"))).toBe(false);
  });
});
