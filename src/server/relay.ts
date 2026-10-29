import { EmptyCascadeOrderError } from "../cascade.js";
import type { Engine } from "../engine.js";
import type { EdgeEngineOptions } from "../engines/edge/engine.js";
import { TtsError, UnknownEngineError, type TtsErrorKind } from "../errors.js";
import { createTts, type SynthesisRequest, type Tts, type TtsConfig } from "../tts.js";

export interface RelayHandlerOptions {
  /** Longest accepted `text`, in UTF-16 code units. Default 2000. */
  maxChars?: number;
  /**
   * Called after validation; resolving `false` answers 403. Optional: a relay serving keyed
   * engines without it spends the key owner's quota for anyone who can reach it.
   */
  authorize?: (req: Request) => boolean | Promise<boolean>;
  /**
   * Options for the standalone Edge engine that serves requests without `engine`, and
   * `engine: "edge"` when `tts` does not configure edge.
   */
  edge?: EdgeEngineOptions;
  /**
   * Serves every engine of this config named in the body (keyed engines, `cascade`, and `edge`
   * when it configures edge, sharing its cache and scheduler). A body without `engine` stays on the
   * standalone Edge engine. A `Tts` instance is used as-is, so its owner reads `engineStatus` from
   * the skip windows relay requests open.
   */
  tts?: TtsConfig | Tts;
}

/** Whether `tts` configures engine `id` (`engineStatus` throws RangeError for one it does not). */
function configures(tts: Tts, id: string): boolean {
  try {
    tts.engineStatus(id);
    return true;
  } catch {
    return false;
  }
}

const isTts = (tts: TtsConfig | Tts): tts is Tts => typeof (tts as Tts).synthesize === "function";

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

const isBooleanRecord = (v: unknown): v is Record<string, boolean> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "boolean");

/** The `Tts` request a non-Edge body asks for, or an error message for a malformed one. */
function parseTtsBody(engine: string, body: Record<string, unknown>): SynthesisRequest | string {
  const { text, voice, lang, voices, order, pronunciation } = body;
  if (engine !== "cascade") {
    if (typeof text !== "string" || typeof voice !== "string" || (lang !== undefined && typeof lang !== "string")) {
      return "expected { engine, text: string, voice: string, lang? }";
    }
    return { engine, text, voice, ...(lang !== undefined ? { lang } : {}) };
  }
  if (
    typeof text !== "string" ||
    (voice !== undefined && typeof voice !== "string") ||
    (lang !== undefined && typeof lang !== "string") ||
    (voices !== undefined && !isStringRecord(voices)) ||
    (order !== undefined && !(Array.isArray(order) && order.every((x) => typeof x === "string"))) ||
    (pronunciation !== undefined && !isBooleanRecord(pronunciation))
  ) {
    return "expected { engine: \"cascade\", text: string, lang?, voices?, order?, pronunciation? }";
  }
  return {
    engine,
    text,
    ...(voice !== undefined ? { voice } : {}),
    ...(lang !== undefined ? { lang } : {}),
    ...(voices !== undefined ? { voices } : {}),
    ...(order !== undefined ? { order: order as string[] } : {}),
    ...(pronunciation !== undefined ? { pronunciation } : {}),
  };
}

/** Reads at most `cap` bytes of the body; `undefined` when it is larger. */
async function readCapped(req: Request, cap: number): Promise<string | undefined> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(out);
}

const json = (status: number, body: { kind?: TtsErrorKind; retryAfter?: number; error?: string }, headers?: HeadersInit) =>
  Response.json(body, { status, ...(headers ? { headers } : {}) });

/**
 * Cross-origin browsers read only CORS-safelisted response headers unless the server names the
 * others: the cascade client needs the engine/voice headers, an error the `Retry-After`.
 */
const EXPOSE_HEADERS = { "access-control-expose-headers": "x-anytts-engine, x-anytts-voice, retry-after" };

const audio = (bytes: ArrayBuffer, engine: string, voice: string) =>
  new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(bytes.byteLength),
      "x-anytts-engine": engine,
      "x-anytts-voice": voice,
      ...EXPOSE_HEADERS,
    },
  });

/** `502 { kind, retryAfter? }`; `rate-limited` with a known wait also sets `Retry-After`. */
function failure(error: unknown): Response {
  if (!(error instanceof TtsError)) {
    // Client went away (request signal aborted) or an unexpected failure.
    return json(502, { error: "synthesis failed" });
  }
  const { kind, retryAfter } = error;
  if (retryAfter === undefined) return json(502, { kind });
  const headers = kind === "rate-limited" ? { "retry-after": String(Math.max(0, Math.ceil(retryAfter))), ...EXPOSE_HEADERS } : undefined;
  return json(502, { kind, retryAfter }, headers);
}

/**
 * Builds the relay around a given Edge engine. Internal seam: the public `createRelayHandler`
 * passes a Node Edge engine and the server `createTts` (which registers the keyed engines), tests
 * pass fakes. `buildTts` builds `options.tts` when it is a config; an instance is used as-is.
 */
export function createRelayHandlerWith(
  engine: Engine,
  options: RelayHandlerOptions = {},
  buildTts: (config: TtsConfig) => Tts = createTts,
): (req: Request) => Promise<Response> {
  const { maxChars = 2000, authorize } = options;
  const tts = options.tts === undefined ? undefined : isTts(options.tts) ? options.tts : buildTts(options.tts);
  const voiceIds = new Set(engine.voices.map((v) => v.id));
  const ttsServesEdge = tts !== undefined && configures(tts, "edge");
  // Worst case 6 bytes per code unit (a `\uXXXX` JSON escape) plus JSON overhead.
  const maxBodyBytes = maxChars * 6 + 1024;
  const tooLarge = () => json(413, { error: `body larger than ${maxBodyBytes} bytes` });

  return async (req) => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "POST" },
      });
    }

    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (declared > maxBodyBytes) return tooLarge();
    let body: unknown;
    try {
      const raw = await readCapped(req, maxBodyBytes);
      if (raw === undefined) return tooLarge();
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const engineId = fields.engine;
    if (engineId !== undefined && typeof engineId !== "string") {
      return json(400, { error: "expected engine to be a string" });
    }

    if (engineId !== undefined && (engineId !== "edge" || ttsServesEdge)) return serveTts(req, engineId, fields);

    const { text, voice } = fields;
    if (typeof text !== "string" || typeof voice !== "string") {
      return json(400, { error: "expected { text: string, voice: string }" });
    }

    if (!voiceIds.has(voice)) return json(400, { kind: "unknown-voice" });
    if (text.length > maxChars) return json(413, { error: `text longer than ${maxChars} characters` });
    if (authorize && !(await authorize(req))) return json(403, { error: "forbidden" });

    try {
      return audio(await engine.synthesize(text, voice, req.signal), engine.id, voice);
    } catch (error) {
      return failure(error);
    }
  };

  /** A keyed engine or `cascade`, served by `tts`; nothing reaches an engine for a pair it cannot serve. */
  async function serveTts(req: Request, engineId: string, fields: Record<string, unknown>): Promise<Response> {
    const parsed = parseTtsBody(engineId, fields);
    if (typeof parsed === "string") return json(400, { error: parsed });
    if (!tts) return json(400, { kind: "unknown-voice" });
    if (parsed.text.length > maxChars) return json(413, { error: `text longer than ${maxChars} characters` });
    if (authorize && !(await authorize(req))) return json(403, { error: "forbidden" });

    try {
      const result = await tts.synthesize({ ...parsed, signal: req.signal });
      return audio(result.bytes, result.engine, result.voice);
    } catch (error) {
      // An unconfigured engine or a voice outside its catalog: the pair cannot be served. Any other
      // RangeError (a bad tier) is the relay's own failure.
      if (error instanceof UnknownEngineError || (error instanceof TtsError && error.kind === "unknown-voice")) {
        return json(400, { kind: "unknown-voice" });
      }
      // An `order` naming no member is the client's mistake.
      if (error instanceof EmptyCascadeOrderError) return json(400, { error: error.message });
      return failure(error);
    }
  }
}
