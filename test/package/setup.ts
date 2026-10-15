import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    tarball: string;
  }
}

const repo = resolve(import.meta.dirname, "../..");

// Build once and pack once for every package test, so test files never race on dist/.
export default function setup(project: TestProject): () => void {
  const packDir = mkdtempSync(join(tmpdir(), "anytts-pack-"));
  const cleanup = () => rmSync(packDir, { recursive: true, force: true });
  try {
    execFileSync("pnpm", ["build"], { cwd: repo, stdio: "pipe" });
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: repo, stdio: "pipe" });
    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`pnpm pack produced no tarball in ${packDir}`);
    project.provide("tarball", join(packDir, tgz));
  } catch (error) {
    // Teardown is never returned on failure, so remove the dir here.
    cleanup();
    throw error;
  }
  return cleanup;
}
