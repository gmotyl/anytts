// Browser-side clients of the relay (`anytts/server`). They hold no key and import no keyed engine
// code: only the static voice catalogs (the app-supplied one for `openai`), so the main entry stays
// free of key-handling code.
import type { Engine, EngineHooks, VoiceInfo, VoiceMap } from "../engine.js";
import { TtsError, type TtsErrorKind } from "../errors.js";
import { AZURE_VOICE_MAP, AZURE_VOICES } from "./azure/voices.js";
import { CARTESIA_VOICE_MAP, CARTESIA_VOICES } from "./cartesia/voices.js";
import { ELEVENLABS_VOICE_MAP, ELEVENLABS_VOICES } from "./elevenlabs/voices.js";
import { KOKORO_DEFAULT_VOICE, KOKORO_VOICES } from "./kokoro/voices.js";
import { SPEECHIFY_VOICE_MAP, SPEECHIFY_VOICES } from "./speechify/voices.js";

export interface RelayFetchOptions {
  url: string;
  /** Max wait for the response headers (the relay answers once the audio is ready). */
  firstByteMs: number;
  /** Max gap between body chunks. */
  stallMs: number;
}

/** What a relay client accepts in the browser. No `apiKey`: the key stays with the relay. */
export interface RelayEngineOptions {
  /** The relay endpoint (`createRelayHandler` from `anytts/server`). */
  relayUrl: string;
  /** Max wait for the relay's response headers. Default 8000 (20000 for `cascade` and `openai`, 35000 for `kokoro`). */
  firstByteMs?: number;
  /** Max gap between body chunks. Default 8000. */
  stallMs?: number;
  apiKey?: never;
}

/** The relay's answer: the audio and the engine/voice that spoke (`x-anytts-engine` / `x-anytts-voice`). */
export interface RelayAnswer {
  bytes: ArrayBuffer;
  engine: string | null;
  voice: string | null;
}

/** Every kind a relay error body may carry; anything else falls back to the status. */
const KINDS: ReadonlySet<string> = new Set<TtsErrorKind>([
  "rejected",
  "first-byte-timeout",
  "stalled",
  "network",
  "no-audio",
  "unknown-voice",
  "quota-exhausted",
  "unauthorized",
  "rate-limited",
]);

const DEFAULT_MS = 8000;
/** A cascade relay may walk several members before it answers. */
const DEFAULT_CASCADE_FIRST_BYTE_MS = 20000;
/**
 * The browser `openai` client's header wait: the relay answers only after the whole clip is
 * generated, and the Node engine itself waits 15000 ms, so the browser must outlast it.
 */
const DEFAULT_OPENAI_FIRST_BYTE_MS = 20000;
/** Same reasoning for `kokoro`: its Node engine waits 30000 ms (a cold model load). */
const DEFAULT_KOKORO_FIRST_BYTE_MS = 35000;

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/** Seconds from the body's `retryAfter`, else from a delta-seconds `Retry-After` header. */
function retryAfterOf(body: { retryAfter?: unknown } | null, response: Response): number | undefined {
  const fromBody = body?.retryAfter;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const header = response.headers.get("retry-after")?.trim();
  return header !== undefined && /^\d+$/.test(header) ? Number(header) : undefined;
}

/**
 * Error rehydration: a `{ kind, retryAfter? }` body keeps its kind and wait. Validation answers
 * carry none, so a 4xx without one is `rejected` (final) and a 5xx is `network` (transient).
 */
async function errorFor(response: Response): Promise<TtsError> {
  type ErrorBody = { kind?: unknown; retryAfter?: unknown } | null;
  // Not JSON: fall back to the status.
  const body = await response.json().then(
    (parsed: unknown) => (typeof parsed === "object" ? (parsed as ErrorBody) : null),
    () => null,
  );
  const kind = typeof body?.kind === "string" ? body.kind : undefined;
  const resolved: TtsErrorKind =
    kind !== undefined && KINDS.has(kind) ? (kind as TtsErrorKind) : response.status < 500 ? "rejected" : "network";
  const retryAfter = retryAfterOf(body, response);
  return new TtsError(resolved, `relay answered ${response.status}`, {
    status: response.status,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}

/** `POST body` (JSON) to the relay with header and stall deadlines; `onFirstByte` on the first chunk. */
export function relayFetch(
  options: RelayFetchOptions,
  body: Record<string, unknown>,
  signal: AbortSignal,
  hooks?: EngineHooks,
): Promise<RelayAnswer> {
  const { url, firstByteMs, stallMs } = options;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());

    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      reader?.cancel().catch(() => {});
      reject(error);
    };
    const arm = (ms: number, kind: "first-byte-timeout" | "stalled") => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new TtsError(kind)), ms);
    };
    function onAbort() {
      fail(abortError());
    }
    signal.addEventListener("abort", onAbort);
    arm(firstByteMs, "first-byte-timeout");

    void (async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        return fail(new TtsError("network", "relay request failed", { cause }));
      }
      if (settled) return;
      arm(stallMs, "stalled");
      if (!response.ok) return fail(await errorFor(response));
      if (!response.body) return fail(new TtsError("no-audio"));

      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) break;
          const first = total === 0;
          chunks.push(value);
          total += value.length;
          arm(stallMs, "stalled");
          if (first && value.length > 0) hooks?.onFirstByte?.();
        }
      } catch (cause) {
        return fail(new TtsError("network", "relay body failed", { cause }));
      }
      if (total === 0) return fail(new TtsError("no-audio"));
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve({ bytes: out.buffer, engine: response.headers.get("x-anytts-engine"), voice: response.headers.get("x-anytts-voice") });
    })();
  });
}

/** Reads only the relay fields: anything else in the config (an `apiKey` included) is ignored. */
function fetchOptions(id: string, options: Record<string, unknown>, defaultFirstByteMs: number): RelayFetchOptions {
  const { relayUrl, firstByteMs, stallMs } = options;
  if (typeof relayUrl !== "string" || relayUrl.length === 0) {
    throw new RangeError(`${id} runs in the browser through the relay: it needs a relayUrl`);
  }
  return {
    url: relayUrl,
    firstByteMs: typeof firstByteMs === "number" ? firstByteMs : defaultFirstByteMs,
    stallMs: typeof stallMs === "number" ? stallMs : DEFAULT_MS,
  };
}

const CATALOGS: Record<string, { voices: readonly VoiceInfo[]; map: VoiceMap }> = {
  elevenlabs: { voices: ELEVENLABS_VOICES, map: ELEVENLABS_VOICE_MAP },
  cartesia: { voices: CARTESIA_VOICES, map: CARTESIA_VOICE_MAP },
  speechify: { voices: SPEECHIFY_VOICES, map: SPEECHIFY_VOICE_MAP },
  azure: { voices: AZURE_VOICES, map: AZURE_VOICE_MAP },
};

/**
 * A keyed engine as a relay client: `POST { engine, text, voice, lang? }`, `lang` only when the
 * request has one. Not `keyed` (it holds no key, so the cascade never skips it for one); slot
 * limits are the relay's, so it sets no `maxConcurrent`.
 */
export function createRelayEngine(id: string, options: RelayEngineOptions): Engine {
  const catalog = Object.hasOwn(CATALOGS, id) ? CATALOGS[id] : undefined;
  if (!catalog) throw new RangeError(`no relay client for engine: ${id}`);
  const fetchOpts = fetchOptions(id, options as unknown as Record<string, unknown>, DEFAULT_MS);
  return {
    id,
    voices: catalog.voices,
    defaults: { voices: catalog.map },
    async synthesize(text, voice, signal, hooks, lang) {
      const body = { engine: id, text, voice, ...(lang !== undefined ? { lang } : {}) };
      return (await relayFetch(fetchOpts, body, signal, hooks)).bytes;
    },
  };
}

/** The browser `openai` client: the relay options plus the app's voice `catalog`. */
export interface OpenAIRelayEngineOptions extends RelayEngineOptions {
  /** The voices the relay's `openai` engine offers; voice checks run on it locally. Non-empty, unique ids. */
  catalog: VoiceInfo[];
  baseUrl?: never;
  extraBody?: never;
}

/** Server-only `openai` fields: refused rather than ignored, so none of them reaches the browser. */
const OPENAI_SERVER_FIELDS = ["apiKey", "baseUrl", "extraBody"] as const;

/**
 * `openai` as a relay client: `POST { engine: "openai", text, voice, lang? }`. Its voices are the
 * app-supplied `catalog`, validated as the Node engine validates it; the default voice is the first.
 */
export function createOpenAIRelayEngine(options: OpenAIRelayEngineOptions): Engine {
  const raw = options as unknown as Record<string, unknown>;
  refuseServerFields("openai", raw, OPENAI_SERVER_FIELDS);
  const { catalog } = options;
  if (!Array.isArray(catalog) || catalog.length === 0) throw new RangeError("openai: catalog must be non-empty");
  const ids = new Set<string>();
  for (const voice of catalog) {
    if (ids.has(voice.id)) throw new RangeError(`openai: duplicate catalog voice id: ${voice.id}`);
    ids.add(voice.id);
  }
  return catalogRelayEngine("openai", catalog, catalog[0]!.id, fetchOptions("openai", raw, DEFAULT_OPENAI_FIRST_BYTE_MS));
}

/** Refuses server-only fields rather than ignoring them, so none of them reaches the browser. */
function refuseServerFields(id: string, raw: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (raw[field] !== undefined) throw new RangeError(`${id} runs in the browser through the relay: ${field} stays on the server`);
  }
}

/** A relay client whose voices are a fixed catalog; the voice map may name only catalog voices. */
function catalogRelayEngine(id: string, catalog: readonly VoiceInfo[], defaultVoice: string, fetchOpts: RelayFetchOptions): Engine {
  return {
    id,
    voices: catalog,
    strictVoiceMap: true,
    defaults: { voices: { default: defaultVoice } },
    async synthesize(text, voice, signal, hooks, lang) {
      const body = { engine: id, text, voice, ...(lang !== undefined ? { lang } : {}) };
      return (await relayFetch(fetchOpts, body, signal, hooks)).bytes;
    },
  };
}

/** The browser `kokoro` client: the relay options only; its voices are the static Kokoro catalog. */
export interface KokoroRelayEngineOptions extends RelayEngineOptions {
  baseUrl?: never;
  catalog?: never;
}

/** `kokoro` as a relay client: `POST { engine: "kokoro", text, voice, lang? }`. */
export function createKokoroRelayEngine(options: KokoroRelayEngineOptions): Engine {
  const raw = options as unknown as Record<string, unknown>;
  refuseServerFields("kokoro", raw, ["apiKey", "baseUrl", "catalog"]);
  return catalogRelayEngine("kokoro", KOKORO_VOICES, KOKORO_DEFAULT_VOICE, fetchOptions("kokoro", raw, DEFAULT_KOKORO_FIRST_BYTE_MS));
}

/** The relay clients the main entry registers for the keyed engine ids, `openai` and `kokoro`. */
export const RELAY_ENGINES: Record<string, (options: Record<string, unknown>) => Engine> = {
  ...Object.fromEntries(
    Object.keys(CATALOGS).map((id) => [id, (options: Record<string, unknown>) => createRelayEngine(id, options as unknown as RelayEngineOptions)]),
  ),
  openai: (options) => createOpenAIRelayEngine(options as unknown as OpenAIRelayEngineOptions),
  kokoro: (options) => createKokoroRelayEngine(options as unknown as KokoroRelayEngineOptions),
};

/** A browser cascade request body; the relay walks the chain. */
export interface CascadeRelayBody {
  text: string;
  lang?: string;
  voices?: Record<string, string>;
  order?: string[];
  pronunciation?: Record<string, boolean>;
}

export interface RelayCascade {
  /** One relay call; resolves with the member that spoke, from the response headers. */
  synthesize(body: CascadeRelayBody, signal: AbortSignal, hooks?: EngineHooks): Promise<{ bytes: ArrayBuffer; engine: string; voice: string }>;
}

/** `cascade` as a relay client: `POST { engine: "cascade", text, lang?, voices?, order?, pronunciation? }`. */
export function createRelayCascade(options: Record<string, unknown>): RelayCascade {
  const fetchOpts = fetchOptions("cascade", options, DEFAULT_CASCADE_FIRST_BYTE_MS);
  return {
    async synthesize(body, signal, hooks) {
      const answer = await relayFetch(fetchOpts, { engine: "cascade", ...body }, signal, hooks);
      if (!answer.engine || !answer.voice) throw new TtsError("rejected", "relay answer names no engine or voice");
      return { bytes: answer.bytes, engine: answer.engine, voice: answer.voice };
    },
  };
}
