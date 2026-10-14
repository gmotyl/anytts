import type { VoiceInfo } from "../engine.js";
import { EDGE_VOICES } from "./edge/voices.js";

export type { VoiceInfo };

/** An engine as listed for settings UIs. */
export interface EngineInfo {
  id: string;
  label: string;
  runtimes: ("browser" | "node")[];
}

const ENGINES: readonly { info: EngineInfo; voices: readonly VoiceInfo[] }[] = [
  { info: { id: "edge", label: "Microsoft Edge (read aloud)", runtimes: ["browser", "node"] }, voices: EDGE_VOICES },
];

export function listEngines(): EngineInfo[] {
  return ENGINES.map(({ info }) => ({ ...info, runtimes: [...info.runtimes] }));
}

/** The engine's voice catalog; `[]` for an unknown engine. */
export function listVoices(engineId: string): VoiceInfo[] {
  return [...(ENGINES.find(({ info }) => info.id === engineId)?.voices ?? [])];
}
