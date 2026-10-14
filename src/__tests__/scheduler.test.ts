import { describe, expect, it } from "vitest";
import { createScheduler } from "../scheduler.js";

/** A job body the test finishes by hand. */
const deferred = () => {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { done, finish };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createScheduler", () => {
  it("speculative tiers never take the run's last slot", () => {
    const scheduler = createScheduler({
      concurrency: 3,
      tiers: [{ name: "run" }, { name: "warm", cap: 2 }, { name: "preload" }],
    });
    const started: string[] = [];
    const body = (label: string) => () => {
      started.push(label);
      return deferred().done;
    };
    scheduler.enqueue("preload", body("p1"));
    scheduler.enqueue("preload", body("p2"));
    const warm = scheduler.enqueue("warm", body("w1"));
    const preload = scheduler.enqueue("preload", body("p3"));
    expect(started).toEqual(["p1", "p2"]);
    expect(warm.started).toBe(false);
    expect(preload.started).toBe(false);

    const run = scheduler.enqueue("run", body("r1"));
    expect(run.started).toBe(true);
    expect(started).toEqual(["p1", "p2", "r1"]);
  });

  it("higher tier starts first", async () => {
    const scheduler = createScheduler({ concurrency: 1, tiers: [{ name: "play" }, { name: "warm" }] });
    const started: string[] = [];
    const blocker = deferred();
    scheduler.enqueue("warm", () => blocker.done);
    scheduler.enqueue("warm", async () => void started.push("warm"));
    scheduler.enqueue("play", async () => void started.push("play"));
    blocker.finish();
    await flush();
    expect(started).toEqual(["play", "warm"]);
  });

  it("promotion keeps original age", async () => {
    const scheduler = createScheduler({ concurrency: 1, tiers: [{ name: "play" }, { name: "warm" }] });
    const started: string[] = [];
    const blocker = deferred();
    scheduler.enqueue("play", () => blocker.done);
    const old = scheduler.enqueue("warm", async () => void started.push("old"));
    scheduler.enqueue("play", async () => void started.push("young"));
    old.promote("play");
    expect(old.tier).toBe("play");
    blocker.finish();
    await flush();
    expect(started).toEqual(["old", "young"]);
  });

  it("removed job never starts", async () => {
    const scheduler = createScheduler({ concurrency: 1, tiers: [{ name: "play" }, { name: "warm" }] });
    let ran = false;
    const blocker = deferred();
    scheduler.enqueue("play", () => blocker.done);
    const job = scheduler.enqueue("warm", async () => void (ran = true));
    expect(job.remove()).toBe(true);
    await expect(job.done).rejects.toMatchObject({ name: "AbortError" });
    blocker.finish();
    await flush();
    expect(ran).toBe(false);
    expect(job.started).toBe(false);
  });

  it("unknown tier throws", () => {
    const scheduler = createScheduler({ concurrency: 1, tiers: [{ name: "play" }] });
    expect(() => scheduler.enqueue("nope", async () => {})).toThrow(/unknown tier/);
    const job = scheduler.enqueue("play", async () => {});
    expect(() => job.promote("nope")).toThrow(/unknown tier/);
  });

  it("invalid config throws", () => {
    const tiers = [{ name: "play" }];
    for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createScheduler({ concurrency, tiers })).toThrow(RangeError);
    }
    expect(() => createScheduler({ concurrency: 1, tiers: [] })).toThrow(RangeError);
    expect(() => createScheduler({ concurrency: 1, tiers: [{ name: "play" }, { name: "play" }] })).toThrow(
      /duplicate tier/,
    );
    expect(() => createScheduler({ concurrency: 1, tiers: [{ name: "play", cap: 0 }] })).toThrow(RangeError);
    expect(() => createScheduler({ concurrency: 2, tiers: [{ name: "play" }, { name: "warm", cap: 1 }] })).not.toThrow();
  });
});
