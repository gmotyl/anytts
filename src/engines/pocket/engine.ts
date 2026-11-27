import type { Engine, EngineHooks, VoiceMap } from "../../engine.js";
import { TtsError } from "../../errors.js";
import { keyedFetch, type RefusalRules } from "../keyed.js";
import { encodeMp3, pcmFromWav } from "./audio.js";
import { pocketCatalog, type PocketVoice } from "./voices.js";

// pocket-tts speaks multipart: POST {baseUrl}/tts with `text` and `voice_url`, answering a WAV
// that is re-encoded to MP3 here. The language is never sent: each server speaks one language.

export interface PocketEngineOptions {
  /** Server root, e.g. "http://127.0.0.1:8890". Required, http(s). */
  baseUrl: string;
  /** Where caller voice samples are served; required when `voices` is non-empty. */
  voiceFilesUrl?: string;
  /** Caller voices, appended to the presets. */
  voices?: readonly PocketVoice[];
  /** Max wait for the response headers. Default 30000 (covers a cold model load). */
  firstByteMs?: number;
  /** Max gap between body chunks. Default: keyedFetch's (8000). */
  stallMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

type PocketId = "pocket" | "pocket-pl";

const DEFAULT_VOICE: Record<PocketId, string> = { pocket: "alba", "pocket-pl": "shefowl" };

/** The Polish server's reference voice: it is used by sending no `voice_url` at all. */
const REFERENCE_VOICE: Partial<Record<PocketId, string>> = { "pocket-pl": "shefowl" };

const CANNOT_CLONE = /voice cloning|predefined voices/i;

function httpUrl(id: string, field: string, value: unknown): URL {
  if (typeof value !== "string" || value === "") throw new RangeError(`${id}: ${field} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError(`${id}: ${field} is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RangeError(`${id}: ${field} must be http(s): ${value}`);
  }
  return url;
}

const trimSlashes = (path: string): string => path.replace(/\/+$/, "");

export function createPocketEngine(
  id: PocketId,
  options: PocketEngineOptions,
): Engine & {
  keyed: false;
  strictVoiceMap: true;
  defaults: { voices: VoiceMap; maxConcurrent: number };
} {
  const { baseUrl, voiceFilesUrl, voices = [], firstByteMs = 30000, stallMs, fetch } = options ?? ({} as PocketEngineOptions);
  const endpoint = httpUrl(id, "baseUrl", baseUrl);
  endpoint.pathname = `${trimSlashes(endpoint.pathname)}/tts`;
  endpoint.hash = "";
  const url = endpoint.toString();

  let filesBase: string | undefined;
  if (voices.length > 0) {
    const files = httpUrl(id, "voiceFilesUrl", voiceFilesUrl);
    filesBase = `${files.origin}${trimSlashes(files.pathname)}`;
  }
  const catalog = pocketCatalog(id, voices);
  const callerVoices = new Map(voices.map((v) => [v.id, v]));
  const fetchOptions = { firstByteMs, stallMs, fetch };

  const rules: RefusalRules = {
    isQuota: () => false,
    // The server reports "this voice cannot be used" as a 500; do not retry it as a transient fault.
    classify: ({ status, body }, message) => {
      if (status !== 500) return undefined;
      const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
      return CANNOT_CLONE.test(text) ? new TtsError("unknown-voice", message, { status }) : undefined;
    },
  };

  async function synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer> {
    const caller = callerVoices.get(voice);
    if (!caller && !catalog.some((v) => v.id === voice)) throw new TtsError("unknown-voice", `${id}: unknown voice "${voice}"`);
    const body = new FormData();
    body.append("text", text);
    if (caller) {
      body.append("voice_url", `${filesBase}/${encodeURIComponent(caller.id)}/sample.wav?v=${caller.version}`);
    } else if (voice !== REFERENCE_VOICE[id]) {
      body.append("voice_url", voice);
    }
    const wav = await keyedFetch(id, { url, headers: {}, body }, fetchOptions, rules, signal, hooks);
    const mp3 = await encodeMp3(pcmFromWav(wav));
    return mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) as ArrayBuffer;
  }

  return {
    id,
    keyed: false,
    strictVoiceMap: true,
    voices: catalog,
    defaults: { voices: { default: DEFAULT_VOICE[id] }, maxConcurrent: 1 },
    synthesize,
  };
}
