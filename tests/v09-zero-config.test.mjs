import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { executeConnectorRequest, gatewayCapabilities, gatewayManifest, gatewayStatus } = await import("../lib/gateway-server.ts");
const { TOOL_DEFINITIONS } = await import("../lib/gateway-contract.ts");
const { benchmarkExtraction, benchmarkSummary, recordExtractionBenchmark, resetBenchmark } = await import("../lib/extraction-benchmark.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

test("retired travel contracts are absent from the public registry", async () => {
  const result = await executeConnectorRequest("travel", "search_flights", {
    origin: "LHR", destination: "JFK", departure_date: "2026-11-05", adults: 1, max_results: 5, currency: "GBP", locale: "en-GB", timezone: "Europe/London",
  }, request());
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "CONNECTOR_UNAVAILABLE");
  assert.equal(result.body.execution.fallback.reason, "not_applicable");

  const manifest = await gatewayManifest();
  assert.equal(manifest.verticals.travel, undefined);
  assert.equal(manifest.verticals.commerce.providers.ikea.search, "online");
});

test("gateway capabilities gives agents a small planning response", () => {
  const commerce = gatewayCapabilities("commerce");
  assert.equal(commerce.status, "success");
  assert.equal(commerce.gateway_mode, "read_only");
  assert.equal(commerce.authentication_required, false);
  assert.equal(commerce.data.capabilities.commerce.recommended_tool, "commerce_search_products");
  assert.equal(commerce.data.capabilities.commerce.providers.ikea, "online");
  assert.equal(commerce.data.capabilities.commerce.providers.amazon, "degraded");
  assert.equal(commerce.data.capabilities.commerce.providers.ebay, undefined);
  assert.equal(commerce.data.capabilities.commerce.provider_details, undefined);
  assert.equal(gatewayCapabilities("not-a-capability").error.code, "INPUT_INVALID");
});

test("status and manifest expose the same read-only planning model", async () => {
  const status = await gatewayStatus();
  const manifest = await gatewayManifest();
  assert.equal(status.gateway_mode, "read_only");
  assert.equal(status.consequential_actions, false);
  assert.equal(status.source.trust, "gateway_interface");
  assert.equal(manifest.gateway_mode, "read_only");
  assert.equal(manifest.verticals.commerce.providers.ikea.status, "online");
  assert.equal(manifest.verticals.rentals.providers.openrent.status, "online");
  assert.equal(manifest.verticals.travel, undefined);
  assert.ok(manifest.tools.some((tool) => tool.tool === "gateway_capabilities"));
});

test("agent front door publishes a compact machine-readable brief", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /id="agent-gateway-brief"/);
  assert.match(source, /gateway_capabilities/);
  assert.match(source, /user_setup: "none"/);
  assert.match(source, /external_untrusted_data/);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.provider === "gateway").length, 9);
});

test("generic extraction benchmark measures framework state, completeness, chaining, and false-success boundaries", () => {
  resetBenchmark();
  const html = `<main id="__next"></main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products: [{ product_id: "p1", title: "Lamp", price: { amount: 49, currency: "GBP" }, canonical_url: "https://retailer.example/p1" }] } } })}</script>`;
  const row = benchmarkExtraction({
    provider: "fixture-retailer",
    surface: "search",
    html,
    records: [{ product_id: "p1", title: "Lamp", price: { amount: 49, currency: "GBP" }, canonical_url: "https://retailer.example/p1" }, { title: "Products" }],
    validRecords: [{ product_id: "p1", title: "Lamp", price: { amount: 49, currency: "GBP" }, canonical_url: "https://retailer.example/p1" }],
    expectedId: "p1",
    idField: "product_id",
  });
  assert.ok(row.frameworks_detected.includes("nextjs"));
  assert.ok(row.embedded_state_kinds.includes("next_data"));
  assert.equal(row.field_completeness.price, 1);
  assert.equal(row.id_chain, "verified");
  assert.equal(row.false_success_count, 1);
  recordExtractionBenchmark(row);
  assert.equal(benchmarkSummary().false_success_count, 1);
});
