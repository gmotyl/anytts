# Proposal: Piper engine — a free, offline browser fallback

> **Status: proposal only** — deferred from the free-tts v1 grill (2026-10-14). Grill before
> design/tasks.

## Problem

The Edge engine depends on Microsoft: a token rotation (as on ~2026-10-10) or an Origin check on
browser sockets silences every consumer. Browsers cannot set Origin on a WebSocket, so the browser
path has no workaround of its own.

## Proposed direction

- A second **Engine**, `piper`, running Piper neural voices in the browser via WASM/ONNX.
- Returns audio bytes like Edge, so consumers' caches, MSE carriers and scrubbers keep working.
- Polish and English voices (`pl_PL-gosia`, `pl_PL-darkman`, an English pick); model downloaded once
  (~60 MB per voice) and cached by the browser.
- Appears in `listEngines()`; its voices in `listVoices("piper")`.

## Rejected alternatives (from the grill)

- Web Speech API (`speechSynthesis`): no audio bytes → no cache, no MSE, no unit scrubber; Polish
  voices depend on the OS.
- Kokoro-js: no Polish.

## Open questions for the grill

- Automatic fallback (Edge `rejected` → Piper) or only user choice in Settings?
- Model hosting (Hugging Face vs self-hosted) and download consent UX.
- Output format (WAV vs encoded) vs consumers' MSE expectations (`audio/mpeg`).
