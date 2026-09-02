import type { ConnectorId, JsonObject } from "../../lib/gateway-contract";
import {
  absoluteUrl,
  extractCanonical,
  extractHrefLinks,
  extractJsonLd,
  extractMeta,
  extractNumericId,
  extractTagText,
  firstNumber,
  firstString,
  isUpstreamChallenge,
  normalizeMoney,
  objectsByType,
  parseMoney,
  property,
  sanitizeText,
  slugify,
  textFromHtml,
  textWindow,
} from "../../lib/upstream-parser";
import {
  fetchJson,
  fetchText,
  GatewayError,
  type ConnectorContext,
  type ConnectorExecution,
  type SiteConnector,
} from "../../lib/gateway-runtime";
import { publicSearchCoverage, publicSearchCoverageFields } from "../../lib/commerce-coverage";

const IKEA_SITE = "https://www.ikea.com/gb/en";
const IKEA_SEARCH_API = "https://sik.search.blue.cdtapps.com/gb/en/search-result-page";
const IKEA_AVAILABILITY_API = "https://api.salesitem.ingka.com/availabilities/ru/gb";

type ProductRecord = {
  product_id: string;
  name: string;
  price: { amount: number; currency: string };
  url: string;
  image_url: string | null;
  category: string | null;
  summary: string | null;
  dimensions?: string | null;
  colour?: string | null;
  rating?: number | null;
  review_count?: number | null;
};

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function ikeaId(...values: unknown[]): string | null {
  for (const value of values) {
    const id = extractNumericId(value);
    if (id && /^\d{8}$/.test(id)) return id;
  }
  return null;
}

function productUrl(value: unknown, id: string, name: string | null): string {
  const candidate = absoluteUrl(value, IKEA_SITE);
  if (candidate && (new URL(candidate).hostname === "ikea.com" || new URL(candidate).hostname.endsWith(".ikea.com")) && /\/gb\/en\/p\//.test(new URL(candidate).pathname)) return candidate;
  return `${IKEA_SITE}/p/${slugify(name ?? "product")}-${id}/`;
}

function imageUrl(value: unknown, baseUrl: string): string | null {
  const candidate = absoluteUrl(value, baseUrl);
  return candidate && /ikea\.com$/i.test(new URL(candidate).hostname.split(".").slice(-2).join(".")) ? candidate : null;
}

function parseApiProduct(value: unknown): ProductRecord | null {
  const object = record(value);
  if (!object) return null;
  const nested = record(object.product);
  const product = nested ?? object;
  const id = ikeaId(
    product.itemNo,
    product.itemNumber,
    product.articleNumber,
    product.productId,
    product.id,
    product.url,
    object.itemNo,
    object.productId,
    object.url,
  );
  const name = firstString(product.name, product.title, product.productName, product.itemName);
  if (!id || !name) return null;
  const price = normalizeMoney(
    product.salesPrice ?? product.price ?? product.lowestPrice ?? product.currentPrice,
    "GBP",
  ) ?? normalizeMoney(
    { amount: product.priceNumeral ?? product.priceValue ?? product.numeral, currencyCode: product.currencyCode },
    "GBP",
  );
  if (!price) return null;
  return {
    product_id: id,
    name,
    price: { amount: price.amount, currency: "GBP" },
    url: productUrl(product.url ?? product.productUrl ?? product.pipUrl ?? object.url, id, name),
    image_url: imageUrl(product.mainImageUrl ?? product.imageUrl ?? product.image, IKEA_SITE),
    category: firstString(product.categoryName, product.category, product.productType, product.typeName),
    summary: firstString(product.shortDescription, product.description, product.typeName),
    dimensions: firstString(product.itemMeasureReferenceText, product.measurement, product.dimensions),
    colour: firstString(product.validDesignText, product.color, product.colour),
    rating: firstNumber(product.ratingValue, product.rating),
    review_count: firstNumber(product.ratingCount, product.reviewCount),
  };
}

function collectApiProducts(value: unknown, output: ProductRecord[] = [], seen = new Set<string>()): ProductRecord[] {
  if (Array.isArray(value)) {
    for (const item of value) collectApiProducts(item, output, seen);
    return output;
  }
  const object = record(value);
  if (!object) return output;
  const parsed = parseApiProduct(object.product ?? object);
  if (parsed && !seen.has(parsed.product_id)) {
    seen.add(parsed.product_id);
    output.push(parsed);
  }
  for (const child of Object.values(object)) {
    if (child !== object.product) collectApiProducts(child, output, seen);
  }
  return output;
}

function parseHtmlProducts(html: string, sourceUrl: string): ProductRecord[] {
  const output: ProductRecord[] = [];
  const seen = new Set<string>();
  const links = extractHrefLinks(html, /\/gb\/en\/p\//, sourceUrl);
  for (const link of links) {
    const id = ikeaId(link.href);
    if (!id || seen.has(id)) continue;
    const nearby = textWindow(html, link.index, 1800);
    const anchorText = sanitizeText(link.html.replace(/<[^>]+>/g, " "));
    const name = anchorText && !/^more|view|add/i.test(anchorText) ? anchorText : extractTagText(nearby, "h3") ?? extractTagText(nearby, "h2");
    const price = parseMoney(nearby, "GBP");
    if (!name || !price) continue;
    const imageMatch = nearby.match(/https?:\/\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]+)?/i);
    output.push({
      product_id: id,
      name,
      price: { amount: price.amount, currency: "GBP" },
      url: link.href,
      image_url: imageMatch ? imageUrl(imageMatch[0].replace(/\\\\/g, ""), sourceUrl) : null,
      category: null,
      summary: null,
    });
    seen.add(id);
  }
  return output;
}

function dedupeAndFilter(products: ProductRecord[], input: JsonObject): ProductRecord[] {
  const maxResults = typeof input.max_results === "number" ? input.max_results : 20;
  const maxPrice = typeof input.max_price === "number" ? input.max_price : null;
  const category = typeof input.category === "string" ? input.category.toLowerCase() : null;
  const sort = typeof input.sort_by === "string" ? input.sort_by : "relevance";
  const filtered = products.filter((product) => {
    if (maxPrice !== null && product.price.amount > maxPrice) return false;
    if (category && !`${product.category ?? ""} ${product.name}`.toLowerCase().includes(category)) return false;
    return true;
  });
  if (sort === "price_asc") filtered.sort((a, b) => a.price.amount - b.price.amount);
  if (sort === "price_desc") filtered.sort((a, b) => b.price.amount - a.price.amount);
  return filtered.slice(0, maxResults);
}

async function searchProducts(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const query = String(input.query);
  const apiUrl = new URL(IKEA_SEARCH_API);
  apiUrl.searchParams.set("types", "PRODUCT");
  apiUrl.searchParams.set("q", query);
  let products: ProductRecord[] = [];
  let sourceUrl = apiUrl.toString();
  let acquisitionRoute = "ikea_search_api";
  let sourceMode: "first_party_api" | "public_http" = "first_party_api";
  try {
    const result = await fetchJson(apiUrl, context);
    products = collectApiProducts(result.value);
  } catch (error) {
    if (!(error instanceof GatewayError) || !["UPSTREAM_BLOCKED", "UPSTREAM_CHANGED"].includes(error.code)) throw error;
  }
  if (!products.length) {
    acquisitionRoute = "ikea_search_html";
    sourceMode = "public_http";
    const pageUrl = new URL(`${IKEA_SITE}/search/`);
    pageUrl.searchParams.set("q", query);
    const result = await fetchText(pageUrl, context);
    sourceUrl = result.url;
    if (isUpstreamChallenge(result.text)) {
      throw new GatewayError("UPSTREAM_BLOCKED", "IKEA returned an automated-access challenge.", { retryable: false, sourceUrl });
    }
    products = parseHtmlProducts(result.text, sourceUrl);
  }
  const results = dedupeAndFilter(products, input);
  const coverage = publicSearchCoverage({
    platform: "ikea",
    route: acquisitionRoute,
    strategy: acquisitionRoute === "ikea_search_api" ? "ikea_first_party_search" : "ikea_search_html_structured_links",
    query,
    records_acquired: products.length,
    pages_fetched: 1,
    pagination_complete: false,
    records_capped: false,
    termination_reason: "query_results",
    max_pages: 1,
    max_products: Math.max(products.length, 20),
    max_requests: 2,
    coverage_level: "bounded_partial",
    coverage_reason: "targeted_search_results_not_catalogue_complete",
    currency: input.currency,
    locale: input.locale,
  });
  return {
    data: {
      query,
      results,
      search_objective: typeof input.search_objective === "string" ? input.search_objective : "discovery",
      ...publicSearchCoverageFields(coverage),
      diagnostics: {
        acquisition: coverage.acquisition,
        route_context: coverage.route_context,
      },
    },
    sourceUrl,
    mode: products.length ? sourceMode : "public_http",
  };
}

async function resolveProductUrl(productId: string, context: ConnectorContext): Promise<string> {
  const apiUrl = new URL(IKEA_SEARCH_API);
  apiUrl.searchParams.set("types", "PRODUCT");
  apiUrl.searchParams.set("q", productId);
  try {
    const result = await fetchJson(apiUrl, context);
    const products = collectApiProducts(result.value);
    const match = products.find((product) => product.product_id === productId);
    if (match) return match.url;
  } catch (error) {
    if (!(error instanceof GatewayError) || !["UPSTREAM_BLOCKED", "UPSTREAM_CHANGED"].includes(error.code)) throw error;
  }
  const pageUrl = new URL(`${IKEA_SITE}/search/`);
  pageUrl.searchParams.set("q", productId);
  const result = await fetchText(pageUrl, context);
  if (isUpstreamChallenge(result.text)) {
    throw new GatewayError("UPSTREAM_BLOCKED", "IKEA returned an automated-access challenge.", { retryable: false, sourceUrl: result.url });
  }
  const match = extractHrefLinks(result.text, /\/gb\/en\/p\//, result.url).find((link) => link.href.includes(productId));
  if (match) return match.href;
  return `${IKEA_SITE}/p/product-${productId}/`;
}

async function getProduct(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const productId = String(input.product_id).replace(/\./g, "").trim();
  if (!/^\d{8}$/.test(productId)) throw new GatewayError("INPUT_INVALID", "product_id must contain an IKEA eight-digit article number.");
  const apiUrl = new URL(IKEA_SEARCH_API);
  apiUrl.searchParams.set("types", "PRODUCT");
  apiUrl.searchParams.set("q", productId);
  try {
    const apiResult = await fetchJson(apiUrl, context);
    const apiProduct = collectApiProducts(apiResult.value).find((product) => product.product_id === productId);
    if (apiProduct) {
      return {
        data: {
          product: {
            product_id: apiProduct.product_id,
            article: apiProduct.product_id,
            name: apiProduct.name,
            price: apiProduct.price,
            summary: apiProduct.summary,
            dimensions: apiProduct.dimensions ?? null,
            colour: apiProduct.colour ?? null,
            rating: apiProduct.rating ?? null,
            review_count: apiProduct.review_count ?? null,
            category: apiProduct.category,
            url: apiProduct.url,
            image_url: apiProduct.image_url,
          },
        },
        sourceUrl: apiResult.url,
        mode: "first_party_api",
      };
    }
  } catch (error) {
    if (!(error instanceof GatewayError) || !["UPSTREAM_BLOCKED", "UPSTREAM_CHANGED"].includes(error.code)) throw error;
  }
  const url = await resolveProductUrl(productId, context);
  const result = await fetchText(url, context);
  if (isUpstreamChallenge(result.text)) {
    throw new GatewayError("UPSTREAM_BLOCKED", "IKEA returned an automated-access challenge.", { retryable: false, sourceUrl: result.url });
  }
  const jsonProduct = objectsByType(extractJsonLd(result.text), ["Product"])[0] ?? {};
  const offers = property(jsonProduct, "offers");
  const name = firstString(property(jsonProduct, "name"), extractTagText(result.text, "h1"), extractMeta(result.text, "og:title"));
  const price = normalizeMoney(offers, "GBP") ?? parseMoney(textFromHtml(result.text).slice(0, 2800), "GBP");
  if (!name || !price) {
    throw new GatewayError("UPSTREAM_CHANGED", "IKEA’s product page did not expose the bounded fields required by this tool.", { retryable: true, sourceUrl: result.url });
  }
  const pageText = textFromHtml(result.text);
  const dimensionMatch = /(?:dimensions?|product size)\s*[:\-]?\s*([^.!?]{3,180})/i.exec(pageText);
  const colourMatch = /(?:colour|color)\s*[:\-]?\s*([^.!?]{2,80})/i.exec(pageText);
  const category = extractHrefLinks(result.text, /\/gb\/en\/cat\//, result.url)[0]?.href ?? null;
  return {
    data: {
      product: {
        product_id: productId,
        article: productId,
        name,
        price: { amount: price.amount, currency: "GBP" },
        summary: firstString(property(jsonProduct, "description"), extractMeta(result.text, "og:description")),
        dimensions: sanitizeText(dimensionMatch?.[1] ?? null),
        colour: sanitizeText(colourMatch?.[1] ?? null),
        category,
        url: extractCanonical(result.text, result.url) ?? result.url,
        image_url: imageUrl(property(jsonProduct, "image"), result.url) ?? absoluteUrl(extractMeta(result.text, "og:image"), result.url),
      },
    },
    sourceUrl: result.url,
    mode: "public_http",
  };
}

type AvailabilityRow = {
  store: string | null;
  status: string | null;
  available: boolean | null;
  quantity: number | null;
};

function collectAvailabilityRows(value: unknown, output: AvailabilityRow[] = [], seen = new Set<string>()): AvailabilityRow[] {
  if (Array.isArray(value)) {
    for (const item of value) collectAvailabilityRows(item, output, seen);
    return output;
  }
  const object = record(value);
  if (!object) return output;
  const quantity = firstNumber(object.availableStock, object.quantity, object.stock, object.stockLevel, object.availabilityQuantity);
  const status = firstString(object.status, object.availability, object.buyingOption, object.message, object.type);
  const storeValue = object.storeName ?? object.locationName ?? object.storeNo ?? property(object.store, "name", "id");
  const store = firstString(storeValue);
  const rawAvailable = object.isAvailable ?? object.available ?? object.inStock;
  const available = typeof rawAvailable === "boolean" ? rawAvailable : quantity !== null ? quantity > 0 : status ? /available|in stock|yes|true/i.test(status) ? true : /unavailable|out of stock|no|false/i.test(status) ? false : null : null;
  if (quantity !== null || status || store || available !== null) {
    const key = `${store ?? ""}|${status ?? ""}|${quantity ?? ""}|${available ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ store, status, available, quantity });
    }
  }
  for (const child of Object.values(object)) collectAvailabilityRows(child, output, seen);
  return output;
}

async function checkAvailability(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const productId = String(input.product_id).replace(/\./g, "").trim();
  const postcode = String(input.postcode).trim().toUpperCase();
  const url = new URL(IKEA_AVAILABILITY_API);
  url.searchParams.set("itemNos", productId);
  url.searchParams.set("zip", postcode.replace(/\s+/g, ""));
  url.searchParams.set("expand", "StoresList,Restocks,SalesLocations,DisplayLocations,ChildItems");
  try {
    const result = await fetchJson(url, context, { headers: { accept: "application/json;version=2" } });
    const rows = collectAvailabilityRows(result.value).filter((row) => row.store || row.status || row.available !== null || row.quantity !== null);
    if (!rows.length) throw new GatewayError("UPSTREAM_CHANGED", "IKEA’s availability response did not contain recognizable stock fields.", { retryable: true, sourceUrl: result.url });
    const availableValues = rows.map((row) => row.available).filter((value): value is boolean => typeof value === "boolean");
    return {
      data: {
        product_id: productId,
        postcode,
        delivery: { status: availableValues.length ? availableValues.some(Boolean) ? "available" : "unavailable" : "unknown", available: availableValues.length ? availableValues.some(Boolean) : null },
        stores: rows.slice(0, 50),
      },
      sourceUrl: result.url,
      mode: "first_party_api",
    };
  } catch (error) {
    throw error;
  }
}

export const ikeaConnector: SiteConnector = {
  provider: "ikea" as ConnectorId,
  async execute(tool, input, context) {
    if (tool === "search_products") return searchProducts(input, context);
    if (tool === "get_product") return getProduct(input, context);
    if (tool === "check_availability") return checkAvailability(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", `IKEA does not implement ${tool}.`);
  },
};
