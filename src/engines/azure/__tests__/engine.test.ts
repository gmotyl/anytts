import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TtsError } from "../../../errors.js";
import { createAzureEngine } from "../engine.js";
import { AZURE_VOICE_MAP, AZURE_VOICES } from "../voices.js";

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

const VOICE = AZURE_VOICE_MAP.pl!;

async function refusal(f: Fixture): Promise<TtsError> {
  const engine = createAzureEngine({ apiKey: "k", region: "westeurope", fetch: async () => replay(f) });
  const error = await engine.synthesize("hej", VOICE, new AbortController().signal).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TtsError);
  return error as TtsError;
}

describe("createAzureEngine", () => {
  it("azure requires a region", () => {
    expect(() => createAzureEngine({ apiKey: "k" })).toThrow(RangeError);
    expect(() => createAzureEngine({ apiKey: "k", region: "" })).toThrow(RangeError);
    expect(() => createAzureEngine({ apiKey: "k", region: "evil.example.com/" })).toThrow(RangeError);
    // Without a key the engine is skipped anyway, so a missing region is not an error.
    expect(() => createAzureEngine({})).not.toThrow();
  });

  it("azure lowercases the region", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1]));
    const engine = createAzureEngine({ apiKey: "k", region: "WestEurope", fetch });
    await engine.synthesize("hej", VOICE, new AbortController().signal);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1");
  });

  it("azure posts ssml to the region endpoint and returns mp3", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1, 2], [3]));
    const engine = createAzureEngine({ apiKey: "secret", region: "westeurope", fetch });
    const onFirstByte = vi.fn();

    const bytes = await engine.synthesize("Cześć", VOICE, new AbortController().signal, { onFirstByte });

    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    expect(onFirstByte).toHaveBeenCalledTimes(1);
    const request = fixture("request") as unknown as { method: string; url: string; headers: Record<string, string> };
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(request.url.replace("{region}", "westeurope"));
    expect(init?.method).toBe(request.method);
    const headers = new Headers(init?.headers);
    expect(headers.get("ocp-apim-subscription-key")).toBe("secret");
    expect(headers.get("content-type")).toBe(request.headers["content-type"]);
    expect(headers.get("x-microsoft-outputformat")).toBe(request.headers["x-microsoft-outputformat"]);
    expect(headers.get("x-microsoft-outputformat")).toMatch(/mp3$/);
    expect(headers.get("user-agent")).toBeTruthy();
    expect(String(init?.body)).toBe(
      `<speak version='1.0' xml:lang='pl-PL'><voice xml:lang='pl-PL' name='${VOICE}'>Cześć</voice></speak>`,
    );
  });

  it("ssml escapes the text and the voice", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1]));
    const engine = createAzureEngine({ apiKey: "k", region: "westeurope", fetch });

    await engine.synthesize(`a < b & "c" > 'd'`, "en-US-Ava'Neural", new AbortController().signal);

    const body = String(fetch.mock.calls[0]![1]?.body);
    expect(body).toContain(">a &lt; b &amp; &quot;c&quot; &gt; &apos;d&apos;</voice>");
    expect(body).toContain("name='en-US-Ava&apos;Neural'");
    expect(body).not.toMatch(/a < b/);
  });

  it("ssml xml:lang keeps the script subtag", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => audio([1]));
    const engine = createAzureEngine({ apiKey: "k", region: "westeurope", fetch });

    await engine.synthesize("zdravo", "sr-Latn-RS-NicholasNeural", new AbortController().signal);

    expect(String(fetch.mock.calls[0]![1]?.body)).toBe(
      "<speak version='1.0' xml:lang='sr-Latn-RS'><voice xml:lang='sr-Latn-RS' name='sr-Latn-RS-NicholasNeural'>zdravo</voice></speak>",
    );
  });

  it("429 maps to rate-limited", async () => {
    const error = await refusal(fixture("rate-limited-429"));
    expect(error.kind).toBe("rate-limited");
    expect(error.retryAfter).toBe(12);
    const { headers: _headers, ...noHeader } = fixture("rate-limited-429");
    const bare = await refusal(noHeader);
    expect(bare.kind).toBe("rate-limited");
    expect(bare.retryAfter).toBeUndefined();
  });

  it("401 maps to unauthorized", async () => {
    const error = await refusal(fixture("unauthorized-401"));
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
  });

  it("plain 403 maps to unauthorized", async () => {
    const error = await refusal(fixture("forbidden-403"));
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(403);
  });

  it("403 out of call volume quota maps to quota-exhausted", async () => {
    const error = await refusal(fixture("quota-403"));
    expect(error.kind).toBe("quota-exhausted");
    expect(error.status).toBe(403);
  });

  it("429 with a quota message maps to quota-exhausted", async () => {
    const error = await refusal(fixture("quota-429"));
    expect(error.kind).toBe("quota-exhausted");
    expect(error.status).toBe(429);
  });

  it("quota message is read from a top-level message or a raw string body", async () => {
    const top = await refusal({ status: 403, body: { message: "Out of call volume quota." } });
    expect(top.kind).toBe("quota-exhausted");
    const raw = await refusal({ status: 403, body: "Out of call volume quota." });
    expect(raw.kind).toBe("quota-exhausted");
  });

  it("missing key rejects without a request", async () => {
    const fetch = vi.fn(async () => audio([1]));
    const engine = createAzureEngine({ fetch });
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
    const engine = createAzureEngine({ apiKey: "k", region: "westeurope", fetch });
    const controller = new AbortController();
    const pending = engine.synthesize("hej", VOICE, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen?.aborted).toBe(true);
  });

  it("azure defaults to one slot", () => {
    const engine = createAzureEngine({ apiKey: "k", region: "westeurope" });
    expect(engine.id).toBe("azure");
    expect(engine.defaults.maxConcurrent).toBe(1);
  });

  it("voices default to the stock pl/en/default map", () => {
    const engine = createAzureEngine({ apiKey: "k", region: "westeurope" });
    expect(engine.defaults.voices).toEqual(AZURE_VOICE_MAP);
    for (const lang of ["pl", "en", "default"]) {
      const id = AZURE_VOICE_MAP[lang];
      expect(AZURE_VOICES.some((voice) => voice.id === id)).toBe(true);
    }
  });
});
