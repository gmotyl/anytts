import type { VoiceInfo } from "../../engine.js";
import type { VoiceMap } from "../keyed.js";

// Azure neural voices (the same ids Edge's Read Aloud serves). The multilingual voices speak
// Polish too; `locale` is the voice's native accent. Ids from the Azure voice gallery:
// https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
export const AZURE_VOICES: readonly VoiceInfo[] = [
  { id: "pl-PL-ZofiaNeural", label: "Zofia (Polish)", locale: "pl-PL", gender: "female", multilingual: false },
  { id: "pl-PL-MarekNeural", label: "Marek (Polish)", locale: "pl-PL", gender: "male", multilingual: false },
  { id: "pl-PL-AgnieszkaNeural", label: "Agnieszka (Polish)", locale: "pl-PL", gender: "female", multilingual: false },
  { id: "en-US-AvaMultilingualNeural", label: "Ava (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "en-US-JennyNeural", label: "Jenny (English · US)", locale: "en-US", gender: "female", multilingual: false },
  { id: "en-US-GuyNeural", label: "Guy (English · US)", locale: "en-US", gender: "male", multilingual: false },
  { id: "en-GB-SoniaNeural", label: "Sonia (English · GB)", locale: "en-GB", gender: "female", multilingual: false },
  { id: "en-GB-RyanNeural", label: "Ryan (English · GB)", locale: "en-GB", gender: "male", multilingual: false },
];

/** Built-in Voice map, used when the config sets no `voices`. */
export const AZURE_VOICE_MAP: VoiceMap = {
  pl: "pl-PL-ZofiaNeural",
  en: "en-US-AvaMultilingualNeural",
  default: "en-US-AvaMultilingualNeural",
};
