import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EventReactions } from "../src/EventReactions";

it.each([false, true])(
  "renders the filled curved skip arrow with skipped=%s without changing accessible actions",
  (skipped) => {
    const markup = renderToStaticMarkup(
      <EventReactions
        entity={{
          id: "test",
          favorite: false,
          reaction: "",
          dislikeReason: "",
          skipped,
          skipReason: "",
          updatedAt: "",
        }}
        onSetState={async () => true}
        pending={false}
        willHide={() => false}
        onExitChange={() => {}}
      />,
    );
    expect(markup).toContain('class="skip-arrow-icon"');
    expect(markup).toContain(
      'fill="currentColor" aria-hidden="true" focusable="false"',
    );
    expect(markup).toContain(
      `aria-label="${skipped ? "Убрать отметку «Пропущено»" : "Пропустить"}"`,
    );
    expect(markup).not.toContain("lucide-skip-forward");
  },
);
