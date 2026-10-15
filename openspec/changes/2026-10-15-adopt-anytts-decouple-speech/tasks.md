# Observable in-flight state (anytts 0.2.0) Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Let a consumer observe whether a synthesis request is cold, pending or ready, and be told when it enters or leaves the in-flight set — released as `anytts@0.2.0`.

**Architecture:** Additive change to the `Tts` facade in `src/tts.ts`: a `state()` query over the existing `cache` + private `inFlight` map, and two new event types (`pending`, `drop`) emitted from the points where a key enters and leaves `inFlight` without a result. `isCached`, scheduling, retries and the cache itself are untouched.

**Tech Stack:** TypeScript (ESM), vitest (projects `node`, `jsdom`, `package`), npm trusted publishing via `release.yml`.

**Design:** [design.md](./design.md) — PR 1 of pavilio's `2026-10-15-adopt-anytts-decouple-speech`.

Branch: `feat/in-flight-state` from `main`, PR to `gmotyl/anytts:main`.

---

### Task 1: `Tts.state()` and the `pending` / `drop` events

**Files:**
- Modify: `src/tts.ts` (`Tts` interface, `createTts`: `synthesize`'s `inFlight.set` / `inFlight.delete` sites, the `tts` object literal)
- Modify: `src/index.ts` only if a new type needs exporting (`TtsEvent`)
- Test: `src/__tests__/tts.test.ts`

**Contract:**

```ts
export type TtsEvent = { type: "pending" | "add" | "drop" | "evict"; key: string };
export interface Tts {
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
  prefetch(req: SynthesisRequest): void;
  isCached(req: SynthesisRequest): boolean;
  state(req: SynthesisRequest): "cold" | "pending" | "ready";
  subscribe(listener: (e: TtsEvent) => void): () => void;
}
```

**Acceptance criteria:**
- WHEN `synthesize`/`prefetch` is called for a key that is neither cached nor in flight THEN `state` answers `"pending"` synchronously after the call and `"ready"` once the result is cached
- WHEN the engine fails for good, or a queued/in-flight job is aborted with no caller left THEN `state` answers `"cold"`, `isCached` is false, and the listener received exactly one `drop` for that key
- WHEN a request succeeds THEN the listener received exactly `pending` then `add` for that key, in that order
- WHEN a second caller joins an in-flight key, a waiting job is promoted, or a transient failure is retried THEN no event is emitted for that step
- WHEN `state` is asked about a voice outside the catalog or an unconfigured engine THEN it answers `"cold"` and does not throw
- WHEN the LRU evicts THEN `evict` is still emitted; `isCached` behaves as before (existing tests stay green)
- WHEN one unsubscribe function is called THEN neither cache nor in-flight events reach the listener any more

**Tests (names only — red first):**
- "state is pending from the call until the result lands, then ready"
- "state returns to cold and drop is emitted when the engine fails for good"
- "state returns to cold and drop is emitted when a queued job is aborted"
- "a success emits pending then add, once each"
- "a joining caller and a promotion emit nothing"
- "a retried transient failure emits nothing between attempts"
- "state answers cold for an unknown voice without throwing"
- "unsubscribe silences both cache and in-flight events"

- [x] **Step 1: Write the failing tests** — Run: `pnpm vitest run --project node src/__tests__/tts.test.ts` — Expected: FAIL (`state is not a function`, missing events)
- [x] **Step 2: Minimal implementation** — Run: `pnpm vitest run --project node src/__tests__/tts.test.ts && pnpm lint` — Expected: PASS, no type errors
- [x] **Step 3: Commit** — `git add src/tts.ts src/index.ts src/__tests__/tts.test.ts && git commit -m "feat(tts): state() query and pending/drop cache events"`

### Task 2: README and package surface

**Files:**
- Modify: `README.md` (after the "Quick start" cache-events lines: a short "Observing a request" subsection)
- Test: `test/package/consume.test.ts` (only if it enumerates the public `Tts` surface — then it names `state`)

**Acceptance criteria:**
- WHEN a reader opens the README THEN `state()` and the four event types are documented with the same wording as the delta spec (`pending` = queued or running, `drop` = left without a result)
- WHEN the package project runs against the built `dist` THEN a consumer can call `tts.state(...)` with types

**Verification: non-testable** — Run: `pnpm build && pnpm test` — Expected: all three projects PASS; `grep -n "state(" README.md` finds the new subsection

- [x] **Step 1: Write the README subsection; extend the package test if it lists the surface** — Run: `pnpm build && pnpm test` — Expected: PASS
- [x] **Step 2: Commit** — `git add README.md test/package && git commit -m "docs: document state() and in-flight events"`

### Task 3: Release 0.2.0

**Files:**
- Modify: `package.json` (`version`: `0.2.0`)

**Acceptance criteria:**
- WHEN the PR is merged THEN tag `v0.2.0` points at the merge commit and `release.yml` publishes `anytts@0.2.0`
- WHEN `npm view anytts version` runs THEN it prints `0.2.0`

**Verification: non-testable** — Run: `npm view anytts version` — Expected: `0.2.0`

- [ ] **Step 1: Bump the version** — `git commit -am "chore: release 0.2.0"`; push the branch; `gh pr create --base main` with the proposal's summary
- [ ] **Step 2: Ask the user to merge and tag** — outward-facing: never tag or publish without the user's go; after merge, `git tag v0.2.0 <merge sha> && git push origin v0.2.0` only when told
- [ ] **Step 3: Confirm on npm and record the version** — Run: `npm view anytts version` — Expected: `0.2.0`; note it in the pavilio session progress file (pavilio PR 2 pins this exact version)
