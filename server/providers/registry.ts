import { overpass } from "./overpass.js";
import { ticketmaster } from "./ticketmaster.js";
import { manual } from "./manual.js";
import { structured } from "./structured.js";
import { catalog } from "./catalog.js";
import belgradeBeat from "./websites/belgrade-beat.js";
import afisha from "./websites/afisha.js";
import bilet from "./websites/bilet.js";
import tickets from "./websites/tickets.js";
import serbiaTravel from "./websites/serbia-travel.js";
import allEvents from "./websites/allevents.js";
import { apifyProviders } from "./apify/providers.js";
import { telegram } from "./telegram/provider.js";
import { foursquare } from "./foursquare/provider.js";
import { googlePlacesApi } from "./google-places/provider.js";
import type { ActivityProvider } from "./types.js";
export const providers: ActivityProvider[] = [
  overpass,
  ticketmaster,
  structured,
  manual,
  belgradeBeat,
  afisha,
  bilet,
  tickets,
  serbiaTravel,
  allEvents,
  telegram,
  foursquare,
  googlePlacesApi,
  ...apifyProviders,
  ...catalog,
];
export function getProvider(id: string) {
  const p = providers.find((p) => p.id === id);
  if (!p) throw new Error("Неизвестный провайдер: " + id);
  return p;
}
export function providerInfo(p: ActivityProvider) {
  const {
    sync,
    normalize,
    testConnection,
    connectionStatus,
    planSync,
    ...info
  } = p;
  return info;
}
