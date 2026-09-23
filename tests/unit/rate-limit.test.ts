import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordApiError, RateLimitedClient } from "../../src/discord/rate-limit.js";

describe("RateLimitedClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "slow down" }), {
          status: 429,
          headers: {
            "Retry-After": "0",
            "X-RateLimit-Global": "false",
            "X-RateLimit-Bucket": "b1",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset-After": "0",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Bucket": "b1",
            "X-RateLimit-Remaining": "5",
            "X-RateLimit-Reset-After": "1",
          },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new RateLimitedClient("token");
    // speed up: delay starts at 100ms — acceptable for test
    const result = await client.request<{ ok: boolean }>({
      method: "GET",
      path: "/guilds/1",
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient 5xx (500/502) with backoff then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new RateLimitedClient("token");
    const pending = client.request<{ ok: boolean }>({
      method: "GET",
      path: "/guilds/1",
    });
    // Timeline: 100 (base delay) + 500 (backoff) + 100 + 1000 (backoff) + 100
    await vi.advanceTimersByTimeAsync(1800);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after bounded retries and surfaces the 5xx error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => new Response("boom", { status: 504 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RateLimitedClient("token");
    const pending = client.request({ method: "GET", path: "/guilds/1" });
    const assertion = expect(pending).rejects.toMatchObject({ status: 504 });
    // 3 retries: base delays 100*4 + backoffs 500 + 1000 + 2000 = 3900
    await vi.advanceTimersByTimeAsync(3900);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-retryable 5xx (503)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RateLimitedClient("token");
    const pending = client.request({ method: "GET", path: "/guilds/1" });
    const assertion = expect(pending).rejects.toThrow(DiscordApiError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
