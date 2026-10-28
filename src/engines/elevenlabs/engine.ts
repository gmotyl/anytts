import type { EngineHooks } from "../../engine.js";
import { keyedFetch, missingKeyError, type KeyedEngine, type KeyedEngineOptions, type Refusal, type RefusalRules } from "../keyed.js";
import { ELEVENLABS_VOICE_MAP, ELEVENLABS_VOICES } from "./voices.js";

// API reference: https://elevenlabs.io/docs/api-reference/text-to-speech/stream
// Errors: https://elevenlabs.io/docs/developers/resources/errors and
// https://elevenlabs.io/docs/help-center/technical/api-error-code-400-or-401 (fixtures in __tests__).

export interface ElevenLabsEngineOptions extends KeyedEngineOptions {
  /** Default `eleven_multilingual_v2` (the API default; speaks Polish). */
  modelId?: string;
  /** MP3 output format. Default `mp3_44100_128` (the highest MP3 every tier may request). */
  outputFormat?: `mp3_${string}`;
  /** Default `https://api.elevenlabs.io`. */
  baseUrl?: string;
}

/** `detail.code` (current `{ type, code }` shape) or `detail.status` (legacy `{ status }` shape). */
function detailCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return undefined;
  const { code, status } = detail as { code?: unknown; status?: unknown };
  if (typeof code === "string") return code;
  return typeof status === "string" ? status : undefined;
}

const RULES: RefusalRules = {
  // 401 `quota_exceeded` (documented code), or 402 `payment_required` (insufficient credits).
  isQuota: (r: Refusal) => r.status === 402 || (r.status === 401 && detailCode(r.body) === "quota_exceeded"),
};

export function createElevenLabsEngine(options: ElevenLabsEngineOptions = {}): KeyedEngine {
  const {
    apiKey,
    modelId = "eleven_multilingual_v2",
    outputFormat = "mp3_44100_128",
    baseUrl = "https://api.elevenlabs.io",
  } = options;

  async function synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer> {
    if (!apiKey) throw missingKeyError("elevenlabs");
    const url =
      `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voice)}/stream` +
      `?output_format=${encodeURIComponent(outputFormat)}`;
    return keyedFetch(
      "elevenlabs",
      {
        url,
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: modelId }),
      },
      options,
      RULES,
      signal,
      hooks,
    );
  }

  return {
    id: "elevenlabs",
    keyed: true,
    voices: ELEVENLABS_VOICES,
    defaults: { voices: { ...ELEVENLABS_VOICE_MAP }, maxConcurrent: 2 },
    synthesize,
  };
}
