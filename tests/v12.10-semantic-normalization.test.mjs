import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest } = await import("../lib/gateway-server.ts");
const {
  classifyCompatibilityColorFamily,
  normalizeCompatibilityColor,
  normalizeCompatibilityProducts,
  resetCompatibilityCaches,
} = await import("../lib/compatibility.ts");
const { taskResultSummary } = await import("../lib/gateway-task.ts");

function provider(domain = "semantic-fixture.example") {
  return {
    id: domain,
    name: domain,
    domain,
    base_url: `https://${domain}`,
    engine: "shopify",
    categories: ["fashion"],
    keywords: ["sweater"],
    enabled: true,
    dynamic: true,
    site_origin: `https://${domain}`,
  };
}

function request() {
  return new Request("https://gateway.example/api/execute");
}

test("shared colour normalization preserves display values and rejects modifier-only green", () => {
  for (const value of ["Light Moss Heather", "Forest Pine Heather", "Pine Green", "Dark Forest Green Fleck"]) {
    const normalized = normalizeCompatibilityColor(value);
    assert.equal(normalized.display, value);
    assert.equal(normalized.family, "green");
    assert.equal(classifyCompatibilityColorFamily(value), "green");
  }
  for (const value of ["Heather Grey", "Heather Oat", "Charcoal Heather", "Natural Heather", "teal", "stone"]) {
    assert.notEqual(classifyCompatibilityColorFamily(value), "green", value);
  }
});

test("variant and product-option colour evidence shares one normalized record", () => {
  const [product] = normalizeCompatibilityProducts({ products: [{
    id: "hudson",
    handle: "hudson-sweater",
    title: "Hudson Sweater",
    product_type: "Sweater",
    options: [{ name: "Color", values: ["Light Moss Heather"] }, { name: "Size", values: ["L"] }],
    variants: [{ id: "hudson-l", option1: "Light Moss Heather", option2: "L", price: "78.40", available: true }],
    url: "/products/hudson-sweater",
  }] }, provider());
  assert.equal(product.color, "Light Moss Heather");
  assert.equal(product.color_family, "green");
  assert.deepEqual(product.color_families, ["green"]);
  assert.equal(product.variants[0].color_family, "green");
});

test("storefront currency context is reusable, market-scoped, and conflict-safe", () => {
  resetCompatibilityCaches();
  const shop = provider("currency-context.example");
  const base = { id: "sweater", handle: "sweater", title: "Context Sweater", url: "/products/sweater", price: 78 };
  const usd = normalizeCompatibilityProducts({ currency_code: "USD", products: [base] }, shop, 40, { market: "us" })[0];
  const gbp = normalizeCompatibilityProducts({ currency_code: "GBP", products: [base] }, shop, 40, { market: "gb" })[0];
  assert.deepEqual(usd.price, { amount: 78, currency: "USD" });
  assert.equal(usd.currency_verified, true);
  assert.equal(usd.currency_source, "storefront_context");
  assert.match(String(usd.currency_context_id), /^storectx_/);
  assert.deepEqual(gbp.price, { amount: 78, currency: "GBP" });
  assert.notEqual(usd.currency_context_id, gbp.currency_context_id);

  const unknown = normalizeCompatibilityProducts({ products: [{ ...base, id: "unknown", handle: "unknown" }] }, provider("unknown-currency.example"), 40, { use_cached_context: false })[0];
  assert.deepEqual(unknown.price, { amount: 78, currency: null });
  assert.equal(unknown.currency_verified, false);

  const conflict = normalizeCompatibilityProducts({ currency_code: "USD", products: [{ ...base, id: "conflict", handle: "conflict", price: { amount: 78, currency: "GBP" } }] }, shop, 40, { market: "conflict" })[0];
  assert.deepEqual(conflict.price, { amount: 78, currency: null });
  assert.equal(conflict.currency_verified, false);
  assert.equal(conflict.currency_conflict, true);

  const mismatched = normalizeCompatibilityProducts({ currency_code: "USD", products: [{ ...base, id: "mismatched", handle: "mismatched", currency: "GBP" }] }, shop, 40, { market: "mismatch" })[0];
  assert.equal(mismatched.currency, null);
  assert.equal(mismatched.currency_verified, false);
  assert.equal(mismatched.currency_conflict, true);
});

test("one commerce call resolves all acquired colour candidates before limiting and verifies the winner", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "semantic-shop.example";
  const hudson = {
    id: "hudson",
    handle: "hudson-sweater",
    title: "Hudson Sweater",
    product_type: "Sweater",
    collections: ["Men's Sweaters"],
    options: [{ name: "Color", values: ["Light Moss Heather"] }, { name: "Size", values: ["L"] }],
    variants: [{ id: "hudson-l", option1: "Light Moss Heather", option2: "L", price: 78.4, available: true }],
    url: "/products/hudson-sweater",
  };
  const pricierGreen = {
    ...hudson,
    id: "forest-pine",
    handle: "forest-pine-sweater",
    title: "Forest Pine Sweater",
    options: [{ name: "Color", values: ["Forest Pine Heather"] }, { name: "Size", values: ["L"] }],
    variants: [{ id: "forest-pine-l", option1: "Forest Pine Heather", option2: "L", price: 92, available: true }],
    url: "/products/forest-pine-sweater",
  };
  const grey = {
    ...hudson,
    id: "grey",
    handle: "grey-sweater",
    title: "Heather Grey Sweater",
    options: [{ name: "Color", values: ["Heather Grey"] }, { name: "Size", values: ["L"] }],
    variants: [{ id: "grey-l", option1: "Heather Grey", option2: "L", price: 40, available: true }],
    url: "/products/grey-sweater",
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200 });
    if (url.pathname === "/" && !url.searchParams.size) return new Response('<html><head><meta property="product:price:currency" content="USD"></head><body><script>window.Shopify={shop:"semantic"}</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [hudson] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [hudson] });
    if (url.pathname === "/collections.json") return json({ collections: [{ handle: "mens-sweaters", title: "Men's Sweaters" }] });
    if (url.pathname === "/collections/mens-sweaters/products.json") return json({ products: [hudson, pricierGreen, grey] });
    if (url.pathname === "/products/hudson-sweater.js") return json(hudson);
    if (url.pathname === "/wp-json/") return json({}, 404);
    if (url.pathname === "/products.json") return json({ products: [hudson, pricierGreen, grey] });
    throw new Error(`unexpected route ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: `https://${host}`,
      query: "cheapest green men's sweater",
      audience: "men",
      color: "green",
      size: "L",
      in_stock: true,
      sort_by: "price_asc",
      max_results: 1,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const data = result.body.data;
    assert.equal(data.answer_ready, true);
    assert.equal(data.agent_action, "answer", JSON.stringify(data));
    assert.equal(data.answer_state, "exact_match");
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].title, "Hudson Sweater");
    assert.equal(data.results[0].color, "Light Moss Heather");
    assert.equal(data.results[0].color_family, "green");
    assert.deepEqual(data.results[0].price, { amount: 78.4, currency: "USD" });
    assert.equal(data.results[0].currency_verified, true);
    assert.equal(data.diagnostics.semantic_normalization.records_acquired, 3);
    assert.equal(data.diagnostics.semantic_normalization.color_family_matches, 2);
    assert.equal(data.diagnostics.semantic_normalization.green_family_records, 2);
    assert.equal(data.providers[host].finalist_verification, "verified");
    assert.equal(taskResultSummary("commerce", data), "Hudson Sweater in Light Moss Heather is the cheapest qualifying green men's sweater at $78.40 USD.");
  } finally {
    globalThis.fetch = originalFetch;
    resetCompatibilityCaches();
  }
});
