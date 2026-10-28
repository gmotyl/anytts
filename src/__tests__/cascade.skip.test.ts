import { describe, expect, it } from "vitest";
import type { Engine } from "../engine.js";
import { TtsError } from "../errors.js";
import { createTts, type EngineConfig, type TtsConfig } from "../tts.js";

/** A member engine whose next calls answer, or reject with what `fail` returns. */
function fakeEngine(id: string, keyed: boolean) {
  let fail: (() => unknown) | undefined;
  const calls: string[] = [];
  const engine: Engine = {
    id,
    keyed,
    voices: [{ id: `${id}-pl`, label: id, locale: "pl-PL", gender: "male", multilingual: false }],
    synthesize(text) {
      calls.push(text);
      return fail ? Promise.reject(fail()) : Promise.resolve(new Uint8Array([1]).buffer);
    },
  };
  return {
    engine,
    calls,
    /** `undefined` answers again. */
    fail(next: (() => unknown) | undefined) {
      fail = next;
    },
  };
}

type Fake = ReturnType<typeof fakeEngine>;

/** Keyed `a` and `b` (with keys unless overridden) and the keyless `edge`, on a clock the test moves. */
function setup(
  engines: Record<string, Partial<EngineConfig>> = {
    a: { apiKey: "k" },
    b: { apiKey: "k" },
    edge: {},
    cascade: { order: ["a", "b", "edge"] },
  },
) {
  const clock = { now: Date.parse("2026-11-14T10:00:00.000Z") };
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
      Object.entries(engines).map(([id, c]) => [id, id === "cascade" ? c : { voices: { pl: `${id}-pl` }, ...c }]),
    ) as TtsConfig["engines"],
    defaultEngine: "cascade",
    scheduler: { concurrency: 4, tiers: [{ name: "play" }] },
  };
  const tts = createTts(config, { engineFactories: factories, now: () => clock.now });
  const fake = (id: string): Fake => fakes[id]!;
  let n = 0;
  // A fresh text per request, so no answer comes from the cache.
  const speak = () => tts.synthesize({ text: `t${n++}`, lang: "pl" });
  return { tts, fake, clock, speak };
}

describe("cascade skip windows", () => {
  it("quota exhausted skips until the 1st of next month UTC", async () => {
    const { tts, fake, clock, speak } = setup();
    fake("a").fail(() => new TtsError("quota-exhausted"));
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(tts.engineStatus("a")).toEqual({ state: "quota-exhausted", until: "2026-12-01T00:00:00.000Z" });
    fake("a").fail(undefined);
    clock.now = Date.parse("2026-11-30T23:59:59.999Z");
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(fake("a").calls).toHaveLength(1);
    clock.now = Date.parse("2026-12-01T00:00:00.000Z");
    expect(tts.engineStatus("a")).toEqual({ state: "ready" });
    expect(await speak()).toMatchObject({ engine: "a" });
    // December rolls over into the next year.
    clock.now = Date.parse("2026-12-31T23:00:00.000Z");
    fake("a").fail(() => new TtsError("quota-exhausted"));
    await speak();
    expect(tts.engineStatus("a")).toEqual({ state: "quota-exhausted", until: "2027-01-01T00:00:00.000Z" });
  });

  it("rate limited skips for retryAfter or 60 s", async () => {
    const { tts, fake, clock, speak } = setup();
    const t0 = clock.now;
    fake("a").fail(() => new TtsError("rate-limited", undefined, { status: 429, retryAfter: 20 }));
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(tts.engineStatus("a")).toEqual({ state: "rate-limited", until: new Date(t0 + 20_000).toISOString() });
    clock.now = t0 + 19_999;
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(fake("a").calls).toHaveLength(1);
    // Without `retryAfter`: 60 s from this failure.
    const t1 = t0 + 20_000;
    clock.now = t1;
    fake("a").fail(() => new TtsError("rate-limited", undefined, { status: 429 }));
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(fake("a").calls).toHaveLength(2);
    expect(tts.engineStatus("a")).toEqual({ state: "rate-limited", until: new Date(t1 + 60_000).toISOString() });
    fake("a").fail(undefined);
    clock.now = t1 + 59_999;
    expect(await speak()).toMatchObject({ engine: "b" });
    clock.now = t1 + 60_000;
    expect(await speak()).toMatchObject({ engine: "a" });
    expect(tts.engineStatus("a")).toEqual({ state: "ready" });
  });

  it("unauthorized skips for the instance life", async () => {
    const { tts, fake, clock, speak } = setup();
    fake("a").fail(() => new TtsError("unauthorized", undefined, { status: 401 }));
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(tts.engineStatus("a")).toEqual({ state: "unauthorized" });
    fake("a").fail(undefined);
    clock.now += 10 * 365 * 24 * 3600 * 1000;
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(fake("a").calls).toHaveLength(1);
    expect(tts.engineStatus("a")).toEqual({ state: "unauthorized" });
    // A direct request still reaches the engine: windows steer the cascade only.
    expect(await tts.synthesize({ text: "direct", lang: "pl", engine: "a" })).toMatchObject({ engine: "a" });
  });

  it("every member fails rejects with the last error", async () => {
    const { fake, speak } = setup();
    const errors = { a: new TtsError("rejected", "a said no"), b: new TtsError("quota-exhausted"), edge: new TtsError("no-audio") };
    for (const id of ["a", "b", "edge"] as const) fake(id).fail(() => errors[id]);
    const rejection: unknown = await speak().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(TtsError);
    expect(rejection).toMatchObject({ kind: "no-audio", cause: [errors.a, errors.b] });
    // One member attempted: its error as is.
    const single = setup({ a: { apiKey: "k" }, cascade: { order: ["a"] } });
    single.fake("a").fail(() => errors.a);
    await expect(single.speak()).rejects.toBe(errors.a);
  });

  it("all skipped rejects with the last skip reason", async () => {
    const { fake, speak } = setup({ a: {}, b: { apiKey: "k" }, cascade: { order: ["a", "b"] } });
    fake("b").fail(() => new TtsError("quota-exhausted"));
    await expect(speak()).rejects.toMatchObject({ kind: "quota-exhausted" });
    // `a` has no key, `b` sits in its quota window: no request at all.
    await expect(speak()).rejects.toMatchObject({ kind: "quota-exhausted", message: expect.stringContaining("2026-12-01T00:00:00.000Z") });
    expect(fake("a").calls).toHaveLength(0);
    expect(fake("b").calls).toHaveLength(1);
  });

  it("a cached member answers even while it is skipped", async () => {
    const { tts, fake, speak } = setup();
    const req = { text: "y", lang: "pl" };
    expect(await tts.synthesize(req)).toMatchObject({ engine: "a" });
    fake("a").fail(() => new TtsError("quota-exhausted"));
    await speak();
    expect(tts.engineStatus("a")).toMatchObject({ state: "quota-exhausted" });
    expect(tts.state(req)).toBe("ready");
    expect(tts.isCached(req)).toBe(true);
    expect(await tts.synthesize(req)).toMatchObject({ engine: "a", voice: "a-pl" });
    expect(fake("a").calls).toHaveLength(2);
    // `b` answered only the request that opened `a`'s window.
    expect(fake("b").calls).toHaveLength(1);
  });

  it("a cached member answers even without a key", async () => {
    const { tts, fake } = setup({ a: {}, b: { apiKey: "k" }, cascade: { order: ["a", "b"] } });
    const req = { text: "y", lang: "pl" };
    // A direct request reaches the engine whatever its key; its result lands in the cache.
    await tts.synthesize({ ...req, engine: "a" });
    expect(tts.state(req)).toBe("ready");
    expect(tts.isCached(req)).toBe(true);
    expect(await tts.synthesize(req)).toMatchObject({ engine: "a" });
    expect(fake("a").calls).toHaveLength(1);
    expect(fake("b").calls).toHaveLength(0);
  });

  it("a skipped member's bad voice only means no cache hit", async () => {
    const { tts, fake } = setup({ a: {}, b: { apiKey: "k" }, cascade: { order: ["a", "b"] } });
    const req = { text: "y", lang: "pl", voices: { a: "nope" } };
    expect(tts.isCached(req)).toBe(false);
    expect(await tts.synthesize(req)).toMatchObject({ engine: "b" });
    expect(fake("a").calls).toHaveLength(0);
  });

  it("a direct refusal opens the window engineStatus reports", async () => {
    const { tts, fake, speak } = setup();
    fake("a").fail(() => new TtsError("quota-exhausted"));
    await expect(tts.synthesize({ text: "d", lang: "pl", engine: "a" })).rejects.toMatchObject({ kind: "quota-exhausted" });
    expect(tts.engineStatus("a")).toEqual({ state: "quota-exhausted", until: "2026-12-01T00:00:00.000Z" });
    // The cascade now passes `a` over.
    expect(await speak()).toMatchObject({ engine: "b" });
    expect(fake("a").calls).toHaveLength(1);
    // A later direct request still reaches the engine.
    fake("a").fail(undefined);
    expect(await tts.synthesize({ text: "d2", lang: "pl", engine: "a" })).toMatchObject({ engine: "a" });
    expect(fake("a").calls).toHaveLength(2);
    // Rate-limited and unauthorized open theirs too; other kinds none.
    fake("b").fail(() => new TtsError("rate-limited", undefined, { status: 429, retryAfter: 5 }));
    await expect(tts.synthesize({ text: "d3", lang: "pl", engine: "b" })).rejects.toMatchObject({ kind: "rate-limited" });
    expect(tts.engineStatus("b")).toMatchObject({ state: "rate-limited" });
    fake("edge").fail(() => new TtsError("unauthorized", undefined, { status: 401 }));
    await expect(tts.synthesize({ text: "d4", lang: "pl", engine: "edge" })).rejects.toMatchObject({ kind: "unauthorized" });
    expect(tts.engineStatus("edge")).toEqual({ state: "unauthorized" });
    const other = setup();
    other.fake("a").fail(() => new TtsError("rejected"));
    await expect(other.tts.synthesize({ text: "d", lang: "pl", engine: "a" })).rejects.toMatchObject({ kind: "rejected" });
    expect(other.tts.engineStatus("a")).toEqual({ state: "ready" });
  });

  it("a member without a key reports no-key", () => {
    const { tts } = setup({ a: {}, b: { apiKey: "" }, edge: {}, cascade: { order: ["a", "b", "edge"] } });
    expect(tts.engineStatus("a")).toEqual({ state: "no-key" });
    expect(tts.engineStatus("b")).toEqual({ state: "no-key" });
    // A keyless engine needs none.
    expect(tts.engineStatus("edge")).toEqual({ state: "ready" });
    expect(() => tts.engineStatus("nope")).toThrow(RangeError);
  });
});
