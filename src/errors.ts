export type TtsErrorKind =
  | "rejected"
  | "first-byte-timeout"
  | "stalled"
  | "network"
  | "no-audio"
  | "unknown-voice";

export interface TtsErrorOptions {
  status?: number;
  cause?: unknown;
}

export class TtsError extends Error {
  readonly kind: TtsErrorKind;
  readonly status?: number;

  constructor(kind: TtsErrorKind, message?: string, options: TtsErrorOptions = {}) {
    super(message ?? kind, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TtsError";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
  }
}

const TRANSIENT: ReadonlySet<TtsErrorKind> = new Set(["first-byte-timeout", "stalled", "network"]);

/** Transient kinds are worth retrying; the rest are final. */
export const isTransient = (kind: TtsErrorKind): boolean => TRANSIENT.has(kind);
