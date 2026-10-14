import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultTransport } from "../transport.js";

const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

function refuseUpgrade(response: string): Promise<string> {
  return new Promise((resolveServer) => {
    const server = createServer();
    server.on("upgrade", (_req, socket) => {
      socket.end(response);
      server.close();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer(`ws://127.0.0.1:${port}/edge/v1`);
    });
  });
}

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defaultTransport (node)", () => {
  it("node transport lets a lowercase header override the default", async () => {
    const { url, headers } = await captureUpgradeHeaders();
    const socket = defaultTransport.open(url, { "user-agent": "Custom/1.0", origin: "https://x.test" });
    socket.addEventListener("error", () => {});

    const seen = await headers;
    expect(seen["user-agent"]).toBe("Custom/1.0");
    expect(seen.origin).toBe("https://x.test");
  });

  it("a runtime that is not node and has no DOM passes no headers argument", () => {
    // A Web Worker: no window/document and no node process.
    const ctor = vi.fn(function FakeWebSocket() {});
    vi.stubGlobal("WebSocket", ctor);
    vi.stubGlobal("process", undefined);
    const url = "wss://example.test/edge/v1?x=1";
    try {
      defaultTransport.open(url, { Origin: "ignored" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(ctor.mock.calls[0]).toEqual([url]);
  });

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

  it("node transport reports the refused handshake status and Date", async () => {
    const date = "Wed, 14 Oct 2026 12:00:00 GMT";
    const url = await refuseUpgrade(
      `HTTP/1.1 403 Forbidden\r\nDate: ${date}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    const seen = new Promise<{ status: number; date: string | null }>((resolve) => {
      const socket = defaultTransport.open(url, {}, {
        onUnexpectedResponse: (status, headers) => {
          resolve({ status, date: headers.get("date") });
          socket.close();
        },
      });
      socket.addEventListener("error", () => {});
    });
    expect(await seen).toEqual({ status: 403, date });
  });

  it("node transport reports a refused connection as a connect error", async () => {
    // Bind then close a server, so the port is known to refuse connections.
    const port = await new Promise<number>((resolvePort) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port: p } = server.address() as AddressInfo;
        server.close(() => resolvePort(p));
      });
    });
    const onUnexpectedResponse = vi.fn();
    const cause = await new Promise<unknown>((resolve) => {
      const socket = defaultTransport.open(`ws://127.0.0.1:${port}/edge/v1`, {}, {
        onUnexpectedResponse,
        onConnectError: resolve,
      });
      socket.addEventListener("error", () => {});
    });
    expect(cause).toBeDefined();
    expect(onUnexpectedResponse).not.toHaveBeenCalled();
  });
});
