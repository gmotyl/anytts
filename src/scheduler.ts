export interface SchedulerConfig {
  concurrency: number;
  /** Ordered most-important first. */
  tiers: { name: string; cap?: number }[];
}
// cap = max jobs in flight from this tier and every tier below it

export interface ScheduledJob<T> {
  readonly tier: string;
  readonly started: boolean;
  /** Settles with the job body's outcome; rejects `AbortError` when removed before starting. */
  readonly done: Promise<T>;
  /** Moves a waiting job to a higher tier, keeping its original enqueue time. No-op otherwise. */
  promote(tier: string): void;
  /** Drops a waiting job so it never starts. Returns false once it has started or was removed. */
  remove(): boolean;
}

export interface Scheduler {
  /** Queues `run`; its slot is released when the returned promise settles. */
  enqueue<T>(tier: string, run: () => Promise<T>): ScheduledJob<T>;
}

interface Entry {
  seq: number;
  tier: number;
  start: () => void;
}

const abortError = (): Error =>
  typeof DOMException === "function"
    ? new DOMException("The job was removed", "AbortError")
    : Object.assign(new Error("The job was removed"), { name: "AbortError" });

export function createScheduler(config: SchedulerConfig): Scheduler {
  const tierIndex = new Map(config.tiers.map((t, i) => [t.name, i]));
  const caps = config.tiers.map((t) => t.cap);
  // inFlight[i] = running jobs of tier i
  const inFlight: number[] = config.tiers.map(() => 0);
  const waiting: Entry[] = [];
  let seq = 0;

  const indexOf = (name: string): number => {
    const index = tierIndex.get(name);
    if (index === undefined) throw new RangeError(`unknown tier: ${name}`);
    return index;
  };

  const canStart = (tier: number): boolean => {
    let total = 0;
    for (const n of inFlight) total += n;
    if (total >= config.concurrency) return false;
    // A job of `tier` counts against the cap of every tier at or above it.
    let below = 0;
    for (let i = inFlight.length - 1; i >= 0; i--) {
      below += inFlight[i]!;
      const cap = caps[i];
      if (i <= tier && cap !== undefined && below >= cap) return false;
    }
    return true;
  };

  const pump = (): void => {
    for (;;) {
      let next: Entry | undefined;
      for (const entry of waiting) {
        if (!canStart(entry.tier)) continue;
        if (!next || entry.tier < next.tier || (entry.tier === next.tier && entry.seq < next.seq)) next = entry;
      }
      if (!next) return;
      waiting.splice(waiting.indexOf(next), 1);
      next.start();
    }
  };

  return {
    enqueue<T>(tierName: string, run: () => Promise<T>): ScheduledJob<T> {
      const entry: Entry = { seq: seq++, tier: indexOf(tierName), start: () => {} };
      let state: "waiting" | "started" | "removed" = "waiting";
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const done = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Removal rejects `done`; keep that from surfacing as unhandled when nobody listens.
      done.catch(() => {});

      entry.start = () => {
        state = "started";
        const tier = entry.tier;
        inFlight[tier]!++;
        let body: Promise<T>;
        try {
          body = Promise.resolve(run());
        } catch (error) {
          body = Promise.reject(error);
        }
        body.then(resolve, reject).finally(() => {
          inFlight[tier]!--;
          pump();
        });
      };

      waiting.push(entry);
      pump();

      return {
        get tier() {
          return config.tiers[entry.tier]!.name;
        },
        get started() {
          return state === "started";
        },
        done,
        promote(name: string) {
          const target = indexOf(name);
          if (state !== "waiting" || target >= entry.tier) return;
          entry.tier = target;
          pump();
        },
        remove() {
          if (state !== "waiting") return false;
          state = "removed";
          waiting.splice(waiting.indexOf(entry), 1);
          reject(abortError());
          return true;
        },
      };
    },
  };
}
