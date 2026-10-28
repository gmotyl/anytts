import { afterEach, describe, expect, it, vi } from "vitest";
import { EDGE_VOICE_MAP } from "../engines/edge/voices.js";
import { ELEVENLABS_VOICE_MAP } from "../engines/elevenlabs/voices.js";
import { createTts, type SynthesisRequest, type TtsEvent } from "../tts.js";

const RELAY = "https://relay.test/tts";
const scheduler = { concurrency: 2, tiers: [{ name: "play" }] };
const MAREK = "pl-PL-MarekNeural";
const ZOFIA = "pl-PL-ZofiaNeural";

/** A relay whose cascade answers with edge and the voice the body asked of it (else Marek). */
function stubRelay() {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { engine: string; voice?: string; voices?: Record<string, string> };
    const [engine, voice] = body.engine === "cascade" ? ["edge", body.voices?.edge ?? MAREK] : [body.engine, body.voice!];
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "audio/mpeg", "x-anytts-engine": engine, "x-anytts-voice": voice },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function browserTts(cacheMax?: number) {
  return createTts({
    engines: { cascade: { relayUrl: RELAY }, elevenlabs: { relayUrl: RELAY }, edge: { voices: EDGE_VOICE_MAP } },
    defaultEngine: "cascade",
    scheduler,
    ...(cacheMax !== undefined ? { cache: { max: cacheMax } } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cascade alias", () => {
  it("the alias is ready after a relay answer", async () => {
    const fetchMock = stubRelay();
    const tts = browserTts();
    const events: TtsEvent[] = [];
    tts.subscribe((e) => events.push(e));
    const req: SynthesisRequest = { text: "Cześć", lang: "pl", voices: { edge: MAREK } };
    expect(tts.state(req)).toBe("cold");
    expect(tts.isCached(req)).toBe(false);
    const pending = tts.synthesize(req);
    expect(tts.state(req)).toBe("pending");
    await pending;
    expect(tts.state(req)).toBe("ready");
    expect(tts.isCached(req)).toBe(true);
    // Every option form that means the same request reads the same alias.
    expect(tts.state({ text: "Cześć", lang: "pl", voices: { edge: MAREK }, pronunciation: {} })).toBe("ready");
    // Cached under the member key too: a direct edge request for the same unit is a hit.
    const direct: SynthesisRequest = { engine: "edge", text: "Cześć", lang: "pl", voice: MAREK };
    expect(tts.state(direct)).toBe("ready");
    expect(await tts.synthesize(direct)).toMatchObject({ engine: "edge", voice: MAREK });
    // A repeat cascade request answers from the alias, with the member that spoke.
    expect(await tts.synthesize(req)).toMatchObject({ engine: "edge", voice: MAREK });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(["pending", "add", "add"]);
  });

  it("changing a member voice misses the alias", async () => {
    const fetchMock = stubRelay();
    const tts = browserTts();
    await tts.synthesize({ text: "Cześć", lang: "pl", voices: { edge: MAREK } });
    const changed: SynthesisRequest = { text: "Cześć", lang: "pl", voices: { edge: ZOFIA } };
    expect(tts.state(changed)).toBe("cold");
    expect(tts.isCached(changed)).toBe(false);
    // `order` and `pronunciation` are part of the alias too.
    expect(tts.state({ text: "Cześć", lang: "pl", voices: { edge: MAREK }, order: ["edge"] })).toBe("cold");
    expect(tts.state({ text: "Cześć", lang: "pl", voices: { edge: MAREK }, pronunciation: { edge: false } })).toBe("cold");
    expect(await tts.synthesize(changed)).toMatchObject({ engine: "edge", voice: ZOFIA });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a relay answer never overwrites a different answer's member entry", async () => {
    // The relay's edge speaks the text as written unless the request turns its pronunciation on;
    // the browser's edge has it on. Both answers rebuild the same member key in the browser.
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { engine: string; voice?: string; pronunciation?: Record<string, boolean> };
      const bytes = body.pronunciation?.edge === true ? [2] : [1];
      const [engine, voice] = body.engine === "cascade" ? ["edge", MAREK] : [body.engine, body.voice!];
      return new Response(new Uint8Array(bytes), {
        headers: { "content-type": "audio/mpeg", "x-anytts-engine": engine, "x-anytts-voice": voice },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tts = createTts({
      engines: { cascade: { relayUrl: RELAY }, elevenlabs: { relayUrl: RELAY }, edge: { voices: EDGE_VOICE_MAP } },
      defaultEngine: "cascade",
      scheduler,
      // Two entries: the member entry and the alias-only one (aliases do not count).
      cache: { max: 2 },
      pronunciation: { pl: { pavilio: "pawilio" } },
    });
    const plain: SynthesisRequest = { text: "pavilio", lang: "pl" };
    const respelled: SynthesisRequest = { text: "pavilio", lang: "pl", pronunciation: { edge: true } };
    expect(new Uint8Array((await tts.synthesize(plain)).bytes)).toEqual(new Uint8Array([1]));
    expect(new Uint8Array((await tts.synthesize(respelled)).bytes)).toEqual(new Uint8Array([2]));
    // The alias-only entry reads as ready, like an alias of a member entry.
    expect(tts.state(respelled)).toBe("ready");
    expect(tts.isCached(respelled)).toBe(true);
    expect(tts.state(plain)).toBe("ready");
    // Each alias still answers with its own relay answer, from the cache.
    expect(new Uint8Array((await tts.synthesize(plain)).bytes)).toEqual(new Uint8Array([1]));
    expect(new Uint8Array((await tts.synthesize(respelled)).bytes)).toEqual(new Uint8Array([2]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Another unit pushes the least recently used member entry out; the alias-only entry stays.
    await tts.synthesize({ engine: "elevenlabs", text: "Hej", lang: "pl", voice: ELEVENLABS_VOICE_MAP.pl! });
    expect(tts.state(plain)).toBe("cold");
    expect(tts.state(respelled)).toBe("ready");
    expect(tts.isCached(respelled)).toBe(true);
    expect(new Uint8Array((await tts.synthesize(respelled)).bytes)).toEqual(new Uint8Array([2]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("evicting the member drops the alias", async () => {
    stubRelay();
    const tts = browserTts(1);
    const events: TtsEvent[] = [];
    tts.subscribe((e) => events.push(e));
    const req: SynthesisRequest = { text: "Cześć", lang: "pl" };
    await tts.synthesize(req);
    expect(tts.state(req)).toBe("ready");
    const [member, alias] = events.filter((e) => e.type === "add").map((e) => e.key);
    // Another unit pushes the member entry out of a one-entry cache.
    await tts.synthesize({ engine: "elevenlabs", text: "Hej", lang: "pl", voice: ELEVENLABS_VOICE_MAP.pl! });
    expect(tts.state(req)).toBe("cold");
    expect(tts.isCached(req)).toBe(false);
    expect(events.filter((e) => e.type === "evict").map((e) => e.key)).toEqual([member, alias]);
  });
});
