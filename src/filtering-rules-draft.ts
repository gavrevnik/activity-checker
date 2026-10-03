import type { FilteringRules } from "../shared/model";

const formatTerms = (terms: string[]) => terms.join(", ");
export const parseRuleTerms = (value: string) => {
  const seen = new Set<string>();
  return value
    .split(/[,\n]/u)
    .map((term) => term.trim())
    .filter((term) => {
      const key = term.toLocaleLowerCase();
      if (!term || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};
export const ruleDraftsFrom = (rules: FilteringRules) => ({
  ticketVenues: formatTerms(rules.ticketsVenue.venues),
  ticketKeywords: formatTerms(rules.ticketsVenue.keywords),
  ticketTitleKeywords: formatTerms(rules.ticketsVenue.titleKeywords),
  titleKeywords: formatTerms(rules.eventTitle.keywords),
  locationKeywords: formatTerms(rules.eventLocation.keywords),
  tagKeywords: formatTerms(rules.entityTags.keywords),
});
export function rulesFromDrafts(
  rules: FilteringRules,
  drafts: ReturnType<typeof ruleDraftsFrom>,
): FilteringRules {
  return {
    ...rules,
    ticketsVenue: {
      ...rules.ticketsVenue,
      venues: parseRuleTerms(drafts.ticketVenues),
      keywords: parseRuleTerms(drafts.ticketKeywords),
      titleKeywords: parseRuleTerms(drafts.ticketTitleKeywords),
    },
    eventTitle: {
      ...rules.eventTitle,
      keywords: parseRuleTerms(drafts.titleKeywords),
    },
    eventLocation: {
      ...rules.eventLocation,
      keywords: parseRuleTerms(drafts.locationKeywords),
    },
    entityTags: {
      ...rules.entityTags,
      keywords: parseRuleTerms(drafts.tagKeywords),
    },
  };
}
