# Delta — synthesis (phase hooks, restartStalled)

## ADDED Requirements

### Requirement: Callers can observe the start and first byte of their request
`synthesize` and `prefetch` accept optional `onStart()` and `onFirstByte()`, each called at most once
per caller.

#### Scenario: Phases of a fresh request
- **WHEN** a request is queued, then its job starts, then the engine delivers the first audio chunk
- **THEN** `onStart` is called when the job starts and `onFirstByte` when the chunk arrives, in that
  order, once each.

#### Scenario: A late joiner learns passed phases
- **WHEN** a second caller joins a job that already started and already received audio
- **THEN** both of its hooks are called promptly (asynchronously after the call returns).

#### Scenario: A cache hit
- **WHEN** the request is already cached
- **THEN** both hooks are called and the request resolves with the cached result.

#### Scenario: A retry does not re-fire hooks
- **WHEN** the first attempt fails transiently after its first byte and the retry succeeds
- **THEN** each hook was called exactly once.

#### Scenario: A throwing hook does not fail synthesis
- **WHEN** a caller's hook throws
- **THEN** the synthesis still resolves for every caller.

### Requirement: A running attempt with no audio yet can be restarted
`tts.restartStalled()` fails every running attempt that has not delivered its first byte as
`first-byte-timeout`, through the normal transient-retry path.

#### Scenario: Restart before the first byte
- **WHEN** an attempt is running with no audio yet, retry budget remains, and `restartStalled()` is
  called
- **THEN** it returns `true`, the attempt's engine call is aborted, and a new attempt starts at once.

#### Scenario: Restart of the last attempt
- **WHEN** the running attempt is already the final retry
- **THEN** the request rejects with `TtsError{kind:'first-byte-timeout'}`.

#### Scenario: Nothing to restart
- **WHEN** nothing is running, or every running attempt already delivered audio
- **THEN** it returns `false` and nothing changes.

#### Scenario: A caller abort still wins
- **WHEN** the job's only caller aborts while a restarted attempt is running
- **THEN** the caller rejects with `AbortError`, not `first-byte-timeout`.
