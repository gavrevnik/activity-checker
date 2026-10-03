import { expect, it } from "vitest";
import { matchesExcursionsTag } from "../shared/excursions-filter";

it("does not restrict the feed while the quick filter is off", () => {
  expect(matchesExcursionsTag([], false)).toBe(true);
  expect(matchesExcursionsTag(["Музыка"], false)).toBe(true);
  expect(matchesExcursionsTag(["Экскурсии"], false)).toBe(true);
});
it("matches the exact excursion tag case-insensitively, including a leading hash", () => {
  for (const tag of [
    "Экскурсии",
    "экскурсии",
    "ЭКСКУРСИИ",
    "#Экскурсии",
    " #экскурсии ",
  ])
    expect(matchesExcursionsTag(["Искусство", tag], true)).toBe(true);
});
it("excludes missing and similar tags rather than searching descriptions or titles", () => {
  for (const tags of [
    [],
    ["Музыка"],
    ["Экскурсия"],
    ["Экскурсии по городу"],
    ["НеЭкскурсии"],
  ])
    expect(matchesExcursionsTag(tags, true)).toBe(false);
});
it("does not mutate tags or replace other tag selections", () => {
  const tags = Object.freeze(["Экскурсии", "Искусство"]);
  const selected = ["Музыка"];
  expect(
    matchesExcursionsTag(tags, true) &&
      tags.some((tag) => selected.includes(tag)),
  ).toBe(false);
  expect(tags).toEqual(["Экскурсии", "Искусство"]);
});
