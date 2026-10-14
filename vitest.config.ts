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
          name: "live",
          environment: "node",
          include: ["test/live/*.live.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
