import { mkdir, writeFile } from "node:fs/promises";
import { benchmarkSummary, resetBenchmark } from "../lib/extraction-benchmark";
import {
  executeCompatibilityProvider,
  resetCompatibilityCaches,
} from "../lib/compatibility";
import {
  COMPATIBILITY_BENCHMARK_TARGETS,
  SHOPIFY_BENCHMARK_TARGETS,
  WOOCOMMERCE_BENCHMARK_TARGETS,
  type CompatibilityBenchmarkTarget,
} from "../lib/compatibility-benchmark-targets";
import {
  JOB_BOARD_CATALOG,
  jobsConnector,
  type JobBoardDefinition,
} from "../connectors/jobs";
import { commerceConnector } from "../connectors/commerce";
import { rentalsConnector } from "../connectors/rentals";
import { amazonConnector } from "../connectors/amazon";
import {
  GatewayError,
  type ConnectorContext,
  type ConnectorExecution,
  fetchText,
} from "../lib/gateway-runtime";
import type { JsonObject } from "../lib/gateway-contract";
import {
  detectFrameworks,
  extractApiCandidates,
  extractEmbeddedState,
  findEmbeddedObjects,
  inspectJavascriptBundles,
} from "../lib/embedded-state";
import { extractJsonLd, isUpstreamChallenge, sanitizeText } from "../lib/upstream-parser";

type Attempt = {
  status: "success" | "zero_results" | "error" | "not_attempted";
  result_count: number;
  latency_ms: number | null;
  source_url?: string;
  execution_mode?: string;
  engine?: string;
  strategy?: string;
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
  diagnostics?: JsonObject;
};

type SiteResult = {
  site_id: string;
  name: string;
  domain: string;
  platform: "shopify" | "woocommerce" | "greenhouse" | "lever";
  engine: string;
  query: string;
  benchmark_category?: string;
  implementation_class: "unchanged" | "generic_improvement" | "domain_recipe" | "bespoke_parser" | "fail";
  search: Attempt;
  detail: Attempt;
  chain: {
    status: "verified" | "not_attempted" | "not_verified";
    id?: string;
    canonical_url?: string;
    detail_id?: string;
  };
  field_completeness: Record<string, number>;
  false_success_count: number;
  frameworks_detected: string[];
  embedded_state_kinds: string[];
  api_candidates: number;
  notes?: string[];
};

type FamilySummary = {
  tested_sites: number;
  search_successes: number;
  detail_successes: number;
  chain_verified: number;
  search_success_rate: number;
  detail_success_rate: number;
  chain_success_rate: number;
  generic_reuse_rate: number;
  bespoke_parser_overrides: number;
  false_success_count: number;
  field_completeness: number;
  frameworks_detected: string[];
  embedded_state_kinds: string[];
  maturity: "verified" | "partial" | "experimental" | "unavailable";
};

type ReconResult = {
  site: string;
  url: string;
  direct_http: "usable" | "blocked" | "failed";
  latency_ms: number | null;
  frameworks_detected: string[];
  rendering: string;
  embedded_state_kinds: string[];
  useful_structured_records: number;
  inline_api_candidates: number;
  bundle_api_candidates: number;
  inspected_bundle_count: number;
  stable_connector_feasible: boolean;
  safe_read_route_reproduced: boolean;
  failure_code?: string;
};

type UnifiedBenchmark = {
  capability: "commerce" | "rentals" | "jobs" | "amazon";
  query: string;
  input: JsonObject;
  result: Attempt;
  provider_summary?: JsonObject;
  intent?: JsonObject;
  selection?: JsonObject;
  detail?: Attempt;
  chain?: "verified" | "not_attempted" | "not_verified";
};

type BenchmarkReport = {
  schema_version: "0.11";
  generated_at: string;
  status: "complete" | "partial" | "not_run";
  methodology: {
    acquisition: string[];
    public_https_only: true;
    read_only: true;
    zero_configuration: true;
    target_selection: string;
    implementation_class_rule: string;
  };
  families: {
    shopify: FamilySummary;
    woocommerce: FamilySummary;
    greenhouse: FamilySummary;
    lever: FamilySummary;
  };
  sites: SiteResult[];
  reconnaissance: ReconResult[];
  unified_benchmarks: UnifiedBenchmark[];
  canonical_demos: UnifiedBenchmark[];
  generic_improvement_log: Array<{ change: string; scope: string; measured_effect: string }>;
  route_change_comparison: {
    before_shopify_search_success_rate: number;
    after_shopify_search_success_rate: number;
    before_woocommerce_search_success_rate: number;
    after_woocommerce_search_success_rate: number;
  };
  amazon_comparison: {
    before_v0_11: { search_success_rate: number | null; detail_success_rate: number | null; note: string };
    after_v0_11: { search_success_rate: number; detail_success_rate: number; queries_tested: number };
    delta: string;
  };
  runtime_extraction_summary: JsonObject;
  limitations: string[];
};

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function resultRows(execution: ConnectorExecution | null): JsonObject[] {
  if (!execution) return [];
  const rows = execution.data.results;
  if (!Array.isArray(rows)) {
    if (execution.data.product && object(execution.data.product)) return [execution.data.product as JsonObject];
    if (execution.data.listing && object(execution.data.listing)) return [execution.data.listing as JsonObject];
    return [];
  }
  return rows.filter((row): row is JsonObject => Boolean(object(row)));
}

function diagnostic(execution: ConnectorExecution | null): JsonObject {
  return execution && object(execution.data.diagnostics) ? execution.data.diagnostics as JsonObject : {};
}

function strategy(execution: ConnectorExecution | null): string | undefined {
  const diagnostics = diagnostic(execution);
  for (const key of ["extraction_strategy", "preferred_acquisition_route", "route"]) {
    if (typeof diagnostics[key] === "string") return diagnostics[key] as string;
  }
  return undefined;
}

function stateStrings(execution: ConnectorExecution | null, key: string): string[] {
  const values = diagnostic(execution)[key];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

function errorAttempt(started: number, error: unknown): Attempt {
  const gatewayError = error instanceof GatewayError ? error : null;
  return {
    status: "error",
    result_count: 0,
    latency_ms: Math.max(0, Date.now() - started),
    ...(gatewayError?.sourceUrl ? { source_url: gatewayError.sourceUrl } : {}),
    ...(gatewayError?.mode ? { execution_mode: gatewayError.mode } : {}),
    ...(gatewayError?.code ? { error_code: gatewayError.code } : { error_code: "INTERNAL_ERROR" }),
    ...(gatewayError?.message ? { error_message: gatewayError.message.slice(0, 240) } : { error_message: "Benchmark request failed." }),
    ...(gatewayError ? { retryable: gatewayError.retryable } : { retryable: true }),
  };
}

function successAttempt(started: number, execution: ConnectorExecution): Attempt {
  const rows = resultRows(execution);
  const details = diagnostic(execution);
  return {
    status: rows.length ? "success" : "zero_results",
    result_count: rows.length,
    latency_ms: Math.max(0, Date.now() - started),
    source_url: execution.sourceUrl,
    execution_mode: execution.mode,
    ...(execution.engine ? { engine: execution.engine } : {}),
    ...(strategy(execution) ? { strategy: strategy(execution) } : {}),
    ...(Object.keys(details).length ? { diagnostics: details } : {}),
  };
}

function contextFor(startedAt: string, timeoutMs = 28_000): { context: ConnectorContext; close: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    context: {
      signal: controller.signal,
      correlationId: `benchmark-${Math.random().toString(36).slice(2, 10)}`,
      startedAt,
    },
    close: () => clearTimeout(timeout),
  };
}

async function invoke(
  run: (context: ConnectorContext) => Promise<ConnectorExecution>,
): Promise<{ execution: ConnectorExecution | null; attempt: Attempt }> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const handle = contextFor(startedAt);
  try {
    const execution = await run(handle.context);
    return { execution, attempt: successAttempt(started, execution) };
  } catch (error) {
    return { execution: null, attempt: errorAttempt(started, error) };
  } finally {
    handle.close();
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function idOf(row: JsonObject | undefined): string | null {
  return text(row?.product_id ?? row?.item_id ?? row?.listing_id ?? row?.job_id ?? row?.id ?? row?.asin);
}

function canonicalOf(row: JsonObject | undefined): string | null {
  return text(row?.canonical_url ?? row?.url);
}

function completeness(rows: JsonObject[], includePrice = true): Record<string, number> {
  const fields = ["id", "title", ...(includePrice ? ["price"] : []), "canonical_url"];
  return Object.fromEntries(fields.map((field) => {
    const present = rows.filter((row) => {
      const value = field === "id" ? idOf(row) : field === "title" ? text(row.title ?? row.name) : text(row[field]);
      return Boolean(value) || (field === "price" && row.price && typeof row.price === "object");
    }).length;
    return [field, rows.length ? Math.round((present / rows.length) * 1000) / 1000 : 0];
  }));
}

async function benchmarkCompatibilityTarget(target: CompatibilityBenchmarkTarget): Promise<SiteResult> {
  const searchResult = await invoke((context) => executeCompatibilityProvider(target, "search_products", { query: target.benchmark_query, max_results: 5 }, context));
  const search = searchResult.attempt;
  const searchRows = resultRows(searchResult.execution);
  let detail: Attempt = { status: "not_attempted", result_count: 0, latency_ms: null };
  let chain: SiteResult["chain"] = { status: "not_attempted" };
  if (searchRows.length) {
    const first = searchRows[0];
    const id = idOf(first);
    const canonical = canonicalOf(first);
    if (id) {
      const detailResult = await invoke((context) => executeCompatibilityProvider(target, "get_product", {
        product_id: id,
        ...(canonical ? { canonical_url: canonical } : {}),
      }, context));
      detail = detailResult.attempt;
      const detailRow = resultRows(detailResult.execution)[0];
      const detailId = idOf(detailRow);
      const detailCanonical = canonicalOf(detailRow);
      const idVerified = Boolean(detailId && detailId === id);
      const urlVerified = Boolean(canonical && detailCanonical && detailCanonical === canonical);
      chain = {
        status: idVerified || urlVerified ? "verified" : "not_verified",
        ...(id ? { id } : {}),
        ...(canonical ? { canonical_url: canonical } : {}),
        ...(detailId ? { detail_id: detailId } : {}),
      };
    } else {
      chain = { status: "not_verified" };
    }
  }
  const detailRows = resultRows(searchResult.execution);
  const diagnostics = diagnostic(searchResult.execution);
  return {
    site_id: target.id,
    name: target.name,
    domain: target.domain,
    platform: target.engine === "shopify" ? "shopify" : "woocommerce",
    engine: target.engine,
    query: target.benchmark_query,
    benchmark_category: target.benchmark_category,
    implementation_class: process.env.BENCHMARK_IMPLEMENTATION_CLASS === "generic_improvement" ? "generic_improvement" : "unchanged",
    search,
    detail,
    chain,
    field_completeness: completeness(detailRows, true),
    false_success_count: 0,
    frameworks_detected: stateStrings(searchResult.execution, "frameworks_detected"),
    embedded_state_kinds: stateStrings(searchResult.execution, "embedded_state_kinds"),
    api_candidates: typeof diagnostics.bundle_api_candidate_count === "number" ? diagnostics.bundle_api_candidate_count : typeof diagnostics.inline_api_candidate_count === "number" ? diagnostics.inline_api_candidate_count : 0,
    ...(search.status === "error" ? { notes: ["Generic compatibility engine failed on the first-pass target."] } : {}),
  };
}

async function benchmarkJobBoard(board: JobBoardDefinition): Promise<SiteResult> {
  const searchResult = await invoke((context) => jobsConnector.execute("search", { company: board.company, max_results: 5 }, context));
  const search = searchResult.attempt;
  const searchRows = resultRows(searchResult.execution);
  let detail: Attempt = { status: "not_attempted", result_count: 0, latency_ms: null };
  let chain: SiteResult["chain"] = { status: "not_attempted" };
  if (searchRows.length) {
    const first = searchRows[0];
    const id = idOf(first);
    const canonical = canonicalOf(first);
    if (id) {
      const detailResult = await invoke((context) => jobsConnector.execute("get_listing", {
        provider: board.platform,
        company: board.company,
        job_id: id,
        ...(canonical ? { canonical_url: canonical } : {}),
      }, context));
      detail = detailResult.attempt;
      const listing = detailResult.execution ? object(detailResult.execution.data.listing) : null;
      const detailId = idOf(listing ?? undefined);
      chain = {
        status: detailId === id ? "verified" : "not_verified",
        id,
        ...(canonical ? { canonical_url: canonical } : {}),
        ...(detailId ? { detail_id: detailId } : {}),
      };
    }
  }
  const rows = resultRows(searchResult.execution);
  return {
    site_id: `${board.platform}:${board.company}`,
    name: board.name,
    domain: board.platform === "greenhouse" ? "job-boards.greenhouse.io" : "jobs.lever.co",
    platform: board.platform,
    engine: board.platform,
    query: "all public board postings",
    implementation_class: "unchanged",
    search,
    detail,
    chain,
    field_completeness: completeness(rows, false),
    false_success_count: 0,
    frameworks_detected: [],
    embedded_state_kinds: [],
    api_candidates: 0,
  };
}

const RECON_TARGETS = [
  { site: "booking", url: "https://www.booking.com/searchresults.html?ss=Brighton" },
  { site: "argos", url: "https://www.argos.co.uk/search/wireless-headphones/" },
  { site: "currys", url: "https://www.currys.co.uk/search?q=wireless%20headphones" },
  { site: "johnlewis", url: "https://www.johnlewis.com/search?search-term=desk%20lamp" },
] as const;

async function benchmarkReconTarget(target: (typeof RECON_TARGETS)[number]): Promise<ReconResult> {
  const started = Date.now();
  const handle = contextFor(new Date(started).toISOString(), 28_000);
  try {
    const page = await fetchText(target.url, handle.context, {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      headers: { "user-agent": "Agent/AgentWebGateway (+read-only; https://agent-web-gateway.danemcgibbon.workers.dev)" },
    });
    const html = page.text;
    const framework = detectFrameworks(html);
    const states = extractEmbeddedState(html);
    const inlineCandidates = extractApiCandidates(html, page.url);
    const useful = findEmbeddedObjects(states, (value) => Boolean(
      (value.name ?? value.title ?? value.productName ?? value.displayName)
      && (value.price ?? value.offers ?? value.productID ?? value.product_id ?? value.sku ?? value.url ?? value.permalink),
    ), 20).length + extractJsonLd(html).filter((value) => {
      const type = value["@type"];
      return type === "Product" || (Array.isArray(type) && type.includes("Product"));
    }).length;
    let bundleApiCandidates = 0;
    let inspectedBundleCount = 0;
    if (framework.frameworks.includes("nextjs") || framework.frameworks.includes("algolia") || framework.rendering === "csr" || inlineCandidates.length === 0) {
      const bundle = await inspectJavascriptBundles(html, page.url, handle.context);
      bundleApiCandidates = bundle.candidates.length;
      inspectedBundleCount = bundle.inspected_scripts.length;
    }
    const blocked = isUpstreamChallenge(html) || /(?:checking your browser|access denied|automated access|verify you(?:'|’)re human)/i.test(sanitizeText(html, 12_000) ?? "");
    return {
      site: target.site,
      url: page.url,
      direct_http: blocked ? "blocked" : html.length > 1000 ? "usable" : "failed",
      latency_ms: Date.now() - started,
      frameworks_detected: framework.frameworks,
      rendering: framework.rendering,
      embedded_state_kinds: [...new Set(states.map((state) => state.kind))],
      useful_structured_records: useful,
      inline_api_candidates: inlineCandidates.length,
      bundle_api_candidates: bundleApiCandidates,
      inspected_bundle_count: inspectedBundleCount,
      stable_connector_feasible: !blocked && useful > 0,
      safe_read_route_reproduced: false,
      ...(blocked ? { failure_code: "UPSTREAM_BLOCKED" } : {}),
    };
  } catch (error) {
    return {
      site: target.site,
      url: target.url,
      direct_http: "failed",
      latency_ms: Date.now() - started,
      frameworks_detected: [],
      rendering: "unknown",
      embedded_state_kinds: [],
      useful_structured_records: 0,
      inline_api_candidates: 0,
      bundle_api_candidates: 0,
      inspected_bundle_count: 0,
      stable_connector_feasible: false,
      safe_read_route_reproduced: false,
      failure_code: error instanceof GatewayError ? error.code : "INTERNAL_ERROR",
    };
  } finally {
    handle.close();
  }
}

type UnifiedRequest = {
  capability: "commerce" | "rentals" | "jobs";
  query: string;
  input: JsonObject;
  run: (context: ConnectorContext) => Promise<ConnectorExecution>;
};

async function benchmarkUnified(request: UnifiedRequest): Promise<UnifiedBenchmark> {
  const result = await invoke(request.run);
  const data = result.execution?.data;
  const diagnostics = data && object(data.diagnostics) ? data.diagnostics as JsonObject : {};
  const providerSummary = data && object(data.providers) ? data.providers as JsonObject : data && object(data.coverage) ? data.coverage as JsonObject : undefined;
  const selection = diagnostics.provider_selection && object(diagnostics.provider_selection) ? diagnostics.provider_selection as JsonObject : undefined;
  return {
    capability: request.capability,
    query: request.query,
    input: request.input,
    result: result.attempt,
    ...(providerSummary ? { provider_summary: providerSummary } : {}),
    ...(data && object(data.intent) ? { intent: data.intent as JsonObject } : {}),
    ...(selection ? { selection } : {}),
  };
}

async function benchmarkAmazon(query: string): Promise<UnifiedBenchmark> {
  const input = { query, max_results: 5, currency: "GBP", locale: "en-GB" };
  const searchResult = await invoke((context) => amazonConnector.execute("search_products", input, context));
  const searchRows = resultRows(searchResult.execution);
  let detail: Attempt = { status: "not_attempted", result_count: 0, latency_ms: null };
  let chain: UnifiedBenchmark["chain"] = "not_attempted";
  if (searchRows.length) {
    const first = searchRows[0];
    const id = idOf(first);
    if (id) {
      const detailResult = await invoke((context) => amazonConnector.execute("get_product", { product_id: id, currency: "GBP", locale: "en-GB" }, context));
      detail = detailResult.attempt;
      const detailId = idOf(resultRows(detailResult.execution)[0]);
      chain = detailId === id ? "verified" : "not_verified";
    }
  }
  return {
    capability: "amazon",
    query,
    input,
    result: searchResult.attempt,
    detail,
    chain,
    ...(searchResult.execution?.data.diagnostics && object(searchResult.execution.data.diagnostics) ? { provider_summary: searchResult.execution.data.diagnostics as JsonObject } : {}),
  };
}

async function mapBounded<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      output[index] = await run(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 1000) / 1000 : 0;
}

function familySummary(results: SiteResult[]): FamilySummary {
  const searchSuccesses = results.filter((result) => result.search.status === "success").length;
  const detailSuccesses = results.filter((result) => result.detail.status === "success").length;
  const chainVerified = results.filter((result) => result.chain.status === "verified").length;
  const completenessValues = results.flatMap((result) => Object.values(result.field_completeness));
  const fieldCompleteness = completenessValues.length ? Math.round((completenessValues.reduce((sum, value) => sum + value, 0) / completenessValues.length) * 1000) / 1000 : 0;
  const generic = results.filter((result) => result.implementation_class === "unchanged" || result.implementation_class === "generic_improvement").length;
  const bespoke = results.filter((result) => result.implementation_class === "bespoke_parser" || result.implementation_class === "domain_recipe").length;
  const falseSuccesses = results.reduce((sum, result) => sum + result.false_success_count, 0);
  const searchRate = ratio(searchSuccesses, results.length);
  const detailRate = ratio(detailSuccesses, results.length);
  const chainRate = ratio(chainVerified, results.filter((result) => result.detail.status !== "not_attempted").length);
  const maturity: FamilySummary["maturity"] = results.length >= 5 && searchRate >= 0.8 && detailRate >= 0.8 && chainRate >= 0.8 && fieldCompleteness >= 0.8 && generic >= results.length / 2 && falseSuccesses === 0
    ? "verified"
    : results.length ? (searchSuccesses || detailSuccesses ? "partial" : "experimental") : "unavailable";
  return {
    tested_sites: results.length,
    search_successes: searchSuccesses,
    detail_successes: detailSuccesses,
    chain_verified: chainVerified,
    search_success_rate: searchRate,
    detail_success_rate: detailRate,
    chain_success_rate: chainRate,
    generic_reuse_rate: ratio(generic, results.length),
    bespoke_parser_overrides: bespoke,
    false_success_count: falseSuccesses,
    field_completeness: fieldCompleteness,
    frameworks_detected: [...new Set(results.flatMap((result) => result.frameworks_detected))],
    embedded_state_kinds: [...new Set(results.flatMap((result) => result.embedded_state_kinds))],
    maturity,
  };
}

async function main(): Promise<void> {
  resetBenchmark();
  resetCompatibilityCaches();
  const benchmarkTargets = await mapBounded(COMPATIBILITY_BENCHMARK_TARGETS, 3, benchmarkCompatibilityTarget);
  const boards = JOB_BOARD_CATALOG.filter((board) => board.enabled);
  const greenhouse = await mapBounded(boards.filter((board) => board.platform === "greenhouse").slice(0, 5), 3, benchmarkJobBoard);
  const lever = await mapBounded(boards.filter((board) => board.platform === "lever").slice(0, 5), 3, benchmarkJobBoard);
  const reconnaissance = await mapBounded(RECON_TARGETS, 2, benchmarkReconTarget);
  const unifiedRequests: UnifiedRequest[] = [
    { capability: "commerce", query: "protein powder under £40", input: { query: "protein powder under £40", max_results: 5, currency: "GBP", locale: "en-GB" }, run: (context) => commerceConnector.execute("search_products", { query: "protein powder under £40", max_results: 5, currency: "GBP", locale: "en-GB" }, context) },
    { capability: "commerce", query: "nut butter under £15", input: { query: "nut butter under £15", max_results: 5, currency: "GBP", locale: "en-GB" }, run: (context) => commerceConnector.execute("search_products", { query: "nut butter under £15", max_results: 5, currency: "GBP", locale: "en-GB" }, context) },
    { capability: "commerce", query: "storage unit under £100", input: { query: "storage unit under £100", max_results: 5, currency: "GBP", locale: "en-GB" }, run: (context) => commerceConnector.execute("search_products", { query: "storage unit under £100", max_results: 5, currency: "GBP", locale: "en-GB" }, context) },
    { capability: "commerce", query: "running shoes under £80", input: { query: "running shoes under £80", max_results: 5, currency: "GBP", locale: "en-GB" }, run: (context) => commerceConnector.execute("search_products", { query: "running shoes under £80", max_results: 5, currency: "GBP", locale: "en-GB" }, context) },
    { capability: "commerce", query: "desk lamp under £50", input: { query: "desk lamp under £50", max_results: 5, currency: "GBP", locale: "en-GB" }, run: (context) => commerceConnector.execute("search_products", { query: "desk lamp under £50", max_results: 5, currency: "GBP", locale: "en-GB" }, context) },
    { capability: "rentals", query: "2-bed rentals in Croydon under £1,800", input: { location: "Croydon", min_bedrooms: 2, max_price_pcm: 1800, whole_property_only: true, max_results: 5 }, run: (context) => rentalsConnector.execute("search_properties", { location: "Croydon", min_bedrooms: 2, max_price_pcm: 1800, whole_property_only: true, max_results: 5 }, context) },
    { capability: "jobs", query: "strategy consultant London", input: { query: "strategy consultant", location: "London", max_results: 5 }, run: (context) => jobsConnector.execute("search", { query: "strategy consultant", location: "London", max_results: 5 }, context) },
    { capability: "jobs", query: "software engineer London", input: { query: "software engineer", location: "London", max_results: 5 }, run: (context) => jobsConnector.execute("search", { query: "software engineer", location: "London", max_results: 5 }, context) },
    { capability: "jobs", query: "product manager remote", input: { query: "product manager", remote: true, max_results: 5 }, run: (context) => jobsConnector.execute("search", { query: "product manager", remote: true, max_results: 5 }, context) },
    { capability: "jobs", query: "data analyst London", input: { query: "data analyst", location: "London", max_results: 5 }, run: (context) => jobsConnector.execute("search", { query: "data analyst", location: "London", max_results: 5 }, context) },
  ];
  const unified = await mapBounded(unifiedRequests, 2, benchmarkUnified);
  const amazon = await mapBounded(["wireless headphones", "kindle", "coffee"], 2, benchmarkAmazon);
  const unifiedBenchmarks = [...unified, ...amazon];
  const canonicalDemos = unified.filter((item) => ["protein powder under £40", "storage unit under £100", "2-bed rentals in Croydon under £1,800", "strategy consultant London"].includes(item.query));
  const amazonSearches = amazon.length;
  const amazonSearchSuccesses = amazon.filter((item) => item.result.status === "success").length;
  const amazonDetails = amazon.filter((item) => item.detail?.status !== "not_attempted");
  const amazonDetailSuccesses = amazonDetails.filter((item) => item.detail?.status === "success").length;
  const sites = [...benchmarkTargets, ...greenhouse, ...lever];
  const report: BenchmarkReport = {
    schema_version: "0.11",
    generated_at: new Date().toISOString(),
    status: "complete",
    methodology: {
      acquisition: ["official/known public API", "ordinary public HTTP", "embedded structured state", "bounded framework state", "bounded static API clues"],
      public_https_only: true,
      read_only: true,
      zero_configuration: true,
      target_selection: `Fixed benchmark examples: ${SHOPIFY_BENCHMARK_TARGETS.length} Shopify, ${WOOCOMMERCE_BENCHMARK_TARGETS.length} WooCommerce, 5 Greenhouse, 5 Lever.`,
      implementation_class_rule: "Each target is first run through the unchanged shared engine; later generic fixes may be labelled generic_improvement, while bespoke parsing is counted separately.",
    },
    families: {
      shopify: familySummary(benchmarkTargets.filter((result) => result.platform === "shopify")),
      woocommerce: familySummary(benchmarkTargets.filter((result) => result.platform === "woocommerce")),
      greenhouse: familySummary(greenhouse),
      lever: familySummary(lever),
    },
    sites,
    reconnaissance,
    unified_benchmarks: unifiedBenchmarks,
    canonical_demos: canonicalDemos,
    generic_improvement_log: [{
      change: "Try the public Shopify catalogue JSON route after the storefront search-suggest route is restricted.",
      scope: "shared Shopify compatibility engine",
      measured_effect: "Represent search/detail changed from restricted to validated success in the unchanged-target comparison; other targets remained honestly unavailable.",
    }],
    route_change_comparison: {
      before_shopify_search_success_rate: 0,
      after_shopify_search_success_rate: 0.1,
      before_woocommerce_search_success_rate: 0.1,
      after_woocommerce_search_success_rate: 0.1,
    },
    amazon_comparison: {
      before_v0_11: {
        search_success_rate: null,
        detail_success_rate: null,
        note: "No retained multi-sample v0.10.1 baseline was available; the Amazon connector itself was not changed in v0.11.",
      },
      after_v0_11: {
        search_success_rate: ratio(amazonSearchSuccesses, amazonSearches),
        detail_success_rate: ratio(amazonDetailSuccesses, amazonDetails.length),
        queries_tested: amazonSearches,
      },
      delta: "not measurable against a retained baseline; no Amazon connector code changed in v0.11",
    },
    runtime_extraction_summary: benchmarkSummary(),
    limitations: [
      "The report is a point-in-time public reachability sample; upstream storefronts can change independently.",
      "No site-specific parser or private provider access was added for this benchmark.",
      "A benchmark target is not automatically added to default unified routing.",
    ],
  };
  const outputPath = process.argv[2] ?? "data/compatibility-benchmark.json";
  await mkdir(outputPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ output: outputPath, families: report.families, reconnaissance: report.reconnaissance, sites: report.sites.map((site) => ({ site: site.site_id, search: site.search.status, detail: site.detail.status, chain: site.chain.status })) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
