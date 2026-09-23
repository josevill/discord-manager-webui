import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { ServerConfigSchema } from "../../src/config/schema.js";
import { validateCrossReferences } from "../../src/config/validate.js";

const TMP = join(tmpdir(), `dm-schema-${Date.now()}`);
mkdirSync(TMP, { recursive: true });

function writeYaml(name: string, body: string): string {
  const path = join(TMP, name);
  writeFileSync(path, body);
  return path;
}

describe("schema + validation", () => {
  it("accepts a minimal valid config", () => {
    const path = writeYaml(
      "ok.yaml",
      `
roles:
  - name: Member
    permissions: ["VIEW_CHANNEL"]
categories:
  - name: General
channels:
  - name: chat
    category: General
`,
    );
    const loaded = loadConfig(path);
    expect(loaded.config.roles).toHaveLength(1);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(true);
  });

  it("rejects unknown category references", () => {
    const path = writeYaml(
      "bad-cat.yaml",
      `
channels:
  - name: chat
    category: Missing
`,
    );
    const loaded = loadConfig(path);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path.includes("category"))).toBe(true);
  });

  it("rejects unknown role in overwrites", () => {
    const path = writeYaml(
      "bad-role.yaml",
      `
categories:
  - name: Gen
channels:
  - name: chat
    category: Gen
    permission_overwrites:
      - role: NoSuchRole
        deny: [VIEW_CHANNEL]
`,
    );
    const loaded = loadConfig(path);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate channel names across categories", () => {
    const path = writeYaml(
      "dup-xcat.yaml",
      `
categories:
  - name: Alpha
  - name: Beta
channels:
  - name: chat
    category: Alpha
  - name: chat
    category: Beta
`,
    );
    const loaded = loadConfig(path);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes("unique across categories"));
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("Alpha");
    expect(issue!.message).toContain("Beta");
  });

  it("rejects duplicate channel names within one category", () => {
    const path = writeYaml(
      "dup-samecat.yaml",
      `
categories:
  - name: Alpha
channels:
  - name: chat
    category: Alpha
  - name: chat
    category: Alpha
`,
    );
    const loaded = loadConfig(path);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('Duplicate channel "chat"'))).toBe(true);
  });

  it("accepts the same channel name as a role name", () => {
    const path = writeYaml(
      "channel-same-as-role.yaml",
      `
roles:
  - name: Admin
categories:
  - name: Alpha
channels:
  - name: Admin
    category: Alpha
`,
    );
    const loaded = loadConfig(path);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(true);
  });

  it("rejects guild channel refs that are not defined channels", () => {
    const path = writeYaml(
      "bad-guild-ref.yaml",
      `
guild:
  system_channel: logs
  rules_channel: rules
channels:
  - name: logs
`,
    );
    const loaded = loadConfig(path);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === "guild.rules_channel")).toBe(true);
    // system_channel resolves to a defined channel → no issue for it
    expect(result.issues.some((i) => i.path === "guild.system_channel")).toBe(false);
  });

  it("accepts guild channel refs to defined channels and nulls", () => {
    const path = writeYaml(
      "ok-guild-ref.yaml",
      `
guild:
  system_channel: logs
  rules_channel: rules
  afk_channel: null
  public_updates_channel: null
channels:
  - name: logs
  - name: rules
`,
    );
    const loaded = loadConfig(path);
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid emoji names", () => {
    const parsed = ServerConfigSchema.safeParse({
      emojis: [{ name: "bad-name!", image: "./x.png" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("warns on community features", () => {
    const path = writeYaml(
      "community.yaml",
      `
channels:
  - name: news
    type: announcement
welcome_screen:
  enabled: true
  welcome_channels:
    - channel: news
      description: hi
`,
    );
    const loaded = loadConfig(path);
    // announcement channel name alone — welcome refs news which exists
    const result = validateCrossReferences(loaded.config);
    expect(result.issues.some((i) => i.level === "warning")).toBe(true);
  });

  it("loads examples/server-config.yaml", () => {
    const loaded = loadConfig("examples/server-config.yaml");
    const result = validateCrossReferences(loaded.config);
    expect(result.ok).toBe(true);
  });
});
