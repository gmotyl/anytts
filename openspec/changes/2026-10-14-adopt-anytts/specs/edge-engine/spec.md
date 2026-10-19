# Delta — edge-engine (first-byte hook)

## ADDED Requirements

### Requirement: The Edge engine reports its first audio byte
`synthesize(text, voice, signal, hooks?)` calls `hooks.onFirstByte()` once per attempt, on the first
audio chunk, on both the direct and the relay path.

#### Scenario: Direct path
- **WHEN** the socket delivers its first binary audio frame
- **THEN** `onFirstByte` is called once, and not again for later frames.

#### Scenario: Relay path
- **WHEN** the relay response delivers its first body chunk
- **THEN** `onFirstByte` is called once.

#### Scenario: No hooks
- **WHEN** `hooks` is omitted
- **THEN** synthesis behaves exactly as in 0.2.2.
