# Proposal: anytts v1 — one speech engine for pavilio and motyl.dev

## Problem

pavilio's panel (agent answers spoken in a terminal cell) and motyl.dev's article reader both turn
text into speech with **the same code, copied twice and drifting**:

| Layer | motyl.dev | pavilio panel |
|---|---|---|
| Synthesis client, LRU, in-flight dedupe, stall retry | `lib/tts/client.ts` (453) | `features/speech/synth.ts` (349) |
| Pronunciation + acronym maps | `lib/tts/pronunciation.ts` — identical 96 + 25 entries | `features/speech/pronunciation.ts` |
| Unit packing 200/450 | `lib/tts/speech.ts` `packUnits` | `features/speech/prepare.ts` `packUnits` |
| Voice catalog + stored voice | `lib/tts/voices.ts` | `features/speech/voices.ts` |
| Scheduling | 1 socket, play before warm | 3-slot window, run/warm/preload |

Both depend on `edge-tts-universal` (browser build), which now fails them both:

- **Since ~2026-10-10 every synthesis is a 403.** Microsoft moved Edge read-aloud to the
  `Sec-MS-GEC` v2 token (a modified SHA256 with its own constants; rany2/edge-tts fixed it in 7.3.0,
  issue #490). `edge-tts-universal` 1.4.0 (last release February) still sends v1.
- **On a 403 its stream never settles** — no error, no end. Users see a red button and silence.
- **No language control.** Multilingual voices auto-detect and sometimes read Polish as English.
- **Only Edge may connect.** The endpoint also refuses (403) any handshake whose User-Agent is not
  Microsoft Edge ≥ 137, and a browser cannot set User-Agent on a WebSocket — so even with the new
  token, Chrome, Firefox and Safari cannot synthesize directly (found 2026-10-14 by both hotfixes).

A short-term `pnpm patch` hotfix in each app restores audio; it does not remove the duplication or
the dependency.

## What changes

A new public library **anytts** (`gmotyl/anytts`, npm `anytts`), runtime-agnostic (browser and
Node), zero runtime dependencies:

- **Engines** behind one interface; v1 ships the **Edge engine** with its own read-aloud client:
  `Sec-MS-GEC` v2 token in plain JS, injectable WebSocket transport (browser native; Node with
  Origin/User-Agent headers), first-byte and stall deadlines.
- **`createTts(config)`**: `synthesize`, `prefetch`, `isCached`, `subscribe`; cache keyed on
  (engine, voice, text); a scheduler with ordered tiers, cumulative caps, join/promote and abort.
- **Typed failure contract**: every synthesis settles; `TtsError{kind}` with bounded retries for
  transient kinds only.
- **Voices**: `listEngines`, `listVoices(engine)`, `resolveVoice`; a **Voice map** per engine
  (`{pl, en, default}`) is the only way to force a language — the Edge endpoint ignores or rejects
  every SSML language hint (spike 2026-10-14).
- **Relay** (`anytts/server`): a stateless Fetch-standard handler that synthesizes in Node with an
  Edge User-Agent; the browser engine uses it automatically outside Edge (`mode: "auto"`).
- **`anytts/text`**: per-language **Pronunciation maps** (shipped `pl` preset = motyl's strict
  map), `packUnits`, `firstSentence`.

## Out of scope

- Adopting the library in pavilio or motyl — separate proposals in each project's store.
- Markdown stripping and language detection — they diverged per app and stay there.
- Playback (MSE carriers, audio elements, media session) — app-owned.
- Piper (offline browser engine) — separate anytts proposal.
- Mounting the Relay route, rate limiting and abuse protection — each app's adoption proposal.

## Preconditions

1. 403 hotfix landed in pavilio and motyl (its `Sec-MS-GEC` v2 module is moved here verbatim).
2. motyl's `fix/pronunciation-match-strictness` merged to motyl `main` (source of the `pl` preset).

## Verification sketch

- Golden token vectors match Python edge-tts 7.3.1 byte for byte.
- A fake transport answering 403 makes `synthesize` reject `rejected` within the deadline.
- In a non-Edge browser environment with `relayUrl`, synthesis goes through the Relay and returns audio.
- Live contract test (one short synthesis + voice list) green manually and in a nightly workflow.
- `anytts@0.1.0` installable from npm in a scratch project, in Node and in a browser bundle.
