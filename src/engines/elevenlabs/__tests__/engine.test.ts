import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TtsError } from "../../../errors.js";
import { createElevenLabsEngine } from "../engine.js";
import { ELEVENLABS_VOICE_MAP, ELEVENLABS_VOICES } from "../voices.js";

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

const VOICE = ELEVENLABS_VOICE_MAP.default!;

async function refusal(f: Fixture): Promise<TtsError> {
  const engine = createElevenLabsEngine({ apiKey: "k", fetch: async () => replay(f) });
  const error = await engine.synthesize("hej", VOICE, new AbortController().signal).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TtsError);
  return error as TtsError;
}

describe("createElevenLabsEngine", () => {
  it("elevenlabs returns mp3 and fires onFirstByte", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1, 2], [3]));
    const engine = createElevenLabsEngine({ apiKey: "secret", fetch });
    const onFirstByte = vi.fn();

    const bytes = await engine.synthesize("Cześć", VOICE, new AbortController().signal, { onFirstByte });

    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    expect(onFirstByte).toHaveBeenCalledTimes(1);
    const request = fixture("request") as unknown as { method: string; url: string; body: { model_id: string } };
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(request.url.replace("{voice_id}", VOICE));
    expect(init?.method).toBe(request.method);
    const headers = new Headers(init?.headers);
    expect(headers.get("xi-api-key")).toBe("secret");
    expect(headers.get("accept")).toBe("audio/mpeg");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Cześć", model_id: request.body.model_id });
  });

  it("quota_exceeded maps to quota-exhausted", async () => {
    expect((await refusal(fixture("quota-exceeded-401"))).kind).toBe("quota-exhausted");
    expect((await refusal(fixture("payment-required-402"))).kind).toBe("quota-exhausted");
  });

  it("other 401 maps to unauthorized", async () => {
    const error = await refusal(fixture("invalid-api-key-401"));
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
    expect((await refusal(fixture("voice-not-found-400"))).kind).toBe("rejected");
    expect((await refusal({ status: 403, body: "forbidden" })).kind).toBe("rejected");
  });

  it("missing key rejects without a request", async () => {
    const fetch = vi.fn(async () => audio([1]));
    const engine = createElevenLabsEngine({ fetch });
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
    const engine = createElevenLabsEngine({ apiKey: "k", fetch });
    const controller = new AbortController();
    const pending = engine.synthesize("hej", VOICE, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen?.aborted).toBe(true);
  });

  it("voices default to the stock pl/en/default map", () => {
    const engine = createElevenLabsEngine({ apiKey: "k" });
    expect(engine.id).toBe("elevenlabs");
    expect(engine.defaults.voices).toEqual(ELEVENLABS_VOICE_MAP);
    expect(engine.defaults.maxConcurrent).toBe(2);
    for (const lang of ["pl", "en", "default"]) {
      const id = ELEVENLABS_VOICE_MAP[lang];
      expect(ELEVENLABS_VOICES.some((voice) => voice.id === id)).toBe(true);
    }
  });
});
