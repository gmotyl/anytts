# Change: openai-compatible-engine

> Designed in the 2026-11-02 grill (Q1–Q7), after the OmniVoice local spike:
> `projects/tts-providers/memo/2026-11-02_1831_omnivoice_local_spike.md` in the workspace,
> session log `projects/anytts/progress/2026-11-02-omnivoice-local-engine.md`.
> Coordinated with the pavilio adoption under the same change id in
> `projects/pavilio/plans/openspec/changes/2026-11-02-openai-compatible-engine/`.

## Why

OmniVoice (k2-fsa) now runs on the dev box behind a small server, `omnivoice-server`, that speaks
OpenAI's `POST /v1/audio/speech`. It is local, free, has no quota and speaks Polish. A clip takes
about 0.7 s for one sentence. anytts cannot reach it: every engine it ships is a fixed cloud
provider.

Many servers use the same request format, including Kokoro-FastAPI, openedai-speech and OpenAI
itself. So the engine is general: OmniVoice is one configuration of it, not an engine of its own.

## What changes

- **New engine `openai`** in `anytts/server`, for any server that speaks
  `POST {baseUrl}/v1/audio/speech`. Its options:
  - Required: `baseUrl` and `catalog: VoiceInfo[]`.
  - Optional: `apiKey`, `model` (default `"tts-1"`), `languageField` and `extraBody`.
  - It always asks for `response_format: "mp3"`.
- **The voice list comes from the app.** The library has no static voice list for `openai`, so
  `listVoices("openai")` returns `[]`. The app passes `catalog`, and every voice check uses it.
  `voices.default` must be in `catalog`.
- **Opt-in language field.** When `languageField` is set, the request language's base (`pl-PL`
  becomes `pl`) is sent under that name, but only when it differs from the voice's catalog locale.
  This follows the Speechify rule. When it is unset, the request is plain OpenAI.
- **Not keyed.** `keyed: false`, so the cascade never skips it for a missing key.
  `Authorization: Bearer` is sent only when `apiKey` is set. Defaults: `maxConcurrent: 1`,
  `firstByteMs: 15000`, because the server sends headers only after the whole clip is generated.
- **Relay client in the browser.** `openai` gets a browser relay client. Its voices come from the
  `catalog` in its config, not from the static `CATALOGS`.
- **Listed for settings.** `listEngines()` includes
  `{ id: "openai", label: "OpenAI-compatible (custom server)", runtimes: ["node"] }`.

## Out of scope

- Several OpenAI-compatible servers in one `Tts`: there is one fixed id, `openai`, and no `type`
  field.
- Fetching `/v1/voices`: it isn't part of OpenAI's API, and it carries no gender.
- Word timestamps and streaming: OmniVoice returns the whole clip with no boundaries.
- `speed`, `instructions` and other OpenAI fields beyond what `extraBody` can carry.
- Starting the server or managing its process: that belongs to the app.

## Release

anytts 0.6.0 (additive feature).
