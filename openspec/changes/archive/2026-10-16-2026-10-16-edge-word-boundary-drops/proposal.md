# Proposal: Edge dropped turns — word boundaries on, no permanent relay switch (0.2.1)

## Problem

Observed 2026-10-16 from a real Microsoft Edge browser (direct WebSocket to
`speech.platform.bing.com`, same plain sentence, 4 tries per configuration):

| `metadataoptions` (sentence / word) | turns with audio |
| ----------------------------------- | ---------------- |
| `false` / `false` (anytts 0.2.0)    | 2/4              |
| `false` / `true` (edge-tts-universal) | 4/4 (twice, also with its timestamp format and URL order) |
| `true` / `false`                    | 2/4              |

The failing turns get `turn.start` and `response`, then the socket closes with no audio
(browser close 1006). Only `wordBoundaryEnabled` matters.

anytts 0.2.0 then treated that close as `rejected` and, in `mode: "auto"`, moved the engine onto
the relay for the rest of its life: one dropped turn put an Edge browser on the server path.

## Change

1. `speech.config` sends `wordBoundaryEnabled: "true"` (sentence boundaries stay off) — a
   deliberate deviation from rany2/edge-tts. The engine skips the resulting `audio.metadata`
   text frames.
2. A turn that opens and then closes with no audio (a *dropped turn*) is retried once on a fresh
   connection. If it drops again, `auto` uses the relay for that call only. Only a refused
   handshake (the socket never opened) switches `auto` to the relay for good.

The public `TtsErrorKind` union is unchanged: a dropped turn still surfaces as `rejected`
(`direct` mode, or a relay-less engine), distinguished internally only.

## Out of scope

Sentence boundaries, exposing word-boundary timings to consumers.
