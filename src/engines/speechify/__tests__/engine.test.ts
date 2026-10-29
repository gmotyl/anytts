import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TtsError } from "../../../errors.js";
import { createSpeechifyEngine } from "../engine.js";
import { SPEECHIFY_VOICE_MAP, SPEECHIFY_VOICES } from "../voices.js";

interface Fixture {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;

const replay = (f: Fixture): Response =>
  new Response(JSON.stringify(f.body), {
    status: f.status,
    headers: { "content-type": "application/json", ...f.headers },
  });

/** A streamed MP3 body delivered in the given chunks. */
const audio = (...chunks: number[][]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "audio/mpeg" } },
  );

const VOICE = SPEECHIFY_VOICE_MAP.pl!;

async function refusal(f: Fixture): Promise<TtsError> {
  const engine = createSpeechifyEngine({ apiKey: "k", fetch: async () => replay(f) });
  const error = await engine.synthesize("hej", VOICE, new AbortController().signal).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TtsError);
  return error as TtsError;
}

describe("createSpeechifyEngine", () => {
  it("speechify returns mp3 and fires onFirstByte", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1, 2], [3]));
    const engine = createSpeechifyEngine({ apiKey: "secret", fetch });
    const onFirstByte = vi.fn();

    const bytes = await engine.synthesize("Cześć", VOICE, new AbortController().signal, { onFirstByte });

    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    expect(onFirstByte).toHaveBeenCalledTimes(1);
    const request = fixture("request") as unknown as { method: string; url: string; body: { model: string } };
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(request.url);
    expect(init?.method).toBe(request.method);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("accept")).toBe("audio/mpeg");
    expect(JSON.parse(String(init?.body))).toEqual({ input: "Cześć", voice_id: VOICE, model: request.body.model });
  });

  it("exhausted quota maps to quota-exhausted", async () => {
    const error = await refusal(fixture("payment-required-402"));
    expect(error.kind).toBe("quota-exhausted");
    expect(error.status).toBe(402);
  });

  it("bad key maps to unauthorized", async () => {
    const error = await refusal(fixture("unauthorized-401"));
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
  });

  it("429 maps to rate-limited with retryAfter", async () => {
    const error = await refusal(fixture("rate-limited-429"));
    expect(error.kind).toBe("rate-limited");
    expect(error.retryAfter).toBe(7);
    const { headers: _headers, ...noHeader } = fixture("rate-limited-429");
    expect((await refusal(noHeader)).retryAfter).toBeUndefined();
  });

  it("unknown refusal maps to rejected", async () => {
    expect((await refusal(fixture("voice-not-found-404"))).kind).toBe("rejected");
    expect((await refusal({ status: 403, body: "forbidden" })).kind).toBe("rejected");
  });

  it("missing key rejects without a request", async () => {
    const fetch = vi.fn(async () => audio([1]));
    const engine = createSpeechifyEngine({ fetch });
    await expect(engine.synthesize("hej", VOICE, new AbortController().signal)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("abort cancels the fetch", async () => {
    let seen: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const engine = createSpeechifyEngine({ apiKey: "k", fetch });
    const controller = new AbortController();
    const pending = engine.synthesize("hej", VOICE, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen?.aborted).toBe(true);
  });

  it("voices default to the stock pl/en/default map", () => {
    const engine = createSpeechifyEngine({ apiKey: "k" });
    expect(engine.id).toBe("speechify");
    expect(engine.defaults.voices).toEqual(SPEECHIFY_VOICE_MAP);
    expect(engine.defaults.maxConcurrent).toBe(2);
    for (const lang of ["pl", "en", "default"]) {
      const id = SPEECHIFY_VOICE_MAP[lang];
      expect(SPEECHIFY_VOICES.some((voice) => voice.id === id)).toBe(true);
    }
    expect(SPEECHIFY_VOICES.find((voice) => voice.id === SPEECHIFY_VOICE_MAP.pl)?.locale).toBe("pl-PL");
  });
});

describe("speechify", () => {
  /** The JSON body Speechify receives when `voice` synthesizes with `lang`. */
  async function body(voice: string, lang?: string): Promise<Record<string, unknown>> {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1]));
    const engine = createSpeechifyEngine({ apiKey: "k", fetch });
    await engine.synthesize("Dzień dobry.", voice, new AbortController().signal, undefined, lang);
    expect(fetch).toHaveBeenCalledTimes(1);
    return JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, unknown>;
  }

  it("sends language pl-PL for a pl request on an en-US voice", async () => {
    expect(await body("geffen_32", "pl")).toEqual({
      input: "Dzień dobry.",
      voice_id: "geffen_32",
      model: "simba-3.5",
      language: "pl-PL",
    });
  });

  it("sends a region-qualified lang from the table unchanged", async () => {
    expect((await body("geffen_32", "pl-PL")).language).toBe("pl-PL");
  });

  it("maps en to en-GB", async () => {
    expect((await body("kajetan", "en")).language).toBe("en-GB");
  });

  it("omits language when the voice already speaks the request language", async () => {
    expect(await body("kajetan", "pl")).not.toHaveProperty("language");
    expect(await body("hugh_32", "en")).not.toHaveProperty("language");
  });

  it("omits language when the request has no lang", async () => {
    expect(await body("geffen_32")).not.toHaveProperty("language");
  });

  it("omits language for a lang outside the simba-3.5 table", async () => {
    expect(await body("geffen_32", "xx")).not.toHaveProperty("language");
  });
});
