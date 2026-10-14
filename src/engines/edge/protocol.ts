/**
 * Edge read-aloud wire protocol: the two text messages a turn sends
 * (`speech.config`, then `ssml`) and parsing of the frames it receives.
 * Ported from rany2/edge-tts 7.3.1 `communicate.py`.
 *
 * The endpoint accepts only `speak` > `voice` > `prosody`: `<lang>`, `<break>`,
 * `mstts:*` and `xml:lang` on inner elements all yield no audio.
 */

export const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

export interface SsmlRequest {
  text: string;
  voice: string;
  /** 32-hex id; random when omitted. */
  requestId?: string;
  date?: Date;
  rate?: string;
  pitch?: string;
  volume?: string;
}

export type Frame =
  | { kind: "audio"; headers: Record<string, string>; audio: Uint8Array }
  | { kind: "turn.end"; headers: Record<string, string> }
  | { kind: "text"; path: string | undefined; headers: Record<string, string>; body: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** JavaScript-style UTC date string, as Edge sends in `X-Timestamp`. */
function timestamp(d: Date): string {
  return (
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    "GMT+0000 (Coordinated Universal Time)"
  );
}

export function newRequestId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildConfigMessage(date: Date = new Date()): string {
  const config = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  };
  return (
    `X-Timestamp:${timestamp(date)}\r\n` +
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    `${JSON.stringify(config)}\r\n`
  );
}

export function buildSsmlMessage(req: SsmlRequest): string {
  const { rate = "+0%", pitch = "+0Hz", volume = "+0%" } = req;
  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${escapeXml(req.voice)}'>` +
    `<prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='${escapeXml(volume)}'>` +
    escapeXml(req.text) +
    "</prosody></voice></speak>";
  return (
    `X-RequestId:${req.requestId ?? newRequestId()}\r\n` +
    "Content-Type:application/ssml+xml\r\n" +
    // The trailing "Z" mirrors a quirk of the real Edge client.
    `X-Timestamp:${timestamp(req.date ?? new Date())}Z\r\n` +
    "Path:ssml\r\n\r\n" +
    ssml
  );
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return headers;
}

/**
 * Text frames: header block, blank line, body. Binary frames: 2-byte big-endian
 * header length, header text, then audio.
 */
export function parseFrame(data: string | ArrayBuffer | Uint8Array): Frame {
  if (typeof data === "string") {
    const split = data.indexOf("\r\n\r\n");
    const headers = parseHeaders(split < 0 ? data : data.slice(0, split));
    const body = split < 0 ? "" : data.slice(split + 4);
    if (headers.Path === "turn.end") return { kind: "turn.end", headers };
    return { kind: "text", path: headers.Path, headers, body };
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 2) throw new Error("binary frame is missing its header length");
  const headerLength = (bytes[0]! << 8) | bytes[1]!;
  if (2 + headerLength > bytes.length) throw new Error("binary frame header exceeds frame");
  const headers = parseHeaders(new TextDecoder().decode(bytes.subarray(2, 2 + headerLength)));
  return { kind: "audio", headers, audio: bytes.subarray(2 + headerLength) };
}
