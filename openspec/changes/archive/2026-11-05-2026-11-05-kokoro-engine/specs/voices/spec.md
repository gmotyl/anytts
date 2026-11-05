## ADDED Requirements

### Requirement: The kokoro engine is listed with its static voices
`listEngines()` includes `{ id: "kokoro", label: "Kokoro (local server)", runtimes: ["node"] }`.
`listVoices("kokoro")` returns Kokoro-82M v1.0's 54 preset voices. Each voice's locale and gender
come from its id prefix (`a` en-US, `b` en-GB, `e` es-ES, `f` fr-FR, `h` hi-IN, `i` it-IT, `j` ja-JP,
`p` pt-BR, `z` zh-CN; second letter `f` female, `m` male), and `multilingual` is `false`.

#### Scenario: Engine list includes kokoro
- **WHEN** `listEngines()` is called
- **THEN** it contains an entry with `id: "kokoro"` and `runtimes` equal to `["node"]`

#### Scenario: Static kokoro voices
- **WHEN** `listVoices("kokoro")` is called
- **THEN** it returns 54 voices with unique ids, including `{ id: "af_heart", label: "Heart", locale: "en-US", gender: "female", multilingual: false }` and `{ id: "bm_george", locale: "en-GB", gender: "male" }`

#### Scenario: The list is a copy
- **WHEN** a caller mutates the returned list or a voice in it
- **THEN** a later `listVoices("kokoro")` is unchanged
