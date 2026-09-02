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
  normalizeMoney,
  parseMoney,
  sanitizeText,
} from "../../lib/upstream-parser";
import {
  fetchText,
  GatewayError,
  type ConnectorContext,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";
import { detectFrameworks, discoverScriptUrls, extractApiCandidates, extractEmbeddedState, findEmbeddedObjects, rememberRecipe } from "../../lib/embedded-state";
import { recordExtractionBenchmark } from "../../lib/extraction-benchmark";
import { publicSearchCoverage, publicSearchCoverageFields } from "../../lib/commerce-coverage";
import { robotsAllows } from "../rentals";

const JOHN_LEWIS_SITE = "https://www.johnlewis.com";
const JOHN_LEWIS_USER_AGENT = "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.danemcgibbon.workers.dev)";
const JOHN_LEWIS_HOSTS = new Set(["johnlewis.com", "www.johnlewis.com"]);
const JOHN_LEWIS_MEDIA_HOSTS = new Set(["media.johnlewiscontent.com"]);
const ROBOTS_TTL_MS = 30 * 60 * 1000;

type JohnLewisProduct = {
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

export type JohnLewisResponseClassification =
  | "PRODUCT_PAGE"
  | "SEARCH_RESULTS"
  | "CHALLENGE_OR_BLOCK"
  | "INTERSTITIAL"
  | "GENERIC_JOHN_LEWIS_PAGE"
  | "INVALID_RESPONSE";

let cachedRobots: { expiresAt: number; text: string } | null = null;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function productIdFrom(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (/^\d{5,12}$/.test(raw)) return raw;
  try {
    const url = new URL(raw, JOHN_LEWIS_SITE);
    const match = /(?:^|\/)p(\d{5,12})\/?$/i.exec(url.pathname) ?? /\/product\/p(\d{5,12})\/?$/i.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function cleanProductUrl(value: unknown, productId: string): string | null {
  const candidate = absoluteUrl(value, JOHN_LEWIS_SITE);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!JOHN_LEWIS_HOSTS.has(url.hostname.toLowerCase())) return null;
    const pathId = productIdFrom(url.toString());
    if (pathId !== productId) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function productLookupUrl(productId: string): string {
  // This stable ID route redirects to the current canonical slug/variant URL.
  return `${JOHN_LEWIS_SITE}/product/p${productId}`;
}

function safeImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = absoluteUrl(decodeHtmlEntities(value), JOHN_LEWIS_SITE);
  if (!candidate) return null;
  try {
    const hostname = new URL(candidate).hostname.toLowerCase();
    return JOHN_LEWIS_HOSTS.has(hostname) || JOHN_LEWIS_MEDIA_HOSTS.has(hostname) ? candidate : null;
  } catch {
    return null;
  }
}

function priceFrom(value: unknown): { amount: number; currency: string } | null {
  const object = record(value);
  if (!object) return normalizeMoney(value, "GBP");
  const direct = normalizeMoney(object.amount ?? object.price ?? object.currentPrice ?? object.sellingPrice ?? object.displayPrice ?? object.display ?? object.formatted, "GBP");
  if (direct) return direct;
  const range = record(object.value) ?? record(object.priceRange) ?? record(object.range);
  const min = normalizeMoney(range?.min ?? range?.low ?? object.min ?? object.low ?? object.amount ?? object.price ?? object.display, "GBP");
  const max = normalizeMoney(range?.max ?? range?.high ?? object.max ?? object.high, "GBP");
  if (!min || (max && max.amount !== min.amount)) return null;
  return min;
}

function featureList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((item) => {
    const object = record(item);
    const name = firstString(object?.displayName, object?.name, object?.key);
    const values = Array.isArray(object?.values) ? object.values : object?.value ? [object.value] : [];
    const joined = values.map((entry) => sanitizeText(entry, 160)).filter((entry): entry is string => Boolean(entry)).join(": ");
    const result = name && joined ? `${name}: ${joined}` : name ?? joined;
    return result ? [result] : [];
  });
}

function productFromObject(value: Record<string, unknown>): JohnLewisProduct | null {
  const productId = productIdFrom(value.productId ?? value.product_id ?? value.id ?? value.url);
  const name = firstString(value.title, value.name, value.productName);
  const url = cleanProductUrl(value.url ?? value.canonicalUrl ?? value.productUrl, productId ?? "");
  if (!productId || !name || name.length < 3 || !url) return null;
  const reviewsObject = record(value.reviewSummary ?? value.reviews);
  const availability = value.outOfStock === true
    ? "out of stock"
    : value.isAvailableToOrder === true
      ? "available to order"
      : null;
  return {
    product_id: productId,
    name,
    price: priceFrom(value.variantPriceRange ?? value.price ?? value.priceRange),
    rating: firstNumber(value.averageRating, value.rating, reviewsObject?.averageRating, reviewsObject?.rating),
    review_count: firstNumber(value.reviews, value.reviewCount, reviewsObject?.count, reviewsObject?.reviewCount),
    image_url: safeImage(value.image ?? value.image_url ?? value.imageUrl),
    url,
    condition: "new",
    availability,
    delivery: firstString(value.delivery, value.deliverySummary),
    description: firstString(value.description, value.productDescription, value.longDescription),
    features: featureList(value.attributes),
  };
}

function jsonLdProducts(html: string): JohnLewisProduct[] {
  return extractJsonLd(html).flatMap((object) => {
    const type = object["@type"];
    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
    return isProduct ? productFromObject({ ...object, productId: object.productID ?? object.sku, url: object.url }) ?? [] : [];
  }).slice(0, 20);
}

function embeddedProducts(html: string): JohnLewisProduct[] {
  const states = extractEmbeddedState(html);
  return findEmbeddedObjects(states, (object) => Boolean(productIdFrom(object.productId ?? object.product_id ?? object.id ?? object.url)) && Boolean(firstString(object.title, object.name, object.productName)) && Boolean(object.url || object.canonicalUrl || object.productUrl), 30)
    .map((object) => productFromObject(object))
    .filter((product): product is JohnLewisProduct => Boolean(product));
}

function dedupe(products: JohnLewisProduct[]): JohnLewisProduct[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    if (seen.has(product.product_id)) return false;
    seen.add(product.product_id);
    return true;
  }).slice(0, 20);
}

function diagnostics(html: string, sourceUrl: string): JsonObject {
  const framework = detectFrameworks(html);
  const states = extractEmbeddedState(html);
  return {
    frameworks_detected: framework.frameworks,
    rendering_detected: framework.rendering,
    embedded_state_kinds: [...new Set(states.map((state) => state.kind))],
    same_origin_script_count: discoverScriptUrls(html, sourceUrl).length,
    inline_api_candidate_count: extractApiCandidates(html, sourceUrl).length,
  };
}

function challenge(html: string): boolean {
  const visible = sanitizeText(html, 10000) ?? "";
  return /(?:access denied|automated access|verify you(?:'|’)re human|robot check|unusual traffic|hang on[,!]?\s*(?:we're|we are) checking)/i.test(visible)
    || /(?:cf-chl-|challenge-platform|captcha[_-](?:input|challenge)|hcaptcha|recaptcha)/i.test(html);
}

function explicitZero(html: string): boolean {
  return /(?:no products found|no results|0 results|couldn['’]?t find)/i.test(sanitizeText(html, 10000) ?? "");
}

export function classifyJohnLewisResponse(html: string, expectedId?: string): JohnLewisResponseClassification {
  if (!html) return "INVALID_RESPONSE";
  if (challenge(html)) return "CHALLENGE_OR_BLOCK";
  if (html.length < 180) return "INVALID_RESPONSE";
  const hasProduct = expectedId
    ? Boolean(cleanProductUrl(extractCanonical(html, JOHN_LEWIS_SITE), expectedId) || new RegExp(`/p${expectedId}(?:/|["'])`, "i").test(html)) && Boolean(extractTagText(html, "h1") || embeddedProducts(html).length)
    : false;
  if (hasProduct) return "PRODUCT_PAGE";
  if (embeddedProducts(html).length || /itemListElement|productId|data-product-id|search-results/i.test(html) || explicitZero(html)) return "SEARCH_RESULTS";
  if (/(?:john lewis|product|search)/i.test(sanitizeText(html, 3000) ?? "")) return "GENERIC_JOHN_LEWIS_PAGE";
  return "INVALID_RESPONSE";
}

function detailFallback(html: string, sourceUrl: string, productId: string): JohnLewisProduct | null {
  const canonical = cleanProductUrl(extractCanonical(html, sourceUrl), productId);
  const title = sanitizeText(extractTagText(html, "h1") ?? extractMeta(html, "og:title"), 260);
  if (!canonical || !title) return null;
  const priceMatch = /(?:itemprop=["']price["'][^>]*(?:content|value)=["']([^"']+)|(?:content|value)=["']([^"']+)["'][^>]*itemprop=["']price["'])/i.exec(html);
  const explicitPrice = priceMatch?.[1] ?? priceMatch?.[2]
    ?? /data-testid=["'][^"']*price[^"']*["'][^>]*>([\s\S]{0,120})<\//i.exec(html)?.[1];
  const price = explicitPrice ? normalizeMoney(explicitPrice, "GBP") ?? parseMoney(explicitPrice, "GBP") : null;
  return {
    product_id: productId,
    name: title,
    price,
    rating: null,
    review_count: null,
    image_url: safeImage(extractMeta(html, "og:image")),
    url: canonical,
    condition: "new",
    availability: null,
    delivery: null,
    description: extractMeta(html, "description"),
  };
}

async function robotsText(context: ConnectorContext): Promise<string> {
  if (cachedRobots && cachedRobots.expiresAt > Date.now()) return cachedRobots.text;
  try {
    const result = await fetchText(`${JOHN_LEWIS_SITE}/robots.txt`, context, { headers: { "user-agent": JOHN_LEWIS_USER_AGENT }, accept: "text/plain" });
    cachedRobots = { text: result.text, expiresAt: Date.now() + ROBOTS_TTL_MS };
    return result.text;
  } catch (error) {
    if (error instanceof GatewayError && error.code === "NOT_FOUND") {
      cachedRobots = { text: "", expiresAt: Date.now() + ROBOTS_TTL_MS };
      return "";
    }
    throw new GatewayError("PROVIDER_RESTRICTED", "John Lewis robots.txt could not be verified, so the gateway will not automate that provider.", { retryable: true, mode: "public_http", sourceUrl: `${JOHN_LEWIS_SITE}/robots.txt`, stage: "http", cause: error });
  }
}

async function fetchJohnLewisHtml(url: string, context: ConnectorContext): Promise<{ html: string; url: string }> {
  const rules = await robotsText(context);
  if (!robotsAllows(rules, url, JOHN_LEWIS_USER_AGENT)) throw new GatewayError("PROVIDER_RESTRICTED", "John Lewis robots.txt disallows the requested read-only path.", { retryable: false, mode: "public_http", sourceUrl: url, stage: "http" });
  const result = await fetchText(url, context, { headers: { "user-agent": JOHN_LEWIS_USER_AGENT } });
  return { html: result.text, url: result.url };
}

function publicHttpError(error: unknown, message: string, sourceUrl: string): GatewayError {
  if (error instanceof GatewayError) return new GatewayError(error.code, error.message, { retryable: error.retryable, httpStatus: error.httpStatus, mode: "public_http", sourceUrl: error.sourceUrl ?? sourceUrl, stage: error.stage ?? "http", cause: error });
  return new GatewayError("UPSTREAM_BLOCKED", message, { retryable: true, mode: "public_http", sourceUrl, stage: "http", cause: error });
}

async function searchProducts(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const url = new URL(`${JOHN_LEWIS_SITE}/search`);
  url.searchParams.set("search-term", String(input.query));
  try {
    const page = await fetchJohnLewisHtml(url.toString(), context);
    const classification = classifyJohnLewisResponse(page.html);
    if (classification === "CHALLENGE_OR_BLOCK") throw new GatewayError("UPSTREAM_BLOCKED", "John Lewis returned an automated-access challenge to the identified HTTP request.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
    if (classification === "INTERSTITIAL") throw new GatewayError("UPSTREAM_CHANGED", "John Lewis returned an interstitial instead of product search results.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    if (classification !== "SEARCH_RESULTS") throw new GatewayError("UPSTREAM_CHANGED", "John Lewis returned a generic or invalid page instead of product search results.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    const products = dedupe([...embeddedProducts(page.html), ...jsonLdProducts(page.html)]);
    const filtered = products.filter((product) => typeof input.max_price !== "number" || (product.price !== null && product.price.amount <= input.max_price)).slice(0, typeof input.max_results === "number" ? input.max_results : 20);
    if (!filtered.length && !explicitZero(page.html)) throw new GatewayError("UPSTREAM_CHANGED", "John Lewis returned a search page without validated product records.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    recordExtractionBenchmark({ provider: "johnlewis", surface: "search", html: page.html, records: products, validRecords: filtered, startedAt: context.startedAt, extractionStrategy: "next_data_then_json_ld" });
    if (filtered.length) rememberRecipe({ domain: "johnlewis.com", capability: "commerce.search", execution_mode: "public_http", request: { method: "GET", url_template: "https://www.johnlewis.com/search?search-term={query}" }, parser: "johnlewis_next_data_products_v1", validator: "validJohnLewisProduct", last_verified_at: new Date().toISOString() });
    const coverage = publicSearchCoverage({
      platform: "johnlewis",
      route: "johnlewis_search_html",
      strategy: "johnlewis_search_html_embedded_state",
      query: input.query,
      records_acquired: products.length,
      pages_fetched: 1,
      pagination_complete: false,
      records_capped: products.length >= 20,
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
        results: filtered,
        search_objective: typeof input.search_objective === "string" ? input.search_objective : "discovery",
        ...publicSearchCoverageFields(coverage),
        diagnostics: {
          response_classification: classification,
          extraction_strategy: "next_data_then_json_ld",
          ...diagnostics(page.html, page.url),
          acquisition: coverage.acquisition,
          route_context: coverage.route_context,
        },
      },
      sourceUrl: page.url,
      mode: "public_http",
      outcome: filtered.length ? "SUCCESS" : "ZERO_RESULTS",
    };
  } catch (error) {
    throw publicHttpError(error, "John Lewis product search could not be reached from the gateway.", url.toString());
  }
}

async function getProduct(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const productId = productIdFrom(input.product_id);
  if (!productId) throw new GatewayError("INPUT_INVALID", "product_id must be a John Lewis numeric product ID or supported product URL.");
  const requestedUrl = cleanProductUrl(input.product_id, productId) ?? productLookupUrl(productId);
  try {
    const page = await fetchJohnLewisHtml(requestedUrl, context);
    const classification = classifyJohnLewisResponse(page.html, productId);
    if (classification === "CHALLENGE_OR_BLOCK") throw new GatewayError("UPSTREAM_BLOCKED", "John Lewis returned an automated-access challenge to the identified HTTP request.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
    if (classification !== "PRODUCT_PAGE") throw new GatewayError("UPSTREAM_CHANGED", "John Lewis returned a generic or invalid page instead of this product.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    const product = dedupe([...embeddedProducts(page.html), ...jsonLdProducts(page.html)]).find((item) => item.product_id === productId) ?? detailFallback(page.html, page.url, productId);
    if (!product) throw new GatewayError("UPSTREAM_CHANGED", "John Lewis did not expose a valid product record for this ID.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic" });
    recordExtractionBenchmark({ provider: "johnlewis", surface: "detail", html: page.html, records: [product], validRecords: [product], expectedId: productId, idField: "product_id", startedAt: context.startedAt, extractionStrategy: "next_data_then_json_ld_then_detail_markup" });
    rememberRecipe({ domain: "johnlewis.com", capability: "commerce.detail", execution_mode: "public_http", request: { method: "GET", url_template: "https://www.johnlewis.com/product/p{product_id}" }, parser: "johnlewis_next_data_product_v1", validator: "validJohnLewisProduct", last_verified_at: new Date().toISOString() });
    return { data: { product, diagnostics: { response_classification: classification, extraction_strategy: "next_data_then_json_ld_then_detail_markup", ...diagnostics(page.html, page.url) } }, sourceUrl: page.url, mode: "public_http" };
  } catch (error) {
    throw publicHttpError(error, "John Lewis product detail could not be reached from the gateway.", requestedUrl);
  }
}

export function resetJohnLewisCaches(): void {
  cachedRobots = null;
}

export const johnLewisConnector: SiteConnector = {
  provider: "johnlewis",
  async execute(tool, input, context) {
    if (tool === "search_products") return searchProducts(input, context);
    if (tool === "get_product") return getProduct(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", `John Lewis does not implement ${tool}.`);
  },
};
