import type { EngineHooks } from "../../engine.js";
import { keyedFetch, missingKeyError, type KeyedEngine, type KeyedEngineOptions, type Refusal, type RefusalRules } from "../keyed.js";
import { CARTESIA_VOICE_MAP, CARTESIA_VOICES } from "./voices.js";

// API reference: https://docs.cartesia.ai/api-reference/tts/bytes and
// https://docs.cartesia.ai/use-the-api/api-conventions (auth, Cartesia-Version).
// Errors: https://docs.cartesia.ai/use-the-api/api-errors and
// https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts (fixtures in __tests__).

export interface CartesiaEngineOptions extends KeyedEngineOptions {
  /** Default `sonic-3.6` (the API default). */
  modelId?: string;
  /** MP3 sample rate. Default 44100 (the API default). */
  sampleRate?: 8000 | 16000 | 22050 | 24000 | 44100 | 48000;
  /** MP3 bit rate. Default 128000 (the API default). */
  bitRate?: 32000 | 64000 | 96000 | 128000 | 192000;
  /** `Cartesia-Version` header. Default `2026-08-14` (structured JSON errors need >= 2026-03-01). */
  version?: string;
  /** Default `https://api.cartesia.ai`. */
  baseUrl?: string;
}

/** `error_code` of a structured error body (`Cartesia-Version` >= 2026-03-01); legacy bodies are plain text. */
function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { error_code?: unknown }).error_code;
  return typeof code === "string" ? code : undefined;
}

const RULES: RefusalRules = {
  // `quota_exceeded` is documented, its HTTP status is not: the code decides whatever the status.
  // A bare 402 (no code) reads as spent credits too; `plan_upgrade_required` does not.
  isQuota: (r: Refusal) =>
    errorCode(r.body) === "quota_exceeded" || (r.status === 402 && errorCode(r.body) === undefined),
  // 401, or a 403 without a specific code (e.g. an admin key on the TTS endpoint).
  isUnauthorized: (r: Refusal) => r.status === 401 || (r.status === 403 && errorCode(r.body) === undefined),
};

/** Single-accent catalog voices get their own language pinned; multilingual or unknown voices do not. */
const PINNED_LANGUAGE = new Map(
  CARTESIA_VOICES.filter((voice) => !voice.multilingual).map((voice) => [voice.id, voice.locale.split("-")[0]!]),
);

export function createCartesiaEngine(options: CartesiaEngineOptions = {}): KeyedEngine {
  const {
    apiKey,
    modelId = "sonic-3.6",
    sampleRate = 44100,
    bitRate = 128000,
    version = "2026-08-14",
    baseUrl = "https://api.cartesia.ai",
  } = options;

  async function synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer> {
    if (!apiKey) throw missingKeyError("cartesia");
    const language = PINNED_LANGUAGE.get(voice);
    return keyedFetch(
      "cartesia",
      {
        url: `${baseUrl}/tts/bytes`,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "cartesia-version": version,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          model_id: modelId,
          transcript: text,
          voice,
          output_format: { container: "mp3", sample_rate: sampleRate, bit_rate: bitRate },
          ...(language !== undefined ? { language } : {}),
        }),
      },
      options,
      RULES,
      signal,
      hooks,
    );
  }

  return {
    id: "cartesia",
    voices: CARTESIA_VOICES,
    defaults: { voices: { ...CARTESIA_VOICE_MAP }, maxConcurrent: 2 },
    synthesize,
  };
}
