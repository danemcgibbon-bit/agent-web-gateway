/**
 * Deterministic WebMCP registration for the page's canonical tool registry.
 *
 * Tool contracts are static build-time data. The page passes the fixed core
 * surface here once at module evaluation; every registerTool call happens in
 * the same synchronous turn. Advanced operations remain server-side registry
 * entries and are reached through gateway_find_tool/gateway_call_tool.
 */

import { BUILD_ID, CORE_WEBMCP_TOOL_NAMES } from "./gateway-contract";

export type WebMcpToolLike = { name: string };

export type WebMcpModelContext<TTool extends WebMcpToolLike> = {
  registerTool: (tool: TTool, options?: { signal?: AbortSignal }) => void | Promise<void>;
  getTools?: () => unknown[] | Promise<unknown[]>;
};

export type WebMcpRegistrationState = "ready" | "partial" | "unavailable";

export type WebMcpRegistrationFailure = {
  tool: string;
  error_name: string;
  message: string;
  build_id: string;
};

export type WebMcpRegistrationTelemetry = {
  bootstrap_started_ms: number;
  register_calls_started: number;
  register_calls_completed: number;
  register_failures: WebMcpRegistrationFailure[];
  registered_tool_names: string[];
  toolchange_count: number;
  bootstrap_ready_ms: number | null;
  document_visibility_state: string;
  build_id: string;
  webmcp_ready: boolean;
};

export type WebMcpRegistrationReport = {
  registration_state: WebMcpRegistrationState;
  registered_tool_count: number;
  preferred_registered_tool_count: number;
  /** Preferred-surface count for compact diagnostics. */
  registered_tools: number;
  registered_tool_names: string[];
  preferred_registered_tool_names: string[];
  discovered_tool_names: string[];
  registration_latency_ms: number;
  registration_failures: string[];
  expected_core_tool_count: number;
  registered_core_tool_count: number;
  registry_match: boolean;
  discovery_error?: string;
  registration_failure_details: WebMcpRegistrationFailure[];
  bootstrap_started_ms: number;
  register_calls_started: number;
  register_calls_completed: number;
  register_failures: WebMcpRegistrationFailure[];
  toolchange_count: number;
  bootstrap_ready_ms: number | null;
  document_visibility_state: string;
  build_id: string;
  webmcp_ready: boolean;
  registration_telemetry: WebMcpRegistrationTelemetry;
  self_check: {
    expected_tool_names: string[];
    discovered_tool_names: string[];
    match: boolean;
    performed: boolean;
    error?: string;
  };
  /** Settlement is exposed without changing the synchronous registration API. */
  registration_settled?: Promise<WebMcpRegistrationReport>;
};

export type WebMcpTransportFixtureReport = {
  protocol: "webmcp";
  fresh_sessions: number;
  first_discovery_successes: number;
  core_registry_complete: number;
  first_gateway_task_invocation_successes: number;
  first_commerce_invocation_successes: number;
  commerce_get_product_invocation_successes: number;
  find_tool_invocation_successes: number;
  call_tool_invocation_successes: number;
  target_survival: number;
  rediscoveries_required: number;
  stale_target_failures: number;
  delayed_registration_failures: number;
  tool_not_discovered_errors: number;
  registration_latency_ms: { min: number; max: number; avg: number };
  ttfsi_ms: { min: number | null; max: number | null; avg: number | null };
};

export type WebMcpCrossClientBenchmarkReport = {
  protocol: "webmcp";
  fresh_sessions_per_journey: number;
  journey_count: number;
  journeys: Array<{
    id: string;
    category: "commerce" | "jobs" | "rentals" | "advanced";
    first_tool: string;
    prompt: string;
    runs: number;
    first_discovery_successes: number;
    first_invocation_successes: number;
    fallback_count: number;
    rediscoveries_required: number;
  }>;
  fallback_count: number;
  rediscoveries_required: number;
};

export function orderedWebMcpTools<TTool extends WebMcpToolLike>(
  tools: readonly TTool[],
  preferredNames: readonly string[],
): TTool[] {
  const order = new Map(preferredNames.map((name, index) => [name, index]));
  const fallbackRank = preferredNames.length;
  return [...tools].sort((left, right) => {
    const leftRank = order.get(left.name) ?? fallbackRank;
    const rightRank = order.get(right.name) ?? fallbackRank;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string" && value.message) return value.message;
  return "registration rejected";
}

function errorName(value: unknown): string {
  if (value instanceof Error && value.name) return value.name;
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string" && value.name) return value.name;
  return "Error";
}

function visibilityState(): string {
  if (typeof document === "undefined") return "unknown";
  return typeof document.visibilityState === "string" ? document.visibilityState : "unknown";
}

function failureFor(tool: string, error: unknown): WebMcpRegistrationFailure {
  return {
    tool,
    error_name: errorName(error),
    message: errorMessage(error),
    build_id: BUILD_ID,
  };
}

function reportWithSettlement(report: WebMcpRegistrationReport, settled: Promise<WebMcpRegistrationReport>): WebMcpRegistrationReport {
  Object.defineProperty(report, "registration_settled", {
    configurable: false,
    enumerable: false,
    value: settled,
    writable: false,
  });
  return report;
}

function unavailableReport(expectedNames: readonly string[] = []): WebMcpRegistrationReport {
  const startedAt = Date.now();
  const telemetry: WebMcpRegistrationTelemetry = {
    bootstrap_started_ms: startedAt,
    register_calls_started: 0,
    register_calls_completed: 0,
    register_failures: [],
    registered_tool_names: [],
    toolchange_count: 0,
    bootstrap_ready_ms: null,
    document_visibility_state: visibilityState(),
    build_id: BUILD_ID,
    webmcp_ready: false,
  };
  const report: WebMcpRegistrationReport = {
    registration_state: "unavailable",
    registered_tool_count: 0,
    preferred_registered_tool_count: 0,
    registered_tools: 0,
    preferred_registered_tool_names: [],
    discovered_tool_names: [],
    registration_latency_ms: 0,
    registration_failures: [],
    expected_core_tool_count: expectedNames.length,
    registered_core_tool_count: 0,
    registry_match: false,
    registration_failure_details: [],
    ...telemetry,
    registration_telemetry: telemetry,
    self_check: {
      expected_tool_names: [...expectedNames],
      discovered_tool_names: [],
      match: false,
      performed: false,
    },
  };
  return reportWithSettlement(report, Promise.resolve(report));
}

/**
 * Register one canonical registry and return a machine-readable readiness
 * report. This function is intentionally synchronous: every tool is submitted
 * before it returns, so a native host cannot observe a preferred-only phase.
 */
export function registerWebMcpTools<TTool extends WebMcpToolLike>(
  modelContext: WebMcpModelContext<TTool> | null | undefined,
  tools: readonly TTool[],
  preferredNames: readonly string[] = tools.map((tool) => tool.name),
  options: { signal?: AbortSignal } = {},
): WebMcpRegistrationReport {
  if (!modelContext?.registerTool) return unavailableReport(preferredNames);

  const startedAt = Date.now();
  const unique = [...new Map(tools.map((tool) => [tool.name, tool])).values()];
  // The fixed core receives an explicit canonical order. An empty preferred
  // list is retained for internal compatibility callers and preserves their
  // already deterministic registry order without creating a new WebMCP phase.
  const ordered = preferredNames.length ? orderedWebMcpTools(unique, preferredNames) : unique;
  const preferred = new Set(preferredNames);
  const failures: string[] = [];
  const failureDetails: WebMcpRegistrationFailure[] = [];
  const registered: string[] = [];
  const pendingRegistrations: Promise<void>[] = [];
  let registerCallsStarted = 0;
  let registerCallsCompleted = 0;
  let report: WebMcpRegistrationReport | null = null;

  const removeRegistered = (name: string): void => {
    const index = registered.indexOf(name);
    if (index >= 0) registered.splice(index, 1);
  };
  const addFailure = (tool: string, error: unknown): void => {
    const detail = failureFor(tool, error);
    if (!failureDetails.some((candidate) => candidate.tool === detail.tool && candidate.error_name === detail.error_name && candidate.message === detail.message)) {
      failureDetails.push(detail);
    }
    const compact = `${tool}: ${detail.message}`;
    if (!failures.includes(compact)) failures.push(compact);
  };

  // Do not split this into preferred/advanced phases. The native host should
  // see the complete fixed surface from the first discovery opportunity.
  for (const tool of ordered) {
    registerCallsStarted += 1;
    try {
      const result = modelContext.registerTool(tool, options);
      registered.push(tool.name);
      let isThenable = false;
      try {
        isThenable = Boolean(result && typeof (result as PromiseLike<void>).then === "function");
      } catch (error) {
        removeRegistered(tool.name);
        addFailure(tool.name, error);
      }
      if (isThenable) {
        const pending = Promise.resolve(result)
          .catch((error) => {
            removeRegistered(tool.name);
            addFailure(tool.name, error);
          })
          .finally(() => {
            registerCallsCompleted += 1;
          });
        pendingRegistrations.push(pending);
      } else {
        registerCallsCompleted += 1;
      }
    } catch (error) {
      removeRegistered(tool.name);
      addFailure(tool.name, error);
      registerCallsCompleted += 1;
    }
  }

  const expectedNames = [...preferredNames];
  let discoveredNames = [...registered];
  let discoveryError: string | undefined;
  let selfCheckPerformed = false;
  let selfCheckMatch = preferredNames.length === 0;

  const refreshReport = (): void => {
    if (!report) return;
    const preferredRegistered = registered.filter((name) => preferred.has(name));
    const registeredCore = preferredNames.filter((name) => registered.includes(name));
    const registeredMatch = preferredNames.length > 0
      && registeredCore.length === preferredNames.length
      && preferredNames.every((name, index) => registeredCore[index] === name && registered[index] === name);
    const registryMatch = registeredMatch && (!selfCheckPerformed || selfCheckMatch);
    if (!registryMatch && preferredNames.length && !failures.includes("WEBMCP_REGISTRY_MISMATCH")) failures.push("WEBMCP_REGISTRY_MISMATCH");
    const ready = failures.length === 0 && (!preferredNames.length || registryMatch) && registerCallsCompleted === registerCallsStarted;
    report.registration_state = ready ? "ready" : "partial";
    report.registered_tool_count = registered.length;
    report.preferred_registered_tool_count = preferredRegistered.length;
    report.registered_tools = preferredRegistered.length;
    report.registered_tool_names = [...registered];
    report.preferred_registered_tool_names = [...preferredRegistered];
    report.discovered_tool_names = [...discoveredNames];
    report.registration_latency_ms = Math.max(0, Date.now() - startedAt);
    report.registration_failures = failures.slice(0, 8);
    report.registration_failure_details = failureDetails.slice(0, 8);
    report.expected_core_tool_count = preferredNames.length;
    report.registered_core_tool_count = registeredCore.length;
    report.registry_match = registryMatch;
    if (discoveryError) report.discovery_error = discoveryError;
    report.bootstrap_ready_ms = ready ? Math.max(0, Date.now() - startedAt) : null;
    report.webmcp_ready = ready;
    report.bootstrap_started_ms = startedAt;
    report.register_calls_started = registerCallsStarted;
    report.register_calls_completed = registerCallsCompleted;
    report.register_failures = [...failureDetails.slice(0, 8)];
    report.toolchange_count = 0;
    report.document_visibility_state = visibilityState();
    report.build_id = BUILD_ID;
    report.registration_telemetry = {
      bootstrap_started_ms: startedAt,
      register_calls_started: registerCallsStarted,
      register_calls_completed: registerCallsCompleted,
      register_failures: [...failureDetails.slice(0, 8)],
      registered_tool_names: [...registered],
      toolchange_count: 0,
      bootstrap_ready_ms: report.bootstrap_ready_ms,
      document_visibility_state: report.document_visibility_state,
      build_id: BUILD_ID,
      webmcp_ready: ready,
    };
    report.self_check = {
      expected_tool_names: expectedNames,
      discovered_tool_names: [...discoveredNames],
      match: selfCheckMatch,
      performed: selfCheckPerformed,
      ...(discoveryError ? { error: discoveryError } : {}),
    };
  };

  const initialRegistryMatch = preferredNames.length > 0
    && preferredNames.every((name, index) => registered[index] === name);
  selfCheckMatch = initialRegistryMatch;
  report = {
    registration_state: failures.length || (preferredNames.length > 0 && !initialRegistryMatch) ? "partial" : "ready",
    registered_tool_count: registered.length,
    preferred_registered_tool_count: registered.filter((name) => preferred.has(name)).length,
    registered_tools: registered.filter((name) => preferred.has(name)).length,
    registered_tool_names: [...registered],
    preferred_registered_tool_names: registered.filter((name) => preferred.has(name)),
    discovered_tool_names: [...discoveredNames],
    registration_latency_ms: Math.max(0, Date.now() - startedAt),
    registration_failures: failures.slice(0, 8),
    expected_core_tool_count: preferredNames.length,
    registered_core_tool_count: preferredNames.filter((name) => registered.includes(name)).length,
    registry_match: initialRegistryMatch,
    registration_failure_details: failureDetails.slice(0, 8),
    bootstrap_started_ms: startedAt,
    register_calls_started: registerCallsStarted,
    register_calls_completed: registerCallsCompleted,
    register_failures: failureDetails.slice(0, 8),
    toolchange_count: 0,
    bootstrap_ready_ms: null,
    document_visibility_state: visibilityState(),
    build_id: BUILD_ID,
    webmcp_ready: false,
    registration_telemetry: {
      bootstrap_started_ms: startedAt,
      register_calls_started: registerCallsStarted,
      register_calls_completed: registerCallsCompleted,
      register_failures: failureDetails.slice(0, 8),
      registered_tool_names: [...registered],
      toolchange_count: 0,
      bootstrap_ready_ms: null,
      document_visibility_state: visibilityState(),
      build_id: BUILD_ID,
      webmcp_ready: false,
    },
    self_check: {
      expected_tool_names: expectedNames,
      discovered_tool_names: [...discoveredNames],
      match: selfCheckMatch,
      performed: false,
    },
  };
  refreshReport();

  const settled = Promise.allSettled(pendingRegistrations).then(async () => {
    if (modelContext.getTools) {
      selfCheckPerformed = true;
      try {
        const value = await modelContext.getTools();
        if (!Array.isArray(value)) throw new Error("getTools did not return an array");
        discoveredNames = value
          .map((candidate) => candidate && typeof candidate === "object" && "name" in candidate && typeof candidate.name === "string" ? candidate.name : null)
          .filter((name): name is string => Boolean(name));
        selfCheckMatch = preferredNames.length === 0
          ? true
          : discoveredNames.length === preferredNames.length && preferredNames.every((name, index) => discoveredNames[index] === name);
      } catch (error) {
        discoveryError = errorMessage(error);
        selfCheckMatch = false;
      }
    }
    refreshReport();
    return report as WebMcpRegistrationReport;
  });
  report = reportWithSettlement(report, settled);
  return report;
}

function metricSummary(values: number[]): { min: number; max: number; avg: number } {
  if (!values.length) return { min: 0, max: 0, avg: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round((total / values.length) * 100) / 100,
  };
}

function nullableMetricSummary(values: number[]): { min: number | null; max: number | null; avg: number | null } {
  if (!values.length) return { min: null, max: null, avg: null };
  const summary = metricSummary(values);
  return summary;
}

/**
 * Run the deterministic transport sequence used by the cold-session test.
 * This mirrors the protocol order without pretending to be a Chromium/CDP
 * runner: a real browser target is supplied by the QA environment when one
 * is available, while this fixture still catches delayed or partial core
 * registration in CI.
 */
export function runWebMcpTransportFixture(sessionCount = 50): WebMcpTransportFixtureReport {
  const freshSessions = Math.max(1, Math.floor(Number.isFinite(sessionCount) ? sessionCount : 50));
  const registrationLatency: number[] = [];
  const ttfsi: number[] = [];
  let firstDiscoverySuccesses = 0;
  let coreRegistryComplete = 0;
  let firstGatewayTaskInvocationSuccesses = 0;
  let firstCommerceInvocationSuccesses = 0;
  let commerceGetProductInvocationSuccesses = 0;
  let findToolInvocationSuccesses = 0;
  let callToolInvocationSuccesses = 0;
  let targetSurvival = 0;
  let rediscoveriesRequired = 0;
  let staleTargetFailures = 0;
  let delayedRegistrationFailures = 0;
  let toolNotDiscoveredErrors = 0;

  for (let session = 0; session < freshSessions; session += 1) {
    type FixtureTool = WebMcpToolLike & { execute: () => { status: "success" } };
    const visibleTools: FixtureTool[] = [];
    let discoveryCalls = 0;
    const target = { id: `fixture-target-${session}` };
    const context: WebMcpModelContext<FixtureTool> = {
      registerTool: (tool) => { visibleTools.push(tool); },
      getTools: () => { discoveryCalls += 1; return [...visibleTools]; },
    };
    const tools: FixtureTool[] = CORE_WEBMCP_TOOL_NAMES.map((name) => ({
      name,
      execute: () => ({ status: "success" }),
    }));
    const navigationStartedAt = Date.now();
    const registration = registerWebMcpTools(context, tools, CORE_WEBMCP_TOOL_NAMES);
    registrationLatency.push(registration.registration_latency_ms);
    const discoveredValue = context.getTools?.() ?? [];
    const discovered = (Array.isArray(discoveredValue) ? discoveredValue : []) as FixtureTool[];
    const discoveredNames = discovered.map((tool) => tool.name);
    const discoveryComplete = discoveredNames.length === CORE_WEBMCP_TOOL_NAMES.length
      && CORE_WEBMCP_TOOL_NAMES.every((name, index) => discoveredNames[index] === name);
    if (discoveryComplete) {
      firstDiscoverySuccesses += 1;
      coreRegistryComplete += 1;
    } else {
      toolNotDiscoveredErrors += 1;
      delayedRegistrationFailures += 1;
    }

    const invoke = (name: string): boolean => {
      const tool = discovered.find((candidate) => candidate.name === name);
      if (!tool) {
        toolNotDiscoveredErrors += 1;
        return false;
      }
      return tool.execute().status === "success";
    };
    if (invoke("gateway_task")) firstGatewayTaskInvocationSuccesses += 1;
    if (invoke("commerce_search_products")) {
      firstCommerceInvocationSuccesses += 1;
      ttfsi.push(Math.max(0, Date.now() - navigationStartedAt));
    }
    if (invoke("commerce_get_product")) commerceGetProductInvocationSuccesses += 1;
    if (invoke("gateway_find_tool")) findToolInvocationSuccesses += 1;
    if (invoke("gateway_call_tool")) callToolInvocationSuccesses += 1;

    // The sequence deliberately keeps one target/context alive and performs
    // no second discovery. Any failure here is a lifecycle failure, not a
    // semantic connector failure.
    if (target.id === `fixture-target-${session}` && discoveryCalls === 1) targetSurvival += 1;
    else staleTargetFailures += 1;
    rediscoveriesRequired += Math.max(0, discoveryCalls - 1);
  }

  return {
    protocol: "webmcp",
    fresh_sessions: freshSessions,
    first_discovery_successes: firstDiscoverySuccesses,
    core_registry_complete: coreRegistryComplete,
    first_gateway_task_invocation_successes: firstGatewayTaskInvocationSuccesses,
    first_commerce_invocation_successes: firstCommerceInvocationSuccesses,
    commerce_get_product_invocation_successes: commerceGetProductInvocationSuccesses,
    find_tool_invocation_successes: findToolInvocationSuccesses,
    call_tool_invocation_successes: callToolInvocationSuccesses,
    target_survival: targetSurvival,
    rediscoveries_required: rediscoveriesRequired,
    stale_target_failures: staleTargetFailures,
    delayed_registration_failures: delayedRegistrationFailures,
    tool_not_discovered_errors: toolNotDiscoveredErrors,
    registration_latency_ms: metricSummary(registrationLatency),
    ttfsi_ms: nullableMetricSummary(ttfsi),
  };
}

const MINIMUM_CROSS_CLIENT_JOURNEYS: ReadonlyArray<{
  id: string;
  category: "commerce" | "jobs" | "rentals" | "advanced";
  first_tool: string;
  prompt: string;
}> = [
  { id: "commerce-default", category: "commerce", first_tool: "commerce_search_products", prompt: "Find a product from a compatible public storefront." },
  { id: "commerce-shopify-targeted", category: "commerce", first_tool: "commerce_search_products", prompt: "Find the cheapest green men's sweater on a Shopify storefront." },
  { id: "commerce-woocommerce-targeted", category: "commerce", first_tool: "commerce_search_products", prompt: "Find a lamp on a WooCommerce storefront." },
  { id: "commerce-filtered", category: "commerce", first_tool: "commerce_search_products", prompt: "Find an in-stock large product under a specified price." },
  { id: "commerce-detail", category: "commerce", first_tool: "commerce_get_product", prompt: "Show more details for the returned product." },
  { id: "jobs-search", category: "jobs", first_tool: "jobs_search", prompt: "Find public software engineering jobs in London." },
  { id: "jobs-detail", category: "jobs", first_tool: "jobs_get_listing", prompt: "Show more details for the returned public job." },
  { id: "rentals-search", category: "rentals", first_tool: "rentals_search_properties", prompt: "Find a two-bedroom rental in Manchester." },
  { id: "rentals-detail", category: "rentals", first_tool: "rentals_get_listing", prompt: "Show more details for the returned rental." },
  { id: "advanced-discovery", category: "advanced", first_tool: "gateway_find_tool", prompt: "Find one uncommon supported compatibility operation." },
];

/**
 * Deterministic minimum cross-client matrix. It measures the producer and
 * registry transport only; connector semantics and external-client behavior
 * are intentionally reported by their own test layers.
 */
export function runCrossClientBenchmarkFixture(sessionCount = 20): WebMcpCrossClientBenchmarkReport {
  const runs = Math.max(1, Math.floor(Number.isFinite(sessionCount) ? sessionCount : 20));
  const journeys = MINIMUM_CROSS_CLIENT_JOURNEYS.map((journey) => {
    let firstDiscoverySuccesses = 0;
    let firstInvocationSuccesses = 0;
    let fallbackCount = 0;
    let rediscoveriesRequired = 0;
    for (let session = 0; session < runs; session += 1) {
      const visible: WebMcpToolLike[] = [];
      let discoveryCalls = 0;
      const context: WebMcpModelContext<WebMcpToolLike> = {
        registerTool: (tool) => { visible.push(tool); },
        getTools: () => { discoveryCalls += 1; return [...visible]; },
      };
      registerWebMcpTools(context, CORE_WEBMCP_TOOL_NAMES.map((name) => ({ name })), CORE_WEBMCP_TOOL_NAMES);
      const discovered = context.getTools?.() ?? [];
      const names = (Array.isArray(discovered) ? discovered : [])
        .map((tool) => tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string" ? tool.name : null)
        .filter((name): name is string => Boolean(name));
      if (names.length === CORE_WEBMCP_TOOL_NAMES.length && CORE_WEBMCP_TOOL_NAMES.every((name, index) => names[index] === name)) firstDiscoverySuccesses += 1;
      if (names.includes(journey.first_tool)) firstInvocationSuccesses += 1;
      else fallbackCount += 1;
      rediscoveriesRequired += Math.max(0, discoveryCalls - 1);
    }
    return {
      ...journey,
      runs,
      first_discovery_successes: firstDiscoverySuccesses,
      first_invocation_successes: firstInvocationSuccesses,
      fallback_count: fallbackCount,
      rediscoveries_required: rediscoveriesRequired,
    };
  });
  return {
    protocol: "webmcp",
    fresh_sessions_per_journey: runs,
    journey_count: journeys.length,
    journeys,
    fallback_count: journeys.reduce((total, journey) => total + journey.fallback_count, 0),
    rediscoveries_required: journeys.reduce((total, journey) => total + journey.rediscoveries_required, 0),
  };
}
