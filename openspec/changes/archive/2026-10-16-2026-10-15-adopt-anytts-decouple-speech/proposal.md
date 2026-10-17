# Proposal: observable in-flight state (anytts 0.2.0)

> Library half of pavilio's change `2026-10-15-adopt-anytts-decouple-speech` (grilled 2026-10-15,
> pavilio workspace `projects/pavilio/plans/openspec/changes/2026-10-15-adopt-anytts-decouple-speech/`).
> PR 1 of that change; released as `anytts@0.2.0` before the panel adopts the library.

## Problem

`Tts.isCached` is true only once a result is cached, and `subscribe` reports only `add` / `evict`.
A consumer that draws "requested but not yet in hand" — pavilio's segmented scrubber and ready pips
(`cold | warming | ready`) — cannot get that state from the library: the in-flight map is private
and nothing fires when a request enters or leaves it.

## Proposed change

Additive, minor bump to `0.2.0`:

- `Tts.state(req): "cold" | "pending" | "ready"` — `ready` when cached, `pending` when queued or
  running, `cold` otherwise (including unknown voice / engine, as `isCached` already answers).
- `subscribe` events gain `pending` (a key entered the in-flight map) and `drop` (it left without a
  result: final error, or abort with no callers left). `add` and `evict` unchanged; retries emit
  nothing in between.
- README section "Observing a request"; `isCached` kept as is.

## Out of scope

Streaming, progress per chunk, per-tier queue inspection.
