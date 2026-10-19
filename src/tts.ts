import { LruCache } from "./cache.js";
import type { Engine } from "./engine.js";
import { createEdgeEngine, type EdgeEngineOptions } from "./engines/edge/engine.js";
import { isTransient, TtsError } from "./errors.js";
import { createScheduler, type ScheduledJob, type SchedulerConfig } from "./scheduler.js";
import { registerVoiceSource } from "./voices.js";

export interface SynthesisRequest {
  text: string;
  lang?: string;
  voice?: string;
  engine?: string;
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
  engine: string;
  voice: string;
}

export type EngineConfig = {
  voices: Record<string, string> & { default: string };
  /** Extra attempts after a transient failure. Default 1. */
  retries?: number;
} & EdgeEngineOptions;

export interface TtsConfig {
  engines: Record<string, EngineConfig>;
  defaultEngine: string;
  scheduler: SchedulerConfig;
  cache?: { max?: number };
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
   */
  restartStalled(): boolean;
}

export type EngineFactory = (options: EdgeEngineOptions) => Engine;

/** Internal seam (not re-exported from the package entry): tests swap engines for fakes. */
export interface CreateTtsInternals {
  engineFactories?: Record<string, EngineFactory>;
}

const DEFAULT_RETRIES = 1;

const BUILTIN_ENGINES: Record<string, EngineFactory> = { edge: createEdgeEngine };

const abortError = (): Error =>
  typeof DOMException === "function"
    ? new DOMException("The operation was aborted.", "AbortError")
    : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

interface Resolved {
  engineId: string;
  engine: Engine;
  retries: number;
  voice: string;
  key: string;
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

export function createTts(config: TtsConfig, internals: CreateTtsInternals = {}): Tts {
  const factories = { ...BUILTIN_ENGINES, ...internals.engineFactories };
  const engines = new Map<string, { engine: Engine; config: EngineConfig }>();
  for (const [id, engineConfig] of Object.entries(config.engines)) {
    const factory = Object.hasOwn(factories, id) ? factories[id] : undefined;
    if (!factory) throw new RangeError(`unknown engine: ${id}`);
    const { voices: _voices, retries: _retries, ...options } = engineConfig;
    engines.set(id, { engine: factory(options), config: engineConfig });
  }
  if (!engines.has(config.defaultEngine)) throw new RangeError(`default engine is not configured: ${config.defaultEngine}`);

  const cache = new LruCache<SynthesisResult>(config.cache);
  const scheduler = createScheduler(config.scheduler);
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

  /** Throws RangeError for an unconfigured engine and `unknown-voice` for a voice outside its catalog. */
  const resolve = (req: SynthesisRequest): Resolved => {
    const engineId = req.engine ?? config.defaultEngine;
    const entry = engines.get(engineId);
    if (!entry) throw new RangeError(`engine is not configured: ${engineId}`);
    const { voices } = entry.config;
    const voice = req.voice ?? (req.lang !== undefined && Object.hasOwn(voices, req.lang) ? voices[req.lang] : undefined) ?? voices.default;
    if (!entry.engine.voices.some((v) => v.id === voice)) {
      throw new TtsError("unknown-voice", `voice ${voice} is not in the ${engineId} catalog`);
    }
    return {
      engineId,
      engine: entry.engine,
      retries: entry.config.retries ?? DEFAULT_RETRIES,
      voice,
      key: JSON.stringify([engineId, voice, req.text]),
    };
  };

  const attempt = async (r: Resolved, text: string, signal: AbortSignal, phases: Phases): Promise<SynthesisResult> => {
    for (let tries = 0; ; tries++) {
      // An `onStart` hook may have aborted the only caller: no engine call for nobody.
      if (signal.aborted) throw abortError();
      // A per-attempt controller, linked to the job's, lets `restartStalled` end this call alone.
      const current: RunningAttempt = { controller: new AbortController(), firstByte: false };
      const onJobAbort = () => current.controller.abort(signal.reason);
      signal.addEventListener("abort", onJobAbort, { once: true });
      if (signal.aborted) onJobAbort();
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
        const bytes = await r.engine.synthesize(text, r.voice, current.controller.signal, hooks);
        return { bytes, mime: "audio/mpeg", engine: r.engineId, voice: r.voice };
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

  const start = (r: Resolved, text: string, tier: string): InFlight => {
    const controller = new AbortController();
    // Created before enqueue: a free slot may run the job synchronously.
    const phases = newPhases();
    const job = scheduler.enqueue(tier, async () => {
      reach(phases, "started");
      const result = await attempt(r, text, controller.signal, phases);
      // Only a job still owned by callers stores its result.
      if (!controller.signal.aborted) cache.set(r.key, result);
      return result;
    });
    const flight: InFlight = { job, controller, callers: 0, phases };
    inFlight.set(r.key, flight);
    emit({ type: "pending", key: r.key });
    const release = () => settle(r.key, flight);
    job.done.then(release, release);
    return flight;
  };

  const synthesize = (req: SynthesisRequest): Promise<SynthesisResult> => {
    let r: Resolved;
    try {
      r = resolve(req);
    } catch (error) {
      return Promise.reject(error);
    }
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
    try {
      // The scheduler throws RangeError for an unknown tier; surface it as a rejection.
      if (flight) flight.job.promote(tier);
      else flight = start(r, req.text, tier);
    } catch (error) {
      return Promise.reject(error);
    }
    flight.callers++;
    const joined = flight;
    const listener = listen(joined.phases, req);

    return new Promise<SynthesisResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        joined.phases.listeners.delete(listener);
        joined.callers--;
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
          rejectPromise(error);
        },
      );
    });
  };

  const tts: Tts = {
    synthesize,
    prefetch(req) {
      synthesize(req).catch(() => {});
    },
    isCached(req) {
      try {
        return cache.has(resolve(req).key);
      } catch {
        return false;
      }
    },
    state(req) {
      try {
        const { key } = resolve(req);
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
        if (current.firstByte) continue;
        // Deregistered now, not when the call settles, so a second call before the retry is a no-op.
        running.delete(current);
        current.controller.abort(new TtsError("first-byte-timeout", "restarted before the first audio byte"));
        restarted = true;
      }
      return restarted;
    },
  };
  registerVoiceSource(
    tts,
    new Map([...engines].map(([id, { engine, config: c }]) => [id, { voices: c.voices, catalog: engine.voices }])),
  );
  return tts;
}
