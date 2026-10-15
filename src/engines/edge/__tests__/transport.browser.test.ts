import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultTransport } from "../transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defaultTransport (browser)", () => {
  it("browser transport passes no headers argument", () => {
    const ctor = vi.fn(function FakeWebSocket() {});
    vi.stubGlobal("WebSocket", ctor);

    const url = "wss://example.test/edge/v1?x=1";
    defaultTransport.open(url, { Origin: "ignored", "User-Agent": "ignored" });

    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0]).toEqual([url]);
  });
});
