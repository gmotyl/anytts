import type { EngineHooks } from "../../engine.js";
import { keyedFetch, missingKeyError, type KeyedEngine, type KeyedEngineOptions, type RefusalRules } from "../keyed.js";
import { AZURE_VOICE_MAP, AZURE_VOICES } from "./voices.js";

// API reference: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
// F0 limits: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
// (fixtures in __tests__).

export interface AzureEngineOptions extends KeyedEngineOptions {
  /** Speech resource region, e.g. `westeurope`. Required when `apiKey` is set. */
  region?: string;
  /** MP3 `X-Microsoft-OutputFormat`. Default `audio-24khz-48kbitrate-mono-mp3`. */
  outputFormat?: `${string}-mp3`;
  /** Required by the API (fewer than 255 characters). Default `anytts`. */
  userAgent?: string;
}

const RULES: RefusalRules = {
  // F0 quota is not adjustable and Azure documents no distinct quota response; 401 and 403
  // both mean the key cannot be used (invalid, wrong region, disabled resource).
  isQuota: () => false,
  isUnauthorized: (r) => r.status === 401 || r.status === 403,
};

const REGION = /^[a-z0-9]+$/;

const escapeXml = (value: string): string =>
  value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** `pl-PL-ZofiaNeural` → `pl-PL`; anything else falls back to `en-US`. */
const voiceLocale = (voice: string): string => /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice)?.[1] ?? "en-US";

export function createAzureEngine(options: AzureEngineOptions = {}): KeyedEngine {
  const { apiKey, region, outputFormat = "audio-24khz-48kbitrate-mono-mp3", userAgent = "anytts" } = options;
  if (apiKey && !(region && REGION.test(region))) {
    throw new RangeError(`azure: region is required with an apiKey (got ${JSON.stringify(region)})`);
  }

  async function synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer> {
    if (!apiKey) throw missingKeyError("azure");
    const lang = escapeXml(voiceLocale(voice));
    const body =
      `<speak version='1.0' xml:lang='${lang}'>` +
      `<voice xml:lang='${lang}' name='${escapeXml(voice)}'>${escapeXml(text)}</voice></speak>`;
    return keyedFetch(
      "azure",
      {
        url: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        headers: {
          "ocp-apim-subscription-key": apiKey,
          "content-type": "application/ssml+xml",
          "x-microsoft-outputformat": outputFormat,
          "user-agent": userAgent,
        },
        body,
      },
      options,
      RULES,
      signal,
      hooks,
    );
  }

  return {
    id: "azure",
    voices: AZURE_VOICES,
    defaults: { voices: { ...AZURE_VOICE_MAP }, maxConcurrent: 1 },
    synthesize,
  };
}
