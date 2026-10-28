import { TtsError } from "./errors.js";

/** The engine id of the chain over the other engines. */
export const CASCADE = "cascade";

/** What the walk needs from the `Tts` instance; `M` is a member prepared for this request. */
export interface CascadeMembers<M, R> {
  /**
   * Why member `id` is passed over without a request, or `undefined` when it may be tried: a keyed
   * engine without an `apiKey`, or a member inside a skip window.
   */
  skipReason(id: string): TtsError | undefined;
  /** Picks the member's voice and prepared text; throws (`unknown-voice`) when it cannot speak the request. */
  prepare(id: string): M;
  isCached(member: M): boolean;
  /** Runs the member's own path: cache, then a scheduler job in its engine slot (waiting while it is busy). */
  run(member: M): Promise<R>;
  /** A failure that moves the walk to the next member. Skip windows open here. */
  onFailure?(id: string, error: TtsError): void;
}

/**
 * Validates `engines.cascade` against the configured engines and returns its members. `order` ids
 * must be configured engines other than `cascade`; the cascade has no `voices` of its own.
 */
export function cascadeMembers(config: Record<string, unknown>, configured: (id: string) => boolean): string[] {
  if (config.voices !== undefined) throw new RangeError("cascade has no voices: set them per member");
  const { order } = config;
  if (!Array.isArray(order) || !order.every((id): id is string => typeof id === "string")) {
    throw new RangeError("cascade needs an order: an array of engine ids");
  }
  for (const id of order) {
    if (id === CASCADE || !configured(id)) throw new RangeError(`cascade member is not a configured engine: ${id}`);
  }
  return [...new Set(order)];
}

/** The request's `order` narrowed to members (non-members dropped), else every member; never empty. */
export function effectiveOrder(members: readonly string[], requested?: readonly string[]): string[] {
  const order = requested === undefined ? [...members] : [...new Set(requested)].filter((id) => members.includes(id));
  if (order.length === 0) throw new RangeError("cascade request has no members to try");
  return order;
}

/** The first member, in `order`, that may be tried and already holds a cached result. */
export function cachedMember<M, R>(order: readonly string[], members: CascadeMembers<M, R>): M | undefined {
  for (const id of order) {
    if (members.skipReason(id)) continue;
    let member: M;
    try {
      member = members.prepare(id);
    } catch {
      continue;
    }
    if (members.isCached(member)) return member;
  }
  return undefined;
}

/** `unknown-voice` and anything that is not a `TtsError` (an abort, a caller bug) stop the chain. */
const switchesMember = (error: unknown): error is TtsError => error instanceof TtsError && error.kind !== "unknown-voice";

/**
 * Walks `order` until a member speaks. Cache lookups go first, across every member, so a unit
 * already synthesized never costs quota. Then each member is tried in turn; a busy member is
 * waited for (its `run` holds the job in the slot queue), never hopped over. Rejects with the last
 * attempted member's error (a copy carrying the earlier attempts' errors, in order, as `cause` when
 * there were any), or the last skip reason when no member was attempted.
 *
 * The first member's job is enqueued synchronously, before this returns.
 */
export async function walkCascade<M, R>(order: readonly string[], members: CascadeMembers<M, R>): Promise<R> {
  const hit = cachedMember(order, members);
  if (hit !== undefined) return members.run(hit);
  const attempted: TtsError[] = [];
  let skipped: TtsError | undefined;
  for (const id of order) {
    const reason = members.skipReason(id);
    if (reason) {
      skipped = reason;
      continue;
    }
    const member = members.prepare(id);
    try {
      return await members.run(member);
    } catch (error) {
      // An abort surfaces as the member path's AbortError (here, or from the next member's `run`).
      if (!switchesMember(error)) throw error;
      members.onFailure?.(id, error);
      attempted.push(error);
    }
  }
  const last = attempted.at(-1);
  if (last === undefined) throw skipped ?? new RangeError("cascade request has no members to try");
  if (attempted.length === 1) throw last;
  // A copy: the member's own error may be shared with other callers of the same job.
  throw new TtsError(last.kind, last.message, {
    ...(last.status !== undefined ? { status: last.status } : {}),
    ...(last.retryAfter !== undefined ? { retryAfter: last.retryAfter } : {}),
    cause: attempted.slice(0, -1),
  });
}
