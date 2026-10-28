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

const TRANSIENT: ReadonlySet<TtsErrorKind> = new Set(["first-byte-timeout", "stalled", "network"]);

/** Transient kinds are worth retrying; the rest are final. */
export const isTransient = (kind: TtsErrorKind): boolean => TRANSIENT.has(kind);
