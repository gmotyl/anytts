import { CHROMIUM_FULL_VERSION } from "./token.js";

/** Opens the read-aloud WebSocket. Injectable so engines can be driven by a fake socket. */
export interface Transport {
  open(url: string, headers: Record<string, string>): WebSocket;
}

const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];

/** Handshake headers the endpoint requires: Edge-extension Origin and a Microsoft Edge >= 137 UA. */
export const EDGE_WS_HEADERS: Readonly<Record<string, string>> = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
    ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
    ` Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

// Node's (undici) WebSocket takes a non-standard `{ headers }` init as its second argument.
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/** Browser: `new WebSocket(url)` (headers cannot be set). Node: global WebSocket with Edge headers. */
export const defaultTransport: Transport = {
  open(url, headers) {
    if (isBrowser()) return new WebSocket(url);
    const Ctor = WebSocket as unknown as NodeWebSocketCtor;
    return new Ctor(url, { headers: { ...EDGE_WS_HEADERS, ...headers } });
  },
};
