import type { Engine } from "../engine.js";
import { TtsError, type TtsErrorKind } from "../errors.js";

export interface RelayHandlerOptions {
  /** Longest accepted `text`, in UTF-16 code units. Default 2000. */
  maxChars?: number;
  /** Called after validation; resolving `false` answers 403. */
  authorize?: (req: Request) => boolean | Promise<boolean>;
}

const json = (status: number, body: { kind?: TtsErrorKind; error?: string }) =>
  Response.json(body, { status });

/**
 * Builds the relay around a given engine. Internal seam: the public
 * `createRelayHandler` passes a Node Edge engine, tests pass a fake.
 */
export function createRelayHandlerWith(
  engine: Engine,
  options: RelayHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const { maxChars = 2000, authorize } = options;
  const voiceIds = new Set(engine.voices.map((v) => v.id));

  return async (req) => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "POST" },
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const { text, voice } = (body ?? {}) as { text?: unknown; voice?: unknown };
    if (typeof text !== "string" || typeof voice !== "string") {
      return json(400, { error: "expected { text: string, voice: string }" });
    }

    if (!voiceIds.has(voice)) return json(400, { kind: "unknown-voice" });
    if (text.length > maxChars) return json(413, { error: `text longer than ${maxChars} characters` });
    if (authorize && !(await authorize(req))) return json(403, { error: "forbidden" });

    try {
      const audio = await engine.synthesize(text, voice, req.signal);
      return new Response(audio, {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": String(audio.byteLength) },
      });
    } catch (error) {
      if (error instanceof TtsError) return json(502, { kind: error.kind });
      // Client went away (request signal aborted) or an unexpected failure.
      return json(502, { error: "synthesis failed" });
    }
  };
}
