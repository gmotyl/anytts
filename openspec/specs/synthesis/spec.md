# synthesis

The `Tts` instance: synthesis, voice choice, caching, scheduling, cancellation, failure contract and
observable request state; per-engine pronunciation and slots; the `cascade` engine and its skip
windows.

### Requirement: A Tts instance is created from configuration and holds no global state
`createTts(config)` returns an independent instance with its own cache and scheduler.

#### Scenario: Two instances do not share cache
- **WHEN** instance A synthesizes "hello" and instance B is asked `isCached` for the same request
- **THEN** B reports `false`

### Requirement: Synthesis returns the whole audio for one text
`synthesize({ text, lang?, voice?, engine?, tier?, signal? })` resolves with
`{ bytes: ArrayBuffer, mime: "audio/mpeg", engine, voice }`.

#### Scenario: Successful synthesis
- **WHEN** the engine delivers audio chunks and ends the turn
- **THEN** `synthesize` resolves with the concatenated bytes, the engine id and the voice actually used

#### Scenario: Default engine
- **WHEN** a request omits `engine`
- **THEN** the configured `defaultEngine` serves it

### Requirement: Voice is chosen as explicit voice, then the Voice map of the language, then default
The voice for a request is `voice ?? voices[lang] ?? voices.default` of the request's engine.

#### Scenario: Forced language picks the language's voice
- **WHEN** a request has `lang: "pl"` and no `voice`, and the engine's Voice map has `pl: "pl-PL-MarekNeural"`
- **THEN** the synthesis uses `pl-PL-MarekNeural`

#### Scenario: No language uses the default voice
- **WHEN** a request has neither `lang` nor `voice`
- **THEN** the synthesis uses the engine's `default` voice

#### Scenario: Explicit voice wins
- **WHEN** a request has `lang: "pl"` and `voice: "en-US-AndrewMultilingualNeural"`
- **THEN** the synthesis uses `en-US-AndrewMultilingualNeural`

#### Scenario: Language without a mapped voice
- **WHEN** a request has `lang: "de"` and the Voice map has no `de` entry
- **THEN** the synthesis uses the engine's `default` voice

### Requirement: Results are cached by engine, voice, language and text
Successful results are kept in an LRU cache (default 200 entries) keyed on (engine, voice, Request
language, prepared text), for every engine, where the Request language is the request's `lang` or
none, and the prepared text is the request text after the engine's pronunciation step (unchanged text when the
step is off).

#### Scenario: Cache hit makes no network request
- **WHEN** the same (engine, voice, lang, text) is synthesized twice
- **THEN** the second call resolves from cache without opening a connection

#### Scenario: Failures are not cached
- **WHEN** a synthesis rejects with any error and the same request is made again
- **THEN** a new synthesis attempt is made

#### Scenario: Subscribers learn about cache changes
- **WHEN** an entry is added or evicted
- **THEN** every `subscribe` listener is called with the affected key

#### Scenario: Pronunciation on and off do not share an entry
- **WHEN** the same Polish text is synthesized on `edge` with `pronunciation: true` and on
  `elevenlabs` with `pronunciation: false`
- **THEN** two cache entries exist, each keyed on the text that engine actually received

#### Scenario: Different languages do not share an entry
- **WHEN** the same text and voice are synthesized once with `lang: "pl"` and once without `lang`
- **THEN** two synthesis attempts are made and two cache entries exist

## ADDED Requirements

### Requirement: A request's in-flight state is observable
`Tts.state(req)` answers `"ready"` when the request's key is cached, `"pending"` while it is
queued or running, and `"cold"` otherwise.

#### Scenario: Pending from the call until the result
- **WHEN** `synthesize` or `prefetch` is called for a key that is neither cached nor in flight
- **THEN** `state` answers `pending` synchronously after the call, whether the job is queued or
  already running, and `ready` once the result is cached

#### Scenario: Back to cold on failure
- **WHEN** a pending request fails for good or is aborted with no caller left
- **THEN** `state` answers `cold` and `isCached` answers false

#### Scenario: Unknown voice is cold
- **WHEN** `state` is asked about a voice outside the engine's catalog or an unconfigured engine
- **THEN** it answers `cold` without throwing

### Requirement: Cache events report the in-flight lifecycle
`subscribe` listeners receive `{ type: "pending" | "add" | "drop" | "evict", key }`.

#### Scenario: A success
- **WHEN** a request starts being synthesized and later lands
- **THEN** the listener receives exactly `pending` then `add` for that key

#### Scenario: A final failure or abandonment
- **WHEN** a request stops being in flight without a cached result
- **THEN** the listener receives `drop` for that key, once

#### Scenario: Joins and retries are silent
- **WHEN** a second caller joins an in-flight key, a waiting job is promoted, or a transient failure
  is retried
- **THEN** no event is emitted for those steps

#### Scenario: Eviction
- **WHEN** the LRU evicts a cached result
- **THEN** the listener receives `evict`

### Requirement: Synthesis is scheduled by ordered tiers with cumulative caps
Jobs wait in tiers ordered most-important first. A tier's `cap` limits jobs in flight from that tier
and all tiers below it; `concurrency` limits all jobs. A freed slot goes to the highest tier with
waiting work whose cap allows it.

#### Scenario: Speculative work never takes the run's last slot
- **GIVEN** `concurrency: 3`, tiers `run`, `warm` (cap 2), `preload`
- **WHEN** two `preload` jobs are in flight and a third `preload` and one `warm` are waiting
- **THEN** neither waiting job starts, and a `run` job enqueued now starts immediately

#### Scenario: Higher tier first
- **GIVEN** `concurrency: 1`, tiers `play`, `warm`
- **WHEN** a `warm` job and then a `play` job are waiting and the slot frees
- **THEN** the `play` job starts first

### Requirement: Duplicate requests join and promote
A request whose key is already queued or in flight shares that job; a higher tier promotes it.

#### Scenario: Join in flight
- **WHEN** a request arrives for a key already being synthesized
- **THEN** no second socket is opened and both callers receive the same result

#### Scenario: Promotion
- **WHEN** a queued `warm` job is requested again with tier `play`
- **THEN** the job moves to the `play` tier and is ordered there by its original enqueue time

### Requirement: Callers can abort with an AbortSignal
Aborting detaches one caller; the job stops only when no callers remain.

#### Scenario: Abort a queued job
- **WHEN** the only caller of a queued job aborts
- **THEN** the job leaves the queue and the caller rejects with `AbortError`

#### Scenario: Abort an in-flight job
- **WHEN** the only caller of an in-flight job aborts
- **THEN** its socket is closed, the slot is freed, and the caller rejects with `AbortError`

#### Scenario: Shared job survives one abort
- **WHEN** one of two callers of an in-flight job aborts
- **THEN** that caller rejects with `AbortError` and the other still receives the audio

### Requirement: Every synthesis settles with audio or a typed error
`synthesize` never hangs; failures reject with `TtsError{ kind }` where kind is one of
`rejected`, `first-byte-timeout`, `stalled`, `network`, `no-audio`, `unknown-voice`,
`quota-exhausted`, `unauthorized` and `rate-limited`; `TtsError` carries `retryAfter?`
(seconds) for `rate-limited`. The three new kinds are not retried on the same engine.

#### Scenario: Transient failures are retried
- **GIVEN** `retries: 1`
- **WHEN** the first attempt ends `first-byte-timeout`, `stalled` or `network` and the second succeeds
- **THEN** `synthesize` resolves with the second attempt's audio

#### Scenario: Retries are bounded
- **GIVEN** `retries: 1`
- **WHEN** two consecutive attempts end `stalled`
- **THEN** `synthesize` rejects with `TtsError{ kind: "stalled" }`

#### Scenario: Non-transient failures are not retried
- **WHEN** an attempt ends `no-audio`, `unknown-voice`, `quota-exhausted`, `unauthorized` or `rate-limited`
- **THEN** `synthesize` rejects with that kind after exactly one attempt

#### Scenario: A rate limit carries its wait
- **WHEN** an engine answers HTTP 429 with `Retry-After: 30`
- **THEN** the rejection is `TtsError{ kind: "rate-limited", retryAfter: 30 }`

### Requirement: The library applies the Pronunciation map per engine
An engine entry's `pronunciation` (default `true` for `edge`, `false` otherwise) decides whether
the request text passes `applyPronunciation(text, lang, config.pronunciation)` before synthesis.

#### Scenario: Edge gets the Polish preset
- **WHEN** `edge` has the default `pronunciation` and a request has `lang: "pl"`
- **THEN** the text Edge receives has the `pl` preset applied

#### Scenario: A keyed engine speaks the text as written
- **WHEN** `elevenlabs` has the default `pronunciation` and a request has `lang: "pl"`
- **THEN** the text ElevenLabs receives is the request text unchanged

#### Scenario: No language, no map
- **WHEN** a request has no `lang`
- **THEN** no map is applied, whatever the flag

### Requirement: Each engine runs at most maxConcurrent attempts
An engine entry's `maxConcurrent` (defaults: azure 1, cartesia 2, elevenlabs 2, speechify 2, edge
unlimited) caps that engine's attempts in flight; a job waits for an engine slot in tier order.

#### Scenario: Azure runs one at a time
- **WHEN** two `azure` jobs are scheduled together
- **THEN** the second attempt starts only after the first settles

#### Scenario: A busy engine does not block another
- **WHEN** `azure`'s slot is taken and an `edge` job is scheduled
- **THEN** the `edge` job starts without waiting

### Requirement: The cascade tries member engines in order
`engines.cascade = { order }` creates the `cascade` engine. A cascade request (`lang?`, `voices?`,
`order?`, `pronunciation?`, no `voice`) is served by the first member in the effective order that
can serve it; the result reports that member's `engine` and `voice`.

#### Scenario: The first member speaks
- **GIVEN** `order: ["elevenlabs", "edge"]` and both configured with keys where needed
- **WHEN** a cascade request with `lang: "pl"` succeeds on ElevenLabs
- **THEN** it resolves with `engine: "elevenlabs"` and ElevenLabs' `pl` voice, and Edge is not called

#### Scenario: A member without a key is skipped
- **GIVEN** `order: ["cartesia", "edge"]` and `cartesia` without `apiKey`
- **WHEN** a cascade request runs
- **THEN** Cartesia is not called and Edge serves it

#### Scenario: Per-request voices
- **WHEN** a cascade request carries `voices: { elevenlabs: "V1" }` and ElevenLabs serves it
- **THEN** ElevenLabs synthesizes with `V1`; a member without an entry uses its Voice map by `lang`

#### Scenario: Per-request order
- **GIVEN** configured `order: ["elevenlabs", "azure", "edge"]`
- **WHEN** a request carries `order: ["azure", "edge"]`
- **THEN** ElevenLabs is not tried for that request

#### Scenario: Per-request pronunciation
- **WHEN** a request carries `pronunciation: { edge: false }` and Edge serves it
- **THEN** Edge receives the text without the map

#### Scenario: A cached member answers first
- **GIVEN** the unit is cached under `azure`'s key and not under `elevenlabs`'
- **WHEN** a cascade request with `order: ["elevenlabs", "azure"]` runs
- **THEN** it resolves from the `azure` entry without any network request

#### Scenario: A busy member is waited for
- **GIVEN** `azure` first in the order with its one slot taken
- **WHEN** a cascade request runs
- **THEN** it waits for Azure's slot and does not move to the next member

#### Scenario: A spent member's cached results still answer
- **GIVEN** `elevenlabs` in a skip window and the unit cached under its key
- **WHEN** a cascade request runs
- **THEN** it resolves from the `elevenlabs` entry without any network request

#### Scenario: Invalid configuration
- **WHEN** `cascade.order` names an unconfigured engine or `cascade` itself, or `cascade` has `voices`
- **THEN** `createTts` throws `RangeError`

#### Scenario: A single voice is refused
- **WHEN** a cascade request carries `voice`
- **THEN** it rejects `TtsError{ kind: "unknown-voice" }` without synthesizing

### Requirement: A failing member opens a skip window and the cascade moves on
`quota-exhausted` skips the member until 00:00 UTC on the 1st of next month, `unauthorized` for
the life of the instance, `rate-limited` for `retryAfter` seconds or 60; transient failures after
retries, `no-audio` and `rejected` move on without a window; `unknown-voice` and abort stop the
chain. Windows are in memory, per instance.

#### Scenario: Quota exhausted
- **GIVEN** `order: ["elevenlabs", "edge"]`
- **WHEN** ElevenLabs rejects `quota-exhausted` on 2026-11-12
- **THEN** Edge serves this request, and ElevenLabs is not called again until 2026-12-01T00:00Z

#### Scenario: Rate limited
- **WHEN** Azure rejects `rate-limited` with `retryAfter: 30`
- **THEN** the next member serves the request and Azure is passed over for 30 s

#### Scenario: Transient failure moves on without a window
- **WHEN** Cartesia's attempts end `network` after retries
- **THEN** the next member serves the request and the next cascade request tries Cartesia again

#### Scenario: Unknown voice does not switch
- **WHEN** the serving member rejects `unknown-voice`
- **THEN** the cascade request rejects `unknown-voice` and no other member is called

#### Scenario: Every member fails
- **WHEN** every member in the effective order is skipped or fails
- **THEN** the request rejects with the last attempted member's error, or — when none was
  attempted — the skip reason of the last skipped member; earlier members' errors are on its
  `cause` as an array

#### Scenario: A queued member job rechecks its window
- **GIVEN** two cascade requests waiting on Azure's one slot
- **WHEN** the first gets `quota-exhausted` before the second's attempt starts
- **THEN** the second passes Azure over with no request and moves to the next member

#### Scenario: A later refusal never shortens a window
- **WHEN** a member in a `quota-exhausted` window later rejects `rate-limited` with `retryAfter: 30`
- **THEN** the window stays `quota-exhausted` until the 1st of next month

#### Scenario: A direct refusal opens the window without blocking direct requests
- **WHEN** a direct `elevenlabs` request rejects `quota-exhausted`
- **THEN** `engineStatus("elevenlabs")` is `quota-exhausted` and cascades skip it, while the next
  direct `elevenlabs` request is still sent

### Requirement: An engine's availability is observable
`tts.engineStatus(id)` reports `ready`, `no-key`, or the open skip window's kind with its `until`.

#### Scenario: A spent member
- **WHEN** ElevenLabs rejected `quota-exhausted` on 2026-11-12
- **THEN** `engineStatus("elevenlabs")` is `{ state: "quota-exhausted", until: "2026-12-01T00:00:00.000Z" }`

#### Scenario: A member without a key
- **WHEN** `speechify` has no `apiKey`
- **THEN** `engineStatus("speechify")` is `{ state: "no-key" }`

### Requirement: A browser caches a cascade result under its member and its alias
In the browser, a cascade result is cached under the member key from the relay's headers and under
the alias `(cascade, lang, optionsHash, text)`; `state` and `isCached` on a cascade request read the
alias.

#### Scenario: The alias is ready after a relay answer
- **WHEN** a cascade request is answered by the relay with `x-anytts-engine: azure`
- **THEN** `state` of the same cascade request is `ready` and the `azure` member key is cached too

#### Scenario: Changing a member voice misses the alias
- **WHEN** the same text is requested again with a different `voices` entry
- **THEN** `state` is `cold` and a new relay request is made

#### Scenario: A relay answer never overwrites a member entry
- **WHEN** the member key named by the relay's headers is already cached
- **THEN** the existing entry is kept and only the alias is stored

#### Scenario: The browser cascade does not retry by default
- **WHEN** a browser cascade request fails at the relay
- **THEN** it rejects after one relay request, since the relay already walked the chain

#### Scenario: Evicting the member drops the alias
- **WHEN** the member entry is evicted
- **THEN** the alias reads `cold`

### Requirement: The Request language reaches the engine
`Engine.synthesize(text, voice, signal, hooks?, lang?)` receives the request's `lang` unchanged, on
the direct path and for every cascade member; an engine may ignore it.

#### Scenario: Direct request
- **WHEN** `synthesize({ engine: "speechify", text, lang: "pl" })` runs
- **THEN** the Speechify engine's `synthesize` is called with `lang` `"pl"`

#### Scenario: Cascade member
- **WHEN** a cascade request with `lang: "pl"` reaches a member
- **THEN** that member's `synthesize` is called with `lang` `"pl"`

#### Scenario: No language
- **WHEN** a request has no `lang`
- **THEN** the engine's `synthesize` is called with `lang` `undefined`

## MODIFIED Requirements
