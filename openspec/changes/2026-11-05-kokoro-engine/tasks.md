# Kokoro engine Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Ship engine `kokoro` (Kokoro-FastAPI with a built-in 54-voice catalog) in anytts 0.7.0.

**Architecture:** `createKokoroEngine` wraps `createOpenAIEngine`, with the catalog, model and
defaults fixed by the engine. `KOKORO_VOICES` is static data, so the registry lists it and the
browser relay client checks voices against it without a `catalog` option.

**Tech Stack:** TypeScript ESM, vitest (`node`/`jsdom`/`package` projects), pnpm.

**Design:** [design.md](./design.md)

Repo: `~/git/prv/anytts`, branch `feat/kokoro-engine` (already holds the change dir). Gate per task:
`pnpm test && pnpm lint`.

---

### Task 1: Kokoro voice catalog

**Files:**
- Create: `src/engines/kokoro/voices.ts` (`KOKORO_VOICES`)
- Test: `src/engines/kokoro/__tests__/voices.test.ts`

**Contract:**
```ts
export const KOKORO_VOICES: readonly VoiceInfo[]; // 54 entries, data per design.md § Catalog
export const KOKORO_DEFAULT_VOICE = "af_heart";
```

**Acceptance criteria:**
- WHEN the catalog is read THEN it holds exactly the 54 ids from design.md § Catalog, all unique
- WHEN any voice is inspected THEN its locale matches its prefix letter, its gender matches the second letter, `multilingual` is `false`, and the label is the capitalised name after `_`
- WHEN `af_heart` is looked up THEN it is `{ id: "af_heart", label: "Heart", locale: "en-US", gender: "female", multilingual: false }`

**Tests (names only — red first):**
- "kokoro catalog has the 54 v1.0 preset ids, unique"
- "every kokoro voice's locale and gender follow its id prefix"
- "af_heart is an en-US female voice labelled Heart"

- [x] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/engines/kokoro` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `pnpm vitest run src/engines/kokoro && pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git add src/engines/kokoro && git commit -m "feat(kokoro): static voice catalog"`

### Task 2: The `kokoro` engine factory, registered in `anytts/server`

**Files:**
- Create: `src/engines/kokoro/engine.ts` (`createKokoroEngine`, `KokoroEngineOptions`)
- Modify: `src/server/index.ts` (server engine map: `kokoro`; export `KokoroEngineOptions`)
- Test: `src/engines/kokoro/__tests__/engine.test.ts`

**Contract:**
```ts
export interface KokoroEngineOptions {
  baseUrl: string; apiKey?: string; firstByteMs?: number; stallMs?: number; fetch?: typeof fetch;
}
// createOpenAIEngine({ ...options, catalog: KOKORO_VOICES, model: "kokoro", firstByteMs: options.firstByteMs ?? 30000 })
// defaults: { voices: { default: "af_heart" }, maxConcurrent: 1 }
```

**Acceptance criteria:**
- WHEN `{ engine: "kokoro", text: "Hello", voice: "am_michael" }` is synthesized against `http://127.0.0.1:8880` THEN one POST goes to `/v1/audio/speech` with body `{ input: "Hello", voice: "am_michael", model: "kokoro", response_format: "mp3" }` and no `authorization` header
- WHEN `apiKey` is set THEN the request carries `authorization: Bearer <key>`
- WHEN the request has `lang: "pl"` THEN the body carries no language field
- WHEN no `voices` are configured and no voice is named THEN `af_heart` speaks, in any language
- WHEN the config sets `catalog`, `model`, `languageField` or `extraBody` THEN `createTts` throws `RangeError`
- WHEN `baseUrl` is missing or not http(s) THEN `createTts` throws `RangeError`
- WHEN a request names `my-voice` THEN it rejects `unknown-voice` with no fetch
- WHEN nothing listens THEN the attempt rejects `network`, and a cascade `["kokoro", "edge"]` falls to `edge`; `engineStatus("kokoro")` is never `no-key`
- WHEN no `firstByteMs` is configured and headers arrive after 20 s (fake timers) THEN the attempt succeeds

**Tests (names only — red first):**
- "kokoro posts an OpenAI speech request with model kokoro"
- "kokoro sends Bearer only when apiKey is set"
- "kokoro never sends a language field"
- "kokoro defaults to af_heart for every language"
- "kokoro refuses engine-owned options"
- "kokoro refuses a missing or non-http baseUrl"
- "kokoro rejects a voice outside its catalog without a request"
- "kokoro down falls through in a cascade and is not no-key"
- "kokoro waits 30 s for the first byte by default"

- [x] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/engines/kokoro` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git add src/engines/kokoro src/server/index.ts && git commit -m "feat(kokoro): engine factory on the openai engine"`

### Task 3: Registry entry

**Files:**
- Modify: `src/engines/registry.ts` (`ENGINES`)
- Test: `src/engines/__tests__/registry.test.ts`

**Acceptance criteria:**
- WHEN `listEngines()` is called THEN it includes `{ id: "kokoro", label: "Kokoro (local server)", runtimes: ["node"] }`
- WHEN `listVoices("kokoro")` is called THEN it returns the 54 catalog voices
- WHEN the returned list or one of its voices is mutated THEN a later `listVoices("kokoro")` is unchanged

**Tests (names only — red first):**
- "listEngines includes kokoro as a node engine"
- "listVoices(kokoro) returns the static catalog"
- "listVoices(kokoro) returns copies"

- [x] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/engines/__tests__/registry.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git add src/engines && git commit -m "feat(kokoro): list engine and voices"`

### Task 4: Browser relay client for `kokoro`

**Files:**
- Modify: `src/engines/relayEngine.ts` (`RELAY_ENGINES`: add `kokoro`; a `createKokoroRelayEngine` that reuses the `openai` relay path with `catalog: KOKORO_VOICES`)
- Test: `src/engines/__tests__/relayEngine.test.ts`

**Acceptance criteria:**
- WHEN a browser instance with `kokoro: { relayUrl: "/api/tts" }` synthesizes `{ engine: "kokoro", text, voice: "af_heart", lang: "pl" }` THEN `/api/tts` receives exactly `{ engine: "kokoro", text, voice: "af_heart", lang: "pl" }`
- WHEN it names `my-voice` THEN it rejects `unknown-voice` without calling the relay
- WHEN the browser config sets `baseUrl`, `apiKey` or `catalog` on `kokoro` THEN `createTts` throws `RangeError`
- WHEN the main `anytts` entry is built THEN it still contains no keyed-engine or server code (the existing package test passes)

**Tests (names only — red first):**
- "browser kokoro request reaches the relay with its language"
- "browser kokoro rejects a voice outside the static catalog"
- "browser kokoro refuses server-only fields"

- [x] **Step 1: Write the failing tests** — Run: `pnpm vitest run src/engines/__tests__/relayEngine.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git add src/engines && git commit -m "feat(kokoro): browser relay client"`

### Task 5: Docs, live smoke, version and PR

**Files:**
- Modify: `README.md` (a `kokoro` section: options, Kokoro-FastAPI on :8880, default `af_heart`, no Polish phonemizer, no word boundaries)
- Modify: `package.json` (`version` → `0.7.0`), `CHANGELOG.md` if present

**Verification: non-testable** — Run: `pnpm build && pnpm test && pnpm lint`, then a one-off Node
script against a running Kokoro-FastAPI: `createTts` from `dist/server` with `kokoro: { baseUrl:
"http://127.0.0.1:8880" }` synthesizing one English and one Polish sentence — Expected: all green,
and two non-empty MP3s whose first bytes are `ID3` or `0xFFFB`.

- [ ] **Step 1: README + version bump** — Run: `pnpm build && pnpm test && pnpm lint` — Expected: PASS
- [ ] **Step 2: Live smoke against Kokoro-FastAPI** (any local install, e.g. pavilio's `kokoroctl start` once its Task 6 lands, or `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu`) — Expected: MP3 bytes
- [ ] **Step 3: Commit, push and open the PR to `main`** — `git commit -am "docs: kokoro engine; 0.7.0" && git push -u origin feat/kokoro-engine && GH_TOKEN="" gh pr create --base main` — then the release tag after merge (`v0.7.0` stages to npm; Greg approves with 2FA)
