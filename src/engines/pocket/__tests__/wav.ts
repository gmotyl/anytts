export interface WavOptions {
  sampleRate?: number;
  channels?: number;
  /** Format tag, 1 = PCM. */
  format?: number;
  bitsPerSample?: number;
  /** Value written into the RIFF size field. */
  riffSize?: number;
  /** Value written into the data size field. */
  dataSize?: number;
  /** Extra chunks (id + payload) placed between `fmt ` and `data`. */
  extraChunks?: Array<{ id: string; payload: Uint8Array }>;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Builds a WAV file; `body` is the raw bytes after the `data` header. */
export function buildWav(body: Uint8Array, opts: WavOptions = {}): ArrayBuffer {
  const sampleRate = opts.sampleRate ?? 24000;
  const channels = opts.channels ?? 1;
  const bits = opts.bitsPerSample ?? 16;
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer);
  const u16 = (n: number) => new Uint8Array(new Uint16Array([n]).buffer);
  parts.push(
    new Uint8Array(ascii("RIFF")),
    u32(opts.riffSize ?? 36 + body.length),
    new Uint8Array(ascii("WAVE")),
    new Uint8Array(ascii("fmt ")),
    u32(16),
    u16(opts.format ?? 1),
    u16(channels),
    u32(sampleRate),
    u32((sampleRate * channels * bits) / 8),
    u16((channels * bits) / 8),
    u16(bits),
  );
  for (const c of opts.extraChunks ?? []) {
    parts.push(new Uint8Array(ascii(c.id)), u32(c.payload.length), c.payload);
    if (c.payload.length % 2) parts.push(new Uint8Array(1));
  }
  parts.push(new Uint8Array(ascii("data")), u32(opts.dataSize ?? body.length), body);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

/** Little-endian 16-bit bytes for the given samples. */
export function pcmBytes(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}
