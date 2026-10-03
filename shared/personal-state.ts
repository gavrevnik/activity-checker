import { z } from "zod";
import { entityReactions, type EntityReaction } from "./model.js";

export interface PersonalState {
  id: string;
  favorite: boolean;
  reaction: EntityReaction;
  dislikeReason: string;
  skipped?: boolean;
  skipReason?: string;
  updatedAt: string;
}
export type PersonalStatePatch = Partial<
  Pick<
    PersonalState,
    "favorite" | "reaction" | "dislikeReason" | "skipped" | "skipReason"
  >
>;
export const dislikeReasonSchema = z.string().trim().max(2000);
export const personalStatePatchSchema = z
  .object({
    favorite: z.boolean().optional(),
    reaction: z.enum(entityReactions).optional(),
    dislikeReason: dislikeReasonSchema.optional(),
    skipped: z.boolean().optional(),
    skipReason: dislikeReasonSchema.optional(),
  })
  .strict()
  .refine(
    (state) => Object.values(state).some((value) => value !== undefined),
    "Укажите избранное, оценку, пропуск или причину.",
  );

// A neutral skip replaces a reaction, never masquerades as a dislike.
// Favorites and the two distinct feedback fields remain independent.
export function normalizePersonalStatePatch<T extends PersonalStatePatch>(
  state: T,
): T {
  if (state.skipped === true) return { ...state, reaction: "" };
  if (state.reaction) return { ...state, skipped: false };
  return state;
}

export function matchesEvaluation(
  entity: Pick<PersonalState, "favorite" | "reaction" | "skipped">,
  evaluation: string[] | null,
) {
  return (
    evaluation === null ||
    evaluation.some((value) =>
      value === "liked"
        ? entity.reaction === "like"
        : value === "disliked"
          ? entity.reaction === "dislike"
          : value === "favorite"
            ? entity.favorite
            : value === "skipped"
              ? !!entity.skipped
              : value === "unrated" &&
                !entity.reaction &&
                !entity.favorite &&
                !entity.skipped,
    )
  );
}
