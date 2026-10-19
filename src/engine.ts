/** A voice an engine can speak with. */
export interface VoiceInfo {
  id: string;
  label: string;
  locale: string;
  gender: "female" | "male";
  multilingual: boolean;
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
  synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer>;
}
