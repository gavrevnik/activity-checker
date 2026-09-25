import { defineProvider, type ProviderContext, type RawItem } from "./types.js";
import { fetchJson } from "./http.js";
const defaultEndpoint = "https://overpass-api.de/api/interpreter";
const fallbackEndpoint = "https://overpass.private.coffee/api/interpreter";
export async function requestOverpass(ctx: ProviderContext, test = false) {
  const primary = ctx.secrets.OVERPASS_URL || defaultEndpoint;
  const endpoints =
    primary === defaultEndpoint ? [primary, fallbackEndpoint] : [primary];
  for (let index = 0; index < endpoints.length; index++) {
    try {
      const data = await fetchJson(
        endpoints[index],
        {
          method: "POST",
          body: new URLSearchParams({ data: overpassQuery(ctx, test) }),
        },
        test ? 20000 : 45000,
      );
      if (!Array.isArray(data.elements))
        throw new Error("В ответе Overpass отсутствует elements.");
      if (data.remark)
        throw new Error(
          "Overpass вернул неполный ответ: " +
            String(data.remark).slice(0, 250),
        );
      return {
        data,
        warnings: index
          ? [
              "Основной сервер Overpass недоступен; данные получены с резервного overpass.private.coffee.",
            ]
          : [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        index + 1 < endpoints.length &&
        /HTTP 50[234]|timeout|timed out|fetch failed/i.test(message)
      )
        continue;
      throw new Error(
        `Overpass: ${message}${index ? " Резервный сервер также недоступен. Повторите позже; сохранённые места остаются в базе." : ""}`,
      );
    }
  }
  throw new Error("Overpass недоступен.");
}
export function overpassQuery(ctx: ProviderContext, test = false) {
  if (!ctx.scope.osmAreaId)
    throw new Error("Для этой географии не задан osmAreaId в scopes.");
  if (test) return "[out:json][timeout:10];node(1);out ids;";
  return `[out:json][timeout:35];area(${ctx.scope.osmAreaId})->.search;(
 nwr(area.search)["sport"~"^(climbing|karting|tennis|swimming|skating|archery)$"];
 nwr(area.search)["tourism"~"^(museum|gallery|attraction)$"];
 nwr(area.search)["amenity"~"^(cinema|theatre|arts_centre)$"];
 nwr(area.search)["leisure"~"^(escape_game|bowling_alley|water_park|sports_centre|sauna)$"];
 );out center tags;`;
}
export function normalizeOSM(item: RawItem, ctx: ProviderContext) {
  const raw = item.payload as any,
    t = raw.tags || {};
  if (!t.name && !t["name:en"]) return null;
  const city = ctx.scope.city || t["addr:city"] || "";
  return {
    type: "Place" as const,
    title: t["name:en"] || t.name,
    description: t.description || "",
    country: ctx.scope.country,
    city,
    category:
      t.sport || ["sports_centre", "water_park"].includes(t.leisure)
        ? "Спорт"
        : t.amenity === "cinema"
          ? "Кино"
          : t.leisure === "escape_game" || t.leisure === "bowling_alley"
            ? "Игры"
            : ["museum", "gallery"].includes(t.tourism) ||
                ["theatre", "arts_centre"].includes(t.amenity)
              ? "Искусство"
              : "Прогулки",
    rawCategory: [t.sport, t.tourism, t.amenity, t.leisure]
      .filter(Boolean)
      .join(", "),
    tags: [t.sport, t.tourism, t.leisure].filter(Boolean),
    address: [t["addr:street"], t["addr:housenumber"]]
      .filter(Boolean)
      .join(" "),
    latitude: raw.lat ?? raw.center?.lat ?? null,
    longitude: raw.lon ?? raw.center?.lon ?? null,
    url: item.url,
    website: normalizeWebsite(t.website || t["contact:website"]),
    phone: t.phone || t["contact:phone"] || "",
    openingHours: t.opening_hours || "",
    knownIds: { osm: `${raw.type}/${raw.id}` },
  };
}
function normalizeWebsite(v: string | undefined) {
  if (!v) return "";
  const value = v.split(";")[0].trim();
  return /^https?:\/\//.test(value)
    ? value
    : value.includes(".")
      ? `https://${value}`
      : "";
}
export const overpass = defineProvider(
  {
    id: "overpass",
    name: "OpenStreetMap",
    group: "Места",
    providerType: "Open data",
    supportedEntityTypes: ["Place"],
    supportedScopes: ["*"],
    implemented: true,
    mode: "ingestion",
    description: "Музеи, скалодромы, кино, спорт и другие постоянные места.",
    credentials: [],
    docs: [
      {
        label: "Overpass API",
        url: "https://wiki.openstreetmap.org/wiki/Overpass_API",
      },
      { label: "Проверить запрос", url: "https://overpass-turbo.eu/" },
    ],
    steps: [
      "Ключ и аккаунт не нужны. Включите источник и нажмите «Проверить».",
      "Нажмите «Синхронизировать»: загрузятся места выбранной географии.",
      "При временной ошибке основного сервера используется один резервный. Свой endpoint можно задать в OVERPASS_URL в .env.local.",
    ],
    limitations:
      "Данные OSM могут быть неполными. Не чаще раза в минуту; при HTTP 502–504 или timeout — одна попытка на резервном сервере. Ответ с remark не импортируется как полный. При HTTP 429 автоматического повтора нет. OSM © contributors · ODbL.",
    defaultUrl: "https://www.openstreetmap.org",
  },
  {
    async testConnection(ctx) {
      const result = await requestOverpass(ctx, true);
      return (
        "Overpass отвечает на проверочный запрос. Большая загрузка может зависеть от нагрузки сервера. " +
        result.warnings.join(" ")
      );
    },
    async sync(ctx) {
      const { data, warnings } = await requestOverpass(ctx);
      return {
        warnings,
        items: data.elements
          .filter((r: any) => r.tags?.name || r.tags?.["name:en"])
          .map((r: any) => ({
            externalId: `${r.type}/${r.id}`,
            url: `https://www.openstreetmap.org/${r.type}/${r.id}`,
            rawText: JSON.stringify(r.tags),
            payload: r,
          })),
      };
    },
    normalize: normalizeOSM,
  },
);
