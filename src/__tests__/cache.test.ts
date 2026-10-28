import { describe, expect, it, vi } from "vitest";
import { LruCache, type CacheEvent } from "../cache.js";

describe("LruCache", () => {
  it("evicts the least recently used past max", () => {
    const cache = new LruCache<number>({ max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("a read refreshes recency", () => {
    const cache = new LruCache<number>({ max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("notifies subscribers on add and evict", () => {
    const cache = new LruCache<number>({ max: 1 });
    const first: CacheEvent[] = [];
    const second = vi.fn();
    const unsubscribe = cache.subscribe((e) => first.push(e));
    cache.subscribe(second);

    cache.set("a", 1);
    cache.set("b", 2);
    expect(first).toEqual([
      { type: "add", key: "a" },
      { type: "add", key: "b" },
      { type: "evict", key: "a" },
    ]);
    expect(second).toHaveBeenCalledTimes(3);

    unsubscribe();
    cache.set("c", 3);
    expect(first).toHaveLength(3);
    expect(second).toHaveBeenCalledTimes(5);
  });

  it("a throwing subscriber does not break the cache", () => {
    const cache = new LruCache<number>({ max: 1 });
    const events: CacheEvent[] = [];
    cache.subscribe(() => {
      throw new Error("listener bug");
    });
    cache.subscribe((e) => events.push(e));
    expect(() => cache.set("a", 1)).not.toThrow();
    expect(() => cache.set("b", 2)).not.toThrow();
    expect(cache.size).toBe(1);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    expect(events).toEqual([
      { type: "add", key: "a" },
      { type: "add", key: "b" },
      { type: "evict", key: "a" },
    ]);
    expect(() => cache.delete("b")).not.toThrow();
    expect(events).toHaveLength(4);
  });

  describe("aliases", () => {
    const recording = (max = 10) => {
      const cache = new LruCache<number>({ max });
      const events: CacheEvent[] = [];
      cache.subscribe((e) => events.push(e));
      return { cache, events };
    };

    it("set over an alias key replaces the alias with a real entry", () => {
      const { cache, events } = recording();
      cache.set("t", 1);
      expect(cache.alias("x", "t")).toBe(true);
      events.length = 0;
      cache.set("x", 2);
      expect(cache.get("x")).toBe(2);
      expect(cache.get("t")).toBe(1);
      expect(cache.size).toBe(2);
      // The dropped alias is reported before the new entry.
      expect(events).toEqual([
        { type: "evict", key: "x" },
        { type: "add", key: "x" },
      ]);
      // Evicting the old target no longer touches the new entry.
      cache.delete("t");
      expect(cache.get("x")).toBe(2);
    });

    it("re-pointing an alias follows the new target only", () => {
      const { cache, events } = recording();
      cache.set("t1", 1);
      cache.set("t2", 2);
      cache.alias("x", "t1");
      events.length = 0;
      expect(cache.alias("x", "t2")).toBe(true);
      expect(cache.get("x")).toBe(2);
      // Not a new key: no event.
      expect(events).toEqual([]);
      // The old target's eviction leaves the alias alone.
      cache.delete("t1");
      expect(cache.get("x")).toBe(2);
      expect(events).toEqual([{ type: "evict", key: "t1" }]);
      cache.delete("t2");
      expect(cache.has("x")).toBe(false);
    });

    it("delete(alias) removes only the alias", () => {
      const { cache, events } = recording();
      cache.set("t", 1);
      cache.alias("x", "t");
      cache.alias("y", "t");
      events.length = 0;
      expect(cache.delete("x")).toBe(true);
      expect(events).toEqual([{ type: "evict", key: "x" }]);
      expect(cache.has("x")).toBe(false);
      expect(cache.get("t")).toBe(1);
      expect(cache.get("y")).toBe(1);
      expect(cache.delete("x")).toBe(false);
    });

    it("alias never shadows a real entry or points at a missing one", () => {
      const { cache } = recording();
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.alias("a", "b")).toBe(false);
      expect(cache.get("a")).toBe(1);
      expect(cache.alias("x", "missing")).toBe(false);
      expect(cache.has("x")).toBe(false);
      expect(cache.alias("a", "a")).toBe(false);
    });

    it("evicting an entry evicts its aliases, after the entry", () => {
      const { cache, events } = recording(1);
      cache.set("t", 1);
      cache.alias("x", "t");
      cache.alias("y", "t");
      // Aliases do not count towards max.
      expect(cache.size).toBe(1);
      events.length = 0;
      cache.set("u", 2);
      expect(events).toEqual([
        { type: "add", key: "u" },
        { type: "evict", key: "t" },
        { type: "evict", key: "x" },
        { type: "evict", key: "y" },
      ]);
      expect(cache.has("x")).toBe(false);
      expect(cache.has("y")).toBe(false);
      // A stale alias name can point at a new target.
      expect(cache.alias("x", "u")).toBe(true);
      expect(cache.get("x")).toBe(2);
    });
  });
});
