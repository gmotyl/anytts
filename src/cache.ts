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
  /** Alias key → the entry key it points at. Aliases do not count towards `max`. */
  private readonly aliases = new Map<string, string>();
  /** Entry key → its aliases, so evicting the entry evicts them too. */
  private readonly aliasesOf = new Map<string, Set<string>>();

  constructor(options: LruCacheOptions = {}) {
    const max = options.max ?? DEFAULT_CACHE_MAX;
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`cache max must be a positive integer, got ${max}`);
    this.max = max;
  }

  /** Entries only; aliases are not counted. */
  get size(): number {
    return this.entries.size;
  }

  /** An entry, or an alias of one. */
  has(key: string): boolean {
    return this.entries.has(this.aliases.get(key) ?? key);
  }

  /** The entry's value; an alias reads (and refreshes) the entry it points at. */
  get(key: string): V | undefined {
    key = this.aliases.get(key) ?? key;
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    // A real entry replaces an alias under the same key.
    this.unlink(key);
    const existed = this.entries.delete(key);
    this.entries.set(key, value);
    // Settle the entries before notifying, so listeners always see a cache within `max`.
    const events: CacheEvent[] = existed ? [] : [{ type: "add", key }];
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      events.push({ type: "evict", key: oldest }, ...this.dropAliasesOf(oldest));
    }
    for (const e of events) this.emit(e);
  }

  /**
   * Points `alias` at the entry `target`: `has` / `get` on the alias read the entry, and evicting
   * the entry evicts the alias. Reported as an `add` when the alias is new. `false` (and nothing
   * stored) when `target` is not an entry.
   */
  alias(alias: string, target: string): boolean {
    if (alias === target || !this.entries.has(target)) return false;
    const previous = this.aliases.get(alias);
    if (previous === target) return true;
    if (previous !== undefined) this.unlink(alias);
    // An alias never shadows a real entry.
    if (this.entries.has(alias)) return false;
    this.aliases.set(alias, target);
    let set = this.aliasesOf.get(target);
    if (!set) this.aliasesOf.set(target, (set = new Set()));
    set.add(alias);
    if (previous === undefined) this.emit({ type: "add", key: alias });
    return true;
  }

  /** Removes an entry (with its aliases) or one alias; reported to subscribers as an eviction. */
  delete(key: string): boolean {
    if (this.unlink(key)) {
      this.emit({ type: "evict", key });
      return true;
    }
    if (!this.entries.delete(key)) return false;
    for (const e of [{ type: "evict" as const, key }, ...this.dropAliasesOf(key)]) this.emit(e);
    return true;
  }

  subscribe(listener: CacheListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Forgets alias `key`, silently; `true` when it was one. */
  private unlink(key: string): boolean {
    const target = this.aliases.get(key);
    if (target === undefined) return false;
    this.aliases.delete(key);
    const set = this.aliasesOf.get(target);
    set?.delete(key);
    if (set?.size === 0) this.aliasesOf.delete(target);
    return true;
  }

  /** Forgets every alias of entry `target`; returns their evictions, to emit after the entry's. */
  private dropAliasesOf(target: string): CacheEvent[] {
    const set = this.aliasesOf.get(target);
    if (!set) return [];
    this.aliasesOf.delete(target);
    for (const alias of set) this.aliases.delete(alias);
    return [...set].map((key) => ({ type: "evict", key }));
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
