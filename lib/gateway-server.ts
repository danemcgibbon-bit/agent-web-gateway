import {
  AGENT_QUICKSTART,
  BUILD_ID,
  CAPABILITY_REGISTRY,
  CONNECTORS,
  CORE_WEBMCP_TOOL_NAMES,
  DEFAULT_RESULT_COUNT,
  GATEWAY_VERSION,
  INTERNAL_OPERATION_COUNT,
  getToolDefinition,
  isConnectorId,
  providerCapability,
  PREFERRED_SEMANTIC_TOOL_NAMES,
  TOOL_DEFINITIONS,
  WEBMCP_CONTRACT_VERSION,
  WEBMCP_DISCOVERY_LAYERS,
  toolSurface,
  toolSurfaceCounts,
  toolsForSurface,
  webmcpRegistryInvariant,
  type CapabilityId,
  type ConnectorId,
  type JsonObject,
  type ToolDefinition,
} from "./gateway-contract";
import { planGatewayTask, taskResultSummary, type GatewayTaskRoute } from "./gateway-task";
import { COMPATIBILITY_PROVIDERS, COMPATIBILITY_PROVIDER_IDS } from "./compatibility-catalog";
import { amazonConnector } from "../connectors/amazon";
import { argosConnector } from "../connectors/argos";
import { bookingConnector } from "../connectors/booking";
import { commerceConnector } from "../connectors/commerce";
import { ebayConnector } from "../connectors/ebay";
import { eventbriteConnector } from "../connectors/eventbrite";
import { ikeaConnector } from "../connectors/ikea";
import { johnLewisConnector } from "../connectors/johnlewis";
import { jobsConnector, JOB_BOARD_CATALOG } from "../connectors/jobs";
import { railConnector } from "../connectors/rail";
import { rentalsConnector } from "../connectors/rentals";
import { travelConnector } from "../connectors/travel";
import {
  createExecutionTrace,
  coverageStatusForErrorCode,
  enforceResultLimit,
  GatewayError,
  markHttpFailure,
  markHttpSuccess,
  markSemanticValidation,
  newCorrelationId,
  presentationForData,
  gatewaySource,
  responseMeta,
  successEnvelope,
  type ConnectorExecution,
  type ConnectorContext,
  type ExecutionMode,
  type ExecutionTrace,
  type GatewayErrorCode,
  type ProviderObservation,
} from "./gateway-runtime";
import { validateDateRange, validateToolInput, validateUkPostcode } from "./gateway-validation";
import { validateConnectorExecution } from "./semantic-validation";
import { listRecipes } from "./embedded-state";
import { benchmarkSummary } from "./extraction-benchmark";
import { compatibilityBenchmarkSummary } from "./compatibility-benchmark";
import { getStoreSnapshot, snapshotSummary } from "./compatibility";

type HealthStatus = "online" | "degraded" | "blocked" | "offline" | "unknown";

type HealthRecord = {
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: GatewayErrorCode | null;
  last_execution_mode: ExecutionMode | null;
  last_successful_check: string | null;
  last_error: { code: GatewayErrorCode; at: string } | null;
};

type ExecutionMetric = {
  provider: ConnectorId;
  upstream_provider?: string;
  tool: string;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  mode?: ExecutionMode;
  http_attempted: boolean;
  http_outcome?: string;
  semantic_validation_outcome?: string;
  retry_attempted: boolean;
  retry_count: number;
  retry_outcome?: string;
  outcome: "success" | "zero_results" | "error";
  error_code?: GatewayErrorCode;
};

type CacheEntry = {
  data: JsonObject;
  sourceUrl: string;
  sourceProvider?: string;
  engine?: string;
  upstreamProvider?: string;
  mode: ExecutionMode;
  outcome?: "SUCCESS" | "ZERO_RESULTS";
  retrievedAt: string;
  provenance?: JsonObject;
  storedAt: number;
};

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

const connectors: Record<ConnectorId, { provider: ConnectorId; execute: SiteConnectorExecute }> = {
  ikea: ikeaConnector,
  eventbrite: eventbriteConnector,
  booking: bookingConnector,
  amazon: amazonConnector,
  ebay: ebayConnector,
  argos: argosConnector,
  johnlewis: johnLewisConnector,
  rail: railConnector,
  travel: travelConnector,
  commerce: commerceConnector,
  rentals: rentalsConnector,
  jobs: jobsConnector,
};

type SiteConnectorExecute = (
  tool: string,
  input: JsonObject,
  context: ConnectorContext,
) => Promise<ConnectorExecution>;

const health = new Map<string, HealthRecord>();
const toolHealth = new Map<string, HealthRecord>();
const executionMetrics: ExecutionMetric[] = [];
const cacheEntries = new Map<string, CacheEntry>();
const MAX_RETAINED_METRICS = 200;
const MAX_CACHE_ENTRIES = 100;

function emptyHealthRecord(): HealthRecord {
  return {
    last_success_at: null,
    last_failure_at: null,
    last_error_code: null,
    last_execution_mode: null,
    last_successful_check: null,
    last_error: null,
  };
}

function healthFor(provider: string): HealthRecord {
  const current = health.get(provider);
  if (current) return current;
  const created = emptyHealthRecord();
  health.set(provider, created);
  return created;
}

function healthForTool(provider: string, tool: string): HealthRecord {
  const key = `${provider}.${tool}`;
  const current = toolHealth.get(key);
  if (current) return current;
  const created = emptyHealthRecord();
  toolHealth.set(key, created);
  return created;
}

export function recordRuntimeHealth(
  provider: string,
  result: "success" | "error",
  errorCode?: GatewayErrorCode,
  tool?: string,
  mode?: ExecutionMode,
): void {
  const entries = [healthFor(provider)];
  if (tool) entries.push(healthForTool(provider, tool));
  const at = new Date().toISOString();
  for (const entry of entries) {
    entry.last_execution_mode = mode ?? "http";
    if (result === "success") {
      entry.last_success_at = at;
      entry.last_successful_check = at;
    } else if (errorCode) {
      entry.last_failure_at = at;
      entry.last_error_code = errorCode;
      entry.last_error = { code: errorCode, at };
    }
  }
}

function recordProviderObservation(observation: ProviderObservation): void {
  const result = observation.outcome === "error" ? "error" : "success";
  recordRuntimeHealth(observation.provider, result, observation.errorCode, observation.tool, observation.mode);
  if (observation.upstream_provider && observation.upstream_provider !== observation.provider) {
    recordRuntimeHealth(observation.upstream_provider, result, observation.errorCode, observation.tool, observation.mode);
  }
  recordExecutionMetric(
    observation.provider,
    observation.tool,
    observation.startedAt,
    observation.trace ?? createExecutionTrace(),
    observation.errorCode,
    observation.mode,
    observation.outcome,
    observation.upstream_provider,
  );
}

function healthStatus(entry: HealthRecord): HealthStatus {
  if (!entry.last_success_at && !entry.last_failure_at) return "unknown";
  const successAt = entry.last_success_at ? Date.parse(entry.last_success_at) : -1;
  const failureAt = entry.last_failure_at ? Date.parse(entry.last_failure_at) : -1;
  if (successAt >= failureAt) return "online";
  if (["UPSTREAM_BLOCKED", "PROVIDER_RESTRICTED", "RATE_LIMITED"].includes(entry.last_error_code ?? "")) return "blocked";
  if (["CONNECTOR_UNAVAILABLE", "PROVIDER_UNSUPPORTED"].includes(entry.last_error_code ?? "")) return "offline";
  return "degraded";
}

function providerHealthStatus(provider: ConnectorId): HealthStatus {
  const tools = CONNECTORS.find((item) => item.id === provider)?.tools ?? [];
  const statuses = tools.map((tool) => baseCapability(provider, tool).status);
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("online")) return "online";
  if (statuses.includes("degraded") || statuses.includes("partial")) return "degraded";
  if (statuses.length > 0 && statuses.every((status) => status === "unknown")) return "unknown";
  if (statuses.length > 0 && statuses.every((status) => status === "offline" || status === "unknown")) return "offline";
  return "degraded";
}

function healthFields(entry: HealthRecord): JsonObject {
  return {
    last_success_at: entry.last_success_at,
    last_failure_at: entry.last_failure_at,
    last_error_code: entry.last_error_code,
    last_execution_mode: entry.last_execution_mode,
    last_successful_check: entry.last_successful_check,
    last_error: entry.last_error,
  };
}

function baseCapability(provider: ConnectorId, tool: string): { modes: string[]; status: string; reason?: string; completeness?: JsonObject } {
  const entry = healthForTool(provider, tool);
  const observed = healthStatus(entry);
  const declared = providerCapability(provider, tool);
  if (!declared) return { modes: [], status: "offline", reason: "No declared zero-setup route is available." };
  return {
    modes: declared.execution_modes,
    status: observed === "unknown" ? declared.status : observed,
    reason: declared.reason,
    ...(declared.completeness ? { completeness: declared.completeness } : {}),
  };
}

export function connectorHealth(): JsonObject[] {
  return CONNECTORS.map(({ id: provider, tools }) => {
    const toolHealthOutput = Object.fromEntries(tools.map((tool) => {
      const entry = healthForTool(provider, tool);
      const capability = baseCapability(provider, tool);
      return [tool, {
        status: capability.status,
        execution_modes: capability.modes,
        available_execution_modes: capability.modes,
        ...(capability.reason ? { reason: capability.reason } : {}),
        ...(capability.completeness ? { completeness: capability.completeness } : {}),
        ...healthFields(entry),
      }];
    }));
    return {
      id: provider,
      contract_status: "registered",
      health_status: providerHealthStatus(provider),
      execution_modes: [...new Set(tools.flatMap((tool) => baseCapability(provider, tool).modes))],
      ...healthFields(healthFor(provider)),
      tools: toolHealthOutput,
    };
  });
}

function aggregateCapabilityStatus(statuses: string[]): string {
  if (statuses.includes("online")) return "online";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.length > 0 && statuses.every((status) => status === "offline")) return "offline";
  return "unknown";
}

function planningStatus(provider: string): string {
  const declared = providerCapability(provider);
  if (!declared) return "offline";
  if (!isConnectorId(provider)) {
    const observed = healthStatus(healthFor(provider));
    return observed === "unknown" ? declared.status : observed;
  }
  const tools = CONNECTORS.find((item) => item.id === provider)?.tools ?? [];
  return aggregateCapabilityStatus(tools.map((tool) => baseCapability(provider, tool).status));
}

function planningProvider(provider: string, group: CapabilityId): JsonObject {
  const declared = providerCapability(provider);
  const status = planningStatus(provider);
  if (!declared) return { status: "offline", execution_modes: [] };
  const output: JsonObject = {
    status,
    execution_modes: declared.execution_modes,
    reason: declared.reason,
  };
  if (declared.engine) output.compatibility_engine = declared.engine;
  if (declared.domain) output.domain = declared.domain;
  if (declared.categories) output.categories = declared.categories;
  if (declared.keywords) output.keywords = declared.keywords;
  if (declared.completeness) output.completeness = declared.completeness;
  if (declared.support_maturity) output.support_maturity = declared.support_maturity;
  if (group === "commerce" && provider !== "commerce") {
    output.search = status;
    output.detail = status;
  }
  if (group === "rentals" && provider !== "rentals") {
    output.search = status;
    output.detail = status;
  }
  if (group === "jobs") {
    output.search = status;
    output.detail = status;
  }
  return output;
}

function capabilityGroup(id: CapabilityId, includeAllProviderDetails = true): JsonObject {
  const definition = CAPABILITY_REGISTRY[id];
  const providers = Object.fromEntries(definition.providers.map((provider) => [provider, planningStatus(provider)]));
  const details = Object.fromEntries(definition.providers.map((provider) => [provider, planningProvider(provider, id)]));
  const planningDetails = Object.fromEntries(Object.entries(details).filter(([provider]) => providers[provider] !== "online"));
  const output: JsonObject = {
    status: aggregateCapabilityStatus(Object.values(providers)),
    recommended_tool: definition.recommended_tools[0],
    recommended_tools: definition.recommended_tools,
    tools: definition.recommended_tools,
    description: definition.description,
    providers,
    provider_details: includeAllProviderDetails ? details : planningDetails,
  };
  if (definition.dynamic_site_targeting) {
    output.dynamic_site_targeting = true;
    output.dynamic_platforms = definition.dynamic_platforms ?? [];
    output.provider_list_role = "tested_examples_and_health_history; not execution eligibility";
  }
  if (id === "commerce") {
    output.platform_families = Object.fromEntries([...new Set(COMPATIBILITY_PROVIDERS.map((provider) => provider.engine))].map((engine) => {
      const members = COMPATIBILITY_PROVIDERS.filter((provider) => provider.engine === engine);
      const memberStatuses = members.map((provider) => planningStatus(provider.id));
      const family: JsonObject = {
        status: aggregateCapabilityStatus(memberStatuses),
        dynamic_targeting: ["shopify", "woocommerce"].includes(engine),
        stores_working: members.filter((provider) => planningStatus(provider.id) === "online").length,
        search: aggregateCapabilityStatus(members.map((provider) => healthStatus(healthForTool(provider.id, "search_products")))),
        detail: aggregateCapabilityStatus(members.map((provider) => healthStatus(healthForTool(provider.id, "get_product")))),
        recommended_tool: "commerce_search_products",
        tested_example_count: members.length,
      };
      if (includeAllProviderDetails) {
        family.tested_examples = members.map((provider) => ({ id: provider.id, name: provider.name, domain: provider.domain }));
      }
      return [engine, family];
    }));
  }
  if (id === "jobs") {
    output.platform_families = Object.fromEntries((["greenhouse", "lever"] as const).map((platform) => {
      const boards = JOB_BOARD_CATALOG.filter((board) => board.platform === platform);
      return [platform, {
        status: planningStatus(platform),
        companies_available: boards.length,
        search: healthStatus(healthForTool(platform, "search")),
        detail: healthStatus(healthForTool(platform, "get_listing")),
        recommended_tool: "jobs_search",
      }];
    }));
  }
  return output;
}

function capabilityGroups(value: unknown): CapabilityId[] {
  if (value === undefined || value === null || value === "all") return ["commerce", "rentals", "jobs"];
  return value === "commerce" || value === "rentals" || value === "jobs" ? [value] : [];
}

function recordExecutionMetric(
  provider: ConnectorId,
  tool: string,
  startedAt: string,
  trace: ExecutionTrace,
  errorCode?: GatewayErrorCode,
  mode?: ExecutionMode,
  outcome: "success" | "zero_results" | "error" = errorCode ? "error" : "success",
  upstreamProvider?: string,
): void {
  const completedAt = new Date().toISOString();
  const metric: ExecutionMetric = {
    provider,
    ...(upstreamProvider ? { upstream_provider: upstreamProvider } : {}),
    tool,
    started_at: startedAt,
    completed_at: completedAt,
    latency_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    ...(mode ? { mode } : {}),
    http_attempted: trace.http.attempted,
    http_outcome: trace.http.outcome,
    semantic_validation_outcome: trace.semantic_validation.outcome,
    retry_attempted: trace.retry.attempted,
    retry_count: trace.retry.count,
    retry_outcome: trace.retry.outcome,
    outcome,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
  executionMetrics.push(metric);
  if (executionMetrics.length > MAX_RETAINED_METRICS) executionMetrics.shift();
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

function rollingProviderMetric(provider: string, tool?: string): JsonObject {
  const rows = executionMetrics.filter((metric) => (metric.provider === provider || metric.upstream_provider === provider) && (!tool || metric.tool === tool));
  const successes = rows.filter((metric) => metric.outcome !== "error");
  const failures = rows.filter((metric) => metric.outcome === "error");
  const lastSuccess = successes.at(-1);
  const lastFailure = failures.at(-1);
  return {
    attempted: rows.length,
    success_count: successes.length,
    failure_count: failures.length,
    success_rate: rows.length ? Math.round((successes.length / rows.length) * 1000) / 1000 : null,
    median_latency_ms: median(rows.map((metric) => metric.latency_ms)),
    last_success: lastSuccess?.completed_at ?? null,
    last_failure: lastFailure?.completed_at ?? null,
    last_error: lastFailure?.error_code ?? null,
  };
}

function amazonMetrics(): JsonObject {
  const amazonRows = executionMetrics.filter((metric) => metric.provider === "amazon");
  const httpRows = amazonRows.filter((metric) => metric.http_attempted);
  const routeRate = (rows: ExecutionMetric[], predicate: (metric: ExecutionMetric) => boolean): number | null => {
    if (!rows.length) return null;
    return Math.round((rows.filter(predicate).length / rows.length) * 1000) / 1000;
  };
  const blockedCodes = new Set<GatewayErrorCode>(["UPSTREAM_BLOCKED", "PROVIDER_RESTRICTED", "RATE_LIMITED"]);
  return {
    attempted: amazonRows.length,
    http_attempted: httpRows.length,
    http_success_rate: routeRate(httpRows, (metric) => metric.outcome !== "error"),
    valid_search_rate: routeRate(amazonRows.filter((metric) => metric.tool === "search_products"), (metric) => metric.outcome !== "error" && metric.semantic_validation_outcome === "success"),
    valid_detail_rate: routeRate(amazonRows.filter((metric) => metric.tool === "get_product"), (metric) => metric.outcome !== "error" && metric.semantic_validation_outcome === "success"),
    block_rate: routeRate(amazonRows, (metric) => Boolean(metric.error_code && blockedCodes.has(metric.error_code))),
    timeout_rate: routeRate(amazonRows, (metric) => metric.error_code === "UPSTREAM_TIMEOUT"),
  };
}

function verticalCoverage(
  providers: string[],
  searchTools: string[],
  detailTools: string[],
): JsonObject {
  const providerSet = new Set(providers);
  const rows = executionMetrics.filter((metric) => providerSet.has(metric.provider) || (metric.upstream_provider ? providerSet.has(metric.upstream_provider) : false));
  const observedProvider = (metric: ExecutionMetric): string => metric.upstream_provider ?? metric.provider;
  const attempted = new Set(rows.map(observedProvider));
  const searchRows = rows.filter((metric) => searchTools.includes(metric.tool));
  const detailRows = rows.filter((metric) => detailTools.includes(metric.tool));
  const successfulSearchProviders = new Set(searchRows.filter((metric) => metric.outcome !== "error").map(observedProvider));
  const successfulDetailProviders = new Set(detailRows.filter((metric) => metric.outcome !== "error").map(observedProvider));
  const searchCoverage = successfulSearchProviders.size === 0
    ? "none"
    : successfulSearchProviders.size === providers.length
      ? "full"
      : "partial";
  const providerMetrics: JsonObject = {};
  for (const provider of providers) providerMetrics[provider] = rollingProviderMetric(provider);
  return {
    providers_attempted: attempted.size,
    providers_operational: providers.filter((provider) => {
      if (CONNECTORS.some((item) => item.id === provider)) return providerHealthStatus(provider as ConnectorId) === "online";
      const latest = rows.filter((metric) => observedProvider(metric) === provider).at(-1);
      return latest ? latest.outcome !== "error" : false;
    }).length,
    search_coverage: searchCoverage,
    detail_coverage: successfulDetailProviders.size,
    provider_metrics: providerMetrics,
  };
}

function compatibilitySummary(): JsonObject {
  const benchmark = benchmarkSummary();
  const byProvider = (benchmark.by_provider && typeof benchmark.by_provider === "object") ? benchmark.by_provider as JsonObject : {};
  const numeric = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const familyBenchmark = (engine: string, providerIds: string[]): JsonObject => {
    const samples = providerIds
      .map((provider) => byProvider[provider])
      .filter((sample): sample is JsonObject => Boolean(sample && typeof sample === "object" && !Array.isArray(sample)));
    const tested = samples.filter((sample) => numeric(sample.samples) > 0).length;
    const searchSamples = samples.reduce((sum, sample) => sum + numeric(sample.search_samples), 0);
    const searchSuccesses = samples.reduce((sum, sample) => sum + numeric(sample.search_successful_samples), 0);
    const detailSamples = samples.reduce((sum, sample) => sum + numeric(sample.detail_samples), 0);
    const detailSuccesses = samples.reduce((sum, sample) => sum + numeric(sample.detail_successful_samples), 0);
    const chainSamples = samples.reduce((sum, sample) => sum + numeric(sample.id_chain_samples), 0);
    const chainSuccesses = samples.reduce((sum, sample) => sum + numeric(sample.id_chain_verified), 0);
    const candidateCount = samples.reduce((sum, sample) => sum + numeric(sample.candidate_count), 0);
    const falseSuccesses = samples.reduce((sum, sample) => sum + numeric(sample.false_success_count), 0);
    const prices = samples.map((sample) => sample.price_completeness).filter((value): value is number => typeof value === "number");
    const priceCompleteness = prices.length ? Math.round((prices.reduce((sum, value) => sum + value, 0) / prices.length) * 1000) / 1000 : null;
    const searchRate = searchSamples ? Math.round((searchSuccesses / searchSamples) * 1000) / 1000 : null;
    const detailRate = detailSamples ? Math.round((detailSuccesses / detailSamples) * 1000) / 1000 : null;
    const chainRate = chainSamples ? Math.round((chainSuccesses / chainSamples) * 1000) / 1000 : null;
    const falseRate = candidateCount ? Math.round((falseSuccesses / candidateCount) * 1000) / 1000 : 0;
    const robust = tested >= 5
      && (searchRate ?? 0) >= 0.8
      && (detailRate ?? 0) >= 0.8
      && (priceCompleteness ?? 0) >= 0.8
      && falseRate === 0
      && (chainRate === null || chainRate === 1);
    const maturity = robust ? "verified_platform_family" : tested ? "experimental" : "detected";
    return {
      providers: providerIds,
      catalog_role: "tested_examples_and_health_history; not execution eligibility",
      dynamic_targeting: ["shopify", "woocommerce"].includes(engine),
      tested_examples: COMPATIBILITY_PROVIDERS
        .filter((provider) => providerIds.includes(provider.id))
        .map((provider) => ({ id: provider.id, name: provider.name, domain: provider.domain })),
      status: aggregateCapabilityStatus(providerIds.map((provider) => planningStatus(provider))),
      support_maturity: maturity,
      tested_stores: tested,
      stores_working: providerIds.filter((provider) => planningStatus(provider) === "online").length,
      search_success_rate: searchRate,
      detail_success_rate: detailRate,
      price_completeness: priceCompleteness,
      id_chain_success_rate: chainRate,
      false_success_rate: falseRate,
      site_specific_parser_overrides: 0,
      engine,
      recommended_tool: "commerce_search_products",
      shared_modules: ["compatibility.ts", "embedded-state.ts", "semantic-validation.ts"],
    };
  };
  const sites = Object.fromEntries(COMPATIBILITY_PROVIDERS.map((provider) => {
    const sample = byProvider[provider.id] && typeof byProvider[provider.id] === "object" ? byProvider[provider.id] as JsonObject : {};
    const searchStatus = healthStatus(healthForTool(provider.id, "search_products"));
    const detailStatus = healthStatus(healthForTool(provider.id, "get_product"));
    return [provider.id, {
      name: provider.name,
      domain: provider.domain,
      engine: provider.engine,
      example_type: "tested_example",
      dynamic_targeting: ["shopify", "woocommerce"].includes(provider.engine),
      status: planningStatus(provider.id),
      capabilities: {
        search: searchStatus,
        detail: detailStatus,
      },
      categories: provider.categories,
      ...(provider.keywords ? { keywords: provider.keywords } : {}),
      support_maturity: sample.samples ? "experimental" : "detected",
      search: sample.successful_samples ? "observed" : "unobserved",
      ...(sample.success_rate !== undefined ? { benchmark_success_rate: sample.success_rate } : {}),
      ...(sample.last_sample_at ? { last_sample_at: sample.last_sample_at } : {}),
    }];
  }));
  const engines = Object.fromEntries([...new Set(COMPATIBILITY_PROVIDERS.map((provider) => provider.engine))].map((engine) => {
    const providers = COMPATIBILITY_PROVIDERS.filter((provider) => provider.engine === engine).map((provider) => provider.id);
    const searchStatuses = providers.map((provider) => healthStatus(healthForTool(provider, "search_products")));
    const detailStatuses = providers.map((provider) => healthStatus(healthForTool(provider, "get_product")));
    return [engine, {
      ...familyBenchmark(engine, providers),
      search: aggregateCapabilityStatus(searchStatuses),
      detail: aggregateCapabilityStatus(detailStatuses),
    }];
  }));
  return {
    route_order: ["shopify", "woocommerce", "nextjs", "algolia", "structured_ssr", "known_recipe"],
    engines,
    sites,
    platforms: Object.fromEntries(["shopify", "woocommerce"].map((engine) => {
      const examples = COMPATIBILITY_PROVIDERS.filter((provider) => provider.engine === engine);
      return [engine, {
        status: aggregateCapabilityStatus(examples.map((provider) => planningStatus(provider.id))),
        dynamic_targeting: true,
        tested_examples: examples.map((provider) => ({ id: provider.id, name: provider.name, domain: provider.domain })),
      }];
    })),
    bounded: {
      max_catalog_examples: COMPATIBILITY_PROVIDERS.length,
      public_https_only: true,
      read_only: true,
      dynamic_site_targeting: true,
      registry_role: "benchmarking_health_history_and_route_optimization; not execution eligibility",
    },
  };
}

function metricsSummary(): JsonObject {
  const byMode: Record<string, number> = { http: 0, cache: 0, public_http: 0, first_party_api: 0, official_api: 0, mixed: 0 };
  const byOutcome = { success: 0, error: 0 };
  const retries = executionMetrics.filter((metric) => metric.retry_attempted);
  for (const metric of executionMetrics) {
    if (metric.mode) byMode[metric.mode] = (byMode[metric.mode] ?? 0) + 1;
    else if (metric.http_attempted) byMode.http += 1;
    if (metric.outcome === "error") byOutcome.error += 1;
    else byOutcome.success += 1;
  }
  const last = executionMetrics.at(-1);
  const summary: JsonObject = {
    retained: executionMetrics.length,
    last_execution_at: last?.completed_at ?? null,
    by_mode: byMode,
    outcomes: byOutcome,
    retries: {
      attempted: retries.length,
      successful: retries.filter((metric) => metric.retry_outcome === "success").length,
      failed: retries.filter((metric) => metric.retry_outcome === "failed").length,
    },
    amazon: amazonMetrics(),
    extraction_benchmark: benchmarkSummary(),
    compatibility: compatibilitySummary(),
    recipes: listRecipes().map((recipe) => ({
      domain: recipe.domain,
      capability: recipe.capability,
      execution_mode: recipe.execution_mode,
      ...(recipe.engine ? { engine: recipe.engine } : {}),
      parser: recipe.parser,
      validator: recipe.validator,
      last_verified_at: recipe.last_verified_at,
      ...(typeof recipe.success_rate === "number" ? { success_rate: recipe.success_rate } : {}),
      ...(recipe.shared_code ? { shared_code: recipe.shared_code } : {}),
      ...(recipe.site_overrides ? { site_overrides: recipe.site_overrides } : {}),
      ...(recipe.route_order ? { route_order: recipe.route_order } : {}),
      ...(recipe.preferred_route ? { preferred_route: recipe.preferred_route } : {}),
    })),
    vertical_coverage: {
      commerce: verticalCoverage(["ikea", "amazon", "argos", "johnlewis", ...COMPATIBILITY_PROVIDER_IDS], ["search_products"], ["get_product"]),
      rentals: verticalCoverage(["onthemarket", "openrent"], ["search_properties"], ["get_listing"]),
      jobs: verticalCoverage(["greenhouse", "lever"], ["search"], ["get_listing"]),
    },
    rolling: {
      ikea: rollingProviderMetric("ikea"),
      amazon: rollingProviderMetric("amazon"),
      argos: rollingProviderMetric("argos"),
      johnlewis: rollingProviderMetric("johnlewis"),
      commerce: rollingProviderMetric("commerce"),
      rentals: rollingProviderMetric("rentals"),
      onthemarket: rollingProviderMetric("onthemarket"),
      openrent: rollingProviderMetric("openrent"),
      jobs: rollingProviderMetric("jobs"),
      greenhouse: rollingProviderMetric("greenhouse"),
      lever: rollingProviderMetric("lever"),
    },
    last: last ?? null,
  };
  for (const provider of COMPATIBILITY_PROVIDER_IDS) (summary.rolling as JsonObject)[provider] = rollingProviderMetric(provider);
  return summary;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cacheTtlSeconds(provider: ConnectorId, tool: string, input: JsonObject = {}): number {
  if (provider === "ikea" && tool === "search_products") return 180;
  if (provider === "ikea" && tool === "get_product") return 300;
  if (provider === "amazon" && tool === "search_products") return 90;
  if (provider === "amazon" && tool === "get_product") return 300;
  if (provider === "johnlewis" && tool === "search_products") return 180;
  if (provider === "johnlewis" && tool === "get_product") return 300;
  // Dynamic storefront answers are held in the compatibility engine's short-
  // lived opaque working-memory snapshots. Keep the gateway response cache
  // disabled for caller-supplied sites so price and stock stay live-verified.
  if (provider === "commerce" && tool === "search_products" && typeof input.site === "string") return 0;
  if (provider === "commerce" && tool === "search_products") return 90;
  if (provider === "commerce" && tool === "get_product" && typeof input.site === "string") return 0;
  if (provider === "commerce" && tool === "get_product") return 240;
  // Rental availability, price, and listing timestamps are volatile. Keep
  // every rental read live so canonical detail reconciliation cannot be served
  // from a stale search-card snapshot.
  if (provider === "rentals" && tool === "search_properties") return 0;
  if (provider === "rentals" && tool === "get_listing") return 0;
  if (provider === "jobs" && tool === "search") return 120;
  if (provider === "jobs" && tool === "get_listing") return 300;
  if (provider === "travel") return 120;
  return 0;
}

function cacheKey(provider: ConnectorId, tool: string, input: JsonObject): string {
  const cacheableInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "response_format" && key !== "include_diagnostics"));
  return `${provider}.${tool}:${stableJson(cacheableInput)}`;
}

function searchNeedsCompleteCoverage(input: JsonObject): boolean {
  const query = String(input.query ?? "");
  return input.sort_by === "price_asc"
    || input.sort_by === "price_desc"
    || /\b(?:cheapest|lowest(?:\s+price)?|most\s+expensive|highest(?:\s+price)?|all\s+(?:matching|available)|every\s+(?:matching|available))\b/i.test(query);
}

function readCache(provider: ConnectorId, tool: string, input: JsonObject): CacheEntry | null {
  const ttl = cacheTtlSeconds(provider, tool, input);
  if (!ttl) return null;
  const key = cacheKey(provider, tool, input);
  const entry = cacheEntries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt >= ttl * 1000) {
    cacheEntries.delete(key);
    return null;
  }
  return entry;
}

function writeCache(provider: ConnectorId, tool: string, input: JsonObject, execution: ConnectorExecution): void {
  const ttl = cacheTtlSeconds(provider, tool, input);
  if (!ttl || execution.mode === "cache") return;
  if (["commerce", "ikea", "amazon", "argos", "johnlewis"].includes(provider) && tool.includes("search") && searchNeedsCompleteCoverage(input) && execution.data.coverage_sufficient_for_superlative !== true) return;
  const key = cacheKey(provider, tool, input);
  cacheEntries.set(key, {
    data: execution.data,
    sourceUrl: execution.sourceUrl,
    sourceProvider: execution.sourceProvider,
    engine: execution.engine,
    upstreamProvider: execution.upstreamProvider,
    mode: execution.mode,
    outcome: execution.outcome,
    retrievedAt: execution.retrievedAt ?? new Date().toISOString(),
    provenance: execution.provenance,
    storedAt: Date.now(),
  });
  while (cacheEntries.size > MAX_CACHE_ENTRIES) {
    const firstKey = cacheEntries.keys().next().value;
    if (typeof firstKey === "string") cacheEntries.delete(firstKey);
    else break;
  }
}

function executionFromCache(
  provider: ConnectorId,
  tool: string,
  input: JsonObject,
  context: ConnectorContext,
  entry: CacheEntry,
): ConnectorExecution {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000));
  const trace = createExecutionTrace();
  trace.fallback = { eligible: false, attempted: false, from: "http", outcome: "skipped", reason: "cache_hit" };
  context.trace = trace;
  const candidate: ConnectorExecution = {
    data: entry.data,
    sourceUrl: entry.sourceUrl,
    sourceProvider: entry.sourceProvider,
    engine: entry.engine,
    upstreamProvider: entry.upstreamProvider,
    retrievedAt: entry.retrievedAt,
    mode: "cache",
    outcome: entry.outcome,
    provenance: entry.provenance,
    cache: { hit: true, age_seconds: ageSeconds, source_mode: entry.mode },
    trace,
  };
  const validated = validateConnectorExecution(provider, tool, input, candidate);
  markSemanticValidation(context, "success");
  return { ...validated, trace: context.trace ?? trace };
}

/* Validate every connector result before exposing it to the caller. */
async function executeValidated(
  provider: ConnectorId,
  tool: string,
  input: JsonObject,
  context: ConnectorContext,
): Promise<ConnectorExecution> {
  const trace = context.trace ?? createExecutionTrace();
  context.trace = trace;
  const runOnce = async (): Promise<ConnectorExecution> => {
    const result = await connectors[provider].execute(tool, input, context);
    if (result.mode !== "cache") markHttpSuccess(context);
    const validated = validateConnectorExecution(provider, tool, input, result);
    markSemanticValidation(context, "success");
    if (validated.mode !== "cache") {
      trace.fallback = { eligible: false, attempted: false, from: "http", outcome: "skipped", reason: "http_success" };
    }
    return { ...validated, trace: context.trace };
  };
  try {
    return await runOnce();
  } catch (unknownError) {
    const error = errorFromUnknown(unknownError);
    const semanticFailure = error.stage === "semantic";
    if (semanticFailure) markSemanticValidation(context, "failed", error.code);
    markHttpFailure(context, error, semanticFailure);
    const serverRetryable = error.retryable && !semanticFailure && ["UPSTREAM_TIMEOUT", "UPSTREAM_CHANGED", "RATE_LIMITED", "UPSTREAM_BLOCKED"].includes(error.code);
    if (serverRetryable && !trace.retry.attempted) {
      trace.retry = { attempted: true, count: 1, outcome: "failed", error_code: error.code };
      try {
        const retried = await runOnce();
        trace.retry = { attempted: true, count: 1, outcome: "success", error_code: error.code };
        return retried;
      } catch (retryUnknownError) {
        const retryError = errorFromUnknown(retryUnknownError);
        trace.retry = { attempted: true, count: 1, outcome: "failed", error_code: retryError.code };
        const retrySemanticFailure = retryError.stage === "semantic";
        if (retrySemanticFailure) markSemanticValidation(context, "failed", retryError.code);
        markHttpFailure(context, retryError, retrySemanticFailure);
        throw retryError;
      }
    }
    throw error;
  }
}

const GENERIC_GATEWAY_TOOL_NAMES = new Set(["gateway_find_tool", "gateway_call_tool"]);
const PAGE_SCOPED_GATEWAY_TOOL_NAMES = new Set(["gateway_expand_tools"]);

function gatewayErrorBody(tool: string, error: GatewayError, correlationId = newCorrelationId()): JsonObject {
  const completedAt = new Date().toISOString();
  return {
    gateway_version: GATEWAY_VERSION,
    build_id: BUILD_ID,
    webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
    status: "error",
    provider: "gateway",
    tool,
    correlation_id: correlationId,
    meta: responseMeta(correlationId, completedAt, completedAt),
    gateway_mode: "read_only",
    consequential_actions: false,
    authentication_required: false,
    answer_ready: false,
    presentation: { action: "none" },
    next_action: null,
    source: gatewaySource(completedAt),
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      agent_action: error.retryable ? "retry_once" : "stop",
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function gatewayEchoResponse(input: JsonObject): JsonObject {
  const definition = getToolDefinition("gateway_echo");
  const validated = definition ? validateToolInput(definition, input) : input;
  const completedAt = new Date().toISOString();
  return {
    gateway_version: GATEWAY_VERSION,
    build_id: BUILD_ID,
    webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
    provider: "gateway",
    tool: "echo",
    status: "success",
    meta: responseMeta(newCorrelationId(), completedAt, completedAt),
    gateway_mode: "read_only",
    consequential_actions: false,
    authentication_required: false,
    answer_ready: true,
    presentation: { action: "none" },
    next_action: null,
    source: gatewaySource(completedAt),
    data: { message: "Hello from Gateway", received: validated.message ?? null },
  };
}

function taskCoverageIsPartial(body: JsonObject, data: JsonObject): boolean {
  if (data.answer_state === "partial" || data.coverage_level === "bounded_partial" || data.coverage_confidence === "partial") return true;
  const coverage = record(body.coverage);
  return Boolean(coverage && Object.values(coverage).some((value) => {
    const detail = record(value);
    const status = String(detail?.status ?? "");
    return status === "partial" || status.includes("blocked") || status.includes("timeout") || status === "unverified";
  }));
}

function taskErrorBody(error: GatewayError, correlationId: string, startedAt: string, clarification?: string): JsonObject {
  const completedAt = new Date().toISOString();
  return {
    gateway_version: GATEWAY_VERSION,
    build_id: BUILD_ID,
    webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
    status: "error",
    provider: "gateway",
    tool: "task",
    correlation_id: correlationId,
    meta: responseMeta(correlationId, startedAt, completedAt),
    gateway_mode: "read_only",
    consequential_actions: false,
    authentication_required: false,
    answer_state: "unverified",
    answer_ready: false,
    presentation: { action: "none" },
    agent_action: clarification ? "clarify" : "report_partial",
    next_action: null,
    ...(clarification ? { clarification } : {}),
    source: gatewaySource(completedAt),
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      agent_action: clarification ? "clarify" : "report_partial",
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function taskRouteData(route: GatewayTaskRoute): JsonObject {
  return {
    vertical: route.vertical,
    tool: `${route.provider}_${route.tool}`,
    arguments: route.arguments,
    extracted: route.extracted,
    ...(route.site ? { site: route.site.origin } : {}),
  };
}

/** Execute the one-shot normal task by routing into an existing workflow. */
export async function gatewayTask(
  inputValue: unknown = {},
  request: Request,
): Promise<{ body: JsonObject; status: number; correlationId: string }> {
  const correlationId = newCorrelationId();
  const startedAt = new Date().toISOString();
  try {
    const definition = getToolDefinition("gateway_task");
    if (!definition) throw new GatewayError("INTERNAL_ERROR", "The default gateway task contract is unavailable.");
    const input = validateToolInput(definition, inputValue);
    const plan = planGatewayTask(input);
    if (!plan.route) {
      const body: JsonObject = {
        gateway_version: GATEWAY_VERSION,
        build_id: BUILD_ID,
        webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
        status: "success",
        provider: "gateway",
        tool: "task",
        correlation_id: correlationId,
        meta: responseMeta(correlationId, startedAt),
        gateway_mode: "read_only",
        consequential_actions: false,
        authentication_required: false,
        answer_state: "needs_clarification",
        answer_ready: false,
        agent_action: "clarify",
        presentation: { action: "none" },
        clarification: plan.clarification,
        next_action: null,
        source: gatewaySource(),
        data: {
          goal: input.goal,
          clarification: plan.clarification,
          reason: plan.reason,
        },
      };
      return { body, status: 200, correlationId };
    }

    const route = plan.route;
    const routed = await executeConnectorRequest(route.provider, route.tool, route.arguments, request);
    const routedBody = routed.body;
    const routedData = record(routedBody.data) ?? {};
    const partial = taskCoverageIsPartial(routedBody, routedData);
    const routedNextAction = record(routedData.next_action) ?? record(routedBody.next_action);
    const routedAnswerReady = routed.status < 400 && routedBody.answer_ready === true;
    const agentAction = routed.status >= 400
      ? "report_partial"
      : routedAnswerReady
        ? partial ? "report_partial" : "answer"
        : routedNextAction ? "follow_next_action" : "report_partial";
    const presentation = routed.status < 400
      ? presentationForData(route.provider, route.tool, routedData, routedAnswerReady, agentAction)
      : { action: "none" } as const;
    const summary = routed.status < 400
      ? taskResultSummary(route.vertical, routedData, partial)
      : "The gateway could not complete the public-source search, so matching status is unknown.";
    const firstResult = Array.isArray(routedData.results) ? routedData.results[0] : null;
    const body: JsonObject = {
      gateway_version: GATEWAY_VERSION,
      build_id: BUILD_ID,
      webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
      status: routedBody.status ?? (routed.status < 400 ? "success" : "error"),
      ...(routedBody.outcome ? { outcome: routedBody.outcome } : {}),
      provider: "gateway",
      tool: "task",
      correlation_id: correlationId,
      meta: routedBody.meta ?? responseMeta(correlationId, startedAt),
      gateway_mode: "read_only",
      consequential_actions: false,
      authentication_required: false,
      ...(routedBody.coverage ? { coverage: routedBody.coverage } : {}),
      answer_state: routedData.answer_state ?? (routed.status < 400 ? "partial" : "unverified"),
      answer_ready: routedAnswerReady,
      agent_action: agentAction,
      presentation,
      summary,
      next_action: agentAction === "follow_next_action" ? routedNextAction : null,
      task: taskRouteData(route),
      ...(routedBody.execution ? { execution: routedBody.execution } : {}),
      ...(routedBody.source ? { source: routedBody.source } : { source: gatewaySource() }),
      ...(routedBody.error ? { error: { ...(record(routedBody.error) ?? {}), agent_action: agentAction } } : {}),
      data: {
        ...routedData,
        task: taskRouteData(route),
        summary,
        ...(firstResult && typeof firstResult === "object" && !Array.isArray(firstResult) ? { result: firstResult } : {}),
      },
    };
    enforceResultLimit(body);
    return { body, status: routed.status, correlationId };
  } catch (unknownError) {
    const error = errorFromUnknown(unknownError);
    const clarification = error.code === "INPUT_INVALID" ? error.message : undefined;
    const body = taskErrorBody(error, correlationId, startedAt, clarification);
    return { body, status: error.httpStatus, correlationId };
  }
}

function discoveryTokens(value: unknown): string[] {
  const stopwords = new Set(["the", "for", "used", "with", "one", "and", "or", "to", "of", "an", "this", "that", "which", "would", "can", "from", "current", "public"]);
  const aliases: Record<string, string> = {
    routes: "route",
    storefronts: "storefront",
    diagnostics: "diagnostic",
    inspect: "diagnostic",
    inspecting: "diagnostic",
    debug: "diagnostic",
    invoke: "call",
    dispatch: "call",
    products: "product",
    listings: "listing",
    properties: "property",
    careers: "job",
    jobs: "job",
  };
  return [...new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9]+/)
    .map((token) => aliases[token] ?? token)
    .map((token) => token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token)
    .filter((token) => token.length > 1 && !stopwords.has(token)))];
}

function discoveryScopeMatches(definition: ToolDefinition, scope: string): boolean {
  if (!scope || scope === "all") return true;
  if (definition.discovery_scopes && (definition.discovery_scopes as readonly string[]).includes(scope)) return true;
  if (scope === "diagnostics") return definition.provider === "gateway";
  if (scope === "compatibility") return definition.name === "gateway_manifest" || definition.name === "commerce_platform_diagnostics" || (COMPATIBILITY_PROVIDER_IDS as readonly string[]).includes(String(definition.provider));
  if (scope === "commerce") return ["commerce", "ikea", "amazon", "argos", "johnlewis"].includes(String(definition.provider)) || definition.name === "commerce_platform_diagnostics";
  if (scope === "rentals") return definition.provider === "rentals";
  if (scope === "jobs") return definition.provider === "jobs";
  return false;
}

function discoveryPurpose(definition: ToolDefinition): string {
  if (definition.name === "commerce_platform_diagnostics") return "Inspect platform detection and route execution for a public storefront.";
  if (definition.name === "gateway_manifest") return "Inspect bounded gateway contracts and current route evidence.";
  if (definition.name === "gateway_status") return "Inspect gateway health, coverage, and rolling execution metrics.";
  if (definition.name === "gateway_expand_tools") return "Deprecated; use the fixed WebMCP surface and strict gateway discovery/dispatch.";
  return definition.description.split(".")[0].trim().slice(0, 180) || definition.title;
}

/** Deterministic, metadata-only advanced discovery; no model or network call is made. */
export function gatewayFindTool(inputValue: unknown = {}): JsonObject {
  const startedAt = new Date().toISOString();
  try {
    const definition = getToolDefinition("gateway_find_tool");
    const input = definition ? validateToolInput(definition, inputValue) : inputValue as JsonObject;
    const query = String(input.query);
    const scope = typeof input.scope === "string" ? input.scope : "all";
    const requested = typeof input.max_results === "number" ? Math.min(5, Math.max(1, input.max_results)) : 3;
    const queryTokens = discoveryTokens(query);
    const distinctiveQueryTokens = queryTokens.filter((token) => ["shopify", "woocommerce", "storefront", "platform", "compatibility"].includes(token));
    const candidates = TOOL_DEFINITIONS
      .filter((tool) => tool.surface === "advanced" && !tool.deprecated && !GENERIC_GATEWAY_TOOL_NAMES.has(tool.name) && discoveryScopeMatches(tool, scope))
      .map((tool) => {
        const nameTokens = discoveryTokens(tool.name.replaceAll("_", " "));
        const metadataTokens = discoveryTokens([
          tool.name,
          tool.title,
          tool.description,
          ...(tool.keywords ?? []),
        ].join(" "));
        const nameText = tool.name.toLowerCase().replaceAll("_", " ");
        const queryText = query.toLowerCase().trim();
        const score = queryTokens.reduce((total, token) => total + (nameTokens.includes(token) ? 8 : metadataTokens.includes(token) ? 2 : 0), 0)
          + (queryText && nameText.includes(queryText) ? 12 : 0)
          + (tool.keywords ?? []).filter((keyword) => queryTokens.some((token) => discoveryTokens(keyword).includes(token))).length * 3;
        return { tool, score, metadataTokens };
      })
      .filter((item) => item.score > 0 && distinctiveQueryTokens.every((token) => item.metadataTokens.includes(token)))
      .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
      .slice(0, requested)
      .map(({ tool }) => ({ operation: tool.name, purpose: discoveryPurpose(tool) }));
    const completedAt = new Date().toISOString();
    return {
      gateway_version: GATEWAY_VERSION,
      provider: "gateway",
      tool: "find_tool",
      status: "success",
      meta: responseMeta(newCorrelationId(), startedAt, completedAt),
      answer_ready: true,
      presentation: { action: "none" },
      next_action: null,
      matches: candidates,
      data: { query, scope, matches: candidates },
    };
  } catch (unknownError) {
    const error = errorFromUnknown(unknownError);
    return gatewayErrorBody("find_tool", error);
  }
}

async function executeRegisteredGatewayOperation(
  definition: ToolDefinition,
  input: JsonObject,
  request: Request,
): Promise<{ body: JsonObject; status: number; correlationId: string }> {
  if (definition.provider !== "gateway") return executeConnectorRequest(definition.provider, definition.operation, input, request);
  if (definition.name === "gateway_echo") {
    const body = gatewayEchoResponse(input);
    return { body, status: 200, correlationId: String(body.correlation_id ?? newCorrelationId()) };
  }
  if (definition.name === "gateway_status") {
    const body = await gatewayStatus();
    return { body, status: 200, correlationId: String(body.meta && typeof body.meta === "object" ? (body.meta as JsonObject).request_id ?? newCorrelationId() : newCorrelationId()) };
  }
  if (definition.name === "gateway_task") {
    return gatewayTask(input, request);
  }
  if (definition.name === "gateway_manifest") {
    const body = await gatewayManifest(input);
    return { body, status: 200, correlationId: String(body.meta && typeof body.meta === "object" ? (body.meta as JsonObject).request_id ?? newCorrelationId() : newCorrelationId()) };
  }
  if (definition.name === "gateway_capabilities") {
    const body = gatewayCapabilities(input);
    return { body, status: body.status === "error" ? 400 : 200, correlationId: String(body.meta && typeof body.meta === "object" ? (body.meta as JsonObject).request_id ?? newCorrelationId() : newCorrelationId()) };
  }
  if (definition.name === "commerce_platform_diagnostics") {
    const body = await gatewayManifest({ surface: "semantic", site: input.site, query: input.query ?? "product" });
    const routeDiagnostics = record(body.route_diagnostics) ?? {
      requested_site: input.site,
      status: "unavailable",
      error_code: "PLATFORM_PROBE_FAILED",
    };
    const response: JsonObject = {
      gateway_version: GATEWAY_VERSION,
      provider: "gateway",
      tool: "commerce_platform_diagnostics",
      status: "success",
      meta: body.meta,
      answer_ready: true,
      presentation: { action: "none" },
      next_action: null,
      data: routeDiagnostics,
    };
    return { body: response, status: 200, correlationId: String(body.meta && typeof body.meta === "object" ? (body.meta as JsonObject).request_id ?? newCorrelationId() : newCorrelationId()) };
  }
  throw new GatewayError("CONNECTOR_UNAVAILABLE", `${definition.name} is page-scoped and must be invoked through native WebMCP.`);
}

/** Dispatch only an exact public registry entry through its existing schema. */
export async function gatewayCallTool(
  operationValue: unknown,
  argumentsValue: unknown,
  request: Request,
): Promise<{ body: JsonObject; status: number; correlationId: string }> {
  const correlationId = newCorrelationId();
  try {
    const operation = typeof operationValue === "string" ? operationValue : "";
    const definition = getToolDefinition(operation);
    if (!definition || GENERIC_GATEWAY_TOOL_NAMES.has(operation)) {
      throw new GatewayError("UNKNOWN_OPERATION", "operation must name an existing registered gateway operation returned by gateway_find_tool.");
    }
    if (PAGE_SCOPED_GATEWAY_TOOL_NAMES.has(operation)) {
      throw new GatewayError("CONNECTOR_UNAVAILABLE", "This operation is page-scoped; call it directly through native WebMCP after registration.", { retryable: false });
    }
    const input = validateToolInput(definition, argumentsValue);
    validateCrossFieldInputs(definition.provider === "gateway" ? "commerce" : definition.provider, definition.operation, input);
    return await executeRegisteredGatewayOperation(definition, input, request);
  } catch (unknownError) {
    const error = errorFromUnknown(unknownError);
    return { body: gatewayErrorBody("call_tool", error, correlationId), status: error.httpStatus, correlationId };
  }
}

export async function gatewayStatus(): Promise<JsonObject> {
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const metrics = metricsSummary();
  return {
    gateway_version: GATEWAY_VERSION,
    provider: "gateway",
    tool: "status",
    status: "success",
    meta: responseMeta(newCorrelationId(), startedAt, completedAt),
    gateway_mode: "read_only",
    consequential_actions: false,
    authentication_required: false,
    presentation: { action: "none" },
    source: gatewaySource(completedAt),
    mode: "stateless-read-only",
    webmcp: {
      ...webmcpDiagnostics(),
      native_route: "native WebMCP",
      fallback: "human-readable page remains usable",
    },
    execution_api: {
      path: "/api/execute",
      status: "online",
      request_contract: "{ provider, tool, arguments }",
      advanced_discovery: "/api/find-tool",
      advanced_dispatch: "/api/call-tool",
    },
    coverage: metrics.vertical_coverage,
    compatibility: metrics.compatibility,
    metrics,
    connectors: connectorHealth(),
  };
}

function inferredCapabilityFromGoal(goal: unknown): CapabilityId | null {
  if (typeof goal !== "string") return null;
  const normalized = goal.toLowerCase();
  if (/\b(job|jobs|role|roles|career|careers|hiring)\b/.test(normalized)) return "jobs";
  if (/\b(flat|house|home|rental|rentals|property|properties|bedroom|bedrooms)\b/.test(normalized)) return "rentals";
  if (/\b(product|products|buy|find|shop|shopping|price|prices|store|stores)\b/.test(normalized)) return "commerce";
  return null;
}

function capabilityRecipes(groups: CapabilityId[]): JsonObject[] {
  return groups.map((id) => {
    const definition = CAPABILITY_REGISTRY[id];
    return {
      capability: id,
      search_tool: definition.recommended_tools[0],
      detail_tool: definition.recommended_tools[1] ?? null,
      recipe: `Call ${definition.recommended_tools[0]} with the user's constraints; use actions.detail or ${definition.recommended_tools[1] ?? "no detail tool"} only for a finalist that needs deeper verification.`,
    };
  });
}

function compactCapabilityGroup(id: CapabilityId): JsonObject {
  const group = capabilityGroup(id, false);
  delete group.provider_details;
  delete group.tools;
  if (id === "commerce" && group.providers && typeof group.providers === "object" && !Array.isArray(group.providers)) {
    const providers = group.providers as JsonObject;
    group.providers = Object.fromEntries(["ikea", "amazon", "argos", "johnlewis"].filter((provider) => provider in providers).map((provider) => [provider, providers[provider]]));
  }
  if (group.platform_families && typeof group.platform_families === "object" && !Array.isArray(group.platform_families)) {
    group.platform_families = Object.fromEntries(Object.entries(group.platform_families as JsonObject).map(([platform, value]) => {
      const family = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
      return [platform, {
        status: family.status,
        dynamic_targeting: family.dynamic_targeting,
        recommended_tool: family.recommended_tool,
        tested_example_count: family.tested_example_count,
        ...(family.companies_available !== undefined ? { companies_available: family.companies_available } : {}),
      }];
    }));
  }
  return group;
}

function capabilityNextAction(groups: CapabilityId[], scope: string): JsonObject {
  if (scope === "diagnostics" || scope === "compatibility") {
    return {
      tool: "gateway_find_tool",
      arguments: { query: scope === "compatibility" ? "compatibility route diagnostics" : "gateway route diagnostics", scope },
      reason: "Search the bounded advanced registry once, then call only the exact operation needed for deliberate inspection.",
    };
  }
  const definition = groups[0] ? CAPABILITY_REGISTRY[groups[0]] : undefined;
  if (definition) {
    return {
      tool: definition.recommended_tools[0],
      reason: "Use the semantic search contract with the user's explicit constraints; inspect one finalist only when needed.",
    };
  }
  return {
    tool: "gateway_capabilities",
    reason: "Choose the task scope first, then call its semantic search contract.",
  };
}

export function gatewayCapabilities(capabilityValue: unknown = "all", options: JsonObject = {}): JsonObject {
  const startedAt = new Date().toISOString();
  const request = capabilityValue && typeof capabilityValue === "object" && !Array.isArray(capabilityValue)
    ? capabilityValue as JsonObject
    : { ...options, capability: capabilityValue };
  const capability = typeof request.capability === "string" ? request.capability : "all";
  const requestedScope = typeof request.scope === "string" ? request.scope : "";
  const goal = typeof request.goal === "string" ? request.goal : "";
  const level = request.level === "advanced" ? "advanced" : "overview";
  const validPlanningScopes = ["commerce", "rentals", "jobs", "diagnostics", "compatibility", "all"];
  const validScope = !requestedScope || validPlanningScopes.includes(requestedScope);
  const scopeCapability = ["commerce", "rentals", "jobs", "all"].includes(requestedScope) ? requestedScope : "";
  const inferred = capability === "all" && !scopeCapability ? inferredCapabilityFromGoal(goal) : null;
  const planCapability = scopeCapability || inferred || capability;
  const advancedScope = requestedScope === "diagnostics" || requestedScope === "compatibility";
  const emptyNavigation = capability === "all" && !requestedScope && !goal;
  const groups = advancedScope || !validScope || emptyNavigation ? [] : capabilityGroups(planCapability);
  const completedAt = new Date().toISOString();
  if (!groups.length && !advancedScope && !emptyNavigation) {
    return {
      gateway_version: GATEWAY_VERSION,
      provider: "gateway",
      tool: "capabilities",
      status: "error",
      meta: responseMeta(newCorrelationId(), startedAt, completedAt),
      gateway_mode: "read_only",
      consequential_actions: false,
      authentication_required: false,
      presentation: { action: "none" },
      coverage: {},
      source: gatewaySource(completedAt),
      error: {
        code: "INPUT_INVALID",
        message: "capability or scope must be commerce, rentals, jobs, diagnostics, compatibility, or all.",
        retryable: false,
      },
    };
  }
  const capabilities = Object.fromEntries(groups.map((id) => [id, level === "advanced" ? capabilityGroup(id, true) : compactCapabilityGroup(id)]));
  const nextAction = emptyNavigation
    ? { tool: "gateway_find_tool", arguments: { query: "specialist gateway capability", scope: "all" }, reason: "Choose a capability or specialist operation before searching." }
    : capabilityNextAction(groups, requestedScope);
  return {
    gateway_version: GATEWAY_VERSION,
    provider: "gateway",
    tool: "capabilities",
    status: "success",
    meta: responseMeta(newCorrelationId(), startedAt, completedAt),
    gateway_mode: "read_only",
    consequential_actions: false,
    authentication_required: false,
    presentation: { action: "none" },
    coverage: Object.fromEntries(groups.map((id) => [id, { status: (capabilities[id] as JsonObject).status }])),
    source: gatewaySource(completedAt),
    data: {
      scope: requestedScope || planCapability,
      goal: goal || null,
      navigation: {
        commerce: "commerce_search_products",
        rentals: "rentals_search_properties",
        jobs: "jobs_search",
        advanced: "gateway_find_tool",
      },
      level,
      capabilities,
      recipes: capabilityRecipes(groups),
      recommended_tool: nextAction.tool,
      recommended_next_action: nextAction,
      advanced_discovery: {
        tool: "gateway_find_tool",
        call_tool: "gateway_call_tool",
        instruction: "Use only when the default semantic surface cannot answer the task; search once and invoke one exact registered operation.",
      },
    },
  };
}

export async function gatewayManifest(surfaceValue: unknown = "full", options: JsonObject = {}): Promise<JsonObject> {
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const metrics = metricsSummary();
  const request = surfaceValue && typeof surfaceValue === "object" && !Array.isArray(surfaceValue)
    ? surfaceValue as JsonObject
    : { ...options, surface: surfaceValue };
  const surface = request.surface === "semantic" ? "semantic" : "full";
  const site = typeof request.site === "string" ? request.site : null;
  const query = typeof request.query === "string" ? request.query : null;
  const healthByProvider = new Map(connectorHealth().map((item) => [String(item.id), item]));
  const tools = toolsForSurface(surface).map((definition) => {
    if (definition.provider === "gateway") {
      return {
        tool: definition.name,
        surface: toolSurface(definition.name),
        provider: definition.provider,
        operation: definition.operation,
        title: definition.title,
        description: definition.description,
        input_schema: definition.inputSchema,
        read_only_hint: definition.readOnlyHint,
        ...(definition.deprecated ? { deprecated: true } : {}),
        status: "online",
        available_execution_modes: ["native_webmcp"],
      };
    }
    const providerHealth = healthByProvider.get(definition.provider);
    const toolHealth = providerHealth?.tools && typeof providerHealth.tools === "object"
      ? (providerHealth.tools as JsonObject)[definition.operation]
      : null;
    const details = toolHealth && typeof toolHealth === "object" ? toolHealth as JsonObject : {};
    return {
      tool: definition.name,
      surface: toolSurface(definition.name),
      provider: definition.provider,
      operation: definition.operation,
      title: definition.title,
      description: definition.description,
      input_schema: definition.inputSchema,
      read_only_hint: definition.readOnlyHint,
      ...(definition.deprecated ? { deprecated: true } : {}),
      status: details.status ?? "unknown",
      available_execution_modes: Array.isArray(details.available_execution_modes) ? details.available_execution_modes : [],
      ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
      ...(details.last_success_at ? { last_success_at: details.last_success_at } : {}),
      ...(details.last_failure_at ? { last_failure_at: details.last_failure_at } : {}),
      ...(details.last_error_code ? { last_error_code: details.last_error_code } : {}),
      ...(details.last_execution_mode ? { last_execution_mode: details.last_execution_mode } : {}),
    };
  });
  const verticals = Object.fromEntries((Object.keys(CAPABILITY_REGISTRY) as CapabilityId[]).map((id) => {
    const group = capabilityGroup(id, surface !== "semantic");
    return [id, {
      ...group,
      providers: group.provider_details,
      coverage: (metrics.vertical_coverage as JsonObject)[id],
    }];
  }));
  const semanticCoverage = Object.fromEntries((Object.keys(CAPABILITY_REGISTRY) as CapabilityId[]).map((id) => [id, { status: capabilityGroup(id, false).status }]));
  let routeDiagnostics: JsonObject | undefined;
  if (site && query) {
    const routeResult = await executeConnectorRequest(
      "commerce",
      "search_products",
      { site, query, max_results: 1, include_diagnostics: true },
      new Request("https://gateway.example/api/execute"),
    );
    const routeBody = routeResult.body;
    const routeData = routeBody.data && typeof routeBody.data === "object" && !Array.isArray(routeBody.data) ? routeBody.data as JsonObject : {};
    const routeExecution = routeBody.execution && typeof routeBody.execution === "object" && !Array.isArray(routeBody.execution) ? routeBody.execution as JsonObject : {};
    const routeProvenance = routeExecution.provenance && typeof routeExecution.provenance === "object" && !Array.isArray(routeExecution.provenance) ? routeExecution.provenance as JsonObject : {};
    const routeError = routeBody.error && typeof routeBody.error === "object" && !Array.isArray(routeBody.error) ? routeBody.error as JsonObject : {};
    const sharedSnapshot = typeof routeData.search_context === "string" ? getStoreSnapshot(routeData.search_context) : null;
    const exactMatches = Array.isArray(routeData.exact_matches)
      ? routeData.exact_matches.slice(0, 20).map((value) => record(value)).filter((value): value is JsonObject => Boolean(value)).map((value) => ({ provider: value.provider, product_id: value.product_id }))
      : [];
    routeDiagnostics = {
      requested_site: site,
      normalized_site: routeData.site ?? (routeError.details && typeof routeError.details === "object" && !Array.isArray(routeError.details) ? (routeError.details as JsonObject).site : null),
      detected_platform: routeData.platform ?? routeExecution.engine ?? routeProvenance.platform ?? null,
      route: routeProvenance.preferred_route ?? routeProvenance.route ?? null,
      status: routeResult.status < 400 ? "reachable" : "unavailable",
      result_state: routeData.answer_state ?? null,
      verification_status: routeData.verification_status ?? null,
      error_code: typeof routeError.code === "string" ? routeError.code : null,
      shared_snapshot: sharedSnapshot
        ? { ...snapshotSummary(sharedSnapshot), exact_matches: exactMatches }
        : { search_context: typeof routeData.search_context === "string" ? routeData.search_context : null, exact_matches: exactMatches },
    };
  }
  return {
    gateway_version: GATEWAY_VERSION,
    provider: "gateway",
    tool: "manifest",
    status: "success",
    meta: responseMeta(newCorrelationId(), startedAt, completedAt),
    gateway_mode: "read_only",
    consequential_actions: false,
    authentication_required: false,
    presentation: { action: "none" },
    source: gatewaySource(completedAt),
    surface,
    surface_counts: toolSurfaceCounts(),
    preferred_tools: PREFERRED_SEMANTIC_TOOL_NAMES,
    agent_guide: AGENT_QUICKSTART,
    tools,
    tool_names: tools.map((definition) => definition.tool),
    maximum_results: 20,
    default_result_count: DEFAULT_RESULT_COUNT,
    coverage: surface === "full" ? metrics.vertical_coverage : semanticCoverage,
    ...(surface === "full" ? { compatibility: metrics.compatibility, compatibility_benchmark: compatibilityBenchmarkSummary() } : {}),
    webmcp: webmcpDiagnostics(),
    verticals,
    ...(routeDiagnostics ? { route_diagnostics: routeDiagnostics } : {}),
  };
}

function errorFromUnknown(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("INTERNAL_ERROR", "The gateway could not complete the connector request.", { cause: error });
}

function defaultExecutionMode(provider: ConnectorId, tool: string): ExecutionMode {
  if (provider === "ikea") return tool === "check_availability" ? "first_party_api" : "first_party_api";
  if (provider === "amazon") return "public_http";
  if (provider === "argos") return "public_http";
  if (provider === "johnlewis") return "public_http";
  if (provider === "ebay" || provider === "eventbrite" || provider === "rail" || provider === "travel" || provider === "booking") return "public_http";
  if (provider === "commerce") return "mixed";
  if (provider === "rentals") return "public_http";
  if (provider === "jobs") return "public_http";
  return "public_http";
}

function webmcpDiagnostics(): JsonObject {
  const invariant = webmcpRegistryInvariant();
  return {
    build_id: BUILD_ID,
    webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
    registration_api: "document.modelContext.registerTool",
    discovery_api: "document.modelContext.getTools",
    invocation_api: "document.modelContext.executeTool",
    registry_source: "TOOL_DEFINITIONS",
    expected_tool_count: CORE_WEBMCP_TOOL_NAMES.length,
    default_tool_count: CORE_WEBMCP_TOOL_NAMES.length,
    full_registry_tool_count: TOOL_DEFINITIONS.length,
    internal_operation_count: INTERNAL_OPERATION_COUNT,
    advanced_tool_count: TOOL_DEFINITIONS.length - CORE_WEBMCP_TOOL_NAMES.length,
    semantic_tool_count: CORE_WEBMCP_TOOL_NAMES.length,
    preferred_tool_count: CORE_WEBMCP_TOOL_NAMES.length,
    surface_counts: toolSurfaceCounts(),
    preferred_tools: PREFERRED_SEMANTIC_TOOL_NAMES,
    default_tool: AGENT_QUICKSTART.default_tool,
    agent_guide: AGENT_QUICKSTART,
    ...invariant,
    registration_strategy: "static_atomic_core_bootstrap",
    registration_readiness: "static_contracts_submitted_before_ui_hydration",
    webmcp_ready_signal: "WEBMCP_READY",
    discovery_layers: WEBMCP_DISCOVERY_LAYERS,
    registration_telemetry: {
      source: "agent-webmcp-runtime",
      fields: [
        "bootstrap_started_ms",
        "register_calls_started",
        "register_calls_completed",
        "register_failures",
        "registered_tool_names",
        "toolchange_count",
        "bootstrap_ready_ms",
        "document_visibility_state",
        "build_id",
      ],
      ready_rule: "WEBMCP_READY is emitted only after all registerTool promises settle without failures.",
    },
    registration_latency_ms: null,
    registration_order: [...CORE_WEBMCP_TOOL_NAMES],
    ttfsi: {
      metric: "time_to_first_successful_invoke",
      definition: "navigation_to_first_successful_semantic_webmcp_invocation",
      value_ms: null,
      measured_by: "agent-webmcp-runtime",
    },
    target_lifecycle: {
      failure_class: "CLIENT_INTEROP_TARGET_LIFECYCLE",
      ownership: "native_client_or_cdp_adapter",
      gateway_action: "keep_normal_flows_discovery_once_and_rediscovery_free",
    },
    expected_preferred_tool_count: CORE_WEBMCP_TOOL_NAMES.length,
    annotation_policy: "readOnlyHint_only; external_untrusted_data_in_response_envelope",
    page_registry_id: "agent-webmcp-registry",
    runtime_status: "page_runtime_reports_native_registration_and_target_lifecycle_separately",
  };
}

function errorEnvelope(
  provider: ConnectorId,
  tool: string,
  correlationId: string,
  startedAt: string,
  error: GatewayError,
  trace: ExecutionTrace,
  mode: ExecutionMode,
  input?: JsonObject,
): JsonObject {
  const completedAt = new Date().toISOString();
  const envelope: JsonObject = {
    gateway_version: GATEWAY_VERSION,
    status: "error",
    provider,
    tool,
    correlation_id: correlationId,
    meta: responseMeta(correlationId, startedAt, completedAt),
    coverage: { [provider]: { status: coverageStatusForErrorCode(error.code), error_code: error.code } },
    answer_state: "unverified",
    answer_ready: false,
    presentation: { action: "none" },
    next_action: error.retryable && input
      ? {
        tool: `${provider}_${tool}`,
        arguments: { ...input },
        reason: "A transient provider failure remains; retry this exact read-only operation once or report the failure.",
        agent_action: "retry_once",
      }
      : null,
    execution: {
      mode: error.mode ?? mode,
      started_at: startedAt,
      completed_at: completedAt,
      ...trace,
    },
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      agent_action: error.retryable ? "retry_once" : "stop",
      ...(error.details ? { details: error.details } : {}),
    },
  };
  if (error.sourceUrl) {
    envelope.source = {
      provider,
      url: error.sourceUrl,
      execution_mode: error.mode ?? mode,
      retrieved_at: completedAt,
      freshness: "live",
      cache_age_seconds: 0,
      trust: "external_untrusted",
    };
  }
  return envelope;
}

function validateCrossFieldInputs(provider: ConnectorId, tool: string, input: JsonObject): void {
  if (provider === "eventbrite" && tool === "search_events") validateDateRange(input, "start_date", "end_date");
  if (provider === "booking" && ["search_hotels", "get_room_options"].includes(tool)) validateDateRange(input, "check_in", "check_out");
  if (provider === "ikea" && tool === "check_availability") validateUkPostcode(String(input.postcode));
}

export async function executeConnectorRequest(
  providerValue: unknown,
  toolValue: unknown,
  argumentsValue: unknown,
  request: Request,
): Promise<{ body: JsonObject; status: number; correlationId: string }> {
  const provider = isConnectorId(providerValue) ? providerValue : "ikea";
  const tool = typeof toolValue === "string" ? toolValue : "unknown";
  const correlationId = newCorrelationId();
  const startedAt = new Date().toISOString();
  const trace = createExecutionTrace();
  trace.fallback = { eligible: false, attempted: false, from: "http", outcome: "skipped", reason: "not_applicable" };
  let selectedProvider: ConnectorId = provider;
  let validatedInput: JsonObject | undefined;
  try {
    if (!isConnectorId(providerValue)) throw new GatewayError("INPUT_INVALID", "provider must be one of ikea, amazon, argos, johnlewis, commerce, rentals, or jobs.");
    selectedProvider = providerValue;
    const definition = getToolDefinition(`${provider}_${tool}`);
    if (!definition || definition.provider !== provider) {
      throw new GatewayError("CONNECTOR_UNAVAILABLE", `No connector tool is registered for ${provider}.${tool}.`);
    }
    const input = validateToolInput(definition, argumentsValue);
    validatedInput = input;
    validateCrossFieldInputs(provider, tool, input);
    trace.fallback = { eligible: false, attempted: false, from: "http", outcome: "skipped", reason: "no_alternate_zero_config_route" };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    // Argos publishes a robots file and a large server-rendered catalogue page;
    // keep the normal gateway bound tight while allowing the first cold Argos
    // request to complete both bounded upstream reads.
    const timeout = setTimeout(() => controller.abort(), provider === "argos" || provider === "commerce" ? 30_000 : 15_000);
    const context: ConnectorContext = {
      signal: controller.signal,
      correlationId,
      startedAt,
      trace,
      onProviderObservation: recordProviderObservation,
    };
    try {
      const cached = readCache(provider, tool, input);
      const result = cached
        ? executionFromCache(provider, tool, input, context, cached)
        : await executeValidated(
          provider,
          tool,
          input,
          context,
        );
      const enriched = cached
        ? result
        : {
          ...result,
          ...(cacheTtlSeconds(provider, tool, input) > 0 ? {
            cache: { hit: false, age_seconds: 0, source_mode: result.mode },
          } : {}),
        };
      if (!cached) writeCache(provider, tool, input, enriched);
      const body = successEnvelope(provider, tool, correlationId, startedAt, enriched, input);
      enforceResultLimit(body);
      recordRuntimeHealth(provider, "success", undefined, tool, enriched.mode);
      recordExecutionMetric(provider, tool, startedAt, enriched.trace ?? trace, undefined, enriched.mode, enriched.outcome === "ZERO_RESULTS" ? "zero_results" : "success");
      return { body, status: 200, correlationId };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
    }
  } catch (unknownError) {
    const error = errorFromUnknown(unknownError);
    const outputMode = error.mode ?? defaultExecutionMode(selectedProvider, tool);
    recordRuntimeHealth(selectedProvider, "error", error.code, tool, outputMode);
    recordExecutionMetric(selectedProvider, tool, startedAt, trace, error.code, outputMode, "error");
    return {
      body: errorEnvelope(selectedProvider, tool, correlationId, startedAt, error, trace, outputMode, validatedInput),
      status: error.httpStatus,
      correlationId,
    };
  }
}
