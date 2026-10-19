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

`synthesize` accepts `{ text, lang?, voice?, engine?, tier?, signal?, onStart?, onFirstByte? }`.
An explicit `voice` wins over `lang`, and the tier defaults to the first one configured.
Identical concurrent requests share one synthesis; asking again on a higher tier promotes the
queued job. An aborted `signal` rejects with an `AbortError`, and the job is cancelled once
nobody is waiting for it. `bytes` is shared with the cache: do not detach or transfer it.

`onStart` fires when the job leaves the queue and `onFirstByte` when the first audio chunk
arrives, each at most once per caller and always in that order, however many retries the job
takes. A caller that joins a running job or hits the cache still hears both, in a microtask after
`synthesize` returns; an aborted caller hears nothing more, and a throwing hook is ignored.
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

listEngines(); // [{ id: "edge", label: "Microsoft Edge (read aloud)", runtimes: ["browser", "node"] }]
listVoices("edge"); // [{ id, label, locale, gender, multilingual }, …]; [] for an unknown engine

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
`(req, res)`. Errors come back as JSON (`400`, `403`, `413`, or `502` with `{ kind }`).

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

### Engine hooks

Engines report progress through `EngineHooks` (exported as a type), passed as the fourth
argument of `Engine.synthesize(text, voice, signal, hooks?)`. The built-in Edge engine calls
`hooks.onFirstByte()` on the first audio chunk, direct or through the relay; that is what drives
the request's `onFirstByte` and tells `restartStalled` an attempt is streaming. Hooks are
optional: an engine that never calls `onFirstByte` still works, but its attempts look silent and
stay restartable even while audio is flowing.

## Errors

Engine failures reject with `TtsError`, which carries a `kind` (and an HTTP `status` when one
is known):

| `kind`               | Meaning                                              | Transient |
| -------------------- | ---------------------------------------------------- | --------- |
| `rejected`           | The service refused the request or the handshake     | no        |
| `first-byte-timeout` | No audio arrived within the first-byte deadline      | yes       |
| `stalled`            | Audio started, then the stream stopped mid-way       | yes       |
| `network`            | Connection failed, dropped or sent malformed data    | yes       |
| `no-audio`           | The request finished without any audio               | no        |
| `unknown-voice`      | The voice is not in the engine's catalog             | no        |

Transient kinds are retried automatically (`retries` per engine, default 1) and can be checked
with `isTransient(kind)`; the rest are final, so show them to the user rather than retrying.

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
