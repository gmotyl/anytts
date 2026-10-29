import type { EngineHooks } from "../../engine.js";
import { keyedFetch, missingKeyError, type KeyedEngine, type KeyedEngineOptions, type Refusal, type RefusalRules } from "../keyed.js";
import { speechifyLanguage } from "./languages.js";
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

  async function synthesize(
    text: string,
    voice: string,
    signal: AbortSignal,
    hooks?: EngineHooks,
    lang?: string,
  ): Promise<ArrayBuffer> {
    if (!apiKey) throw missingKeyError("speechify");
    // `language` is sent only when the request language is in the simba-3.5 table and its base
    // differs from the voice's catalog locale; otherwise it is omitted and the voice's own locale
    // decides. A voice outside the catalog has no known locale, so a known `lang` is always sent.
    const voiceLocale = SPEECHIFY_VOICES.find((v) => v.id === voice)?.locale ?? "";
    const language = speechifyLanguage(lang, voiceLocale);
    return keyedFetch(
      "speechify",
      {
        url: `${baseUrl}/v1/audio/stream`,
        // `Accept` selects the MP3 container.
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ input: text, voice_id: voice, model, ...(language ? { language } : {}) }),
      },
      options,
      RULES,
      signal,
      hooks,
    );
  }

  return {
    id: "speechify",
    keyed: true,
    voices: SPEECHIFY_VOICES,
    defaults: { voices: { ...SPEECHIFY_VOICE_MAP }, maxConcurrent: 2 },
    synthesize,
  };
}
