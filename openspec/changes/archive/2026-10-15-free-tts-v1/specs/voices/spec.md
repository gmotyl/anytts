## ADDED Requirements

### Requirement: Engines are listed for a settings UI
`listEngines()` returns every engine the library ships with `{ id, label, runtimes }`.

#### Scenario: v1 engine list
- **WHEN** `listEngines()` is called
- **THEN** it returns exactly one entry with `id: "edge"` and `runtimes` containing `"browser"` and `"node"`

### Requirement: Voices are listed per engine
`listVoices(engineId)` returns that engine's static, curated catalog as
`{ id, label, locale, gender, multilingual }`; voices are never shared across engines.

#### Scenario: Edge catalog covers both apps' voices
- **WHEN** `listVoices("edge")` is called
- **THEN** it includes `pl-PL-MarekNeural`, `pl-PL-ZofiaNeural`, and every multilingual voice either app offers today, each with its locale and `multilingual` flag

#### Scenario: Unknown engine
- **WHEN** `listVoices("nope")` is called
- **THEN** it returns an empty list

### Requirement: Synthesis rejects a voice that does not belong to the engine
`synthesize` is strict about voice ownership and fails before any network work.

#### Scenario: Foreign voice
- **WHEN** `synthesize` is called with `engine: "edge"` and a `voice` not in the Edge catalog
- **THEN** it rejects `TtsError{ kind: "unknown-voice" }` without opening a socket

### Requirement: resolveVoice turns a saved choice into a valid voice for the chosen engine
`resolveVoice(tts, { engine, voice?, lang? })` returns `{ voice, fellBack }`.

#### Scenario: Saved voice belongs to the engine
- **WHEN** the saved voice is in the engine's catalog
- **THEN** it is returned with `fellBack: false`

#### Scenario: Engine switched under a saved voice
- **WHEN** the saved voice is not in the engine's catalog and `lang: "pl"` maps to a voice
- **THEN** the mapped `pl` voice is returned with `fellBack: true`

#### Scenario: Nothing usable saved
- **WHEN** no voice is saved and no `lang` is given
- **THEN** the engine's `default` voice is returned with `fellBack: false`
