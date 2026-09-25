import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import ical from "node-ical";
import { createHash } from "node:crypto";
import {
  entitySchema,
  importSchema,
  type EntityInput,
  type ProviderInfo,
} from "../../shared/model.js";
import { defineProvider, type ProviderContext, type RawItem } from "./types.js";
import { fetchText } from "./http.js";
const array = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const plain = (v: any): string =>
  typeof v === "string"
    ? load(v).text().trim()
    : typeof v === "number"
      ? String(v)
      : v?.["#text"]
        ? String(v["#text"])
        : "";
const absolute = (v: any, base: string) => {
  try {
    const u = new URL(typeof v === "string" ? v : v?.url || "", base);
    return /^https?:$/.test(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
};
const validDate = (v: any) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}(T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(v) &&
  !Number.isNaN(Date.parse(v))
    ? v
    : "";
export function parseStructured(
  body: string,
  ctx: ProviderContext,
): { items: RawItem[]; warnings: string[] } {
  const format = ctx.source.format,
    url = ctx.source.url;
  const items: RawItem[] = [];
  const warnings: string[] = [];
  function add(payload: any, normalized: EntityInput, externalId?: string) {
    const parsed = entitySchema.parse(normalized);
    const published =
      payload.datePublished ||
      payload.pubDate ||
      payload.published ||
      payload.created;
    const publishedDate = published
      ? new Date(
          typeof published === "string" || published instanceof Date
            ? published
            : "",
        )
      : null;
    items.push({
      externalId:
        externalId ||
        parsed.externalId ||
        createHash("sha256")
          .update(
            [parsed.type, parsed.url, parsed.title, parsed.startAt].join("|"),
          )
          .digest("hex"),
      url: parsed.url || "",
      rawText: parsed.description,
      publishedAt:
        publishedDate && !Number.isNaN(publishedDate.valueOf())
          ? publishedDate.toISOString()
          : undefined,
      payload: { original: payload, normalized: parsed },
    });
  }
  if (
    format === "ics" ||
    (format === "auto" && body.trim().startsWith("BEGIN:VCALENDAR"))
  ) {
    const entries = ical.sync.parseICS(body);
    for (const r of Object.values(entries)) {
      if (r.type !== "VEVENT") continue;
      if (r.rrule || r.recurrenceid) {
        warnings.push(
          "Повторяющиеся ICS-события пропущены: разворачивание повторов пока не поддерживается.",
        );
        continue;
      }
      const start = r.start;
      if (!start) continue;
      const isDate = r.datetype === "date";
      const startAt = isDate
        ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`
        : start.toISOString();
      add(
        r,
        {
          type: "Event",
          title: plain(r.summary) || "Без названия",
          description: plain(r.description),
          startAt,
          endAt: r.end?.toISOString() || "",
          venue: plain(r.location),
          url: r.url ? absolute(r.url, url) : "",
          country: ctx.scope.country,
          city: ctx.scope.city || "",
          languages: ctx.source.language ? [ctx.source.language] : [],
        },
        r.uid,
      );
    }
  } else if (
    format === "rss" ||
    (format === "auto" && /^\s*<(?:\?xml|rss|feed)/.test(body))
  ) {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      processEntities: false,
    });
    const doc = parser.parse(body);
    for (const r of array(doc.rss?.channel?.item || doc.feed?.entry)) {
      const link =
        typeof r.link === "string"
          ? r.link
          : array(r.link).find(
              (l: any) => !l["@_rel"] || l["@_rel"] === "alternate",
            )?.["@_href"];
      add(
        r,
        {
          type: "Event",
          title: plain(r.title),
          description: plain(
            r.description || r.summary || r.content || r["content:encoded"],
          ),
          url: link ? absolute(link, url) : "",
          country: ctx.scope.country,
          city: ctx.scope.city || "",
          startAt: validDate(r["ev:startdate"] || r["event:start"]),
          languages: ctx.source.language ? [ctx.source.language] : [],
        },
        plain(r.guid || r.id) || undefined,
      );
    }
    if (items.some((i) => !(i.payload as any).normalized.startAt))
      warnings.push(
        "У части RSS-записей нет даты события. Дата публикации не подставляется вместо неё.",
      );
  } else {
    const blocks: any[] = [];
    if (
      format === "json" ||
      body.trim().startsWith("{") ||
      body.trim().startsWith("[")
    ) {
      const parsed = JSON.parse(body);
      if (parsed.entities || (Array.isArray(parsed) && parsed[0]?.type)) {
        const batch = importSchema.parse(
          Array.isArray(parsed) ? { entities: parsed } : parsed,
        );
        for (const n of batch.entities) add(n, n);
        return { items, warnings };
      }
      blocks.push(parsed);
    } else {
      const $ = load(body);
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          blocks.push(JSON.parse($(el).text()));
        } catch {
          warnings.push("Один блок JSON-LD содержит невалидный JSON.");
        }
      });
    }
    function visit(n: any) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        n.forEach(visit);
        return;
      }
      const types = array(n["@type"]);
      if (
        types.some(
          (t) => typeof t === "string" && /(?:^|\/)\w*Event$/.test(t),
        ) &&
        n.name
      ) {
        const loc = n.location || {},
          addr = loc.address || {},
          offer = array(n.offers)[0] || {};
        const image = array(n.image)[0];
        add(
          n,
          {
            type: "Event",
            title: plain(n.name),
            description: plain(n.description),
            startAt: validDate(n.startDate),
            endAt: validDate(n.endDate),
            venue: typeof loc === "string" ? loc : plain(loc.name),
            address:
              typeof addr === "string"
                ? addr
                : [addr.streetAddress, addr.postalCode]
                    .filter(Boolean)
                    .join(", "),
            city: addr.addressLocality || ctx.scope.city || "",
            country:
              typeof addr.addressCountry === "string" &&
              addr.addressCountry.length === 2
                ? addr.addressCountry
                : ctx.scope.country,
            url: n.url
              ? absolute(n.url, url)
              : typeof n["@id"] === "string" && /^https?:/.test(n["@id"])
                ? n["@id"]
                : "",
            imageUrl: image ? absolute(image, url) : "",
            price:
              offer.price != null
                ? `${offer.price} ${offer.priceCurrency || ""}`.trim()
                : "",
            languages: array(n.inLanguage).filter((v) => typeof v === "string"),
            rawCategory: types.join(", "),
          },
          typeof n["@id"] === "string" ? n["@id"] : undefined,
        );
        if (n.startDate && !validDate(n.startDate))
          warnings.push(
            "В JSON-LD дата без часового пояса: оставлена пустой для ручного уточнения.",
          );
      }
      for (const [k, v] of Object.entries(n)) if (k !== "@context") visit(v);
    }
    blocks.forEach(visit);
  }
  const unique = [
    ...new Map(items.map((item) => [item.externalId, item])).values(),
  ];
  if (!unique.length)
    throw new Error(
      "Поддерживаемые записи не найдены. Нужны schema.org/Event, RSS, ICS или JSON импорта; HTML-парсер для этого сайта ещё не реализован.",
    );
  if (unique.length > 1000)
    throw new Error("В ленте больше 1 000 записей. Укажите более узкую ленту.");
  return { items: unique, warnings: [...new Set(warnings)] };
}
export function structuredProvider(overrides: Partial<ProviderInfo> = {}) {
  return defineProvider(
    {
      id: "structured",
      name: "Сайт / RSS / ICS / JSON-LD",
      group: "Свои источники",
      providerType: "Website/Aggregator",
      supportedEntityTypes: ["Event", "Place", "Community", "Organizer"],
      supportedScopes: ["*"],
      implemented: true,
      mode: "ingestion",
      description:
        "Публичная лента площадки, календарь или структурированные данные.",
      credentials: [],
      docs: [{ label: "schema.org/Event", url: "https://schema.org/Event" }],
      steps: [
        "Добавьте URL сайта, RSS, ICS или JSON-ленты.",
        "Выберите формат или оставьте автоматическое определение.",
        "Включите и проверьте источник. Проверка читает ленту, но не записывает активности.",
      ],
      limitations:
        "Читает один URL, без обхода страниц, авторизации и JavaScript. HTML без schema.org/Event не поддерживается. ICS с повторами пропускаются с предупреждением.",
      ...overrides,
    },
    {
      async testConnection(ctx) {
        const result = parseStructured(await fetchText(ctx.source.url), ctx);
        return `Распознано записей: ${result.items.length}. ${result.warnings.join(" ")}`;
      },
      async sync(ctx) {
        return parseStructured(await fetchText(ctx.source.url), ctx);
      },
      normalize(item) {
        return entitySchema.parse((item.payload as any).normalized);
      },
    },
  );
}
export const structured = structuredProvider();
