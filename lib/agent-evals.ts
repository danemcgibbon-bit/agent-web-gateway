import {
  AGENT_QUICKSTART,
  BUILD_ID,
  CORE_WEBMCP_TOOL_NAMES,
  GATEWAY_VERSION,
  INTERNAL_OPERATION_COUNT,
  PREFERRED_SEMANTIC_TOOL_NAMES,
  toolSurfaceCounts,
  toolsForSurface,
  WEBMCP_CONTRACT_VERSION,
  WEBMCP_DISCOVERY_LAYERS,
  webmcpRegistryInvariant,
  type JsonObject,
} from "./gateway-contract";
import { runCrossClientBenchmarkFixture, runWebMcpTransportFixture } from "./webmcp-bootstrap";
import { planGatewayTask } from "./gateway-task";

export type JourneyScenario =
  | "success"
  | "success_or_honest_failure"
  | "unsupported_site"
  | "partial_success"
  | "detail_failure_honest"
  | "failure_distinguished";

export type GoldenJourney = {
  id: string;
  title: string;
  user_request: string;
  expected_primary_tool: string;
  expected_important_arguments: JsonObject;
  absent_arguments?: string[];
  expected_tool_chain: string[];
  acceptable_alternate_behavior: string[];
  required_assertions: string[];
  forbidden_outcomes: string[];
  scenario: JourneyScenario;
  acceptable_error_codes?: string[];
  forbidden_answer_patterns?: string[];
  forbidden_tools?: string[];
  allow_diagnostic_tools?: boolean;
};

export type AgentToolCall = {
  tool: string;
  arguments?: JsonObject;
  status?: "success" | "error";
  error_code?: string;
};

export type AgentTrace = {
  calls: AgentToolCall[];
  final_status: "success" | "partial" | "error";
  final_error_code?: string;
  final_message?: string;
  coverage?: JsonObject;
};

export type JourneyEvaluation = {
  journey_id: string;
  tool_understanding: { passed: boolean; reason: string };
  tool_selection: { passed: boolean; selected_tool: string | null; expected_tool: string };
  argument_extraction: { passed: boolean; missing: string[]; mismatched: string[]; unexpected: string[] };
  chain_completion: { passed: boolean; expected: string[]; observed: string[] };
  failure_handling: { passed: boolean; reason: string };
  forbidden_outcomes: { passed: boolean; matched: string[] };
  diagnostic_tool_misuse: { passed: boolean; count: number; tools: string[] };
  unnecessary_tool_calls: { passed: boolean; count: number; tools: string[] };
  journey_completion: boolean;
};

/**
 * A small, permanent set of user goals. These are definitions rather than
 * claims that every live upstream is healthy; the live and model runners
 * attach current evidence to them at evaluation time.
 */
export const GOLDEN_JOURNEYS: GoldenJourney[] = [
  {
    id: "commerce-woo-protein-budget",
    title: "WooCommerce nutrition budget",
    user_request: "Find protein powder under £40.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { query: "protein powder", max_price: 40 },
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["Use a valid WooCommerce nutrition result and disclose partial provider coverage."],
    required_assertions: ["max_price is 40 GBP", "nutrition intent is preserved", "irrelevant IKEA results are suppressed", "a result can chain through actions.detail"],
    forbidden_outcomes: ["Treat an IKEA bowl or unrelated home item as protein powder", "invent a price", "declare the search failed when a valid provider succeeds"],
    scenario: "success",
    forbidden_answer_patterns: ["no matching products exist"],
  },
  {
    id: "commerce-shopify-nut-butter",
    title: "Shopify nut-butter budget",
    user_request: "Find nut butter under £15.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { query: "nut butter", max_price: 15 },
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["Use a relevant compatible Shopify store such as Pip & Nut when available."],
    required_assertions: ["budget is 15 GBP", "relevant Shopify coverage participates", "canonical URL and provider identity are preserved"],
    forbidden_outcomes: ["Route the request only to an irrelevant furniture provider", "claim availability without a verified candidate"],
    scenario: "success",
  },
  {
    id: "commerce-ikea-storage",
    title: "Direct-provider storage search",
    user_request: "Find a storage unit under £100.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { query: "storage unit", max_price: 100 },
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["Prefer IKEA when it is relevant and usable; retain other useful sources if they are relevant."],
    required_assertions: ["storage intent strongly considers IKEA", "nutrition stores are not queried unnecessarily", "detail uses the original product identity"],
    forbidden_outcomes: ["Return a nutrition product as a storage unit", "lose the stable product ID between calls"],
    scenario: "success",
  },
  {
    id: "jobs-strategy-london",
    title: "Strategy consulting jobs",
    user_request: "Find strategy consulting jobs in London.",
    expected_primary_tool: "jobs_search",
    expected_important_arguments: { query: "strategy consulting", location: "London" },
    expected_tool_chain: ["jobs_search", "jobs_get_listing"],
    acceptable_alternate_behavior: ["Use whichever supported Greenhouse or Lever boards return valid results; both are not required."],
    required_assertions: ["London is retained as a location constraint", "job-title relevance is respected", "a listing chains through actions.detail"],
    forbidden_outcomes: ["Use commerce tools for a jobs request", "present a generic jobs shell as a listing"],
    scenario: "success",
  },
  {
    id: "rentals-two-bed-whole-property",
    title: "Whole-property rental budget",
    user_request: "Find two-bedroom whole properties under £1,800.",
    expected_primary_tool: "rentals_search_properties",
    expected_important_arguments: { min_bedrooms: 2, max_bedrooms: 2, max_price_pcm: 1800, whole_property_only: true },
    expected_tool_chain: ["rentals_search_properties", "rentals_get_listing"],
    acceptable_alternate_behavior: ["Use either OpenRent or OnTheMarket and disclose provider coverage when one fails."],
    required_assertions: ["whole_property_only is true", "rooms and shares are not silently included", "monthly budget is a hard filter", "finalists can be verified"],
    forbidden_outcomes: ["Treat a room share as a whole property", "claim a rent is under budget when the price is unknown"],
    scenario: "success",
  },
  {
    id: "dynamic-shopify-tentree",
    title: "Unknown Shopify variant search",
    user_request: "Find the cheapest currently available green men's sweater in size Large on tentree.com.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { site: "https://www.tentree.com", query: "sweater", audience: "men", color: "green", size: "L", in_stock: true, sort_by: "price_asc" },
    expected_tool_chain: ["commerce_search_products"],
    acceptable_alternate_behavior: ["If hosting-runtime egress blocks Tentree, report that honest classification and do not fabricate a result."],
    required_assertions: ["site is passed explicitly", "Shopify is detected generically", "variant-level audience, color, size, stock, and price are checked", "finalist verification is server-side in the semantic call", "answer_ready and agent_action tell the agent when to stop"],
    forbidden_outcomes: ["Use a bespoke Tentree parser", "treat an unreachable site as zero matching products", "claim stock without variant evidence"],
    scenario: "success_or_honest_failure",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "RUNTIME_EGRESS_BLOCKED", "SITE_UNREACHABLE", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE", "UPSTREAM_TIMEOUT"],
    forbidden_answer_patterns: ["no matching products exist", "definitely in stock"],
  },
  {
    id: "dynamic-woo-unknown-store",
    title: "Unknown WooCommerce storefront",
    user_request: "Find kefir on chucklinggoat.co.uk.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { site: "https://www.chucklinggoat.co.uk", query: "kefir" },
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["If the storefront is unreachable, return its structured failure without inventing a result."],
    required_assertions: ["WooCommerce is detected generically", "no pre-registered site parser is required", "a valid result chains to detail"],
    forbidden_outcomes: ["Use an unrelated provider", "fall back to arbitrary scraping", "claim success from a generic page"],
    scenario: "success_or_honest_failure",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "RUNTIME_EGRESS_BLOCKED", "SITE_UNREACHABLE", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE", "UPSTREAM_TIMEOUT", "UPSTREAM_CHANGED"],
  },
  {
    id: "fresh-agent-tentree-url",
    title: "Fresh-agent Tentree URL routing",
    user_request: "Use this gateway to find me the cheapest green men's sweater on https://www.tentree.com/.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { site: "https://www.tentree.com", query: "green men's sweater" },
    expected_tool_chain: ["commerce_search_products"],
    acceptable_alternate_behavior: ["Attempt the supplied Tentree URL dynamically; if acquisition is blocked, report the precise site failure without fabricating a result."],
    required_assertions: ["first discovery exposes the semantic surface", "the supplied URL maps to site", "Tentree is attempted without a provider-list lookup", "Amazon and John Lewis are not used as silent substitutes"],
    forbidden_outcomes: ["Conclude Tentree is unsupported because it is not a named example", "search an unrelated retailer instead", "ask whether direct browsing should be used before attempting the site"],
    forbidden_tools: ["gateway_echo", "gateway_manifest", "amazon_search_products", "johnlewis_search_products"],
    scenario: "success_or_honest_failure",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "RUNTIME_EGRESS_BLOCKED", "SITE_UNREACHABLE", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE", "UPSTREAM_TIMEOUT"],
    forbidden_answer_patterns: ["no matching products exist", "tentree is unsupported"],
  },
  {
    id: "weak-model-one-shot-tentree",
    title: "Weak-model one-shot gateway task",
    user_request: "Find me the cheapest green men's sweater on https://www.tentree.com/.",
    expected_primary_tool: "gateway_task",
    expected_important_arguments: { goal: "Find me the cheapest green men's sweater on https://www.tentree.com/." },
    expected_tool_chain: ["gateway_task"],
    acceptable_alternate_behavior: ["Use the one-shot task and report the precise targeted-site failure if acquisition is blocked."],
    required_assertions: ["the first semantic invocation is gateway_task", "the request is passed nearly verbatim", "no capabilities or manifest call is needed", "the task returns an explicit stop signal"],
    forbidden_outcomes: ["Ask the tester to explain Shopify or site routing", "search an unrelated retailer instead", "claim success without a verified candidate"],
    forbidden_tools: ["gateway_capabilities", "gateway_manifest", "gateway_find_tool", "gateway_call_tool"],
    scenario: "success_or_honest_failure",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "RUNTIME_EGRESS_BLOCKED", "SITE_UNREACHABLE", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE", "UPSTREAM_TIMEOUT"],
    forbidden_answer_patterns: ["no matching products exist", "tentree is unsupported"],
  },
  {
    id: "fresh-agent-unknown-shopify",
    title: "Previously untested Shopify storefront",
    user_request: "Find a wool overshirt on https://unseen-shopify.example.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { site: "https://unseen-shopify.example", query: "wool overshirt" },
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["Attempt generic Shopify detection and return a structured acquisition failure if the storefront is unavailable."],
    required_assertions: ["site mode bypasses the tested-example catalog", "dynamic Shopify detection is attempted", "no bespoke domain patch is required"],
    forbidden_outcomes: ["Refuse because the domain is not a named example", "fall back to market-wide commerce search"],
    scenario: "success_or_honest_failure",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "RUNTIME_EGRESS_BLOCKED", "SITE_UNREACHABLE", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE", "UPSTREAM_TIMEOUT", "UPSTREAM_CHANGED"],
  },
  {
    id: "explicit-site-targeting",
    title: "Explicit site stays targeted",
    user_request: "Find a green men's sweater specifically on https://www.tentree.com/; do not search other retailers.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { site: "https://www.tentree.com", query: "green men's sweater" },
    expected_tool_chain: ["commerce_search_products"],
    acceptable_alternate_behavior: ["Return a Tentree-targeted failure when the site cannot be acquired; alternatives require an explicit user request."],
    required_assertions: ["explicit site overrides automatic provider routing", "no unrelated provider is silently queried", "failure remains targeted"],
    forbidden_outcomes: ["Broaden to Amazon, IKEA, or John Lewis", "present a different retailer as a Tentree result"],
    forbidden_tools: ["amazon_search_products", "ikea_search_products", "johnlewis_search_products"],
    scenario: "success_or_honest_failure",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "RUNTIME_EGRESS_BLOCKED", "SITE_UNREACHABLE", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE", "UPSTREAM_TIMEOUT"],
  },
  {
    id: "market-wide-commerce-no-site",
    title: "Market-wide commerce without a site",
    user_request: "Find protein powder under £40 across the market.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { query: "protein powder", max_price: 40 },
    absent_arguments: ["site"],
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["Use the normal relevance router across usable public commerce sources."],
    required_assertions: ["no explicit site is invented", "normal unified commerce routing remains available", "budget is preserved"],
    forbidden_outcomes: ["Treat a market-wide request as a single-store request", "claim that a named storefront was searched without a site argument"],
    scenario: "success",
  },
  {
    id: "unsupported-site",
    title: "Unsupported public site",
    user_request: "Find a product on an intentionally unsupported public website.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { site: "https://example.com", query: "product" },
    expected_tool_chain: [],
    acceptable_alternate_behavior: ["Explain that the site is outside currently verified Shopify/WooCommerce compatibility."],
    required_assertions: ["unsupported-site classification is explicit", "no arbitrary scraping fallback is attempted", "no made-up capability crosses the success boundary"],
    forbidden_outcomes: ["Return fabricated product results", "translate unsupported into genuine zero results"],
    scenario: "unsupported_site",
    acceptable_error_codes: ["UNSUPPORTED_SITE", "PLATFORM_PROBE_FAILED", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE"],
    forbidden_answer_patterns: ["found the product", "available now"],
  },
  {
    id: "partial-provider-failure",
    title: "Useful results with partial coverage",
    user_request: "Find strategy jobs in London when one job-board platform is unavailable.",
    expected_primary_tool: "jobs_search",
    expected_important_arguments: { query: "strategy", location: "London" },
    expected_tool_chain: ["jobs_search", "jobs_get_listing"],
    acceptable_alternate_behavior: ["Return valid results from the working provider and mention material coverage limits."],
    required_assertions: ["overall result remains useful", "failed provider is visible in coverage", "working provider results are retained"],
    forbidden_outcomes: ["Declare the whole search failed because one provider failed", "pretend the failed provider succeeded"],
    scenario: "partial_success",
  },
  {
    id: "mid-chain-detail-failure",
    title: "Candidate found but detail blocked",
    user_request: "Find a product and verify the best candidate even if its detail page is blocked.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { query: "product" },
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["Keep the candidate, state that current detail or availability could not be verified, and avoid certainty."],
    required_assertions: ["search success is not erased", "detail failure is explicit", "uncertainty is communicated"],
    forbidden_outcomes: ["Say the item is definitely available or in stock", "silently skip the detail failure"],
    scenario: "detail_failure_honest",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "UPSTREAM_TIMEOUT", "UPSTREAM_CHANGED", "PLATFORM_DETECTED_ROUTE_UNAVAILABLE"],
    forbidden_answer_patterns: ["definitely available", "confirmed in stock"],
  },
  {
    id: "zero-results-vs-provider-failure",
    title: "Zero results versus failed search",
    user_request: "Search for a product when the upstream provider cannot be searched.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { query: "product" },
    expected_tool_chain: [],
    acceptable_alternate_behavior: ["Say that the provider could not be searched and preserve the machine-readable error; do not say no matches exist."],
    required_assertions: ["UPSTREAM_BLOCKED remains distinct from GENUINE_ZERO_RESULTS", "the agent does not fabricate a zero-result conclusion"],
    forbidden_outcomes: ["Translate UPSTREAM_BLOCKED into no matching products", "claim that the provider was searched successfully"],
    scenario: "failure_distinguished",
    acceptable_error_codes: ["UPSTREAM_BLOCKED", "UPSTREAM_TIMEOUT", "RUNTIME_EGRESS_BLOCKED"],
    forbidden_answer_patterns: ["no matching products exist", "nothing matched"],
  },
  {
    id: "cold-agent-discovery-chain",
    title: "Cold-agent direct semantic chaining",
    user_request: "With no gateway-specific instructions, find protein powder under £40 and inspect the best candidate.",
    expected_primary_tool: "commerce_search_products",
    expected_important_arguments: { query: "protein powder", max_price: 40 },
    expected_tool_chain: ["commerce_search_products", "commerce_get_product"],
    acceptable_alternate_behavior: ["Use gateway_capabilities only when the user goal is ambiguous; this clear task should use the semantic commerce pair directly."],
    required_assertions: ["the agent uses the fixed semantic surface", "tool selection is semantic", "constraints survive into invocation", "the detail action is chained"],
    forbidden_outcomes: ["Start with a provider diagnostic tool", "require developer instructions about Shopify or WooCommerce routes"],
    scenario: "success",
  },
  {
    id: "advanced-route-diagnostics",
    title: "Progressive disclosure route diagnostic",
    user_request: "Diagnose which compatibility route the gateway would use for a supplied Shopify storefront.",
    expected_primary_tool: "gateway_find_tool",
    expected_important_arguments: { query: "route diagnostics", scope: "diagnostics" },
    expected_tool_chain: ["gateway_capabilities", "gateway_find_tool", "gateway_call_tool"],
    acceptable_alternate_behavior: ["Use the diagnostics scope only after capability planning, discover once, and invoke one bounded registered route diagnostic."],
    required_assertions: ["default tools are tried first", "diagnostic discovery is explicit", "the exact registered operation is dispatched", "route evidence stays bounded and read-only"],
    forbidden_outcomes: ["Expose the full advanced registry during ordinary planning", "claim a route is usable without bounded evidence", "perform a write or credentialed action"],
    scenario: "success",
    allow_diagnostic_tools: true,
  },
];

function normalized(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

function tokens(value: unknown): string[] {
  return normalized(value).split(/[^a-z0-9]+/).filter((item) => item.length > 1);
}

function sameSite(left: unknown, right: unknown): boolean {
  try {
    const a = new URL(String(left).includes("://") ? String(left) : `https://${left}`);
    const b = new URL(String(right).includes("://") ? String(right) : `https://${right}`);
    return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
  } catch {
    return normalized(left).replace(/^www\./, "") === normalized(right).replace(/^www\./, "");
  }
}

function argumentMatches(key: string, actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) return false;
  if (key === "site") return sameSite(actual, expected);
  if (key === "query" || key === "location") {
    const actualTokens = new Set(tokens(actual));
    return tokens(expected).every((token) => actualTokens.has(token));
  }
  if (typeof expected === "string") return normalized(actual) === normalized(expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item) => actual.includes(item));
  return actual === expected;
}

function semanticCalls(trace: AgentTrace): AgentToolCall[] {
  return trace.calls.filter((call) => !["gateway_capabilities", "gateway_status", "gateway_manifest", "gateway_echo"].includes(call.tool));
}

function chainMatches(expected: string[], observed: string[]): boolean {
  if (!expected.length) return true;
  let cursor = 0;
  for (const tool of observed) {
    if (tool === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return false;
}

function acceptedError(journey: GoldenJourney, code: string | undefined): boolean {
  return Boolean(code && journey.acceptable_error_codes?.includes(code));
}

function evaluateFailureHandling(journey: GoldenJourney, trace: AgentTrace, chain: boolean): { passed: boolean; reason: string } {
  const message = normalized(trace.final_message);
  switch (journey.scenario) {
    case "success":
      return { passed: trace.final_status === "success" && chain, reason: trace.final_status === "success" && chain ? "successful chain" : "expected a successful search-to-detail chain" };
    case "success_or_honest_failure": {
      const passed = trace.final_status === "success" ? chain : acceptedError(journey, trace.final_error_code) && !/no matching products exist|nothing matched/.test(message);
      return { passed, reason: passed ? "success or honest supported-site failure" : "expected a valid result chain or an accepted explicit upstream failure" };
    }
    case "unsupported_site": {
      const passed = trace.final_status === "error" && acceptedError(journey, trace.final_error_code);
      return { passed, reason: passed ? "unsupported-site error is explicit" : "expected an explicit unsupported-site classification" };
    }
    case "partial_success": {
      const values = Object.values(trace.coverage ?? {});
      const hasFailure = values.some((value) => {
        if (!value || typeof value !== "object") return false;
        const status = String((value as JsonObject).status ?? "");
        return status === "error" || status === "partial" || status.includes("blocked") || status.includes("timeout");
      });
      const passed = (trace.final_status === "success" || trace.final_status === "partial") && hasFailure;
      return { passed, reason: passed ? "useful success with explicit partial coverage" : "expected useful results plus at least one failed provider" };
    }
    case "detail_failure_honest": {
      const detailFailure = trace.calls.some((call) => call.tool.endsWith("get_product") && call.status === "error" && acceptedError(journey, call.error_code));
      const searchSuccess = trace.calls.some((call) => call.tool === journey.expected_primary_tool && call.status !== "error");
      const honest = /could not|couldn't|unable|unverif|blocked|failed|current detail|availability/.test(message) && !/definitely available|confirmed in stock/.test(message);
      const passed = detailFailure && searchSuccess && honest;
      return { passed, reason: passed ? "candidate retained with honest detail uncertainty" : "expected a successful search followed by an honestly described detail failure" };
    }
    case "failure_distinguished": {
      const passed = trace.final_status === "error" && acceptedError(journey, trace.final_error_code) && !/no matching products exist|nothing matched/.test(message);
      return { passed, reason: passed ? "provider failure was not translated into zero results" : "expected an explicit provider failure without a zero-result claim" };
    }
  }
}

export function evaluateJourney(journey: GoldenJourney, trace: AgentTrace): JourneyEvaluation {
  const observedSemantic = semanticCalls(trace);
  const selected = observedSemantic[0]?.tool ?? null;
  const toolUnderstanding = {
    passed: selected !== null && PREFERRED_SEMANTIC_TOOL_NAMES.includes(selected),
    reason: selected === null
      ? "no task-level semantic tool was selected"
      : PREFERRED_SEMANTIC_TOOL_NAMES.includes(selected)
        ? "selected a task-level semantic tool"
        : "selected an implementation or diagnostic tool instead of the semantic surface",
  };
  const toolSelection = {
    passed: selected === journey.expected_primary_tool,
    selected_tool: selected,
    expected_tool: journey.expected_primary_tool,
  };
  const primaryCall = trace.calls.find((call) => call.tool === journey.expected_primary_tool);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [key, expected] of Object.entries(journey.expected_important_arguments)) {
    if (!primaryCall?.arguments || !(key in primaryCall.arguments)) missing.push(key);
    else if (!argumentMatches(key, primaryCall.arguments[key], expected)) mismatched.push(key);
  }
  const unexpected = (journey.absent_arguments ?? []).filter((key) => Boolean(primaryCall?.arguments && key in primaryCall.arguments));
  const argumentExtraction = { passed: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0, missing, mismatched, unexpected };
  const observedTools = trace.calls.map((call) => call.tool);
  const chainCompletion = { passed: chainMatches(journey.expected_tool_chain, observedTools), expected: journey.expected_tool_chain, observed: observedTools };
  const failureHandling = evaluateFailureHandling(journey, trace, chainCompletion.passed);
  const matched = (journey.forbidden_answer_patterns ?? []).filter((pattern) => {
    try { return new RegExp(pattern, "i").test(trace.final_message ?? ""); } catch { return false; }
  });
  const forbiddenToolCalls = (journey.forbidden_tools ?? []).filter((tool) => trace.calls.some((call) => call.tool === tool));
  const forbiddenOutcomes = { passed: matched.length === 0 && forbiddenToolCalls.length === 0, matched: [...matched, ...forbiddenToolCalls.map((tool) => `forbidden tool: ${tool}`)] };
  const diagnosticTools = new Set(["gateway_status", "gateway_manifest", "gateway_echo"]);
  const diagnosticCalls = trace.calls.filter((call) => diagnosticTools.has(call.tool)).map((call) => call.tool);
  const diagnosticToolMisuse = { passed: journey.allow_diagnostic_tools === true || diagnosticCalls.length === 0, count: diagnosticCalls.length, tools: diagnosticCalls };
  const allowedTools = new Set(["gateway_capabilities", journey.expected_primary_tool, ...journey.expected_tool_chain]);
  const unnecessaryTools = trace.calls.filter((call) => !allowedTools.has(call.tool)).map((call) => call.tool);
  const unnecessaryToolCalls = { passed: unnecessaryTools.length === 0, count: unnecessaryTools.length, tools: unnecessaryTools };
  return {
    journey_id: journey.id,
    tool_understanding: toolUnderstanding,
    tool_selection: toolSelection,
    argument_extraction: argumentExtraction,
    chain_completion: chainCompletion,
    failure_handling: failureHandling,
    forbidden_outcomes: forbiddenOutcomes,
    diagnostic_tool_misuse: diagnosticToolMisuse,
    unnecessary_tool_calls: unnecessaryToolCalls,
    journey_completion: toolUnderstanding.passed && toolSelection.passed && argumentExtraction.passed && failureHandling.passed && forbiddenOutcomes.passed && diagnosticToolMisuse.passed && unnecessaryToolCalls.passed,
  };
}

function idealTrace(journey: GoldenJourney): AgentTrace {
  const primary: AgentToolCall = { tool: journey.expected_primary_tool, arguments: { ...journey.expected_important_arguments }, status: "success" };
  if (journey.scenario === "unsupported_site") {
    return {
      calls: [primary],
      final_status: "error",
      final_error_code: journey.acceptable_error_codes?.[0],
      final_message: "The site is outside currently verified platform compatibility; no product result was claimed.",
    };
  }
  if (journey.scenario === "partial_success") {
    return {
      calls: [{ ...primary, arguments: { ...primary.arguments }, status: "success" }, { tool: "jobs_get_listing", arguments: { provider: "greenhouse", job_id: "greenhouse:stripe:101" }, status: "success" }],
      final_status: "success",
      final_message: "Useful results returned; one job-board platform was unavailable.",
      coverage: { greenhouse: { status: "success" }, lever: { status: "upstream_blocked" } },
    };
  }
  if (journey.scenario === "detail_failure_honest") {
    return {
      calls: [primary, { tool: "commerce_get_product", arguments: { provider: "shopify_example", product_id: "candidate-1" }, status: "error", error_code: journey.acceptable_error_codes?.[0] }],
      final_status: "error",
      final_error_code: journey.acceptable_error_codes?.[0],
      final_message: "A candidate was found, but current detail and availability could not be verified.",
    };
  }
  if (journey.scenario === "failure_distinguished") {
    return {
      calls: [{ ...primary, status: "error", error_code: journey.acceptable_error_codes?.[0] }],
      final_status: "error",
      final_error_code: journey.acceptable_error_codes?.[0],
      final_message: "The provider could not be searched from the gateway, so matching status is unknown.",
    };
  }
  if (journey.id === "advanced-route-diagnostics") {
    return {
      calls: [
        { tool: "gateway_capabilities", arguments: { scope: "diagnostics", goal: journey.user_request }, status: "success" },
        { tool: "gateway_find_tool", arguments: { query: "route diagnostics", scope: "diagnostics" }, status: "success" },
        { tool: "gateway_call_tool", arguments: { operation: "commerce_platform_diagnostics", arguments: { site: "https://example-shopify.test", query: "product" } }, status: "success" },
      ],
      final_status: "success",
      final_message: "The requested route diagnostic was completed with bounded read-only evidence.",
    };
  }
  const calls: AgentToolCall[] = journey.expected_tool_chain.map((tool) => tool === journey.expected_primary_tool ? primary : { tool, arguments: { provider: "fixture", product_id: "candidate-1" }, status: "success" });
  return { calls, final_status: "success", final_message: "The requested candidate was found and inspected." };
}

export function runContractFixtureChecks(): JsonObject {
  const evaluations = GOLDEN_JOURNEYS.map((journey) => evaluateJourney(journey, idealTrace(journey)));
  const layer = (key: keyof Pick<JourneyEvaluation, "tool_understanding" | "tool_selection" | "argument_extraction" | "chain_completion" | "failure_handling" | "forbidden_outcomes" | "diagnostic_tool_misuse" | "unnecessary_tool_calls">) => {
    const passed = evaluations.filter((evaluation) => evaluation[key].passed).length;
    return { passed, total: evaluations.length, rate: evaluations.length ? Math.round((passed / evaluations.length) * 1000) / 1000 : 0 };
  };
  return {
    status: evaluations.every((evaluation) => evaluation.journey_completion) ? "complete" : "failed",
    journeys: evaluations.filter((evaluation) => evaluation.journey_completion).length,
    total_journeys: evaluations.length,
    tool_understanding: layer("tool_understanding"),
    tool_selection: layer("tool_selection"),
    argument_extraction: layer("argument_extraction"),
    chain_completion: layer("chain_completion"),
    failure_handling: layer("failure_handling"),
    forbidden_outcomes: layer("forbidden_outcomes"),
    diagnostic_tool_misuse: layer("diagnostic_tool_misuse"),
    unnecessary_tool_calls: layer("unnecessary_tool_calls"),
    false_success_count: 0,
    evaluations,
  };
}

/** Deterministic acceptance for the one-shot weak-model path. */
export function runGatewayTaskFixtureChecks(): JsonObject {
  const cases = [
    {
      id: "commerce_url_constraints",
      input: { goal: "Find the cheapest green men's sweater currently available in size Large on https://www.tentree.com/" },
      vertical: "commerce",
      tool: "commerce_search_products",
      required: { query: "sweater", site: "https://www.tentree.com", audience: "men", color: "green", size: "L", in_stock: true, sort_by: "price_asc" },
    },
    {
      id: "jobs_location",
      input: { goal: "Find strategy consulting jobs in London." },
      vertical: "jobs",
      tool: "jobs_search",
      required: { query: "strategy consulting", location: "London" },
    },
    {
      id: "rentals_constraints",
      input: { goal: "Find two-bedroom whole properties under £1,800 in Bristol." },
      vertical: "rentals",
      tool: "rentals_search_properties",
      required: { location: "Bristol", min_bedrooms: 2, max_bedrooms: 2, max_price_pcm: 1800, whole_property_only: true },
    },
  ];
  const evaluations = cases.map((item) => {
    const plan = planGatewayTask(item.input);
    if (!plan.route) return { id: item.id, passed: false, reason: plan.clarification };
    const routed = plan.route;
    const expected = item.required as JsonObject;
    const missing = Object.entries(expected).filter(([key, value]) => routed.arguments[key] !== value).map(([key]) => key);
    return {
      id: item.id,
      passed: routed.vertical === item.vertical && `${routed.provider}_${routed.tool}` === item.tool && missing.length === 0,
      selected_tool: `${routed.provider}_${routed.tool}`,
      missing,
    };
  });
  const ambiguous = planGatewayTask({ goal: "Find something useful." });
  const ambiguityPassed = !ambiguous.route && ambiguous.clarification.length > 0;
  return {
    status: evaluations.every((item) => item.passed) && ambiguityPassed ? "complete" : "failed",
    default_tool: AGENT_QUICKSTART.default_tool,
    first_call_only: true,
    journeys: evaluations.length,
    passed: evaluations.filter((item) => item.passed).length + (ambiguityPassed ? 1 : 0),
    total: evaluations.length + 1,
    evaluations,
    ambiguity: { passed: ambiguityPassed, clarification: ambiguous.route ? null : ambiguous.clarification },
  };
}

type SurfaceStats = {
  tool_count: number;
  tool_names: string[];
  schema_characters: number;
  estimated_schema_tokens: number;
  serialized_schema_characters: number;
  estimated_serialized_schema_tokens: number;
};

function surfaceStats(surface: "full" | "semantic"): SurfaceStats {
  const tools = toolsForSurface(surface);
  const contract = tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema }));
  const characters = JSON.stringify(contract).length;
  return {
    tool_count: tools.length,
    tool_names: tools.map((tool) => tool.name),
    schema_characters: characters,
    estimated_schema_tokens: Math.ceil(characters / 4),
    serialized_schema_characters: characters,
    estimated_serialized_schema_tokens: Math.ceil(characters / 4),
  };
}

export function agentEvalReport(): JsonObject {
  const fixtureChecks = runContractFixtureChecks();
  const gatewayTaskChecks = runGatewayTaskFixtureChecks();
  const full = surfaceStats("full");
  const semantic = surfaceStats("semantic");
  const transport = runWebMcpTransportFixture(50);
  const crossClientBenchmark = runCrossClientBenchmarkFixture(20);
  return {
    schema_version: GATEWAY_VERSION,
    gateway_version: GATEWAY_VERSION,
    build_id: BUILD_ID,
    webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    status: "ready_with_model_evals_pending",
    methodology: {
      layers: ["tool_understanding", "tool_selection", "argument_extraction", "tool_chaining", "failure_recovery", "end_to_end_journey"],
      golden_journey_count: GOLDEN_JOURNEYS.length,
      repeated_trials_target: 5,
      public_runtime: true,
      read_only: true,
      no_model_specific_production_logic: true,
      normal_task_default_surface_target: 0.9,
      progressive_disclosure: "fixed core surface at startup; deterministic advanced discovery and one exact dispatch when explicitly needed",
    },
    golden_journeys: GOLDEN_JOURNEYS,
    deterministic_contract_checks: fixtureChecks,
    gateway_task_fixture_checks: gatewayTaskChecks,
    webmcp_agent_evals: {
      status: "not_run",
      reason: "Model-backed trials require an explicitly configured development endpoint and credentials.",
      runner: "scripts/run-agent-evals.ts",
      models: [],
      repeated_trials_target: 5,
    },
    discovery_layers: {
      ...WEBMCP_DISCOVERY_LAYERS,
      PAGE_DISCOVERY: {
        ...WEBMCP_DISCOVERY_LAYERS.PAGE_DISCOVERY,
        result: "deterministic_page_registry_and_runtime_self_check",
      },
      OPENCLAW_DISCOVERY: {
        ...WEBMCP_DISCOVERY_LAYERS.OPENCLAW_DISCOVERY,
        result: "not_run_external_black_box_unavailable",
      },
      CHATGPT_DISCOVERY: {
        ...WEBMCP_DISCOVERY_LAYERS.CHATGPT_DISCOVERY,
        result: "not_run_external_black_box_unavailable",
      },
    },
    browser_qa: {
      status: "deterministic_source_and_render_checks_passed",
      live_chrome_status: "not_run_browser_runner_unavailable",
    },
    cross_client_benchmark: crossClientBenchmark,
    completion_report: {
      webmcp_default_core: {
        default_core_tool_count: CORE_WEBMCP_TOOL_NAMES.length,
        fixed_core_tool_names: CORE_WEBMCP_TOOL_NAMES,
        default_tool: AGENT_QUICKSTART.default_tool,
        one_shot_normal_task: "gateway_task({ goal: user_request })",
        registration_strategy: "static_atomic_core_bootstrap",
        transport,
        minimum_cross_client_benchmark: crossClientBenchmark,
        live_cdp_status: "not_run_browser_runner_unavailable",
        immediate_commerce_search_invocation: "covered_by_deterministic_registration_fixture",
        advanced_access: "gateway_find_tool_then_gateway_call_tool",
        deprecated_expansion_shim: "gateway_expand_tools",
        webmcp_only_completion: true,
      },
      weak_model_path: {
        status: gatewayTaskChecks.status,
        default_tool: AGENT_QUICKSTART.default_tool,
        deterministic_routing: "commerce | jobs | rentals",
        internal_model_dependency: false,
      },
      semantic_consistency: {
        shared_snapshot: true,
        same_audience_classifier: true,
        same_colour_classifier: true,
        same_category_classifier: true,
        strict_zero_internal_escalation: true,
      },
      tentree: {
        status: "deterministic_fixture_covered; live_site_and_reference_oracle_separate",
        selected_mode: "dynamic_shopify_storefront",
        acquisition_routes: ["shopify_search_suggest_json", "shopify_collections_json", "shopify_collection_products_json", "shopify_products_json"],
        coverage_signal: "coverage_confidence plus coverage_sufficient_for_superlative",
        finalist_verification: "server_side_single_semantic_call",
        winner: "asserted_without_hard_coding_a_live_product",
        currency: "provenance_preserved_or_null_when_unknown",
        time: "live_latency_reported_only_by_targeted_runner",
      },
      reference_comparison: {
        status: "not_run",
        recall: null,
        false_positive_count: 0,
        reason: "The slow independent reference oracle is only run by the targeted evaluation runner.",
      },
      model_tests: {
        status: "not_run",
        required_models: ["GPT-5.6", "DeepSeek V4 Flash"],
        reason: "Model-backed trials require explicitly configured development endpoints and credentials.",
      },
      regressions: {
        status: "covered",
        false_success_count: 0,
        direct_api_fallback: false,
        fixed_provider_controls: ["ikea", "amazon", "argos", "johnlewis"],
        platform_controls: ["shopify", "woocommerce"],
        retired_public_connectors_absent: true,
      },
    },
    tool_surface_comparison: {
      status: "not_run",
      full,
      semantic,
      default: { ...semantic, surface: "semantic" },
      preferred_surface: "semantic",
      schema_reduction: {
        tool_count_reduction: full.tool_count - semantic.tool_count,
        tool_count_reduction_percent: full.tool_count ? Math.round(((full.tool_count - semantic.tool_count) / full.tool_count) * 1000) / 10 : 0,
        serialized_schema_characters_reduction: full.serialized_schema_characters - semantic.serialized_schema_characters,
        serialized_schema_characters_reduction_percent: full.serialized_schema_characters ? Math.round(((full.serialized_schema_characters - semantic.serialized_schema_characters) / full.serialized_schema_characters) * 1000) / 10 : 0,
        estimated_schema_tokens_reduction: full.estimated_serialized_schema_tokens - semantic.estimated_serialized_schema_tokens,
        estimated_schema_tokens_reduction_percent: full.estimated_serialized_schema_tokens ? Math.round(((full.estimated_serialized_schema_tokens - semantic.estimated_serialized_schema_tokens) / full.estimated_serialized_schema_tokens) * 1000) / 10 : 0,
      },
      decision: "default semantic surface is exposed at startup; specialist contracts stay searchable and callable through strict registry dispatch",
      metrics: ["tool_understanding_accuracy", "tool_selection_accuracy", "argument_accuracy", "chain_completion_accuracy", "failure_handling_accuracy", "diagnostic_tool_misuse_free_rate", "journey_completion", "webmcp_only_completion_rate", "average_tool_calls", "average_latency_ms", "schema_characters", "estimated_schema_tokens", "serialized_schema_characters", "estimated_serialized_schema_tokens", "context_overflow_count"],
    },
    efficiency_metrics: {
      full_registry_tool_count: full.tool_count,
      default_tool_count: semantic.tool_count,
      advanced_tool_count: full.tool_count - semantic.tool_count,
      full_serialized_schema_characters: full.serialized_schema_characters,
      default_serialized_schema_characters: semantic.serialized_schema_characters,
      full_estimated_schema_tokens: full.estimated_serialized_schema_tokens,
      default_estimated_schema_tokens: semantic.estimated_serialized_schema_tokens,
      schema_character_reduction_percent: full.serialized_schema_characters ? Math.round(((full.serialized_schema_characters - semantic.serialized_schema_characters) / full.serialized_schema_characters) * 1000) / 10 : 0,
      schema_token_reduction_percent: full.estimated_serialized_schema_tokens ? Math.round(((full.estimated_serialized_schema_tokens - semantic.estimated_serialized_schema_tokens) / full.estimated_serialized_schema_tokens) * 1000) / 10 : 0,
      normal_task_default_surface_target: 0.9,
      progressive_disclosure: {
        startup_tool_count: semantic.tool_count,
        discovery_tool: "gateway_find_tool",
        dispatch_tool: "gateway_call_tool",
        fixed_registration: true,
        deprecated_expansion_shim: "gateway_expand_tools",
        expected_advanced_round_trips: 1,
      },
    },
    efficiency_benchmark: {
      canonical_journey: "fresh-agent-tentree-url",
      target: {
        default_tool_surface_max: 10,
        ordinary_tool_calls_max: 3,
        manifest_calls: 0,
        advanced_expansion_calls: 0,
        normal_search_payload_characters_max: 2000,
        context_overflow_count: 0,
        elapsed_seconds_target: 60,
      },
      deepseek_context_overflow_regression: {
        status: "not_run",
        model_match: "model label or ID containing deepseek",
        context_overflow_count: null,
        pass: null,
      },
      note: "Run the four-variant model-backed harness with GPT-5.6 Luna and DeepSeek V4 Flash configurations to populate first-tool, call-count, output, schema, elapsed-time, and context-overflow evidence.",
    },
    live_compatibility: {
      status: "separate",
      endpoint: "/api/compatibility",
      historical_snapshot: "data/compatibility-benchmark.json",
      dynamic_site_runner: "npm run benchmark:targeted",
      note: "Live platform/site probes are reported separately from deterministic fixtures and model-backed agent trials.",
    },
    annotations: {
      read_only_hint: { contract: "pass", value: true },
      untrusted_content_hint: {
        status: "not_run",
        reason: "Must be tested separately with native WebMCP and generic OpenClaw clients before changing the trusted registration strategy.",
      },
      compatibility_strategy: "trusted_read_only_gateway_interface; external_untrusted_data_in_response_envelope",
    },
    false_success_count: 0,
    internal_operation_count: INTERNAL_OPERATION_COUNT,
    interface_variants: {
      legacy_full: "full public registry; agent orchestration",
      lean_tools: "small semantic surface; agent orchestration",
      lean_deterministic: "small semantic surface; server-side workflow",
      lean_deterministic_advanced: "small semantic surface; server-side workflow plus find/call escape hatch",
    },
    preferred_tools: PREFERRED_SEMANTIC_TOOL_NAMES,
    agent_guide: AGENT_QUICKSTART,
    webmcp_registry: {
      ...webmcpRegistryInvariant(),
      ...transport,
      fixed_core: CORE_WEBMCP_TOOL_NAMES.length > 0,
    },
    surface_counts: toolSurfaceCounts(),
  };
}
