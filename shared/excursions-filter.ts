// Match the explicit tag, not titles, descriptions or similarly named tags.
export function matchesExcursionsTag(
  tags: readonly string[],
  onlyExcursions: boolean,
) {
  return (
    !onlyExcursions ||
    tags.some(
      (tag) =>
        tag.trim().replace(/^#/, "").toLocaleLowerCase("ru") === "экскурсии",
    )
  );
}
