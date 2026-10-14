import type { Engine } from "../../engine.js";
import { TtsError } from "../../errors.js";
import { buildConfigMessage, buildSsmlMessage, newRequestId, parseFrame } from "./protocol.js";
import { createSecMsGecGenerator, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN } from "./token.js";
import { defaultTransport, type Transport } from "./transport.js";
import { EDGE_VOICES } from "./voices.js";

export interface EdgeEngineOptions {
  /** Max wait for the first audio chunk, from opening the socket. */
  firstByteMs?: number;
  /** Max gap between audio chunks. */
  stallMs?: number;
  transport?: Transport;
  /** Clock in milliseconds (Date.now-style). */
  now?: () => number;
}

const WSS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

/** A failed attempt plus the server `Date` (ms) when the response carried one. */
interface AttemptFailure {
  error: unknown;
  serverDateMs?: number;
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

function concat(chunks: Uint8Array[], total: number): ArrayBuffer {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

export function createEdgeEngine(options: EdgeEngineOptions = {}): Engine {
  const { firstByteMs = 8000, stallMs = 8000, transport = defaultTransport, now = Date.now } = options;
  // Server clock minus local clock, learned from a rejected handshake's Date header.
  let skewSeconds = 0;

  function attempt(text: string, voice: string, signal: AbortSignal): Promise<ArrayBuffer> {
    return new Promise((resolve, reject: (failure: AttemptFailure) => void) => {
      if (signal.aborted) return reject({ error: abortError() });

      const token = createSecMsGecGenerator(() => now() / 1000, skewSeconds)();
      const url =
        `${WSS_URL}&ConnectionId=${newRequestId()}` +
        `&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

      let opened = false;
      let settled = false;
      let status: number | undefined;
      let serverDateMs: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunks: Uint8Array[] = [];
      let total = 0;

      const socket = transport.open(url, {}, {
        onUnexpectedResponse(code, headers) {
          status = code;
          const date = Date.parse(headers.get("date") ?? "");
          if (!Number.isNaN(date)) serverDateMs = date;
        },
      });
      socket.binaryType = "arraybuffer";

      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        // 2 = CLOSING, 3 = CLOSED.
        if (socket.readyState < 2) {
          try {
            socket.close();
          } catch {
            // Closing a socket that is already failing must not mask the real outcome.
          }
        }
      };
      const fail = (error: unknown, failure: Omit<AttemptFailure, "error"> = {}) => {
        if (settled) return;
        cleanup();
        reject({ error, ...failure });
      };
      const arm = (ms: number, kind: "first-byte-timeout" | "stalled") => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new TtsError(kind)), ms);
      };
      // Before any audio, a refused handshake or a server-side close means "rejected".
      const failEarly = () => {
        if (opened && total === 0) return fail(new TtsError("rejected", "server closed before any audio"));
        if (!opened) {
          return fail(
            new TtsError("rejected", status ? `handshake refused (${status})` : "handshake refused", {
              ...(status !== undefined ? { status } : {}),
            }),
            serverDateMs !== undefined ? { serverDateMs } : {},
          );
        }
        fail(new TtsError("network", "connection lost mid-audio"));
      };

      function onAbort() {
        fail(abortError());
      }
      function onOpen() {
        opened = true;
        const date = new Date(now());
        socket.send(buildConfigMessage(date));
        socket.send(buildSsmlMessage({ text, voice, date }));
      }
      function onMessage(event: MessageEvent) {
        if (settled) return;
        let frame;
        try {
          frame = parseFrame(event.data as string | ArrayBuffer | Uint8Array);
        } catch (cause) {
          return fail(new TtsError("network", "malformed frame", { cause }));
        }
        if (frame.kind === "turn.end") {
          if (total === 0) return fail(new TtsError("no-audio"));
          const audio = concat(chunks, total);
          cleanup();
          return resolve(audio);
        }
        // The service ends with an empty binary frame; it is not audio.
        if (frame.kind !== "audio" || frame.headers.Path !== "audio" || frame.audio.length === 0) return;
        chunks.push(frame.audio.slice());
        total += frame.audio.length;
        arm(stallMs, "stalled");
      }
      function onError() {
        if (opened) return fail(new TtsError("network", "socket error"));
        failEarly();
      }
      function onClose() {
        failEarly();
      }

      signal.addEventListener("abort", onAbort);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      arm(firstByteMs, "first-byte-timeout");
    });
  }

  async function synthesize(text: string, voice: string, signal: AbortSignal): Promise<ArrayBuffer> {
    try {
      return await attempt(text, voice, signal);
    } catch (failure) {
      const { error, serverDateMs } = failure as AttemptFailure;
      if (!(error instanceof TtsError) || error.kind !== "rejected" || serverDateMs === undefined) {
        throw error;
      }
      // Clock skew: same remedy as edge-tts — adopt the server's clock and retry once.
      skewSeconds += serverDateMs / 1000 - (now() / 1000 + skewSeconds);
      try {
        return await attempt(text, voice, signal);
      } catch (second) {
        throw (second as AttemptFailure).error;
      }
    }
  }

  return { id: "edge", voices: EDGE_VOICES, synthesize };
}
