import type { Engine, EngineHooks, VoiceMap } from "../engine.js";
import { TtsError } from "../errors.js";

export type { VoiceMap };

/** Options every keyed engine accepts (engine-specific fields come on top). */
export interface KeyedEngineOptions {
  /** Provider API key. Without one, `synthesize` rejects `unauthorized` and sends nothing. */
  apiKey?: string;
  /**
   * Max wait for the response headers. Default 8000. It covers only the headers: once they arrive
   * the stall clock takes over, so a gap before the first audio chunk is reported as `stalled`.
   */
  firstByteMs?: number;
  /** Max gap between body chunks. Default 8000. */
  stallMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** A keyed engine plus the defaults the library fills in when the config leaves them unset. */
export interface KeyedEngine extends Engine {
  defaults: { voices: VoiceMap; maxConcurrent: number };
}

/** The pieces of a refused response a provider classifier looks at. */
export interface Refusal {
  status: number;
  /** Parsed JSON body, or the raw text when it is not JSON (`undefined` when unreadable). */
  body: unknown;
}

export interface RefusalRules {
  /** The refusal means the period's characters/credits are spent. */
  isQuota(refusal: Refusal): boolean;
  /** The refusal means the key is missing, invalid or revoked. Default: status 401. */
  isUnauthorized?(refusal: Refusal): boolean;
}

export interface KeyedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

export const missingKeyError = (engineId: string): TtsError =>
  new TtsError("unauthorized", `${engineId}: no apiKey configured`);

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * `Retry-After` in seconds: a non-negative integer delta-seconds, or an HTTP-date in IMF-fixdate
 * form (`Wed, 21 Oct 2015 07:28:00 GMT`). `undefined` when absent or anything else (`-3`, `1.5`,
 * `abc`, an impossible date).
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (!IMF_FIXDATE.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  // Reject dates the parser rolled over (e.g. "31 Feb"): the day/month/time must round-trip.
  if (new Date(date).toUTCString().slice(5) !== trimmed.slice(5)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

async function readBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Status → `TtsError`: quota and auth per the provider's rules, 429 → `rate-limited` (with
 * `retryAfter`), 5xx → `network` (transient), anything else → `rejected`.
 */
export async function refusalError(engineId: string, response: Response, rules: RefusalRules): Promise<TtsError> {
  const refusal: Refusal = { status: response.status, body: await readBody(response) };
  const { status } = refusal;
  const message = `${engineId} answered ${status}`;
  if (rules.isQuota(refusal)) return new TtsError("quota-exhausted", message, { status });
  if ((rules.isUnauthorized ?? ((r: Refusal) => r.status === 401))(refusal)) {
    return new TtsError("unauthorized", message, { status });
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    return new TtsError("rate-limited", message, { status, ...(retryAfter !== undefined ? { retryAfter } : {}) });
  }
  // Deliberate deviation from "anything else → rejected": a 5xx is the provider's own failure,
  // not a verdict on this request, so it is reported as transient `network` and gets retried
  // (or cascades) instead of being treated as final.
  if (status >= 500) return new TtsError("network", message, { status });
  return new TtsError("rejected", message, { status });
}

/**
 * One HTTP synthesis call that answers with an audio body: deadlines on headers and between
 * chunks, `onFirstByte` on the first non-empty chunk, abort through `signal`.
 */
export function keyedFetch(
  engineId: string,
  request: KeyedRequest,
  options: KeyedEngineOptions,
  rules: RefusalRules,
  signal: AbortSignal,
  hooks?: EngineHooks,
): Promise<ArrayBuffer> {
  const { firstByteMs = 8000, stallMs = 8000, fetch: doFetch = globalThis.fetch } = options;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());

    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const finish = () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      finish();
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
        response = await doFetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
      } catch (cause) {
        return fail(new TtsError("network", `${engineId} request failed`, { cause }));
      }
      if (settled) return;
      arm(stallMs, "stalled");
      if (!response.ok) {
        const error = await refusalError(engineId, response, rules);
        return fail(error);
      }
      if (!response.body) return fail(new TtsError("no-audio"));

      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) break;
          if (value.length === 0) continue;
          const first = total === 0;
          chunks.push(value);
          total += value.length;
          arm(stallMs, "stalled");
          if (first) {
            try {
              hooks?.onFirstByte?.();
            } catch {
              // A failing observer must not fail the synthesis.
            }
          }
        }
      } catch (cause) {
        return fail(new TtsError("network", `${engineId} body failed`, { cause }));
      }
      if (total === 0) return fail(new TtsError("no-audio"));
      finish();
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out.buffer);
    })();
  });
}
