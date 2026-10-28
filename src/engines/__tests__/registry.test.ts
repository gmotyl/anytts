import { describe, expect, it } from "vitest";
import { createEdgeEngine } from "../edge/engine.js";
import { AZURE_VOICES } from "../azure/voices.js";
import { CARTESIA_VOICES } from "../cartesia/voices.js";
import { ELEVENLABS_VOICES } from "../elevenlabs/voices.js";
import { listEngines, listVoices } from "../registry.js";
import { SPEECHIFY_VOICES } from "../speechify/voices.js";

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
  it("lists keyed engines and cascade with runtimes", () => {
    const engines = listEngines();
    expect(engines.map((engine) => engine.id)).toEqual(["edge", "elevenlabs", "cartesia", "speechify", "azure", "cascade"]);
    const runtimes = Object.fromEntries(engines.map((engine) => [engine.id, [...engine.runtimes].sort()]));
    expect(runtimes).toEqual({
      edge: ["browser", "node"],
      elevenlabs: ["node"],
      cartesia: ["node"],
      speechify: ["node"],
      azure: ["node"],
      cascade: ["browser", "node"],
    });
    for (const engine of engines) expect(engine.label).toBeTruthy();
    // Copies: mutating a listing does not touch the registry.
    engines[0]!.runtimes.pop();
    expect(listEngines()[0]!.runtimes).toHaveLength(2);
  });

  it("cascade has no catalog", () => {
    expect(listVoices("cascade")).toEqual([]);
    expect(listVoices("azure")).toEqual(AZURE_VOICES);
    expect(listVoices("elevenlabs")).toEqual(ELEVENLABS_VOICES);
    expect(listVoices("cartesia")).toEqual(CARTESIA_VOICES);
    expect(listVoices("speechify")).toEqual(SPEECHIFY_VOICES);
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

    // Single-language English voices, grouped by locale after the multilingual ones.
    const english = [
      ["en-US-AriaNeural", "female"],
      ["en-US-JennyNeural", "female"],
      ["en-US-GuyNeural", "male"],
      ["en-US-ChristopherNeural", "male"],
      ["en-GB-SoniaNeural", "female"],
      ["en-GB-RyanNeural", "male"],
      ["en-GB-LibbyNeural", "female"],
    ] as const;
    for (const [id, gender] of english) {
      expect(voices.find((voice) => voice.id === id)).toMatchObject({ gender, multilingual: false });
    }
    const firstSingle = voices.findIndex((voice) => !voice.multilingual);
    expect(voices.slice(firstSingle).every((voice) => !voice.multilingual)).toBe(true);
    expect(voices.slice(firstSingle).map((voice) => voice.locale)).toEqual([
      ...Array(4).fill("en-US"),
      ...Array(3).fill("en-GB"),
      "pl-PL",
      "pl-PL",
    ]);

    // The engine speaks exactly the catalog it is listed with.
    expect(createEdgeEngine().voices).toEqual(voices);
  });

  it("returned voices are copies of the catalog", () => {
    const [first] = listVoices("edge");
    const id = first!.id;
    first!.id = "mutated";
    expect(listVoices("edge")[0]!.id).toBe(id);
    expect(createEdgeEngine().voices[0]!.id).toBe(id);
  });

  it("unknown engine has no voices", () => {
    expect(listVoices("nope")).toEqual([]);
  });
});
