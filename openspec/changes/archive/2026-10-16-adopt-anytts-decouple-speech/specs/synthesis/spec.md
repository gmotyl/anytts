# synthesis — delta for 2026-10-15-adopt-anytts-decouple-speech

Base: the `synthesis` delta of `2026-10-14-free-tts-v1` (not yet folded into `openspec/specs/`);
this delta stands alone and is folded after it.

## ADDED Requirements

### Requirement: A request's in-flight state is observable
`Tts.state(req)` answers `"ready"` when the request's key is cached, `"pending"` while it is
queued or running, and `"cold"` otherwise.

#### Scenario: Pending from the call until the result
- **WHEN** `synthesize` or `prefetch` is called for a key that is neither cached nor in flight
- **THEN** `state` answers `pending` synchronously after the call, whether the job is queued or
  already running, and `ready` once the result is cached.

#### Scenario: Back to cold on failure
- **WHEN** a pending request fails for good or is aborted with no caller left
- **THEN** `state` answers `cold` and `isCached` answers false.

#### Scenario: Unknown voice is cold
- **WHEN** `state` is asked about a voice outside the engine's catalog or an unconfigured engine
- **THEN** it answers `cold` without throwing.

### Requirement: Cache events report the in-flight lifecycle
`subscribe` listeners receive `{ type: "pending" | "add" | "drop" | "evict", key }`.

#### Scenario: A success
- **WHEN** a request enters the in-flight map and later lands
- **THEN** the listener receives exactly `pending` then `add` for that key.

#### Scenario: A final failure or abandonment
- **WHEN** a request leaves the in-flight map without a cached result
- **THEN** the listener receives `drop` for that key, once.

#### Scenario: Joins and retries are silent
- **WHEN** a second caller joins an in-flight key, a waiting job is promoted, or a transient failure
  is retried
- **THEN** no event is emitted for those steps.

#### Scenario: Eviction unchanged
- **WHEN** the LRU evicts a cached result
- **THEN** the listener receives `evict` as before.
