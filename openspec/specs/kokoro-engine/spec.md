# kokoro-engine

The `kokoro` engine: a Kokoro-FastAPI server with the built-in Kokoro-82M voice catalog.

### Requirement: The kokoro engine speaks to a Kokoro-FastAPI server with a built-in catalog
`anytts/server` registers the engine `kokoro`, configured as
`{ baseUrl, apiKey?, voices?, maxConcurrent?, pronunciation?, retries?, firstByteMs?, stallMs? }`.
It synthesizes with `POST {baseUrl}/v1/audio/speech`, body
`{ input, voice, model: "kokoro", response_format: "mp3" }`, and answers with the MP3 bytes.

#### Scenario: A plain request
- **GIVEN** a Node instance with `engines: { kokoro: { baseUrl: "http://127.0.0.1:8880" } }`
- **WHEN** `{ engine: "kokoro", text: "Hello", voice: "am_michael" }` is synthesized
- **THEN** one `POST http://127.0.0.1:8880/v1/audio/speech` is sent with body `{ input: "Hello", voice: "am_michael", model: "kokoro", response_format: "mp3" }` and no `authorization` header

#### Scenario: The language is never sent
- **WHEN** `{ engine: "kokoro", text, voice: "af_heart", lang: "pl" }` is synthesized
- **THEN** the body carries no language field and the request is sent

#### Scenario: Default voice
- **WHEN** the config sets no `voices` and a request names no voice, in any language
- **THEN** `af_heart` speaks it

#### Scenario: Engine-owned options are refused
- **WHEN** the config sets `catalog`, `model`, `languageField` or `extraBody`
- **THEN** `createTts` throws `RangeError`

#### Scenario: Missing or invalid address
- **WHEN** `baseUrl` is missing or not an `http(s)` URL
- **THEN** `createTts` throws `RangeError`

#### Scenario: A voice outside the catalog
- **WHEN** a request names `voice: "my-voice"`
- **THEN** it rejects `unknown-voice` without a network request

### Requirement: The kokoro engine behaves like openai for keys, concurrency and errors
`kokoro` reports `keyed: false`, defaults to `maxConcurrent: 1` and `firstByteMs: 30000`, and
classifies failures as the `openai` engine does.

#### Scenario: Cascade without a key
- **GIVEN** `cascade: { order: ["kokoro", "edge"] }` and `kokoro` without `apiKey`
- **WHEN** a cascade request runs
- **THEN** `kokoro` is tried first and `engineStatus("kokoro")` is not `no-key`

#### Scenario: The server is down
- **WHEN** nothing listens on `baseUrl`
- **THEN** the attempt rejects `TtsError{ kind: "network" }`, and in a cascade the next member is tried

#### Scenario: Cold start
- **WHEN** the config sets no `firstByteMs` and the server answers headers after 20 s
- **THEN** the attempt succeeds
