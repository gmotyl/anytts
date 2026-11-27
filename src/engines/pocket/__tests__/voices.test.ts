import { describe, expect, it } from "vitest";
import { pocketCatalog } from "../voices.js";

// pocket-tts 4.0.1 presets, per specs/pocket-engine/spec.md.
const EXPECTED_IDS = [
  "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette", "eponine", "eve",
  "fantine", "george", "jane", "jean", "javert", "marius", "mary", "michael", "paul",
  "peter_yearsley", "stuart_bell", "vera", "giovanni", "lola", "juergen", "rafael", "daan", "estelle",
];

describe("pocketCatalog", () => {
  it("pocket lists the 27 English presets", () => {
    const voices = pocketCatalog("pocket");
    expect(voices.map((v) => v.id)).toEqual(EXPECTED_IDS);
    expect(voices[0]!.id).toBe("alba");
    expect(voices.every((v) => v.locale === "en-US" && v.multilingual === false)).toBe(true);
  });

  it("pocket-pl lists the shefowl reference", () => {
    const voices = pocketCatalog("pocket-pl");
    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({ id: "shefowl", label: "Polski (wzorzec)", locale: "pl-PL", multilingual: false });
  });

  it.each([".", ".."])("rejects the dot-segment custom voice id %j", (id) => {
    expect(() => pocketCatalog("pocket", [{ id, label: "X", version: 1 }])).toThrow(RangeError);
  });

  it("caller voices take the engine's locale", () => {
    const piotr = { id: "piotr", label: "Piotr", gender: "male" as const, version: 1 };
    const en = pocketCatalog("pocket", [piotr]).find((v) => v.id === "piotr");
    const pl = pocketCatalog("pocket-pl", [piotr]).find((v) => v.id === "piotr");
    expect(en).toMatchObject({ locale: "en-US", gender: "male", label: "Piotr" });
    expect(pl?.locale).toBe("pl-PL");
  });

  it("a caller voice may not shadow a preset", () => {
    expect(() => pocketCatalog("pocket", [{ id: "alba", label: "X", version: 1 }])).toThrow(RangeError);
    expect(() => pocketCatalog("pocket-pl", [{ id: "shefowl", label: "X", version: 1 }])).toThrow(RangeError);
  });
});
