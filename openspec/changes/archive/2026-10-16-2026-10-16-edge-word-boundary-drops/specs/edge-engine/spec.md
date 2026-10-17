# edge-engine — delta for 2026-10-16-edge-word-boundary-drops

Base: the `edge-engine` delta of `2026-10-14-free-tts-v1` (not yet folded into `openspec/specs/`);
folded after it.

## ADDED Requirements

### Requirement: The Edge engine requests word boundaries
`speech.config` sends `metadataoptions` `{ sentenceBoundaryEnabled: "false",
wordBoundaryEnabled: "true" }`. As of 2026-10-16 the service drops about half the turns without
word boundaries.

#### Scenario: Word-boundary frames are not audio
- **WHEN** `Path:audio.metadata` text frames arrive between audio frames
- **THEN** the result holds only the audio bytes and resolves on `turn.end`

### Requirement: A dropped turn is retried once
A *dropped turn* is an attempt whose socket opened and then closed or errored before any audio. The engine
retries it once on a fresh connection.

#### Scenario: Retry succeeds
- **WHEN** the first attempt is a dropped turn and the retry streams audio
- **THEN** `synthesize` resolves with the retry's audio

#### Scenario: Second drop is final
- **WHEN** the retry is also a dropped turn
- **THEN** `synthesize` rejects with `TtsError{ kind: "rejected" }` after exactly two connections
