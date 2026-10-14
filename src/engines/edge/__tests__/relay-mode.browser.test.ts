import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsError } from "../../../errors.js";
import { createTts } from "../../../tts.js";
import { createEdgeEngine, type EdgeEngineOptions } from "../engine.js";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  speak(bytes: number[]): void {
    this.readyState = 1;
    this.emit("open");
    this.emit("message", { data: audioFrame(bytes) });
    this.emit("message", { data: TURN_END });
  }
  /** A refused handshake as a browser sees it: error then close, no status. */
  refuse(): void {
    this.readyState = 3;
    this.emit("error");
    this.emit("close");
  }
}

function audioFrame(bytes: number[]): ArrayBuffer {
  const header = new TextEncoder().encode("X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n");
  const out = new Uint8Array(2 + header.length + bytes.length);
  out[0] = header.length >> 8;
  out[1] = header.length & 0xff;
  out.set(header, 2);
  out.set(bytes, 2 + header.length);
  return out.buffer;
}

const TURN_END = "X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}";
const VOICE = "pl-PL-MarekNeural";
const RELAY = "https://app.test/api/tts";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const audioResponse = (bytes: number[]) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } });

function setUserAgent(ua: string): void {
  vi.stubGlobal("navigator", { userAgent: ua });
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function expectKind(error: unknown, kind: string): void {
  expect(error).toBeInstanceOf(TtsError);
  expect((error as TtsError).kind).toBe(kind);
}

const engineWith = (options: EdgeEngineOptions = {}) =>
  createEdgeEngine({ relayUrl: RELAY, firstByteMs: 1000, stallMs: 500, ...options });

const signal = () => new AbortController().signal;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("edge engine direct/relay mode (browser)", () => {
  it("auto in Edge goes direct", async () => {
    setUserAgent(EDGE_UA);
    const promise = engineWith().synthesize("Cześć", VOICE, signal());
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0]!.speak([1, 2, 3]);

    expect(new Uint8Array(await promise)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto in Chrome goes through the relay", async () => {
    setUserAgent(CHROME_UA);
    fetchMock.mockResolvedValue(audioResponse([4, 5]));

    const bytes = await engineWith().synthesize("Cześć", VOICE, signal());

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([4, 5]));
    expect(FakeSocket.instances).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELAY);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Cześć", voice: VOICE });
  });

  it("auto switches to relay after a direct rejection", async () => {
    setUserAgent(EDGE_UA);
    fetchMock.mockImplementation(async () => audioResponse([9]));
    const engine = engineWith();

    const first = engine.synthesize("one", VOICE, signal());
    FakeSocket.instances[0]!.refuse();
    expect(new Uint8Array(await first)).toEqual(new Uint8Array([9]));

    const second = await engine.synthesize("two", VOICE, signal());
    expect(new Uint8Array(second)).toEqual(new Uint8Array([9]));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("relay error kinds are rehydrated", async () => {
    setUserAgent(CHROME_UA);
    const engine = engineWith();

    fetchMock.mockResolvedValueOnce(Response.json({ kind: "stalled" }, { status: 502 }));
    const stalled = await settle(engine.synthesize("a", VOICE, signal()));
    expectKind(stalled.error, "stalled");
    expect((stalled.error as TtsError).status).toBe(502);

    fetchMock.mockResolvedValueOnce(Response.json({ kind: "unknown-voice" }, { status: 400 }));
    expectKind((await settle(engine.synthesize("a", VOICE, signal()))).error, "unknown-voice");

    // Validation answers carry no kind: client errors are final, server errors transient.
    fetchMock.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    expectKind((await settle(engine.synthesize("a", VOICE, signal()))).error, "rejected");
    fetchMock.mockResolvedValueOnce(Response.json({ error: "too long" }, { status: 413 }));
    expectKind((await settle(engine.synthesize("a", VOICE, signal()))).error, "rejected");
    fetchMock.mockResolvedValueOnce(Response.json({ error: "synthesis failed" }, { status: 502 }));
    expectKind((await settle(engine.synthesize("a", VOICE, signal()))).error, "network");
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 500 }));
    expectKind((await settle(engine.synthesize("a", VOICE, signal()))).error, "network");

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expectKind((await settle(engine.synthesize("a", VOICE, signal()))).error, "network");

    fetchMock.mockResolvedValueOnce(audioResponse([]));
    expectKind((await settle(engine.synthesize("a", VOICE, signal()))).error, "no-audio");
  });

  it("relay deadlines map to first-byte-timeout and stalled", async () => {
    vi.useFakeTimers();
    setUserAgent(CHROME_UA);
    const engine = engineWith();

    // No headers within firstByteMs; the fetch honours its abort signal.
    let fetchSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          fetchSignal = init.signal!;
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const first = settle(engine.synthesize("a", VOICE, signal()));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectKind((await first).error, "first-byte-timeout");
    expect(fetchSignal!.aborted).toBe(true);

    // Headers arrive, one chunk, then silence for stallMs.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    const second = settle(engine.synthesize("b", VOICE, signal()));
    await vi.advanceTimersByTimeAsync(400);
    controller.enqueue(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(400);
    controller.enqueue(new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(499);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectKind((await second).error, "stalled");
    expect(cancelled).toBe(true);
  });

  it("direct and relay share engine id and cache key", async () => {
    const run = async (ua: string) => {
      setUserAgent(ua);
      const tts = createTts({
        engines: { edge: { voices: { default: VOICE }, relayUrl: RELAY, retries: 0 } },
        defaultEngine: "edge",
        scheduler: { concurrency: 1, tiers: [{ name: "play" }] },
      });
      const keys: string[] = [];
      tts.subscribe((e) => keys.push(e.key));
      const promise = tts.synthesize({ text: "Cześć" });
      await Promise.resolve();
      FakeSocket.instances.at(-1)?.speak([7]);
      const result = await promise;
      return { engine: result.engine, keys };
    };

    fetchMock.mockResolvedValue(audioResponse([7]));
    const direct = await run(EDGE_UA);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const relayed = await run(CHROME_UA);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);

    expect(direct.engine).toBe("edge");
    expect(relayed.engine).toBe("edge");
    expect(direct.keys).toHaveLength(1);
    expect(relayed.keys).toEqual(direct.keys);
  });
});
