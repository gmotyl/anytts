## ADDED Requirements

### Requirement: Pronunciation maps are keyed by the spoken language
`applyPronunciation(text, lang, maps?)` applies the Pronunciation map of `lang` — the language of
the voice that will speak the text. The library ships a `pl` preset; apps may extend, override or
add languages.

#### Scenario: Polish voice gets English terms respelled
- **WHEN** `applyPronunciation("deploy na produkcji", "pl")` is called with the shipped preset
- **THEN** the result is `"diploj na produkcji"`

#### Scenario: No language, no rewriting
- **WHEN** `applyPronunciation(text, undefined)` is called
- **THEN** the text is returned unchanged

#### Scenario: Language without a map
- **WHEN** `applyPronunciation(text, "de")` is called and no `de` map exists
- **THEN** the text is returned unchanged

#### Scenario: App adds an entry
- **WHEN** an app passes `maps` extending `pl` with `{ "pavilio": "pawilio" }`
- **THEN** "pavilio" is respelled and every preset entry still applies

### Requirement: The pl preset is the strict map
The shipped `pl` preset is motyl.dev's map after `pronunciation-match-strictness`: each entry
carries its own match mode.

#### Scenario: Short keys do not rewrite longer words
- **WHEN** Polish prose containing "macierz" and "codebase" is processed with `pl`
- **THEN** "macierz" is unchanged and "codebase" is not rewritten through the `code` entry

#### Scenario: Ordinary prose survives
- **WHEN** the ported prose-survival fixture is processed with `pl`
- **THEN** every word the fixture marks as untouched is unchanged

### Requirement: Paragraphs are packed into speech units between a floor and a ceiling
`packUnits(paragraphs, { min = 200, max = 450 })` is generic over `{ text, ...meta }` items and
returns units with the index span of their source paragraphs.

#### Scenario: Short paragraphs merge up to the floor
- **WHEN** three consecutive 90-character paragraphs are packed
- **THEN** the first unit holds the first three paragraphs' text joined, spanning indices 0–2

#### Scenario: Never merge past the ceiling
- **WHEN** merging the next paragraph would exceed `max`
- **THEN** the pending unit is emitted and the paragraph starts a new unit

#### Scenario: Long paragraph cut on sentences, then words
- **WHEN** a single paragraph is longer than `max`
- **THEN** it is cut at sentence boundaries into pieces of at most `max`, and a single sentence longer than `max` is cut at word boundaries; every piece spans that paragraph's index

### Requirement: The first sentence can be taken for a fast start
`firstSentence(text)` returns the leading sentence, or `null` when none is found.

#### Scenario: Leading sentence
- **WHEN** `firstSentence("Pierwsze zdanie. Drugie zdanie.")` is called
- **THEN** it returns `"Pierwsze zdanie."`
