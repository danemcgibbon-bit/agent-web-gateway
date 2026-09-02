import type { JsonObject } from "./gateway-contract";

export type CommerceSearchScope = {
  kind: "store" | "collection" | "search" | "path";
  key: string;
  path?: string;
  query?: string;
};

export type CommerceSearchTerminationReason =
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

export type CommerceSearchAcquisition = {
  strategy: string;
  scope: CommerceSearchScope;
  pages_fetched: number;
  pagination_complete: boolean;
  records_acquired: number;
  records_capped: boolean;
  termination_reason: CommerceSearchTerminationReason;
  max_pages?: number;
  max_products?: number;
  max_requests?: number;
  max_elapsed_ms?: number;
};

export type CommerceSearchRouteContext = {
  platform: string;
  route: string;
  currency?: string;
  locale?: string;
};

export type CommerceSearchCoverage = {
  scope: CommerceSearchScope;
  coverage_level: "complete_for_query" | "bounded_partial" | "unavailable";
  coverage_confidence: "high" | "partial" | "unknown";
  coverage_sufficient_for_superlative: boolean;
  coverage_reason: string;
  acquisition: CommerceSearchAcquisition;
  route_context: CommerceSearchRouteContext;
};

function normalizedQuery(value: unknown): string | undefined {
  const query = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  return query ? query.toLowerCase() : undefined;
}

export function searchScopeForQuery(value: unknown): CommerceSearchScope {
  const query = normalizedQuery(value);
  return {
    kind: "search",
    key: query ?? "unknown",
    ...(query ? { query } : {}),
  };
}

/**
 * A single proof predicate is shared by dynamic and fixed commerce engines.
 * A result count or a successful HTTP response is never enough to establish
 * completeness; the acquisition must report a real terminal page.
 */
export function acquisitionProvesCompleteness(
  acquisition: Pick<CommerceSearchAcquisition, "pagination_complete" | "records_capped" | "termination_reason" | "records_acquired">,
  recordCount: number,
): boolean {
  return acquisition.pagination_complete
    && !acquisition.records_capped
    && (acquisition.termination_reason === "end_of_catalogue" || acquisition.termination_reason === "end_of_collection")
    && acquisition.records_acquired === recordCount;
}

function currencyCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) return undefined;
  return value.trim().toUpperCase();
}

/**
 * Build the common search contract for one-page or otherwise bounded public
 * searches. Callers should keep acquisition and route_context in diagnostics
 * when concise output is preferred, while exposing the coverage fields and
 * scope at the top level.
 */
export function publicSearchCoverage(options: {
  platform: string;
  route: string;
  strategy?: string;
  query: unknown;
  records_acquired: number;
  pages_fetched?: number;
  pagination_complete?: boolean;
  records_capped?: boolean;
  termination_reason?: CommerceSearchTerminationReason;
  max_pages?: number;
  max_products?: number;
  max_requests?: number;
  max_elapsed_ms?: number;
  coverage_level?: "complete_for_query" | "bounded_partial" | "unavailable";
  coverage_reason?: string;
  scope?: CommerceSearchScope;
  currency?: unknown;
  locale?: unknown;
}): CommerceSearchCoverage {
  const scope = options.scope ?? searchScopeForQuery(options.query);
  const requestedLevel = options.coverage_level ?? "bounded_partial";
  const paginationComplete = options.pagination_complete ?? false;
  const recordsCapped = options.records_capped ?? false;
  const acquisition: CommerceSearchAcquisition = {
    strategy: options.strategy ?? options.route,
    scope,
    pages_fetched: Math.max(0, Math.floor(options.pages_fetched ?? 1)),
    pagination_complete: paginationComplete,
    records_acquired: Math.max(0, Math.floor(options.records_acquired)),
    records_capped: recordsCapped,
    termination_reason: options.termination_reason ?? (requestedLevel === "unavailable" ? "route_unavailable" : "query_results"),
    ...(options.max_pages !== undefined ? { max_pages: options.max_pages } : {}),
    ...(options.max_products !== undefined ? { max_products: options.max_products } : {}),
    ...(options.max_requests !== undefined ? { max_requests: options.max_requests } : {}),
    ...(options.max_elapsed_ms !== undefined ? { max_elapsed_ms: options.max_elapsed_ms } : {}),
  };
  const provenComplete = requestedLevel === "complete_for_query" && acquisitionProvesCompleteness(acquisition, acquisition.records_acquired);
  const coverageLevel = provenComplete
    ? "complete_for_query"
    : requestedLevel === "unavailable" ? "unavailable" : "bounded_partial";
  const coverageReason = options.coverage_reason ?? (provenComplete
    ? "search_pagination_exhausted"
    : coverageLevel === "unavailable" ? "no_valid_structured_route" : "targeted_search_results_not_catalogue_complete");
  const routeContext: CommerceSearchRouteContext = {
    platform: options.platform,
    route: options.route,
    ...(currencyCode(options.currency) ? { currency: currencyCode(options.currency) } : {}),
    ...(typeof options.locale === "string" && options.locale.trim() ? { locale: options.locale.trim() } : {}),
  };
  return {
    scope,
    coverage_level: coverageLevel,
    coverage_confidence: provenComplete ? "high" : coverageLevel === "bounded_partial" ? "partial" : "unknown",
    coverage_sufficient_for_superlative: provenComplete,
    coverage_reason: coverageReason,
    acquisition,
    route_context: routeContext,
  };
}

export function publicSearchCoverageFields(coverage: CommerceSearchCoverage): JsonObject {
  return {
    scope: coverage.scope,
    coverage_level: coverage.coverage_level,
    coverage_confidence: coverage.coverage_confidence,
    coverage_sufficient_for_superlative: coverage.coverage_sufficient_for_superlative,
    coverage_reason: coverage.coverage_reason,
  };
}
