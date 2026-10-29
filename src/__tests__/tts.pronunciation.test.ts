import { describe, expect, it } from "vitest";
import type { Engine, VoiceInfo } from "../engine.js";
import { applyPronunciation } from "../text/pronunciation.js";
import { createTts, type EngineConfig, type TtsConfig, type TtsEvent } from "../tts.js";

const voice = (id: string): VoiceInfo => ({ id, label: id, locale: id.slice(0, 5), gender: "male", multilingual: false });

const VOICES = [voice("pl-PL-MarekNeural"), voice("en-US-AndrewMultilingualNeural")];

/** An engine that answers at once and records the text it was asked to speak. */
function recordingEngine(id: string) {
  const texts: string[] = [];
  const engine: Engine = {
    id,
    voices: VOICES,
    synthesize(text) {
      texts.push(text);
      return Promise.resolve(new Uint8Array([1]).buffer);
    },
  };
  return { engine, texts };
}

const VOICE_MAP = { pl: "pl-PL-MarekNeural", default: "en-US-AndrewMultilingualNeural" };

function setup(engines: Record<string, Partial<EngineConfig>>, extra: Pick<TtsConfig, "pronunciation"> = {}) {
  const recorders = Object.fromEntries(Object.keys(engines).map((id) => [id, recordingEngine(id)]));
  const config: TtsConfig = {
    engines: Object.fromEntries(Object.entries(engines).map(([id, c]) => [id, { voices: VOICE_MAP, ...c }])),
    defaultEngine: Object.keys(engines)[0] ?? "edge",
    scheduler: { concurrency: 1, tiers: [{ name: "play" }] },
    ...extra,
  };
  const factories = Object.fromEntries(Object.entries(recorders).map(([id, r]) => [id, () => r.engine]));
  const tts = createTts(config, { engineFactories: factories });
  return { tts, recorders };
}

// "claude" and "react" are both pl preset entries; "pavilio" is not.
const TEXT = "Claude pisze w React o pavilio";

describe("per-engine pronunciation", () => {
  it("edge gets the pl preset by default", async () => {
    const extra = { pl: { pavilio: "pawilio" } };
    const { tts, recorders } = setup({ edge: {} }, { pronunciation: extra });
    await tts.synthesize({ text: TEXT, lang: "pl" });
    const expected = applyPronunciation(TEXT, "pl", extra);
    expect(expected).not.toBe(TEXT);
    expect(expected).toContain("pawilio");
    expect(recorders.edge?.texts).toEqual([expected]);
  });

  it("an engine with pronunciation off speaks the text as written", async () => {
    const { tts, recorders } = setup({ edge: { pronunciation: false }, other: {} });
    await tts.synthesize({ text: TEXT, lang: "pl", engine: "edge" });
    await tts.synthesize({ text: TEXT, lang: "pl", engine: "other" });
    expect(recorders.edge?.texts).toEqual([TEXT]);
    // Every engine other than edge defaults to off.
    expect(recorders.other?.texts).toEqual([TEXT]);
  });

  it("no lang, no map", async () => {
    const { tts, recorders } = setup({ edge: {}, other: { pronunciation: true } }, { pronunciation: { pl: { pavilio: "pawilio" } } });
    await tts.synthesize({ text: TEXT, engine: "edge" });
    await tts.synthesize({ text: TEXT, engine: "other" });
    expect(recorders.edge?.texts).toEqual([TEXT]);
    expect(recorders.other?.texts).toEqual([TEXT]);
  });

  it("pronunciation on and off do not share an entry", async () => {
    const keysOf = async (pronunciation: boolean) => {
      const { tts } = setup({ edge: { pronunciation } });
      const added: string[] = [];
      tts.subscribe((e: TtsEvent) => {
        if (e.type === "add") added.push(e.key);
      });
      await tts.synthesize({ text: TEXT, lang: "pl" });
      expect(tts.isCached({ text: TEXT, lang: "pl" })).toBe(true);
      return added;
    };
    const on = await keysOf(true);
    const off = await keysOf(false);
    expect(on).toHaveLength(1);
    expect(off).toHaveLength(1);
    expect(on[0]).not.toBe(off[0]);
    expect(on[0]).toBe(JSON.stringify(["edge", "pl-PL-MarekNeural", "pl", applyPronunciation(TEXT, "pl")]));
    expect(off[0]).toBe(JSON.stringify(["edge", "pl-PL-MarekNeural", "pl", TEXT]));
  });
});
