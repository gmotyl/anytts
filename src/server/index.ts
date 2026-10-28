import type { IncomingMessage, ServerResponse } from "node:http";
import { createEdgeEngine, type EdgeEngineOptions } from "../engines/edge/engine.js";
import { createAzureEngine } from "../engines/azure/engine.js";
import { createCartesiaEngine } from "../engines/cartesia/engine.js";
import { createElevenLabsEngine } from "../engines/elevenlabs/engine.js";
import { createSpeechifyEngine } from "../engines/speechify/engine.js";
import { createTts as createBrowserSafeTts, type CreateTtsInternals, type EngineFactory, type Tts, type TtsConfig } from "../tts.js";
import { createRelayHandlerWith, type RelayHandlerOptions } from "./relay.js";

export type { AzureEngineOptions } from "../engines/azure/engine.js";
export type { CartesiaEngineOptions } from "../engines/cartesia/engine.js";
export type { ElevenLabsEngineOptions } from "../engines/elevenlabs/engine.js";
export type { SpeechifyEngineOptions } from "../engines/speechify/engine.js";

/** Keyed engines hold API keys, so only this (Node) entry registers them. */
const KEYED_ENGINES: Record<string, EngineFactory> = {
  elevenlabs: createElevenLabsEngine,
  cartesia: createCartesiaEngine,
  speechify: createSpeechifyEngine,
  azure: createAzureEngine,
};

/** `createTts` from `anytts`, plus the keyed engines (`elevenlabs`, `cartesia`, `speechify`, `azure`). */
export function createTts(config: TtsConfig, internals: CreateTtsInternals = {}): Tts {
  return createBrowserSafeTts(config, { ...internals, engineFactories: { ...KEYED_ENGINES, ...internals.engineFactories } });
}

export interface CreateRelayHandlerOptions extends RelayHandlerOptions {
  edge?: EdgeEngineOptions;
}

/**
 * Fetch-standard relay: `POST { text, voice }` → `200 audio/mpeg`, or
 * `400/403/413/502` JSON (`{ kind }` for unknown voices and engine failures).
 */
export function createRelayHandler(opts: CreateRelayHandlerOptions = {}): (req: Request) => Promise<Response> {
  const { edge, ...relay } = opts;
  return createRelayHandlerWith(createEdgeEngine(edge), relay);
}

export interface NodeHandlerOptions {
  /** Largest request body buffered for the handler; larger ones get 413. Default 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? NaN) > cap) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        req.off("data", onData);
        // Keep draining (discarding) so the 413 can be written; the connection closes after it.
        req.resume();
        return reject(new BodyTooLarge());
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function toRequest(req: IncomingMessage, signal: AbortSignal, cap: number): Promise<Request> {
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const url = new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? new Uint8Array(await readBody(req, cap)) : undefined;
  return new Request(url, { method, headers, body, signal });
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  // An empty statusText would send an empty reason phrase; let Node pick the standard one.
  res.writeHead(response.status, response.statusText || undefined, headers);

  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  for (;;) {
    if (res.destroyed) return void (await reader.cancel());
    const { done, value } = await reader.read();
    if (done) break;
    // Respect backpressure, but a client that leaves never drains. The client may have
    // left during the read: 'close' has then already fired and would never be awaited.
    if (!res.write(value)) {
      if (res.destroyed) return void (await reader.cancel());
      const closed = await new Promise<boolean>((resolve) => {
        const onDrain = () => {
          res.off("close", onClose);
          resolve(false);
        };
        const onClose = () => {
          res.off("drain", onDrain);
          resolve(true);
        };
        res.once("drain", onDrain);
        res.once("close", onClose);
        if (res.destroyed) onClose();
      });
      if (closed) return void (await reader.cancel());
    }
  }
  res.end();
}

/** Adapts a Fetch handler to `node:http` / Express `(req, res)`. */
export function toNodeHandler(
  h: (req: Request) => Promise<Response>,
  options: NodeHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;
  return (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    void (async () => {
      try {
        await writeResponse(await h(await toRequest(req, controller.signal, maxBodyBytes)), res);
      } catch (error) {
        if (error instanceof BodyTooLarge && !res.headersSent) {
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ error: "request body too large" }));
        } else if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } else {
          res.destroy();
        }
      }
    })();
  };
}
