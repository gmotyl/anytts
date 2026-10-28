import { describe, expect, it } from "vitest";
import type { Engine, EngineHooks, VoiceInfo } from "../engine.js";
import { TtsError } from "../errors.js";
import { applyPronunciation } from "../text/pronunciation.js";
import { createTts, type EngineConfig, type TtsConfig } from "../tts.js";

const voice = (id: string): VoiceInfo => ({ id, label: id, locale: "pl-PL", gender: "male", multilingual: false });

interface Call {
  text: string;
  voice: string;
  hooks: EngineHooks | undefined;
  resolve: (bytes: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}

type Behaviour = "answer" | "hold" | ((call: Call) => void);

/**
 * A member engine: `answer` settles at once with audio, `hold` leaves the call for the test to
 * settle, a function decides per call. Aborting a held call rejects it.
 */
function fakeEngine(id: string, keyed: boolean) {
  const calls: Call[] = [];
  let behaviour: Behaviour = "answer";
  const engine: Engine = {
    id,
    keyed,
    voices: [voice(`${id}-pl`), voice(`${id}-en`), voice(`${id}-alt`)],
    synthesize(text, v, signal, hooks) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const call: Call = { text, voice: v, hooks, resolve, reject };
        calls.push(call);
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        if (behaviour === "answer") resolve(new Uint8Array([1]).buffer);
        else if (typeof behaviour === "function") behaviour(call);
      });
    },
  };
  return {
    engine,
    calls,
    set(next: Behaviour) {
      behaviour = next;
    },
  };
}

type Fake = ReturnType<typeof fakeEngine>;

const voicesOf = (id: string) => ({ pl: `${id}-pl`, en: `${id}-en`, default: `${id}-en` });

/** Keyed members `a`, `b`, `c` (with keys unless overridden) and the keyless `edge`. */
function setup(
  engines: Record<string, Partial<EngineConfig>> = {
    a: { apiKey: "k" },
    b: { apiKey: "k" },
    edge: {},
    cascade: { order: ["a", "b", "edge"] },
  },
  scheduler: TtsConfig["scheduler"] = { concurrency: 4, tiers: [{ name: "play" }, { name: "warm" }] },
) {
  const fakes: Record<string, Fake> = {};
  const factories: Record<string, () => Engine> = {};
  for (const id of Object.keys(engines)) {
    if (id === "cascade") continue;
    const fake = fakeEngine(id, id !== "edge");
    fakes[id] = fake;
    factories[id] = () => fake.engine;
  }
  const config: TtsConfig = {
    engines: Object.fromEntries(
      Object.entries(engines).map(([id, c]) => [id, id === "cascade" ? c : { voices: voicesOf(id), ...c }]),
    ) as TtsConfig["engines"],
    defaultEngine: "cascade",
    scheduler,
  };
  const tts = createTts(config, { engineFactories: factories });
  return { tts, fakes };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const fake = (fakes: Record<string, Fake>, id: string): Fake => fakes[id]!;

describe("cascade", () => {
  it("the first member speaks", async () => {
    const { tts, fakes } = setup();
    const result = await tts.synthesize({ text: "cześć", lang: "pl" });
    expect(result.engine).toBe("a");
    expect(result.voice).toBe("a-pl");
    expect(fake(fakes, "a").calls.map((c) => c.voice)).toEqual(["a-pl"]);
    expect(fake(fakes, "b").calls).toHaveLength(0);
    expect(fake(fakes, "edge").calls).toHaveLength(0);
  });

  it("a member without a key is skipped", async () => {
    const { tts, fakes } = setup({ a: {}, b: { apiKey: "" }, edge: {}, cascade: { order: ["a", "b", "edge"] } });
    const result = await tts.synthesize({ text: "cześć", lang: "pl", engine: "cascade" });
    expect(result.engine).toBe("edge");
    expect(fake(fakes, "a").calls).toHaveLength(0);
    expect(fake(fakes, "b").calls).toHaveLength(0);
    // Every member skipped: the last skip reason.
    const { tts: none } = setup({ a: {}, cascade: { order: ["a"] } });
    await expect(none.synthesize({ text: "x", lang: "pl" })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("per-request voices", async () => {
    const { tts, fakes } = setup();
    const chosen = await tts.synthesize({ text: "one", lang: "pl", voices: { a: "a-alt", edge: "edge-alt" } });
    expect(chosen).toMatchObject({ engine: "a", voice: "a-alt" });
    const mapped = await tts.synthesize({ text: "two", lang: "en", voices: { b: "b-alt" } });
    expect(mapped).toMatchObject({ engine: "a", voice: "a-en" });
    expect(fake(fakes, "a").calls.map((c) => c.voice)).toEqual(["a-alt", "a-en"]);
    // A voice outside the member's catalog is refused, not swapped for another member.
    await expect(tts.synthesize({ text: "three", lang: "pl", voices: { a: "nope" } })).rejects.toMatchObject({
      kind: "unknown-voice",
    });
    expect(fake(fakes, "b").calls).toHaveLength(0);
  });

  it("per-request order", async () => {
    const { tts, fakes } = setup();
    fake(fakes, "edge").set((call) => call.reject(new TtsError("rejected")));
    const result = await tts.synthesize({ text: "x", lang: "pl", order: ["edge", "unknown", "cascade", "b"] });
    expect(result.engine).toBe("b");
    expect(fake(fakes, "edge").calls).toHaveLength(1);
    expect(fake(fakes, "a").calls).toHaveLength(0);
    await expect(tts.synthesize({ text: "y", lang: "pl", order: ["unknown"] })).rejects.toBeInstanceOf(RangeError);
    await expect(tts.synthesize({ text: "y", lang: "pl", order: [] })).rejects.toBeInstanceOf(RangeError);
  });

  it("per-request pronunciation", async () => {
    const { tts, fakes } = setup({ a: { apiKey: "k" }, edge: {}, cascade: { order: ["a", "edge"] } });
    const text = "Claude pisze w React";
    const prepared = applyPronunciation(text, "pl");
    expect(prepared).not.toBe(text);
    await tts.synthesize({ text, lang: "pl" });
    await tts.synthesize({ text, lang: "pl", pronunciation: { a: true } });
    expect(fake(fakes, "a").calls.map((c) => c.text)).toEqual([text, prepared]);
    // edge is on by default; the override turns it off.
    fake(fakes, "a").set((call) => call.reject(new TtsError("rejected")));
    await tts.synthesize({ text: "Claude", lang: "pl", order: ["edge"] });
    await tts.synthesize({ text: "Claude", lang: "pl", order: ["edge"], pronunciation: { edge: false } });
    expect(fake(fakes, "edge").calls.map((c) => c.text)).toEqual([applyPronunciation("Claude", "pl"), "Claude"]);
  });

  it("a cached member answers first", async () => {
    const { tts, fakes } = setup();
    const req = { text: "cached", lang: "pl" };
    await tts.synthesize({ ...req, engine: "b" });
    expect(tts.state(req)).toBe("ready");
    expect(tts.isCached(req)).toBe(true);
    const result = await tts.synthesize(req);
    expect(result).toMatchObject({ engine: "b", voice: "b-pl" });
    expect(fake(fakes, "a").calls).toHaveLength(0);
    expect(fake(fakes, "b").calls).toHaveLength(1);
    expect(tts.isCached({ text: "other", lang: "pl" })).toBe(false);
    expect(tts.state({ text: "other", lang: "pl" })).toBe("cold");
  });

  it("a busy member is waited for", async () => {
    const { tts, fakes } = setup({ a: { apiKey: "k", maxConcurrent: 1 }, b: { apiKey: "k" }, cascade: { order: ["a", "b"] } });
    const a = fake(fakes, "a");
    a.set("hold");
    const direct = tts.synthesize({ text: "first", lang: "pl", engine: "a" });
    const cascaded = tts.synthesize({ text: "second", lang: "pl" });
    await flush();
    expect(tts.state({ text: "second", lang: "pl" })).toBe("pending");
    expect(a.calls.map((c) => c.text)).toEqual(["first"]);
    expect(fake(fakes, "b").calls).toHaveLength(0);
    a.calls[0]!.resolve(new Uint8Array([1]).buffer);
    await direct;
    await flush();
    expect(a.calls.map((c) => c.text)).toEqual(["first", "second"]);
    a.calls[1]!.resolve(new Uint8Array([2]).buffer);
    expect(await cascaded).toMatchObject({ engine: "a" });
    expect(fake(fakes, "b").calls).toHaveLength(0);
  });

  it("invalid configuration throws", () => {
    expect(() => setup({ a: { apiKey: "k" }, cascade: { order: ["a", "nope"] } })).toThrow(RangeError);
    expect(() => setup({ a: { apiKey: "k" }, cascade: { order: ["a", "cascade"] } })).toThrow(RangeError);
    expect(() => setup({ a: { apiKey: "k" }, cascade: { order: ["a"], voices: { default: "a-pl" } } })).toThrow(RangeError);
    expect(() => setup({ a: { apiKey: "k" }, cascade: {} })).toThrow(RangeError);
  });

  it("a single voice is refused", async () => {
    const { tts, fakes } = setup();
    await expect(tts.synthesize({ text: "x", lang: "pl", voice: "a-pl" })).rejects.toMatchObject({ kind: "unknown-voice" });
    expect(fake(fakes, "a").calls).toHaveLength(0);
  });

  it("transient failure moves on without a window", async () => {
    const { tts, fakes } = setup();
    const a = fake(fakes, "a");
    a.set((call) => call.reject(new TtsError("network")));
    expect(await tts.synthesize({ text: "one", lang: "pl" })).toMatchObject({ engine: "b" });
    // One attempt plus the default retry.
    expect(a.calls).toHaveLength(2);
    a.set("answer");
    expect(await tts.synthesize({ text: "two", lang: "pl" })).toMatchObject({ engine: "a" });
    expect(a.calls).toHaveLength(3);
  });

  it("unknown voice does not switch", async () => {
    const { tts, fakes } = setup();
    const a = fake(fakes, "a");
    a.set((call) => call.reject(new TtsError("unknown-voice")));
    await expect(tts.synthesize({ text: "one", lang: "pl" })).rejects.toMatchObject({ kind: "unknown-voice" });
    expect(fake(fakes, "b").calls).toHaveLength(0);
    // An abort stops the chain as well.
    a.set("hold");
    const controller = new AbortController();
    const pending = tts.synthesize({ text: "two", lang: "pl", signal: controller.signal });
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(fake(fakes, "b").calls).toHaveLength(0);
    expect(fake(fakes, "edge").calls).toHaveLength(0);
  });

  it("phase hooks fire once across members", async () => {
    const { tts, fakes } = setup();
    // Both members start and stream; `a` then fails, `b` answers.
    fake(fakes, "a").set((call) => {
      call.hooks?.onFirstByte?.();
      call.reject(new TtsError("rejected"));
    });
    fake(fakes, "b").set((call) => {
      call.hooks?.onFirstByte?.();
      call.resolve(new Uint8Array([1]).buffer);
    });
    let starts = 0;
    let firstBytes = 0;
    const result = await tts.synthesize({ text: "x", lang: "pl", onStart: () => starts++, onFirstByte: () => firstBytes++ });
    await flush();
    expect(result).toMatchObject({ engine: "b" });
    expect(fake(fakes, "a").calls).toHaveLength(1);
    expect(starts).toBe(1);
    expect(firstBytes).toBe(1);
  });

  it("an abort wins over a member's failure", async () => {
    const { tts, fakes } = setup({ a: { apiKey: "k" }, cascade: { order: ["a"] } });
    const controller = new AbortController();
    fake(fakes, "a").set((call) => call.reject(new TtsError("rejected")));
    // The abort lands after the member failed, before the walk hands that failure to the caller.
    tts.subscribe((e) => {
      if (e.type === "drop") queueMicrotask(() => controller.abort());
    });
    await expect(tts.synthesize({ text: "x", lang: "pl", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fake(fakes, "a").calls).toHaveLength(1);
  });

  it("every member's voice is checked before the first request", async () => {
    const { tts, fakes } = setup();
    await expect(tts.synthesize({ text: "x", lang: "pl", voices: { b: "nope" } })).rejects.toMatchObject({ kind: "unknown-voice" });
    expect(fake(fakes, "a").calls).toHaveLength(0);
    expect(fake(fakes, "b").calls).toHaveLength(0);
    // A cached earlier member does not hide the bad voice either.
    await tts.synthesize({ text: "y", lang: "pl" });
    await expect(tts.synthesize({ text: "y", lang: "pl", voices: { b: "nope" } })).rejects.toMatchObject({ kind: "unknown-voice" });
    expect(tts.state({ text: "y", lang: "pl", voices: { b: "nope" } })).toBe("cold");
    expect(tts.isCached({ text: "y", lang: "pl", voices: { b: "nope" } })).toBe(false);
  });
});
