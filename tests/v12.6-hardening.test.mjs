import assert from "node:assert/strict";
import test from "node:test";

const {
  CORE_WEBMCP_TOOL_NAMES,
  getToolDefinition,
  RETIRED_PUBLIC_CONNECTOR_IDS,
  webmcpRegistryInvariant,
  toolsForSurface,
} = await import("../lib/gateway-contract.ts");
const { executeConnectorRequest, gatewayFindTool, gatewayManifest } = await import("../lib/gateway-server.ts");
const {
  classifyCompatibilityAudience,
  classifyCompatibilityCategoryFamily,
  classifyCompatibilityColorFamily,
  createStoreSnapshot,
  normalizeCompatibilityProducts,
  resetCompatibilityCaches,
  snapshotCandidates,
  snapshotSummary,
} = await import("../lib/compatibility.ts");
const { runWebMcpTransportFixture } = await import("../lib/webmcp-bootstrap.ts");

test("v0.13.0 exposes one fixed ten-tool WebMCP registry", async () => {
  assert.deepEqual(toolsForSurface("semantic").map((tool) => tool.name), CORE_WEBMCP_TOOL_NAMES);
  assert.deepEqual(webmcpRegistryInvariant(), {
    expected_core_tools: 10,
    registered_core_tools: 10,
    expected_core_tool_names: CORE_WEBMCP_TOOL_NAMES,
    registered_core_tool_names: CORE_WEBMCP_TOOL_NAMES,
    registry_match: true,
  });
  assert.equal(getToolDefinition("gateway_expand_tools")?.deprecated, true);
  assert.equal(gatewayFindTool({ query: "expand advanced tools", scope: "all" }).matches.some((match) => match.operation === "gateway_expand_tools"), false);
  assert.deepEqual([...RETIRED_PUBLIC_CONNECTOR_IDS].sort(), ["booking", "ebay", "eventbrite", "rail", "travel"]);

  const manifest = await gatewayManifest("semantic");
  assert.deepEqual(manifest.webmcp.expected_core_tool_names, CORE_WEBMCP_TOOL_NAMES);
  assert.equal(manifest.webmcp.registry_match, true);
  assert.deepEqual(manifest.webmcp.registration_order, CORE_WEBMCP_TOOL_NAMES);
});

test("the cold transport fixture passes the immediate no-rediscovery sequence", () => {
  const report = runWebMcpTransportFixture(50);
  assert.equal(report.fresh_sessions, 50);
  assert.equal(report.first_discovery_successes, 50);
  assert.equal(report.core_registry_complete, 50);
  assert.equal(report.first_gateway_task_invocation_successes, 50);
  assert.equal(report.first_commerce_invocation_successes, 50);
  assert.equal(report.commerce_get_product_invocation_successes, 50);
  assert.equal(report.find_tool_invocation_successes, 50);
  assert.equal(report.call_tool_invocation_successes, 50);
  assert.equal(report.target_survival, 50);
  assert.equal(report.rediscoveries_required, 0);
  assert.equal(report.stale_target_failures, 0);
  assert.equal(report.delayed_registration_failures, 0);
  assert.equal(report.tool_not_discovered_errors, 0);
  assert.equal(typeof report.registration_latency_ms.avg, "number");
  assert.equal(typeof report.ttfsi_ms.avg, "number");
});

test("semantic and diagnostic fixture views share one normalized snapshot and classifiers", () => {
  const provider = {
    id: "tentree-fixture.example",
    name: "Tentree fixture",
    domain: "tentree-fixture.example",
    base_url: "https://tentree-fixture.example",
    engine: "shopify",
    categories: ["fashion"],
    keywords: ["sweater"],
    enabled: true,
    dynamic: true,
    site_origin: "https://tentree-fixture.example",
  };
  const [hudson] = normalizeCompatibilityProducts({ products: [{
    id: "hudson",
    handle: "mens-hudson-green-sweater",
    title: "Hudson Green Sweater",
    product_type: "Sweater",
    collections: ["Men's Sweaters"],
    tags: ["green", "knit"],
    options: [{ name: "Color" }, { name: "Size" }],
    variants: [{ id: "hudson-l", option1: "Forest Green", option2: "L", price: "78.00", available: true }],
    url: "/products/mens-hudson-green-sweater",
  }] }, provider);
  assert.equal(hudson.audience, "men");
  assert.equal(hudson.color_family, "green");
  assert.equal(hudson.category_family, "sweater");

  const snapshot = createStoreSnapshot(provider, [hudson], {
    coverage_level: "complete_for_query",
    source_url: "https://tentree-fixture.example/search",
    acquisition_tier: "fixture",
    network_requests: 1,
    routes: ["fixture_snapshot"],
    search_query: "sweater",
  });
  const semanticQualifiers = snapshotCandidates(snapshot, "sweater").filter((candidate) => (
    classifyCompatibilityAudience(candidate) === "men"
    && classifyCompatibilityColorFamily(candidate.color_family ?? candidate.color) === "green"
    && classifyCompatibilityCategoryFamily(candidate) === "sweater"
  ));
  const diagnosticView = {
    ...snapshotSummary(snapshot),
    exact_matches: semanticQualifiers.map((candidate) => ({ provider: candidate.provider, product_id: candidate.product_id })),
  };
  assert.deepEqual(diagnosticView.exact_matches, [{ provider: "tentree-fixture.example", product_id: "mens-hudson-green-sweater" }]);
  assert.equal(diagnosticView.search_context, snapshot.id);
  assert.equal(diagnosticView.coverage_level, "complete_for_query");
});

test("the diagnostic route exposes the semantic call's shared snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const host = "shared-snapshot-shop.example";
  const product = {
    id: "hudson",
    handle: "mens-hudson-green-sweater",
    title: "Hudson Green Sweater",
    product_type: "Sweater",
    collections: ["Men's Sweaters"],
    tags: ["green", "knit"],
    options: [{ name: "Color" }, { name: "Size" }],
    variants: [{ id: "hudson-l", option1: "Forest Green", option2: "L", price: "78.00", available: true }],
    url: `/products/mens-hudson-green-sweater`,
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200 });
    if (url.pathname === "/") return new Response('<html><body><script>window.Shopify={shop:"shared"}</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [product] } } });
    if (url.pathname === "/products.json") return json({ products: [product] });
    if (url.pathname === "/wp-json/") return json({}, 404);
    if (url.pathname === "/products/mens-hudson-green-sweater.js") return json(product);
    return json({}, 404);
  };
  try {
    const semantic = await gatewayManifest({ surface: "semantic", site: host, query: "sweater" });
    const route = semantic.route_diagnostics;
    assert.equal(route.status, "reachable");
    assert.equal(route.shared_snapshot.records, 1);
    assert.equal(route.shared_snapshot.coverage_level, "bounded_partial");
    assert.deepEqual(route.shared_snapshot.exact_matches, [{ provider: host, product_id: "mens-hudson-green-sweater" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("suspicious strict zero escalates acquisition without relaxing constraints", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "strict-zero-shop.example";
  const women = {
    id: "women",
    handle: "womens-green-sweater",
    title: "Women's Green Sweater",
    product_type: "Sweater",
    options: [{ name: "Color" }, { name: "Size" }],
    variants: [{ id: "women-l", option1: "Green", option2: "L", price: "60.00", available: true }],
    url: "/products/womens-green-sweater",
  };
  const men = {
    id: "men",
    handle: "mens-green-sweater",
    title: "Men's Green Sweater",
    product_type: "Sweater",
    collections: ["Men's Sweaters"],
    options: [{ name: "Color" }, { name: "Size" }],
    variants: [{ id: "men-l", option1: "Green", option2: "L", price: "62.00", available: true }],
    url: "/products/mens-green-sweater",
  };
  let catalogueRequests = 0;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200 });
    if (url.pathname === "/") return new Response('<html><body><script>window.Shopify={shop:"strict-zero"}</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [women] } } });
    if (url.pathname === "/collections.json") return json({ collections: [] });
    if (url.pathname === "/products.json") {
      if (url.searchParams.get("limit") === "1") return json({ products: [women] });
      catalogueRequests += 1;
      return catalogueRequests <= 4 ? json({}, 404) : json({ products: [men] });
    }
    if (url.pathname === "/products/mens-green-sweater.js") return json(men);
    if (url.pathname === "/products/womens-green-sweater.js") return json(women);
    if (url.pathname === "/wp-json/") return json({}, 404);
    return json({}, 404);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: host,
      query: "sweater",
      audience: "men",
      color: "green",
      max_results: 5,
      include_diagnostics: true,
    }, new Request("https://gateway.example/api/execute"));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.intent.audience, "men");
    assert.equal(result.body.data.diagnostics.escalation.attempted, false, JSON.stringify(result.body.data));
    assert.equal(result.body.data.diagnostics.escalation.status, "not_needed");
    assert.equal(result.body.data.results.length, 1);
    assert.match(result.body.data.results[0].title, /Men's/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
