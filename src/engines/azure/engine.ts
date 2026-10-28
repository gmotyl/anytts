import type { EngineHooks } from "../../engine.js";
import {
  keyedFetch,
  missingKeyError,
  type KeyedEngine,
  type KeyedEngineOptions,
  type Refusal,
  type RefusalRules,
} from "../keyed.js";
import { AZURE_VOICE_MAP, AZURE_VOICES } from "./voices.js";

// API reference: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
// F0 limits: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
// (fixtures in __tests__).

export interface AzureEngineOptions extends KeyedEngineOptions {
  /**
   * Speech resource region, e.g. `westeurope` (case-insensitive, `WestEurope` works too).
   * Required when `apiKey` is set. Only the public cloud (`*.tts.speech.microsoft.com`) is
   * supported; sovereign clouds (Azure Government, Azure China) are not.
   */
  region?: string;
  /** MP3 `X-Microsoft-OutputFormat`. Default `audio-24khz-48kbitrate-mono-mp3`. */
  outputFormat?: `${string}-mp3`;
  /** Required by the API (fewer than 255 characters). Default `anytts`. */
  userAgent?: string;
}

/** The error text of a Cognitive Services refusal: `error.message`, `message`, or the raw body. */
function refusalMessage(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const { error, message } = body as { error?: { message?: unknown }; message?: unknown };
    if (typeof error?.message === "string") return error.message;
    if (typeof message === "string") return message;
  }
  return "";
}

const RULES: RefusalRules = {
  // Monthly F0 exhaustion arrives as 403 (possibly 429) with "Out of call volume quota. Quota
  // will be replenished in N days." — only the message tells it apart from a bad key or a
  // per-minute throttle. isQuota runs before isUnauthorized, so any other 401/403 (invalid
  // key, wrong region, disabled resource) stays unauthorized and a plain 429 stays rate-limited.
  isQuota: (r: Refusal) => (r.status === 403 || r.status === 429) && /quota/i.test(refusalMessage(r.body)),
  isUnauthorized: (r) => r.status === 401 || r.status === 403,
};

const REGION = /^[a-z0-9]+$/;

const escapeXml = (value: string): string =>
  value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** `pl-PL-ZofiaNeural` → `pl-PL`, `sr-Latn-RS-NicholasNeural` → `sr-Latn-RS`; else `en-US`. */
const voiceLocale = (voice: string): string =>
  /^([a-z]{2,3}(?:-[A-Z][a-z]{3})?-[A-Z]{2})-/.exec(voice)?.[1] ?? "en-US";

export function createAzureEngine(options: AzureEngineOptions = {}): KeyedEngine {
  const { apiKey, outputFormat = "audio-24khz-48kbitrate-mono-mp3", userAgent = "anytts" } = options;
  const region = options.region?.toLowerCase();
  if (apiKey && !(region && REGION.test(region))) {
    throw new RangeError(`azure: region is required with an apiKey (got ${JSON.stringify(options.region)})`);
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
