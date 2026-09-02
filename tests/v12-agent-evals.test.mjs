import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  AGENT_QUICKSTART,
  GATEWAY_VERSION,
  PREFERRED_SEMANTIC_TOOL_NAMES,
  TOOL_DEFINITIONS,
  toolSurface,
  toolSurfaceCounts,
  toolsForSurface,
} = await import("../lib/gateway-contract.ts");
const {
  GOLDEN_JOURNEYS,
  agentEvalReport,
  evaluateJourney,
  runContractFixtureChecks,
  runGatewayTaskFixtureChecks,
} = await import("../lib/agent-evals.ts");
const { compactResponseData, successEnvelope } = await import("../lib/gateway-runtime.ts");
const { gatewayManifest } = await import("../lib/gateway-server.ts");
const { GET } = await import("../app/api/agent-evals/route.ts");

test("v0.13.0 keeps the active registry and exposes a one-shot default tier", async () => {
  assert.equal(GATEWAY_VERSION, "0.13.2");
  assert.equal(TOOL_DEFINITIONS.length, 24);
  assert.deepEqual(toolSurfaceCounts(), { full: 24, semantic: 10, advanced: 14 });
  assert.equal(PREFERRED_SEMANTIC_TOOL_NAMES.length, 10);
  assert.deepEqual(toolsForSurface("semantic").map((tool) => tool.name), PREFERRED_SEMANTIC_TOOL_NAMES);
  assert.ok(toolsForSurface("semantic").every((tool) => tool.surface === "semantic"));
  assert.ok(TOOL_DEFINITIONS.filter((tool) => tool.surface === "advanced").length > 0);
  assert.ok(TOOL_DEFINITIONS.filter((tool) => toolSurface(tool.name) === "advanced").length > 0);

  const full = await gatewayManifest();
  const semantic = await gatewayManifest("semantic");
  assert.equal(full.surface, "full");
  assert.equal(full.tools.length, 24);
  assert.equal(semantic.surface, "semantic");
  assert.equal(semantic.tools.length, 10);
  assert.ok(semantic.tools.every((tool) => tool.surface === "semantic"));
  assert.equal(semantic.compatibility, undefined);
});

test("tool and parameter descriptions remain compact and user-goal oriented", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description.length <= 500, `${tool.name} description is too long`);
    const properties = tool.inputSchema.properties ?? {};
    for (const [name, property] of Object.entries(properties)) {
      if (typeof property.description === "string") assert.ok(property.description.length <= 150, `${tool.name}.${name} description is too long`);
    }
  }
});

test("the permanent golden journey contract checks cover all required layers", () => {
  assert.ok(GOLDEN_JOURNEYS.length >= 10);
  const report = runContractFixtureChecks();
  assert.equal(report.status, "complete");
  assert.equal(report.journeys, GOLDEN_JOURNEYS.length);
  assert.equal(report.false_success_count, 0);
  for (const key of ["tool_understanding", "tool_selection", "argument_extraction", "chain_completion", "failure_handling", "forbidden_outcomes", "diagnostic_tool_misuse"]) {
    assert.equal(report[key].rate, 1, key);
  }
});

test("failure journeys require honest uncertainty rather than a fabricated success", () => {
  const detailJourney = GOLDEN_JOURNEYS.find((journey) => journey.id === "mid-chain-detail-failure");
  assert.ok(detailJourney);
  const detail = evaluateJourney(detailJourney, {
    calls: [
      { tool: "commerce_search_products", arguments: { query: "product" }, status: "success" },
      { tool: "commerce_get_product", arguments: { provider: "shopify_example", product_id: "candidate-1" }, status: "error", error_code: "UPSTREAM_BLOCKED" },
    ],
    final_status: "error",
    final_error_code: "UPSTREAM_BLOCKED",
    final_message: "A candidate was found, but current detail and availability could not be verified.",
  });
  assert.equal(detail.journey_completion, true);

  const zeroJourney = GOLDEN_JOURNEYS.find((journey) => journey.id === "zero-results-vs-provider-failure");
  assert.ok(zeroJourney);
  const zero = evaluateJourney(zeroJourney, {
    calls: [{ tool: "commerce_search_products", arguments: { query: "product" }, status: "error", error_code: "UPSTREAM_BLOCKED" }],
    final_status: "error",
    final_error_code: "UPSTREAM_BLOCKED",
    final_message: "The provider could not be searched, so matching status is unknown.",
  });
  assert.equal(zero.journey_completion, true);
});

test("normal search payloads omit route diagnostics but retain detail actions", () => {
  const data = {
    query: "lamp",
    results: [{
      provider: "commerce_fixture",
      product_id: "lamp-1",
      title: "Fixture Lamp",
      price: { amount: 20, currency: "GBP" },
      canonical_url: "https://fixture.example/products/lamp-1",
      variants: [{ id: 1, option1: "Large", option2: "Green" }],
      ignored_internal_field: "should not cross the compact boundary",
    }],
    diagnostics: { provider_diagnostics: { huge: "route evidence" } },
  };
  const compact = compactResponseData("commerce", "search_products", data, { max_results: 5 });
  assert.equal(compact.diagnostics, undefined);
  assert.equal(compact.diagnostics_available, true);
  assert.equal(compact.results[0].ignored_internal_field, undefined);
  assert.equal(compact.results[0].variants, undefined);
  const envelope = successEnvelope("commerce", "search_products", "gw_fixture", new Date().toISOString(), {
    data,
    sourceUrl: "https://fixture.example/search",
    mode: "public_http",
    outcome: "SUCCESS",
  }, { max_results: 5 });
  assert.equal(envelope.data.results[0].actions.detail.tool, "commerce_get_product");
  const verbose = compactResponseData("commerce", "search_products", data, { include_diagnostics: true });
  assert.ok(verbose.diagnostics);
});

test("the public quality report is machine-readable and separates model evidence", async () => {
  const report = agentEvalReport();
  assert.equal(report.schema_version, "0.13.2");
  assert.equal(report.golden_journeys.length, 18);
  assert.equal(report.deterministic_contract_checks.false_success_count, 0);
  assert.equal(report.webmcp_agent_evals.status, "not_run");
  assert.equal(report.live_compatibility.status, "separate");
  assert.equal(report.completion_report.webmcp_default_core.webmcp_only_completion, true);
  const response = await GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tool_surface_comparison.semantic.tool_count, 10);
  assert.equal(body.tool_surface_comparison.default.tool_count, 10);
  assert.ok(body.tool_surface_comparison.schema_reduction.serialized_schema_characters_reduction > 0);
  assert.equal(body.efficiency_metrics.progressive_disclosure.fixed_registration, true);
  assert.equal(body.efficiency_metrics.progressive_disclosure.deprecated_expansion_shim, "gateway_expand_tools");
});

test("the one-shot guide and deterministic task fixtures stay aligned", () => {
  assert.equal(AGENT_QUICKSTART.default_tool, "gateway_task");
  assert.deepEqual(Object.values(AGENT_QUICKSTART.specialist_tools), ["commerce_search_products", "jobs_search", "rentals_search_properties"]);
  const report = runGatewayTaskFixtureChecks();
  assert.equal(report.status, "complete");
  assert.equal(report.passed, report.total);
});

test("production registration remains read-only while untrusted content stays an envelope boundary", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /annotations: \{ readOnlyHint: true \}/);
  assert.doesNotMatch(source, /untrustedContentHint/);
  assert.match(JSON.stringify(agentEvalReport()), /external_untrusted_data_in_response_envelope/);
});
