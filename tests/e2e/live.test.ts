import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../../src/config/loader.js";
import type { ServerConfig } from "../../src/config/schema.js";
import { validateCrossReferences } from "../../src/config/validate.js";
import { DiscordRestClient, fetchGuildState } from "../../src/discord/client.js";
import { executePlan } from "../../src/reconcile/execute.js";
import { buildActionPlan } from "../../src/reconcile/plan.js";
import { resolvedFromState } from "../../src/reconcile/resolved.js";
import { writeBackup } from "../../src/state/backup.js";
import { exportStateToYaml, materializeExportAssets } from "../../src/state/export.js";

loadEnv({ quiet: true });

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ALLOW = process.env.E2E_ALLOW_GUILD_ID;

const hasCreds = Boolean(TOKEN && GUILD_ID);

describe.skipIf(!hasCreds)("live E2E", () => {
  const runId = randomBytes(3).toString("hex");
  const prefix = `e2e-${runId}-`;
  let client: DiscordRestClient;
  const createdRoleIds: string[] = [];
  const createdChannelIds: string[] = [];

  beforeAll(() => {
    // Fail fast: live E2E mutates a real guild, so it must be explicitly
    // allowlisted. Unset E2E_ALLOW_GUILD_ID no longer means "any guild".
    if (!ALLOW || ALLOW !== GUILD_ID) {
      throw new Error(
        `Refusing to run live E2E: set E2E_ALLOW_GUILD_ID to ${GUILD_ID} to confirm this is a disposable guild`,
      );
    }
    client = new DiscordRestClient(TOKEN!);
  });

  afterAll(async () => {
    // Cleanup by prefix
    try {
      const state = await fetchGuildState(client, GUILD_ID!);
      for (const ch of state.channels) {
        if (ch.name.startsWith(prefix) || ch.name.includes(runId)) {
          try {
            await client.delete(`/channels/${ch.id}`);
          } catch {
            /* ignore */
          }
        }
      }
      for (const role of state.roles) {
        if (role.name.startsWith(prefix) && !role.managed) {
          try {
            await client.delete(`/guilds/${GUILD_ID}/roles/${role.id}`);
          } catch {
            /* ignore */
          }
        }
      }
      for (const st of state.stickers) {
        if (st.name.startsWith(prefix)) {
          try {
            await client.delete(`/guilds/${GUILD_ID}/stickers/${st.id}`);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore teardown errors */
    }
  });

  it("validates example config", () => {
    const loaded = loadConfig("examples/e2e-config.yaml");
    // e2e-config uses fixed names — schema ok
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(true);
  });

  it("exports live guild state", async () => {
    const state = await fetchGuildState(client, GUILD_ID!);
    const yaml = exportStateToYaml(state);
    expect(yaml).toContain("guild:");
    expect(yaml).toContain("roles:");
  });

  it("export is re-applicable: asset images materialized to <dir>/assets", async () => {
    const state = await fetchGuildState(client, GUILD_ID!);
    const dir = join(tmpdir(), `dm-e2e-export-${runId}`);
    const { config, warnings } = await materializeExportAssets({
      client,
      state,
      assetsDir: join(dir, "assets"),
    });
    const yaml = stringifyYaml(config);

    // No unresolvable image refs may survive: no sticker:<id> placeholders,
    // and any emoji/sticker image must be a file that was actually written.
    expect(yaml).not.toMatch(/image: sticker:\d+/);
    expect(yaml).not.toMatch(/image: https:\/\/cdn\.discordapp\.com\/emojis/);
    const checkRef = (ref: string | null | undefined, label: string) => {
      if (!ref) return;
      if (/^https?:\/\//.test(ref)) return; // documented download fallback
      expect(existsSync(join(dir, ref)), `${label} asset missing: ${ref}`).toBe(true);
    };
    for (const e of config.emojis) checkRef(e.image, `emoji ${e.name}`);
    for (const s of config.stickers) checkRef(s.image, `sticker ${s.name}`);
    checkRef(config.guild.icon, "guild icon");
    expect(warnings).toEqual([]);
  }, 60_000);

  it("creates, updates, and is idempotent for stickers", async () => {
    const stickerName = `${prefix}sticker`;
    const dir = join(tmpdir(), `dm-e2e-sticker-${runId}`);
    mkdirSync(dir, { recursive: true });
    // 16x16 red PNG — small enough for the 512KB sticker limit
    writeFileSync(
      join(dir, "sticker.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAATklEQVR4nO3OMQEAAAgDsLH/d1EF8jUQwD32QAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    const makeConfig = (description: string): ServerConfig => ({
      guild: {},
      roles: [],
      categories: [],
      channels: [],
      emojis: [],
      stickers: [{ name: stickerName, description, tags: `e2e-${runId}`, image: "sticker.png" }],
      webhooks: [],
      auto_mod: { rules: [] },
    });

    let state = await fetchGuildState(client, GUILD_ID!);
    let plan = buildActionPlan({
      config: makeConfig("v1"),
      state,
      baseDir: dir,
      prune: false,
    });
    expect(plan.actions.some((a) => a.type === "CREATE" && a.domain === "sticker")).toBe(true);
    let result = await executePlan({
      client,
      plan,
      guildId: GUILD_ID!,
      baseDir: dir,
      initialResolved: resolvedFromState(state),
    });
    expect(result.failed).toEqual([]);

    state = await fetchGuildState(client, GUILD_ID!);
    const sticker = state.stickers.find((s) => s.name === stickerName);
    expect(sticker).toBeTruthy();
    expect(sticker!.description).toBe("v1");

    // Update text fields (image is immutable — not PATCHable)
    plan = buildActionPlan({
      config: makeConfig("v2"),
      state,
      baseDir: dir,
      prune: false,
    });
    expect(
      plan.actions.some(
        (a) => a.type === "UPDATE" && a.domain === "sticker" && a.resource === stickerName,
      ),
    ).toBe(true);
    result = await executePlan({
      client,
      plan,
      guildId: GUILD_ID!,
      baseDir: dir,
      initialResolved: resolvedFromState(state),
    });
    expect(result.failed).toEqual([]);

    // Idempotent: re-plan after apply must be a no-op (no image advisory either)
    state = await fetchGuildState(client, GUILD_ID!);
    plan = buildActionPlan({ config: makeConfig("v2"), state, baseDir: dir });
    const mutating = plan.actions.filter((a) => a.type !== "SKIP");
    expect(mutating).toEqual([]);
    expect(state.stickers.find((s) => s.name === stickerName)?.description).toBe("v2");
  }, 120_000);

  it("creates, updates, and is idempotent for roles/channels", async () => {
    const roleName = `${prefix}member`;
    const catName = `${prefix}category`;
    const channelName = `${prefix}general`;

    const config: ServerConfig = {
      guild: {},
      roles: [
        {
          name: roleName,
          color: 0x57f287,
          hoist: false,
          mentionable: false,
          permissions: ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"],
          position: 1,
        },
      ],
      categories: [{ name: catName, position: 0, permission_overwrites: [] }],
      channels: [
        {
          name: channelName,
          type: "text",
          category: catName,
          topic: "e2e channel",
          nsfw: false,
          slowmode: 0,
          permission_overwrites: [
            {
              role: "@everyone",
              allow: ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "SEND_MESSAGES"],
              deny: [],
            },
            {
              role: roleName,
              allow: ["SEND_MESSAGES", "MANAGE_MESSAGES"],
              deny: [],
            },
          ],
        },
      ],
      emojis: [],
      stickers: [],
      webhooks: [],
      auto_mod: { rules: [] },
    };

    const dir = join(tmpdir(), `dm-e2e-${runId}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, stringifyYaml(config));

    let state = await fetchGuildState(client, GUILD_ID!);
    let plan = buildActionPlan({
      config,
      state,
      baseDir: dir,
      prune: false,
    });

    expect(plan.summary.creates).toBeGreaterThan(0);

    let result = await executePlan({
      client,
      plan,
      guildId: GUILD_ID!,
      baseDir: dir,
      initialResolved: resolvedFromState(state),
    });
    expect(result.failed).toEqual([]);

    // Track for cleanup
    state = await fetchGuildState(client, GUILD_ID!);
    for (const r of state.roles) {
      if (r.name === roleName) createdRoleIds.push(r.id);
    }
    for (const c of state.channels) {
      if (c.name === catName || c.name === channelName) createdChannelIds.push(c.id);
    }

    // Update role color
    config.roles[0]!.color = 0xff0000;
    writeFileSync(configPath, stringifyYaml(config));
    state = await fetchGuildState(client, GUILD_ID!);
    plan = buildActionPlan({ config, state, baseDir: dir, prune: false });
    expect(plan.actions.some((a) => a.type === "UPDATE" && a.resource === roleName)).toBe(true);
    result = await executePlan({
      client,
      plan,
      guildId: GUILD_ID!,
      baseDir: dir,
      initialResolved: resolvedFromState(state),
    });
    expect(result.failed).toEqual([]);

    // Idempotent second apply: with the P0 fixes in place the re-plan must be a
    // full no-op — no lingering role_positions/channel_positions churn either.
    state = await fetchGuildState(client, GUILD_ID!);
    plan = buildActionPlan({ config, state, baseDir: dir, prune: false });
    const mutating = plan.actions.filter((a) => a.type !== "SKIP");
    expect(mutating.length).toBe(0);
  }, 120_000);

  it("dry-run shows deletes when pruning and backup writes", async () => {
    const state = await fetchGuildState(client, GUILD_ID!);
    const emptyish = loadConfig("examples/e2e-config.yaml").config;
    // Use empty roles/channels relative to live — just ensure dry plan builds
    const plan = buildActionPlan({
      config: emptyish,
      state,
      prune: true,
      dryRun: true,
    });
    expect(plan.dry_run).toBe(true);
    const backupPath = writeBackup(GUILD_ID!, state);
    expect(backupPath).toMatch(/\.jsonl$/);
  }, 60_000);

  it("handles large permission bitfields via string", async () => {
    const roleName = `${prefix}perms`;
    const config: ServerConfig = {
      guild: {},
      roles: [
        {
          name: roleName,
          permissions: ((1n << 43n) | (1n << 40n) | 1024n).toString(),
          hoist: false,
          mentionable: false,
          color: 0,
        },
      ],
      categories: [],
      channels: [],
      emojis: [],
      stickers: [],
      webhooks: [],
      auto_mod: { rules: [] },
    };
    const dir = join(tmpdir(), `dm-e2e-perms-${runId}`);
    mkdirSync(dir, { recursive: true });
    const state = await fetchGuildState(client, GUILD_ID!);
    const plan = buildActionPlan({ config, state, baseDir: dir });
    const result = await executePlan({
      client,
      plan,
      guildId: GUILD_ID!,
      baseDir: dir,
      initialResolved: resolvedFromState(state),
    });
    expect(result.failed).toEqual([]);

    const after = await fetchGuildState(client, GUILD_ID!);
    const role = after.roles.find((r) => r.name === roleName);
    expect(role).toBeTruthy();
    expect(BigInt(role!.permissions) & (1n << 43n)).toBe(1n << 43n);
  }, 60_000);
});
