import { expect, it } from "vitest";
import {
  matchesEvaluation,
  normalizePersonalStatePatch,
  personalStatePatchSchema,
} from "../shared/personal-state.js";

it("uses the same independent favorite/rating filter for both event feeds", () => {
  expect(
    matchesEvaluation({ reaction: "", favorite: false }, ["unrated"]),
  ).toBe(true);
  expect(matchesEvaluation({ reaction: "", favorite: true }, ["unrated"])).toBe(
    false,
  );
  expect(
    matchesEvaluation({ reaction: "like", favorite: false }, ["unrated"]),
  ).toBe(false);
  expect(
    matchesEvaluation({ reaction: "dislike", favorite: true }, ["favorite"]),
  ).toBe(true);
  expect(
    matchesEvaluation({ reaction: "dislike", favorite: true }, ["liked"]),
  ).toBe(false);
  expect(
    matchesEvaluation({ reaction: "dislike", favorite: true }, [
      "liked",
      "disliked",
    ]),
  ).toBe(true);
  expect(
    matchesEvaluation({ reaction: "dislike", favorite: false }, null),
  ).toBe(true);
  expect(matchesEvaluation({ reaction: "", favorite: false }, [])).toBe(false);
  expect(
    personalStatePatchSchema.parse({ favorite: true, reaction: "like" }),
  ).toEqual({ favorite: true, reaction: "like" });
});

it("treats skipping as rated but neutral, independently of favorites", () => {
  const state = { skipped: true, reaction: "" as const, favorite: false };
  expect(matchesEvaluation(state, ["unrated", "disliked", "liked"])).toBe(
    false,
  );
  expect(matchesEvaluation(state, ["skipped"])).toBe(true);
  expect(matchesEvaluation(state, null)).toBe(true);
  expect(matchesEvaluation({ ...state, favorite: true }, ["favorite"])).toBe(
    true,
  );
  expect(
    normalizePersonalStatePatch({
      skipped: true,
      reaction: "like",
      favorite: true,
    }),
  ).toEqual({ skipped: true, reaction: "", favorite: true });
  expect(normalizePersonalStatePatch({ reaction: "dislike" })).toEqual({
    reaction: "dislike",
    skipped: false,
  });
  expect(normalizePersonalStatePatch({ skipReason: "дубль" })).toEqual({
    skipReason: "дубль",
  });
  expect(
    personalStatePatchSchema.parse({ skipped: true, skipReason: "  дубль  " }),
  ).toEqual({ skipped: true, skipReason: "дубль" });
  expect(personalStatePatchSchema.safeParse({ skipped: "true" }).success).toBe(
    false,
  );
  expect(
    personalStatePatchSchema.safeParse({ skipReason: "x".repeat(2001) })
      .success,
  ).toBe(false);
});
