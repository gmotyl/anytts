import { describe, expect, it, vi } from "vitest";
import type { Engine } from "../../engine.js";
import { TtsError } from "../../errors.js";
import { EDGE_VOICES } from "../../engines/edge/voices.js";
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
