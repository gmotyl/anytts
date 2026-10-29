import { describe, expect, it } from "vitest";
import type { Engine, EngineHooks, VoiceInfo } from "../engine.js";
import { TtsError, type TtsErrorKind } from "../errors.js";
import { createTts, type TtsConfig, type TtsEvent } from "../tts.js";

const voice = (id: string): VoiceInfo => ({ id, label: id, locale: id.slice(0, 5), gender: "male", multilingual: false });

const VOICES = [voice("pl-PL-MarekNeural"), voice("en-US-AndrewMultilingualNeural"), voice("en-GB-RyanNeural")];

interface Call {
  text: string;
  voice: string;
  lang: string | undefined;
  signal: AbortSignal;
  /** Reports the first audio chunk through the hooks the engine was given. */
  firstByte: () => void;
  resolve: (bytes: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}

/** An engine whose calls the test settles by hand; aborting a call rejects it like the Edge engine does. */
function fakeEngine(id = "edge") {
  const calls: Call[] = [];
  const engine: Engine = {
    id,
    voices: VOICES,
    synthesize(text, voiceId, signal, hooks?: EngineHooks, lang?: string) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        calls.push({ text, voice: voiceId, lang, signal, firstByte: () => hooks?.onFirstByte?.(), resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
  };
  return { engine, calls };
}

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(overrides: { retries?: number; concurrency?: number; cacheMax?: number } = {}) {
  const edge = fakeEngine("edge");
  const other = fakeEngine("other");
  const config: TtsConfig = {
    engines: {
      edge: {
        voices: { pl: "pl-PL-MarekNeural", default: "en-US-AndrewMultilingualNeural" },
        retries: overrides.retries ?? 1,
      },
      other: { voices: { default: "en-GB-RyanNeural" } },
    },
    defaultEngine: "edge",
    scheduler: { concurrency: overrides.concurrency ?? 1, tiers: [{ name: "play" }, { name: "warm" }] },
    ...(overrides.cacheMax !== undefined ? { cache: { max: overrides.cacheMax } } : {}),
  };
  const factories = { edge: () => edge.engine, other: () => other.engine };
  const tts = createTts(config, { engineFactories: factories });
  return { tts, edge, other, config, factories };
}

const fail = (kind: TtsErrorKind) => new TtsError(kind);

describe("createTts", () => {
  it("a prototype key is not a language voice", async () => {
    const { tts, edge } = setup({ concurrency: 4 });
    const pending = ["constructor", "toString", "__proto__"].map((lang, i) => tts.synthesize({ text: `p${i}`, lang }));
    await flush();
    expect(edge.calls.map((c) => c.voice)).toEqual(Array(3).fill("en-US-AndrewMultilingualNeural"));
    for (const call of edge.calls) call.resolve(bytes(1));
    await Promise.all(pending);
  });

  it("voice resolution: explicit, then language map, then default", async () => {
    const { tts, edge } = setup({ concurrency: 4 });
    const explicit = tts.synthesize({ text: "a", lang: "pl", voice: "en-US-AndrewMultilingualNeural" });
    const mapped = tts.synthesize({ text: "b", lang: "pl" });
    const unmapped = tts.synthesize({ text: "c", lang: "de" });
    const none = tts.synthesize({ text: "d" });
    await flush();
    expect(edge.calls.map((c) => c.voice)).toEqual([
      "en-US-AndrewMultilingualNeural",
      "pl-PL-MarekNeural",
      "en-US-AndrewMultilingualNeural",
      "en-US-AndrewMultilingualNeural",
    ]);
    for (const call of edge.calls) call.resolve(bytes(1));
    const results = await Promise.all([explicit, mapped, unmapped, none]);
    expect(results.map((r) => r.voice)).toEqual(edge.calls.map((c) => c.voice));
    expect(results[1]).toMatchObject({ mime: "audio/mpeg", engine: "edge", voice: "pl-PL-MarekNeural" });
  });

  it("foreign voice rejects unknown-voice without calling the engine", async () => {
    const { tts, edge } = setup();
    await expect(tts.synthesize({ text: "a", voice: "xx-XX-NobodyNeural" })).rejects.toMatchObject({
      name: "TtsError",
      kind: "unknown-voice",
    });
    await flush();
    expect(edge.calls).toHaveLength(0);
  });

  it("default engine serves requests without engine", async () => {
    const { tts, edge, other } = setup();
    const result = tts.synthesize({ text: "a" });
    await flush();
    expect(edge.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(0);
    edge.calls[0]!.resolve(bytes(1));
    expect(await result).toMatchObject({ engine: "edge" });

    const explicit = tts.synthesize({ text: "a", engine: "other" });
    await flush();
    other.calls[0]!.resolve(bytes(2));
    expect(await explicit).toMatchObject({ engine: "other", voice: "en-GB-RyanNeural" });
  });

  it("passes req.lang to engine.synthesize on the direct path", async () => {
    const { tts, edge } = setup();
    const result = tts.synthesize({ engine: "edge", text: "a", lang: "pl" });
    await flush();
    expect(edge.calls.map((c) => c.lang)).toEqual(["pl"]);
    edge.calls[0]!.resolve(bytes(1));
    await result;
  });

  it("passes undefined lang when the request has none", async () => {
    const { tts, edge } = setup();
    const result = tts.synthesize({ text: "a" });
    await flush();
    expect(edge.calls).toHaveLength(1);
    expect(edge.calls[0]!.lang).toBeUndefined();
    edge.calls[0]!.resolve(bytes(1));
    await result;
  });

  it("the same text with different lang does not share a cache entry", async () => {
    // `other` has no pronunciation and no `pl` voice: same text, same voice, only `lang` differs.
    const { tts, other } = setup();
    const withLang = tts.synthesize({ engine: "other", text: "hello", lang: "pl" });
    await flush();
    other.calls[0]!.resolve(bytes(1));
    await withLang;
    expect(tts.isCached({ engine: "other", text: "hello", lang: "pl" })).toBe(true);
    expect(tts.isCached({ engine: "other", text: "hello" })).toBe(false);

    const without = tts.synthesize({ engine: "other", text: "hello" });
    await flush();
    expect(other.calls.map((c) => [c.voice, c.lang])).toEqual([
      ["en-GB-RyanNeural", "pl"],
      ["en-GB-RyanNeural", undefined],
    ]);
    other.calls[1]!.resolve(bytes(2));
    await without;
    expect(tts.isCached({ engine: "other", text: "hello", lang: "pl" })).toBe(true);
    expect(tts.isCached({ engine: "other", text: "hello" })).toBe(true);
  });

  it("duplicate requests call the engine once", async () => {
    const { tts, edge } = setup();
    const first = tts.synthesize({ text: "hello" });
    const joined = tts.synthesize({ text: "hello", voice: "en-US-AndrewMultilingualNeural" });
    await flush();
    expect(edge.calls).toHaveLength(1);
    edge.calls[0]!.resolve(bytes(1, 2, 3));
    const [a, b] = await Promise.all([first, joined]);
    expect(new Uint8Array(a.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(b.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(tts.isCached({ text: "hello" })).toBe(true);

    const hit = await tts.synthesize({ text: "hello" });
    expect(new Uint8Array(hit.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(edge.calls).toHaveLength(1);
  });

  it("joining with a higher tier promotes the job", async () => {
    const { tts, edge } = setup();
    const busy = tts.synthesize({ text: "busy", tier: "play" });
    const warmA = tts.synthesize({ text: "a", tier: "warm" });
    const warmB = tts.synthesize({ text: "b", tier: "warm" });
    tts.synthesize({ text: "b", tier: "play" });
    await flush();
    expect(edge.calls.map((c) => c.text)).toEqual(["busy"]);
    edge.calls[0]!.resolve(bytes(1));
    await busy;
    await flush();
    // "b" was promoted to play, so it takes the slot before the older warm "a".
    expect(edge.calls.map((c) => c.text)).toEqual(["busy", "b"]);
    edge.calls[1]!.resolve(bytes(2));
    await warmB;
    await flush();
    edge.calls[2]!.resolve(bytes(3));
    await warmA;
  });

  it("transient failure retries up to the limit", async () => {
    const { tts, edge } = setup({ retries: 1 });
    const recovered = tts.synthesize({ text: "a" });
    await flush();
    edge.calls[0]!.reject(fail("network"));
    await flush();
    expect(edge.calls).toHaveLength(2);
    edge.calls[1]!.resolve(bytes(9));
    expect(new Uint8Array((await recovered).bytes)).toEqual(new Uint8Array([9]));

    const exhausted = tts.synthesize({ text: "b" });
    await flush();
    edge.calls[2]!.reject(fail("first-byte-timeout"));
    await flush();
    edge.calls[3]!.reject(fail("stalled"));
    await expect(exhausted).rejects.toMatchObject({ kind: "stalled" });
    await flush();
    expect(edge.calls).toHaveLength(4);
  });

  it("non-transient failure is not retried", async () => {
    const { tts, edge } = setup({ retries: 3 });
    const result = tts.synthesize({ text: "a" });
    await flush();
    edge.calls[0]!.reject(fail("no-audio"));
    await expect(result).rejects.toMatchObject({ kind: "no-audio" });
    await flush();
    expect(edge.calls).toHaveLength(1);
  });

  it("an aborted signal rejects on a cache hit", async () => {
    const { tts, edge } = setup();
    const first = tts.synthesize({ text: "a" });
    await flush();
    edge.calls[0]!.resolve(bytes(1));
    await first;
    const controller = new AbortController();
    controller.abort();
    await expect(tts.synthesize({ text: "a", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a prototype key is not an engine id", () => {
    const { factories } = setup();
    for (const id of ["constructor", "toString", "__proto__"]) {
      const config: TtsConfig = {
        engines: { [id]: { voices: { default: "x" } } },
        defaultEngine: id,
        scheduler: { concurrency: 1, tiers: [{ name: "play" }] },
      };
      expect(() => createTts(config, { engineFactories: factories })).toThrow(RangeError);
    }
  });

  it("failures are not cached", async () => {
    const { tts, edge } = setup({ retries: 0 });
    const first = tts.synthesize({ text: "a" });
    await flush();
    edge.calls[0]!.reject(fail("network"));
    await expect(first).rejects.toMatchObject({ kind: "network" });
    expect(tts.isCached({ text: "a" })).toBe(false);

    const second = tts.synthesize({ text: "a" });
    await flush();
    expect(edge.calls).toHaveLength(2);
    edge.calls[1]!.resolve(bytes(1));
    await second;
    expect(tts.isCached({ text: "a" })).toBe(true);
  });

  it("aborting the only caller cancels the job", async () => {
    const { tts, edge } = setup();
    // In flight: the engine signal aborts.
    const flying = new AbortController();
    const inFlight = tts.synthesize({ text: "a", signal: flying.signal });
    // Queued: the job leaves the queue and never reaches the engine.
    const queuing = new AbortController();
    const queued = tts.synthesize({ text: "b", signal: queuing.signal });
    await flush();
    expect(edge.calls.map((c) => c.text)).toEqual(["a"]);

    queuing.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    flying.abort();
    await expect(inFlight).rejects.toMatchObject({ name: "AbortError" });
    expect(edge.calls[0]!.signal.aborted).toBe(true);
    await flush();
    expect(edge.calls).toHaveLength(1);

    // The freed slot serves new work, and an aborted key is not joined.
    const again = tts.synthesize({ text: "a" });
    await flush();
    expect(edge.calls).toHaveLength(2);
    edge.calls[1]!.resolve(bytes(1));
    await again;
  });

  it("aborting one of two callers keeps the job", async () => {
    const { tts, edge } = setup();
    const leaving = new AbortController();
    const left = tts.synthesize({ text: "a", signal: leaving.signal });
    const staying = tts.synthesize({ text: "a", signal: new AbortController().signal });
    await flush();
    leaving.abort();
    await expect(left).rejects.toMatchObject({ name: "AbortError" });
    expect(edge.calls[0]!.signal.aborted).toBe(false);
    edge.calls[0]!.resolve(bytes(7));
    expect(new Uint8Array((await staying).bytes)).toEqual(new Uint8Array([7]));
  });

  it("both callers aborting cancels the job", async () => {
    const { tts, edge } = setup();
    const blocker = tts.synthesize({ text: "busy" });
    const first = new AbortController();
    const second = new AbortController();
    const a = tts.synthesize({ text: "a", signal: first.signal });
    const b = tts.synthesize({ text: "a", signal: second.signal });
    await flush();
    expect(edge.calls.map((c) => c.text)).toEqual(["busy"]);
    first.abort();
    second.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    edge.calls[0]!.resolve(bytes(1));
    await blocker;
    await flush();
    // The queued job was dropped: the freed slot never runs it.
    expect(edge.calls.map((c) => c.text)).toEqual(["busy"]);
    expect(tts.isCached({ text: "a" })).toBe(false);
  });

  it("the last of two callers aborting after start aborts the engine signal", async () => {
    const { tts, edge } = setup();
    const first = new AbortController();
    const second = new AbortController();
    const a = tts.synthesize({ text: "a", signal: first.signal });
    const b = tts.synthesize({ text: "a", signal: second.signal });
    await flush();
    expect(edge.calls).toHaveLength(1);
    first.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(edge.calls[0]!.signal.aborted).toBe(false);
    second.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect(edge.calls[0]!.signal.aborted).toBe(true);
    await flush();
    expect(tts.isCached({ text: "a" })).toBe(false);
  });

  it("unknown tier rejects instead of throwing", async () => {
    const { tts, edge } = setup();
    let fresh: Promise<unknown> | undefined;
    expect(() => {
      fresh = tts.synthesize({ text: "a", tier: "bogus" });
    }).not.toThrow();
    await expect(fresh).rejects.toThrow(RangeError);
    // Joining an in-flight job with an unknown tier rejects too, and leaves the job alone.
    const owner = tts.synthesize({ text: "b" });
    let joined: Promise<unknown> | undefined;
    expect(() => {
      joined = tts.synthesize({ text: "b", tier: "bogus" });
    }).not.toThrow();
    await expect(joined).rejects.toThrow(RangeError);
    await flush();
    expect(edge.calls.map((c) => c.text)).toEqual(["b"]);
    edge.calls[0]!.resolve(bytes(3));
    expect(new Uint8Array((await owner).bytes)).toEqual(new Uint8Array([3]));
  });

  it("prefetch with an unknown tier does not throw", async () => {
    const { tts, edge } = setup();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => tts.prefetch({ text: "a", tier: "bogus" })).not.toThrow();
      const owner = tts.synthesize({ text: "b" });
      expect(() => tts.prefetch({ text: "b", tier: "bogus" })).not.toThrow();
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await owner;
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("prefetch swallows failures", async () => {
    const { tts, edge } = setup({ retries: 0 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      tts.prefetch({ text: "a" });
      tts.prefetch({ text: "b", voice: "xx-XX-NobodyNeural" });
      await flush();
      edge.calls[0]!.reject(fail("no-audio"));
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
      expect(tts.isCached({ text: "a" })).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("instances share no cache", async () => {
    const { tts: a, edge, config, factories } = setup();
    const b = createTts(config, { engineFactories: factories });
    const events: string[] = [];
    b.subscribe((e) => events.push(e.type));
    const done = a.synthesize({ text: "hello" });
    await flush();
    edge.calls[0]!.resolve(bytes(1));
    await done;
    expect(a.isCached({ text: "hello" })).toBe(true);
    expect(b.isCached({ text: "hello" })).toBe(false);
    expect(events).toEqual([]);
  });

  describe("in-flight state", () => {
    const key = (text: string, engine = "edge", voice = "en-US-AndrewMultilingualNeural") =>
      JSON.stringify([engine, voice, null, text]);
    const record = (tts: ReturnType<typeof setup>["tts"]) => {
      const events: TtsEvent[] = [];
      const unsubscribe = tts.subscribe((e) => events.push(e));
      return { events, unsubscribe };
    };

    it("state is pending from the call until the result lands, then ready", async () => {
      const { tts, edge } = setup({ concurrency: 1 });
      expect(tts.state({ text: "a" })).toBe("cold");
      const result = tts.synthesize({ text: "a" });
      // Synchronously after the call.
      expect(tts.state({ text: "a" })).toBe("pending");
      // prefetch takes the same path; with the only slot busy, "b" is pending before the engine is reached.
      tts.prefetch({ text: "b" });
      expect(tts.state({ text: "b" })).toBe("pending");
      await flush();
      expect(edge.calls.map((c) => c.text)).toEqual(["a"]);
      expect(tts.state({ text: "a" })).toBe("pending");
      expect(tts.state({ text: "b" })).toBe("pending");
      edge.calls[0]!.resolve(bytes(1));
      await result;
      expect(tts.state({ text: "a" })).toBe("ready");
      expect(tts.isCached({ text: "a" })).toBe(true);
      await flush();
      expect(edge.calls.map((c) => c.text)).toEqual(["a", "b"]);
      expect(tts.state({ text: "b" })).toBe("pending");
      edge.calls[1]!.resolve(bytes(2));
      await flush();
      expect(tts.state({ text: "b" })).toBe("ready");
    });

    it("state returns to cold and drop is emitted when the engine fails for good", async () => {
      const { tts, edge } = setup({ retries: 0 });
      const { events } = record(tts);
      const result = tts.synthesize({ text: "a" });
      expect(tts.state({ text: "a" })).toBe("pending");
      await flush();
      edge.calls[0]!.reject(fail("no-audio"));
      await expect(result).rejects.toMatchObject({ kind: "no-audio" });
      await flush();
      expect(tts.state({ text: "a" })).toBe("cold");
      expect(tts.isCached({ text: "a" })).toBe(false);
      expect(events).toEqual([
        { type: "pending", key: key("a") },
        { type: "drop", key: key("a") },
      ]);
    });

    it("state returns to cold and drop is emitted when a queued job is aborted", async () => {
      const { tts, edge } = setup();
      const { events } = record(tts);
      const blocker = tts.synthesize({ text: "busy" });
      const controller = new AbortController();
      const queued = tts.synthesize({ text: "a", signal: controller.signal });
      await flush();
      expect(edge.calls.map((c) => c.text)).toEqual(["busy"]);
      expect(tts.state({ text: "a" })).toBe("pending");
      controller.abort();
      expect(tts.state({ text: "a" })).toBe("cold");
      await expect(queued).rejects.toMatchObject({ name: "AbortError" });
      // Let the removed job's rejection run its release handler: no second drop.
      edge.calls[0]!.resolve(bytes(1));
      await blocker;
      await flush();
      expect(tts.isCached({ text: "a" })).toBe(false);
      expect(events.filter((e) => e.key === key("a"))).toEqual([
        { type: "pending", key: key("a") },
        { type: "drop", key: key("a") },
      ]);
    });

    it("drop is emitted once when a running job is aborted by its last caller", async () => {
      const { tts, edge } = setup();
      const { events } = record(tts);
      const controller = new AbortController();
      const running = tts.synthesize({ text: "a", signal: controller.signal });
      await flush();
      expect(edge.calls).toHaveLength(1);
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(edge.calls[0]!.signal.aborted).toBe(true);
      await flush();
      await flush();
      expect(tts.state({ text: "a" })).toBe("cold");
      expect(events).toEqual([
        { type: "pending", key: key("a") },
        { type: "drop", key: key("a") },
      ]);
    });

    it("a success emits pending then add, once each", async () => {
      const { tts, edge } = setup();
      const { events } = record(tts);
      const result = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await result;
      await flush();
      expect(events).toEqual([
        { type: "pending", key: key("a") },
        { type: "add", key: key("a") },
      ]);
    });

    it("a joining caller and a promotion emit nothing", async () => {
      const { tts, edge } = setup();
      const { events } = record(tts);
      const busy = tts.synthesize({ text: "busy", tier: "play" });
      const warm = tts.synthesize({ text: "a", tier: "warm" });
      // Joins the queued job and promotes it to play.
      const promoted = tts.synthesize({ text: "a", tier: "play" });
      // Joins again without a tier change.
      const joined = tts.synthesize({ text: "a", tier: "play" });
      expect(events).toEqual([
        { type: "pending", key: key("busy") },
        { type: "pending", key: key("a") },
      ]);
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await busy;
      await flush();
      edge.calls[1]!.resolve(bytes(2));
      await Promise.all([warm, promoted, joined]);
      await flush();
      expect(events.map((e) => e.type)).toEqual(["pending", "pending", "add", "add"]);
    });

    it("a retried transient failure emits nothing between attempts", async () => {
      const { tts, edge } = setup({ retries: 1 });
      const { events } = record(tts);
      const result = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.reject(fail("network"));
      await flush();
      expect(edge.calls).toHaveLength(2);
      expect(tts.state({ text: "a" })).toBe("pending");
      expect(events).toEqual([{ type: "pending", key: key("a") }]);
      edge.calls[1]!.resolve(bytes(1));
      await result;
      expect(events).toEqual([
        { type: "pending", key: key("a") },
        { type: "add", key: key("a") },
      ]);
    });

    it("state answers cold for an unknown voice without throwing", () => {
      const { tts } = setup();
      expect(() => tts.state({ text: "a", voice: "xx-XX-NobodyNeural" })).not.toThrow();
      expect(tts.state({ text: "a", voice: "xx-XX-NobodyNeural" })).toBe("cold");
      expect(() => tts.state({ text: "a", engine: "nope" })).not.toThrow();
      expect(tts.state({ text: "a", engine: "nope" })).toBe("cold");
    });

    it("evict still reaches a tts subscriber when the cache overflows", async () => {
      const { tts, edge } = setup({ cacheMax: 1 });
      const { events } = record(tts);
      const first = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await first;
      const second = tts.synthesize({ text: "b" });
      await flush();
      edge.calls[1]!.resolve(bytes(2));
      await second;
      await flush();
      expect(events).toEqual([
        { type: "pending", key: key("a") },
        { type: "add", key: key("a") },
        { type: "pending", key: key("b") },
        { type: "add", key: key("b") },
        { type: "evict", key: key("a") },
      ]);
      expect(tts.isCached({ text: "a" })).toBe(false);
      expect(tts.state({ text: "a" })).toBe("cold");
    });

    it("unsubscribe silences both cache and in-flight events", async () => {
      const { tts, edge } = setup({ retries: 0 });
      const { events, unsubscribe } = record(tts);
      const other: TtsEvent[] = [];
      tts.subscribe((e) => other.push(e));
      const first = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await first;
      expect(events.map((e) => e.type)).toEqual(["pending", "add"]);
      unsubscribe();
      const second = tts.synthesize({ text: "b" });
      await flush();
      edge.calls[1]!.resolve(bytes(2));
      await second;
      const failing = tts.synthesize({ text: "c" });
      await flush();
      edge.calls[2]!.reject(fail("no-audio"));
      await expect(failing).rejects.toMatchObject({ kind: "no-audio" });
      await flush();
      expect(events.map((e) => e.type)).toEqual(["pending", "add"]);
      // The other listener keeps receiving every kind of event.
      expect(other.map((e) => e.type)).toEqual(["pending", "add", "pending", "add", "pending", "drop"]);
    });

    it("a listener that aborts the caller's signal on pending still gets AbortError", async () => {
      const { tts, edge } = setup();
      const { events } = record(tts);
      const controller = new AbortController();
      // Abort from inside the pending notification, before synthesize has registered its abort listener.
      tts.subscribe((e) => {
        if (e.type === "pending") controller.abort();
      });
      const result = tts.synthesize({ text: "a", signal: controller.signal });
      // Attach the handler before yielding: a synchronous rejection must not be reported as unhandled.
      const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await flush();
      // Settle any engine call by hand: a correctly aborted call ignores this, a leaked one would resolve the caller.
      edge.calls[0]?.resolve(bytes(1));
      await rejection;
      await flush();
      expect(tts.state({ text: "a" })).toBe("cold");
      expect(tts.isCached({ text: "a" })).toBe(false);
      expect(events).toEqual([
        { type: "pending", key: key("a") },
        { type: "drop", key: key("a") },
      ]);
      // The free scheduler slot may have reached the engine synchronously; if so, its signal must be aborted.
      if (edge.calls.length === 1) expect(edge.calls[0]!.signal.aborted).toBe(true);
    });
  });
  describe("phase hooks", () => {
    /** Hooks that log their phase, tagged so several callers can share one log. */
    const phases = (log: string[], tag = "") => ({
      onStart: () => log.push(`${tag}start`),
      onFirstByte: () => log.push(`${tag}firstByte`),
    });

    it("onStart fires when the job leaves the queue, onFirstByte on the first chunk", async () => {
      const { tts, edge } = setup({ concurrency: 1 });
      const blocker = tts.synthesize({ text: "blocker" });
      const log: string[] = [];
      const result = tts.synthesize({ text: "a", ...phases(log) });
      await flush();
      // Still queued behind the blocker.
      expect(edge.calls).toHaveLength(1);
      expect(log).toEqual([]);
      edge.calls[0]!.resolve(bytes(1));
      await blocker;
      await flush();
      expect(edge.calls).toHaveLength(2);
      expect(log).toEqual(["start"]);
      edge.calls[1]!.firstByte();
      expect(log).toEqual(["start", "firstByte"]);
      edge.calls[1]!.firstByte();
      edge.calls[1]!.resolve(bytes(2));
      await result;
      await flush();
      expect(log).toEqual(["start", "firstByte"]);
    });

    it("a late joiner gets passed phases asynchronously", async () => {
      const { tts, edge } = setup({ concurrency: 2 });
      const first = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.firstByte();

      const log: string[] = [];
      const joined = tts.synthesize({ text: "a", ...phases(log) });
      expect(log).toEqual([]);
      await Promise.resolve();
      expect(log).toEqual(["start", "firstByte"]);

      // A joiner past only the start learns it late and the first byte live.
      const startedLog: string[] = [];
      const second = tts.synthesize({ text: "b" });
      await flush();
      const started = tts.synthesize({ text: "b", ...phases(startedLog) });
      expect(startedLog).toEqual([]);
      await Promise.resolve();
      expect(startedLog).toEqual(["start"]);

      edge.calls[1]!.firstByte();
      expect(startedLog).toEqual(["start", "firstByte"]);
      edge.calls[0]!.resolve(bytes(1));
      edge.calls[1]!.resolve(bytes(2));
      await Promise.all([first, joined, second, started]);
      expect(log).toEqual(["start", "firstByte"]);
    });

    it("a cache hit fires both hooks", async () => {
      const { tts, edge } = setup();
      const warm = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.resolve(bytes(7));
      await warm;

      const log: string[] = [];
      const hit = tts.synthesize({ text: "a", ...phases(log) });
      expect(log).toEqual([]);
      const result = await hit;
      expect(log).toEqual(["start", "firstByte"]);
      expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([7]));
      expect(edge.calls).toHaveLength(1);
    });

    it("a retry does not re-fire hooks", async () => {
      const { tts, edge } = setup({ retries: 1 });
      const log: string[] = [];
      const result = tts.synthesize({ text: "a", ...phases(log) });
      await flush();
      edge.calls[0]!.firstByte();
      edge.calls[0]!.reject(fail("network"));
      await flush();
      expect(edge.calls).toHaveLength(2);
      edge.calls[1]!.firstByte();
      edge.calls[1]!.resolve(bytes(1));
      await result;
      expect(log).toEqual(["start", "firstByte"]);
    });

    it("a throwing hook does not fail the synthesis", async () => {
      const { tts, edge } = setup();
      const thrower = {
        onStart: () => {
          throw new Error("start hook");
        },
        onFirstByte: () => {
          throw new Error("first-byte hook");
        },
      };
      const log: string[] = [];
      const live = tts.synthesize({ text: "a", ...thrower });
      const other = tts.synthesize({ text: "a", ...phases(log) });
      await flush();
      edge.calls[0]!.firstByte();
      const late = tts.synthesize({ text: "a", ...thrower });
      await flush();
      edge.calls[0]!.resolve(bytes(3));
      const results = await Promise.all([live, other, late]);
      expect(results.map((r) => new Uint8Array(r.bytes))).toEqual(Array(3).fill(new Uint8Array([3])));
      // The throwing caller does not starve the others.
      expect(log).toEqual(["start", "firstByte"]);

      const hit = await tts.synthesize({ text: "a", ...thrower });
      expect(new Uint8Array(hit.bytes)).toEqual(new Uint8Array([3]));
    });

    it("an aborted caller's hooks are not called", async () => {
      const { tts, edge } = setup({ concurrency: 1 });
      const blocker = tts.synthesize({ text: "blocker" });
      const aborted: string[] = [];
      const kept: string[] = [];
      const controller = new AbortController();
      const gone = tts.synthesize({ text: "a", signal: controller.signal, ...phases(aborted) });
      const stays = tts.synthesize({ text: "a", ...phases(kept) });
      controller.abort();
      await expect(gone).rejects.toMatchObject({ name: "AbortError" });

      edge.calls[0]!.resolve(bytes(1));
      await blocker;
      await flush();
      edge.calls[1]!.firstByte();

      // A late joiner aborting before its catch-up microtask hears nothing either.
      const lateController = new AbortController();
      const lateLog: string[] = [];
      const late = tts.synthesize({ text: "a", signal: lateController.signal, ...phases(lateLog) });
      lateController.abort();
      await expect(late).rejects.toMatchObject({ name: "AbortError" });

      edge.calls[1]!.resolve(bytes(2));
      await stays;
      await flush();
      expect(kept).toEqual(["start", "firstByte"]);
      expect(aborted).toEqual([]);
      expect(lateLog).toEqual([]);

      // Nor does a cache hit aborted right after the call.
      const hitController = new AbortController();
      const hitLog: string[] = [];
      const hit = tts.synthesize({ text: "a", signal: hitController.signal, ...phases(hitLog) });
      hitController.abort();
      await hit;
      await flush();
      expect(hitLog).toEqual([]);
    });

    it("a settled flight releases its callers' hooks", async () => {
      const { tts, edge } = setup();
      const log: string[] = [];
      const result = tts.synthesize({ text: "a", ...phases(log) });
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await result;
      await flush();
      // An engine still holding its hooks after the settle reaches no caller.
      edge.calls[0]!.firstByte();
      expect(log).toEqual(["start"]);
    });

    it("an onStart that aborts the only caller skips the engine", async () => {
      const { tts, edge } = setup({ concurrency: 1 });
      const blocker = tts.synthesize({ text: "blocker" });
      const controller = new AbortController();
      const result = tts.synthesize({ text: "a", signal: controller.signal, onStart: () => controller.abort() });
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await blocker;
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      await flush();
      expect(edge.calls).toHaveLength(1);
      expect(tts.state({ text: "a" })).toBe("cold");
    });

    it("prefetch forwards hooks", async () => {
      const { tts, edge } = setup({ concurrency: 1 });
      const blocker = tts.synthesize({ text: "blocker" });
      const log: string[] = [];
      tts.prefetch({ text: "a", ...phases(log) });
      await flush();
      expect(log).toEqual([]);
      edge.calls[0]!.resolve(bytes(1));
      await blocker;
      await flush();
      expect(log).toEqual(["start"]);
      edge.calls[1]!.firstByte();
      expect(log).toEqual(["start", "firstByte"]);
      edge.calls[1]!.resolve(bytes(2));
      await flush();
      expect(tts.isCached({ text: "a" })).toBe(true);
    });
  });

  describe("restartStalled", () => {
    it("restartStalled aborts a pre-first-byte attempt into its retry", async () => {
      const { tts, edge } = setup({ retries: 1 });
      const log: string[] = [];
      const result = tts.synthesize({
        text: "a",
        onStart: () => log.push("start"),
        onFirstByte: () => log.push("firstByte"),
      });
      await flush();
      expect(edge.calls).toHaveLength(1);
      expect(tts.restartStalled()).toBe(true);
      expect(edge.calls[0]!.signal.aborted).toBe(true);
      await flush();
      expect(edge.calls).toHaveLength(2);
      expect(edge.calls[1]!.signal.aborted).toBe(false);
      edge.calls[1]!.firstByte();
      edge.calls[1]!.resolve(bytes(5));
      expect(new Uint8Array((await result).bytes)).toEqual(new Uint8Array([5]));
      // Phases fire once per flight across the restart.
      expect(log).toEqual(["start", "firstByte"]);
    });

    it("restartStalled on the last attempt rejects with first-byte-timeout", async () => {
      const { tts, edge } = setup({ retries: 0 });
      const result = tts.synthesize({ text: "a" });
      await flush();
      expect(tts.restartStalled()).toBe(true);
      await expect(result).rejects.toMatchObject({ name: "TtsError", kind: "first-byte-timeout" });
      expect(edge.calls).toHaveLength(1);
      expect(tts.state({ text: "a" })).toBe("cold");
    });

    it("restartStalled returns false when nothing is running", async () => {
      const { tts, edge } = setup();
      expect(tts.restartStalled()).toBe(false);
      const done = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.resolve(bytes(1));
      await done;
      expect(tts.restartStalled()).toBe(false);
    });

    it("restartStalled leaves a streaming attempt alone", async () => {
      const { tts, edge } = setup({ concurrency: 2 });
      const streaming = tts.synthesize({ text: "a" });
      await flush();
      edge.calls[0]!.firstByte();
      expect(tts.restartStalled()).toBe(false);
      expect(edge.calls[0]!.signal.aborted).toBe(false);

      // Only the silent one of two running attempts is restarted.
      const silent = tts.synthesize({ text: "b" });
      await flush();
      expect(tts.restartStalled()).toBe(true);
      expect(edge.calls[0]!.signal.aborted).toBe(false);
      expect(edge.calls[1]!.signal.aborted).toBe(true);
      await flush();
      expect(edge.calls).toHaveLength(3);
      edge.calls[0]!.resolve(bytes(1));
      edge.calls[2]!.resolve(bytes(2));
      await Promise.all([streaming, silent]);
    });

    it("a caller abort during a restarted attempt yields AbortError", async () => {
      const { tts, edge } = setup({ retries: 1 });
      const controller = new AbortController();
      const result = tts.synthesize({ text: "a", signal: controller.signal });
      await flush();
      expect(tts.restartStalled()).toBe(true);
      await flush();
      expect(edge.calls).toHaveLength(2);
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(edge.calls[1]!.signal.aborted).toBe(true);
      await flush();
      expect(edge.calls).toHaveLength(2);
      expect(tts.restartStalled()).toBe(false);
    });

    it("a second restartStalled before the retry starts is a no-op", async () => {
      const { tts, edge } = setup({ retries: 2 });
      const result = tts.synthesize({ text: "a" });
      await flush();
      expect(tts.restartStalled()).toBe(true);
      expect(tts.restartStalled()).toBe(false);
      await flush();
      // One restart spent one retry: the second attempt is running, one retry remains.
      expect(edge.calls).toHaveLength(2);
      edge.calls[1]!.resolve(bytes(1));
      await result;
    });

    it("a late first byte from a restarted attempt is ignored", async () => {
      const { tts, edge } = setup({ retries: 2 });
      const log: string[] = [];
      const result = tts.synthesize({ text: "a", onFirstByte: () => log.push("firstByte") });
      await flush();
      expect(tts.restartStalled()).toBe(true);
      await flush();
      expect(edge.calls).toHaveLength(2);
      // The abandoned call reports audio after it was replaced.
      edge.calls[0]!.firstByte();
      await flush();
      expect(log).toEqual([]);
      // The replacement is still silent, so it stays restartable.
      expect(tts.restartStalled()).toBe(true);
      await flush();
      expect(edge.calls).toHaveLength(3);
      edge.calls[2]!.resolve(bytes(1));
      await result;
    });

    it("restartStalled skips an attempt whose job was already aborted", async () => {
      const { tts, edge } = setup({ retries: 1 });
      const controller = new AbortController();
      const result = tts.synthesize({ text: "a", signal: controller.signal });
      await flush();
      expect(edge.calls).toHaveLength(1);
      controller.abort();
      // The attempt is aborted but has not reached its `finally` yet.
      expect(tts.restartStalled()).toBe(false);
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});
