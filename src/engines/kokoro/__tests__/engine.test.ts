import { afterEach, describe, expect, it, vi } from "vitest";
import { createEdgeEngine } from "../../edge/engine.js";
import { createKokoroEngine } from "../engine.js";
import { TtsError } from "../../../errors.js";
import { EDGE_VOICE_MAP } from "../../edge/voices.js";
import type { TtsConfig } from "../../../tts.js";
import { createTts } from "../../../server/index.js";

const scheduler: TtsConfig["scheduler"] = { concurrency: 4, tiers: [{ name: "play" }] };
const baseUrl = "http://127.0.0.1:8880";

const audio = (): Response =>
  new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } });

type FetchMock = ReturnType<typeof vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

const okFetch = (): FetchMock => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio());

const kokoroTts = (options: Record<string, unknown>) =>
  createTts({ engines: { kokoro: { baseUrl, ...options } }, defaultEngine: "kokoro", scheduler });

const sentBody = (fetch: FetchMock, call = 0): Record<string, unknown> =>
  JSON.parse(String(fetch.mock.calls[call]![1]?.body)) as Record<string, unknown>;

const sentHeaders = (fetch: FetchMock): Headers => new Headers(fetch.mock.calls[0]![1]?.headers);

/** Edge with its network call replaced: records the voices it spoke. */
const fakeEdge = (spoken: string[]) => ({
  edge: (options: Record<string, unknown>) => ({
    ...createEdgeEngine(options),
    synthesize: async (_text: string, voice: string) => {
      spoken.push(voice);
      return new Uint8Array([1]).buffer;
    },
  }),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("kokoro engine", () => {
  it("kokoro posts an OpenAI speech request with model kokoro", async () => {
    const fetch = okFetch();
    const tts = kokoroTts({ fetch });

    await expect(tts.synthesize({ engine: "kokoro", text: "Hello", voice: "am_michael" })).resolves.toMatchObject({
      engine: "kokoro",
      voice: "am_michael",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8880/v1/audio/speech");
    expect(init?.method).toBe("POST");
    expect(sentBody(fetch)).toEqual({ input: "Hello", voice: "am_michael", model: "kokoro", response_format: "mp3" });
    expect(sentHeaders(fetch).get("authorization")).toBeNull();
  });

  it("kokoro sends Bearer only when apiKey is set", async () => {
    const withKey = okFetch();
    await kokoroTts({ fetch: withKey, apiKey: "secret" }).synthesize({ text: "Hello" });
    expect(sentHeaders(withKey).get("authorization")).toBe("Bearer secret");

    const withoutKey = okFetch();
    await kokoroTts({ fetch: withoutKey }).synthesize({ text: "Hello" });
    expect(sentHeaders(withoutKey).get("authorization")).toBeNull();
  });

  it("kokoro never sends a language field", async () => {
    const fetch = okFetch();
    await kokoroTts({ fetch }).synthesize({ text: "Cześć", voice: "am_michael", lang: "pl" });

    expect(sentBody(fetch)).toEqual({ input: "Cześć", voice: "am_michael", model: "kokoro", response_format: "mp3" });
  });

  it("kokoro defaults to af_heart for every language", async () => {
    const fetch = okFetch();
    const tts = kokoroTts({ fetch });

    const results = [
      await tts.synthesize({ text: "Hello" }),
      await tts.synthesize({ text: "Cześć", lang: "pl" }),
      await tts.synthesize({ text: "Hola", lang: "es-ES" }),
    ];
    expect(results.map((r) => r.voice)).toEqual(["af_heart", "af_heart", "af_heart"]);
    expect([0, 1, 2].map((i) => sentBody(fetch, i).voice)).toEqual(["af_heart", "af_heart", "af_heart"]);
  });

  it("kokoro refuses engine-owned options", () => {
    const owned: Record<string, unknown>[] = [
      { catalog: [{ id: "x", label: "X", locale: "en-US", gender: "female", multilingual: false }] },
      { model: "tts-1" },
      { languageField: "language" },
      { extraBody: { speed: 1 } },
    ];
    for (const option of owned) {
      expect(() => kokoroTts({ fetch: okFetch(), ...option })).toThrow(RangeError);
      const [key] = Object.keys(option);
      expect(() => kokoroTts({ fetch: okFetch(), ...option })).toThrow(`kokoro: ${key} is set by the engine`);
    }
  });

  it("kokoro refuses a missing or non-http baseUrl", () => {
    const build = (engine: Record<string, unknown>) =>
      createTts({ engines: { kokoro: engine }, defaultEngine: "kokoro", scheduler });

    expect(() => build({})).toThrow(RangeError);
    expect(() => build({ baseUrl: "" })).toThrow(RangeError);
    expect(() => build({ baseUrl: "not a url" })).toThrow(RangeError);
    expect(() => build({ baseUrl: "ftp://127.0.0.1:8880" })).toThrow(RangeError);
  });

  it("kokoro rejects a voice outside its catalog without a request", async () => {
    const fetch = okFetch();
    await expect(kokoroTts({ fetch }).synthesize({ text: "Hello", voice: "my-voice" })).rejects.toMatchObject({
      kind: "unknown-voice",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("kokoro down falls through in a cascade and is not no-key", async () => {
    const refused = () =>
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      });

    const direct = refused();
    await expect(kokoroTts({ fetch: direct, retries: 0 }).synthesize({ text: "Hello" })).rejects.toMatchObject({
      kind: "network",
    });

    const fetch = refused();
    const spoken: string[] = [];
    const tts = createTts(
      {
        engines: { kokoro: { baseUrl, fetch, retries: 0 }, edge: {}, cascade: { order: ["kokoro", "edge"] } },
        defaultEngine: "cascade",
        scheduler,
      },
      { engineFactories: fakeEdge(spoken) },
    );
    expect(tts.engineStatus("kokoro").state).not.toBe("no-key");
    await expect(tts.synthesize({ text: "cześć", lang: "pl" })).resolves.toMatchObject({ engine: "edge" });
    expect(fetch).toHaveBeenCalled();
    expect(spoken).toEqual([EDGE_VOICE_MAP.pl]);
    expect(tts.engineStatus("kokoro").state).not.toBe("no-key");
  });

  it("kokoro waits 30 s for the first byte by default", async () => {
    vi.useFakeTimers();
    // Headers at 20 s: past the openai default (15 s), inside kokoro's (30 s).
    const slow = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(audio()), 20_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    let settled: unknown;
    const pending = kokoroTts({ fetch: slow, retries: 0 })
      .synthesize({ text: "Hello" })
      .then(
        (r) => (settled = r),
        (e: unknown) => (settled = e),
      );
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(settled).toMatchObject({ engine: "kokoro", voice: "af_heart" });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("kokoro runs one request at a time by default", async () => {
    // A local model serves one request at a time; the scheduler alone would allow 4.
    const release: (() => void)[] = [];
    const fetch = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => release.push(() => resolve(audio()))),
    );
    const tts = kokoroTts({ fetch });

    const first = tts.synthesize({ text: "One" });
    const second = tts.synthesize({ text: "Two" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);

    release[0]!();
    await first;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release[1]!();
    await second;
    expect(createKokoroEngine({ baseUrl }).defaults.maxConcurrent).toBe(1);
  });

  it("kokoro passes stallMs through", async () => {
    vi.useFakeTimers();
    // Headers and one chunk arrive, then the body goes silent.
    const silentAfterFirstChunk = (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } }));
    };
    const engine = createKokoroEngine({ baseUrl, stallMs: 100, fetch: silentAfterFirstChunk });
    let settled: unknown;
    const pending = engine
      .synthesize("Hello", "af_heart", new AbortController().signal)
      .catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBeUndefined();
    // Well before keyedFetch's 8000 default.
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBeInstanceOf(TtsError);
    expect((settled as TtsError).kind).toBe("stalled");
  });
});
