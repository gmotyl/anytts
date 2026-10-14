import { describe, expect, it } from "vitest";
import type { Engine, VoiceInfo } from "../engine.js";
import { createTts } from "../tts.js";
import { resolveVoice } from "../voices.js";

const voice = (id: string): VoiceInfo => ({ id, label: id, locale: id.slice(0, 5), gender: "male", multilingual: false });

const engine = (id: string, voices: string[]): Engine => ({
  id,
  voices: voices.map(voice),
  synthesize: () => Promise.reject(new Error("not used")),
});

function setup() {
  return createTts(
    {
      engines: {
        edge: { voices: { pl: "pl-PL-MarekNeural", default: "en-US-AndrewMultilingualNeural" } },
        other: { voices: { pl: "pl-PL-ZofiaNeural", default: "en-GB-RyanNeural" } },
      },
      defaultEngine: "edge",
      scheduler: { concurrency: 1, tiers: [{ name: "play" }] },
    },
    {
      engineFactories: {
        edge: () => engine("edge", ["pl-PL-MarekNeural", "en-US-AndrewMultilingualNeural"]),
        other: () => engine("other", ["pl-PL-ZofiaNeural", "en-GB-RyanNeural"]),
      },
    },
  );
}

describe("resolveVoice", () => {
  it("keeps a voice that belongs to the engine", () => {
    const tts = setup();
    expect(resolveVoice(tts, { engine: "edge", voice: "pl-PL-MarekNeural", lang: "en" })).toEqual({
      voice: "pl-PL-MarekNeural",
      fellBack: false,
    });
  });

  it("falls back to the language voice after an engine switch", () => {
    const tts = setup();
    expect(resolveVoice(tts, { engine: "other", voice: "pl-PL-MarekNeural", lang: "pl" })).toEqual({
      voice: "pl-PL-ZofiaNeural",
      fellBack: true,
    });
  });

  it("falls back to default without a language voice", () => {
    const tts = setup();
    expect(resolveVoice(tts, { engine: "other", voice: "pl-PL-MarekNeural", lang: "de" })).toEqual({
      voice: "en-GB-RyanNeural",
      fellBack: true,
    });
    expect(resolveVoice(tts, { engine: "other", voice: "pl-PL-MarekNeural" })).toEqual({
      voice: "en-GB-RyanNeural",
      fellBack: true,
    });
  });

  it("nothing saved resolves to default without fallback", () => {
    const tts = setup();
    expect(resolveVoice(tts, { engine: "edge" })).toEqual({ voice: "en-US-AndrewMultilingualNeural", fellBack: false });
  });

  it("nothing saved with a language resolves to the language voice", () => {
    const tts = setup();
    expect(resolveVoice(tts, { engine: "edge", lang: "pl" })).toEqual({ voice: "pl-PL-MarekNeural", fellBack: false });
  });

  it("a prototype key is not a language voice", () => {
    const tts = setup();
    for (const lang of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(resolveVoice(tts, { engine: "edge", lang })).toEqual({ voice: "en-US-AndrewMultilingualNeural", fellBack: false });
    }
  });

  it("rejects an engine this instance does not configure", () => {
    const tts = setup();
    expect(() => resolveVoice(tts, { engine: "nope" })).toThrow(RangeError);
  });
});
