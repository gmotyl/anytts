import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceInfo } from "../../../engine.js";
import { TtsError } from "../../../errors.js";
import { createOpenAIEngine, type OpenAIEngineOptions } from "../engine.js";

const CATALOG: VoiceInfo[] = [
  { id: "en-female", label: "English female", locale: "en-GB", gender: "female", multilingual: true },
  { id: "pl-male", label: "Polish male", locale: "pl-PL", gender: "male", multilingual: false },
];

const audio = (...bytes: number[]): Response =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } });

type FetchMock = ReturnType<typeof vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

const okFetch = (): FetchMock => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio(1, 2, 3));

const engineWith = (fetch: FetchMock, extra: Partial<OpenAIEngineOptions> = {}) =>
  createOpenAIEngine({ baseUrl: "http://h:8890", catalog: CATALOG, fetch, ...extra });

const signal = () => new AbortController().signal;

const sentBody = (fetch: FetchMock): Record<string, unknown> =>
  JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, unknown>;

const sentHeaders = (fetch: FetchMock): Headers => new Headers(fetch.mock.calls[0]![1]?.headers);

async function failure(response: () => Response | Promise<Response>): Promise<TtsError> {
  const engine = createOpenAIEngine({ baseUrl: "http://h:8890", catalog: CATALOG, fetch: async () => response() });
  const error = await engine.synthesize("Hello", "en-female", signal()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TtsError);
  return error as TtsError;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createOpenAIEngine", () => {
  it("posts the OpenAI speech body to baseUrl/v1/audio/speech", async () => {
    const fetch = okFetch();
    const bytes = await engineWith(fetch).synthesize("Hello", "en-female", signal());

    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://h:8890/v1/audio/speech");
    expect(init?.method).toBe("POST");
    expect(sentBody(fetch)).toEqual({ input: "Hello", voice: "en-female", model: "tts-1", response_format: "mp3" });
    expect(sentHeaders(fetch).get("authorization")).toBeNull();
    expect(sentHeaders(fetch).get("content-type")).toBe("application/json");
  });

  it("joins a trailing-slash baseUrl without a double slash", async () => {
    const fetch = okFetch();
    await engineWith(fetch, { baseUrl: "http://h:8890/" }).synthesize("Hello", "en-female", signal());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe("http://h:8890/v1/audio/speech");
  });

  it("sends Bearer only when apiKey is set", async () => {
    const withKey = okFetch();
    await engineWith(withKey, { apiKey: "secret" }).synthesize("Hello", "en-female", signal());
    expect(sentHeaders(withKey).get("authorization")).toBe("Bearer secret");

    const withoutKey = okFetch();
    await engineWith(withoutKey).synthesize("Hello", "en-female", signal());
    expect(sentHeaders(withoutKey).get("authorization")).toBeNull();
  });

  it("merges extraBody without overriding the fixed fields", async () => {
    const fetch = okFetch();
    await engineWith(fetch, {
      model: "omni",
      extraBody: { num_step: 16, model: "x", input: "y", voice: "z", response_format: "wav" },
    }).synthesize("Hello", "en-female", signal());

    expect(sentBody(fetch)).toEqual({
      num_step: 16,
      input: "Hello",
      voice: "en-female",
      model: "omni",
      response_format: "mp3",
    });
  });

  it("sends the language base only when it differs from the voice locale", async () => {
    const differs = okFetch();
    await engineWith(differs, { languageField: "language" }).synthesize("Cześć", "en-female", signal(), undefined, "pl-PL");
    expect(sentBody(differs).language).toBe("pl");

    const same = okFetch();
    await engineWith(same, { languageField: "language" }).synthesize("Cześć", "pl-male", signal(), undefined, "pl");
    expect(sentBody(same)).not.toHaveProperty("language");

    const noLang = okFetch();
    await engineWith(noLang, { languageField: "language" }).synthesize("Hello", "en-female", signal());
    expect(sentBody(noLang)).not.toHaveProperty("language");
  });

  it("never sends a language field without languageField", async () => {
    const fetch = okFetch();
    await engineWith(fetch).synthesize("Cześć", "en-female", signal(), undefined, "pl-PL");

    expect(sentBody(fetch)).toEqual({ input: "Cześć", voice: "en-female", model: "tts-1", response_format: "mp3" });
  });

  it("maps refusals and network failures to error kinds", async () => {
    const refused = await failure(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    expect(refused.kind).toBe("network");

    const rejected = await failure(() => new Response(JSON.stringify({ error: "bad voice" }), { status: 400 }));
    expect(rejected.kind).toBe("rejected");
    expect(rejected.status).toBe(400);

    const unauthorized = await failure(() => new Response("nope", { status: 401 }));
    expect(unauthorized.kind).toBe("unauthorized");

    const limited = await failure(() => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }));
    expect(limited.kind).toBe("rate-limited");
    expect(limited.retryAfter).toBe(5);

    // A self-hosted server has no quota: no status maps to quota-exhausted.
    for (const status of [400, 401, 402, 403, 404, 422, 429, 500, 503]) {
      const error = await failure(() => new Response("x", { status }));
      expect(error.kind).not.toBe("quota-exhausted");
    }
  });

  it("throws RangeError on missing or invalid baseUrl or catalog", () => {
    const fetch = okFetch();
    const make = (options: Partial<OpenAIEngineOptions>) => () =>
      createOpenAIEngine({ baseUrl: "http://h:8890", catalog: CATALOG, fetch, ...options } as OpenAIEngineOptions);

    expect(make({ baseUrl: undefined as unknown as string })).toThrow(RangeError);
    expect(make({ baseUrl: "" })).toThrow(RangeError);
    expect(make({ baseUrl: "not a url" })).toThrow(RangeError);
    expect(make({ baseUrl: "ftp://h:8890" })).toThrow(RangeError);
    expect(make({ catalog: undefined as unknown as VoiceInfo[] })).toThrow(RangeError);
    expect(make({ catalog: [] })).toThrow(RangeError);
    expect(make({ catalog: [CATALOG[0]!, { ...CATALOG[1]!, id: "en-female" }] })).toThrow(RangeError);
    expect(make({ baseUrl: "https://h" })).not.toThrow();
  });

  it("defaults: keyed false, maxConcurrent 1, first catalog voice as default", async () => {
    const engine = createOpenAIEngine({ baseUrl: "http://h:8890", catalog: CATALOG, fetch: okFetch() });

    expect(engine.id).toBe("openai");
    expect(engine.keyed).toBe(false);
    expect(engine.voices).toEqual(CATALOG);
    expect(engine.defaults).toEqual({ voices: { default: "en-female" }, maxConcurrent: 1 });

    // Default firstByteMs is 15000: the headers wait outlives keyedFetch's 8000 default.
    vi.useFakeTimers();
    const hanging = createOpenAIEngine({
      baseUrl: "http://h:8890",
      catalog: CATALOG,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    let settled: unknown;
    const pending = hanging.synthesize("Hello", "en-female", signal()).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBeInstanceOf(TtsError);
    expect((settled as TtsError).kind).toBe("first-byte-timeout");
  });
  it("passes a custom stallMs through to the body read", async () => {
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
    const engine = createOpenAIEngine({ baseUrl: "http://h:8890", catalog: CATALOG, stallMs: 100, fetch: silentAfterFirstChunk });
    let settled: unknown;
    const pending = engine.synthesize("Hello", "en-female", signal()).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBeUndefined();
    // Well before keyedFetch's 8000 default.
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBeInstanceOf(TtsError);
    expect((settled as TtsError).kind).toBe("stalled");
  });

  it("throws RangeError when languageField names a fixed body field", () => {
    for (const languageField of ["input", "voice", "model", "response_format"]) {
      expect(() => engineWith(okFetch(), { languageField })).toThrow(RangeError);
    }
    expect(() => engineWith(okFetch(), { languageField: "language" })).not.toThrow();
  });
});
