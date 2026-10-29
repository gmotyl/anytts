import type { VoiceInfo } from "../../engine.js";
import type { VoiceMap } from "../keyed.js";

// Speechify stock voices: every native pl-PL voice from the live `GET /v1/voices`, plus the
// language-support page's "staff picks" for en-US and en-GB
// (https://docs.speechify.ai/docs/language-support.md). On simba-3.5 every voice speaks all 48
// languages, keeping its native accent; `locale` is that accent.
export const SPEECHIFY_VOICES: readonly VoiceInfo[] = [
  { id: "kajetan", label: "Kajetan (multilingual · PL)", locale: "pl-PL", gender: "male", multilingual: true },
  { id: "iga", label: "Iga (multilingual · PL)", locale: "pl-PL", gender: "female", multilingual: true },
  { id: "tymon", label: "Tymon (multilingual · PL)", locale: "pl-PL", gender: "male", multilingual: true },
  { id: "jagna", label: "Jagna (multilingual · PL)", locale: "pl-PL", gender: "female", multilingual: true },
  { id: "dominika", label: "Dominika (multilingual · PL)", locale: "pl-PL", gender: "female", multilingual: true },
  { id: "michal", label: "Michał (multilingual · PL)", locale: "pl-PL", gender: "male", multilingual: true },
  { id: "geffen_32", label: "Geffen (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "harper_32", label: "Harper (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "wyatt_32", label: "Wyatt (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "dominic_32", label: "Dominic (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "george", label: "George (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "henry", label: "Henry (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "carly", label: "Carly (multilingual · EN-US)", locale: "en-US", gender: "female", multilingual: true },
  { id: "oliver", label: "Oliver (multilingual · EN-US)", locale: "en-US", gender: "male", multilingual: true },
  { id: "beatrice_32", label: "Beatrice (multilingual · EN-GB)", locale: "en-GB", gender: "female", multilingual: true },
  { id: "imogen_32", label: "Imogen (multilingual · EN-GB)", locale: "en-GB", gender: "female", multilingual: true },
  { id: "edmund_32", label: "Edmund (multilingual · EN-GB)", locale: "en-GB", gender: "male", multilingual: true },
  { id: "hugh_32", label: "Hugh (multilingual · EN-GB)", locale: "en-GB", gender: "male", multilingual: true },
];

/** Built-in Voice map, used when the config sets no `voices`. */
export const SPEECHIFY_VOICE_MAP: VoiceMap = {
  pl: "kajetan",
  en: "geffen_32",
  default: "geffen_32",
};
