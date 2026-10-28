import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TtsError } from "../../../errors.js";
import { createCartesiaEngine } from "../engine.js";
import { CARTESIA_VOICE_MAP, CARTESIA_VOICES } from "../voices.js";

interface Fixture {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;

const replay = (f: Fixture): Response =>
  new Response(typeof f.body === "string" ? f.body : JSON.stringify(f.body), {
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

const VOICE = CARTESIA_VOICE_MAP.default!;

async function refusal(f: Fixture): Promise<TtsError> {
  const engine = createCartesiaEngine({ apiKey: "k", fetch: async () => replay(f) });
  const error = await engine.synthesize("hej", VOICE, new AbortController().signal).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TtsError);
  return error as TtsError;
}

interface RequestFixture {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: { model_id: string; output_format: unknown };
}

describe("createCartesiaEngine", () => {
  it("cartesia returns mp3 and fires onFirstByte", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1, 2], [3]));
    const engine = createCartesiaEngine({ apiKey: "secret", fetch });
    const onFirstByte = vi.fn();

    const bytes = await engine.synthesize("Cześć", VOICE, new AbortController().signal, { onFirstByte });

    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    expect(onFirstByte).toHaveBeenCalledTimes(1);
    const request = fixture("request") as unknown as RequestFixture;
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(request.url);
    expect(init?.method).toBe(request.method);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("cartesia-version")).toBe(request.headers["cartesia-version"]);
    expect(headers.get("accept")).toBe("audio/mpeg");
    // The default voice is multilingual, so no `language` pins it.
    expect(JSON.parse(String(init?.body))).toEqual({
      model_id: request.body.model_id,
      transcript: "Cześć",
      voice: VOICE,
      output_format: request.body.output_format,
    });
  });

  it("a single-language stock voice sends its language", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1]));
    const engine = createCartesiaEngine({ apiKey: "k", fetch });
    await engine.synthesize("Cześć", CARTESIA_VOICE_MAP.pl!, new AbortController().signal);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ language: "pl" });

    await engine.synthesize("Hi", "my-cloned-voice", new AbortController().signal);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).not.toHaveProperty("language");
  });

  it("exhausted credits map to quota-exhausted", async () => {
    const quota = fixture("quota-exceeded");
    expect((await refusal(quota)).kind).toBe("quota-exhausted");
    // The status of a quota refusal is undocumented: the error_code decides, whatever the status.
    expect((await refusal({ ...quota, status: 429 })).kind).toBe("quota-exhausted");
    expect((await refusal({ ...quota, status: 403 })).kind).toBe("quota-exhausted");
    expect((await refusal(fixture("plan-upgrade-required-402"))).kind).toBe("rejected");
  });

  it("bad key maps to unauthorized", async () => {
    const error = await refusal(fixture("invalid-api-key-401"));
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
    // Legacy plain-text error body (pre-2026-03-01 versions) still maps by status.
    expect((await refusal({ status: 401, body: "Unauthorized: Invalid API key" })).kind).toBe("unauthorized");
  });

  it("bare 402 maps to quota-exhausted", async () => {
    // A legacy plain-text 402 carries no code: it reads as spent credits.
    expect((await refusal({ status: 402, body: "Payment Required: out of credits" })).kind).toBe("quota-exhausted");
  });

  it("403 without a code maps to unauthorized, with a specific code to rejected", async () => {
    const noCode = await refusal({ status: 403, body: { error_code: null, title: "Forbidden", message: "admin key" } });
    expect(noCode.kind).toBe("unauthorized");
    expect(noCode.status).toBe(403);
    expect((await refusal({ status: 403, body: "Forbidden" })).kind).toBe("unauthorized");
    const coded = { status: 403, body: { error_code: "voice_access_denied", title: "Forbidden", message: "no access" } };
    expect((await refusal(coded)).kind).toBe("rejected");
  });

  it("429 maps to rate-limited with retryAfter", async () => {
    const error = await refusal(fixture("rate-limited-429"));
    expect(error.kind).toBe("rate-limited");
    expect(error.retryAfter).toBe(3);
    const { headers: _headers, ...noHeader } = fixture("rate-limited-429");
    const bare = await refusal(noHeader);
    expect(bare.kind).toBe("rate-limited");
    expect(bare.retryAfter).toBeUndefined();
  });

  it("unknown refusal maps to rejected", async () => {
    expect((await refusal(fixture("voice-not-found-404"))).kind).toBe("rejected");
    expect((await refusal({ status: 400, body: "Bad Request: transcript is empty" })).kind).toBe("rejected");
  });

  it("missing key rejects without a request", async () => {
    const fetch = vi.fn(async () => audio([1]));
    const engine = createCartesiaEngine({ fetch });
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
    const engine = createCartesiaEngine({ apiKey: "k", fetch });
    const controller = new AbortController();
    const pending = engine.synthesize("hej", VOICE, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen?.aborted).toBe(true);
  });

  it("defaults to two slots and the stock pl/en/default map", () => {
    const engine = createCartesiaEngine({ apiKey: "k" });
    expect(engine.id).toBe("cartesia");
    expect(engine.defaults.maxConcurrent).toBe(2);
    expect(engine.defaults.voices).toEqual(CARTESIA_VOICE_MAP);
    for (const lang of ["pl", "en", "default"]) {
      const id = CARTESIA_VOICE_MAP[lang];
      expect(CARTESIA_VOICES.some((voice) => voice.id === id)).toBe(true);
    }
    const pl = CARTESIA_VOICES.find((voice) => voice.id === CARTESIA_VOICE_MAP.pl);
    expect(pl?.locale).toBe("pl-PL");
  });
});
