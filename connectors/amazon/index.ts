import type { JsonObject } from "../../lib/gateway-contract";
import { amazonAsinFromInput, canonicalAmazonUkUrl } from "../../lib/provider-identifiers";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractCanonical,
  extractJsonLd,
  extractMeta,
  extractTagText,
  firstNumber,
  firstString,
  isUpstreamChallenge,
  normalizeMoney,
  parseMoney,
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
import {
  detectFrameworks,
  discoverScriptUrls,
  extractApiCandidates,
  extractEmbeddedState,
  findEmbeddedObjects,
  rememberRecipe,
} from "../../lib/embedded-state";
import { recordExtractionBenchmark } from "../../lib/extraction-benchmark";
import { publicSearchCoverage, publicSearchCoverageFields } from "../../lib/commerce-coverage";

const AMAZON_SITE = "https://www.amazon.co.uk";
const IDENTIFYING_USER_AGENT = "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.djrookie99.chatgpt.site)";
const MAX_AMAZON_SEARCH_PAGES = 4;
const MAX_AMAZON_SEARCH_PRODUCTS = 160;
const MAX_AMAZON_SEARCH_ELAPSED_MS = 10_000;
const AMAZON_PAGE_PRODUCT_LIMIT = 100;

type ProductRecord = {
  product_id: string;
  asin: string;
  name: string;
  price: { amount: number; currency: string } | null;
  rating: number | null;
  review_count: number | null;
  image_url: string | null;
  url: string;
  prime?: boolean | null;
  delivery?: string | null;
  availability?: string | null;
  features?: string[];
  reviews?: string[];
};

export type AmazonResponseClassification =
  | "PRODUCT_PAGE"
  | "SEARCH_RESULTS"
  | "CHALLENGE_OR_BLOCK"
  | "INTERSTITIAL"
  | "GENERIC_AMAZON_PAGE"
  | "INVALID_RESPONSE";

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function asin(value: unknown): string | null {
  return amazonAsinFromInput(value);
}

function amazonUrl(value: unknown, productId: string): string {
  return canonicalAmazonUkUrl(value) ?? `${AMAZON_SITE}/dp/${productId}`;
}

function imageUrl(value: unknown): string | null {
  const candidate = absoluteUrl(value, AMAZON_SITE);
  if (!candidate) return null;
  try {
    const hostname = new URL(candidate).hostname.toLowerCase();
    return /(?:^|\.)amazon\.(?:com|co\.uk)$/.test(hostname) || hostname.includes("media-amazon") ? candidate : null;
  } catch {
    return null;
  }
}

function htmlChallenge(html: string): boolean {
  const visible = sanitizeText(html, 10000) ?? "";
  return /(?:automated access|enter the characters|sorry! something went wrong|validatecaptcha|robot check|do not support your session|different,? up-to-date browser|automated requests|verify you(?:'|’)re human|unusual traffic)/i.test(visible)
    || /(?:validatecaptcha|captcha[_-](?:input|challenge)|amzn-captcha|challenge-platform|cf-chl-)/i.test(html)
    || (isUpstreamChallenge(visible) && /(?:access denied|robot check|verify you|unusual traffic)/i.test(visible));
}

function productJsonLd(html: string): JsonObject | null {
  return extractJsonLd(html).find((item) => {
    const type = item["@type"];
    return typeof type === "string" ? type.toLowerCase() === "product" : Array.isArray(type) && type.some((entry) => typeof entry === "string" && entry.toLowerCase() === "product");
  }) ?? null;
}

function explicitSearchZero(html: string): boolean {
  return /(?:no results|did not match any products|0 results|no products found|we couldn't find any results)/i.test(sanitizeText(html, 10000) ?? "");
}

export function classifyAmazonResponse(html: string, expectedId?: string, kind: "product" | "search" = expectedId ? "product" : "search"): AmazonResponseClassification {
  if (!html) return "INVALID_RESPONSE";
  if (htmlChallenge(html)) return "CHALLENGE_OR_BLOCK";
  if (html.length < (kind === "product" ? 180 : 80)) return "INVALID_RESPONSE";
  const visible = sanitizeText(html, 10000) ?? "";
  if (/(?:enable javascript|checking your browser|before you continue|sorry,? we need to verify|robot verification)/i.test(visible)
    && !/id=["']productTitle["']|data-asin=["'][A-Z0-9]{10}["']|s-result-item|\/dp\/[A-Z0-9]{10}/i.test(html)) return "INTERSTITIAL";
  if (kind === "product") {
    if (expectedId && productMarker(html, expectedId)) return "PRODUCT_PAGE";
  } else {
    const hasSearchResult = /s-result-item|data-asin=["'][A-Z0-9]{10}["']|(?:search-results|searchResult|result-list)/i.test(html)
      || [...html.matchAll(/href=["'][^"']*(?:\/dp|\/gp\/product|\/gp\/aw\/d|\/aw\/d)\/[A-Z0-9]{10}/gi)].length > 0;
    if (hasSearchResult || explicitSearchZero(html)) return "SEARCH_RESULTS";
  }
  if (/(?:amazon|sign in|your lists|cart)/i.test(visible)) return "GENERIC_AMAZON_PAGE";
  return "INVALID_RESPONSE";
}

function htmlTitle(html: string): string | null {
  const productTitle = /id=["']productTitle["'][^>]*>([\s\S]*?)<\//i.exec(html)?.[1];
  const jsonLd = productJsonLd(html);
  return (typeof jsonLd?.name === "string" ? sanitizeText(jsonLd.name) : null)
    ?? sanitizeText(productTitle)
    ?? extractTagText(html, "h1")
    ?? extractMeta(html, "og:title")
    ?? extractTagText(html, "title");
}

function productMarker(html: string, productId: string): boolean {
  const canonicalId = asin(extractCanonical(html, AMAZON_SITE));
  const hasIdentity = canonicalId === productId || new RegExp(`data-asin=["']${productId}["']`, "i").test(html);
  const hasSpecificFields = /id=["']productTitle["']/i.test(html)
    || /id=["'](?:feature-bullets|availability|buybox|priceblock_ourprice|corePrice_feature_div)["']/i.test(html)
    || Boolean(productJsonLd(html));
  return html.length >= 180
    && !htmlChallenge(html)
    && hasIdentity
    && hasSpecificFields;
}

function productElementText(html: string, id: string, maxLength = 320): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]{0,2400}?)<\\/[^>]+>`, "i").exec(html);
  const value = sanitizeText(match?.[1], maxLength);
  if (!value || /(?:function\s*\(|window\.|document\.|data-csa-|var\s+\w+\s*=)/i.test(value)) return null;
  return value;
}

function productImageFromHtml(html: string): string | null {
  const landing = /<img\b[^>]*(?:id=["']landingImage["']|data-old-hires=["'][^"']+)[^>]*>/i.exec(html)?.[0];
  const dynamic = /data-a-dynamic-image=["']([^"']+)["']/i.exec(html)?.[1];
  const dynamicImage = dynamic ? /https?:\/\/[^"'{}\s]+/i.exec(decodeHtmlEntities(dynamic))?.[0] : null;
  const value = landing ? /data-old-hires=["']([^"']+)["']/i.exec(landing)?.[1] ?? /src=["']([^"']+)["']/i.exec(landing)?.[1] : dynamicImage;
  return imageUrl(value) ?? imageUrl(extractMeta(html, "og:image"));
}

function priceFromHtml(html: string, name: string): { amount: number; currency: string } | null {
  const jsonLd = productJsonLd(html);
  const offer = jsonLd?.offers;
  const jsonPrice = normalizeMoney(Array.isArray(offer) ? offer[0] : offer, "GBP");
  if (jsonPrice) return jsonPrice;
  const markers = ["corePrice_feature_div", "priceblock_ourprice", "priceblock_dealprice", "apex_desktop", "price_inside_buybox", "tp_price_block_total_price_ww"];
  for (const marker of markers) {
    const markerMatch = new RegExp(`(?:id|class)=["'][^"']*${marker}[^"']*["']`, "i").exec(html);
    if (!markerMatch) continue;
    const price = parseMoney(textWindow(html, markerMatch.index, 900), "GBP");
    if (price) return price;
  }
  const titleIndex = html.toLowerCase().indexOf(name.toLowerCase());
  if (titleIndex >= 0) return parseMoney(textWindow(html, titleIndex, 1800), "GBP");
  const idIndex = html.search(/id=["']productTitle["']/i);
  return idIndex >= 0 ? parseMoney(textWindow(html, idIndex, 1800), "GBP") : null;
}

function ratingFromHtml(html: string): number | null {
  const jsonLd = productJsonLd(html);
  const aggregate = jsonLd?.aggregateRating;
  const aggregateRating = record(aggregate);
  const jsonValue = firstNumber(aggregateRating?.ratingValue);
  if (jsonValue !== null && jsonValue >= 0 && jsonValue <= 5) return jsonValue;
  const marker = html.search(/(?:id=["']acrPopover|a-icon-alt|data-hook=["']average-star-rating)/i);
  const text = marker >= 0 ? textWindow(html, marker, 900) : textWindow(html, html.search(/id=["']productTitle["']/i), 1800);
  const match = /([0-5](?:\.\d)?)\s*(?:out of\s*5|stars?)/i.exec(text);
  return match ? Number(match[1]) : null;
}

function reviewCountFromHtml(html: string): number | null {
  const markers = [/id=["']acrCustomerReviewText["']/i, /data-hook=["']total-review-count["']/i, /data-hook=["']rating-count["']/i];
  for (const marker of markers) {
    const index = html.search(marker);
    if (index < 0) continue;
    const match = /([\d,]+)\s*(?:ratings?|reviews?)/i.exec(textWindow(html, index, 400));
    if (match) return Number(match[1].replace(/,/g, ""));
  }
  const jsonLd = productJsonLd(html);
  const aggregate = record(jsonLd?.aggregateRating);
  return firstNumber(aggregate?.reviewCount, aggregate?.ratingCount);
}

function boundedList(html: string, marker: RegExp, itemPattern: RegExp, maxItems: number, maxLength: number): string[] {
  const index = html.search(marker);
  if (index < 0) return [];
  const region = html.slice(index, Math.min(html.length, index + 9000));
  return [...region.matchAll(itemPattern)]
    .map((match) => sanitizeText(match[1], maxLength))
    .filter((value): value is string => Boolean(value))
    .filter((value, itemIndex, values) => values.indexOf(value) === itemIndex)
    .slice(0, maxItems);
}

function htmlProduct(html: string, sourceUrl: string, productId: string): ProductRecord | null {
  if (!productMarker(html, productId)) return null;
  const name = htmlTitle(html);
  if (!name) return null;
  const pageText = sanitizeText(html, 12000) ?? "";
  const price = priceFromHtml(html, name);
  const rating = ratingFromHtml(html);
  const reviewCount = reviewCountFromHtml(html);
  const delivery = productElementText(html, "deliveryBlockContainer", 240)
    ?? productElementText(html, "deliveryBlockMessage", 240);
  const availability = productElementText(html, "availability", 240);
  const features = boundedList(html, /id=["']feature-bullets["']/i, /<li[^>]*>([\s\S]*?)<\/li>/gi, 12, 280);
  const reviews = boundedList(html, /data-hook=["']review-body["']/i, /data-hook=["']review-body["'][^>]*>([\s\S]*?)<\//gi, 5, 360);
  const canonical = canonicalAmazonUkUrl(extractCanonical(html, sourceUrl)) ?? `${AMAZON_SITE}/dp/${productId}`;
  return {
    product_id: productId,
    asin: productId,
    name,
    price: price && price.currency === "GBP" ? price : null,
    rating,
    review_count: reviewCount,
    image_url: productImageFromHtml(html),
    url: canonical,
    prime: /\bprime\b/i.test(pageText) ? true : null,
    delivery: sanitizeText(delivery),
    availability,
    features,
    reviews,
  };
}

function jsonLdProducts(html: string, limit = 20): ProductRecord[] {
  const products: ProductRecord[] = [];
  const seen = new Set<string>();
  for (const object of extractJsonLd(html)) {
    const type = object["@type"];
    const isProduct = typeof type === "string" ? type.toLowerCase() === "product" : Array.isArray(type) && type.some((entry) => typeof entry === "string" && entry.toLowerCase() === "product");
    if (!isProduct) continue;
    const productId = asin(object.sku ?? object.mpn ?? object.productID ?? object.url);
    const name = firstString(object.name);
    if (!productId || !name || seen.has(productId)) continue;
    const aggregate = record(object.aggregateRating);
    const offer = object.offers;
    const price = normalizeMoney(Array.isArray(offer) ? offer[0] : offer, "GBP");
    products.push({
      product_id: productId,
      asin: productId,
      name,
      price: price && price.currency === "GBP" ? price : null,
      rating: firstNumber(aggregate?.ratingValue),
      review_count: firstNumber(aggregate?.reviewCount, aggregate?.ratingCount),
      image_url: imageUrl(Array.isArray(object.image) ? object.image[0] : object.image),
      url: amazonUrl(object.url, productId),
      prime: null,
      delivery: null,
    });
    seen.add(productId);
  }
  return products.slice(0, limit);
}

function embeddedProduct(value: Record<string, unknown>): ProductRecord | null {
  const productId = asin(value.asin ?? value.ASIN ?? value.product_id ?? value.productId ?? value.productID ?? value.sku ?? value.url ?? value.detailPageURL);
  const name = firstString(value.name, value.title, value.productTitle, value.displayName);
  if (!productId || !name || name.length < 3) return null;
  const aggregate = record(value.aggregateRating ?? value.ratingSummary ?? value.customerReviews);
  const price = normalizeMoney(value.price ?? value.displayPrice ?? value.listingPrice ?? value.offers, "GBP");
  const image = Array.isArray(value.image) ? value.image[0] : value.image;
  return {
    product_id: productId,
    asin: productId,
    name,
    price: price && price.currency === "GBP" ? price : null,
    rating: firstNumber(value.rating, value.ratingValue, aggregate?.ratingValue, aggregate?.starRating),
    review_count: firstNumber(value.review_count, value.reviewCount, value.ratingCount, aggregate?.reviewCount, aggregate?.count),
    image_url: imageUrl(value.image_url ?? value.imageUrl ?? image),
    url: amazonUrl(value.url ?? value.detailPageURL ?? value.detailPageUrl, productId),
    prime: typeof value.prime === "boolean" ? value.prime : null,
    delivery: firstString(value.delivery, value.deliverySummary, value.availability),
    availability: firstString(value.availability, value.inStock),
  };
}

function embeddedProducts(html: string, limit = 20): ProductRecord[] {
  const states = extractEmbeddedState(html).filter((state) => state.kind !== "json_ld");
  return findEmbeddedObjects(states, (object) => Boolean(asin(object.asin ?? object.ASIN ?? object.product_id ?? object.productId ?? object.productID ?? object.sku)) && Boolean(firstString(object.name, object.title, object.productTitle)), limit)
    .map(embeddedProduct)
    .filter((product): product is ProductRecord => Boolean(product));
}

function htmlProducts(html: string, limit = AMAZON_PAGE_PRODUCT_LIMIT): ProductRecord[] {
  const products: ProductRecord[] = [...jsonLdProducts(html, limit), ...embeddedProducts(html, limit)];
  const seen = new Set(products.map((product) => product.product_id));
  const pattern = /href=["']([^"']*(?:\/(?:dp|gp\/product|gp\/aw\/d|aw\/d)\/[^"']+))["']/gi;
  for (const match of html.matchAll(pattern)) {
    const href = absoluteUrl(match[1], AMAZON_SITE);
    const productId = asin(href);
    if (!productId || seen.has(productId)) continue;
    const index = match.index ?? 0;
    const nearbyHtml = html.slice(Math.max(0, index - 2600), Math.min(html.length, index + 2600));
    const nearby = textWindow(html, index, 2600);
    const title = sanitizeText(
      /(?:data-cy|class)=["'][^"']*(?:title|product-title)[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(nearbyHtml)?.[1]
        ?? extractTagText(nearbyHtml, "h2")
        ?? extractTagText(nearbyHtml, "h3"),
    );
    if (!title || /^(?:see all|add to list|add to basket|amazon|products?)$/i.test(title)) continue;
    const price = parseMoney(nearby, "GBP");
    const image = /(?:src|data-src)=["']([^"']+)["']/i.exec(nearbyHtml)?.[1];
    products.push({
      product_id: productId,
      asin: productId,
      name: title,
      price: price && price.currency === "GBP" ? price : null,
      rating: /([0-5](?:\.\d)?)\s+out of\s+5\s+stars?/i.exec(nearby)?.[1] ? Number(/([0-5](?:\.\d)?)\s+out of\s+5\s+stars?/i.exec(nearby)?.[1]) : null,
      review_count: null,
      image_url: imageUrl(image),
      url: amazonUrl(href, productId),
      prime: /\bprime\b/i.test(nearby) ? true : null,
      delivery: /((?:free\s+)?delivery[^.]{0,120})/i.exec(nearby)?.[1] ?? null,
    });
    seen.add(productId);
  }
  return products.slice(0, limit);
}

function embeddedDetailProduct(html: string, sourceUrl: string, productId: string): ProductRecord | null {
  const states = extractEmbeddedState(html).filter((state) => state.kind !== "json_ld");
  const object = findEmbeddedObjects(states, (candidate) => asin(candidate.asin ?? candidate.ASIN ?? candidate.product_id ?? candidate.productId ?? candidate.productID ?? candidate.sku) === productId && Boolean(firstString(candidate.name, candidate.title, candidate.productTitle)), 1)[0];
  const product = object ? embeddedProduct(object) : null;
  if (!product) return null;
  return { ...product, url: amazonUrl(product.url || sourceUrl, productId) };
}

function extractionDiagnostics(html: string, sourceUrl: string): JsonObject {
  const framework = detectFrameworks(html);
  const states = extractEmbeddedState(html);
  const scripts = discoverScriptUrls(html, sourceUrl);
  const apiCandidates = extractApiCandidates(html, sourceUrl);
  return {
    frameworks_detected: framework.frameworks,
    rendering_detected: framework.rendering,
    embedded_state_kinds: [...new Set(states.map((state) => state.kind))],
    same_origin_script_count: scripts.length,
    inline_api_candidate_count: apiCandidates.length,
  };
}

function amazonSearchPageHasTerminalEvidence(html: string): boolean {
  if (explicitSearchZero(html)) return true;
  const nextTags = [...html.matchAll(/<[^>]*(?:class\s*=\s*["'][^"']*s-pagination-next[^"']*["']|data-csa-c-content-id\s*=\s*["']s-pagination-next["'])[^>]*>/gi)].map((match) => match[0]);
  return nextTags.some((tag) => /(?:s-pagination-disabled|a-disabled|aria-disabled\s*=\s*["']true["']|disabled\b)/i.test(tag));
}

function publicHttpError(error: unknown, fallbackMessage: string, sourceUrl?: string): GatewayError {
  if (error instanceof GatewayError) {
    const message = error.code === "UPSTREAM_BLOCKED"
      ? "Amazon’s identified public HTTP route was refused or returned an automated-access response."
      : error.message;
    return new GatewayError(error.code, message, {
      retryable: error.code === "UPSTREAM_BLOCKED" ? false : error.retryable,
      httpStatus: error.httpStatus,
      mode: "public_http",
      sourceUrl: error.sourceUrl ?? sourceUrl,
      stage: error.stage ?? "http",
      cause: error,
    });
  }
  return new GatewayError("UPSTREAM_BLOCKED", fallbackMessage, { retryable: true, mode: "public_http", stage: "http", sourceUrl, cause: error });
}

async function fetchAmazonText(value: string | URL, context: ConnectorContext): Promise<{ text: string; response: Response; url: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchText(value, context, {
        headers: { "user-agent": IDENTIFYING_USER_AGENT },
        upstream5xxCode: "UPSTREAM_BLOCKED",
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof GatewayError) || error.code !== "UPSTREAM_TIMEOUT" || attempt > 0) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new GatewayError("UPSTREAM_TIMEOUT", "Amazon did not respond within the execution window.", { retryable: true, mode: "public_http", stage: "http" });
}

async function searchProducts(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const query = String(input.query);
  const objective = input.search_objective === "ranked" || input.search_objective === "exhaustive_ranked" ? input.search_objective : "discovery";
  const coverageNeeded = objective === "ranked" || objective === "exhaustive_ranked";
  const maxPages = coverageNeeded ? MAX_AMAZON_SEARCH_PAGES : 1;
  const requestedMaxResults = typeof input.max_results === "number" ? input.max_results : 20;
  const url = new URL(`${AMAZON_SITE}/s`);
  url.searchParams.set("k", query);
  const acquisitionStartedAt = Date.now();
  const products: ProductRecord[] = [];
  const seen = new Set<string>();
  let sourceUrl = url.toString();
  let pagesFetched = 0;
  let networkRequests = 0;
  let recordsCapped = false;
  let paginationComplete = false;
  let terminationReason: "end_of_catalogue" | "query_results" | "max_pages" | "max_products" | "max_elapsed_ms" | "upstream_error" = "query_results";
  let firstClassification: AmazonResponseClassification = "INVALID_RESPONSE";
  let partialErrorCode: string | undefined;
  let lastPageHtml = "";
  try {
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      if (Date.now() - acquisitionStartedAt >= MAX_AMAZON_SEARCH_ELAPSED_MS) {
        terminationReason = "max_elapsed_ms";
        break;
      }
      const pageUrl = new URL(url);
      if (pageNumber > 1) pageUrl.searchParams.set("page", String(pageNumber));
      networkRequests += 1;
      let page: { text: string; response: Response; url: string };
      try {
        page = await fetchAmazonText(pageUrl, context);
      } catch (error) {
        if (pageNumber === 1) throw error;
        partialErrorCode = error instanceof GatewayError ? error.code : "UPSTREAM_ERROR";
        terminationReason = "upstream_error";
        break;
      }
      sourceUrl = page.url;
      lastPageHtml = page.text;
      const classification = classifyAmazonResponse(page.text, undefined, "search");
      if (pageNumber === 1) firstClassification = classification;
      if (classification === "CHALLENGE_OR_BLOCK") {
        const error = new GatewayError("UPSTREAM_BLOCKED", "Amazon returned an automated-access challenge to the identified HTTP request.", { retryable: false, sourceUrl: page.url, mode: "public_http", stage: "http" });
        if (pageNumber === 1) throw error;
        partialErrorCode = error.code;
        terminationReason = "upstream_error";
        break;
      }
      if (classification === "INTERSTITIAL") {
        const error = new GatewayError("UPSTREAM_CHANGED", "Amazon returned an interstitial instead of a product search result set.", { retryable: true, sourceUrl: page.url, mode: "public_http", stage: "semantic" });
        if (pageNumber === 1) throw error;
        partialErrorCode = error.code;
        terminationReason = "upstream_error";
        break;
      }
      if (classification !== "SEARCH_RESULTS") {
        const error = new GatewayError("UPSTREAM_CHANGED", "Amazon returned a generic or invalid page instead of a product search result set.", { retryable: false, sourceUrl: page.url, mode: "public_http", stage: "semantic" });
        if (pageNumber === 1) throw error;
        partialErrorCode = error.code;
        terminationReason = "upstream_error";
        break;
      }
      const pageProducts = htmlProducts(page.text, AMAZON_PAGE_PRODUCT_LIMIT);
      if (!pageProducts.length && !explicitSearchZero(page.text)) {
        const error = new GatewayError("UPSTREAM_CHANGED", "Amazon returned a page without a validated product result set.", { retryable: true, sourceUrl: page.url, mode: "public_http", stage: "semantic" });
        if (pageNumber === 1) throw error;
        partialErrorCode = error.code;
        terminationReason = "upstream_error";
        break;
      }
      pagesFetched += 1;
      if (pageProducts.length >= AMAZON_PAGE_PRODUCT_LIMIT) recordsCapped = true;
      for (const product of pageProducts) {
        if (seen.has(product.product_id)) continue;
        seen.add(product.product_id);
        products.push(product);
        if (products.length >= MAX_AMAZON_SEARCH_PRODUCTS) {
          recordsCapped = true;
          terminationReason = "max_products";
          break;
        }
      }
      if (recordsCapped) {
        terminationReason = "max_products";
        break;
      }
      if (amazonSearchPageHasTerminalEvidence(page.text)) {
        paginationComplete = true;
        terminationReason = "end_of_catalogue";
        break;
      }
      if (!coverageNeeded) {
        terminationReason = "query_results";
        break;
      }
      if (pageNumber === maxPages) {
        terminationReason = "max_pages";
        break;
      }
    }
    const filtered = products.filter((product) => typeof input.max_price !== "number" || (product.price !== null && product.price.amount <= input.max_price));
    const responseProducts = coverageNeeded ? filtered : filtered.slice(0, requestedMaxResults);
    const coverage = publicSearchCoverage({
      platform: "amazon",
      route: "amazon_search_html",
      strategy: coverageNeeded ? "amazon_search_html_paged" : "amazon_search_html_targeted",
      query,
      records_acquired: products.length,
      pages_fetched: pagesFetched,
      pagination_complete: paginationComplete,
      records_capped: recordsCapped,
      termination_reason: terminationReason,
      max_pages: maxPages,
      max_products: MAX_AMAZON_SEARCH_PRODUCTS,
      max_requests: maxPages,
      max_elapsed_ms: MAX_AMAZON_SEARCH_ELAPSED_MS,
      coverage_level: paginationComplete ? "complete_for_query" : "bounded_partial",
      coverage_reason: paginationComplete
        ? "amazon_search_pagination_exhausted"
        : terminationReason === "max_pages" || terminationReason === "max_products" || terminationReason === "max_elapsed_ms"
          ? `bounded_partial_${terminationReason}`
          : terminationReason === "upstream_error" ? "upstream_error_before_search_completion" : "targeted_search_results_not_catalogue_complete",
      currency: input.currency,
      locale: input.locale,
    });
    if (products.length) {
      rememberRecipe({
        domain: "amazon.co.uk",
        capability: "commerce.search",
        execution_mode: "public_http",
        request: { method: "GET", url_template: "https://www.amazon.co.uk/s?k={query}" },
        parser: "amazon_html_products_v2",
        validator: "validAmazonProduct",
        last_verified_at: new Date().toISOString(),
      });
    }
    const diagnostics = extractionDiagnostics(lastPageHtml, sourceUrl);
    recordExtractionBenchmark({ provider: "amazon", surface: "search", html: lastPageHtml, records: products, validRecords: responseProducts, startedAt: context.startedAt, extractionStrategy: "amazon_search_html" });
    const coverageFields = publicSearchCoverageFields(coverage);
    return {
      data: {
        query: input.query,
        results: responseProducts,
        search_objective: objective,
        ...coverageFields,
        diagnostics: {
          response_classification: firstClassification,
          extraction_strategy: "json_ld_then_embedded_state_then_result_containers",
          pages_fetched: pagesFetched,
          network_requests: networkRequests,
          pagination_complete: paginationComplete,
          termination_reason: terminationReason,
          records_acquired: products.length,
          records_capped: recordsCapped,
          acquisition: coverage.acquisition,
          route_context: coverage.route_context,
          ...(partialErrorCode ? { partial_error_code: partialErrorCode } : {}),
          ...diagnostics,
        },
      },
      sourceUrl,
      mode: "public_http",
      outcome: responseProducts.length ? "SUCCESS" : "ZERO_RESULTS",
    };
  } catch (unknownError) {
    throw publicHttpError(unknownError, "Amazon’s public catalogue could not be reached.", url.toString());
  }
}

async function getProduct(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const productId = asin(input.product_id);
  if (!productId) throw new GatewayError("INPUT_INVALID", "product_id must be an Amazon UK ASIN or a supported Amazon UK product URL.");
  const url = `${AMAZON_SITE}/dp/${productId}`;
  let page;
  try {
    page = await fetchAmazonText(url, context);
  } catch (unknownError) {
    throw publicHttpError(unknownError, "Amazon’s public product page could not be reached.", url);
  }
  const classification = classifyAmazonResponse(page.text, productId, "product");
  if (classification === "CHALLENGE_OR_BLOCK") throw new GatewayError("UPSTREAM_BLOCKED", "Amazon returned an automated-access challenge to the identified HTTP request.", { retryable: false, sourceUrl: page.url, mode: "public_http", stage: "http" });
  if (classification === "INTERSTITIAL") throw new GatewayError("UPSTREAM_CHANGED", "Amazon returned an interstitial instead of a product page.", { retryable: true, sourceUrl: page.url, mode: "public_http", stage: "semantic" });
  if (classification !== "PRODUCT_PAGE") throw new GatewayError("UPSTREAM_CHANGED", "Amazon returned a generic or invalid page instead of this product.", { retryable: false, sourceUrl: page.url, mode: "public_http", stage: "semantic" });
  const product = htmlProduct(page.text, page.url, productId) ?? embeddedDetailProduct(page.text, page.url, productId);
  if (!product) throw new GatewayError("UPSTREAM_CHANGED", "Amazon’s product page did not expose a valid product record.", { retryable: true, sourceUrl: page.url, mode: "public_http", stage: "semantic" });
  recordExtractionBenchmark({ provider: "amazon", surface: "detail", html: page.text, records: [product], validRecords: [product], expectedId: productId, idField: "product_id", startedAt: context.startedAt, extractionStrategy: "json_ld_then_embedded_state_then_product_markup" });
  rememberRecipe({
    domain: "amazon.co.uk",
    capability: "commerce.detail",
    execution_mode: "public_http",
    request: { method: "GET", url_template: "https://www.amazon.co.uk/dp/{asin}" },
    parser: "amazon_html_product_v2",
    validator: "validAmazonProduct",
    last_verified_at: new Date().toISOString(),
  });
  return { data: { product, diagnostics: { response_classification: classification, extraction_strategy: "json_ld_then_embedded_state_then_product_markup", ...extractionDiagnostics(page.text, page.url) } }, sourceUrl: page.url, mode: "public_http" };
}

export const amazonConnector: SiteConnector = {
  provider: "amazon",
  async execute(tool, input, context) {
    if (tool === "search_products") return searchProducts(input, context);
    if (tool === "get_product") return getProduct(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", `Amazon does not implement ${tool}.`);
  },
};
