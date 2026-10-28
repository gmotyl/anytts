import type { EngineHooks } from "../../engine.js";
import { keyedFetch, missingKeyError, type KeyedEngine, type KeyedEngineOptions, type Refusal, type RefusalRules } from "../keyed.js";
import { SPEECHIFY_VOICE_MAP, SPEECHIFY_VOICES } from "./voices.js";

// API reference: https://docs.speechify.ai/build/api-reference/v1/audio/stream (POST /v1/audio/stream,
// raw audio bytes chunked; /v1/audio/speech answers JSON with base64 audio_data, so it is not used).
// Errors: https://docs.speechify.ai/build/guides/concepts/error-handling and
// https://docs.speechify.ai/docs/api-limits (fixtures in __tests__).

export interface SpeechifyEngineOptions extends KeyedEngineOptions {
  /** Default `simba-3.5` (48 languages, Polish included; the API default `simba-3.0` has no Polish). */
  model?: string;
  /** Default `https://api.speechify.ai` (or a regional `https://eu.api.speechify.ai`). */
  baseUrl?: string;
}

const RULES: RefusalRules = {
  // 402 payment_required: insufficient balance/credits or the spend limit is reached.
  isQuota: (r: Refusal) => r.status === 402,
};

export function createSpeechifyEngine(options: SpeechifyEngineOptions = {}): KeyedEngine {
  const { apiKey, model = "simba-3.5", baseUrl = "https://api.speechify.ai" } = options;

  async function synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer> {
    if (!apiKey) throw missingKeyError("speechify");
    return keyedFetch(
      "speechify",
      {
        url: `${baseUrl}/v1/audio/stream`,
        // `Accept` selects the MP3 container; `language` is omitted so the voice's own locale decides.
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ input: text, voice_id: voice, model }),
      },
      options,
      RULES,
      signal,
      hooks,
    );
  }

  return {
    id: "speechify",
    voices: SPEECHIFY_VOICES,
    defaults: { voices: { ...SPEECHIFY_VOICE_MAP }, maxConcurrent: 2 },
    synthesize,
  };
}
