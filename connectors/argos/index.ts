import type { JsonObject } from "../../lib/gateway-contract";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractCanonical,
  extractJsonLd,
  extractMeta,
  extractTagText,
  firstNumber,
  firstString,
  parseMoney,
  sanitizeText,
  slugify,
  textWindow,
} from "../../lib/upstream-parser";
import {
  fetchText,
  GatewayError,
  type ConnectorContext,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";
import { detectFrameworks, extractApiCandidates, extractEmbeddedState, rememberRecipe } from "../../lib/embedded-state";
import { robotsAllows } from "../rentals";
import { publicSearchCoverage, publicSearchCoverageFields } from "../../lib/commerce-coverage";

const ARGOS_SITE = "https://www.argos.co.uk";
const ARGOS_USER_AGENT = "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.djrookie99.chatgpt.site)";
const ARGOS_HOSTS = new Set(["argos.co.uk", "www.argos.co.uk"]);
const MEDIA_HOST_SUFFIX = ".4rgos.it";

type ArgosProduct = {
  product_id: string;
  name: string;
  price: { amount: number; currency: string } | null;
  rating: number | null;
  review_count: number | null;
  image_url: string | null;
  url: string;
  condition: "new";
  availability: string | null;
  delivery: string | null;
  description?: string | null;
  features?: string[];
};

export type ArgosResponseClassification =
  | "PRODUCT_PAGE"
  | "SEARCH_RESULTS"
  | "CHALLENGE_OR_BLOCK"
  | "INTERSTITIAL"
  | "GENERIC_ARGOS_PAGE"
  | "INVALID_RESPONSE";

type RobotsEntry = { expiresAt: number; text: string };
let cachedRobots: RobotsEntry | null = null;
const ROBOTS_TTL_MS = 30 * 60 * 1000;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function attr(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;
}

function productUrl(productId: string): string {
  return `${ARGOS_SITE}/product/${productId}`;
}

function cleanProductUrl(value: unknown, productId: string): string {
  const candidate = absoluteUrl(value, ARGOS_SITE);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (ARGOS_HOSTS.has(url.hostname.toLowerCase()) && new RegExp(`/product/${productId}(?:/|$)`, "i").test(url.pathname)) {
        url.search = "";
        url.hash = "";
        url.pathname = `/product/${productId}`;
        return url.toString();
      }
    } catch {
      // Use the known-safe canonical URL below.
    }
  }
  return productUrl(productId);
}

function safeImage(value: unknown): string | null {
  const candidate = absoluteUrl(typeof value === "string" ? decodeHtmlEntities(value) : value, ARGOS_SITE);
  if (!candidate) return null;
  try {
    const hostname = new URL(candidate).hostname.toLowerCase();
    return ARGOS_HOSTS.has(hostname) || hostname.endsWith(MEDIA_HOST_SUFFIX) ? candidate : null;
  } catch {
    return null;
  }
}

function productCardStarts(html: string): number[] {
  const starts: number[] = [];
  const pattern = /<(?:div|article)\b[^>]*(?:data-testid|data-test)=["']component-product-card["'][^>]*>/gi;
  for (const match of html.matchAll(pattern)) starts.push(match.index ?? 0);
  return starts.slice(0, 80);
}

function productIdFromCard(card: string): string | null {
  const id = /\bdata-product-id=["'](\d{4,14})["']/i.exec(card)?.[1]
    ?? /href=["'](?:https?:\/\/www\.argos\.co\.uk)?\/product\/(\d{4,14})(?:[/?#]|["'])/i.exec(card)?.[1];
  return id ?? null;
}

function productAnchor(card: string, productId: string): string | null {
  const tag = new RegExp(`<a\\b[^>]*href=["'](?:https?:\\/\\/(?:www\\.)?argos\\.co\\.uk)?\\/product\\/${productId}[^"']*["'][^>]*>`, "i").exec(card)?.[0];
  return tag ?? null;
}

function productTitle(card: string, productId: string): string | null {
  const anchor = productAnchor(card, productId);
  const image = /<img\b[^>]*>/i.exec(card)?.[0] ?? "";
  return sanitizeText(attr(anchor ?? "", "aria-label"), 260)
    ?? sanitizeText(attr(anchor ?? "", "title"), 260)
    ?? sanitizeText(attr(image, "alt"), 260)
    ?? sanitizeText(extractTagText(card, "h2"), 260)
    ?? sanitizeText(extractTagText(card, "h3"), 260);
}

function priceInRegion(region: string): { amount: number; currency: string } | null {
  const tag = /<[^>]*\bitemprop=["']price["'][^>]*>/i.exec(region)?.[0]
    ?? /<[^>]*\bdata-test=["']product-price-primary["'][^>]*>/i.exec(region)?.[0];
  if (tag) {
    const content = attr(tag, "content");
    const amount = content ? Number(content.replace(/,/g, "")) : NaN;
    if (Number.isFinite(amount) && amount >= 0) return { amount, currency: "GBP" };
  }
  return parseMoney(region, "GBP");
}

function ratingInRegion(region: string): number | null {
  const value = firstNumber(/\bdata-star-rating=["']([^"']+)["']/i.exec(region)?.[1]);
  if (value !== null && value >= 0 && value <= 5) return value;
  const match = /rating\s+([0-5](?:\.\d)?)\s+out\s+of\s+5/i.exec(sanitizeText(region, 3500) ?? "");
  return match ? Number(match[1]) : null;
}

function reviewCountInRegion(region: string): number | null {
  const match = /from\s+([\d,]+)\s+reviews?/i.exec(sanitizeText(region, 3500) ?? "");
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function cardToProduct(card: string): ArgosProduct | null {
  const id = productIdFromCard(card);
  const name = id ? productTitle(card, id) : null;
  if (!id || !name || name.length < 3 || /^(?:products?|search results?|argos)$/i.test(name)) return null;
  const image = /<img\b[^>]*>/i.exec(card)?.[0] ?? "";
  return {
    product_id: id,
    name,
    price: priceInRegion(card),
    rating: ratingInRegion(card),
    review_count: reviewCountInRegion(card),
    image_url: safeImage(attr(image, "src") ?? attr(image, "data-src")),
    url: productUrl(id),
    condition: "new",
    availability: null,
    delivery: null,
  };
}

function jsonLdProduct(html: string, expectedId?: string): ArgosProduct | null {
  const object = extractJsonLd(html).find((item) => {
    const type = item["@type"];
    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
    const url = typeof item.url === "string" ? item.url : "";
    return isProduct && (!expectedId || url.includes(`/product/${expectedId}`));
  });
  if (!object) return null;
  const id = expectedId ?? /\/product\/(\d{4,14})/i.exec(String(object.url ?? ""))?.[1];
  const name = firstString(object.name);
  if (!id || !name) return null;
  const offers = record(object.offers);
  const price = offers ? priceInRegion(JSON.stringify(offers)) : null;
  const aggregate = record(object.aggregateRating);
  return {
    product_id: id,
    name,
    price,
    rating: firstNumber(aggregate?.ratingValue),
    review_count: firstNumber(aggregate?.reviewCount, aggregate?.ratingCount),
    image_url: safeImage(Array.isArray(object.image) ? object.image[0] : object.image),
    url: productUrl(id),
    condition: "new",
    availability: firstString(offers?.availability),
    delivery: null,
  };
}

function explicitZero(html: string): boolean {
  const text = sanitizeText(html, 12000) ?? "";
  return /(?:no\s+(?:products?|results?)\s+(?:found|available)|0\s+(?:products?|results?)|couldn['’]?t\s+find)/i.test(text)
    || /\b(?:result|product)[^\d]{0,20}count[^\d]{0,10}["']?0\b/i.test(html);
}

function hasChallenge(html: string): boolean {
  const visible = sanitizeText(html, 12000) ?? "";
  return /(?:access\s+denied|automated\s+access|verify\s+you(?:'|’)re\s+human|robot\s+check|unusual\s+traffic|sorry,?\s+we\s+couldn['’]?t\s+find)/i.test(visible)
    || /(?:cf-chl-|challenge-platform|captcha[_-](?:input|challenge)|hcaptcha|recaptcha)/i.test(html);
}

function hasInterstitial(html: string): boolean {
  return /(?:enable\s+javascript|checking\s+your\s+browser|cookie\s+consent|before\s+you\s+continue|one\s+moment)/i.test(sanitizeText(html, 6000) ?? "")
    && !/component-product-card|data-product-id|itemprop=["']price/i.test(html);
}

export function classifyArgosResponse(html: string, expectedId?: string): ArgosResponseClassification {
  if (!html) return "INVALID_RESPONSE";
  if (hasChallenge(html)) return "CHALLENGE_OR_BLOCK";
  if (html.length < 180) return "INVALID_RESPONSE";
  if (hasInterstitial(html)) return "INTERSTITIAL";
  if (expectedId && (new RegExp(`/product/${expectedId}(?:/|["'])`, "i").test(html) || new RegExp(`data-product-id=["']${expectedId}["']`, "i").test(html)) && (extractTagText(html, "h1") || jsonLdProduct(html, expectedId))) return "PRODUCT_PAGE";
  if (/component-product-card|sai-product-data|\/search\//i.test(html)) return "SEARCH_RESULTS";
  if (/argos|product|search/i.test(sanitizeText(html, 3000) ?? "")) return "GENERIC_ARGOS_PAGE";
  return "INVALID_RESPONSE";
}

export function parseArgosSearch(html: string): { results: ArgosProduct[]; explicitZero: boolean; classification: ArgosResponseClassification; extraction_strategy: string; frameworks_detected: string[]; embedded_state_kinds: string[]; inline_api_candidate_count: number } {
  const classification = classifyArgosResponse(html);
  const framework = detectFrameworks(html);
  const states = extractEmbeddedState(html);
  const apiCandidates = extractApiCandidates(html, ARGOS_SITE);
  if (classification !== "SEARCH_RESULTS") return { results: [], explicitZero: explicitZero(html), classification, extraction_strategy: "none", frameworks_detected: framework.frameworks, embedded_state_kinds: [...new Set(states.map((state) => state.kind))], inline_api_candidate_count: apiCandidates.length };
  const starts = productCardStarts(html);
  const products: ArgosProduct[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < starts.length; index += 1) {
    const card = html.slice(starts[index], starts[index + 1] ?? Math.min(html.length, starts[index] + 24_000));
    const product = cardToProduct(card);
    if (product && !seen.has(product.product_id)) {
      seen.add(product.product_id);
      products.push({ ...product, url: cleanProductUrl(product.url, product.product_id) });
    }
    if (products.length >= 20) break;
  }
  return { results: products, explicitZero: explicitZero(html), classification, extraction_strategy: products.length ? "product_card" : "structured_search_shell", frameworks_detected: framework.frameworks, embedded_state_kinds: [...new Set(states.map((state) => state.kind))], inline_api_candidate_count: apiCandidates.length };
}

function detailTitle(html: string): string | null {
  const title = extractTagText(html, "h1") ?? extractMeta(html, "og:title") ?? extractTagText(html, "title");
  if (!title) return null;
  return sanitizeText(title.replace(/^buy\s+/i, "").replace(/\s*\|\s*argos.*$/i, ""), 260);
}

function detailPrice(html: string): { amount: number; currency: string } | null {
  const marker = /itemprop=["']price["'][^>]*|data-test=["']product-price-primary["']/i.exec(html);
  return marker ? priceInRegion(textWindow(html, marker.index, 900)) : null;
}

export function parseArgosDetail(html: string, sourceUrl: string, productId: string): ArgosProduct | null {
  if (classifyArgosResponse(html, productId) !== "PRODUCT_PAGE") return null;
  const title = detailTitle(html) ?? jsonLdProduct(html, productId)?.name;
  const canonical = extractCanonical(html, sourceUrl);
  if (!title || !canonical || !new RegExp(`/product/${productId}/?$`, "i").test(new URL(canonical).pathname)) return null;
  const productJson = jsonLdProduct(html, productId);
  const pageText = sanitizeText(textWindow(html, html.search(/data-product-id|itemprop=["']price/i), 4500), 4500) ?? "";
  const availability = /(?:out\s+of\s+stock|in\s+stock|check\s+stock|available\s+for\s+delivery)/i.exec(pageText)?.[0] ?? null;
  const description = extractMeta(html, "description");
  return {
    product_id: productId,
    name: title,
    price: detailPrice(html) ?? productJson?.price ?? null,
    rating: ratingInRegion(textWindow(html, html.search(/reviews?|rating/i), 1800)) ?? productJson?.rating ?? null,
    review_count: reviewCountInRegion(textWindow(html, html.search(/reviews?|rating/i), 1800)) ?? productJson?.review_count ?? null,
    image_url: safeImage(extractMeta(html, "og:image") ?? productJson?.image_url),
    url: productUrl(productId),
    condition: "new",
    availability,
    delivery: /delivery[^.]{0,120}/i.exec(pageText)?.[0] ?? null,
    description,
  };
}

async function robotsText(context: ConnectorContext): Promise<string> {
  if (cachedRobots && cachedRobots.expiresAt > Date.now()) return cachedRobots.text;
  try {
    const result = await fetchText(`${ARGOS_SITE}/robots.txt`, context, { headers: { "user-agent": ARGOS_USER_AGENT }, accept: "text/plain" });
    cachedRobots = { text: result.text, expiresAt: Date.now() + ROBOTS_TTL_MS };
    return result.text;
  } catch (error) {
    if (error instanceof GatewayError && error.code === "NOT_FOUND") {
      cachedRobots = { text: "", expiresAt: Date.now() + ROBOTS_TTL_MS };
      return "";
    }
    throw new GatewayError("PROVIDER_RESTRICTED", "Argos robots.txt could not be verified, so the gateway will not automate that provider.", { retryable: true, mode: "public_http", sourceUrl: `${ARGOS_SITE}/robots.txt`, stage: "http", cause: error });
  }
}

async function fetchArgosHtml(url: string, context: ConnectorContext): Promise<{ html: string; url: string }> {
  const rules = await robotsText(context);
  if (!robotsAllows(rules, url, ARGOS_USER_AGENT)) throw new GatewayError("PROVIDER_RESTRICTED", "Argos robots.txt disallows the requested read-only path.", { retryable: false, mode: "public_http", sourceUrl: url, stage: "http" });
  const result = await fetchText(url, context, { headers: { "user-agent": ARGOS_USER_AGENT } });
  return { html: result.text, url: result.url };
}

function publicHttpError(error: unknown, message: string, sourceUrl: string): GatewayError {
  if (error instanceof GatewayError) {
    return new GatewayError(error.code, error.message, { retryable: error.retryable, httpStatus: error.httpStatus, mode: "public_http", sourceUrl: error.sourceUrl ?? sourceUrl, stage: error.stage ?? "http", cause: error });
  }
  return new GatewayError("UPSTREAM_BLOCKED", message, { retryable: true, mode: "public_http", sourceUrl, stage: "http", cause: error });
}

async function searchProducts(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const url = `${ARGOS_SITE}/search/${slugify(String(input.query))}/`;
  try {
    const page = await fetchArgosHtml(url, context);
    const parsed = parseArgosSearch(page.html);
    if (parsed.classification === "CHALLENGE_OR_BLOCK") throw new GatewayError("UPSTREAM_BLOCKED", "Argos returned an automated-access challenge to the identified HTTP request.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
    if (parsed.classification === "INTERSTITIAL") throw new GatewayError("UPSTREAM_CHANGED", "Argos returned an interstitial instead of a product search result set.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    if (!parsed.results.length && !parsed.explicitZero) throw new GatewayError("UPSTREAM_CHANGED", "Argos returned a page without a recognizable validated product result set.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    const results = parsed.results.filter((product) => typeof input.max_price !== "number" || (product.price !== null && product.price.amount <= input.max_price)).slice(0, typeof input.max_results === "number" ? input.max_results : 20);
    if (results.length) {
      rememberRecipe({
        domain: "argos.co.uk",
        capability: "commerce.search",
        execution_mode: "public_http",
        request: { method: "GET", url_template: "https://www.argos.co.uk/search/{query}/" },
        parser: "argos_product_cards_v1",
        validator: "validArgosProduct",
        last_verified_at: new Date().toISOString(),
      });
    }
    const coverage = publicSearchCoverage({
      platform: "argos",
      route: "argos_search_html",
      strategy: "argos_search_html_product_cards",
      query: input.query,
      records_acquired: parsed.results.length,
      pages_fetched: 1,
      pagination_complete: false,
      records_capped: parsed.results.length >= 20,
      termination_reason: "query_results",
      max_pages: 1,
      max_products: 20,
      max_requests: 1,
      coverage_level: "bounded_partial",
      coverage_reason: "targeted_search_results_not_catalogue_complete",
      currency: input.currency,
      locale: input.locale,
    });
    return {
      data: {
        query: input.query,
        results,
        search_objective: typeof input.search_objective === "string" ? input.search_objective : "discovery",
        ...publicSearchCoverageFields(coverage),
        diagnostics: {
          response_classification: parsed.classification,
          extraction_strategy: parsed.extraction_strategy,
          frameworks_detected: parsed.frameworks_detected,
          embedded_state_kinds: parsed.embedded_state_kinds,
          inline_api_candidate_count: parsed.inline_api_candidate_count,
          acquisition: coverage.acquisition,
          route_context: coverage.route_context,
        },
      },
      sourceUrl: page.url,
      mode: "public_http",
      outcome: results.length ? "SUCCESS" : "ZERO_RESULTS",
    };
  } catch (error) {
    throw publicHttpError(error, "Argos catalogue search could not be reached from the gateway.", url);
  }
}

async function getProduct(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const productId = String(input.product_id ?? "").trim();
  if (!/^\d{4,14}$/.test(productId)) throw new GatewayError("INPUT_INVALID", "product_id must be an Argos UK product ID.");
  const url = productUrl(productId);
  try {
    const page = await fetchArgosHtml(url, context);
    const classification = classifyArgosResponse(page.html, productId);
    if (classification === "CHALLENGE_OR_BLOCK") throw new GatewayError("UPSTREAM_BLOCKED", "Argos returned an automated-access challenge to the identified HTTP request.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
    const product = parseArgosDetail(page.html, page.url, productId);
    if (!product) throw new GatewayError("UPSTREAM_CHANGED", "Argos did not expose a valid product record for this ID.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    rememberRecipe({
      domain: "argos.co.uk",
      capability: "commerce.detail",
      execution_mode: "public_http",
      request: { method: "GET", url_template: "https://www.argos.co.uk/product/{product_id}" },
      parser: "argos_product_detail_v1",
      validator: "validArgosProduct",
      last_verified_at: new Date().toISOString(),
    });
    const framework = detectFrameworks(page.html);
    const states = extractEmbeddedState(page.html);
    return { data: { product, diagnostics: { response_classification: classification, extraction_strategy: "structured_product_data_then_product_markup", frameworks_detected: framework.frameworks, embedded_state_kinds: [...new Set(states.map((state) => state.kind))], inline_api_candidate_count: extractApiCandidates(page.html, page.url).length } }, sourceUrl: page.url, mode: "public_http" };
  } catch (error) {
    throw publicHttpError(error, "Argos product detail could not be reached from the gateway.", url);
  }
}

export function resetArgosCaches(): void {
  cachedRobots = null;
}

export const argosConnector: SiteConnector = {
  provider: "argos",
  async execute(tool, input, context) {
    if (tool === "search_products") return searchProducts(input, context);
    if (tool === "get_product") return getProduct(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", `Argos does not implement ${tool}.`);
  },
};
