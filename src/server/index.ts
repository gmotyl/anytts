import type { IncomingMessage, ServerResponse } from "node:http";
import { createEdgeEngine, type EdgeEngineOptions } from "../engines/edge/engine.js";
import { createRelayHandlerWith, type RelayHandlerOptions } from "./relay.js";

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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function toRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const url = new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? new Uint8Array(await readBody(req)) : undefined;
  return new Request(url, { method, headers, body, signal });
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText, headers);

  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Respect backpressure.
    if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}

/** Adapts a Fetch handler to `node:http` / Express `(req, res)`. */
export function toNodeHandler(
  h: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    void (async () => {
      try {
        await writeResponse(await h(await toRequest(req, controller.signal)), res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } else {
          res.destroy();
        }
      }
    })();
  };
}
