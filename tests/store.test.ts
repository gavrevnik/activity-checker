import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { importEntities } from "../server/import";
import { entitySchema, type EntityInput } from "../shared/model";
import { seedDemo } from "../server/demo";
import {
  cinemaClubPreference,
  defaultUserProfile,
  upgradeUserProfileDefaults,
} from "../server/profile";
let store: Store;
beforeEach(() => (store = new Store(":memory:")));
afterEach(() => {
  vi.useRealTimers();
  store.close();
});
const place: EntityInput = {
  type: "Place",
  title: "Boulder Room",
  address: "Test 12",
  city: "Belgrade",
  url: "https://venue.test/location",
  description: "Original",
};
function ingest(
  value: EntityInput,
  externalId = "1",
  sourceId = "source-manual",
) {
  return store.ingest(store.source(sourceId), [
    {
      entity: value,
      raw: {
        externalId,
        url: value.url || "",
        rawText: value.description || "",
        payload: value,
      },
    },
  ]);
}
function input(id: string) {
  const e = store.entity(id);
  return entitySchema.parse(
    Object.fromEntries(
      Object.keys(entitySchema.shape).map((k) => [k, (e as any)[k]]),
    ),
  );
}
describe("canonical ingestion", () => {
  it("seeds sources without secrets or invented connection success", () => {
    expect(store.scopes()).toHaveLength(2);
    expect(store.sources().length).toBeGreaterThan(15);
    expect(store.sources().every((s) => s.status !== "connected")).toBe(true);
  });
  it("rejects the retired organizer entity type", () => {
    expect(() =>
      entitySchema.parse({ type: "Organizer", title: "Legacy organizer" }),
    ).toThrow();
  });
  it("creates and updates the local personal profile", () => {
    const initial = store.profile();
    expect(initial.artists).toHaveLength(46);
    expect(initial.artists).toContain("HÆLOS");
    expect(initial.communityPreferences.join(" ")).toContain("Русскоязычные");
    expect(initial.eventPreferences).toContain(cinemaClubPreference);
    const { updatedAt: _updatedAt, ...input } = initial;
    const saved = store.saveProfile({
      ...input,
      summary: "Обновлённый профиль",
      artists: ["Massive Attack", "Portishead"],
    });
    expect(saved.summary).toBe("Обновлённый профиль");
    expect(store.profile().artists).toEqual(["Massive Attack", "Portishead"]);
  });
  it("clears a stale event end when the provider moves a single-day event", () => {
    ingest(
      {
        type: "Event",
        title: "Moved event",
        startAt: "2099-10-01",
        endAt: "2099-10-03",
      },
      "moved-event",
      "source-afisha",
    );
    ingest(
      {
        type: "Event",
        title: "Moved event",
        startAt: "2099-11-01",
      },
      "moved-event",
      "source-afisha",
    );
    expect(store.entities()[0]).toMatchObject({
      startAt: "2099-11-01",
      endAt: "",
    });
  });
  it("adds cinema clubs to an existing profile only once", () => {
    const current = {
      ...defaultUserProfile,
      eventPreferences: ["Квизы"],
    };
    const upgraded = upgradeUserProfileDefaults(current);
    expect(upgraded.eventPreferences).toEqual(["Квизы", cinemaClubPreference]);
    expect(upgradeUserProfileDefaults(upgraded)).toBe(upgraded);
  });
  it("upgrades the previous profile shape without losing the artist list", () => {
    store.profile();
    store.db.prepare("UPDATE user_profile SET data=? WHERE id='main'").run(
      JSON.stringify({
        summary: "Legacy profile",
        eventPreferences: ["Old event"],
        communityPreferences: ["Old community"],
        networkingGoals: ["Old goal"],
        musicPreferences: ["Old music"],
        artists: ["Portishead"],
        searchNotes: "Old instructions",
      }),
    );
    const upgraded = store.profile();
    expect(upgraded.summary).toContain("product analytics");
    expect(upgraded.artists).toEqual(["Portishead"]);
    const row = store.db
      .prepare("SELECT data FROM user_profile WHERE id='main'")
      .get() as { data: string };
    expect(JSON.parse(row.data)).not.toHaveProperty("networkingGoals");
    expect(JSON.parse(row.data)).not.toHaveProperty("searchNotes");
  });
  it("is idempotent and keeps original payload", () => {
    expect(ingest(place).created).toBe(1);
    expect(ingest(place).duplicates).toBe(1);
    expect(store.entities()).toHaveLength(1);
    const e = store.entity(store.entities()[0].id);
    expect(e.provenance).toHaveLength(1);
    expect(e.provenance[0].rawPayload).toEqual(place);
  });
  it("keeps changed raw versions and edits, personal state and AI metadata", () => {
    ingest(place);
    const id = store.entities()[0].id;
    store.editEntity(id, {
      ...input(id),
      title: "My title",
      aiScore: 9.1,
      aiDecision: "recommended",
    });
    store.setState(id, { favorite: true, archived: true, notes: "Try this" });
    expect(
      ingest({ ...place, title: "Provider title", description: "New details" })
        .updated,
    ).toBe(1);
    const e = store.entity(id);
    expect(e.title).toBe("My title");
    expect(e.description).toBe("New details");
    expect(e.aiScore).toBe(9.1);
    expect(e.favorite && e.archived).toBe(true);
    expect(e.notes).toBe("Try this");
    expect(e.provenance).toHaveLength(2);
  });
  it("keeps an event reaction independent from the favorite flag", () => {
    const event: EntityInput = {
      type: "Event",
      title: "One-off concert",
      startAt: "2099-04-16T18:00:00Z",
    };
    ingest(event, "event-reaction");
    const id = store.entities()[0].id;

    store.setState(id, { reaction: "like", favorite: true });
    expect(store.entity(id)).toMatchObject({
      reaction: "like",
      favorite: true,
    });

    store.setState(id, { reaction: "dislike" });
    expect(store.entity(id)).toMatchObject({
      reaction: "dislike",
      favorite: true,
    });
    expect(store.entities()).toHaveLength(1);

    ingest(
      { ...event, description: "Updated provider description" },
      "event-reaction",
    );
    expect(store.entity(id)).toMatchObject({
      reaction: "dislike",
      favorite: true,
      description: "Updated provider description",
    });

    expect(() => {
      ingest(place, "place-reaction");
      const placeId = store
        .entities()
        .find((entity) => entity.type === "Place")!.id;
      store.setState(placeId, { reaction: "like" });
    }).toThrow("Оценивать можно только мероприятия");
  });
  it("deduplicates across sources and links both", () => {
    ingest(place);
    ingest(
      { ...place, url: "https://venue.test/location?utm_source=tg" },
      "channel-2",
      "source-telegram",
    );
    expect(store.entities()).toHaveLength(1);
    expect(store.entities()[0].sources).toHaveLength(2);
    expect(store.entity(store.entities()[0].id).provenance).toHaveLength(2);
  });
  it("keeps restaurant cuisine and deduplicates by Google Place ID", () => {
    ingest(
      {
        type: "Place",
        title: "Original Google title",
        address: "First address",
        knownIds: { google_place: "place-restaurant-1" },
      },
      "place-restaurant-1",
      "source-google-places-api",
    );
    ingest(
      {
        type: "Place",
        title: "Personal restaurant title",
        category: "Еда и напитки",
        cuisine: "грузинская",
        tags: ["restaurant", "want-to-visit"],
        knownIds: {
          google_place: "place-restaurant-1",
          legacy_restaurant: "legacy-restaurant-001",
        },
      },
      "legacy-restaurant-001",
    );
    expect(store.entities()).toHaveLength(1);
    expect(store.entities()[0]).toMatchObject({
      title: "Personal restaurant title",
      cuisine: "грузинская",
      tags: expect.arrayContaining(["restaurant", "want-to-visit"]),
      knownIds: {
        google_place: "place-restaurant-1",
        legacy_restaurant: "legacy-restaurant-001",
      },
    });
    expect(store.entities()[0].sources).toHaveLength(2);
  });
  it("merges recurring events but keeps types and countries separate", () => {
    const e: EntityInput = {
      type: "Event",
      title: "Jazz",
      url: "https://club.test/events/jazz",
      venue: "Club",
      startAt: "2099-10-01T20:00:00+02:00",
    };
    ingest(e, "1");
    ingest({ ...e, startAt: "2099-10-02T20:00:00+02:00" }, "2");
    ingest({ ...e, type: "Place" }, "3");
    ingest({ ...e, country: "DE" }, "4");
    expect(store.entities()).toHaveLength(3);
    expect(
      store.entities().find((entity) => entity.type === "Event")?.startAt,
    ).toBe("2099-10-01T18:00:00.000Z");
  });
  it("moves completed dated events to the dedicated archive table", () => {
    ingest({ type: "Event", title: "Past", startAt: "2026-09-30" }, "past");
    ingest(
      {
        type: "Event",
        title: "Still running",
        startAt: "2026-09-29",
        endAt: "2026-10-02",
      },
      "running",
    );
    ingest({ type: "Event", title: "Today", startAt: "2026-10-01" }, "today");
    ingest({ type: "Event", title: "Undated" }, "undated");
    expect(store.archivePastEvents("belgrade", "2026-10-01")).toEqual({
      archived: 1,
      cutoffDate: "2026-10-01",
    });
    expect(store.entities().map((entity) => entity.title)).not.toContain(
      "Past",
    );
    const archived = store.db
      .prepare("SELECT * FROM past_events_archive")
      .get() as { title: string; snapshot: string };
    expect(archived.title).toBe("Past");
    expect(JSON.parse(archived.snapshot).provenance).toHaveLength(1);
  });
  it("counts archivable past events separately for every scope", () => {
    ingest(
      {
        type: "Event",
        title: "Past in Belgrade",
        city: "Belgrade",
        startAt: "2000-01-01",
      },
      "past-belgrade",
    );
    ingest(
      {
        type: "Event",
        title: "Past outside Belgrade",
        city: "Niš",
        startAt: "2000-01-01",
      },
      "past-nis",
    );
    ingest(
      {
        type: "Event",
        title: "Future in Belgrade",
        city: "Belgrade",
        startAt: "2099-01-01",
      },
      "future-belgrade",
    );
    expect(store.filterRulesView().pastEventsByScope).toEqual({
      serbia: 2,
      belgrade: 1,
    });
  });
  it("applies configurable static filters without deleting source data", () => {
    expect(
      ingest(
        {
          type: "Community",
          title: "Small Telegram group",
          tags: ["telegram"],
          memberCount: 199,
        },
        "small",
        "source-telegram",
      ).filtered,
    ).toBe(1);
    ingest(
      {
        type: "Community",
        title: "Unknown Telegram group",
        tags: ["telegram"],
      },
      "unknown",
      "source-telegram",
    );
    expect(store.entities().map((entity) => entity.title)).toEqual([
      "Unknown Telegram group",
    ]);
    const hidden = store
      .entities({ includeFiltered: true })
      .find((entity) => entity.title === "Small Telegram group")!;
    expect(hidden.filterReasons).toContain("telegramMinMembers");

    const rules = store.filterRules();
    store.saveFilterRules({
      ...rules,
      telegramMinMembers: { enabled: true, minMembers: 100 },
    });
    expect(
      store
        .entities()
        .map((entity) => entity.title)
        .sort(),
    ).toEqual(["Small Telegram group", "Unknown Telegram group"]);
  });
  it("filters events by Tickets.rs venues, title and location keywords", () => {
    ingest({ type: "Event", title: "Old event", startAt: "2000-01-01" }, "old");
    ingest(
      {
        type: "Event",
        title: "Pan show",
        venue: "PAN TEATAR",
        startAt: "2099-01-01",
      },
      "pan",
      "source-tickets",
    );
    ingest(
      {
        type: "Event",
        title: "Opera show",
        venue: "Opera i teatar Madlenianum",
        startAt: "2099-01-01",
      },
      "madlenianum",
      "source-tickets",
    );
    ingest(
      {
        type: "Event",
        title: "Odeon show",
        venue: "Teatar Odeon",
        startAt: "2099-01-01",
      },
      "odeon",
      "source-tickets",
    );
    ingest(
      {
        type: "Event",
        title: "Puppet show",
        venue: "MALO POZORIŠTE Pinokio",
        startAt: "2099-01-01",
      },
      "puppet",
      "source-tickets",
    );
    ingest(
      {
        type: "Event",
        title: "Independent show",
        venue: "Pozorište Slavija",
        startAt: "2099-01-01",
      },
      "independent",
    );
    ingest(
      {
        type: "Event",
        title: "ABBA TrIbUtE show",
        startAt: "2099-01-01",
      },
      "tribute",
    );
    ingest(
      {
        type: "Event",
        title: "Vaučer - future programme",
        startAt: "2099-01-01",
      },
      "voucher",
    );
    ingest(
      {
        type: "Event",
        title: "FEST 2026 - special screening",
        startAt: "2099-01-01",
      },
      "fest",
      "source-tickets",
    );
    ingest(
      {
        type: "Event",
        title: "FEST 2026 - another source",
        startAt: "2099-01-01",
      },
      "fest-other",
      "source-structured",
    );
    ingest(
      {
        type: "Event",
        title: "Family show",
        venue: "DEČJI kulturni centar",
        startAt: "2099-01-01",
      },
      "children",
      "source-structured",
    );
    ingest(
      {
        type: "Event",
        title: "Family workshop",
        tags: ["For kids", "Workshop"],
        startAt: "2099-01-01",
      },
      "for-kids",
      "source-structured",
    );
    expect(
      store
        .entities()
        .map((entity) => entity.title)
        .sort(),
    ).toEqual(["FEST 2026 - another source", "Independent show"]);
    expect(store.filterRulesView().counts).toMatchObject({
      total: 10,
      pastEvents: 1,
      ticketsVenue: 5,
      eventTitle: 2,
      eventLocation: 1,
      entityTags: 1,
    });
    const rules = store.filterRules();
    store.saveFilterRules({
      ...rules,
      pastEvents: { enabled: false },
      ticketsVenue: { ...rules.ticketsVenue, enabled: false },
      eventTitle: { ...rules.eventTitle, enabled: false },
      eventLocation: { ...rules.eventLocation, enabled: false },
      entityTags: { ...rules.entityTags, enabled: false },
    });
    expect(store.entities()).toHaveLength(12);
  });
  it("upgrades the previous single Tickets.rs venue rule", () => {
    store.db
      .prepare("UPDATE settings SET value=? WHERE key='filtering-rules'")
      .run(
        JSON.stringify({
          pastEvents: { enabled: false },
          telegramMinMembers: { enabled: true, minMembers: 500 },
          ticketsVenue: { enabled: true, venue: "KPGT" },
        }),
      );
    expect(store.filterRules()).toEqual({
      pastEvents: { enabled: false },
      telegramMinMembers: { enabled: true, minMembers: 500 },
      ticketsVenue: {
        enabled: true,
        venues: [
          "Pan Teatar",
          "Opera i teatar Madlenianum",
          "Teatar Odeon",
          "KPGT",
        ],
        keywords: ["pozorište"],
        titleKeywords: ["FEST 2026"],
      },
      eventTitle: { enabled: true, keywords: ["tribute", "Vaučer"] },
      eventLocation: { enabled: true, keywords: ["Dečji"] },
      entityTags: { enabled: true, keywords: ["#For kids"] },
    });
  });
  it("uses complete event signatures across timezones", () => {
    const e: EntityInput = {
      type: "Event",
      title: "Jazz",
      venue: "Club",
      startAt: "2099-10-01T20:00:00+02:00",
    };
    ingest(e, "1");
    ingest({ ...e, startAt: "2099-10-01T18:00:00Z" }, "2");
    expect(store.entities()).toHaveLength(1);
  });
  it("deduplicates the final event list when one source omits the venue", () => {
    const event: EntityInput = {
      type: "Event",
      title: "Belgrade Jazz Night",
      city: "Belgrade",
      venue: "Jazz Club",
      startAt: "2099-10-01T20:00:00+02:00",
    };
    ingest(event, "allevents-1", "source-allevents");
    ingest(
      { ...event, venue: "", description: "Same event from another feed" },
      "feed-2",
      "source-telegram",
    );
    expect(store.entities()).toHaveLength(1);
    expect(store.entities()[0].sources).toHaveLength(2);
  });
  it("aggressively collapses recurring events and keeps the earliest date", () => {
    ingest(
      {
        type: "Event",
        title: "Recurring show",
        venue: "Main Hall",
        startAt: "2099-05-03T20:00:00+02:00",
      },
      "later",
      "source-allevents",
    );
    ingest(
      {
        type: "Event",
        title: "Recurring show",
        venue: "Main Hall",
        startAt: "2099-05-01T19:00:00+02:00",
      },
      "earlier",
      "source-structured",
    );
    expect(store.entities()).toHaveLength(1);
    expect(store.entities()[0].startAt).toBe("2099-05-01T17:00:00.000Z");
    expect(store.entity(store.entities()[0].id).provenance).toHaveLength(2);

    ingest(
      {
        type: "Event",
        title: "Recurring show",
        venue: "Other Hall",
        startAt: "2099-05-04T19:00:00+02:00",
      },
      "other-production",
      "source-structured",
    );
    expect(store.entities()).toHaveLength(2);
  });
  it("collapses an event pair marked as a possible duplicate", () => {
    ingest(
      {
        type: "Event",
        title: "Candidate pair",
        venue: "First Hall",
        startAt: "2099-06-10T20:00:00+02:00",
      },
      "candidate-a",
      "source-allevents",
    );
    ingest(
      {
        type: "Event",
        title: "Candidate pair",
        venue: "Second Hall",
        startAt: "2099-06-12T18:00:00+02:00",
      },
      "candidate-b",
      "source-structured",
    );
    const [firstId, secondId] = store
      .entities()
      .map((entity) => entity.id)
      .sort();
    store.db
      .prepare("INSERT INTO duplicate_pairs VALUES (?,?,?,'new')")
      .run(firstId, secondId, "Possible duplicate");
    expect(
      store.entities().every((entity) => entity.duplicateCount === 1),
    ).toBe(true);

    expect(store.collapseEventDuplicates()).toBe(1);
    expect(store.entities()).toHaveLength(1);
    expect(store.entities()[0].startAt).toBe("2099-06-10T18:00:00.000Z");
    expect(store.entity(store.entities()[0].id).provenance).toHaveLength(2);
  });
  it("flags ambiguous names without destructive merge", () => {
    ingest({ type: "Community", title: "Photo club" }, "1");
    ingest({ type: "Community", title: "Photo club" }, "2");
    expect(store.entities()).toHaveLength(2);
    expect(store.entities().every((e) => e.duplicateCount === 1)).toBe(true);
  });
  it("does not equate guid 1 from unrelated RSS sources", () => {
    const a = store.saveSource({
      providerId: "structured",
      name: "A",
      url: "https://a.test/rss",
    });
    const b = store.saveSource({
      providerId: "structured",
      name: "B",
      url: "https://b.test/rss",
    });
    ingest({ type: "Event", title: "A" }, "1", a.id);
    ingest({ type: "Event", title: "B" }, "1", b.id);
    expect(store.entities()).toHaveLength(2);
  });
  it("preview rolls back entities, provenance and discovery", () => {
    const e = { ...place, website: "https://t.me/exampleclub" };
    const preview = importEntities(store, { entities: [e] }, true);
    expect(preview.result.created).toBe(1);
    expect(store.entities()).toHaveLength(0);
    expect(store.candidates()).toHaveLength(0);
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM source_items").get()?.n,
    ).toBe(0);
  });
  it("rejects an entire invalid batch before writing", () => {
    expect(() =>
      importEntities(store, {
        entities: [place, { type: "Bad", title: "bad" }],
      }),
    ).toThrow();
    expect(store.entities()).toHaveLength(0);
  });
  it("rolls back a partially processed provider batch", () => {
    expect(() =>
      store.ingest(
        store.source("source-manual"),
        [place, { ...place, title: "" }].map((entity, i) => ({
          entity,
          raw: { externalId: String(i), url: "", rawText: "", payload: entity },
        })),
      ),
    ).toThrow();
    expect(store.entities()).toHaveLength(0);
  });
  it("accepts fenced JSON with conservative defaults", () => {
    expect(
      importEntities(store, '```json\n[{"type":"Place","title":"A"}]\n```')
        .result.created,
    ).toBe(1);
    expect(store.entities()[0].country).toBe("RS");
  });
  it("discovers social source then accepts it disabled once", () => {
    ingest({ ...place, description: "Visit https://t.me/exampleclub" });
    const c = store.candidates()[0];
    expect(c.probableType).toBe("telegram");
    const source = store.candidateAction(c.id, "accept");
    expect(source?.enabled).toBe(false);
    expect(() => store.candidateAction(c.id, "accept")).toThrow();
  });
  it("routes discovered Facebook URLs to the working Apify provider", () => {
    ingest({
      ...place,
      description: "Visit https://www.facebook.com/events/123456",
    });
    expect(store.candidates()[0].probableType).toBe("facebook-apify");
  });
  it("merges provenance and relationships without losing edits", () => {
    ingest({ type: "Community", title: "A" }, "a");
    const a = store.entities()[0].id;
    ingest({ type: "Community", title: "B" }, "b");
    const b = store.entities().find((e) => e.title === "B")!.id;
    ingest({ type: "Event", title: "E" }, "e");
    const e = store.entities().find((e) => e.title === "E")!.id;
    store.relate(b, e, "organizes");
    store.setState(b, { notes: "From B", favorite: true });
    store.merge(a, b);
    expect(store.entities()).toHaveLength(2);
    const kept = store.entity(a);
    expect(kept.provenance).toHaveLength(2);
    expect(kept.related[0].id).toBe(e);
    expect(kept.notes).toBe("From B");
    expect(kept.favorite).toBe(true);
    ingest({ type: "Community", title: "B" }, "b");
    expect(store.entities()).toHaveLength(2);
  });
  it("keeps an event reaction when manually merging cards", () => {
    ingest({ type: "Event", title: "Keep" }, "event-keep");
    ingest({ type: "Event", title: "Remove" }, "event-remove");
    const keep = store.entities().find((entity) => entity.title === "Keep")!;
    const remove = store
      .entities()
      .find((entity) => entity.title === "Remove")!;
    store.setState(remove.id, { reaction: "dislike", favorite: true });

    store.merge(keep.id, remove.id);

    expect(store.entity(keep.id)).toMatchObject({
      reaction: "dislike",
      favorite: true,
    });
  });
  it("separates demo from real and does not reseed after removal", () => {
    seedDemo(store);
    expect(store.entities()).toHaveLength(3);
    store.deleteDemo();
    seedDemo(store);
    expect(store.entities()).toHaveLength(0);
  });
  it("rejects secrets in source URL and provider mutation", () => {
    expect(() =>
      store.saveSource({
        providerId: "structured",
        name: "secret",
        url: "https://example.test?token=secret",
      }),
    ).toThrow();
    expect(() =>
      store.saveSource(
        { providerId: "telegram", name: "changed" },
        "source-structured",
      ),
    ).toThrow();
  });
  it("merges existing Tickets.rs series in migration 009", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const event = (
      startAt: string,
      url: string,
      venue = "Museum",
    ): EntityInput => ({
      type: "Event",
      title: "Repeated museum entry",
      description: "Same exhibition",
      venue,
      startAt,
      url,
    });
    ingest(
      event("2026-10-03T15:00:00Z", "https://tickets.test/show-2"),
      "show-2",
    );
    ingest(
      event(
        "2026-10-02T10:00:00Z",
        "https://tickets.test/show-1",
        "Temporary Museum",
      ),
      "show-1",
    );
    const earlier = store
      .entities()
      .find((entity) => entity.url.endsWith("show-1"))!;
    store.db
      .prepare(
        "UPDATE entities SET data=json_set(data,'$.venue','Museum') WHERE id=?",
      )
      .run(earlier.id);
    const later = store
      .entities()
      .find((entity) => entity.url.endsWith("show-2"))!;
    store.setState(later.id, { favorite: true, notes: "Keep this note" });
    store.db
      .prepare(
        "UPDATE source_items SET sourceId='source-tickets' WHERE sourceId='source-manual'",
      )
      .run();
    store.db
      .prepare(
        "UPDATE source_item_heads SET sourceId='source-tickets' WHERE sourceId='source-manual'",
      )
      .run();
    store.db
      .prepare("DELETE FROM migrations WHERE name=?")
      .run("009_merge_tickets_series.sql");

    store.migrate();

    expect(store.entities()).toHaveLength(1);
    const kept = store.entity(store.entities()[0].id);
    expect(kept.startAt).toBe("2026-10-02T10:00:00.000Z");
    expect(kept.provenance).toHaveLength(2);
    expect(kept.favorite).toBe(true);
    expect(kept.notes).toBe("Keep this note");
  });
  it("purges excluded Afisha.rs sections and pins the source to /ru", () => {
    ingest(
      {
        type: "Event",
        title: "Children programme",
        tags: ["Дети"],
        rawCategory: "Дети",
        startAt: "2099-10-10",
        url: "https://afisha.rs/ru/deti/children-programme",
      },
      "afisha-children",
      "source-afisha",
    );
    ingest(
      {
        type: "Event",
        title: "Concert programme",
        tags: ["Концерты"],
        rawCategory: "Концерты",
        startAt: "2099-10-11",
        url: "https://afisha.rs/ru/koncerty/concert-programme",
      },
      "afisha-concert",
      "source-afisha",
    );
    store.db
      .prepare("UPDATE sources SET url='https://afisha.rs/' WHERE id=?")
      .run("source-afisha");
    store.db
      .prepare("DELETE FROM migrations WHERE name=?")
      .run("014_afisha_ru_sections.sql");

    store.migrate();

    expect(store.source("source-afisha").url).toBe("https://afisha.rs/ru");
    expect(store.entities().map((entity) => entity.title)).toContain(
      "Concert programme",
    );
    expect(store.entities().map((entity) => entity.title)).not.toContain(
      "Children programme",
    );
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_items WHERE sourceId='source-afisha' AND sourceUrl LIKE '%/ru/deti/%'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
  });
  it("removes provenance from the former Afisha.rs homepage reader", () => {
    ingest(
      {
        type: "Event",
        title: "Legacy homepage event",
        startAt: "2099-10-12",
        url: "https://afisha.rs/ru/koncerty/legacy-homepage-event",
      },
      "legacy-homepage",
      "source-afisha",
    );
    store.db
      .prepare(
        "UPDATE source_items SET rawPayload=? WHERE sourceId='source-afisha' AND externalId='legacy-homepage'",
      )
      .run(
        JSON.stringify({
          original: { "@type": "Event", name: "Legacy homepage event" },
          normalized: { rawCategory: "Event" },
        }),
      );
    store.db
      .prepare("DELETE FROM migrations WHERE name=?")
      .run("015_afisha_homepage_cleanup.sql");

    store.migrate();

    expect(store.entities().map((entity) => entity.title)).not.toContain(
      "Legacy homepage event",
    );
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_items WHERE sourceId='source-afisha' AND externalId='legacy-homepage'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
  });
});
it("does not oscillate between unchanged provider records for one canonical place", () => {
  ingest(place, "node/1");
  ingest({ ...place, description: "Way data" }, "way/2");
  expect(ingest(place, "node/1").duplicates).toBe(1);
  expect(
    ingest({ ...place, description: "Way data" }, "way/2").duplicates,
  ).toBe(1);
  expect(store.entities()).toHaveLength(1);
});
it("applies a provider reverting to a previously seen raw version", () => {
  ingest(place);
  ingest({ ...place, description: "Second" });
  ingest(place);
  expect(store.entities()[0].description).toBe("Original");
  expect(store.entity(store.entities()[0].id).provenance).toHaveLength(2);
});
it("separates identical external IDs across countries", () => {
  ingest(place);
  ingest({ ...place, country: "DE" });
  expect(store.entities()).toHaveLength(2);
});
it("reprocesses identical raw data when adapter normalization changes", () => {
  const raw = {
    externalId: "fixed",
    url: "",
    rawText: "",
    payload: { name: "Gym" },
  };
  const source = store.source("source-manual");
  store.ingest(source, [
    { raw, entity: { type: "Place", title: "Gym", category: "Другое" } },
  ]);
  expect(
    store.ingest(source, [
      { raw, entity: { type: "Place", title: "Gym", category: "Спорт" } },
    ]).updated,
  ).toBe(1);
  expect(store.entities()[0].category).toBe("Спорт");
  expect(store.entity(store.entities()[0].id).provenance).toHaveLength(1);
});
