import { describe, expect, it } from "vitest";
import { TtsError, isTransient, type TtsErrorKind } from "../errors.js";

describe("TtsError", () => {
  it("TtsError carries its kind and is an Error", () => {
    const cause = new Error("boom");
    const err = new TtsError("rejected", "handshake refused", { status: 403, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.kind).toBe("rejected");
    expect(err.name).toBe("TtsError");
    expect(err.status).toBe(403);
    expect(err.message).toBe("handshake refused");
    expect(err.cause).toBe(cause);

    const bare = new TtsError("no-audio");
    expect(bare.kind).toBe("no-audio");
    expect(bare.status).toBeUndefined();
    expect(bare.message).not.toBe("");
  });

  it("only first-byte-timeout, stalled and network are transient", () => {
    const all: TtsErrorKind[] = [
      "rejected",
      "first-byte-timeout",
      "stalled",
      "network",
      "no-audio",
      "unknown-voice",
    ];
    const transient = all.filter((k) => isTransient(k));
    expect(transient).toEqual(["first-byte-timeout", "stalled", "network"]);
  });

  it("rate-limited carries retryAfter", () => {
    const err = new TtsError("rate-limited", "429", { status: 429, retryAfter: 30 });
    expect(err.kind).toBe("rate-limited");
    expect(err.retryAfter).toBe(30);
    expect(new TtsError("rate-limited").retryAfter).toBeUndefined();
  });

  it("refusal kinds are not transient", () => {
    const refusals: TtsErrorKind[] = ["quota-exhausted", "unauthorized", "rate-limited"];
    for (const kind of refusals) expect(isTransient(kind)).toBe(false);
  });
});
