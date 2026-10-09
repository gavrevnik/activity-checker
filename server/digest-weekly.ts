import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { localDay } from "../shared/dates.js";
import { aiDigestInputSchema, type AiDigestInput } from "../shared/ai-digests.js";

const scope = z.object({ scopeId: z.string().default("belgrade"), runId: z.uuid() }).strict();
export const digestWeeklyRunSchema = scope;
export const digestWeeklyCandidatesSchema = scope.extend({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) });
export const digestWeeklyPrepareSchema = scope.extend({
  data: aiDigestInputSchema,
  references: z.array(z.object({ kind: z.enum(["event", "telegram"]), id: z.string().min(1).max(200), expectedUpdatedAt: z.string().min(1).max(100),
    previousEventKey: z.string().min(1).max(250).optional(),
    updateReason: z.string().trim().max(1000).default(""),
    detailQuotes: z.object({ programme: z.string().trim().min(5).max(1000).optional(),
      booking: z.string().trim().min(5).max(1000).optional(), availability: z.string().trim().min(5).max(1000).optional(),
      price: z.string().trim().min(5).max(1000).optional() }).strict().default({}) }).strict()).max(20),
});
type Facts = Record<string, string | string[]>;
type Event = { id: string; title: string; startAt: string; endAt?: string; venue?: string; address?: string;
  price?: string; languages?: string[]; url?: string; description?: string; fullText?: string; publishedAt?: string;
  createdAt: string; updatedAt: string; country?: string; city?: string; archived?: boolean; filtered?: boolean;
  skipped?: boolean; reaction?: string; type?: string; communityId?: string; sources?: Array<{ providerId: string }>; demo?: boolean };
type Row = { runId: string; scopeId: string; weekStart: string; recordKind: string; eventKey: string;
  aliases: string; facts: string; payload: string; state: string; windowStart: string; windowEnd: string;
  createdAt: string; deliveredAt: string | null; nativeRunId: string | null };
const normalized = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const shift = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(d + "T12:00:00Z").getUTCDay();
export function digestPeriod(now: Date, timezone: string) {
  const today = localDay(now, timezone), weekStart = shift(today, -((weekday(today) + 6) % 7));
  let endDate = shift(today, 6);
  if (weekday(endDate) === 6) endDate = shift(endDate, 1); // Include the whole weekend when the seven-day range ends Saturday.
  return { today, weekStart, startDate: today, endDate, windowStart: new Date(now.valueOf() - 86400000).toISOString(), windowEnd: now.toISOString() };
}
const dateFact = (value: string) => value.length === 10 ? value : new Date(value).toISOString();
function eventFacts(e: Event): Facts {
  return { startAt: dateFact(e.startAt), endAt: e.endAt ? dateFact(e.endAt) : "", venue: normalized(e.venue || ""),
    address: normalized(e.address || ""), price: normalized(e.price || ""), languages: [...(e.languages || [])].map(normalized).sort() };
}
function aliases(kind: string, e: Event) {
  return [`${kind}:${e.id}`, "occurrence:" + hash([normalized(e.title), dateFact(e.startAt), normalized(e.venue || ""), normalized(e.address || "")]), "programme:" + hash(normalized(e.title))];
}
const changed = (old: Facts, next: Facts) => Object.keys(next).filter(key => {
  const value = next[key];
  return (Array.isArray(value) ? value.length > 0 : value !== "") && JSON.stringify(value) !== JSON.stringify(old[key]);
});

export class DigestWeekly {
  constructor(private store: Store, private telegram: () => Event[] = () => []) {}
  private insert(run: Row, kind: string, key: string, identity: string[], facts: Facts, payload: unknown, state = "observed") {
    this.store.db.prepare(`INSERT INTO digest_weekly_history
      (runId,scopeId,weekStart,recordKind,eventKey,aliases,facts,payload,state,windowStart,windowEnd,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(runId,recordKind,eventKey) DO UPDATE SET
      aliases=excluded.aliases,facts=excluded.facts,payload=excluded.payload,state=excluded.state`)
      .run(run.runId, run.scopeId, run.weekStart, kind, key, JSON.stringify(identity), JSON.stringify(facts), JSON.stringify(payload), state, run.windowStart, run.windowEnd, run.createdAt);
  }
  private run(scopeId: string, runId: string) {
    const row = this.store.db.prepare("SELECT * FROM digest_weekly_history WHERE scopeId=? AND runId=? AND recordKind='run'").get(scopeId, runId) as Row | undefined;
    if (!row) throw new Error("DIGEST_RUN_NOT_FOUND");
    return row;
  }
  private events(scopeId: string, from: string, to: string): Array<{ kind: "event" | "telegram"; event: Event }> {
    const s = this.store.scope(scopeId);
    const valid = (e: Event) => e.startAt && !e.demo && !e.archived && !e.filtered && !e.skipped && e.reaction !== "dislike" &&
      e.country === s.country && (!s.city || e.city === s.city) && localDay(e.startAt, s.timezone) <= to && localDay(e.endAt || e.startAt, s.timezone) >= from;
    return [...this.store.entities().filter(e => e.type === "Event" && valid(e)).map(event => ({ kind: "event" as const, event })),
      ...this.telegram().filter(valid).map(event => ({ kind: "telegram" as const, event }))];
  }
  begin(input: z.input<typeof scope>, now = new Date()) {
    const a = scope.parse(input), s = this.store.scope(a.scopeId), p = digestPeriod(now, s.timezone);
    return this.store.transaction(() => {
      const previous = this.store.db.prepare("SELECT * FROM digest_weekly_history WHERE scopeId=? AND runId=? AND recordKind='run'").get(a.scopeId, a.runId) as Row | undefined;
      if (previous) return { runId: a.runId, ...JSON.parse(previous.payload).period };
      // Rotation touches only this short-lived ledger. ai_digests and source data remain intact.
      this.store.db.prepare("DELETE FROM digest_weekly_history WHERE weekStart<?").run(shift(p.weekStart, -7));
      const run = { runId: a.runId, scopeId: a.scopeId, weekStart: p.weekStart, windowStart: p.windowStart, windowEnd: p.windowEnd, createdAt: p.windowEnd } as Row;
      const baseline = this.events(a.scopeId, p.startDate, p.endDate).map(({ kind, event }) => ({ kind, id: event.id, facts: eventFacts(event), sourceTextHash: hash(normalized(event.fullText || event.description || "")) }));
      this.insert(run, "run", "", [], {}, { period: p, baseline });
      return { runId: a.runId, ...p };
    });
  }
  private assess(run: Row, kind: string, event: Event) {
    const meta = JSON.parse(run.payload), current = eventFacts(event), key = `${kind}:${event.id}`;
    const prior = this.store.db.prepare(`SELECT * FROM digest_weekly_history WHERE scopeId=? AND recordKind='observation'
      AND eventKey=? AND runId<>? ORDER BY createdAt DESC LIMIT 1`).get(run.scopeId, key, run.runId) as Row | undefined;
    const baseline = meta.baseline.find((e: { kind: string; id: string }) => e.kind === kind && e.id === event.id);
    const inWindow = (v?: string) => !!v && Date.parse(v) > Date.parse(run.windowStart) && Date.parse(v) <= Date.parse(run.windowEnd);
    const sourceTextHash = hash(normalized(event.fullText || event.description || ""));
    const oldTextHash = prior ? JSON.parse(prior.payload).sourceTextHash : baseline?.sourceTextHash;
    const textChanged = !!oldTextHash && oldTextHash !== sourceTextHash;
    const factChanges = prior ? changed(JSON.parse(prior.facts), current) : baseline ? changed(baseline.facts, current) : [];
    // fetchedAt and updatedAt are not publication dates; ordinary sync/score refreshes cannot make a card new.
    const freshness = kind === "telegram" ? inWindow(event.publishedAt) ? "new_telegram_post" : factChanges.length ? "changed_event_facts" : textChanged ? "changed_source_text" : "old_announcement" :
      factChanges.length ? "changed_event_facts" : textChanged ? "changed_source_text" : inWindow(event.createdAt) || (!baseline && Date.parse(event.createdAt) >= Date.parse(run.windowEnd)) ? event.sources?.some(s => ["tickets","bilet","afisha","belgrade-beat","serbia-travel","allevents"].includes(s.providerId)) ? "first_api_discovery" : "first_web_discovery" : "old_announcement";
    return { kind, id: event.id, event, aliases: aliases(kind, event), facts: current, sourceTextHash, freshness, factChanges, eligible: freshness !== "old_announcement" };
  }
  candidates(input: z.input<typeof digestWeeklyCandidatesSchema>) {
    const a = digestWeeklyCandidatesSchema.parse(input), run = this.run(a.scopeId, a.runId), p = JSON.parse(run.payload).period;
    const rows = this.events(a.scopeId, p.startDate, p.endDate).map(({ kind, event }) => this.assess(run, kind, event));
    this.store.transaction(() => {
      for (const row of rows) this.insert(run, "observation", `${row.kind}:${row.id}`, row.aliases, row.facts, { publishedAt: row.event.publishedAt || null, sourceTextHash: row.sourceTextHash });
    });
    const fresh = rows.filter(row => row.eligible);
    const history = this.store.db.prepare(`SELECT eventKey,aliases,facts,payload,state,createdAt,deliveredAt FROM digest_weekly_history
      WHERE scopeId=? AND weekStart=? AND recordKind='publication' ORDER BY createdAt DESC`).all(a.scopeId, run.weekStart);
    return { period: p, total: fresh.length, offset: a.offset, nextOffset: a.offset + a.limit < fresh.length ? a.offset + a.limit : null,
      candidates: fresh.slice(a.offset, a.offset + a.limit), alreadyReportedThisWeek: history };
  }
  prepare(input: z.input<typeof digestWeeklyPrepareSchema>, save: (data: AiDigestInput) => unknown) {
    const a = digestWeeklyPrepareSchema.parse(input), run = this.run(a.scopeId, a.runId), meta = JSON.parse(run.payload), p = meta.period;
    if (a.data.id !== a.runId || a.data.scopeId !== a.scopeId || a.data.startDate !== p.startDate || a.data.endDate !== p.endDate || a.data.items.length !== a.references.length) throw new Error("DIGEST_PERIOD_MISMATCH");
    const requestHash = hash(a);
    if (meta.prepared) {
      if (meta.requestHash !== requestHash) throw new Error("DIGEST_PAYLOAD_CHANGED");
      return meta.result;
    }
    return this.store.transaction(() => {
      const current = this.events(a.scopeId, p.startDate, p.endDate), approved: AiDigestInput["items"] = [], suppressed: Array<{ id: string; reason: string }> = [], included: string[][] = [];
      const history = this.store.db.prepare(`SELECT * FROM digest_weekly_history WHERE scopeId=? AND weekStart=?
        AND recordKind='publication' AND runId<>? ORDER BY createdAt DESC`).all(a.scopeId, run.weekStart, a.runId) as Row[];
      for (let i = 0; i < a.references.length; i++) {
        const ref = a.references[i], found = current.find(e => e.kind === ref.kind && e.event.id === ref.id);
        if (!found) throw new Error("DIGEST_EVENT_INACTIVE");
        if (ref.expectedUpdatedAt !== found.event.updatedAt) throw new Error("DIGEST_EVENT_CHANGED");
        const row = this.assess(run, found.kind, found.event), item = a.data.items[i];
        if (dateFact(item.startAt) !== dateFact(found.event.startAt) || (item.endAt && dateFact(item.endAt) !== dateFact(found.event.endAt || found.event.startAt))) throw new Error("DIGEST_EVENT_CHANGED");
        if (!row.eligible) { suppressed.push({ id: ref.id, reason: "outside_daily_window" }); continue; }
        if (included.some(list => list.some(key => !key.startsWith("programme:") && row.aliases.includes(key)))) { suppressed.push({ id: ref.id, reason: "duplicate_in_issue" }); continue; }
        const previous = ref.previousEventKey ? history.find(h => h.eventKey === ref.previousEventKey && (JSON.parse(h.aliases) as string[]).some(key => key.startsWith("programme:") && row.aliases.includes(key))) :
          history.find(h => (JSON.parse(h.aliases) as string[]).some(key => !key.startsWith("programme:") && row.aliases.includes(key)));
        if (ref.previousEventKey && !previous) throw new Error("DIGEST_PREVIOUS_EVENT_MISMATCH");
        const facts = { ...row.facts };
        if (previous) {
          const old = JSON.parse(previous.facts) as Facts;
          for (const key of ["programme", "booking", "availability", "detailPrice"]) if (old[key]) facts[key] = old[key];
        }
        const sourceText = normalized(found.event.fullText || found.event.description || "");
        for (const [name, quote] of Object.entries(ref.detailQuotes)) {
          if (!sourceText.includes(normalized(quote))) throw new Error("DIGEST_DETAIL_NOT_VERIFIED");
          facts[name === "price" ? "detailPrice" : name] = normalized(quote);
        }
        const newDetails = previous ? changed(JSON.parse(previous.facts), facts) : [];
        if (previous && (!newDetails.length || !ref.updateReason)) { suppressed.push({ id: ref.id, reason: "already_reported_this_week" }); continue; }
        approved.push(item); included.push(row.aliases);
        this.insert(run, "publication", row.aliases[0], row.aliases, facts, { item, updateReason: previous ? ref.updateReason : "", changedFields: newDetails }, "prepared");
      }
      const data = { ...a.data, items: approved }, savedDigest = save(data);
      const result = { runId: a.runId, data, savedDigest, approvedCount: approved.length, suppressed };
      this.insert(run, "run", "", [], {}, { ...meta, prepared: true, requestHash, result }, "prepared");
      return result;
    });
  }
  reconcile(runId: string, state: "delivered" | "unknown", nativeRunId: string) {
    // Called only by the fixed internal transport, never registered as a model tool.
    const result = this.store.db.prepare(`UPDATE digest_weekly_history SET state=?,deliveredAt=CASE WHEN ?='delivered' THEN ? ELSE NULL END,
      nativeRunId=? WHERE runId=? AND recordKind IN ('run','publication') AND state IN ('prepared','unknown')`)
      .run(state, state, new Date().toISOString(), nativeRunId, runId);
    return { updated: Number(result.changes) };
  }
}
