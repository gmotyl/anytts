# relay

Server-side synthesis for browsers the endpoint refuses and for keyed engines, and how browser
engines reach it.

### Requirement: The Relay handler synthesizes on the server with an Edge identity
`createRelayHandler(options)` returns a Fetch-standard `(Request) => Promise<Response>`. Without
`tts` it runs the Edge engine in Node and answers `POST { text, voice }`; with `tts` in its options it
serves every engine of that configuration — `POST { engine?, text, voice }` for one engine
(`engine` defaults to `edge`) and `POST { engine: "cascade", text, lang?, voices?, order?,
pronunciation? }` for the chain — and every `200` names the engine and voice that spoke. `tts` is
a `TtsConfig` or a shared `Tts` instance. `authorize` stays optional for every configuration.

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

#### Scenario: A shared instance reports the relay's skip windows
- **GIVEN** a relay created with `tts` set to a `Tts` instance whose cascade lists ElevenLabs first
- **WHEN** a cascade request through the relay gets ElevenLabs' quota refusal
- **THEN** `instance.engineStatus("elevenlabs")` on the consumer's side is `quota-exhausted`

#### Scenario: Unknown voice
- **WHEN** `voice` is not in the requested engine's catalog, or `engine` is not configured
- **THEN** the response is `400` with JSON `{ "kind": "unknown-voice" }` and no upstream connection is made

#### Scenario: Empty cascade order
- **WHEN** a cascade request's effective `order` is empty
- **THEN** the response is `400` and no upstream connection is made

#### Scenario: Engine headers are readable cross-origin
- **WHEN** any `200` is returned
- **THEN** it carries `access-control-expose-headers` naming `x-anytts-engine` and `x-anytts-voice`

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

### Requirement: The Relay handler mounts in Node HTTP servers
`toNodeHandler(handler)` adapts the Fetch handler to `(req, res)` for Express and `node:http`.

#### Scenario: Express route
- **WHEN** the adapted handler is mounted on an Express `POST` route and called
- **THEN** the HTTP response matches what the Fetch handler returned (status, headers, body)

### Requirement: The browser engine chooses direct or relay
The `edge` engine accepts `relayUrl` and `mode: "auto" | "direct" | "relay"`; the default is
`auto` when `relayUrl` is set and `direct` otherwise. Node is always direct.

#### Scenario: Auto in Edge goes direct
- **GIVEN** `mode: "auto"` and `navigator.userAgent` of Edge 143
- **WHEN** a synthesis runs
- **THEN** a WebSocket is opened to Microsoft and the relay is not called

#### Scenario: Auto in Chrome goes through the relay
- **GIVEN** `mode: "auto"` and `navigator.userAgent` of Chrome 143
- **WHEN** a synthesis runs
- **THEN** `relayUrl` receives `POST { text, voice }` and no WebSocket is opened

#### Scenario: Auto falls back to relay after a refused handshake
- **GIVEN** `mode: "auto"` in Edge and a direct attempt whose handshake is refused
- **WHEN** this and every later synthesis of the instance runs
- **THEN** it goes through the relay

#### Scenario: A dropped turn does not switch auto to the relay
- **GIVEN** `mode: "auto"` in Edge and a direct synthesis whose turn drops twice
- **WHEN** that synthesis runs
- **THEN** it goes through the relay for that call only, and the next synthesis goes direct

#### Scenario: Relay errors keep their kind
- **WHEN** the relay answers `502 { "kind": "stalled" }`
- **THEN** the browser attempt ends `TtsError{ kind: "stalled" }` and the normal retry rules apply

#### Scenario: Relay deadlines
- **WHEN** the relay sends no response headers within `firstByteMs`
- **THEN** the attempt ends `first-byte-timeout`

#### Scenario: Mode does not change identity
- **WHEN** the same text and voice are synthesized once direct and once through the relay
- **THEN** both use the same cache key and report `engine: "edge"`

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
