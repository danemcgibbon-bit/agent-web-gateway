import type { JsonObject } from "../../lib/gateway-contract";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractCanonical,
  extractHrefLinks,
  extractMeta,
  extractNumericId,
  extractTagText,
  firstNumber,
  firstString,
  isUpstreamChallenge,
  normalizeMoney,
  parseMoney,
  sanitizeText,
  slugify,
  textFromHtml,
  textWindow,
} from "../../lib/upstream-parser";
import {
  createExecutionTrace,
  fetchText,
  GatewayError,
  markHttpFailure,
  markHttpSuccess,
  markSemanticValidation,
  type ConnectorContext,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";

const OTM_SITE = "https://www.onthemarket.com";
const OPENRENT_SITE = "https://www.openrent.co.uk";
const AGENT_USER_AGENT = "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.djrookie99.chatgpt.site)";
const RENTAL_PROVIDERS = ["onthemarket", "openrent"] as const;
type RentalProvider = (typeof RENTAL_PROVIDERS)[number];
type RentalRecord = JsonObject;

export type RentalConstraintState = "MATCH" | "NO_MATCH" | "UNKNOWN";
export type RentalListingMode = "whole_property" | "room_in_shared_property" | "unknown";
export type RentalRentBasis = "whole_property" | "room" | "unknown";

type RentalFieldAuthority = "detail" | "search" | "structured";

/**
 * Detail pages are the authority for facts that can change between a result
 * card and the listing itself.  Search-only fields remain useful provenance,
 * but are never allowed to overwrite these values after reconciliation.
 */
export const RENTAL_FIELD_AUTHORITY: Record<string, RentalFieldAuthority> = {
  canonical_url: "detail",
  title: "detail",
  address: "detail",
  area: "detail",
  postcode: "detail",
  property_type: "detail",
  dwelling_type: "detail",
  listing_mode: "detail",
  shared_property: "detail",
  price_pcm: "detail",
  effective_price_pcm: "detail",
  rent: "detail",
  bedrooms: "detail",
  bathrooms: "detail",
  max_occupants: "detail",
  occupancy: "detail",
  couples_allowed: "detail",
  availability: "detail",
  availability_details: "detail",
  listed_at: "detail",
  last_updated_at: "detail",
  available_from: "detail",
  search_position: "search",
  provider: "structured",
  listing_id: "structured",
};

const MAX_RENTAL_PAGES = 10;
const MAX_RENTAL_DETAIL_VERIFICATIONS = 40;
const MAX_BEDROOMS = 30;
const MAX_BATHROOMS = 30;
const MAX_OCCUPANTS = 100;
const MAX_RENT_PCM = 100_000;

type RentalEvidence<T = unknown> = {
  value: T;
  confidence: "high" | "medium" | "low";
  source: string;
};

type RentalConstraintEvaluation = {
  states: Record<string, RentalConstraintState>;
  failed_constraints: string[];
  unknown_constraints: string[];
  exact: boolean;
  status: "exact" | "filtered" | "unverified_candidate";
  reason?: string;
};

type RentalAcquisition = {
  requested_url: string;
  provider_location_scope: string;
  pages_fetched: number;
  records_acquired: number;
  pagination_complete: boolean;
  records_capped: boolean;
  termination_reason: string;
  provider_filters_applied: string[];
};

type RobotsRule = { path: string; allow: boolean };
type RobotsBlock = { agents: string[]; rules: RobotsRule[] };
type RobotsCacheEntry = { expiresAt: number; blocks: RobotsBlock[] };

const robotsCache = new Map<RentalProvider, RobotsCacheEntry>();
const ROBOTS_TTL_MS = 30 * 60 * 1000;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringList(value: unknown, maxItems = 20, maxLength = 240): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const output: string[] = [];
  for (const item of values) {
    const text = typeof item === "object" && item !== null
      ? firstString((item as JsonObject).label, (item as JsonObject).name, (item as JsonObject).value, (item as JsonObject).text)
      : sanitizeText(item, maxLength);
    if (text && !output.includes(text)) output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function textValue(value: unknown, maxLength = 900): string | null {
  if (typeof value === "string") return sanitizeText(value, maxLength);
  if (Array.isArray(value)) return sanitizeText(stringList(value, 30, maxLength).join("; "), maxLength);
  if (value && typeof value === "object") {
    const object = value as JsonObject;
    return firstString(object.text, object.value, object.label, object.name, object.description);
  }
  return null;
}

function cleanUrl(value: unknown, baseUrl: string, provider: RentalProvider): string | null {
  const candidate = absoluteUrl(value, baseUrl);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const validHost = provider === "onthemarket"
      ? url.hostname === "onthemarket.com" || url.hostname.endsWith(".onthemarket.com")
      : url.hostname === "openrent.co.uk" || url.hostname.endsWith(".openrent.co.uk");
    if (!validHost) return null;
    url.search = "";
    url.hash = "";
    url.pathname = provider === "onthemarket"
      ? `${url.pathname.replace(/\/+$/, "")}/`
      : url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalUrl(provider: RentalProvider, listingId: string, value?: unknown): string | null {
  const base = provider === "onthemarket" ? OTM_SITE : OPENRENT_SITE;
  const parsed = value ? cleanUrl(value, base, provider) : null;
  if (parsed) return parsed;
  if (provider === "onthemarket" && /^\d{5,}$/.test(listingId)) return `${OTM_SITE}/details/${listingId}/`;
  return null;
}

function parseNextData(html: string): JsonObject | null {
  const match = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(decodeHtmlEntities(match[1])) as unknown;
    return record(value);
  } catch {
    return null;
  }
}

function findArrays(value: unknown, keys: string[], depth = 0): unknown[][] {
  if (depth > 8 || value === null || value === undefined) return [];
  const output: unknown[][] = [];
  if (Array.isArray(value)) {
    for (const item of value) output.push(...findArrays(item, keys, depth + 1));
    return output;
  }
  const object = record(value);
  if (!object) return output;
  for (const key of keys) if (Array.isArray(object[key])) output.push(object[key] as unknown[]);
  for (const child of Object.values(object)) output.push(...findArrays(child, keys, depth + 1));
  return output;
}

function findObjectById(value: unknown, id: string, depth = 0): JsonObject | null {
  if (depth > 9 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectById(item, id, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const object = record(value);
  if (!object) return null;
  const candidateId = firstString(object.id, object.propertyId, object.listingId, object["property-id"]);
  if (candidateId === id && (object.propertyTitle || object.title || object.priceRaw || object.canonicalUrl || object["details-url"])) return object;
  for (const child of Object.values(object)) {
    const found = findObjectById(child, id, depth + 1);
    if (found) return found;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function rentMoney(...values: unknown[]): number | null {
  for (const value of values) {
    const text = textValue(value, 400);
    const source = typeof value === "string" ? value : text;
    if (source) {
      const monthly = /£\s*([\d,]+(?:\.\d{1,2})?)\s*(?:pcm|p\/m|per\s+month|monthly|a\s+month)/i.exec(source);
      if (monthly) return Number(monthly[1].replace(/,/g, ""));
      const parsed = parseMoney(source, "GBP");
      if (parsed?.currency === "GBP") {
        if (/(?:pw|per\s+week|weekly)/i.test(source)) return roundMoney(parsed.amount * 52 / 12);
        return parsed.amount;
      }
    }
    const normalized = normalizeMoney(value, "GBP");
    if (normalized?.currency === "GBP") return normalized.amount;
  }
  return null;
}

export function classifyBills(text: string): { classification: "none" | "some" | "all" | "unknown"; surcharge_pcm: number | null } {
  const source = sanitizeText(text, 5000)?.toLowerCase() ?? "";
  let surcharge: number | null = null;
  const surchargePatterns = [
    /£\s*([\d,]+(?:\.\d{1,2})?)\s*(?:pcm|p\/m|per\s+month|monthly)?[^£.]{0,80}(?:mandatory\s+)?(?:bills?|utilities?|utility)(?:\s+package)?/i,
    /(?:mandatory\s+)?(?:bills?|utilities?|utility)(?:\s+package)?[^£.]{0,80}£\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const pattern of surchargePatterns) {
    const match = pattern.exec(source);
    if (match) {
      const amount = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(amount) && amount > 0) { surcharge = amount; break; }
    }
  }
  if (/(?:bills?|utilities?)\s+(?:included\s+)?(?:no|not|false)|(?:no|not)\s+(?:all\s+)?(?:bills?|utilities?)/i.test(source)) {
    return { classification: "none", surcharge_pcm: surcharge };
  }
  if (/(?:all|utilities?|bills?)\s+(?:are\s+)?included|bills?\s+included|utilities?\s+included/i.test(source)) {
    return { classification: surcharge ? "some" : "all", surcharge_pcm: surcharge };
  }
  if (/(?:some|selected|water|heating|internet|wifi|council tax)[^.]{0,45}(?:bills?|utilities?)\s+included|(?:bills?|utilities?)[^.]{0,45}included/i.test(source)) {
    return { classification: "some", surcharge_pcm: surcharge };
  }
  if (/(?:bills?|utilities?)\s+(?:not\s+included|excluded|extra|separate)|excluding\s+(?:bills?|utilities?)|tenant(?:s)?\s+(?:pay|pays)\s+(?:their\s+own\s+)?(?:bills?|utilities?)/i.test(source)) {
    return { classification: "none", surcharge_pcm: surcharge };
  }
  return { classification: surcharge ? "some" : "unknown", surcharge_pcm: surcharge };
}

export function normalizeFurnishing(text: string): "furnished" | "part_furnished" | "unfurnished" | "unknown" {
  if (/part[\s-]?furnished/i.test(text)) return "part_furnished";
  if (/\bunfurnished\b/i.test(text)) return "unfurnished";
  if (/\bfurnished\b/i.test(text)) return "furnished";
  return "unknown";
}

function postcodeFrom(text: string): string | null {
  const match = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i.exec(text);
  return match ? match[1].toUpperCase().replace(/\s+/g, " ") : null;
}

function firstDate(text: string): string | null {
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (iso && Number.isFinite(Date.parse(`${iso}T00:00:00Z`))) return iso;
  const date = /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i.exec(text);
  if (!date) return null;
  const parsed = Date.parse(`${date[1]} ${date[2]} ${date[3]} UTC`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function listedAtFromDays(value: unknown, listedText: string | null): string | null {
  return listedAtFromText(listedText, value);
}

function stationSignal(text: string): string | null {
  const match = /\b(?:\d+\s*(?:-|to)\s*)?\d+\s*(?:minute|min)\s*(?:walk|徒歩)?[^.]{0,60}\b(?:station|tube|railway)\b[^.]{0,80}/i.exec(text)
    ?? /\b[^.]{0,60}\b(?:station|tube)\b[^.]{0,60}\b(?:walk|minutes?)\b/i.exec(text);
  return sanitizeText(match?.[0] ?? null, 180)
    ?? sanitizeText(/\b(?:[A-Z][A-Za-z' -]{1,30}\s+)?\d+\s*(?:minute|min)\.?\s+walk\b/i.exec(text)?.[0] ?? null, 180);
}

function petSignal(text: string): boolean | null {
  if (/(?:no|not|cannot|can't)\s+(?:pets?|animals?)/i.test(text)) return false;
  if (/(?:pets?|animals?)\s+(?:allowed|welcome|considered|permitted)/i.test(text) || /pet friendly/i.test(text)) return true;
  return null;
}

function boolSignal(text: string, yes: RegExp, no: RegExp): boolean | null {
  if (no.test(text)) return false;
  if (yes.test(text)) return true;
  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = firstNumber(value);
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

function boundedInteger(value: unknown, min: number, max: number): { value: number | null; status: "valid" | "missing" | "invalid" } {
  if (value === undefined || value === null || value === "") return { value: null, status: "missing" };
  const parsed = finiteNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < min || parsed > max) return { value: null, status: "invalid" };
  return { value: parsed, status: "valid" };
}

function boundedMoney(value: unknown): { value: number | null; status: "valid" | "missing" | "invalid" } {
  const parsed = finiteNumber(value);
  if (value === undefined || value === null || value === "") return { value: null, status: "missing" };
  if (parsed === null || parsed <= 0 || parsed > MAX_RENT_PCM) return { value: null, status: "invalid" };
  return { value: roundMoney(parsed), status: "valid" };
}

function normalizeLocationText(value: unknown): string | null {
  const text = textValue(value, 300);
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return normalized || null;
}

function locationMatches(requested: string, listing: RentalRecord): RentalConstraintState {
  const requestedNormalized = normalizeLocationText(requested);
  if (!requestedNormalized) return "UNKNOWN";
  const location = record(listing.location);
  if (location?.verified === true) {
    const providerScope = normalizeLocationText(location.display ?? location.normalized);
    if (!providerScope || providerScope.includes(requestedNormalized) || requestedNormalized.includes(providerScope)) return "MATCH";
  }
  const candidates = [
    location?.display,
    location?.normalized,
    record(listing.search_scope)?.requested_location,
    record(listing.search_scope)?.provider_location_scope,
    listing.location_display,
    listing.location_normalized,
    listing.area,
    listing.address,
    listing.postcode,
  ].map(normalizeLocationText).filter((value): value is string => Boolean(value));
  if (candidates.some((candidate) => candidate.includes(requestedNormalized) || requestedNormalized.includes(candidate))) return "MATCH";
  const requestedTokens = requestedNormalized.split(" ").filter((token) => token.length > 2);
  if (requestedTokens.length && candidates.some((candidate) => requestedTokens.every((token) => candidate.includes(token)))) return "MATCH";
  return "UNKNOWN";
}

function inferDwellingType(value: unknown, text: string): string | null {
  const source = `${textValue(value, 120) ?? ""} ${text}`.toLowerCase();
  if (/\b(?:room|bedroom\s+in\s+shared|roomlet)\b/.test(source) && !/\bflat\b/.test(source)) return "room";
  if (/\bmaisonette\b/.test(source)) return "maisonette";
  if (/\bstudio\b/.test(source)) return "studio";
  if (/\bflat\b|\bapartment\b/.test(source)) return "flat";
  if (/\bhouse\b|\bterrace\b|\bterraced\b|\bsemi[- ]?detached\b|\bdetached\b|\bbungalow\b/.test(source)) return "house";
  return textValue(value, 120);
}

function inferListingMode(value: unknown, text: string, dwellingType: string | null, sharedProperty?: unknown): RentalListingMode {
  const explicit = typeof value === "string" ? value.toLowerCase().replace(/[ -]+/g, "_") : "";
  if (explicit === "whole_property" || explicit === "whole") return "whole_property";
  if (explicit === "room_in_shared_property" || explicit === "shared_room" || explicit === "room") return "room_in_shared_property";
  const source = text.toLowerCase();
  if (typeof sharedProperty === "boolean") {
    if (sharedProperty) return "room_in_shared_property";
    if (dwellingType && dwellingType !== "room") return "whole_property";
  }
  if (/(?:room\s+(?:in|to\s+rent)|roomlet|house\s+share|flat\s+share|shared\s+(?:flat|property|house)|co[\s-]?living|single\s+occupancy|bedsit\s+share)/i.test(source)) return "room_in_shared_property";
  if (dwellingType && dwellingType !== "room") return "whole_property";
  return "unknown";
}

function inferRentBasis(listingMode: RentalListingMode, text: string, value?: unknown): RentalRentBasis {
  const explicit = typeof value === "string" ? value.toLowerCase().replace(/[ -]+/g, "_") : "";
  if (explicit === "whole_property" || explicit === "property" || explicit === "home") return "whole_property";
  if (explicit === "room") return "room";
  if (listingMode === "room_in_shared_property") return "room";
  if (listingMode === "whole_property") return "whole_property";
  if (/\b(?:room|per\s+room|room\s+only|house\s+share|flat\s+share)\b/i.test(text)) return "room";
  return "unknown";
}

function parseBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (/^(?:true|yes|y|allowed|included)$/i.test(value.trim())) return true;
  if (/^(?:false|no|n|not\s+allowed|excluded)$/i.test(value.trim())) return false;
  return null;
}

function relativeTimestamp(text: string, mode: "listed" | "updated"): string | null {
  const source = text.toLowerCase();
  const marker = mode === "listed"
    ? /(?:listed|added|posted|created|published)\s+(?:about\s+)?/i
    : /(?:last\s+)?updated\s+(?:about\s+)?/i;
  const match = marker.exec(source);
  if (!match) return null;
  const rest = source.slice(match.index + match[0].length);
  const amount = /^(\d+)\s*(minute|minutes|min|hour|hours|day|days|week|weeks)\s*ago/i.exec(rest);
  if (amount) {
    const count = Number(amount[1]);
    const unit = amount[2].toLowerCase();
    const factor = unit.startsWith("minute") || unit === "min" ? 60_000 : unit.startsWith("hour") ? 3_600_000 : unit.startsWith("week") ? 7 * 86_400_000 : 86_400_000;
    return new Date(Date.now() - count * factor).toISOString();
  }
  if (/^today\b/i.test(rest)) return new Date().toISOString();
  if (/^yesterday\b/i.test(rest)) return new Date(Date.now() - 86_400_000).toISOString();
  return null;
}

function listedAtFromText(text: string | null, listedDays?: unknown): string | null {
  const days = finiteNumber(listedDays);
  if (days !== null && Number.isInteger(days) && days >= 0 && days <= 3650) return new Date(Date.now() - days * 86_400_000).toISOString();
  return relativeTimestamp(text ?? "", "listed") ?? firstDate(text ?? "");
}

function updatedAtFromText(text: string | null, updatedValue?: unknown): string | null {
  const explicit = textValue(updatedValue, 180);
  const asDate = explicit ? firstDate(explicit) : null;
  return asDate ?? relativeTimestamp(text ?? "", "updated");
}

function canonicalTimestamp(value: unknown): string | null {
  const text = textValue(value, 180);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date(parsed).toISOString();
}

function availableFromText(value: unknown, text: string): string | null {
  const direct = textValue(value, 180);
  const candidate = direct ?? /(?:available\s+from|available)\s*[:\-]?\s*([^.;|]{3,60})/i.exec(text)?.[1] ?? null;
  if (!candidate) return null;
  return firstDate(candidate) ?? (/\b(?:today|now|immediately)\b/i.test(candidate) ? new Date().toISOString().slice(0, 10) : candidate);
}

function availabilityEvidence(value: unknown, text: string): { available: boolean | null; available_from: string | null } {
  const explicit = parseBooleanValue(value);
  const unavailable = /(?:let\s+agreed|no\s+longer\s+available|unavailable|property\s+let|withdrawn|not\s+available)/i.test(text);
  const available = explicit ?? (unavailable ? false : /\bavailable(?:\s+from|\s+now)?\b|\b(?:immediately|now)\b|immediately\s+available/i.test(text) ? true : null);
  return { available, available_from: availableFromText(value, text) };
}

function couplesEvidence(value: unknown, text: string, maxOccupants: number | null): RentalEvidence<boolean> | null {
  const explicit = parseBooleanValue(value);
  if (explicit !== null) return { value: explicit, confidence: "high", source: "structured_couples_field" };
  if (/(?:no|not|cannot|can't|won't)\s+(?:accommodate\s+)?couples?|couples?\s+(?:not\s+allowed|allowed\s*(?:no|false))|single\s+(?:tenant|occupancy|person)\s+only/i.test(text)) {
    return { value: false, confidence: "high", source: "explicit_listing_preference" };
  }
  if (/(?:couples?|two\s+tenants?)\s+(?:allowed|welcome|accepted|considered|permitted)(?!\s*(?:no|false))|suitable\s+for\s+couples?|dual\s+occupancy/i.test(text)) {
    return { value: true, confidence: "high", source: "explicit_listing_preference" };
  }
  if (maxOccupants !== null && maxOccupants < 2) return { value: false, confidence: "high", source: "maximum_occupants" };
  return null;
}

function comparable(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return value.trim().toLowerCase().replace(/\s+/g, " ");
  try { return JSON.stringify(value); } catch { return String(value); }
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function mergeDefined(...values: Array<JsonObject | null | undefined>): JsonObject {
  const merged: JsonObject = {};
  for (const value of values) {
    if (!value) continue;
    for (const [key, item] of Object.entries(value)) {
      if (hasValue(item)) merged[key] = item;
    }
  }
  return merged;
}

export function normalizeRentalListing(value: RentalRecord, options: { locationVerified?: boolean } = {}): RentalRecord {
  const listing = { ...value };
  const searchScope = record(listing.search_scope);
  const rawText = [listing.title, listing.address, listing.description, listing.availability, listing.available_from, listing.available, listing.listed_text, listing.last_updated_text, searchScope?.requested_location, searchScope?.provider_location_scope, Array.isArray(listing.features) ? listing.features.join(" ") : "", listing.listing_mode, listing.property_type].filter(Boolean).join(" ");
  const dwellingType = inferDwellingType(listing.dwelling_type ?? listing.property_type, rawText);
  const listingMode = inferListingMode(listing.listing_mode, rawText, dwellingType, listing.shared_property);
  const rentObject = record(listing.rent);
  const parsedPrice = boundedMoney(listing.price_pcm ?? rentObject?.amount);
  const price = parsedPrice.value;
  const bills = record(listing.bills);
  const surcharge = boundedMoney(listing.bills_surcharge_pcm ?? bills?.surcharge_pcm).value;
  const effectiveParsed = boundedMoney(listing.effective_price_pcm);
  const effective = effectiveParsed.value ?? (price === null ? null : roundMoney(price + (surcharge ?? 0)));
  const rentBasis = inferRentBasis(listingMode, rawText, rentObject?.basis ?? listing.rent_basis);
  const rent = {
    amount: price,
    currency: "GBP",
    period: "month",
    basis: rentBasis,
    ...(effective !== null ? { effective_amount: effective } : {}),
  };
  const bedroomParsed = boundedInteger(listing.bedrooms, 0, MAX_BEDROOMS);
  const bathroomParsed = boundedInteger(listing.bathrooms, 0, MAX_BATHROOMS);
  const occupantParsed = boundedInteger(listing.max_occupants ?? record(listing.occupancy)?.max_occupants, 1, MAX_OCCUPANTS);
  const occupancyParseFailures = Array.isArray(listing.parse_failures) ? [...listing.parse_failures.map(String)] : [];
  if (parsedPrice.status === "invalid" && !occupancyParseFailures.includes("price_pcm")) occupancyParseFailures.push("price_pcm");
  if (effectiveParsed.status === "invalid" && !occupancyParseFailures.includes("effective_price_pcm")) occupancyParseFailures.push("effective_price_pcm");
  if (occupantParsed.status === "invalid" && !occupancyParseFailures.includes("max_occupants")) occupancyParseFailures.push("max_occupants");
  if (bedroomParsed.status === "invalid" && !occupancyParseFailures.includes("bedrooms")) occupancyParseFailures.push("bedrooms");
  if (bathroomParsed.status === "invalid" && !occupancyParseFailures.includes("bathrooms")) occupancyParseFailures.push("bathrooms");
  const occupancyObject = record(listing.occupancy);
  const couples = couplesEvidence(listing.couples_allowed ?? occupancyObject?.couples_allowed, rawText, occupantParsed.value);
  const availability = availabilityEvidence(listing.available ?? listing.availability ?? listing.availability_available, rawText);
  const locationObject = record(listing.location);
  const locationDisplay = textValue(locationObject?.display ?? listing.location_display ?? listing.area ?? listing.address, 300);
  const locationNormalized = normalizeLocationText(locationObject?.normalized ?? listing.location_normalized ?? locationDisplay);
  const timestamps = record(listing.timestamps);
  const listedAt = canonicalTimestamp(timestamps?.listed_at ?? listing.listed_at);
  const lastUpdated = canonicalTimestamp(timestamps?.last_updated_at ?? listing.last_updated_at);
  const availableFrom = canonicalTimestamp(timestamps?.available_from ?? listing.available_from) ?? availability.available_from;
  const normalizedVerification = record(listing.verification);
  const normalized: RentalRecord = {
    ...listing,
    canonical_record: true,
    dwelling_type: dwellingType,
    listing_mode: listingMode,
    property_type: textValue(listing.property_type, 120) ?? dwellingType,
    shared_property: listingMode === "room_in_shared_property" ? true : listingMode === "whole_property" ? false : listing.shared_property ?? null,
    whole_property: listingMode === "whole_property" ? true : listingMode === "room_in_shared_property" ? false : null,
    whole_property_eligible: listingMode === "whole_property",
    price_pcm: price,
    effective_price_pcm: effective,
    rent,
    rent_basis: rentBasis,
    bedrooms: bedroomParsed.value,
    bathrooms: bathroomParsed.value,
    max_occupants: occupantParsed.value,
    occupancy: {
      max_occupants: occupantParsed.value,
      couples_allowed: couples?.value ?? null,
      ...(couples ? { couples_confidence: couples.confidence, couples_source: couples.source } : {}),
    },
    couples_allowed: couples?.value ?? null,
    couples_confidence: couples?.confidence ?? "unknown",
    couples_source: couples?.source ?? null,
    availability: textValue(listing.availability, 180) ?? availableFrom,
    availability_details: {
      available: availability.available,
      available_from: availableFrom,
    },
    available_from: availableFrom,
    listed_at: listedAt,
    last_updated_at: lastUpdated,
    timestamps: {
      listed_at: listedAt,
      last_updated_at: lastUpdated,
      available_from: availableFrom,
    },
    location: {
      display: locationDisplay,
      normalized: locationNormalized,
      verified: options.locationVerified ?? locationObject?.verified === true,
    },
    ...(occupancyParseFailures.length ? { parse_failures: occupancyParseFailures } : {}),
    ...(normalizedVerification ? { verification: normalizedVerification } : {}),
  };
  return normalized;
}

export function reconcileRentalListing(searchRecord: RentalRecord, detailRecord: RentalRecord): RentalRecord {
  const search = normalizeRentalListing(searchRecord, { locationVerified: record(searchRecord.location)?.verified === true });
  const detail = normalizeRentalListing(detailRecord);
  const conflicts: string[] = [];
  const reconciled: RentalRecord = { ...search };
  const authoritativeFields = Object.keys(RENTAL_FIELD_AUTHORITY).filter((field) => RENTAL_FIELD_AUTHORITY[field] === "detail");
  for (const field of authoritativeFields) {
    const searchValue = search[field];
    const detailValue = detail[field];
    if (hasValue(searchValue) && hasValue(detailValue) && comparable(searchValue) !== comparable(detailValue)) conflicts.push(field);
    if (hasValue(detailValue)) reconciled[field] = detailValue;
  }
  // The nested objects need field-level merging so a detail parser that lacks
  // one optional datum does not erase a verified search-scope or timestamp.
  if (record(detail.location)) reconciled.location = mergeDefined(record(search.location), record(detail.location));
  if (record(detail.rent)) reconciled.rent = mergeDefined(record(search.rent), record(detail.rent));
  if (record(detail.occupancy)) reconciled.occupancy = mergeDefined(record(search.occupancy), record(detail.occupancy));
  if (record(detail.availability_details)) reconciled.availability_details = mergeDefined(record(search.availability_details), record(detail.availability_details));
  if (record(detail.timestamps)) reconciled.timestamps = mergeDefined(record(search.timestamps), record(detail.timestamps));
  const parseFailures = [...new Set([
    ...(Array.isArray(search.parse_failures) ? search.parse_failures.map(String) : []),
    ...(Array.isArray(detail.parse_failures) ? detail.parse_failures.map(String) : []),
  ])];
  if (parseFailures.length) reconciled.parse_failures = parseFailures;
  const canonical = normalizeRentalListing(reconciled, { locationVerified: record(detail.location)?.verified === true || record(search.location)?.verified === true });
  canonical.reconciliation = {
    status: "reconciled",
    authoritative_source: "detail",
    fields_reconciled: authoritativeFields.filter((field) => hasValue(detail[field])),
    conflicts,
  };
  return canonical;
}

function commonRecord(
  provider: RentalProvider,
  listingId: string,
  sourceUrl: string,
  values: {
    title?: unknown;
    address?: unknown;
    postcode?: unknown;
    area?: unknown;
    price?: unknown;
    bedrooms?: unknown;
    bathrooms?: unknown;
    propertyType?: unknown;
    furnishing?: unknown;
    availability?: unknown;
    listedText?: unknown;
    listedDays?: unknown;
    updatedText?: unknown;
    listedAt?: unknown;
    lastUpdatedAt?: unknown;
    features?: unknown;
    description?: unknown;
    extraText?: unknown;
    imageUrl?: unknown;
    billsText?: unknown;
    maxOccupants?: unknown;
    couplesAllowed?: unknown;
    available?: unknown;
    listingMode?: unknown;
    sharedProperty?: unknown;
  },
): RentalRecord | null {
  const url = canonicalUrl(provider, listingId, sourceUrl);
  const title = textValue(values.title, 260);
  if (!url || !listingId || !title || title.length < 3) return null;
  const address = textValue(values.address, 260);
  const description = textValue(values.description, 1600);
  const features = stringList(values.features, 24, 220);
  const listedText = textValue(values.listedText, 180);
  const updatedText = textValue(values.updatedText ?? values.lastUpdatedAt, 180);
  const fullText = [title, address, description, listedText, updatedText, stringList(values.extraText, 40, 240).join(" "), features.join(" ")].filter(Boolean).join(" ");
  const rawPrice = rentMoney(values.price, fullText);
  const priceParsed = boundedMoney(rawPrice);
  const price = priceParsed.value;
  const bills = classifyBills([textValue(values.billsText, 2400), fullText, stringList(values.extraText, 20, 800).join(" ")].filter(Boolean).join(" "));
  const effective = price === null ? null : roundMoney(price + (bills.surcharge_pcm ?? 0));
  const furnishingText = [textValue(values.furnishing, 80), features.join(" "), fullText].filter(Boolean).join(" ");
  const addressText = address ?? "";
  const propertyType = textValue(values.propertyType, 120);
  const bedrooms = boundedInteger(values.bedrooms, 0, MAX_BEDROOMS).value;
  const bathrooms = boundedInteger(values.bathrooms, 0, MAX_BATHROOMS).value;
  const occupants = boundedInteger(values.maxOccupants, 1, MAX_OCCUPANTS);
  const parseFailures = [
    ...(priceParsed.status === "invalid" ? ["price_pcm"] : []),
    ...(occupants.status === "invalid" ? ["max_occupants"] : []),
    ...(boundedInteger(values.bedrooms, 0, MAX_BEDROOMS).status === "invalid" ? ["bedrooms"] : []),
    ...(boundedInteger(values.bathrooms, 0, MAX_BATHROOMS).status === "invalid" ? ["bathrooms"] : []),
  ];
  const listingMode = inferListingMode(values.listingMode, fullText, inferDwellingType(propertyType, fullText), values.sharedProperty);
  const dwellingType = inferDwellingType(propertyType, fullText);
  const couples = couplesEvidence(values.couplesAllowed, fullText, occupants.value);
  const availabilityText = [textValue(values.availability, 240), fullText].filter(Boolean).join(" ");
  const availability = availabilityEvidence(values.available ?? values.availability, availabilityText);
  const recordValue: RentalRecord = {
    provider,
    listing_id: listingId,
    canonical_url: url,
    title,
    address,
    postcode: postcodeFrom(`${textValue(values.postcode, 40) ?? ""} ${addressText} ${fullText}`),
    area: textValue(values.area, 120) ?? address,
    price_pcm: price,
    effective_price_pcm: effective,
    bedrooms,
    bathrooms,
    property_type: propertyType,
    furnishing: normalizeFurnishing(furnishingText),
    bills: bills,
    bills_surcharge_pcm: bills.surcharge_pcm,
    availability: textValue(values.availability, 180) ?? firstDate(fullText),
    available_from: availableFromText(values.availability, fullText),
    availability_details: availability,
    listed_at: textValue(values.listedAt, 100) ?? listedAtFromDays(values.listedDays, listedText),
    last_updated_at: textValue(values.lastUpdatedAt, 100) ?? updatedAtFromText(updatedText ?? listedText),
    last_updated_text: updatedText,
    listed_text: listedText,
    features: features.slice(0, 24),
    pets_allowed: petSignal(fullText),
    student_only: boolSignal(fullText, /students?\s+only|student\s+property/i, /not\s+student/i),
    retirement_only: boolSignal(fullText, /retirement|sheltered\s+housing/i, /not\s+retirement/i),
    shared_property: listingMode === "room_in_shared_property" ? true : listingMode === "whole_property" ? false : boolSignal(fullText, /house\s+share|flat\s+share|shared\s+property|room\s+to\s+rent|co[\s-]?living/i, /whole\s+property/i),
    listing_mode: listingMode,
    dwelling_type: dwellingType,
    max_occupants: occupants.value,
    occupancy: {
      max_occupants: occupants.value,
      couples_allowed: couples?.value ?? null,
      ...(couples ? { couples_confidence: couples.confidence, couples_source: couples.source } : {}),
    },
    couples_allowed: couples?.value ?? null,
    couples_confidence: couples?.confidence ?? "unknown",
    couples_source: couples?.source ?? null,
    ...(parseFailures.length ? { parse_failures: parseFailures } : {}),
    station_proximity_signal: stationSignal(fullText),
    description,
    image_url: absoluteUrl(values.imageUrl, sourceUrl),
    source: { retrieved_at: new Date().toISOString(), execution_mode: "public_http", trust: "external_untrusted" },
  };
  return normalizeRentalListing(recordValue);
}

function parseOtmItem(value: unknown, sourceUrl: string): RentalRecord | null {
  const object = record(value);
  if (!object) return null;
  const details = firstString(object["details-url"], object.detailsUrl, object.canonicalUrl, object.url, object.propertyLink);
  const id = firstString(object.id, object.propertyId, object.listingId, object["property-id"]) ?? extractNumericId(details);
  if (!id || !/^\d{5,}$/.test(id)) return null;
  const features = stringList(object.features, 24);
  const labels = stringList(object.propertyLabels, 12);
  const description = firstString(object.summary, object.description, object.propertyDescription, object.details);
  const address = firstString(object.address, object.displayAddress, object.addressLocality, object.location);
  const listedText = textValue(object["days-since-added-reduced"], 80) ?? firstString(object.listedText, object.recentlyAdded, object["recently-added"]);
  return commonRecord("onthemarket", id, cleanUrl(details, sourceUrl, "onthemarket") ?? `${OTM_SITE}/details/${id}/`, {
    title: firstString(object["property-title"], object.propertyTitle, object.title, object.humanisedPropertyType),
    address,
    area: firstString(object.addressLocality, object.area, object.location),
    price: object.price ?? object.priceRaw ?? object["short-price"],
    bedrooms: object.bedrooms,
    bathrooms: object.bathrooms,
    propertyType: firstString(object["humanised-property-type"], object.propertyType, object["property-type"]),
    furnishing: firstString(object.furnishing, object.furnished),
    availability: firstString(object.availability, object.availableFrom, object["available-from"]),
    listedText,
    listedDays: object["days-since-added-reduced"],
    listedAt: firstString(object.listedAt, object.listingCreatedAt, object.createdAt, object.dateAdded, object["date-added"]),
    lastUpdatedAt: firstString(object.lastUpdatedAt, object.updatedAt, object.dateUpdated, object["last-updated"]),
    features: [...features, ...labels],
    description,
    extraText: [object, labels],
    imageUrl: record(object["cover-image"])?.url ?? object["cover-image"],
    billsText: [description, features, labels, object],
    maxOccupants: object.maxOccupants ?? object.maxTenants ?? object.maximumTenants ?? object.maximumOccupants ?? object.maxResidents ?? object.tenantCapacity,
    couplesAllowed: object.couplesAllowed ?? object.couples ?? object.coupleAllowed,
    available: object.available,
  });
}

function parseOtmSearch(html: string, sourceUrl: string): { results: RentalRecord[]; explicitZero: boolean } {
  const next = parseNextData(html);
  const arrays = findArrays(next, ["list", "properties", "results"]);
  const records = arrays.flat().map((item) => parseOtmItem(item, sourceUrl)).filter((item): item is RentalRecord => Boolean(item));
  if (records.length) return { results: dedupeWithinProvider(records), explicitZero: false };
  const links = extractHrefLinks(html, /\/details\/\d+/i, sourceUrl);
  const fallback = links.map((link) => {
    const id = extractNumericId(link.href);
    if (!id) return null;
    const nearby = textWindow(html, link.index, 3200);
    return parseOtmItem({
      id,
      "details-url": link.href,
      "property-title": extractTagText(nearby, "h2") ?? extractTagText(nearby, "h3") ?? sanitizeText(link.html.replace(/<[^>]+>/g, " ")),
      address: extractTagText(nearby, "address") ?? extractTagText(nearby, "p"),
      "short-price": nearby,
      features: [...nearby.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => sanitizeText(match[1])).filter(Boolean),
      summary: nearby,
    }, sourceUrl);
  }).filter((item): item is RentalRecord => Boolean(item));
  return {
    results: dedupeWithinProvider(fallback),
    explicitZero: /(?:totalResults|total-results)["']?\s*[:=]\s*0|no\s+(?:properties|results)\s+(?:found|available)/i.test(html),
  };
}

function parseOtmDetail(html: string, sourceUrl: string, listingId: string): RentalRecord | null {
  const next = parseNextData(html);
  const object = findObjectById(next, listingId) ?? {};
  const parsed = parseOtmItem({ ...object, id: listingId, canonicalUrl: extractCanonical(html, sourceUrl) ?? object.canonicalUrl, summary: object.summary ?? extractMeta(html, "description"), propertyTitle: object.propertyTitle ?? extractTagText(html, "h1") }, sourceUrl);
  if (parsed) return parsed;
  const text = textFromHtml(html);
  return commonRecord("onthemarket", listingId, sourceUrl, {
    title: extractTagText(html, "h1") ?? extractMeta(html, "og:title"),
    address: extractMeta(html, "og:description"),
    price: text,
    description: extractMeta(html, "description") ?? text.slice(0, 1600),
    extraText: text,
    imageUrl: extractMeta(html, "og:image"),
    billsText: text,
  });
}

function listItems(html: string): string[] {
  return [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => sanitizeText(match[1], 160))
    .filter((item): item is string => Boolean(item))
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 30);
}

function featureItems(html: string): string[] {
  const heading = html.search(/>\s*Features\s*</i);
  const region = heading >= 0 ? html.slice(heading, Math.min(html.length, heading + 9000)) : html;
  return listItems(region).filter((item) => !/^(?:add listing|sign in|sign up|home|about|tenants?|landlords?|openrent|pricing|services?)$/i.test(item));
}

function htmlRowSignal(html: string, label: string): boolean | null {
  const index = html.search(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  if (index < 0) return null;
  const rowStart = Math.max(0, html.lastIndexOf("<tr", index));
  const rowEnd = html.indexOf("</tr>", index);
  const row = html.slice(rowStart, rowEnd >= 0 ? rowEnd : Math.min(html.length, index + 1800));
  if (/text-danger|(?:>\s*No\s*<)|(?:>\s*false\s*<)|\b(?:not\s+allowed|no|false)\b/i.test(row)) return false;
  if (/text-success|check/i.test(row) || /\b(?:yes|allowed|true)\b/i.test(row)) return true;
  return null;
}

function encodedPostcode(html: string): string | null {
  const match = /(?:postCode|postcode)=([A-Z]{1,2}\d[A-Z\d]?)(?:%20|\s+)(\d[A-Z]{2})/i.exec(html);
  return match ? `${match[1]} ${match[2]}`.toUpperCase() : null;
}

function parseOpenRentCard(link: { href: string; index: number; html: string }): RentalRecord | null {
  const id = link.href.match(/(?:\/|-)(\d{5,})(?:[/?#]|$)/)?.[1];
  if (!id) return null;
  const card = link.html;
  const cardText = sanitizeText(card, 4200) ?? "";
  const monthly = /£\s*[\d,]+(?:\.\d{1,2})?\s*(?:per\s+month|pcm|p\/m|monthly)/i.exec(cardText)?.[0];
  const features = listItems(card);
  return commonRecord("openrent", id, link.href, {
    title: extractTagText(card, "div", "fs-3") ?? extractTagText(card, "h2") ?? extractTagText(card, "h3"),
    address: extractTagText(card, "address"),
    price: monthly ?? cardText,
    bedrooms: /(?:^|\s)(\d+)\s+beds?/i.exec(cardText)?.[1],
    bathrooms: /(?:^|\s)(\d+)\s+baths?/i.exec(cardText)?.[1],
    propertyType: /\d+\s+bed\s+([^,]+)/i.exec(cardText)?.[1],
    furnishing: features.find((item) => /furnished/i.test(item)) ?? cardText,
    availability: /(?:available|available from)\s+([^.;]{3,50})/i.exec(cardText)?.[1],
    listedText: /last\s+updated[^<.;]{0,100}/i.exec(cardText)?.[0],
    features,
    description: extractTagText(card, "div", "line-clamp-2") ?? cardText.slice(0, 1200),
    extraText: cardText,
    imageUrl: /(?:src|data-src)=["']([^"']+)["']/i.exec(card)?.[1],
    billsText: cardText,
  });
}

function labelValue(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*[:\\-]?\\s*([^|;]{1,100}?)(?=\\b(?:Property Address|Available From|Preferred Minimum Tenancy|Furnishing|Pets Allowed|Student Friendly|Maximum Tenants|Max Tenants|Couples Allowed|Features|Bills Included|Last Updated|Listed|Added)\\b|$)`, "i").exec(text);
  return sanitizeText(match?.[1], 120);
}

function parseOpenRentDetail(html: string, sourceUrl: string, listingId: string): RentalRecord | null {
  const canonical = extractCanonical(html, sourceUrl) ?? sourceUrl;
  const text = sanitizeText(html, 14000) ?? "";
  const description = extractTagText(html, "div", "descriptionText") ?? extractMeta(html, "description") ?? text.slice(0, 1600);
  const title = extractTagText(html, "h1") ?? /Property:\s*([^|]+)/i.exec(extractMeta(html, "description") ?? "")?.[1] ?? extractMeta(html, "og:title");
  const priceIndex = html.search(/>\s*Price\s*&(?:amp;)?\s*Bills\s*</i);
  const priceRegion = priceIndex >= 0 ? textWindow(html, priceIndex, 2200) : extractMeta(html, "description") ?? text.slice(0, 2200);
  const features = featureItems(html);
  const address = labelValue(text, "Property Address") ?? extractTagText(html, "address");
  const available = labelValue(text, "Available From")?.replace(/\s+(?:Preferred Minimum Tenancy|Furnishing|Pets Allowed|Student Friendly|Features)\b[\s\S]*$/i, "") ?? /available\s+from\s+([^.;]{3,60})/i.exec(text)?.[1];
  const furnishing = labelValue(text, "Furnishing") ?? text;
  const pets = labelValue(text, "Pets Allowed");
  const maxTenants = labelValue(text, "Maximum Tenants") ?? labelValue(text, "Max Tenants") ?? /(?:\b(\d+)\s+tenants?\s+max\b)/i.exec(text)?.[1];
  const billsIncluded = htmlRowSignal(html, "Bills Included");
  const petsAllowed = htmlRowSignal(html, "Pets Allowed");
  const couplesAllowed = htmlRowSignal(html, "Couples Allowed") ?? htmlRowSignal(html, "Couples Welcome");
  const rentPcm = /Rent\s+PCM\s*£\s*[\d,]+(?:\.\d{1,2})?/i.exec(text)?.[0];
  return commonRecord("openrent", listingId, canonical, {
    title,
    address,
    postcode: encodedPostcode(html) ?? postcodeFrom(text),
    area: /(?:^|\s)([A-Z][A-Za-z' -]{2,40})\s+\d[A-Z]{2}\b/i.exec(text)?.[1] ?? undefined,
    price: rentPcm ?? (priceRegion || extractMeta(html, "description") || text),
    bedrooms: /(?:^|\s)(\d+)\s+bed(?:room)?s?/i.exec(`${title ?? ""} ${text}`)?.[1],
    bathrooms: /(?:^|\s)(\d+)\s+bath(?:room)?s?/i.exec(`${title ?? ""} ${text}`)?.[1],
    propertyType: /\d+\s+bed\s+([^,|]+)/i.exec(title ?? "")?.[1],
    furnishing,
    availability: available,
    listedText: /(?:listed|added|posted|created)[^.;]{0,100}/i.exec(text)?.[0],
    updatedText: /last\s+updated[^.;]{0,100}/i.exec(text)?.[0],
    features,
    description,
    extraText: [text, pets, billsIncluded === false ? "bills not included" : billsIncluded === true ? "bills included" : "", petsAllowed === false ? "no pets" : petsAllowed === true ? "pets allowed" : ""],
    imageUrl: extractMeta(html, "og:image"),
    billsText: [text, billsIncluded === false ? "bills not included" : billsIncluded === true ? "bills included" : ""],
    maxOccupants: maxTenants,
    couplesAllowed,
    available,
  });
}

function dedupeWithinProvider(results: RentalRecord[]): RentalRecord[] {
  const seen = new Set<string>();
  return results.filter((item) => {
    const key = `${item.provider}:${item.listing_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseRobots(text: string): RobotsBlock[] {
  const blocks: RobotsBlock[] = [];
  for (const rawBlock of text.split(/\n\s*\n/)) {
    const agents: string[] = [];
    const rules: RobotsRule[] = [];
    for (const rawLine of rawBlock.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const match = /^([^:]+):\s*(.*)$/i.exec(line);
      if (!match) continue;
      const key = match[1].trim().toLowerCase();
      const value = match[2].trim();
      if (key === "user-agent") agents.push(value.toLowerCase());
      if (key === "allow" || key === "disallow") rules.push({ path: value, allow: key === "allow" });
    }
    if (agents.length) blocks.push({ agents, rules });
  }
  return blocks;
}

function ruleMatches(rule: string, target: string): boolean {
  if (!rule) return false;
  const anchored = rule.endsWith("$");
  const source = (anchored ? rule.slice(0, -1) : rule).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try { return new RegExp(`^${source}${anchored ? "$" : ""}`).test(target); } catch { return false; }
}

export function robotsAllows(text: string, targetUrl: string, userAgent = AGENT_USER_AGENT): boolean {
  const blocks = parseRobots(text);
  const agentName = userAgent.toLowerCase();
  const applicable = blocks.filter((block) => block.agents.some((agent) => agent === "*" || agentName.includes(agent) || agent.includes("agentwebgateway")));
  const rules = applicable.flatMap((block) => block.rules);
  if (!rules.length) return true;
  let target: string;
  try {
    const url = new URL(targetUrl);
    target = `${url.pathname}${url.search}`;
  } catch {
    return false;
  }
  const matches = rules.filter((rule) => ruleMatches(rule.path, target));
  if (!matches.length) return true;
  const bestLength = Math.max(...matches.map((rule) => rule.path.length));
  const best = matches.filter((rule) => rule.path.length === bestLength);
  return best.some((rule) => rule.allow);
}

export function resetRentalCaches(): void {
  robotsCache.clear();
}

function robotsUrl(provider: RentalProvider): string {
  return `${provider === "onthemarket" ? OTM_SITE : OPENRENT_SITE}/robots.txt`;
}

async function robotsFor(provider: RentalProvider, context: ConnectorContext): Promise<RobotsBlock[]> {
  const cached = robotsCache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return cached.blocks;
  const url = robotsUrl(provider);
  try {
    const result = await fetchText(url, context, { headers: { "user-agent": AGENT_USER_AGENT }, accept: "text/plain" });
    const blocks = parseRobots(result.text);
    robotsCache.set(provider, { blocks, expiresAt: Date.now() + ROBOTS_TTL_MS });
    return blocks;
  } catch (unknownError) {
    if (unknownError instanceof GatewayError && unknownError.code === "NOT_FOUND") {
      robotsCache.set(provider, { blocks: [], expiresAt: Date.now() + ROBOTS_TTL_MS });
      return [];
    }
    throw new GatewayError("PROVIDER_RESTRICTED", `${provider} robots.txt could not be verified, so the gateway will not automate that provider.`, {
      retryable: true,
      mode: "public_http",
      sourceUrl: url,
      stage: "http",
      cause: unknownError,
    });
  }
}

async function fetchProviderHtml(provider: RentalProvider, url: string, context: ConnectorContext): Promise<{ html: string; url: string }> {
  const blocks = await robotsFor(provider, context);
  if (!robotsAllows(blocksToText(blocks), url)) {
    throw new GatewayError("PROVIDER_RESTRICTED", `${provider} robots.txt disallows the requested read-only search or detail path.`, { retryable: false, mode: "public_http", sourceUrl: url, stage: "http" });
  }
  try {
    const result = await fetchText(url, context, { headers: { "user-agent": AGENT_USER_AGENT } });
    if (isUpstreamChallenge(result.text)) throw new GatewayError("UPSTREAM_BLOCKED", `${provider} returned an automated-access challenge.`, { retryable: false, mode: "public_http", sourceUrl: result.url, stage: "http" });
    return { html: result.text, url: result.url };
  } catch (unknownError) {
    if (unknownError instanceof GatewayError) {
      throw new GatewayError(unknownError.code, unknownError.message, { retryable: unknownError.retryable, httpStatus: unknownError.httpStatus, mode: "public_http", sourceUrl: unknownError.sourceUrl ?? url, stage: unknownError.stage ?? "http", cause: unknownError });
    }
    throw new GatewayError("UPSTREAM_BLOCKED", `${provider} could not be reached from the gateway.`, { retryable: true, mode: "public_http", sourceUrl: url, stage: "http", cause: unknownError });
  }
}

function blocksToText(blocks: RobotsBlock[]): string {
  return blocks.map((block) => [
    ...block.agents.map((agent) => `User-agent: ${agent}`),
    ...block.rules.map((rule) => `${rule.allow ? "Allow" : "Disallow"}: ${rule.path}`),
  ].join("\n")).join("\n\n");
}

function searchUrl(provider: RentalProvider, location: string): string {
  const slug = slugify(location);
  return provider === "onthemarket" ? `${OTM_SITE}/to-rent/property/${slug}/` : `${OPENRENT_SITE}/properties-to-rent/${slug}`;
}

function providerFilterPlan(provider: RentalProvider, input: NormalRentalInput): string[] {
  if (provider !== "openrent") return [];
  const filters: string[] = [];
  if (input.min_price_pcm !== undefined) filters.push("min_price_pcm");
  if (input.max_price_pcm !== undefined) filters.push("max_price_pcm");
  if (input.min_bedrooms !== undefined) filters.push("min_bedrooms");
  if (input.max_bedrooms !== undefined) filters.push("max_bedrooms");
  if (input.property_type) filters.push("property_type");
  if (input.whole_property_only) filters.push("whole_property_only");
  return filters;
}

function providerSearchUrl(provider: RentalProvider, input: NormalRentalInput, pageNumber = 1): string {
  const url = new URL(searchUrl(provider, input.location));
  // OpenRent exposes these filters as query parameters on its public search
  // route.  Keep OnTheMarket's route unmodified because its robots rules and
  // URL contract are provider-specific; local verification remains mandatory.
  if (provider === "openrent") {
    if (input.min_price_pcm !== undefined) url.searchParams.set("minPrice", String(input.min_price_pcm));
    if (input.max_price_pcm !== undefined) url.searchParams.set("maxPrice", String(input.max_price_pcm));
    if (input.min_bedrooms !== undefined) url.searchParams.set("minBedrooms", String(input.min_bedrooms));
    if (input.max_bedrooms !== undefined) url.searchParams.set("maxBedrooms", String(input.max_bedrooms));
    if (input.property_type) url.searchParams.set("propertyType", input.property_type);
    if (input.whole_property_only) url.searchParams.set("listingType", "whole_property");
  }
  if (pageNumber > 1) url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

function paginationUrl(value: unknown, baseUrl: string, provider: RentalProvider): string | null {
  const candidate = absoluteUrl(value, baseUrl);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const validHost = provider === "onthemarket"
      ? url.hostname === "onthemarket.com" || url.hostname.endsWith(".onthemarket.com")
      : url.hostname === "openrent.co.uk" || url.hostname.endsWith(".openrent.co.uk");
    if (!validHost) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function nextPageUrl(provider: RentalProvider, html: string, currentUrl: string, pageNumber: number): string | null {
  // Inspect all same-page anchors because a provider may expose a rel="next"
  // link whose href has no explicit `page=` marker.
  const links = extractHrefLinks(html, /./i, currentUrl);
  for (const link of links) {
    if (!/(?:rel\s*=\s*["']?next|>\s*next\b|aria-label\s*=\s*["']?next)/i.test(link.html)) continue;
    const clean = paginationUrl(link.href, currentUrl, provider);
    if (clean && normaliseUrlForComparison(clean) !== normaliseUrlForComparison(currentUrl)) return clean;
  }
  for (const link of links) {
    try {
      const parsed = new URL(link.href, currentUrl);
      const page = Number(parsed.searchParams.get("page") ?? parsed.searchParams.get("p") ?? parsed.pathname.match(/\/page\/(\d+)/i)?.[1]);
      if (Number.isInteger(page) && page > pageNumber) return paginationUrl(parsed.toString(), currentUrl, provider);
    } catch {
      // Ignore malformed provider links.
    }
  }
  if (new RegExp(`(?:has[_-]?next(?:page)?|next[_-]?page)\\s*["']?\\s*[:=]\\s*(?:true|${pageNumber + 1})`, "i").test(html)) {
    const next = new URL(currentUrl);
    next.searchParams.set("page", String(pageNumber + 1));
    return next.toString();
  }
  return null;
}

function annotateSearchRecord(listing: RentalRecord, input: NormalRentalInput, pageNumber: number, position: number): RentalRecord {
  return normalizeRentalListing({
    ...listing,
    search_position: position,
    search_page: pageNumber,
    search_scope: {
      requested_location: input.location,
      provider_location_scope: input.location,
      scope_sufficient_for_query: true,
    },
    location: {
      display: input.location,
      normalized: normalizeLocationText(input.location),
      verified: true,
    },
  }, { locationVerified: true });
}

type ProviderSearchResult = {
  results: RentalRecord[];
  sourceUrl: string;
  outcome: "SUCCESS" | "ZERO_RESULTS";
  acquisition: RentalAcquisition;
};

async function providerSearch(provider: RentalProvider, input: NormalRentalInput, context: ConnectorContext): Promise<ProviderSearchResult> {
  const initialUrl = providerSearchUrl(provider, input, 1);
  const candidates: RentalRecord[] = [];
  let currentUrl = initialUrl;
  let pageNumber = 1;
  let paginationComplete = true;
  let terminationReason = "no_next_page";
  let explicitZero = false;
  let firstResolvedUrl = initialUrl;
  const wantsCompleteCoverage = input.objective_requested !== "none" || input.max_results > 10;
  while (pageNumber <= MAX_RENTAL_PAGES) {
    const page = await fetchProviderHtml(provider, currentUrl, context);
    if (pageNumber === 1) firstResolvedUrl = page.url;
    const parsed = provider === "onthemarket" ? parseOtmSearch(page.html, page.url) : {
      results: dedupeWithinProvider(extractHrefLinks(page.html, /\/property-to-rent\//i, page.url).map((link) => parseOpenRentCard(link)).filter((item): item is RentalRecord => Boolean(item))),
      explicitZero: /(?:no\s+properties|no\s+results)\s+(?:found|available)|0\s+properties/i.test(page.html),
    };
    explicitZero = explicitZero || parsed.explicitZero;
    candidates.push(...parsed.results.map((listing, index) => annotateSearchRecord(listing, input, pageNumber, candidates.length + index + 1)));
    const discoveredNext = nextPageUrl(provider, page.html, page.url, pageNumber);
    if (!discoveredNext) {
      paginationComplete = true;
      terminationReason = parsed.results.length ? "end_of_provider_results" : "no_next_page";
      break;
    }
    if (!wantsCompleteCoverage) {
      paginationComplete = false;
      terminationReason = "bounded_result_window";
      break;
    }
    if (pageNumber === MAX_RENTAL_PAGES) {
      paginationComplete = false;
      terminationReason = "max_pages";
      break;
    }
    paginationComplete = false;
    terminationReason = "next_page";
    pageNumber += 1;
    currentUrl = discoveredNext;
  }
  if (!candidates.length && !explicitZero) throw new GatewayError("UPSTREAM_CHANGED", `${provider} returned a page without a recognizable rental result feed.`, { retryable: true, mode: "public_http", sourceUrl: firstResolvedUrl, stage: "semantic" });
  const results = dedupeWithinProvider(candidates);
  return {
    results,
    sourceUrl: firstResolvedUrl,
    outcome: results.length ? "SUCCESS" : "ZERO_RESULTS",
    acquisition: {
      requested_url: initialUrl,
      provider_location_scope: input.location,
      pages_fetched: pageNumber,
      records_acquired: results.length,
      pagination_complete: paginationComplete,
      records_capped: !paginationComplete && terminationReason === "max_pages",
      termination_reason: terminationReason,
      provider_filters_applied: providerFilterPlan(provider, input),
    },
  };
}

async function providerDetail(provider: RentalProvider, listing: RentalRecord, context: ConnectorContext): Promise<{ listing: RentalRecord; sourceUrl: string }> {
  const id = String(listing.listing_id);
  const url = canonicalUrl(provider, id, listing.canonical_url);
  if (!url) throw new GatewayError("INPUT_INVALID", `${provider} requires the canonical listing URL returned by search for detail verification.`, { retryable: false, mode: "public_http", stage: "http" });
  const page = await fetchProviderHtml(provider, url, context);
  const parsed = provider === "onthemarket" ? parseOtmDetail(page.html, page.url, id) : parseOpenRentDetail(page.html, page.url, id);
  if (!parsed) throw new GatewayError("UPSTREAM_CHANGED", `${provider} detail page did not expose a valid listing record.`, { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
  return { listing: parsed, sourceUrl: page.url };
}

type NormalRentalInput = {
  location: string;
  max_results: number;
  providers: RentalProvider[];
  min_bedrooms?: number;
  max_bedrooms?: number;
  min_price_pcm?: number;
  max_price_pcm?: number;
  property_type?: string;
  furnishing?: string;
  bills_included?: boolean;
  pets_allowed?: boolean;
  available_before?: string;
  freshness_days?: number;
  couples_required: boolean;
  available_now: boolean;
  whole_property_only: boolean;
  sort_by: string;
  objective_requested: "none" | "cheapest" | "most_expensive" | "newest_listing";
  exclude_listing_ids: Set<string>;
  exclude_urls: Set<string>;
};

function normaliseUrlForComparison(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().toLowerCase();
  } catch {
    return null;
  }
}

function normaliseInput(input: JsonObject): NormalRentalInput {
  const providers = Array.isArray(input.providers)
    ? input.providers.filter((value): value is RentalProvider => RENTAL_PROVIDERS.includes(value as RentalProvider))
    : [...RENTAL_PROVIDERS];
  const ids = new Set(Array.isArray(input.exclude_listing_ids) ? input.exclude_listing_ids.map((value) => String(value).trim().toLowerCase()) : []);
  const urls = new Set(Array.isArray(input.exclude_urls) ? input.exclude_urls.map(normaliseUrlForComparison).filter((value): value is string => Boolean(value)) : []);
  const propertyType = typeof input.property_type === "string" ? input.property_type.toLowerCase().trim() : undefined;
  const sortByRaw = typeof input.sort_by === "string" ? input.sort_by.toLowerCase() : "relevance";
  const sortBy = sortByRaw === "freshest" || sortByRaw === "newest" ? "newest" : sortByRaw;
  const objectiveRequested: NormalRentalInput["objective_requested"] = sortBy === "price_asc"
    ? "cheapest"
    : sortBy === "price_desc"
      ? "most_expensive"
      : sortBy === "newest"
        ? "newest_listing"
        : "none";
  const implicitWholeProperty = propertyType !== "room"
    && (input.couples_required === true || Boolean(propertyType && /^(?:flat|apartment|house|maisonette|studio|bungalow)$/i.test(propertyType)));
  return {
    location: String(input.location).trim(),
    max_results: typeof input.max_results === "number" ? Math.min(20, Math.max(1, input.max_results)) : 10,
    providers,
    ...(typeof input.min_bedrooms === "number" ? { min_bedrooms: input.min_bedrooms } : {}),
    ...(typeof input.max_bedrooms === "number" ? { max_bedrooms: input.max_bedrooms } : {}),
    ...(typeof input.min_price_pcm === "number" ? { min_price_pcm: input.min_price_pcm } : {}),
    ...(typeof input.max_price_pcm === "number" ? { max_price_pcm: input.max_price_pcm } : {}),
    ...(propertyType ? { property_type: propertyType } : {}),
    ...(typeof input.furnishing === "string" ? { furnishing: input.furnishing } : {}),
    ...(typeof input.bills_included === "boolean" ? { bills_included: input.bills_included } : {}),
    ...(typeof input.pets_allowed === "boolean" ? { pets_allowed: input.pets_allowed } : {}),
    ...(typeof input.available_before === "string" ? { available_before: input.available_before } : {}),
    ...(typeof input.freshness_days === "number" ? { freshness_days: input.freshness_days } : {}),
    couples_required: input.couples_required === true,
    available_now: input.available_now === true,
    whole_property_only: input.whole_property_only === true || implicitWholeProperty,
    sort_by: sortBy,
    objective_requested: objectiveRequested,
    exclude_listing_ids: ids,
    exclude_urls: urls,
  };
}

function normalizedPropertyType(value: unknown): string | null {
  const text = textValue(value, 120)?.toLowerCase() ?? "";
  if (!text) return null;
  if (/maisonette/.test(text)) return "maisonette";
  if (/studio/.test(text)) return "studio";
  if (/flat|apartment/.test(text)) return "flat";
  if (/house|bungalow|terrace|detached|semi/.test(text)) return "house";
  if (/room/.test(text)) return "room";
  return text;
}

function stateForBoolean(actual: unknown, expected: boolean): RentalConstraintState {
  if (typeof actual !== "boolean") return "UNKNOWN";
  return actual === expected ? "MATCH" : "NO_MATCH";
}

function stateForBound(actual: unknown, expected: number | undefined, direction: "min" | "max"): RentalConstraintState {
  if (expected === undefined) return "MATCH";
  if (typeof actual !== "number" || !Number.isFinite(actual)) return "UNKNOWN";
  return direction === "min" ? actual >= expected ? "MATCH" : "NO_MATCH" : actual <= expected ? "MATCH" : "NO_MATCH";
}

function rentalAvailabilityState(listing: RentalRecord): RentalConstraintState {
  const details = record(listing.availability_details);
  const available = details?.available ?? listing.available;
  return typeof available === "boolean" ? (available ? "MATCH" : "NO_MATCH") : "UNKNOWN";
}

function rentalConstraintInput(input: NormalRentalInput | JsonObject): NormalRentalInput {
  return "exclude_listing_ids" in input && input.exclude_listing_ids instanceof Set ? input as NormalRentalInput : normaliseInput(input as JsonObject);
}

export function evaluateRentalConstraints(listingValue: RentalRecord, rawInput: NormalRentalInput | JsonObject): RentalConstraintEvaluation {
  const input = rentalConstraintInput(rawInput);
  const listing = normalizeRentalListing(listingValue);
  const states: Record<string, RentalConstraintState> = {};
  const id = String(listing.listing_id ?? "").toLowerCase();
  const url = normaliseUrlForComparison(listing.canonical_url);
  states.excluded = input.exclude_listing_ids.has(id) || Boolean(url && input.exclude_urls.has(url)) ? "NO_MATCH" : "MATCH";
  if (input.whole_property_only) {
    const mode = listing.listing_mode as RentalListingMode;
    states.whole_property = mode === "whole_property" ? "MATCH" : mode === "room_in_shared_property" ? "NO_MATCH" : "UNKNOWN";
  }
  if (input.property_type) {
    const requested = normalizedPropertyType(input.property_type);
    const actual = normalizedPropertyType(listing.dwelling_type ?? listing.property_type);
    states.property_type = !requested || !actual ? "UNKNOWN" : actual === requested || actual.includes(requested) || requested.includes(actual) ? "MATCH" : "NO_MATCH";
  }
  if (input.min_bedrooms !== undefined) states.min_bedrooms = stateForBound(listing.bedrooms, input.min_bedrooms, "min");
  if (input.max_bedrooms !== undefined) states.max_bedrooms = stateForBound(listing.bedrooms, input.max_bedrooms, "max");
  const rent = record(listing.rent);
  const rentAmount = typeof listing.effective_price_pcm === "number" ? listing.effective_price_pcm : typeof listing.price_pcm === "number" ? listing.price_pcm : null;
  const rentBasis = rent?.basis ?? listing.rent_basis;
  const wholePropertyPriceRequired = input.whole_property_only;
  const priceBasisState = wholePropertyPriceRequired && rentBasis !== "whole_property" ? rentBasis === "room" ? "NO_MATCH" : "UNKNOWN" : "MATCH";
  if (input.min_price_pcm !== undefined) states.min_price_pcm = priceBasisState === "MATCH" ? stateForBound(rentAmount, input.min_price_pcm, "min") : priceBasisState;
  if (input.max_price_pcm !== undefined) states.max_price_pcm = priceBasisState === "MATCH" ? stateForBound(rentAmount, input.max_price_pcm, "max") : priceBasisState;
  if (input.couples_required) states.couples = stateForBoolean(listing.couples_allowed, true);
  if (input.available_now) states.available = rentalAvailabilityState(listing);
  if (input.furnishing) states.furnishing = listing.furnishing === "unknown" ? "UNKNOWN" : listing.furnishing === input.furnishing ? "MATCH" : "NO_MATCH";
  if (input.bills_included !== undefined) {
    const classification = String(record(listing.bills)?.classification ?? "unknown");
    states.bills_included = classification === "unknown" ? "UNKNOWN" : input.bills_included ? classification === "all" ? "MATCH" : "NO_MATCH" : classification === "all" ? "NO_MATCH" : "MATCH";
  }
  if (input.pets_allowed !== undefined) states.pets_allowed = stateForBoolean(listing.pets_allowed, input.pets_allowed);
  if (input.available_before) {
    const availableFrom = listing.available_from ?? record(listing.availability_details)?.available_from ?? firstDate(String(listing.availability ?? ""));
    if (!availableFrom) states.available_before = "UNKNOWN";
    else {
      const parsed = Date.parse(String(availableFrom));
      states.available_before = Number.isFinite(parsed) ? String(availableFrom).slice(0, 10) <= input.available_before ? "MATCH" : "NO_MATCH" : "UNKNOWN";
    }
  }
  if (input.freshness_days !== undefined) {
    const parsed = Date.parse(String(listing.listed_at ?? ""));
    states.freshness = Number.isFinite(parsed) ? parsed >= Date.now() - input.freshness_days * 86_400_000 ? "MATCH" : "NO_MATCH" : "UNKNOWN";
  }
  if (input.location) states.location = locationMatches(input.location, listing);
  const failed = Object.entries(states).filter(([, state]) => state === "NO_MATCH").map(([key]) => key);
  const unknown = Object.entries(states).filter(([, state]) => state === "UNKNOWN").map(([key]) => key);
  const verified = record(listing.verification)?.status === "verified";
  const requiredStates = Object.entries(states).filter(([key]) => key !== "excluded");
  const exact = verified && states.excluded === "MATCH" && requiredStates.every(([, state]) => state === "MATCH");
  const status = exact ? "exact" : failed.length ? "filtered" : "unverified_candidate";
  return {
    states,
    failed_constraints: failed,
    unknown_constraints: unknown,
    exact,
    status,
    ...(failed[0] ? { reason: failed[0] } : unknown[0] ? { reason: `${unknown[0]}_unknown` } : {}),
  };
}

export function hardFilterReason(listing: RentalRecord, input: NormalRentalInput | JsonObject): string | null {
  const evaluation = evaluateRentalConstraints(listing, input);
  return evaluation.failed_constraints.find((value) => value !== "excluded") ?? (evaluation.failed_constraints.includes("excluded") ? "excluded_listing" : null);
}

function rankingReasons(listing: RentalRecord, input: NormalRentalInput, medianPrice: number | null): string[] {
  const reasons: string[] = [];
  const price = typeof listing.effective_price_pcm === "number" ? listing.effective_price_pcm : typeof listing.price_pcm === "number" ? listing.price_pcm : null;
  if (price !== null && medianPrice !== null && price < medianPrice) reasons.push(`£${Math.round(medianPrice - price)}/month below the eligible-result median`);
  if (typeof listing.listed_at === "string") {
    const listedAt = Date.parse(listing.listed_at);
    if (Number.isFinite(listedAt)) {
      const age = Math.max(0, Math.floor((Date.now() - listedAt) / 86400000));
      reasons.push(age <= 0 ? "added today" : age === 1 ? "added yesterday" : `added ${age} days ago`);
    }
  }
  if (input.furnishing && listing.furnishing === input.furnishing) reasons.push(String(input.furnishing).replace("_", " "));
  if (listing.station_proximity_signal) reasons.push(String(listing.station_proximity_signal));
  return reasons.slice(0, 4);
}

function rankListings(listings: RentalRecord[], input: NormalRentalInput): RentalRecord[] {
  const prices = listings.map((listing) => typeof listing.effective_price_pcm === "number" ? listing.effective_price_pcm : null).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const ranked: RentalRecord[] = listings.map((listing) => ({ ...listing, ranking_reasons: rankingReasons(listing, input, medianPrice) }));
  const priceOf = (listing: RentalRecord) => typeof listing.effective_price_pcm === "number" ? listing.effective_price_pcm : Number.POSITIVE_INFINITY;
  if (input.sort_by === "price_asc") ranked.sort((a, b) => priceOf(a) - priceOf(b));
  else if (input.sort_by === "price_desc") ranked.sort((a, b) => priceOf(b) - priceOf(a));
  else if (input.sort_by === "newest") ranked.sort((a, b) => {
    const aFresh = Date.parse(String(a.listed_at ?? ""));
    const bFresh = Date.parse(String(b.listed_at ?? ""));
    const aKnown = Number.isFinite(aFresh);
    const bKnown = Number.isFinite(bFresh);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return (bFresh - aFresh) || (priceOf(a) - priceOf(b));
  });
  else ranked.sort((a, b) => {
    const aFresh = a.listed_at ? Date.parse(String(a.listed_at)) : 0;
    const bFresh = b.listed_at ? Date.parse(String(b.listed_at)) : 0;
    return (bFresh - aFresh) || (priceOf(a) - priceOf(b));
  });
  return ranked;
}

export function rentalObjectiveVerified(listings: RentalRecord[], input: NormalRentalInput | JsonObject, coverageComplete: boolean): boolean {
  const normalized = rentalConstraintInput(input);
  if (normalized.objective_requested === "none") return true;
  if (!coverageComplete || !listings.length) return false;
  if (listings.some((listing) => record(listing.verification)?.status !== "verified")) return false;
  if (normalized.objective_requested === "newest_listing") {
    return listings.every((listing) => typeof listing.listed_at === "string" && Number.isFinite(Date.parse(listing.listed_at)));
  }
  if (normalized.objective_requested === "cheapest" || normalized.objective_requested === "most_expensive") {
    return listings.every((listing) => {
      const rent = record(listing.rent);
      return typeof listing.effective_price_pcm === "number"
        && rent?.basis !== "unknown"
        && (normalized.whole_property_only ? rent?.basis === "whole_property" : Boolean(rent?.basis));
    });
  }
  return false;
}

function providerError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof GatewayError) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "UPSTREAM_BLOCKED", message: "The rental provider could not be reached from the gateway.", retryable: true };
}

function reportProviderObservation(
  context: ConnectorContext,
  provider: RentalProvider,
  tool: "search_properties" | "get_listing",
  startedAt: string,
  trace: ReturnType<typeof createExecutionTrace>,
  mode: "public_http",
  outcome: "success" | "zero_results" | "error",
  errorCode?: GatewayError["code"],
): void {
  context.onProviderObservation?.({
    provider: "rentals",
    upstream_provider: provider,
    tool,
    startedAt,
    mode,
    outcome,
    ...(errorCode ? { errorCode } : {}),
    trace,
  });
}

type VerificationBatch = {
  verified: RentalRecord[];
  filtered: RentalRecord[];
  unverified: RentalRecord[];
  failed: RentalRecord[];
};

function candidateKey(listing: RentalRecord): string {
  return `${String(listing.provider ?? "unknown").toLowerCase()}:${String(listing.listing_id ?? "").toLowerCase()}`;
}

function pushDiagnostic(diagnostics: JsonObject, key: string, value: unknown, limit = 100): void {
  const current = Array.isArray(diagnostics[key]) ? diagnostics[key] : [];
  diagnostics[key] = [...current, value].slice(0, limit);
}

async function verifyFinalists(listings: RentalRecord[], input: NormalRentalInput, context: ConnectorContext, diagnostics: JsonObject): Promise<VerificationBatch> {
  const verificationTargets = listings.slice(0, MAX_RENTAL_DETAIL_VERIFICATIONS);
  const deferredTargets = listings.slice(MAX_RENTAL_DETAIL_VERIFICATIONS);
  const settled = await Promise.all(verificationTargets.map(async (listing): Promise<{ kind: "verified" | "filtered" | "unverified" | "failed"; listing: RentalRecord }> => {
    const provider = String(listing.provider) as RentalProvider;
    const childContext: ConnectorContext = { ...context, trace: createExecutionTrace() };
    const childStartedAt = new Date().toISOString();
    try {
      const detail = await providerDetail(provider, listing, childContext);
      markHttpSuccess(childContext);
      markSemanticValidation(childContext, "success");
      reportProviderObservation(childContext, provider, "get_listing", childStartedAt, childContext.trace!, "public_http", "success");
      const canonical = reconcileRentalListing(listing, detail.listing);
      const verified = normalizeRentalListing({
        ...canonical,
        verification: { status: "verified", retrieved_at: new Date().toISOString() },
      }, { locationVerified: record(canonical.location)?.verified === true || Boolean(record(listing.search_scope)?.scope_sufficient_for_query) });
      const evaluation = evaluateRentalConstraints(verified, input);
      verified.constraint_states = evaluation.states;
      verified.failed_constraints = evaluation.failed_constraints;
      verified.unknown_constraints = evaluation.unknown_constraints;
      const reconciliation = record(verified.reconciliation);
      if (Array.isArray(reconciliation?.conflicts)) for (const conflict of reconciliation.conflicts) pushDiagnostic(diagnostics, "price_bedroom_mode_conflicts", { provider: listing.provider, listing_id: listing.listing_id, field: conflict });
      for (const parseFailure of Array.isArray(verified.parse_failures) ? verified.parse_failures : []) pushDiagnostic(diagnostics, "invalid_parses", { provider: listing.provider, listing_id: listing.listing_id, field: parseFailure });
      const key = candidateKey(verified);
      diagnostics.constraints = { ...(record(diagnostics.constraints) ?? {}), [key]: evaluation.states };
      if (evaluation.status === "exact") return { kind: "verified", listing: verified };
      if (evaluation.status === "filtered") {
        pushDiagnostic(diagnostics, "filtered_out", { provider: listing.provider, listing_id: listing.listing_id, reason: `detail_${evaluation.reason ?? evaluation.failed_constraints[0] ?? "constraint"}`, constraint_states: evaluation.states });
        return { kind: "filtered", listing: { ...verified, verification: { status: "filtered", reason: evaluation.reason ?? evaluation.failed_constraints[0] ?? "constraint" } } };
      }
      pushDiagnostic(diagnostics, "unverified_candidates", { provider: listing.provider, listing_id: listing.listing_id, reason: evaluation.reason ?? "hard_constraint_unknown", unknown_constraints: evaluation.unknown_constraints, constraint_states: evaluation.states });
      return { kind: "unverified", listing: { ...verified, verification: { status: "unverified_candidate", reason: evaluation.reason ?? "hard_constraint_unknown" } } };
    } catch (error) {
      const failure = providerError(error);
      const gatewayError = error instanceof GatewayError ? error : new GatewayError("UPSTREAM_BLOCKED", failure.message, { retryable: failure.retryable, mode: "public_http", stage: "http" });
      markHttpFailure(childContext, gatewayError, gatewayError.stage === "semantic");
      reportProviderObservation(childContext, provider, "get_listing", childStartedAt, childContext.trace!, "public_http", "error", gatewayError.code);
      pushDiagnostic(diagnostics, "verification_failures", { provider: listing.provider, listing_id: listing.listing_id, ...failure });
      return { kind: "failed", listing: { ...listing, verification: { status: "failed", error_code: failure.code, message: failure.message } } };
    }
  }));
  const deferred = deferredTargets.map((listing) => {
    const normalized = normalizeRentalListing(listing);
    const evaluation = evaluateRentalConstraints(normalized, input);
    normalized.verification = { status: "unverified_candidate", reason: "detail_verification_budget_exhausted" };
    normalized.constraint_states = evaluation.states;
    normalized.failed_constraints = evaluation.failed_constraints;
    normalized.unknown_constraints = evaluation.unknown_constraints;
    pushDiagnostic(diagnostics, "unverified_candidates", {
      provider: listing.provider,
      listing_id: listing.listing_id,
      reason: "detail_verification_budget_exhausted",
      unknown_constraints: evaluation.unknown_constraints,
      constraint_states: evaluation.states,
    });
    return normalized;
  });
  return {
    verified: settled.filter((item) => item.kind === "verified").map((item) => item.listing),
    filtered: settled.filter((item) => item.kind === "filtered").map((item) => item.listing),
    unverified: [...settled.filter((item) => item.kind === "unverified").map((item) => item.listing), ...deferred],
    failed: settled.filter((item) => item.kind === "failed").map((item) => item.listing),
  };
}

function serializableRentalInput(input: NormalRentalInput): JsonObject {
  return {
    location: input.location,
    max_results: input.max_results,
    providers: input.providers,
    ...(input.min_bedrooms !== undefined ? { min_bedrooms: input.min_bedrooms } : {}),
    ...(input.max_bedrooms !== undefined ? { max_bedrooms: input.max_bedrooms } : {}),
    ...(input.min_price_pcm !== undefined ? { min_price_pcm: input.min_price_pcm } : {}),
    ...(input.max_price_pcm !== undefined ? { max_price_pcm: input.max_price_pcm } : {}),
    ...(input.property_type ? { property_type: input.property_type } : {}),
    ...(input.furnishing ? { furnishing: input.furnishing } : {}),
    ...(input.bills_included !== undefined ? { bills_included: input.bills_included } : {}),
    ...(input.pets_allowed !== undefined ? { pets_allowed: input.pets_allowed } : {}),
    ...(input.available_before ? { available_before: input.available_before } : {}),
    ...(input.freshness_days !== undefined ? { freshness_days: input.freshness_days } : {}),
    couples_required: input.couples_required,
    available_now: input.available_now,
    whole_property_only: input.whole_property_only,
    sort_by: input.sort_by,
    objective_requested: input.objective_requested,
    ...(input.exclude_listing_ids.size ? { exclude_listing_ids: [...input.exclude_listing_ids] } : {}),
    ...(input.exclude_urls.size ? { exclude_urls: [...input.exclude_urls] } : {}),
  };
}

function assertRentalOutputIntegrity(exactListings: RentalRecord[], filtered: RentalRecord[], failed: RentalRecord[], unverified: RentalRecord[] = []): void {
  const exactKeys = new Set(exactListings.map(candidateKey));
  const filteredKeys = new Set(filtered.map(candidateKey));
  const failedKeys = new Set(failed.map(candidateKey));
  const unverifiedKeys = new Set(unverified.map(candidateKey));
  const violations: string[] = [];
  for (const key of exactKeys) {
    if (filteredKeys.has(key)) violations.push(`${key}:exact_and_filtered`);
    if (failedKeys.has(key)) violations.push(`${key}:exact_and_failed`);
    if (unverifiedKeys.has(key)) violations.push(`${key}:exact_and_unverified`);
  }
  for (const listing of exactListings) {
    if (record(listing.verification)?.status !== "verified") violations.push(`${candidateKey(listing)}:unverified_exact`);
    if (listing.whole_property === true && listing.listing_mode !== "whole_property") violations.push(`${candidateKey(listing)}:whole_property_mode_conflict`);
    if (record(listing.rent)?.basis === "room" && listing.whole_property === true) violations.push(`${candidateKey(listing)}:room_price_for_property`);
    if (listing.couples_allowed === true && listing.couples_source === "maximum_occupants" && Array.isArray(listing.parse_failures) && listing.parse_failures.includes("max_occupants")) violations.push(`${candidateKey(listing)}:invalid_occupancy_couples`);
  }
  if (violations.length) throw new GatewayError("INTERNAL_ERROR", "Rental canonicalization invariant failed.", { retryable: false, mode: "public_http", stage: "semantic", details: { violations } });
}

async function searchProperties(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const normalizedInput = normaliseInput(input);
  const diagnostics: JsonObject = {
    normalized_intent: serializableRentalInput(normalizedInput),
    filtered_out: [],
    unverified_candidates: [],
    verification_failures: [],
    invalid_parses: [],
    price_bedroom_mode_conflicts: [],
    constraints: {},
    provider_acquisition: {},
  };
  const providerResults: RentalRecord[] = [];
  const providerStatus: JsonObject = {};
  const sourceUrls: string[] = [];
  const errors: GatewayError[] = [];
  type RentalAttempt = { provider: RentalProvider; result?: ProviderSearchResult; error?: unknown };
  const attempts: RentalAttempt[] = await Promise.all(normalizedInput.providers.map(async (provider): Promise<RentalAttempt> => {
    const childContext: ConnectorContext = { ...context, trace: createExecutionTrace() };
    const childStartedAt = new Date().toISOString();
    try {
      const result = await providerSearch(provider, normalizedInput, childContext);
      markHttpSuccess(childContext);
      markSemanticValidation(childContext, "success");
      reportProviderObservation(childContext, provider, "search_properties", childStartedAt, childContext.trace!, "public_http", result.outcome === "ZERO_RESULTS" ? "zero_results" : "success");
      return { provider, result };
    } catch (error) {
      const failure = providerError(error);
      const gatewayError = error instanceof GatewayError ? error : new GatewayError("UPSTREAM_BLOCKED", failure.message, { retryable: failure.retryable, mode: "public_http", stage: "http" });
      markHttpFailure(childContext, gatewayError, gatewayError.stage === "semantic");
      reportProviderObservation(childContext, provider, "search_properties", childStartedAt, childContext.trace!, "public_http", "error", gatewayError.code);
      if (error instanceof GatewayError) errors.push(error);
      return { provider, error };
    }
  }));
  for (const attempt of attempts) {
    if (attempt.result) {
      providerResults.push(...attempt.result.results);
      sourceUrls.push(attempt.result.sourceUrl);
      providerStatus[attempt.provider] = {
        status: attempt.result.outcome === "ZERO_RESULTS" ? "zero_results" : "success",
        result_count: attempt.result.results.length,
        execution_mode: "public_http",
        acquisition: attempt.result.acquisition,
        completeness_status: attempt.result.acquisition.pagination_complete ? "complete" : "partial",
      };
      (diagnostics.provider_acquisition as JsonObject)[attempt.provider] = attempt.result.acquisition;
    } else {
      const failure = providerError(attempt.error);
      providerStatus[attempt.provider] = { status: "error", ...failure, acquisition: { pages_fetched: 0, records_acquired: 0, pagination_complete: false, termination_reason: "provider_error", provider_filters_applied: providerFilterPlan(attempt.provider, normalizedInput) } };
      (diagnostics.provider_acquisition as JsonObject)[attempt.provider] = providerStatus[attempt.provider];
    }
  }
  if (!Object.values(providerStatus).some((value) => ["success", "zero_results"].includes(String(record(value)?.status)))) {
    throw errors[0] ?? new GatewayError("NO_VALID_RESULTS", "No enabled rental provider returned a usable listing result.", { retryable: false, mode: "public_http", stage: "semantic" });
  }
  const candidates = dedupeWithinProvider(providerResults);
  const plausible = candidates.filter((listing) => {
    const normalized = normalizeRentalListing(listing);
    const evaluation = evaluateRentalConstraints(normalized, normalizedInput);
    if (evaluation.failed_constraints.length) {
      pushDiagnostic(diagnostics, "filtered_out", { provider: listing.provider, listing_id: listing.listing_id, reason: evaluation.reason ?? evaluation.failed_constraints[0], constraint_states: evaluation.states });
      return false;
    }
    return true;
  });
  diagnostics.candidate_count = candidates.length;
  diagnostics.cheap_prefilter_count = plausible.length;
  const preRanked = rankListings(plausible, normalizedInput);
  const batch = await verifyFinalists(preRanked, normalizedInput, context, diagnostics);
  diagnostics.detail_fetch_count = Math.min(preRanked.length, MAX_RENTAL_DETAIL_VERIFICATIONS);
  diagnostics.canonical_verified_count = batch.verified.length;
  const filteredKeys = new Set(batch.filtered.map(candidateKey));
  const failedKeys = new Set(batch.failed.map(candidateKey));
  const unknownKeys = new Set(batch.unverified.map(candidateKey));
  const verifiedListings = rankListings(batch.verified, normalizedInput);
  const finalResults = verifiedListings.slice(0, normalizedInput.max_results);
  const providerSuccessful = Object.values(providerStatus).filter((value) => ["success", "zero_results"].includes(String(record(value)?.status)));
  const providerCoverageComplete = providerSuccessful.length > 0
    && providerSuccessful.length === normalizedInput.providers.length
    && providerSuccessful.every((value) => record(record(value)?.acquisition)?.pagination_complete === true);
  const detailCoverageComplete = batch.unverified.length === 0 && batch.failed.length === 0;
  const coverageComplete = providerCoverageComplete && detailCoverageComplete;
  const objectiveVerified = rentalObjectiveVerified(batch.verified, normalizedInput, coverageComplete);
  const hasUnresolved = batch.unverified.length > 0 || batch.failed.length > 0 || !coverageComplete;
  const answerState = finalResults.length
    ? normalizedInput.objective_requested === "newest_listing" && !objectiveVerified
      ? "qualifying_matches_objective_unverified"
      : hasUnresolved ? "partial" : "exact_match"
    : hasUnresolved ? "partial" : "no_exact_match";
  const answerReady = true;
  const agentAction = finalResults.length && !hasUnresolved ? "answer" : finalResults.length && normalizedInput.objective_requested === "newest_listing" && !objectiveVerified ? "answer" : "report_partial";
  const coverageSummary: JsonObject = {
    pages_fetched: providerSuccessful.reduce((sum: number, value) => sum + Number(record(record(value)?.acquisition)?.pages_fetched ?? 0), 0),
    listings_acquired: candidates.length,
    pagination_complete: providerCoverageComplete,
    provider_pagination_complete: providerCoverageComplete,
    detail_verification_complete: detailCoverageComplete,
    coverage_complete: coverageComplete,
    termination_reason: coverageComplete ? "all_providers_exhausted" : !providerCoverageComplete ? "bounded_partial" : "detail_verification_budget_or_failure",
    ...(preRanked.length > MAX_RENTAL_DETAIL_VERIFICATIONS ? { detail_verification_capped: true, detail_verification_budget: MAX_RENTAL_DETAIL_VERIFICATIONS } : {}),
    provider_filters_applied: Object.fromEntries(normalizedInput.providers.map((provider) => [provider, providerFilterPlan(provider, normalizedInput)])),
    location_scope: normalizedInput.location,
  };
  diagnostics.coverage = coverageSummary;
  const objectiveSummary: JsonObject = {
    objective_requested: normalizedInput.objective_requested,
    ranking_field: normalizedInput.objective_requested === "newest_listing" ? "listed_at" : normalizedInput.objective_requested === "cheapest" || normalizedInput.objective_requested === "most_expensive" ? "effective_price_pcm" : "relevance",
    objective_supported: normalizedInput.objective_requested !== "newest_listing" || batch.verified.some((listing) => typeof listing.listed_at === "string"),
    objective_verified: objectiveVerified,
  };
  diagnostics.objective = objectiveSummary;
  if (normalizedInput.objective_requested === "newest_listing" && !objectiveVerified) objectiveSummary.reason = "Reliable listing-created timestamps unavailable for the complete qualifying set.";
  const summary = finalResults.length
    ? normalizedInput.objective_requested === "newest_listing" && !objectiveVerified
      ? "Qualifying properties were found, but the gateway cannot reliably establish which was newly listed most recently."
      : hasUnresolved ? "Verified qualifying properties were found in bounded public-source coverage." : `Found ${finalResults.length} qualifying rental propert${finalResults.length === 1 ? "y" : "ies"}.`
    : hasUnresolved ? "No verified match was found in the searched coverage; some hard constraints or provider coverage could not be fully verified." : "No qualifying matches were found in the searched public sources.";
  const integrityExact = finalResults.filter((listing) => record(listing.verification)?.status === "verified");
  assertRentalOutputIntegrity(integrityExact, batch.filtered, batch.failed, batch.unverified);
  diagnostics.finalist_count = preRanked.length;
  diagnostics.exact_matches = finalResults.map((listing) => ({ provider: listing.provider, listing_id: listing.listing_id }));
  diagnostics.filtered_count = filteredKeys.size;
  diagnostics.failed_count = failedKeys.size;
  diagnostics.unknown_count = unknownKeys.size;
  return {
    data: {
      location: normalizedInput.location,
      filters: serializableRentalInput(normalizedInput),
      normalized_intent: diagnostics.normalized_intent,
      results: finalResults,
      exact_matches: finalResults.map((listing) => ({ provider: listing.provider, listing_id: listing.listing_id })),
      unverified_candidates: batch.unverified.slice(0, 20),
      providers: providerStatus,
      coverage: diagnostics.coverage,
      coverage_level: coverageComplete ? "complete_for_query" : "bounded_partial",
      coverage_confidence: coverageComplete ? "complete" : "partial",
      coverage_sufficient_for_superlative: coverageComplete,
      search_objective: normalizedInput.objective_requested,
      objective_requested: normalizedInput.objective_requested,
      objective_supported: objectiveSummary.objective_supported,
      objective_verified: objectiveVerified,
      answer_state: answerState,
      answer_ready: answerReady,
      agent_action: agentAction,
      summary,
      diagnostics,
    },
    sourceUrl: sourceUrls[0] ?? providerSearchUrl(normalizedInput.providers[0] ?? "onthemarket", normalizedInput),
    sourceProvider: "UK rentals (OnTheMarket, OpenRent)",
    mode: "public_http",
    retrievedAt: new Date().toISOString(),
    outcome: finalResults.length ? "SUCCESS" : "ZERO_RESULTS",
  };
}

async function getListing(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const provider = String(input.provider) as RentalProvider;
  const listingId = String(input.listing_id).trim();
  if (!RENTAL_PROVIDERS.includes(provider) || !listingId) throw new GatewayError("INPUT_INVALID", "provider and listing_id must identify an enabled rental provider and listing.");
  const url = canonicalUrl(provider, listingId, input.canonical_url);
  if (!url) throw new GatewayError("INPUT_INVALID", "OpenRent detail requires the canonical_url returned by rentals_search_properties; OnTheMarket IDs can be used directly.");
  const childContext: ConnectorContext = { ...context, trace: createExecutionTrace() };
  const childStartedAt = new Date().toISOString();
  let result;
  try {
    result = await providerDetail(provider, { provider, listing_id: listingId, canonical_url: url }, childContext);
    markHttpSuccess(childContext);
    markSemanticValidation(childContext, "success");
    reportProviderObservation(childContext, provider, "get_listing", childStartedAt, childContext.trace!, "public_http", "success");
  } catch (error) {
    const failure = error instanceof GatewayError ? error : new GatewayError("UPSTREAM_BLOCKED", "The rental provider could not be reached from the gateway.", { retryable: true, mode: "public_http", stage: "http", cause: error });
    markHttpFailure(childContext, failure, failure.stage === "semantic");
    reportProviderObservation(childContext, provider, "get_listing", childStartedAt, childContext.trace!, "public_http", "error", failure.code);
    throw error;
  }
  const verifiedListing = normalizeRentalListing({
    ...result.listing,
    verification: { status: "verified", retrieved_at: new Date().toISOString() },
  }, { locationVerified: record(result.listing.location)?.verified === true });
  return { data: { listing: verifiedListing }, sourceUrl: result.sourceUrl, sourceProvider: provider === "onthemarket" ? "OnTheMarket" : "OpenRent", mode: "public_http", retrievedAt: new Date().toISOString() };
}

export const rentalsConnector: SiteConnector = {
  provider: "rentals",
  async execute(tool, input, context) {
    if (tool === "search_properties") return searchProperties(input, context);
    if (tool === "get_listing") return getListing(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", `Rentals does not implement ${tool}.`);
  },
};
