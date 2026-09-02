import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { executeConnectorRequest, gatewayManifest } = await import("../lib/gateway-server.ts");
const { discoverDynamicCompatibilityProvider, resetCompatibilityCaches } = await import("../lib/compatibility.ts");
const { getRecipe } = await import("../lib/embedded-state.ts");
const { GatewayError, fetchUpstream } = await import("../lib/gateway-runtime.ts");
const { detectFrameworks, extractEmbeddedState } = await import("../lib/embedded-state.ts");

test("the page and manifest expose one complete generic WebMCP registry", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /TOOL_DEFINITIONS\.map/);
  assert.match(source, /registerWebMcpTools/);
  assert.match(source, /registration_order/);
  assert.match(source, /modelContext\.getTools/);
  assert.match(source, /id="agent-webmcp-registry"/);
  assert.match(source, /id="agent-webmcp-runtime"/);
  assert.doesNotMatch(source, /untrustedContentHint/);
  const manifest = await gatewayManifest();
  assert.equal(manifest.webmcp.expected_tool_count, 10);
  assert.equal(manifest.webmcp.semantic_tool_count, 10);
  assert.equal(manifest.tools.length, 24);
  assert.ok(manifest.tools.every((tool) => tool.input_schema && tool.read_only_hint === true));
});

function request() {
  return new Request("https://gateway.example/api/execute");
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function tentreeProduct() {
  return {
    id: 7701,
    handle: "mens-classic-sweater",
    title: "Men's Classic Crewneck Sweater",
    currency_code: "GBP",
    options: [{ name: "Color", values: ["Forest Green", "Black"] }, { name: "Size", values: ["S", "L"] }],
    variants: [
      { id: 77011, sku: "TT-GREEN-L", option1: "Forest Green", option2: "L", price: "35.00", compare_at_price: "49.00", available: true },
      { id: 77012, sku: "TT-GREEN-S", option1: "Forest Green", option2: "S", price: "35.00", available: false },
      { id: 77013, sku: "TT-BLACK-L", option1: "Black", option2: "L", price: "39.00", available: true },
    ],
    images: [{ src: "https://www.tentree.com/cdn/sweater.jpg" }],
    url: "/products/mens-classic-sweater",
  };
}

test("generic embedded state detects Next/RSC without evaluating page code", () => {
  const html = `<main id="__next"></main><script>self.__next_f.push([1,"{\\"products\\":[{\\"title\\":\\"Lamp\\"}]}"])</script>`;
  assert.ok(detectFrameworks(html).frameworks.includes("nextjs"));
  assert.ok(extractEmbeddedState(html).some((state) => state.kind === "next_flight"));
});

test("dynamic Shopify search enforces audience, color, size, stock, price, and detail chaining", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  let rootRequests = 0;
  const product = tentreeProduct();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "www.tentree.com");
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") {
      rootRequests += 1;
      return new Response('<html><head><link href="https://cdn.shopify.com/s/files/theme.css"></head><body><script>window.Shopify = { shop: "tentree" };</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/search/suggest.json") {
      assert.equal(url.searchParams.get("q"), "sweater");
      return json({ resources: { results: { products: [product] } } });
    }
    if (url.pathname === "/products/mens-classic-sweater.js") return json(product);
    throw new Error(`unexpected dynamic Shopify request ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: "https://www.tentree.com",
      query: "green men's sweater size large",
      in_stock: true,
      sort_by: "price_asc",
      max_results: 5,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.platform, "shopify");
    assert.equal(result.body.data.results.length, 1);
    const first = result.body.data.results[0];
    assert.equal(first.provider, "tentree.com");
    assert.equal(first.product_id, "mens-classic-sweater");
    assert.equal(first.matched_color, "Forest Green");
    assert.equal(first.matched_size, "L");
    assert.equal(first.variant_available, true);
    assert.deepEqual(first.price, { amount: 35, currency: "GBP" });
    assert.equal(first.platform, "shopify");
    assert.equal(first.actions.detail.arguments.provider, "tentree.com");
    assert.equal(first.actions.detail.arguments.site, "https://www.tentree.com");
    assert.equal(first.actions.detail.arguments.canonical_url, first.canonical_url);
    assert.equal(result.body.execution.provenance.platform, "shopify");
    assert.equal(result.body.execution.provenance.dynamic_discovery, "cold");
    assert.equal(result.body.source.provenance.domain, "tentree.com");
    assert.equal(result.body.data.providers["tentree.com"].compatibility_engine, "shopify");
    assert.equal(getRecipe("tentree.com", "commerce.search")?.preferred_route, "shopify_search_suggest_json");

    const detail = await executeConnectorRequest("commerce", "get_product", first.actions.detail.arguments, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.product.provider, "tentree.com");
    assert.equal(detail.body.data.product.product_id, first.product_id);
    assert.equal(detail.body.data.product.canonical_url, first.canonical_url);
    assert.equal(detail.body.data.product.variants[0].sku, "TT-GREEN-L");
    assert.equal(detail.body.execution.engine, "shopify");
    assert.equal(detail.body.execution.provenance.dynamic_discovery, "warm");

    const beforeWarm = rootRequests;
    const warm = await discoverDynamicCompatibilityProvider("https://www.tentree.com", {
      signal: new AbortController().signal,
      correlationId: "test-warm",
      startedAt: new Date().toISOString(),
    });
    assert.equal(warm.cache_status, "warm");
    assert.equal(rootRequests, beforeWarm);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dynamic WooCommerce route failures are explicit and do not become success", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "unusable-shop.example");
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return new Response('<html class="woocommerce"><body><div class="woocommerce" data-product_id="1"></div><script>/* /wp-json/wc/store/v1/products */</script><link href="/wp-content/plugins/woocommerce/assets/client.css"></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/wp-json/") return json({ namespaces: ["wp/v2"], routes: { "/wp/v2": {} } });
    if (url.searchParams.get("s") === "lamp") return new Response("<html><body><h1>Shop</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { site: "https://unusable-shop.example", query: "lamp", max_results: 5 }, request());
    assert.equal(result.status, 501);
    assert.equal(result.body.error.code, "PLATFORM_DETECTED_ROUTE_UNAVAILABLE");
    assert.equal(result.body.error.details.platform_detected, "woocommerce");
    assert.equal(result.body.error.details.site, "unusable-shop.example");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dynamic site safety rejects private origins and cross-boundary redirects", async () => {
  resetCompatibilityCaches();
  const invalid = await executeConnectorRequest("commerce", "search_products", { site: "https://127.0.0.1", query: "lamp" }, request());
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "INPUT_INVALID");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  try {
    await assert.rejects(
      fetchUpstream("https://public-example.example/", { signal: new AbortController().signal, correlationId: "redirect-test", startedAt: new Date().toISOString() }, { allowedOrigin: "https://public-example.example" }),
      (error) => error instanceof GatewayError && error.code === "INTERNAL_ERROR",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
