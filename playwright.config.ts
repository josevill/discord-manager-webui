import { defineConfig, devices } from "@playwright/test";

const PORT = 3847;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/web",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: {
    command: "npx tsx scripts/playwright-ui-server.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: String(PORT),
      DISCORD_TOKEN: "",
      DISCORD_GUILD_ID: "",
    },
  },
});
