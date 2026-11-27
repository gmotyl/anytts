import { describe, expect, it, vi } from "vitest";
import { AZURE_VOICE_MAP } from "../../engines/azure/voices.js";
import { createEdgeEngine } from "../../engines/edge/engine.js";
import { EDGE_VOICE_MAP } from "../../engines/edge/voices.js";
import { createTts as createMainTts, type TtsConfig } from "../../tts.js";
import type { VoiceInfo } from "../../engine.js";
import { resolveVoice } from "../../voices.js";
import { createTts } from "../index.js";

const scheduler: TtsConfig["scheduler"] = { concurrency: 4, tiers: [{ name: "play" }] };

const audio = (): Response =>
  new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A fetch whose calls the test answers by hand. */
function heldFetch() {
  const calls: { url: string; body: string; answer: () => void }[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({ url: String(url), body: String(init?.body), answer: () => resolve(audio()) });
    });
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

describe("anytts/server createTts", () => {
  it("keyed engine defaults fill unset voices and maxConcurrent", async () => {
    const { fetch, calls } = heldFetch();
    const tts = createTts({
      engines: { azure: { apiKey: "k", region: "westeurope", fetch } },
      defaultEngine: "azure",
      scheduler,
    });
    const first = tts.synthesize({ text: "jeden", lang: "pl" });
    const second = tts.synthesize({ text: "dwa", lang: "pl" });
    await flush();
    // Azure's default slot is 1: the second request waits although the scheduler allows 4.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain(`name='${AZURE_VOICE_MAP.pl}'`);
    calls[0]!.answer();
    await expect(first).resolves.toMatchObject({ engine: "azure", voice: AZURE_VOICE_MAP.pl });
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]!.answer();
    await second;
    expect(resolveVoice(tts, { engine: "azure", lang: "en" }).voice).toBe(AZURE_VOICE_MAP.en);
  });

  it("configured voices and maxConcurrent override the defaults", async () => {
    const { fetch, calls } = heldFetch();
    const tts = createTts({
      engines: { azure: { apiKey: "k", region: "westeurope", fetch, maxConcurrent: 2, voices: { default: "en-GB-RyanNeural" } } },
      defaultEngine: "azure",
      scheduler,
    });
    const both = [tts.synthesize({ text: "one", lang: "pl" }), tts.synthesize({ text: "two" })];
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toContain("name='en-GB-RyanNeural'");
    for (const call of calls) call.answer();
    await Promise.all(both);
  });

  it("azure apiKey without region throws through createTts", () => {
    expect(() => createTts({ engines: { azure: { apiKey: "k" } }, defaultEngine: "azure", scheduler })).toThrow(RangeError);
  });

  it("edge without voices speaks its default voice map", async () => {
    const spoken: string[] = [];
    const config: TtsConfig = { engines: { edge: { pronunciation: true } }, defaultEngine: "edge", scheduler };
    const tts = createMainTts(config, {
      engineFactories: {
        // The real engine (catalog and defaults), with the network call replaced.
        edge: (options) => ({
          ...createEdgeEngine(options),
          synthesize: async (_text: string, voice: string) => {
            spoken.push(voice);
            return new Uint8Array([1]).buffer;
          },
        }),
      },
    });
    await expect(tts.synthesize({ text: "cześć", lang: "pl" })).resolves.toMatchObject({ voice: EDGE_VOICE_MAP.pl });
    await tts.synthesize({ text: "hi", lang: "en" });
    await tts.synthesize({ text: "hallo", lang: "de" });
    expect(spoken).toEqual([EDGE_VOICE_MAP.pl, EDGE_VOICE_MAP.en, EDGE_VOICE_MAP.default]);
  });

  it("edge options stay type-checked", () => {
    const config: TtsConfig = {
      // @ts-expect-error firstByteMs is a number of milliseconds
      engines: { edge: { firstByteMs: "soon" } },
      defaultEngine: "edge",
      scheduler,
    };
    expect(config.defaultEngine).toBe("edge");
  });
});

describe("anytts/server createTts with openai", () => {
  const baseUrl = "http://127.0.0.1:8890";
  const catalog: VoiceInfo[] = [
    { id: "pl-female", label: "Polish female", locale: "pl-PL", gender: "female", multilingual: false },
    { id: "en-male", label: "English male", locale: "en-US", gender: "male", multilingual: false },
  ];

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

  it("server createTts synthesizes with the openai engine", async () => {
    const fetch = vi.fn(async () => audio());
    const tts = createTts({ engines: { openai: { baseUrl, catalog, fetch } }, defaultEngine: "openai", scheduler });
    await expect(tts.synthesize({ text: "cześć", voice: "pl-female" })).resolves.toMatchObject({ engine: "openai", voice: "pl-female" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("openai rejects a voice outside its catalog without a request", async () => {
    const fetch = vi.fn(async () => audio());
    const tts = createTts({ engines: { openai: { baseUrl, catalog, fetch } }, defaultEngine: "openai", scheduler });
    await expect(tts.synthesize({ text: "hi", voice: "auto" })).rejects.toMatchObject({ kind: "unknown-voice" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("openai voice map outside the catalog throws RangeError", () => {
    expect(() =>
      createTts({ engines: { openai: { baseUrl, catalog, voices: { default: "nope" } } }, defaultEngine: "openai", scheduler }),
    ).toThrow(RangeError);
    expect(() =>
      createTts({ engines: { openai: { baseUrl, catalog, voices: { default: "pl-female", en: "nope" } } }, defaultEngine: "openai", scheduler }),
    ).toThrow(RangeError);
  });

  it("cascade tries openai without an apiKey", async () => {
    const fetch = vi.fn(async () => audio());
    const spoken: string[] = [];
    const tts = createTts(
      { engines: { openai: { baseUrl, catalog, fetch }, edge: {}, cascade: { order: ["openai", "edge"] } }, defaultEngine: "cascade", scheduler },
      { engineFactories: fakeEdge(spoken) },
    );
    expect(tts.engineStatus("openai").state).not.toBe("no-key");
    await expect(tts.synthesize({ text: "cześć" })).resolves.toMatchObject({ engine: "openai" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spoken).toEqual([]);
  });

  it("cascade moves past an unreachable openai server", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const spoken: string[] = [];
    const tts = createTts(
      { engines: { openai: { baseUrl, catalog, fetch, retries: 0 }, edge: {}, cascade: { order: ["openai", "edge"] } }, defaultEngine: "cascade", scheduler },
      { engineFactories: fakeEdge(spoken) },
    );
    await expect(tts.synthesize({ text: "cześć", lang: "pl" })).resolves.toMatchObject({ engine: "edge", voice: EDGE_VOICE_MAP.pl });
    expect(fetch).toHaveBeenCalled();
    expect(spoken).toEqual([EDGE_VOICE_MAP.pl]);
  });

  it("openai runs one attempt at a time by default", async () => {
    const { fetch, calls } = heldFetch();
    const tts = createTts({ engines: { openai: { baseUrl, catalog, fetch } }, defaultEngine: "openai", scheduler });
    const first = tts.synthesize({ text: "jeden" });
    const second = tts.synthesize({ text: "dwa" });
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]!.answer();
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]!.answer();
    await expect(second).resolves.toMatchObject({ engine: "openai" });
  });
});

describe("anytts/server createTts with pocket", () => {
  const wav = (): Response => {
    const pcm = new Uint8Array(3200);
    const buf = new ArrayBuffer(44 + pcm.length);
    const v = new DataView(buf);
    const tag = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    tag(0, "RIFF");
    v.setUint32(4, 36 + pcm.length, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 24000, true);
    v.setUint32(28, 48000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    tag(36, "data");
    v.setUint32(40, pcm.length, true);
    new Uint8Array(buf).set(pcm, 44);
    return new Response(buf, { status: 200, headers: { "content-type": "audio/wav" } });
  };

  it("node createTts builds pocket engines", async () => {
    const fetch = vi.fn(async () => wav());
    const tts = createTts({
      engines: { pocket: { baseUrl: "http://127.0.0.1:8890", fetch }, "pocket-pl": { baseUrl: "http://127.0.0.1:8891", fetch } },
      defaultEngine: "pocket",
      scheduler,
    });
    await expect(tts.synthesize({ engine: "pocket", text: "Hello", voice: "alba" })).resolves.toMatchObject({ engine: "pocket", voice: "alba" });
    await expect(tts.synthesize({ engine: "pocket-pl", text: "Cześć", voice: "shefowl" })).resolves.toMatchObject({ engine: "pocket-pl", voice: "shefowl" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a cascade skips an unconfigured pocket", async () => {
    const spoken: string[] = [];
    const tts = createTts(
      { engines: { edge: {}, cascade: { order: ["edge"] } }, defaultEngine: "cascade", scheduler },
      {
        engineFactories: {
          edge: (options: Record<string, unknown>) => ({
            ...createEdgeEngine(options),
            synthesize: async (_text: string, voice: string) => {
              spoken.push(voice);
              return new Uint8Array([1]).buffer;
            },
          }),
        },
      },
    );
    await expect(tts.synthesize({ text: "hi", order: ["pocket", "edge"] })).resolves.toMatchObject({ engine: "edge" });
    expect(spoken).toHaveLength(1);
  });

  it("a config-level cascade order naming an unconfigured pocket throws RangeError", () => {
    expect(() => createTts({ engines: { edge: {}, cascade: { order: ["pocket"] } }, defaultEngine: "cascade", scheduler })).toThrow(
      /not a configured engine: pocket/,
    );
  });
});
