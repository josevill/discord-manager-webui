import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/config/**",
        "src/reconcile/diff.ts",
        "src/reconcile/execute.ts",
        "src/reconcile/identity.ts",
        "src/reconcile/plan.ts",
        "src/reconcile/resolved.ts",
        "src/discord/permissions.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
