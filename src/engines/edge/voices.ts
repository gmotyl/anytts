import type { VoiceInfo } from "../../engine.js";

export type { VoiceInfo };

// Union of the motyl and pavilio voice lists, plus single-language English voices (0.2.2).
// Multilingual first, then single-language grouped by locale; gender/locale checked against
// Microsoft's read-aloud voices/list.
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
  { id: "en-US-AriaNeural", label: "Aria (English · US)", locale: "en-US", gender: "female", multilingual: false },
  { id: "en-US-JennyNeural", label: "Jenny (English · US)", locale: "en-US", gender: "female", multilingual: false },
  { id: "en-US-GuyNeural", label: "Guy (English · US)", locale: "en-US", gender: "male", multilingual: false },
  { id: "en-US-ChristopherNeural", label: "Christopher (English · US)", locale: "en-US", gender: "male", multilingual: false },
  { id: "en-GB-SoniaNeural", label: "Sonia (English · UK)", locale: "en-GB", gender: "female", multilingual: false },
  { id: "en-GB-RyanNeural", label: "Ryan (English · UK)", locale: "en-GB", gender: "male", multilingual: false },
  { id: "en-GB-LibbyNeural", label: "Libby (English · UK)", locale: "en-GB", gender: "female", multilingual: false },
  { id: "pl-PL-MarekNeural", label: "Marek (Polish)", locale: "pl-PL", gender: "male", multilingual: false },
  { id: "pl-PL-ZofiaNeural", label: "Zofia (Polish)", locale: "pl-PL", gender: "female", multilingual: false },
];
