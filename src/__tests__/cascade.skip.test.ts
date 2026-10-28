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

  it("all skipped by a rate limit carries the remaining window as retryAfter", async () => {
    const { tts, fake, clock, speak } = setup({ a: {}, b: { apiKey: "k" }, cascade: { order: ["a", "b"] } });
    fake("b").fail(() => new TtsError("rate-limited", undefined, { status: 429, retryAfter: 20 }));
    await expect(speak()).rejects.toMatchObject({ kind: "rate-limited", retryAfter: 20 });
    clock.now += 4_500;
    // 15.5 s left: rounded up, and no request reaches `b`.
    await expect(speak()).rejects.toMatchObject({ kind: "rate-limited", retryAfter: 16 });
    expect(fake("b").calls).toHaveLength(1);
    // Other skip kinds carry none.
    const quota = setup({ a: { apiKey: "k" }, cascade: { order: ["a"] } });
    quota.fake("a").fail(() => new TtsError("quota-exhausted"));
    await quota.speak().catch(() => {});
    const skipped = await quota.speak().catch((e: unknown) => e);
    expect(skipped).toMatchObject({ kind: "quota-exhausted" });
    expect((skipped as TtsError).retryAfter).toBeUndefined();
    expect(tts.engineStatus("b")).toMatchObject({ state: "rate-limited" });
  });

  it("a later refusal never shortens an open window", async () => {
    const { tts, fake, clock } = setup();
    const t0 = clock.now;
    const direct = (text: string) => tts.synthesize({ text, lang: "pl", engine: "a" }).catch(() => {});
    // Rate-limited 20 s, then 5 s: the 20 s window stays.
    fake("a").fail(() => new TtsError("rate-limited", undefined, { status: 429, retryAfter: 20 }));
    await direct("r1");
    fake("a").fail(() => new TtsError("rate-limited", undefined, { status: 429, retryAfter: 5 }));
    await direct("r2");
    expect(tts.engineStatus("a")).toEqual({ state: "rate-limited", until: new Date(t0 + 20_000).toISOString() });
    // Quota-exhausted, then rate-limited: the quota window and its kind stay.
    fake("b").fail(() => new TtsError("quota-exhausted"));
    await tts.synthesize({ text: "q1", lang: "pl", engine: "b" }).catch(() => {});
    fake("b").fail(() => new TtsError("rate-limited", undefined, { status: 429, retryAfter: 60 }));
    await tts.synthesize({ text: "q2", lang: "pl", engine: "b" }).catch(() => {});
    expect(tts.engineStatus("b")).toEqual({ state: "quota-exhausted", until: "2026-12-01T00:00:00.000Z" });
    // A longer refusal does extend a window.
    fake("a").fail(() => new TtsError("quota-exhausted"));
    await direct("r3");
    expect(tts.engineStatus("a")).toEqual({ state: "quota-exhausted", until: "2026-12-01T00:00:00.000Z" });
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

  it("a queued attempt rechecks the skip window", async () => {
    const calls: string[] = [];
    let refuse!: (error: unknown) => void;
    const slow: Engine = {
      id: "a",
      keyed: true,
      voices: [{ id: "a-pl", label: "a", locale: "pl-PL", gender: "male", multilingual: false }],
      synthesize(text) {
        calls.push(text);
        return new Promise((_resolve, reject) => {
          refuse = reject;
        });
      },
    };
    const b = fakeEngine("b", true);
    const tts = createTts(
      {
        engines: {
          a: { apiKey: "k", maxConcurrent: 1, voices: { pl: "a-pl" } },
          b: { apiKey: "k", voices: { pl: "b-pl" } },
          cascade: { order: ["a", "b"] },
        },
        defaultEngine: "cascade",
        scheduler: { concurrency: 4, tiers: [{ name: "play" }] },
      },
      { engineFactories: { a: () => slow, b: () => b.engine }, now: () => Date.parse("2026-11-14T10:00:00.000Z") },
    );
    // Both pass `a`'s skip check; the second waits in `a`'s one slot behind the first.
    const first = tts.synthesize({ text: "one", lang: "pl" });
    const second = tts.synthesize({ text: "two", lang: "pl" });
    await Promise.resolve();
    expect(calls).toEqual(["one"]);
    refuse(new TtsError("quota-exhausted"));
    expect(await first).toMatchObject({ engine: "b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The window the first call opened passes `a` over for the queued one: no provider call.
    expect(calls).toEqual(["one"]);
    expect(await second).toMatchObject({ engine: "b" });
    expect(b.calls).toEqual(["one", "two"]);
  });

  it("a queued attempt skipped at start keeps its skip reason as the final error", async () => {
    let refuse!: (error: unknown) => void;
    const calls: string[] = [];
    const slow: Engine = {
      id: "a",
      keyed: true,
      voices: [{ id: "a-pl", label: "a", locale: "pl-PL", gender: "male", multilingual: false }],
      synthesize(text) {
        calls.push(text);
        return new Promise((_resolve, reject) => {
          refuse = reject;
        });
      },
    };
    const tts = createTts(
      {
        engines: { a: { apiKey: "k", maxConcurrent: 1, voices: { pl: "a-pl" } }, cascade: { order: ["a"] } },
        defaultEngine: "cascade",
        scheduler: { concurrency: 4, tiers: [{ name: "play" }] },
      },
      { engineFactories: { a: () => slow }, now: () => Date.parse("2026-11-14T10:00:00.000Z") },
    );
    const first = tts.synthesize({ text: "one", lang: "pl" });
    // Settles while the test waits below: handled from the start.
    const second = tts.synthesize({ text: "two", lang: "pl" }).catch((error: unknown) => error);
    // A direct request queued behind them still reaches the engine.
    const direct = tts.synthesize({ text: "three", lang: "pl", engine: "a" });
    await Promise.resolve();
    refuse(new TtsError("unauthorized", undefined, { status: 401 }));
    await expect(first).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["one", "three"]);
    const skipped = await second;
    expect(skipped).toBeInstanceOf(TtsError);
    expect(skipped).toMatchObject({ kind: "unauthorized", message: expect.stringContaining("skipped by the cascade") });
    refuse(new TtsError("unauthorized", undefined, { status: 401 }));
    await expect(direct).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("a direct request joined to a queued cascade attempt still reaches the engine", async () => {
    let refuse!: (error: unknown) => void;
    let answer!: (bytes: ArrayBuffer) => void;
    const calls: string[] = [];
    const slow: Engine = {
      id: "a",
      keyed: true,
      voices: [{ id: "a-pl", label: "a", locale: "pl-PL", gender: "male", multilingual: false }],
      synthesize(text) {
        calls.push(text);
        return new Promise((resolve, reject) => {
          refuse = reject;
          answer = resolve;
        });
      },
    };
    const b = fakeEngine("b", true);
    const tts = createTts(
      {
        engines: {
          a: { apiKey: "k", maxConcurrent: 1, voices: { pl: "a-pl" } },
          b: { apiKey: "k", voices: { pl: "b-pl" } },
          cascade: { order: ["a", "b"] },
        },
        defaultEngine: "cascade",
        scheduler: { concurrency: 4, tiers: [{ name: "play" }] },
      },
      { engineFactories: { a: () => slow, b: () => b.engine }, now: () => Date.parse("2026-11-14T10:00:00.000Z") },
    );
    const first = tts.synthesize({ text: "one", lang: "pl" });
    const second = tts.synthesize({ text: "two", lang: "pl" });
    // Same unit as the queued cascade attempt: joins its job.
    const direct = tts.synthesize({ text: "two", lang: "pl", engine: "a" });
    await Promise.resolve();
    refuse(new TtsError("quota-exhausted"));
    expect(await first).toMatchObject({ engine: "b" });
    await Promise.resolve();
    expect(calls).toEqual(["one", "two"]);
    answer(new Uint8Array([2]).buffer);
    expect(await direct).toMatchObject({ engine: "a" });
    // The cascade caller riding on that job is served by it.
    expect(await second).toMatchObject({ engine: "a" });
  });

  it("a direct request arriving as a queued attempt skips at start never joins the dead job", async () => {
    for (let delay = 0; delay <= 12; delay++) {
      let refuse!: (error: unknown) => void;
      const calls: string[] = [];
      const slow: Engine = {
        id: "a",
        keyed: true,
        voices: [{ id: "a-pl", label: "a", locale: "pl-PL", gender: "male", multilingual: false }],
        synthesize(text) {
          calls.push(text);
          // The first call hangs until refused; later ones answer.
          if (calls.length > 1) return Promise.resolve(new Uint8Array([2]).buffer);
          return new Promise((_resolve, reject) => {
            refuse = reject;
          });
        },
      };
      const b = fakeEngine("b", true);
      const tts = createTts(
        {
          engines: {
            a: { apiKey: "k", maxConcurrent: 1, voices: { pl: "a-pl" } },
            b: { apiKey: "k", voices: { pl: "b-pl" } },
            cascade: { order: ["a", "b"] },
          },
          defaultEngine: "cascade",
          scheduler: { concurrency: 4, tiers: [{ name: "play" }] },
        },
        { engineFactories: { a: () => slow, b: () => b.engine }, now: () => Date.parse("2026-11-14T10:00:00.000Z") },
      );
      const first = tts.synthesize({ text: "one", lang: "pl" });
      const second = tts.synthesize({ text: "two", lang: "pl" });
      await Promise.resolve();
      refuse(new TtsError("quota-exhausted"));
      for (let i = 0; i < delay; i++) await Promise.resolve();
      // Same unit as the queued cascade attempt: it joins that job if still queued, else starts its own.
      const direct = await tts.synthesize({ text: "two", lang: "pl", engine: "a" }).catch((error: unknown) => error);
      expect(direct, `delay ${delay}`).toMatchObject({ engine: "a" });
      expect(calls, `delay ${delay}`).toEqual(["one", "two"]);
      expect(await first).toMatchObject({ engine: "b" });
      expect(await second).toMatchObject({ engine: expect.stringMatching(/^[ab]$/) });
    }
  });

  it("a direct request that joined a queued cascade attempt and aborted no longer keeps it going", async () => {
    let refuse!: (error: unknown) => void;
    const calls: string[] = [];
    const slow: Engine = {
      id: "a",
      keyed: true,
      voices: [{ id: "a-pl", label: "a", locale: "pl-PL", gender: "male", multilingual: false }],
      synthesize(text) {
        calls.push(text);
        return new Promise((_resolve, reject) => {
          refuse = reject;
        });
      },
    };
    const b = fakeEngine("b", true);
    const tts = createTts(
      {
        engines: {
          a: { apiKey: "k", maxConcurrent: 1, voices: { pl: "a-pl" } },
          b: { apiKey: "k", voices: { pl: "b-pl" } },
          cascade: { order: ["a", "b"] },
        },
        defaultEngine: "cascade",
        scheduler: { concurrency: 4, tiers: [{ name: "play" }] },
      },
      { engineFactories: { a: () => slow, b: () => b.engine }, now: () => Date.parse("2026-11-14T10:00:00.000Z") },
    );
    const first = tts.synthesize({ text: "one", lang: "pl" });
    const second = tts.synthesize({ text: "two", lang: "pl" });
    const controller = new AbortController();
    const direct = tts.synthesize({ text: "two", lang: "pl", engine: "a", signal: controller.signal });
    controller.abort();
    await expect(direct).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    refuse(new TtsError("quota-exhausted"));
    expect(await first).toMatchObject({ engine: "b" });
    // Only the cascade walk is left on the job: it skips at start and the walk moves on.
    expect(await second).toMatchObject({ engine: "b" });
    expect(calls).toEqual(["one"]);
    expect(b.calls).toEqual(["one", "two"]);
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
