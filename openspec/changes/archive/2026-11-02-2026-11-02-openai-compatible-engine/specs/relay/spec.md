## MODIFIED Requirements

### Requirement: Keyed engines and the cascade are relay clients in the browser
Was: in the browser, `cascade` and every keyed engine take only `{ relayUrl, firstByteMs? }`.
Is: in the browser, `cascade`, every keyed engine and `openai` are relay clients that take
`{ relayUrl, firstByteMs?, stallMs? }`. `openai` also requires `catalog: VoiceInfo[]`, and its
voice checks use that list. They POST the request to the relay and report the engine and voice
from the response headers. A direct request sends `lang` when the request has one.

#### Scenario: A browser openai request
- **WHEN** a browser instance with `engines: { openai: { relayUrl: "/api/tts", catalog: [pl-female] } }` synthesizes `{ engine: "openai", text, voice: "pl-female", lang: "pl" }`
- **THEN** `/api/tts` receives `{ engine: "openai", text, voice: "pl-female", lang: "pl" }`

#### Scenario: A browser openai voice outside the catalog
- **WHEN** the same instance synthesizes `{ engine: "openai", text, voice: "en-male" }`
- **THEN** it rejects `unknown-voice` without calling the relay

#### Scenario: A browser openai client needs its catalog
- **WHEN** a browser instance configures `openai: { relayUrl: "/api/tts" }` without `catalog`
- **THEN** `createTts` throws `RangeError`

#### Scenario: Server-only openai fields stay out of the browser
- **WHEN** a browser instance configures `openai` with `apiKey`, `baseUrl` or `extraBody`
- **THEN** `createTts` throws `RangeError`

#### Scenario: A browser cascade request
- **WHEN** a browser instance with `engines: { cascade: { relayUrl: "/api/tts" } }` synthesizes
  `{ engine: "cascade", text, lang: "pl", voices }`
- **THEN** `/api/tts` receives `{ engine: "cascade", text, lang, voices }` and the result's `engine`
  and `voice` equal the response's `x-anytts-engine` / `x-anytts-voice`

#### Scenario: A browser direct keyed request sends its language
- **WHEN** a browser instance with `engines: { speechify: { relayUrl: "/api/tts" } }` synthesizes
  `{ engine: "speechify", text, voice: "geffen_32", lang: "pl" }`
- **THEN** `/api/tts` receives `{ engine: "speechify", text, voice: "geffen_32", lang: "pl" }`

#### Scenario: Relay errors keep kind and wait
- **WHEN** the relay answers `502 { "kind": "rate-limited", "retryAfter": 30 }`
- **THEN** the browser attempt ends `TtsError{ kind: "rate-limited", retryAfter: 30 }`

#### Scenario: No key reaches the browser
- **WHEN** a browser instance is created with an `apiKey` on any engine
- **THEN** `createTts` throws `RangeError`, and the main `anytts` entry contains no keyed-engine
  code
