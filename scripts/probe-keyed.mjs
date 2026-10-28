#!/usr/bin/env node
// Manual live probe of the keyed engines. Not run in CI: it spends a few characters of each
// provider's quota. Build first (`corepack pnpm build`), then:
//
//   ELEVENLABS_API_KEY=… CARTESIA_API_KEY=… SPEECHIFY_API_KEY=… \
//   AZURE_SPEECH_KEY=… AZURE_SPEECH_REGION=westeurope node scripts/probe-keyed.mjs
//
// Engines without a key are listed as missing and skipped; the script always exits 0.
// For each engine with a key it synthesizes a short Polish and English phrase with the default
// voices (engine / voice / bytes / first-byte latency, or the error kind and status), reports
// whether any 429 carried a Retry-After header, and checks the stock voice ids of the catalogs
// whose ids came from secondary sources (Cartesia, ElevenLabs).

import { createTts } from "../dist/server/index.js";
import { listVoices } from "../dist/index.js";

const PHRASES = [
  { lang: "pl", text: "Dzień dobry, to jest krótki test syntezy mowy." },
  { lang: "en", text: "Hello, this is a short speech synthesis test." },
];

const PROVIDERS = [
  { id: "elevenlabs", env: ["ELEVENLABS_API_KEY"], config: (env) => ({ apiKey: env.ELEVENLABS_API_KEY }) },
  { id: "cartesia", env: ["CARTESIA_API_KEY"], config: (env) => ({ apiKey: env.CARTESIA_API_KEY }) },
  { id: "speechify", env: ["SPEECHIFY_API_KEY"], config: (env) => ({ apiKey: env.SPEECHIFY_API_KEY }) },
  {
    id: "azure",
    env: ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"],
    config: (env) => ({ apiKey: env.AZURE_SPEECH_KEY, region: env.AZURE_SPEECH_REGION }),
  },
];

/** Wraps `fetch` to record every 429 and whether it carried `Retry-After`. */
function recordingFetch(log) {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 429) log.push(response.headers.get("retry-after"));
    return response;
  };
}

function describeError(error) {
  if (error && typeof error === "object" && "kind" in error) {
    const status = error.status !== undefined ? ` status=${error.status}` : "";
    const wait = error.retryAfter !== undefined ? ` retryAfter=${error.retryAfter}s` : "";
    return `${error.kind}${status}${wait} (${error.message})`;
  }
  return String(error);
}

async function probeSynthesis(provider, env, rateLimits) {
  let tts;
  try {
    tts = createTts({
      engines: { [provider.id]: { ...provider.config(env), retries: 0, fetch: recordingFetch(rateLimits) } },
      defaultEngine: provider.id,
      scheduler: { concurrency: 1, tiers: [{ name: "probe" }] },
    });
  } catch (error) {
    console.log(`  config error: ${error.message}`);
    return;
  }
  for (const { lang, text } of PHRASES) {
    const started = performance.now();
    let firstByte;
    try {
      const result = await tts.synthesize({ text, lang, onFirstByte: () => (firstByte ??= performance.now()) });
      const latency = firstByte === undefined ? "n/a" : `${Math.round(firstByte - started)} ms`;
      console.log(`  ${lang}: ok engine=${result.engine} voice=${result.voice} bytes=${result.bytes.byteLength} first-byte=${latency}`);
    } catch (error) {
      console.log(`  ${lang}: FAILED ${describeError(error)}`);
    }
  }
  console.log(`  engineStatus: ${JSON.stringify(tts.engineStatus(provider.id))}`);
}

/** GETs each stock voice id; prints the ones the provider does not know. */
async function checkVoiceIds(label, ids, request, rateLimits) {
  const missing = [];
  for (const id of ids) {
    try {
      const response = await request(id);
      if (response.status === 429) rateLimits.push(response.headers.get("retry-after"));
      if (!response.ok) missing.push(`${id} (${response.status})`);
      await response.body?.cancel();
    } catch (error) {
      missing.push(`${id} (${error.message})`);
    }
  }
  console.log(
    missing.length === 0
      ? `  ${label}: all ${ids.length} stock voice ids found`
      : `  ${label}: ${missing.length}/${ids.length} not found: ${missing.join(", ")}`,
  );
}

const VOICE_CHECKS = {
  elevenlabs: (env, rateLimits) =>
    checkVoiceIds(
      "GET /v1/voices/{id}",
      listVoices("elevenlabs").map((voice) => voice.id),
      (id) => fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(id)}`, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }),
      rateLimits,
    ),
  cartesia: (env, rateLimits) =>
    checkVoiceIds(
      "GET /voices/{id}",
      listVoices("cartesia").map((voice) => voice.id),
      (id) =>
        fetch(`https://api.cartesia.ai/voices/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${env.CARTESIA_API_KEY}`, "cartesia-version": "2026-08-14" },
        }),
      rateLimits,
    ),
};

const env = process.env;
const present = PROVIDERS.filter((p) => p.env.every((name) => env[name]));
const missing = PROVIDERS.filter((p) => !p.env.every((name) => env[name]));

for (const p of missing) {
  const names = p.env.filter((name) => !env[name]);
  console.log(`${p.id}: skipped, missing ${names.join(" + ")}`);
}
if (present.length === 0) {
  console.log("No provider keys set: nothing to probe.");
  process.exit(0);
}

for (const provider of present) {
  console.log(`${provider.id}:`);
  const rateLimits = [];
  await probeSynthesis(provider, env, rateLimits);
  await VOICE_CHECKS[provider.id]?.(env, rateLimits);
  if (rateLimits.length === 0) console.log("  429: none seen");
  else {
    const withHeader = rateLimits.filter((value) => value !== null);
    console.log(`  429: ${rateLimits.length} seen, ${withHeader.length} with Retry-After (${withHeader.join(", ") || "none"})`);
  }
}
process.exit(0);
