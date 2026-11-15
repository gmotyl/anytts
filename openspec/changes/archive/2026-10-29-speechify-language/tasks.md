# speechify-language Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Speechify multilingual voices speak the request's language by sending `language`, fed by a Request language that now reaches every engine.

**Architecture:** `Engine.synthesize` gains an optional trailing `lang`; `Tts` passes `req.lang` and keys the member cache on it. The relay's direct body accepts `lang` and the browser relay client sends it. Speechify alone reads it, through a fixed simba-3.5 locale table and a cross-language rule.

**Tech Stack:** TypeScript (ESM), vitest (`node`, `jsdom`, `package` projects), corepack pnpm.

**Design:** [design.md](./design.md)

Commands: `corepack pnpm test`, `corepack pnpm lint`, `corepack pnpm build`. Single files:
`corepack pnpm vitest run <path>`.

---

### Task 1: Request language reaches the engine and the cache key

**Files:**
- Modify: `src/engine.ts` (`Engine.synthesize`)
- Modify: `src/tts.ts` (`memberKey`, `resolveEngine` — its `key` and `call`)
- Test: `src/__tests__/tts.test.ts`, `src/__tests__/cascade.test.ts`

**Contract:**
```ts
synthesize(text: string, voice: string, signal: AbortSignal, hooks?: EngineHooks, lang?: string): Promise<ArrayBuffer>;
// member key
JSON.stringify([engineId, voice, lang ?? null, preparedText])
```

**Acceptance criteria:**
- WHEN `synthesize({ engine, text, lang: "pl" })` runs directly THEN the engine's `synthesize` receives `lang` `"pl"` as its 5th argument
- WHEN a cascade request with `lang: "pl"` reaches a member THEN that member's `synthesize` receives `"pl"`
- WHEN a request has no `lang` THEN the engine receives `undefined`
- WHEN the same text and voice are synthesized with `lang: "pl"` and without `lang` THEN two attempts run and two cache entries exist
- WHEN the same (engine, voice, lang, text) is synthesized twice THEN the second resolves from cache (existing cache tests stay green with the new key shape)
- WHEN `corepack pnpm lint` runs THEN existing engines compile unchanged (the parameter is optional)

**Tests (names only — red first):**
- "tts > passes req.lang to engine.synthesize on the direct path"
- "tts > passes undefined lang when the request has none"
- "tts > the same text with different lang does not share a cache entry"
- "cascade > passes req.lang to each cascade member's synthesize"

- [x] **Step 1: Write the failing tests** — Run: `corepack pnpm vitest run src/__tests__/tts.test.ts src/__tests__/cascade.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `corepack pnpm test && corepack pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git add src/engine.ts src/tts.ts src/__tests__ && git commit -m "feat(tts): pass the request language to engines and key the cache on it"`

### Task 2: Speechify sends `language` across languages

**Files:**
- Create: `src/engines/speechify/languages.ts` (`SPEECHIFY_LANGUAGES`, `speechifyLanguage`)
- Modify: `src/engines/speechify/engine.ts` (`createSpeechifyEngine` → `synthesize`; replace the "`language` is omitted" comment with the rule)
- Modify: `src/engines/speechify/__tests__/fixtures/request.json` (`body` example + `_notes`: the rule, the 2026-10-29 live spike)
- Test: `src/engines/speechify/__tests__/engine.test.ts`

**Contract:**
```ts
/** Base code → simba-3.5 locale, from the docs' "Simba 3.5 languages" section (48 entries);
 *  European variant where a base has several: en → en-GB, pt → pt-PT, es → es-ES. */
export const SPEECHIFY_LANGUAGES: Readonly<Record<string, string>>;
/** The `language` to send for `lang` on a voice of `voiceLocale`, or undefined to omit it. */
export function speechifyLanguage(lang: string | undefined, voiceLocale: string): string | undefined;
```
Rule: resolve `lang` → locale (a region-qualified `lang` must be one of the table's values; a bare
base must be a key); omit when unresolved or when `base(locale) === base(voiceLocale)`. The voice's
locale comes from `SPEECHIFY_VOICES`.

**Acceptance criteria:**
- WHEN `geffen_32` synthesizes with `lang: "pl"` THEN the body is exactly `{ input, voice_id: "geffen_32", model: "simba-3.5", language: "pl-PL" }`
- WHEN `geffen_32` synthesizes with `lang: "pl-PL"` THEN the body carries `language: "pl-PL"`
- WHEN `kajetan` synthesizes with `lang: "en"` THEN the body carries `language: "en-GB"`
- WHEN `kajetan` with `lang: "pl"`, or `hugh_32` with `lang: "en"` THEN the body has no `language` key
- WHEN `lang` is absent or `"xx"` THEN the body has no `language` key and the request is still sent
- WHEN the table is inspected THEN it has 48 bases and `en`/`pt`/`es` map to `en-GB`/`pt-PT`/`es-ES`

**Tests (names only — red first):**
- "speechify > sends language pl-PL for a pl request on an en-US voice"
- "speechify > sends a region-qualified lang from the table unchanged"
- "speechify > maps en to en-GB"
- "speechify > omits language when the voice already speaks the request language"
- "speechify > omits language when the request has no lang"
- "speechify > omits language for a lang outside the simba-3.5 table"
- "speechify languages > lists 48 bases with European defaults for en, pt and es"

- [x] **Step 1: Write the failing tests** — Run: `corepack pnpm vitest run src/engines/speechify` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `corepack pnpm vitest run src/engines/speechify && corepack pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git add src/engines/speechify && git commit -m "feat(speechify): send language when the voice speaks another language"`

### Task 3: Speechify catalog lists all native Polish voices

**Files:**
- Modify: `src/engines/speechify/voices.ts` (`SPEECHIFY_VOICES`)
- Test: `src/engines/speechify/__tests__/engine.test.ts` (or `src/__tests__/voices.test.ts`, whichever already covers keyed catalogs)

**Acceptance criteria:**
- WHEN `listVoices("speechify")` is filtered to `pl-PL` THEN it returns exactly `dominika`, `iga`, `jagna`, `kajetan`, `michal`, `tymon`
- WHEN the new entries are read THEN `dominika` is female, `michal` is male labelled "Michał (multilingual · PL)", both `multilingual: true`, following the existing label pattern
- WHEN the default Voice map is read THEN `pl` is still `kajetan`

**Tests (names only — red first):**
- "voices > speechify catalog lists all six native pl-PL voices"

- [x] **Step 1: Write the failing test** — Run: `corepack pnpm vitest run src/engines/speechify src/__tests__/voices.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: same — Expected: PASS
- [x] **Step 3: Commit** — `git add src/engines/speechify src/__tests__ && git commit -m "feat(speechify): add dominika and michal to the catalog"`

### Task 4: The direct relay request carries `lang`

**Files:**
- Modify: `src/server/relay.ts` (`parseTtsBody` non-cascade branch; error message names `lang?`)
- Modify: `src/engines/relayEngine.ts` (`createRelayEngine` → `synthesize`; its doc comment's body shape)
- Modify: `src/server/index.ts` (doc comment of the relay body shapes)
- Test: `src/server/__tests__/relay.test.ts`, `src/engines/__tests__/relayEngine.test.ts`

**Acceptance criteria:**
- WHEN `POST { engine: "speechify", text, voice: "geffen_32", lang: "pl" }` reaches a relay with `tts` THEN `tts.synthesize` receives `lang: "pl"` (and so the server-side pronunciation step and Speechify's `language` see it)
- WHEN `POST { engine: "speechify", text, voice, lang: 1 }` arrives THEN the response is `400` and no synthesis starts
- WHEN the direct body has no `lang` THEN behaviour is unchanged (no `lang` key in the request)
- WHEN a browser relay client for `speechify` synthesizes with `lang: "pl"` THEN `/api/tts` receives `{ engine: "speechify", text, voice, lang: "pl" }`; without `lang` the body has no `lang` key
- WHEN the Edge-only relay (no `tts`) gets a body with `lang` THEN it still answers `200` (field ignored)

**Tests (names only — red first):**
- "relay > forwards lang on a direct request"
- "relay > rejects a non-string lang on a direct request"
- "relay > the edge-only relay ignores lang"
- "relay client > sends lang on a direct keyed request when the request has one"
- "relay client > omits lang when the request has none"

- [x] **Step 1: Write the failing tests** — Run: `corepack pnpm vitest run src/server/__tests__/relay.test.ts src/engines/__tests__/relayEngine.test.ts` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `corepack pnpm test && corepack pnpm lint` — Expected: PASS
- [x] **Step 3: Commit** — `git add src/server src/engines/relayEngine.ts src/engines/__tests__ && git commit -m "feat(relay): accept and send lang on direct requests"`

### Task 5: Docs and version 0.5.0

**Files:**
- Modify: `README.md` (Speechify row/notes: `language` rule and `en → en-GB`; relay direct body shape with `lang?`; custom-engine `synthesize` signature if documented)
- Modify: `package.json` (`version` → `0.5.0`)
- Modify: `openspec/changes/2026-10-29-speechify-language/design.md` only if implementation forced a deviation (record it)

**Verification: non-testable** — Run: `corepack pnpm test && corepack pnpm lint && corepack pnpm build` — Expected: all green; `grep -n "lang?" README.md` shows the direct relay body; `package.json` version `0.5.0`.

- [x] **Step 1: Update docs and version** — Run: the verification above — Expected: PASS
- [x] **Step 2: Commit** — `git add README.md package.json openspec && git commit -m "docs: speechify language, relay lang; 0.5.0"`

Live check (Greg, with keys, after build): `geffen_32` + `lang: "pl"` through pavilio's cascade speaks Polish.
