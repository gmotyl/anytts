## ADDED Requirements

### Requirement: The openai engine is listed with no static voices
`listEngines()` includes `{ id: "openai", label: "OpenAI-compatible (custom server)", runtimes: ["node"] }`.
`listVoices("openai")` returns `[]`, because the app supplies that engine's voices in its config
`catalog`.

#### Scenario: Engine list includes openai
- **WHEN** `listEngines()` is called
- **THEN** it contains an entry with `id: "openai"` and `runtimes` equal to `["node"]`

#### Scenario: No static openai voices
- **WHEN** `listVoices("openai")` is called
- **THEN** it returns an empty list
