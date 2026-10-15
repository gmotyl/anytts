import { plPreset } from "./presets/pl.js";

/**
 * How loosely one pronunciation entry is allowed to match.
 *
 * - `word` — standalone word (Unicode boundaries) plus an optional plural "s", case-insensitive.
 * - `stem` — word start, any trailing letters (Polish inflection) preserved, case-insensitive.
 *   The loosest mode: a short stem swallows every longer word it prefixes.
 * - `exact` — standalone word plus the optional plural "s", case-SENSITIVE. For acronyms whose
 *   lowercase form is an ordinary word.
 */
export type PronunciationMatchMode = "word" | "stem" | "exact";

/** A respelling with its own match mode. A bare string entry is `{ say, match: "word" }`. */
export interface PronunciationEntry {
  readonly say: string;
  readonly match: PronunciationMatchMode;
}

/** One language's Pronunciation map: key → respelling. */
export type PronunciationMap = Readonly<Record<string, string | PronunciationEntry>>;

/** Pronunciation maps keyed by the spoken language of the voice ("pl", "en", …). */
export type PronunciationMaps = Readonly<Record<string, PronunciationMap>>;

const PRESETS: PronunciationMaps = { pl: plPreset };

// Modes run in this order; `exact` must stay last so a word key like `ci/cd` consumes
// "CI/CD" whole before a bare `CI` exact key could split it.
const MODE_ORDER: readonly PronunciationMatchMode[] = ["word", "stem", "exact"];

const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

// Case-sensitive whole-word replacement of every key at once: one alternation, longest key
// first, so each match is rewritten exactly once. A trailing plural "s" is re-attached.
const replaceExact = (text: string, map: ReadonlyMap<string, string>): string => {
  if (map.size === 0) return text;
  const names = [...map.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`${WORD_START}(${names.map(escapeRegExp).join("|")})(s?)${WORD_END}`, "gu");
  return text.replace(pattern, (_m, name: string, plural: string) => map.get(name) + plural);
};

const patternFor = (mode: "word" | "stem", key: string): RegExp => {
  const head = `${WORD_START}${escapeRegExp(key)}`;
  return mode === "word" ? new RegExp(`${head}(s?)${WORD_END}`, "giu") : new RegExp(`${head}(\\p{L}*)`, "giu");
};

/**
 * Respell `text` for a voice speaking `lang`. `maps` default to `{ pl: plPreset }`; a passed map
 * for a language extends (and per key overrides) that language's preset. No `lang`, or a
 * language without a map → the text is returned unchanged.
 */
export function applyPronunciation(text: string, lang: string | undefined, maps?: PronunciationMaps): string {
  if (lang === undefined) return text;
  const preset = own(PRESETS, lang);
  const extra = maps === undefined ? undefined : own(maps, lang);
  if (preset === undefined && extra === undefined) return text;

  const byMode = new Map<PronunciationMatchMode, Map<string, string>>(MODE_ORDER.map((m) => [m, new Map()]));
  const merged: PronunciationMap = { ...preset, ...extra };
  for (const [key, entry] of Object.entries(merged)) {
    const { say, match } = typeof entry === "string" ? { say: entry, match: "word" as const } : entry;
    byMode.get(match)?.set(key, say);
  }

  let out = text;
  for (const mode of MODE_ORDER) {
    const map = byMode.get(mode) ?? new Map<string, string>();
    if (mode === "exact") {
      out = replaceExact(out, map);
      continue;
    }
    // Longest key first, so a longer key beats one of its own prefixes.
    const keys = [...map.keys()].sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const say = map.get(key) ?? "";
      out = out.replace(patternFor(mode, key), (_m, suffix: string) => say + suffix);
    }
  }
  return out;
}
