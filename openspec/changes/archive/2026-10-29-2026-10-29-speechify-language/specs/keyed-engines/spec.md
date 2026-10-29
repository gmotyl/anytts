## ADDED Requirements

### Requirement: Speechify names the language when the voice speaks another
The Speechify engine adds `language` to its request body only when the Request language is in its
simba-3.5 locale table and its base subtag differs from the base of the voice's catalog locale.
A base code maps to one locale (`pl → pl-PL`; European variant where several exist:
`en → en-GB`, `pt → pt-PT`, `es → es-ES`); a region-qualified `lang` in the table passes unchanged.

#### Scenario: Multilingual voice reads Polish
- **WHEN** `geffen_32` (en-US) synthesizes with `lang: "pl"`
- **THEN** the request body is `{ input, voice_id: "geffen_32", model: "simba-3.5", language: "pl-PL" }`

#### Scenario: Region-qualified language
- **WHEN** `geffen_32` synthesizes with `lang: "pl-PL"`
- **THEN** the body carries `language: "pl-PL"`

#### Scenario: English maps to en-GB
- **WHEN** `kajetan` (pl-PL) synthesizes with `lang: "en"`
- **THEN** the body carries `language: "en-GB"`

#### Scenario: Same-language voice keeps its own locale
- **WHEN** `kajetan` synthesizes with `lang: "pl"`, or `hugh_32` (en-GB) with `lang: "en"`
- **THEN** the body has no `language` field

#### Scenario: Unknown or absent language
- **WHEN** a Speechify request has no `lang`, or a `lang` outside the table (e.g. `"xx"`)
- **THEN** the body has no `language` field and the request is still sent

### Requirement: The Speechify catalog lists every native Polish stock voice
`listVoices("speechify")` includes the six pl-PL stock voices `dominika`, `iga`, `jagna`,
`kajetan`, `michal` and `tymon`; the default Voice map keeps `pl → kajetan`.

#### Scenario: Polish voices listed
- **WHEN** `listVoices("speechify")` is filtered to locale `pl-PL`
- **THEN** it returns exactly those six ids, `michal` labelled "Michał"
