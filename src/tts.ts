import { LruCache } from "./cache.js";
import { CASCADE, cachedMember, cascadeMembers, effectiveOrder, MemberSkippedError, walkCascade, type CascadeMembers } from "./cascade.js";
import type { Engine, EngineHooks, VoiceMap } from "./engine.js";
import { createEdgeEngine, type EdgeEngineOptions } from "./engines/edge/engine.js";
import { createRelayCascade, RELAY_ENGINES, type RelayCascade } from "./engines/relayEngine.js";
import { isTransient, TtsError, UnknownEngineError } from "./errors.js";
import { createScheduler, type ScheduledJob, type SchedulerConfig } from "./scheduler.js";
import { applyPronunciation, type PronunciationMap } from "./text/pronunciation.js";
import { registerVoiceSource } from "./voices.js";

export interface SynthesisRequest {
  text: string;
  lang?: string;
  voice?: string;
  /** Engine id, or `cascade` for the chain over its member engines. Default: `defaultEngine`. */
  engine?: string;
  /** Cascade only: member id → voice for this request; a member not named uses its Voice map by `lang`. */
  voices?: Record<string, string>;
  /** Cascade only: the members to try, in this order; ids that are not members are dropped. */
  order?: string[];
  /** Cascade only: member id → whether to apply the Pronunciation map, over the member's config. */
  pronunciation?: Record<string, boolean>;
  tier?: string;
  signal?: AbortSignal;
  /**
   * Called once when the job leaves the queue; for a cache hit or a flight that already started,
   * asynchronously after `synthesize` returns. A throwing hook is ignored.
   */
  onStart?(): void;
  /** Called once when the first audio chunk arrives (on any attempt), after `onStart`; same timing rules. */
  onFirstByte?(): void;
}

export interface SynthesisResult {
  /** Shared with the cache and every caller served the same entry: do not detach or transfer it. */
  bytes: ArrayBuffer;
  mime: "audio/mpeg";
  /** The engine that spoke: for a cascade request, the member that answered. */
  engine: string;
  /** The voice it spoke with. */
  voice: string;
}

export type EngineConfig = {
  /** Language → voice id. Default: the engine's built-in `pl`/`en`/`default` Voice map. */
  voices?: VoiceMap;
  /** Extra attempts after a transient failure. Default 1. */
  retries?: number;
  /**
   * Respell the text with the request language's Pronunciation map before this engine speaks it.
   * Default `true` for `edge`, `false` for every other engine.
   */
  pronunciation?: boolean;
  /**
   * Most attempts this engine runs at once; a waiting job keeps its tier priority. Default: the
   * engine's own (Azure 1, Cartesia / ElevenLabs / Speechify 2), unlimited for `edge`.
   */
  maxConcurrent?: number;
} & Record<string, unknown>;

/**
 * `engines.cascade`: the member engines, tried in this order (where the keys are: Node). No
 * `voices` of its own. In the browser, `{ relayUrl }` instead: one relay call walks the chain.
 */
export type CascadeConfig = { order: string[] } | CascadeRelayConfig;

/** A browser `cascade`: a relay client, no local walk. */
export interface CascadeRelayConfig {
  /** The relay endpoint (`createRelayHandler` from `anytts/server`). */
  relayUrl: string;
  /**
   * Max wait for the relay's response headers (it answers once a member has spoken). Default 20000;
   * it must cover the relay's worst-case member walk, or a walk that would succeed is cut off.
   */
  firstByteMs?: number;
  /** Max gap between body chunks. Default 8000. */
  stallMs?: number;
  /**
   * Extra relay calls after a transient failure. Default 0: each call re-runs the relay's whole
   * member walk (and spends each member's quota again).
   */
  retries?: number;
}

export interface TtsConfig {
  /** Engine id → config; engine-specific fields (e.g. `edge`'s) sit next to the shared ones. */
  engines: { edge?: EngineConfig & EdgeEngineOptions; cascade?: CascadeConfig & EngineConfig } & Record<string, EngineConfig>;
  defaultEngine: string;
  scheduler: SchedulerConfig;
  cache?: { max?: number };
  /** Extra Pronunciation map entries per language, over the built-in preset (`pl`). */
  pronunciation?: Record<string, PronunciationMap>;
}

/**
 * Lifecycle of a request key: `pending` when it enters the in-flight map, `add` when its result is
 * cached, `drop` when it leaves the map without a result (final failure or abandonment), `evict`
 * when the LRU removes the cached result.
 */
export type TtsEvent = { type: "pending" | "add" | "drop" | "evict"; key: string };

export type TtsListener = (e: TtsEvent) => void;

export interface Tts {
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
  prefetch(req: SynthesisRequest): void;
  isCached(req: SynthesisRequest): boolean;
  /** `ready` when cached, `pending` while queued or running, `cold` otherwise (including unknown voices). */
  state(req: SynthesisRequest): "cold" | "pending" | "ready";
  subscribe(listener: TtsListener): () => void;
  /**
   * Fails every running attempt that has not delivered its first byte as `first-byte-timeout`:
   * retried at once if budget remains, else the request rejects. `true` if any attempt was restarted.
   * Only the engine's `EngineHooks.onFirstByte` marks an attempt as streaming: an engine that never
   * calls it keeps its attempts restartable even while audio is flowing.
   */
  restartStalled(): boolean;
  /**
   * A member's standing for the cascade: `no-key` for a keyed engine without an `apiKey`, else the
   * kind of the skip window it sits in (`until` is when it closes, absent for `unauthorized`, which
   * lasts the instance's life), else `ready`. Throws RangeError for an id that is not a configured engine.
   * A quota, rate-limit or auth refusal opens the window whether it came from a cascade attempt or a
   * direct request to the engine; the window steers the cascade only, so direct requests still reach
   * the engine. A skipped member's cached results still answer cascade requests.
   */
  engineStatus(id: string): EngineStatus;
}

export interface EngineStatus {
  state: "ready" | "no-key" | "quota-exhausted" | "rate-limited" | "unauthorized";
  /** ISO time the skip window closes. */
  until?: string;
}

/**
 * Builds an engine from its config minus the shared fields. Declared as a method so factories
 * taking their own options type (`EdgeEngineOptions`, `AzureEngineOptions`, …) fit.
 */
export type EngineFactory = { create(options: Record<string, unknown>): Engine }["create"];

/** Internal seam (not re-exported from the package entry): tests swap engines for fakes. */
export interface CreateTtsInternals {
  engineFactories?: Record<string, EngineFactory>;
  /** The clock skip windows are measured on, in epoch ms. Default: `Date.now`. */
  now?: () => number;
}

const DEFAULT_RETRIES = 1;
/** The rate-limit skip window when the provider gives no `Retry-After`. */
const DEFAULT_RATE_LIMIT_SECONDS = 60;

type SkipKind = Exclude<EngineStatus["state"], "ready" | "no-key">;

/**
 * Browser-safe factories only: `edge`, and relay clients for the keyed engine ids (they hold no key).
 * `anytts/server` replaces the relay clients with the keyed engines.
 */
const BUILTIN_ENGINES: Record<string, EngineFactory> = { edge: createEdgeEngine, ...RELAY_ENGINES };

const abortError = (): Error =>
  typeof DOMException === "function"
    ? new DOMException("The operation was aborted.", "AbortError")
    : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

interface Resolved {
  engineId: string;
  retries: number;
  voice: string;
  /** The text the engine speaks: the request text, respelled when the engine's pronunciation is on. */
  text: string;
  key: string;
  /** One engine call. */
  call(signal: AbortSignal, hooks: EngineHooks): Promise<SynthesisResult>;
  /** Caches a result: under `key`, or (a browser cascade) under the member key plus `key` as its alias. */
  store(result: SynthesisResult): void;
}

/** One caller's hooks and which of them it has already heard. */
interface Listener {
  req: SynthesisRequest;
  started: boolean;
  firstByte: boolean;
}

/** Phases a flight has reached, shared by every attempt, and the callers still listening. */
interface Phases {
  started: boolean;
  firstByte: boolean;
  listeners: Set<Listener>;
}

interface InFlight {
  job: ScheduledJob<SynthesisResult>;
  controller: AbortController;
  callers: number;
  /** Callers that are not a cascade walk; while there are none, a skip window open at start cancels the job. */
  direct: number;
  phases: Phases;
}

/** One running engine call; `restartStalled` aborts it while `firstByte` is still false. */
interface RunningAttempt {
  controller: AbortController;
  firstByte: boolean;
}

const newPhases = (): Phases => ({ started: false, firstByte: false, listeners: new Set() });

/** Brings `listener` up to the phases reached so far, in order; a removed (aborted) listener hears nothing. */
const notify = (phases: Phases, listener: Listener): void => {
  if (phases.started && !listener.started && phases.listeners.has(listener)) {
    listener.started = true;
    try {
      listener.req.onStart?.();
    } catch {
      // A faulty hook must not fail the synthesis.
    }
  }
  if (phases.firstByte && !listener.firstByte && phases.listeners.has(listener)) {
    listener.firstByte = true;
    try {
      listener.req.onFirstByte?.();
    } catch {
      // ignored
    }
  }
};

/** Marks `phase` reached once per flight (a retry does not re-fire it) and tells every listener. */
const reach = (phases: Phases, phase: "started" | "firstByte"): void => {
  if (phases[phase]) return;
  phases[phase] = true;
  for (const listener of [...phases.listeners]) notify(phases, listener);
};

/** Registers a caller; phases already passed are delivered in a microtask, after `synthesize` returns. */
const listen = (phases: Phases, req: SynthesisRequest): Listener => {
  const listener: Listener = { req, started: false, firstByte: false };
  phases.listeners.add(listener);
  if (phases.started) queueMicrotask(() => notify(phases, listener));
  return listener;
};

/** A `cascade` relay client; `order` and `voices` belong to the relay's (Node) config. */
function relayCascadeFrom(config: Record<string, unknown>): RelayCascade {
  if (config.order !== undefined) throw new RangeError("cascade takes either order (a local walk) or relayUrl (a relay client), not both");
  if (config.voices !== undefined) throw new RangeError("cascade has no voices: set them per member");
  return createRelayCascade(config);
}

/** Canonical form of the options a cascade request carries: same meaning, same string. */
function cascadeOptionsHash(req: SynthesisRequest): string {
  const sorted = <T>(record: Record<string, T> | undefined): [string, T][] =>
    Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([sorted(req.voices), req.order === undefined ? null : [...new Set(req.order)], sorted(req.pronunciation)]);
}

export function createTts(config: TtsConfig, internals: CreateTtsInternals = {}): Tts {
  const factories = { ...BUILTIN_ENGINES, ...internals.engineFactories };
  // `config` is the engine's effective config: unset `voices` / `maxConcurrent` take the engine's defaults.
  const engines = new Map<string, { engine: Engine; config: EngineConfig }>();
  for (const [id, engineConfig] of Object.entries(config.engines)) {
    if (id === CASCADE) continue;
    const factory = Object.hasOwn(factories, id) ? factories[id] : undefined;
    if (!factory) throw new RangeError(`unknown engine: ${id}`);
    const { voices: _voices, retries: _retries, pronunciation: _pronunciation, maxConcurrent: _maxConcurrent, ...options } = engineConfig;
    const engine = factory(options);
    const voices = engineConfig.voices ?? engine.defaults?.voices;
    const maxConcurrent = engineConfig.maxConcurrent ?? engine.defaults?.maxConcurrent;
    engines.set(id, {
      engine,
      config: {
        ...engineConfig,
        ...(voices !== undefined ? { voices } : {}),
        ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
      },
    });
  }
  const cascadeConfig: Record<string, unknown> | undefined = Object.hasOwn(config.engines, CASCADE) ? config.engines[CASCADE] : undefined;
  // `{ relayUrl }` makes the cascade a relay client (the browser); `{ order }` walks locally.
  const relayCascade: RelayCascade | undefined = cascadeConfig && cascadeConfig.relayUrl !== undefined ? relayCascadeFrom(cascadeConfig) : undefined;
  const members = cascadeConfig && !relayCascade ? cascadeMembers(cascadeConfig, (id) => engines.has(id)) : undefined;
  const hasCascade = members !== undefined || relayCascade !== undefined;
  if (!engines.has(config.defaultEngine) && !(config.defaultEngine === CASCADE && hasCascade)) throw new RangeError(`default engine is not configured: ${config.defaultEngine}`);

  const cache = new LruCache<SynthesisResult>(config.cache);
  // Engines without an effective `maxConcurrent` are unlimited, bounded only by the scheduler's concurrency.
  const slots: Record<string, number> = {};
  for (const [id, { config: c }] of engines) if (c.maxConcurrent !== undefined) slots[id] = c.maxConcurrent;
  const scheduler = createScheduler(config.scheduler, slots);
  const defaultTier = config.scheduler.tiers[0]?.name;
  const inFlight = new Map<string, InFlight>();
  // In-flight (`pending` / `drop`) listeners; cache events come straight from `LruCache`.
  const listeners = new Set<TtsListener>();
  const running = new Set<RunningAttempt>();

  const emit = (e: TtsEvent): void => {
    for (const listener of [...listeners]) {
      // A faulty listener must not break synthesis or starve the other listeners.
      try {
        listener(e);
      } catch {
        // ignored
      }
    }
  };

  /**
   * Removes `flight` from the in-flight map once; the removal that finds no cached result is the
   * `drop`. A later settle for the same flight (the `job.done` release after an abort) is a no-op.
   */
  const settle = (key: string, flight: InFlight): void => {
    // An engine may hold its hooks past the settle; it must not keep callers' requests alive.
    flight.phases.listeners.clear();
    if (inFlight.get(key) !== flight) return;
    inFlight.delete(key);
    if (!cache.has(key)) emit({ type: "drop", key });
  };

  /** The text engine `engineId` speaks for `req`: respelled when its pronunciation is on and `lang` is given. */
  const prepareText = (engineId: string, req: SynthesisRequest, pronounceOverride?: boolean): string => {
    const pronounce = pronounceOverride ?? engines.get(engineId)?.config.pronunciation ?? engineId === "edge";
    return pronounce && req.lang !== undefined ? applyPronunciation(req.text, req.lang, config.pronunciation) : req.text;
  };

  // Built on the prepared text, so the same request text with and without a map never collides;
  // `lang` is part of it because an engine may speak the same text differently per language.
  const memberKey = (engineId: string, voice: string, lang: string | undefined, text: string): string =>
    JSON.stringify([engineId, voice, lang ?? null, text]);

  /**
   * Throws RangeError for an unconfigured engine and `unknown-voice` for a voice outside its catalog.
   * `pronounce` overrides the engine's `pronunciation` setting (a cascade request's per-member flag).
   */
  const resolveEngine = (engineId: string, req: SynthesisRequest, voiceOverride?: string, pronounceOverride?: boolean): Resolved => {
    const entry = engines.get(engineId);
    if (!entry) throw new UnknownEngineError(engineId);
    // Snapshot the language once: the deferred call (and its retries) must not see a later mutation of `req`.
    const lang = req.lang;
    const voices = entry.config.voices ?? {};
    const voice = voiceOverride ?? (lang !== undefined && Object.hasOwn(voices, lang) ? voices[lang] : undefined) ?? voices.default;
    if (voice === undefined) throw new TtsError("unknown-voice", `${engineId} has no voice for ${lang ?? "default"}`);
    if (!entry.engine.voices.some((v) => v.id === voice)) {
      throw new TtsError("unknown-voice", `voice ${voice} is not in the ${engineId} catalog`);
    }
    const text = prepareText(engineId, req, pronounceOverride);
    const key = memberKey(engineId, voice, lang, text);
    return {
      engineId,
      retries: entry.config.retries ?? DEFAULT_RETRIES,
      voice,
      text,
      key,
      call: async (signal, hooks) => ({
        bytes: await entry.engine.synthesize(text, voice, signal, hooks, lang),
        mime: "audio/mpeg",
        engine: engineId,
        voice,
      }),
      store: (result) => cache.set(key, result),
    };
  };

  /**
   * A browser cascade request: one relay call, keyed by the Cascade alias `(cascade, lang,
   * optionsHash, text)`. Its result is cached under the member key the relay names (built as a
   * direct request to that member would build it) and the alias points at that entry; when that
   * member key already holds an entry, the result is cached under the alias key alone instead.
   */
  const resolveRelayCascade = (req: SynthesisRequest): Resolved => {
    // One voice id cannot name voices of several engines.
    if (req.voice !== undefined) throw new TtsError("unknown-voice", "a cascade request takes `voices` per member, not `voice`");
    // `store` runs after the relay answers: rebuild the member key from the request as it was resolved.
    const snapshot: SynthesisRequest = { ...req };
    const key = JSON.stringify([CASCADE, req.lang ?? null, cascadeOptionsHash(req), req.text]);
    const body = {
      text: req.text,
      ...(req.lang !== undefined ? { lang: req.lang } : {}),
      ...(req.voices !== undefined ? { voices: req.voices } : {}),
      ...(req.order !== undefined ? { order: req.order } : {}),
      ...(req.pronunciation !== undefined ? { pronunciation: req.pronunciation } : {}),
    };
    return {
      engineId: CASCADE,
      // One relay call is a whole member walk: retrying it re-spends every member it tried, so the
      // browser cascade does not retry unless its config says so.
      retries: typeof cascadeConfig!.retries === "number" ? cascadeConfig!.retries : 0,
      voice: "",
      text: req.text,
      key,
      call: async (signal, hooks) => ({ ...(await relayCascade!.synthesize(body, signal, hooks)), mime: "audio/mpeg" }),
      store: (result) => {
        const { pronunciation } = snapshot;
        const pronounce = pronunciation && Object.hasOwn(pronunciation, result.engine) ? pronunciation[result.engine] : undefined;
        const member = memberKey(result.engine, result.voice, snapshot.lang, prepareText(result.engine, snapshot, pronounce));
        // The rebuilt key guesses the relay's prepared text (its pronunciation config may differ), so
        // another answer may already sit there: never overwrite it, keep this one under the alias key.
        if (cache.has(member)) {
          cache.set(key, result);
          return;
        }
        cache.set(member, result);
        cache.alias(key, member);
      },
    };
  };

  const resolve = (req: SynthesisRequest): Resolved => resolveEngine(req.engine ?? config.defaultEngine, req, req.voice);

  const isCascade = (req: SynthesisRequest): boolean => members !== undefined && (req.engine ?? config.defaultEngine) === CASCADE;
  const isRelayCascade = (req: SynthesisRequest): boolean => relayCascade !== undefined && (req.engine ?? config.defaultEngine) === CASCADE;

  const now = internals.now ?? Date.now;
  /** Open skip windows by member id; `until` is epoch ms, `Infinity` for the instance's life. */
  const windows = new Map<string, { kind: SkipKind; until: number }>();

  const hasNoKey = (id: string): boolean => {
    const { engine, config: c } = engines.get(id)!;
    return engine.keyed === true && !(typeof c.apiKey === "string" && c.apiKey.length > 0);
  };

  /** The member's open window; a closed one is forgotten. */
  const openWindow = (id: string): { kind: SkipKind; until: number } | undefined => {
    const window = windows.get(id);
    if (window && window.until <= now()) {
      windows.delete(id);
      return undefined;
    }
    return window;
  };

  /**
   * A keyed engine without an `apiKey`, or one inside a skip window, is passed over by the cascade,
   * never asked; its cached results still answer.
   */
  const skipReason = (id: string): TtsError | undefined => {
    if (hasNoKey(id)) return new TtsError("unauthorized", `${id} has no key: skipped by the cascade`);
    const window = openWindow(id);
    if (!window) return undefined;
    const span = window.until === Infinity ? "for this instance's life" : `until ${new Date(window.until).toISOString()}`;
    // A rate-limit window tells the caller how long is left, so a relay can send `Retry-After`.
    const retryAfter = window.kind === "rate-limited" ? Math.ceil((window.until - now()) / 1000) : undefined;
    return new TtsError(window.kind, `${id} is skipped by the cascade ${span} (${window.kind})`, retryAfter === undefined ? {} : { retryAfter });
  };

  /**
   * Opens the engine's skip window for a quota, auth or rate-limit failure, from a cascade attempt
   * or a direct request; other kinds open none. Called from the job itself, before its slot frees,
   * so a job queued behind it in the same slot sees the window when it starts.
   */
  const onFailure = (id: string, error: TtsError): void => {
    const at = now();
    let until: number;
    if (error.kind === "quota-exhausted") {
      const date = new Date(at);
      until = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    } else if (error.kind === "rate-limited") {
      until = at + (error.retryAfter ?? DEFAULT_RATE_LIMIT_SECONDS) * 1000;
    } else if (error.kind === "unauthorized") {
      until = Infinity;
    } else {
      return;
    }
    // A later refusal never shortens an open window (nor replaces a longer one's kind).
    if ((openWindow(id)?.until ?? -Infinity) >= until) return;
    windows.set(id, { kind: error.kind, until });
  };

  /** The cascade's view of its members for one request; `run` is filled in by `synthesize`. */
  const cascadeMembersFor = (
    req: SynthesisRequest,
    run: (r: Resolved) => Promise<SynthesisResult> = () => Promise.reject(new Error("not runnable")),
  ): CascadeMembers<Resolved, SynthesisResult> => ({
    skipReason,
    prepare: (id) =>
      resolveEngine(
        id,
        req,
        req.voices && Object.hasOwn(req.voices, id) ? req.voices[id] : undefined,
        req.pronunciation && Object.hasOwn(req.pronunciation, id) ? req.pronunciation[id] : undefined,
      ),
    isCached: (r) => cache.has(r.key),
    run,
  });

  const attempt = async (r: Resolved, signal: AbortSignal, phases: Phases): Promise<SynthesisResult> => {
    for (let tries = 0; ; tries++) {
      // An `onStart` hook may have aborted the only caller: no engine call for nobody.
      if (signal.aborted) throw abortError();
      // A per-attempt controller, linked to the job's, lets `restartStalled` end this call alone.
      const current: RunningAttempt = { controller: new AbortController(), firstByte: false };
      const onJobAbort = () => current.controller.abort(signal.reason);
      signal.addEventListener("abort", onJobAbort, { once: true });
      running.add(current);
      const hooks = {
        onFirstByte: () => {
          // An abandoned call reporting late audio must not speak for the attempt that replaced it.
          if (current.controller.signal.aborted) return;
          current.firstByte = true;
          reach(phases, "firstByte");
        },
      };
      try {
        return await r.call(current.controller.signal, hooks);
      } catch (caught) {
        // An engine call ended by `restartStalled` fails with the restart's reason; a job abort stays as is.
        const { reason } = current.controller.signal;
        const error = !signal.aborted && current.controller.signal.aborted && reason instanceof TtsError ? reason : caught;
        const retry = error instanceof TtsError && isTransient(error.kind) && tries < r.retries && !signal.aborted;
        if (!retry) throw error;
      } finally {
        running.delete(current);
        signal.removeEventListener("abort", onJobAbort);
      }
    }
  };

  const start = (r: Resolved, tier: string): InFlight => {
    const controller = new AbortController();
    // Created before enqueue: a free slot may run the job synchronously.
    const phases = newPhases();
    // Unset while `enqueue` runs: a job started synchronously was enqueued right after the cascade's own skip check.
    let flight: InFlight | undefined;
    const job = scheduler.enqueue(tier, async () => {
      // Only cascade walks wait on this job: a window opened while it was queued passes the member over.
      const skipped = flight !== undefined && flight.direct === 0 && engines.has(r.engineId) ? skipReason(r.engineId) : undefined;
      if (skipped) {
        // Out of the map before the throw: a direct request arriving before `release` runs starts a
        // fresh job instead of joining this dead one.
        settle(r.key, flight!);
        throw new MemberSkippedError(skipped);
      }
      reach(phases, "started");
      let result: SynthesisResult;
      try {
        result = await attempt(r, controller.signal, phases);
      } catch (error) {
        // Before the slot frees. The browser cascade's relay keeps its own windows: it opens none here.
        if (error instanceof TtsError && engines.has(r.engineId)) onFailure(r.engineId, error);
        throw error;
      }
      // Only a job still owned by callers stores its result.
      if (!controller.signal.aborted) r.store(result);
      return result;
    }, r.engineId);
    flight = { job, controller, callers: 0, direct: 0, phases };
    inFlight.set(r.key, flight);
    emit({ type: "pending", key: r.key });
    const release = () => settle(r.key, flight);
    job.done.then(release, release);
    return flight;
  };

  const synthesize = (req: SynthesisRequest): Promise<SynthesisResult> => {
    if (isCascade(req)) return synthesizeCascade(req);
    if (isRelayCascade(req)) {
      // The relay keeps the skip windows; the browser opens none for its cascade.
      try {
        return synthesizeResolved(resolveRelayCascade(req), req);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    let r: Resolved;
    try {
      r = resolve(req);
    } catch (error) {
      return Promise.reject(error);
    }
    // A direct refusal opens the engine's skip window too (in the job), so `engineStatus` reports it.
    return synthesizeResolved(r, req);
  };

  /**
   * The cascade walk is not a scheduler job itself: each member goes through its own path (cache,
   * then a job in that member's slot group, at the caller's tier), so a busy member is waited for
   * without holding a scheduler slot for the whole chain.
   */
  const synthesizeCascade = (req: SynthesisRequest): Promise<SynthesisResult> => {
    // One voice id cannot name voices of several engines.
    if (req.voice !== undefined) return Promise.reject(new TtsError("unknown-voice", "a cascade request takes `voices` per member, not `voice`"));
    let order: string[];
    try {
      order = effectiveOrder(members!, req.order);
    } catch (error) {
      return Promise.reject(error);
    }
    // The caller hears each phase once, however many members the walk tries.
    let started = false;
    let firstByte = false;
    const memberReq: SynthesisRequest = {
      ...req,
      onStart: req.onStart && (() => {
        if (started) return;
        started = true;
        req.onStart!();
      }),
      onFirstByte: req.onFirstByte && (() => {
        if (firstByte) return;
        firstByte = true;
        req.onFirstByte!();
      }),
    };
    return walkCascade(order, cascadeMembersFor(req, (r) => synthesizeResolved(r, memberReq, true))).catch((error: unknown) => {
      // An abort that lands while a member's failure is on its way to the caller still wins.
      throw req.signal?.aborted && error instanceof TtsError ? abortError() : error;
    });
  };

  /** `viaCascade`: the caller is a cascade walk, which a skip window opened before the job starts turns away. */
  const synthesizeResolved = (r: Resolved, req: SynthesisRequest, viaCascade = false): Promise<SynthesisResult> => {
    const { signal } = req;
    if (signal?.aborted) return Promise.reject(abortError());
    const hit = cache.get(r.key);
    if (hit) {
      // A cache hit has passed both phases; the caller still hears them, unless it aborts first.
      const listener: Listener = { req, started: false, firstByte: false };
      const phases: Phases = { started: true, firstByte: true, listeners: new Set([listener]) };
      queueMicrotask(() => {
        if (!signal?.aborted) notify(phases, listener);
      });
      return Promise.resolve({ ...hit });
    }

    const tier = req.tier ?? defaultTier ?? "";
    let flight = inFlight.get(r.key);
    if (flight) {
      // Counted before `promote`: it may start the job synchronously, and the start-time skip check
      // and any `onStart` abort must already see this caller.
      flight.callers++;
      if (!viaCascade) flight.direct++;
      try {
        flight.job.promote(tier);
      } catch (error) {
        // The scheduler throws RangeError for an unknown tier; surface it as a rejection.
        flight.callers--;
        if (!viaCascade) flight.direct--;
        return Promise.reject(error);
      }
    } else {
      try {
        flight = start(r, tier);
      } catch (error) {
        return Promise.reject(error);
      }
      flight.callers++;
      if (!viaCascade) flight.direct++;
    }
    const joined = flight;
    const listener = listen(joined.phases, req);

    return new Promise<SynthesisResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        joined.phases.listeners.delete(listener);
        joined.callers--;
        if (!viaCascade) joined.direct--;
        if (joined.callers === 0) {
          // Nobody is waiting any more: drop the queued job or stop the running one.
          settle(r.key, joined);
          if (!joined.job.remove()) joined.controller.abort();
        }
        rejectPromise(abortError());
      };
      // A pending listener may have aborted the signal already; addEventListener would never replay that.
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      joined.job.done.then(
        (result) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolvePromise({ ...result });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          // Only a cascade walk understands a skip; anyone else hears the refusal behind it.
          rejectPromise(!viaCascade && error instanceof MemberSkippedError ? error.reason : error);
        },
      );
    });
  };

  /** `ready` when a member key is cached, `pending` while a member's job for this request is queued or running. */
  const cascadeState = (req: SynthesisRequest): "cold" | "pending" | "ready" => {
    if (req.voice !== undefined) return "cold";
    const order = effectiveOrder(members!, req.order);
    const view = cascadeMembersFor(req);
    if (cachedMember(order, view) !== undefined) return "ready";
    for (const id of order) {
      // `cachedMember` has already checked every such member can speak the request.
      if (!view.skipReason(id) && inFlight.has(view.prepare(id).key)) return "pending";
    }
    return "cold";
  };

  const tts: Tts = {
    synthesize,
    prefetch(req) {
      synthesize(req).catch(() => {});
    },
    isCached(req) {
      try {
        if (isCascade(req)) return req.voice === undefined && cachedMember(effectiveOrder(members!, req.order), cascadeMembersFor(req)) !== undefined;
        // A browser cascade reads its alias: nothing is known about it before the relay's first answer.
        if (isRelayCascade(req)) return cache.has(resolveRelayCascade(req).key);
        return cache.has(resolve(req).key);
      } catch {
        return false;
      }
    },
    state(req) {
      try {
        if (isCascade(req)) return cascadeState(req);
        const { key } = isRelayCascade(req) ? resolveRelayCascade(req) : resolve(req);
        return cache.has(key) ? "ready" : inFlight.has(key) ? "pending" : "cold";
      } catch {
        return "cold";
      }
    },
    subscribe(listener) {
      const unsubscribeCache = cache.subscribe(listener);
      listeners.add(listener);
      return () => {
        unsubscribeCache();
        listeners.delete(listener);
      };
    },
    restartStalled() {
      let restarted = false;
      for (const current of [...running]) {
        // Already aborted (job aborted, or restarted) but not yet in its `finally`: nothing to restart.
        if (current.firstByte || current.controller.signal.aborted) continue;
        // Deregistered now, not when the call settles, so a second call before the retry is a no-op.
        running.delete(current);
        current.controller.abort(new TtsError("first-byte-timeout", "restarted before the first audio byte"));
        restarted = true;
      }
      return restarted;
    },
    engineStatus(id) {
      if (!engines.has(id)) throw new RangeError(`unknown engine: ${id}`);
      if (hasNoKey(id)) return { state: "no-key" };
      const window = openWindow(id);
      if (!window) return { state: "ready" };
      return window.until === Infinity ? { state: window.kind } : { state: window.kind, until: new Date(window.until).toISOString() };
    },
  };
  registerVoiceSource(
    tts,
    new Map([
      ...[...engines].map(([id, { engine, config: c }]) => [id, { voices: c.voices ?? {}, catalog: engine.voices }] as const),
      // The cascade has no voices of its own.
      ...(hasCascade ? [[CASCADE, { voices: {}, catalog: [] }] as const] : []),
    ]),
  );
  return tts;
}
