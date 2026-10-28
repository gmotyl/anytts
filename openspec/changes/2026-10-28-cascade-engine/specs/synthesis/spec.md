# synthesis — delta for cascade-engine

## MODIFIED Requirements

### Requirement: Every synthesis settles with audio or a typed error
was: kinds `rejected`, `first-byte-timeout`, `stalled`, `network`, `no-audio`, `unknown-voice` →
is: plus `quota-exhausted`, `unauthorized` and `rate-limited`; `TtsError` carries `retryAfter?`
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

### Requirement: Results are cached by engine, voice and text
was: keyed on (engine, voice, text) → is: keyed on (engine, voice, prepared text), where the
prepared text is the request text after the engine's pronunciation step (unchanged text when the
step is off).

#### Scenario: Cache hit makes no network request
- **WHEN** the same (engine, voice, text) is synthesized twice
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

## ADDED Requirements

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
  attempted — the skip reason of the last skipped member

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

#### Scenario: Evicting the member drops the alias
- **WHEN** the member entry is evicted
- **THEN** the alias reads `cold`
