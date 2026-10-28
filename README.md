# anytts

Text-to-speech for the browser and Node with pluggable engines — starting with the free Edge read-aloud service.

- Node ≥ 22 and modern browsers
- ESM-only, TypeScript types included
- Zero runtime dependencies

```sh
npm i anytts
```

## Quick start

```ts
import { createTts } from "anytts";

const tts = createTts({
  engines: {
    edge: {
      voices: {
        default: "en-US-AvaMultilingualNeural",
        pl: "pl-PL-ZofiaNeural",
      },
    },
  },
  defaultEngine: "edge",
  // Tiers are ordered most-important first; `cap` limits how many jobs from this tier
  // and every tier below it may run at once.
  scheduler: {
    concurrency: 2,
    tiers: [{ name: "play" }, { name: "warm", cap: 1 }],
  },
  cache: { max: 50 },
});

// Synthesize (voice picked from `voices[lang]`, else `voices.default`).
const { bytes, mime, voice } = await tts.synthesize({ text: "Cześć!", lang: "pl", tier: "play" });
const url = URL.createObjectURL(new Blob([bytes], { type: mime }));

// Warm the cache for what comes next; failures are swallowed.
tts.prefetch({ text: "Następne zdanie.", lang: "pl", tier: "warm" });

tts.isCached({ text: "Następne zdanie.", lang: "pl" }); // true once synthesized

// Lifecycle events: { type: "pending" | "add" | "drop" | "evict", key }.
const unsubscribe = tts.subscribe((e) => console.log(e.type, e.key));
```

`synthesize` accepts `{ text, lang?, voice?, engine?, tier?, signal?, onStart?, onFirstByte? }`
(plus `voices?`, `order?` and `pronunciation?` for a [cascade](#cascade) request) and resolves with
`{ bytes, mime, engine, voice }`, where `engine` / `voice` name what actually spoke.
An explicit `voice` wins over `lang`, and the tier defaults to the first one configured.
Identical concurrent requests share one synthesis; asking again on a higher tier promotes the
queued job. An aborted `signal` rejects with an `AbortError`, and the job is cancelled once
nobody is waiting for it. `bytes` is shared with the cache: do not detach or transfer it.

`onStart` fires when the job leaves the queue and `onFirstByte` when the first audio chunk
arrives, each at most once per caller and always in that order, however many retries the job
takes. A caller that joins a running job hears the phases the job already passed in a microtask
after `synthesize` returns, and later ones as they happen; a cache hit hears both in that
microtask. An aborted caller hears nothing more, and a throwing hook is ignored.
`prefetch` forwards them too.

```ts
await tts.synthesize({
  text: "Cześć!",
  lang: "pl",
  onStart: () => showSpinner(), // synthesis started (left the queue)
  onFirstByte: () => showWaveform(), // audio is flowing
});
```

### Restarting a silent attempt

`tts.restartStalled()` fails every running attempt that has not delivered its first byte yet as
`first-byte-timeout`: it is retried at once if the engine's `retries` budget allows, otherwise the
request rejects. It returns `true` if it restarted anything. Attempts already streaming are left
alone. Call it when a backgrounded tab or a sleeping device comes back, since a connection
opened before the pause rarely answers after it:

```ts
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tts.restartStalled();
});
```

### How engines report the first byte

Built-in engines receive an `EngineHooks` object (exported as a type) with each call and report
the first audio chunk through `hooks.onFirstByte()`; the Edge engine does so direct or through
the relay. That signal drives the request's `onFirstByte` and tells `restartStalled` an attempt
is streaming: until it fires, the attempt counts as silent and can be restarted.

### Observing a request

`tts.state(req)` answers `"ready"` when the request's key is cached, `"pending"` while it is
queued or running, and `"cold"` otherwise (including an unknown voice or engine, without
throwing). `subscribe` listeners (type `TtsListener`, exported alongside `TtsEvent`) receive
`{ type: "pending" | "add" | "drop" | "evict", key }`:
`pending` when a request enters the in-flight map, `add` when its result is cached, `drop` when
it leaves the map without a result (a final failure or abandonment), and `evict` when the LRU
removes a cached result, as before. Joins and retries are silent: a second caller joining an
in-flight key, a waiting job being promoted, or a transient failure being retried emits nothing.

```ts
const req = { text: "Trzecie zdanie.", lang: "pl" };
tts.state(req); // "cold"
const done = tts.synthesize(req);
tts.state(req); // "pending" synchronously after the call (queued or already running)
await done;
tts.state(req); // "ready"; the listener above saw `pending` then `add`
```

## Text helpers: `anytts/text`

```ts
import { applyPronunciation, packUnits, firstSentence } from "anytts/text";

// Respell words for the voice's language. Polish ships with a built-in preset; your map
// extends it and overrides it per key.
applyPronunciation("Zrób commit na GitHub", "pl");
applyPronunciation("Deploy na Vercel", "pl", {
  pl: { deploy: "diploj", K8S: { say: "kubernetes", match: "exact" } },
});

// Pack paragraphs into synthesis-sized units (merge up to `min`, never past `max`).
const units = packUnits([{ text: "First paragraph." }, { text: "Second one." }], { min: 200, max: 450 });
// → [{ text, from, to }], where from/to are source paragraph indices

firstSentence("Hello there. More text follows."); // "Hello there."
```

Pronunciation entries match as `word` (the default for bare strings: whole word plus an
optional plural "s", case-insensitive), `stem` (word start, inflected endings kept) or `exact`
(whole word, case-sensitive, for acronyms). The text helpers are exported only from
`anytts/text`, not from the package root.

## Engine and voice settings

For a settings UI, list what is available, then resolve a saved choice leniently:

```ts
import { listEngines, listVoices, resolveVoice } from "anytts";

listEngines();
// [
//   { id: "edge", label: "Microsoft Edge (read aloud)", runtimes: ["browser", "node"] },
//   { id: "elevenlabs", label: "ElevenLabs", runtimes: ["node"] },
//   { id: "cartesia", label: "Cartesia", runtimes: ["node"] },
//   { id: "speechify", label: "Speechify", runtimes: ["node"] },
//   { id: "azure", label: "Azure Speech (F0)", runtimes: ["node"] },
//   { id: "cascade", label: "Cascade (first engine that answers)", runtimes: ["browser", "node"] },
// ]
listVoices("edge"); // [{ id, label, locale, gender, multilingual }, …]; [] for an unknown engine or "cascade"

const saved = loadSettings(); // e.g. { engine: "edge", voice: "pl-PL-MarekNeural" }
const { voice, fellBack } = resolveVoice(tts, { engine: saved.engine, voice: saved.voice, lang: "pl" });
if (fellBack) {
  // The saved voice is no longer in the catalog: `voice` is `voices[lang]` or `voices.default`.
  saveSettings({ ...saved, voice });
}
await tts.synthesize({ text: "Dzień dobry.", engine: saved.engine, voice });
```

`synthesize` itself is strict: a voice outside the engine's catalog rejects with
`TtsError("unknown-voice")`. `resolveVoice` throws `RangeError` for an engine the instance does
not configure.

## Browser, Node and the relay

In Node, the Edge engine always talks to the service directly. In the browser, the service
only accepts Microsoft Edge (≥ 137), so other browsers need a relay on your server:

```ts
// server.ts (Node)
import { createServer } from "node:http";
import { createRelayHandler, toNodeHandler } from "anytts/server";

// Fetch-standard handler: POST { text, voice } → 200 audio/mpeg.
const relay = createRelayHandler({
  maxChars: 2000,
  authorize: (req) => req.headers.get("x-api-key") === process.env.TTS_KEY,
});

createServer(toNodeHandler(relay)).listen(3000);
```

`createRelayHandler` returns `(req: Request) => Promise<Response>`, so Fetch-based runtimes and
route handlers can use it as is; `toNodeHandler` adapts it to `node:http` / Express
`(req, res)`. Errors come back as JSON (`400`, `403`, `413`, or `502` with `{ kind }`); the full
protocol, including keyed engines and the cascade, is under [Relay protocol](#relay-protocol).

Point the browser engine at it:

```ts
const tts = createTts({
  engines: {
    edge: {
      voices: { default: "en-US-AvaMultilingualNeural" },
      relayUrl: "/api/tts",
      // mode "auto" (the default when relayUrl is set): direct in Edge, relay elsewhere, and
      // switch to the relay for good if the service refuses this browser's handshake. A turn
      // the service accepts and then drops with no audio is retried direct once, then relayed
      // for that call only.
      // "direct" or "relay" forces one path.
    },
  },
  defaultEngine: "edge",
  scheduler: { concurrency: 2, tiers: [{ name: "play" }] },
});
```

## Keyed engines

Four engines call a paid (or free-tier) provider API with your key:

| id           | Provider                 | Engine options (besides the shared ones)                                                    | Default voices (`pl` / `en` = `default`)                                   | `maxConcurrent` |
| ------------ | ------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------- |
| `elevenlabs` | ElevenLabs               | `modelId` (`eleven_multilingual_v2`), `outputFormat` (`mp3_44100_128`), `baseUrl`           | Brian `nPczCjzI2devNBz1zQrb` / George `JBFqnCBsd6RMkjVDRZzb`               | 2               |
| `cartesia`   | Cartesia                 | `modelId` (`sonic-3.6`), `sampleRate` (44100), `bitRate` (128000), `version`, `baseUrl`     | Polish Narrator Woman `575a5d29-…` / Jacqueline `9626c31c-…`               | 2               |
| `speechify`  | Speechify                | `model` (`simba-3.5`, which speaks Polish), `baseUrl` (or `https://eu.api.speechify.ai`)    | `kajetan` / `geffen_32`                                                    | 2               |
| `azure`      | Azure Speech             | `region` (**required** with `apiKey`, e.g. `westeurope`), `outputFormat`, `userAgent`      | `pl-PL-ZofiaNeural` / `en-US-AvaMultilingualNeural`                        | 1               |

Every keyed engine also takes `apiKey`, `firstByteMs` (wait for the response headers, default
8000), `stallMs` (gap between body chunks, default 8000), and the shared engine fields: `voices`
(replaces the built-in `pl` / `en` / `default` map), `retries`, `pronunciation` and
`maxConcurrent` (most attempts this engine runs at once; a waiting job keeps its tier priority;
`edge` is unlimited unless you set it). `listVoices(id)` returns each provider's stock catalog.
Azure's `region` is checked at creation: an `apiKey` without a valid region throws `RangeError`.
Only the public Azure cloud is supported.

A keyed engine without `apiKey` can still be configured: asked directly, it rejects
`TtsError("unauthorized")` and sends nothing; as a cascade member it is skipped. So a consumer can
list every engine and let the environment decide which keys exist.

### Server only: `anytts/server`

Keys never belong in a browser. The keyed engines are registered only by the `createTts` that
`anytts/server` exports; the main `anytts` entry is browser-safe and contains no key-handling
code. In the browser, the same engine ids (and `cascade`) are thin relay clients that accept
`{ relayUrl, firstByteMs?, stallMs? }` and no `apiKey`:

```ts
// Node
import { createTts } from "anytts/server";

const tts = createTts({
  engines: { azure: { apiKey: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION } },
  defaultEngine: "azure",
  scheduler: { concurrency: 2, tiers: [{ name: "play" }] },
});

// Browser: the relay holds the key.
import { createTts as createBrowserTts } from "anytts";

const browserTts = createBrowserTts({
  engines: { azure: { relayUrl: "/api/tts" } },
  defaultEngine: "azure",
  scheduler: { concurrency: 2, tiers: [{ name: "play" }] },
});
```

### Pronunciation per engine

Each engine's `pronunciation` flag (default `true` for `edge`, `false` for every other engine)
makes the library respell the text with the request language's Pronunciation map (the built-in
`pl` preset plus the config's top-level `pronunciation` entries) before that engine speaks it. It
applies only when the request has a `lang`. The cache key uses the respelled text, so an Edge
result with the map and an ElevenLabs result without it never collide.

> Since 0.4.0 an `edge` request with a `lang` gets the `pl` preset applied by the library. If you
> already call `applyPronunciation` yourself, set `edge: { pronunciation: false }` or stop doing it.

## Cascade

`cascade` is an engine id that tries one request on member engines in order until one speaks, so
a free tier that runs out falls through to the next provider (and finally to Edge):

```ts
import { createTts } from "anytts/server";

const env = process.env;
const tts = createTts({
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
  scheduler: { concurrency: 2, tiers: [{ name: "play" }, { name: "warm", cap: 1 }] },
});

const { bytes, engine, voice } = await tts.synthesize({ engine: "cascade", text: "Cześć!", lang: "pl" });
// engine / voice name the member that spoke, e.g. "cartesia" and its pl voice.
```

`engines.cascade` takes `{ order }`; every id must be another configured engine,
and the cascade has no `voices` of its own (either mistake throws `RangeError` at creation).

**Per request** a cascade request takes, instead of `voice`:

```ts
await tts.synthesize({
  engine: "cascade",
  text: "Dzień dobry.",
  lang: "pl",
  voices: { elevenlabs: "JBFqnCBsd6RMkjVDRZzb", edge: "pl-PL-MarekNeural" }, // else each member's map by lang
  order: ["azure", "edge"],     // subset and order for this request; non-members are dropped
  pronunciation: { edge: false }, // per-member override of the engine's flag
});
```

A `voice` on a cascade request rejects `unknown-voice` (one id cannot name voices of several
engines), as does a `voices` entry outside the catalog of a member that may be tried — before any
request is sent. An
`order` that leaves no member rejects with a `RangeError`. `voices` / `order` / `pronunciation` on
a non-cascade request are ignored.

**How the chain walks:**

1. **Cache first.** Before any network work it checks every member's cache entry, in order — a
   skipped member's included — and the first hit answers. A unit already synthesized never costs
   quota.
2. **Skip.** A keyed member without `apiKey`, or one inside a skip window, is passed over without a
   request.
3. **Attempt.** Otherwise the member runs with its own `retries`. A member whose
   `maxConcurrent` slots are busy is waited for, not hopped over (hopping would change the voice
   mid-answer for a momentary limit).
4. On audio, the result is cached under the member's key and returned. `quota-exhausted`,
   `unauthorized` and `rate-limited` open a skip window and move on; transient failures after
   retries, `no-audio` and `rejected` move on without one; `unknown-voice` and an abort stop the
   chain.

**Skip windows** live in the instance (in memory):

| Refusal           | Member skipped                                       |
| ----------------- | ---------------------------------------------------- |
| `quota-exhausted` | until 00:00 UTC on the 1st of next month             |
| `rate-limited`    | for the provider's `Retry-After`, else 60 s          |
| `unauthorized`    | for the life of the instance                         |

A refusal opens the window whether it came from a cascade attempt or a direct request to the
engine; the window steers the cascade only, so direct requests still reach the engine. A later
refusal never shortens an open window. A restart costs at most one failed attempt per spent
member; build a new instance after changing a key (it starts with no windows).

**Final error:** when no member speaks, the request rejects with the error of the last member
actually attempted; if more than one was attempted, the earlier members' errors are on its
`cause`, as an array in order. If every member was skipped, it rejects with the last skip
reason (e.g. `quota-exhausted`, or `rate-limited` with the remaining `retryAfter`). A member
skipped for having no key reports kind `unauthorized` there.

### `engineStatus`

`tts.engineStatus(id)` reports a member's standing, for a settings UI:

```ts
tts.engineStatus("elevenlabs");
// { state: "ready" }
// { state: "no-key" }                                    keyed engine without apiKey
// { state: "quota-exhausted", until: "2026-11-01T00:00:00.000Z" }
// { state: "rate-limited", until: "…" }
// { state: "unauthorized" }                              lasts the instance's life
```

It throws `RangeError` for an engine the instance does not configure. The relay does not expose
it over HTTP: pass the instance you read it from to the relay as `tts` (below).

## Relay protocol

`createRelayHandler(options)` from `anytts/server`:

| option      | meaning                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `maxChars`  | Longest accepted `text`. Default 2000.                                                                                            |
| `authorize` | `(req) => boolean \| Promise<boolean>`, called after validation; `false` answers 403.                                             |
| `edge`      | Options for the standalone Edge engine that serves bodies without `engine` (and `engine: "edge"` when `tts` has no `edge`).        |
| `tts`       | A `TtsConfig` (built with the keyed engines registered) or a `Tts` instance (used as is) that serves every engine named in a body. |

```ts
import { createServer } from "node:http";
import { createRelayHandler, createTts, toNodeHandler } from "anytts/server";

const tts = createTts(config); // the cascade config above
const relay = createRelayHandler({
  tts, // shared: read tts.engineStatus(id) from the instance whose skip windows the relay fills
  authorize: (req) => req.headers.get("x-api-key") === process.env.TTS_KEY,
});
createServer(toNodeHandler(relay)).listen(3000);
```

> **WARNING: a relay serving keyed engines without an `authorize` guard spends the key owner's
> quota (and money, if the plan bills overage) for anyone who can reach the URL.** `authorize` is
> optional and nothing checks for it at creation — guard the route yourself.

Also turn off overage / pay-as-you-go billing (or set a hard spend limit) at each provider, so an
exhausted free tier answers with a quota error the cascade skips instead of a bill.

**Request bodies** (`POST`, JSON):

- `{ text, voice }` — the standalone Edge engine, as before 0.4.0.
- `{ engine, text, voice }` — one engine of `tts`. `engine: "edge"` goes through the `tts`
  instance (its cache and scheduler) when it configures `edge`, else through the standalone Edge
  engine.
- `{ engine: "cascade", text, lang?, voices?, order?, pronunciation? }` — the chain of `tts`.

**Responses:**

- `200 audio/mpeg` with `x-anytts-engine` and `x-anytts-voice` naming what spoke (the member, for
  a cascade).
- `400` — invalid JSON or a malformed body (`{ error }`); an engine `tts` does not configure, or a
  voice outside the engine's catalog (`{ kind: "unknown-voice" }`); a cascade `order` with no
  member (`{ error }`).
- `403` — `authorize` said no. `405` — not a `POST`.
- `413` — the body or `text` is too long.
- `502 { kind, retryAfter? }` — the synthesis failed; `rate-limited` with a known wait also sets
  a `Retry-After` header (in seconds).

In the browser, point the relay clients at it; one cascade call walks the whole chain on the
server, and the result is cached under the member's key and a cascade alias (text, `lang` and the
request's `voices` / `order` / `pronunciation`), so changing a member's voice is a cache miss:

```ts
import { createTts } from "anytts";

const tts = createTts({
  engines: {
    cascade: { relayUrl: "/api/tts" }, // firstByteMs defaults to 20000: the relay may try several members
    edge: { voices: { default: "en-US-AvaMultilingualNeural" }, relayUrl: "/api/tts" },
  },
  defaultEngine: "cascade",
  scheduler: { concurrency: 2, tiers: [{ name: "play" }] },
});

const { engine, voice } = await tts.synthesize({ text: "Cześć!", lang: "pl" }); // from the response headers
```

Relay errors keep their `kind` and `retryAfter` in the browser, and the normal retry rules apply.

## Errors

Engine failures reject with `TtsError`, which carries a `kind` (and an HTTP `status` when one
is known, plus `retryAfter` seconds for `rate-limited`):

| `kind`               | Meaning                                                                                           | Transient |
| -------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| `rejected`           | The service refused the request or the handshake                                                  | no        |
| `first-byte-timeout` | No audio arrived within the first-byte deadline, or `restartStalled()` restarted the last attempt | yes       |
| `stalled`            | Audio started, then the stream stopped mid-way                                                    | yes       |
| `network`            | Connection failed, dropped or sent malformed data                                                 | yes       |
| `no-audio`           | The request finished without any audio                                                            | no        |
| `unknown-voice`      | The voice is not in the engine's catalog                                                          | no        |
| `quota-exhausted`    | The provider's period quota or credits are spent (e.g. HTTP 402)                                  | no        |
| `unauthorized`       | The key is missing, invalid or revoked                                                            | no        |
| `rate-limited`       | HTTP 429; `retryAfter` holds the seconds from `Retry-After` when sent                             | no        |

A provider's 5xx is reported as `network`. Transient kinds are retried automatically (`retries`
per engine, default 1) and can be checked with `isTransient(kind)`; the rest are final, so show
them to the user rather than retrying (the cascade moves on to the next member instead).

```ts
import { TtsError, isTransient } from "anytts";

try {
  await tts.synthesize({ text: "Hi" });
} catch (error) {
  if (error instanceof TtsError && !isTransient(error.kind)) showError(error.kind);
}
```

## License

MIT
