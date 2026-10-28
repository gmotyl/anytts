# Design: cascade-engine

## Glossary

- **Cascade** — the engine id `cascade`: one request tried on member engines in order until one speaks. _Avoid_: auto-free, auto, fallback chain, provider chain.
- **Member engine** — an engine listed in the cascade's `order`. _Avoid_: free engine, provider.
- **Keyed engine** — an engine that needs an `apiKey` and therefore runs only on the server. _Avoid_: paid engine, free engine.
- **Skip window** — the time a member is passed over after a quota, auth or rate-limit error. _Avoid_: cooldown, ban.
- **Engine slot** — one unit of an engine's `maxConcurrent`; a job holds one while its attempt runs. _Avoid_: lane, permit.
- **Cascade alias** — the browser-cache key (`cascade`, `lang`, options, text) that points at a member result. _Avoid_: virtual key.

## Overview

```mermaid
flowchart LR
  subgraph browser["Browser (anytts)"]
    bt["Tts — engines: { cascade: { relayUrl } }"]
    bc["cache: member key + cascade alias"]
  end
  subgraph server["Server (anytts/server)"]
    relay["Relay handler"]
    st["Tts — edge + keyed engines + cascade"]
    skip["skip windows (in memory)"]
    slots["engine slots"]
  end
  subgraph providers["Providers"]
    el["ElevenLabs"]
    ca["Cartesia"]
    sp["Speechify"]
    az["Azure F0"]
    ed["Edge read-aloud"]
  end
  bt -->|"POST { engine: cascade, text, lang, voices, order, pronunciation }"| relay
  relay --> st
  st --- skip
  st --- slots
  st --> el
  st --> ca
  st --> sp
  st --> az
  st --> ed
  relay -->|"audio + x-anytts-engine / x-anytts-voice"| bt
  bt --- bc
```

Keyed engines and the chain run where the keys are: in Node. The browser never holds a key; its
`cascade` and keyed engines are thin Relay clients.

## Configuration

```ts
createTts({
  defaultEngine: "cascade",
  engines: {
    elevenlabs: { apiKey: env.ELEVENLABS_API_KEY },                 // voices default per engine
    cartesia:   { apiKey: env.CARTESIA_API_KEY, maxConcurrent: 2 },
    speechify:  { apiKey: env.SPEECHIFY_API_KEY },
    azure:      { apiKey: env.AZURE_SPEECH_KEY, region: env.AZURE_SPEECH_REGION },
    edge:       { pronunciation: true },
    cascade:    { order: ["elevenlabs", "cartesia", "speechify", "azure", "edge"] },
  },
  pronunciation: { pl: { /* extra entries over the pl preset */ } },  // optional
  scheduler: { /* unchanged */ },
});
```

- **One shape for keyed engines:** `{ apiKey?, voices?, maxConcurrent?, pronunciation?, retries?,
  ...engine fields }`. Azure adds `region` (required when `apiKey` is set).
- **A member without `apiKey` is skipped**, never an error — so a consumer can list every member
  and let the keys decide. A keyed engine without `apiKey` used *directly* rejects `unauthorized`.
- **`cascade` validation at creation:** every `order` id must be a configured engine other than
  `cascade` (else `RangeError`); `cascade` has no `voices` (a `voices` entry is a `RangeError`).
- **Defaults:** each keyed engine ships a `pl`/`en`/`default` Voice map from its stock catalog;
  `pronunciation` defaults to `true` for `edge` and `false` for every other engine;
  `maxConcurrent` defaults to Azure 1, Cartesia 2, ElevenLabs 2, Speechify 2, Edge unlimited.
- **Catalogs:** `listEngines()` lists the keyed engines and `cascade` with `runtimes`
  (`["node"]` for keyed engines, `["browser", "node"]` for `cascade`), and `listVoices(id)` returns a
  static catalog of each provider's stock voices (`[]` for `cascade`).
- **Entry points:** the keyed engine factories are registered by `anytts/server` (its
  `createTts` re-export registers them); the main `anytts` entry registers only browser-safe
  factories — `edge` and the relay clients — so a browser bundle cannot contain key-handling code.

## Request shape

```ts
tts.synthesize({
  engine: "cascade",
  text, lang: "pl",
  voices?: { elevenlabs: "…", edge: "pl-PL-MarekNeural" },  // per member; else its Voice map by lang
  order?: ["azure", "edge"],                                // subset + order for this request
  pronunciation?: { edge: false },                          // per member override
});
```

- `voice` on a cascade request → `unknown-voice` (one voice id cannot name voices of several
  engines). `voices` / `order` / `pronunciation` on a non-cascade request are ignored.
- `order` entries that are not members are dropped; an empty effective order rejects with a
  `RangeError` (a caller bug, not a synthesis failure).
- Result: `{ bytes, mime, engine: <member id>, voice: <member voice> }`.

## The chain

```mermaid
flowchart TD
  start(["cascade request"]) --> pick["next member in effective order"]
  pick --> none{"any left?"}
  none -->|"no"| fail(["reject with the last error (or last skip reason)"])
  none -->|"yes"| key{"has apiKey (or keyless)?"}
  key -->|"no"| pick
  key -->|"yes"| win{"inside a skip window?"}
  win -->|"yes"| pick
  win -->|"no"| cached{"member key cached?"}
  cached -->|"yes"| done(["resolve from cache"])
  cached -->|"no"| slot["wait for an engine slot"]
  slot --> attempt["attempt (with the member's retries)"]
  attempt --> ok{"result"}
  ok -->|"audio"| store(["cache under member key, resolve"])
  ok -->|"quota-exhausted / unauthorized / rate-limited"| mark["open skip window"] --> pick
  ok -->|"transient after retries / no-audio / rejected"| pick
  ok -->|"unknown-voice / abort"| stop(["reject, do not switch"])
```

- **Cache lookups first:** before any network work, the chain checks the member keys in effective
  order and the first cached one wins — so an already-synthesized unit never costs quota.
- **Waiting, not hopping:** a member whose slots are all taken is waited for (the job keeps its
  tier priority). Hopping would change the voice mid-answer for a momentary limit.
- **Final error:** the error of the last member actually attempted; if every member was skipped
  without an attempt, the skip reason of the last skipped member (e.g. `quota-exhausted`).
- **Abort** releases the slot and stops the chain.

### Error kinds and skip windows

| Kind | Raised when (per engine, confirmed against the provider in its task) | Skip window |
|---|---|---|
| `quota-exhausted` | the provider refuses because the period's characters/credits are used | until 00:00 UTC on the 1st of next month |
| `unauthorized` | the key is missing, invalid or revoked | for the life of the instance |
| `rate-limited` | HTTP 429 (Azure F0 concurrency included), with `retryAfter` seconds from `Retry-After` | `retryAfter`, else 60 s |

`TtsError` gains `retryAfter?: number`. `quota-exhausted`, `unauthorized` and `rate-limited` are
**not** retried on the same engine (they are final for that engine, like `no-audio`). Skip windows
live in the instance; a restart costs at most one failed attempt per spent member. Rebuilding the
instance (a consumer replacing it after a key change) starts with no windows — wanted, since a new
key clears `unauthorized`.

**Observable state:** `tts.engineStatus(id)` returns `{ state: "ready" | "no-key" |
"quota-exhausted" | "rate-limited" | "unauthorized", until?: string /* ISO */ }` from the skip
windows, so a settings UI can show a live chip per member (the pavilio mockup does). The relay
does not expose it; a consumer serves it from its own server instance.

The exact status/body each provider returns for an exhausted quota is an open research point
(tts-providers wiki); each keyed engine's task pins it from the provider's docs and a recorded
fixture, and anything unrecognised maps to `rejected` (moves on, no window).

## Pronunciation

- Applied by the library, after the member is picked: `applyPronunciation(text, lang,
  config.pronunciation)` when the member's effective `pronunciation` is on and `lang` is given.
- The member key is built on the **prepared** text, so Edge-with-map and ElevenLabs-without-map
  results never collide.
- This holds for single-engine requests too: an `edge` request with `pronunciation: true` now gets
  the `pl` preset applied by the library. Consumers that already apply it themselves turn the flag
  off or stop applying it (pavilio does the latter).

## Cache

- **Member key** — `(engine, voice, preparedText)`, as today for single engines.
- **Cascade alias** (browser only) — `(cascade, lang, optionsHash, text)`, where `optionsHash`
  covers `voices`, `order` and `pronunciation` — otherwise changing a member's voice would keep
  answering from the old audio. The alias points at the member entry; `state` / `isCached` on a
  cascade request read the alias; evicting the member entry evicts its aliases.
- The server does not keep aliases: its lookups walk the member keys (above).

## Relay protocol

- Body: `{ engine?, text, voice }` (one engine; `engine` defaults to `edge`, so today's clients are
  unchanged) or `{ engine: "cascade", text, lang?, voices?, order?, pronunciation? }`.
- `createRelayHandler(opts)` keeps `{ maxChars, authorize?, edge? }` and gains `tts?: TtsConfig`;
  with `tts`, the relay serves every engine of that config. Unknown `engine` → `400 { kind:
  "unknown-voice" }` (the engine/voice pair cannot be served).
- `200` responses carry `x-anytts-engine` and `x-anytts-voice` (the member that spoke).
- Errors: `502 { kind, retryAfter? }`; `rate-limited` also sets `Retry-After`.
- `authorize` stays optional (Q17): no check at creation; the README warns that a relay serving
  keyed engines without a guard spends the owner's quota.

## Browser relay clients

- `cascade` and each keyed engine accept only `{ relayUrl, firstByteMs? }` in the browser and POST
  the request to it; `engine`/`voice` in the result come from the response headers.
- A cascade result is cached under the member key from the headers **and** the cascade alias.
- Relay errors keep their kind and `retryAfter`; the normal retry rules apply.

## Testing

- Unit: chain walk with fake engines (skip on missing key, skip windows per kind, wait on a busy
  slot, cache-first lookup, final error rules, abort), alias cache, pronunciation placement.
- Per keyed engine: request shape and error classification against recorded fixtures; no live
  calls in CI.
- Relay: body variants, headers, error mapping, back-compat `{ text, voice }`.
- Optional manual live probe per provider with a real key (script, not CI).
