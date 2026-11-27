import { TtsError } from "../../errors.js";

export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

const tag = (view: DataView, at: number): string =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/**
 * Decodes a 16-bit PCM WAV. Streaming servers write placeholder RIFF/data sizes, so the `data`
 * chunk is taken to run to the end of the buffer rather than trusting the declared size.
 */
export function pcmFromWav(bytes: ArrayBuffer): Pcm {
  const view = new DataView(bytes);
  if (view.byteLength < 12 || tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE") {
    throw new TtsError("no-audio", "response is not a RIFF/WAVE file");
  }
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let sawFmt = false;
  let at = 12;
  while (at + 8 <= view.byteLength) {
    const id = tag(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (body + 16 > view.byteLength) break;
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      sawFmt = true;
    } else if (id === "data") {
      if (!sawFmt) throw new TtsError("no-audio", "WAV data chunk precedes the fmt chunk");
      if (format !== 1 || bits !== 16) {
        throw new TtsError("no-audio", `unsupported WAV format ${format} (${bits}-bit), expected 16-bit PCM`);
      }
      const length = (view.byteLength - body) & ~1;
      if (length <= 0) throw new TtsError("no-audio", "WAV contains no audio data");
      const samples = new Int16Array(length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { samples, sampleRate, channels };
    }
    at = body + size + (size & 1);
  }
  throw new TtsError("no-audio", "WAV has no data chunk");
}

/** Encodes PCM as MP3. lamejs is loaded lazily so importing this module stays cheap. */
export async function encodeMp3(pcm: Pcm, kbps = 64): Promise<Uint8Array> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const channels = pcm.channels === 2 ? 2 : 1;
  const encoder = new Mp3Encoder(channels, pcm.sampleRate, kbps);
  const block = 1152;
  const chunks: Uint8Array[] = [];
  const frames = Math.floor(pcm.samples.length / channels);
  for (let i = 0; i < frames; i += block) {
    const n = Math.min(block, frames - i);
    let out: Uint8Array;
    if (channels === 2) {
      const left = new Int16Array(n);
      const right = new Int16Array(n);
      for (let j = 0; j < n; j++) {
        left[j] = pcm.samples[(i + j) * 2]!;
        right[j] = pcm.samples[(i + j) * 2 + 1]!;
      }
      out = encoder.encodeBuffer(left, right);
    } else {
      out = encoder.encodeBuffer(pcm.samples.subarray(i, i + n));
    }
    if (out.length) chunks.push(out);
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const mp3 = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    mp3.set(c, off);
    off += c.length;
  }
  return mp3;
}
