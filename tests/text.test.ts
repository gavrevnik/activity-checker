import { describe, expect, it } from "vitest";
import { containsSerbianSpecificLetters } from "../shared/text";

describe("Serbian-specific letter detection", () => {
  it("matches Serbian Latin and Cyrillic letters", () => {
    for (const value of ["Čačak", "Dorćol", "Đorđe", "Šuma", "Život", "Љубав"])
      expect(containsSerbianSpecificLetters(value)).toBe(true);
  });

  it("does not treat English J or Russian Cyrillic as Serbian-specific", () => {
    for (const value of ["Jazz in Belgrade", "Jovan Johnson", "Жизнь и музыка"])
      expect(containsSerbianSpecificLetters(value)).toBe(false);
  });
});
