import { copyFileSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";

/**
 * Minimal SSE server that streams one action event and then holds the
 * connection open, simulating a long-running apply (route.fulfill cannot
 * stream a body, so we route.continue() to this helper instead).
 */
async function startSseServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
    });
    res.flushHeaders();
    res.write('event: start\ndata: {"total":3,"actionable":3,"dryRun":false}\n\n');
    const t = setTimeout(() => {
      res.write(
        'event: action\ndata: {"index":0,"total":3,"status":"success","type":"CREATE","domain":"channel","resource":"general"}\n\n',
      );
    }, 60);
    req.on("close", () => clearTimeout(t));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

const root = process.cwd();
const fixturePath = join(root, "tests/web/.tmp/server-config.yaml");
const examplePath = join(root, "examples/server-config.yaml");

test.beforeEach(() => {
  copyFileSync(examplePath, fixturePath);
});

test.describe("discord-manager WebUI", () => {
  test("boots and shows guild name + channel tree from fixture", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();
    await expect(page.getByTestId("header-guild-name")).toHaveValue("My Server");
    await expect(page.getByTestId("channel-item-welcome")).toBeVisible();
    await expect(page.getByTestId("role-item-Admin")).toBeVisible();
    await expect(page.getByTestId("category-item-Information")).toBeVisible();
  });

  test("edit channel name, save, and persist across reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    await page.getByTestId("channel-item-welcome").click();
    const nameInput = page.getByTestId("channel-name-input");
    await expect(nameInput).toHaveValue("welcome");
    await nameInput.fill("welcome-renamed");
    await expect(page.getByTestId("dirty-badge")).toBeVisible();

    await page.getByTestId("btn-save").click();
    await expect(page.getByTestId("status-message")).toHaveText("Saved");

    const onDisk = parseYaml(readFileSync(fixturePath, "utf8")) as {
      channels: { name: string }[];
    };
    expect(onDisk.channels.some((c) => c.name === "welcome-renamed")).toBe(true);

    await page.reload();
    await expect(page.getByTestId("channel-item-welcome-renamed")).toBeVisible();
  });

  test("add role and channel, then save/reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    await page.getByTestId("add-role").click();
    const roleName = page.getByTestId("role-name-input");
    await expect(roleName).toBeVisible();
    const createdRole = await roleName.inputValue();
    expect(createdRole).toMatch(/^role-\d+$/);

    await page.getByTestId("add-channel-in-Community").click();
    const channelName = page.getByTestId("channel-name-input");
    await expect(channelName).toBeVisible();
    const createdChannel = await channelName.inputValue();
    expect(createdChannel).toMatch(/^channel-\d+$/);
    await expect(page.getByTestId("channel-category-input")).toHaveValue("Community");

    await page.getByTestId("btn-save").click();
    await expect(page.getByTestId("status-message")).toHaveText("Saved");

    await page.reload();
    await expect(page.getByTestId(`role-item-${createdRole}`)).toBeVisible();
    await expect(page.getByTestId(`channel-item-${createdChannel}`)).toBeVisible();
  });

  test("add emoji, webhook, and auto-mod rule via the Content pane and persist", async ({
    page,
  }) => {
    await page.route("**/api/assets", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: "assets/party.png" }),
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();
    await expect(page.getByTestId("content-list")).toBeVisible();

    // Emoji: add, name, upload image, restrict to a role.
    await page.getByTestId("add-emoji").click();
    const emojiName = page.getByTestId("emoji-name-input");
    await expect(emojiName).toBeVisible();
    await emojiName.fill("party_time");
    const emojiPicker = page.getByTestId("asset-picker").first();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      emojiPicker.getByTestId("asset-picker-choose").click(),
    ]);
    await chooser.setFiles({
      name: "party.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-png-bytes"),
    });
    await expect(emojiPicker.getByTestId("asset-picker-value")).toHaveText("assets/party.png");
    await page
      .getByTestId("emoji-roles-editor")
      .locator("label")
      .filter({ hasText: "Admin" })
      .click();

    // Webhook: add, name, channel.
    await page.getByTestId("add-webhook").click();
    await expect(page.getByTestId("webhook-name-input")).toBeVisible();
    await page.getByTestId("webhook-name-input").fill("ci-hook");
    await page.getByTestId("webhook-channel-input").fill("general");

    // Auto-mod rule: event/trigger/metadata/actions/exemptions.
    await page.getByTestId("add-auto-mod-rule").click();
    const ruleName = page.getByTestId("auto-mod-name-input");
    await expect(ruleName).toBeVisible();
    await ruleName.fill("no-spam");
    await page.getByTestId("auto-mod-event-input").selectOption("5"); // Pattern
    await page.getByTestId("auto-mod-trigger-input").selectOption("0"); // Mentions
    await page.getByTestId("auto-mod-metadata-input").fill('{"mention_limit": 5}');
    await page.getByTestId("auto-mod-action-type-0").selectOption("1"); // Alert
    await page.getByTestId("auto-mod-action-channel-0").fill("mod-log");
    await page.getByTestId("auto-mod-add-action").click();
    await expect(page.getByTestId("auto-mod-action-1")).toBeVisible();
    await page
      .getByTestId("auto-mod-exempt-roles")
      .locator("label")
      .filter({ hasText: "Admin" })
      .click();

    await page.getByTestId("btn-save").click();
    await expect(page.getByTestId("status-message")).toHaveText("Saved");

    await page.reload();
    await expect(page.getByTestId("emoji-item-party_time")).toBeVisible();
    await expect(page.getByTestId("webhook-item-ci-hook")).toBeVisible();
    await expect(page.getByTestId("auto-mod-item-no-spam")).toBeVisible();

    const onDisk = parseYaml(readFileSync(fixturePath, "utf8")) as {
      emojis: { name: string; image: string; roles: string[] }[];
      webhooks: { name: string; channel: string; avatar: string | null }[];
      auto_mod: {
        rules: {
          name: string;
          event_type: number;
          trigger_type: number;
          trigger_metadata: Record<string, unknown>;
          actions: { type: number; metadata?: Record<string, unknown> }[];
          exempt_roles: string[];
        }[];
      };
    };
    expect(onDisk.emojis).toEqual([
      { name: "party_time", image: "assets/party.png", roles: ["Admin"] },
    ]);
    expect(onDisk.webhooks).toEqual([{ name: "ci-hook", channel: "general", avatar: null }]);
    const rule = onDisk.auto_mod.rules[0]!;
    expect(rule).toMatchObject({
      name: "no-spam",
      event_type: 5,
      trigger_type: 0,
      trigger_metadata: { mention_limit: 5 },
      exempt_roles: ["Admin"],
    });
    expect(rule.actions).toEqual([{ type: 1, metadata: { channel: "mod-log" } }, { type: 2 }]);
  });

  test("validation fails for missing category and blocks save", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    await page.getByTestId("channel-item-general").click();
    await page.getByTestId("channel-category-input").fill("DoesNotExist");

    await page.getByTestId("btn-validate").click();
    await expect(page.getByTestId("status-message")).toHaveText("Validation failed");
    await expect(page.getByTestId("validation-issue").first()).toContainText(
      'Category "DoesNotExist" is not defined',
    );

    await page.getByTestId("btn-save").click();
    await expect(page.getByTestId("status-message")).toHaveText("Save rejected");
    await expect(page.getByTestId("validation-issue").first()).toContainText(
      'Category "DoesNotExist" is not defined',
    );
  });

  test("reorder roles and persist order on save", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();
    await expect(page.getByTestId("role-item-Admin")).toBeVisible();

    await page.getByTestId("role-move-down-Admin").click();
    await expect(page.getByTestId("dirty-badge")).toBeVisible();

    await page.getByTestId("btn-save").click();
    await expect(page.getByTestId("status-message")).toHaveText("Saved");

    const onDisk = parseYaml(readFileSync(fixturePath, "utf8")) as {
      roles: { name: string }[];
    };
    const names = onDisk.roles.map((r) => r.name);
    expect(names[0]).toBe("Moderator");
    expect(names[1]).toBe("Admin");
  });

  test("Plan shows unavailable message without Discord credentials", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    const health = await page.request.get("/api/health");
    const healthJson = (await health.json()) as { discordConfigured: boolean };
    expect(healthJson.discordConfigured).toBe(false);

    await page.getByTestId("btn-plan").click();
    await expect(page.getByTestId("alert-modal")).toBeVisible();
    await expect(page.getByTestId("alert-modal-message")).toContainText(
      "Plan unavailable: Discord credentials not configured",
    );
    await page.getByTestId("alert-modal-close").click();
    await expect(page.getByTestId("alert-modal")).toHaveCount(0);

    const planRes = await page.request.post("/api/plan", {
      data: {},
    });
    expect(planRes.status()).toBe(503);
    const planJson = (await planRes.json()) as { code?: string };
    expect(planJson.code).toBe("DISCORD_NOT_CONFIGURED");
  });

  test("Fetch status is gated without Discord credentials", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    const health = await page.request.get("/api/health");
    const healthJson = (await health.json()) as { discordConfigured: boolean };
    expect(healthJson.discordConfigured).toBe(false);

    await expect(page.getByTestId("btn-fetch")).toBeDisabled();

    const fetchRes = await page.request.post("/api/fetch");
    expect(fetchRes.status()).toBe(503);
    const fetchJson = (await fetchRes.json()) as { code?: string };
    expect(fetchJson.code).toBe("DISCORD_NOT_CONFIGURED");
  });

  test("Fetch status replaces config and clears dirty state", async ({ page }) => {
    const fetchedConfig = {
      guild: { name: "Fetched Guild" },
      roles: [{ name: "FetchedRole", hoist: false, mentionable: false }],
      categories: [],
      channels: [{ name: "fetched-general", type: "text" }],
      emojis: [],
      stickers: [],
      webhooks: [],
      auto_mod: { rules: [] },
    };

    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...json, discordConfigured: true }),
      });
    });
    await page.route("**/api/fetch", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          config: fetchedConfig,
          warnings: [],
        }),
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();
    await expect(page.getByTestId("header-guild-name")).toHaveValue("My Server");

    await page.getByTestId("header-guild-name").fill("Dirty Name");
    await expect(page.getByTestId("dirty-badge")).toBeVisible();

    await page.getByTestId("btn-fetch").click();
    await expect(page.getByTestId("alert-modal")).toBeVisible();
    await expect(page.getByTestId("alert-modal-message")).toContainText(
      "unsaved edits that will be discarded",
    );
    await page.getByTestId("alert-modal-confirm").click();
    await expect(page.getByTestId("alert-modal-message")).toHaveText("Fetched live status");
    await page.getByTestId("alert-modal-close").click();
    await expect(page.getByTestId("header-guild-name")).toHaveValue("Fetched Guild");
    await expect(page.getByTestId("role-item-FetchedRole")).toBeVisible();
    await expect(page.getByTestId("channel-item-fetched-general")).toBeVisible();
    await expect(page.getByTestId("dirty-badge")).toHaveCount(0);
  });

  test("plan output panel can toggle and copy", async ({ page }) => {
    const fakePlan = {
      actions: [
        {
          type: "CREATE",
          domain: "channel",
          resource: "general",
          reason: "Channel general not found",
        },
      ],
      summary: { creates: 1, updates: 0, deletes: 0, skips: 0 },
      dry_run: true,
      warnings: [],
    };

    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...json, discordConfigured: true }),
      });
    });
    await page.route("**/api/plan", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, plan: fakePlan }),
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();
    await expect(page.getByTestId("toggle-plan-output")).toBeDisabled();

    await page.getByTestId("btn-plan").click();
    await expect(page.getByTestId("alert-modal")).toBeVisible();
    await expect(page.getByTestId("alert-modal-message")).toHaveText("Plan ready");
    const modalDetail = page.getByTestId("alert-modal-detail");
    await expect(modalDetail).toBeVisible();
    await expect(modalDetail.getByTestId("plan-view")).toBeVisible();
    await expect(modalDetail.getByTestId("plan-view-section-create")).toContainText("general");
    await expect(modalDetail).toContainText("Create");

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("alert-modal-copy").click();
    await expect(page.getByTestId("alert-modal-copy")).toHaveText("Copied");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(JSON.stringify(fakePlan, null, 2));

    await page.getByTestId("alert-modal-close").click();
    await expect(page.getByTestId("alert-modal")).toHaveCount(0);

    const output = page.getByTestId("plan-output");
    await expect(output).toBeVisible();
    await expect(output.getByTestId("plan-view")).toBeVisible();
    await expect(output).toContainText("general");

    await page.getByTestId("hide-plan-output").click();
    await expect(output).toHaveCount(0);
    await expect(page.getByTestId("toggle-plan-output")).toBeEnabled();
    await expect(page.getByTestId("toggle-plan-output")).toHaveText("Show output");

    await page.getByTestId("toggle-plan-output").click();
    await expect(page.getByTestId("plan-output")).toBeVisible();
    await expect(page.getByTestId("toggle-plan-output")).toHaveText("Hide output");
  });

  test("upload asset file into guild icon field, clear it, and persist on save", async ({
    page,
  }) => {
    await page.route("**/api/assets", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: "assets/my-icon.png" }),
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();
    await page.getByTestId("select-guild").click();

    // First asset picker in the guild inspector is the icon.
    const iconPicker = page.getByTestId("asset-picker").first();
    await expect(iconPicker.getByTestId("asset-picker-value")).toHaveText("(not set)");

    const pickFile = async () => {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        iconPicker.getByTestId("asset-picker-choose").click(),
      ]);
      await chooser.setFiles({
        name: "my-icon.png",
        mimeType: "image/png",
        buffer: Buffer.from("fake-png-bytes"),
      });
    };

    await pickFile();
    await expect(iconPicker.getByTestId("asset-picker-value")).toHaveText("assets/my-icon.png");
    await expect(page.getByTestId("dirty-badge")).toBeVisible();

    // Clear works for nullable fields.
    await iconPicker.getByTestId("asset-picker-clear").click();
    await expect(iconPicker.getByTestId("asset-picker-value")).toHaveText("(not set)");

    // Pick again, save, and verify the reference persists into the YAML.
    await pickFile();
    await expect(iconPicker.getByTestId("asset-picker-value")).toHaveText("assets/my-icon.png");

    await page.getByTestId("btn-save").click();
    await expect(page.getByTestId("status-message")).toHaveText("Saved");
    const onDisk = parseYaml(readFileSync(fixturePath, "utf8")) as { guild: { icon?: string } };
    expect(onDisk.guild.icon).toBe("assets/my-icon.png");
  });

  test("Apply confirm modal then success", async ({ page }) => {
    const fakeResult = {
      ok: true,
      plan: {
        actions: [
          {
            type: "UPDATE",
            domain: "guild",
            resource: "My Server",
            reason: "Guild fields differ: name",
          },
        ],
        summary: { creates: 0, updates: 1, deletes: 0, skips: 0 },
        dry_run: false,
        warnings: [],
      },
      result: { applied: 1, skipped: 0, failed: [] },
    };
    // /api/apply is an SSE stream: start → action* → done.
    const sse = [
      'event: start\ndata: {"total":1,"actionable":1,"dryRun":false}\n\n',
      'event: action\ndata: {"index":0,"total":1,"status":"success","type":"UPDATE","domain":"guild","resource":"My Server"}\n\n',
      `event: done\ndata: ${JSON.stringify(fakeResult)}\n\n`,
    ].join("");

    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...json, discordConfigured: true }),
      });
    });
    await page.route("**/api/apply", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse,
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    await page.getByTestId("btn-apply").click();
    await expect(page.getByTestId("alert-modal-message")).toContainText("mutate the server");
    await page.getByTestId("alert-modal-confirm").click();
    await expect(page.getByTestId("alert-modal-message")).toHaveText("Apply complete");
    await expect(
      page.getByTestId("alert-modal-detail").getByTestId("plan-view-section-update"),
    ).toContainText("My Server");
    await page.getByTestId("alert-modal-close").click();
    await expect(page.getByTestId("alert-modal")).toHaveCount(0);
  });

  test("Apply confirm modal shows danger styling and renders the error phase", async ({ page }) => {
    // SSE stream that fails: start → error. postApplyStream surfaces the
    // error message and the modal must land in the error phase.
    const sse = [
      'event: start\ndata: {"total":2,"actionable":2,"dryRun":false}\n\n',
      'event: error\ndata: {"error":"50033: Channel name already taken"}\n\n',
    ].join("");

    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...json, discordConfigured: true }),
      });
    });
    await page.route("**/api/apply", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse,
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    // Confirm phase: the Apply button uses danger styling.
    await page.getByTestId("btn-apply").click();
    const confirmBtn = page.getByTestId("alert-modal-confirm");
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toHaveText("Apply");
    await expect(confirmBtn).toHaveClass(/btn-danger/);
    const dangerBg = await confirmBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    const redVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--red").trim(),
    );
    expect(redVar.startsWith("#"), "--red should be a hex color").toBe(true);
    expect(dangerBg).toBe(hexToRgb(redVar));

    // Confirm → the streamed error lands in the error phase with danger styling.
    await confirmBtn.click();
    const modal = page.locator(".alert-modal");
    await expect(modal).toHaveClass(/error/);
    await expect(page.getByTestId("alert-modal-title")).toHaveText("Apply failed");
    await expect(page.getByTestId("alert-modal-message")).toContainText(
      "50033: Channel name already taken",
    );
    const titleColor = await page
      .getByTestId("alert-modal-title")
      .evaluate((el) => getComputedStyle(el).color);
    expect(titleColor).toBe("rgb(242, 63, 67)"); // .alert-modal.error .alert-modal-title
    await expect(page.getByTestId("alert-modal-close")).toBeVisible();
    await page.getByTestId("alert-modal-close").click();
    await expect(page.getByTestId("alert-modal")).toHaveCount(0);
  });

  test("Apply confirm modal shows the prune checkbox and sends prune in the request", async ({
    page,
  }) => {
    const fakeResult = {
      ok: true,
      plan: {
        actions: [],
        summary: { creates: 0, updates: 0, deletes: 1, skips: 0 },
        dry_run: false,
        warnings: [],
      },
      result: { applied: 1, skipped: 0, failed: [] },
    };
    const sse = [
      'event: start\ndata: {"total":1,"actionable":1,"dryRun":false}\n\n',
      `event: done\ndata: ${JSON.stringify(fakeResult)}\n\n`,
    ].join("");

    let capturedBody: Record<string, unknown> | undefined;

    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...json, discordConfigured: true }),
      });
    });
    await page.route("**/api/apply", (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      void route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse,
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("app")).toBeVisible();

    // Default: checkbox is present and unchecked → request sends prune: false.
    await page.getByTestId("btn-apply").click();
    const pruneCheckbox = page.getByTestId("apply-prune-checkbox");
    await expect(pruneCheckbox).toBeVisible();
    await expect(pruneCheckbox).not.toBeChecked();
    await page.getByTestId("alert-modal-confirm").click();
    await expect(page.getByTestId("alert-modal-message")).toHaveText("Apply complete");
    expect(capturedBody?.prune).toBe(false);
    await page.getByTestId("alert-modal-close").click();

    // Checked → the same apply request sends prune: true.
    await page.getByTestId("btn-apply").click();
    await expect(pruneCheckbox).toBeVisible();
    await pruneCheckbox.check();
    await page.getByTestId("alert-modal-confirm").click();
    await expect(page.getByTestId("alert-modal-message")).toHaveText("Apply complete");
    expect(capturedBody?.prune).toBe(true);
  });

  test("Apply streams per-action progress and can be cancelled", async ({ page }) => {
    const sse = await startSseServer();
    try {
      await page.route("**/api/meta", async (route) => {
        const res = await route.fetch();
        const json = (await res.json()) as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...json, discordConfigured: true }),
        });
      });
      await page.route("**/api/apply", (route) =>
        route.continue({ url: `http://127.0.0.1:${sse.port}/apply` }),
      );

      await page.goto("/");
      await expect(page.getByTestId("app")).toBeVisible();

      await page.getByTestId("btn-apply").click();
      await page.getByTestId("alert-modal-confirm").click();
      await expect(page.getByTestId("alert-modal-message")).toHaveText("Applying config…");

      // Progress shows as the first action event lands on the live stream.
      const progressText = page.getByTestId("apply-progress-text");
      await expect(progressText).toBeVisible();
      await expect(progressText).toHaveText("Step 1 of 3 — ✓ CREATE general");

      // Cancel aborts the in-flight request and reports the cancellation.
      await page.getByTestId("alert-modal-cancel-pending").click();
      await expect(page.getByTestId("alert-modal-message")).toContainText("Apply cancelled");
      await page.getByTestId("alert-modal-close").click();
      await expect(page.getByTestId("alert-modal")).toHaveCount(0);
    } finally {
      await sse.close();
    }
  });
});
