import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/__tests__/*.test.ts"],
          exclude: ["src/**/__tests__/*.browser.test.ts"],
        },
      },
      {
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/__tests__/*.browser.test.ts"],
        },
      },
      {
        test: {
          name: "package",
          environment: "node",
          include: ["test/package/*.test.ts"],
          globalSetup: ["test/package/setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: "live",
          environment: "node",
          include: ["test/live/*.live.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
