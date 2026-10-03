import type { Entity } from "../shared/model";
import { normalizePersonalStatePatch } from "../shared/personal-state";
import type {
  PersonalState,
  PersonalStatePatch,
} from "../shared/personal-state";

export type EntityStatePatch = PersonalStatePatch;
export type SetPersonalState<T extends PersonalState> = (
  entity: T,
  state: EntityStatePatch,
  feedback?: () => Promise<void>,
) => Promise<boolean>;
export type SetEntityState = SetPersonalState<Entity>;

// Each card saves independently; the UI never waits for a catalogue reload.
export function createEntityStateUpdater<T extends PersonalState = Entity>({
  save,
  patch,
  pending,
  reportError,
}: {
  save: (id: string, state: EntityStatePatch) => Promise<T>;
  patch: (id: string, state: EntityStatePatch & { updatedAt?: string }) => void;
  pending: (id: string, value: boolean) => void;
  reportError: (error: unknown) => void;
}): SetPersonalState<T> {
  const inFlight = new Set<string>();
  return async (entity, state, feedback) => {
    state = normalizePersonalStatePatch(state);
    if (inFlight.has(entity.id)) return false;
    inFlight.add(entity.id);
    const previous: EntityStatePatch = {};
    if (state.favorite !== undefined) previous.favorite = entity.favorite;
    if (state.reaction !== undefined) previous.reaction = entity.reaction;
    if (state.dislikeReason !== undefined)
      previous.dislikeReason = entity.dislikeReason;
    if (state.skipped !== undefined) previous.skipped = !!entity.skipped;
    if (state.skipReason !== undefined)
      previous.skipReason = entity.skipReason || "";
    pending(entity.id, true);
    try {
      // Handle rejection immediately, even while the short exit animation runs.
      const response = save(entity.id, state).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await feedback?.();
      patch(entity.id, state);
      const outcome = await response;
      if ("error" in outcome) throw outcome.error;
      const confirmed: EntityStatePatch = {};
      if (state.favorite !== undefined)
        confirmed.favorite = outcome.value.favorite;
      if (state.reaction !== undefined)
        confirmed.reaction = outcome.value.reaction;
      if (state.dislikeReason !== undefined)
        confirmed.dislikeReason = outcome.value.dislikeReason;
      if (state.skipped !== undefined)
        confirmed.skipped = !!outcome.value.skipped;
      if (state.skipReason !== undefined)
        confirmed.skipReason = outcome.value.skipReason || "";
      patch(entity.id, { ...confirmed, updatedAt: outcome.value.updatedAt });
      return true;
    } catch (error) {
      patch(entity.id, previous);
      reportError(error);
      return false;
    } finally {
      inFlight.delete(entity.id);
      pending(entity.id, false);
    }
  };
}
