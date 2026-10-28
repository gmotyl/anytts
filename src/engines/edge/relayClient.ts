import type { EngineHooks } from "../../engine.js";
import { relayFetch, type RelayFetchOptions } from "../relayEngine.js";

export type RelayClientOptions = RelayFetchOptions;

/**
 * `POST { text, voice }` (no `engine`: the relay's Edge default) with the same deadlines as the
 * direct engine. Error bodies keep their kind and `retryAfter`, as for every relay client.
 */
export async function relaySynthesize(
  options: RelayClientOptions,
  text: string,
  voice: string,
  signal: AbortSignal,
  hooks?: EngineHooks,
): Promise<ArrayBuffer> {
  return (await relayFetch(options, { text, voice }, signal, hooks)).bytes;
}
