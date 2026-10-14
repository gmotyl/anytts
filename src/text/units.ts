export interface Unit {
  text: string;
  /** Index of the first source paragraph this unit speaks. */
  from: number;
  /** Index of the last source paragraph this unit speaks. */
  to: number;
}

export interface PackOptions {
  /** Floor: consecutive paragraphs merge until a unit reaches this length. Default 200. */
  min?: number;
  /** Ceiling: a unit never grows past this length. Default 450. */
  max?: number;
}

const DEFAULT_MIN = 200;
const DEFAULT_MAX = 450;

// A sentence ends with `.`, `!`, `?` or `…` (optionally followed by closing quotes or
// brackets) before whitespace or the end of the text, so "2.5" is not a boundary.
const SENTENCE_END = /[.!?…]+["'”’»)\]]*(?=\s|$)/u;
const SENTENCE = new RegExp(`\\S[\\s\\S]*?(?:${SENTENCE_END.source}|$)`, "gu");
const FIRST_SENTENCE = new RegExp(`^\\s*(\\S[\\s\\S]*?${SENTENCE_END.source})`, "u");

/** The text's first complete sentence, or `null` when it has none. */
export function firstSentence(text: string): string | null {
  return FIRST_SENTENCE.exec(text)?.[1] ?? null;
}

/**
 * Pack paragraphs into synthesis units: consecutive paragraphs merge until a unit
 * reaches `min`, never past `max`. A paragraph longer than `max` is cut on sentence
 * boundaries, then words; every piece spans that paragraph's index.
 */
export function packUnits<T extends { text: string }>(
  paragraphs: readonly T[],
  opts: PackOptions = {},
): Unit[] {
  const min = opts.min ?? DEFAULT_MIN;
  const max = opts.max ?? DEFAULT_MAX;
  const units: Unit[] = [];
  let pending: Unit | null = null;

  const flush = (): void => {
    if (pending) units.push(pending);
    pending = null;
  };

  paragraphs.forEach(({ text }, index) => {
    if (text.length > max) {
      flush();
      for (const piece of cut(text, max)) units.push({ text: piece, from: index, to: index });
      return;
    }
    if (pending && pending.text.length + 1 + text.length > max) flush();
    pending = pending ? { text: `${pending.text} ${text}`, from: pending.from, to: index } : { text, from: index, to: index };
    if (pending.text.length >= min) flush();
  });
  flush();

  return units;
}

/** Greedily join sentences into pieces ≤ max; an over-long sentence falls back to words. */
function cut(text: string, max: number): string[] {
  const sentences = (text.match(SENTENCE) ?? []).map((s) => s.trim());
  return greedy(sentences.flatMap((s) => (s.length > max ? greedy(words(s, max), max) : [s])), max);
}

function words(text: string, max: number): string[] {
  // A single word longer than max is hard-cut so every piece fits.
  return text.split(/\s+/u).flatMap((word) => {
    const parts: string[] = [];
    for (let i = 0; i < word.length; i += max) parts.push(word.slice(i, i + max));
    return parts;
  });
}

function greedy(parts: readonly string[], max: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    if (current && current.length + 1 + part.length > max) {
      pieces.push(current);
      current = part;
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
