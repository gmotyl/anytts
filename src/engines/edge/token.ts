/**
 * Sec-MS-GEC v2 — the DRM token Microsoft Edge's read-aloud TTS endpoint
 * requires on every request since ~2026-10-10.
 *
 * Self-contained: no imports, no platform APIs; golden vectors from Python
 * edge-tts 7.3.1 pin the output.
 *
 * A faithful port of rany2/edge-tts 7.3.1 `edge_tts/drm.py`
 * (`generate_sec_ms_gec_v2`). The token is `<CS64 16 hex>-<SHA256 64 hex>`,
 * where the "SHA256" resumes from a fixed mid-block state with its own
 * constants — so WebCrypto's `crypto.subtle.digest` cannot compute it and
 * everything here is plain 32-bit integer arithmetic.
 *
 * v1 sent the plain SHA-256 hex of the same input with
 * `Sec-MS-GEC-Version: 1-<chromium>`; v2 must be paired with
 * {@link SEC_MS_GEC_VERSION}.
 */

/** The fixed client token Edge ships; part of the hashed input. */
export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/** Chromium build edge-tts 7.3.1 impersonates. */
export const CHROMIUM_FULL_VERSION = "143.0.3650.75";

/** `Sec-MS-GEC-Version` value for v2 tokens (v1 used the `1-` prefix). */
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

/** Seconds between 1601-01-01 (Windows epoch) and 1970-01-01. */
const WIN_EPOCH = 11644473600;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4,
  0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
/** Round constants for the resumed first block: K[14] is swapped out. */
const SHA256_BLOCK_K = SHA256_K.map((k, i) => (i === 14 ? SHA256_ADJUSTMENT : k));
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

/** [coefficient, offset] pairs seeding the CS64 term/offset lists. */
const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

/** 32-bit unsigned multiply (low 32 bits of the product). */
const mul = (a: number, b: number): number => Math.imul(a, b) >>> 0;
const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;
const rol16 = (x: number): number => ((x << 16) | (x >>> 16)) >>> 0;
const sigma0 = (x: number): number => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const sigma1 = (x: number): number => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;

function expandSchedule(w: number[], first: number): void {
  for (let i = first; i < 64; i++) {
    w.push((sigma1(w[i - 2]!) + w[i - 7]! + sigma0(w[i - 15]!) + w[i - 16]!) >>> 0);
  }
}

/** SHA-256 compression rounds `first..63`; returns the working registers. */
function rounds(state: readonly number[], w: readonly number[], first: number): number[] {
  const k = first === 14 ? SHA256_BLOCK_K : SHA256_K;
  let [a, b, c, d, e, f, g, h] = state as [
    number, number, number, number, number, number, number, number,
  ];
  for (let i = first; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = g ^ (e & (f ^ g));
    const t1 = (h + (s1 >>> 0) + (ch >>> 0) + k[i]! + w[i]!) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) | (c & (a | b));
    const t2 = ((s0 >>> 0) + (maj >>> 0)) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

/** The state after the fixed-prefix block, seeded by the first 7 data bytes. */
function initialState(data: Uint8Array): number[] {
  const w: number[] = new Array(14).fill(0);
  w.push(((data[0]! << 16) | (data[1]! << 8) | data[2]!) >>> 0);
  w.push(((data[3]! << 24) | (data[4]! << 16) | (data[5]! << 8) | data[6]!) >>> 0);
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16]!;
    if (i - 2 >= 14) {
      value += i === 16 ? (sigma1(w[i - 2]!) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : sigma1(w[i - 2]!);
    }
    if (i - 7 >= 14) value += w[i - 7]!;
    if (i - 15 >= 14) {
      value += i === 29 ? (sigma0(w[i - 15]!) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : sigma0(w[i - 15]!);
    }
    w.push(value >>> 0);
  }
  w.push(
    (sigma1(w[28]!) + w[23]! + sigma0(w[15]!) + w[14]! + SHA256_ADJUSTMENT - SHA256_K[14]!) >>> 0,
  );
  expandSchedule(w, 31);
  const working = rounds(SHA256_STATE, w, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]!) >>> 0);
}

/** The modified SHA-256 digest of `data` (at least 7 bytes), as 32 bytes. */
function sha256Digest(data: Uint8Array): Uint8Array {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  const tail = data.length - 7;
  const padLen = (((55 - length) % 64) + 64) % 64;
  const total = tail + 1 + padLen + 8;
  const padded = new Uint8Array(total);
  padded.set(data.subarray(7), 0);
  padded[tail] = 0x80;
  // Bit length as a big-endian u64; the high word is 0 for any realistic input.
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  view.setUint32(total - 4, bits >>> 0);

  let state = initialState(data);
  for (let offset = 0; offset < total; offset += 64) {
    const w: number[] = [];
    for (let j = 0; j < 16; j++) w.push(view.getUint32(offset + j * 4));
    expandSchedule(w, 16);
    const working = rounds(state, w, 0);
    state = state.map((x, i) => (x + working[i]!) >>> 0);
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  state.forEach((x, i) => outView.setUint32(i * 4, x));
  return out;
}

/** Little-endian u32 words of `data`, zero-padded to an even word count. */
function wordsLe4Even(data: Uint8Array): number[] {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const view = new DataView(padded.buffer);
  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 4) words.push(view.getUint32(i, true));
  if (words.length % 2) words.push(0);
  return words;
}

/** The two CS64 words keyed by the first 8 digest bytes. */
function cs64Digest(data: Uint8Array, digest: Uint8Array): [number, number] {
  const dv = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = (dv.getUint32(0, true) | 1) >>> 0;
  const keyB = (dv.getUint32(4, true) | 1) >>> 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coefficient], i) => mul(coefficient, factors[i % 2]!));
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);

  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  wordsLe4Even(prefixed).forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = (term + mul(CS64_ADJUSTMENT0, factors[0]!)) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  });

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i]!;
    const y = terms[i + 1]!;
    let t = rol16((offsets[i]! + x) >>> 0);
    let q = mul(t, 0x76f50f34);
    swapAcc = (swapAcc + ((mul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[i + 1]! + y) >>> 0);
    q = mul(t, 0x1881ce3c);
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul(state, keyA) + x) >>> 0;
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;
    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/**
 * Windows file-time ticks (100 ns) for `unixSeconds`, floored to its 5-minute
 * window, as the decimal string the token hashes. BigInt keeps the ~1.3e17
 * product exact, matching Python's `f"{ticks:.0f}"`.
 */
export function secMsGecTicks(unixSeconds: number): string {
  let seconds = unixSeconds + WIN_EPOCH;
  seconds -= seconds % 300;
  return (BigInt(Math.round(seconds)) * 10_000_000n).toString();
}

/**
 * The v2 Sec-MS-GEC token for a moment in time.
 *
 * Pure: the clock is the argument. Pass `Date.now() / 1000` (plus any server
 * clock-skew correction) for a live request; tokens are stable within each
 * 5-minute window.
 */
export function generateSecMsGecV2(unixSeconds: number): string {
  const input = `${secMsGecTicks(unixSeconds)}${TRUSTED_CLIENT_TOKEN}`;
  const data = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) data[i] = input.charCodeAt(i);
  const digest = sha256Digest(data);
  const [lo, hi] = cs64Digest(data, digest);
  const cs64 = new Uint8Array(8);
  const cv = new DataView(cs64.buffer);
  cv.setUint32(0, lo, true);
  cv.setUint32(4, hi, true);
  return `${hex(cs64)}-${hex(digest)}`;
}

/** A clock in Unix seconds; injectable so callers and tests control time. */
export type UnixClock = () => number;

/** Wall-clock default for {@link createSecMsGecGenerator}. */
const systemClock: UnixClock = () => Date.now() / 1000;

/**
 * Binds {@link generateSecMsGecV2} to a clock, for callers that want a
 * zero-argument generator (`() => token`). `offsetSeconds` is the server
 * clock-skew correction (server time minus local time), added to every read.
 */
export function createSecMsGecGenerator(
  clock: UnixClock = systemClock,
  offsetSeconds = 0,
): () => string {
  return () => generateSecMsGecV2(clock() + offsetSeconds);
}
