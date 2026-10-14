import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { defaultTransport } from "../transport.js";

const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

function captureUpgradeHeaders(): Promise<{ url: string; headers: Promise<IncomingHttpHeaders> }> {
  return new Promise((resolveServer) => {
    const server = createServer();
    const headers = new Promise<IncomingHttpHeaders>((resolveHeaders) => {
      server.on("upgrade", (req, socket) => {
        resolveHeaders(req.headers);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({ url: `ws://127.0.0.1:${port}/edge/v1`, headers });
    });
  });
}

describe("defaultTransport (node)", () => {
  it("node transport sends Origin and User-Agent", async () => {
    const { url, headers } = await captureUpgradeHeaders();
    const socket = defaultTransport.open(url, { "X-Extra": "1" });
    socket.addEventListener("error", () => {});

    const seen = await headers;
    expect(seen.origin).toBe(EDGE_ORIGIN);
    const edg = /Edg\/(\d+)/.exec(seen["user-agent"] ?? "");
    expect(edg).not.toBeNull();
    expect(Number(edg?.[1])).toBeGreaterThanOrEqual(137);
    expect(seen["x-extra"]).toBe("1");
  });
});
