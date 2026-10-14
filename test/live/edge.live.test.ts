import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEdgeEngine } from "../../src/engines/edge/engine.js";
import { createSecMsGecGenerator, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN } from "../../src/engines/edge/token.js";
import { EDGE_WS_HEADERS } from "../../src/engines/edge/transport.js";
import { listVoices } from "../../src/index.js";
import { createRelayHandler, toNodeHandler } from "../../src/server/index.js";

// Contract test against Microsoft's live endpoint: run via `pnpm test:live`, never in `pnpm test`.

const TEXT = "Dzień dobry, to jest test syntezy mowy.";
const VOICE = "pl-PL-MarekNeural";
const VOICE_LIST_URL =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list" +
  `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

/** MP3 frame sync (11 set bits) or an ID3v2 tag. */
function looksLikeMp3(bytes: Uint8Array): boolean {
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const sync = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
  return id3 || sync;
}

describe("Edge read-aloud (live)", () => {
  it("synthesizes a short Polish sentence directly from Node", async () => {
    const audio = new Uint8Array(
      await createEdgeEngine().synthesize(TEXT, VOICE, AbortSignal.timeout(20_000)),
    );
    expect(audio.byteLength).toBeGreaterThan(1024);
    expect(looksLikeMp3(audio)).toBe(true);
  });

  describe("through a local relay", () => {
    let server: Server;
    let url: string;

    beforeAll(async () => {
      server = createServer(toNodeHandler(createRelayHandler()));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("returns 200 audio/mpeg for the same request", async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: TEXT, voice: VOICE }),
        signal: AbortSignal.timeout(20_000),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("audio/mpeg");
      const audio = new Uint8Array(await res.arrayBuffer());
      expect(audio.byteLength).toBeGreaterThan(1024);
      expect(looksLikeMp3(audio)).toBe(true);
    });
  });

  it("lists every voice in the Edge catalog", async () => {
    const major = EDGE_WS_HEADERS["User-Agent"]!.match(/Edg\/(\d+)/)![1];
    // Mirrors edge-tts 7.3.1 `list_voices` (VOICE_HEADERS + MUID cookie + Sec-MS-GEC).
    const res = await fetch(
      `${VOICE_LIST_URL}&Sec-MS-GEC=${createSecMsGecGenerator()()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
      {
        headers: {
          "User-Agent": EDGE_WS_HEADERS["User-Agent"]!,
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-CH-UA": `" Not;A Brand";v="99", "Microsoft Edge";v="${major}", "Chromium";v="${major}"`,
          "Sec-CH-UA-Mobile": "?0",
          Accept: "*/*",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    expect(res.status).toBe(200);
    const live = new Set(((await res.json()) as { ShortName: string }[]).map((v) => v.ShortName));
    const catalog = listVoices("edge").map((v) => v.id);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.filter((id) => !live.has(id))).toEqual([]);
  });
});
