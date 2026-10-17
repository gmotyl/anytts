# relay

Server-side synthesis for browsers the endpoint refuses, and how the browser engine chooses it.

### Requirement: The Relay handler synthesizes on the server with an Edge identity
`createRelayHandler(options)` returns a Fetch-standard `(Request) => Promise<Response>` that runs the
Edge engine in Node and answers `POST { text, voice }` with the audio.

#### Scenario: Successful relay
- **WHEN** a valid `POST { text, voice }` arrives
- **THEN** the response is `200` with `content-type: audio/mpeg` and the MP3 bytes, and the upstream handshake carried an Edge ≥ 137 User-Agent

#### Scenario: Unknown voice
- **WHEN** `voice` is not in the Edge catalog
- **THEN** the response is `400` with JSON `{ "kind": "unknown-voice" }` and no upstream connection is made

#### Scenario: Text too long
- **WHEN** `text` exceeds `maxChars` (default 2000)
- **THEN** the response is `413` and no upstream connection is made

#### Scenario: Authorization hook refuses
- **WHEN** `authorize(request)` resolves `false`
- **THEN** the response is `403` and no upstream connection is made

#### Scenario: Upstream failure
- **WHEN** the Edge engine fails with a `TtsError`
- **THEN** the response is `502` with JSON `{ "kind": <that kind> }`

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
