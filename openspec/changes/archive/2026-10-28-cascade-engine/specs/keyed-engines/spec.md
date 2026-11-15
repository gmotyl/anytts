# keyed-engines — delta for cascade-engine

New capability: the engines that need an API key — ElevenLabs, Cartesia, Speechify and Azure F0.

## ADDED Requirements

### Requirement: Keyed engines share one configuration shape and run in Node only
`elevenlabs`, `cartesia`, `speechify` and `azure` are configured as
`{ apiKey?, voices?, maxConcurrent?, pronunciation?, retries? }` plus engine fields (`azure`:
`region`), and are registered by `anytts/server` only.

#### Scenario: A keyed engine on its own
- **GIVEN** a Node instance with `engines: { cartesia: { apiKey } }`
- **WHEN** `{ engine: "cartesia", text, lang: "en" }` is synthesized
- **THEN** it resolves with Cartesia's audio in Cartesia's `en` voice

#### Scenario: Missing key used directly
- **WHEN** a keyed engine without `apiKey` serves a direct request
- **THEN** it rejects `unauthorized` without a network request

#### Scenario: Azure needs a region
- **WHEN** `azure` has `apiKey` but no `region`
- **THEN** `createTts` throws `RangeError`

### Requirement: Each keyed engine ships a stock catalog and default Voice maps
`listEngines()` lists each keyed engine with `runtimes: ["node"]`, and `cascade` with
`["browser", "node"]`; `listVoices(id)` returns the provider's stock voices; each keyed engine's
default Voice map has `pl`, `en` and `default` entries from that catalog.

#### Scenario: Catalogs are listed
- **WHEN** `listVoices("azure")` is called
- **THEN** it returns Azure voices including at least one `pl-PL` and one `en-*` voice

#### Scenario: Defaults speak both languages
- **WHEN** a keyed engine with no `voices` serves `lang: "pl"` and `lang: "en"`
- **THEN** each uses a voice of that language from the engine's catalog

#### Scenario: The cascade has no catalog
- **WHEN** `listVoices("cascade")` is called
- **THEN** it returns `[]`

### Requirement: Keyed engines classify provider refusals into error kinds
Each keyed engine maps the provider's responses to `quota-exhausted`, `unauthorized`,
`rate-limited` (with `retryAfter` from `Retry-After`), `network`, `no-audio` and `rejected`; any
unrecognised refusal is `rejected`.

#### Scenario: Exhausted quota
- **WHEN** the provider answers with its exhausted-quota response (pinned per engine from a recorded fixture)
- **THEN** the engine rejects `quota-exhausted`

#### Scenario: Bad key
- **WHEN** the provider answers its invalid-key response (typically HTTP 401/403)
- **THEN** the engine rejects `unauthorized`

#### Scenario: Too many requests
- **WHEN** the provider answers HTTP 429 with `Retry-After: 12`
- **THEN** the engine rejects `rate-limited` with `retryAfter: 12`

#### Scenario: Unknown refusal
- **WHEN** the provider answers an error the engine does not recognise
- **THEN** the engine rejects `rejected`

#### Scenario: Abort
- **WHEN** the request's signal aborts mid-request
- **THEN** the HTTP request is cancelled and the engine rejects with an `AbortError`
