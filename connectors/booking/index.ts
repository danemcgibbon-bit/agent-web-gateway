import type { JsonObject } from "../../lib/gateway-contract";
import {
  absoluteUrl,
  extractCanonical,
  extractHrefLinks,
  extractJsonLd,
  extractMeta,
  extractTagText,
  firstInteger,
  firstNumber,
  firstString,
  isUpstreamChallenge,
  normalizeMoney,
  objectsByType,
  parseMoney,
  property,
  sanitizeText,
  textWindow,
} from "../../lib/upstream-parser";
import {
  fetchText,
  GatewayError,
  type ConnectorContext,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";

const BOOKING_SITE = "https://www.booking.com";

type PriceBasis = "total_stay" | "nightly" | "displayed";
type BookingPrice = { amount: number; currency: string; basis: PriceBasis };

type HotelRecord = {
  hotel_id: string;
  provider_hotel_id: string | null;
  name: string;
  url: string;
  location: string | null;
  rating: number | null;
  review_count: number | null;
  price: BookingPrice | null;
};

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function hotelIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value, BOOKING_SITE);
    if (url.hostname !== "booking.com" && !url.hostname.endsWith(".booking.com")) return null;
    const match = url.pathname.match(/^\/hotel\/(.+)$/i);
    if (!match) return null;
    const path = match[1].replace(/^\/+|\/+$/g, "");
    return path && !path.includes("..") ? path : null;
  } catch {
    return null;
  }
}

function hotelUrlFromId(value: string): string {
  const raw = value.trim().replace(/^https?:\/\/www\.booking\.com\//i, "").replace(/^hotel\//i, "");
  if (!/^[a-z0-9][a-z0-9._/-]{2,220}$/i.test(raw) || raw.includes("..") || raw.includes("//")) {
    throw new GatewayError("INPUT_INVALID", "hotel_id must be the stable Booking.com path returned by search.");
  }
  return `${BOOKING_SITE}/hotel/${raw}`;
}

function providerHotelId(value: string): string | null {
  const match = value.match(/(?:hotelid|hotel_id|data-hotelid=)["'=\s:]*(\d{4,})/i);
  return match?.[1] ?? null;
}

function parsePriceWithBasis(text: string): BookingPrice | null {
  const matches = [...text.matchAll(/(?:£|GBP\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/gi)];
  for (const match of matches) {
    const amount = Number((match[1] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    const start = Math.max(0, (match.index ?? 0) - 80);
    const nearby = text.slice(start, Math.min(text.length, (match.index ?? 0) + 180));
    const basis: PriceBasis = /per\s+night|nightly|\/night/i.test(nearby) ? "nightly" : /total|stay|for\s+\d+\s+nights?/i.test(nearby) ? "total_stay" : "displayed";
    return { amount, currency: "GBP", basis };
  }
  const parsed = parseMoney(text, "GBP");
  return parsed ? { ...parsed, basis: "displayed" } : null;
}

function addressText(value: unknown): string | null {
  const object = record(value);
  return firstString(object?.streetAddress, object?.addressLocality, object?.addressRegion, object?.addressCountry, value);
}

function parseJsonHotel(object: JsonObject, sourceUrl: string): HotelRecord | null {
  const url = absoluteUrl(property(object, "url", "@id"), sourceUrl);
  const hotelId = url ? hotelIdFromUrl(url) : null;
  if (!url || !hotelId) return null;
  const ratingObject = record(property(object, "aggregateRating", "rating"));
  const offers = property(object, "offers");
  const money = normalizeMoney(offers, "GBP");
  return {
    hotel_id: hotelId,
    provider_hotel_id: providerHotelId(JSON.stringify(object)),
    name: firstString(property(object, "name", "headline")) ?? hotelId,
    url: `${BOOKING_SITE}/hotel/${hotelId}`,
    location: addressText(property(object, "address", "location")),
    rating: firstNumber(ratingObject?.ratingValue, property(object, "ratingValue")),
    review_count: firstInteger(ratingObject?.reviewCount, ratingObject?.reviewCountText),
    price: money ? { ...money, currency: "GBP", basis: "displayed" } : null,
  };
}

function anchorLabel(anchorHtml: string): string | null {
  const title = /\b(?:title|aria-label)=["']([^"']+)["']/i.exec(anchorHtml)?.[1];
  const label = sanitizeText(title ?? anchorHtml.replace(/<[^>]+>/g, " "));
  if (!label || /^(see availability|view deals|choose your room|show prices)$/i.test(label)) return null;
  return label;
}

function parseBookingHotels(html: string, sourceUrl: string): HotelRecord[] {
  const output: HotelRecord[] = [];
  const seen = new Set<string>();
  for (const object of objectsByType(extractJsonLd(html), ["Hotel", "LodgingBusiness", "Resort", "Hostel"])) {
    const hotel = parseJsonHotel(object, sourceUrl);
    if (hotel && !seen.has(hotel.hotel_id)) {
      seen.add(hotel.hotel_id);
      output.push(hotel);
    }
  }
  const links = extractHrefLinks(html, /\/hotel\//i, sourceUrl);
  for (const link of links) {
    const hotelId = hotelIdFromUrl(link.href);
    if (!hotelId || seen.has(hotelId)) continue;
    const nearby = textWindow(html, link.index, 2200);
    const rating = /(?:scored|rating|score)[^0-9]{0,20}(\d(?:\.\d)?)/i.exec(nearby)?.[1];
    const reviews = /([0-9][0-9,]*)\s+(?:reviews?|ratings?)/i.exec(nearby)?.[1];
    const title = anchorLabel(link.html) ?? extractTagText(nearby, "h3") ?? extractTagText(nearby, "h2") ?? hotelId;
    output.push({
      hotel_id: hotelId,
      provider_hotel_id: providerHotelId(nearby),
      name: title,
      url: `${BOOKING_SITE}/hotel/${hotelId}`,
      location: null,
      rating: rating ? Number(rating) : null,
      review_count: reviews ? Number(reviews.replace(/,/g, "")) : null,
      price: parsePriceWithBasis(nearby),
    });
    seen.add(hotelId);
  }
  return output;
}

function bookingSearchUrl(input: JsonObject): URL {
  const url = new URL("/searchresults.html", BOOKING_SITE);
  url.searchParams.set("ss", String(input.destination));
  url.searchParams.set("checkin", String(input.check_in));
  url.searchParams.set("checkout", String(input.check_out));
  url.searchParams.set("group_adults", String(input.adults));
  url.searchParams.set("no_rooms", String(input.rooms));
  url.searchParams.set("group_children", "0");
  url.searchParams.set("selected_currency", "GBP");
  url.searchParams.set("lang", "en-gb");
  if (input.sort_by === "price_asc") url.searchParams.set("order", "price");
  if (input.sort_by === "rating_desc") url.searchParams.set("order", "review_score_and_price");
  return url;
}

async function searchHotels(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const searchUrl = bookingSearchUrl(input);
  const result = await fetchText(searchUrl, context);
  if (isUpstreamChallenge(result.text)) throw new GatewayError("UPSTREAM_BLOCKED", "Booking.com returned an automated-access challenge.", { retryable: false, sourceUrl: result.url });
  const hotels = parseBookingHotels(result.text, result.url).slice(0, typeof input.max_results === "number" ? input.max_results : 20);
  return { data: { destination: input.destination, check_in: input.check_in, check_out: input.check_out, results: hotels }, sourceUrl: result.url, mode: "public_http" };
}

async function getHotel(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const url = hotelUrlFromId(String(input.hotel_id));
  const result = await fetchText(url, context);
  if (isUpstreamChallenge(result.text)) throw new GatewayError("UPSTREAM_BLOCKED", "Booking.com returned an automated-access challenge.", { retryable: false, sourceUrl: result.url });
  const hotel = parseBookingHotels(result.text, result.url)[0];
  if (!hotel) {
    const name = extractMeta(result.text, "og:title") ?? extractTagText(result.text, "h1");
    if (!name) throw new GatewayError("UPSTREAM_CHANGED", "Booking.com’s property page did not expose bounded hotel fields.", { retryable: true, sourceUrl: result.url });
    return { data: { hotel: { hotel_id: String(input.hotel_id), name, url: extractCanonical(result.text, result.url) ?? result.url } }, sourceUrl: result.url, mode: "public_http" };
  }
  return { data: { hotel }, sourceUrl: result.url, mode: "public_http" };
}

type RoomOption = {
  room_name: string;
  total_price: { amount: number; currency: string; basis: "total_stay" | "displayed" } | null;
  taxes_and_fees: string | null;
  cancellation: string | null;
  breakfast_included: boolean | null;
  occupancy: string | null;
  availability: "available" | "unavailable" | "unknown";
};

function parseRoomOptions(html: string): RoomOption[] {
  const output: RoomOption[] = [];
  const seen = new Set<string>();
  const roomPattern = /data-testid=["']room-name["'][^>]*>([\s\S]{0,900})<\/[^>]+>/gi;
  for (const match of html.matchAll(roomPattern)) {
    const roomName = sanitizeText(match[1]);
    if (!roomName) continue;
    const index = match.index ?? 0;
    const nearby = textWindow(html, index, 2600);
    const price = parsePriceWithBasis(nearby);
    const key = `${roomName}|${price?.amount ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      room_name: roomName,
      total_price: price ? { amount: price.amount, currency: "GBP", basis: price.basis === "nightly" ? "displayed" : price.basis === "total_stay" ? "total_stay" : "displayed" } : null,
      taxes_and_fees: /tax(?:es)?|fee(?:s)?/i.test(nearby) ? sanitizeText(/((?:taxes?|fees?)[^.!?]{0,160})/i.exec(nearby)?.[1] ?? null) : null,
      cancellation: sanitizeText(/((?:free cancellation|non-refundable|cancellation)[^.!?]{0,180})/i.exec(nearby)?.[1] ?? null),
      breakfast_included: /breakfast\s+(?:included|included in the price)|includes breakfast/i.test(nearby) ? true : /breakfast not included|no breakfast/i.test(nearby) ? false : null,
      occupancy: sanitizeText(/((?:sleeps?|max(?:imum)?\s+occupancy|for)\s+[^.!?]{1,50})/i.exec(nearby)?.[1] ?? null, 100),
      availability: /sold out|unavailable|no rooms/i.test(nearby) ? "unavailable" : price ? "available" : "unknown",
    });
  }
  for (const object of objectsByType(extractJsonLd(html), ["Product", "Room"])) {
    const name = firstString(property(object, "name", "roomName"));
    if (!name) continue;
    const money = normalizeMoney(property(object, "offers", "price"), "GBP");
    const key = `${name}|${money?.amount ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      room_name: name,
      total_price: money ? { ...money, currency: "GBP", basis: "displayed" } : null,
      taxes_and_fees: null,
      cancellation: null,
      breakfast_included: null,
      occupancy: null,
      availability: money ? "available" : "unknown",
    });
  }
  return output.slice(0, 50);
}

async function getRoomOptions(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const baseUrl = new URL(hotelUrlFromId(String(input.hotel_id)));
  baseUrl.searchParams.set("checkin", String(input.check_in));
  baseUrl.searchParams.set("checkout", String(input.check_out));
  baseUrl.searchParams.set("group_adults", String(input.adults));
  baseUrl.searchParams.set("no_rooms", String(input.rooms));
  baseUrl.searchParams.set("group_children", "0");
  baseUrl.searchParams.set("selected_currency", "GBP");
  baseUrl.searchParams.set("lang", "en-gb");
  const result = await fetchText(baseUrl, context);
  if (isUpstreamChallenge(result.text)) throw new GatewayError("UPSTREAM_BLOCKED", "Booking.com returned an automated-access challenge.", { retryable: false, sourceUrl: result.url });
  const rooms = parseRoomOptions(result.text);
  return { data: { hotel_id: input.hotel_id, check_in: input.check_in, check_out: input.check_out, rooms }, sourceUrl: result.url, mode: "public_http" };
}

export const bookingConnector: SiteConnector = {
  provider: "booking",
  async execute(tool, input, context) {
    if (tool === "search_hotels") return searchHotels(input, context);
    if (tool === "get_hotel") return getHotel(input, context);
    if (tool === "get_room_options") return getRoomOptions(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", `Booking.com does not implement ${tool}.`);
  },
};
