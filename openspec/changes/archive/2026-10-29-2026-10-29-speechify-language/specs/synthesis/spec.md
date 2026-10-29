## ADDED Requirements

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

### Requirement: Results are cached by engine, voice, language and text
Was: keyed on (engine, voice, prepared text). Is: successful results are kept in an LRU cache
(default 200 entries) keyed on (engine, voice, Request language, prepared text), where the
Request language is the request's `lang` or none, and the prepared text is the request text after
the engine's pronunciation step (unchanged text when the step is off). This holds for every engine.

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
