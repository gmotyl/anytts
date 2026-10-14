import type { VoiceInfo } from "./engine.js";
import type { Tts } from "./tts.js";

/** Per configured engine: its voice map and the engine instance's catalog. */
export type VoiceSource = Map<string, { voices: Record<string, string> & { default: string }; catalog: readonly VoiceInfo[] }>;

// Module-private seam: createTts registers each instance here so the public Tts shape stays unchanged.
const sources = new WeakMap<Tts, VoiceSource>();

/** Internal (not re-exported from the package entry). */
export function registerVoiceSource(tts: Tts, source: VoiceSource): void {
  sources.set(tts, source);
}

/**
 * Lenient voice resolution for settings UIs: a saved voice outside the engine's catalog falls back
 * to `voices[lang]`, then `voices.default`, with `fellBack: true`. Throws RangeError for an engine
 * this instance does not configure.
 */
export function resolveVoice(tts: Tts, q: { engine: string; voice?: string; lang?: string }): { voice: string; fellBack: boolean } {
  const entry = sources.get(tts)?.get(q.engine);
  if (!entry) throw new RangeError(`engine is not configured: ${q.engine}`);
  if (q.voice !== undefined && entry.catalog.some((v) => v.id === q.voice)) return { voice: q.voice, fellBack: false };
  const fallback = (q.lang !== undefined ? entry.voices[q.lang] : undefined) ?? entry.voices.default;
  return { voice: fallback, fellBack: q.voice !== undefined };
}
