# relay — delta for 2026-10-16-edge-word-boundary-drops

Base: the `relay` delta of `2026-10-14-free-tts-v1` (not yet folded into `openspec/specs/`);
folded after it.

## MODIFIED Requirements

### Requirement: The browser engine chooses direct or relay
The `edge` engine accepts `relayUrl` and `mode: "auto" | "direct" | "relay"`; the default is
`auto` when `relayUrl` is set and `direct` otherwise. Node is always direct.

#### Scenario: Auto falls back to relay after a refused handshake
- **GIVEN** `mode: "auto"` in Edge and a direct attempt whose handshake is refused
- **WHEN** this and every later synthesis of the instance runs
- **THEN** it goes through the relay

#### Scenario: A dropped turn does not switch auto to the relay
- **GIVEN** `mode: "auto"` in Edge and a direct synthesis whose turn drops twice
- **WHEN** that synthesis runs
- **THEN** it goes through the relay for that call only, and the next synthesis goes direct

(Other scenarios of this requirement are unchanged; "Auto falls back to relay after a direct
rejection" is replaced by the two above.)
