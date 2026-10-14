import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp project with only the packed tarball installed (via npm, no workspace links). */
export function installPacked(tarball: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `free-tts-${prefix}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `consumer-${prefix}`, private: true, type: "module" }, null, 2),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
    cwd: dir,
    stdio: "pipe",
  });
  return dir;
}
