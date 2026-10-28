import type { VoiceInfo } from "../../engine.js";
import type { VoiceMap } from "../keyed.js";

// ElevenLabs default ("premade") voices. Every one speaks all eleven_multilingual_v2 languages,
// Polish included; `locale` is the voice's native accent. George's id is the one ElevenLabs'
// TTS reference uses in its examples; the rest come from the premade library.
export const ELEVENLABS_VOICES: readonly VoiceInfo[] = [
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George (multilingual · EN-GB)", locale: "en-GB", gender: "male", multilingual: true },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel (multilingual · EN-GB)", locale: "en-GB", gender: "male", multilingual: true },
  { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice (multilingual · EN-GB)", locale: "en-GB", gender: "female", multilingual: true },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "cgSgspJ2msm6clMCkdW9", label: "Jessica (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily (multilingual · EN-GB)", locale: "en-GB", gender: "female", multilingual: true },
  { id: "IKne3meq5aSn9XLyUdCD", label: "Charlie (multilingual · EN-AU)", locale: "en-AU", gender: "male", multilingual: true },
  { id: "cjVigY5qzO86Huf0OWal", label: "Eric (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
];

/** Built-in Voice map, used when the config sets no `voices`. */
export const ELEVENLABS_VOICE_MAP: VoiceMap = {
  pl: "nPczCjzI2devNBz1zQrb",
  en: "JBFqnCBsd6RMkjVDRZzb",
  default: "JBFqnCBsd6RMkjVDRZzb",
};
