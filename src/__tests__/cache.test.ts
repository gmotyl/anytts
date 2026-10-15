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
});
