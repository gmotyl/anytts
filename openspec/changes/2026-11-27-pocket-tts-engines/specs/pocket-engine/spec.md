## ADDED Requirements

### Requirement: The pocket engines speak to a pocket-tts server and answer MP3
`anytts/server` registers `pocket` and `pocket-pl`, configured as
`{ baseUrl, voiceFilesUrl?, voices?, maxConcurrent?, pronunciation?, retries?, firstByteMs?, stallMs?, fetch? }`.
Each synthesizes with a multipart `POST {baseUrl}/tts` and answers with MP3 bytes encoded from the
WAV reply. Both report `keyed: false` and `strictVoiceMap: true`, and default to `maxConcurrent: 1`.

#### Scenario: A preset voice
- **GIVEN** a Node instance with `engines: { pocket: { baseUrl: "http://127.0.0.1:8890" } }`
- **WHEN** `{ engine: "pocket", text: "Hello", voice: "alba" }` is synthesized
- **THEN** one `POST http://127.0.0.1:8890/tts` is sent with form fields `text=Hello` and `voice_url=alba`, and the result is MP3 bytes starting with an MP3 frame sync

#### Scenario: A caller-supplied voice
- **GIVEN** `pocket-pl` configured with `voiceFilesUrl: "http://127.0.0.1:8892"` and `voices: [{ id: "piotr", label: "Piotr", gender: "male", version: 1764245000000 }]`
- **WHEN** `{ engine: "pocket-pl", text: "Cześć", voice: "piotr" }` is synthesized
- **THEN** `voice_url` is `http://127.0.0.1:8892/piotr/sample.wav?v=1764245000000`

#### Scenario: The Polish reference voice
- **WHEN** `{ engine: "pocket-pl", text: "Cześć" }` is synthesized with no voice configured
- **THEN** `shefowl` is the voice and the form carries no `voice_url`

#### Scenario: The language is never sent
- **WHEN** a request carries `lang: "pl"`
- **THEN** the form has only `text` and, where applicable, `voice_url`

#### Scenario: A caller voice without a voice-file address
- **WHEN** `voices` is non-empty and `voiceFilesUrl` is missing
- **THEN** `createTts` throws `RangeError`

#### Scenario: A voice outside the catalog
- **WHEN** a request names `voice: "nobody"`
- **THEN** it rejects `unknown-voice` without a network request

### Requirement: The pocket catalogs are presets plus caller voices, with the engine's locale
`pocket` lists the 27 preset voices of pocket-tts 4.0.1 (`alba`, `anna`, `azelma`, `bill_boerst`,
`caro_davy`, `charles`, `cosette`, `eponine`, `eve`, `fantine`, `george`, `jane`, `jean`, `javert`,
`marius`, `mary`, `michael`, `paul`, `peter_yearsley`, `stuart_bell`, `vera`, `giovanni`, `lola`,
`juergen`, `rafael`, `daan`, `estelle`), default `alba`. `pocket-pl` lists `shefowl`, default
`shefowl`. Caller `voices` are appended. Every voice of `pocket` has locale `en-US`, and every voice
of `pocket-pl` has locale `pl-PL`.

#### Scenario: Static catalog
- **WHEN** `listVoices("pocket")` is called
- **THEN** it returns the 27 presets, each `en-US`

#### Scenario: Caller voices take the engine's locale
- **WHEN** `pocket` is configured with a voice `piotr`
- **THEN** the instance lists `piotr` with locale `en-US`

### Requirement: The WAV reply is decoded without trusting its header sizes
The engine takes the PCM from the end of the `data` chunk header to the end of the bytes received,
whatever the RIFF and `data` sizes say. It reads the channel count, sample rate and bit depth from
`fmt `, and encodes 16-bit PCM to MP3 at 64 kbps. The encoder module is imported on the first
synthesis only.

#### Scenario: Streamed placeholder sizes
- **WHEN** the reply's header declares a `data` size of 2,000,000,000 but 96,000 bytes follow
- **THEN** 48,000 samples are encoded (2.0 s at 24 kHz) and no error is raised

#### Scenario: An odd trailing byte
- **WHEN** 96,001 bytes of PCM follow the header
- **THEN** the last byte is dropped

#### Scenario: No audio
- **WHEN** the reply has a header but no PCM bytes
- **THEN** it rejects `no-audio`

#### Scenario: Lazy encoder
- **WHEN** an instance with `pocket` configured is created and nothing is synthesized
- **THEN** the encoder module has not been imported

### Requirement: Pocket refusals map onto the existing error kinds
A 500 whose body mentions voice cloning or predefined voices is `unknown-voice`. Every other
refusal follows the shared rules: 5xx is `network`, anything else `rejected`. The first-byte and
stall deadlines apply as for every HTTP engine.

#### Scenario: English server without cloning weights
- **WHEN** the server answers `500` with "We could not download the weights for the model with voice cloning…"
- **THEN** it rejects `unknown-voice`, and a cascade moves to its next member

#### Scenario: Polish server asked for a preset
- **WHEN** `pocket-pl` receives `500` "Cannot use predefined voices…"
- **THEN** it rejects `unknown-voice`

#### Scenario: Server down
- **WHEN** the connection is refused
- **THEN** it rejects `network`

### Requirement: The browser reaches the pocket engines through the relay
`createTts` in the browser accepts `pocket` and `pocket-pl` only as relay clients. The registry
labels them "Pocket TTS (English)" and "Pocket TTS (Polish)".

#### Scenario: Browser config
- **WHEN** a browser instance is created with `engines: { pocket: { relay: "/api/tts" } }`
- **THEN** synthesis POSTs the relay with `engine: "pocket"`, and `listEngines()` labels it "Pocket TTS (English)"
