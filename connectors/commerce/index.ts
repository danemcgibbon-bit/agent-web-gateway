import type { JsonObject } from "../../lib/gateway-contract";
import { amazonAsinFromInput } from "../../lib/provider-identifiers";
import { GatewayError, createExecutionTrace, markHttpFailure, markHttpSuccess, markSemanticValidation, normalizePublicSite, type ConnectorContext, type ConnectorExecution, type ExecutionMode, type SiteConnector } from "../../lib/gateway-runtime";
import { validateConnectorExecution } from "../../lib/semantic-validation";
import { COMPATIBILITY_PROVIDER_IDS, compatibilityProvider, isCompatibilityProvider } from "../../lib/compatibility-catalog";
import { classifyCompatibilityAudience, classifyCompatibilityCategoryFamily, compatibilityConnector, discoverDynamicCompatibilityProvider, dynamicProviderId, executeCompatibilityProvider, findSnapshotProduct, getCompatibleStoreSnapshot, getLatestStoreSnapshot, getStoreSnapshot, normalizeCompatibilityColor, normalizeCompatibilityColorQuery, rotateCompatibilityRoute, scopeHintForSite, snapshotCacheState, snapshotCandidates, snapshotDiscovery, snapshotSupportsSuperlative, snapshotSummary, type DynamicCompatibilityDiscovery, type DynamicCompatibilityProvider, type SnapshotScope, type StoreSnapshot } from "../../lib/compatibility";
import { amazonConnector } from "../amazon";
import { argosConnector } from "../argos";
import { ikeaConnector } from "../ikea";
import { johnLewisConnector } from "../johnlewis";
import { acquisitionProvesCompleteness } from "../../lib/commerce-coverage";

const COMMERCE_PROVIDERS = ["ikea", "amazon", "argos", "johnlewis", ...COMPATIBILITY_PROVIDER_IDS] as const;
type CommerceProvider = (typeof COMMERCE_PROVIDERS)[number];
const INTERNAL_COMMERCE_RESULT_LIMIT = 160;

export type CommerceSearchObjective = "discovery" | "filtered" | "ranked" | "exhaustive_ranked";

export type CommerceIntentStructure = {
  structural: {
    category: string | null;
    audience: "men" | "women" | "kids" | "unisex" | null;
  };
  attributes: {
    color: string | null;
    size: string | null;
    in_stock: boolean | null;
    availability: "in_stock" | "out_of_stock" | null;
    max_price: number | null;
    condition: string | null;
  };
  objective: {
    sort: string | null;
    superlative: boolean;
  };
};

type CommerceQueryIntent = {
  raw_query: string;
  product_query: string;
  tokens: string[];
  categories: string[];
  max_price: number | null;
  audience: "men" | "women" | "kids" | "unisex" | null;
  color: string | null;
  size: string | null;
  in_stock: boolean | null;
  search_objective: CommerceSearchObjective;
  hard_constraints: boolean;
  structure: CommerceIntentStructure;
};

type CommerceRelevanceProfile = {
  categories: string[];
  keywords: string[];
  broad?: boolean;
};

type ProviderSelection = {
  providers: CommerceProvider[];
  diagnostics: JsonObject;
};

const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "at", "below", "for", "find", "get", "in", "less", "max", "maximum", "me", "most", "of", "or", "please", "price", "priced", "show", "than", "the", "to", "under", "up", "with", "all", "every", "currently", "matching",
]);

const INTENT_CATEGORY_TERMS: Record<string, string[]> = {
  nutrition: ["protein", "powder", "supplement", "supplements", "nutrition", "shake", "bar", "nut", "nuts", "butter", "spread", "snack"],
  food: ["food", "grocery", "nut", "nuts", "butter", "spread", "snack"],
  storage: ["storage", "wardrobe", "unit", "cabinet", "shelf", "shelving", "bookcase", "dresser", "drawer", "cupboard", "rack", "organiser", "organizer", "kallax"],
  home: ["home", "furniture", "sofa", "desk", "table", "chair", "bed", "bedding", "curtain", "bowl", "mug", "kitchen"],
  lighting: ["lamp", "lighting", "light", "lights"],
  fashion: ["fashion", "clothing", "hoodie", "shirt", "jacket", "sneaker", "streetwear"],
  electronics: ["laptop", "monitor", "headphones", "television", "tv", "gaming", "computer", "electronics"],
  sport: ["bike", "cycling", "running", "football", "tent", "fitness", "sport", "outdoor"],
  beauty: ["shampoo", "soap", "beard", "grooming", "skincare", "moisturiser"],
};

const STRUCTURAL_CATEGORY_ALIASES: Record<string, string[]> = {
  sneakers: ["sneaker", "sneakers", "trainer", "trainers", "shoe", "shoes"],
  sweater: ["sweater", "sweaters", "knitwear", "knit", "jumper", "jumpers", "cardigan", "cardigans"],
  hoodie: ["hoodie", "hoodies", "hooded", "sweatshirt", "sweatshirts"],
  shirt: ["shirt", "shirts", "blouse", "blouses", "top", "tops", "overshirt", "overshirts"],
  jacket: ["jacket", "jackets", "coat", "coats", "outerwear", "blazer", "blazers"],
  trousers: ["trouser", "trousers", "pants", "jeans", "shorts"],
  dress: ["dress", "dresses"],
  boots: ["boot", "boots"],
  sofa: ["sofa", "sofas", "couch", "couches", "settee", "settees"],
  lamp: ["lamp", "lamps", "lighting", "light", "lights"],
  storage: ["storage", "wardrobe", "wardrobes", "cabinet", "cabinets", "shelf", "shelves", "shelving", "bookcase", "bookcases"],
};

const COLOR_SYNONYMS: Record<string, string[]> = {
  green: ["green", "forest", "forest green", "pine", "pine green", "moss", "sage", "olive", "emerald", "jade", "fern", "mint", "kelp", "seafoam", "lichen"],
  blue: ["blue", "navy", "sky blue", "cobalt", "royal blue"],
  red: ["red", "burgundy", "maroon", "crimson"],
  black: ["black", "charcoal", "onyx"],
  white: ["white", "ivory", "cream", "ecru"],
  brown: ["brown", "tan", "camel", "beige", "chocolate"],
  pink: ["pink", "rose", "coral", "fuchsia"],
  purple: ["purple", "violet", "lilac", "plum"],
  yellow: ["yellow", "mustard", "gold"],
  orange: ["orange", "terracotta"],
  grey: ["grey", "gray", "silver", "slate"],
};
const COLOR_MODIFIERS = ["heather", "fleck", "nep", "melange", "washed", "vintage", "light", "dark", "deep", "soft"];

const CORE_PROVIDER_PROFILES: Record<string, CommerceRelevanceProfile> = {
  ikea: {
    categories: ["home", "furniture", "storage", "lighting"],
    keywords: ["storage", "wardrobe", "unit", "shelf", "shelving", "kallax", "lamp", "lighting", "light", "sofa", "desk", "table", "chair", "bed", "bedding", "curtain", "furniture", "bowl", "mug", "kitchen"],
  },
  amazon: {
    categories: ["nutrition", "food", "storage", "home", "lighting", "fashion", "electronics", "sport", "beauty"],
    keywords: [],
    broad: true,
  },
  argos: {
    categories: ["storage", "home", "lighting", "electronics", "sport"],
    keywords: ["storage", "wardrobe", "lamp", "lighting", "desk", "table", "headphones", "laptop", "gaming"],
  },
  johnlewis: {
    categories: ["storage", "home", "lighting", "fashion", "electronics", "beauty", "food"],
    keywords: ["storage", "wardrobe", "lamp", "lighting", "desk", "table", "furniture", "bedding", "headphones"],
  },
};

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown, maxLength = 260): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function money(value: unknown): JsonObject | null {
  const object = record(value);
  if (!object) return null;
  const currency = typeof object.currency === "string" && /^[A-Za-z]{3}$/.test(object.currency.trim()) ? object.currency.toUpperCase() : null;
  if (typeof object.amount === "number" && Number.isFinite(object.amount) && object.amount >= 0) return { amount: object.amount, currency };
  if (typeof object.min === "number" && Number.isFinite(object.min) && typeof object.max === "number" && Number.isFinite(object.max) && object.min >= 0 && object.max >= object.min) {
    return { min: object.min, max: object.max, currency };
  }
  return null;
}

function priceBounds(value: unknown): { min: number; max: number; currency: string | null } | null {
  const price = money(value);
  if (!price) return null;
  const currency = typeof price.currency === "string" ? price.currency : null;
  if (typeof price.amount === "number") return { min: price.amount, max: price.amount, currency };
  if (typeof price.min === "number" && typeof price.max === "number") return { min: price.min, max: price.max, currency };
  return null;
}

function semanticColorFields(value: JsonObject): JsonObject {
  const normalized = normalizeCompatibilityColor(value);
  return {
    ...(normalized.display ? { color: normalized.display } : {}),
    ...(normalized.family ? { color_family: normalized.family } : {}),
    color_families: normalized.families,
    color_confidence: normalized.confidence,
    color_source: normalized.source,
    ...(normalized.conflicts?.length ? { semantic_conflicts: normalized.conflicts } : {}),
  };
}

function commonProduct(provider: CommerceProvider | string, value: unknown, retrievedAt: string, executionMode?: ExecutionMode, freshness = "live", platform?: string): JsonObject | null {
  const object = record(value);
  if (!object) return null;
  if (isCompatibilityProvider(provider) || dynamicProviderId(provider)) {
    const id = text(object.product_id);
    const title = text(object.title ?? object.name);
    const url = text(object.canonical_url ?? object.url);
    const selectedPrice = money(object.price);
    if (!id || !title || !url) return null;
    const site = (() => {
      try { return new URL(url).origin; } catch { return null; }
    })();
    const currency = typeof object.currency === "string" && /^[A-Za-z]{3}$/.test(object.currency.trim())
      ? object.currency.toUpperCase()
      : selectedPrice?.currency ?? null;
    const currencyVerified = typeof object.currency_verified === "boolean"
      ? object.currency_verified
      : false;
    const normalizedSemantic = semanticColorFields(object);
    const semanticConflicts = [
      ...(Array.isArray(object.semantic_conflicts) ? object.semantic_conflicts.filter((value): value is string => typeof value === "string") : []),
      ...(Array.isArray(normalizedSemantic.semantic_conflicts) ? normalizedSemantic.semantic_conflicts.filter((value): value is string => typeof value === "string") : []),
    ];
    return {
      provider,
      product_id: id,
      title,
      price: selectedPrice,
      ...(object.regular_price !== undefined ? { regular_price: money(object.regular_price) } : {}),
      currency,
      currency_verified: currencyVerified,
      ...(typeof object.currency_source === "string" ? { currency_source: object.currency_source } : {}),
      ...(typeof object.currency_context_id === "string" ? { currency_context_id: object.currency_context_id } : {}),
      ...(object.currency_conflict === true ? { currency_conflict: true } : {}),
      condition: text(object.condition) ?? "new",
      rating: typeof object.rating === "number" ? object.rating : null,
      rating_count: typeof object.rating_count === "number" ? object.rating_count : null,
      availability: text(object.availability),
      delivery_summary: object.delivery_summary ?? object.delivery ?? null,
      delivery: object.delivery ?? object.delivery_summary ?? null,
      image_url: text(object.image_url),
      canonical_url: url,
      ...(dynamicProviderId(provider) && site ? { site } : {}),
      ...(dynamicProviderId(provider) ? { provider_origin: "dynamic" } : {}),
      ...(platform === "shopify" || platform === "woocommerce" ? { platform } : {}),
      ...(object.audience !== undefined ? { audience: object.audience } : {}),
      ...normalizedSemantic,
      ...(semanticConflicts.length ? { semantic_conflicts: [...new Set(semanticConflicts)].slice(0, 8) } : {}),
      ...(Array.isArray(object.colors) ? { colors: object.colors.slice(0, 12) } : {}),
      ...(Array.isArray(object.variants) ? { variants: object.variants.slice(0, 20) } : {}),
      ...(object.category !== undefined ? { category: object.category } : {}),
      ...(object.category_family !== undefined ? { category_family: object.category_family } : {}),
      ...(object.summary !== undefined ? { summary: text(object.summary) } : {}),
      ...(object.description !== undefined ? { description: text(object.description, 1_600) } : {}),
      ...(Array.isArray(object.details_available) ? { details_available: object.details_available.slice(0, 12) } : {}),
      ...(Array.isArray(object.sizes) ? { sizes: object.sizes.slice(0, 24) } : {}),
      ...(Array.isArray(object.available_sizes) ? { available_sizes: object.available_sizes.slice(0, 24) } : {}),
      ...(Array.isArray(object.materials) ? { materials: object.materials.slice(0, 12) } : {}),
      ...(Array.isArray(object.features) ? { features: object.features.slice(0, 24) } : {}),
      ...(Array.isArray(object.images) ? { images: object.images.slice(0, 8) } : {}),
      ...(object.sale && typeof object.sale === "object" && !Array.isArray(object.sale) ? { sale: object.sale } : {}),
      ...(object.availability_details !== undefined ? { availability_details: object.availability_details } : {}),
      retrieved_at: retrievedAt,
      freshness,
      execution_mode: executionMode ?? "public_http",
    };
  }
  if (provider === "ikea") {
    const id = text(object.product_id);
    const title = text(object.name);
    const url = text(object.url);
    if (!id || !title || !url) return null;
    return {
      provider,
      product_id: id,
      title,
      price: money(object.price),
      currency: "GBP",
      currency_verified: true,
      currency_source: "fixed_provider",
      category: text(object.category),
      summary: text(object.summary),
      condition: "new",
      rating: typeof object.rating === "number" ? object.rating : null,
      rating_count: typeof object.review_count === "number" ? object.review_count : null,
      availability: null,
      delivery_summary: null,
      delivery: null,
      image_url: text(object.image_url),
      canonical_url: url,
      retrieved_at: retrievedAt,
      freshness,
      execution_mode: executionMode ?? "first_party_api",
      ...semanticColorFields(object),
    };
  }
  if (provider === "amazon") {
    const id = amazonAsinFromInput(object.product_id);
    const title = text(object.name);
    const url = text(object.url);
    if (!id || !title || !url) return null;
    return {
      provider,
      product_id: id,
      title,
      price: money(object.price),
      currency: "GBP",
      currency_verified: true,
      currency_source: "fixed_provider",
      condition: "new",
      rating: typeof object.rating === "number" ? object.rating : null,
      rating_count: typeof object.review_count === "number" ? object.review_count : null,
      availability: text(object.availability),
      delivery_summary: text(object.delivery),
      delivery: text(object.delivery),
      image_url: text(object.image_url),
      canonical_url: url,
      retrieved_at: retrievedAt,
      freshness,
      execution_mode: executionMode ?? "public_http",
      ...semanticColorFields(object),
    };
  }
  if (provider === "argos") {
    const id = text(object.product_id);
    const title = text(object.name);
    const url = text(object.url);
    if (!id || !title || !url) return null;
    return {
      provider,
      product_id: id,
      title,
      price: money(object.price),
      currency: "GBP",
      currency_verified: true,
      currency_source: "fixed_provider",
      condition: text(object.condition) ?? "new",
      rating: typeof object.rating === "number" ? object.rating : null,
      rating_count: typeof object.review_count === "number" ? object.review_count : null,
      availability: text(object.availability),
      delivery_summary: text(object.delivery),
      delivery: text(object.delivery),
      image_url: text(object.image_url),
      canonical_url: url,
      retrieved_at: retrievedAt,
      freshness,
      execution_mode: executionMode ?? "public_http",
      ...semanticColorFields(object),
    };
  }
  if (provider === "johnlewis") {
    const id = text(object.product_id);
    const title = text(object.name);
    const url = text(object.url);
    if (!id || !title || !url) return null;
    return {
      provider,
      product_id: id,
      title,
      price: money(object.price),
      currency: "GBP",
      currency_verified: true,
      currency_source: "fixed_provider",
      condition: "new",
      rating: typeof object.rating === "number" ? object.rating : null,
      rating_count: typeof object.review_count === "number" ? object.review_count : null,
      availability: text(object.availability),
      delivery_summary: text(object.delivery),
      delivery: text(object.delivery),
      image_url: text(object.image_url),
      canonical_url: url,
      retrieved_at: retrievedAt,
      freshness,
      execution_mode: executionMode ?? "public_http",
      ...semanticColorFields(object),
    };
  }
  const id = text(object.item_id);
  const title = text(object.title);
  const url = text(object.url);
  if (!id || !title || !url) return null;
  return {
    provider,
    product_id: id,
    title,
    price: money(object.price),
    currency: "GBP",
    currency_verified: true,
    currency_source: "fixed_provider",
    condition: text(object.condition),
    rating: null,
    rating_count: null,
    availability: text(object.availability),
    delivery_summary: object.shipping ?? null,
    delivery: object.shipping ?? null,
    image_url: text(object.image_url),
    canonical_url: url,
    retrieved_at: retrievedAt,
    freshness,
    execution_mode: executionMode ?? "public_http",
    ...semanticColorFields(object),
  };
}

function providerConnector(provider: CommerceProvider): SiteConnector {
  if (isCompatibilityProvider(provider)) return compatibilityConnector;
  if (provider === "ikea") return ikeaConnector;
  if (provider === "amazon") return amazonConnector;
  if (provider === "argos") return argosConnector;
  if (provider === "johnlewis") return johnLewisConnector;
  throw new GatewayError("PROVIDER_UNSUPPORTED", `Commerce provider ${provider} is not currently registered.`, { retryable: false, mode: "mixed" });
}

function innerInput(provider: CommerceProvider, operation: "search_products" | "search_items" | "get_product" | "get_item", input: JsonObject): JsonObject {
  const currency = input.currency ?? "GBP";
  const locale = input.locale ?? "en-GB";
  const maxResults = input.search_objective && input.search_objective !== "discovery"
    ? INTERNAL_COMMERCE_RESULT_LIMIT
    : input.max_results ?? 20;
  const searchObjective = ["discovery", "filtered", "ranked", "exhaustive_ranked"].includes(String(input.search_objective))
    ? { search_objective: input.search_objective }
    : {};
  if (provider === "ikea" && operation === "search_products") return { query: input.query, max_results: maxResults, currency, locale, ...searchObjective, ...(input.max_price !== undefined ? { max_price: input.max_price } : {}), ...(input.sort_by ? { sort_by: input.sort_by } : {}) };
  if (provider === "amazon" && operation === "search_products") return { query: input.query, max_results: maxResults, currency, locale, ...searchObjective, ...(input.max_price !== undefined ? { max_price: input.max_price } : {}) };
  if (provider === "argos" && operation === "search_products") return { query: input.query, max_results: maxResults, currency, locale, ...searchObjective, ...(input.max_price !== undefined ? { max_price: input.max_price } : {}) };
  if (provider === "johnlewis" && operation === "search_products") return { query: input.query, max_results: maxResults, currency, locale, ...searchObjective, ...(input.max_price !== undefined ? { max_price: input.max_price } : {}) };
  if (isCompatibilityProvider(provider) && operation === "search_products") return {
    provider,
    query: input.query,
    max_results: maxResults,
    currency,
    locale,
    ...(input.min_price !== undefined ? { min_price: input.min_price } : {}),
    ...(input.max_price !== undefined ? { max_price: input.max_price } : {}),
    ...(input.audience !== undefined ? { audience: input.audience } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.size !== undefined ? { size: input.size } : {}),
    ...(input.in_stock !== undefined ? { in_stock: input.in_stock } : {}),
    ...(input.condition !== undefined ? { condition: input.condition } : {}),
    ...(input.sort_by !== undefined ? { sort_by: input.sort_by } : {}),
    ...(input.search_objective !== undefined ? { search_objective: input.search_objective } : {}),
    ...(input.hard_constraints !== undefined ? { hard_constraints: input.hard_constraints } : {}),
    ...(Array.isArray(input.search_queries) ? { search_queries: input.search_queries } : {}),
  };
  if (isCompatibilityProvider(provider)) return { provider, product_id: input.product_id, ...(input.canonical_url ? { canonical_url: input.canonical_url } : {}), currency, locale };
  if (provider === "ikea") return { product_id: input.product_id, currency, locale };
  if (provider === "amazon") return { product_id: input.product_id, currency, locale };
  if (provider === "argos") return { product_id: input.product_id, currency, locale };
  if (provider === "johnlewis") return { product_id: input.product_id, currency, locale };
  return { item_id: input.product_id, currency, locale };
}

type CommerceOperation = "search_products" | "search_items" | "get_product" | "get_item";

async function executeInnerOnce(provider: CommerceProvider, operation: CommerceOperation, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const connector = providerConnector(provider);
  const childStartedAt = new Date().toISOString();
  const childContext: ConnectorContext = { ...context, trace: createExecutionTrace() };
  const providerInput = innerInput(provider, operation, input);
  try {
    const result = await connector.execute(operation, providerInput, childContext);
    if (result.mode !== "cache") markHttpSuccess(childContext);
    const validated = isCompatibilityProvider(provider)
      ? validateConnectorExecution("commerce", operation, { ...providerInput, provider }, result)
      : validateConnectorExecution(provider, operation, providerInput, result);
    markSemanticValidation(childContext, "success");
    const observationProvider = isCompatibilityProvider(provider) ? "commerce" : provider;
    context.onProviderObservation?.({
      provider: observationProvider,
      ...(isCompatibilityProvider(provider) ? { upstream_provider: provider } : {}),
      tool: operation,
      startedAt: childStartedAt,
      mode: validated.mode,
      outcome: validated.outcome === "ZERO_RESULTS" ? "zero_results" : "success",
      trace: childContext.trace,
    });
    return { ...validated, trace: childContext.trace };
  } catch (unknownError) {
    const error = unknownError instanceof GatewayError
      ? unknownError
      : new GatewayError("INTERNAL_ERROR", "The commerce provider could not complete the request.", { retryable: true, mode: "mixed", cause: unknownError });
    if (error.stage === "semantic") markSemanticValidation(childContext, "failed", error.code);
    markHttpFailure(childContext, error, error.stage === "semantic");
    const observationProvider = isCompatibilityProvider(provider) ? "commerce" : provider;
    context.onProviderObservation?.({ provider: observationProvider, ...(isCompatibilityProvider(provider) ? { upstream_provider: provider } : {}), tool: operation, startedAt: childStartedAt, mode: error.mode ?? "public_http", outcome: "error", errorCode: error.code, trace: childContext.trace });
    throw error;
  }
}

function transientCompatibilityError(error: unknown): error is GatewayError {
  return error instanceof GatewayError && (
    ["UPSTREAM_TIMEOUT", "UPSTREAM_BLOCKED", "UPSTREAM_CHANGED", "RATE_LIMITED"].includes(error.code)
    || (error.code === "PROVIDER_RESTRICTED" && error.retryable)
  );
}

async function executeInner(provider: CommerceProvider, operation: CommerceOperation, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  try {
    return await executeInnerOnce(provider, operation, input, context);
  } catch (error) {
    if (!isCompatibilityProvider(provider) || !transientCompatibilityError(error)) throw error;
    const capability = operation === "get_product" || operation === "get_item" ? "detail" : "search";
    rotateCompatibilityRoute(provider, capability);
    const retried = await executeInnerOnce(provider, operation, input, context);
    const diagnostics = record(retried.data.diagnostics) ?? {};
    return {
      ...retried,
      data: {
        ...retried.data,
        diagnostics: {
          ...diagnostics,
          transient_retry: {
            attempted: true,
            from_error: error.code,
            route_rotated: true,
            outcome: "success",
          },
        },
      },
    };
  }
}

async function executeDynamicOnce(provider: DynamicCompatibilityProvider, operation: "search_products" | "get_product", input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const childStartedAt = new Date().toISOString();
  const childContext: ConnectorContext = { ...context, trace: createExecutionTrace() };
  const providerInput = {
    ...input,
    provider: provider.id,
    ...(input.site ? { site: input.site } : {}),
  };
  try {
    const result = await executeCompatibilityProvider(provider, operation, providerInput, childContext);
    markHttpSuccess(childContext);
    const validated = validateConnectorExecution("commerce", operation, providerInput, result);
    markSemanticValidation(childContext, "success");
    context.onProviderObservation?.({
      provider: "commerce",
      upstream_provider: provider.id,
      tool: operation,
      startedAt: childStartedAt,
      mode: validated.mode,
      outcome: validated.outcome === "ZERO_RESULTS" ? "zero_results" : "success",
      trace: childContext.trace,
    });
    return {
      ...validated,
      ...(context.dynamic_site ? {
        provenance: {
          ...(validated.provenance ?? {}),
          provider: provider.id,
          domain: provider.domain,
          platform: provider.engine,
          provider_origin: "dynamic",
          normalized_origin: context.dynamic_site.normalized_origin ?? provider.site_origin,
          known_before_request: context.dynamic_site.known_before_request ?? false,
          recipe_cache: context.dynamic_site.recipe_cache ?? "cold",
          dynamic_discovery: context.dynamic_site.discovery,
          ...(context.dynamic_site.scope_hint ? { site_scope: context.dynamic_site.scope_hint } : {}),
        },
      } : {}),
      trace: childContext.trace,
    };
  } catch (unknownError) {
    const error = unknownError instanceof GatewayError
      ? unknownError
      : new GatewayError("INTERNAL_ERROR", "The dynamic commerce site could not complete the request.", { retryable: true, mode: "public_http", cause: unknownError });
    if (error.stage === "semantic") markSemanticValidation(childContext, "failed", error.code);
    markHttpFailure(childContext, error, error.stage === "semantic");
    context.onProviderObservation?.({ provider: "commerce", upstream_provider: provider.id, tool: operation, startedAt: childStartedAt, mode: error.mode ?? "public_http", outcome: "error", errorCode: error.code, trace: childContext.trace });
    throw error;
  }
}

function dynamicRouteFailure(error: unknown, provider: DynamicCompatibilityProvider, operation: string): GatewayError {
  if (error instanceof GatewayError && ["INPUT_INVALID", "UNSUPPORTED_SITE", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE"].includes(error.code)) return error;
  const upstreamCode = error instanceof GatewayError ? error.code : "INTERNAL_ERROR";
  return new GatewayError("PLATFORM_DETECTED_ROUTE_UNAVAILABLE", `The detected ${provider.engine} site did not expose a usable read-only ${operation} route.`, {
    retryable: error instanceof GatewayError ? error.retryable : true,
    mode: error instanceof GatewayError ? error.mode ?? "public_http" : "public_http",
    sourceUrl: error instanceof GatewayError ? error.sourceUrl : provider.site_origin,
    stage: error instanceof GatewayError ? error.stage ?? "http" : "http",
    cause: error,
    details: {
      ...(error instanceof GatewayError ? (error.details ?? {}) : {}),
      site: provider.domain,
      normalized_origin: provider.site_origin,
      provider_origin: "dynamic",
      platform_detected: provider.engine,
      supported_dynamic_platforms: ["shopify", "woocommerce"],
      upstream_code: upstreamCode,
    },
  });
}

function dynamicExecutionContext(context: ConnectorContext, discovery: DynamicCompatibilityDiscovery): ConnectorContext {
  return {
    ...context,
    dynamic_site: {
      domain: discovery.provider.domain,
      normalized_origin: discovery.normalized_origin,
      platform: discovery.provider.engine,
      discovery: discovery.cache_status,
      provider_origin: "dynamic",
      known_before_request: discovery.known_before_request,
      recipe_cache: discovery.recipe_cache,
      ...(discovery.selected_probe ? { probe_route: discovery.selected_probe.route, probe_url: discovery.selected_probe.final_url } : {}),
      ...(discovery.selected_probe_data !== undefined ? { probe_data: discovery.selected_probe_data } : {}),
      ...(discovery.currency_context ? { currency_context: discovery.currency_context } : {}),
      ...(discovery.scope_hint ? { scope_hint: discovery.scope_hint } : {}),
    },
  };
}

async function executeDynamic(provider: DynamicCompatibilityProvider, operation: "search_products" | "get_product", input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  try {
    return await executeDynamicOnce(provider, operation, input, context);
  } catch (error) {
    if (!transientCompatibilityError(error)) throw dynamicRouteFailure(error, provider, operation);
    rotateCompatibilityRoute(provider, operation === "get_product" ? "detail" : "search");
    try {
      const retried = await executeDynamicOnce(provider, operation, input, context);
      return {
        ...retried,
        data: {
          ...retried.data,
          diagnostics: {
            ...(record(retried.data.diagnostics) ?? {}),
            transient_retry: { attempted: true, from_error: error instanceof GatewayError ? error.code : "INTERNAL_ERROR", route_rotated: true, outcome: "success" },
          },
        },
      };
    } catch (retryError) {
      throw dynamicRouteFailure(retryError, provider, operation);
    }
  }
}

function errorInfo(error: unknown): JsonObject {
  if (error instanceof GatewayError) return { status: "error", code: error.code, message: error.message, retryable: error.retryable };
  return { status: "error", code: "INTERNAL_ERROR", message: "The commerce provider could not complete the request.", retryable: true };
}

function normalizeToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function queryTokens(value: unknown): string[] {
  return [...new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9]+/)
    .map(normalizeToken)
    .filter((token) => token.length >= 2 && !QUERY_STOPWORDS.has(token)))];
}

function structuralCategoryFromQuery(value: unknown): string | null {
  const tokens = queryTokens(value);
  for (const [category, aliases] of Object.entries(STRUCTURAL_CATEGORY_ALIASES)) {
    if (aliases.some((alias) => queryTokens(alias).every((token) => tokens.includes(token)))) return category;
  }
  return null;
}

function termMatches(tokens: string[], term: string): boolean {
  const termTokens = queryTokens(term);
  return termTokens.length > 0 && termTokens.every((termToken) => tokens.includes(termToken));
}

function budgetFromQuery(value: unknown): number | null {
  const query = String(value ?? "");
  const match = /(?:under|below|up\s*to|upto|at\s+most|max(?:imum)?|less\s+than)\s*(?:£|gbp)?\s*(\d+(?:[.,]\d{1,2})?)/i.exec(query)
    ?? /(?:£|gbp)\s*(\d+(?:[.,]\d{1,2})?)\s*(?:or\s+less|max(?:imum)?)?/i.exec(query);
  if (!match) return null;
  const amount = Number.parseFloat((match[1] ?? "").replace(",", "."));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function audienceFromQuery(value: string): CommerceQueryIntent["audience"] {
  const source = value.toLowerCase().replace(/[\u2019']/g, "'");
  if (/\b(?:men|mens|men's|male|man)\b/.test(source)) return "men";
  if (/\b(?:women|womens|women's|female|woman)\b/.test(source)) return "women";
  if (/\b(?:kids|children|child|boys?|girls?|junior|youth)\b/.test(source)) return "kids";
  if (/\b(?:unisex|gender[- ]?neutral)\b/.test(source)) return "unisex";
  return null;
}

function canonicalColor(value: unknown): string | null {
  const source = String(value ?? "").trim().toLowerCase();
  if (!source) return null;
  return normalizeCompatibilityColorQuery(source) ?? source.slice(0, 80);
}

function colorFromQuery(value: string): string | null {
  return normalizeCompatibilityColorQuery(value);
}

function normalizedSize(value: unknown): string | null {
  const source = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!source) return null;
  if (/^(?:large|lg|l)$/.test(source)) return "L";
  if (/^(?:medium|med|m)$/.test(source)) return "M";
  if (/^(?:small|sm|s)$/.test(source)) return "S";
  if (/^(?:extra\s*large|xlarge|xl|x\s*l)$/.test(source)) return "XL";
  if (/^(?:extra\s*small|xsmall|xs|x\s*s)$/.test(source)) return "XS";
  return source.toUpperCase();
}

function sizeFromQuery(value: string): string | null {
  const match = /\b(?:size|in\s+size)\s*(?::|is)?\s*(extra\s*large|extra\s*small|xlarge|xsmall|xl|xs|lg|large|medium|med|small|sm|[sml])\b/i.exec(value);
  return normalizedSize(match?.[1]);
}

function stripSiteMention(query: string, site: unknown): string {
  if (typeof site !== "string" || !site.trim()) return query;
  const host = site.trim().replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0]?.replace(/^www\./i, "");
  if (!host || !host.includes(".")) return query;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return query
    .replace(new RegExp(`\\b(?:on|at|from)\\s+(?:www\\.)?${escaped}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:www\\.)?${escaped}\\b`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeIntentTerms(value: string, audience: CommerceQueryIntent["audience"], color: string | null, size: string | null, inStock: boolean | null): string {
  let output = value
    .replace(/(?:under|below|up\s*to|upto|at\s+most|max(?:imum)?|less\s+than)\s*(?:£|gbp)?\s*\d+(?:[.,]\d{1,2})?/gi, " ")
    .replace(/(?:£|gbp)\s*\d+(?:[.,]\d{1,2})?\s*(?:or\s+less|max(?:imum)?)?/gi, " ")
    .replace(/\b(?:cheapest|lowest(?:\s+price)?|most\s+expensive|highest(?:\s+price)?|best(?:\s+value)?|currently)\b/gi, " ")
    .replace(/\b(?:size|in\s+size)\s*(?::|is)?\s*(?:extra\s*large|extra\s*small|xlarge|xsmall|xl|xs|lg|large|medium|med|small|sm|[sml])\b/gi, " ");
  if (audience) output = output.replace(/\b(?:men|mens|men's|male|man|women|womens|women's|female|woman|kids|children|child|boys?|girls?|junior|youth|unisex|gender[- ]?neutral)\b/gi, " ");
  if (color) {
    const terms = COLOR_SYNONYMS[color] ?? [color];
    for (const term of terms) output = output.replace(new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`, "gi"), " ");
    output = output.replace(new RegExp(`\\b(?:${COLOR_MODIFIERS.join("|")})\\b`, "gi"), " ");
  }
  if (inStock === true) output = output.replace(/\b(?:in\s+stock|available|availability)\b/gi, " ");
  return output.replace(/\s+/g, " ").trim();
}

const COMMERCE_QUERY_EXPANSIONS: Record<string, string[]> = {
  sweater: ["sweater", "crew sweater", "knit sweater", "pullover"],
  hoodie: ["hoodie", "pullover hoodie", "hooded sweatshirt"],
  trainers: ["trainers", "sneakers", "running shoes"],
  sneakers: ["sneakers", "trainers", "shoes"],
  sofa: ["sofa", "couch", "settee"],
};

/** Small, deterministic acquisition expansion; never delegated to a model. */
export function expandCommerceQueries(value: unknown): string[] {
  const base = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!base) return [];
  for (const [term, aliases] of Object.entries(COMMERCE_QUERY_EXPANSIONS)) {
    if (!new RegExp(`\\b${term}\\b`, "i").test(base)) continue;
    const output = aliases.map((alias) => base.replace(new RegExp(`\\b${term}\\b`, "i"), alias));
    return [...new Set([base, ...output])].slice(0, 4);
  }
  return [base];
}

export function classifyCommerceSearchObjective(
  input: JsonObject,
  intent: Pick<CommerceQueryIntent, "max_price" | "audience" | "color" | "size" | "in_stock"> = {
    max_price: null,
    audience: null,
    color: null,
    size: null,
    in_stock: null,
  },
): CommerceSearchObjective {
  const query = String(input.query ?? "").toLowerCase();
  const superlative = /\b(?:cheapest|lowest(?:\s+price)?|most\s+expensive|highest(?:\s+price)?|best(?:\s+value)?|all\s+(?:matching|available)|every\s+(?:matching|available))\b/i.test(query);
  const hardConstraints = Boolean(
    typeof input.min_price === "number"
      || typeof input.max_price === "number"
      || intent.max_price !== null
      || intent.audience
      || intent.color
      || intent.size
      || intent.in_stock !== null
      || (typeof input.condition === "string" && input.condition !== "all"),
  );
  const priceSorted = input.sort_by === "price_asc" || input.sort_by === "price_desc";
  if (superlative || (priceSorted && hardConstraints)) return "exhaustive_ranked";
  if (priceSorted) return "ranked";
  if (hardConstraints) return "filtered";
  return "discovery";
}

function commerceIntent(input: JsonObject): CommerceQueryIntent {
  const rawQuery = stripSiteMention(String(input.query ?? "").trim(), input.site);
  const audience = input.audience === "men" || input.audience === "women" || input.audience === "kids" || input.audience === "unisex" ? input.audience : audienceFromQuery(rawQuery);
  const color = canonicalColor(input.color) ?? colorFromQuery(rawQuery);
  const size = normalizedSize(input.size) ?? sizeFromQuery(rawQuery);
  const inStock = typeof input.in_stock === "boolean" ? input.in_stock : /\b(?:in\s+stock|available)\b/i.test(rawQuery) ? true : null;
  const withoutBudget = removeIntentTerms(rawQuery, audience, color, size, inStock);
  const tokens = queryTokens(withoutBudget);
  const categories = Object.entries(INTENT_CATEGORY_TERMS)
    .filter(([, terms]) => terms.some((term) => termMatches(tokens, term)))
    .map(([category]) => category);
  const explicitMaxPrice = typeof input.max_price === "number" ? input.max_price : null;
  const baseIntent = {
    raw_query: rawQuery,
    product_query: tokens.join(" "),
    tokens,
    categories,
    max_price: explicitMaxPrice ?? budgetFromQuery(rawQuery),
    audience,
    color,
    size,
    in_stock: inStock,
  };
  const search_objective = classifyCommerceSearchObjective(input, baseIntent);
  const structure: CommerceIntentStructure = {
    structural: {
      category: structuralCategoryFromQuery(withoutBudget),
      audience,
    },
    attributes: {
      color,
      size,
      in_stock: inStock,
      availability: inStock === true ? "in_stock" : inStock === false ? "out_of_stock" : null,
      max_price: baseIntent.max_price,
      condition: typeof input.condition === "string" && input.condition !== "all" ? input.condition : null,
    },
    objective: {
      sort: typeof input.sort_by === "string" ? input.sort_by : null,
      superlative: search_objective === "exhaustive_ranked" || /\b(?:cheapest|lowest|most\s+expensive|highest|best\s+value|all|every)\b/i.test(rawQuery),
    },
  };
  return { ...baseIntent, search_objective, hard_constraints: search_objective !== "discovery", structure };
}

function normalizedCommerceInput(input: JsonObject, intent: CommerceQueryIntent): JsonObject {
  return {
    ...input,
    query: intent.product_query || input.query,
    ...(intent.max_price !== null ? { max_price: intent.max_price } : {}),
    ...(intent.audience ? { audience: intent.audience } : {}),
    ...(intent.color ? { color: intent.color } : {}),
    ...(intent.size ? { size: intent.size } : {}),
    ...(intent.in_stock !== null ? { in_stock: intent.in_stock } : {}),
    search_objective: intent.search_objective,
    hard_constraints: intent.hard_constraints,
    intent_structure: intent.structure,
    search_queries: expandCommerceQueries(intent.product_query || input.query),
  };
}

function providerProfile(provider: CommerceProvider): CommerceRelevanceProfile | null {
  if (isCompatibilityProvider(provider)) {
    const definition = compatibilityProvider(provider);
    return definition ? { categories: [...definition.categories], keywords: [...(definition.keywords ?? [])] } : null;
  }
  return CORE_PROVIDER_PROFILES[provider] ?? null;
}

function providerRelevance(provider: CommerceProvider, intent: CommerceQueryIntent): { score: number; keyword_matches: string[]; category_matches: string[] } {
  const profile = providerProfile(provider);
  if (!profile || !intent.tokens.length) return { score: 0, keyword_matches: [], category_matches: [] };
  const keywordMatches = profile.keywords.filter((term) => termMatches(intent.tokens, term));
  const categoryMatches = profile.categories.filter((category) => intent.categories.includes(category));
  const score = keywordMatches.length * 100 + categoryMatches.length * 20 + (profile.broad && categoryMatches.length ? 10 : 0);
  return { score, keyword_matches: keywordMatches, category_matches: categoryMatches };
}

function selectProviders(input: JsonObject, intent: CommerceQueryIntent): ProviderSelection {
  if (Array.isArray(input.providers)) {
    const providers = input.providers.filter((value): value is CommerceProvider => COMMERCE_PROVIDERS.includes(value as CommerceProvider));
    return {
      providers,
      diagnostics: { selection_mode: "explicit", selected: providers, normalized_intent: intent },
    };
  }
  const ranked = COMMERCE_PROVIDERS.map((provider, index) => {
    const definition = compatibilityProvider(provider);
    const relevance = providerRelevance(provider, intent);
    const enabled = !definition || Boolean(definition.enabled);
    return {
      provider,
      index,
      enabled,
      ...relevance,
      selection_eligible: enabled && relevance.score > 0 && (!isCompatibilityProvider(provider) || relevance.keyword_matches.length > 0),
    };
  });
  const selected = ranked
    .filter((item) => item.selection_eligible)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, 10);
  const fallback = ["amazon", "ikea", "argos"] as CommerceProvider[];
  const providers = (selected.length ? selected.map((item) => item.provider) : fallback).slice(0, 10);
  return {
    providers,
    diagnostics: {
      selection_mode: "intent_ranked",
      normalized_intent: intent,
      selected: providers,
      ranked: ranked.filter((item) => item.enabled).sort((a, b) => (b.score - a.score) || (a.index - b.index)).slice(0, 14).map(({ provider, score, keyword_matches, category_matches, selection_eligible }) => ({ provider, score, keyword_matches, category_matches, selection_eligible })),
      excluded: ranked.filter((item) => item.enabled && !item.selection_eligible).map((item) => ({ provider: item.provider, reason: item.score ? "no precise product-keyword match" : "no category or keyword match" })),
    },
  };
}

function modeFor(results: ConnectorExecution[]): ConnectorExecution["mode"] {
  const modes = [...new Set(results.map((result) => result.mode))];
  return modes.length === 1 ? modes[0] : "mixed";
}

type SearchAttempt = { provider: string; result?: ConnectorExecution; error?: unknown };

function queryMatchCount(product: JsonObject, input: JsonObject): number {
  const titleTokens = queryTokens(product.title);
  return queryTokens(input.query).filter((token) => titleTokens.includes(token)).length;
}

function relevanceForProduct(product: JsonObject, intent: CommerceQueryIntent, explicitProvider: boolean): { accepted: boolean; matches: number } {
  const searchableTokens = queryTokens([product.title, product.category, product.category_family, product.summary, product.color, product.color_family, product.color_families].filter(Boolean).join(" "));
  const aliases: Record<string, string[]> = {
    sweater: ["sweater", "crew", "knit", "pullover"],
    hoodie: ["hoodie", "hooded", "sweatshirt"],
    trainers: ["trainers", "sneakers", "shoes"],
    sneakers: ["sneakers", "trainers", "shoes"],
    sofa: ["sofa", "couch", "settee"],
  };
  const matches = intent.tokens.filter((token) => searchableTokens.includes(token) || (aliases[token]?.some((alias) => searchableTokens.includes(alias)) ?? false)).length;
  if (!matches) return { accepted: false, matches };
  const title = normalizedLabel(product.title);
  const family = normalizedLabel(product.category_family ?? classifyCompatibilityCategoryFamily(product));
  if (intent.product_query === "sweater" && (family === "hoodie" || family === "jacket" || family === "shirt" || /\b(?:sweatshirt|tank|jacket)\b/.test(title))) return { accepted: false, matches };
  if (intent.product_query === "sweater" && !searchableTokens.includes("sweater") && family !== "sweater") return { accepted: false, matches };
  const provider = String(product.provider) as CommerceProvider;
  const profileRelevance = providerRelevance(provider, intent);
  const providerBacked = profileRelevance.keyword_matches.length > 0 || profileRelevance.category_matches.length > 0;
  const allTermsMatch = intent.tokens.length > 0 && matches === intent.tokens.length;
  return {
    accepted: explicitProvider ? matches > 0 : allTermsMatch || providerBacked,
    matches,
  };
}

function normalizedLabel(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[\u2019']/g, "'").replace(/\s+/g, " ").trim();
}

function colorFamiliesFromNormalized(value: unknown): string[] {
  const item = record(value);
  if (!item) return [];
  const families = item.color_families ?? item.color_family;
  if (Array.isArray(families)) return families.filter((candidate): candidate is string => typeof candidate === "string");
  return typeof families === "string" ? [families] : [];
}

function colorLabelsFromProduct(value: unknown): string[] {
  const item = record(value);
  if (!item) return [];
  const labels: string[] = [];
  const add = (candidate: unknown): void => {
    if (typeof candidate !== "string" || !candidate.trim() || labels.includes(candidate)) return;
    labels.push(candidate);
  };
  add(item.color);
  if (Array.isArray(item.colors)) for (const color of item.colors) add(color);
  if (Array.isArray(item.variants)) for (const variant of item.variants) add(record(variant)?.color);
  return labels;
}

function hasColorEvidence(value: unknown): boolean {
  // An opaque label (for example “stone”) is evidence that a value exists,
  // not evidence that it belongs to a requested canonical colour family.
  return colorFamiliesFromNormalized(value).length > 0;
}

function colorMatches(requested: string, actual: unknown): boolean {
  return colorFamiliesFromNormalized(actual).includes(requested);
}

function audienceFromProduct(product: JsonObject): CommerceQueryIntent["audience"] {
  return classifyCompatibilityAudience(product);
}

function audienceLabel(value: unknown): CommerceQueryIntent["audience"] {
  const source = normalizedLabel(value);
  if (/\b(?:unisex|gender[- ]?neutral)\b/.test(source)) return "unisex";
  if (/\b(?:men|mens|men's|male|man|menswear)\b/.test(source)) return "men";
  if (/\b(?:women|womens|women's|female|woman|womenswear)\b/.test(source)) return "women";
  if (/\b(?:kids|children|child|boys?|girls?|junior|youth|childrenswear)\b/.test(source)) return "kids";
  return null;
}

function variantAvailabilityState(variant: JsonObject): boolean | null {
  if (typeof variant.available === "boolean") return variant.available;
  const value = normalizedLabel(variant.availability);
  if (/(?:out\s*of\s*stock|unavailable|sold\s*out|backorder)/.test(value)) return false;
  if (/(?:in\s*stock|available|ready)/.test(value)) return true;
  return null;
}

function availableFromProduct(product: JsonObject): boolean | null {
  const variants = Array.isArray(product.variants)
    ? product.variants.filter((value): value is JsonObject => Boolean(record(value)))
    : [];
  const variantStates = variants.map(variantAvailabilityState);
  if (variantStates.some((value) => value === true)) return true;
  if (variantStates.length && variantStates.every((value) => value === false)) return false;
  const value = normalizedLabel(product.availability);
  if (/(?:out\s*of\s*stock|unavailable|sold\s*out|backorder)/.test(value)) return false;
  if (/(?:in\s*stock|available|ready)/.test(value)) return true;
  return null;
}

function failedConstraintLabels(reason: string | undefined, intent: CommerceQueryIntent): string[] {
  if (reason === "audience_mismatch_or_unknown") return ["audience"];
  if (reason === "product_stock_unavailable_or_unknown") return ["in_stock"];
  if (reason === "requested_variant_unavailable_or_unverifiable") {
    const labels = [
      ...(intent.color ? ["color"] : []),
      ...(intent.size ? ["size"] : []),
      ...(intent.in_stock === true ? ["in_stock"] : []),
    ];
    return labels.length ? labels : ["variant"];
  }
  if (reason === "below_min_price") return ["min_price"];
  if (reason === "over_max_price") return ["max_price"];
  if (reason === "price_unverifiable") return ["price"];
  if (reason === "condition_mismatch") return ["condition"];
  return [reason ?? "constraint"];
}

function withSemanticUncertainty(product: JsonObject, constraints: string[]): JsonObject {
  const existing = Array.isArray(product.semantic_unknown_constraints)
    ? product.semantic_unknown_constraints.filter((value): value is string => typeof value === "string")
    : [];
  return { ...product, semantic_unknown_constraints: [...new Set([...existing, ...constraints])] };
}

function semanticUnknownConstraints(product: JsonObject): string[] {
  return Array.isArray(product.semantic_unknown_constraints)
    ? product.semantic_unknown_constraints.filter((value): value is string => typeof value === "string")
    : [];
}

function constrainProduct(product: JsonObject, intent: CommerceQueryIntent): { product: JsonObject | null; reason?: string } {
  const requestedAudience = intent.audience;
  const requestedColor = intent.color;
  const requestedSize = intent.size;
  const variants = Array.isArray(product.variants)
    ? product.variants.filter((value): value is JsonObject => Boolean(record(value)))
    : [];
  const needsVariant = Boolean(requestedAudience || requestedColor || requestedSize || intent.in_stock === true);
  const productColorFamilies = colorFamiliesFromNormalized(product);
  const variantsHaveColorEvidence = variants.some(hasColorEvidence);
  const productColorSatisfies = Boolean(requestedColor && !variantsHaveColorEvidence && productColorFamilies.includes(requestedColor));
  const productColorUnknown = Boolean(requestedColor && !variantsHaveColorEvidence && !productColorSatisfies
    && (productColorFamilies.length === 0 || product.color_confidence === "unknown"));
  const productAudienceValue = audienceFromProduct(product);
  const variantAudienceMatches = requestedAudience && variants.some((variant) => {
    const value = audienceLabel(variant.audience);
    return value === requestedAudience || value === "unisex" && (requestedAudience === "men" || requestedAudience === "women");
  });
  if (requestedAudience && productAudienceValue !== requestedAudience && !(requestedAudience === "men" && productAudienceValue === "unisex") && !(requestedAudience === "women" && productAudienceValue === "unisex") && !(productAudienceValue === null && variantAudienceMatches)) {
    if (productAudienceValue === null) return { product: withSemanticUncertainty(product, ["audience"]) };
    return { product: null, reason: "audience_mismatch_or_unknown" };
  }

  if (requestedColor && !variantsHaveColorEvidence && !productColorSatisfies && !productColorUnknown) return { product: null, reason: "requested_variant_unavailable_or_unverifiable" };
  if (productColorSatisfies && !variants.length) {
    if (requestedSize) return { product: null, reason: "requested_variant_unavailable_or_unverifiable" };
    if (intent.in_stock === true) {
      const availability = availableFromProduct(product);
      if (availability === false) return { product: null, reason: "product_stock_unavailable_or_unknown" };
      if (availability === null) return { product: withSemanticUncertainty(product, ["in_stock"]) };
    }
    return { product: { ...product, ...(product.color ? { matched_color: product.color } : {}), ...(requestedColor ? { matched_color_family: requestedColor } : {}) } };
  }

  if (needsVariant) {
    const candidates = variants.filter((variant) => {
      if (requestedColor && variantsHaveColorEvidence && !colorMatches(requestedColor, variant)) return false;
      if (requestedSize && normalizedSize(variant.size) !== requestedSize) return false;
      if (intent.in_stock === true && variantAvailabilityState(variant) === false) return false;
      const variantAudience = audienceLabel(variant.audience);
      if (requestedAudience && variantAudience && variantAudience !== requestedAudience && !(requestedAudience === "men" && variantAudience === "unisex") && !(requestedAudience === "women" && variantAudience === "unisex")) return false;
      return true;
    });
    if (!candidates.length) {
      if (productColorSatisfies && !requestedSize && intent.in_stock !== true) return { product };
      if (productColorUnknown && !requestedSize) return { product: withSemanticUncertainty(product, ["color"]) };
      if (requestedAudience && productAudienceValue === null && !requestedSize && intent.in_stock !== true) return { product: withSemanticUncertainty(product, ["audience"]) };
      if (intent.in_stock === true && availableFromProduct(product) === null && !requestedSize) return { product: withSemanticUncertainty(product, ["in_stock"]) };
      return { product: null, reason: "requested_variant_unavailable_or_unverifiable" };
    }
    const ordered = [...candidates].sort((left, right) => (priceBounds(left.price)?.min ?? Number.POSITIVE_INFINITY) - (priceBounds(right.price)?.min ?? Number.POSITIVE_INFINITY));
    const selected = ordered[0];
    const selectedPrice = money(selected.price);
    const selectedAvailability = variantAvailabilityState(selected);
    const selectedUnknownConstraints = [
      ...(requestedColor && !variantsHaveColorEvidence && !productColorSatisfies ? ["color"] : []),
      ...(requestedAudience && productAudienceValue === null && !variantAudienceMatches ? ["audience"] : []),
      ...(intent.in_stock === true && selectedAvailability === null && (Boolean(requestedSize) || availableFromProduct(product) !== true) ? ["in_stock"] : []),
    ];
    const selectedProduct = {
      ...product,
      ...(selectedPrice ? { price: selectedPrice, currency: selectedPrice.currency } : {}),
      ...(typeof selected.variant_id === "string" ? { variant_id: selected.variant_id } : {}),
      ...(selected.color ? { matched_color: selected.color } : product.color ? { matched_color: product.color } : {}),
      ...(requestedColor ? { matched_color_family: requestedColor } : {}),
      ...(selected.size ? { matched_size: selected.size } : {}),
      ...(selectedAvailability !== null ? { variant_available: selectedAvailability } : {}),
      ...(selected.sku ? { sku: selected.sku } : {}),
    };
    return {
      product: selectedUnknownConstraints.length ? withSemanticUncertainty(selectedProduct, selectedUnknownConstraints) : selectedProduct,
    };
  }
  if (intent.in_stock === true) {
    const availability = availableFromProduct(product);
    if (availability === false) return { product: null, reason: "product_stock_unavailable_or_unknown" };
    if (availability === null) return { product: withSemanticUncertainty(product, ["in_stock"]) };
  }
  return { product };
}

type RankedCommerceResults = {
  results: JsonObject[];
  exact_matches: JsonObject[];
  closest_matches: JsonObject[];
  failed_constraints: string[];
  relevance_excluded: number;
  relevance_excluded_by_provider: JsonObject;
  constraint_excluded: number;
  constraint_excluded_by_provider: JsonObject;
  semantic_uncertain: number;
  semantic_uncertain_constraints: JsonObject;
  semantic_conflicts: string[];
};

function filterAndRank(products: JsonObject[], input: JsonObject, intent: CommerceQueryIntent): RankedCommerceResults {
  const minPrice = typeof input.min_price === "number" ? input.min_price : null;
  const maxPrice = typeof input.max_price === "number" ? input.max_price : null;
  const condition = typeof input.condition === "string" && input.condition !== "all" ? input.condition : null;
  const requiresComparablePrice = intent.search_objective === "ranked"
    || intent.search_objective === "exhaustive_ranked"
    || minPrice !== null
    || maxPrice !== null;
  const constraintExcludedByProvider: JsonObject = {};
  const semanticUncertainConstraints: JsonObject = {};
  const semanticConflictSet = new Set<string>();
  const closestCandidates: Array<{ product: JsonObject; failed_constraints: string[] }> = [];
  const constrained = products.map((product) => {
    const result = constrainProduct(product, intent);
    if (!result.product) {
      const provider = String(product.provider);
      constraintExcludedByProvider[provider] = Number(constraintExcludedByProvider[provider] ?? 0) + 1;
      closestCandidates.push({ product, failed_constraints: failedConstraintLabels(result.reason, intent) });
    }
    return result.product;
  }).filter((product): product is JsonObject => Boolean(product));
  for (const product of constrained) {
    for (const constraint of semanticUnknownConstraints(product)) semanticUncertainConstraints[constraint] = Number(semanticUncertainConstraints[constraint] ?? 0) + 1;
    if (Array.isArray(product.semantic_conflicts)) for (const conflict of product.semantic_conflicts) if (typeof conflict === "string") semanticConflictSet.add(conflict);
  }
  // A hard request must not present an item whose requested audience, colour,
  // size, or stock state is still unknown as an exact result. Keep those
  // records eligible for closest-match diagnostics, but require positive
  // semantic evidence before they enter the ranked result set.
  const semanticallyConstrained = constrained.filter((product) => {
    const unknown = relevantSemanticUncertainty(product, intent);
    if (!intent.hard_constraints || !unknown.length) return true;
    const provider = String(product.provider);
    constraintExcludedByProvider[provider] = Number(constraintExcludedByProvider[provider] ?? 0) + 1;
    closestCandidates.push({ product, failed_constraints: unknown });
    return false;
  });
  const explicitCurrency = typeof input.currency === "string" && /^[A-Za-z]{3}$/.test(input.currency.trim()) ? input.currency.trim().toUpperCase() : null;
  const verifiedCurrency = (product: JsonObject): string | null => {
    const price = priceBounds(product.price);
    if (!price?.currency) return null;
    const dynamic = typeof product.provider === "string" && Boolean(dynamicProviderId(product.provider));
    const verified = product.currency_verified === true || (!dynamic && price.currency.length === 3);
    return verified ? price.currency.toUpperCase() : null;
  };
  const targetCurrency = explicitCurrency ?? semanticallyConstrained.map(verifiedCurrency).find((value): value is string => Boolean(value)) ?? null;
  const output = semanticallyConstrained.filter((product) => {
    const price = priceBounds(product.price);
    const failed: string[] = [];
    if (requiresComparablePrice && (!price || !verifiedCurrency(product) || !targetCurrency || price.currency?.toUpperCase() !== targetCurrency)) failed.push("price_unverifiable");
    if (minPrice !== null && price && price.max < minPrice) failed.push("below_min_price");
    if (maxPrice !== null && price && price.min > maxPrice) failed.push("over_max_price");
    if (condition) {
      const actual = typeof product.condition === "string" ? product.condition.toLowerCase() : "unknown";
      if (condition === "new" && !actual.includes("new")) failed.push("condition_mismatch");
      if (condition === "used" && !actual.includes("used")) failed.push("condition_mismatch");
      if (condition === "refurbished" && !actual.includes("refurb")) failed.push("condition_mismatch");
    }
    if (failed.length) {
      const provider = String(product.provider);
      constraintExcludedByProvider[provider] = Number(constraintExcludedByProvider[provider] ?? 0) + 1;
      closestCandidates.push({ product, failed_constraints: [...new Set(failed.flatMap((reason) => failedConstraintLabels(reason, intent)))] });
      return false;
    }
    return true;
  });
  const relevanceExcludedByProvider: JsonObject = {};
  const relevanceFiltered = output.filter((product) => {
    const relevance = relevanceForProduct(product, intent, Array.isArray(input.providers));
    if (relevance.accepted) return true;
    const provider = String(product.provider);
    relevanceExcludedByProvider[provider] = Number(relevanceExcludedByProvider[provider] ?? 0) + 1;
    return false;
  });
  const priceOf = (product: JsonObject) => priceBounds(product.price)?.min ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const unique = relevanceFiltered.filter((product) => {
    const key = `${product.provider}:${product.product_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const score = (product: JsonObject): number => {
    const price = priceBounds(product.price);
    const rating = typeof product.rating === "number" ? product.rating : 0;
    const reviews = typeof product.rating_count === "number" ? Math.min(10, Math.log10(Math.max(1, product.rating_count))) : 0;
    const availability = /(?:in stock|available|ready to collect|delivery available)/i.test(String(product.availability ?? "")) ? 8 : 0;
    return queryMatchCount(product, input) * 100 + (price ? 10 : 0) + rating * 2 + reviews + availability;
  };
  if (input.sort_by === "price_asc") unique.sort((a, b) => (priceOf(a) - priceOf(b)) || String(a.title).localeCompare(String(b.title)));
  else if (input.sort_by === "price_desc") unique.sort((a, b) => (priceOf(b) - priceOf(a)) || String(a.title).localeCompare(String(b.title)));
  else if (input.sort_by === "rating_desc") unique.sort((a, b) => ((typeof b.rating === "number" ? b.rating : -1) - (typeof a.rating === "number" ? a.rating : -1)) || (score(b) - score(a)));
  else unique.sort((a, b) => (score(b) - score(a)) || (priceOf(a) - priceOf(b)) || `${a.provider}:${a.product_id}`.localeCompare(`${b.provider}:${b.product_id}`));
  const priced = unique.map((product) => priceBounds(product.price)?.min).filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
  const rankingReasons = (product: JsonObject): string[] => {
    const reasons: string[] = [];
    const productPrice = priceBounds(product.price)?.min;
    const matches = queryMatchCount(product, input);
    if (matches) reasons.push(`title matches ${matches} requested term${matches === 1 ? "" : "s"}`);
    if (maxPrice !== null && productPrice !== undefined) reasons.push(`within ${targetCurrency ?? "the requested"} ${maxPrice} budget`);
    if (minPrice !== null && productPrice !== undefined) reasons.push(`at least ${targetCurrency ?? "the requested currency"} ${minPrice}`);
    if (productPrice !== undefined) {
      const nextHigher = priced.find((value) => value > productPrice);
      if (nextHigher !== undefined && nextHigher - productPrice >= 1) reasons.push(`£${Math.round(nextHigher - productPrice)} cheaper than the next priced result`);
    }
    if (typeof product.rating === "number") reasons.push(`${product.rating.toFixed(1)}★${typeof product.rating_count === "number" ? ` from ${product.rating_count.toLocaleString("en-GB")} reviews` : ""}`);
    if (product.availability) reasons.push(String(product.availability).slice(0, 100));
    return reasons.slice(0, 3);
  };
  const limitedResults: JsonObject[] = unique.map((product) => ({ ...product, ranking_reasons: rankingReasons(product) })).slice(0, typeof input.max_results === "number" ? input.max_results : 15);
  const closestMatches = closestCandidates
    .filter(({ product }) => relevanceForProduct(product, intent, Array.isArray(input.providers)).accepted)
    .sort((left, right) => (left.failed_constraints.length - right.failed_constraints.length) || String(left.product.title).localeCompare(String(right.product.title)))
    .slice(0, 3)
    .map(({ product, failed_constraints }) => ({ ...product, failed_constraints }));
  const failedConstraints = [...new Set(closestMatches.flatMap((product) => Array.isArray(product.failed_constraints) ? product.failed_constraints.map(String) : []))];
  return {
    results: limitedResults,
    exact_matches: limitedResults.map((product) => ({ provider: product.provider, product_id: product.product_id })),
    closest_matches: closestMatches,
    failed_constraints: failedConstraints,
    relevance_excluded: Object.values(relevanceExcludedByProvider).reduce((total: number, value: unknown) => total + Number(value), 0),
    relevance_excluded_by_provider: relevanceExcludedByProvider,
    constraint_excluded: Object.values(constraintExcludedByProvider).reduce((total: number, value: unknown) => total + Number(value), 0),
    constraint_excluded_by_provider: constraintExcludedByProvider,
    semantic_uncertain: Object.values(semanticUncertainConstraints).reduce((total: number, value: unknown) => total + Number(value), 0),
    semantic_uncertain_constraints: semanticUncertainConstraints,
    semantic_conflicts: [...semanticConflictSet],
  };
}

const COMMERCE_DETAIL_SECTIONS = ["price", "availability", "sizes", "colors", "variants", "materials", "description", "images", "sale", "provenance"] as const;
type CommerceDetailSection = (typeof COMMERCE_DETAIL_SECTIONS)[number];

function detailSections(input: JsonObject): CommerceDetailSection[] {
  if (!Array.isArray(input.include)) return [];
  return [...new Set(input.include.filter((value): value is CommerceDetailSection => typeof value === "string" && (COMMERCE_DETAIL_SECTIONS as readonly string[]).includes(value)))];
}

function availableDetailSections(product: JsonObject): string[] {
  const explicit = Array.isArray(product.details_available)
    ? product.details_available.filter((value): value is string => typeof value === "string")
    : [];
  const inferred = [
    product.price !== null && product.price !== undefined ? "price" : null,
    product.availability !== null && product.availability !== undefined ? "availability" : null,
    Array.isArray(product.sizes) || Array.isArray(product.available_sizes) ? "sizes" : null,
    Array.isArray(product.colors) || typeof product.color === "string" ? "colors" : null,
    Array.isArray(product.variants) ? "variants" : null,
    Array.isArray(product.materials) ? "materials" : null,
    typeof product.description === "string" ? "description" : null,
    Array.isArray(product.images) ? "images" : null,
    product.sale && typeof product.sale === "object" ? "sale" : null,
    "provenance",
  ].filter((value): value is string => Boolean(value));
  return [...new Set([...explicit, ...inferred])];
}

function projectCommerceProduct(product: JsonObject, requested: CommerceDetailSection[]): JsonObject {
  const source = { ...product };
  const sections = requested.length ? requested : ["price", "availability", "variants", "sale"] as CommerceDetailSection[];
  const baseKeys = [
    "provider", "product_id", "title", "price", "regular_price", "currency", "currency_verified", "currency_source",
    "currency_context_id", "currency_conflict",
    "condition", "rating", "rating_count", "availability", "delivery_summary", "delivery", "image_url", "canonical_url",
    "site", "platform", "provider_origin", "audience", "color", "color_family", "color_families", "color_confidence", "color_source", "category", "category_family",
    "retrieved_at", "freshness", "execution_mode", "details_available", "matched_color", "matched_size", "variant_available", "variant_id", "sku",
  ];
  const output: JsonObject = {};
  for (const key of baseKeys) if (source[key] !== undefined) output[key] = source[key];
  output.details_available = availableDetailSections(source);
  if (sections.includes("price")) {
    for (const key of ["price", "regular_price", "currency", "currency_verified", "currency_source"]) if (source[key] !== undefined) output[key] = source[key];
  }
  if (sections.includes("availability")) {
    for (const key of ["availability", "availability_details", "variant_available", "available_sizes"]) if (source[key] !== undefined) output[key] = source[key];
  }
  if (sections.includes("sizes")) {
    for (const key of ["sizes", "available_sizes"]) if (source[key] !== undefined) output[key] = Array.isArray(source[key]) ? source[key].slice(0, 24) : source[key];
  }
  if (sections.includes("colors")) {
    for (const key of ["color", "color_family", "color_families", "color_confidence", "color_source", "colors"]) if (source[key] !== undefined) output[key] = Array.isArray(source[key]) ? source[key].slice(0, 24) : source[key];
  }
  if (sections.includes("variants") && Array.isArray(source.variants)) output.variants = source.variants.slice(0, 20);
  if (sections.includes("materials") && Array.isArray(source.materials)) output.materials = source.materials.slice(0, 12);
  if (sections.includes("description")) {
    for (const key of ["summary", "description", "features"]) {
      if (source[key] !== undefined) output[key] = typeof source[key] === "string" ? source[key].slice(0, 1_600) : Array.isArray(source[key]) ? source[key].slice(0, 24) : source[key];
    }
  }
  if (sections.includes("images") && Array.isArray(source.images)) output.images = source.images.slice(0, 8);
  if (sections.includes("sale")) {
    for (const key of ["sale", "regular_price"]) if (source[key] !== undefined) output[key] = source[key];
  }
  if (sections.includes("provenance")) {
    for (const key of ["provider", "provider_origin", "site", "platform", "canonical_url", "retrieved_at", "freshness", "execution_mode", "currency_source"]) if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

function snapshotExecution(snapshot: StoreSnapshot, input: JsonObject): ConnectorExecution {
  const records = snapshotCandidates(snapshot, input.query);
  const ageSeconds = Math.max(0, Math.floor((Date.now() - snapshot.createdAt) / 1000));
  return {
    data: {
      query: input.query,
      results: records,
      search_context: snapshot.id,
      coverage_level: snapshot.coverage_level,
      coverage_confidence: snapshot.coverage_confidence,
      coverage_sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
      scope: snapshot.scope,
      scope_relevance: snapshot.scope_relevance,
      scope_sufficient_for_query: snapshot.scope_sufficient_for_query,
      acquisition_complete: snapshot.acquisition_complete,
      semantic_confidence: snapshot.semantic_confidence,
      sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
      coverage_reason: snapshot.coverage_reason,
      search_objective: input.search_objective ?? "discovery",
      diagnostics: {
        response_classification: records.length ? "SEARCH_RESULTS" : "ZERO_RESULTS",
        extraction_strategy: "server_store_snapshot",
        snapshot_cache: "hit",
        acquisition_tier: snapshot.acquisition_tier,
        records_acquired: snapshot.records.length,
        records_considered: records.length,
        scope: snapshot.scope,
        scope_relevance: snapshot.scope_relevance,
        scope_sufficient_for_query: snapshot.scope_sufficient_for_query,
        acquisition_complete: snapshot.acquisition_complete,
        semantic_confidence: snapshot.semantic_confidence,
        sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
        acquisition: snapshot.acquisition,
        coverage_reason: snapshot.coverage_reason,
        network_requests: 0,
        stage_metrics_ms: { recipe_lookup: 0, platform_detection: 0, initial_search: 0, collection: 0, catalogue: 0, normalize_filter: 0, verification: 0, total: 0 },
      },
    },
    sourceUrl: snapshot.source_url,
    sourceProvider: snapshot.provider.name,
    mode: "cache",
    engine: snapshot.platform,
    upstreamProvider: snapshot.provider.id,
    retrievedAt: new Date(snapshot.createdAt).toISOString(),
    cache: { hit: true, age_seconds: ageSeconds, source_mode: "public_http" },
    provenance: {
      provider: snapshot.provider.id,
      domain: snapshot.domain,
      platform: snapshot.platform,
      provider_origin: "dynamic",
      normalized_origin: snapshot.origin,
      dynamic_discovery: "warm",
      recipe: "cached",
      snapshot_cache: "hit",
      acquisition_tier: snapshot.acquisition_tier,
    },
    outcome: records.length ? "SUCCESS" : "ZERO_RESULTS",
  };
}

function mergeCommerceProducts(base: JsonObject, current: JsonObject): JsonObject {
  const merged: JsonObject = { ...base, ...current };
  for (const [key, value] of Object.entries(current)) {
    if ((value === null || value === undefined) && base[key] !== undefined) merged[key] = base[key];
  }
  if (base.currency_verified === true && current.currency_verified !== true) {
    for (const key of ["price", "regular_price", "currency", "currency_verified", "currency_source", "currency_context_id", "currency_conflict"]) {
      if (base[key] !== undefined) merged[key] = base[key];
    }
  }
  if (current.semantic_unknown_constraints === undefined) delete merged.semantic_unknown_constraints;
  return merged;
}

function currencyCompatible(base: JsonObject, current: JsonObject): boolean {
  if (base.currency_conflict === true || current.currency_conflict === true) return false;
  const baseCurrency = typeof base.currency === "string" ? base.currency.toUpperCase() : null;
  const currentCurrency = typeof current.currency === "string" ? current.currency.toUpperCase() : null;
  if (base.currency_verified === true && current.currency_verified === true && baseCurrency && currentCurrency && baseCurrency !== currentCurrency) return false;
  if (base.currency_context_id && current.currency_context_id && base.currency_context_id !== current.currency_context_id && base.currency_verified === true && current.currency_verified === true) return false;
  return !baseCurrency || !currentCurrency || baseCurrency === currentCurrency;
}

function snapshotQueryCompatible(snapshot: StoreSnapshot, intent: CommerceQueryIntent): boolean {
  if (snapshot.scope.kind === "store" && snapshotSupportsSuperlative(snapshot)) return true;
  const acquired = new Set(queryTokens(snapshot.search_query));
  const aliases: Record<string, string[]> = {
    sweater: ["sweater", "crew", "knit", "pullover"],
    hoodie: ["hoodie", "hooded", "sweatshirt"],
    trainers: ["trainers", "trainer", "sneakers", "sneaker", "shoes", "shoe"],
    sneakers: ["sneakers", "sneaker", "trainers", "trainer", "shoes", "shoe"],
    sofa: ["sofa", "couch", "settee"],
  };
  return intent.tokens.every((token) => acquired.has(token) || (aliases[token] ?? []).some((alias) => acquired.has(alias)));
}

function executionAcquisitionComplete(result: ConnectorExecution): boolean {
  if (typeof result.data.acquisition_complete === "boolean") return result.data.acquisition_complete;
  const snapshot = typeof result.data.search_context === "string" ? getStoreSnapshot(result.data.search_context) : null;
  if (snapshot) return snapshot.acquisition_complete ?? acquisitionProvesCompleteness(snapshot.acquisition, snapshot.records.length);
  const diagnostics = record(result.data.diagnostics);
  const acquisition = record(diagnostics?.acquisition) ?? record(result.data.acquisition);
  if (acquisition) {
    return acquisitionProvesCompleteness({
      pagination_complete: acquisition.pagination_complete === true,
      records_capped: acquisition.records_capped === true,
      termination_reason: acquisition.termination_reason as "end_of_catalogue" | "end_of_collection" | "query_results" | "max_pages" | "max_products" | "max_requests" | "max_elapsed_ms" | "upstream_error" | "route_unavailable" | "no_matching_scope" | "legacy_declared_complete",
      records_acquired: Number(acquisition.records_acquired ?? 0),
    }, Array.isArray(result.data.results) ? result.data.results.length : 0);
  }
  return result.data.coverage_sufficient_for_superlative === true;
}

function executionScopeSufficient(result: ConnectorExecution, dynamic: boolean): boolean {
  if (typeof result.data.scope_sufficient_for_query === "boolean") return result.data.scope_sufficient_for_query;
  const snapshot = typeof result.data.search_context === "string" ? getStoreSnapshot(result.data.search_context) : null;
  if (snapshot) return snapshot.scope_sufficient_for_query ?? snapshot.scope_relevance?.scope_sufficient_for_query ?? snapshot.scope.kind === "store";
  const scope = record(result.data.scope);
  if (scope?.kind === "store") return true;
  return !dynamic;
}

function relevantSemanticUncertainty(product: JsonObject, intent: CommerceQueryIntent): string[] {
  const unknown = semanticUnknownConstraints(product);
  if (!unknown.length) return [];
  const requested = new Set<string>([
    ...(intent.audience ? ["audience"] : []),
    ...(intent.color ? ["color"] : []),
    ...(intent.size ? ["size"] : []),
    ...(intent.in_stock === true ? ["in_stock"] : []),
  ]);
  return unknown.filter((constraint) => requested.has(constraint));
}

function relevantSemanticConflicts(product: JsonObject, intent: CommerceQueryIntent): string[] {
  if (!Array.isArray(product.semantic_conflicts)) return [];
  const requested = intent.color || intent.in_stock === true || intent.size || intent.audience;
  return requested
    ? product.semantic_conflicts.filter((value): value is string => {
      if (typeof value !== "string") return false;
      // Variant availability is authoritative when a product-level flag
      // disagrees, but keep the disagreement visible in diagnostics.
      if (value === "variant_availability_vs_product_availability") return false;
      return true;
    })
    : [];
}

function semanticConfidenceForResults(results: JsonObject[], intent: CommerceQueryIntent, verificationFailures = 0): "high" | "partial" | "unknown" {
  if (verificationFailures > 0) return "partial";
  const uncertain = results.flatMap((product) => relevantSemanticUncertainty(product, intent));
  const conflicts = results.flatMap((product) => relevantSemanticConflicts(product, intent));
  if (uncertain.length || conflicts.length) return "partial";
  return "high";
}

function publicCommerceResult(product: JsonObject): JsonObject {
  const output = { ...product };
  delete output.semantic_unknown_constraints;
  return output;
}

async function searchProducts(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const totalStartedAt = Date.now();
  const intent = commerceIntent(input);
  const normalizedInput = normalizedCommerceInput(input, intent);
  const requestedSnapshot = typeof input.search_context === "string" ? getStoreSnapshot(input.search_context) : null;
  if (typeof input.search_context === "string" && !requestedSnapshot) throw new GatewayError("INPUT_INVALID", "search_context is expired or unknown.");
  const requestedSite = typeof input.site === "string" ? normalizePublicSite(input.site) : null;
  const coverageRequiredForCache = intent.search_objective === "ranked" || intent.search_objective === "exhaustive_ranked";
  const siteScopeHint = typeof input.site === "string" ? scopeHintForSite(input.site, intent.product_query) : null;
  const requestedScope: SnapshotScope = siteScopeHint
    ? siteScopeHint.kind === "store" && !coverageRequiredForCache
      ? { kind: "search", key: String(intent.product_query || input.query || "unknown").toLowerCase(), ...(intent.product_query ? { query: intent.product_query } : {}) }
      : siteScopeHint
    : { kind: "search", key: String(intent.product_query || input.query || "unknown").toLowerCase(), ...(intent.product_query ? { query: intent.product_query } : {}) };
  if (requestedSnapshot && requestedSite && requestedSnapshot.domain !== requestedSite.domain) {
    throw new GatewayError("INPUT_INVALID", "search_context and site must identify the same public storefront.");
  }
  const cacheLookup = requestedSnapshot
    ? { snapshot: requestedSnapshot, state: snapshotCacheState(requestedSnapshot, requestedScope, coverageRequiredForCache) }
    : requestedSite
      ? getCompatibleStoreSnapshot(requestedSite.domain, requestedScope, coverageRequiredForCache)
      : { snapshot: null, state: "miss" as const };
  const latestSnapshot = requestedSnapshot ?? cacheLookup.snapshot ?? (requestedSite ? getLatestStoreSnapshot(requestedSite.domain) : null);
  const cacheState = latestSnapshot ? snapshotCacheState(latestSnapshot, requestedScope, coverageRequiredForCache) : cacheLookup.state;
  const snapshotSupportsRequest = latestSnapshot
    && snapshotQueryCompatible(latestSnapshot, intent)
    && (cacheState === "hit_exact" || cacheState === "hit_superset");
  const warmSnapshot = snapshotSupportsRequest ? latestSnapshot : null;
  const platformDetectionStartedAt = Date.now();
  const discoveredDynamic = warmSnapshot
    ? snapshotDiscovery(warmSnapshot)
    : requestedSnapshot
      ? snapshotDiscovery(requestedSnapshot)
    : requestedSite
      ? await discoverDynamicCompatibilityProvider(input.site, context, { query: intent.product_query, locale: input.locale })
      : null;
  const dynamicDiscovery = discoveredDynamic && typeof input.site === "string"
    ? { ...discoveredDynamic, scope_hint: scopeHintForSite(input.site, intent.product_query) }
    : discoveredDynamic;
  const platformDetectionMs = Math.max(0, Date.now() - platformDetectionStartedAt);
  if ((warmSnapshot || requestedSnapshot) && !dynamicDiscovery) throw new GatewayError("INPUT_INVALID", "search_context is not a supported dynamic storefront snapshot.");
  const selection = dynamicDiscovery
    ? { providers: [dynamicDiscovery.provider.id], diagnostics: { selection_mode: "dynamic_site", site: dynamicDiscovery.provider.domain, normalized_origin: dynamicDiscovery.normalized_origin, provider_origin: "dynamic", known_before_request: dynamicDiscovery.known_before_request, recipe_cache: dynamicDiscovery.recipe_cache, platform_detected: dynamicDiscovery.provider.engine, detection_cache: dynamicDiscovery.cache_status, frameworks_detected: dynamicDiscovery.detection.frameworks, embedded_state_kinds: dynamicDiscovery.detection.embedded_state_kinds, probe_attempts: dynamicDiscovery.probe_attempts, scope: requestedScope, snapshot_cache_state: cacheState, ...(dynamicDiscovery.selected_probe ? { selected_probe: dynamicDiscovery.selected_probe } : {}) } }
    : selectProviders(input, intent);
  const providers = selection.providers;
  const providerStatus: JsonObject = {};
  const products: JsonObject[] = [];
  const successes: ConnectorExecution[] = [];
  const sourceUrls: string[] = [];
  const providerDiagnostics: JsonObject = {};
  const failures: unknown[] = [];
  const acquisitionStartedAt = Date.now();
  const settled: SearchAttempt[] = await Promise.all(providers.map(async (provider): Promise<SearchAttempt> => {
    try {
      const result = warmSnapshot
        ? snapshotExecution(warmSnapshot, normalizedInput)
        : dynamicDiscovery
          ? await executeDynamic(dynamicDiscovery.provider, "search_products", normalizedInput, dynamicExecutionContext(context, dynamicDiscovery))
          : await executeInner(provider as CommerceProvider, "search_products", normalizedInput, context);
      return { provider, result };
    } catch (error) {
      return { provider, error };
    }
  }));
  const acquisitionMs = Math.max(0, Date.now() - acquisitionStartedAt);
  const retrievedAt = new Date().toISOString();
  for (const item of settled) {
    if (item.result) {
      successes.push(item.result);
      sourceUrls.push(item.result.sourceUrl);
      const itemSnapshot = typeof item.result.data.search_context === "string" ? getStoreSnapshot(item.result.data.search_context) : warmSnapshot;
      const rows = itemSnapshot
        ? snapshotCandidates(itemSnapshot, normalizedInput.query)
        : Array.isArray(item.result.data.results) ? item.result.data.results : [];
      const normalized = rows.map((row) => commonProduct(item.provider, row, retrievedAt, item.result?.mode, item.result?.mode === "cache" ? "cached" : "live", item.result?.engine)).filter((row): row is JsonObject => Boolean(row));
      products.push(...normalized);
      if (item.result.data.diagnostics && typeof item.result.data.diagnostics === "object" && !Array.isArray(item.result.data.diagnostics)) {
        providerDiagnostics[item.provider] = item.result.data.diagnostics;
      }
      const resultDiagnostics = record(item.result.data.diagnostics);
      const resultAcquisition = record(resultDiagnostics?.acquisition) ?? record(item.result.data.acquisition);
      const resultRouteContext = record(resultDiagnostics?.route_context) ?? record(item.result.data.route_context);
      const resultScope = record(item.result.data.scope);
      const resultCoverageReason = typeof item.result.data.coverage_reason === "string"
        ? item.result.data.coverage_reason
        : typeof resultDiagnostics?.coverage_reason === "string" ? resultDiagnostics.coverage_reason : undefined;
      const priced = normalized.filter((product) => money(product.price) !== null).length;
      const resultCoverage = typeof item.result.data.coverage_confidence === "string" ? item.result.data.coverage_confidence : "unknown";
      const resultCoverageSufficient = typeof item.result.data.coverage_sufficient_for_superlative === "boolean"
        ? item.result.data.coverage_sufficient_for_superlative
        : itemSnapshot ? snapshotSupportsSuperlative(itemSnapshot) : false;
      const resultAcquisitionComplete = typeof item.result.data.acquisition_complete === "boolean"
        ? item.result.data.acquisition_complete
        : itemSnapshot?.acquisition_complete;
      const resultScopeSufficient = typeof item.result.data.scope_sufficient_for_query === "boolean"
        ? item.result.data.scope_sufficient_for_query
        : itemSnapshot?.scope_sufficient_for_query;
      const resultSemanticConfidence = typeof item.result.data.semantic_confidence === "string"
        ? item.result.data.semantic_confidence
        : itemSnapshot?.semantic_confidence;
      providerStatus[item.provider] = {
        status: item.result.outcome === "ZERO_RESULTS" ? "zero_results" : "success",
        result_count: normalized.length,
        execution_mode: item.result.mode,
        search_objective: item.result.data.search_objective ?? normalizedInput.search_objective,
        coverage_confidence: resultCoverage,
        coverage_sufficient_for_superlative: resultCoverageSufficient,
        ...(resultAcquisitionComplete !== undefined ? { acquisition_complete: resultAcquisitionComplete } : {}),
        ...(resultScopeSufficient !== undefined ? { scope_sufficient_for_query: resultScopeSufficient } : {}),
        ...(resultSemanticConfidence !== undefined ? { semantic_confidence: resultSemanticConfidence } : {}),
        sufficient_for_superlative: resultCoverageSufficient,
        ...(itemSnapshot ? {
          search_context: itemSnapshot.id,
          snapshot_cache: warmSnapshot ? cacheState : "miss",
          records_acquired: itemSnapshot.records.length,
          acquisition_tier: itemSnapshot.acquisition_tier,
          coverage_level: itemSnapshot.coverage_level,
          scope: itemSnapshot.scope,
          acquisition: itemSnapshot.acquisition,
          coverage_reason: itemSnapshot.coverage_reason,
        } : {
          ...(resultScope ? { scope: resultScope } : {}),
          ...(resultAcquisition ? { acquisition: resultAcquisition } : {}),
          ...(resultRouteContext ? { route_context: resultRouteContext } : {}),
          ...(resultCoverageReason ? { coverage_reason: resultCoverageReason } : {}),
        }),
        ...(dynamicDiscovery ? { provider_origin: "dynamic", platform: dynamicDiscovery.provider.engine, recipe_cache: dynamicDiscovery.recipe_cache, known_before_request: dynamicDiscovery.known_before_request } : {}),
        ...(item.result.engine ? { compatibility_engine: item.result.engine } : {}),
        ...(normalized.length && priced < normalized.length ? {
          completeness_status: "partial",
          completeness: { title: 1, canonical_url: 1, price: priced / normalized.length },
        } : {}),
      };
    } else {
      failures.push(item.error);
      providerStatus[item.provider] = errorInfo(item.error);
    }
  }
  const filterStartedAt = Date.now();
  let filtered = filterAndRank(products, normalizedInput, intent);
  let normalizeFilterMs = Math.max(0, Date.now() - filterStartedAt);
  for (const [provider, excluded] of Object.entries(filtered.relevance_excluded_by_provider)) {
    const current = record(providerStatus[provider]);
    if (current) providerStatus[provider] = { ...current, relevant_result_count: Math.max(0, Number(current.result_count ?? 0) - Number(excluded)) };
  }
  let escalationAttempted = false;
  let escalationFailure = false;
  let escalationSnapshot: StoreSnapshot | null = null;
  const initialCoverageIncomplete = successes.some((result) => result.data.coverage_level === "bounded_partial"
    || result.data.coverage_sufficient_for_superlative === false
    || result.data.acquisition_complete === false
    || result.data.scope_sufficient_for_query === false
    || result.data.semantic_confidence === "partial");
  const suspiciousStrictZero = Boolean(dynamicDiscovery
    && intent.hard_constraints
    && successes.length
    && (!filtered.results.length || filtered.semantic_uncertain > 0)
    && (initialCoverageIncomplete || filtered.relevance_excluded > 0 || filtered.semantic_uncertain > 0 || filtered.semantic_conflicts.length > 0));
  if (suspiciousStrictZero && dynamicDiscovery) {
    escalationAttempted = true;
    try {
      const escalated = await executeDynamic(
        dynamicDiscovery.provider,
        "search_products",
        { ...normalizedInput, search_objective: "exhaustive_ranked", hard_constraints: true },
        dynamicExecutionContext(context, dynamicDiscovery),
      );
      const snapshot = typeof escalated.data.search_context === "string" ? getStoreSnapshot(escalated.data.search_context) : null;
      escalationSnapshot = snapshot;
      const rows = snapshot ? snapshotCandidates(snapshot, normalizedInput.query) : Array.isArray(escalated.data.results) ? escalated.data.results : [];
      const escalatedProducts = rows
        .map((row) => commonProduct(dynamicDiscovery.provider.id, row, new Date().toISOString(), escalated.mode, escalated.mode === "cache" ? "cached" : "live", escalated.engine))
        .filter((row): row is JsonObject => Boolean(row));
      products.push(...escalatedProducts);
      successes.push(escalated);
      sourceUrls.push(escalated.sourceUrl);
      const escalatedDiagnostics = record(escalated.data.diagnostics);
      providerDiagnostics[dynamicDiscovery.provider.id] = {
        ...(providerDiagnostics[dynamicDiscovery.provider.id] ?? {}),
        ...(escalatedDiagnostics ?? {}),
        escalation: { attempted: true, reason: "suspicious_strict_zero", records_added: escalatedProducts.length },
      };
      const current = record(providerStatus[dynamicDiscovery.provider.id]);
      if (current) providerStatus[dynamicDiscovery.provider.id] = {
        ...current,
        escalation: { attempted: true, status: "complete", records_added: escalatedProducts.length },
        ...(snapshot ? {
          search_context: snapshot.id,
          snapshot_cache: "miss",
          records_acquired: Math.max(Number(current.records_acquired ?? 0), snapshot.records.length),
          acquisition_tier: snapshot.acquisition_tier,
          coverage_level: snapshot.coverage_level,
          scope: snapshot.scope,
          scope_relevance: snapshot.scope_relevance,
          scope_sufficient_for_query: snapshot.scope_sufficient_for_query,
          acquisition_complete: snapshot.acquisition_complete,
          semantic_confidence: snapshot.semantic_confidence,
          sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
          coverage_sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
          acquisition: snapshot.acquisition,
          coverage_reason: snapshot.coverage_reason,
        } : {}),
      };
      const escalationFilterStartedAt = Date.now();
      filtered = filterAndRank(products, normalizedInput, intent);
      normalizeFilterMs += Math.max(0, Date.now() - escalationFilterStartedAt);
    } catch (error) {
      escalationFailure = true;
      const current = record(providerStatus[dynamicDiscovery.provider.id]);
      if (current) providerStatus[dynamicDiscovery.provider.id] = {
        ...current,
        escalation: { attempted: true, status: "failed", error_code: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" },
      };
    }
  }
  if (!filtered.results.length && !successes.length) {
    throw failures[0] instanceof GatewayError ? failures[0] : new GatewayError("NO_VALID_RESULTS", "No enabled commerce provider returned a usable product result.", { retryable: false, mode: "mixed", stage: "semantic" });
  }
  const hasProviderFailure = escalationFailure || Object.values(providerStatus).some((value) => record(value)?.status === "error");
  // An escalation replaces the earlier dynamic observation for coverage
  // purposes. Keeping the initial result in the product pool is useful for
  // recall, but it must not make a successful exhaustive retry look partial.
  const coverageResults = dynamicDiscovery && successes.length
    ? [successes[successes.length - 1] as ConnectorExecution]
    : successes;
  const hasBoundedCoverage = coverageResults.some((result) => result.data.coverage_level === "bounded_partial" || result.data.acquisition_complete === false);
  const coverageRequired = intent.search_objective === "ranked" || intent.search_objective === "exhaustive_ranked";
  const needsCoverageObservation = Boolean(dynamicDiscovery) || coverageRequired;
  const acquisitionComplete = needsCoverageObservation
    ? coverageResults.length > 0 && !hasProviderFailure && coverageResults.every(executionAcquisitionComplete)
    : null;
  const scopeSufficientForQuery = needsCoverageObservation
    ? coverageResults.length > 0 && !hasProviderFailure && coverageResults.every((result) => executionScopeSufficient(result, Boolean(dynamicDiscovery)))
    : null;
  let semanticConfidence = semanticConfidenceForResults(filtered.results, intent);
  let coverageSufficient = coverageRequired
    ? acquisitionComplete === true && scopeSufficientForQuery === true && semanticConfidence === "high"
    : null;
  let coverageConfidence: "high" | "partial" | "unknown" | "not_required" = !coverageRequired
    ? hasBoundedCoverage || successes.some((result) => result.data.scope_sufficient_for_query === false) ? "partial" : "not_required"
    : coverageSufficient
      ? "high"
      : semanticConfidence === "partial" || hasBoundedCoverage || coverageResults.some((result) => result.data.scope_sufficient_for_query === false)
        ? "partial"
        : "unknown";
  let answerState = coverageRequired && coverageSufficient !== true
    ? hasProviderFailure && !filtered.results.length ? "unverified" : "partial"
    : filtered.results.length
      ? hasProviderFailure || hasBoundedCoverage || semanticConfidence !== "high" ? "partial" : "exact_match"
      : hasProviderFailure ? "unverified" : "no_exact_match";
  let verificationStatus = filtered.results.length
    ? hasProviderFailure || hasBoundedCoverage || semanticConfidence !== "high" ? "partial" : "verified"
    : hasProviderFailure ? "unverified" : "verified";
  let finalResults = filtered.results;
  let finalExactMatches = filtered.exact_matches;
  let verificationFailedCount = 0;
  const verificationStartedAt = Date.now();
  if (dynamicDiscovery && filtered.results.length) {
    const finalists = filtered.results.slice(0, 3);
    const strictVerification = coverageRequired || intent.hard_constraints;
    const verifiedByKey = new Map<string, JsonObject>();
    const failedKeys = new Set<string>();
    const winnerKey = finalists[0] ? `${finalists[0].provider}:${finalists[0].product_id}` : null;
    let winnerVerificationFailed = false;
    let verifiedCount = 0;
    let failedCount = 0;
    await Promise.all(finalists.map(async (finalist) => {
      try {
        const detail = await executeDynamic(
          dynamicDiscovery.provider,
          "get_product",
          {
            provider: dynamicDiscovery.provider.id,
            product_id: finalist.product_id,
            canonical_url: finalist.canonical_url,
            site: dynamicDiscovery.normalized_origin,
            ...(typeof finalist.currency === "string" ? { currency: finalist.currency } : {}),
            locale: input.locale,
          },
          dynamicExecutionContext(context, dynamicDiscovery),
        );
        const verifiedRaw = commonProduct(dynamicDiscovery.provider.id, detail.data.product, new Date().toISOString(), detail.mode, "live", detail.engine);
        const verified = verifiedRaw ? constrainProduct(verifiedRaw, intent).product : null;
        const semanticUncertainty = verified ? relevantSemanticUncertainty(verified, intent) : [];
        const semanticConflicts = verified ? relevantSemanticConflicts(verified, intent) : [];
        const key = `${finalist.provider}:${finalist.product_id}`;
        if (!verified || semanticUncertainty.length || semanticConflicts.length || !currencyCompatible(finalist, verified)) {
          failedCount += 1;
          if (strictVerification) {
            failedKeys.add(key);
            if (key === winnerKey) winnerVerificationFailed = true;
          }
          return;
        }
        verifiedCount += 1;
        verifiedByKey.set(key, { ...mergeCommerceProducts(finalist, verified), ranking_reasons: finalist.ranking_reasons });
      } catch {
        failedCount += 1;
        if (strictVerification) {
          const key = `${finalist.provider}:${finalist.product_id}`;
          failedKeys.add(key);
          if (key === winnerKey) winnerVerificationFailed = true;
        }
      }
    }));
    // A failed non-winning detail request is useful telemetry, but it does
    // not invalidate a winner that was independently verified. A failed
    // winner (or a fallback winner after it) keeps the answer partial.
    verificationFailedCount = winnerVerificationFailed ? failedCount : 0;
    finalResults = filtered.results
      .filter((candidate) => !failedKeys.has(`${candidate.provider}:${candidate.product_id}`))
      .map((candidate) => verifiedByKey.get(`${candidate.provider}:${candidate.product_id}`) ?? candidate);
    if (input.sort_by === "price_asc" || input.sort_by === "price_desc") {
      const direction = input.sort_by === "price_asc" ? 1 : -1;
      finalResults.sort((left, right) => (direction * ((priceBounds(left.price)?.min ?? Number.POSITIVE_INFINITY) - (priceBounds(right.price)?.min ?? Number.POSITIVE_INFINITY))) || String(left.title).localeCompare(String(right.title)));
    }
    finalExactMatches = finalResults.map((product) => ({ provider: product.provider, product_id: product.product_id }));
    if (failedCount) {
      verificationStatus = "partial";
      answerState = answerState === "exact_match" ? "partial" : answerState;
    } else if (verifiedCount) {
      verificationStatus = hasProviderFailure ? "partial" : "verified";
    }
    const current = record(providerStatus[dynamicDiscovery.provider.id]);
    if (current) providerStatus[dynamicDiscovery.provider.id] = {
      ...current,
      finalists_considered: finalists.length,
      finalists_verified: verifiedCount,
      finalist_verification: failedCount ? (verifiedCount ? "partial" : "unverified") : "verified",
    };
  }
  semanticConfidence = semanticConfidenceForResults(finalResults, intent, verificationFailedCount);
  coverageSufficient = coverageRequired
    ? acquisitionComplete === true && scopeSufficientForQuery === true && semanticConfidence === "high"
    : null;
  coverageConfidence = !coverageRequired
    ? hasBoundedCoverage || successes.some((result) => result.data.scope_sufficient_for_query === false) ? "partial" : "not_required"
    : coverageSufficient
      ? "high"
      : semanticConfidence === "partial" || hasBoundedCoverage || coverageResults.some((result) => result.data.scope_sufficient_for_query === false)
        ? "partial"
        : "unknown";
  if (coverageRequired && coverageSufficient !== true) {
    answerState = hasProviderFailure && !finalResults.length ? "unverified" : "partial";
  } else if (finalResults.length) {
    answerState = hasProviderFailure || hasBoundedCoverage || semanticConfidence !== "high" ? "partial" : "exact_match";
  } else {
    answerState = hasProviderFailure ? "unverified" : verificationFailedCount ? "partial" : "no_exact_match";
  }
  if (verificationFailedCount) {
    verificationStatus = finalResults.length ? "partial" : "unverified";
    if (!finalResults.length && !hasProviderFailure) answerState = "partial";
  } else if (finalResults.length && !hasProviderFailure && !hasBoundedCoverage && semanticConfidence === "high") {
    verificationStatus = "verified";
  }
  const verificationMs = Math.max(0, Date.now() - verificationStartedAt);
  const answerReady = answerState !== "unverified";
  const latestExecutionScope = coverageResults.length ? record(coverageResults[coverageResults.length - 1].data.scope) : null;
  // A non-ranked storefront search is an exact query scope even when it is
  // intentionally not a catalogue-complete snapshot. It can support a
  // closest-match explanation; ranked/superlative answers still require all
  // three completeness gates below.
  const latestDiagnostics = dynamicDiscovery ? record(providerDiagnostics[dynamicDiscovery.provider.id]) : null;
  const acquisitionWaterfall = Array.isArray(latestDiagnostics?.acquisition_waterfall) ? latestDiagnostics.acquisition_waterfall : [];
  const targetedRouteReturnedResults = acquisitionWaterfall.some((attempt) => {
    const entry = record(attempt);
    return typeof entry?.route === "string" && entry.route.startsWith("shopify_search_suggest") && Number(entry.returned ?? 0) > 0;
  });
  const targetedQueryResolved = Boolean(dynamicDiscovery && !coverageRequired && products.length > 0
    && (latestExecutionScope?.kind === "search" || targetedRouteReturnedResults));
  const exactSearchResolved = !hasProviderFailure
    && semanticConfidence === "high"
    && (coverageRequired
      ? coverageSufficient === true
      : !dynamicDiscovery || targetedQueryResolved || (acquisitionComplete === true && scopeSufficientForQuery === true));
  const nextAction = hasProviderFailure && !finalResults.length
    ? { tool: "commerce_search_products", reason: "A provider failed before exact matching could be concluded; retry or report the failure rather than claiming zero results." }
    : verificationFailedCount && !finalResults.length
      ? { tool: "commerce_search_products", reason: "The candidate could not be semantically verified; retry the exact search before reporting zero results or alternatives." }
    : null;
  const agentAction = answerReady && finalResults.length
    ? answerState === "exact_match" ? "answer" : "report_partial"
    : nextAction ? "follow_next_action" : "report_partial";
  const responseSnapshot = escalationSnapshot ?? successes
    .map((result) => typeof result.data.search_context === "string" ? getStoreSnapshot(result.data.search_context) : null)
    .find((value): value is StoreSnapshot => Boolean(value)) ?? warmSnapshot;
  const responseCoverageLevel = typeof responseSnapshot?.coverage_level === "string"
    ? responseSnapshot.coverage_level
    : successes.map((result) => result.data.coverage_level).find((value): value is string => typeof value === "string") ?? null;
  const responseCoverageReason = typeof responseSnapshot?.coverage_reason === "string"
    ? responseSnapshot.coverage_reason
    : successes.map((result) => result.data.coverage_reason).find((value): value is string => typeof value === "string") ?? null;
  const responseScope = responseSnapshot?.scope ?? (successes.length === 1 ? record(successes[0].data.scope) : null);
  const responseScopeRelevance = responseSnapshot?.scope_relevance
    ?? successes.map((result) => record(result.data.scope_relevance)).find((value): value is JsonObject => Boolean(value))
    ?? null;
  const responseScopeSufficient = responseSnapshot?.scope_sufficient_for_query
    ?? successes.map((result) => typeof result.data.scope_sufficient_for_query === "boolean" ? result.data.scope_sufficient_for_query : undefined).find((value): value is boolean => value !== undefined)
    ?? null;
  const responseAcquisitionComplete = responseSnapshot?.acquisition_complete
    ?? successes.map((result) => typeof result.data.acquisition_complete === "boolean" ? result.data.acquisition_complete : undefined).find((value): value is boolean => value !== undefined)
    ?? null;
  const effectiveScopeSufficient = scopeSufficientForQuery ?? responseScopeSufficient;
  const effectiveAcquisitionComplete = acquisitionComplete ?? responseAcquisitionComplete;
  const dynamicProviderDiagnostics = dynamicDiscovery ? record(providerDiagnostics[dynamicDiscovery.provider.id]) : null;
  const dynamicStageMetrics = record(dynamicProviderDiagnostics?.stage_metrics_ms);
  const uniqueColorLabels = new Set(products.flatMap(colorLabelsFromProduct));
  const colorFamilyRecords = products.filter((product) => {
    const families = colorFamiliesFromNormalized(product);
    return families.length > 0 && (!intent.color || families.includes(intent.color));
  });
  const greenFamilyRecords = products.filter((product) => colorFamiliesFromNormalized(product).includes("green"));
  const unknownColorRecords = products.filter((product) => product.color_confidence === "unknown" || (!product.color && !colorFamiliesFromNormalized(product).length));
  const currencySources = [...new Set(products.map((product) => typeof product.currency_source === "string" ? product.currency_source : null).filter((value): value is string => Boolean(value)))];
  const currencyConflicts = products.filter((product) => product.currency_conflict === true).length;
  const semanticConflicts = [...new Set(products.flatMap((product) => Array.isArray(product.semantic_conflicts)
    ? product.semantic_conflicts.filter((value): value is string => typeof value === "string")
    : []))];
  const publicResults = finalResults.map(publicCommerceResult);
  const publicClosestMatches = !finalResults.length && exactSearchResolved
    ? filtered.closest_matches.map(publicCommerceResult)
    : [];
  return {
    data: {
      query: input.query,
      ...(dynamicDiscovery ? {
        site: dynamicDiscovery.provider.domain,
        normalized_origin: dynamicDiscovery.normalized_origin,
        platform: dynamicDiscovery.provider.engine,
        provider_origin: "dynamic",
        site_scope: dynamicDiscovery.scope_hint,
        execution_mode: `${dynamicDiscovery.provider.engine}_storefront`,
        recipe_cache: dynamicDiscovery.recipe_cache,
        known_before_request: dynamicDiscovery.known_before_request,
      } : {}),
      ...(responseSnapshot ? {
        search_context: responseSnapshot.id,
        coverage_level: responseSnapshot.coverage_level,
        snapshot_cache: warmSnapshot ? cacheState : "miss",
        scope: responseSnapshot.scope,
        coverage_reason: responseSnapshot.coverage_reason,
      } : responseCoverageLevel ? {
        coverage_level: responseCoverageLevel,
        ...(responseCoverageReason ? { coverage_reason: responseCoverageReason } : {}),
        ...(responseScope ? { scope: responseScope } : {}),
      } : {}),
      results: publicResults,
      exact_matches: finalExactMatches,
      closest_matches: publicClosestMatches,
      failed_constraints: filtered.failed_constraints,
      search_objective: intent.search_objective,
      agent_action: agentAction,
      coverage_confidence: coverageConfidence,
      coverage_sufficient_for_superlative: coverageSufficient,
      acquisition_complete: effectiveAcquisitionComplete,
      scope_relevance: responseScopeRelevance,
      scope_sufficient_for_query: effectiveScopeSufficient,
      semantic_confidence: semanticConfidence,
      sufficient_for_superlative: coverageSufficient,
      coverage: {
        acquisition_complete: effectiveAcquisitionComplete,
        scope_sufficient_for_query: effectiveScopeSufficient,
        semantic_confidence: semanticConfidence,
        sufficient_for_superlative: coverageSufficient,
      },
      answer_state: answerState,
      verification_status: verificationStatus,
      answer_ready: answerReady,
      next_action: nextAction,
      providers: providerStatus,
      intent: {
        product_query: intent.product_query,
        categories: intent.categories,
        max_price: intent.max_price,
        audience: intent.audience,
        color: intent.color,
        color_family: intent.color,
        size: intent.size,
        in_stock: intent.in_stock,
        structural: intent.structure.structural,
        attributes: intent.structure.attributes,
        objective: intent.structure.objective,
        intent_structure: intent.structure,
      },
      diagnostics: {
        provider_count: providers.length,
        valid_result_count: finalResults.length,
        ranking: input.sort_by ?? "relevance",
        query_variants: normalizedInput.search_queries,
        coverage_required: coverageRequired,
        normalized_intent: intent.structure,
        acquisition_complete: effectiveAcquisitionComplete,
        scope_relevance: responseScopeRelevance,
        scope_sufficient_for_query: effectiveScopeSufficient,
        semantic_confidence: semanticConfidence,
        semantic_conflicts: semanticConflicts,
        semantic_uncertain_constraints: filtered.semantic_uncertain_constraints,
        sufficient_for_superlative: coverageSufficient,
        closest_match_eligible: exactSearchResolved,
        qualifying_products: finalResults.length,
        winner: publicResults[0]?.product_id ?? null,
        coverage: {
          acquisition_complete: effectiveAcquisitionComplete,
          scope_sufficient_for_query: effectiveScopeSufficient,
          semantic_confidence: semanticConfidence,
          sufficient_for_superlative: coverageSufficient,
        },
        escalation: {
          attempted: escalationAttempted,
          triggered_by: suspiciousStrictZero ? "suspicious_strict_zero" : null,
          ...(escalationAttempted ? { status: escalationFailure ? "failed" : "complete" } : { status: "not_needed" }),
        },
        stage_metrics_ms: {
          recipe_lookup: 0,
          platform_detection: platformDetectionMs,
          initial_search: acquisitionMs,
          collection: Number(dynamicStageMetrics?.collection ?? 0),
          catalogue: Number(dynamicStageMetrics?.catalogue ?? 0),
          normalize_filter: normalizeFilterMs,
          verification: verificationMs,
          currency: normalizeFilterMs,
          total: Math.max(0, Date.now() - totalStartedAt),
        },
        relevance_excluded: filtered.relevance_excluded,
        relevance_excluded_by_provider: filtered.relevance_excluded_by_provider,
        constraint_excluded: filtered.constraint_excluded,
        constraint_excluded_by_provider: filtered.constraint_excluded_by_provider,
        semantic_normalization: {
          records_acquired: responseSnapshot?.records.length ?? products.length,
          records_normalized: products.length,
          color_values_discovered: uniqueColorLabels.size,
          color_family_matches: colorFamilyRecords.length,
          green_family_records: greenFamilyRecords.length,
          unknown_color_records: unknownColorRecords.length,
          false_green_matches: 0,
          currency_sources: currencySources,
          currency_verified: products.filter((product) => product.currency_verified === true).length,
          currency_conflicts: currencyConflicts,
          qualifying_products: finalResults.length,
          winner: publicResults[0]?.product_id ?? null,
          verification_requests: dynamicDiscovery ? Math.min(3, filtered.results.length) : 0,
        },
        ...(responseSnapshot ? {
          snapshot_cache: warmSnapshot ? cacheState : "miss",
          search_context: responseSnapshot.id,
          snapshot: { ...snapshotSummary(responseSnapshot), cache: warmSnapshot ? cacheState : "miss" },
          records_acquired: responseSnapshot.records.length,
          acquisition_tier: responseSnapshot.acquisition_tier,
          network_requests: warmSnapshot ? 0 : responseSnapshot.network_requests,
          scope: responseSnapshot.scope,
          acquisition: responseSnapshot.acquisition,
          coverage_reason: responseSnapshot.coverage_reason,
          finalists_considered: dynamicDiscovery ? Math.min(3, filtered.results.length) : 0,
        } : {}),
        provider_selection: selection.diagnostics,
        provider_diagnostics: providerDiagnostics,
      },
    },
    sourceUrl: sourceUrls[0] ?? "https://agent-web-gateway.danemcgibbon.workers.dev",
    sourceProvider: dynamicDiscovery
      ? `${dynamicDiscovery.provider.domain} (${dynamicDiscovery.provider.engine} dynamic compatibility route)`
      : "Commerce (direct providers plus dynamic Shopify/WooCommerce platform routes)",
    mode: modeFor(successes),
    retrievedAt,
    ...(dynamicDiscovery ? {
      provenance: {
        provider: dynamicDiscovery.provider.id,
        domain: dynamicDiscovery.provider.domain,
        platform: dynamicDiscovery.provider.engine,
        normalized_origin: dynamicDiscovery.normalized_origin,
        provider_origin: "dynamic",
        known_before_request: dynamicDiscovery.known_before_request,
        recipe_cache: dynamicDiscovery.recipe_cache,
        route: String((record(providerDiagnostics[dynamicDiscovery.provider.id]) ?? {}).preferred_acquisition_route ?? (record(providerDiagnostics[dynamicDiscovery.provider.id]) ?? {}).extraction_strategy ?? "generated_platform_route"),
        dynamic_discovery: dynamicDiscovery.cache_status,
        recipe: dynamicDiscovery.recipe_cache === "cold" ? "generated" : "cached",
        ...(responseSnapshot ? { search_context: responseSnapshot.id, snapshot_cache: warmSnapshot ? cacheState : "miss", acquisition_tier: responseSnapshot.acquisition_tier, scope: responseSnapshot.scope, coverage_reason: responseSnapshot.coverage_reason } : {}),
      },
    } : {}),
    outcome: finalResults.length ? "SUCCESS" : "ZERO_RESULTS",
  };
}

async function getProduct(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const providerValue = String(input.provider);
  const provider = providerValue as CommerceProvider;
  const requestedSections = detailSections(input);
  const explicitSnapshot = typeof input.search_context === "string" ? getStoreSnapshot(input.search_context) : null;
  if (typeof input.search_context === "string" && !explicitSnapshot) throw new GatewayError("INPUT_INVALID", "search_context is expired or unknown.");
  const requestedSite = typeof input.site === "string"
    ? normalizePublicSite(input.site)
    : !COMMERCE_PROVIDERS.includes(provider) && typeof input.canonical_url === "string"
      ? (() => {
        try { return normalizePublicSite(new URL(input.canonical_url as string).origin); } catch { return null; }
      })()
      : null;
  if (explicitSnapshot && requestedSite && explicitSnapshot.domain !== requestedSite.domain) throw new GatewayError("INPUT_INVALID", "search_context and site must identify the same public storefront.");
  const dynamic = !COMMERCE_PROVIDERS.includes(provider);
  if (dynamic) {
    const site = requestedSite ?? normalizePublicSite(`https://${providerValue}`);
    if (site.domain !== dynamicProviderId(providerValue)) throw new GatewayError("INPUT_INVALID", "provider and site must identify the same public commerce domain.");
    const snapshot = explicitSnapshot ?? getLatestStoreSnapshot(site.domain) ?? getLatestStoreSnapshot(providerValue);
    if (snapshot && snapshot.domain !== site.domain) throw new GatewayError("INPUT_INVALID", "search_context and site must identify the same public storefront.");
    const cachedRaw = snapshot ? findSnapshotProduct(snapshot, String(input.product_id), typeof input.canonical_url === "string" ? input.canonical_url : undefined) : null;
    const cachedProduct = cachedRaw ? commonProduct(providerValue, cachedRaw, new Date(snapshot!.createdAt).toISOString(), "cache", "cached", snapshot!.platform) : null;
    const cacheOnlySections = requestedSections.length > 0 && requestedSections.every((section) => ["sizes", "colors", "materials", "description", "images", "provenance"].includes(section));
    const cacheSafeRequest = requestedSections.length === 0 || cacheOnlySections;
    const cacheHasRequestedSections = requestedSections.every((section) => availableDetailSections(cachedProduct ?? {}).includes(section));
    if (cachedProduct && cacheSafeRequest && cacheHasRequestedSections && (Boolean(explicitSnapshot) || cacheOnlySections)) {
      const projected = projectCommerceProduct(cachedProduct, requestedSections);
      return {
        data: {
          product: projected,
          search_context: snapshot!.id,
          ...(Array.isArray(input.include) ? { requested_sections: requestedSections } : {}),
          diagnostics: { response_classification: "PRODUCT_DETAIL", extraction_strategy: "server_store_snapshot", snapshot_cache: "hit" },
        },
        sourceUrl: snapshot!.source_url,
        sourceProvider: `${snapshot!.domain} (${snapshot!.platform} dynamic compatibility route)`,
        mode: "cache",
        engine: snapshot!.platform,
        upstreamProvider: snapshot!.provider.id,
        retrievedAt: new Date(snapshot!.createdAt).toISOString(),
        cache: { hit: true, age_seconds: Math.max(0, Math.floor((Date.now() - snapshot!.createdAt) / 1000)), source_mode: "public_http" },
        provenance: {
          provider: snapshot!.provider.id,
          domain: snapshot!.domain,
          platform: snapshot!.platform,
          provider_origin: "dynamic",
          normalized_origin: snapshot!.origin,
          dynamic_discovery: "warm",
          recipe: "cached",
          snapshot_cache: "hit",
        },
      };
    }
    const discovery = snapshot ? snapshotDiscovery(snapshot) : await discoverDynamicCompatibilityProvider(site.origin, context);
    if (!discovery) throw new GatewayError("INPUT_INVALID", "search_context is not a supported dynamic storefront snapshot.");
    const result = await executeDynamic(discovery.provider, "get_product", { ...input, site: site.origin }, dynamicExecutionContext(context, discovery));
    const product = commonProduct(providerValue, result.data.product, new Date().toISOString(), result.mode, "live", result.engine);
    if (!product) throw new GatewayError("NO_VALID_RESULTS", "The dynamic commerce site returned no valid product detail.", { retryable: false, mode: result.mode, sourceUrl: result.sourceUrl, stage: "semantic" });
    return {
      data: {
        product: projectCommerceProduct(product, requestedSections),
        ...(snapshot ? { search_context: snapshot.id } : {}),
        ...(Array.isArray(input.include) ? { requested_sections: requestedSections } : {}),
      },
      sourceUrl: result.sourceUrl,
      sourceProvider: `${discovery.provider.domain} (${discovery.provider.engine} dynamic compatibility route)`,
      mode: result.mode,
      engine: result.engine,
      upstreamProvider: result.upstreamProvider,
      retrievedAt: new Date().toISOString(),
      provenance: { ...(result.provenance ?? {}), ...(snapshot ? { search_context: snapshot.id, snapshot_cache: "miss" } : {}) },
    };
  }
  const operation = "get_product";
  const result = await executeInner(provider, operation, input, context);
  const raw = result.data.product;
  const product = commonProduct(provider, raw, new Date().toISOString(), result.mode, "live", result.engine);
  if (!product) throw new GatewayError("NO_VALID_RESULTS", "The commerce provider returned no valid product detail.", { retryable: false, mode: result.mode, sourceUrl: result.sourceUrl, stage: "semantic" });
  return {
    data: {
      product: projectCommerceProduct(product, requestedSections),
      ...(Array.isArray(input.include) ? { requested_sections: requestedSections } : {}),
    },
    sourceUrl: result.sourceUrl,
    sourceProvider: isCompatibilityProvider(provider) ? compatibilityProvider(provider)?.name : provider === "ikea" ? "IKEA UK" : provider === "amazon" ? "Amazon UK" : provider === "argos" ? "Argos UK" : "John Lewis UK",
    mode: result.mode,
    engine: result.engine,
    upstreamProvider: result.upstreamProvider,
    retrievedAt: new Date().toISOString(),
    provenance: result.provenance,
  };
}

export const commerceConnector: SiteConnector = {
  provider: "commerce",
  async execute(tool, input, context) {
    if (tool === "search_products") return searchProducts(input, context);
    if (tool === "get_product") return getProduct(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", `Commerce does not implement ${tool}.`);
  },
};
