import { describe, expect, it } from "vitest";
import { TtsError } from "../../../errors.js";
import { encodeMp3, pcmFromWav } from "../audio.js";
import { buildWav, pcmBytes } from "./wav.js";

const noAudio = (fn: () => unknown): TtsError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TtsError);
    expect((e as TtsError).kind).toBe("no-audio");
    return e as TtsError;
  }
  throw new Error("expected a throw");
};

describe("pcmFromWav", () => {
  it("ignores placeholder RIFF and data sizes", () => {
    const wav = buildWav(new Uint8Array(96_000), { riffSize: 0xffffffff, dataSize: 2_000_000_000 });
    const pcm = pcmFromWav(wav);
    expect(pcm.samples.length).toBe(48_000);
    expect(pcm.sampleRate).toBe(24_000);
    expect(pcm.channels).toBe(1);
  });

  it("drops an odd trailing byte", () => {
    const pcm = pcmFromWav(buildWav(new Uint8Array(96_001)));
    expect(pcm.samples.length).toBe(48_000);
  });

  it("skips chunks before data", () => {
    const wav = buildWav(pcmBytes([1, -2, 3]), {
      extraChunks: [{ id: "LIST", payload: new Uint8Array([1, 2, 3, 4, 5]) }],
    });
    expect([...pcmFromWav(wav).samples]).toEqual([1, -2, 3]);
  });

  it("pcmFromWav rejects a data chunk with less than one sample", () => {
    noAudio(() => pcmFromWav(buildWav(new Uint8Array(1))));
  });

  it("rejects an empty or non-WAV body as no-audio", () => {
    noAudio(() => pcmFromWav(buildWav(new Uint8Array(0))));
    noAudio(() => pcmFromWav(new TextEncoder().encode("not a wav file at all, sorry").buffer));
    noAudio(() => pcmFromWav(new ArrayBuffer(0)));
  });

  it("rejects non-16-bit PCM", () => {
    const err = noAudio(() => pcmFromWav(buildWav(new Uint8Array(8), { format: 3, bitsPerSample: 32 })));
    expect(err.message).toMatch(/format 3/);
    expect(err.message).toMatch(/32-bit/);
  });
});

describe("encodeMp3", () => {
  it("returns MP3 frames for 24 kHz mono", async () => {
    const samples = new Int16Array(24_000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000));
    const mp3 = await encodeMp3({ samples, sampleRate: 24_000, channels: 1 });
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1]! & 0xe0).toBe(0xe0);
    expect(mp3.length).toBeLessThan(10_000);
  });
});

describe("module loading", () => {
  it("importing audio.ts does not load lamejs", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../audio.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import[^()]*from\s+["']@breezystack\/lamejs["']/m);
    expect(src).toMatch(/await import\(\s*["']@breezystack\/lamejs["']\s*\)/);
  });
});
