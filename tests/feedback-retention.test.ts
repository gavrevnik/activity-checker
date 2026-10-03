import { expect, it } from "vitest";
import {
  createFeedbackRetention,
  feedbackCardKey,
} from "../src/feedback-retention";
import { matchesEvaluation } from "../shared/personal-state";

it.each(["dislike", "skip"])(
  "keeps a %s card in Unrated until its feedback lease is released",
  (kind) => {
    let retained: ReadonlySet<string> = new Set();
    const retention = createFeedbackRetention((cards) => {
      retained = cards;
    });
    const key = feedbackCardKey("entities", "one");
    const release = retention.hold(key);
    const visible = () =>
      retained.has(key) ||
      matchesEvaluation(
        {
          reaction: kind === "dislike" ? "dislike" : "",
          skipped: kind === "skip",
          favorite: false,
        },
        ["unrated"],
      );
    expect(visible()).toBe(true); // Includes the time spent saving feedback or showing a failed-write error.
    release();
    expect(visible()).toBe(false);
  },
);

it("does not release the next popup when an earlier one finishes late", () => {
  let retained: ReadonlySet<string> = new Set();
  const retention = createFeedbackRetention((cards) => {
    retained = cards;
  });
  const key = feedbackCardKey("entities", "one");
  const first = retention.hold(key);
  const second = retention.hold(key);
  first();
  first();
  expect(retained.has(key)).toBe(true);
  second();
  expect(retained.size).toBe(0);
});

it("allows independent dismissal animation and feedback on the next card, including matching Telegram IDs", () => {
  let retained: ReadonlySet<string> = new Set();
  const retention = createFeedbackRetention((cards) => {
    retained = cards;
  });
  const event = feedbackCardKey("entities", "one");
  const telegram = feedbackCardKey("telegram-events", "one");
  const releaseEvent = retention.hold(event);
  const releaseTelegram = retention.hold(telegram);
  releaseEvent();
  expect([...retained]).toEqual([telegram]);
  releaseTelegram();
  expect(retained.size).toBe(0);
});
