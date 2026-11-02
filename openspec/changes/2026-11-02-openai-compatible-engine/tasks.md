# OpenAI-compatible engine Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Ship engine `openai` (any `POST /v1/audio/speech` server, OmniVoice first) in anytts 0.6.0.

**Architecture:** A Node engine in `anytts/server` built on `keyedFetch`, `keyed: false`, with voices from an app-supplied `catalog`. In the browser, a relay client for `openai` checks voices against the same `catalog`. The registry lists the engine with no static voices.

**Tech Stack:** TypeScript ESM, vitest (`node`/`jsdom`/`package` projects), pnpm.

**Design:** [design.md](./design.md)

Worktree: `/srv/git/prv/anytts-openai`, branch `feat/openai-compatible-engine`. Gate per task:
`pnpm test && pnpm lint`.

---

### Task 1: The `openai` engine factory

**Files:**
- Create: `src/engines/openai/engine.ts` (`createOpenAIEngine`, `OpenAIEngineOptions`)
- Test: `src/engines/openai/__tests__/engine.test.ts`

**Contract:**
```ts
export interface OpenAIEngineOptions {
  baseUrl: string; catalog: VoiceInfo[]; apiKey?: string; model?: string;
  languageField?: string; extraBody?: Record<string, unknown>;
  firstByteMs?: number; stallMs?: number; fetch?: typeof fetch;
}
export function createOpenAIEngine(options: OpenAIEngineOptions): Engine & {
  keyed: false; defaults: { voices: VoiceMap; maxConcurrent: number };
};
```

**Acceptance criteria:**
- WHEN synthesizing `("Hello", "en-female")` with `baseUrl: "http://h:8890/"` THEN exactly one POST goes to `http://h:8890/v1/audio/speech`, with body `{ input, voice, model: "tts-1", response_format: "mp3" }` and no `authorization` header, and the response bytes are returned
- WHEN `apiKey` is set THEN the request carries `authorization: Bearer <key>`
- WHEN `extraBody` is `{ num_step: 16, model: "x", input: "y" }` THEN `num_step` is sent, and `model`, `input`, `voice` and `response_format` keep the engine's values
- WHEN `languageField: "language"`, the voice locale is `en-GB` and `lang` is `pl-PL` THEN the body carries `language: "pl"`
- WHEN the voice locale is `pl-PL` and `lang` is `pl` THEN no language field is sent; WHEN `languageField` is unset THEN no language field is ever sent
- WHEN the connection is refused THEN it rejects `network`; WHEN the server answers 400 THEN `rejected` with status 400; WHEN 401 THEN `unauthorized`; WHEN 429 with `Retry-After: 5` THEN `rate-limited` with `retryAfter: 5`; no status gives `quota-exhausted`
- WHEN `baseUrl` is missing or not `http(s)`, or `catalog` is missing, empty or holds a duplicate id THEN `createOpenAIEngine` throws `RangeError`
- WHEN the engine is created THEN it has `keyed: false`, `voices` equal to `catalog`, and `defaults` `{ voices: { default: catalog[0].id }, maxConcurrent: 1 }`; the default `firstByteMs` is 15000

**Tests (names only — red first):**
- "posts the OpenAI speech body to baseUrl/v1/audio/speech"
- "joins a trailing-slash baseUrl without a double slash"
- "sends Bearer only when apiKey is set"
- "merges extraBody without overriding the fixed fields"
- "sends the language base only when it differs from the voice locale"
- "never sends a language field without languageField"
- "maps refusals and network failures to error kinds"
- "throws RangeError on missing or invalid baseUrl or catalog"
- "defaults: keyed false, maxConcurrent 1, first catalog voice as default"

- [ ] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/engines/openai` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** (reuse `keyedFetch` and `RefusalRules` with `isQuota: () => false`) — Run: `pnpm vitest run src/engines/openai && pnpm lint` — Expected: PASS
- [ ] **Step 3: Commit** — `git add src/engines/openai && git commit -m "feat(openai): OpenAI-compatible speech engine"`

### Task 2: Register `openai` in `anytts/server` and check the voice map at construction

**Files:**
- Modify: `src/server/index.ts` (`KEYED_ENGINES` map → add `openai`; export `OpenAIEngineOptions` type; doc comment of `createTts`)
- Modify: `src/tts.ts` (only if needed so that a voice-map value outside the catalog throws `RangeError` for `openai`)
- Test: `src/server/__tests__/createTts.test.ts`

**Acceptance criteria:**
- WHEN a Node `createTts({ engines: { openai: { baseUrl, catalog } }, defaultEngine: "openai" })` synthesizes `{ text, voice: "pl-female" }` with a fake fetch THEN it resolves with `engine: "openai"`
- WHEN a request names a voice outside `catalog` (e.g. `auto`) THEN it rejects `unknown-voice` and fetch is never called
- WHEN `voices: { default: "nope" }` and `nope` is not in `catalog` THEN `createTts` throws `RangeError`
- WHEN `cascade: { order: ["openai", "edge"] }` and `openai` has no `apiKey` THEN `engineStatus("openai")` is not `no-key` and the cascade attempts `openai` first
- WHEN `openai` runs in a cascade and fails `network` THEN the next member speaks (an existing skip-window behaviour, asserted for `openai`)
- WHEN two `openai` requests are queued without `maxConcurrent` THEN the second starts only after the first settles

**Tests (names only — red first):**
- "server createTts synthesizes with the openai engine"
- "openai rejects a voice outside its catalog without a request"
- "openai voice map outside the catalog throws RangeError"
- "cascade tries openai without an apiKey"
- "cascade moves past an unreachable openai server"
- "openai runs one attempt at a time by default"

- [ ] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/server/__tests__/createTts.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [ ] **Step 3: Commit** — `git add src && git commit -m "feat(server): register the openai engine"`

### Task 3: Browser relay client for `openai`

**Files:**
- Modify: `src/engines/relayEngine.ts` (`RELAY_ENGINES`, `createRelayEngine`: an `openai` client whose voices are `options.catalog`)
- Test: `src/engines/__tests__/relayEngine.test.ts`

**Acceptance criteria:**
- WHEN a browser instance with `openai: { relayUrl: "/api/tts", catalog: [pl-female] }` synthesizes `{ engine: "openai", text, voice: "pl-female", lang: "pl" }` THEN the relay receives `{ engine: "openai", text, voice: "pl-female", lang: "pl" }`
- WHEN it names `voice: "en-male"`, which is outside the catalog THEN it rejects `unknown-voice` without calling the relay
- WHEN `catalog` is missing THEN `createTts` throws `RangeError`
- WHEN `apiKey`, `baseUrl` or `extraBody` is set on the browser `openai` THEN `createTts` throws `RangeError`
- WHEN the relay answers `502 { kind: "network" }` THEN the attempt ends `TtsError{ kind: "network" }`

**Tests (names only — red first):**
- "browser openai posts engine, text, voice and lang to the relay"
- "browser openai rejects a voice outside its catalog"
- "browser openai requires a catalog"
- "browser openai refuses apiKey, baseUrl and extraBody"
- "browser openai keeps the relay error kind"

- [ ] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/engines/__tests__/relayEngine.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [ ] **Step 3: Commit** — `git add src && git commit -m "feat(relay): browser relay client for openai"`

### Task 4: Registry entry

**Files:**
- Modify: `src/engines/registry.ts` (`ENGINES`)
- Test: `src/engines/__tests__/registry.test.ts`

**Acceptance criteria:**
- WHEN `listEngines()` is called THEN it contains `{ id: "openai", label: "OpenAI-compatible (custom server)", runtimes: ["node"] }`
- WHEN `listVoices("openai")` is called THEN it returns `[]`

**Tests (names only — red first):**
- "listEngines includes the openai engine for node"
- "listVoices returns no static voices for openai"

- [ ] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/engines/__tests__/registry.test.ts` — Expected: FAIL
- [ ] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [ ] **Step 3: Commit** — `git add src && git commit -m "feat(registry): list the openai engine"`

### Task 5: Docs, live smoke, version and PR

**Files:**
- Modify: `README.md` (an `openai` section: options, OmniVoice example with `languageField: "language"` and `extraBody: { num_step: 16 }`, no word boundaries, no streaming)
- Modify: `package.json` (`version` → `0.6.0`), `CHANGELOG.md` if present

**Verification: non-testable** — Run: `pnpm build && pnpm test && pnpm lint`, then a one-off Node
script against the running server: `createTts` from `dist/server` with `openai: { baseUrl:
"http://127.0.0.1:8890", catalog: [cand-pl-f2 (pl-PL, female)], languageField: "language" }`
synthesizing one Polish sentence — Expected: all green, and the script writes a non-empty MP3
whose first bytes are `ID3` or `0xFFFB`.

- [ ] **Step 1: README + version bump** — Run: `pnpm build && pnpm test && pnpm lint` — Expected: PASS
- [ ] **Step 2: Live smoke against omnivoice-server** (`/srv/git/prv/omnivoice-server/omnivoicectl status` healthy first) — Expected: MP3 bytes
- [ ] **Step 3: Commit, push and open the PR to `main`** — `git commit -am "docs: openai engine; 0.6.0" && git push -u origin feat/openai-compatible-engine && gh pr create --base main` — then the release tag after merge (`v0.6.0` stages to npm; Greg approves with 2FA)
