export type FeedbackCollection = "entities" | "telegram-events";
export const feedbackCardKey = (collection: FeedbackCollection, id: string) =>
  `${collection}/${id}`;

// Each popup owns a lease, so a late completion cannot unpin a newer popup
// for the same card. Closing animations can overlap with the next feedback.
export function createFeedbackRetention(
  changed: (cards: ReadonlySet<string>) => void,
) {
  const leases = new Map<symbol, string>();
  const publish = () => changed(new Set(leases.values()));
  return {
    hold(card: string) {
      const lease = Symbol(card);
      leases.set(lease, card);
      publish();
      return () => {
        if (leases.delete(lease)) publish();
      };
    },
  };
}
