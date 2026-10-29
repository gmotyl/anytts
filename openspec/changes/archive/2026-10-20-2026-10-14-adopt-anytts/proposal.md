# Proposal: request phase hooks and restart of a stalled attempt (for motyl's adoption)

> Coordinated change: same id as motyl.dev's `2026-10-14-adopt-anytts` (workspace
> `projects/motyl/plans/openspec/changes/2026-10-14-adopt-anytts/`). Grilled 2026-10-19 in the motyl
> session. Ships as **anytts 0.3.0**; motyl pins it.

## Problem

motyl's reader (the code anytts was extracted from) relies on two things 0.2.2 does not offer:

1. **Phase timings.** Its reader log records, per unit, how long the request waited in the queue and
   how long until the first audio byte (`onStart` / `onFirstByte` callbacks on its old client). Those
   two numbers are what sized its stall deadlines and what every `?readerlog=1` diagnosis reads.
2. **Restart on wake.** When the screen turns on while the reader is starved, it abandons a running
   attempt that has not delivered its first byte and starts the retry at once, instead of waiting out
   the 8 s first-byte deadline. Device logs showed the listener sitting through a dead attempt.

`signal` aborts the whole request (and drops the job when no caller is left); there is no way to
expire one *attempt* into its normal retry, and no way to observe queue/first-byte phases.

## What changes

- `synthesize` / `prefetch` requests accept optional **`onStart()`** and **`onFirstByte()`**,
  each called at most once per caller: when the job leaves the queue / receives its first audio
  chunk — or immediately when the joined job is already past that phase.
- **`tts.restartStalled(): boolean`** — if a running attempt has not delivered its first byte, it
  fails as `first-byte-timeout` now and goes through the normal transient-retry path (spending the
  retry budget exactly like the deadline would). Returns `false` when nothing runs or every running
  attempt already streams.
- The `Engine` interface gains an optional per-attempt hooks argument
  (`synthesize(text, voice, signal, hooks?: { onFirstByte?(): void })`); the Edge engine and its
  relay client call it on the first audio chunk.

Additive, minor bump (0.3.0). pavilio may ignore the new API.

## Not in scope

Per-request deadlines, a restart for already-streaming attempts, Piper.
