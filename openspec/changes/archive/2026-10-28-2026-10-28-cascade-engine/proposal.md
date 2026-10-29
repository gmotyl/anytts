# Change: cascade-engine

> Shared change id with the pavilio change of the same name
> (`projects/pavilio/plans/openspec/changes/2026-10-28-cascade-engine/` in the workspace), which
> adopts it in the panel. Designed in the 2026-10-27/28 grill (Q1–Q17); source research:
> `projects/tts-providers/wiki/questions/2026-10-26-apis-fit-free-first-fallback.md`.

## Why

anytts speaks through one engine, Edge read-aloud. It is free, but it is a single unofficial
endpoint: when Microsoft changes the token or drops a voice, speech stops. Several providers offer a
renewing free tier that refuses rather than bills when the month's quota runs out (ElevenLabs,
Cartesia, Speechify, Azure F0). Used one after another, they give better voices than Edge for most
of the month and fall back to Edge only when all of them are spent.

Doing this in every consumer would duplicate key handling, quota signalling and cache rules, so it
belongs in the library: **one engine id, `cascade`, that tries member engines in a user-set order
and moves on when a provider says it cannot serve.**

## What changes

- **Four keyed engines** — `elevenlabs`, `cartesia`, `speechify`, `azure` — each a normal `engines`
  entry in one shared shape (`apiKey`, `voices?`, `maxConcurrent?`, `pronunciation?`, plus
  engine fields such as Azure's `region`), usable on their own, with built-in `pl`/`en` Voice maps
  and static catalogs of the providers' stock voices. They run in Node only; the browser reaches
  them through the Relay.
- **The `cascade` engine** — `cascade: { order: [...] }`. A request gives `lang` and optionally
  per-request `voices`, `order` and `pronunciation`. The chain skips members without a key and
  members marked unavailable, waits for a free slot on a busy member, and moves to the next member
  on quota, auth, rate-limit or persistent transient errors.
- **Three new error kinds** — `quota-exhausted`, `unauthorized`, `rate-limited` (with
  `retryAfter`) — and the skip windows they set.
- **Per-engine concurrency** — `maxConcurrent` per engine, built-in defaults for keyed engines.
- **Pronunciation inside the library** — an engine entry's `pronunciation: true|false`; the
  library applies the request language's Pronunciation map after the member is picked.
- **The Relay serves every engine** — `{ engine?, text, voice }` for one engine,
  `{ engine: "cascade", text, lang?, voices?, order?, pronunciation? }` for the chain, answering with
  headers naming the engine and voice that spoke. `authorize` stays optional (Q17).
- **Browser relay clients** — in the browser, keyed engines and `cascade` are configured with
  `{ relayUrl }` only; the browser caches a cascade result under the member key and a cascade alias.

## Out of scope

- Google Cloud TTS and Amazon Polly members (they bill silently past the free tier).
- Local character counting or a monthly budget per engine (a later change, with Google/Polly).
- Skip state that survives a restart.
- Account-specific voices (cloned / library voices) — see `2026-10-17-client-managed-voice-catalog`.
- The Piper engine (`2026-10-14-piper-engine`).

## Impact

- New: `src/engines/{elevenlabs,cartesia,speechify,azure}/`, `src/cascade.ts`, browser relay client.
- Changed: `TtsErrorKind`, `TtsConfig` / `EngineConfig`, `SynthesisRequest`, the scheduler (engine
  slots), the cache (cascade alias), `src/server` (relay body and headers), `listEngines`.
- Minor version bump; consumers pin and adopt on their own schedule.
