import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfigMessage, buildSsmlMessage, escapeXml, newRequestId, parseFrame } from "../protocol.js";

const DATE = new Date(Date.UTC(2026, 9, 14, 17, 5, 9));

function headersOf(message: string): Record<string, string> {
  const head = message.slice(0, message.indexOf("\r\n\r\n"));
  return Object.fromEntries(
    head.split("\r\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
  );
}

function bodyOf(message: string): string {
  return message.slice(message.indexOf("\r\n\r\n") + 4);
}

function binaryFrame(header: string, audio: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(header);
  const frame = new Uint8Array(2 + head.length + audio.length);
  frame[0] = head.length >> 8;
  frame[1] = head.length & 0xff;
  frame.set(head, 2);
  frame.set(audio, 2 + head.length);
  return frame;
}

describe("edge wire protocol", () => {
  it("config message requests 24khz 48kbit mono mp3", () => {
    const message = buildConfigMessage(DATE);
    const headers = headersOf(message);
    expect(headers.Path).toBe("speech.config");
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(headers["X-Timestamp"]).toBe(
      "Wed Oct 14 2026 17:05:09 GMT+0000 (Coordinated Universal Time)",
    );
    const config = JSON.parse(bodyOf(message)) as {
      context: { synthesis: { audio: { outputFormat: string } } };
    };
    expect(config.context.synthesis.audio.outputFormat).toBe("audio-24khz-48kbitrate-mono-mp3");
  });

  it("config message enables word boundaries and keeps sentence boundaries off", () => {
    // As of 2026-10-16 the service drops about half the turns (opens, then closes with no audio)
    // when word boundaries are off; with them on it answered every turn.
    const config = JSON.parse(bodyOf(buildConfigMessage(DATE))) as {
      context: { synthesis: { audio: { metadataoptions: Record<string, string> } } };
    };
    expect(config.context.synthesis.audio.metadataoptions).toEqual({
      sentenceBoundaryEnabled: "false",
      wordBoundaryEnabled: "true",
    });
  });

  it("ssml has only speak, voice and prosody", () => {
    const message = buildSsmlMessage({
      text: "Dzień dobry",
      voice: "pl-PL-ZofiaNeural",
      requestId: "abc123",
      date: DATE,
    });
    const headers = headersOf(message);
    expect(headers.Path).toBe("ssml");
    expect(headers["X-RequestId"]).toBe("abc123");
    expect(headers["Content-Type"]).toBe("application/ssml+xml");

    const ssml = bodyOf(message);
    const tags = [...ssml.matchAll(/<\/?([a-zA-Z:]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["speak", "voice", "prosody"]));
    expect(ssml).toMatch(
      /^<speak [^>]*><voice name='pl-PL-ZofiaNeural'><prosody [^>]*>Dzień dobry<\/prosody><\/voice><\/speak>$/,
    );
    expect(ssml).not.toContain("<lang");
    expect([...ssml.matchAll(/xml:lang='([^']*)'/g)].map((m) => m[1])).toEqual(["en-US"]);
    expect(ssml.indexOf("xml:lang")).toBeLessThan(ssml.indexOf("<voice"));
  });

  it("ssml escapes markup characters", () => {
    expect(escapeXml(`a < b > c & d`)).toBe("a &lt; b &gt; c &amp; d");
    const ssml = bodyOf(
      buildSsmlMessage({ text: "<break/> & co", voice: "en-US-AriaNeural", requestId: "x" }),
    );
    expect(ssml).toContain("&lt;break/&gt; &amp; co");
    expect(ssml).not.toContain("<break");
  });

  it("binary frame yields audio after headers", () => {
    const audio = new Uint8Array([0xff, 0xf3, 0x01, 0x02, 0x03]);
    const frame = binaryFrame(
      "X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nX-StreamId:1\r\nPath:audio\r\n",
      audio,
    );
    const parsed = parseFrame(frame.buffer as ArrayBuffer);
    expect(parsed.kind).toBe("audio");
    if (parsed.kind !== "audio") return;
    expect(Array.from(parsed.audio)).toEqual(Array.from(audio));
    expect(parsed.headers.Path).toBe("audio");

    // Same bytes as a Uint8Array view with a non-zero offset.
    const padded = new Uint8Array(frame.length + 3);
    padded.set(frame, 3);
    const view = parseFrame(padded.subarray(3));
    expect(view.kind === "audio" && Array.from(view.audio)).toEqual(Array.from(audio));
  });

  it("turn.end frame ends the turn", () => {
    expect(parseFrame("X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}").kind).toBe("turn.end");
    expect(parseFrame("X-RequestId:abc\r\nPath:turn.start\r\n\r\n{}")).toMatchObject({
      kind: "text",
      path: "turn.start",
    });
  });

  it("audio.metadata text frame parses as text, not audio", () => {
    const frame =
      "X-RequestId:abc\r\nContent-Type:application/json; charset=utf-8\r\nPath:audio.metadata\r\n\r\n" +
      '{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1000000,"Duration":3000000,' +
      '"text":{"Text":"Hello","Length":5,"BoundaryType":"WordBoundary"}}}]}';
    expect(parseFrame(frame)).toMatchObject({ kind: "text", path: "audio.metadata" });
  });
});

describe("newRequestId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("works without crypto.randomUUID (insecure browser origin)", () => {
    const { getRandomValues } = crypto;
    vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(crypto) });
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).not.toBe(a);
  });
});
