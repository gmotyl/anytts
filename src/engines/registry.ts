import type { VoiceInfo } from "../engine.js";
import { AZURE_VOICES } from "./azure/voices.js";
import { CARTESIA_VOICES } from "./cartesia/voices.js";
import { EDGE_VOICES } from "./edge/voices.js";
import { ELEVENLABS_VOICES } from "./elevenlabs/voices.js";
import { SPEECHIFY_VOICES } from "./speechify/voices.js";

export type { VoiceInfo };

/** An engine as listed for settings UIs. */
export interface EngineInfo {
  id: string;
  label: string;
  runtimes: ("browser" | "node")[];
}

// Static catalogs only: the keyed engines' code lives in `anytts/server`, so listing them here keeps
// the main entry free of key-handling code.
const ENGINES: readonly { info: EngineInfo; voices: readonly VoiceInfo[] }[] = [
  { info: { id: "edge", label: "Microsoft Edge (read aloud)", runtimes: ["browser", "node"] }, voices: EDGE_VOICES },
  { info: { id: "elevenlabs", label: "ElevenLabs", runtimes: ["node"] }, voices: ELEVENLABS_VOICES },
  { info: { id: "cartesia", label: "Cartesia", runtimes: ["node"] }, voices: CARTESIA_VOICES },
  { info: { id: "speechify", label: "Speechify", runtimes: ["node"] }, voices: SPEECHIFY_VOICES },
  { info: { id: "azure", label: "Azure Speech (F0)", runtimes: ["node"] }, voices: AZURE_VOICES },
  // The chain over the other engines: no voices of its own.
  { info: { id: "cascade", label: "Cascade (first engine that answers)", runtimes: ["browser", "node"] }, voices: [] },
];

export function listEngines(): EngineInfo[] {
  return ENGINES.map(({ info }) => ({ ...info, runtimes: [...info.runtimes] }));
}

/** The engine's voice catalog; `[]` for an unknown engine. */
export function listVoices(engineId: string): VoiceInfo[] {
  return (ENGINES.find(({ info }) => info.id === engineId)?.voices ?? []).map((voice) => ({ ...voice }));
}
