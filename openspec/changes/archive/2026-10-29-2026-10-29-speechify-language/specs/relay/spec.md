## MODIFIED Requirements

### Requirement: The Relay handler synthesizes on the server with an Edge identity
Was: one engine is served by `POST { engine?, text, voice }`. Is: one engine is served by
`POST { engine?, text, voice, lang? }` — `lang` is optional, must be a string when present, and is
passed to synthesis as the Request language. Everything else in this requirement is unchanged
(Edge-only form without `tts`, the cascade body, response headers, optional `authorize`); its
existing scenarios stay as they are and these are added.

#### Scenario: A direct request carries its language
- **GIVEN** a relay created with `tts` configuring `speechify`
- **WHEN** `POST { engine: "speechify", text, voice: "geffen_32", lang: "pl" }` arrives
- **THEN** Speechify synthesizes with Request language `"pl"` (its body carries `language: "pl-PL"`)

#### Scenario: A non-string language is refused
- **WHEN** `POST { engine: "speechify", text, voice, lang: 1 }` arrives
- **THEN** the response is `400` and no synthesis starts

### Requirement: Keyed engines and the cascade are relay clients in the browser
Was: the browser POSTs the request to the relay. Is: as before, and a direct keyed-engine request
also sends `lang` when the request has one. Existing scenarios are unchanged; this one is added.

#### Scenario: A browser direct keyed request sends its language
- **WHEN** a browser instance with `engines: { speechify: { relayUrl: "/api/tts" } }` synthesizes
  `{ engine: "speechify", text, voice: "geffen_32", lang: "pl" }`
- **THEN** `/api/tts` receives `{ engine: "speechify", text, voice: "geffen_32", lang: "pl" }`
