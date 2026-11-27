import type { VoiceInfo } from "../../engine.js";

export interface PocketVoice {
  id: string;
  label: string;
  gender?: "female" | "male";
  /** Cache-busting version of the voice sample (appended as `?v=`). */
  version: number;
}

type PocketId = "pocket" | "pocket-pl";

const LOCALE: Record<PocketId, string> = { pocket: "en-US", "pocket-pl": "pl-PL" };

const label = (id: string): string =>
  id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

const preset = (id: string, gender: "female" | "male"): VoiceInfo => ({
  id,
  label: label(id),
  locale: "en-US",
  gender,
  multilingual: false,
});

// pocket-tts 4.0.1 predefined voices; `alba` is the default and comes first.
// The genders below are inferred from the voice names, not taken from the spec or the pocket-tts
// docs (VoiceInfo.gender is required, so something has to be filled in). Treat them as best guesses.
export const POCKET_PRESETS: readonly VoiceInfo[] = [
  preset("alba", "female"),
  preset("anna", "female"),
  preset("azelma", "female"),
  preset("bill_boerst", "male"),
  preset("caro_davy", "male"),
  preset("charles", "male"),
  preset("cosette", "female"),
  preset("eponine", "female"),
  preset("eve", "female"),
  preset("fantine", "female"),
  preset("george", "male"),
  preset("jane", "female"),
  preset("jean", "male"),
  preset("javert", "male"),
  preset("marius", "male"),
  preset("mary", "female"),
  preset("michael", "male"),
  preset("paul", "male"),
  preset("peter_yearsley", "male"),
  preset("stuart_bell", "male"),
  preset("vera", "female"),
  preset("giovanni", "male"),
  preset("lola", "female"),
  preset("juergen", "male"),
  preset("rafael", "male"),
  preset("daan", "male"),
  preset("estelle", "female"),
];

// The Polish server ships one reference voice.
export const POCKET_PL_PRESETS: readonly VoiceInfo[] = [
  { id: "shefowl", label: "Polski (wzorzec)", locale: "pl-PL", gender: "female", multilingual: false },
];

/** Presets plus caller voices, all carrying the engine's locale. */
export function pocketCatalog(id: PocketId, customVoices: readonly PocketVoice[] = []): VoiceInfo[] {
  const presets = id === "pocket" ? POCKET_PRESETS : POCKET_PL_PRESETS;
  const taken = new Set(presets.map((v) => v.id));
  const extra = customVoices.map((v): VoiceInfo => {
    if (taken.has(v.id)) throw new RangeError(`${id}: voice "${v.id}" shadows a preset voice`);
    taken.add(v.id);
    // VoiceInfo requires a gender; the "female" fallback for callers that omit it is a placeholder, not data.
    return { id: v.id, label: v.label, locale: LOCALE[id], gender: v.gender ?? "female", multilingual: false };
  });
  return [...presets, ...extra];
}
