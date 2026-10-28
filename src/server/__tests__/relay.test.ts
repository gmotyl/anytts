import { describe, expect, it, vi } from "vitest";
import type { Engine } from "../../engine.js";
import { TtsError } from "../../errors.js";
import { EDGE_VOICES } from "../../engines/edge/voices.js";
import { createTts, type Tts, type TtsConfig } from "../../tts.js";
import { createRelayHandlerWith } from "../relay.js";

const VOICE = EDGE_VOICES[0]!.id;
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

function fakeEngine(impl?: Engine["synthesize"]) {
  const synthesize = vi.fn<Engine["synthesize"]>(impl ?? (async () => AUDIO.slice().buffer));
  const engine: Engine = { id: "edge", voices: EDGE_VOICES, synthesize };
  return { engine, synthesize };
}

const post = (body: unknown) =>
  new Request("http://relay.test/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("createRelayHandler", () => {
  it("relays audio for a valid request", async () => {
    const { engine, synthesize } = fakeEngine();
    const res = await createRelayHandlerWith(engine)(post({ text: "Hello", voice: VOICE }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(AUDIO);
    expect(synthesize).toHaveBeenCalledWith("Hello", VOICE, expect.any(AbortSignal));
  });

  it("rejects an unknown voice without calling the engine", async () => {
    const { engine, synthesize } = fakeEngine();
    const res = await createRelayHandlerWith(engine)(post({ text: "Hello", voice: "xx-XX-NopeNeural" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ kind: "unknown-voice" });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("rejects text over maxChars", async () => {
    const { engine, synthesize } = fakeEngine();
    const handler = createRelayHandlerWith(engine, { maxChars: 5 });
    expect((await handler(post({ text: "12345", voice: VOICE }))).status).toBe(200);
    const res = await handler(post({ text: "123456", voice: VOICE }));
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(synthesize).toHaveBeenCalledTimes(1);

    // Default limit is 2000.
    const byDefault = createRelayHandlerWith(engine);
    expect((await byDefault(post({ text: "a".repeat(2001), voice: VOICE }))).status).toBe(413);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("authorize false refuses", async () => {
    const { engine, synthesize } = fakeEngine();
    const authorize = vi.fn(async (req: Request) => req.headers.get("x-key") === "ok");
    const res = await createRelayHandlerWith(engine, { authorize })(post({ text: "Hello", voice: VOICE }));
    expect(res.status).toBe(403);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("engine failure becomes 502 with its kind", async () => {
    const { engine } = fakeEngine(async () => {
      throw new TtsError("stalled");
    });
    const res = await createRelayHandlerWith(engine)(post({ text: "Hello", voice: VOICE }));
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ kind: "stalled" });
  });

  it("rejects malformed requests with 400 or 405", async () => {
    const { engine, synthesize } = fakeEngine();
    const handler = createRelayHandlerWith(engine);
    expect((await handler(new Request("http://relay.test/", { method: "GET" }))).status).toBe(405);
    const notJson = new Request("http://relay.test/", { method: "POST", body: "{nope" });
    expect((await handler(notJson)).status).toBe(400);
    expect((await handler(post({ text: 1, voice: VOICE }))).status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before parsing it", async () => {
    const { engine, synthesize } = fakeEngine();
    const handler = createRelayHandlerWith(engine, { maxChars: 10 });

    // Declared too large: answered from the header alone, body untouched.
    const declared = new Request("http://relay.test/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100000" },
      body: JSON.stringify({ text: "Hi", voice: VOICE }),
    });
    const res = await handler(declared);
    expect(res.status).toBe(413);
    expect(declared.bodyUsed).toBe(false);

    // Undeclared (streamed) and too large: reading stops at the cap.
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const streamed = new Request("http://relay.test/api/tts", {
      method: "POST",
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect((await handler(streamed)).status).toBe(413);
    expect(pulls).toBeLessThan(10);
    expect(synthesize).not.toHaveBeenCalled();

    // A body within the cap still works.
    expect((await handler(post({ text: "1234567890", voice: VOICE }))).status).toBe(200);

    // Valid JSON escaping every character (6 bytes each) at maxChars still fits.
    const escaped = createRelayHandlerWith(engine, { maxChars: 2000 });
    const body = `{"text":"${"\\u0105".repeat(2000)}","voice":${JSON.stringify(VOICE)}}`;
    const wide = new Request("http://relay.test/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect((await escaped(wide)).status).toBe(200);
  });
});

/** A keyed member whose next calls answer, or reject with what `fail` returns. */
function fakeKeyed(id: string) {
  let fail: (() => unknown) | undefined;
  const synthesize = vi.fn<Engine["synthesize"]>(async () => {
    if (fail) throw fail();
    return new Uint8Array([7, 7]).buffer;
  });
  const engine: Engine = {
    id,
    keyed: true,
    voices: [{ id: `${id}-pl`, label: id, locale: "pl-PL", gender: "male", multilingual: false }],
    synthesize,
  };
  return {
    engine,
    synthesize,
    fail(next: (() => unknown) | undefined) {
      fail = next;
    },
  };
}

/** ElevenLabs and Azure fakes (with keys) behind a cascade `elevenlabs → azure`. */
function keyedSetup() {
  const elevenlabs = fakeKeyed("elevenlabs");
  const azure = fakeKeyed("azure");
  const config: TtsConfig = {
    engines: {
      elevenlabs: { apiKey: "k", voices: { pl: "elevenlabs-pl" } },
      azure: { apiKey: "k", voices: { pl: "azure-pl" } },
      cascade: { order: ["elevenlabs", "azure"] },
    },
    defaultEngine: "cascade",
    scheduler: { concurrency: 4, tiers: [{ name: "play" }] },
  };
  const engineFactories = { elevenlabs: () => elevenlabs.engine, azure: () => azure.engine };
  const build = (c: TtsConfig): Tts => createTts(c, { engineFactories });
  return { elevenlabs, azure, config, build, tts: build(config) };
}

describe("relay serves every engine", () => {
  it("a request without engine stays on edge", async () => {
    const { engine, synthesize } = fakeEngine();
    const { tts, elevenlabs } = keyedSetup();
    const res = await createRelayHandlerWith(engine, { tts })(post({ text: "Hello", voice: VOICE }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-anytts-engine")).toBe("edge");
    expect(res.headers.get("x-anytts-voice")).toBe(VOICE);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(AUDIO);
    expect(synthesize).toHaveBeenCalledWith("Hello", VOICE, expect.any(AbortSignal));
    expect(elevenlabs.synthesize).not.toHaveBeenCalled();
  });

  it("a keyed engine through the relay", async () => {
    const { engine, synthesize } = fakeEngine();
    const { elevenlabs, config, build, tts } = keyedSetup();
    // A Tts instance is used as-is; a TtsConfig is built with the given factory.
    for (const handler of [
      createRelayHandlerWith(engine, { tts }),
      createRelayHandlerWith(engine, { tts: config }, build),
    ]) {
      const res = await handler(post({ engine: "elevenlabs", text: "Cześć", voice: "elevenlabs-pl" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/mpeg");
      expect(res.headers.get("x-anytts-engine")).toBe("elevenlabs");
      expect(res.headers.get("x-anytts-voice")).toBe("elevenlabs-pl");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 7]));
    }
    expect(elevenlabs.synthesize).toHaveBeenCalledTimes(2);
    expect(elevenlabs.synthesize).toHaveBeenCalledWith("Cześć", "elevenlabs-pl", expect.any(AbortSignal), expect.anything());
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("a cascade request names the member that spoke", async () => {
    const { engine } = fakeEngine();
    const { elevenlabs, azure, tts } = keyedSetup();
    elevenlabs.fail(() => new TtsError("quota-exhausted"));
    const res = await createRelayHandlerWith(engine, { tts })(post({ engine: "cascade", text: "Cześć", lang: "pl" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anytts-engine")).toBe("azure");
    expect(res.headers.get("x-anytts-voice")).toBe("azure-pl");
    expect(azure.synthesize).toHaveBeenCalledTimes(1);
  });

  it("unknown engine answers unknown-voice", async () => {
    const { engine, synthesize } = fakeEngine();
    const { elevenlabs, azure, tts } = keyedSetup();
    const withTts = createRelayHandlerWith(engine, { tts });
    const without = createRelayHandlerWith(engine);
    const cases: [typeof withTts, unknown][] = [
      [withTts, { engine: "cartesia", text: "Hi", voice: "x" }],
      [withTts, { engine: "elevenlabs", text: "Hi", voice: "azure-pl" }],
      [withTts, { engine: "cascade", text: "Hi", lang: "pl", voices: { azure: "nope" } }],
      [without, { engine: "elevenlabs", text: "Hi", voice: "elevenlabs-pl" }],
      [without, { engine: "cascade", text: "Hi", lang: "pl" }],
    ];
    for (const [handler, body] of cases) {
      const res = await handler(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ kind: "unknown-voice" });
    }
    expect(elevenlabs.synthesize).not.toHaveBeenCalled();
    expect(azure.synthesize).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("rate-limited carries Retry-After", async () => {
    const { engine } = fakeEngine();
    const { elevenlabs, tts } = keyedSetup();
    elevenlabs.fail(() => new TtsError("rate-limited", "slow down", { status: 429, retryAfter: 42 }));
    const res = await createRelayHandlerWith(engine, { tts })(post({ engine: "elevenlabs", text: "Hi", voice: "elevenlabs-pl" }));
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toEqual({ kind: "rate-limited", retryAfter: 42 });

    // Other kinds carry neither.
    elevenlabs.fail(() => new TtsError("unauthorized"));
    const other = await createRelayHandlerWith(engine, { tts })(post({ engine: "elevenlabs", text: "Ho", voice: "elevenlabs-pl" }));
    expect(other.status).toBe(502);
    expect(other.headers.get("retry-after")).toBeNull();
    expect(await other.json()).toEqual({ kind: "unauthorized" });
  });

  it("a shared instance reports the relay's skip windows", async () => {
    const { engine } = fakeEngine();
    const { elevenlabs, tts } = keyedSetup();
    expect(tts.engineStatus("elevenlabs")).toEqual({ state: "ready" });
    elevenlabs.fail(() => new TtsError("rate-limited", "slow down", { status: 429, retryAfter: 30 }));
    const res = await createRelayHandlerWith(engine, { tts })(post({ engine: "cascade", text: "Cześć", lang: "pl" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anytts-engine")).toBe("azure");
    expect(tts.engineStatus("elevenlabs")).toMatchObject({ state: "rate-limited", until: expect.any(String) });
    expect(tts.engineStatus("azure")).toEqual({ state: "ready" });
  });

  it("no authorization hook serves the request", async () => {
    const { engine } = fakeEngine();
    const { tts } = keyedSetup();
    const open = createRelayHandlerWith(engine, { tts });
    expect((await open(post({ engine: "elevenlabs", text: "Hi", voice: "elevenlabs-pl" }))).status).toBe(200);
    expect((await open(post({ text: "Hi", voice: VOICE }))).status).toBe(200);

    const guarded = createRelayHandlerWith(engine, { tts, authorize: async () => false });
    expect((await guarded(post({ engine: "elevenlabs", text: "Hi", voice: "elevenlabs-pl" }))).status).toBe(403);
    expect((await guarded(post({ engine: "cascade", text: "Hi", lang: "pl" }))).status).toBe(403);
  });
});
