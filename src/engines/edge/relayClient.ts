import { TtsError, type TtsErrorKind } from "../../errors.js";

export interface RelayClientOptions {
  url: string;
  /** Max wait for the response headers. */
  firstByteMs: number;
  /** Max gap between body chunks. */
  stallMs: number;
}

const KINDS: ReadonlySet<string> = new Set<TtsErrorKind>([
  "rejected",
  "first-byte-timeout",
  "stalled",
  "network",
  "no-audio",
  "unknown-voice",
]);

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/**
 * Error rehydration: a `{ kind }` body keeps its kind. Validation answers carry
 * none, so a 4xx without one is `rejected` (final) and a 5xx is `network` (transient).
 */
async function errorFor(response: Response): Promise<TtsError> {
  let kind: string | undefined;
  try {
    kind = ((await response.json()) as { kind?: unknown } | null)?.kind as string | undefined;
  } catch {
    // Not JSON: fall back to the status.
  }
  const resolved: TtsErrorKind =
    kind !== undefined && KINDS.has(kind)
      ? (kind as TtsErrorKind)
      : response.status < 500
        ? "rejected"
        : "network";
  return new TtsError(resolved, `relay answered ${response.status}`, { status: response.status });
}

/** `POST { text, voice }` to the relay with the same deadlines as the direct engine. */
export function relaySynthesize(
  options: RelayClientOptions,
  text: string,
  voice: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const { url, firstByteMs, stallMs } = options;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());

    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      reader?.cancel().catch(() => {});
      reject(error);
    };
    const arm = (ms: number, kind: "first-byte-timeout" | "stalled") => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new TtsError(kind)), ms);
    };
    function onAbort() {
      fail(abortError());
    }
    signal.addEventListener("abort", onAbort);
    arm(firstByteMs, "first-byte-timeout");

    void (async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice }),
          signal: controller.signal,
        });
      } catch (cause) {
        return fail(new TtsError("network", "relay request failed", { cause }));
      }
      if (settled) return;
      arm(stallMs, "stalled");
      if (!response.ok) return fail(await errorFor(response));
      if (!response.body) return fail(new TtsError("no-audio"));

      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) break;
          chunks.push(value);
          total += value.length;
          arm(stallMs, "stalled");
        }
      } catch (cause) {
        return fail(new TtsError("network", "relay body failed", { cause }));
      }
      if (total === 0) return fail(new TtsError("no-audio"));
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out.buffer);
    })();
  });
}
