# Proposal: Single-language English voices in the Edge catalog (0.2.2)

## Problem

The Edge catalog offers English only through multilingual voices, which auto-detect the language
and sometimes misread mixed or short text. Consumers wanting a plain English voice (US or UK)
have no single-language choice, unlike Polish (`pl-PL-MarekNeural`, `pl-PL-ZofiaNeural`).

## Change

Add seven non-multilingual Edge read-aloud voices, labelled `<Name> (English · US|UK)`:

| id | gender |
| -- | ------ |
| `en-US-AriaNeural` | female |
| `en-US-JennyNeural` | female |
| `en-US-GuyNeural` | male |
| `en-US-ChristopherNeural` | male |
| `en-GB-SoniaNeural` | female |
| `en-GB-RyanNeural` | male |
| `en-GB-LibbyNeural` | female |

Every id, gender and locale was checked on 2026-10-17 against Microsoft's
`readaloud/voices/list` (Sec-MS-GEC v2 token from `src/engines/edge/token.ts`, 322 voices).
The catalog keeps multilingual voices first and existing entries in order; single-language voices
follow, grouped by locale (en-US, en-GB, pl-PL).

## Out of scope

Other locales, defaults (`voices.default` stays the consumer's choice), dynamic voice listing.
