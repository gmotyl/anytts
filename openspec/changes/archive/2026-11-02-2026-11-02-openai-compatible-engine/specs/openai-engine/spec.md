## ADDED Requirements

### Requirement: The openai engine speaks OpenAI's speech API to an app-configured server
`anytts/server` registers the engine `openai`. It is configured as
`{ baseUrl, catalog, apiKey?, model?, languageField?, extraBody?, voices?, maxConcurrent?, pronunciation?, retries?, firstByteMs?, stallMs? }`
and synthesizes with `POST {baseUrl}/v1/audio/speech`, answering with the MP3 bytes.

#### Scenario: A plain request
- **GIVEN** a Node instance with `engines: { openai: { baseUrl: "http://127.0.0.1:8890", catalog: [en-female (en-GB)] } }`
- **WHEN** `{ engine: "openai", text: "Hello", voice: "en-female" }` is synthesized
- **THEN** one `POST http://127.0.0.1:8890/v1/audio/speech` is sent with body `{ input: "Hello", voice: "en-female", model: "tts-1", response_format: "mp3" }` and no `authorization` header, and the result is the response's bytes

#### Scenario: A trailing slash in baseUrl
- **WHEN** `baseUrl` is `"http://127.0.0.1:8890/"`
- **THEN** the request URL is `http://127.0.0.1:8890/v1/audio/speech`

#### Scenario: An API key is sent as Bearer
- **WHEN** the config sets `apiKey: "sk-test"`
- **THEN** the request carries `authorization: Bearer sk-test`

#### Scenario: Extra body fields are merged but cannot override the fixed fields
- **WHEN** the config sets `extraBody: { num_step: 16, model: "x", input: "y" }`
- **THEN** the body carries `num_step: 16`, while `model`, `input`, `voice` and `response_format` keep the engine's values

#### Scenario: A custom model
- **WHEN** the config sets `model: "gpt-4o-mini-tts"`
- **THEN** the body carries `model: "gpt-4o-mini-tts"`

### Requirement: The openai engine's voices come from the app catalog
The engine has no static catalog. Its voices are exactly the config's `catalog`, and every voice
check uses that list.

#### Scenario: A voice outside the catalog
- **WHEN** a request names `voice: "auto"` and `catalog` has no `auto`
- **THEN** it rejects `unknown-voice` without a network request

#### Scenario: The default voice must be in the catalog
- **WHEN** `voices: { default: "nope" }` and `catalog` has no `nope`
- **THEN** `createTts` throws `RangeError`

#### Scenario: Without a voice map the first catalog voice is the default
- **WHEN** the config sets no `voices` and `catalog` is `[pl-female, en-female]`
- **THEN** a request with no voice and no matching language speaks `pl-female`

#### Scenario: Missing configuration
- **WHEN** `baseUrl` is missing or not an `http(s)` URL, or `catalog` is missing, empty or holds a duplicate id
- **THEN** `createTts` throws `RangeError`

### Requirement: The openai engine names the language only when configured and the voice speaks another
When `languageField` is set and the base of the request language (the part before `-`,
lowercased) differs from the base of the voice's catalog locale, the body carries that base under
`languageField`. Otherwise no language field is sent.

#### Scenario: An English voice reads Polish
- **GIVEN** `languageField: "language"` and voice `en-female` with locale `en-GB`
- **WHEN** `{ text, voice: "en-female", lang: "pl-PL" }` is synthesized
- **THEN** the body carries `language: "pl"`

#### Scenario: The voice already speaks the language
- **GIVEN** `languageField: "language"` and voice `pl-female` with locale `pl-PL`
- **WHEN** `{ text, voice: "pl-female", lang: "pl" }` is synthesized
- **THEN** the body carries no `language` field

#### Scenario: No languageField
- **WHEN** `languageField` is unset and the request has `lang: "pl"` for an `en-GB` voice
- **THEN** the body carries no language field

### Requirement: The openai engine is not keyed and runs one attempt at a time by default
The engine reports `keyed: false`, so the cascade never skips it for a missing key. Its defaults
are `maxConcurrent: 1` and `firstByteMs: 15000`.

#### Scenario: Cascade without a key
- **GIVEN** a Node instance with `cascade: { order: ["openai", "edge"] }` and `openai` without `apiKey`
- **WHEN** a cascade request runs
- **THEN** `openai` is tried first and `engineStatus("openai")` is not `no-key`

#### Scenario: Concurrency default
- **WHEN** two requests for `openai` are queued and the config sets no `maxConcurrent`
- **THEN** the second attempt starts only after the first settles

### Requirement: The openai engine classifies failures into error kinds
Failures map to the shared error kinds. A refused connection, a network failure or a 5xx gives
`network`. 401 gives `unauthorized`, 429 gives `rate-limited` (with `retryAfter`), and any other
4xx gives `rejected`. A refusal is never `quota-exhausted`.

#### Scenario: The server is down
- **WHEN** nothing listens on `baseUrl`
- **THEN** the attempt rejects `TtsError{ kind: "network" }`, and in a cascade the next member is tried

#### Scenario: A bad request
- **WHEN** the server answers `400 { "detail": "unknown voice" }`
- **THEN** the attempt rejects `TtsError{ kind: "rejected", status: 400 }`
