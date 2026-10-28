# relay — delta for cascade-engine

## MODIFIED Requirements

### Requirement: The Relay handler synthesizes on the server with an Edge identity
was: answers `POST { text, voice }` with the Edge engine only → is: with `tts` in its options it
serves every engine of that configuration — `POST { engine?, text, voice }` for one engine
(`engine` defaults to `edge`) and `POST { engine: "cascade", text, lang?, voices?, order?,
pronunciation? }` for the chain — and every `200` names the engine and voice that spoke.
`authorize` stays optional for every configuration.

#### Scenario: Successful relay
- **WHEN** a valid `POST { text, voice }` arrives
- **THEN** the response is `200` with `content-type: audio/mpeg`, the MP3 bytes,
  `x-anytts-engine: edge` and `x-anytts-voice: <voice>`, and the upstream handshake carried an
  Edge ≥ 137 User-Agent

#### Scenario: A keyed engine through the relay
- **GIVEN** a relay created with `tts` configuring `elevenlabs`
- **WHEN** `POST { engine: "elevenlabs", text, voice }` arrives
- **THEN** ElevenLabs synthesizes it and the response names `x-anytts-engine: elevenlabs`

#### Scenario: A cascade request
- **GIVEN** a relay created with `tts` configuring `cascade`
- **WHEN** `POST { engine: "cascade", text, lang: "pl" }` arrives and Azure serves it
- **THEN** the response is `200` with `x-anytts-engine: azure` and Azure's voice in `x-anytts-voice`

#### Scenario: Unknown voice
- **WHEN** `voice` is not in the requested engine's catalog, or `engine` is not configured
- **THEN** the response is `400` with JSON `{ "kind": "unknown-voice" }` and no upstream connection is made

#### Scenario: Text too long
- **WHEN** `text` exceeds `maxChars` (default 2000)
- **THEN** the response is `413` and no upstream connection is made

#### Scenario: Authorization hook refuses
- **WHEN** `authorize(request)` resolves `false`
- **THEN** the response is `403` and no upstream connection is made

#### Scenario: No authorization hook
- **WHEN** a relay serving keyed engines is created without `authorize`
- **THEN** creation succeeds and requests are served (the README warns about unguarded keyed relays)

#### Scenario: Upstream failure
- **WHEN** synthesis fails with a `TtsError`
- **THEN** the response is `502` with JSON `{ "kind": <that kind> }`, plus `retryAfter` and a
  `Retry-After` header when the kind is `rate-limited`

## ADDED Requirements

### Requirement: Keyed engines and the cascade are relay clients in the browser
In the browser, `cascade` and every keyed engine take only `{ relayUrl, firstByteMs? }`, POST the
request to the relay and report the engine and voice from the response headers.

#### Scenario: A browser cascade request
- **WHEN** a browser instance with `engines: { cascade: { relayUrl: "/api/tts" } }` synthesizes
  `{ engine: "cascade", text, lang: "pl", voices }`
- **THEN** `/api/tts` receives `{ engine: "cascade", text, lang, voices }` and the result's `engine`
  and `voice` equal the response's `x-anytts-engine` / `x-anytts-voice`

#### Scenario: Relay errors keep kind and wait
- **WHEN** the relay answers `502 { "kind": "rate-limited", "retryAfter": 30 }`
- **THEN** the browser attempt ends `TtsError{ kind: "rate-limited", retryAfter: 30 }`

#### Scenario: No key reaches the browser
- **WHEN** a browser instance is created with an `apiKey` on any engine
- **THEN** `createTts` throws `RangeError`, and the main `anytts` entry contains no keyed-engine
  synthesis code
