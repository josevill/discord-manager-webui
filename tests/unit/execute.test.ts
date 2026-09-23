import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordRestClient } from "../../src/discord/client.js";
import {
  executePlan,
  loadAssetBytes,
  loadAssetDataUri,
  resolvePlaceholders,
} from "../../src/reconcile/execute.js";
import type { ActionPlan } from "../../src/state/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function abuf(bytes: number[]): ArrayBuffer {
  const b = Buffer.from(bytes);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("loadAssetBytes / loadAssetDataUri", () => {
  it("passes through data: URIs", async () => {
    const b64 = Buffer.from([1, 2, 3]).toString("base64");
    const out = await loadAssetBytes("/tmp", `data:image/png;base64,${b64}`);
    expect(out.bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(out.contentType).toBe("image/png");
  });

  it("reads local files and derives the mime from the extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-exec-asset-"));
    try {
      writeFileSync(join(dir, "a.apng"), Buffer.from([9, 9]));
      const out = await loadAssetBytes(dir, "a.apng");
      expect(out.bytes).toEqual(Buffer.from([9, 9]));
      expect(out.filename).toBe("a.apng");
      expect(out.contentType).toBe("image/apng");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads http(s) assets anonymously from non-Discord hosts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/webp" }),
      arrayBuffer: async () => abuf([4, 5, 6]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await loadAssetBytes("/tmp", "https://static.example/img.png", "tok");
    expect(out.bytes).toEqual(Buffer.from([4, 5, 6]));
    expect(out.contentType).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledWith("https://static.example/img.png", {
      headers: {},
    });
  });

  it("sends the bot token only to Discord CDN hosts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => abuf([4, 5, 6]),
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadAssetBytes("/tmp", "https://cdn.discordapp.com/emojis/1.png", "tok");
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.discordapp.com/emojis/1.png", {
      headers: { Authorization: "Bot tok" },
    });
  });

  it("throws a readable error when the URL download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, headers: new Headers() }),
    );
    await expect(loadAssetDataUri("/tmp", "https://static.example/missing.png")).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe("resolvePlaceholders (async asset download)", () => {
  it("resolves __asset__ URL values to data URIs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => abuf([7, 8]),
      }),
    );
    const out = (await resolvePlaceholders(
      { image: "__asset__:https://static.example/x.png" },
      new Map(),
      "/tmp",
    )) as { image: string };
    expect(out.image).toBe(`data:image/png;base64,${Buffer.from([7, 8]).toString("base64")}`);
  });
});

describe("executePlan abort signal", () => {
  function twoCreatePlan(): ActionPlan {
    return {
      actions: [
        {
          type: "CREATE",
          domain: "role",
          resource: "A",
          endpoint: "/guilds/g1/roles",
          method: "POST",
          payload: { name: "A" },
          reason: "create role",
          dependencies: [],
        },
        {
          type: "CREATE",
          domain: "role",
          resource: "B",
          endpoint: "/guilds/g1/roles",
          method: "POST",
          payload: { name: "B" },
          reason: "create role",
          dependencies: [],
        },
      ],
      summary: { creates: 2, updates: 0, deletes: 0, skips: 0 },
      dry_run: false,
      warnings: [],
    };
  }

  it("makes no API calls when the signal is already aborted", async () => {
    const post = vi.fn();
    const client = {
      token: "t",
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as DiscordRestClient;
    const controller = new AbortController();
    controller.abort();

    const result = await executePlan({
      client,
      plan: twoCreatePlan(),
      guildId: "g1",
      baseDir: "/tmp",
      signal: controller.signal,
    });

    expect(result.applied).toBe(0);
    expect(result.failed).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("stops issuing calls once the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const post = vi.fn().mockResolvedValue({ id: "role-1" });
    const client = {
      token: "t",
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as DiscordRestClient;

    const seen: string[] = [];
    const result = await executePlan({
      client,
      plan: twoCreatePlan(),
      guildId: "g1",
      baseDir: "/tmp",
      signal: controller.signal,
      onActionResult: (info) => {
        seen.push(info.action.resource);
        // Abort right after the first action settles; the next action must
        // not start.
        if (info.status === "success") controller.abort();
      },
    });

    // First action applied, second never started.
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.resolved.get("role:A")).toBe("role-1");
    expect(seen).toEqual(["A"]);
  });
});

describe("executePlan sticker CREATE (multipart)", () => {
  function stickerPlan(image: string): ActionPlan {
    return {
      actions: [
        {
          type: "CREATE",
          domain: "sticker",
          resource: "hype",
          endpoint: "/guilds/g1/stickers",
          method: "POST",
          payload: {
            name: "hype",
            description: "d",
            tags: "t",
            image: `__asset__:${image}`,
          },
          reason: "Sticker not found",
          dependencies: [],
        },
      ],
      summary: { creates: 1, updates: 0, deletes: 0, skips: 0 },
      dry_run: false,
      warnings: [],
    };
  }

  it("uploads via postMultipart and records the resolved id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-exec-sticker-"));
    writeFileSync(join(dir, "hype.png"), Buffer.from([1, 2, 3]));
    try {
      const postMultipart = vi.fn().mockResolvedValue({ id: "st99", name: "hype" });
      const client = {
        token: "tok",
        postMultipart,
        post: vi.fn(),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as DiscordRestClient;

      const result = await executePlan({
        client,
        plan: stickerPlan("hype.png"),
        guildId: "g1",
        baseDir: dir,
      });

      expect(result.applied).toBe(1);
      expect(result.failed).toEqual([]);
      expect(result.resolved.get("sticker:hype")).toBe("st99");
      expect(postMultipart).toHaveBeenCalledOnce();
      const [path, form] = postMultipart.mock.calls[0]!;
      expect(path).toBe("/guilds/g1/stickers");
      expect(form.get("name")).toBe("hype");
      expect(form.get("description")).toBe("d");
      expect(form.get("tags")).toBe("t");
      const file = form.get("file") as File;
      expect(file.name).toBe("hype.png");
      expect(file.type).toBe("image/png");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
      // The generic JSON path must not be used for sticker creates
      expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads URL-valued sticker images before the multipart upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => abuf([9, 9, 9]),
      }),
    );
    const postMultipart = vi.fn().mockResolvedValue({ id: "st100" });
    const client = {
      token: "tok",
      postMultipart,
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as DiscordRestClient;

    const result = await executePlan({
      client,
      plan: stickerPlan("https://static.example/hype.png"),
      guildId: "g1",
      baseDir: "/tmp",
    });

    expect(result.failed).toEqual([]);
    const [, form] = postMultipart.mock.calls[0]!;
    const file = form.get("file") as File;
    expect(file.name).toBe("hype.png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([9, 9, 9]));
  });
});
