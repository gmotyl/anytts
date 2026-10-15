import type { VoiceInfo } from "../../engine.js";

export type { VoiceInfo };

// Union of the motyl and pavilio voice lists; gender/locale checked against `edge-tts --list-voices`.
export const EDGE_VOICES: readonly VoiceInfo[] = [
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "en-US-AvaMultilingualNeural", label: "Ava (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "en-US-BrianMultilingualNeural", label: "Brian (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "en-US-EmmaMultilingualNeural", label: "Emma (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "en-AU-WilliamMultilingualNeural", label: "William (multilingual · EN-AU)", locale: "en-AU", gender: "male", multilingual: true },
  { id: "de-DE-SeraphinaMultilingualNeural", label: "Seraphina (multilingual · DE)", locale: "de-DE", gender: "female", multilingual: true },
  { id: "de-DE-FlorianMultilingualNeural", label: "Florian (multilingual · DE)", locale: "de-DE", gender: "male", multilingual: true },
  { id: "fr-FR-VivienneMultilingualNeural", label: "Vivienne (multilingual · FR)", locale: "fr-FR", gender: "female", multilingual: true },
  { id: "fr-FR-RemyMultilingualNeural", label: "Remy (multilingual · FR)", locale: "fr-FR", gender: "male", multilingual: true },
  { id: "it-IT-GiuseppeMultilingualNeural", label: "Giuseppe (multilingual · IT)", locale: "it-IT", gender: "male", multilingual: true },
  { id: "pl-PL-MarekNeural", label: "Marek (Polish)", locale: "pl-PL", gender: "male", multilingual: false },
  { id: "pl-PL-ZofiaNeural", label: "Zofia (Polish)", locale: "pl-PL", gender: "female", multilingual: false },
];
