import type { Engine, VoiceMap } from "../../engine.js";
import { createOpenAIEngine } from "../openai/engine.js";
import { KOKORO_DEFAULT_VOICE, KOKORO_VOICES } from "./voices.js";

// Kokoro-FastAPI speaks the OpenAI speech API; this is the openai engine with the catalog,
// model and language handling fixed.

export interface KokoroEngineOptions {
  /** Server root, e.g. "http://127.0.0.1:8880". Required. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer` only when set. */
  apiKey?: string;
  /** Max wait for the response headers. Default 30000 (covers a cold model load). */
  firstByteMs?: number;
  /** Max gap between body chunks. Default: keyedFetch's (8000). */
  stallMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The engine owns these; accepting them would let a config break the catalog or phonemizer. */
const OWNED = ["catalog", "model", "languageField", "extraBody"] as const;

export function createKokoroEngine(options: KokoroEngineOptions): Engine & {
  keyed: false;
  strictVoiceMap: true;
  defaults: { voices: VoiceMap; maxConcurrent: number };
} {
  const raw = (options ?? {}) as unknown as Record<string, unknown>;
  for (const key of OWNED) {
    if (raw[key] !== undefined) throw new RangeError(`kokoro: ${key} is set by the engine`);
  }
  const { baseUrl, apiKey, firstByteMs = 30000, stallMs, fetch } = options ?? ({} as KokoroEngineOptions);
  const engine = createOpenAIEngine({
    baseUrl,
    apiKey,
    firstByteMs,
    stallMs,
    fetch,
    catalog: [...KOKORO_VOICES],
    model: "kokoro",
  });
  return {
    ...engine,
    id: "kokoro",
    defaults: { voices: { default: KOKORO_DEFAULT_VOICE }, maxConcurrent: 1 },
  };
}
