import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const fixturePath = join(root, "tests/web/.tmp/server-config.yaml");
const examplePath = join(root, "examples/server-config.yaml");

test.beforeEach(() => {
  copyFileSync(examplePath, fixturePath);
});

test.describe("responsive phone WebUI", () => {
  test("bottom nav switches panes; select channel opens Edit", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toHaveAttribute("data-layout", "phone");
    await expect(page.getByTestId("mobile-nav")).toBeVisible();
    await expect(page.getByTestId("channel-item-welcome")).toBeVisible();
    await expect(page.getByTestId("roles-rail")).toBeHidden();

    await page.getByTestId("nav-roles").click();
    await expect(page.getByTestId("role-item-Admin")).toBeVisible();
    await expect(page.getByTestId("channel-tree")).toBeHidden();

    await page.getByTestId("nav-channels").click();
    await page.getByTestId("channel-item-welcome").click();
    await expect(page.getByTestId("channel-name-input")).toBeVisible();
    await expect(page.getByTestId("channel-name-input")).toHaveValue("welcome");
    await expect(page.getByTestId("nav-inspector")).toHaveClass(/active/);
  });

  test("add role via Roles tab, edit name, save via Actions", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toHaveAttribute("data-layout", "phone");

    await page.getByTestId("nav-roles").click();
    await page.getByTestId("add-role").click();
    const roleName = page.getByTestId("role-name-input");
    await expect(roleName).toBeVisible();
    const createdRole = await roleName.inputValue();
    expect(createdRole).toMatch(/^role-\d+$/);
    await roleName.fill("phone-role");
    await expect(page.getByTestId("dirty-badge")).toBeVisible();

    await page.getByTestId("actions-menu").click();
    await page.getByTestId("btn-save").click();
    await expect(page.getByTestId("status-message")).toHaveText("Saved");

    const onDisk = parseYaml(readFileSync(fixturePath, "utf8")) as {
      roles: { name: string }[];
    };
    expect(onDisk.roles.some((r) => r.name === "phone-role")).toBe(true);
  });

  test("Content tab lists the emoji/webhook/auto-mod sections", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toHaveAttribute("data-layout", "phone");
    await expect(page.getByTestId("mobile-nav")).toBeVisible();

    await page.getByTestId("nav-content").click();
    await expect(page.getByTestId("nav-content")).toHaveClass(/active/);
    await expect(page.getByTestId("content-list")).toBeVisible();
    await expect(page.getByTestId("content-list")).toContainText("Emojis");
    await expect(page.getByTestId("content-list")).toContainText("Webhooks");
    await expect(page.getByTestId("content-list")).toContainText("Auto-mod rules");

    // Selecting an item opens the Edit pane with its form card.
    await page.getByTestId("add-webhook").click();
    await expect(page.getByTestId("webhook-name-input")).toBeVisible();
    await expect(page.getByTestId("nav-inspector")).toHaveClass(/active/);
  });
});
