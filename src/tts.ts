import { LruCache, type CacheListener } from "./cache.js";
import type { Engine } from "./engine.js";
import { createEdgeEngine, type EdgeEngineOptions } from "./engines/edge/engine.js";
import { isTransient, TtsError } from "./errors.js";
import { createScheduler, type ScheduledJob, type SchedulerConfig } from "./scheduler.js";

export interface SynthesisRequest {
  text: string;
  lang?: string;
  voice?: string;
  engine?: string;
  tier?: string;
  signal?: AbortSignal;
}

export interface SynthesisResult {
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

export interface Tts {
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
  prefetch(req: SynthesisRequest): void;
  isCached(req: SynthesisRequest): boolean;
  subscribe(listener: (e: { type: "add" | "evict"; key: string }) => void): () => void;
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

interface InFlight {
  job: ScheduledJob<SynthesisResult>;
  controller: AbortController;
  callers: number;
}

export function createTts(config: TtsConfig, internals: CreateTtsInternals = {}): Tts {
  const factories = { ...BUILTIN_ENGINES, ...internals.engineFactories };
  const engines = new Map<string, { engine: Engine; config: EngineConfig }>();
  for (const [id, engineConfig] of Object.entries(config.engines)) {
    const factory = factories[id];
    if (!factory) throw new RangeError(`unknown engine: ${id}`);
    const { voices: _voices, retries: _retries, ...options } = engineConfig;
    engines.set(id, { engine: factory(options), config: engineConfig });
  }
  if (!engines.has(config.defaultEngine)) throw new RangeError(`default engine is not configured: ${config.defaultEngine}`);

  const cache = new LruCache<SynthesisResult>(config.cache);
  const scheduler = createScheduler(config.scheduler);
  const defaultTier = config.scheduler.tiers[0]?.name;
  const inFlight = new Map<string, InFlight>();

  /** Throws RangeError for an unconfigured engine and `unknown-voice` for a voice outside its catalog. */
  const resolve = (req: SynthesisRequest): Resolved => {
    const engineId = req.engine ?? config.defaultEngine;
    const entry = engines.get(engineId);
    if (!entry) throw new RangeError(`engine is not configured: ${engineId}`);
    const { voices } = entry.config;
    const voice = req.voice ?? (req.lang !== undefined ? voices[req.lang] : undefined) ?? voices.default;
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

  const attempt = async (r: Resolved, text: string, signal: AbortSignal): Promise<SynthesisResult> => {
    for (let tries = 0; ; tries++) {
      try {
        const bytes = await r.engine.synthesize(text, r.voice, signal);
        return { bytes, mime: "audio/mpeg", engine: r.engineId, voice: r.voice };
      } catch (error) {
        const retry = error instanceof TtsError && isTransient(error.kind) && tries < r.retries && !signal.aborted;
        if (!retry) throw error;
      }
    }
  };

  const start = (r: Resolved, text: string, tier: string): InFlight => {
    const controller = new AbortController();
    const job = scheduler.enqueue(tier, async () => {
      const result = await attempt(r, text, controller.signal);
      // Only a job still owned by callers stores its result.
      if (!controller.signal.aborted) cache.set(r.key, result);
      return result;
    });
    const flight: InFlight = { job, controller, callers: 0 };
    inFlight.set(r.key, flight);
    const release = () => {
      if (inFlight.get(r.key) === flight) inFlight.delete(r.key);
    };
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
    const hit = cache.get(r.key);
    if (hit) return Promise.resolve({ ...hit });
    const { signal } = req;
    if (signal?.aborted) return Promise.reject(abortError());

    const tier = req.tier ?? defaultTier ?? "";
    let flight = inFlight.get(r.key);
    if (flight) flight.job.promote(tier);
    else flight = start(r, req.text, tier);
    flight.callers++;
    const joined = flight;

    return new Promise<SynthesisResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        joined.callers--;
        if (joined.callers === 0) {
          // Nobody is waiting any more: drop the queued job or stop the running one.
          if (inFlight.get(r.key) === joined) inFlight.delete(r.key);
          if (!joined.job.remove()) joined.controller.abort();
        }
        rejectPromise(abortError());
      };
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

  return {
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
    subscribe(listener: CacheListener) {
      return cache.subscribe(listener);
    },
  };
}
