import { afterEach, expect, it } from "vitest";
import { Store } from "../server/store.js";
import {
  moldovaProviders,
  moldovaItem,
} from "../server/providers/websites/moldova.js";
let store: Store | undefined;
afterEach(() => store?.close());
it("seeds independent Chisinau sources without moving or enabling Serbia sources", () => {
  store = new Store(":memory:");
  expect(store.source("source-allevents")).toMatchObject({
    scopeId: "belgrade",
    url: "https://allevents.in/belgrade/all",
  });
  expect(store.source("source-allevents-chisinau")).toMatchObject({
    scopeId: "chisinau",
    url: "https://allevents.in/chisinau/all",
    enabled: true,
  });
  for (const p of moldovaProviders) {
    const source = store.source("source-" + p.id);
    expect(source).toMatchObject({ scopeId: "chisinau", enabled: true });
    expect(
      p.connectionStatus({
        source,
        scope: store.scope("belgrade"),
        secrets: {},
      }).canSync,
    ).toBe(false);
  }
});
it("uses Chisinau time across the DST transition and retains unknown event language", () => {
  store = new Store(":memory:");
  const ctx = {
    source: store.source("source-fest-md"),
    scope: store.scope("chisinau"),
    secrets: {},
  };
  const e = {
    id: "one",
    url: "https://www.fest.md/ru/events/concerts/one",
    title: "Concert",
    description: "",
    start: "2026-11-14T20:00:00",
    end: "",
    venue: "Hall",
    address: "",
    city: "Chisinau",
    country: "MD",
    price: "",
    image: "",
    category: "concerts",
  };
  expect(
    (moldovaItem("fest-md", e, ctx).payload as any).normalized,
  ).toMatchObject({
    startAt: "2026-11-14T18:00:00.000Z",
    country: "MD",
    city: "Chisinau",
    languages: [],
  });
  expect(
    (
      moldovaItem("fest-md", { ...e, start: "2026-10-17T19:00:00" }, ctx)
        .payload as any
    ).normalized.startAt,
  ).toBe("2026-10-17T16:00:00.000Z");
});

it("retains independent iTicket performances through Store ingestion, reimport and duplicate collapse", () => {
  store = new Store(":memory:");
  const source = store.source("source-iticket-md");
  const ctx = { source, scope: store.scope("chisinau"), secrets: {} };
  const records = ["2026-12-18T19:00:00", "2026-12-19T19:00:00"].map(start => {
    const raw = moldovaItem("iticket-md", { id: `concert@${start}`, url: "https://iticket.md/ru/event/concert", title: "Concert", description: "", start, end: "", city: "Chisinau", country: "MD", venue: "Same venue", address: "", price: "", image: "", category: "concerts" }, ctx);
    return { raw, entity: (raw.payload as any).normalized };
  });
  store.ingest(source, records);
  store.ingest(source, records);
  store.collapseEventDuplicates();
  const events = store.entities({ includeFiltered: true }).filter(e => e.title === "Concert");
  expect(events).toHaveLength(2);
  expect(new Set(events.map(e => e.startAt)).size).toBe(2);
});
