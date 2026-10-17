# edge-engine

Behavior of the `edge` engine's connection to Microsoft's Read Aloud endpoint.

### Requirement: The Edge engine authenticates with the Sec-MS-GEC v2 token
Every connection carries a `Sec-MS-GEC` value computed from the current (offset-corrected) time,
matching the reference implementation (rany2/edge-tts).

#### Scenario: Token matches the reference implementation
- **WHEN** the token is computed for each timestamp in the golden-vector fixture
- **THEN** it equals the value Python edge-tts produced for that timestamp, byte for byte

#### Scenario: Token works without Web Crypto
- **WHEN** the token is computed in an environment without `crypto.subtle`
- **THEN** it is still produced

### Requirement: The Edge engine runs in the browser and in Node
The engine opens its socket through an injectable transport; the default transport uses the global
`WebSocket`, passing Origin and User-Agent headers in Node.

#### Scenario: Node sends identifying headers
- **WHEN** the engine connects from Node with the default transport
- **THEN** the upgrade request carries the Edge extension `Origin` and a Microsoft Edge ≥ 137 `User-Agent` (the endpoint refuses every other User-Agent with 403)

#### Scenario: Browser connects without custom headers
- **WHEN** the engine connects in a browser with the default transport
- **THEN** it opens `new WebSocket(url)` with no headers argument

### Requirement: The Edge engine sends only SSML the endpoint accepts
The SSML body is `speak` > `voice` > `prosody` with XML-escaped text and no language hint.

#### Scenario: No language element or attribute is sent
- **WHEN** a request is made with `lang: "pl"`
- **THEN** the SSML contains no `<lang>` element and no `xml:lang` other than the fixed root value, and the language is expressed only by the chosen voice

#### Scenario: Markup characters in text are escaped
- **WHEN** the text contains `<`, `>` or `&`
- **THEN** they reach the endpoint escaped and the synthesis does not fail on them

### Requirement: The Edge engine requests word boundaries
`speech.config` sends `metadataoptions` `{ sentenceBoundaryEnabled: "false",
wordBoundaryEnabled: "true" }` (the service drops many turns without word boundaries).

#### Scenario: Word-boundary frames are not audio
- **WHEN** `Path:audio.metadata` text frames arrive between audio frames
- **THEN** the result holds only the audio bytes and resolves on `turn.end`

### Requirement: The Edge engine maps failures to typed errors within deadlines
An attempt ends as audio or as exactly one of `rejected`, `first-byte-timeout`, `stalled`,
`network`, `no-audio`.

#### Scenario: 403 settles instead of hanging
- **WHEN** the endpoint answers the upgrade with 403
- **THEN** the attempt ends `rejected` well within `firstByteMs`, and no socket is left open

#### Scenario: No first byte
- **WHEN** the socket opens but no audio arrives within `firstByteMs`
- **THEN** the attempt ends `first-byte-timeout` and the socket is closed

#### Scenario: Stall between chunks
- **WHEN** audio has started and the gap to the next chunk exceeds `stallMs`
- **THEN** the attempt ends `stalled` and the socket is closed

#### Scenario: Turn ends with no audio
- **WHEN** `turn.end` arrives and no audio bytes were received
- **THEN** the attempt ends `no-audio`

### Requirement: A rejected connection corrects clock skew once
On the first `rejected` of a synthesis, the engine adjusts its clock offset from the response's
`Date` header and retries once.

#### Scenario: Skewed clock recovers
- **GIVEN** the local clock is 10 minutes off and the first attempt is rejected with a `Date` header
- **WHEN** the engine retries with the corrected offset and the endpoint accepts it
- **THEN** `synthesize` resolves with audio

#### Scenario: Second rejection is final
- **WHEN** the retry after clock correction is also rejected
- **THEN** `synthesize` rejects with `TtsError{ kind: "rejected" }`

### Requirement: A dropped turn is retried once
A *dropped turn* is an attempt whose socket opened and then closed or errored before any audio. The
engine retries it once on a fresh connection.

#### Scenario: Retry succeeds
- **WHEN** the first attempt is a dropped turn and the retry streams audio
- **THEN** `synthesize` resolves with the retry's audio

#### Scenario: Second drop is final
- **WHEN** the retry is also a dropped turn
- **THEN** `synthesize` rejects with `TtsError{ kind: "rejected" }` after exactly two connections
