import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest, gatewayCapabilities, gatewayManifest } = await import("../lib/gateway-server.ts");
const { COMPATIBILITY_PROVIDER_IDS, isCompatibilityProvider } = await import("../lib/compatibility-catalog.ts");
const { normalizePublicSite } = await import("../lib/gateway-runtime.ts");
const { resetCompatibilityCaches } = await import("../lib/compatibility.ts");
const { PREFERRED_SEMANTIC_TOOL_NAMES } = await import("../lib/gateway-contract.ts");
const { registerWebMcpTools } = await import("../lib/webmcp-bootstrap.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function notFound() {
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
}

function shopifyProduct(host) {
  return {
    id: 9401,
    handle: "wool-overshirt",
    title: "Wool Overshirt",
    variants: [{ id: 94011, option1: "Natural", option2: "L", price: "64.00", available: true }],
    images: [{ src: `https://${host}/cdn/wool-overshirt.jpg` }],
    url: "/products/wool-overshirt",
  };
}

function wooProduct(host) {
  return {
    id: 9501,
    name: "Organic Kefir",
    slug: "organic-kefir",
    prices: { price: "1200", currency_code: "GBP", currency_minor_unit: 2 },
    images: [{ src: `https://${host}/wp-content/uploads/kefir.jpg` }],
    permalink: `https://${host}/product/organic-kefir/`,
    stock_status: "instock",
  };
}

test("normalizes common site forms to one safe public origin", () => {
  for (const value of ["tentree.com", "www.tentree.com", "https://tentree.com", "https://www.tentree.com/"]) {
    const normalized = normalizePublicSite(value);
    assert.equal(normalized.domain, "tentree.com");
    assert.ok(["https://tentree.com", "https://www.tentree.com"].includes(normalized.origin));
    assert.ok(["tentree.com", "www.tentree.com"].includes(normalized.hostname));
    assert.ok(!normalized.origin.endsWith("/"));
  }
});

test("an unknown Shopify domain bypasses the tested-example catalog and honors targeted providers", async () => {
  resetCompatibilityCaches();
  const host = "unseen-shopify-v121.example";
  assert.ok(!COMPATIBILITY_PROVIDER_IDS.some((id) => id === host));
  assert.equal(isCompatibilityProvider(host), false);
  const originalFetch = globalThis.fetch;
  const calls = [];
  const product = shopifyProduct(host);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response('<html><head><link href="https://cdn.shopify.com/theme.css"></head><body><script>window.Shopify = { shop: "unseen" };</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [product] } } });
    if (url.pathname === "/products.json") return json({ products: [] });
    if (url.pathname === "/wp-json/") return notFound();
    return notFound();
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: `${host}/storefront/`,
      providers: ["ikea"],
      query: "wool overshirt",
      max_results: 5,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.site, host);
    assert.equal(result.body.data.normalized_origin, `https://${host}`);
    assert.equal(result.body.data.platform, "shopify");
    assert.equal(result.body.data.provider_origin, "dynamic");
    assert.equal(result.body.data.providers[host].provider_origin, "dynamic");
    assert.equal(result.body.data.providers[host].known_before_request, false);
    assert.equal(result.body.execution.provenance.recipe_cache, "cold");
    assert.equal(result.body.data.results[0].provider, host);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((url) => url.hostname === host));
    assert.ok(!calls.some((url) => url.hostname.includes("ikea")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown WooCommerce domain receives shared route discovery", async () => {
  resetCompatibilityCaches();
  const host = "unseen-woocommerce-v121.example";
  assert.ok(!COMPATIBILITY_PROVIDER_IDS.some((id) => id === host));
  const originalFetch = globalThis.fetch;
  const calls = [];
  const product = wooProduct(host);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response('<html class="woocommerce"><body><div class="woocommerce product type-product" data-product_id="9501"></div><link href="/wp-content/plugins/woocommerce/assets/client.css"></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json" || url.pathname === "/products.json") return notFound();
    if (url.pathname === "/wp-json/" && !url.search) return json({ namespaces: ["wp/v2", "wc/store/v1"], routes: { "/wc/store/v1/products": {} } });
    if (url.pathname === "/wp-json/wc/store/v1/products") return json([product]);
    if (url.pathname === "/" && url.searchParams.get("s") === "kefir") return new Response("<html><body><h1>Shop</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    return notFound();
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { site: host, query: "kefir", max_results: 5 }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.platform, "woocommerce");
    assert.equal(result.body.data.provider_origin, "dynamic");
    assert.equal(result.body.data.providers[host].compatibility_engine, "woocommerce");
    assert.equal(result.body.data.results[0].provider, host);
    assert.equal(result.body.data.results[0].price.amount, 12);
    assert.ok(calls.some((url) => url.pathname === "/wp-json/wc/store/v1/products"));
    assert.ok(calls.every((url) => url.hostname === host));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit site failures remain targeted and never fall back to unrelated providers", async () => {
  resetCompatibilityCaches();
  const host = "targeted-failure-v121.example";
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response('<html><body><script>window.Shopify = { shop: "targeted" };</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    return notFound();
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { site: host, query: "lamp", max_results: 5 }, request());
    assert.notEqual(result.status, 200);
    assert.ok(["PLATFORM_DETECTED_ROUTE_UNAVAILABLE", "UPSTREAM_CHANGED", "UPSTREAM_BLOCKED", "SITE_UNREACHABLE"].includes(result.body.error.code), JSON.stringify(result.body));
    assert.equal(result.body.error.details.site, host);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((url) => url.hostname === host));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dynamic targeting rejects unsafe origins before compatibility execution", () => {
  for (const value of [
    "https://127.0.0.1",
    "https://localhost",
    "https://10.0.0.8",
    "https://192.168.1.4",
    "https://169.254.169.254",
    "https://[::1]",
    "http://public-v121.example",
    "https://user:pass@public-v121.example",
    "not a domain",
  ]) {
    assert.throws(() => normalizePublicSite(value), (error) => error?.code === "INPUT_INVALID");
  }
});

test("capabilities and manifests distinguish dynamic platform support from tested examples", async () => {
  const capabilities = gatewayCapabilities("commerce");
  const commerce = capabilities.data.capabilities.commerce;
  assert.equal(commerce.dynamic_site_targeting, true);
  assert.deepEqual(commerce.dynamic_platforms, ["shopify", "woocommerce"]);
  assert.equal(commerce.provider_list_role, "tested_examples_and_health_history; not execution eligibility");
  assert.equal(commerce.platform_families.shopify.dynamic_targeting, true);
  assert.equal(commerce.platform_families.shopify.tested_examples, undefined);

  const semantic = await gatewayManifest("semantic");
  assert.equal(semantic.verticals.commerce.dynamic_site_targeting, true);
  assert.equal(semantic.verticals.commerce.platform_families.woocommerce.dynamic_targeting, true);
  assert.equal(semantic.verticals.commerce.platform_families.woocommerce.tested_examples, undefined);

  const full = await gatewayManifest("full");
  assert.equal(full.compatibility.platforms.shopify.dynamic_targeting, true);
  assert.ok(full.compatibility.platforms.shopify.tested_examples.length > 0);
  assert.equal(full.compatibility.sites.shopify_pipandnut.example_type, "tested_example");
  assert.equal(full.compatibility.bounded.registry_role, "benchmarking_health_history_and_route_optimization; not execution eligibility");
});

test("cold bootstrap registers the preferred semantic surface atomically and completes deterministically", () => {
  const calls = [];
  const modelContext = {
    registerTool(tool) {
      calls.push(tool.name);
    },
    getTools() {
      return calls.map((name) => ({ name }));
    },
  };
  const tools = [
    { name: "gateway_echo" },
    ...PREFERRED_SEMANTIC_TOOL_NAMES.slice(0, 1).map((name) => ({ name })),
    ...PREFERRED_SEMANTIC_TOOL_NAMES.slice(1).map((name) => ({ name })),
    { name: "gateway_status" },
  ];
  const report = registerWebMcpTools(modelContext, tools, PREFERRED_SEMANTIC_TOOL_NAMES);
  assert.deepEqual(calls.slice(0, PREFERRED_SEMANTIC_TOOL_NAMES.length), PREFERRED_SEMANTIC_TOOL_NAMES);
  assert.deepEqual(calls.slice(PREFERRED_SEMANTIC_TOOL_NAMES.length), ["gateway_echo", "gateway_status"]);
  assert.equal(report.registration_state, "ready");
  assert.equal(report.registered_tools, PREFERRED_SEMANTIC_TOOL_NAMES.length);
  assert.ok(report.registration_latency_ms >= 0);
});

test("ten repeated cold bootstrap sessions expose every preferred contract on first registration phase", async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const visible = [];
    const modelContext = { registerTool(tool) { visible.push(tool.name); } };
    await registerWebMcpTools(modelContext, [{ name: "gateway_echo" }, ...PREFERRED_SEMANTIC_TOOL_NAMES.map((name) => ({ name }))], PREFERRED_SEMANTIC_TOOL_NAMES);
    assert.deepEqual(visible.slice(0, PREFERRED_SEMANTIC_TOOL_NAMES.length), PREFERRED_SEMANTIC_TOOL_NAMES, `cold attempt ${attempt + 1}`);
  }
});
