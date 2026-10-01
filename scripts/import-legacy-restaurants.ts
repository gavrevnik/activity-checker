import { config } from "dotenv";
import { entitySchema, type Entity } from "../shared/model.js";
import { Store } from "../server/store.js";

config({ path: ".env.local" });

type LegacyRestaurant = {
  id: number;
  title: string;
  url: string;
  placeId: string;
  address: string;
  cuisine: string;
  visited?: boolean;
  segment?: string;
  closed?: boolean;
  rating?: number;
  reviews?: number;
  ratingSource?: string;
};

// Personal list migrated from content-checker/legacy/belgrade_restaurants.md.
// Ratings and review counts are snapshots from public web results checked on
// 2026-10-01; missing values are intentionally left empty instead of guessed.
export const legacyRestaurants: LegacyRestaurant[] = [
  {
    id: 1,
    title: "IDOL bar",
    url: "https://g.co/kgs/38pXFM4",
    placeId: "ChIJEwXp2CZ7WkcRwnd9G1ebjuU",
    address: "Strahinjića Bana 61, Beograd 11000",
    cuisine: "китайская / азиатская / европейская",
    visited: true,
    rating: 4.7,
    reviews: 2665,
    ratingSource:
      "https://restaurantguru.com/IDOL-tiki-bar-and-chinese-restaurant-Belgrade",
  },
  {
    id: 2,
    title: "June",
    url: "https://g.co/kgs/sHUCDhG",
    placeId: "ChIJGdU3YNh7WkcR4fgn8iBunqg",
    address: "Gospodar-Jevremova 25, Beograd 11158",
    cuisine: "кафе / завтраки / современная кухня",
    visited: true,
    rating: 4.6,
    reviews: 1455,
    ratingSource: "https://wanderlog.com/tr/place/details/8779781/june-cafe",
  },
  {
    id: 3,
    title: "Iva Balkan Cuisine",
    url: "https://g.co/kgs/HQcCxBt",
    placeId: "ChIJuWbCdsZ7WkcRy_h1tuAKFWs",
    address: "Svetog Save 14, Beograd 11000",
    cuisine: "современная балканская / сербская",
    visited: true,
    rating: 4.6,
    reviews: 2270,
    ratingSource:
      "https://ru.restaurantguru.com/amp/New-Balkan-Cuisine-Iva-Belgrade",
  },
  {
    id: 4,
    title: "New Reset",
    url: "https://g.co/kgs/DwYb8ZS",
    placeId: "ChIJpX6587R6WkcROyRep0PIiFc",
    address: "Gospodar Jovanova 42, Beograd",
    cuisine: "европейская / французская / фьюжн",
    visited: true,
    rating: 4.7,
    reviews: 734,
    ratingSource:
      "https://wanderlog.com/ro/place/details/735708/restoran-new-reset-dorcol",
  },
  {
    id: 5,
    title: "Good Dumplings",
    url: "https://g.co/kgs/YxwUmjV",
    placeId: "ChIJ14HFwKllWkcRpyI-Yr_DU7A",
    address: "Pop-Lukina 15, Beograd 11000",
    cuisine: "китайская / дамплинги",
    visited: true,
    rating: 4.8,
    reviews: 517,
    ratingSource: "https://ru.restaurantguru.com/Good-Dumplings-Belgrade",
  },
  {
    id: 6,
    title: "Šaran",
    url: "https://maps.app.goo.gl/7XhU8EZedk9npvnFA",
    placeId: "ChIJEwH1OqxlWkcReiY_JaPToXM",
    address: "Kej Oslobođenja 53, Beograd 11000",
    cuisine: "рыба / морепродукты",
    visited: true,
    rating: 4.6,
    reviews: 2808,
    ratingSource: "https://nomatto.com/aran-restoran",
  },
  {
    id: 7,
    title: "Istok",
    url: "https://maps.app.goo.gl/b37TSpVXfF6EGLb3A",
    placeId: "ChIJdRLBiLR6WkcRXK_5GXDoqtM",
    address: "Gospodar-Jevremova 50, Beograd 11000",
    cuisine: "вьетнамская / тайская / корейская",
    visited: true,
    rating: 4.3,
    reviews: 1860,
    ratingSource: "https://restaurantguru.com/Istok-Belgrade",
  },
  {
    id: 8,
    title: "Kunst Wine Bar",
    url: "https://maps.app.goo.gl/hggsA4NZo6dwUE8N7",
    placeId: "ChIJGTT7Uwl7WkcRKMKmh8AKY7U",
    address: "Kičevska 6, Beograd 11000",
    cuisine: "винный бар / европейские закуски",
    visited: true,
    rating: 4.8,
    reviews: 85,
    ratingSource: "https://restaurantguru.com/Kunst-wine-bar-Belgrade",
  },
  {
    id: 9,
    title: "Suvobor",
    url: "https://maps.app.goo.gl/BdhqhVmEyRuSeNYx5",
    placeId: "ChIJ0VfsH0tlWkcR6KgZE8IOa6o",
    address: "Kralja Petra 70, Beograd 11106",
    cuisine: "традиционная сербская",
    visited: true,
    rating: 4.5,
    reviews: 1384,
    ratingSource: "https://wanderlog.com/place/details/4098502/kafana-suvobor",
  },
  {
    id: 10,
    title: "Карусель",
    url: "https://maps.app.goo.gl/myVeT9yw7nh4Dbrt7",
    placeId: "ChIJCTrtESx7WkcRO3INLc8VN0k",
    address: "Cara Dušana 50, Beograd 11000",
    cuisine: "бар / коктейли / европейская",
    visited: true,
    closed: true,
    rating: 4.6,
    reviews: 254,
    ratingSource:
      "https://wanderlog.com/place/details/9380297/%D0%BA%D0%B0%D1%80%D1%83%D1%81%D0%B5%D0%BB",
  },
  {
    id: 11,
    title: "Process",
    url: "https://maps.app.goo.gl/U8cVKzVx3tY5yBFA6",
    placeId: "ChIJaSumKkB7WkcRr-yxqq1jh0o",
    address: "Palmotićeva 25a, Beograd",
    cuisine: "винный бар",
    visited: true,
    rating: 4.8,
    reviews: 179,
    ratingSource: "https://restaurantguru.com/Proces-Wine-Bar-Belgrade",
  },
  {
    id: 12,
    title: "Axiom Bar",
    url: "https://maps.app.goo.gl/RdT9rFYa6m8pnT7v6",
    placeId: "ChIJkycVPwBlWkcRcTOefdXwcv4",
    address: "Višnjićeva 3, Beograd 11000",
    cuisine: "крафтовое пиво / бар",
    visited: true,
    rating: 4.6,
    reviews: 174,
    ratingSource: "https://restaurantguru.com/Axiom-Belgrade",
  },
  {
    id: 13,
    title: "Кафана Корчагин",
    url: "https://maps.app.goo.gl/qp8PtLMzfqWMUxAT7",
    placeId: "ChIJXyainZ56WkcRZFGiW87FpSk",
    address: "Ćirila i Metodija 2а, Beograd 11000",
    cuisine: "традиционная сербская / балканская",
    visited: true,
    rating: 4.8,
    reviews: 18136,
    ratingSource: "https://restaurantguru.com/Pavle-Korcagin-Belgrade",
  },
  {
    id: 14,
    title: "Pietra",
    url: "https://maps.app.goo.gl/mxJptVEG9Zo8XQiX9",
    placeId: "ChIJjZWUnKp7WkcRa1NlqsdLayQ",
    address: "Kumanovska 6, Beograd 11111",
    cuisine: "итальянская / неаполитанская пицца",
    visited: true,
    rating: 4.6,
    reviews: 1934,
    ratingSource: "https://restaurantguru.com/Pietra-Belgrade",
  },
  {
    id: 15,
    title: "Little Bay",
    url: "https://maps.app.goo.gl/drWuDznoT69VFVM28",
    placeId: "ChIJQV148q5lWkcRY7ZsDYpSRro",
    address: "Dositejeva 9a, Beograd 11000",
    cuisine: "европейская",
    visited: true,
    closed: true,
    rating: 4.6,
    ratingSource:
      "https://www.google.com/maps/search/Lunch%2Bat%2BLittle%2BBay%2C%2BBelgrade%2C%2BSerbia",
  },
  {
    id: 16,
    title: "Thyme",
    url: "https://maps.app.goo.gl/HBiPEMs5WWDXBX8K7",
    placeId: "ChIJgZe-KcBlWkcROqlD0l5Y4Fw",
    address: "Karađorđeva 4b, Beograd 11080",
    cuisine: "стритфуд / современная / завтраки",
    visited: true,
    rating: 4.8,
    reviews: 2458,
    ratingSource:
      "https://restaurantguru.com/Thyme-StreetFood-and-Breakfast-Belgrade",
  },
  {
    id: 17,
    title: "SMASH BURGERS",
    url: "https://maps.app.goo.gl/oxpgAN6D6spYUHmb9",
    placeId: "ChIJw6BoD2B7WkcRVcW4UcIdAUI",
    address: "Takovska 50, Beograd",
    cuisine: "американская / бургеры / фастфуд",
    visited: true,
    rating: 4.8,
    reviews: 6696,
    ratingSource: "https://wanderlog.com/place/details/2388599/smash-burgers",
  },
  {
    id: 18,
    title: "Riddle Bar Skadarlija",
    url: "https://maps.app.goo.gl/JUbEkKnRbZrqj5m28",
    placeId: "ChIJ6ywZmcJ7WkcRv18MIew4DkM",
    address: "Skadarska 9, Beograd 11000",
    cuisine: "коктейльный бар",
    segment: "средний",
    rating: 4.7,
    reviews: 1285,
    ratingSource: "https://restaurantguru.com/Riddle-Bar-Belgrade",
  },
  {
    id: 19,
    title: "Fomin Bar",
    url: "https://maps.app.goo.gl/RTWk2Cmkhj3DBHap6",
    placeId: "ChIJxdLSolZ7WkcRdd9hWEjpBmw",
    address: "Sinđelićeva 3a, Beograd",
    cuisine: "крафтовое пиво / вино / европейская",
    segment: "средний",
    closed: true,
    rating: 4.7,
    reviews: 184,
    ratingSource: "https://restaurantguru.com/Fomin-Bar-Beograd-Belgrade",
  },
  {
    id: 20,
    title: "Lebanese Pekara",
    url: "https://maps.app.goo.gl/y4nw7hAciQeNvMHL6",
    placeId: "ChIJayqn1517WkcRVIkkYp4BoP4",
    address: "Beogradska 50, Beograd 11000",
    cuisine: "ливанская / выпечка / фалафель",
    segment: "средний",
    rating: 4.8,
    reviews: 540,
    ratingSource:
      "https://app.wanderlog.com/place/details/7509698/furuna-libanska-pekara-%D9%81%D9%88%D8%B1%D9%88%D9%86%D8%A7-%D8%A7%D9%84%D9%81%D8%B1%D9%86-%D8%A7%D9%84%D9%84%D8%A8%D9%86%D8%A7%D9%86%D9%8A",
  },
  {
    id: 21,
    title: "Thai Restaurant",
    url: "https://maps.app.goo.gl/Gz2yyWKcahKVz2QV8",
    placeId: "ChIJo07ejb97WkcRSdQnrKrhQXs",
    address: "Krunska 26, Beograd 11000",
    cuisine: "тайская",
    segment: "средний",
    rating: 4.7,
    reviews: 672,
    ratingSource:
      "https://wanderlog.com/de/place/details/3546641/tao-tajlandski-restoran",
  },
  {
    id: 22,
    title: "Royal India",
    url: "https://maps.app.goo.gl/4EkQq5F3GgwgH5YBA",
    placeId: "ChIJC9dHWaZ7WkcRD7LEByx0tEY",
    address: "Maršala Birjuzova 3, Beograd 11000",
    cuisine: "индийская",
    segment: "средний",
  },
  {
    id: 23,
    title: "Mezestoran Dvorište",
    url: "https://maps.app.goo.gl/ME9YK4FmpMKPRHdg9",
    placeId: "ChIJj8N-0rp6WkcRcrsES1fUATo",
    address: "Svetogorska 46, Beograd 11000",
    cuisine: "средиземноморская / греческая",
    segment: "средний · Michelin Recommended",
    rating: 4.6,
    reviews: 4939,
    ratingSource: "https://restaurantguru.com/Mezestoran-Dvoriste-Belgrade",
  },
  {
    id: 24,
    title: "Gastro Šor",
    url: "https://maps.app.goo.gl/VkPWH9WzDB6E1eGM6",
    placeId: "ChIJtVc_elB7WkcRsAsmYNHenM8",
    address: "Žorža Klemansoa 27, Beograd 11000",
    cuisine: "гастропарк / фуд-корт",
    segment: "средний",
  },
  {
    id: 25,
    title: "Boem Bar",
    url: "https://maps.app.goo.gl/Bp5jH69SiP6gaLw38",
    placeId: "ChIJ_Zw1WfZ7WkcRN4D78IsLqKk",
    address: "Skadarska 40B, Beograd 11000",
    cuisine: "сербская / европейская / бар",
    segment: "средний",
    rating: 4.8,
    reviews: 996,
    ratingSource: "https://restaurantguru.com/Boembar-Serbia",
  },
  {
    id: 26,
    title: "View Rooftop",
    url: "https://maps.app.goo.gl/FiEHyVzotjPnQDZt5",
    placeId: "ChIJUZgbbuBxWkcR51eAqag4VaU",
    address: "Internacionalnih brigada 9, Beograd 11000",
    cuisine: "международная / rooftop-ресторан",
    segment: "средний",
    rating: 4.7,
    reviews: 897,
    ratingSource:
      "https://wanderlog.com/place/details/1445364/the-view-rooftop",
  },
  {
    id: 27,
    title: "La Rumba",
    url: "https://maps.app.goo.gl/17WhUEcRV8ArjoK37",
    placeId: "ChIJY_ZK96B7WkcR4eqadGP3Bcg",
    address: "Desanke Maksimović 7, Beograd 11000",
    cuisine: "кубинская / латиноамериканская",
    segment: "средний",
    rating: 4.8,
    reviews: 648,
    ratingSource:
      "https://halalfoodle.com/restaurants/serbia/belgrade/la-rumba-desanke-maksimovic-7",
  },
  {
    id: 28,
    title: "Bosiljak Pizza Napoletana",
    url: "https://maps.app.goo.gl/4L41WhStnHTqBvEE9",
    placeId: "ChIJwWAYfCNlWkcR3XjsbHP6_Z4",
    address: "Bežanijska 36, Beograd 11080",
    cuisine: "итальянская / неаполитанская пицца",
    segment: "средний",
    rating: 4.7,
    reviews: 4239,
    ratingSource: "https://restaurantguru.com/Bosiljak-Belgrade-2",
  },
  {
    id: 29,
    title: "IbericoWine&food",
    url: "https://maps.app.goo.gl/ZwrGLjZ1i3zWu541A",
    placeId: "ChIJc_PkSgBlWkcRtUCl7qy9d24",
    address: "Vuka Karadžića 6, Beograd 11000",
    cuisine: "испанская / европейская / вино",
    segment: "средний",
    closed: true,
  },
  {
    id: 30,
    title: "La Taqueria",
    url: "https://maps.app.goo.gl/3nLb2w48SmwP1frf9",
    placeId: "ChIJLV97_UxlWkcRf077KLYfHu4",
    address: "Gračanička 7, Beograd",
    cuisine: "мексиканская",
    segment: "средний",
  },
  {
    id: 31,
    title: "Georgia",
    url: "https://maps.app.goo.gl/oG42ME2nDpwPJzom7",
    placeId: "ChIJP2wrbGJlWkcR1GlUyrWs3pI",
    address: "Kej Oslobođenja 73, Beograd",
    cuisine: "грузинская",
    segment: "средний",
    closed: true,
    rating: 4.4,
    reviews: 1027,
    ratingSource: "https://mio.travel/p/georgia-belgrade",
  },
  {
    id: 32,
    title: "Spring Belgrade",
    url: "https://maps.app.goo.gl/Fi4zUqPd2m6EpYDJ8",
    placeId: "ChIJ63J2ewR7WkcRJcKeapQyOdw",
    address: "Dositejeva 22, Beograd",
    cuisine: "китайская",
    segment: "средний",
    rating: 4.5,
    reviews: 319,
    ratingSource:
      "https://wanderlog.com/place/details/4473842/spring-belgrade-%E6%98%A5%E9%A3%8E%E5%8D%81%E9%87%8C%E4%B8%AD%E9%A4%90%E9%A6%86",
  },
  {
    id: 33,
    title: "Restoran Hanan",
    url: "https://maps.app.goo.gl/S7jNkr2jFDB19dDw7",
    placeId: "ChIJR3j5TrB6WkcRYa1rv7x01yg",
    address: "Svetogorska 2, Beograd",
    cuisine: "ливанская / ближневосточная / халяль",
    segment: "средний",
    rating: 4.4,
    reviews: 2624,
    ratingSource:
      "https://wanderlog.com/tr/place/details/1282877/restoran-hanan",
  },
  {
    id: 34,
    title: "Rodizio",
    url: "https://maps.app.goo.gl/ocjnTk5tf6EJBiir8",
    placeId: "ChIJXdPSoIdvWkcRTk5J3VEmAL0",
    address: "Bulevar Milutina Milankovića 11b, Beograd",
    cuisine: "бразильская / стейк-хаус",
    segment: "средний",
    rating: 4.6,
    reviews: 1457,
    ratingSource: "https://wanderlog.com/zh/place/details/3984242/rodizio",
  },
  {
    id: 35,
    title: "Legat",
    url: "https://maps.app.goo.gl/whHzZWYY4J7SGB2k7",
    placeId: "ChIJETI21LlxWkcRTWr3S9rI6-k",
    address: "Jasenička 7, Beograd 11010",
    cuisine: "современная сербская / fine dining",
    segment: "дорогой",
    rating: 4.8,
    ratingSource:
      "https://www.google.com/maps/search/Legat%2B1903%2BJaseni%C4%8Dka%2B7%2B11010%2BBeograd",
  },
  {
    id: 36,
    title: "Toro Latin GastroBar",
    url: "https://maps.app.goo.gl/ejvaXiGMPY46rFA38",
    placeId: "ChIJCTOKYk5lWkcRNerMQmOwF9c",
    address: "Karađorđeva 2, Beograd 11000",
    cuisine: "латиноамериканская / фьюжн",
    segment: "дорогой",
    rating: 4.7,
    ratingSource: "https://ru.restaurantguru.com/Toro-Belgrade",
  },
  {
    id: 37,
    title: "Salon 1905",
    url: "https://maps.app.goo.gl/cbzN6aR67D8sQmYZ8",
    placeId: "ChIJLQw_IVNlWkcRpjFLjFK_vCw",
    address: "Karađorđeva 48, Beograd 11000",
    cuisine: "современная сербская / европейская / fine dining",
    segment: "дорогой",
    rating: 4.5,
    reviews: 849,
    ratingSource: "https://restaurantguru.com/amp/Salon-1905-Beograd-Vinca-2",
  },
  {
    id: 38,
    title: "Enso Wine Bar",
    url: "https://maps.app.goo.gl/ZH7oTTdsqass4qnXA",
    placeId: "ChIJgVOOnZV6WkcRbPjfc04QsUY",
    address: "Mitropolita Petra 8, Beograd 11000",
    cuisine: "современная / фьюжн / fine dining",
    segment: "дорогой",
    rating: 4.7,
    reviews: 639,
    ratingSource: "https://restaurantguru.com/Enso-Belgrade",
  },
  {
    id: 39,
    title: "Restoran 27",
    url: "https://maps.app.goo.gl/aT8RgdsCko4ezmBv6",
    placeId: "ChIJiTYf9iBwWkcR_19hOb1mg4M",
    address: "Istarska 27, Beograd",
    cuisine: "средиземноморская / морепродукты / fine dining",
    segment: "дорогой",
    rating: 4.8,
    reviews: 680,
    ratingSource: "https://restaurantguru.com/27-Belgrade",
  },
  {
    id: 40,
    title: "Mandarina Cake Shop",
    url: "https://maps.app.goo.gl/eGFcgMpRpD8FGR9v5",
    placeId: "ChIJ3Z10SipxWkcR3vqP-FJUIRk",
    address: "Baba Višnjina 26, Beograd 11000",
    cuisine: "десерты / выпечка / завтраки / кофе",
    segment: "десерты",
    rating: 4.7,
    reviews: 205,
    ratingSource: "https://wedding-seat.com/de/vendors/vendor_87b202f94ea8e0d4",
  },
  {
    id: 41,
    title: "Salon de thé by Small Tree",
    url: "https://maps.app.goo.gl/sJoJYfiQTMJPoHCT6",
    placeId: "ChIJ6fPHNgpwWkcRay2cK9hOJMo",
    address: "Svetog Save 12, Beograd 11000",
    cuisine: "чайная / десерты",
    segment: "десерты",
    rating: 4.8,
    reviews: 411,
    ratingSource:
      "https://wanderlog.com/place/details/4572749/salon-de-th%C3%A9-by-small-tree",
  },
];

const checkedAt = "2026-10-01T00:00:00.000Z";
const database =
  process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite";
const store = new Store(database);
const statusTags = new Set([
  "visited",
  "liked",
  "want-to-visit",
  "personal-list",
]);

function entityInput(entity: Entity) {
  return Object.fromEntries(
    Object.keys(entitySchema.shape).map((field) => [
      field,
      entity[field as keyof Entity],
    ]),
  );
}

try {
  const source = store.source("source-manual");
  const result = store.ingest(
    source,
    legacyRestaurants.map((restaurant) => {
      const externalId = `legacy-restaurant-${String(restaurant.id).padStart(3, "0")}`;
      const tags = [
        "restaurant",
        ...(restaurant.closed ? ["closed-permanently"] : []),
      ];
      const entity = {
        type: "Place" as const,
        title: restaurant.title,
        description: "",
        country: "RS",
        city: "Belgrade",
        category: "Еда и напитки",
        rawCategory: restaurant.cuisine,
        cuisine: restaurant.cuisine,
        tags,
        address: restaurant.address,
        url: restaurant.url,
        googleRating: restaurant.rating ?? null,
        googleReviewCount: restaurant.reviews ?? null,
        googleRatingSource: restaurant.ratingSource || "",
        googleRatingCheckedAt:
          restaurant.rating !== undefined || restaurant.reviews !== undefined
            ? checkedAt
            : null,
        externalId,
        knownIds: {
          google_place: restaurant.placeId,
          legacy_restaurant: externalId,
        },
      };
      return {
        raw: {
          externalId,
          url: restaurant.url,
          rawText: [restaurant.title, restaurant.address, restaurant.cuisine]
            .filter(Boolean)
            .join("\n"),
          payload: { legacyRestaurant: restaurant, normalized: entity },
        },
        entity,
      };
    }),
  );

  const imported = store
    .entities({ includeFiltered: true })
    .filter((entity) => entity.knownIds.legacy_restaurant);
  for (const entity of imported) {
    const restaurant = legacyRestaurants.find(
      (item) => item.placeId === entity.knownIds.google_place,
    );
    if (!restaurant) continue;
    store.writeEntity(
      entity.id,
      entitySchema.parse({
        ...entityInput(entity),
        description: entity.description.startsWith(
          "Из прежнего личного списка:",
        )
          ? ""
          : entity.description,
        tags: entity.tags.filter((tag) => !statusTags.has(tag)),
      }),
    );
    store.setState(entity.id, {
      favorite: Boolean(restaurant.visited),
      notes: "",
    });
  }

  console.log(
    JSON.stringify(
      {
        database,
        requested: legacyRestaurants.length,
        restaurantCards: imported.length,
        result,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
