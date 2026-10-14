/** A voice an engine can speak with. */
export interface VoiceInfo {
  id: string;
  label: string;
  locale: string;
  gender: "female" | "male";
  multilingual: boolean;
}

/**
 * A synthesis backend. `synthesize` always settles: audio bytes, a `TtsError`,
 * or an `AbortError` when `signal` aborts.
 */
export interface Engine {
  id: string;
  voices: readonly VoiceInfo[];
  synthesize(text: string, voice: string, signal: AbortSignal): Promise<ArrayBuffer>;
}
