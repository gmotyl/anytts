import { describe, expect, it } from "vitest";
import { createEdgeEngine } from "../edge/engine.js";
import { listEngines, listVoices } from "../registry.js";

// Copied from motyl `lib/tts/voices.ts` (TTS_VOICES).
const MOTYL_VOICES = [
  "en-AU-WilliamMultilingualNeural",
  "en-US-AndrewMultilingualNeural",
  "en-US-EmmaMultilingualNeural",
  "en-US-AvaMultilingualNeural",
  "en-US-BrianMultilingualNeural",
  "de-DE-SeraphinaMultilingualNeural",
  "de-DE-FlorianMultilingualNeural",
  "fr-FR-VivienneMultilingualNeural",
  "fr-FR-RemyMultilingualNeural",
  "it-IT-GiuseppeMultilingualNeural",
  "pl-PL-MarekNeural",
  "pl-PL-ZofiaNeural",
];

// Copied from pavilio `panel/src/features/speech/voices.ts` (SPEECH_VOICES).
const PAVILIO_VOICES = [
  "en-US-AndrewMultilingualNeural",
  "en-AU-WilliamMultilingualNeural",
  "en-US-EmmaMultilingualNeural",
  "en-US-AvaMultilingualNeural",
  "en-US-BrianMultilingualNeural",
  "de-DE-SeraphinaMultilingualNeural",
  "de-DE-FlorianMultilingualNeural",
  "fr-FR-VivienneMultilingualNeural",
  "fr-FR-RemyMultilingualNeural",
  "it-IT-GiuseppeMultilingualNeural",
];

describe("registry", () => {
  it("lists the edge engine for browser and node", () => {
    const engines = listEngines();
    expect(engines.map((engine) => engine.id)).toEqual(["edge"]);
    expect([...engines[0]!.runtimes].sort()).toEqual(["browser", "node"]);
    expect(engines[0]!.label).toBeTruthy();
  });

  it("edge catalog includes Polish voices and both apps' voices", () => {
    const voices = listVoices("edge");
    const ids = voices.map((voice) => voice.id);
    const expected = new Set(["pl-PL-MarekNeural", "pl-PL-ZofiaNeural", ...MOTYL_VOICES, ...PAVILIO_VOICES]);
    for (const id of expected) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const voice of voices) {
      expect(voice.locale).toBe(voice.id.split("-").slice(0, 2).join("-"));
      expect(voice.multilingual).toBe(voice.id.includes("Multilingual"));
      expect(["female", "male"]).toContain(voice.gender);
      expect(voice.label).toBeTruthy();
    }
    expect(voices.find((voice) => voice.id === "pl-PL-MarekNeural")).toMatchObject({
      locale: "pl-PL",
      gender: "male",
      multilingual: false,
    });
    expect(voices.find((voice) => voice.id === "pl-PL-ZofiaNeural")?.gender).toBe("female");

    // The engine speaks exactly the catalog it is listed with.
    expect(createEdgeEngine().voices).toEqual(voices);
  });

  it("unknown engine has no voices", () => {
    expect(listVoices("nope")).toEqual([]);
  });
});
