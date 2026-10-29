// simba-3.5 languages: https://docs.speechify.ai/docs/language-support.md, section "Simba 3.5
// languages" (48 base codes, fetched 2026-10-29). Each base maps to the locale of its "Staff picks for
// every language" row; where a base has several rows the European one wins (en-GB, pt-PT, es-ES).
// Bases without a row of their own code (be, bs, my, la, no, sr, tl) send the bare code, which the
// docs accept ("either alone or with any region").

/** Base code → simba-3.5 locale, from the docs' "Simba 3.5 languages" section (48 entries);
 *  European variant where a base has several: en → en-GB, pt → pt-PT, es → es-ES. */
export const SPEECHIFY_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  ar: "ar-AE",
  be: "be",
  bn: "bn-IN",
  bs: "bs",
  my: "my",
  ca: "ca-ES",
  zh: "zh-CN",
  hr: "hr-HR",
  cs: "cs-CZ",
  da: "da-DK",
  nl: "nl-NL",
  en: "en-GB",
  fi: "fi-FI",
  fr: "fr-FR",
  ka: "ka-GE",
  de: "de-DE",
  el: "el-GR",
  gu: "gu-IN",
  he: "he-IL",
  hi: "hi-IN",
  hu: "hu-HU",
  id: "id-ID",
  it: "it-IT",
  ja: "ja-JP",
  kk: "kk-KZ",
  ko: "ko-KR",
  la: "la",
  ms: "ms-MY",
  mr: "mr-IN",
  no: "no",
  fa: "fa-IR",
  pl: "pl-PL",
  pt: "pt-PT",
  ro: "ro-RO",
  ru: "ru-RU",
  sr: "sr",
  sk: "sk-SK",
  sl: "sl-SI",
  es: "es-ES",
  sv: "sv-SE",
  tl: "tl",
  ta: "ta-IN",
  te: "te-IN",
  th: "th-TH",
  tr: "tr-TR",
  uk: "uk-UA",
  ur: "ur-IN",
  vi: "vi-VN",
});

const LOCALES = new Set(Object.values(SPEECHIFY_LANGUAGES));

const base = (locale: string): string => locale.split("-")[0]!.toLowerCase();

/** The `language` to send for `lang` on a voice of `voiceLocale`, or undefined to omit it. */
export function speechifyLanguage(lang: string | undefined, voiceLocale: string): string | undefined {
  if (!lang) return undefined;
  // A region-qualified `lang` must be one of the table's locales; a bare base must be a key.
  const locale = lang.includes("-")
    ? LOCALES.has(lang)
      ? lang
      : undefined
    : Object.hasOwn(SPEECHIFY_LANGUAGES, lang)
      ? SPEECHIFY_LANGUAGES[lang]
      : undefined;
  // A voice already speaking the language keeps its own locale (an en-GB voice reading English).
  if (!locale || base(locale) === base(voiceLocale)) return undefined;
  return locale;
}
