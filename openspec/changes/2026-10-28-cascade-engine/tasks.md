# Cascade engine Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Four keyed engines (ElevenLabs, Cartesia, Speechify, Azure F0) and a `cascade` engine that tries engines in a user-set order and falls back on quota, auth and rate-limit refusals, served to browsers through the Relay.

**Architecture:** Keyed engines are ordinary `Engine`s registered only by `anytts/server`; `cascade` is a walk inside `Tts` over member engines with in-memory skip windows, per-engine slots and member-key cache lookups. The library applies the Pronunciation map per engine after the member is picked. The Relay accepts an `engine` field and a shared `Tts` instance; in the browser keyed engines and `cascade` are relay clients that also cache under a cascade alias.

**Tech Stack:** TypeScript ESM, vitest (projects `node`, `jsdom`, `package`), no runtime dependencies.

**Design:** [design.md](./design.md)

Run tests with `corepack pnpm exec vitest run <file>`; the full gate is `corepack pnpm test && corepack pnpm lint`.

---

### Task 1: Error kinds for refusals

**Files:**
- Modify: `src/errors.ts` (`TtsErrorKind`, `TtsError`, `TtsErrorOptions`)
- Test: `src/__tests__/errors.test.ts`

**Contract:**
```ts
type TtsErrorKind = /* existing */ | "quota-exhausted" | "unauthorized" | "rate-limited";
interface TtsErrorOptions { status?: number; cause?: unknown; retryAfter?: number /* seconds */ }
class TtsError { readonly retryAfter?: number }
```

**Acceptance criteria:**
- WHEN a `TtsError("rate-limited", …, { retryAfter: 30 })` is built THEN `retryAfter === 30`
- WHEN `isTransient` is asked about `quota-exhausted`, `unauthorized` or `rate-limited` THEN it answers `false`

**Tests (names only — red first):**
- "rate-limited carries retryAfter"
- "refusal kinds are not transient"

- [x] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/__tests__/errors.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [x] **Step 3: Commit** — `git add src/errors.ts src/__tests__/errors.test.ts && git commit -m "feat(errors): quota-exhausted, unauthorized, rate-limited kinds"`

### Task 2: Per-engine pronunciation inside the library

**Files:**
- Modify: `src/tts.ts` (`EngineConfig`, `TtsConfig`, request resolution / cache key building)
- Test: `src/__tests__/tts.pronunciation.test.ts`

**Contract:**
```ts
type EngineConfig = { voices?: Record<string,string> & { default?: string }; retries?: number;
  pronunciation?: boolean; maxConcurrent?: number } & Record<string, unknown>;
interface TtsConfig { /* existing */ pronunciation?: Record<string, PronunciationMap> }
```

**Acceptance criteria:**
- WHEN `edge` synthesizes `lang: "pl"` with `pronunciation` unset THEN the engine receives the text respelled by the `pl` preset (+ `config.pronunciation.pl` entries)
- WHEN an engine with `pronunciation: false` synthesizes `lang: "pl"` THEN it receives the text as written
- WHEN a request has no `lang` THEN no map is applied on any engine
- WHEN the same text is synthesized on `edge` with pronunciation on and off THEN two distinct cache entries exist (key built on the prepared text)

**Tests (names only — red first):**
- "edge gets the pl preset by default"
- "an engine with pronunciation off speaks the text as written"
- "no lang, no map"
- "pronunciation on and off do not share an entry"

- [x] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/__tests__/tts.pronunciation.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: same, then `corepack pnpm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -am "feat(tts): apply the Pronunciation map per engine"`

### Task 3: Engine slots (`maxConcurrent`)

**Files:**
- Modify: `src/scheduler.ts` (`createScheduler`, `ScheduledJob`), `src/tts.ts` (attempt start)
- Test: `src/__tests__/scheduler.slots.test.ts`

**Acceptance criteria:**
- WHEN two jobs target an engine with `maxConcurrent: 1` THEN the second attempt starts only after the first settles, and keeps its tier priority while waiting
- WHEN engine A is full THEN a job for engine B still starts
- WHEN a waiting job is aborted THEN it leaves the queue and holds no slot

**Tests (names only — red first):**
- "azure runs one at a time"
- "a busy engine does not block another"
- "an aborted waiter releases nothing it never held"

- [x] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/__tests__/scheduler.slots.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: same, then `corepack pnpm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -am "feat(scheduler): per-engine slots"`

### Task 4: Keyed engine base + ElevenLabs

**Files:**
- Create: `src/engines/keyed.ts` (shared fetch, MP3 accept, `onFirstByte` on first body chunk, status → `TtsError` mapping helpers)
- Create: `src/engines/elevenlabs/engine.ts`, `src/engines/elevenlabs/voices.ts`
- Test: `src/engines/elevenlabs/__tests__/engine.test.ts` (+ fixtures in `__tests__/fixtures/`)

**Acceptance criteria:**
- WHEN the implementer starts THEN they read ElevenLabs' current TTS API docs and record the endpoint, MP3 output parameter and the quota / auth / 429 response shapes as fixtures (source URL in a fixture comment)
- WHEN synthesis succeeds THEN the result is the MP3 body and `onFirstByte` fired once
- WHEN the response is 401 with `quota_exceeded` THEN `quota-exhausted`; any other 401 THEN `unauthorized`; 429 THEN `rate-limited` with `retryAfter` from `Retry-After`; any other refusal THEN `rejected`
- WHEN the engine has no `apiKey` THEN `synthesize` rejects `unauthorized` without a request
- WHEN `signal` aborts THEN the fetch aborts and the call rejects `AbortError`
- WHEN `voices` is unset THEN built-in `pl`/`en`/`default` stock voices are used

**Tests (names only — red first):**
- "elevenlabs returns mp3 and fires onFirstByte"
- "quota_exceeded maps to quota-exhausted"
- "other 401 maps to unauthorized"
- "429 maps to rate-limited with retryAfter"
- "unknown refusal maps to rejected"
- "missing key rejects without a request"
- "abort cancels the fetch"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/engines/elevenlabs` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git add src/engines && git commit -m "feat(engines): keyed engine base and ElevenLabs"`

### Task 5: Cartesia engine

**Files:**
- Create: `src/engines/cartesia/engine.ts`, `src/engines/cartesia/voices.ts`
- Test: `src/engines/cartesia/__tests__/engine.test.ts`

**Acceptance criteria:** as Task 4, with Cartesia's documented quota refusal mapped to `quota-exhausted` (docs + fixtures recorded first), MP3 container requested, default `maxConcurrent` 2.

**Tests (names only — red first):**
- "cartesia returns mp3 and fires onFirstByte"
- "exhausted credits map to quota-exhausted"
- "bad key maps to unauthorized"
- "429 maps to rate-limited with retryAfter"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/engines/cartesia` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git add src/engines/cartesia && git commit -m "feat(engines): Cartesia"`

### Task 6: Speechify engine

**Files:**
- Create: `src/engines/speechify/engine.ts`, `src/engines/speechify/voices.ts`
- Test: `src/engines/speechify/__tests__/engine.test.ts`

**Acceptance criteria:** as Task 4, with Speechify's documented quota refusal mapped to `quota-exhausted` (docs + fixtures first), MP3 requested, a `pl-PL` stock voice in the default map, default `maxConcurrent` 2.

**Tests (names only — red first):**
- "speechify returns mp3 and fires onFirstByte"
- "exhausted quota maps to quota-exhausted"
- "bad key maps to unauthorized"
- "429 maps to rate-limited with retryAfter"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/engines/speechify` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git add src/engines/speechify && git commit -m "feat(engines): Speechify"`

### Task 7: Azure F0 engine

**Files:**
- Create: `src/engines/azure/engine.ts`, `src/engines/azure/voices.ts`
- Test: `src/engines/azure/__tests__/engine.test.ts`

**Acceptance criteria:**
- WHEN configured with `apiKey` but no `region` THEN `createTts` throws `RangeError`
- WHEN synthesizing THEN the request goes to the region's endpoint with an MP3 output format and SSML naming the voice
- WHEN Azure answers 429 THEN `rate-limited` (`retryAfter` from `Retry-After`, else unset); 401/403 THEN `unauthorized`
- WHEN `maxConcurrent` is unset THEN it is 1

**Tests (names only — red first):**
- "azure requires a region"
- "azure posts ssml to the region endpoint and returns mp3"
- "429 maps to rate-limited"
- "401 maps to unauthorized"
- "azure defaults to one slot"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/engines/azure` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git add src/engines/azure && git commit -m "feat(engines): Azure F0"`

### Task 8: Registration, catalogs and entry points

**Files:**
- Modify: `src/engines/registry.ts` (`ENGINES`, `listEngines`, `listVoices`), `src/tts.ts` (`BUILTIN_ENGINES` → browser-safe set), `src/server/index.ts` (registers keyed factories)
- Test: `src/engines/__tests__/registry.test.ts`, `test/` package-entry test (existing `package` project)

**Acceptance criteria:**
- WHEN `listEngines()` is called THEN it lists `edge`, the four keyed engines (`runtimes: ["node"]`) and `cascade` (`runtimes: ["browser", "node"]`)
- WHEN `listVoices("cascade")` THEN `[]`; WHEN `listVoices("azure")` THEN its stock catalog
- WHEN the built `anytts` (main) entry is bundled THEN it contains no keyed engine module; `anytts/server` registers them

**Tests (names only — red first):**
- "lists keyed engines and cascade with runtimes"
- "cascade has no catalog"
- "main entry ships no keyed engine code"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/engines/__tests__/registry.test.ts && corepack pnpm test` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git commit -am "feat: register keyed engines from anytts/server"`

### Task 9: The cascade walk

**Files:**
- Create: `src/cascade.ts`
- Modify: `src/tts.ts` (`SynthesisRequest`, `synthesize` / `state` / `isCached` routing for `cascade`, config validation)
- Test: `src/__tests__/cascade.test.ts`

**Contract:**
```ts
interface SynthesisRequest { /* existing */ voices?: Record<string, string>;
  order?: string[]; pronunciation?: Record<string, boolean> }
// engines.cascade: { order: string[] }
```

**Acceptance criteria:**
- WHEN the first member has a key and succeeds THEN the result names that member and its voice
- WHEN a member has no `apiKey` THEN it is skipped without a request
- WHEN `voices` names a member's voice THEN that member uses it; otherwise its Voice map by `lang`
- WHEN `order` is given THEN only those members, in that order, are tried; non-members dropped; an empty effective order rejects `RangeError`
- WHEN `pronunciation` overrides a member THEN that member's prepared text follows the override
- WHEN a later member's key is cached and an earlier one's is not THEN the cached result answers without a request (lookups walk member keys first)
- WHEN a member's slots are full THEN the cascade waits for it rather than moving on
- WHEN `order` names an unknown engine or `cascade`, or `cascade` has `voices` THEN `createTts` throws `RangeError`
- WHEN a cascade request has `voice` THEN it rejects `unknown-voice`
- WHEN a member fails transiently after its retries THEN the next member is tried; WHEN it fails `unknown-voice` or the request aborts THEN the cascade stops

**Tests (names only — red first):**
- "the first member speaks"
- "a member without a key is skipped"
- "per-request voices"
- "per-request order"
- "per-request pronunciation"
- "a cached member answers first"
- "a busy member is waited for"
- "invalid configuration throws"
- "a single voice is refused"
- "transient failure moves on without a window"
- "unknown voice does not switch"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/__tests__/cascade.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same, then `corepack pnpm test` — Expected: PASS
- [ ] **Step 3: Commit** — `git add src && git commit -m "feat: cascade engine"`

### Task 10: Skip windows and `engineStatus`

**Files:**
- Modify: `src/cascade.ts`, `src/tts.ts` (`Tts.engineStatus`)
- Test: `src/__tests__/cascade.skip.test.ts`

**Contract:**
```ts
engineStatus(id: string): { state: "ready" | "no-key" | "quota-exhausted" | "rate-limited" | "unauthorized"; until?: string }
```

**Acceptance criteria:**
- WHEN a member rejects `quota-exhausted` on 2026-11-14 THEN it is skipped until `2026-12-01T00:00:00.000Z` and `engineStatus` reports that `until`
- WHEN `rate-limited` with `retryAfter: 20` THEN skipped 20 s; without it 60 s
- WHEN `unauthorized` THEN skipped for the instance's life
- WHEN every member fails THEN the rejection is the last attempted member's error with earlier ones in `cause`; WHEN all were skipped THEN the last skip reason
- WHEN a member has no key THEN `engineStatus` is `no-key`

**Tests (names only — red first):**
- "quota exhausted skips until the 1st of next month UTC"
- "rate limited skips for retryAfter or 60 s"
- "unauthorized skips for the instance life"
- "every member fails rejects with the last error"
- "all skipped rejects with the last skip reason"
- "a member without a key reports no-key"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/__tests__/cascade.skip.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git commit -am "feat(cascade): skip windows and engineStatus"`

### Task 11: Relay serves every engine

**Files:**
- Modify: `src/server/relay.ts` (`createRelayHandlerWith`, `RelayHandlerOptions`), `src/server/index.ts` (`createRelayHandler`)
- Test: `src/server/__tests__/relay.test.ts`

**Contract:**
```ts
interface RelayHandlerOptions { maxChars?: number; authorize?: (req: Request) => boolean | Promise<boolean>;
  edge?: EdgeEngineOptions; tts?: TtsConfig | Tts }
// body: { engine?: string; text: string; voice: string }
//     | { engine: "cascade"; text: string; lang?: string; voices?; order?; pronunciation? }
// 200: audio/mpeg + x-anytts-engine, x-anytts-voice;  502: { kind, retryAfter? } (+ Retry-After on rate-limited)
```

**Acceptance criteria:**
- WHEN `{ text, voice }` without `engine` arrives THEN Edge serves it exactly as before
- WHEN `{ engine: "elevenlabs", text, voice }` arrives on a relay with `tts` THEN ElevenLabs serves it and the headers name it
- WHEN `{ engine: "cascade", text, lang: "pl" }` is served by Azure THEN `x-anytts-engine: azure` and Azure's voice
- WHEN `engine` is not configured or `voice` not in its catalog THEN `400 { kind: "unknown-voice" }`, no upstream call
- WHEN a member refuses `rate-limited` with `retryAfter` THEN `502 { kind: "rate-limited", retryAfter }` and `Retry-After`
- WHEN `tts` is a `Tts` instance THEN the consumer's `instance.engineStatus` reflects windows opened by relay requests
- WHEN `authorize` is absent THEN requests are served (Q17); WHEN it resolves `false` THEN `403`

**Tests (names only — red first):**
- "a request without engine stays on edge"
- "a keyed engine through the relay"
- "a cascade request names the member that spoke"
- "unknown engine answers unknown-voice"
- "rate-limited carries Retry-After"
- "a shared instance reports the relay's skip windows"
- "no authorization hook serves the request"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/server` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [ ] **Step 3: Commit** — `git commit -am "feat(relay): serve every engine, shared Tts instance"`

### Task 12: Browser relay clients and the cascade alias

**Files:**
- Create: `src/engines/relayEngine.ts` (generic relay client for keyed engines and `cascade`)
- Modify: `src/tts.ts` (alias entries in the cache, `state` / `isCached` for cascade in the browser), `src/cache.ts` (alias eviction)
- Test: `src/__tests__/cascade.alias.test.ts`, `src/engines/__tests__/relayEngine.test.ts`

**Acceptance criteria:**
- WHEN a browser `cascade` configured `{ relayUrl }` synthesizes THEN it POSTs the cascade body and the result's `engine`/`voice` come from the headers
- WHEN that result arrives THEN it is cached under the member key and the alias `(cascade, lang, optionsHash, text)`, and `state` for the same request is `ready`
- WHEN a member voice in `voices` changes THEN the alias misses
- WHEN the member entry is evicted THEN its aliases go too
- WHEN the relay answers `502 { kind, retryAfter }` THEN the client rejects a `TtsError` of that kind and `retryAfter`
- WHEN a keyed engine is configured in the browser THEN no option accepts `apiKey` (type error / ignored) and no key is sent

**Tests (names only — red first):**
- "a browser cascade request uses the relay"
- "the alias is ready after a relay answer"
- "changing a member voice misses the alias"
- "evicting the member drops the alias"
- "relay errors keep kind and wait"
- "no key reaches the browser"

- [ ] **Step 1: Write the failing tests** — Run: `corepack pnpm exec vitest run src/__tests__/cascade.alias.test.ts src/engines/__tests__/relayEngine.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: same, then `corepack pnpm test && corepack pnpm lint` — Expected: PASS
- [ ] **Step 3: Commit** — `git commit -am "feat: browser relay clients and cascade alias cache"`

### Task 13: README, live probe and release prep

**Files:**
- Modify: `README.md` (keyed engines, cascade config, relay `tts`, warning that a keyed relay without a guard spends the owner's quota, overage-billing advice), `package.json` (minor version)
- Create: `scripts/probe-keyed.mjs` (manual live probe per provider, reads keys from env; not run in CI)

**Verification: non-testable** — Run: `corepack pnpm test && corepack pnpm lint && corepack pnpm build` — Expected: all green; README shows the config example from design.md; `node scripts/probe-keyed.mjs` without keys prints which keys are missing and exits 0.

- [ ] **Step 1: Docs, probe and version bump** — Run: the command above — Expected: green
- [ ] **Step 2: Commit** — `git commit -am "docs: keyed engines and cascade; release prep"`
- [ ] **Step 3: Push the branch and open a PR to `main`** — release follows the repo's tag flow (staged publish, approved by the owner).
