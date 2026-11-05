## MODIFIED Requirements

### Requirement: Keyed engines and the cascade are relay clients in the browser
Was: in the browser, `cascade`, every keyed engine and `openai` are relay clients. `openai`
requires `catalog`.
Is: `kokoro` is a relay client too, taking `{ relayUrl, firstByteMs?, stallMs? }`. Its voice checks
use the static Kokoro catalog, and it takes no `catalog`. Everything else is unchanged.

#### Scenario: A browser kokoro request
- **WHEN** a browser instance with `engines: { kokoro: { relayUrl: "/api/tts" } }` synthesizes `{ engine: "kokoro", text, voice: "af_heart", lang: "pl" }`
- **THEN** `/api/tts` receives `{ engine: "kokoro", text, voice: "af_heart", lang: "pl" }`

#### Scenario: A browser kokoro voice outside the catalog
- **WHEN** the same instance synthesizes `{ engine: "kokoro", text, voice: "my-voice" }`
- **THEN** it rejects `unknown-voice` without calling the relay

#### Scenario: Server-only kokoro fields stay out of the browser
- **WHEN** a browser instance configures `kokoro` with `baseUrl`, `apiKey` or `catalog`
- **THEN** `createTts` throws `RangeError`
