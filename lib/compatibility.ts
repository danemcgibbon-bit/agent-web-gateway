import type { JsonObject } from "./gateway-contract";
import {
  detectAlgoliaConfig,
  detectFrameworks,
  extractEmbeddedState,
  extractApiCandidates,
  forgetRecipe,
  getRecipe,
  inspectJavascriptBundles,
  rememberRecipe,
  type AlgoliaDetection,
  type BundleInspection,
} from "./embedded-state";
import {
  fetchText,
  GatewayError,
  normalizePublicSite,
  type ConnectorContext,
  type ConnectorExecution,
  type GatewayErrorCode,
  type PublicSite,
  type SiteConnector,
} from "./gateway-runtime";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractJsonLd,
  extractMeta,
  extractTagText,
  firstNumber,
  firstString,
  isUpstreamChallenge,
  parseMoney,
  sanitizeText,
} from "./upstream-parser";
import {
  COMPATIBILITY_PROVIDERS,
  compatibilityHostMatches,
  compatibilityProductPathAllowed,
  compatibilityProvider,
  isDynamicProviderId,
  type CompatibilityEngine,
  type CompatibilityProviderDefinition,
} from "./compatibility-catalog";
import { recordExtractionBenchmark } from "./extraction-benchmark";
import { acquisitionProvesCompleteness, publicSearchCoverage, publicSearchCoverageFields } from "./commerce-coverage";

export type CompatibilityDetection = {
  engine: CompatibilityEngine | null;
  frameworks: string[];
  rendering: string;
  embedded_state_kinds: string[];
  algolia: AlgoliaDetection | null;
  woocommerce?: WooDetection;
};

export type WooDetection = {
  platform: "woocommerce" | null;
  confidence: number;
  signals: string[];
};

type WooRoute = "woo_store_api" | "woo_store_api_plain" | "woo_product_search_api" | "woo_frontend_search" | "structured_catalogue";

type WooRouteState = {
  platform: "woocommerce";
  confidence: number;
  signals: string[];
  routes: {
    store_api: boolean;
    store_api_plain: boolean;
    product_search_api: boolean;
    frontend_search: boolean;
  };
  rest_index_status: "verified" | "unknown" | "unavailable";
  store_api_verified: boolean;
  preferred_search: WooRoute | null;
  preferred_detail: WooRoute | null;
  route_failures: Partial<Record<WooRoute, number>>;
  last_verified_at: string;
};

type WooAttempt = {
  route: WooRoute;
  state: "SUCCESS_WITH_RESULTS" | "GENUINE_ZERO_RESULTS" | "ROUTE_UNUSABLE" | "ROUTE_NOT_AVAILABLE" | "ROUTE_RESTRICTED" | "PARSER_MISMATCH" | "UPSTREAM_BLOCKED" | "UPSTREAM_TIMEOUT";
  url?: string;
  error?: unknown;
};

type ProductCandidate = JsonObject;

export type DynamicCompatibilityProvider = CompatibilityProviderDefinition & {
  dynamic: true;
  site_origin: string;
};

export type SnapshotCoverageLevel = "complete_for_query" | "bounded_partial" | "unavailable";

export type SnapshotScopeKind = "store" | "collection" | "search" | "path";

export type SnapshotScope = {
  kind: SnapshotScopeKind;
  key: string;
  path?: string;
  query?: string;
};

export type ScopeRelevanceDimension = "match" | "weak" | "unknown" | "mismatch" | "narrower" | "weak_or_conflicting" | "not_applicable";

/**
 * Scope semantics are deliberately separate from transport and pagination.
 * A collection can be completely fetched and still be the wrong universe for
 * the user's request.
 */
export type ScopeRelevanceAssessment = {
  category: ScopeRelevanceDimension;
  audience: ScopeRelevanceDimension;
  color: ScopeRelevanceDimension;
  overall: "sufficient" | "insufficient" | "unknown";
  score: number;
  structural_match: boolean;
  specialization: string[];
  reasons: string[];
  scope_sufficient_for_query: boolean;
};

export type ScopeIntent = {
  structural: {
    category: string | null;
    audience: "men" | "women" | "kids" | "unisex" | null;
  };
  attributes: {
    color: string | null;
    size: string | null;
    in_stock: boolean | null;
  };
  objective?: {
    sort?: string | null;
    superlative?: boolean;
  };
};

export type SnapshotTerminationReason =
  | "end_of_catalogue"
  | "end_of_collection"
  | "query_results"
  | "max_pages"
  | "max_products"
  | "max_requests"
  | "max_elapsed_ms"
  | "upstream_error"
  | "route_unavailable"
  | "no_matching_scope"
  | "legacy_declared_complete";

export type SnapshotAcquisition = {
  strategy: string;
  scope: SnapshotScope;
  pages_fetched: number;
  pagination_complete: boolean;
  records_acquired: number;
  records_capped: boolean;
  termination_reason: SnapshotTerminationReason;
  max_pages?: number;
  max_products?: number;
  max_requests?: number;
  max_elapsed_ms?: number;
};

export type SnapshotRouteContext = {
  platform: CompatibilityEngine;
  route: string;
  currency?: string;
  currency_context_id?: string;
  currency_verified?: boolean;
  currency_source?: string;
  market_key?: string;
  locale?: string;
};

export type StoreCurrencyContext = {
  context_id: string;
  origin: string;
  market_key: string;
  currency: string | null;
  currency_verified: boolean;
  currency_source: "storefront_currency_field" | "localization_state" | "price_object" | "structured_page_metadata" | "currency_selector" | "fixed_provider" | "conflict" | "unknown";
  conflict: boolean;
  observed_at: string;
};

export type SnapshotCacheState = "hit_exact" | "hit_superset" | "hit_insufficient" | "miss" | "stale";

export type StoreSnapshot = {
  id: string;
  domain: string;
  origin: string;
  platform: CompatibilityEngine;
  provider: CompatibilityProviderDefinition | DynamicCompatibilityProvider;
  records: ProductCandidate[];
  index: Map<string, number[]>;
  search_query: string;
  createdAt: number;
  expiresAt: number;
  coverage_level: SnapshotCoverageLevel;
  coverage_confidence: "high" | "partial" | "unknown";
  source_url: string;
  acquisition_tier: string;
  network_requests: number;
  routes: string[];
  scope: SnapshotScope;
  acquisition: SnapshotAcquisition;
  route_context: SnapshotRouteContext;
  currency_context?: StoreCurrencyContext;
  coverage_reason: string;
  scope_relevance?: ScopeRelevanceAssessment;
  scope_sufficient_for_query?: boolean;
  acquisition_complete?: boolean;
  semantic_confidence?: "high" | "partial" | "unknown";
  detection?: CompatibilityDetection;
};

export type DynamicSiteProbe = {
  route: string;
  status: "success" | "blocked" | "policy_restricted" | "unavailable" | "timeout" | "invalid" | "unreachable";
  response_received: boolean;
  requested_url?: string;
  final_url?: string;
  http_status?: number;
  redirect_chain?: string[];
  response_classification?: string;
  elapsed_ms: number;
  error_code?: GatewayErrorCode;
  platform?: "shopify" | "woocommerce";
  record_count?: number;
};

export type DynamicCompatibilityDiscovery = {
  provider: DynamicCompatibilityProvider;
  detection: CompatibilityDetection;
  cache_status: "cold" | "warm";
  normalized_origin: string;
  known_before_request: boolean;
  recipe_cache: "cold" | "warm";
  probe_attempts: DynamicSiteProbe[];
  scope_hint: SnapshotScope & { requested_url?: string; collection_handle?: string };
  selected_probe?: Pick<DynamicSiteProbe, "route" | "final_url" | "platform" | "record_count">;
  selected_probe_data?: unknown;
  currency_context?: StoreCurrencyContext;
};

const ROBOTS_TTL_MS = 30 * 60 * 1000;
const WOO_ROUTE_TTL_MS = 15 * 60 * 1000;
const DYNAMIC_PROVIDER_TTL_MS = 30 * 60 * 1000;
const MAX_GENERIC_RECORDS = 40;
export const MAX_SNAPSHOT_RECORDS = 8_000;
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const MAX_SNAPSHOTS = 24;
const MAX_SHOPIFY_CATALOGUE_PAGES = 32;
const MAX_SHOPIFY_COLLECTION_PAGES = 32;
const MAX_SHOPIFY_ACQUISITION_REQUESTS = 40;
const MAX_SHOPIFY_ACQUISITION_PRODUCTS = MAX_SNAPSHOT_RECORDS;
const MAX_SHOPIFY_ACQUISITION_ELAPSED_MS = 20_000;
const SHOPIFY_PAGE_SIZE = 250;
const MAX_SHOPIFY_ROUTE_RETRIES = 4;
const ACQUISITION_CONCURRENCY = 4;
const WOO_PAGE_SIZE = 100;
const MAX_WOO_CATEGORY_PAGES = 32;
const MAX_WOO_CATEGORY_REQUESTS = 40;
const MAX_WOO_CATEGORY_ELAPSED_MS = 20_000;
const MAX_INTERNAL_SEMANTIC_RESULTS = 160;
const robotsCache = new Map<string, { expiresAt: number; text: string }>();
const robotsInflight = new Map<string, Promise<string>>();
const robotsObservation = new Map<string, DynamicSiteProbe>();
const wooRouteCache = new Map<string, WooRouteState>();
const dynamicProviderCache = new Map<string, { expiresAt: number; provider: DynamicCompatibilityProvider; detection: CompatibilityDetection; currency_context?: StoreCurrencyContext }>();
const storeSnapshots = new Map<string, StoreSnapshot>();
const latestStoreSnapshots = new Map<string, string>();
const currencyContextCache = new Map<string, { expiresAt: number; context: StoreCurrencyContext }>();
const CURRENCY_CONTEXT_TTL_MS = 15 * 60 * 1000;

const SCOPE_CATEGORY_TERMS: Record<string, string[]> = {
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

const SCOPE_SPECIALIZATION_TERMS = [
  "colorful", "colourful", "festival", "edit", "new-arrivals", "new arrivals", "trending", "trend", "gift-guide", "gift guide",
  "best-sellers", "best sellers", "summer-picks", "summer picks", "picks", "sale", "clearance", "outlet", "limited",
];

function scopeNormalized(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scopeHasTerm(value: unknown, terms: string[]): boolean {
  const source = scopeNormalized(value);
  return terms.some((term) => {
    const normalizedTerm = scopeNormalized(term);
    return new RegExp(`(?:^|\\s)${normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s)`, "i").test(source);
  });
}

function scopeCategoryFromText(value: unknown): string | null {
  const source = scopeNormalized(value);
  for (const [category, terms] of Object.entries(SCOPE_CATEGORY_TERMS)) {
    if (terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(source))) return category;
  }
  return null;
}

function scopeAudienceFromText(value: unknown): ScopeIntent["structural"]["audience"] {
  const source = scopeNormalized(value);
  if (/\b(?:unisex|gender neutral)\b/i.test(source)) return "unisex";
  if (/\b(?:men|mens|menswear|male|man)\b/i.test(source)) return "men";
  if (/\b(?:women|womens|womenswear|female|woman)\b/i.test(source)) return "women";
  if (/\b(?:kids|children|child|boys|girls|junior|youth)\b/i.test(source)) return "kids";
  return null;
}

function scopeIntentFromValue(value: unknown, fallbackQuery?: unknown): ScopeIntent {
  const item = object(value) ?? {};
  const structure = object(item.intent_structure) ?? item;
  const structural = object(structure.structural) ?? {};
  const attributes = object(structure.attributes) ?? {};
  const query = firstString(item.query, item.product_query, fallbackQuery) ?? "";
  const category = firstString(structural.category, item.category) ?? scopeCategoryFromText(query);
  const audienceValue = firstString(structural.audience, item.audience);
  const audience = audienceValue && ["men", "women", "kids", "unisex"].includes(audienceValue.toLowerCase())
    ? audienceValue.toLowerCase() as ScopeIntent["structural"]["audience"]
    : scopeAudienceFromText(query);
  const colorValue = firstString(attributes.color, item.color);
  const color = colorValue ? (colorFamilyMatches(colorValue)[0] ?? colorValue.toLowerCase()) : null;
  const sizeValue = firstString(attributes.size, item.size);
  const inStock = typeof attributes.in_stock === "boolean"
    ? attributes.in_stock
    : attributes.availability === "in_stock" ? true
      : attributes.availability === "out_of_stock" ? false
        : typeof item.in_stock === "boolean" ? item.in_stock : null;
  const objective = object(structure.objective) ?? {};
  const superlative = typeof objective.superlative === "boolean"
    ? objective.superlative
    : Boolean(item.search_objective && item.search_objective !== "discovery") || /\b(?:cheapest|lowest|highest|most expensive|all|every)\b/i.test(query);
  return {
    structural: { category: category ? category.toLowerCase() : null, audience: audience ?? null },
    attributes: { color, size: sizeValue ? sizeValue.toUpperCase() : null, in_stock: inStock },
    objective: { sort: typeof objective.sort === "string" ? objective.sort : typeof item.sort_by === "string" ? item.sort_by : null, superlative },
  };
}

function collectionSourceText(collection: JsonObject): string {
  return [
    collection.title,
    collection.name,
    collection.handle,
    collection.slug,
    collection.description,
    collection.category,
    collection.product_type,
    collection.productType,
    collection.taxonomy,
    collection.parent,
    collection.parent_title,
  ].map((value) => String(value ?? "")).join(" ");
}

function clampScopeScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

/** Deterministic, metadata-first collection relevance assessment. */
export function scoreCompatibilityCollection(value: unknown, intentValue: unknown, options: { explicit_scope?: boolean } = {}): ScopeRelevanceAssessment {
  const collection = object(value) ?? {};
  const intent = scopeIntentFromValue(intentValue);
  const source = collectionSourceText(collection);
  const normalizedSource = scopeNormalized(source);
  const category = intent.structural.category;
  const collectionCategory = scopeCategoryFromText(source);
  const collectionAudience = scopeAudienceFromText(source);
  const requestedColor = intent.attributes.color;
  const collectionFamilies = colorFamilyMatches(source);
  const specializations = SCOPE_SPECIALIZATION_TERMS.filter((term) => scopeHasTerm(normalizedSource, [term]));
  const reasons: string[] = [];
  let score = 0;
  let categoryDimension: ScopeRelevanceDimension = "not_applicable";
  let audienceDimension: ScopeRelevanceDimension = "unknown";
  let colorDimension: ScopeRelevanceDimension = requestedColor ? "unknown" : "not_applicable";

  if (category) {
    if (collectionCategory === category) {
      categoryDimension = "match";
      score += 0.5;
      reasons.push("category_match");
    } else if (collectionCategory && SCOPE_CATEGORY_TERMS[category]?.some((term) => scopeHasTerm(normalizedSource, [term]))) {
      categoryDimension = "weak";
      score += 0.25;
      reasons.push("weak_category_match");
    } else if (collectionCategory) {
      categoryDimension = "mismatch";
      score -= 0.35;
      reasons.push("category_conflict");
    } else {
      categoryDimension = "unknown";
      reasons.push("category_unknown");
    }
  }

  if (intent.structural.audience) {
    if (collectionAudience === intent.structural.audience) {
      audienceDimension = "match";
      score += 0.4;
      reasons.push("audience_match");
    } else if (collectionAudience === "unisex" && ["men", "women"].includes(intent.structural.audience)) {
      audienceDimension = "weak";
      score += 0.18;
      reasons.push("unisex_audience");
    } else if (collectionAudience) {
      audienceDimension = "mismatch";
      score -= 0.5;
      reasons.push("audience_conflict");
    } else {
      audienceDimension = "unknown";
      reasons.push("audience_unknown");
    }
  } else if (collectionAudience) {
    audienceDimension = "narrower";
    score -= 0.16;
    reasons.push("scope_narrower_than_query");
  }

  if (requestedColor) {
    if (collectionFamilies.includes(requestedColor)) {
      colorDimension = "match";
      score += 0.08;
      reasons.push("attribute_color_match");
    } else if (collectionFamilies.length) {
      colorDimension = "weak_or_conflicting";
      score -= 0.2;
      reasons.push("attribute_color_conflict");
    } else if (specializations.some((term) => ["colorful", "colourful"].includes(term))) {
      colorDimension = "weak_or_conflicting";
      score -= 0.2;
      reasons.push("color_specialization_conflict");
    }
  } else if (specializations.some((term) => ["colorful", "colourful"].includes(term))) {
    colorDimension = "weak_or_conflicting";
    score -= 0.08;
  }

  if (specializations.length) {
    score -= Math.min(0.24, specializations.length * 0.12);
    reasons.push("merchandising_specialization");
  }
  if (collection.category || collection.taxonomy || collection.parent) {
    score += 0.04;
    reasons.push("structured_collection_metadata");
  }

  const hasCategoryRequirement = Boolean(category);
  const categorySufficient = !hasCategoryRequirement || categoryDimension === "match";
  const audienceSufficient = intent.structural.audience
    // A category-aligned, non-departmental collection is a safe broader
    // universe: audience remains a downstream product filter. A conflicting
    // department is never treated as broad.
    ? audienceDimension === "match" || audienceDimension === "weak" || audienceDimension === "unknown" && categoryDimension === "match"
    : !collectionAudience || options.explicit_scope === true;
  const colorSufficient = !requestedColor || colorDimension !== "weak_or_conflicting";
  const specializationSufficient = !specializations.length || options.explicit_scope === true && categoryDimension === "match" && audienceSufficient;
  const structuralMatch = categorySufficient && audienceSufficient;
  const sufficient = structuralMatch && colorSufficient && specializationSufficient;
  const hasContradiction = categoryDimension === "mismatch"
    || audienceDimension === "mismatch"
    || colorDimension === "weak_or_conflicting"
    || specializations.length > 0;
  const overall: ScopeRelevanceAssessment["overall"] = sufficient
    ? "sufficient"
    : hasContradiction ? "insufficient"
      : categoryDimension === "unknown" || audienceDimension === "unknown" ? "unknown" : "insufficient";
  return {
    category: categoryDimension,
    audience: audienceDimension,
    color: colorDimension,
    overall,
    score: clampScopeScore(score),
    structural_match: structuralMatch,
    specialization: specializations,
    reasons: [...new Set(reasons)],
    scope_sufficient_for_query: sufficient,
  };
}

/** Short alias for callers/tests that use the conceptual name from the brief. */
export const scoreCollection = scoreCompatibilityCollection;

function scopeRelevanceForSnapshot(scope: SnapshotScope, searchQuery: unknown, intentValue?: unknown): ScopeRelevanceAssessment {
  if (scope.kind === "store") return {
    category: "not_applicable",
    audience: "not_applicable",
    color: "not_applicable",
    overall: "sufficient",
    score: 1,
    structural_match: true,
    specialization: [],
    reasons: ["store_catalogue_scope"],
    scope_sufficient_for_query: true,
  };
  if (scope.kind === "search") {
    const intent = scopeIntentFromValue(intentValue ?? { query: searchQuery });
    const searchText = scope.query ?? scope.key ?? searchQuery;
    const searchCategory = scopeCategoryFromText(searchText);
    const searchAudience = scopeAudienceFromText(searchText);
    const searchFamilies = colorFamilyMatches(searchText);
    const category = intent.structural.category
      ? searchCategory === intent.structural.category ? "match" : searchCategory ? "mismatch" : "unknown"
      : "not_applicable";
    const audience = intent.structural.audience
      ? searchAudience === intent.structural.audience || searchAudience === "unisex" && ["men", "women"].includes(intent.structural.audience) ? "match" : searchAudience ? "mismatch" : "unknown"
      : "not_applicable";
    const color = intent.attributes.color
      ? searchFamilies.includes(intent.attributes.color) ? "match" : searchFamilies.length ? "weak_or_conflicting" : "unknown"
      : "not_applicable";
    const sufficient = category !== "mismatch" && audience !== "mismatch" && color !== "weak_or_conflicting";
    return {
      category,
      audience,
      color,
      overall: sufficient ? "sufficient" : "insufficient",
      score: clampScopeScore((category === "match" ? 0.5 : 0.15) + (audience === "match" ? 0.25 : 0) + (color === "match" ? 0.1 : 0)),
      structural_match: category !== "mismatch" && audience !== "mismatch",
      specialization: [],
      reasons: ["query_scope", ...(category === "match" ? ["category_match"] : []), ...(audience === "unknown" ? ["audience_filter_applied"] : []), ...(color === "unknown" ? ["attribute_filter_applied"] : [])],
      scope_sufficient_for_query: sufficient,
    };
  }
  if (scope.kind !== "collection") return {
    category: "unknown",
    audience: "unknown",
    color: "not_applicable",
    overall: "unknown",
    score: 0,
    structural_match: false,
    specialization: [],
    reasons: ["non_collection_scope"],
    scope_sufficient_for_query: false,
  };
  return scoreCompatibilityCollection({ handle: scope.key, title: scope.key }, intentValue ?? { query: searchQuery }, { explicit_scope: false });
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function snapshotTokens(value: unknown): string[] {
  return [...new Set(String(value ?? "")
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2))];
}

const SNAPSHOT_TOKEN_ALIASES: Record<string, string[]> = {
  sweater: ["sweater", "crew", "knit", "pullover"],
  hoodie: ["hoodie", "hooded", "sweatshirt"],
  trainers: ["trainers", "trainer", "sneakers", "sneaker", "shoes", "shoe"],
  sneakers: ["sneakers", "sneaker", "trainers", "trainer", "shoes", "shoe"],
  sofa: ["sofa", "couch", "settee"],
};

function snapshotSearchableText(product: ProductCandidate): string {
  return [
    product.title,
    product.category,
    product.category_family,
    product.product_type,
    product.audience,
    product.color,
    product.color_family,
    product.tags,
    product.collections,
    product.search_terms,
  ].flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => String(value ?? "")).join(" ");
}

export type DynamicSiteScopeHint = SnapshotScope & {
  requested_url?: string;
  collection_handle?: string;
};

function normalizedScopeQuery(value: unknown): string | undefined {
  const query = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  return query ? query.toLowerCase() : undefined;
}

/** Preserve a caller's meaningful path while keeping the request origin separate. */
export function scopeHintForSite(value: unknown, query?: unknown): DynamicSiteScopeHint {
  const raw = typeof value === "string" && value.includes("://") ? value.trim() : `https://${String(value ?? "").trim()}`;
  const url = new URL(raw);
  const path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  const normalizedQueryValue = normalizedScopeQuery(query) ?? normalizedScopeQuery(url.searchParams.get("q"));
  const collectionMatch = /(?:^|\/)(?:collections|product-category|product-cat|category)\/([^/]+)$/i.exec(path);
  if (collectionMatch) {
    let handle = collectionMatch[1] ?? "";
    try { handle = decodeURIComponent(handle); } catch { /* keep the encoded handle */ }
    if (/^[a-z0-9][a-z0-9-]{1,120}$/i.test(handle)) {
      return {
        kind: "collection",
        key: handle.toLowerCase(),
        path: path.toLowerCase(),
        requested_url: url.toString(),
        collection_handle: handle,
        ...(normalizedQueryValue ? { query: normalizedQueryValue } : {}),
      };
    }
  }
  if (path === "/") {
    return {
      kind: "store",
      key: "store",
      path: "/",
      requested_url: url.toString(),
      ...(normalizedQueryValue ? { query: normalizedQueryValue } : {}),
    };
  }
  if (/\/search$/i.test(path)) {
    return {
      kind: "search",
      key: normalizedQueryValue ?? path.toLowerCase(),
      path: path.toLowerCase(),
      requested_url: url.toString(),
      ...(normalizedQueryValue ? { query: normalizedQueryValue } : {}),
    };
  }
  return {
    kind: "path",
    key: path.toLowerCase(),
    path: path.toLowerCase(),
    requested_url: url.toString(),
    ...(normalizedQueryValue ? { query: normalizedQueryValue } : {}),
  };
}

function snapshotScopeForStorage(value: SnapshotScope): SnapshotScope {
  return {
    kind: value.kind,
    key: value.key,
    ...(value.path ? { path: value.path } : {}),
    ...(value.query ? { query: value.query } : {}),
  };
}

function snapshotScopeQueryCompatible(snapshotScope: SnapshotScope, requestedScope: SnapshotScope): boolean {
  if (snapshotScope.kind === "store") return true;
  if (snapshotScope.kind !== "search" && requestedScope.kind !== "search") return true;
  const acquired = new Set(snapshotTokens(snapshotScope.query ?? snapshotScope.key));
  const requested = snapshotTokens(requestedScope.query ?? requestedScope.key);
  return requested.length === 0 || requested.every((token) => acquired.has(token) || (SNAPSHOT_TOKEN_ALIASES[token] ?? []).some((alias) => acquired.has(alias)));
}

function snapshotScopeCanSatisfy(snapshotScope: SnapshotScope, requestedScope: SnapshotScope): boolean {
  if (snapshotScope.kind === requestedScope.kind && snapshotScope.key === requestedScope.key) return true;
  if (snapshotScope.kind === "store") return true;
  if (requestedScope.kind === "collection") return snapshotScope.kind === "collection" && snapshotScope.key === requestedScope.key;
  if (requestedScope.kind === "search") {
    if (snapshotScope.kind === "search" && snapshotScope.key === requestedScope.key) return true;
    return snapshotScope.kind === "collection" && snapshotScopeQueryCompatible(snapshotScope, requestedScope);
  }
  if (requestedScope.kind === "path") return snapshotScope.kind === "path" && snapshotScope.key === requestedScope.key;
  return false;
}

export function snapshotSupportsSuperlative(snapshot: StoreSnapshot): boolean {
  const acquisitionComplete = snapshot.acquisition_complete
    ?? (snapshot.coverage_level === "complete_for_query" && acquisitionProvesCompleteness(snapshot.acquisition, snapshot.records.length));
  const scopeSufficient = snapshot.scope_sufficient_for_query
    ?? snapshot.scope_relevance?.scope_sufficient_for_query
    ?? snapshot.scope.kind === "store";
  const semanticConfidence = snapshot.semantic_confidence ?? (acquisitionComplete ? "high" : "unknown");
  return acquisitionComplete && scopeSufficient && semanticConfidence === "high";
}

export function snapshotCacheState(snapshot: StoreSnapshot | null, requestedScope: SnapshotScope, requireComplete = false): SnapshotCacheState {
  if (!snapshot) return "miss";
  if (snapshot.expiresAt <= Date.now()) return "stale";
  if (!snapshotScopeCanSatisfy(snapshot.scope, requestedScope) || !snapshotScopeQueryCompatible(snapshot.scope, requestedScope)) return "hit_insufficient";
  if (snapshot.scope.kind === "store" && requestedScope.kind !== "store" && !snapshotSupportsSuperlative(snapshot)) return "hit_insufficient";
  if (requireComplete && !snapshotSupportsSuperlative(snapshot)) return "hit_insufficient";
  return snapshot.scope.kind === requestedScope.kind && snapshot.scope.key === requestedScope.key ? "hit_exact" : "hit_superset";
}

export function getCompatibleStoreSnapshot(domain: string, requestedScope: SnapshotScope, requireComplete = false): { snapshot: StoreSnapshot | null; state: SnapshotCacheState } {
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, "");
  const candidates = [...storeSnapshots.values()]
    .filter((snapshot) => snapshot.domain === normalizedDomain)
    .sort((left, right) => right.createdAt - left.createdAt);
  const states = candidates.map((snapshot) => ({ snapshot, state: snapshotCacheState(snapshot, requestedScope, requireComplete) }));
  for (const wanted of ["hit_exact", "hit_superset"] as const) {
    const match = states.find((item) => item.state === wanted);
    if (match) return match;
  }
  const insufficient = states.find((item) => item.state === "hit_insufficient");
  if (insufficient) return insufficient;
  const stale = states.find((item) => item.state === "stale");
  return stale ?? { snapshot: null, state: "miss" };
}

function newSnapshotId(): string {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `ctx_${random.slice(0, 28)}`;
}

function snapshotIsLive(snapshot: StoreSnapshot): boolean {
  if (snapshot.expiresAt <= Date.now()) {
    storeSnapshots.delete(snapshot.id);
    if (latestStoreSnapshots.get(snapshot.domain) === snapshot.id) latestStoreSnapshots.delete(snapshot.domain);
    return false;
  }
  return true;
}

export function createStoreSnapshot(
  provider: CompatibilityProviderDefinition | DynamicCompatibilityProvider,
  records: ProductCandidate[],
  options: {
    origin?: string;
    coverage_level: SnapshotCoverageLevel;
    source_url: string;
    acquisition_tier: string;
    network_requests: number;
    routes: string[];
    detection?: CompatibilityDetection;
    search_query?: string;
    id?: string;
    scope?: SnapshotScope;
    acquisition?: Partial<SnapshotAcquisition>;
    route_context?: Partial<SnapshotRouteContext>;
    currency_context?: StoreCurrencyContext;
    intent_value?: unknown;
    coverage_reason?: string;
    scope_relevance?: ScopeRelevanceAssessment;
    scope_sufficient_for_query?: boolean;
    acquisition_complete?: boolean;
    semantic_confidence?: "high" | "partial" | "unknown";
  },
): StoreSnapshot {
  const normalized: ProductCandidate[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const id = typeof record.product_id === "string" ? record.product_id : "";
    const url = typeof record.canonical_url === "string" ? record.canonical_url : "";
    const key = `${id}:${url}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    normalized.push(record);
    if (normalized.length >= MAX_SNAPSHOT_RECORDS) break;
  }
  const now = Date.now();
  const id = options.id ?? newSnapshotId();
  const index = new Map<string, number[]>();
  normalized.forEach((record, indexValue) => {
    for (const token of snapshotTokens(snapshotSearchableText(record))) {
      const positions = index.get(token) ?? [];
      positions.push(indexValue);
      index.set(token, positions);
    }
  });
  const origin = options.origin ?? ("site_origin" in provider && typeof provider.site_origin === "string" ? provider.site_origin : provider.base_url);
  const currencyContext = options.currency_context ?? currencyContextFromValue(normalized, provider, { origin }) ?? cachedCurrencyContext(provider);
  const normalizedSearchQuery = normalizedScopeQuery(options.search_query);
  const scope = snapshotScopeForStorage(options.scope ?? (options.coverage_level === "complete_for_query"
    ? { kind: "store", key: "store", path: "/" }
    : { kind: "search", key: normalizedSearchQuery ?? "unknown", ...(normalizedSearchQuery ? { query: normalizedSearchQuery } : {}) }));
  const acquisition: SnapshotAcquisition = {
    strategy: options.acquisition?.strategy ?? (scope.kind === "collection" ? "collection" : scope.kind === "store" ? "catalogue" : "targeted_query"),
    scope: snapshotScopeForStorage(options.acquisition?.scope ?? scope),
    pages_fetched: Math.max(0, Number(options.acquisition?.pages_fetched ?? (options.coverage_level === "complete_for_query" ? 1 : 0))),
    pagination_complete: options.acquisition?.pagination_complete ?? options.coverage_level === "complete_for_query",
    records_acquired: Math.max(0, Number(options.acquisition?.records_acquired ?? normalized.length)),
    records_capped: options.acquisition?.records_capped ?? false,
    termination_reason: options.acquisition?.termination_reason ?? (options.coverage_level === "complete_for_query" ? "legacy_declared_complete" : "query_results"),
    ...(options.acquisition?.max_pages !== undefined ? { max_pages: options.acquisition.max_pages } : {}),
    ...(options.acquisition?.max_products !== undefined ? { max_products: options.acquisition.max_products } : {}),
    ...(options.acquisition?.max_requests !== undefined ? { max_requests: options.acquisition.max_requests } : {}),
    ...(options.acquisition?.max_elapsed_ms !== undefined ? { max_elapsed_ms: options.acquisition.max_elapsed_ms } : {}),
  };
  const acquisitionComplete = options.acquisition_complete
    ?? (options.coverage_level === "complete_for_query" && acquisitionProvesCompleteness(acquisition, normalized.length));
  const scopeRelevance = options.scope_relevance ?? scopeRelevanceForSnapshot(scope, options.search_query ?? "", options.intent_value);
  const scopeSufficient = options.scope_sufficient_for_query ?? scopeRelevance.scope_sufficient_for_query;
  const semanticConfidence = options.semantic_confidence ?? (acquisitionComplete ? "high" : "unknown");
  const provenComplete = acquisitionComplete && scopeSufficient && semanticConfidence === "high";
  const effectiveCoverageLevel: SnapshotCoverageLevel = provenComplete
    ? "complete_for_query"
    : options.coverage_level === "unavailable" ? "unavailable" : options.coverage_level === "complete_for_query" ? "bounded_partial" : options.coverage_level;
  const coverageReason = !scopeSufficient
    ? "scope_insufficient_for_query"
    : options.coverage_reason ?? (provenComplete
    ? scope.kind === "collection" ? "complete_relevant_collection" : "complete_store_catalogue"
    : options.coverage_level === "complete_for_query" ? "legacy_completeness_unproven"
      : options.coverage_level === "bounded_partial" ? "bounded_partial_scope" : "no_valid_structured_route");
  const routeCurrency = options.route_context?.currency ?? currencyContext?.currency;
  const snapshot: StoreSnapshot = {
    id,
    domain: provider.domain,
    origin: origin.replace(/\/$/, ""),
    platform: provider.engine,
    provider,
    records: normalized,
    index,
    search_query: options.search_query ?? "",
    createdAt: now,
    expiresAt: now + SNAPSHOT_TTL_MS,
    coverage_level: effectiveCoverageLevel,
    coverage_confidence: provenComplete ? "high" : options.coverage_level === "bounded_partial" ? "partial" : "unknown",
    source_url: options.source_url,
    acquisition_tier: options.acquisition_tier,
    network_requests: Math.max(0, options.network_requests),
    routes: [...new Set(options.routes)].slice(0, 12),
    scope,
    acquisition,
    route_context: {
      platform: provider.engine,
      route: options.route_context?.route ?? options.routes[0] ?? options.acquisition_tier,
      ...(routeCurrency ? { currency: routeCurrency } : {}),
      ...(options.route_context?.currency_context_id || currencyContext ? { currency_context_id: options.route_context?.currency_context_id ?? currencyContext?.context_id } : {}),
      ...(options.route_context?.currency_verified !== undefined || currencyContext ? { currency_verified: options.route_context?.currency_verified ?? currencyContext?.currency_verified } : {}),
      ...(options.route_context?.currency_source || currencyContext ? { currency_source: options.route_context?.currency_source ?? currencyContext?.currency_source } : {}),
      ...(options.route_context?.market_key || currencyContext ? { market_key: options.route_context?.market_key ?? currencyContext?.market_key } : {}),
      ...(options.route_context?.locale ? { locale: options.route_context.locale } : {}),
    },
    ...(currencyContext ? { currency_context: currencyContext } : {}),
    coverage_reason: coverageReason,
    scope_relevance: scopeRelevance,
    scope_sufficient_for_query: scopeSufficient,
    acquisition_complete: acquisitionComplete,
    semantic_confidence: semanticConfidence,
    ...(options.detection ? { detection: options.detection } : {}),
  };
  storeSnapshots.set(id, snapshot);
  latestStoreSnapshots.set(snapshot.domain, id);
  while (storeSnapshots.size > MAX_SNAPSHOTS) {
    const first = storeSnapshots.keys().next().value;
    if (typeof first === "string") {
      storeSnapshots.delete(first);
      for (const [domain, snapshotId] of latestStoreSnapshots) if (snapshotId === first) latestStoreSnapshots.delete(domain);
    }
    else break;
  }
  return snapshot;
}

export function getStoreSnapshot(value: unknown): StoreSnapshot | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const snapshot = storeSnapshots.get(value.trim());
  return snapshot && snapshotIsLive(snapshot) ? snapshot : null;
}

export function getLatestStoreSnapshot(domain: string): StoreSnapshot | null {
  const id = latestStoreSnapshots.get(domain.toLowerCase().replace(/^www\./, ""));
  if (!id) return null;
  const snapshot = getStoreSnapshot(id);
  if (!snapshot) latestStoreSnapshots.delete(domain.toLowerCase().replace(/^www\./, ""));
  return snapshot;
}

export function findSnapshotProduct(snapshot: StoreSnapshot, productId: string, canonicalUrl?: string): ProductCandidate | null {
  const expectedId = productId.trim().toLowerCase();
  const expectedUrl = canonicalUrl?.trim().replace(/\/$/, "").toLowerCase();
  return snapshot.records.find((product) => {
    const id = String(product.product_id ?? "").trim().toLowerCase();
    const url = String(product.canonical_url ?? "").trim().replace(/\/$/, "").toLowerCase();
    return id === expectedId || Boolean(expectedUrl && url === expectedUrl);
  }) ?? null;
}

export function snapshotCandidates(snapshot: StoreSnapshot, query: unknown): ProductCandidate[] {
  const tokens = snapshotTokens(query);
  if (!tokens.length) return snapshot.records;
  const positions = new Set<number>();
  for (const token of tokens) {
    const candidates = SNAPSHOT_TOKEN_ALIASES[token] ?? [token];
    for (const candidate of candidates) for (const position of snapshot.index.get(candidate) ?? []) positions.add(position);
  }
  if (!positions.size) return snapshot.records;
  return [...positions].sort((left, right) => left - right).map((position) => snapshot.records[position]).filter((value): value is ProductCandidate => Boolean(value));
}

export function snapshotDiscovery(snapshot: StoreSnapshot): DynamicCompatibilityDiscovery | null {
  if (!snapshot.provider.dynamic || !("site_origin" in snapshot.provider) || typeof snapshot.provider.site_origin !== "string") return null;
  const scope_hint: DynamicSiteScopeHint = {
    ...snapshot.scope,
    requested_url: `${snapshot.origin}${snapshot.scope.path && snapshot.scope.path !== "/" ? snapshot.scope.path : "/"}`,
    ...(snapshot.scope.kind === "collection" ? { collection_handle: snapshot.scope.key } : {}),
  };
  return {
    provider: snapshot.provider as DynamicCompatibilityProvider,
    detection: snapshot.detection ?? defaultDetection(snapshot.platform as "shopify" | "woocommerce"),
    cache_status: "warm",
    normalized_origin: snapshot.origin,
    known_before_request: true,
    recipe_cache: "warm",
    probe_attempts: [],
    scope_hint,
    ...(snapshot.currency_context ? { currency_context: snapshot.currency_context } : {}),
  };
}

export function snapshotSummary(snapshot: StoreSnapshot): JsonObject {
  return {
    search_context: snapshot.id,
    cache: "hit",
    coverage_level: snapshot.coverage_level,
    coverage_confidence: snapshot.coverage_confidence,
    coverage_reason: snapshot.coverage_reason,
    scope: snapshot.scope,
    ...(snapshot.scope_relevance ? { scope_relevance: snapshot.scope_relevance } : {}),
    acquisition_complete: snapshot.acquisition_complete ?? acquisitionProvesCompleteness(snapshot.acquisition, snapshot.records.length),
    scope_sufficient_for_query: snapshot.scope_sufficient_for_query ?? snapshot.scope_relevance?.scope_sufficient_for_query ?? snapshot.scope.kind === "store",
    semantic_confidence: snapshot.semantic_confidence ?? "unknown",
    sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
    acquisition: snapshot.acquisition,
    route_context: snapshot.route_context,
    ...(snapshot.currency_context ? { currency_context: snapshot.currency_context } : {}),
    records: snapshot.records.length,
    age_seconds: Math.max(0, Math.floor((Date.now() - snapshot.createdAt) / 1000)),
  };
}

function text(value: unknown, maxLength = 260): string | null {
  return sanitizeText(value, maxLength);
}

function number(value: unknown): number | null {
  return firstNumber(value);
}

function firstObject(...values: unknown[]): JsonObject | null {
  for (const value of values) {
    const result = object(value);
    if (result) return result;
  }
  return null;
}

function providerOrigin(provider: CompatibilityProviderDefinition): string {
  return provider.base_url.replace(/\/$/, "");
}

function canonicalProviderUrl(value: unknown, provider: CompatibilityProviderDefinition): string | null {
  const candidate = absoluteUrl(value, providerOrigin(provider));
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!compatibilityHostMatches(url.hostname, provider)) return null;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "") || `${providerOrigin(provider)}/`;
  } catch {
    return null;
  }
}

function productPath(url: string, provider: CompatibilityProviderDefinition): boolean {
  return compatibilityProductPathAllowed(url, provider);
}

function idFromUrl(value: string): string | null {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const last = parts.at(-1)?.replace(/\.(?:html?|json)$/i, "");
    return last && !/^(?:search|products?|items?|index|shop|category)$/i.test(last) ? last : null;
  } catch {
    return null;
  }
}

function identity(value: JsonObject, provider: CompatibilityProviderDefinition): string | null {
  const candidates = provider.engine === "shopify"
    ? [value.handle, value.slug, value.product_id, value.productId, value.sku, value.id, value.url]
    : [value.product_id, value.productId, value.item_id, value.itemId, value.sku, value.id, value.slug, value.handle, value.url];
  let raw: string | null = null;
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      raw = candidate.trim();
      break;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      raw = String(candidate);
      break;
    }
  }
  if (raw === null) return null;
  const result = raw.trim();
  if (!result || /^(?:product|products|item|items|search|results|undefined|null)$/i.test(result)) return null;
  if (/^(?:https?:\/\/|\/)/i.test(result)) return idFromUrl(canonicalProviderUrl(result, provider) ?? result) ?? null;
  return result.slice(0, 180);
}

function imageValue(value: unknown, provider: CompatibilityProviderDefinition): string | null {
  const item = Array.isArray(value) ? value[0] : value;
  const candidate = object(item);
  return absoluteUrl(candidate?.url ?? candidate?.src ?? item, providerOrigin(provider));
}

type NormalizedMoney = {
  amount?: number;
  min?: number;
  max?: number;
  currency: string | null;
  verified: boolean;
  source: "upstream_presentment" | "price_symbol" | "storefront_context" | "fixed_provider" | "conflict" | "unknown";
  context_id?: string;
  conflict?: boolean;
};

function currencyCode(value: unknown): string | null {
  const item = object(value);
  const candidate = firstString(item?.currency, item?.currency_code, item?.currencyCode, item?.priceCurrency, item?.price_currency);
  return candidate && /^[A-Za-z]{3}$/.test(candidate.trim()) ? candidate.trim().toUpperCase() : null;
}

function explicitCurrency(value: JsonObject): string | null {
  return currencyCode(value) ?? currencyCode(value.prices) ?? currencyCode(value.offers) ?? currencyCode(firstObject(value.price, value.currentPrice, value.salePrice));
}

type CurrencyEvidence = {
  code: string;
  source: StoreCurrencyContext["currency_source"];
  strength: number;
};

function currencyEvidence(value: unknown, depth = 0, path = ""): CurrencyEvidence[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.slice(0, 160).flatMap((item) => currencyEvidence(item, depth + 1, path));
  const item = object(value);
  if (!item) return [];
  const output: CurrencyEvidence[] = [];
  const directKeys = ["currency_code", "currencyCode", "priceCurrency", "price_currency", "presentment_currency", "presentmentCurrency", "shop_currency", "shopCurrency", "active_currency", "activeCurrency", "currency"];
  for (const key of directKeys) {
    const code = currencyCode({ currency: item[key] });
    if (!code) continue;
    const lowerPath = `${path}.${key}`.toLowerCase();
    const source: CurrencyEvidence["source"] = /(?:local|market|presentment|active|shop)/.test(lowerPath)
      ? "localization_state"
      : /(?:price|offer)/.test(lowerPath)
        ? "price_object"
        : "storefront_currency_field";
    output.push({ code, source, strength: source === "storefront_currency_field" ? 5 : source === "localization_state" ? 4 : 3 });
  }
  for (const [key, child] of Object.entries(item)) {
    if (child === null || child === undefined) continue;
    const childPath = path ? `${path}.${key}` : key;
    const lowerKey = key.toLowerCase();
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") continue;
    const nested = currencyEvidence(child, depth + 1, childPath);
    if (nested.length) output.push(...nested);
    if (/(?:price|offer|amount|money)/.test(lowerKey) && object(child)) {
      const code = currencyCode(child);
      if (code) output.push({ code, source: "price_object", strength: 3 });
    }
  }
  return output;
}

function currencyContextId(origin: string, marketKey: string, currency: string | null, conflict: boolean): string {
  const source = `${origin.replace(/\/$/, "").toLowerCase()}|${marketKey.toLowerCase()}|${currency ?? "unknown"}|${conflict ? "conflict" : "ok"}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `storectx_${(hash >>> 0).toString(36)}`;
}

function currencyCacheKey(origin: string, marketKey: string): string {
  return `${origin.replace(/\/$/, "").toLowerCase()}|${marketKey.toLowerCase() || "default"}`;
}

function currencyContextFromEvidence(origin: string, marketKey: string, evidence: CurrencyEvidence[]): StoreCurrencyContext | null {
  const normalizedOrigin = (() => {
    try { return new URL(origin).origin; } catch { return origin.replace(/\/$/, ""); }
  })();
  const normalizedMarketKey = marketKey.toLowerCase() || "default";
  const codes = [...new Set(evidence.map((item) => item.code))];
  if (!codes.length) return null;
  const conflict = codes.length > 1;
  const strongest = [...evidence].sort((left, right) => right.strength - left.strength)[0];
  const currency = conflict ? null : codes[0] ?? null;
  const source = conflict ? "conflict" : strongest?.source ?? "unknown";
  return {
    context_id: currencyContextId(normalizedOrigin, normalizedMarketKey, currency, conflict),
    origin: normalizedOrigin,
    market_key: normalizedMarketKey,
    currency,
    currency_verified: Boolean(currency && !conflict),
    currency_source: source,
    conflict,
    observed_at: new Date().toISOString(),
  };
}

function currencyContextFromValue(value: unknown, provider: CompatibilityProviderDefinition, options: { origin?: string; market?: unknown; locale?: unknown; route?: unknown } = {}): StoreCurrencyContext | null {
  const origin = options.origin ?? providerOrigin(provider);
  const marketKey = (text(options.market, 80) ?? text(options.locale, 80) ?? "default").toLowerCase();
  const context = currencyContextFromEvidence(origin, marketKey, currencyEvidence(value));
  if (context) currencyContextCache.set(currencyCacheKey(context.origin, context.market_key), { expiresAt: Date.now() + CURRENCY_CONTEXT_TTL_MS, context });
  return context;
}

function cachedCurrencyContext(provider: CompatibilityProviderDefinition, options: { market?: unknown; locale?: unknown } = {}): StoreCurrencyContext | null {
  const marketKey = (text(options.market, 80) ?? text(options.locale, 80) ?? "default").toLowerCase();
  const entry = currencyContextCache.get(currencyCacheKey(providerOrigin(provider), marketKey));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    currencyContextCache.delete(currencyCacheKey(providerOrigin(provider), marketKey));
    return null;
  }
  return entry.context;
}

function currencyContextFromHtml(html: string, provider: CompatibilityProviderDefinition, options: { market?: unknown; locale?: unknown } = {}): StoreCurrencyContext | null {
  const evidence: CurrencyEvidence[] = [];
  const source = html.slice(0, 2_500_000);
  const patterns: Array<{ pattern: RegExp; source: CurrencyEvidence["source"]; strength: number }> = [
    { pattern: /<meta[^>]*(?:property|name)=["']product:price:currency["'][^>]*(?:content|value)=["']([A-Z]{3})\b/gi, source: "structured_page_metadata", strength: 5 },
    { pattern: /<meta[^>]*(?:content|value)=["']([A-Z]{3})\b[^>]*(?:property|name)=["']product:price:currency["']/gi, source: "structured_page_metadata", strength: 5 },
    { pattern: /(?:data-currency|currency_code|currencyCode|shop_currency|presentment_currency|active_currency)\s*[:=]\s*["']([A-Z]{3})\b/gi, source: "structured_page_metadata", strength: 4 },
    { pattern: /(?:Shopify\s*\.\s*currency|currency\s*\.\s*active|(?:active|currency)\s*[:=])[^\n<>{}]{0,100}?["']([A-Z]{3})\b/gi, source: "localization_state", strength: 4 },
    { pattern: /(?:currency-selector|currency_select|currency)[^>]{0,180}(?:selected|active)[^>]{0,180}(?:value|data-currency)=["']([A-Z]{3})\b/gi, source: "currency_selector", strength: 4 },
  ];
  for (const entry of patterns) {
    for (const match of source.matchAll(entry.pattern)) {
      const code = String(match[1] ?? "").toUpperCase();
      if (/^[A-Z]{3}$/.test(code)) evidence.push({ code, source: entry.source, strength: entry.strength });
      if (evidence.length >= 12) break;
    }
    if (evidence.length >= 12) break;
  }
  const context = currencyContextFromEvidence(providerOrigin(provider), (text(options.market, 80) ?? text(options.locale, 80) ?? "default").toLowerCase(), evidence);
  if (context) currencyContextCache.set(currencyCacheKey(context.origin, context.market_key), { expiresAt: Date.now() + CURRENCY_CONTEXT_TTL_MS, context });
  return context;
}

function currencyContextForProduct(value: JsonObject, provider: CompatibilityProviderDefinition, supplied?: StoreCurrencyContext | null): StoreCurrencyContext | null {
  if (supplied) return supplied;
  return cachedCurrencyContext(provider) ?? currencyContextFromValue(value, provider);
}

function currencyContextFromUnknown(value: unknown): StoreCurrencyContext | null {
  const item = object(value);
  if (!item || typeof item.context_id !== "string" || typeof item.origin !== "string" || typeof item.market_key !== "string") return null;
  const source = item.currency_source;
  const validSources: StoreCurrencyContext["currency_source"][] = ["storefront_currency_field", "localization_state", "price_object", "structured_page_metadata", "currency_selector", "fixed_provider", "conflict", "unknown"];
  return {
    context_id: item.context_id,
    origin: item.origin,
    market_key: item.market_key,
    currency: typeof item.currency === "string" && /^[A-Za-z]{3}$/.test(item.currency) ? item.currency.toUpperCase() : null,
    currency_verified: item.currency_verified === true,
    currency_source: validSources.includes(source as StoreCurrencyContext["currency_source"]) ? source as StoreCurrencyContext["currency_source"] : "unknown",
    conflict: item.conflict === true,
    observed_at: typeof item.observed_at === "string" ? item.observed_at : new Date().toISOString(),
  };
}

function mergeCurrencyContexts(provider: CompatibilityProviderDefinition, supplied: StoreCurrencyContext | null, observed: StoreCurrencyContext | null, options: { market?: unknown; locale?: unknown } = {}): StoreCurrencyContext | null {
  if (!supplied) return observed;
  if (!observed) return supplied;
  if (supplied.conflict || observed.conflict || (supplied.currency && observed.currency && supplied.currency !== observed.currency)) {
    const origin = providerOrigin(provider);
    const marketKey = (text(options.market, 80) ?? text(options.locale, 80) ?? supplied.market_key ?? observed.market_key ?? "default");
    const conflict = currencyContextFromEvidence(origin, marketKey, [
      ...(supplied.currency ? [{ code: supplied.currency, source: supplied.currency_source, strength: 5 }] : []),
      ...(observed.currency ? [{ code: observed.currency, source: observed.currency_source, strength: 5 }] : []),
    ]);
    if (conflict) {
      currencyContextCache.set(currencyCacheKey(origin, marketKey), { expiresAt: Date.now() + CURRENCY_CONTEXT_TTL_MS, context: conflict });
      return conflict;
    }
  }
  return supplied.currency_verified ? supplied : observed;
}

function publicMoney(value: NormalizedMoney | null): JsonObject | null {
  if (!value) return null;
  return value.amount !== undefined
    ? { amount: value.amount, currency: value.currency }
    : value.min !== undefined && value.max !== undefined
      ? { min: value.min, max: value.max, currency: value.currency }
      : null;
}

function moneyValue(value: unknown, currency: string | null = "GBP", minorUnit?: unknown, allowFixedFallback = true, currencyContext?: StoreCurrencyContext | null): NormalizedMoney | null {
  const itemCurrency = currencyCode(value);
  const contextCurrency = currencyContext?.currency_verified ? currencyContext.currency : null;
  const declaredCurrency = itemCurrency ?? (currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null);
  const contextConflict = currencyContext?.conflict === true || Boolean(contextCurrency && declaredCurrency && contextCurrency !== declaredCurrency);
  const effectiveCurrency = contextConflict ? null : itemCurrency ?? currency ?? (allowFixedFallback ? "GBP" : contextCurrency);
  const contextMatches = Boolean(!contextConflict && contextCurrency && effectiveCurrency === contextCurrency);
  const source: NormalizedMoney["source"] = contextConflict
    ? "conflict"
    : itemCurrency
      ? "upstream_presentment"
      : contextMatches
        ? "storefront_context"
        : effectiveCurrency
          ? allowFixedFallback ? "fixed_provider" : "unknown"
          : "unknown";
  const verified = !contextConflict && Boolean(itemCurrency || contextMatches || (allowFixedFallback && effectiveCurrency));
  const contextId = currencyContext && (contextMatches || contextConflict) ? currencyContext.context_id : undefined;
  const metadata = { ...(contextId ? { context_id: contextId } : {}), ...(contextConflict ? { conflict: true } : {}) };
  const unitValue = typeof minorUnit === "string" ? Number(minorUnit) : minorUnit;
  const unit = typeof unitValue === "number" && Number.isInteger(unitValue) && unitValue > 0 ? 10 ** unitValue : 1;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { amount: value / unit, currency: effectiveCurrency, verified, source, ...metadata };
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? { amount: numeric / unit, currency: effectiveCurrency, verified, source, ...metadata } : null;
  }
  if (typeof value === "string") {
    const parsed = parseMoney(value, "GBP");
    if (parsed) {
      if (currencyContext?.currency_verified && currencyContext.currency !== parsed.currency) {
        return { amount: parsed.amount, currency: null, verified: false, source: "conflict", context_id: currencyContext.context_id, conflict: true };
      }
      return { amount: parsed.amount, currency: parsed.currency, verified: true, source: "price_symbol", ...(currencyContext ? { context_id: currencyContext.context_id } : {}) };
    }
    return null;
  }
  const raw = object(value);
  if (!raw) return null;
  const amount = firstNumber(raw.amount, raw.value, raw.price, raw.priceNumeral, raw.numeral);
  if (amount !== null && amount >= 0) {
    return { amount: amount / unit, currency: effectiveCurrency, verified, source, ...metadata };
  }
  return null;
}

function normalizedLabel(value: unknown): string | null {
  const result = text(value, 120);
  return result ? result.toLowerCase().replace(/[\u2019']/g, "'").replace(/\s+/g, " ").trim() : null;
}

function normalizedSize(value: unknown): string | null {
  const result = normalizedLabel(value);
  if (!result) return null;
  if (/^(?:large|lg|l)$/i.test(result)) return "L";
  if (/^(?:medium|med|m)$/i.test(result)) return "M";
  if (/^(?:small|sm|s)$/i.test(result)) return "S";
  if (/^(?:extra\s*large|xlarge|xl|x\s*l)$/i.test(result)) return "XL";
  if (/^(?:extra\s*small|xsmall|xs|x\s*s)$/i.test(result)) return "XS";
  return result.toUpperCase();
}

function normalizedColor(value: unknown): string | null {
  if (Array.isArray(value)) return normalizedColor(value[0]);
  const item = object(value);
  if (item) return normalizedColor(item.name ?? item.title ?? item.label ?? item.value ?? item.color ?? item.colour);
  const result = text(value, 120);
  if (!result) return null;
  const first = result.split(/[|/,]/)[0]?.trim() ?? result;
  return first || null;
}

const COLOR_FAMILY_TERMS: Record<string, string[]> = {
  green: ["green", "forest", "pine", "moss", "sage", "olive", "emerald", "jade", "fern", "mint", "kelp", "seafoam", "lichen"],
  blue: ["blue", "navy", "sky", "cobalt", "royal"],
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

const AMBIGUOUS_COLOR_TERMS = new Set(["stone", "sand", "khaki", "teal", "aqua", "rust", "wine"]);

export type CompatibilityColorSource = "product_color_field" | "variant_color_option" | "product_color_option" | "structured_product_metadata" | "title_or_handle" | "text_fallback" | "unknown";
export type CompatibilityColorConfidence = "high" | "medium" | "unknown";
export type NormalizedCompatibilityColor = {
  display: string | null;
  family: string | null;
  families: string[];
  confidence: CompatibilityColorConfidence;
  source: CompatibilityColorSource;
  conflicts?: string[];
};

function colorFamilyMatches(value: unknown): string[] {
  const source = normalizedLabel(Array.isArray(value) ? value.map((item) => normalizedColor(item)).filter(Boolean).join(" ") : value);
  if (!source) return [];
  const matches = Object.entries(COLOR_FAMILY_TERMS)
    .filter(([, terms]) => terms.some((term) => new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`, "i").test(source)))
    .map(([family]) => family);
  const ambiguous = [...AMBIGUOUS_COLOR_TERMS].some((term) => new RegExp(`\\b${term}\\b`, "i").test(source));
  return ambiguous ? [] : matches;
}

export function classifyCompatibilityColorFamily(value: unknown): string | null {
  const item = object(value);
  const rawFamilies = item?.color_families ?? item?.families;
  if (Array.isArray(rawFamilies)) {
    const families = rawFamilies.filter((candidate): candidate is string => typeof candidate === "string");
    return families.length === 1 ? families[0] : null;
  }
  const matches = colorFamilyMatches(item?.display ?? item?.family ?? item?.color_family ?? item?.color ?? item?.colour ?? item?.title ?? item?.name ?? value);
  return matches.length === 1 ? matches[0] : null;
}

function colorCandidate(value: unknown): { display: string | null; families: string[] } {
  if (Array.isArray(value)) {
    const candidates = value.map(colorCandidate).filter((candidate) => Boolean(candidate.display));
    return {
      display: candidates.length === 1 ? candidates[0].display : null,
      families: [...new Set(candidates.flatMap((candidate) => candidate.families))],
    };
  }
  const display = normalizedColor(value);
  return { display, families: colorFamilyMatches(display) };
}

function textColorCandidate(value: unknown): { display: string | null; families: string[] } {
  const source = text(value, 320);
  if (!source) return { display: null, families: [] };
  const terms = Object.values(COLOR_FAMILY_TERMS).flat().sort((left, right) => right.length - left.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const modifiers = ["heather", "fleck", "nep", "melange", "mélange", "washed", "vintage", "light", "dark", "deep", "soft"];
  const pattern = new RegExp(`\\b(?:(?:${modifiers.join("|")})\\s+)?(?:${terms.join("|")})(?:\\s+(?:(?:${terms.join("|" )})|(?:${modifiers.join("|")})))*\\b`, "i");
  const match = pattern.exec(source);
  return colorCandidate(match?.[0]);
}

function structuredColorValues(value: JsonObject): string[] {
  const output: string[] = [];
  const add = (candidate: unknown): void => {
    const display = normalizedColor(candidate);
    if (display && !output.includes(display)) output.push(display);
  };
  for (const source of [value.metadata, value.metafields, value.custom_fields, value.attributes]) {
    if (Array.isArray(source)) {
      for (const item of source) {
        const entry = object(item);
        const name = normalizedLabel(entry?.name ?? entry?.key ?? entry?.slug ?? entry?.attribute) ?? "";
        if (/color|colour|shade|tone/i.test(name)) add(entry?.value ?? entry?.option ?? entry?.label);
      }
    } else if (object(source)) {
      for (const [name, candidate] of Object.entries(source as JsonObject)) if (/color|colour|shade|tone/i.test(name)) add(candidate);
    }
  }
  for (const candidate of [value.tags, value.color_tags, value.colour_tags]) {
    for (const item of stringList(candidate, 24)) if (colorFamilyMatches(item).length) add(item);
  }
  return output;
}

export function normalizeCompatibilityColor(value: JsonObject | unknown): NormalizedCompatibilityColor {
  if (typeof value === "string" || Array.isArray(value)) {
    const candidates = (Array.isArray(value) ? value : [value]).map(colorCandidate).filter((candidate) => Boolean(candidate.display));
    const families = [...new Set(candidates.flatMap((candidate) => candidate.families))];
    return {
      display: candidates.length === 1 ? candidates[0].display : null,
      family: families.length === 1 ? families[0] : null,
      families,
      confidence: families.length ? "high" : "unknown",
      source: "product_color_field",
    };
  }
  const item = object(value) ?? {};
  const identityCandidates = [item.title, item.name, item.handle, item.slug].map(textColorCandidate);
  const identityEvidence = identityCandidates.filter((candidate) => candidate.families.length > 0);
  const identityFamilies = [...new Set(identityEvidence.flatMap((candidate) => candidate.families))];
  const withIdentityConflict = (candidate: NormalizedCompatibilityColor): NormalizedCompatibilityColor => {
    if (!identityFamilies.length || !candidate.families.length) return candidate;
    const conflicts: string[] = [];
    const titleFamilies = [...new Set(identityCandidates.slice(0, 2).flatMap((entry) => entry.families))];
    const handleFamilies = [...new Set(identityCandidates.slice(2).flatMap((entry) => entry.families))];
    if (titleFamilies.length && !candidate.families.some((family) => titleFamilies.includes(family))) conflicts.push("title_color_vs_normalized_color");
    if (handleFamilies.length && !candidate.families.some((family) => handleFamilies.includes(family))) conflicts.push("handle_color_vs_normalized_color");
    return conflicts.length ? { ...candidate, conflicts } : candidate;
  };
  const explicit = [item.color, item.colour, item.colorName, item.color_name, item.shade, item.tone]
    .map(colorCandidate)
    .filter((candidate) => Boolean(candidate.display));
  if (explicit.length) {
    const families = [...new Set(explicit.flatMap((candidate) => candidate.families))];
    return withIdentityConflict({
      display: explicit.length === 1 ? explicit[0].display : null,
      family: families.length === 1 ? families[0] : null,
      families,
      confidence: families.length ? "high" : "unknown",
      source: "product_color_field",
    });
  }
  const definitions = optionDefinitions(item);
  const variantValues = Array.isArray(item.variants)
    ? item.variants.map((variant) => {
      const entry = object(variant);
      return entry ? colorCandidate(variantAttribute(entry, "color", definitions)) : { display: null, families: [] };
    }).filter((candidate) => Boolean(candidate.display))
    : [];
  if (variantValues.length) {
    const families = [...new Set(variantValues.flatMap((candidate) => candidate.families))];
    return withIdentityConflict({
      display: variantValues.length === 1 ? variantValues[0].display : null,
      family: families.length === 1 ? families[0] : null,
      families,
      confidence: families.length ? "high" : "unknown",
      source: "variant_color_option",
    });
  }
  const options = optionValues(item, "color").map(colorCandidate).filter((candidate) => Boolean(candidate.display));
  if (options.length) {
    const families = [...new Set(options.flatMap((candidate) => candidate.families))];
    return withIdentityConflict({
      display: options.length === 1 ? options[0].display : null,
      family: families.length === 1 ? families[0] : null,
      families,
      confidence: families.length ? "high" : "unknown",
      source: "product_color_option",
    });
  }
  const structured = structuredColorValues(item).map(colorCandidate);
  if (structured.length) {
    const families = [...new Set(structured.flatMap((candidate) => candidate.families))];
    return withIdentityConflict({
      display: structured.length === 1 ? structured[0].display : null,
      family: families.length === 1 ? families[0] : null,
      families,
      confidence: families.length ? "medium" : "unknown",
      source: "structured_product_metadata",
    });
  }
  const titleWithFamily = identityCandidates.find((candidate) => candidate.families.length);
  if (titleWithFamily) {
    return {
      display: titleWithFamily.display,
      family: titleWithFamily.families.length === 1 ? titleWithFamily.families[0] : null,
      families: titleWithFamily.families,
      confidence: "high",
      source: "title_or_handle",
    };
  }
  const fallback = textColorCandidate(item.description ?? item.body_html ?? item.bodyHtml ?? item.summary);
  return fallback.display
    ? { display: fallback.display, family: fallback.families.length === 1 ? fallback.families[0] : null, families: fallback.families, confidence: "unknown", source: "text_fallback" }
    : { display: null, family: null, families: [], confidence: "unknown", source: "unknown" };
}

export function normalizeCompatibilityColorQuery(value: unknown): string | null {
  const matches = colorFamilyMatches(value);
  return matches.length === 1 ? matches[0] : null;
}

function canonicalAudience(value: unknown): "men" | "women" | "kids" | "unisex" | null {
  const source = normalizedLabel(value);
  if (!source) return null;
  if (/\b(?:unisex|gender[- ]?neutral)\b/i.test(source)) return "unisex";
  if (/\b(?:men|mens|men's|male|man|menswear)\b/i.test(source)) return "men";
  if (/\b(?:women|womens|women's|female|woman|womenswear)\b/i.test(source)) return "women";
  if (/\b(?:kids|children|child|boys?|girls?|junior|youth|childrenswear)\b/i.test(source)) return "kids";
  return null;
}

function optionDefinitions(value: JsonObject): Array<{ name: string; index: number }> {
  if (!Array.isArray(value.options)) return [];
  return value.options.slice(0, 6).map((item, index) => {
    const definition = object(item);
    return { name: normalizedLabel(definition?.name ?? definition?.label) ?? "", index: index + 1 };
  });
}

function optionKind(name: string): "color" | "size" | "audience" | null {
  if (/(?:colou?r|shade|tone)/i.test(name)) return "color";
  if (/(?:size|dimension|fit)/i.test(name)) return "size";
  if (/(?:gender|audience|department)/i.test(name)) return "audience";
  return null;
}

function variantAttribute(value: JsonObject, kind: "color" | "size" | "audience", definitions: Array<{ name: string; index: number }>): unknown {
  const explicit = kind === "color"
    ? [value.color, value.colour, value.option_color, value.optionColour]
    : kind === "size"
      ? [value.size, value.option_size, value.optionSize]
      : [value.audience, value.gender, value.department];
  for (const candidate of explicit) if (candidate !== undefined && candidate !== null) return candidate;
  const attributes = value.attributes;
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      const item = object(attribute);
      const name = normalizedLabel(item?.name ?? item?.slug ?? item?.attribute) ?? "";
      if (optionKind(name) === kind) return item?.option ?? item?.value ?? item?.label;
    }
  } else if (object(attributes)) {
    for (const [name, candidate] of Object.entries(attributes as JsonObject)) {
      if (optionKind(normalizedLabel(name) ?? "") === kind) return candidate;
    }
  }
  for (const definition of definitions) {
    if (optionKind(definition.name) === kind) return value[`option${definition.index}`];
  }
  return undefined;
}

function variantAvailable(value: JsonObject): boolean | null {
  for (const candidate of [value.available, value.availableForSale, value.available_for_sale, value.is_in_stock, value.isInStock, value.purchasable, value.is_purchasable]) {
    if (typeof candidate === "boolean") return candidate;
  }
  const status = normalizedLabel(value.stock_status ?? value.stockStatus ?? value.availability);
  if (status) {
    if (/(?:out\s*of\s*stock|unavailable|sold\s*out|backorder)/i.test(status)) return false;
    if (/(?:in\s*stock|available|instock|ready)/i.test(status)) return true;
  }
  return null;
}

function normalizeVariant(value: JsonObject, provider: CompatibilityProviderDefinition, definitions: Array<{ name: string; index: number }>, currency: string | null, minorUnit?: unknown, currencyContext?: StoreCurrencyContext | null): JsonObject | null {
  const variantId = firstString(value.variant_id, value.variantId, value.sku, value.id, value.code);
  const colorValue = variantAttribute(value, "color", definitions);
  const colorMetadata = colorCandidate(colorValue);
  const color = colorMetadata.display;
  const size = normalizedSize(variantAttribute(value, "size", definitions));
  const audience = canonicalAudience(variantAttribute(value, "audience", definitions));
  const variantCurrency = currencyCode(value) ?? currency;
  const price = moneyValue(value.display_price ?? value.price ?? value.sale_price ?? value.salePrice ?? value.currentPrice, variantCurrency, minorUnit, !provider.dynamic, currencyContext);
  const compareAtPrice = moneyValue(value.compare_at_price ?? value.compareAtPrice ?? value.regular_price ?? value.display_regular_price, variantCurrency, minorUnit, !provider.dynamic, currencyContext);
  const available = variantAvailable(value);
  const canonical = canonicalProviderUrl(value.canonical_url ?? value.canonicalUrl ?? value.url, provider);
  if (!variantId && !color && !size && !price && available === null) return null;
  return {
    variant_id: variantId,
    sku: firstString(value.sku, value.code),
    color,
    ...(colorMetadata.families.length === 1 ? { color_family: colorMetadata.families[0] } : {}),
    ...(colorMetadata.families.length > 1 ? { color_families: colorMetadata.families } : {}),
    ...(color ? { color_confidence: colorMetadata.families.length ? "high" : "unknown", color_source: "variant_color_option" } : {}),
    size,
    audience,
    price: publicMoney(price),
    compare_at_price: publicMoney(compareAtPrice),
    available,
    ...(canonical ? { canonical_url: canonical } : {}),
  };
}

function normalizedVariants(value: JsonObject, provider: CompatibilityProviderDefinition, currency: string | null, minorUnit?: unknown, currencyContext?: StoreCurrencyContext | null): JsonObject[] {
  if (!Array.isArray(value.variants)) return [];
  const definitions = optionDefinitions(value);
  const output: JsonObject[] = [];
  for (const candidate of value.variants.slice(0, 24)) {
    const variant = object(candidate);
    if (!variant) continue;
    const normalized = normalizeVariant(variant, provider, definitions, currency, minorUnit, currencyContext);
    if (normalized) output.push(normalized);
    if (output.length >= 20) break;
  }
  return output;
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => valueText(item)).join(" ");
  const item = object(value);
  if (item) return [item.name, item.title, item.label, item.handle, item.slug, item.value].map((candidate) => String(candidate ?? "")).join(" ");
  return String(value ?? "");
}

function audienceSignals(value: unknown): Array<"men" | "women" | "kids" | "unisex"> {
  const source = normalizedLabel(valueText(value));
  if (!source) return [];
  const signals: Array<"men" | "women" | "kids" | "unisex"> = [];
  if (/\b(?:unisex|gender[- ]?neutral)\b/i.test(source)) signals.push("unisex");
  if (/\b(?:men|mens|men's|male|man|menswear)\b/i.test(source)) signals.push("men");
  if (/\b(?:women|womens|women's|female|woman|womenswear)\b/i.test(source)) signals.push("women");
  if (/\b(?:kids|children|child|boys?|girls?|junior|youth|childrenswear)\b/i.test(source)) signals.push("kids");
  return [...new Set(signals)];
}

/** Weighted structured audience classification; conflicting evidence stays unknown. */
export function classifyCompatibilityAudience(value: JsonObject): "men" | "women" | "kids" | "unisex" | null {
  const scores: Record<"men" | "women" | "kids", number> = { men: 0, women: 0, kids: 0 };
  const add = (candidate: unknown, weight: number): void => {
    const signals = audienceSignals(candidate);
    if (signals.includes("unisex")) {
      scores.men = Math.max(scores.men, weight);
      scores.women = Math.max(scores.women, weight);
      return;
    }
    for (const signal of signals) if (signal !== "unisex") scores[signal] += weight;
  };
  const explicit = [value.audience, value.gender].flatMap(audienceSignals);
  if (explicit.includes("unisex")) return "unisex";
  add(value.audience, 6);
  add(value.gender, 6);
  add(value.collections, 5);
  add(value.department, 4);
  add(value.product_type ?? value.productType ?? value.category, 4);
  add(value.tags, 3);
  add(value.handle ?? value.slug, 2);
  add(value.title ?? value.name, 2);
  const ordered = (Object.entries(scores) as Array<[keyof typeof scores, number]>).sort((left, right) => right[1] - left[1]);
  if (!ordered[0] || ordered[0][1] === 0 || ordered[0][1] === ordered[1]?.[1]) return null;
  return ordered[0][0];
}

export function classifyCompatibilityCategoryFamily(value: JsonObject): string | null {
  const source = normalizedLabel([
    value.product_type,
    value.productType,
    value.category,
    value.tags,
    value.collections,
    value.title,
    value.name,
  ].map(valueText).join(" ")) ?? "";
  const candidates: Array<[string, RegExp]> = [
    ["sweater", /\b(?:sweater|knitwear|knitted|cardigan|jumper)\b/i],
    ["hoodie", /\b(?:hoodie|hooded sweatshirt)\b/i],
    ["shirt", /\b(?:shirt|blouse|top)\b/i],
    ["jacket", /\b(?:jacket|coat|outerwear)\b/i],
    ["trainers", /\b(?:trainer|trainers|sneaker|sneakers|running shoe|shoes)\b/i],
    ["sofa", /\b(?:sofa|couch|settee)\b/i],
  ];
  const matches = candidates.filter(([, pattern]) => pattern.test(source)).map(([family]) => family);
  return matches.length === 1 ? matches[0] : null;
}

function stringList(value: unknown, limit = 24): string[] {
  const values = Array.isArray(value) ? value : [value];
  const output: string[] = [];
  for (const candidate of values) {
    const item = object(candidate);
    const raw = item ? item.name ?? item.title ?? item.label ?? item.value ?? item.text : candidate;
    if (typeof raw !== "string") continue;
    for (const part of raw.split(/[\n;,|]+/)) {
      const normalized = text(part, 240);
      if (normalized && !output.includes(normalized)) output.push(normalized);
      if (output.length >= limit) return output;
    }
  }
  return output;
}

function imageList(value: unknown, provider: CompatibilityProviderDefinition, limit = 8): string[] {
  const values = Array.isArray(value) ? value : [value];
  const output: string[] = [];
  for (const candidate of values) {
    const item = object(candidate);
    const url = absoluteUrl(item?.url ?? item?.src ?? item?.image_url ?? candidate, providerOrigin(provider));
    if (url && !output.includes(url)) output.push(url);
    if (output.length >= limit) break;
  }
  return output;
}

function optionValues(value: JsonObject, kind: "color" | "size"): string[] {
  if (!Array.isArray(value.options)) return [];
  return value.options
    .filter((candidate) => {
      const item = object(candidate);
      return optionKind(normalizedLabel(item?.name ?? item?.label) ?? "") === kind;
    })
    .flatMap((candidate) => {
      const item = object(candidate);
      return stringList(item?.values ?? item?.options ?? item?.value, 24);
    });
}

function productDetailFields(
  value: JsonObject,
  provider: CompatibilityProviderDefinition,
  variants: JsonObject[],
  price: NormalizedMoney | null,
  regularPrice: NormalizedMoney | null,
  availability: string | null,
): JsonObject {
  const variantColors = variants.map((variant) => variant.color).filter((candidate): candidate is string => typeof candidate === "string");
  const colors = [...new Set([
    ...optionValues(value, "color"),
    ...stringList(value.colors ?? value.colours ?? value.color ?? value.colour, 24),
    ...variantColors,
  ])].slice(0, 24);
  const sizes = [...new Set([
    ...optionValues(value, "size").map((candidate) => normalizedSize(candidate)).filter((candidate): candidate is string => Boolean(candidate)),
    ...variants.map((variant) => typeof variant.size === "string" ? variant.size : null).filter((candidate): candidate is string => Boolean(candidate)),
  ])].slice(0, 24);
  const availableSizes = [...new Set(variants.filter((variant) => variant.available === true).map((variant) => variant.size).filter((candidate): candidate is string => typeof candidate === "string"))].slice(0, 24);
  const description = text(value.description ?? value.body_html ?? value.bodyHtml ?? value.long_description ?? value.longDescription, 1_600);
  const summary = text(value.summary ?? value.short_description ?? value.shortDescription ?? description, 420);
  let materials = stringList(value.materials ?? value.material ?? value.fabric ?? value.composition ?? value.fabric_content, 12);
  if (!materials.length && description) {
    const match = /\b(?:material|fabric|composition)\s*[:\-]\s*([^.;\n]{2,180})/i.exec(description);
    if (match?.[1]) materials = stringList(match[1], 12);
  }
  const features = stringList(value.features ?? value.highlights ?? value.bullets ?? value.specifications, 24);
  const images = imageList(value.images ?? value.media ?? value.gallery ?? value.image_url ?? value.imageUrl, provider);
  const detailsAvailable: string[] = [
    ...(price ? ["price"] : []),
    ...(availability ? ["availability"] : []),
    ...(sizes.length ? ["sizes"] : []),
    ...(colors.length ? ["colors"] : []),
    ...(variants.length ? ["variants"] : []),
    ...(materials.length ? ["materials"] : []),
    ...(description ? ["description"] : []),
    ...(images.length ? ["images"] : []),
    ...(regularPrice ? ["sale"] : []),
    "provenance",
  ];
  return {
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(materials.length ? { materials } : {}),
    ...(features.length ? { features } : {}),
    ...(sizes.length ? { sizes } : {}),
    ...(availableSizes.length ? { available_sizes: availableSizes } : {}),
    ...(colors.length ? { colors } : {}),
    ...(images.length ? { images } : {}),
    ...(regularPrice ? { sale: { price: publicMoney(price), regular_price: publicMoney(regularPrice), on_sale: Boolean(price && regularPrice && price.amount !== undefined && regularPrice.amount !== undefined && price.amount < regularPrice.amount) } } : {}),
    ...(availability ? { availability_details: availability } : {}),
    ...(Array.isArray(value.tags) ? { tags: stringList(value.tags, 40) } : {}),
    ...(Array.isArray(value.collections) ? { collections: stringList(value.collections, 24) } : {}),
    ...(typeof value.product_type === "string" ? { product_type: value.product_type } : {}),
    details_available: [...new Set(detailsAvailable)],
  };
}

function rangeMoney(value: unknown, currency: string | null = "GBP", minorUnit?: unknown, allowFixedFallback = true, currencyContext?: StoreCurrencyContext | null): NormalizedMoney | null {
  const item = object(value);
  if (!item) return null;
  const min = moneyValue(item.min ?? item.minimum ?? item.min_price ?? item.minPrice ?? item.lowPrice ?? item.from, currency, minorUnit, allowFixedFallback, currencyContext);
  const max = moneyValue(item.max ?? item.maximum ?? item.max_price ?? item.maxPrice ?? item.highPrice ?? item.to, currency, minorUnit, allowFixedFallback, currencyContext);
  if (!min && !max) return null;
  const lower = min?.amount ?? max?.amount;
  const upper = max?.amount ?? min?.amount;
  if (lower === undefined || upper === undefined || lower < 0 || upper < lower) return null;
  const conflicts = Boolean(min?.conflict || max?.conflict);
  return { min: lower, max: upper, currency: conflicts ? null : min?.currency ?? max?.currency ?? currency, verified: !conflicts && Boolean(min?.verified || max?.verified), source: conflicts ? "conflict" : min?.source ?? max?.source ?? "unknown", ...(currencyContext && (currencyContext.currency_verified || conflicts) ? { context_id: currencyContext.context_id } : {}), ...(conflicts ? { conflict: true } : {}) };
}

function productMoney(value: JsonObject, fallbackCurrency: string | null, fixedProvider: boolean, currencyContext?: StoreCurrencyContext | null): NormalizedMoney | null {
  const variants = Array.isArray(value.variants) ? value.variants : [];
  const firstVariant = object(variants[0]);
  const prices = object(value.prices);
  const currency = explicitCurrency(value) ?? fallbackCurrency;
  const minorUnit = prices?.currency_minor_unit ?? prices?.currencyMinorUnit;
  const range = rangeMoney(
    value.price_range ?? value.priceRange ?? prices?.price_range ?? prices?.priceRange ?? value.price,
    currency,
    minorUnit,
    fixedProvider,
    currencyContext,
  );
  if (range) return range;
  const variantPrices = variants
    .map((variant) => {
      const item = object(variant);
      return moneyValue(item?.display_price ?? item?.price ?? item?.sale_price, currencyCode(item) ?? currency, minorUnit, fixedProvider, currencyContext);
    })
    .filter((item): item is NormalizedMoney & { amount: number } => Boolean(item?.amount !== undefined));
  if (variantPrices.length > 1) {
    const amounts = variantPrices.map((item) => item.amount);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    if (min !== max) return { min, max, currency: variantPrices.some((item) => item.conflict) ? null : variantPrices[0].currency, verified: !variantPrices.some((item) => item.conflict) && variantPrices.every((item) => item.verified), source: variantPrices.some((item) => item.conflict) ? "conflict" : variantPrices[0].source, ...(currencyContext ? { context_id: currencyContext.context_id } : {}), ...(variantPrices.some((item) => item.conflict) ? { conflict: true } : {}) };
  }
  return moneyValue(
    value.price
      ?? value.currentPrice
      ?? value.salePrice
      ?? value.displayPrice
      ?? value.priceRange
      ?? value.offers
      ?? firstVariant?.price
      ?? prices?.price,
    currency,
    minorUnit,
    fixedProvider,
    currencyContext,
  );
}

function productRegularMoney(value: JsonObject, fallbackCurrency: string | null, fixedProvider: boolean, currencyContext?: StoreCurrencyContext | null): NormalizedMoney | null {
  const prices = object(value.prices);
  const currency = explicitCurrency(value) ?? fallbackCurrency;
  const minorUnit = prices?.currency_minor_unit ?? prices?.currencyMinorUnit;
  const firstVariant = object(Array.isArray(value.variants) ? value.variants[0] : null);
  const candidate = value.regular_price ?? value.regularPrice ?? value.compare_at_price ?? value.compareAtPrice ?? prices?.regular_price ?? prices?.regularPrice ?? value.originalPrice ?? firstVariant?.compare_at_price ?? firstVariant?.compareAtPrice ?? firstVariant?.display_regular_price;
  return rangeMoney(candidate, currency, minorUnit, fixedProvider, currencyContext) ?? moneyValue(candidate, currency, minorUnit, fixedProvider, currencyContext);
}

function genericTitle(value: string): boolean {
  return value.length < 3 || /^(?:products?|items?|search results?|shop|home|welcome|category)$/i.test(value);
}

function productFromObject(value: JsonObject, provider: CompatibilityProviderDefinition, fallbackUrl?: string, suppliedCurrencyContext?: StoreCurrencyContext | null): ProductCandidate | null {
  const canonical = canonicalProviderUrl(
    value.canonical_url ?? value.canonicalUrl ?? value.permalink ?? value.productUrl ?? value.product_url ?? value.url ?? fallbackUrl
      ?? (provider.engine === "shopify" && firstString(value.handle, value.slug) ? `${providerOrigin(provider)}/products/${encodeURIComponent(firstString(value.handle, value.slug)!)}` : null)
      ?? (provider.engine === "woocommerce" && firstString(value.slug, value.handle) ? `${providerOrigin(provider)}/product/${encodeURIComponent(firstString(value.slug, value.handle)!)}/` : null),
    provider,
  );
  if (!canonical || !productPath(canonical, provider)) return null;
  const title = firstString(value.title, value.name, value.productName, value.product_name, value.displayName);
  if (!title || genericTitle(title)) return null;
  const productId = identity(value, provider) ?? idFromUrl(canonical);
  if (!productId) return null;
  const aggregate = firstObject(value.aggregateRating, value.ratingSummary, value.reviews, value.review_summary);
  const prices = object(value.prices);
  const fixedProvider = !provider.dynamic;
  const currencyContext = fixedProvider ? null : currencyContextForProduct(value, provider, suppliedCurrencyContext);
  const currency = explicitCurrency(value) ?? (fixedProvider ? "GBP" : currencyContext?.currency ?? null);
  const minorUnit = prices?.currency_minor_unit ?? prices?.currencyMinorUnit;
  const variants = normalizedVariants(value, provider, currency, minorUnit, currencyContext);
  const variantAvailability = variants.some((variant) => variant.available === true)
    ? "in stock"
    : variants.length && variants.every((variant) => variant.available === false)
      ? "out of stock"
      : null;
  const productLevelAvailability = typeof value.available === "boolean"
    ? value.available ? "in stock" : "out of stock"
    : typeof value.availableForSale === "boolean"
      ? value.availableForSale ? "available" : "out of stock"
      : typeof value.is_in_stock === "boolean"
        ? value.is_in_stock ? "in stock" : "out of stock"
        : firstString(value.availability, value.stock_status, value.stockStatus, value.inStock, value.availabilityText, value.stockStatusLabel);
  const productLevelSaysAvailable = Boolean(productLevelAvailability
    && !/(?:out\s*of\s*stock|unavailable|sold\s*out|backorder)/i.test(productLevelAvailability)
    && /(?:in\s*stock|available|ready)/i.test(productLevelAvailability));
  const availabilityConflict = Boolean(variantAvailability && productLevelAvailability
    && (variantAvailability === "in stock") !== productLevelSaysAvailable);
  // Variant evidence answers a no-size in-stock question: one purchasable
  // variant is enough. Product-level flags are retained only when variants do
  // not provide a usable availability signal.
  const availability = variantAvailability ?? productLevelAvailability;
  const priceValue = productMoney(value, currency, fixedProvider, currencyContext);
  const regularPriceValue = productRegularMoney(value, currency, fixedProvider, currencyContext);
  const currencyConflict = priceValue?.conflict === true || currencyContext?.conflict === true;
  const variantColors = [...new Set(variants.map((variant) => variant.color).filter((item): item is string => typeof item === "string"))];
  const colorMetadata = normalizeCompatibilityColor(value);
  const color = colorMetadata.display ?? (variantColors.length === 1 ? variantColors[0] : null);
  const colorFamilies = [...new Set([...colorMetadata.families, ...variants.flatMap((variant) => Array.isArray(variant.color_families) ? variant.color_families : typeof variant.color_family === "string" ? [variant.color_family] : [])])];
  const detailFields = productDetailFields(value, provider, variants, priceValue, regularPriceValue, availability);
  const semanticConflicts = [
    ...(colorMetadata.conflicts ?? []),
    ...(availabilityConflict ? ["variant_availability_vs_product_availability"] : []),
  ];
  return {
    provider: provider.id,
    product_id: productId,
    title: title.slice(0, 260),
    price: publicMoney(priceValue),
    regular_price: publicMoney(regularPriceValue),
    currency: currencyConflict ? null : priceValue?.currency ?? currency ?? null,
    currency_verified: priceValue?.verified === true,
    currency_source: priceValue?.source ?? (currencyContext?.currency_source ?? (fixedProvider ? "fixed_provider" : "unknown")),
    ...(priceValue?.context_id || currencyContext?.context_id ? { currency_context_id: priceValue?.context_id ?? currencyContext?.context_id } : {}),
    ...(priceValue?.conflict || currencyContext?.conflict ? { currency_conflict: true } : {}),
    condition: firstString(value.condition, value.itemCondition) ?? "new",
    rating: number(value.rating ?? value.ratingValue ?? value.averageRating ?? aggregate?.ratingValue),
    rating_count: number(value.rating_count ?? value.reviewCount ?? value.review_count ?? aggregate?.reviewCount ?? aggregate?.ratingCount),
    availability,
    delivery_summary: firstString(value.delivery, value.deliverySummary, value.shipping, value.shippingLabel),
    delivery: firstString(value.delivery, value.deliverySummary, value.shipping, value.shippingLabel),
    image_url: imageValue(value.image_url ?? value.imageUrl ?? value.image ?? value.images, provider),
    canonical_url: canonical,
    audience: classifyCompatibilityAudience(value),
    color,
    color_family: colorMetadata.family ?? (colorFamilies.length === 1 ? colorFamilies[0] : null),
    color_families: colorFamilies,
    color_confidence: colorMetadata.confidence,
    color_source: colorMetadata.source,
    ...(semanticConflicts.length ? { semantic_conflicts: [...new Set(semanticConflicts)] } : {}),
    category_family: classifyCompatibilityCategoryFamily(value),
    ...(variantColors.length ? { colors: variantColors.slice(0, 12) } : {}),
    ...(variants.length ? { variants } : {}),
    ...(firstString(value.category, value.product_type, value.productType, value.type) ? { category: firstString(value.category, value.product_type, value.productType, value.type) } : {}),
    ...detailFields,
  };
}

function productType(value: JsonObject): boolean {
  const type = value["@type"];
  return type === undefined || (typeof type === "string" && type.toLowerCase() === "product") || (Array.isArray(type) && type.some((item) => typeof item === "string" && item.toLowerCase() === "product"));
}

function possibleProductObject(value: JsonObject): boolean {
  return productType(value) && Boolean(firstString(value.title, value.name, value.productName, value.product_name, value.displayName))
    && Boolean(firstString(value.url, value.canonical_url, value.canonicalUrl, value.permalink, value.productUrl, value.product_id, value.productId, value.sku, value.id, value.slug, value.handle));
}

function collectObjects(value: unknown, provider: CompatibilityProviderDefinition, output: ProductCandidate[], seen: Set<string>, depth = 0, limit = MAX_GENERIC_RECORDS, currencyContext?: StoreCurrencyContext | null): void {
  if (depth > 7 || output.length >= limit) return;
  if (Array.isArray(value)) {
    for (const child of value) collectObjects(child, provider, output, seen, depth + 1, limit, currencyContext);
    return;
  }
  const current = object(value);
  if (!current) return;
  if (possibleProductObject(current)) {
    const product = productFromObject(current, provider, undefined, currencyContext);
    if (product) {
      const key = `${product.product_id}:${product.canonical_url}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push(product);
      }
    }
  }
  for (const child of Object.values(current)) collectObjects(child, provider, output, seen, depth + 1, limit, currencyContext);
}

function anchorProducts(html: string, provider: CompatibilityProviderDefinition): ProductCandidate[] {
  const output: ProductCandidate[] = [];
  const seen = new Set<string>();
  for (const match of html.slice(0, 2_500_000).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,2600}?)<\/a>/gi)) {
    const url = canonicalProviderUrl(match[1], provider);
    if (!url || !productPath(url, provider)) continue;
    const title = text(match[2], 260);
    if (!title || genericTitle(title)) continue;
    const product = productFromObject({ name: title, title, url, id: idFromUrl(url), price: parseMoney(sanitizeText(match[2], 2600) ?? "", "GBP") }, provider);
    if (!product) continue;
    const key = `${product.product_id}:${product.canonical_url}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(product);
    }
    if (output.length >= MAX_GENERIC_RECORDS) break;
  }
  return output;
}

function wooCardProducts(html: string, provider: CompatibilityProviderDefinition): ProductCandidate[] {
  const output: ProductCandidate[] = [];
  const seen = new Set<string>();
  const source = html.slice(0, 2_500_000);
  for (const match of source.matchAll(/<a\b([^>]*)href=["']([^"']+)["'][^>]*>([\s\S]{0,3200}?)<\/a>/gi)) {
    const index = match.index ?? 0;
    const attributes = match[1] ?? "";
    const canonical = canonicalProviderUrl(match[2], provider);
    if (!canonical) continue;
    const window = source.slice(Math.max(0, index - 1200), Math.min(source.length, index + 3600));
    const dataId = /data-product[_-]id\s*=\s*["']([^"']+)["']/i.exec(`${attributes} ${window}`)?.[1]
      ?? /post-(\d{3,})/i.exec(`${attributes} ${window}`)?.[1]
      ?? null;
    const markedAsProduct = /(?:woocommerce|product[_-](?:item|card|type)|add_to_cart_button|data-product)/i.test(`${attributes} ${window}`);
    const explicitProductRoute = /\/(?:product|products|shop)\//i.test(new URL(canonical).pathname);
    if (!markedAsProduct && !explicitProductRoute) continue;
    const title = text(
      extractTagText(window, "h2")
        ?? extractTagText(window, "h3")
        ?? extractTagText(window, "h4")
        ?? /<img\b[^>]*alt=["']([^"']+)["']/i.exec(match[3] ?? "")?.[1]
        ?? match[3],
      260,
    );
    if (!title || genericTitle(title)) continue;
    const product = productFromObject({
      id: dataId ?? idFromUrl(canonical),
      title,
      name: title,
      url: canonical,
      price: parseMoney(sanitizeText(window, 4200) ?? "", "GBP"),
    }, provider);
    if (!product) continue;
    const key = `${product.product_id}:${product.canonical_url}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(product);
    }
    if (output.length >= MAX_GENERIC_RECORDS) break;
  }
  return output;
}

function parseWooVariations(html: string): JsonObject[] {
  const output: JsonObject[] = [];
  for (const match of html.slice(0, 2_500_000).matchAll(/data-product_variations\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    const raw = decodeHtmlEntities(match[2] ?? "").trim();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const value of parsed) {
        const item = object(value);
        if (item) output.push(item);
        if (output.length >= 30) break;
      }
    } catch {
      // Theme variation attributes are optional and may be HTML-escaped.
    }
    if (output.length >= 30) break;
  }
  return output;
}

function wooVariationFields(html: string): JsonObject {
  const variations = parseWooVariations(html);
  if (!variations.length) return {};
  const prices = variations
    .map((item) => moneyValue(item.display_price ?? item.price ?? item.sale_price, "GBP"))
    .filter((item): item is NormalizedMoney & { amount: number } => Boolean(item?.amount !== undefined));
  const regularPrices = variations
    .map((item) => moneyValue(item.display_regular_price ?? item.regular_price, "GBP"))
    .filter((item): item is NormalizedMoney & { amount: number } => Boolean(item?.amount !== undefined));
  const fields: JsonObject = {
    variants: variations.slice(0, 20).map((item) => ({
      variation_id: item.variation_id ?? item.id ?? null,
      attributes: item.attributes ?? null,
      price: item.display_price ?? item.price ?? null,
      regular_price: item.display_regular_price ?? item.regular_price ?? null,
      available: typeof item.is_in_stock === "boolean" ? item.is_in_stock : item.is_purchasable ?? null,
      image: item.image ?? null,
    })),
  };
  if (prices.length) {
    const amounts = prices.map((item) => item.amount);
    fields.price = amounts.every((amount) => amount === amounts[0])
      ? publicMoney(prices[0])
      : { min: Math.min(...amounts), max: Math.max(...amounts), currency: prices[0].currency };
  }
  if (regularPrices.length) {
    const amounts = regularPrices.map((item) => item.amount);
    fields.regular_price = amounts.every((amount) => amount === amounts[0])
      ? publicMoney(regularPrices[0])
      : { min: Math.min(...amounts), max: Math.max(...amounts), currency: regularPrices[0].currency };
  }
  return fields;
}

function flightHints(html: string, provider: CompatibilityProviderDefinition): ProductCandidate[] {
  const output: ProductCandidate[] = [];
  const pattern = /(?:productId|product_id|sku|handle|slug)["']?\s*:\s*["']([^"']{2,180})["'][\s\S]{0,1200}?(?:name|title|productName)["']?\s*:\s*["']([^"']{3,260})["']/gi;
  for (const match of html.slice(0, 2_500_000).matchAll(pattern)) {
    const nearby = html.slice(Math.max(0, (match.index ?? 0) - 400), Math.min(html.length, (match.index ?? 0) + 1800));
    const url = /(?:canonical_url|canonicalUrl|productUrl|url)["']?\s*:\s*["'](https?:\/\/[^"']+|\/[^"']+)["']/i.exec(nearby)?.[1];
    const product = productFromObject({ id: match[1], productId: match[1], name: match[2], title: match[2], url }, provider);
    if (product) output.push(product);
    if (output.length >= 12) break;
  }
  return output;
}

export function extractCompatibilityProducts(html: string, provider: CompatibilityProviderDefinition, fallbackUrl?: string, options: { currency_context?: StoreCurrencyContext; market?: unknown; locale?: unknown } = {}): ProductCandidate[] {
  const currencyContext = options.currency_context ?? currencyContextFromHtml(html, provider, options) ?? cachedCurrencyContext(provider, options);
  const output: ProductCandidate[] = [];
  const seen = new Set<string>();
  const seenUrls = new Set<string>();
  const add = (product: ProductCandidate | null): void => {
    if (!product) return;
    const key = `${product.product_id}:${product.canonical_url}`;
    const canonical = typeof product.canonical_url === "string" ? product.canonical_url : "";
    if (seen.has(key) || (canonical && seenUrls.has(canonical))) return;
    seen.add(key);
    if (canonical) seenUrls.add(canonical);
    output.push(product);
  };
  for (const state of extractEmbeddedState(html)) collectObjects(state.value, provider, output, seen, 0, MAX_GENERIC_RECORDS, currencyContext);
  if (provider.engine === "woocommerce") {
    for (const product of wooCardProducts(html, provider)) add(product);
  }
  for (const product of anchorProducts(html, provider)) add(product);
  for (const product of flightHints(html, provider)) add(product);
  const canonical = canonicalProviderUrl(fallbackUrl, provider);
  if (!output.length && canonical) {
    const title = text(extractTagText(html, "h1") ?? extractMeta(html, "og:title"), 260);
    if (title) add(productFromObject({ title, name: title, url: canonical, id: idFromUrl(canonical) }, provider));
  }
  return output.slice(0, MAX_GENERIC_RECORDS);
}

export function normalizeCompatibilityProducts(value: unknown, provider: CompatibilityProviderDefinition, limit = MAX_GENERIC_RECORDS, options: { currency_context?: StoreCurrencyContext; market?: unknown; locale?: unknown; route?: unknown; use_cached_context?: boolean } = {}): ProductCandidate[] {
  const observedContext = currencyContextFromValue(value, provider, { market: options.market, locale: options.locale, route: options.route });
  const cachedContext = options.use_cached_context === false ? null : cachedCurrencyContext(provider, options);
  const currencyContext = mergeCurrencyContexts(provider, options.currency_context ?? cachedContext, observedContext, options)
    ?? options.currency_context
    ?? (options.use_cached_context === false ? null : cachedContext);
  const output: ProductCandidate[] = [];
  const seen = new Set<string>();
  collectObjects(value, provider, output, seen, 0, Math.min(MAX_SNAPSHOT_RECORDS, Math.max(1, limit)), currencyContext);
  return output.slice(0, Math.min(MAX_SNAPSHOT_RECORDS, Math.max(1, limit)));
}

function queryTokens(value: unknown): string[] {
  return [...new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2))];
}

function queryFilter(products: ProductCandidate[], query: unknown, requireMatch = false): ProductCandidate[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return products;
  const matched = products.filter((product) => tokens.some((token) => String(product.title ?? "").toLowerCase().includes(token)));
  return matched.length || requireMatch ? matched : products;
}

function pageBlocked(html: string): boolean {
  const visible = sanitizeText(html, 12_000) ?? "";
  return isUpstreamChallenge(html) || /(?:automated access|checking your browser|enable javascript|verify you(?:'|’)re human|access denied)/i.test(visible);
}

function noResults(html: string): boolean {
  return /(?:no results|no products found|nothing matched|couldn['’]?t find|0 products)/i.test(sanitizeText(html, 12_000) ?? "");
}

export function detectWooCommerce(html: string): WooDetection {
  const source = html.slice(0, 2_500_000);
  const signals: string[] = [];
  const add = (signal: string): void => {
    if (!signals.includes(signal)) signals.push(signal);
  };
  if (/wp-json\/?|rest_route=/i.test(source)) add("WordPress REST markers");
  if (/wc\/store(?:\/v\d+)?|wc-blocks/i.test(source)) add("Woo Store API or blocks markers");
  if (/woocommerce(?:-[a-z-]+)?(?:\.min)?\.(?:js|css)|woocommerce(?:_|-)(?:product|cart|checkout)/i.test(source)) add("WooCommerce frontend assets");
  if (/(?:class|id)=["'][^"']*(?:woocommerce|product[_-](?:type|card)|add_to_cart_button)[^"']*["']/i.test(source)) add("WooCommerce product markup");
  if (/data-product[_-]id\s*=|data-product_variations\s*=/i.test(source)) add("WooCommerce product data attributes");
  if (extractJsonLd(source).some((item) => {
    const type = item["@type"];
    return (type === "Product" || (Array.isArray(type) && type.includes("Product"))) && Boolean(item.offers || item.brand || item.sku);
  })) add("Product schema with commerce fields");
  const score = Math.min(0.99, signals.reduce((total, signal) => total + (
    signal === "Woo Store API or blocks markers" ? 0.35
      : signal === "WordPress REST markers" ? 0.25
        : signal === "WooCommerce frontend assets" ? 0.24
          : signal === "WooCommerce product data attributes" ? 0.22
            : signal === "WooCommerce product markup" ? 0.2
              : 0.12
  ), 0));
  return { platform: score >= 0.45 ? "woocommerce" : null, confidence: Math.round(score * 100) / 100, signals };
}

function robotsAllows(robots: string, target: string): boolean {
  const lines = robots.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
  let applies = false;
  const rules: Array<{ allow: boolean; path: string }> = [];
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      applies = value === "*" || /agentwebgateway/i.test(value);
    } else if (applies && (key === "allow" || key === "disallow") && value) {
      rules.push({ allow: key === "allow", path: value });
    }
  }
  const url = new URL(target);
  const path = `${url.pathname}${url.search}`;
  const matches = rules.filter((rule) => {
    const escaped = rule.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
    return new RegExp(`^${escaped}`, "i").test(path);
  }).sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.allow ?? true;
}

async function robotsText(provider: CompatibilityProviderDefinition, context: ConnectorContext): Promise<string> {
  const hostKey = provider.domain;
  const cached = robotsCache.get(hostKey);
  if (cached && cached.expiresAt > Date.now()) return cached.text;
  const inFlight = robotsInflight.get(hostKey);
  if (inFlight) return inFlight;
  const url = `${providerOrigin(provider)}/robots.txt`;
  const startedAt = Date.now();
  const pending = (async (): Promise<string> => {
    try {
      const result = await fetchText(url, context, { accept: "text/plain,text/*;q=0.8", headers: { "user-agent": "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.djrookie99.chatgpt.site)" }, ...(provider.dynamic ? { allowedOrigin: providerOrigin(provider) } : {}) });
      robotsObservation.set(hostKey, {
        route: "robots.txt",
        status: "success",
        response_received: true,
        requested_url: url,
        final_url: result.url,
        http_status: result.response.status,
        redirect_chain: result.redirect_chain.slice(0, 5),
        response_classification: "ROBOTS_POLICY",
        elapsed_ms: Math.max(0, Date.now() - startedAt),
      });
      robotsCache.set(hostKey, { text: result.text, expiresAt: Date.now() + ROBOTS_TTL_MS });
      return result.text;
    } catch (error) {
      if (error instanceof GatewayError && error.code === "NOT_FOUND") {
        robotsObservation.set(hostKey, probeFailure("robots.txt", url, startedAt, error));
        robotsCache.set(hostKey, { text: "", expiresAt: Date.now() + ROBOTS_TTL_MS });
        return "";
      }
      robotsObservation.set(hostKey, probeFailure("robots.txt", url, startedAt, error));
      throw new GatewayError("PROVIDER_RESTRICTED", "The public site access policy could not be verified for this route.", { retryable: true, mode: "public_http", sourceUrl: url, stage: "http", cause: error });
    }
  })();
  robotsInflight.set(hostKey, pending);
  try {
    return await pending;
  } finally {
    if (robotsInflight.get(hostKey) === pending) robotsInflight.delete(hostKey);
  }
}

async function publicText(provider: CompatibilityProviderDefinition, url: string, context: ConnectorContext, accept = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"): Promise<{ text: string; url: string; http_status: number; redirect_chain: string[] }> {
  const candidate = absoluteUrl(url, providerOrigin(provider));
  let target: string | null = null;
  if (candidate) {
    const parsed = new URL(candidate);
    if (compatibilityHostMatches(parsed.hostname, provider)) {
      parsed.hash = "";
      target = parsed.toString();
    }
  }
  if (!target) throw new GatewayError("INTERNAL_ERROR", "The compatibility connector generated a URL outside its fixed site boundary.");
  const robots = await robotsText(provider, context);
  if (!robotsAllows(robots, target)) throw new GatewayError("PROVIDER_RESTRICTED", "The public site access policy disallows the requested read-only route.", { retryable: false, mode: "public_http", sourceUrl: target, stage: "http" });
  const result = await fetchText(target, context, { accept, headers: { "user-agent": "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.djrookie99.chatgpt.site)" }, ...(provider.dynamic ? { allowedOrigin: providerOrigin(provider) } : {}) });
  return { text: result.text, url: result.url, http_status: result.response.status, redirect_chain: result.redirect_chain };
}

async function publicJson(provider: CompatibilityProviderDefinition, url: string, context: ConnectorContext): Promise<{ value: unknown; url: string }> {
  const result = await publicText(provider, url, context, "application/json,text/plain;q=0.9,*/*;q=0.8");
  try {
    return { value: JSON.parse(result.text) as unknown, url: result.url };
  } catch (error) {
    throw new GatewayError("UPSTREAM_CHANGED", "The public structured route did not return valid JSON.", { retryable: true, mode: "public_http", sourceUrl: result.url, stage: "http", cause: error });
  }
}

type DynamicProbeResult = DynamicSiteProbe & {
  value?: unknown;
  detection?: CompatibilityDetection;
  currency_context?: StoreCurrencyContext;
};

function probeFailureStatus(error: unknown): DynamicSiteProbe["status"] {
  if (!(error instanceof GatewayError)) return "unreachable";
  if (error.code === "PROVIDER_RESTRICTED") return "policy_restricted";
  if (error.code === "UPSTREAM_TIMEOUT") return "timeout";
  if (error.code === "NOT_FOUND") return "unavailable";
  if (error.code === "UPSTREAM_CHANGED") return "invalid";
  if (error.code === "UPSTREAM_BLOCKED" || error.code === "ROUTE_BLOCKED" || error.details?.response_classification === "ROUTE_BLOCKED") {
    return error.details?.http_status ? "blocked" : "unreachable";
  }
  if (error.code === "SITE_UNREACHABLE" || error.code === "RUNTIME_EGRESS_BLOCKED") return "unreachable";
  return "unreachable";
}

function probeFailure(route: string, requestedUrl: string, startedAt: number, error: unknown): DynamicProbeResult {
  const gatewayError = error instanceof GatewayError ? error : null;
  const details = gatewayError?.details ?? {};
  const httpStatus = typeof details.http_status === "number" ? details.http_status : undefined;
  const redirectChain = Array.isArray(details.redirect_chain)
    ? details.redirect_chain.filter((value): value is string => typeof value === "string").slice(0, 5)
    : undefined;
  return {
    route,
    status: probeFailureStatus(error),
    response_received: httpStatus !== undefined,
    requested_url: requestedUrl,
    ...(gatewayError?.sourceUrl ? { final_url: gatewayError.sourceUrl } : {}),
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    ...(redirectChain?.length ? { redirect_chain: redirectChain } : {}),
    response_classification: typeof details.response_classification === "string"
      ? details.response_classification
      : gatewayError?.code === "PROVIDER_RESTRICTED" ? "ROBOTS_OR_POLICY_RESTRICTED" : "NO_HTTP_RESPONSE",
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    ...(gatewayError ? { error_code: gatewayError.code } : { error_code: "SITE_UNREACHABLE" }),
  };
}

function shopifySuggestRows(value: unknown): unknown[] | null {
  const root = object(value);
  const resources = object(root?.resources);
  const results = object(resources?.results);
  const rows = results?.products ?? root?.products;
  return Array.isArray(rows) ? rows : null;
}

function shopifyProductsRows(value: unknown): unknown[] | null {
  const root = object(value);
  return Array.isArray(root?.products) ? root.products : null;
}

function shopifyCollectionRows(value: unknown): unknown[] | null {
  const root = object(value);
  return Array.isArray(root?.collections) ? root.collections : null;
}

function shopifyCollectionProductsRows(value: unknown): unknown[] | null {
  const root = object(value);
  return Array.isArray(root?.products) ? root.products : null;
}

function shopifyCollectionHandle(value: unknown): string | null {
  const item = object(value);
  const handle = firstString(item?.handle, item?.slug);
  return handle && /^[a-z0-9][a-z0-9-]{1,120}$/i.test(handle) ? handle : null;
}

function shopifyAcquisitionBudgetReason(startedAt: number, networkRequests: number, recordsAcquired: number, recordsCapped: boolean): SnapshotTerminationReason | null {
  if (recordsCapped || recordsAcquired >= MAX_SHOPIFY_ACQUISITION_PRODUCTS) return "max_products";
  if (networkRequests >= MAX_SHOPIFY_ACQUISITION_REQUESTS) return "max_requests";
  if (Date.now() - startedAt >= MAX_SHOPIFY_ACQUISITION_ELAPSED_MS) return "max_elapsed_ms";
  return null;
}

function shopifyPageIsTerminal(value: unknown, returned: number, page: number): boolean {
  const root = object(value);
  const pagination = object(root?.pagination) ?? object(root?.meta);
  const hasNextPage = pagination?.has_next_page ?? pagination?.hasNextPage ?? root?.has_next_page ?? root?.hasNextPage;
  if (hasNextPage === false) return true;
  const totalPages = firstNumber(pagination?.total_pages, pagination?.totalPages, root?.total_pages, root?.totalPages);
  if (totalPages !== null && totalPages >= 0) return page >= totalPages;
  const totalRecords = firstNumber(pagination?.total, pagination?.total_products, pagination?.count, root?.total, root?.total_products, root?.count);
  if (totalRecords !== null && totalRecords >= 0) return page * SHOPIFY_PAGE_SIZE >= totalRecords;
  return returned < SHOPIFY_PAGE_SIZE;
}

function wooIndexEvidence(value: unknown): boolean {
  const root = object(value);
  const namespaces = Array.isArray(root?.namespaces) ? root.namespaces : [];
  const routes = object(root?.routes);
  const routeNames = routes ? Object.keys(routes) : [];
  return namespaces.some((item) => typeof item === "string" && /(?:^|\/)wc\/(?:store|v\d+)/i.test(item))
    || routeNames.some((item) => /(?:^|\/)wc\/(?:store|v\d+)/i.test(item));
}

async function probeHomepage(provider: DynamicCompatibilityProvider, context: ConnectorContext): Promise<DynamicProbeResult> {
  const requestedUrl = `${providerOrigin(provider)}/`;
  const startedAt = Date.now();
  try {
    const page = await publicText(provider, requestedUrl, context);
    if (pageBlocked(page.text)) {
      return {
        route: "homepage",
        status: "blocked",
        response_received: true,
        requested_url: requestedUrl,
        final_url: page.url,
        http_status: page.http_status,
        redirect_chain: page.redirect_chain.slice(0, 5),
        response_classification: "CHALLENGE_OR_INTERSTITIAL",
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        error_code: "UPSTREAM_BLOCKED",
      };
    }
    const detection = detectCompatibilityEngine(page.text, page.url);
    const platform = detection.engine === "shopify" || detection.engine === "woocommerce" ? detection.engine : undefined;
    const currencyContext = currencyContextFromHtml(page.text, provider);
    return {
      route: "homepage",
      status: platform ? "success" : "invalid",
      response_received: true,
      requested_url: requestedUrl,
      final_url: page.url,
      http_status: page.http_status,
      redirect_chain: page.redirect_chain.slice(0, 5),
      response_classification: platform ? "PLATFORM_MARKER" : "GENERIC_OR_UNSUPPORTED_PAGE",
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      ...(platform ? { platform } : {}),
      detection,
      ...(currencyContext ? { currency_context: currencyContext } : {}),
    };
  } catch (error) {
    return probeFailure("homepage", requestedUrl, startedAt, error);
  }
}

async function probeJsonRoute(
  provider: DynamicCompatibilityProvider,
  route: string,
  requestedUrl: string,
  context: ConnectorContext,
  platform: "shopify" | "woocommerce",
  validPayload: (value: unknown) => { valid: boolean; record_count?: number },
): Promise<DynamicProbeResult> {
  const startedAt = Date.now();
  try {
    const page = await publicText(provider, requestedUrl, context, "application/json,text/plain;q=0.9,*/*;q=0.8");
    if (pageBlocked(page.text)) {
      return {
        route,
        status: "blocked",
        response_received: true,
        requested_url: requestedUrl,
        final_url: page.url,
        http_status: page.http_status,
        redirect_chain: page.redirect_chain.slice(0, 5),
        response_classification: "CHALLENGE_OR_INTERSTITIAL",
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        error_code: "UPSTREAM_BLOCKED",
        platform,
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(page.text) as unknown;
    } catch {
      return {
        route,
        status: "invalid",
        response_received: true,
        requested_url: requestedUrl,
        final_url: page.url,
        http_status: page.http_status,
        redirect_chain: page.redirect_chain.slice(0, 5),
        response_classification: "INVALID_JSON",
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        error_code: "UPSTREAM_CHANGED",
        platform,
      };
    }
    const payload = validPayload(value);
    if (!payload.valid) {
      return {
        route,
        status: "invalid",
        response_received: true,
        requested_url: requestedUrl,
        final_url: page.url,
        http_status: page.http_status,
        redirect_chain: page.redirect_chain.slice(0, 5),
        response_classification: "UNRECOGNIZED_STRUCTURED_PAYLOAD",
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        error_code: "UPSTREAM_CHANGED",
        platform,
      };
    }
    const currencyContext = currencyContextFromValue(value, provider, { origin: page.url });
    return {
      route,
      status: "success",
      response_received: true,
      requested_url: requestedUrl,
      final_url: page.url,
      http_status: page.http_status,
      redirect_chain: page.redirect_chain.slice(0, 5),
      response_classification: platform === "shopify" ? "SHOPIFY_STRUCTURED_SEARCH_PAYLOAD" : "WOOCOMMERCE_REST_INDEX",
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      platform,
      ...(payload.record_count !== undefined ? { record_count: payload.record_count } : {}),
      ...(currencyContext ? { currency_context: currencyContext } : {}),
      value,
    };
  } catch (error) {
    return probeFailure(route, requestedUrl, startedAt, error);
  }
}

function emptyWooRouteState(): WooRouteState {
  return {
    platform: "woocommerce",
    confidence: 0.65,
    signals: ["detected WooCommerce storefront; generic public routes pending"],
    routes: {
      store_api: true,
      store_api_plain: true,
      product_search_api: false,
      frontend_search: true,
    },
    rest_index_status: "unknown",
    store_api_verified: false,
    preferred_search: null,
    preferred_detail: null,
    route_failures: {},
    last_verified_at: new Date().toISOString(),
  };
}

function isWooRoute(value: unknown): value is WooRoute {
  return ["woo_store_api", "woo_store_api_plain", "woo_product_search_api", "woo_frontend_search", "structured_catalogue"].includes(value as WooRoute);
}

function routeCanSearch(state: WooRouteState, route: WooRoute): boolean {
  if (route === "woo_frontend_search") return true;
  if (route === "woo_store_api") return state.routes.store_api || state.rest_index_status === "unknown";
  if (route === "woo_store_api_plain") return state.routes.store_api_plain || state.rest_index_status === "unknown";
  return route === "woo_product_search_api" && state.routes.product_search_api;
}

function applyLearnedWooRoutes(provider: CompatibilityProviderDefinition, state: WooRouteState): void {
  const searchRoute = getRecipe(provider.domain, "commerce.search")?.preferred_route;
  if (isWooRoute(searchRoute) && searchRoute !== "structured_catalogue" && routeCanSearch(state, searchRoute)) state.preferred_search = searchRoute;
  const detailRoute = getRecipe(provider.domain, "commerce.detail")?.preferred_route;
  if (isWooRoute(detailRoute)) state.preferred_detail = detailRoute;
}

function routeKeys(value: unknown): string[] {
  const item = object(value);
  return item ? Object.keys(item) : [];
}

async function discoverWooRoutes(provider: CompatibilityProviderDefinition, context: ConnectorContext): Promise<WooRouteState> {
  const cached = wooRouteCache.get(provider.domain);
  if (cached && Date.parse(cached.last_verified_at) + WOO_ROUTE_TTL_MS > Date.now()) {
    applyLearnedWooRoutes(provider, cached);
    return cached;
  }
  const state = emptyWooRouteState();
  try {
    const result = await publicJson(provider, `${providerOrigin(provider)}/wp-json/`, context);
    const root = object(result.value);
    const namespaces = Array.isArray(root?.namespaces) ? root.namespaces.filter((value): value is string => typeof value === "string") : [];
    const routes = routeKeys(root?.routes);
    const storeAdvertised = namespaces.some((value) => /(?:^|\/)wc\/store\/v\d+$/i.test(value)) || routes.some((value) => /wc\/store\/v\d+/i.test(value));
    const searchAdvertised = namespaces.some((value) => /(?:^|\/)wps\/v\d+$/i.test(value)) || routes.some((value) => /wps\/v\d+/i.test(value));
    state.routes.store_api = storeAdvertised;
    state.routes.store_api_plain = storeAdvertised;
    state.routes.product_search_api = searchAdvertised;
    state.rest_index_status = "verified";
    state.confidence = storeAdvertised ? 0.99 : searchAdvertised ? 0.9 : 0.82;
    state.signals = ["WordPress REST index", ...(storeAdvertised ? ["wc/store namespace"] : []), ...(searchAdvertised ? ["wps namespace"] : [])];
  } catch {
    // Some public stores disable the REST index while leaving storefront
    // routes available. Keep the bounded known-route probes enabled.
    state.signals.push("REST index unavailable; known public routes retained");
    state.rest_index_status = "unknown";
  }
  applyLearnedWooRoutes(provider, state);
  state.last_verified_at = new Date().toISOString();
  wooRouteCache.set(provider.domain, state);
  return state;
}

function wooRouteUrl(provider: CompatibilityProviderDefinition, route: WooRoute, productId?: string): URL {
  let url: URL;
  if (route === "woo_store_api_plain") {
    url = new URL(`${providerOrigin(provider)}/`);
    url.searchParams.set("rest_route", `/wc/store/v1/products${productId ? `/${encodeURIComponent(productId)}` : ""}`);
  } else if (route === "woo_product_search_api") {
    url = new URL(`${providerOrigin(provider)}/wp-json/wps/v1/${productId ? "products/" : "products"}${productId ? encodeURIComponent(productId) : ""}`);
  } else {
    url = new URL(`${providerOrigin(provider)}/wp-json/wc/store/v1/products${productId ? `/${encodeURIComponent(productId)}` : ""}`);
  }
  return url;
}

function addWooSearchParams(url: URL, query: string, maxResults: number, page?: number): void {
  if (url.searchParams.get("rest_route")) {
    url.searchParams.set("search", query);
    url.searchParams.set("per_page", String(maxResults));
  } else {
    url.searchParams.set("search", query);
    url.searchParams.set("per_page", String(maxResults));
    url.searchParams.set("_fields", "id,name,slug,prices,price,regular_price,sale_price,images,average_rating,rating_count,review_count,stock_status,permalink,short_description,variations");
  }
  if (page !== undefined) url.searchParams.set("page", String(page));
}

function wooProductsFromResponse(value: unknown, provider: CompatibilityProviderDefinition, limit = MAX_GENERIC_RECORDS, currencyContext?: StoreCurrencyContext | null): ProductCandidate[] {
  const objectValue = object(value);
  const source = Array.isArray(value)
    ? value
    : objectValue?.products ?? objectValue?.items ?? objectValue?.results ?? objectValue?.data ?? value;
  return normalizeCompatibilityProducts(source, provider, limit, currencyContext ? { currency_context: currencyContext } : {});
}

function wooErrorState(error: unknown): WooAttempt["state"] {
  if (!(error instanceof GatewayError)) return "ROUTE_UNUSABLE";
  if (error.code === "NOT_FOUND") return "ROUTE_NOT_AVAILABLE";
  if (error.code === "PROVIDER_RESTRICTED") return "ROUTE_RESTRICTED";
  if (error.code === "UPSTREAM_TIMEOUT") return "UPSTREAM_TIMEOUT";
  if (error.code === "UPSTREAM_BLOCKED") return "UPSTREAM_BLOCKED";
  return "ROUTE_UNUSABLE";
}

function wooFailureCode(state: WooAttempt["state"]): GatewayErrorCode {
  if (state === "ROUTE_RESTRICTED" || state === "UPSTREAM_BLOCKED") return "UPSTREAM_BLOCKED";
  if (state === "UPSTREAM_TIMEOUT") return "UPSTREAM_TIMEOUT";
  if (state === "PARSER_MISMATCH") return "UPSTREAM_CHANGED";
  return "UPSTREAM_CHANGED";
}

function wooDiagnostics(state: WooRouteState, attempts: WooAttempt[], extra: JsonObject = {}): JsonObject {
  return {
    woo_platform: {
      platform: state.platform,
      confidence: state.confidence,
      signals: state.signals,
      rest_index_status: state.rest_index_status,
      routes: state.routes,
      store_api_verified: state.store_api_verified,
    },
    woo_route_attempts: attempts.map((attempt) => ({
      route: attempt.route,
      state: attempt.state,
      ...(attempt.url ? { url: attempt.url } : {}),
    })),
    woo_preferred_search: state.preferred_search,
    woo_preferred_detail: state.preferred_detail,
    ...extra,
  };
}

function markWooRouteFailure(provider: CompatibilityProviderDefinition, state: WooRouteState, route: WooRoute, capability: "search" | "detail"): void {
  const count = (state.route_failures[route] ?? 0) + 1;
  state.route_failures[route] = count;
  if (count >= 2) {
    if (capability === "search" && state.preferred_search === route) state.preferred_search = null;
    if (capability === "detail" && state.preferred_detail === route) state.preferred_detail = null;
    forgetRecipe(provider.domain, `commerce.${capability}`);
  }
  state.last_verified_at = new Date().toISOString();
  wooRouteCache.set(provider.domain, state);
}

function markWooRouteSuccess(provider: CompatibilityProviderDefinition, state: WooRouteState, route: WooRoute, capability: "search" | "detail"): void {
  state.route_failures[route] = 0;
  if (capability === "search") state.preferred_search = route;
  else state.preferred_detail = route;
  if (route === "woo_store_api" || route === "woo_store_api_plain") state.store_api_verified = true;
  state.last_verified_at = new Date().toISOString();
  wooRouteCache.set(provider.domain, state);
}

/**
 * Rotate only the current learned preference before one bounded retry. The
 * route discovery result stays cached, so a retry can use a known alternate
 * surface without rediscovering the storefront.
 */
export function rotateCompatibilityRoute(value: unknown, capability: "search" | "detail"): void {
  const provider = isDynamicCompatibilityProvider(value) ? value : compatibilityProvider(value);
  if (!provider || provider.engine !== "woocommerce") return;
  const state = wooRouteCache.get(provider.domain);
  if (!state) return;
  if (capability === "search") state.preferred_search = null;
  else state.preferred_detail = null;
  state.last_verified_at = new Date().toISOString();
  wooRouteCache.set(provider.domain, state);
}

function searchUrl(provider: CompatibilityProviderDefinition, query: string): string {
  const encoded = encodeURIComponent(query);
  const template = provider.search_path ?? "/search?q={query}";
  return `${providerOrigin(provider)}${template.replace("{query}", encoded)}`;
}

function wooFrontendSearchUrl(provider: CompatibilityProviderDefinition, query: string): string {
  const url = new URL(`${providerOrigin(provider)}/`);
  url.searchParams.set("s", query);
  url.searchParams.set("post_type", "product");
  return url.toString();
}

function diagnostics(provider: CompatibilityProviderDefinition, html: string, sourceUrl: string, bundle?: BundleInspection | null): JsonObject {
  const framework = detectFrameworks(html);
  const states = extractEmbeddedState(html);
  const algolia = detectAlgoliaConfig(html);
  const woo = detectWooCommerce(html);
  const candidates = extractApiCandidates(html, sourceUrl);
  return {
    compatibility_engine: provider.engine,
    frameworks_detected: framework.frameworks,
    rendering_detected: framework.rendering,
    embedded_state_kinds: [...new Set(states.map((state) => state.kind))],
    algolia: algolia ? { detected: true, application_id_present: Boolean(algolia.application_id), public_config_present: algolia.has_public_config, index_count: algolia.index_names.length } : { detected: false },
    ...(provider.engine === "woocommerce" ? { woocommerce: woo } : {}),
    same_origin_script_count: bundle?.script_urls.length ?? 0,
    inline_api_candidate_count: candidates.length,
    bundle_api_candidate_count: bundle?.candidates.length ?? 0,
    ...(bundle ? { bundle_candidates: bundle.candidates.slice(0, 12).map((candidate) => ({ url: candidate.url, kind: candidate.kind })) } : {}),
  };
}

export function detectCompatibilityEngine(html: string, sourceUrl = "https://example.invalid/"): CompatibilityDetection {
  const framework = detectFrameworks(html);
  const states = extractEmbeddedState(html);
  const algolia = detectAlgoliaConfig(html);
  const woocommerce = detectWooCommerce(html);
  const hasProductJsonLd = extractJsonLd(html).some((item) => {
    const type = item["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  });
  let engine: CompatibilityEngine | null = null;
  if (framework.frameworks.includes("shopify")) engine = "shopify";
  else if (woocommerce.platform) engine = "woocommerce";
  else if (framework.frameworks.includes("nextjs")) engine = "nextjs";
  else if (algolia) engine = "algolia";
  else if (hasProductJsonLd) engine = "structured_ssr";
  else if (framework.rendering === "ssr") engine = "structured_ssr";
  else if (sourceUrl) engine = null;
  return {
    engine,
    frameworks: framework.frameworks,
    rendering: framework.rendering,
    embedded_state_kinds: [...new Set(states.map((state) => state.kind))],
    algolia,
    woocommerce,
  };
}

function recordBenchmark(provider: CompatibilityProviderDefinition, surface: "search" | "detail" | "recon", html: string, records: ProductCandidate[], startedAt: string, strategy: string, expectedId?: string): void {
  recordExtractionBenchmark({
    provider: provider.id,
    surface,
    engine: provider.engine,
    html,
    records,
    validRecords: records,
    expectedId,
    idField: "product_id",
    startedAt,
    extractionStrategy: `${provider.engine}:${strategy}`,
  });
}

export function scopeRouteCacheKey(value: unknown): string {
  const intent = scopeIntentFromValue(value);
  return `${intent.structural.category ?? "unknown"}|${intent.structural.audience ?? "any"}|collection`;
}

function cachedScopeRoute(provider: CompatibilityProviderDefinition, input: JsonObject): { handle: string; path?: string; scope_relevance?: ScopeRelevanceAssessment } | null {
  const recipe = getRecipe(provider.domain, "commerce.search");
  const routes = object(recipe?.scope_routes);
  const entry = object(routes?.[scopeRouteCacheKey(input)]);
  const handle = firstString(entry?.handle);
  if (!handle || !/^[a-z0-9][a-z0-9-]{1,120}$/i.test(handle)) return null;
  return {
    handle,
    ...(typeof entry?.path === "string" ? { path: entry.path } : {}),
    ...(object(entry?.scope_relevance) ? { scope_relevance: entry?.scope_relevance as ScopeRelevanceAssessment } : {}),
  };
}

function demoteCachedScopeRoute(provider: CompatibilityProviderDefinition, input: JsonObject): void {
  const recipe = getRecipe(provider.domain, "commerce.search");
  const routes = object(recipe?.scope_routes);
  const key = scopeRouteCacheKey(input);
  if (!routes || !Object.hasOwn(routes, key) || !recipe) return;
  const nextRoutes = { ...routes };
  delete nextRoutes[key];
  rememberRecipe({ ...recipe, scope_routes: nextRoutes });
}

function rememberPublicRecipe(provider: CompatibilityProviderDefinition, capability: "search" | "detail", strategy: string, data: JsonObject = {}): void {
  const previous = getRecipe(provider.domain, `commerce.${capability}`);
  const wooRoute = provider.engine === "woocommerce" && ["woo_store_api", "woo_store_api_plain", "woo_product_search_api", "woo_frontend_search", "structured_catalogue"].includes(strategy)
    ? strategy
    : undefined;
  const diagnostic = object(data.diagnostics);
  const scope = object(data.scope);
  const scopeRelevance = object(data.scope_relevance) as ScopeRelevanceAssessment | null;
  const scopeSufficient = data.scope_sufficient_for_query === true;
  const acquisitionComplete = data.acquisition_complete === true;
  const coherentResults = Array.isArray(data.results) && data.results.length > 0;
  const scopeKey = capability === "search" && scope?.kind === "collection" && scopeSufficient && acquisitionComplete && coherentResults
    ? typeof diagnostic?.scope_route_key === "string" ? diagnostic.scope_route_key : scopeRouteCacheKey(diagnostic?.normalized_intent ?? data)
    : null;
  const previousScopeRoutes = object(previous?.scope_routes) ?? {};
  const nextScopeRoutes = scopeKey && typeof scope?.key === "string"
    ? {
      ...previousScopeRoutes,
      [scopeKey]: {
        handle: scope.key,
        ...(typeof scope.path === "string" ? { path: scope.path } : {}),
        ...(scopeRelevance ? { scope_relevance: scopeRelevance } : {}),
        validated_at: new Date().toISOString(),
      },
    }
    : previousScopeRoutes;
  rememberRecipe({
    domain: provider.domain,
    capability: `commerce.${capability}`,
    execution_mode: "public_http",
    engine: provider.engine,
    request: { method: "GET", url_template: capability === "search"
      ? wooRoute === "woo_frontend_search" ? wooFrontendSearchUrl(provider, "{query}") : searchUrl(provider, "{query}")
        : `${providerOrigin(provider)}/product/{id}` },
    parser: `${provider.engine}_generic_product_v1`,
    validator: "validCommonProduct",
    last_verified_at: new Date().toISOString(),
    shared_code: ["compatibility.ts", "embedded-state.ts", "semantic-validation.ts"],
    ...(wooRoute ? {
      route_order: ["woo_store_api", "woo_store_api_plain", "woo_product_search_api", "woo_frontend_search", "structured_catalogue"],
      preferred_route: wooRoute,
    } : { preferred_route: strategy }),
    ...(Object.keys(nextScopeRoutes).length ? { scope_routes: nextScopeRoutes } : {}),
    ...(capability === "search" ? {
      search_knowledge: {
        ...(previous?.search_knowledge ?? {}),
        route_order: provider.engine === "shopify"
          ? ["shopify_search_suggest_json", "shopify_collections_json", "shopify_collection_products_json", "shopify_products_json"]
          : ["woo_store_api", "woo_store_api_plain", "woo_product_search_api", "woo_frontend_search"],
        bounded_query_variants: 4,
        bounded_pages: provider.engine === "shopify" ? { collections: MAX_SHOPIFY_COLLECTION_PAGES, collection_products: MAX_SHOPIFY_COLLECTION_PAGES, catalogue: MAX_SHOPIFY_CATALOGUE_PAGES } : { search: 3 },
        product_answers_cached: true,
        snapshot_ttl_seconds: 900,
      },
    } : {}),
  });
}

function execution(provider: CompatibilityProviderDefinition, tool: "search_products" | "get_product", sourceUrl: string, data: JsonObject, startedAt: string, outcome: "SUCCESS" | "ZERO_RESULTS", strategy: string, html = "", expectedId?: string, bundle?: BundleInspection | null): ConnectorExecution {
  const rows = Array.isArray(data.results) ? data.results as ProductCandidate[] : data.product ? [data.product as ProductCandidate] : [];
  recordBenchmark(provider, tool === "search_products" ? "search" : "detail", html, rows, startedAt, strategy, expectedId);
  const recipeExisted = Boolean(getRecipe(provider.domain, `commerce.${tool === "search_products" ? "search" : "detail"}`));
  rememberPublicRecipe(provider, tool === "search_products" ? "search" : "detail", strategy, data);
  return {
    data: {
      ...data,
      diagnostics: {
        ...(object(data.diagnostics) ?? {}),
        ...(html ? diagnostics(provider, html, sourceUrl, bundle) : { compatibility_engine: provider.engine }),
      },
    },
    sourceUrl,
    sourceProvider: provider.name,
    upstreamProvider: provider.id,
    engine: provider.engine,
    mode: "public_http",
    retrievedAt: new Date().toISOString(),
    ...(provider.dynamic ? {
      provenance: {
        provider: provider.id,
        domain: provider.domain,
        platform: provider.engine,
        provider_origin: "dynamic",
        route: strategy,
        dynamic_discovery: true,
        recipe: recipeExisted ? "cached" : "generated",
      },
    } : {}),
    outcome,
  };
}

async function htmlSearch(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext, initialError?: unknown, requestedUrl?: string, routeDiagnostics: JsonObject = {}, strategy = "html_structured_state"): Promise<ConnectorExecution> {
  const url = requestedUrl ?? searchUrl(provider, String(input.query));
  const page = await publicText(provider, url, context);
  if (pageBlocked(page.text)) throw new GatewayError("UPSTREAM_BLOCKED", "The public site returned an automated-access or interstitial response.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
  const currencyContext = currencyContextFromUnknown(context.dynamic_site?.currency_context) ?? cachedCurrencyContext(provider, { locale: input.locale });
  const extractedProducts = extractCompatibilityProducts(page.text, provider, page.url, { ...(currencyContext ? { currency_context: currencyContext } : {}), locale: input.locale });
  const products = queryFilter(extractedProducts, input.query, true).slice(0, typeof input.max_results === "number" ? input.max_results : 20);
  const explicitZero = noResults(page.text);
  if (!products.length && !explicitZero) {
    let bundle: BundleInspection | null = null;
    const detection = detectCompatibilityEngine(page.text, page.url);
    if (detection.frameworks.includes("nextjs") || detection.engine === "algolia" || detection.rendering === "csr") {
      bundle = await inspectJavascriptBundles(page.text, page.url, context, provider.dynamic ? providerOrigin(provider) : undefined);
      recordBenchmark(provider, "recon", page.text, [], context.startedAt, "bounded_bundle_api_discovery");
    }
    throw new GatewayError("UPSTREAM_CHANGED", "The public search page did not contain valid product records after bounded structured-data extraction.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic", cause: bundle?.candidates.length ? new Error(`${bundle.candidates.length} bounded read-only API clues found`) : initialError });
  }
  const scope: SnapshotScope = {
    kind: "search",
    key: normalizedScopeQuery(input.query) ?? "unknown",
    ...(normalizedScopeQuery(input.query) ? { query: normalizedScopeQuery(input.query) } : {}),
  };
  const coverage = publicSearchCoverage({
    platform: provider.engine,
    route: strategy,
    strategy: `${provider.engine}_${strategy}_targeted`,
    query: input.query,
    records_acquired: extractedProducts.length,
    pages_fetched: 1,
    pagination_complete: false,
    records_capped: extractedProducts.length >= MAX_GENERIC_RECORDS,
    termination_reason: "query_results",
    max_pages: 1,
    max_products: MAX_GENERIC_RECORDS,
    max_requests: 1,
    coverage_level: "bounded_partial",
    coverage_reason: "targeted_search_results_not_catalogue_complete",
    scope,
    currency: input.currency,
    locale: input.locale,
  });
  const snapshot = provider.dynamic ? createStoreSnapshot(provider, extractedProducts, {
    origin: providerOrigin(provider),
    search_query: String(input.query ?? ""),
    coverage_level: "bounded_partial",
    source_url: page.url,
    acquisition_tier: "tier1_targeted",
    network_requests: 1,
    routes: [strategy],
    scope,
    intent_value: input,
    acquisition: coverage.acquisition,
    ...(currencyContext ? { currency_context: currencyContext } : {}),
    route_context: { route: strategy, ...(typeof input.currency === "string" ? { currency: input.currency.toUpperCase() } : {}), ...(typeof input.locale === "string" ? { locale: input.locale } : {}) },
    coverage_reason: coverage.coverage_reason,
  }) : null;
  const coverageFields = snapshot
    ? {
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
    }
    : publicSearchCoverageFields(coverage);
  const data: JsonObject = {
    query: input.query,
    results: products,
    ...coverageFields,
    diagnostics: {
      response_classification: products.length ? "SEARCH_RESULTS" : "ZERO_RESULTS",
      extraction_strategy: "embedded_state_jsonld_scoped_links",
      fallback_from: initialError instanceof GatewayError ? initialError.code : null,
      ...routeDiagnostics,
      acquisition: snapshot?.acquisition ?? coverage.acquisition,
      route_context: coverage.route_context,
      records_acquired: extractedProducts.length,
      records_capped: extractedProducts.length >= MAX_GENERIC_RECORDS,
      coverage_reason: snapshot?.coverage_reason ?? coverage.coverage_reason,
    },
  };
  if (!products.length && explicitZero) return execution(provider, "search_products", page.url, data, context.startedAt, "ZERO_RESULTS", strategy, page.text);
  return execution(provider, "search_products", page.url, data, context.startedAt, "SUCCESS", strategy, page.text);
}

async function shopifySearch(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const acquisitionStartedAt = Date.now();
  let firstError: unknown;
  const limit = typeof input.max_results === "number" ? Math.min(20, input.max_results) : 20;
  const learned = getRecipe(provider.domain, "commerce.search")?.preferred_route;
  const objective = String(input.search_objective ?? "discovery");
  const coverageNeeded = objective !== "discovery";
  const searchQueries = (Array.isArray(input.search_queries) ? input.search_queries : [input.query])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim().slice(0, 120))
    .slice(0, 4);
  const requestedScopeHint = context.dynamic_site?.scope_hint;
  const requestedScope: SnapshotScope = requestedScopeHint
    ? snapshotScopeForStorage(requestedScopeHint)
    : { kind: "store", key: "store", path: "/" };
  const acquisitionCurrencyContext = currencyContextFromUnknown(context.dynamic_site?.currency_context) ?? cachedCurrencyContext(provider, { locale: input.locale });
  const directCollectionRequested = requestedScope.kind === "collection";
  const storeScope: SnapshotScope = { kind: "store", key: "store", path: "/" };
  const suggestedProducts: ProductCandidate[] = [];
  const suggestedSeen = new Set<string>();
  const routeAttempts: JsonObject[] = [];
  let networkRequests = 0;
  let recordsCapped = false;
  const addProducts = (value: unknown, query: string, route: string, target: ProductCandidate[], targetSeen: Set<string>): number => {
    const rows = normalizeCompatibilityProducts(value, provider, MAX_SNAPSHOT_RECORDS, { ...(acquisitionCurrencyContext ? { currency_context: acquisitionCurrencyContext } : {}), locale: input.locale, route });
    const selected = route.startsWith("shopify_search_suggest") ? queryFilter(rows, query, true) : rows;
    let added = 0;
    for (const product of selected) {
      const key = `${product.product_id}:${product.canonical_url}`;
      if (targetSeen.has(key)) continue;
      if (target.length >= MAX_SHOPIFY_ACQUISITION_PRODUCTS) {
        recordsCapped = true;
        break;
      }
      targetSeen.add(key);
      target.push(product);
      added += 1;
    }
    routeAttempts.push({ route, query, returned: rows.length, added });
    return added;
  };
  let sourceUrl = `${providerOrigin(provider)}/search/suggest.json`;
  const probeRoute = context.dynamic_site?.probe_route;
  const probeData = context.dynamic_site?.probe_data;
  for (const query of searchQueries.length ? searchQueries : [String(input.query ?? "")]) {
    try {
      if (query === searchQueries[0] && provider.engine === "shopify" && probeRoute?.startsWith("shopify_search_suggest") && probeData !== undefined) {
        sourceUrl = context.dynamic_site?.probe_url ?? sourceUrl;
        addProducts(probeData, query, "shopify_search_suggest_json_probe_reused", suggestedProducts, suggestedSeen);
        continue;
      }
      const locales = [null, localeSegment(input.locale)].filter((value, index, values): value is string | null => values.indexOf(value) === index);
      let localeSucceeded = false;
      for (const locale of locales) {
        try {
          const suggest = new URL(`${providerOrigin(provider)}${locale ? `/${locale}` : ""}/search/suggest.json`);
          suggest.searchParams.set("q", query);
          suggest.searchParams.set("resources[type]", "product");
          suggest.searchParams.set("resources[limit]", String(limit));
          suggest.searchParams.set("resources[options][unavailable_products]", "hide");
          networkRequests += 1;
          const result = await publicJson(provider, suggest.toString(), context);
          sourceUrl = result.url;
          addProducts(result.value, query, "shopify_search_suggest_json", suggestedProducts, suggestedSeen);
          localeSucceeded = true;
          break;
        } catch (error) {
          firstError ??= error;
          routeAttempts.push({ route: "shopify_search_suggest_json", query, ...(locale ? { locale } : {}), error: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" });
        }
      }
      if (!localeSucceeded) throw firstError ?? new GatewayError("UPSTREAM_CHANGED", "Shopify search suggestions were unavailable.", { retryable: true, mode: "public_http", stage: "http" });
    } catch (error) {
      firstError ??= error;
      if (!routeAttempts.some((attempt) => attempt.route === "shopify_search_suggest_json" && attempt.query === query)) {
        routeAttempts.push({ route: "shopify_search_suggest_json", query, error: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" });
      }
    }
  }

  if (suggestedProducts.length && !coverageNeeded) {
    const discoveryScope: SnapshotScope = {
      kind: "search",
      key: normalizedScopeQuery(input.query) ?? "unknown",
      ...(normalizedScopeQuery(input.query) ? { query: normalizedScopeQuery(input.query) } : {}),
    };
    const snapshot = provider.dynamic ? createStoreSnapshot(provider, suggestedProducts, {
      origin: providerOrigin(provider),
      search_query: String(input.query ?? ""),
      coverage_level: "bounded_partial",
      source_url: sourceUrl,
      acquisition_tier: "tier1_targeted",
      network_requests: networkRequests,
      routes: routeAttempts.map((attempt) => String(attempt.route)),
      scope: discoveryScope,
      intent_value: input,
      acquisition: {
        strategy: "shopify_search_suggest_json",
        scope: discoveryScope,
        pages_fetched: 0,
        pagination_complete: false,
        records_acquired: suggestedProducts.length,
        records_capped: false,
        termination_reason: "query_results",
        max_requests: MAX_SHOPIFY_ACQUISITION_REQUESTS,
        max_products: MAX_SHOPIFY_ACQUISITION_PRODUCTS,
        max_elapsed_ms: MAX_SHOPIFY_ACQUISITION_ELAPSED_MS,
      },
      ...(acquisitionCurrencyContext ? { currency_context: acquisitionCurrencyContext } : {}),
      route_context: { route: "shopify_search_suggest_json", currency: typeof input.currency === "string" ? input.currency.toUpperCase() : undefined, locale: typeof input.locale === "string" ? input.locale : undefined },
      coverage_reason: "targeted_search_results_not_catalogue_complete",
    }) : null;
    return execution(provider, "search_products", sourceUrl, {
      query: input.query,
      results: suggestedProducts.slice(0, limit),
      ...(snapshot ? {
        search_context: snapshot.id,
        coverage_level: snapshot.coverage_level,
        coverage_confidence: snapshot.coverage_confidence,
        scope: snapshot.scope,
        scope_relevance: snapshot.scope_relevance,
        scope_sufficient_for_query: snapshot.scope_sufficient_for_query,
        acquisition_complete: snapshot.acquisition_complete,
        semantic_confidence: snapshot.semantic_confidence,
        sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
        coverage_reason: snapshot.coverage_reason,
      } : {}),
      search_objective: objective,
      coverage_sufficient_for_superlative: false,
      diagnostics: {
        response_classification: "SEARCH_RESULTS",
        extraction_strategy: "shopify_search_suggest_json",
        learned_route: learned === "shopify_search_suggest_json",
        acquisition_waterfall: routeAttempts,
        acquisition_tier: "tier1_targeted",
        snapshot_cache: "miss",
        records_acquired: suggestedProducts.length,
        scope: discoveryScope,
        scope_relevance: snapshot?.scope_relevance,
        scope_sufficient_for_query: snapshot?.scope_sufficient_for_query,
        acquisition_complete: snapshot?.acquisition_complete,
        semantic_confidence: snapshot?.semantic_confidence,
        sufficient_for_superlative: snapshot ? snapshotSupportsSuperlative(snapshot) : false,
        acquisition: snapshot?.acquisition,
        coverage_reason: "targeted_search_results_not_catalogue_complete",
        network_requests: networkRequests,
        stage_metrics_ms: {
          collection: 0,
          catalogue: 0,
          total: Math.max(0, Date.now() - acquisitionStartedAt),
        },
      },
    }, context.startedAt, "SUCCESS", "shopify_search_suggest_json");
  }

  let collectionComplete = false;
  const collectionStartedAt = Date.now();
  let collectionMs = 0;
  let collectionPagesFetched = 0;
  let selectedCollectionPagesFetched = 0;
  let collectionTerminationReason: SnapshotTerminationReason = "no_matching_scope";
  let selectedCollection: { handle: string; path: string } | null = null;
  let selectedScopeRelevance: ScopeRelevanceAssessment | null = null;
  let requestedScopeRelevance: ScopeRelevanceAssessment | null = null;
  let collectionProducts: ProductCandidate[] = [];
  const partialCollectionProducts: ProductCandidate[] = [];
  const collectionCandidatesDiagnostics: JsonObject[] = [];
  if (coverageNeeded) {
    try {
      let candidates: Array<{ handle: string; score: number; index: number; direct?: boolean; cached?: boolean; scope_relevance: ScopeRelevanceAssessment }> = [];
      const directHandle = requestedScope.kind === "collection"
        ? requestedScopeHint?.collection_handle ?? requestedScope.key
        : null;
      if (directHandle && /^[a-z0-9][a-z0-9-]{1,120}$/i.test(directHandle)) {
        const scopeRelevance = scoreCompatibilityCollection({ handle: directHandle }, input, { explicit_scope: true });
        requestedScopeRelevance = scopeRelevance;
        candidates = [{ handle: directHandle, score: Number.POSITIVE_INFINITY, index: 0, direct: true, scope_relevance: scopeRelevance }];
        collectionCandidatesDiagnostics.push({ handle: directHandle, score: Number.POSITIVE_INFINITY, scope_relevance: scopeRelevance, direct: true });
      } else {
        const budgetReason = shopifyAcquisitionBudgetReason(acquisitionStartedAt, networkRequests, 0, recordsCapped);
        if (budgetReason) {
          collectionTerminationReason = budgetReason;
        } else {
          const collectionsUrl = new URL(`${providerOrigin(provider)}/collections.json`);
          collectionsUrl.searchParams.set("limit", String(SHOPIFY_PAGE_SIZE));
          networkRequests += 1;
          const collectionsResult = await publicJson(provider, collectionsUrl.toString(), context);
          sourceUrl = collectionsResult.url;
          const collections = shopifyCollectionRows(collectionsResult.value) ?? [];
          candidates = collections
            .map((collection, index) => {
              const handle = shopifyCollectionHandle(collection);
              const scopeRelevance = scoreCompatibilityCollection(collection, input);
              return { collection, handle, score: scopeRelevance.score, index, scope_relevance: scopeRelevance };
            })
            .filter((item): item is { collection: unknown; handle: string; score: number; index: number; scope_relevance: ScopeRelevanceAssessment } => Boolean(item.handle) && item.score > 0)
            .sort((left, right) => (right.score - left.score) || (left.index - right.index))
            .slice(0, 3)
            .map(({ handle, score, index, scope_relevance }) => ({ handle, score, index, scope_relevance }));
          const cached = cachedScopeRoute(provider, input);
          if (cached) {
            const cachedRelevance = scoreCompatibilityCollection({ handle: cached.handle }, input);
            if (cachedRelevance.scope_sufficient_for_query) {
              const existing = candidates.find((candidate) => candidate.handle === cached.handle);
              candidates = [
                {
                  handle: cached.handle,
                  score: Math.max(cachedRelevance.score, existing?.score ?? 0),
                  index: existing?.index ?? -1,
                  cached: true,
                  scope_relevance: cachedRelevance,
                },
                ...candidates.filter((candidate) => candidate.handle !== cached.handle),
              ].slice(0, 3);
            }
          }
          for (const candidate of candidates) {
            collectionCandidatesDiagnostics.push({
              handle: candidate.handle,
              score: candidate.score,
              scope_relevance: candidate.scope_relevance,
              ...(candidate.cached ? { cached: true } : {}),
            });
          }
          if (!candidates.length) collectionTerminationReason = "no_matching_scope";
        }
      }
      for (const candidate of candidates) {
        let routeComplete = false;
        let candidateTerminationReason: SnapshotTerminationReason = "max_pages";
        const candidateProducts: ProductCandidate[] = [];
        const candidateSeen = new Set<string>();
        let candidatePagesFetched = 0;
        for (let page = 1; page <= MAX_SHOPIFY_COLLECTION_PAGES; page += 1) {
          const budgetReason = shopifyAcquisitionBudgetReason(acquisitionStartedAt, networkRequests, candidateProducts.length, recordsCapped);
          if (budgetReason) {
            candidateTerminationReason = budgetReason;
            break;
          }
          const collectionUrl = new URL(`${providerOrigin(provider)}/collections/${encodeURIComponent(candidate.handle)}/products.json`);
          collectionUrl.searchParams.set("limit", String(SHOPIFY_PAGE_SIZE));
          collectionUrl.searchParams.set("page", String(page));
          try {
            networkRequests += 1;
            const result = await publicJson(provider, collectionUrl.toString(), context);
            sourceUrl = result.url;
            const rows = shopifyCollectionProductsRows(result.value);
            if (!rows) throw new GatewayError("UPSTREAM_CHANGED", "The Shopify collection route returned an unrecognized payload.", { retryable: true, mode: "public_http", sourceUrl: result.url, stage: "semantic" });
            collectionPagesFetched += 1;
            candidatePagesFetched += 1;
            addProducts(result.value, String(input.query ?? ""), "shopify_collection_products_json", candidateProducts, candidateSeen);
            routeAttempts.push({ route: "shopify_collection_products_json", handle: candidate.handle, page, returned: rows.length });
            if (shopifyPageIsTerminal(result.value, rows.length, page)) {
              routeComplete = true;
              candidateTerminationReason = "end_of_collection";
              break;
            }
          } catch (error) {
            firstError ??= error;
            candidateTerminationReason = "upstream_error";
            routeAttempts.push({ route: "shopify_collection_products_json", handle: candidate.handle, page, error: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" });
            break;
          }
        }
        if (!routeComplete && candidateTerminationReason === "max_pages") collectionTerminationReason = "max_pages";
        const scopeSufficient = candidate.scope_relevance.scope_sufficient_for_query;
        if (routeComplete && !recordsCapped && scopeSufficient && candidateProducts.length > 0) {
          collectionComplete = true;
          collectionTerminationReason = candidateTerminationReason;
          if (collectionComplete) {
            collectionProducts = candidateProducts;
            selectedCollectionPagesFetched = candidatePagesFetched;
            selectedCollection = { handle: candidate.handle, path: `/collections/${candidate.handle}` };
            selectedScopeRelevance = candidate.scope_relevance;
            const diagnostic = collectionCandidatesDiagnostics.find((value) => value.handle === candidate.handle);
            if (diagnostic) diagnostic.selected = true;
            break;
          }
        }
        if (candidate.cached && (!scopeSufficient || candidateTerminationReason === "upstream_error" || (routeComplete && !candidateProducts.length))) demoteCachedScopeRoute(provider, input);
        for (const product of candidateProducts) {
          const key = `${product.product_id}:${product.canonical_url}`;
          if (!partialCollectionProducts.some((value) => `${value.product_id}:${value.canonical_url}` === key)) partialCollectionProducts.push(product);
        }
        if (candidateTerminationReason === "max_requests" || candidateTerminationReason === "max_elapsed_ms") break;
      }
    } catch (error) {
      firstError ??= error;
      collectionTerminationReason = "upstream_error";
      routeAttempts.push({ route: "shopify_collections_json", error: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" });
    }
    collectionMs = Math.max(0, Date.now() - collectionStartedAt);
  }

  let catalogueComplete = false;
  let catalogueMs = 0;
  const catalogueStartedAt = Date.now();
  let cataloguePagesFetched = 0;
  let catalogueTerminationReason: SnapshotTerminationReason = "no_matching_scope";
  const catalogueProducts: ProductCandidate[] = [];
  const catalogueSeen = new Set<string>();
  const cataloguePages = collectionComplete ? 0 : coverageNeeded ? MAX_SHOPIFY_CATALOGUE_PAGES : suggestedProducts.length ? 0 : 1;
  for (let page = 1; page <= cataloguePages && !recordsCapped; page += 1) {
    const budgetReason = shopifyAcquisitionBudgetReason(acquisitionStartedAt, networkRequests, catalogueProducts.length, recordsCapped);
    if (budgetReason) {
      catalogueTerminationReason = budgetReason;
      break;
    }
    const productsUrl = new URL(`${providerOrigin(provider)}/products.json`);
    productsUrl.searchParams.set("limit", String(SHOPIFY_PAGE_SIZE));
    productsUrl.searchParams.set("page", String(page));
    let result: { value: unknown; url: string } | null = null;
    let pageError: unknown;
    let budgetStopped = false;
    for (let retry = 0; retry <= MAX_SHOPIFY_ROUTE_RETRIES; retry += 1) {
      const retryBudget = shopifyAcquisitionBudgetReason(acquisitionStartedAt, networkRequests, catalogueProducts.length, recordsCapped);
      if (retryBudget) {
        catalogueTerminationReason = retryBudget;
        budgetStopped = true;
        break;
      }
      networkRequests += 1;
      try {
        result = await publicJson(provider, productsUrl.toString(), context);
        break;
      } catch (error) {
        pageError = error;
        routeAttempts.push({ route: "shopify_products_json", page, retry: retry + 1, error: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" });
        if (!(error instanceof GatewayError) || !["NOT_FOUND", "UPSTREAM_CHANGED", "UPSTREAM_TIMEOUT", "UPSTREAM_BLOCKED"].includes(error.code)) break;
      }
    }
    if (!result) {
      if (budgetStopped) break;
      firstError ??= pageError ?? new GatewayError("UPSTREAM_CHANGED", "The Shopify catalogue route returned no result.", { retryable: true, mode: "public_http", stage: "http" });
      catalogueTerminationReason = "upstream_error";
      break;
    }
    try {
      const rows = shopifyProductsRows(result.value);
      if (!rows) throw new GatewayError("UPSTREAM_CHANGED", "The Shopify catalogue route returned an unrecognized payload.", { retryable: true, mode: "public_http", sourceUrl: result.url, stage: "semantic" });
      cataloguePagesFetched += 1;
      sourceUrl = result.url;
      addProducts(result.value, String(input.query ?? ""), "shopify_products_json", catalogueProducts, catalogueSeen);
      routeAttempts.push({ route: "shopify_products_json", page, returned: rows.length });
      if (recordsCapped) {
        catalogueTerminationReason = "max_products";
        break;
      }
      if (shopifyPageIsTerminal(result.value, rows.length, page)) {
        catalogueComplete = true;
        catalogueTerminationReason = "end_of_catalogue";
        break;
      }
    } catch (error) {
      firstError ??= error;
      catalogueTerminationReason = "upstream_error";
      if (!routeAttempts.some((attempt) => attempt.route === "shopify_products_json" && attempt.page === page && attempt.error)) routeAttempts.push({ route: "shopify_products_json", page, error: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" });
      break;
    }
  }
  if (!catalogueComplete && cataloguePages > 0 && catalogueTerminationReason === "no_matching_scope" && cataloguePagesFetched >= cataloguePages) catalogueTerminationReason = "max_pages";
  catalogueMs = Math.max(0, Date.now() - catalogueStartedAt);

  const mergeProducts = (sources: ProductCandidate[][]): { products: ProductCandidate[]; seen: Set<string> } => {
    const merged: ProductCandidate[] = [];
    const mergedSeen = new Set<string>();
    for (const source of sources) {
      for (const product of source) {
        const key = `${product.product_id}:${product.canonical_url}`;
        if (mergedSeen.has(key)) continue;
        mergedSeen.add(key);
        merged.push(product);
        if (merged.length >= MAX_SHOPIFY_ACQUISITION_PRODUCTS) return { products: merged, seen: mergedSeen };
      }
    }
    return { products: merged, seen: mergedSeen };
  };
  const useCollectionScope = collectionComplete && Boolean(selectedCollection);
  const collectionScoped = useCollectionScope || (directCollectionRequested && !catalogueComplete && partialCollectionProducts.length > 0);
  const active = useCollectionScope
    ? mergeProducts([collectionProducts])
    : directCollectionRequested && !catalogueComplete
      ? mergeProducts([catalogueProducts, partialCollectionProducts, suggestedProducts])
      : mergeProducts([suggestedProducts, partialCollectionProducts, catalogueProducts]);
  const products = active.products;
  const activeScope: SnapshotScope = useCollectionScope && selectedCollection
    ? { kind: "collection", key: selectedCollection.handle.toLowerCase(), path: selectedCollection.path, ...(normalizedScopeQuery(input.query) ? { query: normalizedScopeQuery(input.query) } : {}) }
    : directCollectionRequested && !catalogueComplete ? requestedScope : storeScope;
  const activeScopeRelevance = useCollectionScope
    ? selectedScopeRelevance
    : directCollectionRequested && !catalogueComplete ? requestedScopeRelevance : null;
  const paginationComplete = useCollectionScope ? collectionComplete : catalogueComplete;
  const terminationReason = useCollectionScope
    ? collectionTerminationReason
    : catalogueComplete
      ? catalogueTerminationReason
      : directCollectionRequested
        ? collectionTerminationReason
        : catalogueTerminationReason === "no_matching_scope" && suggestedProducts.length ? "query_results" : catalogueTerminationReason;
  const coverageLevel: SnapshotCoverageLevel = paginationComplete && !recordsCapped ? "complete_for_query" : "bounded_partial";
  const coverageReason = paginationComplete
    ? useCollectionScope ? "complete_relevant_collection" : "complete_store_catalogue"
    : terminationReason === "max_pages" || terminationReason === "max_products" || terminationReason === "max_requests" || terminationReason === "max_elapsed_ms"
      ? `bounded_partial_${terminationReason}`
      : terminationReason === "upstream_error" ? "upstream_error_before_scope_completion" : "scope_not_proven_complete";
  const acquisitionAttempted = collectionPagesFetched > 0
    || cataloguePagesFetched > 0
    || routeAttempts.some((attempt) => ["shopify_collections_json", "shopify_collection_products_json", "shopify_products_json"].includes(String(attempt.route)));
  const scopeRelevance = activeScopeRelevance ?? scopeRelevanceForSnapshot(activeScope, input.query, input);
  const acquisitionComplete = paginationComplete && !recordsCapped && ["end_of_collection", "end_of_catalogue"].includes(terminationReason);
  const semanticConfidence: "high" | "partial" | "unknown" = acquisitionComplete ? "high" : products.length ? "partial" : "unknown";

  if ((!coverageNeeded && products.length) || (coverageNeeded && (acquisitionAttempted || catalogueComplete || collectionComplete))) {
    const snapshot = provider.dynamic ? createStoreSnapshot(provider, products, {
      origin: providerOrigin(provider),
      search_query: String(input.query ?? ""),
      coverage_level: coverageLevel,
      source_url: sourceUrl,
      acquisition_tier: collectionScoped ? "tier3_collection" : catalogueComplete ? "tier4_catalogue" : "tier4_catalogue_bounded",
      network_requests: networkRequests,
      routes: routeAttempts.map((attempt) => String(attempt.route)),
      scope: activeScope,
      intent_value: input,
      scope_relevance: scopeRelevance,
      scope_sufficient_for_query: scopeRelevance.scope_sufficient_for_query,
      acquisition_complete: acquisitionComplete,
      semantic_confidence: semanticConfidence,
      acquisition: {
        strategy: collectionScoped ? "shopify_collection_pagination" : "shopify_catalogue_pagination",
        scope: activeScope,
        pages_fetched: collectionScoped ? (useCollectionScope ? selectedCollectionPagesFetched : collectionPagesFetched) : cataloguePagesFetched,
        pagination_complete: paginationComplete && !recordsCapped,
        records_acquired: products.length,
        records_capped: recordsCapped,
        termination_reason: terminationReason,
        max_pages: useCollectionScope ? MAX_SHOPIFY_COLLECTION_PAGES : MAX_SHOPIFY_CATALOGUE_PAGES,
        max_products: MAX_SHOPIFY_ACQUISITION_PRODUCTS,
        max_requests: MAX_SHOPIFY_ACQUISITION_REQUESTS,
        max_elapsed_ms: MAX_SHOPIFY_ACQUISITION_ELAPSED_MS,
      },
      ...(acquisitionCurrencyContext ? { currency_context: acquisitionCurrencyContext } : {}),
      route_context: {
        route: collectionScoped ? "shopify_collection_products_json" : "shopify_products_json",
        currency: typeof input.currency === "string" ? input.currency.toUpperCase() : undefined,
        locale: typeof input.locale === "string" ? input.locale : undefined,
      },
      coverage_reason: coverageReason,
    }) : null;
    const recipeStrategy = collectionScoped
      ? "shopify_collection_products_json"
      : routeAttempts.some((attempt) => String(attempt.route).startsWith("shopify_search_suggest") && typeof attempt.returned === "number")
        ? "shopify_search_suggest_json"
        : "shopify_products_json";
    const coverageSufficient = snapshot ? snapshotSupportsSuperlative(snapshot) : coverageLevel === "complete_for_query" && paginationComplete && !recordsCapped;
    return execution(provider, "search_products", sourceUrl, {
      query: input.query,
      results: products.slice(0, limit),
      ...(snapshot ? {
        search_context: snapshot.id,
        coverage_level: snapshot.coverage_level,
        coverage_confidence: snapshot.coverage_confidence,
        scope: snapshot.scope,
        scope_relevance: snapshot.scope_relevance,
        scope_sufficient_for_query: snapshot.scope_sufficient_for_query,
        acquisition_complete: snapshot.acquisition_complete,
        semantic_confidence: snapshot.semantic_confidence,
        sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
        coverage_reason: snapshot.coverage_reason,
      } : {
        coverage_level: coverageLevel,
        scope_relevance: scopeRelevance,
        scope_sufficient_for_query: scopeRelevance.scope_sufficient_for_query,
        acquisition_complete: acquisitionComplete,
        semantic_confidence: semanticConfidence,
        sufficient_for_superlative: acquisitionComplete && scopeRelevance.scope_sufficient_for_query && semanticConfidence === "high",
        coverage_reason: coverageReason,
      }),
      search_objective: objective,
      coverage_sufficient_for_superlative: coverageSufficient,
      diagnostics: {
        response_classification: products.length ? "SEARCH_RESULTS" : "ZERO_RESULTS",
        extraction_strategy: "shopify_scope_aware_waterfall",
        learned_route: learned,
        acquisition_strategy: collectionScoped ? "collection" : "catalogue",
        scope: activeScope,
        scope_relevance: scopeRelevance,
        scope_sufficient_for_query: scopeRelevance.scope_sufficient_for_query,
        scope_route_key: scopeRouteCacheKey(input),
        candidate_scopes: collectionCandidatesDiagnostics,
        normalized_intent: input.intent_structure ?? {
          structural: { category: scopeRelevance.category === "match" ? input.query : null, audience: input.audience ?? null },
          attributes: { color: input.color ?? null, size: input.size ?? null, in_stock: input.in_stock ?? null, availability: input.in_stock === true ? "in_stock" : input.in_stock === false ? "out_of_stock" : null },
          objective: { sort: input.sort_by ?? null, superlative: objective !== "discovery" },
        },
        collection_route_complete: collectionComplete,
        catalogue_route_complete: catalogueComplete,
        collection_pages_fetched: collectionPagesFetched,
        catalogue_pages_fetched: cataloguePagesFetched,
        pagination_complete: paginationComplete && !recordsCapped,
        acquisition_complete: acquisitionComplete,
        semantic_confidence: semanticConfidence,
        sufficient_for_superlative: acquisitionComplete && scopeRelevance.scope_sufficient_for_query && semanticConfidence === "high",
        termination_reason: terminationReason,
        acquisition_waterfall: routeAttempts,
        acquisition_tier: collectionScoped ? "tier3_collection" : catalogueComplete ? "tier4_catalogue" : "tier4_catalogue_bounded",
        snapshot_cache: "miss",
        records_acquired: products.length,
        records_capped: recordsCapped,
        coverage_reason: coverageReason,
        network_requests: networkRequests,
        stage_metrics_ms: {
          collection: collectionMs,
          catalogue: catalogueMs,
          total: Math.max(0, Date.now() - acquisitionStartedAt),
        },
        capped: !paginationComplete || recordsCapped,
        ...(snapshot ? { acquisition: snapshot.acquisition } : {}),
      },
    }, context.startedAt, products.length ? "SUCCESS" : "ZERO_RESULTS", recipeStrategy);
  }

  try {
    const fallback = await htmlSearch(provider, input, context, firstError, undefined, {
      search_objective: objective,
      coverage_confidence: "unknown",
      coverage_sufficient_for_superlative: false,
      coverage_reason: "no_valid_structured_route",
      acquisition_waterfall: routeAttempts,
    });
    const fallbackSnapshot = typeof fallback.data.search_context === "string" ? getStoreSnapshot(fallback.data.search_context) : null;
    return {
      ...fallback,
      data: {
        ...fallback.data,
        search_objective: objective,
        ...(fallbackSnapshot ? {
          coverage_level: fallbackSnapshot.coverage_level,
          coverage_confidence: fallbackSnapshot.coverage_confidence,
          coverage_sufficient_for_superlative: snapshotSupportsSuperlative(fallbackSnapshot),
          scope: fallbackSnapshot.scope,
          coverage_reason: fallbackSnapshot.coverage_reason,
        } : {
          coverage_level: "unavailable",
          coverage_confidence: "unknown",
          coverage_sufficient_for_superlative: false,
          coverage_reason: "no_valid_structured_route",
        }),
      },
    };
  } catch (error) {
    if (error instanceof GatewayError && error.code === "NOT_FOUND") {
      throw new GatewayError("UPSTREAM_CHANGED", "The Shopify structured search route was temporarily unavailable during bounded acquisition.", {
        retryable: true,
        mode: "public_http",
        sourceUrl: error.sourceUrl,
        stage: "http",
        cause: error,
      });
    }
    if (error instanceof GatewayError) throw error;
    if (firstError instanceof GatewayError) throw firstError;
    throw error;
  }
}

function responseHasProductList(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  const item = object(value);
  return Boolean(item && ["products", "items", "results", "data"].some((key) => Array.isArray(item[key])));
}

function appendWooDiagnostics(result: ConnectorExecution, state: WooRouteState, attempts: WooAttempt[], extra: JsonObject = {}): ConnectorExecution {
  return {
    ...result,
    data: {
      ...result.data,
      diagnostics: {
        ...(object(result.data.diagnostics) ?? {}),
        ...wooDiagnostics(state, attempts, extra),
      },
    },
  };
}

async function probeWooStoreRoute(provider: CompatibilityProviderDefinition, route: "woo_store_api" | "woo_store_api_plain", state: WooRouteState, context: ConnectorContext, attempts: WooAttempt[]): Promise<"verified" | "empty" | "unavailable" | "unknown"> {
  const url = wooRouteUrl(provider, route);
  url.searchParams.set("per_page", "1");
  if (!url.searchParams.get("rest_route")) url.searchParams.set("_fields", "id,name,slug,prices,permalink");
  try {
    const result = await publicJson(provider, url.toString(), context);
    const products = wooProductsFromResponse(result.value, provider, MAX_GENERIC_RECORDS, currencyContextFromUnknown(context.dynamic_site?.currency_context));
    if (products.length) {
      state.store_api_verified = true;
      state.route_failures[route] = 0;
      attempts.push({ route, state: "SUCCESS_WITH_RESULTS", url: result.url });
      wooRouteCache.set(provider.domain, state);
      return "verified";
    }
    const emptyState = responseHasProductList(result.value) ? "GENUINE_ZERO_RESULTS" : "PARSER_MISMATCH";
    attempts.push({ route, state: emptyState, url: result.url });
    return emptyState === "GENUINE_ZERO_RESULTS" ? "empty" : "unknown";
  } catch (error) {
    const stateForError = wooErrorState(error);
    attempts.push({ route, state: stateForError, url: error instanceof GatewayError ? error.sourceUrl : url.toString(), error });
    markWooRouteFailure(provider, state, route, "search");
    return stateForError === "ROUTE_NOT_AVAILABLE" ? "unavailable" : "unknown";
  }
}

async function attemptWooJsonSearch(provider: CompatibilityProviderDefinition, route: WooRoute, input: JsonObject, context: ConnectorContext): Promise<{ execution?: ConnectorExecution; attempt: WooAttempt }> {
  const url = wooRouteUrl(provider, route);
  const internalLimit = input.search_objective && input.search_objective !== "discovery"
    ? MAX_INTERNAL_SEMANTIC_RESULTS
    : typeof input.max_results === "number" ? Math.min(20, input.max_results) : 20;
  addWooSearchParams(url, String(input.query), internalLimit);
  try {
    const result = await publicJson(provider, url.toString(), context);
    const products = queryFilter(wooProductsFromResponse(result.value, provider, internalLimit, currencyContextFromUnknown(context.dynamic_site?.currency_context)), input.query, true).slice(0, internalLimit);
    if (products.length) {
      const scope: SnapshotScope = {
        kind: "search",
        key: normalizedScopeQuery(input.query) ?? "unknown",
        ...(normalizedScopeQuery(input.query) ? { query: normalizedScopeQuery(input.query) } : {}),
      };
      const snapshot = provider.dynamic ? createStoreSnapshot(provider, products, {
        origin: providerOrigin(provider),
        search_query: String(input.query ?? ""),
        coverage_level: "bounded_partial",
        source_url: result.url,
        acquisition_tier: "tier1_targeted",
        network_requests: 1,
        routes: [route],
        scope,
        intent_value: input,
        acquisition: {
          strategy: `woocommerce_${route}_search`,
          scope,
          pages_fetched: 1,
          pagination_complete: false,
          records_acquired: products.length,
          records_capped: false,
          termination_reason: "query_results",
          max_requests: 1,
        },
        ...(currencyContextFromUnknown(context.dynamic_site?.currency_context) ? { currency_context: currencyContextFromUnknown(context.dynamic_site?.currency_context)! } : {}),
        route_context: { route },
        coverage_reason: "targeted_search_results_not_catalogue_complete",
      }) : null;
      return {
        execution: execution(provider, "search_products", result.url, {
          query: input.query,
          results: products,
          ...(snapshot ? {
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
          } : {}),
          diagnostics: {
            response_classification: "SEARCH_RESULTS",
            extraction_strategy: route,
            ...(snapshot ? {
              snapshot_cache: "miss",
              acquisition_tier: "tier1_targeted",
              records_acquired: snapshot.records.length,
              network_requests: 1,
              scope: snapshot.scope,
              scope_relevance: snapshot.scope_relevance,
              scope_sufficient_for_query: snapshot.scope_sufficient_for_query,
              acquisition_complete: snapshot.acquisition_complete,
              semantic_confidence: snapshot.semantic_confidence,
              sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
              acquisition: snapshot.acquisition,
              coverage_reason: snapshot.coverage_reason,
            } : {}),
          },
        }, context.startedAt, "SUCCESS", route),
        attempt: { route, state: "SUCCESS_WITH_RESULTS", url: result.url },
      };
    }
    return {
      attempt: {
        route,
        state: responseHasProductList(result.value) ? "GENUINE_ZERO_RESULTS" : "PARSER_MISMATCH",
        url: result.url,
      },
    };
  } catch (error) {
    return { attempt: { route, state: wooErrorState(error), url: error instanceof GatewayError ? error.sourceUrl : url.toString(), error } };
  }
}

async function attemptWooExhaustiveSearch(
  provider: CompatibilityProviderDefinition,
  state: WooRouteState,
  input: JsonObject,
  context: ConnectorContext,
): Promise<{ execution?: ConnectorExecution; attempts: WooAttempt[] }> {
  const searchQueries = (Array.isArray(input.search_queries) ? input.search_queries : [input.query])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim().slice(0, 120))
    .slice(0, 4);
  const routes: WooRoute[] = [];
  const addRoute = (route: WooRoute): void => {
    if (!routes.includes(route) && route !== "woo_frontend_search" && route !== "structured_catalogue") routes.push(route);
  };
  if (state.preferred_search) addRoute(state.preferred_search);
  if (state.routes.store_api) addRoute("woo_store_api");
  if (state.routes.store_api_plain) addRoute("woo_store_api_plain");
  if (state.routes.product_search_api) addRoute("woo_product_search_api");
  const attempts: WooAttempt[] = [];
  let firstError: unknown;
  const acquisitionStartedAt = Date.now();
  for (const route of routes) {
    const products: ProductCandidate[] = [];
    const seen = new Set<string>();
    let routeUsable = false;
    let routeComplete = true;
    let lastUrl: string | undefined;
    let networkRequests = 0;
    let pagesFetched = 0;
    let recordsCapped = false;
    const addProducts = (value: unknown, query: string): number => {
      let added = 0;
      for (const product of queryFilter(wooProductsFromResponse(value, provider, WOO_PAGE_SIZE, currencyContextFromUnknown(context.dynamic_site?.currency_context)), query)) {
        const key = `${product.product_id}:${product.canonical_url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        products.push(product);
        added += 1;
        if (products.length >= MAX_SNAPSHOT_RECORDS) {
          recordsCapped = true;
          break;
        }
      }
      return added;
    };
    for (const query of searchQueries.length ? searchQueries : [String(input.query ?? "")]) {
      let queryComplete = false;
      for (let start = 1; start <= 80 && !queryComplete && !recordsCapped; start += ACQUISITION_CONCURRENCY) {
        const pages = Array.from({ length: Math.min(ACQUISITION_CONCURRENCY, 80 - start + 1) }, (_, index) => start + index);
        const batch = await Promise.all(pages.map(async (page) => {
          const url = wooRouteUrl(provider, route);
        addWooSearchParams(url, query, WOO_PAGE_SIZE, page);
          networkRequests += 1;
          try {
            const result = await publicJson(provider, url.toString(), context);
            const rows = wooProductsFromResponse(result.value, provider, WOO_PAGE_SIZE, currencyContextFromUnknown(context.dynamic_site?.currency_context));
            const hasList = responseHasProductList(result.value) || Array.isArray(result.value);
            if (!hasList) throw new GatewayError("UPSTREAM_CHANGED", "The WooCommerce route returned an unrecognized product payload.", { retryable: true, mode: "public_http", sourceUrl: result.url, stage: "semantic" });
            return { page, url: result.url, rows, value: result.value };
          } catch (error) {
            return { page, url: error instanceof GatewayError ? error.sourceUrl ?? url.toString() : url.toString(), error };
          }
        }));
        const terminalPage = batch.filter((item): item is { page: number; url: string; rows: ProductCandidate[]; value: unknown } => Array.isArray(item.rows) && item.rows.length < WOO_PAGE_SIZE).map((item) => item.page).sort((left, right) => left - right)[0];
        let batchFailed = false;
        for (const item of batch.sort((left, right) => left.page - right.page)) {
          if (terminalPage !== undefined && item.page > terminalPage) continue;
          if (item.error) {
            firstError ??= item.error;
            batchFailed = true;
            attempts.push({ route, state: wooErrorState(item.error), url: item.url, error: item.error });
            continue;
          }
          lastUrl = item.url;
          routeUsable = true;
          pagesFetched += 1;
          addProducts(item.value, query);
        }
        if (terminalPage !== undefined && !batchFailed) {
          queryComplete = true;
          break;
        }
        if (batchFailed) {
          routeComplete = false;
          break;
        }
      }
      if (!queryComplete) routeComplete = false;
      if (!routeUsable && attempts.at(-1)?.route === route) break;
    }
    if (routeUsable) {
      const coverageConfidence = routeComplete && !recordsCapped ? "high" : products.length ? "partial" : "unknown";
      const scope: SnapshotScope = {
        kind: "search",
        key: normalizedScopeQuery(input.query) ?? "unknown",
        ...(normalizedScopeQuery(input.query) ? { query: normalizedScopeQuery(input.query) } : {}),
      };
      const terminationReason: SnapshotTerminationReason = routeComplete && !recordsCapped
        ? "end_of_catalogue"
        : recordsCapped ? "max_products" : firstError ? "upstream_error" : "max_pages";
      const coverageReason = routeComplete && !recordsCapped
        ? "complete_query_route"
        : terminationReason === "max_products" ? "bounded_partial_max_products"
          : terminationReason === "max_pages" ? "bounded_partial_max_pages"
            : "upstream_error_before_scope_completion";
      const snapshot = provider.dynamic ? createStoreSnapshot(provider, products, {
        origin: providerOrigin(provider),
        search_query: String(input.query ?? ""),
        coverage_level: routeComplete && !recordsCapped ? "complete_for_query" : "bounded_partial",
        source_url: lastUrl ?? providerOrigin(provider),
        acquisition_tier: "tier4_catalogue",
        network_requests: networkRequests,
        routes: [route],
        scope,
        intent_value: input,
        acquisition: {
          strategy: `woocommerce_${route}_paged_search`,
          scope,
          pages_fetched: pagesFetched,
          pagination_complete: routeComplete && !recordsCapped,
          records_acquired: products.length,
          records_capped: recordsCapped,
          termination_reason: terminationReason,
          max_pages: 80,
          max_products: MAX_SNAPSHOT_RECORDS,
        },
        ...(currencyContextFromUnknown(context.dynamic_site?.currency_context) ? { currency_context: currencyContextFromUnknown(context.dynamic_site?.currency_context)! } : {}),
        route_context: { route },
        coverage_reason: coverageReason,
      }) : null;
      attempts.push({ route, state: products.length ? "SUCCESS_WITH_RESULTS" : "GENUINE_ZERO_RESULTS", ...(lastUrl ? { url: lastUrl } : {}) });
      markWooRouteSuccess(provider, state, route, "search");
      return {
        execution: execution(provider, "search_products", lastUrl ?? wooRouteUrl(provider, route).toString(), {
          query: input.query,
          results: products.slice(0, typeof input.max_results === "number" ? Math.min(20, input.max_results) : 20),
          ...(snapshot ? {
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
          } : {}),
          search_objective: input.search_objective ?? "exhaustive_ranked",
          coverage_confidence: coverageConfidence,
          coverage_sufficient_for_superlative: snapshot ? snapshotSupportsSuperlative(snapshot) : coverageConfidence === "high",
          diagnostics: {
            response_classification: products.length ? "SEARCH_RESULTS" : "ZERO_RESULTS",
            extraction_strategy: "woocommerce_bounded_paged_search",
            acquisition_waterfall: attempts.map((attempt) => ({ route: attempt.route, state: attempt.state, ...(attempt.url ? { url: attempt.url } : {}) })),
            query_variants: searchQueries,
            capped: coverageConfidence !== "high",
            ...(snapshot ? {
              snapshot_cache: "miss",
              records_acquired: snapshot.records.length,
              records_capped: recordsCapped,
              network_requests: networkRequests,
              scope: snapshot.scope,
              scope_relevance: snapshot.scope_relevance,
              scope_sufficient_for_query: snapshot.scope_sufficient_for_query,
              acquisition_complete: snapshot.acquisition_complete,
              semantic_confidence: snapshot.semantic_confidence,
              sufficient_for_superlative: snapshotSupportsSuperlative(snapshot),
              acquisition: snapshot.acquisition,
              coverage_reason: snapshot.coverage_reason,
              stage_metrics_ms: { catalogue: Math.max(0, Date.now() - acquisitionStartedAt), total: Math.max(0, Date.now() - acquisitionStartedAt) },
            } : {}),
          },
        }, context.startedAt, products.length ? "SUCCESS" : "ZERO_RESULTS", route),
        attempts,
      };
    }
  }
  if (firstError && attempts.length) return { attempts };
  return { attempts };
}

async function wooScopedCategorySearch(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution | null> {
  if (provider.engine !== "woocommerce" || context.dynamic_site?.scope_hint?.kind !== "collection") return null;
  const scopeHint = context.dynamic_site.scope_hint;
  const handle = scopeHint.collection_handle ?? scopeHint.key;
  if (!/^[a-z0-9][a-z0-9-]{1,120}$/i.test(handle)) return null;
  const scope: SnapshotScope = {
    kind: "collection",
    key: handle.toLowerCase(),
    ...(scopeHint.path ? { path: scopeHint.path } : {}),
    ...(normalizedScopeQuery(input.query) ? { query: normalizedScopeQuery(input.query) } : {}),
  };
  const acquisitionStartedAt = Date.now();
  const categoryUrl = new URL(`${providerOrigin(provider)}/wp-json/wc/store/v1/products/categories`);
  categoryUrl.searchParams.set("slug", handle);
  categoryUrl.searchParams.set("per_page", "1");
  try {
    const categoryResult = await publicJson(provider, categoryUrl.toString(), context);
    const categoryRoot = object(categoryResult.value);
    const categoryRows = Array.isArray(categoryResult.value)
      ? categoryResult.value
      : Array.isArray(categoryRoot?.categories) ? categoryRoot.categories : [];
    const category = categoryRows.map(object).find((item) => String(item?.slug ?? "").toLowerCase() === handle.toLowerCase()) ?? categoryRows.map(object).find((item) => item?.id !== undefined);
    const categoryId = category ? Number(category.id) : NaN;
    if (!Number.isInteger(categoryId) || categoryId < 1) return null;

    const products: ProductCandidate[] = [];
    const seen = new Set<string>();
    const routeAttempts: JsonObject[] = [{ route: "woo_category_lookup", handle, category_id: categoryId }];
    let sourceUrl = categoryResult.url;
    let pagesFetched = 0;
    let networkRequests = 1;
    let paginationComplete = false;
    let recordsCapped = false;
    let terminationReason: SnapshotTerminationReason = "max_pages";
    for (let page = 1; page <= MAX_WOO_CATEGORY_PAGES; page += 1) {
      if (networkRequests >= MAX_WOO_CATEGORY_REQUESTS) {
        terminationReason = "max_requests";
        break;
      }
      if (Date.now() - acquisitionStartedAt >= MAX_WOO_CATEGORY_ELAPSED_MS) {
        terminationReason = "max_elapsed_ms";
        break;
      }
      const productsUrl = new URL(`${providerOrigin(provider)}/wp-json/wc/store/v1/products`);
      productsUrl.searchParams.set("category", String(categoryId));
      productsUrl.searchParams.set("per_page", String(WOO_PAGE_SIZE));
      productsUrl.searchParams.set("page", String(page));
      productsUrl.searchParams.set("_fields", "id,name,slug,prices,price,regular_price,sale_price,images,average_rating,rating_count,review_count,stock_status,permalink,short_description,variations");
      networkRequests += 1;
      try {
        const result = await publicJson(provider, productsUrl.toString(), context);
        sourceUrl = result.url;
        const rows = wooProductsFromResponse(result.value, provider, WOO_PAGE_SIZE, currencyContextFromUnknown(context.dynamic_site?.currency_context));
        if (!(responseHasProductList(result.value) || Array.isArray(result.value))) throw new GatewayError("UPSTREAM_CHANGED", "The WooCommerce category route returned an unrecognized product payload.", { retryable: true, mode: "public_http", sourceUrl: result.url, stage: "semantic" });
        pagesFetched += 1;
        let added = 0;
        for (const product of rows) {
          const key = `${product.product_id}:${product.canonical_url}`;
          if (seen.has(key)) continue;
          seen.add(key);
          products.push(product);
          added += 1;
          if (products.length >= MAX_SNAPSHOT_RECORDS) {
            recordsCapped = true;
            break;
          }
        }
        routeAttempts.push({ route: "woo_category_products", handle, category_id: categoryId, page, returned: rows.length, added });
        if (recordsCapped) {
          terminationReason = "max_products";
          break;
        }
        if (rows.length < WOO_PAGE_SIZE) {
          paginationComplete = true;
          terminationReason = "end_of_collection";
          break;
        }
      } catch (error) {
        routeAttempts.push({ route: "woo_category_products", handle, category_id: categoryId, page, error: error instanceof GatewayError ? error.code : "UPSTREAM_ERROR" });
        if (!products.length) return null;
        terminationReason = "upstream_error";
        break;
      }
    }
    const coverageLevel: SnapshotCoverageLevel = paginationComplete && !recordsCapped ? "complete_for_query" : "bounded_partial";
    const coverageReason = paginationComplete && !recordsCapped
      ? "complete_relevant_collection"
      : terminationReason === "max_pages" || terminationReason === "max_products" || terminationReason === "max_requests" || terminationReason === "max_elapsed_ms"
        ? `bounded_partial_${terminationReason}`
        : "upstream_error_before_scope_completion";
    const snapshot = provider.dynamic ? createStoreSnapshot(provider, products, {
      origin: providerOrigin(provider),
      search_query: String(input.query ?? ""),
      coverage_level: coverageLevel,
      source_url: sourceUrl,
      acquisition_tier: "tier3_collection",
      network_requests: networkRequests,
      routes: ["woo_category_products"],
      scope,
      intent_value: input,
      scope_relevance: scoreCompatibilityCollection({ handle, title: handle }, input, { explicit_scope: true }),
      acquisition: {
        strategy: "woocommerce_category_pagination",
        scope,
        pages_fetched: pagesFetched,
        pagination_complete: paginationComplete && !recordsCapped,
        records_acquired: products.length,
        records_capped: recordsCapped,
        termination_reason: terminationReason,
        max_pages: MAX_WOO_CATEGORY_PAGES,
        max_products: MAX_SNAPSHOT_RECORDS,
        max_requests: MAX_WOO_CATEGORY_REQUESTS,
        max_elapsed_ms: MAX_WOO_CATEGORY_ELAPSED_MS,
      },
      ...(currencyContextFromUnknown(context.dynamic_site?.currency_context) ? { currency_context: currencyContextFromUnknown(context.dynamic_site?.currency_context)! } : {}),
      route_context: {
        route: "woo_category_products",
        ...(typeof input.currency === "string" ? { currency: input.currency.toUpperCase() } : {}),
        ...(typeof input.locale === "string" ? { locale: input.locale } : {}),
      },
      coverage_reason: coverageReason,
    }) : null;
    return execution(provider, "search_products", sourceUrl, {
      query: input.query,
      results: products.slice(0, typeof input.max_results === "number" ? Math.min(20, input.max_results) : 20),
      ...(snapshot ? {
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
      } : {
        coverage_level: coverageLevel,
        coverage_confidence: coverageLevel === "complete_for_query" ? "high" : "partial",
        coverage_sufficient_for_superlative: coverageLevel === "complete_for_query" && !recordsCapped,
        scope,
        coverage_reason: coverageReason,
      }),
      search_objective: input.search_objective ?? "discovery",
      diagnostics: {
        response_classification: products.length ? "SEARCH_RESULTS" : "ZERO_RESULTS",
        extraction_strategy: "woocommerce_category_pagination",
        acquisition_strategy: "collection",
        acquisition_waterfall: routeAttempts,
        scope,
        scope_relevance: snapshot?.scope_relevance,
        scope_sufficient_for_query: snapshot?.scope_sufficient_for_query,
        acquisition_complete: snapshot?.acquisition_complete,
        semantic_confidence: snapshot?.semantic_confidence,
        sufficient_for_superlative: snapshot ? snapshotSupportsSuperlative(snapshot) : false,
        acquisition: snapshot?.acquisition ?? {
          strategy: "woocommerce_category_pagination",
          scope,
          pages_fetched: pagesFetched,
          pagination_complete: paginationComplete && !recordsCapped,
          records_acquired: products.length,
          records_capped: recordsCapped,
          termination_reason: terminationReason,
          max_pages: MAX_WOO_CATEGORY_PAGES,
          max_products: MAX_SNAPSHOT_RECORDS,
          max_requests: MAX_WOO_CATEGORY_REQUESTS,
          max_elapsed_ms: MAX_WOO_CATEGORY_ELAPSED_MS,
        },
        coverage_reason: coverageReason,
        records_acquired: products.length,
        records_capped: recordsCapped,
        network_requests: networkRequests,
        stage_metrics_ms: { collection: Math.max(0, Date.now() - acquisitionStartedAt), total: Math.max(0, Date.now() - acquisitionStartedAt) },
      },
    }, context.startedAt, products.length ? "SUCCESS" : "ZERO_RESULTS", "woo_store_api");
  } catch {
    return null;
  }
}

async function wooSearch(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const state = await discoverWooRoutes(provider, context);
  const objective = String(input.search_objective ?? "discovery");
  const scopedCategory = await wooScopedCategorySearch(provider, input, context);
  if (scopedCategory) return appendWooDiagnostics(scopedCategory, state, [], { preferred_acquisition_route: "woo_category_products" });
  if (objective !== "discovery") {
    const exhaustive = await attemptWooExhaustiveSearch(provider, state, input, context);
    if (exhaustive.execution) return appendWooDiagnostics(exhaustive.execution, state, exhaustive.attempts, { preferred_acquisition_route: exhaustive.execution.data.diagnostics && object(exhaustive.execution.data.diagnostics)?.extraction_strategy });
  }
  const attempts: WooAttempt[] = [];
  const firstErrors: unknown[] = [];
  const orderedRoutes: WooRoute[] = [];
  const addRoute = (route: WooRoute): void => {
    if (!orderedRoutes.includes(route)) orderedRoutes.push(route);
  };
  if (state.preferred_search) addRoute(state.preferred_search);
  if (state.routes.store_api) addRoute("woo_store_api");
  if (state.routes.store_api_plain) addRoute("woo_store_api_plain");
  if (state.routes.product_search_api) addRoute("woo_product_search_api");

  for (const route of orderedRoutes) {
    if ((route === "woo_store_api" || route === "woo_store_api_plain") && !state.store_api_verified) {
      const probe = await probeWooStoreRoute(provider, route, state, context, attempts);
      if (probe === "empty" || probe === "unavailable" || (probe === "unknown" && state.rest_index_status === "verified")) continue;
    }
    const result = await attemptWooJsonSearch(provider, route, input, context);
    attempts.push(result.attempt);
    if (result.execution) {
      markWooRouteSuccess(provider, state, route, "search");
      return appendWooDiagnostics(result.execution, state, attempts, { preferred_acquisition_route: route });
    }
    if (result.attempt.error) firstErrors.push(result.attempt.error);
    if (!["GENUINE_ZERO_RESULTS"].includes(result.attempt.state)) markWooRouteFailure(provider, state, route, "search");
  }

  const frontendUrl = wooFrontendSearchUrl(provider, String(input.query));
  try {
    const result = await htmlSearch(
      provider,
      input,
      context,
      firstErrors[0],
      frontendUrl,
      wooDiagnostics(state, attempts, { acquisition_waterfall: orderedRoutes }),
      "woo_frontend_search",
    );
    const frontendAttempt: WooAttempt = {
      route: "woo_frontend_search",
      state: result.outcome === "ZERO_RESULTS" ? "GENUINE_ZERO_RESULTS" : "SUCCESS_WITH_RESULTS",
      url: result.sourceUrl,
    };
    attempts.push(frontendAttempt);
    markWooRouteSuccess(provider, state, "woo_frontend_search", "search");
    return appendWooDiagnostics(result, state, attempts, { preferred_acquisition_route: "woo_frontend_search" });
  } catch (error) {
    const attempt: WooAttempt = { route: "woo_frontend_search", state: wooErrorState(error), url: error instanceof GatewayError ? error.sourceUrl : frontendUrl, error };
    attempts.push(attempt);
    markWooRouteFailure(provider, state, "woo_frontend_search", "search");
    if (error instanceof GatewayError) throw error;
    const fallback = firstErrors.find((value): value is GatewayError => value instanceof GatewayError);
    if (fallback) throw fallback;
    throw new GatewayError(wooFailureCode(attempt.state), "The WooCommerce public search waterfall could not produce a validated result.", { retryable: true, mode: "public_http", sourceUrl: frontendUrl, stage: "semantic" });
  }
}

async function structuredSearch(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  return htmlSearch(provider, input, context);
}

function canonicalFromInput(provider: CompatibilityProviderDefinition, input: JsonObject): string | null {
  return canonicalProviderUrl(input.canonical_url ?? input.product_id, provider);
}

async function shopifyDetail(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const canonical = canonicalFromInput(provider, input);
  const handle = canonical ? idFromUrl(canonical) : String(input.product_id);
  if (!handle) throw new GatewayError("INPUT_INVALID", "product_id did not identify a public product route.");
  const detailCurrencyContext = currencyContextFromUnknown(context.dynamic_site?.currency_context) ?? cachedCurrencyContext(provider, { locale: input.locale });
  let lastError: unknown;
  for (const suffix of [".js", ".json"]) {
    try {
      const result = await publicJson(provider, `${providerOrigin(provider)}/products/${encodeURIComponent(handle)}${suffix}`, context);
      const products = normalizeCompatibilityProducts(result.value, provider, MAX_GENERIC_RECORDS, { ...(detailCurrencyContext ? { currency_context: detailCurrencyContext } : {}), locale: input.locale, route: `shopify_product${suffix}` });
      const product = products.find((item) => String(item.product_id) === handle) ?? products[0];
      if (product) return execution(provider, "get_product", result.url, { product, diagnostics: { extraction_strategy: `shopify_product${suffix}` } }, context.startedAt, "SUCCESS", `shopify_product${suffix}`, undefined, handle);
    } catch (error) {
      lastError = error;
    }
  }
  const pageUrl = canonical ?? `${providerOrigin(provider)}/products/${encodeURIComponent(handle)}`;
  const page = await publicText(provider, pageUrl, context);
  if (pageBlocked(page.text)) throw new GatewayError("UPSTREAM_BLOCKED", "The public product page returned an automated-access or interstitial response.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
  const extracted = extractCompatibilityProducts(page.text, provider, page.url, { ...(detailCurrencyContext ? { currency_context: detailCurrencyContext } : {}), locale: input.locale });
  const product = extracted.find((item) => String(item.product_id) === handle) ?? extracted[0];
  if (!product) throw new GatewayError("UPSTREAM_CHANGED", "The public product page did not contain a valid product record.", { retryable: true, mode: "public_http", sourceUrl: page.url, stage: "semantic", cause: lastError });
  return execution(provider, "get_product", page.url, { product, diagnostics: { extraction_strategy: "shopify_product_html" } }, context.startedAt, "SUCCESS", "shopify_product_html", page.text, handle);
}

function explicitCanonicalFromInput(provider: CompatibilityProviderDefinition, input: JsonObject): string | null {
  const value = input.canonical_url ?? (typeof input.product_id === "string" && /^https?:\/\//i.test(input.product_id) ? input.product_id : null);
  return canonicalProviderUrl(value, provider);
}

function wooDetailIdentityMatches(product: ProductCandidate, input: JsonObject, pageUrl: string, provider: CompatibilityProviderDefinition): boolean {
  const expected = String(input.product_id ?? "").trim();
  const canonicalExpected = explicitCanonicalFromInput(provider, input);
  const canonicalProduct = canonicalProviderUrl(product.canonical_url, provider);
  if (canonicalExpected && canonicalProduct === canonicalExpected) return true;
  if (String(product.product_id ?? "").toLowerCase() === expected.toLowerCase()) return true;
  const pageCanonical = canonicalProviderUrl(pageUrl, provider);
  return !canonicalExpected && Boolean(pageCanonical && idFromUrl(pageCanonical)?.toLowerCase() === expected.toLowerCase());
}

function alignWooDetailIdentity(product: ProductCandidate, input: JsonObject, provider: CompatibilityProviderDefinition): ProductCandidate {
  const expected = String(input.product_id ?? "").trim();
  const canonicalExpected = explicitCanonicalFromInput(provider, input);
  if (/^\d+$/.test(expected) && canonicalExpected && canonicalProviderUrl(product.canonical_url, provider) === canonicalExpected) {
    return { ...product, product_id: expected };
  }
  return product;
}

function wooDetailProductFromPage(html: string, pageUrl: string, provider: CompatibilityProviderDefinition, input: JsonObject): ProductCandidate | null {
  const candidates = extractCompatibilityProducts(html, provider, pageUrl);
  const matching = candidates.find((product) => wooDetailIdentityMatches(product, input, pageUrl, provider));
  const variationFields = wooVariationFields(html);
  if (matching) {
    const enriched = productFromObject({ ...matching, ...variationFields }, provider, typeof matching.canonical_url === "string" ? matching.canonical_url : undefined) ?? matching;
    return alignWooDetailIdentity(enriched, input, provider);
  }
  const structured = extractJsonLd(html).filter((value) => {
    const type = value["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  });
  for (const value of structured) {
    const product = productFromObject({ ...value, ...variationFields }, provider, pageUrl);
    if (product && wooDetailIdentityMatches(product, input, pageUrl, provider)) return alignWooDetailIdentity(product, input, provider);
  }
  const heading = text(extractTagText(html, "h1") ?? extractMeta(html, "og:title"), 260);
  if (!heading || genericTitle(heading)) return null;
  const headingIndex = html.search(/<h1\b/i);
  const scope = html.slice(Math.max(0, headingIndex < 0 ? 0 : headingIndex - 8_000), Math.min(html.length, headingIndex < 0 ? 18_000 : headingIndex + 18_000));
  const priceMarkup = /<(?:span|p|div)[^>]+(?:class|itemprop)=["'][^"']*(?:price|amount)[^"']*["'][^>]*>([\s\S]{0,300}?)<\/(?:span|p|div)>/i.exec(scope)?.[1];
  const dataId = /data-product[_-]id\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null;
  const product = productFromObject({
    id: dataId ?? idFromUrl(pageUrl) ?? input.product_id,
    title: heading,
    name: heading,
    url: pageUrl,
    price: parseMoney(sanitizeText(priceMarkup ?? "", 500) ?? "", "GBP"),
    ...variationFields,
    availability: /(?:outofstock|out of stock|unavailable)/i.test(scope) ? "out of stock" : /(?:instock|in stock|available)/i.test(scope) ? "in stock" : null,
  }, provider, pageUrl);
  return product && wooDetailIdentityMatches(product, input, pageUrl, provider)
    ? alignWooDetailIdentity(product, input, provider)
    : null;
}

async function wooDetail(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const id = String(input.product_id).trim();
  if (!id) throw new GatewayError("INPUT_INVALID", "product_id must identify a public WooCommerce product.");
  const state = await discoverWooRoutes(provider, context);
  const attempts: WooAttempt[] = [];
  const routes: WooRoute[] = [];
  const addRoute = (route: WooRoute): void => {
    if (!routes.includes(route)) routes.push(route);
  };
  if (state.preferred_detail) addRoute(state.preferred_detail);
  if (state.routes.store_api || state.rest_index_status === "unknown") addRoute("woo_store_api");
  if (state.routes.store_api_plain || state.rest_index_status === "unknown") addRoute("woo_store_api_plain");
  if (state.routes.product_search_api) addRoute("woo_product_search_api");
  let lastError: unknown;
  for (const route of routes) {
    const url = wooRouteUrl(provider, route, id);
    try {
      const result = await publicJson(provider, url.toString(), context);
      const product = wooProductsFromResponse(result.value, provider, MAX_GENERIC_RECORDS, currencyContextFromUnknown(context.dynamic_site?.currency_context))[0];
      if (!product || !wooDetailIdentityMatches(product, input, result.url, provider)) {
        attempts.push({ route, state: "PARSER_MISMATCH", url: result.url });
        markWooRouteFailure(provider, state, route, "detail");
        continue;
      }
      const aligned = alignWooDetailIdentity(product, input, provider);
      attempts.push({ route, state: "SUCCESS_WITH_RESULTS", url: result.url });
      markWooRouteSuccess(provider, state, route, "detail");
      const resultExecution = execution(provider, "get_product", result.url, { product: aligned, diagnostics: { extraction_strategy: route } }, context.startedAt, "SUCCESS", route, undefined, id);
      return appendWooDiagnostics(resultExecution, state, attempts, { preferred_acquisition_route: route });
    } catch (error) {
      lastError = error;
      const stateForError = wooErrorState(error);
      attempts.push({ route, state: stateForError, url: error instanceof GatewayError ? error.sourceUrl : url.toString(), error });
      markWooRouteFailure(provider, state, route, "detail");
      if (error instanceof GatewayError && ["UPSTREAM_TIMEOUT", "PROVIDER_RESTRICTED"].includes(error.code)) {
        // A blocked route does not make the storefront detail page unusable.
        continue;
      }
    }
  }

  const explicitCanonical = explicitCanonicalFromInput(provider, input);
  const candidates = [
    explicitCanonical,
    `${providerOrigin(provider)}/product/${encodeURIComponent(id)}/`,
    `${providerOrigin(provider)}/products/${encodeURIComponent(id)}/`,
    /^https?:\/\//i.test(id) ? null : `${providerOrigin(provider)}/${encodeURIComponent(id)}/`,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  for (const url of candidates.slice(0, 4)) {
    try {
      const page = await publicText(provider, url, context);
      if (pageBlocked(page.text)) throw new GatewayError("UPSTREAM_BLOCKED", "The public product page returned an automated-access or interstitial response.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
      const product = wooDetailProductFromPage(page.text, page.url, provider, input);
      if (!product) {
        attempts.push({ route: "structured_catalogue", state: "PARSER_MISMATCH", url: page.url });
        markWooRouteFailure(provider, state, "structured_catalogue", "detail");
        continue;
      }
      attempts.push({ route: "structured_catalogue", state: "SUCCESS_WITH_RESULTS", url: page.url });
      markWooRouteSuccess(provider, state, "structured_catalogue", "detail");
      const resultExecution = execution(provider, "get_product", page.url, { product, diagnostics: { extraction_strategy: "woocommerce_structured_detail" } }, context.startedAt, "SUCCESS", "structured_catalogue", page.text, String(product.product_id));
      return appendWooDiagnostics(resultExecution, state, attempts, { preferred_acquisition_route: "structured_catalogue" });
    } catch (error) {
      lastError = error;
      const stateForError = wooErrorState(error);
      attempts.push({ route: "structured_catalogue", state: stateForError, url: error instanceof GatewayError ? error.sourceUrl : url, error });
      markWooRouteFailure(provider, state, "structured_catalogue", "detail");
      if (error instanceof GatewayError && ["UPSTREAM_BLOCKED", "PROVIDER_RESTRICTED", "UPSTREAM_TIMEOUT"].includes(error.code)) throw error;
    }
  }
  if (lastError instanceof GatewayError && lastError.code === "UPSTREAM_BLOCKED") throw lastError;
  throw new GatewayError("UPSTREAM_CHANGED", "The WooCommerce public detail waterfall could not establish product identity.", { retryable: true, mode: "public_http", sourceUrl: explicitCanonical ?? candidates[0], stage: "semantic", cause: lastError });
}

async function structuredDetail(provider: CompatibilityProviderDefinition, input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const canonical = canonicalFromInput(provider, input);
  const candidates = [canonical, `${providerOrigin(provider)}/product/${encodeURIComponent(String(input.product_id))}/`, `${providerOrigin(provider)}/p/${encodeURIComponent(String(input.product_id))}`].filter((value): value is string => Boolean(value));
  let lastError: unknown;
  for (const url of candidates.slice(0, 3)) {
    try {
      const page = await publicText(provider, url, context);
      if (pageBlocked(page.text)) throw new GatewayError("UPSTREAM_BLOCKED", "The public product page returned an automated-access or interstitial response.", { retryable: false, mode: "public_http", sourceUrl: page.url, stage: "http" });
      const product = extractCompatibilityProducts(page.text, provider, page.url).find((item) => String(item.product_id) === String(input.product_id)) ?? extractCompatibilityProducts(page.text, provider, page.url)[0];
      if (product) return execution(provider, "get_product", page.url, { product, diagnostics: { extraction_strategy: "structured_product_page" } }, context.startedAt, "SUCCESS", "structured_product_page", page.text, String(input.product_id));
    } catch (error) {
      lastError = error;
      if (error instanceof GatewayError && ["UPSTREAM_TIMEOUT", "RATE_LIMITED", "PROVIDER_RESTRICTED"].includes(error.code)) throw error;
    }
  }
  throw new GatewayError("UPSTREAM_CHANGED", "The public product route did not contain a valid product record.", { retryable: true, mode: "public_http", sourceUrl: candidates[0], stage: "semantic", cause: lastError });
}

export function compatibilityProviderIds(): string[] {
  return COMPATIBILITY_PROVIDERS.filter((provider) => provider.enabled).map((provider) => provider.id);
}

export function compatibilityProviderFor(value: unknown): CompatibilityProviderDefinition | undefined {
  return compatibilityProvider(value);
}

function providerForPublicSite(site: PublicSite, engine: CompatibilityEngine = "structured_ssr"): DynamicCompatibilityProvider {
  return {
    id: site.domain,
    name: site.domain,
    domain: site.domain,
    base_url: site.origin,
    engine,
    categories: ["commerce"],
    keywords: [],
    enabled: true,
    dynamic: true,
    site_origin: site.origin,
  };
}

export function isDynamicCompatibilityProvider(value: unknown): value is DynamicCompatibilityProvider {
  return Boolean(value && typeof value === "object" && (value as JsonObject).dynamic === true && isDynamicProviderId((value as JsonObject).id));
}

export function dynamicProviderId(value: unknown): string | null {
  if (typeof value === "string" && isDynamicProviderId(value)) return value.toLowerCase().replace(/^www\./, "");
  return null;
}

function localeSegment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const locale = value.trim().replace(/_/g, "-");
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale) ? locale.toLowerCase() : null;
}

function shopifySuggestUrl(provider: DynamicCompatibilityProvider, query: string, locale?: string | null): string {
  const path = locale ? `/${locale}/search/suggest.json` : "/search/suggest.json";
  const url = new URL(`${providerOrigin(provider)}${path}`);
  url.searchParams.set("q", query);
  url.searchParams.set("resources[type]", "product");
  url.searchParams.set("resources[limit]", "20");
  url.searchParams.set("resources[options][unavailable_products]", "hide");
  return url.toString();
}

function defaultDetection(platform: "shopify" | "woocommerce", homepage?: DynamicProbeResult): CompatibilityDetection {
  if (homepage?.detection?.engine === platform) return homepage.detection;
  return {
    engine: platform,
    frameworks: platform === "shopify" ? ["shopify"] : [],
    rendering: "unknown",
    embedded_state_kinds: [],
    algolia: null,
    ...(platform === "woocommerce" ? { woocommerce: { platform, confidence: 0.9, signals: ["known public platform route"] } } : {}),
  };
}

function publicProbeSummary(probe: DynamicProbeResult): DynamicSiteProbe {
  const summary = { ...probe } as DynamicProbeResult;
  delete summary.detection;
  delete summary.value;
  delete summary.currency_context;
  return summary;
}

function probeErrorCode(probes: DynamicProbeResult[]): GatewayErrorCode {
  if (probes.length && probes.every((probe) => !probe.response_received && (probe.status === "unreachable" || probe.status === "timeout"))) return "SITE_UNREACHABLE";
  if (probes.some((probe) => probe.status === "blocked")) return "UPSTREAM_BLOCKED";
  if (probes.some((probe) => probe.status === "policy_restricted")) return "PROVIDER_RESTRICTED";
  return "PLATFORM_PROBE_FAILED";
}

function probeFailureMessage(code: GatewayErrorCode): string {
  if (code === "SITE_UNREACHABLE") return "The gateway runtime received no response from the bounded public compatibility routes.";
  if (code === "UPSTREAM_BLOCKED") return "The site responded, but its bounded public compatibility routes were blocked or challenged.";
  if (code === "PROVIDER_RESTRICTED") return "The site's public access policy disallows the bounded compatibility routes.";
  return "The site responded, but no bounded public Shopify or WooCommerce platform route produced valid evidence.";
}

/**
 * Detect one caller-supplied public site once, then reuse the generated
 * platform definition. Only Shopify and WooCommerce continue into the
 * generic engines; this is intentionally not a general URL scraper.
 */
export async function discoverDynamicCompatibilityProvider(
  value: unknown,
  context: ConnectorContext,
  options: { query?: unknown; locale?: unknown } = {},
): Promise<DynamicCompatibilityDiscovery> {
  const site = normalizePublicSite(value);
  const scope_hint = scopeHintForSite(value, options.query);
  const cached = dynamicProviderCache.get(site.domain);
  const cachedRecipe = getRecipe(site.domain, "commerce.search") ?? getRecipe(site.domain, "commerce.detail");
  const catalogExample = COMPATIBILITY_PROVIDERS.some((provider) => provider.domain.replace(/^www\./i, "").toLowerCase() === site.domain);
  const knownBeforeRequest = Boolean(cached || cachedRecipe || catalogExample);
  const recipeCache = cachedRecipe ? "warm" : "cold";
  if (cached && cached.expiresAt > Date.now()) {
    return {
      provider: cached.provider,
      detection: cached.detection,
      cache_status: "warm",
      normalized_origin: site.origin,
      known_before_request: knownBeforeRequest,
      recipe_cache: recipeCache,
      probe_attempts: [],
      scope_hint,
      ...(cached.currency_context ? { currency_context: cached.currency_context } : {}),
    };
  }

  const provisional = providerForPublicSite(site);
  const shopify = providerForPublicSite(site, "shopify");
  const woocommerce = providerForPublicSite(site, "woocommerce");
  const query = text(options.query, 120) ?? "product";
  const locale = localeSegment(options.locale);
  const suggestUrls = [shopifySuggestUrl(shopify, query), ...(locale ? [shopifySuggestUrl(shopify, query, locale)] : [])]
    .filter((url, index, values) => values.indexOf(url) === index);
  const [homepage, ...routeProbes] = await Promise.all([
    probeHomepage(provisional, context),
    ...suggestUrls.map((url, index) => probeJsonRoute(shopify, index ? "shopify_search_suggest_json_locale" : "shopify_search_suggest_json", url, context, "shopify", (payload) => {
      const rows = shopifySuggestRows(payload);
      return { valid: rows !== null, record_count: rows?.length ?? 0 };
    })),
    probeJsonRoute(shopify, "shopify_products_json_probe", `${providerOrigin(shopify)}/products.json?limit=1`, context, "shopify", (payload) => {
      const rows = shopifyProductsRows(payload);
      return { valid: rows !== null, record_count: rows?.length ?? 0 };
    }),
    probeJsonRoute(woocommerce, "woocommerce_rest_index", `${providerOrigin(woocommerce)}/wp-json/`, context, "woocommerce", (payload) => ({ valid: wooIndexEvidence(payload) })),
  ]);
  const probes = [homepage, ...routeProbes];
  const reportedProbes = [robotsObservation.get(site.domain), ...probes].filter((probe): probe is DynamicProbeResult => Boolean(probe));
  const homepagePlatform = homepage.platform;
  const successful = probes.filter((probe) => probe.status === "success" && probe.platform);
  const preferred = [
    ...routeProbes.filter((probe) => probe.platform === "shopify" && probe.route.startsWith("shopify_search_suggest")),
    ...routeProbes.filter((probe) => probe.platform === "shopify" && probe.route === "shopify_products_json_probe"),
    ...routeProbes.filter((probe) => probe.platform === "woocommerce"),
    ...(homepagePlatform ? [homepage] : []),
  ].find((probe) => probe.status === "success" && probe.platform);
  if (!preferred || !successful.length) {
    const code = probeErrorCode(probes);
    const details: JsonObject = {
      site: site.domain,
      normalized_origin: site.origin,
      provider_origin: "dynamic",
      known_before_request: knownBeforeRequest,
      recipe_cache: recipeCache,
      platform_detected: homepage.detection?.engine ?? null,
      supported_dynamic_platforms: ["shopify", "woocommerce"],
      frameworks_detected: homepage.detection?.frameworks ?? [],
      embedded_state_kinds: homepage.detection?.embedded_state_kinds ?? [],
      probe_attempts: reportedProbes.map(publicProbeSummary),
      runtime_egress_suspected: code === "SITE_UNREACHABLE",
    };
    throw new GatewayError(code, probeFailureMessage(code), {
      retryable: code === "SITE_UNREACHABLE" || code === "PLATFORM_PROBE_FAILED",
      mode: "public_http",
      sourceUrl: homepage.final_url ?? probes.find((probe) => probe.final_url)?.final_url ?? site.origin,
      stage: code === "UPSTREAM_BLOCKED" || code === "PROVIDER_RESTRICTED" ? "http" : "semantic",
      details,
    });
  }
  const platform = preferred.platform as "shopify" | "woocommerce";
  const detection = defaultDetection(platform, homepage);
  const provider: DynamicCompatibilityProvider = { ...provisional, engine: platform };
  const currencyContext = preferred.currency_context ?? homepage.currency_context ?? routeProbes.find((probe) => probe.currency_context)?.currency_context;
  dynamicProviderCache.set(site.domain, { provider, detection, expiresAt: Date.now() + DYNAMIC_PROVIDER_TTL_MS, ...(currencyContext ? { currency_context: currencyContext } : {}) });
  return {
    provider,
    detection,
    cache_status: "cold",
    normalized_origin: site.origin,
    known_before_request: knownBeforeRequest,
    recipe_cache: recipeCache,
    probe_attempts: reportedProbes.map(publicProbeSummary),
    scope_hint,
    selected_probe: {
      route: preferred.route,
      ...(preferred.final_url ? { final_url: preferred.final_url } : {}),
      platform,
      ...(preferred.record_count !== undefined ? { record_count: preferred.record_count } : {}),
    },
    selected_probe_data: preferred.value,
    ...(currencyContext ? { currency_context: currencyContext } : {}),
  };
}

export function compatibilityProviderRelevance(query: unknown, provider: CompatibilityProviderDefinition): boolean {
  const tokens = queryTokens(query);
  if (!tokens.length) return false;
  return [...provider.categories, ...(provider.keywords ?? [])]
    .some((term) => tokens.some((token) => term.toLowerCase().includes(token) || token.includes(term.toLowerCase())));
}

export function resetCompatibilityCaches(): void {
  robotsCache.clear();
  robotsInflight.clear();
  robotsObservation.clear();
  wooRouteCache.clear();
  dynamicProviderCache.clear();
  currencyContextCache.clear();
  storeSnapshots.clear();
  latestStoreSnapshots.clear();
}

/**
 * Execute one fixed compatibility definition through the shared generic
 * engine. The public connector uses this helper for catalog examples and
 * dynamically generated public-site definitions; benchmark targets remain
 * bounded inputs rather than an unrestricted URL proxy.
 */
export async function executeCompatibilityProvider(
  provider: CompatibilityProviderDefinition,
  tool: "search_products" | "get_product",
  input: JsonObject,
  context: ConnectorContext,
): Promise<ConnectorExecution> {
  if (tool === "search_products") {
    if (provider.engine === "shopify") return shopifySearch(provider, input, context);
    if (provider.engine === "woocommerce") return wooSearch(provider, input, context);
    return structuredSearch(provider, input, context);
  }
  if (provider.engine === "shopify") return shopifyDetail(provider, input, context);
  if (provider.engine === "woocommerce") return wooDetail(provider, input, context);
  return structuredDetail(provider, input, context);
}

export const compatibilityConnector: SiteConnector = {
  provider: "commerce",
  async execute(tool, input, context): Promise<ConnectorExecution> {
    const provider = compatibilityProvider(input.provider);
    if (!provider || !provider.enabled) throw new GatewayError("CONNECTOR_UNAVAILABLE", "The selected public compatibility provider is not enabled.");
    if (tool !== "search_products" && tool !== "get_product") {
      throw new GatewayError("CONNECTOR_UNAVAILABLE", `The ${provider.name} compatibility route does not implement ${tool}.`);
    }
    return executeCompatibilityProvider(provider, tool, input, context);
  },
};
