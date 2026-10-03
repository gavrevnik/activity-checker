import { describe, expect, it } from "vitest";
import { isAiScoreInput, matchesAiScore } from "../shared/score-filter";

describe("event AI-score threshold", () => {
  it("accepts an empty field and integer thresholds from 0 to 10", () => {
    for (const value of ["", "0", "1", "8", "10"])
      expect(isAiScoreInput(value)).toBe(true);
    for (const value of ["-1", "11", "100", "8.5", "a", " "])
      expect(isAiScoreInput(value)).toBe(false);
  });
  it("includes the threshold and all higher scores, including fractional scores", () => {
    expect(matchesAiScore(7.9, "8")).toBe(false);
    expect(matchesAiScore(8, "8")).toBe(true);
    expect(matchesAiScore(8.5, "8")).toBe(true);
    expect(matchesAiScore(10, "8")).toBe(true);
  });
  it("excludes unrated events for every active threshold, including zero", () => {
    expect(matchesAiScore(null, "0")).toBe(false);
    expect(matchesAiScore(null, "8")).toBe(false);
    expect(matchesAiScore(0, "0")).toBe(true);
    expect(matchesAiScore(10, "10")).toBe(true);
    expect(matchesAiScore(9.9, "10")).toBe(false);
  });
  it("shows both rated and unrated events when cleared", () => {
    expect(matchesAiScore(null, "")).toBe(true);
    expect(matchesAiScore(0, "")).toBe(true);
    expect(matchesAiScore(10, "")).toBe(true);
  });
});
