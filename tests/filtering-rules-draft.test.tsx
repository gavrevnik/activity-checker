import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultFilteringRules, filteringRulesSchema } from "../shared/model";
import {
  parseRuleTerms,
  ruleDraftsFrom,
  rulesFromDrafts,
} from "../src/filtering-rules-draft";
import { FilteringRules } from "../src/FilteringRules";

describe("filtering rules Enter payload", () => {
  it("parses comma/newline lists, ignoring empty terms and case-insensitive duplicates", () => {
    expect(parseRuleTerms("  Tribute, \nTRIBUTE,\n Jazz  , , blues ")).toEqual([
      "Tribute",
      "Jazz",
      "blues",
    ]);
    expect(parseRuleTerms(" , \n ")).toEqual([]);
  });
  it("roundtrips the existing rules without changing them", () => {
    expect(
      rulesFromDrafts(
        defaultFilteringRules,
        ruleDraftsFrom(defaultFilteringRules),
      ),
    ).toEqual(defaultFilteringRules);
  });
  it("applies every text field and preserves numeric/switch settings", () => {
    const rules = {
      ...defaultFilteringRules,
      telegramMinMembers: { enabled: false, minMembers: 500 },
    };
    const drafts = {
      ticketVenues: "Venue A\nVenue B",
      ticketKeywords: "theatre",
      ticketTitleKeywords: "festival",
      titleKeywords: "spam, ads",
      locationKeywords: "kids",
      tagKeywords: "#ad\n#ad",
    };
    const next = rulesFromDrafts(rules, drafts);
    expect(filteringRulesSchema.parse(next)).toEqual(next);
    expect(next.telegramMinMembers).toEqual({
      enabled: false,
      minMembers: 500,
    });
    expect(next.ticketsVenue).toMatchObject({
      venues: ["Venue A", "Venue B"],
      keywords: ["theatre"],
      titleKeywords: ["festival"],
    });
    expect(next.eventTitle.keywords).toEqual(["spam", "ads"]);
    expect(next.eventLocation.keywords).toEqual(["kids"]);
    expect(next.entityTags.keywords).toEqual(["#ad"]);
    expect(rules.eventTitle.keywords).toEqual(
      defaultFilteringRules.eventTitle.keywords,
    );
  });
  it("renders Enter instructions instead of a save/apply button and disables fields while saving", () => {
    const value = {
      rules: defaultFilteringRules,
      counts: {
        total: 0,
        pastEvents: 0,
        telegramMinMembers: 0,
        ticketsVenue: 0,
        eventTitle: 0,
        eventLocation: 0,
        entityTags: 0,
      },
      pastEventsByScope: {},
    };
    const html = renderToStaticMarkup(
      <FilteringRules value={value} busy={false} onSave={async () => {}} />,
    );
    expect(html).toContain("Enter — применить изменения");
    expect(html).toContain("Shift+Enter — новая строка");
    expect(html).not.toContain("Сохранить и применить");
    const pending = renderToStaticMarkup(
      <FilteringRules value={value} busy onSave={async () => {}} />,
    );
    expect(pending).toMatch(/<fieldset[^>]*disabled=""/);
    expect(pending).toContain("Применение изменений");
    expect(pending).not.toContain("Изменения применены");
  });
});
