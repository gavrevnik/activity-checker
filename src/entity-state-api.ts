import type { Entity } from "../shared/model";
import type { EntityStatePatch } from "./entity-state";
import { api, ApiError } from "./api";
import type { PersonalState } from "../shared/personal-state";

function confirmed(value: PersonalState, id: string, state: EntityStatePatch) {
  return (
    value &&
    value.id === id &&
    typeof value.updatedAt === "string" &&
    (state.reaction === undefined || value.reaction === state.reaction) &&
    (state.favorite === undefined || value.favorite === state.favorite) &&
    (state.skipped === undefined || value.skipped === state.skipped) &&
    (state.skipReason === undefined || value.skipReason === state.skipReason) &&
    (state.dislikeReason === undefined ||
      value.dislikeReason === state.dislikeReason)
  );
}

// Only explicit, idempotent personal-state assignments are retried. Never retry
// imports, source syncs, or other API mutations which could have external costs.
export async function saveEntityState(
  id: string,
  state: EntityStatePatch,
  signal = AbortSignal.timeout(15000),
): Promise<Entity> {
  return savePersonalState<Entity>("/entities", id, state, signal);
}

export async function savePersonalState<T extends PersonalState>(
  collection: string,
  id: string,
  state: EntityStatePatch,
  signal = AbortSignal.timeout(15000),
): Promise<T> {
  const path = collection + "/" + encodeURIComponent(id);
  for (let attempt = 0; ; attempt++) {
    try {
      const saved = await api<T>(path, "PATCH", state, signal);
      if (!confirmed(saved, id, state))
        throw new ApiError(
          "Сервер не подтвердил сохранение оценки.",
          200,
          true,
        );
      return saved;
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        !error.retryable ||
        attempt >= 2 ||
        signal.aborted
      )
        throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, attempt ? 750 : 250),
      );
      // The write may have succeeded before its response was interrupted.
      // Confirm it by ID before repeating the exact same assignment.
      try {
        const current = await api<T>(path, "GET", undefined, signal);
        if (confirmed(current, id, state)) return current;
      } catch (readError) {
        if (
          !(readError instanceof ApiError) ||
          !readError.retryable ||
          signal.aborted
        )
          throw readError;
      }
    }
  }
}
