import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "../index.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(handler: (req: Request) => Promise<Response>): Promise<string> {
  server = createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("toNodeHandler", () => {
  it("node adapter mirrors the fetch response", async () => {
    let seen: { method: string; url: string; type: string | null; body: unknown } | undefined;
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 9, 8, 7, 6]);
    const base = await listen(async (req) => {
      seen = {
        method: req.method,
        url: req.url,
        type: req.headers.get("content-type"),
        body: await req.json(),
      };
      return new Response(bytes, {
        status: 201,
        headers: { "content-type": "audio/mpeg", "x-relay": "yes" },
      });
    });

    const res = await fetch(`${base}/api/tts?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hi", voice: "v" }),
    });

    expect(seen).toEqual({
      method: "POST",
      url: `${base}/api/tts?x=1`,
      type: "application/json",
      body: { text: "Hi", voice: "v" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-relay")).toBe("yes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    // Error responses pass through unchanged as well.
    const base2 = base;
    server!.removeAllListeners("request");
    server!.on(
      "request",
      toNodeHandler(async () => Response.json({ kind: "stalled" }, { status: 502 })),
    );
    const err = await fetch(`${base2}/`, { method: "POST", body: "{}" });
    expect(err.status).toBe(502);
    expect(err.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await err.json()).toEqual({ kind: "stalled" });
  });
});
