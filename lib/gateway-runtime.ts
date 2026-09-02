import { BUILD_ID, DEFAULT_RESULT_COUNT, GATEWAY_SCHEMA_VERSION, GATEWAY_VERSION, WEBMCP_CONTRACT_VERSION, type ConnectorId, type JsonObject, type ResponseFormat } from "./gateway-contract";

export const MAX_UPSTREAM_BODY_BYTES = 2_500_000;
export const MAX_RESULT_BYTES = 220_000;
export const CONNECTOR_TIMEOUT_MS = 12_000;

/** The route selected by the gateway; callers never select this value. */
export type ExecutionMode =
  | "cache"
  | "http"
  | "public_http"
  | "official_api"
  | "first_party_api"
  | "mixed";

export type GatewayErrorCode =
  | "INPUT_INVALID"
  | "UNKNOWN_OPERATION"
  | "CONNECTOR_UNAVAILABLE"
  | "NO_VALID_RESULTS"
  | "UNSUPPORTED_SITE"
  | "PLATFORM_DETECTED_ROUTE_UNAVAILABLE"
  | "PROVIDER_RESTRICTED"
  | "PROVIDER_UNSUPPORTED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_BLOCKED"
  | "UPSTREAM_CHANGED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "ROUTE_BLOCKED"
  | "PLATFORM_PROBE_FAILED"
  | "SITE_UNREACHABLE"
  | "RUNTIME_EGRESS_BLOCKED"
  | "INTERNAL_ERROR";

export type AttemptOutcome = "success" | "semantic_failure" | "blocked" | "timeout" | "failed" | "unavailable";

export type ExecutionAttempt = {
  attempted: boolean;
  outcome?: AttemptOutcome;
  error_code?: GatewayErrorCode;
};

export type FallbackProvenance = {
  eligible: boolean;
  attempted: boolean;
  from: "http";
  outcome?: "success" | "failed" | "unavailable" | "skipped";
  reason?: string;
  error_code?: GatewayErrorCode;
};

export type ExecutionTrace = {
  http: ExecutionAttempt;
  semantic_validation: {
    attempted: boolean;
    outcome?: "success" | "failed";
    error_code?: GatewayErrorCode;
  };
  fallback: FallbackProvenance;
  retry: {
    attempted: boolean;
    count: number;
    outcome?: "success" | "failed" | "skipped";
    error_code?: GatewayErrorCode;
  };
};

export function createExecutionTrace(): ExecutionTrace {
  return {
    http: { attempted: false },
    semantic_validation: { attempted: false },
    fallback: { eligible: false, attempted: false, from: "http", outcome: "skipped", reason: "no_alternate_zero_config_route" },
    retry: { attempted: false, count: 0, outcome: "skipped" },
  };
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly mode?: ExecutionMode;
  readonly sourceUrl?: string;
  readonly stage?: "http" | "semantic";
  readonly details?: JsonObject;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      httpStatus?: number;
      mode?: ExecutionMode;
      sourceUrl?: string;
      stage?: "http" | "semantic";
      cause?: unknown;
      details?: JsonObject;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GatewayError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? statusForErrorCode(code);
    this.mode = options.mode;
    this.sourceUrl = options.sourceUrl;
    this.stage = options.stage;
    this.details = options.details;
  }
}

export type ConnectorContext = {
  signal: AbortSignal;
  correlationId: string;
  startedAt: string;
  trace?: ExecutionTrace;
  onProviderObservation?: (observation: ProviderObservation) => void;
  dynamic_site?: {
    domain: string;
    normalized_origin?: string;
    platform: string;
    discovery: "cold" | "warm";
    provider_origin?: "dynamic";
    known_before_request?: boolean;
    recipe_cache?: "cold" | "warm";
    probe_route?: string;
    probe_url?: string;
    probe_data?: unknown;
    currency_context?: {
      context_id?: string;
      origin?: string;
      market_key?: string;
      currency?: string | null;
      currency_verified?: boolean;
      currency_source?: string;
      conflict?: boolean;
    };
    scope_hint?: {
      kind: "store" | "collection" | "search" | "path";
      key: string;
      path?: string;
      requested_url?: string;
      collection_handle?: string;
      query?: string;
    };
  };
};

export type ProviderObservation = {
  provider: ConnectorId;
  upstream_provider?: string;
  tool: string;
  startedAt: string;
  mode?: ExecutionMode;
  outcome: "success" | "zero_results" | "error";
  errorCode?: GatewayErrorCode;
  trace?: ExecutionTrace;
};

export type ConnectorExecution = {
  data: JsonObject;
  sourceUrl: string;
  mode: ExecutionMode;
  engine?: string;
  upstreamProvider?: string;
  outcome?: "SUCCESS" | "ZERO_RESULTS";
  sourceProvider?: string;
  retrievedAt?: string;
  provenance?: JsonObject;
  cache?: {
    hit: boolean;
    age_seconds: number;
    source_mode?: ExecutionMode;
  };
  trace?: ExecutionTrace;
};

export type SiteConnector = {
  provider: ConnectorId;
  execute: (
    tool: string,
    input: JsonObject,
    context: ConnectorContext,
  ) => Promise<ConnectorExecution>;
};

export function statusForErrorCode(code: GatewayErrorCode): number {
  switch (code) {
    case "INPUT_INVALID":
      return 400;
    case "UNKNOWN_OPERATION":
      return 404;
    case "CONNECTOR_UNAVAILABLE":
      return 503;
    case "UNSUPPORTED_SITE":
    case "PLATFORM_DETECTED_ROUTE_UNAVAILABLE":
    case "PROVIDER_UNSUPPORTED":
      return 501;
    case "UPSTREAM_TIMEOUT":
      return 504;
    case "UPSTREAM_BLOCKED":
    case "PROVIDER_RESTRICTED":
    case "ROUTE_BLOCKED":
    case "PLATFORM_PROBE_FAILED":
    case "SITE_UNREACHABLE":
    case "RUNTIME_EGRESS_BLOCKED":
      return 502;
    case "UPSTREAM_CHANGED":
    case "NO_VALID_RESULTS":
      return 502;
    case "NOT_FOUND":
      return 404;
    case "RATE_LIMITED":
      return 429;
    default:
      return 500;
  }
}

export function outcomeForGatewayError(error: GatewayError): AttemptOutcome {
  if (error.code === "UPSTREAM_TIMEOUT") return "timeout";
  if (["UPSTREAM_BLOCKED", "PROVIDER_RESTRICTED", "RATE_LIMITED", "ROUTE_BLOCKED"].includes(error.code)) return "blocked";
  if (error.stage === "semantic" || ["NO_VALID_RESULTS", "UPSTREAM_CHANGED"].includes(error.code)) return "semantic_failure";
  return "failed";
}

export function markHttpAttempt(context: ConnectorContext): void {
  if (context.trace) context.trace.http.attempted = true;
}

export function markHttpSuccess(context: ConnectorContext): void {
  if (!context.trace) return;
  context.trace.http.attempted = true;
  context.trace.http.outcome = "success";
}

export function markHttpFailure(context: ConnectorContext, error: GatewayError, semantic = false): void {
  if (!context.trace) return;
  context.trace.http.attempted = true;
  context.trace.http.outcome = semantic ? "semantic_failure" : outcomeForGatewayError(error);
  context.trace.http.error_code = error.code;
  context.trace.fallback = {
    eligible: false,
    attempted: false,
    from: "http",
    outcome: "skipped",
    reason: "no_alternate_zero_config_route",
    error_code: error.code,
  };
}

export function markSemanticValidation(context: ConnectorContext, outcome: "success" | "failed", errorCode?: GatewayErrorCode): void {
  if (!context.trace) return;
  context.trace.semantic_validation = {
    attempted: true,
    outcome,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
}

export function newCorrelationId(): string {
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `gw_${id.replaceAll("-", "")}`;
}

const ALLOWED_UPSTREAM_HOSTS = new Set([
  "www.ikea.com",
  "sik.search.blue.cdtapps.com",
  "api.ingka.ikea.com",
  "api.salesitem.ingka.com",
  "www.eventbrite.co.uk",
  "eventbrite.co.uk",
  "www.booking.com",
  "www.amazon.co.uk",
  "amazon.co.uk",
  "www.argos.co.uk",
  "argos.co.uk",
  "www.johnlewis.com",
  "johnlewis.com",
  "www.onthemarket.com",
  "onthemarket.com",
  "www.openrent.co.uk",
  "openrent.co.uk",
  "representclo.com",
  "www.representclo.com",
  "rapanuiclothing.com",
  "www.rapanuiclothing.com",
  "pipandnut.com",
  "www.pipandnut.com",
  "hardandware.com",
  "www.hardandware.com",
  "formnutrition.com",
  "www.formnutrition.com",
  "gruum.com",
  "www.gruum.com",
  "decathlon.co.uk",
  "www.decathlon.co.uk",
  "currys.co.uk",
  "www.currys.co.uk",
  "dunelm.com",
  "www.dunelm.com",
  "boards-api.greenhouse.io",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "api.lever.co",
  "jobs.lever.co",
]);

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPrivateOrInternalHostname(value: string): boolean {
  const hostname = normalizedHostname(value);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".lan") || hostname.endsWith(".home") || hostname.endsWith(".nip.io") || hostname.endsWith(".sslip.io") || hostname.endsWith(".xip.io") || hostname === "localtest.me" || hostname === "metadata.google.internal" || hostname === "instance-data") return true;
  if (hostname.includes(":")) {
    return hostname === "::1" || hostname === "::" || hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/i.test(hostname) || hostname.startsWith("::ffff:127.") || hostname.startsWith("::ffff:10.") || hostname.startsWith("::ffff:192.168.") || hostname.startsWith("::ffff:169.254.");
  }
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return !hostname.includes(".");
  const [first, second] = octets.map(Number);
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 192 && second === 0) || (first === 198 && (second === 18 || second === 19 || second === 51)) || (first === 203 && second === 0) || first >= 224;
}

function publicOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new GatewayError("INPUT_INVALID", "site must be a valid public HTTPS domain or URL.");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || isPrivateOrInternalHostname(url.hostname) || !url.hostname.includes(".")) {
    throw new GatewayError("INPUT_INVALID", "site must use a public HTTPS origin.");
  }
  return new URL(url.origin);
}

export type PublicSite = {
  origin: string;
  hostname: string;
  domain: string;
};

export function normalizePublicSite(value: unknown): PublicSite {
  if (typeof value !== "string" || !value.trim() || value.length > 300) {
    throw new GatewayError("INPUT_INVALID", "site must be a public HTTPS domain or URL.");
  }
  const url = publicOrigin(value.trim());
  const hostname = normalizedHostname(url.hostname);
  return { origin: url.origin, hostname, domain: hostname.replace(/^www\./, "") };
}

function samePublicOriginHost(hostname: string, allowedOrigin: string): boolean {
  const host = normalizedHostname(hostname).replace(/^www\./, "");
  const allowed = normalizedHostname(new URL(allowedOrigin).hostname).replace(/^www\./, "");
  return host === allowed;
}

function assertAllowedUpstreamUrl(value: string | URL, allowedOrigin?: string): URL {
  const url = typeof value === "string" ? new URL(value) : new URL(value.toString());
  const hostname = normalizedHostname(url.hostname);
  const allowedHost = ALLOWED_UPSTREAM_HOSTS.has(hostname) || Boolean(allowedOrigin && samePublicOriginHost(hostname, allowedOrigin));
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || !allowedHost || url.username || url.password || isPrivateOrInternalHostname(hostname)) {
    throw new GatewayError("INTERNAL_ERROR", "The connector generated a URL outside its upstream allowlist.");
  }
  return url;
}

function mapFetchFailure(error: unknown, url: URL, timedOut: boolean): GatewayError {
  if (error instanceof GatewayError) return error;
  if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
    return new GatewayError("UPSTREAM_TIMEOUT", "The upstream website did not respond within the execution window.", {
      retryable: true,
      sourceUrl: url.toString(),
      stage: "http",
      cause: error,
    });
  }
  return new GatewayError("UPSTREAM_BLOCKED", "The upstream website could not be reached from the gateway.", {
    retryable: true,
    sourceUrl: url.toString(),
    stage: "http",
    cause: error,
  });
}

type UpstreamRequestOptions = RequestInit & {
  accept?: string;
  upstream5xxCode?: "UPSTREAM_BLOCKED" | "UPSTREAM_TIMEOUT" | "UPSTREAM_CHANGED";
  allowedOrigin?: string;
  maxRedirects?: number;
};

const responseMetadata = new WeakMap<Response, { redirect_chain: string[] }>();

export async function fetchUpstream(
  value: string | URL,
  context: ConnectorContext,
  options: UpstreamRequestOptions = {},
): Promise<Response> {
  const url = assertAllowedUpstreamUrl(value, options.allowedOrigin);
  const { accept, upstream5xxCode, allowedOrigin, maxRedirects = 3, ...requestInit } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONNECTOR_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (context.signal.aborted) controller.abort();
  else context.signal.addEventListener("abort", abort, { once: true });

  const headers = new Headers(options.headers);
  headers.set("accept", accept ?? headers.get("accept") ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
  headers.set("accept-language", headers.get("accept-language") ?? "en-GB,en;q=0.8");
  headers.set("user-agent", headers.get("user-agent") ?? "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.danemcgibbon.workers.dev)");

  try {
    let currentUrl = url;
    let redirects = 0;
    const redirectChain = [currentUrl.toString()];
    let response: Response;
    while (true) {
      response = await fetch(currentUrl, { ...requestInit, redirect: "manual", headers, signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirects >= maxRedirects) {
        throw new GatewayError("UPSTREAM_CHANGED", "The upstream redirect chain exceeded the gateway limit.", { retryable: true, sourceUrl: currentUrl.toString(), stage: "http" });
      }
      currentUrl = assertAllowedUpstreamUrl(new URL(location, currentUrl), allowedOrigin);
      redirects += 1;
      redirectChain.push(currentUrl.toString());
    }
    if (response.status === 429) {
      throw new GatewayError("RATE_LIMITED", "The upstream website rate-limited the gateway request.", {
        retryable: true,
        httpStatus: 429,
        sourceUrl: currentUrl.toString(),
        stage: "http",
        details: { http_status: 429, requested_url: url.toString(), final_url: currentUrl.toString(), redirect_chain: redirectChain, response_classification: "ROUTE_RATE_LIMITED" },
      });
    }
    if (response.status === 401 || response.status === 403 || response.status === 406 || response.status === 409 || response.status === 451) {
      throw new GatewayError("UPSTREAM_BLOCKED", "The upstream website refused the gateway request.", {
        retryable: false,
        httpStatus: 502,
        sourceUrl: currentUrl.toString(),
        stage: "http",
        details: { http_status: response.status, requested_url: url.toString(), final_url: currentUrl.toString(), redirect_chain: redirectChain, response_classification: "ROUTE_BLOCKED" },
      });
    }
    if (response.status === 404) {
      throw new GatewayError("NOT_FOUND", "The requested item was not found on the upstream website.", {
        retryable: false,
        httpStatus: 404,
        sourceUrl: currentUrl.toString(),
        stage: "http",
        details: { http_status: 404, requested_url: url.toString(), final_url: currentUrl.toString(), redirect_chain: redirectChain, response_classification: "ROUTE_NOT_FOUND" },
      });
    }
    if (response.status >= 500) {
      throw new GatewayError(upstream5xxCode ?? "UPSTREAM_TIMEOUT", "The upstream website returned a server error.", {
        retryable: true,
        httpStatus: 502,
        sourceUrl: currentUrl.toString(),
        stage: "http",
        details: { http_status: response.status, requested_url: url.toString(), final_url: currentUrl.toString(), redirect_chain: redirectChain, response_classification: "UPSTREAM_SERVER_ERROR" },
      });
    }
    if (!response.ok) {
      throw new GatewayError("UPSTREAM_CHANGED", `The upstream website returned HTTP ${response.status}.`, {
        retryable: true,
        httpStatus: 502,
        sourceUrl: currentUrl.toString(),
        stage: "http",
        details: { http_status: response.status, requested_url: url.toString(), final_url: currentUrl.toString(), redirect_chain: redirectChain, response_classification: "UPSTREAM_NON_SUCCESS" },
      });
    }
    responseMetadata.set(response, { redirect_chain: redirectChain });
    return response;
  } catch (error) {
    throw mapFetchFailure(error, url, timedOut);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", abort);
  }
}

export async function readUpstreamText(response: Response, sourceUrl: string): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_UPSTREAM_BODY_BYTES) {
    throw new GatewayError("UPSTREAM_CHANGED", "The upstream response exceeded the gateway body limit.", {
      retryable: true,
      sourceUrl,
      stage: "http",
    });
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_UPSTREAM_BODY_BYTES) {
    throw new GatewayError("UPSTREAM_CHANGED", "The upstream response exceeded the gateway body limit.", {
      retryable: true,
      sourceUrl,
      stage: "http",
    });
  }
  return text;
}

export async function fetchText(
  value: string | URL,
  context: ConnectorContext,
  options: UpstreamRequestOptions = {},
): Promise<{ text: string; response: Response; url: string; redirect_chain: string[] }> {
  const url = assertAllowedUpstreamUrl(value, options.allowedOrigin);
  const response = await fetchUpstream(url, context, options);
  return { text: await readUpstreamText(response, url.toString()), response, url: response.url || url.toString(), redirect_chain: responseMetadata.get(response)?.redirect_chain ?? [url.toString()] };
}

export async function fetchJson(
  value: string | URL,
  context: ConnectorContext,
  options: UpstreamRequestOptions = {},
): Promise<{ value: unknown; response: Response; url: string }> {
  const result = await fetchText(value, context, {
    ...options,
    accept: options.accept ?? "application/json,text/plain;q=0.9,*/*;q=0.8",
  });
  try {
    return { ...result, value: JSON.parse(result.text) as unknown };
  } catch (error) {
    throw new GatewayError("UPSTREAM_CHANGED", "The upstream response was not valid JSON.", {
      retryable: true,
      sourceUrl: result.url,
      stage: "http",
      cause: error,
    });
  }
}

export function enforceResultLimit(value: JsonObject): void {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > MAX_RESULT_BYTES) {
    throw new GatewayError("INTERNAL_ERROR", "The connector result exceeded the gateway result limit.");
  }
}

export function responseMeta(requestId: string, startedAt: string, completedAt = new Date().toISOString()): JsonObject {
  return {
    gateway_version: GATEWAY_VERSION,
    build_id: BUILD_ID,
    webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
    schema_version: GATEWAY_SCHEMA_VERSION,
    request_id: requestId,
    now_utc: completedAt,
    latency_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
  };
}

export function gatewaySource(retrievedAt = new Date().toISOString()): JsonObject {
  return {
    provider: "Agent Web Gateway",
    execution_mode: "native_webmcp",
    trust: "gateway_interface",
    retrieved_at: retrievedAt,
    freshness: "live",
  };
}

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

const COMPACT_RESULT_FIELDS = new Set([
  "provider", "product_id", "asin", "item_id", "listing_id", "hotel_id", "event_id", "venue_id", "service_id", "flight_id", "job_id", "source_job_id",
  "title", "name", "company", "company_slug", "platform", "site", "category", "summary", "description_summary", "location", "address", "area",
  "origin", "destination", "departure", "arrival", "departure_date", "arrival_date", "duration", "stops", "event_date", "start_at", "end_at", "venue",
  "price", "regular_price", "currency", "currency_verified", "currency_source", "currency_context_id", "currency_conflict", "condition", "availability", "variant_id", "variant_available", "matched_color", "matched_color_family", "matched_size", "audience", "color", "color_family", "color_families", "color_confidence", "color_source", "category_family", "colors", "details_available", "search_context", "coverage_level", "coverage_reason", "site_scope",
  "rating", "rating_count", "review_count", "canonical_url", "url", "image_url", "delivery_summary", "delivery", "shipping",
  "price_pcm", "effective_price_pcm", "bedrooms", "bathrooms", "property_type", "furnishing", "bills", "bills_surcharge_pcm", "pets_allowed", "whole_property", "whole_property_eligible", "shared_property", "max_occupants", "parse_failures",
  "listed_at", "last_updated_at", "available_from", "published_at", "updated_at", "retrieved_at", "freshness", "remote", "department", "team", "employment_type", "salary", "nights", "guests", "rooms", "timezone",
  "listing_mode", "dwelling_type", "rent", "rent_basis", "occupancy", "couples_allowed", "couples_confidence", "couples_source", "availability_details", "timestamps", "location", "constraint_states", "unknown_constraints", "unverified_candidates",
  "verification", "verification_status", "listing_type", "execution_mode", "actions", "failed_constraints", "search_objective", "objective_requested", "objective_supported", "objective_verified", "coverage_confidence", "coverage_sufficient_for_superlative",
]);

function compactSearchRecord(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(source)) {
    if (!COMPACT_RESULT_FIELDS.has(key)) continue;
    if (typeof item === "string" && item.length > 320) output[key] = item.slice(0, 317) + "...";
    else if (Array.isArray(item) && ["colors", "details_available"].includes(key)) output[key] = item.slice(0, 8);
    else output[key] = item;
  }
  return output;
}

function detailedSearchRecord(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  const output = compactSearchRecord(value);
  if (!record(output)) return output;
  const detailed = output as JsonObject;
  for (const key of ["description", "features", "ranking_reasons", "availability_details", "specifications"]) {
    const item = source[key];
    if (typeof item === "string") detailed[key] = item.slice(0, 800);
    else if (Array.isArray(item)) detailed[key] = item.slice(0, 24);
    else if (item && typeof item === "object" && !Array.isArray(item)) detailed[key] = item;
  }
  if (Array.isArray(source.variants)) {
    detailed.variants = source.variants.slice(0, 12).map((variant) => {
      const item = record(variant);
      if (!item) return variant;
      return Object.fromEntries(Object.entries(item).filter(([key]) => [
        "id", "variant_id", "sku", "title", "price", "regular_price", "currency", "available", "availability", "color", "color_family", "color_families", "color_confidence", "color_source", "size", "option1", "option2", "option3",
      ].includes(key)));
    });
    if (source.variants.length > 12) detailed.variants_truncated = true;
  }
  return detailed;
}

export function responseFormatForInput(input: JsonObject = {}): ResponseFormat {
  if (input.response_format === "detailed" || input.response_format === "diagnostic") return input.response_format;
  return input.include_diagnostics === true ? "diagnostic" : "concise";
}

/**
 * Keep ordinary search responses useful to an unfamiliar agent. The caller can
 * opt into bounded richer fields with detailed or route evidence with
 * diagnostic; include_diagnostics remains a compatible diagnostic alias.
 */
export function compactResponseData(provider: ConnectorId, tool: string, data: JsonObject, input: JsonObject = {}): JsonObject {
  const format = responseFormatForInput(input);
  if (format === "diagnostic") return { ...data, response_format: format };
  const output: JsonObject = { ...data };
  const hasDiagnostics = Object.hasOwn(data, "diagnostics");
  delete output.diagnostics;
  output.response_format = format;
  const requested = typeof input.max_results === "number" ? Math.min(5, Math.max(1, input.max_results)) : DEFAULT_RESULT_COUNT;
  if (Array.isArray(data.exact_matches)) output.exact_matches = data.exact_matches.slice(0, requested).map(compactSearchRecord);
  const recordFormatter = format === "detailed" ? detailedSearchRecord : compactSearchRecord;
  if (Array.isArray(data.closest_matches)) output.closest_matches = data.closest_matches.slice(0, 3).map(recordFormatter);
  if (Array.isArray(data.failed_constraints)) output.failed_constraints = data.failed_constraints.slice(0, 8);
  if (!Array.isArray(data.results)) return output;
  const returned = data.results.slice(0, requested).map(recordFormatter);
  output.results = returned;
  output.returned_result_count = returned.length;
  if (returned.length < data.results.length) output.results_truncated = true;
  if (hasDiagnostics) output.diagnostics_available = true;
  return output;
}

function answerStateFor(data: JsonObject, results: unknown[]): string {
  if (typeof data.answer_state === "string") return data.answer_state;
  const coverage = record(data.coverage) ?? record(data.providers);
  const hasFailure = Boolean(coverage && Object.values(coverage).some((value) => {
    const detail = record(value);
    const status = String(detail?.status ?? "");
    return status === "error" || status.includes("blocked") || status.includes("timeout") || status.includes("unverified");
  }));
  const objective = String(data.search_objective ?? "");
  const coverageIncomplete = data.coverage_level === "bounded_partial"
    || data.coverage_sufficient_for_superlative !== true
      && (objective === "ranked" || objective === "exhaustive_ranked");
  if (coverageIncomplete) return "partial";
  return results.length ? hasFailure ? "partial" : "exact_matches" : hasFailure ? "unverified" : "no_exact_match";
}

function decisionReadyData(provider: ConnectorId, tool: string, data: JsonObject, input: JsonObject = {}): JsonObject {
  if (!tool.includes("search")) return data;
  const results = Array.isArray(data.results) ? data.results : [];
  const exactMatches = Array.isArray(data.exact_matches)
    ? data.exact_matches
    : results.map((value) => {
      const result = record(value);
      return result && (typeof result.provider === "string" || typeof result.product_id === "string" || typeof result.listing_id === "string" || typeof result.job_id === "string")
        ? {
          ...(typeof result.provider === "string" ? { provider: result.provider } : {}),
          ...(typeof result.product_id === "string" ? { product_id: result.product_id } : {}),
          ...(typeof result.listing_id === "string" ? { listing_id: result.listing_id } : {}),
          ...(typeof result.job_id === "string" ? { job_id: result.job_id } : {}),
        }
        : null;
    }).filter(Boolean);
  const state = answerStateFor(data, results);
  const answerReady = typeof data.answer_ready === "boolean" ? data.answer_ready : state !== "unverified";
  const requestedAgentAction = data.agent_action;
  const agentAction = requestedAgentAction === "answer" || requestedAgentAction === "follow_next_action" || requestedAgentAction === "report_partial"
    ? requestedAgentAction
    : answerReady ? state === "partial" || data.coverage_level === "bounded_partial" ? "report_partial" : "answer" : "follow_next_action";
  const retryTool = provider === "commerce" ? "commerce_search_products" : provider === "rentals" ? "rentals_search_properties" : provider === "jobs" ? "jobs_search" : `${provider}_search`;
  const requestedNext = record(data.next_action);
  const nextAction = answerReady
    ? null
    : requestedNext
      ? {
        ...requestedNext,
        ...(requestedNext.arguments ? {} : { arguments: { ...input } }),
        reason: requestedNext.reason ?? "Retry once or report provider failure; do not infer zero results from an unavailable source.",
        agent_action: requestedNext.agent_action ?? "retry_once",
      }
      : {
        tool: retryTool,
        arguments: { ...input },
        reason: "Retry once or report provider failure; do not infer zero results from an unavailable source.",
        agent_action: "retry_once",
      };
  return {
    ...data,
    answer_state: state,
    exact_matches: exactMatches,
    answer_ready: answerReady,
    verification_status: typeof data.verification_status === "string"
      ? data.verification_status
      : results.length ? "server_filtered_ranked" : "unverified",
    next_action: nextAction,
    agent_action: agentAction,
  };
}

function detailAction(provider: string, result: JsonObject, searchContext?: unknown): JsonObject | null {
  const currency = typeof result.currency === "string" ? result.currency : null;
  const locale = "en-GB";
  if (provider === "commerce" && typeof result.provider === "string" && typeof result.product_id === "string") {
    const needsCanonical = !["ikea", "amazon", "ebay", "argos", "johnlewis"].includes(result.provider);
    return { tool: "commerce_get_product", arguments: { provider: result.provider, product_id: result.product_id, ...(needsCanonical && typeof result.canonical_url === "string" ? { canonical_url: result.canonical_url } : {}), ...(typeof result.site === "string" ? { site: result.site } : {}), ...(typeof searchContext === "string" ? { search_context: searchContext } : {}), ...(currency ? { currency } : {}), locale } };
  }
  if (provider === "rentals" && typeof result.provider === "string" && typeof result.listing_id === "string") {
    return {
      tool: "rentals_get_listing",
      arguments: {
        provider: result.provider,
        listing_id: result.listing_id,
        ...(typeof result.canonical_url === "string" ? { canonical_url: result.canonical_url } : {}),
      },
    };
  }
  if (provider === "ikea" && typeof result.product_id === "string") return { tool: "ikea_get_product", arguments: { product_id: result.product_id, currency, locale } };
  if (provider === "amazon" && typeof result.product_id === "string") return { tool: "amazon_get_product", arguments: { product_id: result.product_id, currency, locale } };
  if (provider === "argos" && typeof result.product_id === "string") return { tool: "argos_get_product", arguments: { product_id: result.product_id, currency, locale } };
  if (provider === "johnlewis" && typeof result.product_id === "string") return { tool: "johnlewis_get_product", arguments: { product_id: result.product_id, currency, locale } };
  if (provider === "ebay" && typeof result.item_id === "string") return { tool: "ebay_get_item", arguments: { item_id: result.item_id, currency, locale } };
  if (provider === "jobs" && (result.provider === "greenhouse" || result.provider === "lever") && typeof result.job_id === "string") {
    return {
      tool: "jobs_get_listing",
      arguments: {
        provider: result.provider,
        job_id: result.job_id,
        ...(typeof result.company_slug === "string" ? { company: result.company_slug } : {}),
        ...(typeof result.canonical_url === "string" ? { canonical_url: result.canonical_url } : {}),
      },
    };
  }
  return null;
}

function addDetailActions(provider: ConnectorId, tool: string, data: JsonObject): JsonObject {
  if (!tool.includes("search")) return data;
  const rows = Array.isArray(data.results) ? data.results : [];
  if (!rows.length) return data;
  const results = rows.map((value) => {
    const result = record(value);
    if (!result) return value;
    const action = detailAction(provider, result, data.search_context);
    return action ? { ...result, actions: { ...(record(result.actions) ?? {}), detail: action } } : result;
  });
  return { ...data, results };
}

export function coverageStatusForErrorCode(code: unknown): string {
  if (code === "UPSTREAM_TIMEOUT") return "upstream_timeout";
  if (code === "UPSTREAM_BLOCKED" || code === "PROVIDER_RESTRICTED" || code === "ROUTE_BLOCKED" || code === "SITE_UNREACHABLE" || code === "RUNTIME_EGRESS_BLOCKED") return "upstream_blocked";
  if (code === "RATE_LIMITED") return "rate_limited";
  if (code === "PROVIDER_UNSUPPORTED" || code === "CONNECTOR_UNAVAILABLE") return "offline";
  if (code === "UNSUPPORTED_SITE" || code === "PLATFORM_DETECTED_ROUTE_UNAVAILABLE" || code === "PLATFORM_PROBE_FAILED") return "unsupported";
  if (code === "NO_VALID_RESULTS") return "no_valid_results";
  if (code === "UPSTREAM_CHANGED") return "parser_failed";
  if (code === "NOT_FOUND") return "not_found";
  if (code === "INPUT_INVALID") return "input_invalid";
  return "provider_error";
}

function coverageForExecution(provider: ConnectorId, execution: ConnectorExecution): JsonObject {
  // Unified connectors expose provider-level observations under `providers`,
  // while some older single-provider connectors expose a scalar coverage
  // summary. Prefer the provider map so the outer envelope remains stable
  // (`coverage.<provider>.status`) for every multi-provider workflow.
  const providerDeclared = record(execution.data.providers);
  const coverageDeclared = record(execution.data.coverage);
  const declared = providerDeclared ?? (coverageDeclared && Object.values(coverageDeclared).some((value) => Boolean(record(value)?.status)) ? coverageDeclared : null);
  if (declared) {
    const normalized: JsonObject = {};
    for (const [name, value] of Object.entries(declared)) {
      const detail = record(value);
      if (!detail) {
        normalized[name] = value;
        continue;
      }
      let status = detail.status;
      if (detail.completeness_status === "partial" && status === "success") status = "partial";
      if (status === "error") status = coverageStatusForErrorCode(detail.code);
      normalized[name] = { ...detail, status };
    }
    return normalized;
  }
  if (coverageDeclared) {
    return {
      [provider]: {
        status: execution.outcome === "ZERO_RESULTS" ? "zero_results" : "success",
        ...coverageDeclared,
      },
    };
  }
  const results = Array.isArray(execution.data.results) ? execution.data.results.length : execution.data.product || execution.data.listing ? 1 : 0;
  return {
    [provider]: {
      status: execution.outcome === "ZERO_RESULTS" ? "zero_results" : "success",
      results,
    },
  };
}

export function successEnvelope(
  provider: ConnectorId,
  tool: string,
  correlationId: string,
  startedAt: string,
  execution: ConnectorExecution,
  input: JsonObject = {},
): JsonObject {
  const completedAt = new Date().toISOString();
  const data = decisionReadyData(provider, tool, addDetailActions(provider, tool, compactResponseData(provider, tool, execution.data, input)), input);
  const answerReady = tool.includes("search") ? data.answer_ready === true : true;
  const nextAction = tool.includes("search") ? data.next_action ?? null : null;
  const requestedAgentAction = data.agent_action;
  const agentAction = requestedAgentAction === "answer" || requestedAgentAction === "follow_next_action" || requestedAgentAction === "clarify" || requestedAgentAction === "report_partial"
    ? requestedAgentAction
    : answerReady ? "answer" : nextAction ? "follow_next_action" : "report_partial";
  const results = Array.isArray(data.results) ? data.results : [];
  const result = record(data.result) ?? (record(results[0]) ?? null);
  const alternatives = Array.isArray(data.alternatives)
    ? data.alternatives.slice(0, 3)
    : Array.isArray(data.closest_matches) ? data.closest_matches.slice(0, 3) : [];
  const summary = typeof data.summary === "string"
    ? data.summary
    : results.length ? `Returned ${results.length} matching result${results.length === 1 ? "" : "s"}.`
      : Object.hasOwn(data, "results") ? "No exact matches were returned." : null;
  const envelope: JsonObject = {
    gateway_version: GATEWAY_VERSION,
    build_id: BUILD_ID,
    webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
    status: "success",
    outcome: execution.outcome ?? "SUCCESS",
    provider,
    tool,
    correlation_id: correlationId,
    meta: responseMeta(correlationId, startedAt, completedAt),
    answer_state: data.answer_state ?? null,
    agent_action: agentAction,
    answer_ready: answerReady,
    summary,
    result,
    alternatives,
    coverage: coverageForExecution(provider, execution),
    ...(typeof data.search_objective === "string" ? { search_objective: data.search_objective } : {}),
    ...(typeof data.search_context === "string" ? { search_context: data.search_context } : {}),
    ...(typeof data.coverage_level === "string" ? { coverage_level: data.coverage_level } : {}),
    ...(typeof data.coverage_confidence === "string" ? { coverage_confidence: data.coverage_confidence } : {}),
    ...(typeof data.coverage_sufficient_for_superlative === "boolean" ? { coverage_sufficient_for_superlative: data.coverage_sufficient_for_superlative } : {}),
    next_action: nextAction,
    execution: {
      mode: execution.mode,
      ...(execution.engine ? { engine: execution.engine } : {}),
      ...(execution.upstreamProvider ? { upstream_provider: execution.upstreamProvider } : {}),
      started_at: startedAt,
      completed_at: completedAt,
      ...(execution.cache ? { cache: execution.cache } : {}),
      ...(execution.provenance ? { provenance: execution.provenance } : {}),
      ...(execution.trace ?? {}),
    },
    source: {
      provider: execution.sourceProvider ?? (
        provider === "ikea" ? "IKEA UK"
          : provider === "eventbrite" ? "Eventbrite UK"
            : provider === "booking" ? "Booking.com"
              : provider === "amazon" ? "Amazon UK"
                  : provider === "ebay" ? "eBay UK"
                  : provider === "argos" ? "Argos UK"
                    : provider === "johnlewis" ? "John Lewis UK"
              : provider === "rail" ? "UK rail"
                  : provider === "travel" ? "Travel"
                    : provider === "commerce" ? "Commerce (IKEA, Amazon, Argos, John Lewis)"
                  : provider === "rentals" ? "UK rentals (OnTheMarket, OpenRent)"
                        : provider === "jobs" ? "Public jobs (Greenhouse, Lever)"
                        : "Agent Web Gateway"
      ),
      ...(execution.upstreamProvider ? { upstream_provider: execution.upstreamProvider } : {}),
      ...(execution.engine ? { compatibility_engine: execution.engine } : {}),
      url: execution.sourceUrl,
      execution_mode: execution.mode,
      retrieved_at: execution.retrievedAt ?? completedAt,
      cache_age_seconds: execution.cache?.age_seconds ?? 0,
      freshness: execution.cache?.hit ? "cached" : "live",
      trust: "external_untrusted",
      ...(execution.provenance ? { provenance: execution.provenance } : {}),
    },
    data,
  };
  enforceResultLimit(envelope);
  return envelope;
}
