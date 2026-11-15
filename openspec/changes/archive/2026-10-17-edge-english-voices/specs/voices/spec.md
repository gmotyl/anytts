# voices — delta for 2026-10-17-edge-english-voices

Base: the `voices` delta of `2026-10-14-free-tts-v1` (not yet folded into `openspec/specs/`);
folded after it.

## ADDED Requirements

### Requirement: The Edge catalog offers single-language English voices
`listVoices("edge")` includes `en-US-AriaNeural`, `en-US-JennyNeural`, `en-US-GuyNeural`,
`en-US-ChristopherNeural`, `en-GB-SoniaNeural`, `en-GB-RyanNeural` and `en-GB-LibbyNeural`, each
with `multilingual: false`, its locale and gender.

#### Scenario: English single-language voices are listed
- **WHEN** `listVoices("edge")` is called
- **THEN** each of the seven voices is present with `multilingual: false` and a label of the form `<Name> (English · US)` or `<Name> (English · UK)`

#### Scenario: Catalog is grouped
- **WHEN** `listVoices("edge")` is called
- **THEN** every multilingual voice precedes every single-language voice, and single-language voices are grouped by locale (en-US, en-GB, pl-PL)

#### Scenario: Every catalog id is a live Edge voice
- **WHEN** the live contract test fetches Microsoft's `readaloud/voices/list`
- **THEN** every catalog id appears in it
