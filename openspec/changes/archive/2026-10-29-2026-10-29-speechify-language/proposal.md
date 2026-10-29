# Change: speechify-language

> Designed in the 2026-10-29 grill (Q1–Q5) after a live spike:
> `projects/anytts/progress/2026-10-29-speechify-polish-spike.md` in the workspace.

## Why

A Speechify multilingual voice reads Polish as English. The engine never sends Speechify's
`language` field, so the voice's own locale decides, and pavilio pins en-GB voices (`hugh_32`,
`edmund_32`) that bypass the `pl → kajetan` Voice map. The spike proved the fix: the same voice
with `language: "pl-PL"` speaks Polish (with its native US accent), while native pl-PL voices
are unaffected by the field. Engines cannot send it today because `Engine.synthesize` never
receives the request's language.

## What changes

- **Request language reaches the engine** — `Engine.synthesize` takes an optional `lang`; `Tts`
  passes the request's `lang` on direct and cascade paths. Additive: existing engines stay valid.
- **The member cache key includes `lang`** — `(engine, voice, lang, prepared text)` for every
  engine, so a language-aware engine never answers one language with another's audio.
- **The direct relay request carries `lang`** — `POST { engine?, text, voice, lang? }`; browser
  relay clients send it when the request has one.
- **Speechify sends `language`** only when the request language's base differs from the voice's
  locale, mapped to a full simba-3.5 locale (`pl → pl-PL`, `en → en-GB`); unknown languages send
  nothing.
- **Speechify catalog** gains the two missing native pl-PL stock voices, `dominika` and `michal`.

## Out of scope

- Cartesia and ElevenLabs reading `lang` (both have a language field; adopt later with a probe).
- Pavilio's pinned en-GB Speechify voice — `language` fixes the language, not the accent; a
  per-language pin is a pavilio question.
- SSML `<lang>`: undocumented by Speechify and stripped silently (spike evidence).

## Release

anytts 0.5.0 (additive feature).
