import type { VoiceInfo } from "../../engine.js";
import type { VoiceMap } from "../keyed.js";

// Cartesia stock voices. Jacqueline's id is the one Cartesia's own docs use
// (https://docs.cartesia.ai/build-with-cartesia/capability-guides/multilingual-voices.md: en-US
// native, multilingual accents). Cartesia's docs list no other ids, so the rest come from
// SignalWire's public Cartesia voice table (https://developer.signalwire.com/voice/tts/cartesia),
// checked against Barbershop Man, whose id is the one Cartesia's examples use.
// `multilingual: false` voices have one native accent; the engine pins their `language`.
export const CARTESIA_VOICES: readonly VoiceInfo[] = [
  { id: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", label: "Jacqueline (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "575a5d29-1fdc-4d4e-9afa-5a9a71759864", label: "Polish Narrator Woman (PL)", locale: "pl-PL", gender: "female", multilingual: false },
  { id: "3d335974-4c4a-400a-84dc-ebf4b73aada6", label: "Polish Confident Man (PL)", locale: "pl-PL", gender: "male", multilingual: false },
  { id: "4ef93bb3-682a-46e6-b881-8e157b6b4388", label: "Polish Narrator Man (PL)", locale: "pl-PL", gender: "male", multilingual: false },
  { id: "a0e99841-438c-4a64-b679-ae501e7d6091", label: "Barbershop Man (EN-US)", locale: "en-US", gender: "male", multilingual: false },
  { id: "79a125e8-cd45-4c13-8a67-188112f4dd22", label: "British Lady (EN-GB)", locale: "en-GB", gender: "female", multilingual: false },
];

/** Built-in Voice map, used when the config sets no `voices`. */
export const CARTESIA_VOICE_MAP: VoiceMap = {
  pl: "575a5d29-1fdc-4d4e-9afa-5a9a71759864",
  en: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
  default: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
};
