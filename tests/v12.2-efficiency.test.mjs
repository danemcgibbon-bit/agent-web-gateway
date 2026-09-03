import assert from "node:assert/strict";
import test from "node:test";

const {
  GATEWAY_EXPANSION_SCOPES,
  CONNECTORS,
  PREFERRED_SEMANTIC_TOOL_NAMES,
  RETIRED_PUBLIC_CONNECTOR_IDS,
  TOOL_DEFINITIONS,
  toolSurfaceCounts,
  toolsForExpansionScope,
  toolsForSurface,
} = await import("../lib/gateway-contract.ts");
const { executeConnectorRequest, gatewayCapabilities } = await import("../lib/gateway-server.ts");
const { compactResponseData, successEnvelope } = await import("../lib/gateway-runtime.ts");
const { registerWebMcpTools } = await import("../lib/webmcp-bootstrap.ts");
const { resetCompatibilityCaches } = await import("../lib/compatibility.ts");

test("the default surface is lean and advanced scopes are explicit", async () => {
  assert.deepEqual(toolSurfaceCounts(), { full: 24, semantic: 10, advanced: 14 });
  assert.deepEqual(toolsForSurface("semantic").map((tool) => tool.name), PREFERRED_SEMANTIC_TOOL_NAMES);
  assert.equal(toolsForExpansionScope("diagnostics").some((tool) => tool.name === "gateway_status"), true);
  assert.equal(toolsForExpansionScope("diagnostics").some((tool) => tool.name === "commerce_search_products"), false);
  assert.equal(toolsForExpansionScope("rentals").length, 0);
  assert.ok(Object.keys(GATEWAY_EXPANSION_SCOPES).includes("compatibility"));
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.surface === "advanced").length, 14);
});

test("the public registry omits providers without a usable route", async () => {
  const retired = [...RETIRED_PUBLIC_CONNECTOR_IDS];
  assert.deepEqual(retired.sort(), ["booking", "ebay", "eventbrite", "rail", "travel"]);
  assert.ok(CONNECTORS.every((connector) => !RETIRED_PUBLIC_CONNECTOR_IDS.has(connector.id)));
  const manifest = await (await import("../lib/gateway-server.ts")).gatewayManifest();
  const names = manifest.tools.map((tool) => tool.tool);
  for (const prefix of ["booking_", "ebay_", "eventbrite_", "rail_", "travel_"]) {
    assert.ok(names.every((name) => !name.startsWith(prefix)), prefix);
  }
  assert.equal(manifest.verticals.travel, undefined);
  assert.equal(manifest.verticals.rentals.providers.airbnb, undefined);
  assert.equal(manifest.verticals.rentals.providers.rightmove, undefined);
  assert.equal(manifest.verticals.rentals.providers.zoopla, undefined);
});

test("cold registration exposes only the default and expansion adds one scope", async () => {
  const visible = [];
  const modelContext = {
    registerTool(tool) { visible.push(tool.name); },
    getTools() { return visible.map((name) => ({ name })); },
  };
  await registerWebMcpTools(modelContext, toolsForSurface("semantic"), PREFERRED_SEMANTIC_TOOL_NAMES);
  assert.deepEqual(visible, PREFERRED_SEMANTIC_TOOL_NAMES);
  const advanced = toolsForExpansionScope("diagnostics").map((tool) => ({ name: tool.name }));
  await registerWebMcpTools(modelContext, advanced, []);
  assert.deepEqual(visible.slice(-advanced.length), advanced.map((tool) => tool.name));
});

test("capabilities is a compact goal guide with an explicit next action", () => {
  const result = gatewayCapabilities({ goal: "Find strategy jobs in London", capability: "all" });
  assert.equal(result.status, "success");
  assert.equal(result.data.scope, "jobs");
  assert.equal(result.data.capabilities.jobs.recommended_tool, "jobs_search");
  assert.equal(result.data.recommended_next_action.tool, "jobs_search");
  assert.ok(Array.isArray(result.data.recipes));
  assert.equal(result.data.capabilities.jobs.provider_details, undefined);
});

test("normal search envelopes expose decision state without variants or diagnostics", () => {
  const data = {
    query: "green sweater",
    results: [{ provider: "fixture", product_id: "s-1", title: "Green sweater", price: { amount: 30, currency: "GBP" }, variants: [{ id: "v-1" }] }],
    diagnostics: { route: "hidden" },
  };
  const compact = compactResponseData("commerce", "search_products", data, { max_results: 5 });
  assert.equal(compact.diagnostics, undefined);
  assert.equal(compact.results[0].variants, undefined);
  const envelope = successEnvelope("commerce", "search_products", "gw_v122", new Date().toISOString(), {
    data,
    sourceUrl: "https://fixture.example/search",
    mode: "public_http",
  }, { max_results: 5 });
  assert.equal(envelope.data.answer_state, "exact_matches");
  assert.equal(envelope.data.answer_ready, true);
  assert.deepEqual(envelope.data.exact_matches[0], { provider: "fixture", product_id: "s-1" });
  assert.equal(envelope.data.next_action, null);
});

test("commerce search classifies no-exact-match and returns closest failed constraints", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "closest-shopify-v122.example";
  const products = [
    { id: 1, handle: "womens-blue-sweater", title: "Women's blue sweater", variants: [{ id: 11, option1: "Blue", option2: "M", price: "25.00", available: true }] },
    { id: 2, handle: "mens-black-sweater", title: "Men's black sweater", variants: [{ id: 21, option1: "Black", option2: "L", price: "28.00", available: true }] },
    { id: 3, handle: "mens-green-sweater", title: "Men's green sweater", variants: [{ id: 31, option1: "Green", option2: "S", price: "22.00", available: true }] },
  ];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== host) throw new Error(`unexpected host ${url.hostname}`);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    if (url.pathname === "/") return new Response('<html><head><link href="https://cdn.shopify.com/theme.css"></head><body><script>window.Shopify = { shop: "closest" };</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return new Response(JSON.stringify({ resources: { results: { products } } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/products.json" || url.pathname === "/wp-json/") return new Response("not found", { status: 404 });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: host,
      query: "sweater",
      audience: "men",
      color: "green",
      size: "L",
      in_stock: true,
      max_results: 5,
    }, new Request("https://gateway.example/api/execute"));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.answer_state, "no_exact_match");
    assert.equal(result.body.data.answer_ready, true);
    assert.deepEqual(result.body.data.exact_matches, []);
    assert.ok(result.body.data.closest_matches.length > 0);
    assert.ok(result.body.data.failed_constraints.some((value) => ["audience", "color", "size"].includes(value)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
