/** A voice an engine can speak with. */
export interface VoiceInfo {
  id: string;
  label: string;
  locale: string;
  gender: "female" | "male";
  multilingual: boolean;
}

/** A Voice map: language → voice id, plus an optional `default`. */
export type VoiceMap = Record<string, string> & { default?: string };

/** What the library fills in when an engine's config leaves it unset. */
export interface EngineDefaults {
  /** Voice map used when the config sets no `voices`. */
  voices?: VoiceMap;
  /** Slot count used when the config sets no `maxConcurrent`; absent means unlimited. */
  maxConcurrent?: number;
}

/**
 * Progress callbacks an engine may report through; engines that ignore them stay valid. An engine
 * that never calls `onFirstByte` looks silent to `Tts.restartStalled`, which may restart it mid-stream.
 */
export interface EngineHooks {
  /** The first audio byte of this call arrived. Called at most once per `synthesize` call. */
  onFirstByte?(): void;
}

/**
 * A synthesis backend. `synthesize` always settles: audio bytes, a `TtsError`,
 * or an `AbortError` when `signal` aborts.
 */
export interface Engine {
  id: string;
  voices: readonly VoiceInfo[];
  defaults?: EngineDefaults;
  synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer>;
}
