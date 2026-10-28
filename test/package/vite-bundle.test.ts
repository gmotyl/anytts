import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { build } from "vite";
import { installPacked } from "./helpers.js";

const SERVER_MARKERS = ["toNodeHandler", "createRelayHandler", "writeHead"];
// Key-handling code of the keyed engines: provider endpoints and the shared keyed base.
const KEYED_MARKERS = [
  "api.elevenlabs.io",
  "api.cartesia.ai",
  "api.speechify.ai",
  "tts.speech.microsoft.com",
  "createElevenLabsEngine",
  "createCartesiaEngine",
  "createSpeechifyEngine",
  "createAzureEngine",
  "keyedFetch",
  "no apiKey configured",
];
const ENGINE_MARKERS = ["TrustedClientToken", "speech.platform.bing.com", "Sec-MS-GEC", "createEdgeEngine"];

let dir: string;

beforeAll(() => {
  dir = installPacked(inject("tarball"), "vite");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Bundle {
  code: string;
  warnings: string[];
}

async function bundle(name: string, source: string): Promise<Bundle> {
  const entry = join(dir, `${name}.js`);
  writeFileSync(entry, source);
  const warnings: string[] = [];
  const result = await build({
    root: dir,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      target: "es2022",
      minify: false,
      modulePreload: false,
      rollupOptions: {
        input: entry,
        onwarn: (w) => void warnings.push(w.message),
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Array<{
    output: Array<{ type: string; code?: string }>;
  }>;
  const code = outputs
    .flatMap((o) => o.output)
    .filter((o) => o.type === "chunk")
    .map((o) => o.code ?? "")
    .join("\n");
  return { code, warnings };
}

function expectNoNodeBuiltins({ code, warnings }: Bundle): void {
  // Vite either stubs Node built-ins (`__vite-browser-external`) or leaves them as bare external imports.
  expect(code).not.toContain("__vite-browser-external");
  expect(code).not.toMatch(/\bfrom\s*["'](node:)?(http|https|net|tls|crypto|stream|buffer|fs|events)["']/);
  expect(code).not.toMatch(/["']node:/);
  expect(warnings.filter((w) => /externalized|browser compatibility|node:/i.test(w))).toEqual([]);
}

it("browser bundle needs no node built-ins and excludes the server", async () => {
  const out = await bundle("main", `import * as tts from "anytts";\nconsole.log(tts);\n`);
  expectNoNodeBuiltins(out);
  // Sanity: the engine is in (so the marker checks below are meaningful).
  expect(out.code).toContain("speech.platform.bing.com");
  for (const marker of SERVER_MARKERS) expect(out.code).not.toContain(marker);
});

it("text entry bundles without engine code", async () => {
  const out = await bundle("text", `import * as text from "anytts/text";\nconsole.log(text);\n`);
  expectNoNodeBuiltins(out);
  expect(out.code).toContain("packUnits");
  for (const marker of [...ENGINE_MARKERS, ...SERVER_MARKERS]) expect(out.code).not.toContain(marker);
});

it("main entry ships no keyed engine code", async () => {
  const out = await bundle("keyless", `import * as tts from "anytts";\nconsole.log(tts);\n`);
  // Sanity: the main entry is in (edge, and the keyed engines' static catalogs for settings UIs).
  expect(out.code).toContain("speech.platform.bing.com");
  for (const marker of KEYED_MARKERS) expect(out.code).not.toContain(marker);

  // `anytts/server` registers the keyed factories; the main entry does not.
  writeFileSync(
    join(dir, "keyed.mjs"),
    `
import { createTts } from "anytts";
import { createTts as createServerTts } from "anytts/server";
const scheduler = { concurrency: 1, tiers: [{ name: "play" }] };
const ids = ["elevenlabs", "cartesia", "speechify", "azure"];
const result = {};
for (const id of ids) {
  const config = { engines: { [id]: {} }, defaultEngine: id, scheduler };
  let main;
  try { createTts(config); main = "ok"; } catch (e) { main = e.name; }
  let server;
  try { createServerTts(config); server = "ok"; } catch (e) { server = e.name; }
  result[id] = { main, server };
}
console.log(JSON.stringify(result));
`,
  );
  const result = JSON.parse(execFileSync("node", ["keyed.mjs"], { cwd: dir, encoding: "utf8" })) as Record<
    string,
    { main: string; server: string }
  >;
  expect(result).toEqual({
    elevenlabs: { main: "RangeError", server: "ok" },
    cartesia: { main: "RangeError", server: "ok" },
    speechify: { main: "RangeError", server: "ok" },
    azure: { main: "RangeError", server: "ok" },
  });
});
