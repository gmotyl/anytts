import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransient, TtsError } from "../../errors.js";
import { keyedFetch, parseRetryAfter, type KeyedEngineOptions, type RefusalRules } from "../keyed.js";

const REQUEST = { url: "https://tts.example/v1/speak", headers: { "x-key": "k" }, body: "{}" };
const RULES: RefusalRules = { isQuota: () => false };

/** A body whose chunks the test pushes by hand; `cancelled` counts `reader.cancel()` reaching it. */
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled += 1;
    },
  });
  return {
    state,
    response: new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    push: (...bytes: number[]) => controller.enqueue(new Uint8Array(bytes)),
    close: () => controller.close(),
  };
}

/** A fetch that records the inner signal and answers with `respond` (or never, when omitted). */
function fakeFetch(respond?: () => Response) {
  const seen: { signal?: AbortSignal } = {};
  const fetch = vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        seen.signal = init?.signal ?? undefined;
        seen.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        if (respond) resolve(respond());
      }),
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

const run = (options: KeyedEngineOptions, signal: AbortSignal = new AbortController().signal) => {
  const pending = keyedFetch("test", REQUEST, options, RULES, signal);
  // Observe the outcome now so a rejection under fake timers is never "unhandled".
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return outcome;
};

describe("keyedFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("headers past firstByteMs fail first-byte-timeout and abort the inner fetch", async () => {
    const { fetch, seen } = fakeFetch();
    const outcome = run({ fetch, firstByteMs: 100, stallMs: 1000 });

    await vi.advanceTimersByTimeAsync(99);
    expect(seen.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await outcome;
    expect(result.ok).toBe(false);
    expect((result as { error: TtsError }).error).toBeInstanceOf(TtsError);
    expect((result as { error: TtsError }).error.kind).toBe("first-byte-timeout");
    expect(seen.signal?.aborted).toBe(true);
  });

  it("a gap between chunks past stallMs fails stalled and cancels the reader", async () => {
    const body = controlledBody();
    const { fetch, seen } = fakeFetch(() => body.response);
    const outcome = run({ fetch, firstByteMs: 1000, stallMs: 100 });

    await vi.advanceTimersByTimeAsync(60);
    body.push(1, 2);
    // Each chunk re-arms the stall clock: 100 ms after the headers is not a stall any more.
    await vi.advanceTimersByTimeAsync(90);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    const result = await outcome;
    expect(result.ok).toBe(false);
    expect((result as { error: TtsError }).error.kind).toBe("stalled");
    expect(body.state.cancelled).toBe(1);
    expect(seen.signal?.aborted).toBe(true);
  });

  it("abort mid-body rejects AbortError and cancels the reader", async () => {
    const body = controlledBody();
    const { fetch, seen } = fakeFetch(() => body.response);
    const controller = new AbortController();
    const outcome = run({ fetch, firstByteMs: 1000, stallMs: 1000 }, controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    body.push(1);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    const result = await outcome;
    expect(result.ok).toBe(false);
    expect((result as { error: Error }).error).toMatchObject({ name: "AbortError" });
    expect(body.state.cancelled).toBe(1);
    expect(seen.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("5xx maps to network (transient), not rejected", async () => {
    for (const status of [500, 502, 503]) {
      const { fetch } = fakeFetch(() => new Response("upstream down", { status }));
      const result = await run({ fetch });
      expect(result.ok).toBe(false);
      const error = (result as { error: TtsError }).error;
      expect(error.kind).toBe("network");
      expect(error.status).toBe(status);
      expect(isTransient(error.kind)).toBe(true);
    }
  });

  it("success clears every timer and removes the abort listener", async () => {
    const body = controlledBody();
    const { fetch } = fakeFetch(() => body.response);
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    const outcome = run({ fetch, firstByteMs: 1000, stallMs: 1000 }, signal);

    await vi.advanceTimersByTimeAsync(0);
    body.push(1, 2);
    body.push(3);
    body.close();

    const result = await outcome;
    expect(result.ok).toBe(true);
    expect([...new Uint8Array((result as { value: ArrayBuffer }).value)]).toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
    const added = add.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(added).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("abort", added);
  });

  it("429 with a junk Retry-After carries no retryAfter", async () => {
    const { fetch } = fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "1.5" } }));
    const result = await run({ fetch });
    const error = (result as { error: TtsError }).error;
    expect(error.kind).toBe("rate-limited");
    expect(error.retryAfter).toBeUndefined();
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.UTC(2015, 9, 21, 7, 27, 50);

  it("accepts non-negative integer delta-seconds", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(" 120 ")).toBe(120);
  });

  it("accepts an IMF-fixdate HTTP-date, clamped at 0 when past", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", NOW)).toBe(10);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:27:00 GMT", NOW)).toBe(0);
  });

  it("rejects junk", () => {
    for (const value of [null, "", "  ", "-3", "1.5", "+5", "abc", "1e3", "7s"]) {
      expect(parseRetryAfter(value, NOW)).toBeUndefined();
    }
  });

  it("rejects dates that are not a real IMF-fixdate", () => {
    for (const value of [
      "2015-10-21T07:28:00Z",
      "Oct 21 2015",
      "Wed, 21 Oct 2015 07:28:00",
      "Wed, 21 Oct 2015 07:28:00 +0000",
      "Sat, 31 Feb 2015 07:28:00 GMT",
      "Wed, 21 Oct 2015 25:28:00 GMT",
      "Foo, 21 Oct 2015 07:28:00 GMT",
      "wed, 21 Oct 2015 07:28:00 GMT",
    ]) {
      expect(parseRetryAfter(value, NOW)).toBeUndefined();
    }
  });
});
