import { describe, expect, it } from "vitest";
import { KOKORO_DEFAULT_VOICE, KOKORO_VOICES } from "../voices.js";

// Kokoro-82M v1.0 VOICES.md, per design.md § Catalog.
const EXPECTED_IDS = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova",
  "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "em_santa",
  "ff_siwis",
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  "if_sara", "im_nicola",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  "pf_dora", "pm_alex", "pm_santa",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
];

const LOCALE_BY_PREFIX: Record<string, string> = {
  a: "en-US", b: "en-GB", e: "es-ES", f: "fr-FR", h: "hi-IN", i: "it-IT", j: "ja-JP", p: "pt-BR", z: "zh-CN",
};
const GENDER_BY_LETTER: Record<string, string> = { f: "female", m: "male" };

describe("KOKORO_VOICES", () => {
  it("kokoro catalog has the 54 v1.0 preset ids, unique", () => {
    const ids = KOKORO_VOICES.map((v) => v.id);
    expect(EXPECTED_IDS).toHaveLength(54);
    expect(ids).toHaveLength(54);
    expect(new Set(ids).size).toBe(54);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("every kokoro voice's locale and gender follow its id prefix", () => {
    for (const v of KOKORO_VOICES) {
      const name = v.id.slice(3);
      expect(v.id[2]).toBe("_");
      expect(v.locale).toBe(LOCALE_BY_PREFIX[v.id[0]!]);
      expect(v.gender).toBe(GENDER_BY_LETTER[v.id[1]!]);
      expect(v.multilingual).toBe(false);
      expect(v.label).toBe(name.charAt(0).toUpperCase() + name.slice(1));
    }
  });

  it("af_heart is an en-US female voice labelled Heart", () => {
    expect(KOKORO_DEFAULT_VOICE).toBe("af_heart");
    expect(KOKORO_VOICES.find((v) => v.id === "af_heart")).toEqual({
      id: "af_heart",
      label: "Heart",
      locale: "en-US",
      gender: "female",
      multilingual: false,
    });
  });
});
