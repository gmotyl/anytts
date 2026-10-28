import { describe, expect, it } from "vitest";
import type { Engine, VoiceInfo } from "../engine.js";
import { createTts } from "../tts.js";

const voice = (id: string): VoiceInfo => ({ id, label: id, locale: id.slice(0, 5), gender: "male", multilingual: false });

interface Call {
  text: string;
  resolve: (bytes: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}

/** An engine whose calls the test settles by hand; aborting a call rejects it. */
function fakeEngine(id: string) {
  const calls: Call[] = [];
  const engine: Engine = {
    id,
    voices: [voice("en-US-AvaNeural")],
    synthesize(text, _voice, signal) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        calls.push({ text, resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
  };
  return { engine, calls };
}

const bytes = () => new Uint8Array([1]).buffer;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const azure = fakeEngine("azure");
  const edge = fakeEngine("edge");
  const tts = createTts(
    {
      engines: {
        azure: { voices: { default: "en-US-AvaNeural" }, maxConcurrent: 1 },
        edge: { voices: { default: "en-US-AvaNeural" } },
      },
      defaultEngine: "edge",
      scheduler: { concurrency: 4, tiers: [{ name: "play" }, { name: "warm" }] },
    },
    { engineFactories: { azure: () => azure.engine, edge: () => edge.engine } },
  );
  return { tts, azure, edge };
}

describe("engine slots", () => {
  it("azure runs one at a time", async () => {
    const { tts, azure } = setup();
    const first = tts.synthesize({ text: "a", engine: "azure", tier: "warm" });
    const second = tts.synthesize({ text: "b", engine: "azure", tier: "warm" });
    const urgent = tts.synthesize({ text: "c", engine: "azure", tier: "play" });
    await flush();
    expect(azure.calls.map((c) => c.text)).toEqual(["a"]);

    azure.calls[0]!.resolve(bytes());
    await first;
    await flush();
    // The waiting play job keeps its tier priority over the older warm one.
    expect(azure.calls.map((c) => c.text)).toEqual(["a", "c"]);

    azure.calls[1]!.resolve(bytes());
    await urgent;
    await flush();
    expect(azure.calls.map((c) => c.text)).toEqual(["a", "c", "b"]);
    azure.calls[2]!.resolve(bytes());
    await second;
  });

  it("a busy engine does not block another", async () => {
    const { tts, azure, edge } = setup();
    const a = tts.synthesize({ text: "a", engine: "azure" });
    const b = tts.synthesize({ text: "b", engine: "azure" });
    const e = tts.synthesize({ text: "e", engine: "edge" });
    await flush();
    expect(azure.calls.map((c) => c.text)).toEqual(["a"]);
    expect(edge.calls.map((c) => c.text)).toEqual(["e"]);

    edge.calls[0]!.resolve(bytes());
    azure.calls[0]!.resolve(bytes());
    await Promise.all([a, e]);
    await flush();
    azure.calls[1]!.resolve(bytes());
    await b;
  });

  it("an aborted waiter releases nothing it never held", async () => {
    const { tts, azure } = setup();
    const running = tts.synthesize({ text: "a", engine: "azure" });
    const controller = new AbortController();
    const waiter = tts.synthesize({ text: "b", engine: "azure", signal: controller.signal });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    expect(tts.state({ text: "b", engine: "azure" })).toBe("cold");

    // The slot is still held by the running job: a newcomer waits.
    const next = tts.synthesize({ text: "c", engine: "azure" });
    const last = tts.synthesize({ text: "d", engine: "azure" });
    await flush();
    expect(azure.calls.map((c) => c.text)).toEqual(["a"]);

    azure.calls[0]!.resolve(bytes());
    await running;
    await flush();
    // The aborted job never ran, and one slot still means one at a time.
    expect(azure.calls.map((c) => c.text)).toEqual(["a", "c"]);
    azure.calls[1]!.resolve(bytes());
    await next;
    await flush();
    expect(azure.calls.map((c) => c.text)).toEqual(["a", "c", "d"]);
    azure.calls[2]!.resolve(bytes());
    await last;
  });

  it("a rejected engine call releases its slot", async () => {
    const { tts, azure } = setup();
    const failing = tts.synthesize({ text: "a", engine: "azure" });
    const next = tts.synthesize({ text: "b", engine: "azure" });
    await flush();
    expect(azure.calls.map((c) => c.text)).toEqual(["a"]);

    azure.calls[0]!.reject(new Error("boom"));
    await expect(failing).rejects.toThrow("boom");
    await flush();
    // The failed job gave its slot back: the waiting job starts.
    expect(azure.calls.map((c) => c.text)).toEqual(["a", "b"]);
    azure.calls[1]!.resolve(bytes());
    await next;
  });

  it("a job aborted mid-run releases its slot", async () => {
    const { tts, azure } = setup();
    const controller = new AbortController();
    const running = tts.synthesize({ text: "a", engine: "azure", signal: controller.signal });
    const next = tts.synthesize({ text: "b", engine: "azure" });
    await flush();
    expect(azure.calls.map((c) => c.text)).toEqual(["a"]);

    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    // The aborted engine call settled and gave its slot back: the waiting job starts.
    expect(azure.calls.map((c) => c.text)).toEqual(["a", "b"]);
    azure.calls[1]!.resolve(bytes());
    await next;
  });
});
