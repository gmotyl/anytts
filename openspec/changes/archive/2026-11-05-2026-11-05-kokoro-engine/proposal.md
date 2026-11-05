# Change: kokoro-engine

> Designed in the 2026-11-05 pavilio grill (Q1–Q8), session log
> `projects/pavilio/progress/2026-11-05-grill-kokoro-tts.md` in the workspace. Coordinated with
> the pavilio adoption under the same change id in
> `projects/pavilio/plans/openspec/changes/2026-11-05-kokoro-engine/`.

## Why

Kokoro-82M (Apache-2.0) runs locally behind Kokoro-FastAPI, which speaks OpenAI's
`POST /v1/audio/speech`. It is small and fast on a laptop, so it suits machines where OmniVoice is
too slow. The `openai` engine can already reach that endpoint, but an app has to bring a catalog,
and only one `openai` server can be configured per instance. A machine with OmniVoice and a machine
with Kokoro need different engines, each with its own catalog.

Kokoro's voices are fixed preset voicepacks with no cloning, so its catalog can ship in the
library, like the cloud engines' catalogs.

## What changes

- **New engine `kokoro`** in `anytts/server`. It is the `openai` engine with:
  - a static catalog (Kokoro-82M v1.0's 54 preset voices),
  - `model: "kokoro"`,
  - no `languageField`, because Kokoro-FastAPI picks the language from the voice prefix,
  - default voices `{ default: "af_heart" }`, Kokoro's only A-grade voice.

  Its options are `baseUrl` (required), `apiKey`, `firstByteMs` and `stallMs`.
- **Listed with its voices.** `listEngines()` includes
  `{ id: "kokoro", label: "Kokoro (local server)", runtimes: ["node"] }`, and
  `listVoices("kokoro")` returns the static catalog, so settings UIs work while the server is down.
- **A relay client in the browser.** In the browser, `kokoro` is a relay client like the keyed
  engines and `openai`. It takes `{ relayUrl, firstByteMs?, stallMs? }` and checks voices against
  the static catalog, so no `catalog` option is needed.
- **Release 0.7.0** (minor: new engine, no breaking change).

## Out of scope

- Kokoro-FastAPI's captioned-speech endpoint (word timestamps).
- Voice blending (`POST /v1/audio/voices/combine`).
- Any language gate. Every language is sent to the one configured voice. Kokoro has no Polish
  phonemizer, and the app decides whether that is good enough.
