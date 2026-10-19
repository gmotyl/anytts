# Phase Hooks and restartStalled Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Ship anytts 0.3.0 with per-request `onStart`/`onFirstByte` hooks and `tts.restartStalled()`, so motyl.dev can adopt anytts without losing restart-on-wake or its reader-log timings.

**Architecture:** The Edge engine (direct + relay client) reports the first audio chunk through an optional per-attempt `hooks` argument. `createTts` tracks per-flight phases and per-caller hooks, and gives each attempt its own AbortController linked to the job's, so `restartStalled()` can fail one attempt as `first-byte-timeout` into the existing retry loop.

**Tech Stack:** TypeScript (ESM), Vitest (projects node / jsdom / package).

**Design:** [design.md](./design.md)

---

## Working environment

Worktree `~/git/prv/anytts-phase-hooks`, branch `feat/phase-hooks-restart-stalled` from `origin/main`
(`git worktree add`; `pnpm install` in it). PR to `main`. Gates: `pnpm test`, `pnpm lint`, `pnpm build`.
Tests live in the existing `__tests__` folders next to the code.

---

### Task 1: Engine reports its first audio byte

**Files:**
- Modify: `src/engine.ts` (`Engine.synthesize` — optional 4th param)
- Modify: `src/engines/edge/engine.ts` (direct path: first binary audio frame)
- Modify: `src/engines/edge/relayClient.ts` (`relaySynthesize`: first body chunk)
- Test: `src/engines/edge/__tests__/engine.test.ts`, `src/engines/edge/__tests__/relay-mode.browser.test.ts`

**Contract:**
```ts
export interface EngineHooks { onFirstByte?(): void }
synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks): Promise<ArrayBuffer>;
```
`EngineHooks` is exported from the package root.

**Acceptance criteria:**
- WHEN the direct socket delivers its first audio frame THEN `onFirstByte` is called once; later frames do not call it again.
- WHEN the relay response delivers its first body chunk THEN `onFirstByte` is called once.
- WHEN `auto` mode retries a dropped turn THEN each attempt's first audio frame calls the hook passed to that `synthesize` call at most once in total.
- WHEN `hooks` is omitted THEN all existing engine tests pass unchanged.

**Tests (names only — red first):**
- "edge engine calls onFirstByte once on the first audio frame"
- "edge engine without hooks behaves as before"
- "relay client calls onFirstByte once on the first body chunk"

- [x] **Step 1: Write the failing tests** — Run: `pnpm test` — Expected: FAIL (new tests)
- [x] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(edge): report the first audio byte through engine hooks"`

---

### Task 2: Per-request `onStart` / `onFirstByte`

**Files:**
- Modify: `src/tts.ts` (`SynthesisRequest`, in-flight record, `start`, `synthesize`, `prefetch`)
- Test: `src/__tests__/tts.test.ts`

**Contract:**
```ts
interface SynthesisRequest { /* existing */ onStart?(): void; onFirstByte?(): void }
```

**Acceptance criteria:**
- WHEN a request is queued, then starts, then receives audio THEN `onStart` then `onFirstByte` are called, once each.
- WHEN a caller joins a flight already past a phase THEN that hook is called asynchronously after `synthesize` returns.
- WHEN the request is a cache hit THEN both hooks are called and the cached result is returned.
- WHEN the first attempt fails transiently after its first byte and the retry succeeds THEN each hook was called exactly once.
- WHEN a hook throws THEN every caller still resolves.
- WHEN a caller aborts THEN its hooks are not called afterwards.
- WHEN `prefetch` is given hooks THEN they behave as for `synthesize`.

**Tests (names only — red first):**
- "onStart fires when the job leaves the queue, onFirstByte on the first chunk"
- "a late joiner gets passed phases asynchronously"
- "a cache hit fires both hooks"
- "a retry does not re-fire hooks"
- "a throwing hook does not fail the synthesis"
- "an aborted caller's hooks are not called"
- "prefetch forwards hooks"

- [x] **Step 1: Write the failing tests** — Run: `pnpm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(tts): per-request onStart and onFirstByte hooks"`

---

### Task 3: `tts.restartStalled()`

**Files:**
- Modify: `src/tts.ts` (`Tts` interface, `attempt`, running-attempt registry)
- Test: `src/__tests__/tts.test.ts`

**Contract:**
```ts
interface Tts { /* existing */ restartStalled(): boolean }
```

**Acceptance criteria:**
- WHEN an attempt runs with no first byte and retry budget remains THEN `restartStalled()` returns `true`, the engine call's signal aborts, and a new attempt starts at once.
- WHEN the running attempt is the last one THEN the request rejects with `TtsError{kind:'first-byte-timeout'}`.
- WHEN nothing runs, or every running attempt has delivered audio THEN it returns `false` and nothing changes.
- WHEN the job's only caller aborts while a restarted attempt runs THEN the caller rejects with `AbortError`.
- WHEN `restartStalled()` is called twice before the retry starts THEN the second call returns `false`.

**Tests (names only — red first):**
- "restartStalled aborts a pre-first-byte attempt into its retry"
- "restartStalled on the last attempt rejects with first-byte-timeout"
- "restartStalled returns false when nothing is running"
- "restartStalled leaves a streaming attempt alone"
- "a caller abort during a restarted attempt yields AbortError"
- "a second restartStalled before the retry starts is a no-op"

- [x] **Step 1: Write the failing tests** — Run: `pnpm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `pnpm test && pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(tts): restartStalled expires a silent attempt into its retry"`

---

### Task 4: Docs and version 0.3.0

**Files:**
- Modify: `README.md` (`synthesize` request fields; new "Restarting a silent attempt" note; engine hooks for custom engines)
- Modify: `package.json` (`version` → `0.3.0`)

**Verification: non-testable** — Run: `pnpm test && pnpm lint && pnpm build && npm pack --dry-run` — Expected: all green; tarball lists `dist/index.d.ts` containing `restartStalled` and `onFirstByte`.

- [x] **Step 1: README + version bump** — Run: the command above — Expected: as stated
- [x] **Step 2: Commit** — `git commit -m "chore: release 0.3.0"`

---

### Task 5: PR, merge, publish (Greg)

**Acceptance criteria:**
- WHEN the PR is opened THEN it targets `main` and links this change dir.
- WHEN Greg has merged it THEN `npm view anytts version` reports `0.3.0`.

- [ ] **Step 1: Push + PR** — Run: `git push -u origin feat/phase-hooks-restart-stalled && gh pr create --base main` — Expected: PR URL. Stop; do not merge.
- [ ] **Step 2 (Greg):** merge, then `npm publish` from `main` after `pnpm build`.
- [ ] **Step 3: Confirm** — Run: `npm view anytts version` — Expected: `0.3.0`. motyl's Task 1 is unblocked.
