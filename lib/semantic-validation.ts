import type { ConnectorId, JsonObject } from "./gateway-contract";
import {
  GatewayError,
  type ConnectorExecution,
  type ExecutionMode,
  type GatewayErrorCode,
} from "./gateway-runtime";
import { amazonAsinFromInput } from "./provider-identifiers";
import { slugify } from "./upstream-parser";
import { compatibilityHostMatches, compatibilityProductPathAllowed, compatibilityProvider, dynamicProductPathAllowed, isCompatibilityProvider, isDynamicProviderId } from "./compatibility-catalog";

type JsonRecord = JsonObject;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalized(value: unknown): string {
  return stringValue(value)?.toLowerCase().replace(/\s+/g, " ") ?? "";
}

function sameText(value: unknown, expected: unknown): boolean {
  return Boolean(stringValue(value) && stringValue(expected) && normalized(value) === normalized(expected));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveMoney(value: unknown): boolean {
  const money = record(value);
  if (!money || normalized(money.currency) !== "gbp") return false;
  if (finiteNumber(money.amount)) return money.amount >= 0;
  return finiteNumber(money.min) && finiteNumber(money.max) && money.min >= 0 && money.max >= money.min;
}

function compatibilityMoney(value: unknown, product: JsonRecord): boolean {
  if (value === null || value === undefined) return true;
  const money = record(value);
  if (!money) return false;
  const validAmount = finiteNumber(money.amount) && money.amount >= 0;
  const validRange = finiteNumber(money.min) && finiteNumber(money.max) && money.min >= 0 && money.max >= money.min;
  if (!validAmount && !validRange) return false;
  const currency = money.currency;
  if (currency !== null && currency !== undefined && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) return false;
  if (product.currency_verified !== undefined && typeof product.currency_verified !== "boolean") return false;
  if (product.currency_verified === true && typeof currency !== "string") return false;
  if (typeof product.currency === "string" && typeof currency === "string" && product.currency.toUpperCase() !== currency.toUpperCase()) return false;
  if (product.currency_verified === false && typeof product.currency === "string" && currency === null) return false;
  return true;
}

function officialIkeaProductUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (url.hostname === "www.ikea.com" || url.hostname === "ikea.com") && /^\/gb\/en\/p\/[a-z0-9][a-z0-9-]*-\d{8}\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function officialEventbriteUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (url.hostname === "eventbrite.co.uk" || url.hostname.endsWith(".eventbrite.co.uk")) && /^\/e\/[a-z0-9][a-z0-9-]{2,159}\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function officialAmazonProductUrl(value: unknown, expectedId?: unknown): boolean {
  try {
    const url = new URL(String(value));
    if (!(url.hostname === "amazon.co.uk" || url.hostname.endsWith(".amazon.co.uk"))) return false;
    const productId = amazonAsinFromInput(url);
    const expected = expectedId ? amazonAsinFromInput(expectedId) : null;
    return Boolean(productId && (!expected || productId === expected));
  } catch {
    return false;
  }
}

function officialEbayItemUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (url.hostname === "ebay.co.uk" || url.hostname.endsWith(".ebay.co.uk")) && /^\/itm\/[A-Za-z0-9|_-]{3,220}/i.test(url.pathname);
  } catch {
    return false;
  }
}

function officialArgosProductUrl(value: unknown, expectedId?: unknown): boolean {
  try {
    const url = new URL(String(value));
    if (!(url.hostname === "argos.co.uk" || url.hostname.endsWith(".argos.co.uk"))) return false;
    const match = /^\/product\/(\d{4,14})\/?$/i.exec(url.pathname);
    const expected = expectedId ? String(expectedId).trim() : null;
    return Boolean(match && (!expected || match[1] === expected));
  } catch {
    return false;
  }
}

function officialJohnLewisProductUrl(value: unknown, expectedId?: unknown): boolean {
  try {
    const url = new URL(String(value));
    if (!(url.hostname === "johnlewis.com" || url.hostname === "www.johnlewis.com")) return false;
    const match = /(?:^|\/)p(\d{5,12})\/?$/i.exec(url.pathname) ?? /\/product\/p(\d{5,12})\/?$/i.exec(url.pathname);
    const expected = expectedId ? String(expectedId).trim() : null;
    return Boolean(match && (!expected || match[1] === expected));
  } catch {
    return false;
  }
}

function bookingHotelPath(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if ((url.hostname !== "booking.com" && !url.hostname.endsWith(".booking.com")) || !/^\/hotel\//i.test(url.pathname)) return null;
    const path = url.pathname.slice("/hotel/".length).replace(/^\/+|\/+$/g, "");
    return plausibleBookingHotelId(path) ? path : null;
  } catch {
    return null;
  }
}

function plausibleBookingHotelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const id = value.trim();
  if (!/^[a-z0-9][a-z0-9._/-]{2,220}$/i.test(id) || id.includes("..") || id.includes("//")) return false;
  if (id.split("/").filter(Boolean).length < 2) return false;
  return !/^(?:index(?:\.[a-z-]+)?\.html?|searchresults?(?:\.html?)?|hotels?|accommodation|properties?)$/i.test(id);
}

function genericName(value: unknown, patterns: RegExp[]): boolean {
  const text = stringValue(value);
  return !text || text.length < 3 || patterns.some((pattern) => pattern.test(text));
}

function hasEventContext(event: JsonRecord): boolean {
  return Boolean(
    stringValue(event.provider_event_id)
      || stringValue(event.start_time)
      || stringValue(event.venue)
      || stringValue(event.city)
      || stringValue(event.address)
      || positiveMoney(event.price)
      || (stringValue(event.description)?.length ?? 0) >= 24,
  );
}

function validIkeaProduct(value: unknown): boolean {
  const product = record(value);
  if (!product || !/^\d{8}$/.test(String(product.product_id ?? "").replace(/\./g, ""))) return false;
  if (genericName(product.name, [/^ikea(?: product)?$/i, /^products?$/i, /^search results?$/i])) return false;
  return officialIkeaProductUrl(product.url) && positiveMoney(product.price);
}

function validEvent(value: unknown): boolean {
  const event = record(value);
  if (!event || !/^[a-z0-9][a-z0-9-]{2,159}$/i.test(String(event.event_id ?? ""))) return false;
  if (genericName(event.title, [/^eventbrite$/i, /^events?$/i, /^search results?$/i]) || normalized(event.title) === normalized(event.event_id)) return false;
  if (!officialEventbriteUrl(event.url)) return false;
  return hasEventContext(event);
}

function validBookingHotel(value: unknown): boolean {
  const hotel = record(value);
  if (!hotel || !plausibleBookingHotelId(hotel.hotel_id)) return false;
  if (genericName(hotel.name, [/^booking(?:\.com)?$/i, /^hotels?$/i, /^accommodation$/i, /^properties$/i, /^search results?$/i])) return false;
  const path = bookingHotelPath(hotel.url);
  if (!path || path.toLowerCase() !== String(hotel.hotel_id).trim().toLowerCase()) return false;
  return Boolean(
    stringValue(hotel.provider_hotel_id)
      || stringValue(hotel.location)
      || (finiteNumber(hotel.rating) && hotel.rating >= 0 && hotel.rating <= 10)
      || (finiteNumber(hotel.review_count) && hotel.review_count >= 0)
      || positiveMoney(hotel.price),
  );
}

function validAmazonProduct(value: unknown): boolean {
  const product = record(value);
  const productId = String(product?.product_id ?? "").trim().toUpperCase();
  const asin = String(product?.asin ?? productId).trim().toUpperCase();
  if (!product || !/^[A-Z0-9]{10}$/.test(productId) || asin !== productId) return false;
  if (genericName(product.name, [/^amazon(?:\.co\.uk)?$/i, /^products?$/i, /^search results?$/i])) return false;
  if (!officialAmazonProductUrl(product.url, productId)) return false;
  return product.price === null || product.price === undefined || positiveMoney(product.price);
}

function validArgosProduct(value: unknown): boolean {
  const product = record(value);
  const productId = String(product?.product_id ?? "").trim();
  if (!product || !/^\d{4,14}$/.test(productId)) return false;
  if (genericName(product.name, [/^argos(?:\.co\.uk)?$/i, /^products?$/i, /^search results?$/i])) return false;
  return officialArgosProductUrl(product.url, productId)
    && (product.price === null || product.price === undefined || positiveMoney(product.price));
}

function validJohnLewisProduct(value: unknown): boolean {
  const product = record(value);
  const productId = String(product?.product_id ?? "").trim();
  if (!product || !/^\d{5,12}$/.test(productId)) return false;
  if (genericName(product.name, [/^john lewis(?: & partners)?$/i, /^products?$/i, /^search results?$/i])) return false;
  return officialJohnLewisProductUrl(product.url, productId)
    && (product.price === null || product.price === undefined || positiveMoney(product.price));
}

function validCommonProduct(value: unknown): boolean {
  const product = record(value);
  const provider = stringValue(product?.provider);
  const productId = stringValue(product?.product_id);
  const title = stringValue(product?.title);
  const url = stringValue(product?.canonical_url);
  if (!product || !provider || (!isCompatibilityProvider(provider) && !isDynamicProviderId(provider) && !["ikea", "amazon", "ebay", "argos", "johnlewis"].includes(provider)) || !productId || !title || genericName(title, [/^products?$/i, /^search results?$/i])) return false;
  try {
    const parsed = new URL(url ?? "");
    const host = parsed.hostname.toLowerCase();
    const compatibility = compatibilityProvider(provider);
    const validHost = compatibility
      ? compatibilityHostMatches(host, compatibility) && compatibilityProductPathAllowed(url ?? "", compatibility)
      : isDynamicProviderId(provider)
        ? dynamicProductPathAllowed(url ?? "", provider)
      : provider === "ikea"
      ? (host === "ikea.com" || host.endsWith(".ikea.com")) && /\/gb\/en\/p\//i.test(parsed.pathname)
      : provider === "amazon"
        ? officialAmazonProductUrl(url, productId)
          : provider === "ebay"
            ? (host === "ebay.co.uk" || host.endsWith(".ebay.co.uk")) && /^\/itm\//i.test(parsed.pathname)
            : provider === "argos"
              ? officialArgosProductUrl(url, productId)
                : provider === "johnlewis"
                  ? officialJohnLewisProductUrl(url, productId)
                  : false;
    if (!validHost) return false;
  } catch {
    return false;
  }
  const flexibleCurrency = isCompatibilityProvider(provider) || isDynamicProviderId(provider);
  return flexibleCurrency ? compatibilityMoney(product.price, product) : product.price === null || product.price === undefined || positiveMoney(product.price);
}

function validTravelFlight(value: unknown): boolean {
  const flight = record(value);
  if (!flight || !stringValue(flight.flight_id) || genericName(flight.origin, [/^origin$/i]) || genericName(flight.destination, [/^destination$/i])) return false;
  if (!stringValue(flight.departure) || !stringValue(flight.arrival) || !stringValue(flight.source_provider)) return false;
  if (!/google flights|travel/i.test(String(flight.source_provider))) return false;
  if (!positiveMoney(flight.price)) return false;
  if (flight.changes !== undefined && (!Number.isInteger(flight.changes) || Number(flight.changes) < 0)) return false;
  return Array.isArray(flight.segments) && flight.segments.length > 0;
}

function validTravelHotel(value: unknown): boolean {
  const hotel = record(value);
  if (!hotel || !stringValue(hotel.hotel_id) || genericName(hotel.name, [/^hotel(?:s)?$/i, /^properties?$/i, /^search results?$/i])) return false;
  if (!stringValue(hotel.source_provider) || !/google hotels|travel/i.test(String(hotel.source_provider))) return false;
  if (hotel.price !== null && hotel.price !== undefined && !positiveMoney(hotel.price)) return false;
  if (hotel.rating !== null && hotel.rating !== undefined && (!finiteNumber(hotel.rating) || hotel.rating < 0 || hotel.rating > 5)) return false;
  if (hotel.review_count !== null && hotel.review_count !== undefined && (!finiteNumber(hotel.review_count) || hotel.review_count < 0)) return false;
  return Boolean(stringValue(hotel.address) || positiveMoney(hotel.price) || finiteNumber(hotel.rating));
}

function validRentalListing(value: unknown): boolean {
  const listing = record(value);
  const provider = stringValue(listing?.provider);
  const listingId = stringValue(listing?.listing_id);
  const title = stringValue(listing?.title);
  const url = stringValue(listing?.canonical_url);
  if (!listing || !provider || !["onthemarket", "openrent"].includes(provider) || !listingId || !title || genericName(title, [/^properties?$/i, /^rentals?$/i, /^search results?$/i])) return false;
  try {
    const parsed = new URL(url ?? "");
    const host = parsed.hostname.toLowerCase();
    if (provider === "onthemarket") {
      if (!(host === "onthemarket.com" || host.endsWith(".onthemarket.com")) || !/^\/details\/[^/]+\/?$/i.test(parsed.pathname) || !parsed.pathname.toLowerCase().includes(`/details/${listingId.toLowerCase()}`)) return false;
    } else if (!(host === "openrent.co.uk" || host.endsWith(".openrent.co.uk")) || !/^\/property-to-rent\//i.test(parsed.pathname) || !new RegExp(`(?:/|-)${String(listingId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`, "i").test(parsed.pathname)) {
      return false;
    }
  } catch {
    return false;
  }
  if (listing.price_pcm !== null && listing.price_pcm !== undefined && (!finiteNumber(listing.price_pcm) || listing.price_pcm < 0)) return false;
  if (listing.effective_price_pcm !== null && listing.effective_price_pcm !== undefined && (!finiteNumber(listing.effective_price_pcm) || listing.effective_price_pcm < 0)) return false;
  if (listing.bedrooms !== null && listing.bedrooms !== undefined && (!Number.isInteger(listing.bedrooms) || Number(listing.bedrooms) < 0)) return false;
  if (listing.bathrooms !== null && listing.bathrooms !== undefined && (!Number.isInteger(listing.bathrooms) || Number(listing.bathrooms) < 0)) return false;
  if (listing.bedrooms !== null && listing.bedrooms !== undefined && Number(listing.bedrooms) > 30) return false;
  if (listing.bathrooms !== null && listing.bathrooms !== undefined && Number(listing.bathrooms) > 30) return false;
  if (listing.max_occupants !== null && listing.max_occupants !== undefined && (!Number.isInteger(listing.max_occupants) || Number(listing.max_occupants) < 1 || Number(listing.max_occupants) > 100)) return false;
  if (listing.listing_mode !== null && listing.listing_mode !== undefined && !["whole_property", "room_in_shared_property", "unknown"].includes(String(listing.listing_mode))) return false;
  if (listing.dwelling_type !== null && listing.dwelling_type !== undefined && typeof listing.dwelling_type !== "string") return false;
  if (listing.couples_allowed !== null && listing.couples_allowed !== undefined && typeof listing.couples_allowed !== "boolean") return false;
  const rent = record(listing.rent);
  if (rent) {
    if (rent.amount !== null && rent.amount !== undefined && (!finiteNumber(rent.amount) || Number(rent.amount) <= 0 || Number(rent.amount) > 100000)) return false;
    if (rent.basis !== null && rent.basis !== undefined && !["whole_property", "room", "unknown"].includes(String(rent.basis))) return false;
  }
  if (listing.furnishing !== null && listing.furnishing !== undefined && !["furnished", "part_furnished", "unfurnished", "unknown"].includes(String(listing.furnishing))) return false;
  const bills = record(listing.bills);
  if (bills && !["none", "some", "all", "unknown"].includes(String(bills.classification))) return false;
  return true;
}

function validEbayItem(value: unknown): boolean {
  const item = record(value);
  if (!item || !stringValue(item.item_id) || genericName(item.title, [/^ebay$/i, /^items?$/i, /^search results?$/i])) return false;
  if (!officialEbayItemUrl(item.url)) return false;
  return item.price === null || item.price === undefined || positiveMoney(item.price);
}

function validRailJourney(value: unknown): boolean {
  const journey = record(value);
  if (!journey || !stringValue(journey.service_id) || !stringValue(journey.origin) || !stringValue(journey.destination)) return false;
  if (!stringValue(journey.departure) || !stringValue(journey.arrival) || !stringValue(journey.operator)) return false;
  if (journey.changes !== undefined && (!Number.isInteger(journey.changes) || Number(journey.changes) < 0)) return false;
  return /national rail|rail data marketplace/i.test(String(journey.source_provider ?? ""));
}

function validJobUrl(value: unknown, provider: string, company: string, sourceId: string): boolean {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (provider === "greenhouse") {
      return (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io")
        && new RegExp("^/" + company.toLowerCase() + "/jobs/" + sourceId.toLowerCase() + "(?:/|$)").test(path);
    }
    return host === "jobs.lever.co"
      && new RegExp("^/" + company.toLowerCase() + "/" + sourceId.toLowerCase() + "(?:/|$)").test(path);
  } catch {
    return false;
  }
}

function validJobListing(value: unknown): boolean {
  const job = record(value);
  const provider = stringValue(job?.provider);
  const platform = stringValue(job?.platform);
  const jobId = stringValue(job?.job_id);
  const sourceId = stringValue(job?.source_job_id);
  const company = stringValue(job?.company_slug);
  const title = stringValue(job?.title);
  if (!job || !provider || !["greenhouse", "lever"].includes(provider) || platform !== provider || !jobId || !sourceId || !company || !title) return false;
  if (genericName(title, [/^jobs?$/i, /^careers?$/i, /^search results?$/i])) return false;
  if (jobId.toLowerCase() !== (provider + ":" + company + ":" + sourceId).toLowerCase()) return false;
  if (!validJobUrl(job.canonical_url, provider, company, sourceId)) return false;
  if (job.remote !== null && job.remote !== undefined && typeof job.remote !== "boolean") return false;
  return true;
}

function semanticError(
  message: string,
  execution: Pick<ConnectorExecution, "mode" | "sourceUrl">,
): never {
  const code: GatewayErrorCode = execution.mode === "official_api" ? "NO_VALID_RESULTS" : "UPSTREAM_CHANGED";
  throw new GatewayError(code, message, {
    retryable: false,
    mode: execution.mode as ExecutionMode,
    sourceUrl: execution.sourceUrl,
    stage: "semantic",
  });
}

function listResult(
  execution: ConnectorExecution,
  key: string,
  predicate: (value: unknown) => boolean,
  message: string,
): ConnectorExecution {
  const rows = execution.data[key];
  if (!Array.isArray(rows)) semanticError(message, execution);
  const valid = rows.filter(predicate);
  if (!valid.length && execution.outcome !== "ZERO_RESULTS") semanticError(message, execution);
  return valid.length === rows.length ? execution : { ...execution, data: { ...execution.data, [key]: valid } };
}

function validateIkea(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_products") {
    if (!sameText(execution.data.query, input.query)) semanticError("IKEA returned a result set for a different query.", execution);
    return listResult(execution, "results", validIkeaProduct, "IKEA loaded successfully but no valid product results could be extracted.");
  }
  if (tool === "get_product") {
    const product = execution.data.product;
    if (!validIkeaProduct(product) || String(record(product)?.product_id).replace(/\./g, "") !== String(input.product_id).replace(/\./g, "")) {
      semanticError("IKEA loaded successfully but did not return a valid product record.", execution);
    }
    return execution;
  }
  if (tool === "check_availability") {
    const delivery = record(execution.data.delivery);
    const productId = String(execution.data.product_id ?? "").replace(/\./g, "");
    const postcode = normalized(execution.data.postcode).replace(/\s+/g, "");
    const status = stringValue(delivery?.status);
    const available = delivery?.available;
    if (!/^\d{8}$/.test(productId) || productId !== String(input.product_id).replace(/\./g, "") || postcode !== normalized(input.postcode).replace(/\s+/g, "") || !delivery || !["available", "unavailable", "unknown"].includes(status ?? "") || (available !== null && typeof available !== "boolean") || !Array.isArray(execution.data.stores)) {
      semanticError("IKEA returned an availability response without a valid stock status.", execution);
    }
    if ((status === "available" && available !== true) || (status === "unavailable" && available !== false) || (status === "unknown" && available !== null)) {
      semanticError("IKEA returned an inconsistent availability status.", execution);
    }
    return execution;
  }
  semanticError(`IKEA returned an unsupported semantic result for ${tool}.`, execution);
}

function validateEventbrite(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_events") {
    if (!sameText(execution.data.location, input.location)) semanticError("Eventbrite returned a result set for a different location.", execution);
    return listResult(execution, "results", validEvent, "Eventbrite loaded successfully but no valid event results could be extracted.");
  }
  if (tool === "get_event") {
    const event = execution.data.event;
    if (!validEvent(event) || normalized(record(event)?.event_id) !== normalized(input.event_id)) {
      semanticError("Eventbrite loaded successfully but did not return a valid event record.", execution);
    }
    return execution;
  }
  if (tool === "list_venues") {
    if (!sameText(execution.data.location, input.location)) semanticError("Eventbrite returned venue data for a different location.", execution);
    return listResult(execution, "venues", (value) => {
      const venue = record(value);
      const urls = venue?.event_urls;
      return Boolean(
        venue
          && !genericName(venue.name, [/^venues?$/i, /^events?$/i, /venue$/i])
          && typeof venue.event_count === "number"
          && Number.isInteger(venue.event_count)
          && venue.event_count > 0
          && Array.isArray(urls)
          && urls.length > 0
          && urls.every(officialEventbriteUrl),
      );
    }, "Eventbrite loaded successfully but no valid venue results could be extracted.");
  }
  semanticError(`Eventbrite returned an unsupported semantic result for ${tool}.`, execution);
}

function validateBooking(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_hotels") {
    if (!sameText(execution.data.destination, input.destination) || !sameText(execution.data.check_in, input.check_in) || !sameText(execution.data.check_out, input.check_out)) {
      semanticError("Booking.com returned a result set for a different search state.", execution);
    }
    return listResult(execution, "results", validBookingHotel, "Booking.com loaded successfully but no valid hotel results could be extracted.");
  }
  if (tool === "get_hotel") {
    const hotel = execution.data.hotel;
    const expected = String(input.hotel_id).replace(/^https?:\/\/www\.booking\.com\//i, "").replace(/^hotel\//i, "");
    if (!validBookingHotel(hotel) || String(record(hotel)?.hotel_id).toLowerCase() !== expected.toLowerCase()) {
      semanticError("Booking.com loaded successfully but did not return a valid property record.", execution);
    }
    return execution;
  }
  if (tool === "get_room_options") {
    const hotelId = String(execution.data.hotel_id ?? "");
    if (hotelId.toLowerCase() !== String(input.hotel_id).toLowerCase() || !sameText(execution.data.check_in, input.check_in) || !sameText(execution.data.check_out, input.check_out)) {
      semanticError("Booking.com returned room data for a different search state.", execution);
    }
    return listResult(execution, "rooms", (value) => {
      const room = record(value);
      const availability = stringValue(room?.availability);
      return Boolean(
        room
          && !genericName(room.room_name, [/^rooms?$/i, /^room options$/i, /^choose your room$/i])
          && ["available", "unavailable", "unknown"].includes(availability ?? "")
          && (positiveMoney(room.total_price) || stringValue(room.taxes_and_fees) || stringValue(room.cancellation) || typeof room.breakfast_included === "boolean" || stringValue(room.occupancy) || availability),
      );
    }, "Booking.com loaded successfully but no valid room options could be extracted.");
  }
  semanticError(`Booking.com returned an unsupported semantic result for ${tool}.`, execution);
}

function validateAmazon(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_products") {
    if (!sameText(execution.data.query, input.query)) semanticError("Amazon returned a result set for a different query.", execution);
    return listResult(execution, "results", validAmazonProduct, "Amazon loaded successfully but no valid product results could be extracted.");
  }
  if (tool === "get_product") {
    const product = execution.data.product;
    const expected = amazonAsinFromInput(input.product_id);
    if (!expected || !validAmazonProduct(product) || String(record(product)?.product_id).toUpperCase() !== expected) {
      semanticError("Amazon loaded successfully but did not return a valid product record.", execution);
    }
    return execution;
  }
  semanticError(`Amazon returned an unsupported semantic result for ${tool}.`, execution);
}

function validateArgos(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_products") {
    if (!sameText(execution.data.query, input.query)) semanticError("Argos returned a result set for a different query.", execution);
    return listResult(execution, "results", validArgosProduct, "Argos loaded successfully but no valid product results could be extracted.");
  }
  if (tool === "get_product") {
    const product = execution.data.product;
    const expected = String(input.product_id).trim();
    if (!validArgosProduct(product) || String(record(product)?.product_id) !== expected) {
      semanticError("Argos loaded successfully but did not return a valid product record.", execution);
    }
    return execution;
  }
  semanticError(`Argos returned an unsupported semantic result for ${tool}.`, execution);
}

function validateJohnLewis(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_products") {
    if (!sameText(execution.data.query, input.query)) semanticError("John Lewis returned a result set for a different query.", execution);
    return listResult(execution, "results", validJohnLewisProduct, "John Lewis loaded successfully but no valid product results could be extracted.");
  }
  if (tool === "get_product") {
    const expected = String(input.product_id).match(/\d{5,12}/)?.[0] ?? String(input.product_id).trim();
    const product = execution.data.product;
    if (!validJohnLewisProduct(product) || String(record(product)?.product_id) !== expected) {
      semanticError("John Lewis loaded successfully but did not return a valid product record.", execution);
    }
    return execution;
  }
  semanticError(`John Lewis returned an unsupported semantic result for ${tool}.`, execution);
}

function validateCommerce(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_products") {
    if (!sameText(execution.data.query, input.query)) semanticError("Commerce returned a result set for a different query.", execution);
    return listResult(execution, "results", validCommonProduct, "Commerce loaded successfully but no valid product results could be extracted.");
  }
  if (tool === "get_product") {
    const product = execution.data.product;
    const expectedId = normalized(input.provider) === "amazon" ? amazonAsinFromInput(input.product_id) : String(input.product_id).replace(/\./g, "").trim().toLowerCase();
    if (!expectedId || !validCommonProduct(product) || normalized(record(product)?.provider) !== normalized(input.provider) || normalized(record(product)?.product_id) !== String(expectedId).toLowerCase()) {
      semanticError("Commerce loaded successfully but did not return a valid product record.", execution);
    }
    return execution;
  }
  semanticError(`Commerce returned an unsupported semantic result for ${tool}.`, execution);
}

function validateRentals(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_properties") {
    if (!sameText(execution.data.location, input.location)) semanticError("Rentals returned a result set for a different location.", execution);
    return listResult(execution, "results", validRentalListing, "Rental providers loaded successfully but no valid property results could be extracted.");
  }
  if (tool === "get_listing") {
    const listing = execution.data.listing;
    if (!validRentalListing(listing) || normalized(record(listing)?.provider) !== normalized(input.provider) || normalized(record(listing)?.listing_id) !== normalized(input.listing_id)) {
      semanticError("The rental provider did not return a valid listing record.", execution);
    }
    return execution;
  }
  semanticError(`Rentals returned an unsupported semantic result for ${tool}.`, execution);
}

function validateJobs(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search") {
    if (input.query !== undefined && !sameText(execution.data.query, input.query)) semanticError("Jobs returned a result set for a different query.", execution);
    if (input.location !== undefined && !sameText(execution.data.location, input.location)) semanticError("Jobs returned a result set for a different location.", execution);
    return listResult(execution, "results", validJobListing, "The public jobs boards returned no valid job results.");
  }
  if (tool === "get_listing") {
    const listing = execution.data.listing;
    const expectedProvider = normalized(input.provider);
    const expectedRawId = String(input.job_id ?? "").trim();
    const company = typeof input.company === "string" ? slugify(input.company) : null;
    const expectedId = new RegExp("^" + expectedProvider + ":([^:]+):(.+)$", "i").test(expectedRawId)
      ? expectedRawId
      : company ? expectedProvider + ":" + company + ":" + expectedRawId : expectedRawId;
    const recordValue = record(listing);
    if (!validJobListing(listing)
      || normalized(recordValue?.provider) !== expectedProvider
      || normalized(recordValue?.job_id) !== normalized(expectedId)) {
      semanticError("The public jobs board did not return the requested valid listing.", execution);
    }
    return execution;
  }
  semanticError(`Jobs returned an unsupported semantic result for ${tool}.`, execution);
}

function validateEbay(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_items") {
    if (!sameText(execution.data.query, input.query)) semanticError("eBay returned a result set for a different query.", execution);
    return listResult(execution, "results", validEbayItem, "eBay loaded successfully but no valid item results could be extracted.");
  }
  if (tool === "get_item") {
    const item = execution.data.item;
    if (!validEbayItem(item) || String(record(item)?.item_id) !== String(input.item_id)) {
      semanticError("eBay loaded successfully but did not return a valid item record.", execution);
    }
    return execution;
  }
  semanticError(`eBay returned an unsupported semantic result for ${tool}.`, execution);
}

function validateRail(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_journeys") {
    if (!sameText(execution.data.origin, input.origin) || !sameText(execution.data.destination, input.destination) || !sameText(execution.data.departure_date, input.departure_date)) {
      semanticError("The rail provider returned a result set for a different journey request.", execution);
    }
    return listResult(execution, "results", (value) => {
      if (!validRailJourney(value)) return false;
      const journey = record(value)!;
      const origin = normalized(journey.origin);
      const destination = normalized(journey.destination);
      return (origin.includes(normalized(input.origin)) || normalized(input.origin).includes(origin))
        && (destination.includes(normalized(input.destination)) || normalized(input.destination).includes(destination));
    }, "The rail provider returned no valid journey results.");
  }
  if (tool === "get_service") {
    const service = execution.data.service;
    if (!validRailJourney(service) || String(record(service)?.service_id) !== String(input.service_id)) {
      semanticError("The rail provider did not return a valid service record.", execution);
    }
    return execution;
  }
  semanticError(`Rail returned an unsupported semantic result for ${tool}.`, execution);
}

function validateTravel(tool: string, input: JsonObject, execution: ConnectorExecution): ConnectorExecution {
  if (tool === "search_flights") {
    if (!sameText(execution.data.origin, input.origin) || !sameText(execution.data.destination, input.destination) || !sameText(execution.data.departure_date, input.departure_date)) {
      semanticError("The flight route returned a result set for a different route or date.", execution);
    }
    return listResult(execution, "results", validTravelFlight, "The flight route returned no valid flight results.");
  }
  if (tool === "search_hotels") {
    if (!sameText(execution.data.destination, input.destination) || !sameText(execution.data.check_in, input.check_in) || !sameText(execution.data.check_out, input.check_out)) {
      semanticError("The hotel route returned a result set for a different destination or date range.", execution);
    }
    return listResult(execution, "results", validTravelHotel, "The hotel route returned no valid hotel results.");
  }
  semanticError(`Travel returned an unsupported semantic result for ${tool}.`, execution);
}

export function validateConnectorExecution(
  provider: ConnectorId,
  tool: string,
  input: JsonObject,
  execution: ConnectorExecution,
): ConnectorExecution {
  if (!execution || !execution.data || typeof execution.data !== "object" || Array.isArray(execution.data)) {
    semanticError("The connector returned no structured semantic result.", execution);
  }
  if (provider === "ikea") return validateIkea(tool, input, execution);
  if (provider === "eventbrite") return validateEventbrite(tool, input, execution);
  if (provider === "booking") return validateBooking(tool, input, execution);
  if (provider === "amazon") return validateAmazon(tool, input, execution);
  if (provider === "argos") return validateArgos(tool, input, execution);
  if (provider === "johnlewis") return validateJohnLewis(tool, input, execution);
  if (provider === "ebay") return validateEbay(tool, input, execution);
  if (provider === "travel") return validateTravel(tool, input, execution);
  if (provider === "commerce") return validateCommerce(tool, input, execution);
  if (provider === "rentals") return validateRentals(tool, input, execution);
  if (provider === "jobs") return validateJobs(tool, input, execution);
  return validateRail(tool, input, execution);
}
