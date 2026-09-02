import type { JsonObject } from "./gateway-contract";

const MAX_TEXT_LENGTH = 1200;

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&#([0-9]+);?/g, (_, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&(amp|apos|quot|lt|gt|nbsp|pound|ndash|mdash|rsquo|lsquo|rdquo|ldquo|eacute|aacute|ouml|uuml);/gi, (match, entity: string) => {
      const entities: Record<string, string> = {
        amp: "&",
        apos: "'",
        quot: '"',
        lt: "<",
        gt: ">",
        nbsp: " ",
        pound: "£",
        ndash: "–",
        mdash: "—",
        rsquo: "’",
        lsquo: "‘",
        rdquo: "”",
        ldquo: "“",
        eacute: "é",
        aacute: "á",
        ouml: "ö",
        uuml: "ü",
      };
      return entities[entity.toLowerCase()] ?? match;
    });
}

export function sanitizeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const text = decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

export function absoluteUrl(value: unknown, baseUrl: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function extractMeta(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
  const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
  return sanitizeText(pattern.exec(html)?.[1] ?? reversePattern.exec(html)?.[1]);
}

export function extractCanonical(html: string, baseUrl: string): string | null {
  const match = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i.exec(html)
    ?? /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i.exec(html);
  return absoluteUrl(match?.[1], baseUrl);
}

export function extractTagText(html: string, tag: string, classOrAttribute?: string): string | null {
  const suffix = classOrAttribute ? `[^>]*${classOrAttribute}[^>]*` : "[^>]*";
  const match = new RegExp(`<${tag}${suffix}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return sanitizeText(match?.[1]);
}

export function extractJsonLd(html: string): JsonObject[] {
  const objects: JsonObject[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const source = decodeHtmlEntities(match[1] ?? "").trim();
    if (!source) continue;
    try {
      const parsed: unknown = JSON.parse(source);
      collectObjects(parsed, objects);
    } catch {
      // Upstream JSON-LD is optional. The caller has bounded HTML fallbacks.
    }
  }
  return objects;
}

function collectObjects(value: unknown, output: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as JsonObject;
  output.push(object);
  for (const child of Object.values(object)) collectObjects(child, output);
}

export function objectsByType(objects: JsonObject[], types: string[]): JsonObject[] {
  const wanted = new Set(types.map((type) => type.toLowerCase()));
  return objects.filter((object) => {
    const value = object["@type"];
    const values = Array.isArray(value) ? value : [value];
    return values.some((entry) => typeof entry === "string" && wanted.has(entry.toLowerCase()));
  });
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return sanitizeText(value);
    if (Array.isArray(value)) {
      const item = firstString(...value);
      if (item) return item;
    }
  }
  return null;
}

export function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function firstInteger(...values: unknown[]): number | null {
  const number = firstNumber(...values);
  return number === null ? null : Math.round(number);
}

export function normalizeMoney(value: unknown, fallbackCurrency = "GBP"): { amount: number; currency: string } | null {
  if (typeof value === "number" && Number.isFinite(value)) return { amount: value, currency: fallbackCurrency };
  if (typeof value === "string") {
    const parsed = parseMoney(value, fallbackCurrency);
    if (parsed) return parsed;
  }
  if (value && typeof value === "object") {
    const object = value as JsonObject;
    const amount = firstNumber(object.amount, object.value, object.price, object.priceNumeral, object.numeral, object.minPrice, object.lowPrice);
    const currency = firstString(object.currency, object.currencyCode, object.priceCurrency) ?? fallbackCurrency;
    if (amount !== null) return { amount, currency: currency.toUpperCase() };
  }
  return null;
}

export function parseMoney(text: string, fallbackCurrency = "GBP"): { amount: number; currency: string } | null {
  const match = /(?:£|GBP\s*)([0-9][0-9,]*(?:\.\d{1,2})?)|(?:€|EUR\s*)([0-9][0-9,]*(?:\.\d{1,2})?)|(?:\$|USD\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/i.exec(text);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3];
  const amount = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const currency = match[1] ? "GBP" : match[2] ? "EUR" : "USD";
  return { amount, currency: currency || fallbackCurrency };
}

export function textWindow(html: string, index: number, radius = 1400): string {
  return sanitizeText(html.slice(Math.max(0, index - radius), Math.min(html.length, index + radius)), radius * 2) ?? "";
}

export function textFromHtml(html: string): string {
  return sanitizeText(html, 8000) ?? "";
}

export function extractHrefLinks(html: string, pattern: RegExp, baseUrl: string): Array<{ href: string; index: number; html: string }> {
  const links: Array<{ href: string; index: number; html: string }> = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const href = absoluteUrl(match[1], baseUrl);
    if (!href || !pattern.test(href)) continue;
    links.push({ href, index: match.index ?? 0, html: match[0] });
  }
  return links;
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function safeDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  return value;
}

export function extractNumericId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).match(/\d{5,}/);
  return match?.[0] ?? null;
}

export function isUpstreamChallenge(html: string): boolean {
  return /(captcha|verify you are human|access denied|cf-chl-|challenge-platform|unusual traffic|robot check)/i.test(html);
}

export function property(object: unknown, ...keys: string[]): unknown {
  if (!object || typeof object !== "object") return undefined;
  const record = object as JsonObject;
  for (const key of keys) if (key in record) return record[key];
  return undefined;
}
