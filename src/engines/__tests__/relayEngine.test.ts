import { afterEach, describe, expect, it, vi } from "vitest";
import { TtsError } from "../../errors.js";
import { createTts, type TtsConfig } from "../../tts.js";
import { ELEVENLABS_VOICE_MAP } from "../elevenlabs/voices.js";
import { createRelayCascade, createRelayEngine } from "../relayEngine.js";

const RELAY = "https://relay.test/tts";
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
const scheduler = { concurrency: 2, tiers: [{ name: "play" }] };

const audio = (engine: string, voice: string) =>
  new Response(AUDIO, {
    status: 200,
    headers: { "content-type": "audio/mpeg", "x-anytts-engine": engine, "x-anytts-voice": voice },
  });

/** Stubs the global `fetch` the relay clients call; `answer` gets the parsed body. */
function stubRelay(answer: (body: Record<string, unknown>) => Response) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    answer(JSON.parse(String(init?.body)) as Record<string, unknown>),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const rejection = async (promise: Promise<unknown>): Promise<TtsError> => {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TtsError);
  return error as TtsError;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser relay clients", () => {
  it("a browser cascade request uses the relay", async () => {
    const fetchMock = stubRelay(() => audio("azure", "pl-PL-MarekNeural"));
    const tts = createTts({ engines: { cascade: { relayUrl: RELAY } }, defaultEngine: "cascade", scheduler });
    const result = await tts.synthesize({
      text: "Cześć",
      lang: "pl",
      voices: { edge: "pl-PL-MarekNeural" },
      order: ["azure", "edge"],
      pronunciation: { edge: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(RELAY);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      engine: "cascade",
      text: "Cześć",
      lang: "pl",
      voices: { edge: "pl-PL-MarekNeural" },
      order: ["azure", "edge"],
      pronunciation: { edge: false },
    });
    // The member that spoke comes from the relay's headers.
    expect(result.engine).toBe("azure");
    expect(result.voice).toBe("pl-PL-MarekNeural");
    expect(result.mime).toBe("audio/mpeg");
    expect(new Uint8Array(result.bytes)).toEqual(AUDIO);
    // A keyed engine in the browser is a relay client too: `{ engine, text, voice, lang? }`.
    const keyed = createTts({ engines: { elevenlabs: { relayUrl: RELAY } }, defaultEngine: "elevenlabs", scheduler });
    fetchMock.mockImplementationOnce(async () => audio("elevenlabs", ELEVENLABS_VOICE_MAP.pl!));
    const spoken = await keyed.synthesize({ text: "Cześć", lang: "pl" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      engine: "elevenlabs",
      text: "Cześć",
      voice: ELEVENLABS_VOICE_MAP.pl,
      lang: "pl",
    });
    expect(spoken).toMatchObject({ engine: "elevenlabs", voice: ELEVENLABS_VOICE_MAP.pl });
  });

  it("relay errors keep kind and wait", async () => {
    const fetchMock = stubRelay(() =>
      Response.json({ kind: "rate-limited", retryAfter: 30 }, { status: 502, headers: { "retry-after": "30" } }),
    );
    const tts = createTts({
      engines: { cascade: { relayUrl: RELAY }, elevenlabs: { relayUrl: RELAY } },
      defaultEngine: "cascade",
      scheduler,
    });
    const limited = await rejection(tts.synthesize({ text: "Hi", lang: "pl" }));
    expect(limited.kind).toBe("rate-limited");
    expect(limited.retryAfter).toBe(30);
    // Not transient: no retry on the same relay.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The Retry-After header stands in when the body carries no wait.
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ kind: "rate-limited" }, { status: 502, headers: { "retry-after": "12" } }),
    );
    expect((await rejection(tts.synthesize({ text: "Hi again", lang: "pl" }))).retryAfter).toBe(12);

    for (const kind of ["quota-exhausted", "unauthorized"] as const) {
      fetchMock.mockImplementationOnce(async () => Response.json({ kind }, { status: 502 }));
      const error = await rejection(tts.synthesize({ engine: "elevenlabs", text: `${kind} text`, lang: "pl" }));
      expect(error.kind).toBe(kind);
      expect(error.retryAfter).toBeUndefined();
    }
    // A keyed relay client's refusal shows in its status, as a direct engine's would.
    expect(tts.engineStatus("elevenlabs").state).toBe("unauthorized");
  });

  it("a relay error body's retryAfter stands without a Retry-After header", async () => {
    stubRelay(() => Response.json({ kind: "rate-limited", retryAfter: 12 }, { status: 502 }));
    const tts = createTts({ engines: { cascade: { relayUrl: RELAY } }, defaultEngine: "cascade", scheduler });
    const error = await rejection(tts.synthesize({ text: "Hi", lang: "pl" }));
    expect(error.kind).toBe("rate-limited");
    expect(error.retryAfter).toBe(12);
  });

  it("a browser cascade does not retry the relay walk unless configured to", async () => {
    // `network` is transient: a direct engine would retry it once.
    const fetchMock = stubRelay(() => Response.json({ kind: "network" }, { status: 502 }));
    const tts = createTts({ engines: { cascade: { relayUrl: RELAY } }, defaultEngine: "cascade", scheduler });
    expect((await rejection(tts.synthesize({ text: "Hi", lang: "pl" }))).kind).toBe("network");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // An explicit `retries` still applies.
    fetchMock.mockClear();
    const retrying = createTts({ engines: { cascade: { relayUrl: RELAY, retries: 1 } }, defaultEngine: "cascade", scheduler });
    expect((await rejection(retrying.synthesize({ text: "Hi", lang: "pl" }))).kind).toBe("network");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a cascade relay answer that names no engine or voice is rejected", async () => {
    const bare = (headers: Record<string, string>) =>
      new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg", ...headers } });
    const cases: Record<string, string>[] = [{}, { "x-anytts-engine": "azure" }, { "x-anytts-voice": "pl-PL-MarekNeural" }];
    for (const [i, headers] of cases.entries()) {
      stubRelay(() => bare(headers));
      const tts = createTts({ engines: { cascade: { relayUrl: RELAY } }, defaultEngine: "cascade", scheduler });
      expect((await rejection(tts.synthesize({ text: `Hi ${i}`, lang: "pl" }))).kind).toBe("rejected");
    }
  });

  it("a cascade relay client waits 20000 ms for the headers by default", async () => {
    vi.useFakeTimers();
    try {
      // The relay never answers; the fetch honours its abort signal.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            }),
        ),
      );
      let error: unknown;
      createRelayCascade({ relayUrl: RELAY })
        .synthesize({ text: "Hi" }, new AbortController().signal)
        .catch((e: unknown) => {
          error = e;
        });
      await vi.advanceTimersByTimeAsync(19999);
      expect(error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(error).toBeInstanceOf(TtsError);
      expect((error as TtsError).kind).toBe("first-byte-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no key reaches the browser", async () => {
    const fetchMock = stubRelay((body) => audio(String(body.engine), String(body.voice)));
    // @ts-expect-error a relay client takes no apiKey
    createRelayEngine("elevenlabs", { relayUrl: RELAY, apiKey: "sk-secret" });
    // A key in the engine config is ignored: never sent, and the client is not a keyed engine.
    const config: TtsConfig = {
      engines: { elevenlabs: { relayUrl: RELAY, apiKey: "sk-secret" } },
      defaultEngine: "elevenlabs",
      scheduler,
    };
    const tts = createTts(config);
    await tts.synthesize({ text: "Cześć", lang: "pl" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("sk-secret");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      engine: "elevenlabs",
      text: "Cześć",
      voice: ELEVENLABS_VOICE_MAP.pl,
      lang: "pl",
    });
    expect(createRelayEngine("elevenlabs", { relayUrl: RELAY }).keyed).toBeUndefined();
    // Holding no key, it is not `no-key`.
    expect(tts.engineStatus("elevenlabs").state).toBe("ready");
    // Without a relayUrl a keyed engine cannot run in the browser.
    expect(() => createTts({ engines: { elevenlabs: {} }, defaultEngine: "elevenlabs", scheduler })).toThrow(RangeError);
  });
});

describe("relay client", () => {
  it("sends lang on a direct keyed request when the request has one", async () => {
    const fetchMock = stubRelay((body) => audio(String(body.engine), String(body.voice)));
    const engine = createRelayEngine("speechify", { relayUrl: RELAY });
    await engine.synthesize("Cześć", "geffen_32", new AbortController().signal, undefined, "pl");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      engine: "speechify",
      text: "Cześć",
      voice: "geffen_32",
      lang: "pl",
    });
  });

  it("omits lang when the request has none", async () => {
    const fetchMock = stubRelay((body) => audio(String(body.engine), String(body.voice)));
    const engine = createRelayEngine("speechify", { relayUrl: RELAY });
    await engine.synthesize("Hi", "geffen_32", new AbortController().signal);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ engine: "speechify", text: "Hi", voice: "geffen_32" });
    expect(body).not.toHaveProperty("lang");
  });
});
