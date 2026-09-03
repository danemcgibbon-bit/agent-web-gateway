import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest } = await import("../lib/gateway-server.ts");
const { resetCompatibilityCaches } = await import("../lib/compatibility.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function product() {
  return {
    id: 1701,
    handle: "mens-green-sweater",
    title: "Men's Green Cotton Sweater",
    variants: [{ id: 17011, option1: "Green", option2: "L", price: "34.00", available: true }],
    url: "/products/mens-green-sweater",
  };
}

test("a challenged homepage does not prevent Shopify search-route detection", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, query: url.search });
    assert.equal(url.hostname, "www.tentree.com");
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response("automated access verification", { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") {
      assert.equal(url.searchParams.get("q"), "sweater");
      assert.equal(url.searchParams.get("resources[type]"), "product");
      assert.equal(url.searchParams.get("resources[options][unavailable_products]"), "hide");
      return json({ resources: { results: { products: [product()] } } });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: "https://www.tentree.com",
      query: "sweater",
      max_results: 5,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.platform, "shopify");
    assert.equal(result.body.data.results[0].product_id, "mens-green-sweater");
    const attempts = result.body.data.diagnostics.provider_selection.probe_attempts;
    assert.equal(attempts.find((attempt) => attempt.route === "homepage").status, "blocked");
    assert.equal(attempts.find((attempt) => attempt.route === "shopify_search_suggest_json").status, "success");
    assert.equal(result.body.data.diagnostics.provider_selection.selected_probe.route, "shopify_search_suggest_json");
    assert.equal(result.body.execution.provenance.platform, "shopify");
    assert.equal(calls[0].path, "/robots.txt");
    assert.ok(calls.some((call) => call.path === "/search/suggest.json"));
    assert.ok(!Object.values(attempts).some((attempt) => Object.hasOwn(attempt, "value")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("route-level Shopify failures remain distinct from a detected platform", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "blocked-shop.example");
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response("automated access verification", { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return new Response("blocked", { status: 403 });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { site: "https://blocked-shop.example", query: "sweater" }, request());
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, "UPSTREAM_BLOCKED");
    assert.equal(result.body.error.details.platform_detected, null);
    assert.equal(result.body.error.details.probe_attempts.find((attempt) => attempt.route === "shopify_search_suggest_json").response_classification, "ROUTE_BLOCKED");
    assert.equal(result.body.error.details.probe_attempts.find((attempt) => attempt.route === "shopify_search_suggest_json").http_status, 403);
    assert.ok(!Object.values(result.body.error.details.probe_attempts).some((attempt) => Object.hasOwn(attempt, "response_body") || Object.hasOwn(attempt, "value")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
