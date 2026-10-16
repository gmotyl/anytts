import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsError } from "../../../errors.js";
import { createEdgeEngine } from "../engine.js";
import { generateSecMsGecV2 } from "../token.js";
import type { Transport, TransportHooks } from "../transport.js";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls++;
    this.readyState = 3;
  }
  get listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  // Server-side helpers.
  serverOpen(): void {
    this.readyState = 1;
    this.emit("open");
  }
  serverSend(data: unknown): void {
    this.emit("message", { data });
  }
  serverError(): void {
    this.emit("error");
  }
  serverClose(): void {
    this.readyState = 3;
    this.emit("close");
  }
  /** Still usable from the server's point of view: neither closed by us nor by the server. */
  get open(): boolean {
    return this.readyState !== 3;
  }
}

interface Opened {
  url: string;
  socket: FakeSocket;
  hooks: TransportHooks | undefined;
}

function fakeTransport(onOpen: (o: Opened, index: number) => void = () => {}) {
  const opened: Opened[] = [];
  const transport: Transport = {
    open(url, _headers, hooks) {
      const o: Opened = { url, socket: new FakeSocket(), hooks };
      opened.push(o);
      onOpen(o, opened.length - 1);
      return o.socket as unknown as WebSocket;
    },
  };
  return { transport, opened };
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

function metadataFrame(word: string, offset: number): string {
  return (
    "X-RequestId:abc\r\nContent-Type:application/json; charset=utf-8\r\nPath:audio.metadata\r\n\r\n" +
    JSON.stringify({
      Metadata: [
        {
          Type: "WordBoundary",
          Data: { Offset: offset, Duration: 3000000, text: { Text: word, Length: word.length, BoundaryType: "WordBoundary" } },
        },
      ],
    })
  );
}

const TURN_END = "X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}";
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const VOICE = "pl-PL-MarekNeural";

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function expectKind(error: unknown, kind: string): TtsError {
  expect(error).toBeInstanceOf(TtsError);
  expect((error as TtsError).kind).toBe(kind);
  return error as TtsError;
}

describe("createEdgeEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const engineWith = (transport: Transport) =>
    createEdgeEngine({ transport, firstByteMs: 1000, stallMs: 500, now: () => NOW });

  it("resolves concatenated audio on turn end", async () => {
    const { transport, opened } = fakeTransport();
    const promise = engineWith(transport).synthesize("Cześć", VOICE, new AbortController().signal);
    const { socket, url } = opened[0]!;
    expect(url).toMatch(
      /^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=[0-9a-f]{32}&Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}&Sec-MS-GEC-Version=2-143\.0\.3650\.75$/,
    );
    socket.serverOpen();
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).toContain("Path:speech.config");
    expect(socket.sent[1]).toContain("Path:ssml");
    expect(socket.sent[1]).toContain(VOICE);

    socket.serverSend("X-RequestId:abc\r\nPath:turn.start\r\n\r\n{}");
    socket.serverSend(audioFrame([1, 2]));
    // Non-audio binary frames and the empty trailing frame are skipped.
    const empty = new Uint8Array([0, 0]);
    socket.serverSend(empty.buffer);
    socket.serverSend(audioFrame([3]));
    socket.serverSend(TURN_END);

    const { value } = await settle(promise);
    expect(Array.from(new Uint8Array(value!))).toEqual([1, 2, 3]);
    expect(socket.open).toBe(false);
  });

  it("403 settles as rejected within the deadline", async () => {
    const { transport, opened } = fakeTransport(({ socket, hooks }) => {
      // Mimics undici: response observed, then an error event, and never a close event.
      setTimeout(() => {
        hooks?.onUnexpectedResponse?.(403, new Headers());
        socket.serverError();
      }, 50);
    });
    const promise = settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    await vi.advanceTimersByTimeAsync(100);
    const { error } = await promise;
    const err = expectKind(error, "rejected");
    expect(err.status).toBe(403);
    expect(opened).toHaveLength(1);
    expect(opened.every((o) => !o.socket.open)).toBe(true);
    expect(opened[0]!.socket.listenerCount).toBe(0);
  });

  it("word-boundary metadata frames between audio frames are not audio", async () => {
    const { transport, opened } = fakeTransport();
    const promise = engineWith(transport).synthesize("Hello world", VOICE, new AbortController().signal);
    const { socket } = opened[0]!;
    socket.serverOpen();
    socket.serverSend("X-RequestId:abc\r\nPath:turn.start\r\n\r\n{}");
    socket.serverSend("X-RequestId:abc\r\nPath:response\r\n\r\n{}");
    socket.serverSend(metadataFrame("Hello", 1000000));
    socket.serverSend(audioFrame([1, 2]));
    socket.serverSend(metadataFrame("world", 5000000));
    socket.serverSend(audioFrame([3]));
    socket.serverSend(TURN_END);

    const { value, error } = await settle(promise);
    expect(error).toBeUndefined();
    expect(Array.from(new Uint8Array(value!))).toEqual([1, 2, 3]);
    expect(opened).toHaveLength(1);
  });

  it("close after open with no audio retries once on a fresh connection", async () => {
    const { transport, opened } = fakeTransport();
    const promise = settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    opened[0]!.socket.serverOpen();
    opened[0]!.socket.serverClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toHaveLength(2);
    const { socket } = opened[1]!;
    socket.serverOpen();
    socket.serverSend(audioFrame([7]));
    socket.serverSend(TURN_END);
    const { value } = await promise;
    expect(Array.from(new Uint8Array(value!))).toEqual([7]);
  });

  it("close before audio twice is rejected after one retry", async () => {
    const { transport, opened } = fakeTransport();
    const promise = settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    opened[0]!.socket.serverOpen();
    opened[0]!.socket.serverClose();
    await vi.advanceTimersByTimeAsync(0);
    opened[1]!.socket.serverOpen();
    opened[1]!.socket.serverClose();
    const { error } = await promise;
    expectKind(error, "rejected");
    expect(opened).toHaveLength(2);
  });

  it("no first byte times out and closes the socket", async () => {
    const { transport, opened } = fakeTransport();
    const promise = settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    opened[0]!.socket.serverOpen();
    await vi.advanceTimersByTimeAsync(999);
    expect(opened[0]!.socket.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await promise;
    expectKind(error, "first-byte-timeout");
    expect(opened[0]!.socket.closeCalls).toBe(1);
  });

  it("a gap between chunks stalls and closes the socket", async () => {
    const { transport, opened } = fakeTransport();
    const promise = settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    const { socket } = opened[0]!;
    socket.serverOpen();
    socket.serverSend(audioFrame([1]));
    await vi.advanceTimersByTimeAsync(400);
    socket.serverSend(audioFrame([2]));
    await vi.advanceTimersByTimeAsync(499);
    expect(socket.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await promise;
    expectKind(error, "stalled");
    expect(socket.closeCalls).toBe(1);
  });

  it("turn end without audio is no-audio", async () => {
    const { transport, opened } = fakeTransport();
    const promise = settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    opened[0]!.socket.serverOpen();
    opened[0]!.socket.serverSend(TURN_END);
    const { error } = await promise;
    expectKind(error, "no-audio");
    expect(opened[0]!.socket.open).toBe(false);
  });

  it("socket error mid-audio is network", async () => {
    const { transport, opened } = fakeTransport();
    const promise = settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    const { socket } = opened[0]!;
    socket.serverOpen();
    socket.serverSend(audioFrame([1]));
    socket.serverError();
    const { error } = await promise;
    expectKind(error, "network");
    expect(socket.open).toBe(false);
  });

  it("connect error without a response is network", async () => {
    const { transport, opened } = fakeTransport(({ socket, hooks }) => {
      // Mimics undici on ECONNREFUSED/DNS failure: no response, then an error event.
      queueMicrotask(() => {
        hooks?.onConnectError?.(new Error("connect ECONNREFUSED"));
        socket.serverError();
      });
    });
    const { error } = await settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    const err = expectKind(error, "network");
    expect(err.cause).toBeInstanceOf(Error);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.socket.listenerCount).toBe(0);
  });

  it("error before open without a signal stays rejected", async () => {
    const { transport } = fakeTransport(({ socket }) => {
      queueMicrotask(() => socket.serverError());
    });
    const { error } = await settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    expectKind(error, "rejected");
  });

  it("a transport that throws on open rejects network", async () => {
    const cause = new Error("bad url");
    const transport: Transport = {
      open() {
        throw cause;
      },
    };
    const { error } = await settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    const err = expectKind(error, "network");
    expect(err.cause).toBe(cause);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort closes the socket", async () => {
    const { transport, opened } = fakeTransport();
    const controller = new AbortController();
    const promise = settle(engineWith(transport).synthesize("x", VOICE, controller.signal));
    const { socket } = opened[0]!;
    socket.serverOpen();
    socket.serverSend(audioFrame([1]));
    controller.abort();
    const { error } = await promise;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(socket.closeCalls).toBe(1);
    expect(socket.listenerCount).toBe(0);
  });

  it("a rejection with a Date header corrects clock skew once", async () => {
    // The server is 20 minutes ahead of the local clock.
    const serverMs = NOW + 20 * 60_000;
    const { transport, opened } = fakeTransport(({ socket, hooks }, index) => {
      if (index === 0) {
        queueMicrotask(() => {
          hooks?.onUnexpectedResponse?.(403, new Headers({ Date: new Date(serverMs).toUTCString() }));
          socket.serverError();
        });
        return;
      }
      queueMicrotask(() => {
        socket.serverOpen();
        socket.serverSend(audioFrame([7]));
        socket.serverSend(TURN_END);
      });
    });
    const { value } = await settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    expect(Array.from(new Uint8Array(value!))).toEqual([7]);
    expect(opened).toHaveLength(2);
    const gec = (url: string) => new URL(url).searchParams.get("Sec-MS-GEC");
    expect(gec(opened[0]!.url)).toBe(generateSecMsGecV2(NOW / 1000));
    expect(gec(opened[1]!.url)).toBe(generateSecMsGecV2(serverMs / 1000));
    expect(gec(opened[1]!.url)).not.toBe(gec(opened[0]!.url));
  });

  it("a second rejection after skew correction is final", async () => {
    const { transport, opened } = fakeTransport(({ socket, hooks }) => {
      queueMicrotask(() => {
        hooks?.onUnexpectedResponse?.(403, new Headers({ Date: new Date(NOW + 3_600_000).toUTCString() }));
        socket.serverError();
      });
    });
    const { error } = await settle(engineWith(transport).synthesize("x", VOICE, new AbortController().signal));
    expect(expectKind(error, "rejected").status).toBe(403);
    expect(opened).toHaveLength(2);
    expect(opened.every((o) => !o.socket.open)).toBe(true);
  });

  it("node runtime is always direct", async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { transport, opened } = fakeTransport();
      const engine = createEdgeEngine({
        transport,
        relayUrl: "https://app.test/api/tts",
        mode: "relay",
        now: () => NOW,
      });
      const promise = engine.synthesize("x", VOICE, new AbortController().signal);
      expect(opened).toHaveLength(1);
      const { socket, url } = opened[0]!;
      expect(url).toMatch(/^wss:\/\//);
      socket.serverOpen();
      socket.serverSend(audioFrame([5, 6]));
      socket.serverSend(TURN_END);
      const { value } = await settle(promise);
      expect(Array.from(new Uint8Array(value!))).toEqual([5, 6]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
