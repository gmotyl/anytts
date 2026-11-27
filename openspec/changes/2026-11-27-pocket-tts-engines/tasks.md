# Pocket TTS engines (anytts) Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Add the engines `pocket` and `pocket-pl`. They synthesize through `pocket-tts serve` and
return MP3.

**Architecture:**
- One factory, `createPocketEngine`, in `src/engines/pocket/` builds both ids.
- It reuses `keyedFetch` and `refusalError` from `src/engines/keyed.ts` for the HTTP call.
- A pure WAV-to-PCM parser and a lazily imported lamejs encoder turn the reply into MP3.
- The engines are registered in the registry, the Node factories and the relay catalogs, the same
  way `kokoro` is.

**Tech Stack:** TypeScript, Node 20+ `fetch` and `FormData`, `@breezystack/lamejs` 1.2.7
(LGPL-3.0), vitest.

**Design:** the pavilio design for this change, `projects/pavilio/plans/openspec/changes/2026-11-27-pocket-tts-engines/design.md`
in the workspace repo (§ anytts), and this change's [proposal](proposal.md) and
[spec](specs/pocket-engine/spec.md).

**Repo:** `/srv/git/prv/anytts-pocket-engine` (branch `feat/pocket-engine`). Run `pnpm install`
first if `node_modules` is missing. The test command is `pnpm test`; the typecheck is `pnpm lint`.

---

### Task 1: WAV decoding and MP3 encoding

**Files:**
- Create: `src/engines/pocket/audio.ts` (`pcmFromWav`, `encodeMp3`)
- Modify: `package.json` (dependency `@breezystack/lamejs@1.2.7`)
- Test: `src/engines/pocket/__tests__/audio.test.ts`

**Contract:**
```ts
export interface Pcm { samples: Int16Array; sampleRate: number; channels: number }
export function pcmFromWav(bytes: ArrayBuffer): Pcm;           // throws TtsError("no-audio")
export async function encodeMp3(pcm: Pcm, kbps?: number): Promise<Uint8Array>; // default 64
```

**Acceptance criteria:**
- WHEN the header declares a `data` size of 2,000,000,000 and 96,000 bytes follow THEN 48,000
  samples are returned at 24,000 Hz, mono.
- WHEN 96,001 bytes follow THEN the odd trailing byte is dropped.
- WHEN a `LIST` chunk sits between `fmt ` and `data` THEN it is skipped.
- WHEN no bytes follow the `data` header, or the bytes are not RIFF/WAVE THEN `TtsError` with kind
  `no-audio` is thrown.
- WHEN the format is not 16-bit PCM THEN `no-audio` is thrown and names the format.
- WHEN `encodeMp3` encodes 1 s of a 24 kHz sine THEN the output starts with an MP3 frame sync
  (`0xFF`, then `0xE0` masked) and is under 10 KB.
- WHEN the module is imported THEN lamejs is not yet imported (it is loaded with `await import()`
  inside `encodeMp3`).

**Tests (names only — red first):**
- "pcmFromWav ignores placeholder RIFF and data sizes"
- "pcmFromWav drops an odd trailing byte"
- "pcmFromWav skips chunks before data"
- "pcmFromWav rejects an empty or non-WAV body as no-audio"
- "pcmFromWav rejects non-16-bit PCM"
- "encodeMp3 returns MP3 frames for 24 kHz mono"
- "importing audio.ts does not load lamejs"

- [ ] **Step 1: Write the failing tests** — Run: `pnpm test -- src/engines/pocket/__tests__/audio.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** (add the dependency with `pnpm add @breezystack/lamejs@1.2.7`) — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git add package.json pnpm-lock.yaml src/engines/pocket && git commit -m "feat(pocket): WAV decoding and MP3 encoding"`

### Task 2: Pocket voice catalogs

**Files:**
- Create: `src/engines/pocket/voices.ts` (`POCKET_PRESETS`, `POCKET_PL_PRESETS`, `pocketCatalog`)
- Test: `src/engines/pocket/__tests__/voices.test.ts`

**Contract:**
```ts
export interface PocketVoice { id: string; label: string; gender?: "female" | "male"; version: number }
export function pocketCatalog(id: "pocket" | "pocket-pl", customVoices?: readonly PocketVoice[]): VoiceInfo[];
```

**Acceptance criteria:**
- WHEN `pocketCatalog("pocket")` is called THEN it returns the 27 presets named in the spec, each
  with locale `en-US` and `multilingual: false`, `alba` first.
- WHEN `pocketCatalog("pocket-pl")` is called THEN it returns `shefowl` ("Polski (wzorzec)") with
  locale `pl-PL`.
- WHEN caller voices are given THEN they are appended with the engine's locale (`piotr` on `pocket`
  is `en-US`, and on `pocket-pl` is `pl-PL`).
- WHEN a caller voice has a preset's id THEN `pocketCatalog` throws `RangeError`.

**Tests (names only — red first):**
- "pocket lists the 27 English presets"
- "pocket-pl lists the shefowl reference"
- "caller voices take the engine's locale"
- "a caller voice may not shadow a preset"

- [ ] **Step 1: Write the failing tests** — Run: `pnpm test -- src/engines/pocket/__tests__/voices.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git add src/engines/pocket && git commit -m "feat(pocket): preset and caller voice catalogs"`

### Task 3: The pocket engine

**Files:**
- Create: `src/engines/pocket/engine.ts` (`createPocketEngine`, `PocketEngineOptions`)
- Test: `src/engines/pocket/__tests__/engine.test.ts`

**Contract:**
```ts
export interface PocketEngineOptions {
  baseUrl: string;            // required, http(s)
  voiceFilesUrl?: string;     // required when customVoices is non-empty
  customVoices?: readonly PocketVoice[];
  firstByteMs?: number;       // default 30000
  stallMs?: number;
  fetch?: typeof fetch;
}
export function createPocketEngine(id: "pocket" | "pocket-pl", options: PocketEngineOptions): Engine & {
  keyed: false; strictVoiceMap: true; defaults: { voices: VoiceMap; maxConcurrent: number };
};
```

**Acceptance criteria:**
- WHEN `pocket` synthesizes `"Hello"` with `alba` THEN one `POST {baseUrl}/tts` is sent with a
  `FormData` holding exactly `text=Hello` and `voice_url=alba`, and MP3 bytes are returned.
- WHEN a caller voice `piotr` (version `1764245000000`) is used THEN `voice_url` is
  `{voiceFilesUrl}/piotr/sample.wav?v=1764245000000`, with the id URI-encoded.
- WHEN `pocket-pl` synthesizes with `shefowl` or with no voice THEN the form has no `voice_url`.
- WHEN a request carries `lang` THEN no language field is sent.
- WHEN `baseUrl` is missing or not http(s), or `customVoices` is non-empty without `voiceFilesUrl` THEN
  the factory throws `RangeError`.
- WHEN the server answers 500 with a body containing `voice cloning` or `predefined voices` THEN it
  rejects `unknown-voice`; any other 5xx rejects `network`; a 4xx rejects `rejected`.
- WHEN the defaults are read THEN `maxConcurrent` is 1 and the voice map default is `alba`
  (`pocket`) or `shefowl` (`pocket-pl`).

**Tests (names only — red first):**
- "sends text and a preset voice_url as multipart"
- "builds the voice-file URL for a caller voice"
- "pocket-pl's reference voice sends no voice_url"
- "never sends the language"
- "refuses a bad baseUrl and caller voices without voiceFilesUrl"
- "maps the cloning and predefined-voice 500s to unknown-voice"
- "maps other refusals like the keyed engines"
- "returns MP3 decoded from the WAV reply"

- [ ] **Step 1: Write the failing tests** (injected `fetch`, WAV fixtures from Task 1's helpers) — Run: `pnpm test -- src/engines/pocket/__tests__/engine.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git add src/engines/pocket && git commit -m "feat(pocket): pocket and pocket-pl engines"`

### Task 4: Registration (registry, Node factories, relay catalogs)

**Files:**
- Modify: `src/engines/registry.ts` (`ENGINES`)
- Modify: `src/server/index.ts` (`NODE_ENGINES`, type exports `PocketEngineOptions`, `PocketVoice`)
- Modify: `src/engines/relayEngine.ts` (`CATALOGS`)
- Test: `src/engines/__tests__/registry.test.ts`, `src/engines/__tests__/relayEngine.test.ts`, `src/server/__tests__/createTts.test.ts`

**Acceptance criteria:**
- WHEN `listEngines()` is read THEN it has `pocket` "Pocket TTS (English)" and `pocket-pl`
  "Pocket TTS (Polish)", runtimes `node`.
- WHEN `listVoices("pocket")` is read THEN it returns the 27 presets.
- WHEN a Node `createTts` gets `engines: { pocket: { baseUrl }, "pocket-pl": { baseUrl } }` THEN
  both synthesize through the factory from Task 3.
- WHEN a browser `createTts` gets `engines: { pocket: { relayUrl: "/api/tts" } }` THEN synthesis POSTs
  the relay with `engine: "pocket"`.
- WHEN a cascade lists `pocket` with no `baseUrl` configured THEN it is skipped as not configured,
  as `kokoro` is.

**Tests (names only — red first):**
- "registry lists both pocket engines"
- "node createTts builds pocket engines"
- "browser pocket is a relay client"
- "a cascade skips an unconfigured pocket"

- [ ] **Step 1: Write the failing tests** — Run: `pnpm test` — Expected: FAIL (new tests only)
- [ ] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [ ] **Step 3: Commit** — `git add src && git commit -m "feat(pocket): register pocket engines"`

### Task 5: README, version bump, live check

**Verification: non-testable** — Run: `pnpm build && pnpm test && pnpm lint` — Expected: all green.
Then run one live synthesis against a real `pocket-tts serve` (the spike venv at
`/tmp/claude-1001/-srv-git-prv-projects/<session>/scratchpad/pocket-spike`, or the installer's)
from a small script that imports `dist/server/index.js`. Expected: an MP3 file that ffprobe reads.

**Acceptance criteria:**
- WHEN the README is read THEN it documents `pocket`/`pocket-pl` (options, presets, voice-file URL
  rule, required server `pocket-tts serve`) and states that `@breezystack/lamejs` is LGPL-3.0 and
  is loaded only by the pocket engines.
- WHEN `package.json` is read THEN the version is bumped one minor step over 0.7.0.

- [ ] **Step 1: README and version** — Run: `pnpm build && pnpm test && pnpm lint` — Expected: PASS
- [ ] **Step 2: Live check** — Run: the script above — Expected: an MP3 that `ffprobe` reads with the right duration
- [ ] **Step 3: Commit** — `git add README.md package.json && git commit -m "chore: release pocket engines"`; then push the branch, open the PR against `gmotyl/anytts:main`, and publish to npm after merge (needed by pavilio Task 1)
