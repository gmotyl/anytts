import { describe, expect, it } from "vitest";
import type { Engine, VoiceInfo } from "../engine.js";
import { TtsError, type TtsErrorKind } from "../errors.js";
import { createTts, type TtsConfig } from "../tts.js";

const voice = (id: string): VoiceInfo => ({ id, label: id, locale: id.slice(0, 5), gender: "male", multilingual: false });

const VOICES = [voice("pl-PL-MarekNeural"), voice("en-US-AndrewMultilingualNeural"), voice("en-GB-RyanNeural")];

interface Call {
  text: string;
  voice: string;
  signal: AbortSignal;
  resolve: (bytes: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}

/** An engine whose calls the test settles by hand; aborting a call rejects it like the Edge engine does. */
function fakeEngine(id = "edge") {
  const calls: Call[] = [];
  const engine: Engine = {
    id,
    voices: VOICES,
    synthesize(text, voiceId, signal) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        calls.push({ text, voice: voiceId, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
  };
  return { engine, calls };
}

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(overrides: { retries?: number; concurrency?: number } = {}) {
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
});
