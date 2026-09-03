import assert from "node:assert/strict";
import test from "node:test";

const {
  GATEWAY_VERSION,
  INTERNAL_OPERATION_COUNT,
  PREFERRED_SEMANTIC_TOOL_NAMES,
  RETIRED_PUBLIC_CONNECTOR_IDS,
  TOOL_DEFINITIONS,
  toolSurfaceCounts,
  toolsForSurface,
} = await import("../lib/gateway-contract.ts");
const { gatewayCallTool, gatewayFindTool } = await import("../lib/gateway-server.ts");
const { gatewayCapabilities } = await import("../lib/gateway-server.ts");
const { compactResponseData, successEnvelope } = await import("../lib/gateway-runtime.ts");
const { validateToolInput } = await import("../lib/gateway-validation.ts");

function request() {
  return new Request("https://gateway.example/api/call-tool");
}

test("v0.13.0 keeps the public surface small while adding the one-shot default", () => {
  assert.equal(GATEWAY_VERSION, "0.13.2");
  assert.deepEqual(toolSurfaceCounts(), { full: 24, semantic: 10, advanced: 14 });
  assert.equal(INTERNAL_OPERATION_COUNT >= 31, true);
  assert.deepEqual(toolsForSurface("semantic").map((tool) => tool.name), PREFERRED_SEMANTIC_TOOL_NAMES);
  assert.ok(PREFERRED_SEMANTIC_TOOL_NAMES.includes("gateway_find_tool"));
  assert.ok(PREFERRED_SEMANTIC_TOOL_NAMES.includes("gateway_call_tool"));
  assert.equal(TOOL_DEFINITIONS.some((tool) => RETIRED_PUBLIC_CONNECTOR_IDS.has(tool.provider)), false);
});

test("advanced discovery is deterministic, scoped, and metadata-only", () => {
  const input = { query: "inspect the Shopify routes used for a dynamic storefront", scope: "commerce" };
  const first = gatewayFindTool(input);
  const second = gatewayFindTool(input);
  assert.deepEqual(first.matches, second.matches);
  assert.equal(first.matches[0].operation, "commerce_platform_diagnostics");
  assert.equal(first.matches.some((match) => Object.hasOwn(match, "input_schema")), false);
  assert.equal(first.matches.some((match) => match.operation.startsWith("eventbrite_") || match.operation.startsWith("ebay_")), false);
  assert.equal(JSON.stringify(first).length < 2_000, true);
});

test("an empty capabilities request is a small navigation map", () => {
  const result = gatewayCapabilities();
  assert.equal(JSON.stringify(result).length < 2_000, true);
  assert.deepEqual(result.data.navigation, {
    commerce: "commerce_search_products",
    rentals: "rentals_search_properties",
    jobs: "jobs_search",
    advanced: "gateway_find_tool",
  });
  assert.equal(result.data.capabilities.commerce, undefined);
});

test("generic dispatch uses exact registered operations and rejects arbitrary execution", async () => {
  const echo = await gatewayCallTool("gateway_echo", { message: "hello" }, request());
  assert.equal(echo.status, 200);
  assert.equal(echo.body.status, "success");
  assert.equal(echo.body.data.received, "hello");

  const unknown = await gatewayCallTool("fetch_url", { url: "https://example.com" }, request());
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "UNKNOWN_OPERATION");
  assert.equal(unknown.body.answer_ready, false);
  assert.equal(unknown.body.next_action, null);

  const invalid = await gatewayCallTool("commerce_search_products", { url: "https://example.com" }, request());
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "INPUT_INVALID");
  assert.equal(invalid.body.error.agent_action, "stop");
});

test("response formats keep concise output small and expose richer fields only on request", () => {
  const data = {
    query: "green sweater",
    results: [{
      provider: "fixture",
      product_id: "s-1",
      title: "Green sweater",
      price: { amount: 30, currency: "GBP" },
      variants: [{ id: "v-1", option1: "Green", option2: "L", available: true }],
      diagnostics: { route: "hidden" },
    }],
    diagnostics: { route: "hidden" },
  };
  const concise = compactResponseData("commerce", "search_products", data, {});
  const detailed = compactResponseData("commerce", "search_products", data, { response_format: "detailed" });
  const diagnostic = compactResponseData("commerce", "search_products", data, { response_format: "diagnostic" });
  assert.equal(concise.response_format, "concise");
  assert.equal(concise.results[0].variants, undefined);
  assert.equal(concise.diagnostics, undefined);
  assert.equal(detailed.results[0].variants[0].option2, "L");
  assert.equal(detailed.diagnostics, undefined);
  assert.ok(diagnostic.diagnostics);
});

test("common human parameter values normalize before strict validation", () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "commerce_search_products");
  const validated = validateToolInput(definition, { query: "sweater", audience: "men's", size: "large" });
  assert.equal(validated.audience, "men");
  assert.equal(validated.size, "L");
});

test("unverified searches return a precise retry action and never a vague instruction", () => {
  const envelope = successEnvelope("commerce", "search_products", "gw_fixture", new Date().toISOString(), {
    data: { query: "product", results: [], providers: { tentree: { status: "error", code: "UPSTREAM_TIMEOUT" } } },
    sourceUrl: "https://gateway.example",
    mode: "public_http",
  }, { query: "product", max_results: 3 });
  assert.equal(envelope.answer_ready, false);
  assert.equal(envelope.data.answer_ready, false);
  assert.deepEqual(envelope.data.next_action, {
    tool: "commerce_search_products",
    arguments: { query: "product", max_results: 3 },
    reason: "Retry once or report provider failure; do not infer zero results from an unavailable source.",
    agent_action: "retry_once",
  });
});
