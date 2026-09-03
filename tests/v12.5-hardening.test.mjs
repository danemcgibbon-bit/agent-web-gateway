import assert from "node:assert/strict";
import test from "node:test";

const { GATEWAY_VERSION, PREFERRED_SEMANTIC_TOOL_NAMES } = await import("../lib/gateway-contract.ts");
const { executeConnectorRequest } = await import("../lib/gateway-server.ts");
const { normalizeCompatibilityProducts, resetCompatibilityCaches } = await import("../lib/compatibility.ts");
const { classifyCommerceSearchObjective, expandCommerceQueries } = await import("../connectors/commerce/index.ts");
const { registerWebMcpTools } = await import("../lib/webmcp-bootstrap.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
}

function product(host, handle, title, amount, color = "Forest Green") {
  return {
    id: handle,
    handle,
    title,
    currency_code: "USD",
    options: [{ name: "Color", values: [color] }, { name: "Size", values: ["L"] }],
    variants: [{ id: `${handle}-l`, option1: color, option2: "L", price: amount.toFixed(2), available: true }],
    url: `/products/${handle}`,
    images: [{ src: `https://${host}/cdn/${handle}.jpg` }],
  };
}

test("v0.13.0 classifies objectives and keeps expansion deterministic", () => {
  assert.equal(GATEWAY_VERSION, "0.13.2");
  assert.equal(classifyCommerceSearchObjective({ query: "cheapest green men's sweater", sort_by: "price_asc" }, { max_price: null, audience: "men", color: "green", size: null, in_stock: null }), "exhaustive_ranked");
  assert.equal(classifyCommerceSearchObjective({ query: "green sweater", audience: "men" }, { max_price: null, audience: "men", color: "green", size: null, in_stock: null }), "filtered");
  assert.deepEqual(expandCommerceQueries("sweater"), ["sweater", "crew sweater", "knit sweater", "pullover"]);
  assert.deepEqual(expandCommerceQueries("wool overshirt"), ["wool overshirt"]);
});

test("dynamic currency never inherits an unproven GBP label", () => {
  const provider = {
    id: "currency-shop.example",
    name: "currency-shop.example",
    domain: "currency-shop.example",
    base_url: "https://currency-shop.example",
    engine: "shopify",
    categories: ["fashion"],
    keywords: [],
    enabled: true,
    dynamic: true,
    site_origin: "https://currency-shop.example",
  };
  const unknown = normalizeCompatibilityProducts({ products: [{ id: "bare", handle: "bare-sweater", title: "Bare Sweater", price: 78, url: "/products/bare-sweater" }] }, provider)[0];
  assert.deepEqual(unknown.price, { amount: 78, currency: null });
  assert.equal(unknown.currency, null);
  assert.equal(unknown.currency_verified, false);
  const usd = normalizeCompatibilityProducts({ products: [{ id: "usd", handle: "usd-sweater", title: "USD Sweater", price: { amount: 78, currency: "USD" }, url: "/products/usd-sweater" }] }, provider)[0];
  assert.deepEqual(usd.price, { amount: 78, currency: "USD" });
  assert.equal(usd.currency_verified, true);
});

test("Shopify exhaustive search expands, verifies, and reports high coverage", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "coverage-shop.example";
  const women = product(host, "womens-green-sweater", "Women's Green Sweater", 12);
  const expensive = product(host, "mens-green-sweater-50", "Men's Green Sweater", 50);
  const winner = product(host, "mens-green-sweater-20", "Men's Green Sweater", 20);
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response('<html><head><link href="https://cdn.shopify.com/theme.css"></head><body><script>window.Shopify={shop:"coverage"}</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [women, expensive] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [expensive] });
    if (url.pathname === "/collections.json") return json({ collections: [{ handle: "mens-sweaters", title: "Men's Sweaters" }] });
    if (url.pathname === "/collections/mens-sweaters/products.json") return json({ products: [winner, expensive] });
    if (url.pathname === "/products.json") return json({ products: [winner, expensive] });
    if (url.pathname === "/products/mens-green-sweater-20.js") return json(winner);
    throw new Error(`unexpected coverage route ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: `https://${host}`,
      query: "cheapest currently available green men's sweater in size Large",
      sort_by: "price_asc",
      in_stock: true,
      max_results: 5,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.search_objective, "exhaustive_ranked");
    assert.equal(result.body.data.coverage_confidence, "high");
    assert.equal(result.body.data.coverage_sufficient_for_superlative, true);
    assert.equal(result.body.data.results[0].product_id, "mens-green-sweater-20");
    assert.equal(result.body.data.results[0].audience, "men");
    assert.deepEqual(result.body.data.results[0].price, { amount: 20, currency: "USD" });
    assert.equal(result.body.data.results[0].currency_verified, true);
    assert.deepEqual(result.body.data.closest_matches, []);
    assert.ok(calls.some((url) => url.pathname === "/collections.json"));
    assert.ok(calls.some((url) => url.pathname === "/collections/mens-sweaters/products.json"));
    assert.equal(calls.some((url) => url.pathname === "/products.json" && url.searchParams.get("limit") === "250"), false);
    assert.ok(calls.some((url) => url.pathname.endsWith("mens-green-sweater-20.js")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded catalogue exhaustion is honest partial coverage and still answer-ready", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "partial-shop.example";
  const rows = Array.from({ length: 250 }, (_, index) => product(host, `mens-sweater-${index}`, `Men's Green Sweater ${index}`, 20 + index));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response('<html><body><script>window.Shopify={shop:"partial"}</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [rows[0]] });
    if (url.pathname === "/collections.json") return json({ collections: [] });
    if (url.pathname === "/products.json") return json({ products: rows });
    if (url.pathname === "/products/mens-sweater-0.js") return json(rows[0]);
    throw new Error(`unexpected partial route ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { site: `https://${host}`, query: "cheapest men's sweater", sort_by: "price_asc", max_results: 3 }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.coverage_confidence, "partial");
    assert.equal(result.body.data.coverage_sufficient_for_superlative, false);
    assert.equal(result.body.data.answer_state, "partial");
    assert.equal(result.body.data.answer_ready, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("twenty cold WebMCP registrations expose every core tool before discovery", async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const visible = [];
    const tools = PREFERRED_SEMANTIC_TOOL_NAMES.map((name) => ({ name, execute: async () => ({ status: "success" }) }));
    const modelContext = {
      registerTool(tool) { visible.push(tool); },
      getTools() { return visible; },
    };
    const pending = registerWebMcpTools(modelContext, tools, PREFERRED_SEMANTIC_TOOL_NAMES);
    assert.deepEqual(visible.map((tool) => tool.name), PREFERRED_SEMANTIC_TOOL_NAMES, `cold attempt ${attempt + 1}`);
    assert.equal(typeof visible.find((tool) => tool.name === "commerce_search_products")?.execute, "function");
    const report = await pending;
    assert.equal(report.preferred_registered_tool_count, PREFERRED_SEMANTIC_TOOL_NAMES.length);
    assert.ok(report.discovered_tool_names.includes("commerce_search_products"));
  }
});
