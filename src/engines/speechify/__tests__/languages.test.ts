import { describe, expect, it } from "vitest";
import { SPEECHIFY_LANGUAGES } from "../languages.js";

describe("speechify languages", () => {
  it("lists 48 bases with European defaults for en, pt and es", () => {
    expect(Object.keys(SPEECHIFY_LANGUAGES)).toHaveLength(48);
    expect(SPEECHIFY_LANGUAGES.en).toBe("en-GB");
    expect(SPEECHIFY_LANGUAGES.pt).toBe("pt-PT");
    expect(SPEECHIFY_LANGUAGES.es).toBe("es-ES");
    expect(SPEECHIFY_LANGUAGES.pl).toBe("pl-PL");
  });
});
