## ADDED Requirements

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

### Requirement: Results are cached by engine, voice and text
Successful results are kept in an LRU cache (default 200 entries) keyed on (engine, voice, text).

#### Scenario: Cache hit makes no network request
- **WHEN** the same (engine, voice, text) is synthesized twice
- **THEN** the second call resolves from cache without opening a socket

#### Scenario: Failures are not cached
- **WHEN** a synthesis rejects with any error and the same request is made again
- **THEN** a new synthesis attempt is made

#### Scenario: Subscribers learn about cache changes
- **WHEN** an entry is added or evicted
- **THEN** every `subscribe` listener is called with the affected key

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
`rejected`, `first-byte-timeout`, `stalled`, `network`, `no-audio`, `unknown-voice`.

#### Scenario: Transient failures are retried
- **GIVEN** `retries: 1`
- **WHEN** the first attempt ends `first-byte-timeout`, `stalled` or `network` and the second succeeds
- **THEN** `synthesize` resolves with the second attempt's audio

#### Scenario: Retries are bounded
- **GIVEN** `retries: 1`
- **WHEN** two consecutive attempts end `stalled`
- **THEN** `synthesize` rejects with `TtsError{ kind: "stalled" }`

#### Scenario: Non-transient failures are not retried
- **WHEN** an attempt ends `no-audio` or `unknown-voice`
- **THEN** `synthesize` rejects with that kind after exactly one attempt
