import { CHROMIUM_FULL_VERSION } from "./token.js";

/** Optional observers of the handshake; a transport calls only what it can observe. */
export interface TransportHooks {
  /**
   * The upgrade was answered with a non-101 status. Called before the socket's
   * `error` event. Browsers never expose this, so browser transports never call it.
   */
  onUnexpectedResponse?(status: number, headers: Headers): void;
  /**
   * The connection failed before any HTTP response (DNS, refused, TLS reset).
   * Called before the socket's `error` event. Browser transports never call it.
   */
  onConnectError?(cause: unknown): void;
}

/** Opens the read-aloud WebSocket. Injectable so engines can be driven by a fake socket. */
export interface Transport {
  open(url: string, headers: Record<string, string>, hooks?: TransportHooks): WebSocket;
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

/**
 * Headers can be set only on Node's (undici) WebSocket. Detect Node positively, so
 * Web Workers and other non-Node runtimes take the URL-only path. A DOM wins over
 * `process` (jsdom, Electron renderers), since browser WebSockets reject an init object.
 */
function canSetHeaders(): boolean {
  if (typeof window !== "undefined" && typeof document !== "undefined") return false;
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

/** Defaults overlaid by `overrides`, matching names case-insensitively (overrides win). */
function mergeHeaders(
  defaults: Readonly<Record<string, string>>,
  overrides: Record<string, string>,
): Record<string, string> {
  const overridden = new Set(Object.keys(overrides).map((k) => k.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(defaults)) if (!overridden.has(k.toLowerCase())) merged[k] = v;
  return { ...merged, ...overrides };
}

// Node's (undici) WebSocket takes a non-standard `{ headers, dispatcher }` init as its second argument.
type NodeWebSocketCtor = new (
  url: string,
  init: { headers: Record<string, string>; dispatcher?: unknown },
) => WebSocket;

interface Dispatcher {
  dispatch(options: unknown, handler: object): boolean;
}

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/**
 * undici's WebSocket hides the status and headers of a refused upgrade (the
 * error event carries neither), so we observe the response through a dispatcher
 * that delegates to the global one. Covers both the undici 6 (`onHeaders`) and
 * undici 7 (`onResponseStart`) handler shapes.
 */
function observingDispatcher(hooks: TransportHooks): Dispatcher | undefined {
  const base = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER] as Dispatcher | undefined;
  if (typeof base?.dispatch !== "function") return undefined;
  return {
    dispatch(options, handler) {
      let responded = false;
      // A throwing hook must never throw inside undici.
      const report = (status: unknown, headers: Headers) => {
        responded = true;
        try {
          if (typeof status === "number" && status !== 101) hooks.onUnexpectedResponse?.(status, headers);
        } catch {
          // Ignored: observers cannot affect the connection.
        }
      };
      const reportError = (cause: unknown) => {
        if (responded) return;
        try {
          hooks.onConnectError?.(cause);
        } catch {
          // Ignored: observers cannot affect the connection.
        }
      };
      const observed = new Proxy(handler, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          if (prop === "onHeaders") {
            return (status: unknown, raw: unknown, ...rest: unknown[]) => {
              const headers = new Headers();
              if (Array.isArray(raw)) {
                for (let i = 0; i + 1 < raw.length; i += 2) headers.append(String(raw[i]), String(raw[i + 1]));
              }
              report(status, headers);
              return value.call(target, status, raw, ...rest);
            };
          }
          if (prop === "onResponseStart") {
            return (controller: unknown, status: unknown, raw: unknown, ...rest: unknown[]) => {
              const headers = new Headers();
              for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
                for (const item of Array.isArray(v) ? v : [v]) headers.append(k, String(item));
              }
              report(status, headers);
              return value.call(target, controller, status, raw, ...rest);
            };
          }
          if (prop === "onError") {
            return (cause: unknown, ...rest: unknown[]) => {
              reportError(cause);
              return value.call(target, cause, ...rest);
            };
          }
          if (prop === "onResponseError") {
            return (controller: unknown, cause: unknown, ...rest: unknown[]) => {
              reportError(cause);
              return value.call(target, controller, cause, ...rest);
            };
          }
          return value.bind(target);
        },
      });
      return base.dispatch(options, observed);
    },
  };
}

/** Node: global WebSocket with Edge headers. Elsewhere: `new WebSocket(url)` (headers cannot be set). */
export const defaultTransport: Transport = {
  open(url, headers, hooks) {
    if (!canSetHeaders()) return new WebSocket(url);
    const Ctor = WebSocket as unknown as NodeWebSocketCtor;
    const dispatcher =
      hooks?.onUnexpectedResponse || hooks?.onConnectError ? observingDispatcher(hooks) : undefined;
    return new Ctor(url, {
      headers: mergeHeaders(EDGE_WS_HEADERS, headers),
      ...(dispatcher ? { dispatcher } : {}),
    });
  },
};
