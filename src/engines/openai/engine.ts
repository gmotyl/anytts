import type { Engine, EngineHooks, VoiceInfo, VoiceMap } from "../../engine.js";
import { keyedFetch, type RefusalRules } from "../keyed.js";

// OpenAI-compatible speech endpoint: POST {baseUrl}/v1/audio/speech with
// { input, voice, model, response_format } answering raw audio bytes. Targets self-hosted
// servers (e.g. OmniVoice), so the key is optional and there is no quota.

export interface OpenAIEngineOptions {
  /** Server root, e.g. "http://127.0.0.1:8890"; the engine appends "/v1/audio/speech". Required. */
  baseUrl: string;
  /** The voices this server offers; replaces a static catalog. Required, non-empty, unique ids. */
  catalog: VoiceInfo[];
  /** Sent as `Authorization: Bearer` only when set. */
  apiKey?: string;
  /** Default "tts-1". */
  model?: string;
  /** Body field that carries the request language (OmniVoice: "language"); unset → never sent. */
  languageField?: string;
  /** Merged into every request body; cannot override input/voice/model/response_format. */
  extraBody?: Record<string, unknown>;
  /** Max wait for the response headers. Default 15000 (local models can be slow to start). */
  firstByteMs?: number;
  /** Max gap between body chunks. Default: keyedFetch's (8000). */
  stallMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const RULES: RefusalRules = {
  // A self-hosted server has no quota.
  isQuota: () => false,
};

/** Language base: everything before the first `-`, lowercased. */
const languageBase = (tag: string): string => tag.split("-")[0]!.toLowerCase();

function validate(options: OpenAIEngineOptions): void {
  const { baseUrl, catalog } = options ?? ({} as OpenAIEngineOptions);
  if (typeof baseUrl !== "string" || baseUrl === "") throw new RangeError("openai: baseUrl is required");
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new RangeError(`openai: baseUrl is not a URL: ${baseUrl}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new RangeError(`openai: baseUrl must be http(s): ${baseUrl}`);
  }
  if (!Array.isArray(catalog) || catalog.length === 0) throw new RangeError("openai: catalog must be non-empty");
  const ids = new Set<string>();
  for (const voice of catalog) {
    if (ids.has(voice.id)) throw new RangeError(`openai: duplicate catalog voice id: ${voice.id}`);
    ids.add(voice.id);
  }
}

export function createOpenAIEngine(options: OpenAIEngineOptions): Engine & {
  keyed: false;
  defaults: { voices: VoiceMap; maxConcurrent: number };
} {
  validate(options);
  const { baseUrl, catalog, apiKey, model = "tts-1", languageField, extraBody, firstByteMs = 15000 } = options;
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/audio/speech`;
  const fetchOptions = { ...options, firstByteMs };

  async function synthesize(
    text: string,
    voice: string,
    signal: AbortSignal,
    hooks?: EngineHooks,
    lang?: string,
  ): Promise<ArrayBuffer> {
    // Fixed fields come last so extraBody cannot override them.
    const body: Record<string, unknown> = { ...extraBody, input: text, voice, model, response_format: "mp3" };
    if (languageField && lang) {
      const voiceLocale = catalog.find((v) => v.id === voice)?.locale ?? "";
      const base = languageBase(lang);
      if (base !== languageBase(voiceLocale)) body[languageField] = base;
    }
    const headers: Record<string, string> = { "content-type": "application/json", accept: "audio/mpeg" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return keyedFetch("openai", { url, headers, body: JSON.stringify(body) }, fetchOptions, RULES, signal, hooks);
  }

  return {
    id: "openai",
    keyed: false,
    voices: catalog,
    defaults: { voices: { default: catalog[0]!.id }, maxConcurrent: 1 },
    synthesize,
  };
}
