export interface CacheEvent {
  type: "add" | "evict";
  key: string;
}

export type CacheListener = (e: CacheEvent) => void;

export interface LruCacheOptions {
  /** Maximum number of entries; the least recently used is evicted past it. Default 200. */
  max?: number;
}

export const DEFAULT_CACHE_MAX = 200;

/** Map-backed LRU: insertion order is recency order (oldest first). */
export class LruCache<V> {
  readonly max: number;
  private readonly entries = new Map<string, V>();
  private readonly listeners = new Set<CacheListener>();

  constructor(options: LruCacheOptions = {}) {
    const max = options.max ?? DEFAULT_CACHE_MAX;
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`cache max must be a positive integer, got ${max}`);
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    const existed = this.entries.delete(key);
    this.entries.set(key, value);
    // Settle the entries before notifying, so listeners always see a cache within `max`.
    const events: CacheEvent[] = existed ? [] : [{ type: "add", key }];
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      events.push({ type: "evict", key: oldest });
    }
    for (const e of events) this.emit(e);
  }

  /** Removes an entry; reported to subscribers as an eviction. */
  delete(key: string): boolean {
    if (!this.entries.delete(key)) return false;
    this.emit({ type: "evict", key });
    return true;
  }

  subscribe(listener: CacheListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(e: CacheEvent): void {
    for (const listener of [...this.listeners]) {
      // A faulty listener must not corrupt the cache or starve the other listeners.
      try {
        listener(e);
      } catch {
        // ignored
      }
    }
  }
}
