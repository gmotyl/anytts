---
title: Pocket TTS engines
summary: Add `pocket` and `pocket-pl`, local engines that talk to Kyutai's `pocket-tts serve` and encode its WAV reply to MP3, with preset voices and voices cloned from clips served by URL.
---

# Change: Pocket TTS engines

## Why

Kyutai's Pocket TTS (https://github.com/kyutai-labs/pocket-tts) is a 100M-parameter model that runs
on two CPU cores at about 3.5× real time and clones a voice from a short WAV. A community Polish
model (`shefowl/pocket-tts-polish-6l`) runs on the same server. Its HTTP API (`POST /tts`, multipart,
WAV only) is not OpenAI-compatible, so the existing `openai` and `kokoro` engines can't use it.
Every anytts result is MP3.

## What changes

- **New capability `pocket-engine`.** One factory registers two engines, `pocket` (English) and
  `pocket-pl` (Polish), both Node-runtime, and reachable from the browser through the relay.
- **Request.** A multipart `POST {baseUrl}/tts` with `text` and `voice_url`. The voice URL is a
  preset name, or `{voiceFilesUrl}/{id}/sample.wav?v={version}` for a caller-supplied voice.
  `pocket-pl`'s `shefowl` preset sends no `voice_url`.
- **Response.** The WAV body comes through `keyedFetch`. Its placeholder header sizes are ignored
  and the PCM is encoded to MP3 with `@breezystack/lamejs`. This is anytts's first runtime
  dependency: LGPL-3.0, imported lazily, and noted in the README.

## Out of scope

- Streaming.
- A browser runtime.
- `.safetensors` voices.
- `voice_wav` uploads, which re-clone on every request (measured at +4.2 s per request).

## Impact

- **Files:** `src/engines/pocket/{engine,voices}.ts` with tests; `registry.ts`; `relayEngine.ts`
  `CATALOGS`; `server/index.ts` `NODE_ENGINES`; README; minor version bump.
- **Consumer:** pavilio change `2026-11-27-pocket-tts-engines`. Its full design and spike timings
  are in the workspace repo at
  `projects/pavilio/plans/openspec/changes/2026-11-27-pocket-tts-engines/design.md`.
