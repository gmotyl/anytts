export type TtsErrorKind =
  | "rejected"
  | "first-byte-timeout"
  | "stalled"
  | "network"
  | "no-audio"
  | "unknown-voice"
  | "quota-exhausted"
  | "unauthorized"
  | "rate-limited";

export interface TtsErrorOptions {
  status?: number;
  cause?: unknown;
  /** Seconds the provider asked to wait (from `Retry-After`), for `rate-limited`. */
  retryAfter?: number;
}

export class TtsError extends Error {
  readonly kind: TtsErrorKind;
  readonly status?: number;
  readonly retryAfter?: number;

  constructor(kind: TtsErrorKind, message?: string, options: TtsErrorOptions = {}) {
    super(message ?? kind, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TtsError";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

/**
 * A request names an engine the instance does not configure. A `RangeError`, as before; its own
 * class lets a caller (the relay) tell it apart from other configuration errors.
 */
export class UnknownEngineError extends RangeError {
  readonly engineId: string;

  constructor(engineId: string) {
    super(`engine is not configured: ${engineId}`);
    this.name = "UnknownEngineError";
    this.engineId = engineId;
  }
}

const TRANSIENT: ReadonlySet<TtsErrorKind> = new Set(["first-byte-timeout", "stalled", "network"]);

/** Transient kinds are worth retrying; the rest are final. */
export const isTransient = (kind: TtsErrorKind): boolean => TRANSIENT.has(kind);
