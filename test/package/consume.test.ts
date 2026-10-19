import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, inject, it } from "vitest";
import { installPacked } from "./helpers.js";

const repo = resolve(import.meta.dirname, "../..");
let dir: string | undefined;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it("packed package imports in node 22", () => {
  const tarball = inject("tarball");

  // Only dist/ (minus tests) and the package metadata ship.
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);
  expect(listing.length).toBeGreaterThan(0);
  for (const file of listing) {
    expect(file).toMatch(/^package\/(dist\/|package\.json$|README|LICENSE)/);
    expect(file).not.toMatch(/__tests__|\.test\.|\/test\//);
  }

  dir = installPacked(tarball, "node");

  // No runtime dependency comes along.
  const installed = readdirSync(join(dir, "node_modules")).filter((n) => !n.startsWith("."));
  expect(installed).toEqual(["anytts"]);

  writeFileSync(
    join(dir, "check.mjs"),
    `
import * as root from "anytts";
import * as text from "anytts/text";
import * as server from "anytts/server";
const kinds = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v]));
console.log(JSON.stringify({ root: kinds(root), text: kinds(text), server: kinds(server), node: process.versions.node }));
`,
  );
  const out = JSON.parse(execFileSync("node", ["check.mjs"], { cwd: dir, encoding: "utf8" })) as {
    root: Record<string, string>;
    text: Record<string, string>;
    server: Record<string, string>;
    node: string;
  };
  expect(Number(out.node.split(".")[0])).toBeGreaterThanOrEqual(22);
  expect(out.root).toMatchObject({
    createTts: "function",
    TtsError: "function",
    isTransient: "function",
    resolveVoice: "function",
    listEngines: "function",
    listVoices: "function",
  });
  expect(out.text).toMatchObject({
    firstSentence: "function",
    packUnits: "function",
    applyPronunciation: "function",
    plPreset: "object",
  });
  expect(out.server).toMatchObject({ createRelayHandler: "function", toNodeHandler: "function" });

  // Types resolve through the exports map under NodeNext.
  writeFileSync(
    join(dir, "consumer.ts"),
    `
import { createTts, TtsError, type Tts, type TtsConfig, type TtsEvent, type VoiceInfo, type EngineHooks } from "anytts";
import { packUnits, applyPronunciation, plPreset, type Unit } from "anytts/text";
import { createRelayHandler, toNodeHandler } from "anytts/server";

const config: TtsConfig = {} as TtsConfig;
const tts: Tts = createTts(config);
const units: Unit[] = packUnits([{ text: "Ala ma kota." }]);
const handler: (req: Request) => Promise<Response> = createRelayHandler();
const nodeHandler = toNodeHandler(handler);
const err: unknown = new TtsError("rejected", "x");
const voices: VoiceInfo[] = [];
const hooks: EngineHooks = { onFirstByte: () => {} };
const state: "cold" | "pending" | "ready" = tts.state({ text: "x" });
const listener = (e: TtsEvent): void => {
  const type: "pending" | "add" | "drop" | "evict" = e.type;
  const key: string = e.key;
  void type;
  void key;
};
const unsubscribe: () => void = tts.subscribe(listener);
// Reverse direction: the new literals must be assignable to TtsEvent, so a dist that
// regressed to the old two-type union fails here rather than passing silently.
const pending: TtsEvent = { type: "pending", key: "k" };
const dropped: TtsEvent = { type: "drop", key: "k" };
export { tts, units, nodeHandler, err, voices, hooks, state, unsubscribe, pending, dropped, applyPronunciation, plPreset };
`,
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: ["node"],
        typeRoots: [join(repo, "node_modules/@types")],
      },
      files: ["consumer.ts"],
    }),
  );
  const tsc = join(repo, "node_modules/.bin/tsc");
  try {
    execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new Error(`consumer typecheck failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
});
