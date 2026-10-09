import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { importEntities } from "../server/import.js";
import { AiDigests } from "../server/ai-digests.js";
import { DigestWeekly, digestPeriod } from "../server/digest-weekly.js";
import type { AiDigestInput } from "../shared/ai-digests.js";

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
const monday = new Date("2099-10-05T08:00:00Z"), tuesday = new Date("2099-10-06T08:00:00Z");
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  importEntities(store, { entities: [{ type: "Event", title: "Fixture event", startAt: "2099-10-08T19:00:00+02:00", venue: "Fixture venue", price: "500 RSD", url: "https://example.org/event", description: "Programme: discussion and practical workshop" }] });
  const event = store.entities().find(e => e.title === "Fixture event")!;
  store.db.prepare("UPDATE entities SET createdAt=? WHERE id=?").run("2099-10-05T07:00:00Z", event.id);
  let telegram: Array<typeof event & { publishedAt: string; fullText: string }> = [];
  const weekly = new DigestWeekly(store, () => telegram), save = (d: AiDigestInput) => new AiDigests(store).create(d, monday);
  return { store, event: store.entitySummary(event.id), weekly, save, setTelegram: (data: typeof telegram) => { telegram = data; } };
}
function input(f: ReturnType<typeof fixture>, runId: string, now = monday, id = f.event.id, kind: "event" | "telegram" = "event", updateReason = "") {
  const p = digestPeriod(now, "Europe/Belgrade");
  return { runId, scopeId: "belgrade", references: [{ kind, id, updateReason, expectedUpdatedAt: kind === "event" ? f.store.entitySummary(id).updatedAt : f.event.updatedAt }], data: { id: runId, scopeId: "belgrade", title: "New events", requestSummary: "Daily discoveries", startDate: p.startDate, endDate: p.endDate,
    items: [{ title: "Fixture event", description: "Why it fits", startAt: f.event.startAt, aiScore: 9, sourceName: "Fixture", sourceUrl: "https://example.org/event" }] } };
}
describe("weekly event digest history", () => {
  it("records a new announcement once, idempotently, with its saved digest", () => {
    const f = fixture(), id = randomUUID(); f.weekly.begin({ runId: id }, monday);
    expect(f.weekly.candidates({ runId: id }).total).toBe(1);
    const args = input(f, id), result = f.weekly.prepare(args, f.save);
    expect(result.approvedCount).toBe(1); expect(f.weekly.prepare(args, f.save)).toEqual(result);
    expect(f.store.db.prepare("SELECT state FROM digest_weekly_history WHERE recordKind='publication'").get()).toMatchObject({ state: "prepared" });
    f.weekly.reconcile(id, "delivered", "native-run");
    expect(f.store.db.prepare("SELECT state FROM digest_weekly_history WHERE recordKind='publication'").get()).toMatchObject({ state: "delivered" });
  });
  it("suppresses a repost in another source on Tuesday even with different text and score", () => {
    const f = fixture(), first = randomUUID(); f.weekly.begin({ runId: first }, monday); f.weekly.candidates({ runId: first }); f.weekly.prepare(input(f, first), f.save);
    const second = randomUUID(); f.weekly.begin({ runId: second }, tuesday);
    f.setTelegram([{ ...f.event, id: "new-post", title: "FIXTURE EVENT", publishedAt: "2099-10-06T07:00:00Z", fullText: "Same event, new wording", createdAt: "2099-10-06T07:00:00Z" }]);
    const args = input(f, second, tuesday, "new-post", "telegram"); args.data.items[0].description = "Completely rewritten recommendation"; args.data.items[0].aiScore = 10;
    const result = f.weekly.prepare(args, f.save);
    expect(result.approvedCount).toBe(0); expect(result.suppressed[0].reason).toBe("already_reported_this_week");
  });
  it("admits a material price change only with an explicit explanation", () => {
    const f = fixture(), first = randomUUID(); f.weekly.begin({ runId: first }, monday); f.weekly.candidates({ runId: first }); f.weekly.prepare(input(f, first), f.save);
    const next = randomUUID(); f.weekly.begin({ runId: next }, tuesday);
    const data = JSON.parse((f.store.db.prepare("SELECT data FROM entities WHERE id=?").get(f.event.id) as { data: string }).data); data.price = "600 RSD";
    f.store.db.prepare("UPDATE entities SET data=?,updatedAt=? WHERE id=?").run(JSON.stringify(data), tuesday.toISOString(), f.event.id);
    expect(f.weekly.candidates({ runId: next }).candidates[0].factChanges).toContain("price");
    const result = f.weekly.prepare(input(f, next, tuesday, f.event.id, "event", "Цена изменилась с 500 на 600 RSD"), f.save);
    expect(result.approvedCount).toBe(1);
  });
  it("allows a verified new programme detail but not mere rewritten source text", () => {
    const f = fixture(), first = randomUUID(); f.weekly.begin({ runId: first }, monday); f.weekly.candidates({ runId: first }); f.weekly.prepare(input(f, first), f.save);
    const next = randomUUID(); f.weekly.begin({ runId: next }, tuesday);
    const data = JSON.parse((f.store.db.prepare("SELECT data FROM entities WHERE id=?").get(f.event.id) as { data: string }).data); data.description += " with new speaker Alex";
    f.store.db.prepare("UPDATE entities SET data=? WHERE id=?").run(JSON.stringify(data), f.event.id);
    expect(f.weekly.candidates({ runId: next }).candidates[0].freshness).toBe("changed_source_text");
    const args = input(f, next, tuesday, f.event.id, "event", "Добавлен новый спикер Alex");
    const result = f.weekly.prepare({ ...args, references: [{ ...args.references[0], detailQuotes: { programme: "new speaker Alex" } }] }, f.save);
    expect(result.approvedCount).toBe(1);
  });
  it("keeps simultaneous events at different venues separate", () => {
    const f = fixture(), id = randomUUID(); f.weekly.begin({ runId: id }, monday);
    f.setTelegram(["Venue A", "Venue B"].map((venue, i) => ({ ...f.event, id: "post" + i, venue, publishedAt: "2099-10-05T07:00:00Z", fullText: "Fixture programme" })));
    const args = input(f, id, monday, "post0", "telegram");
    const result = f.weekly.prepare({ ...args, data: { ...args.data, items: [args.data.items[0], { ...args.data.items[0] }] }, references: [args.references[0], { ...args.references[0], id: "post1" }] }, f.save);
    expect(result.approvedCount).toBe(2);
  });
  it("does not treat ordinary sync timestamps, recommendation wording or AI score as novelty", () => {
    const f = fixture(), first = randomUUID(); f.weekly.begin({ runId: first }, monday); f.weekly.candidates({ runId: first });
    const next = randomUUID(); f.weekly.begin({ runId: next }, tuesday);
    f.store.db.prepare("UPDATE entities SET updatedAt=? WHERE id=?").run(tuesday.toISOString(), f.event.id);
    expect(f.weekly.candidates({ runId: next }).total).toBe(0);
  });
  it("rejects invented detail quotations and stale event times", () => {
    const f = fixture(), id = randomUUID(); f.weekly.begin({ runId: id }, monday);
    const args = input(f, id);
    expect(() => f.weekly.prepare({ ...args, references: [{ ...args.references[0], detailQuotes: { programme: "Invented extra speaker" } }] }, f.save)).toThrow("DIGEST_DETAIL_NOT_VERIFIED");
    args.data.items[0].startAt = "2099-10-08T21:00:00+02:00";
    expect(() => f.weekly.prepare(args, f.save)).toThrow("DIGEST_EVENT_CHANGED");
    expect(f.store.db.prepare("SELECT count(*) AS n FROM digest_weekly_history WHERE recordKind='publication'").get()).toMatchObject({ n: 0 });
  });
  it("rotates older weeks in the ledger while preserving full saved digests", () => {
    const f = fixture(), id = randomUUID(); f.weekly.begin({ runId: id }, monday); f.weekly.prepare(input(f, id), f.save);
    f.weekly.begin({ runId: randomUUID() }, new Date("2099-10-19T08:00:00Z"));
    expect(f.store.db.prepare("SELECT count(*) AS n FROM digest_weekly_history WHERE weekStart='2099-10-05'").get()).toMatchObject({ n: 0 });
    expect(new AiDigests(f.store).get(id)).not.toBeNull();
  });
  it("resets publication dedup on Monday and covers DST with a rolling 24h window", () => {
    const a = digestPeriod(new Date("2026-10-25T08:00:00Z"), "Europe/Belgrade");
    expect(Date.parse(a.windowEnd) - Date.parse(a.windowStart)).toBe(86400000);
    expect(a.weekStart).toBe("2026-10-19");
    expect(a.endDate).toBe("2026-11-01");
    expect(digestPeriod(new Date("2026-10-26T08:00:00Z"), "Europe/Belgrade").weekStart).toBe("2026-10-26");
  });
});
