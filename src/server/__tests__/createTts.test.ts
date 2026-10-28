import { describe, expect, it } from "vitest";
import { AZURE_VOICE_MAP } from "../../engines/azure/voices.js";
import { createEdgeEngine } from "../../engines/edge/engine.js";
import { EDGE_VOICE_MAP } from "../../engines/edge/voices.js";
import { createTts as createMainTts, type TtsConfig } from "../../tts.js";
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
