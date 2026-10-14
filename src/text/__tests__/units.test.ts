import { describe, expect, it } from "vitest";
import { firstSentence, packUnits } from "../index.js";

const para = (length: number, fill = "a") => ({ text: `${fill.repeat(length - 1)}.` });

describe("packUnits", () => {
  it("short paragraphs merge up to the floor", () => {
    const paragraphs = [para(90, "a"), para(90, "b"), para(90, "c"), para(90, "d")];
    const units = packUnits(paragraphs);
    expect(units[0]).toEqual({
      text: paragraphs.slice(0, 3).map((p) => p.text).join(" "),
      from: 0,
      to: 2,
    });
    expect(units[1]).toEqual({ text: paragraphs[3]!.text, from: 3, to: 3 });
  });

  it("never merges past the ceiling", () => {
    // 150 is below the floor, but 150 + 1 + 350 would pass the 450 ceiling.
    const paragraphs = [para(150, "a"), para(350, "b"), para(50, "c")];
    const units = packUnits(paragraphs);
    expect(units).toEqual([
      { text: paragraphs[0]!.text, from: 0, to: 0 },
      { text: paragraphs[1]!.text, from: 1, to: 1 },
      { text: paragraphs[2]!.text, from: 2, to: 2 },
    ]);
    for (const unit of units) expect(unit.text.length).toBeLessThanOrEqual(450);
  });

  it("long paragraph is cut on sentences then words", () => {
    const sentence = "Zażółć gęślą jaźń teraz! ";
    const sentences = sentence.repeat(4).trim(); // 4 sentences of 24 chars
    const words = Array.from({ length: 20 }, (_, i) => `słowo${i}`).join(" ") + "…";
    const paragraphs = [{ text: "Krótki wstęp." }, { text: sentences }, { text: words }];
    const units = packUnits(paragraphs, { min: 10, max: 50 });

    expect(units[0]).toEqual({ text: "Krótki wstęp.", from: 0, to: 0 });
    const fromSentences = units.filter((u) => u.from === 1);
    expect(fromSentences.map((u) => u.text)).toEqual([
      "Zażółć gęślą jaźń teraz! Zażółć gęślą jaźń teraz!",
      "Zażółć gęślą jaźń teraz! Zażółć gęślą jaźń teraz!",
    ]);
    const fromWords = units.filter((u) => u.from === 2);
    expect(fromWords.length).toBeGreaterThan(1);
    for (const unit of fromWords) {
      expect(unit.to).toBe(2);
      expect(unit.text.length).toBeLessThanOrEqual(50);
      expect(unit.text).not.toMatch(/^\s|\s$/);
    }
    expect(fromWords.map((u) => u.text).join(" ")).toBe(words);
  });
});

describe("firstSentence", () => {
  it("first sentence is extracted", () => {
    expect(firstSentence("Pierwsze zdanie. Drugie zdanie.")).toBe("Pierwsze zdanie.");
    expect(firstSentence("Czy to działa? Tak.")).toBe("Czy to działa?");
    expect(firstSentence("Hmm… dalej.")).toBe("Hmm…");
    expect(firstSentence("Wersja 2.5 jest gotowa! Reszta.")).toBe("Wersja 2.5 jest gotowa!");
    expect(firstSentence("bez kropki")).toBeNull();
    expect(firstSentence("")).toBeNull();
  });
});
