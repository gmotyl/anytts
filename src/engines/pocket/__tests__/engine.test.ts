import { describe, expect, it, vi } from "vitest";
import { TtsError } from "../../../errors.js";
import { createPocketEngine } from "../engine.js";
import { buildWav, pcmBytes } from "./wav.js";

const baseUrl = "http://127.0.0.1:8890";

type FetchMock = ReturnType<typeof vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

const wavReply = (): Response =>
  new Response(buildWav(pcmBytes(Array.from({ length: 4800 }, (_, i) => Math.round(Math.sin(i / 10) * 8000)))), {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });

const okFetch = (): FetchMock => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => wavReply());
const failFetch = (status: number, body: string): FetchMock =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status }));

const form = (fetch: FetchMock): Record<string, unknown> => {
  const body = fetch.mock.calls[0]![1]?.body;
  expect(body).toBeInstanceOf(FormData);
  return Object.fromEntries((body as FormData).entries());
};

const signal = () => new AbortController().signal;

describe("pocket engine", () => {
  it.each([".", ".."])("the factory rejects the dot-segment custom voice id %j", (id) => {
    expect(() =>
      createPocketEngine("pocket", { baseUrl, voiceFilesUrl: "http://127.0.0.1:8892", customVoices: [{ id, label: "X", version: 1 }] }),
    ).toThrow(RangeError);
  });

  it("sends text and a preset voice_url as multipart", async () => {
    const fetch = okFetch();
    const engine = createPocketEngine("pocket", { baseUrl, fetch });

    await engine.synthesize("Hello", "alba", signal());

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8890/tts");
    expect(init?.method).toBe("POST");
    expect(form(fetch)).toEqual({ text: "Hello", voice_url: "alba" });
    expect(engine).toMatchObject({ id: "pocket", keyed: false, strictVoiceMap: true });
  });

  it("builds the voice-file URL for a caller voice", async () => {
    const fetch = okFetch();
    const engine = createPocketEngine("pocket-pl", {
      baseUrl,
      voiceFilesUrl: "http://127.0.0.1:8892",
      customVoices: [{ id: "piotr", label: "Piotr", gender: "male", version: 1764245000000 }],
      fetch,
    });
    await engine.synthesize("Cześć", "piotr", signal());
    expect(form(fetch)).toEqual({
      text: "Cześć",
      voice_url: "http://127.0.0.1:8892/piotr/sample.wav?v=1764245000000",
    });

    const odd = okFetch();
    await createPocketEngine("pocket", {
      baseUrl,
      voiceFilesUrl: "http://127.0.0.1:8892/",
      customVoices: [{ id: "a b/ć", label: "X", version: 1 }],
      fetch: odd,
    }).synthesize("x", "a b/ć", signal());
    expect(form(odd).voice_url).toBe(`http://127.0.0.1:8892/${encodeURIComponent("a b/ć")}/sample.wav?v=1`);
  });

  it("pocket-pl's reference voice sends no voice_url", async () => {
    const fetch = okFetch();
    const engine = createPocketEngine("pocket-pl", { baseUrl, fetch });
    expect(engine.defaults.voices).toEqual({ default: "shefowl" });
    await engine.synthesize("Cześć", "shefowl", signal());
    expect(form(fetch)).toEqual({ text: "Cześć" });
  });

  it("never sends the language", async () => {
    const fetch = okFetch();
    await createPocketEngine("pocket", { baseUrl, fetch }).synthesize("Hello", "alba", signal(), undefined, "pl");
    expect(Object.keys(form(fetch)).sort()).toEqual(["text", "voice_url"]);
  });

  it("refuses a bad baseUrl and caller voices without voiceFilesUrl", () => {
    const customVoices = [{ id: "piotr", label: "Piotr", version: 1 }];
    expect(() => createPocketEngine("pocket", {} as never)).toThrow(RangeError);
    expect(() => createPocketEngine("pocket", { baseUrl: "" })).toThrow(RangeError);
    expect(() => createPocketEngine("pocket", { baseUrl: "ftp://x" })).toThrow(RangeError);
    expect(() => createPocketEngine("pocket", { baseUrl: "nope" })).toThrow(RangeError);
    expect(() => createPocketEngine("pocket", { baseUrl, customVoices })).toThrow(RangeError);
    expect(() => createPocketEngine("pocket", { baseUrl, customVoices, voiceFilesUrl: "http://x" })).not.toThrow();
  });

  it("rejects a voice outside the catalog without a request", async () => {
    const fetch = okFetch();
    await expect(createPocketEngine("pocket", { baseUrl, fetch }).synthesize("x", "nobody", signal())).rejects.toMatchObject({
      kind: "unknown-voice",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps the cloning and predefined-voice 500s to unknown-voice", async () => {
    for (const body of [
      "We could not download the weights for the model with voice cloning, but you did...",
      JSON.stringify({ detail: "Cannot use predefined voices with this model" }),
    ]) {
      const engine = createPocketEngine("pocket", { baseUrl, fetch: failFetch(500, body) });
      await expect(engine.synthesize("x", "alba", signal())).rejects.toMatchObject({ kind: "unknown-voice", status: 500 });
    }
  });

  it("maps other refusals like the keyed engines", async () => {
    const run = (status: number) =>
      createPocketEngine("pocket", { baseUrl, fetch: failFetch(status, "boom") }).synthesize("x", "alba", signal());
    await expect(run(500)).rejects.toMatchObject({ kind: "network" });
    await expect(run(503)).rejects.toMatchObject({ kind: "network" });
    await expect(run(422)).rejects.toMatchObject({ kind: "rejected" });
    await expect(run(404)).rejects.toMatchObject({ kind: "rejected" });
    const down = vi.fn(async () => {
      throw new TypeError("refused");
    });
    await expect(
      createPocketEngine("pocket", { baseUrl, fetch: down as never }).synthesize("x", "alba", signal()),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("waits 30 s for the first byte by default", async () => {
    vi.useFakeTimers();
    try {
      // Never answers; rejects only when the engine aborts the request.
      const hang = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      const engine = createPocketEngine("pocket", { baseUrl, fetch: hang });
      const state: { error?: unknown } = {};
      engine.synthesize("x", "alba", signal()).catch((e: unknown) => {
        state.error = e;
      });
      await vi.advanceTimersByTimeAsync(29999);
      expect(state.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      expect(state.error).toMatchObject({ kind: "first-byte-timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sniffs the body for voice-cloning text on a 500 only", async () => {
    const run = (status: number, body: string) =>
      createPocketEngine("pocket", { baseUrl, fetch: failFetch(status, body) }).synthesize("x", "alba", signal());
    // A 4xx that mentions voice cloning is an ordinary refusal, not an unknown voice.
    await expect(run(422, "voice cloning is unavailable")).rejects.toMatchObject({ kind: "rejected" });
    await expect(run(400, JSON.stringify({ detail: "Cannot use predefined voices" }))).rejects.toMatchObject({ kind: "rejected" });
    // A 500 with an unrelated JSON body stays a transient network fault.
    await expect(run(500, JSON.stringify({ detail: "internal error" }))).rejects.toMatchObject({ kind: "network" });
  });

  it("returns MP3 decoded from the WAV reply", async () => {
    const engine = createPocketEngine("pocket", { baseUrl, fetch: okFetch() });
    const bytes = new Uint8Array(await engine.synthesize("Hello", "alba", signal()));
    expect(bytes.length).toBeGreaterThan(0);
    const sync = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
    const id3 = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!) === "ID3";
    expect(sync || id3).toBe(true);
  });

  it("defaults to one slot and the preset voice", () => {
    expect(createPocketEngine("pocket", { baseUrl }).defaults).toEqual({ voices: { default: "alba" }, maxConcurrent: 1 });
  });
});
