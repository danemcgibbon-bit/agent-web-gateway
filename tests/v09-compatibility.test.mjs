import assert from "node:assert/strict";
import test from "node:test";

const {
  detectCompatibilityEngine,
  resetCompatibilityCaches,
} = await import("../lib/compatibility.ts");
const { detectAlgoliaConfig, detectFrameworks, extractEmbeddedState } = await import("../lib/embedded-state.ts");
const { executeConnectorRequest, gatewayManifest } = await import("../lib/gateway-server.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
}

function shopifyProduct(host, index) {
  return {
    id: 1000 + index,
    handle: `compat-lamp-${index}`,
    title: `Compatibility Lamp ${index}`,
    variants: [{ price: `${19 + index}.99` }],
    images: [{ src: `https://${host}/cdn/lamp-${index}.jpg` }],
    available: true,
  };
}

test("platform detection finds Next.js, JSON-LD, and public Algolia configuration", () => {
  const html = `<!doctype html><main id="__next"></main>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { product: { productId: "next-1", title: "Next Lamp" } } } })}</script>
    <script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Next Lamp", sku: "next-1", url: "https://example.co.uk/products/next-1" })}</script>
    <script>const algolia = { applicationID: "ABCD1234", indexName: "products" };</script>`;
  const detection = detectCompatibilityEngine(html, "https://example.co.uk/search?q=lamp");
  assert.equal(detection.engine, "nextjs");
  assert.ok(detection.frameworks.includes("nextjs"));
  assert.ok(detection.embedded_state_kinds.includes("next_data"));
  assert.ok(extractEmbeddedState(html).some((state) => state.kind === "json_ld"));
  assert.equal(detectFrameworks(html).frameworks.includes("algolia"), true);
  assert.equal(detectAlgoliaConfig(html)?.has_public_config, true);
  assert.deepEqual(detectAlgoliaConfig(html)?.index_names, ["products"]);
});

test("one Shopify engine supports three unrelated public storefronts and chains detail", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const providers = [
    ["shopify_represent", "representclo.com", 1],
    ["shopify_rapanuiclothing", "rapanuiclothing.com", 2],
    ["shopify_pipandnut", "pipandnut.com", 3],
  ];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const row = providers.find(([, host]) => host === url.hostname);
    assert.ok(row, `unexpected Shopify host ${url.hostname}`);
    const [, host, index] = row;
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/search/suggest.json") {
      assert.equal(url.searchParams.get("q"), "lamp");
      return new Response(JSON.stringify({ resources: { results: { products: [shopifyProduct(host, index)] } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === `/products/compat-lamp-${index}.js`) return new Response(JSON.stringify(shopifyProduct(host, index)), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected Shopify request ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { query: "lamp", providers: providers.map(([id]) => id), max_results: 5 }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.results.length, 3);
    assert.ok(result.body.data.results.every((item) => item.actions.detail.arguments.canonical_url.includes("/products/compat-lamp-")));
    assert.equal(result.body.execution.mode, "public_http");
    assert.equal(result.body.data.providers.shopify_represent.compatibility_engine, "shopify");
    const first = result.body.data.results[0];
    const detail = await executeConnectorRequest("commerce", "get_product", {
      provider: first.provider,
      product_id: first.product_id,
      canonical_url: first.canonical_url,
    }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.product.product_id, first.product_id);
    assert.equal(detail.body.execution.engine, "shopify");
    assert.equal(detail.body.source.compatibility_engine, "shopify");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one WooCommerce Store API engine supports three public stores and chains numeric IDs", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const providers = [
    ["woocommerce_hardandware", "www.hardandware.com", 11],
    ["woocommerce_formnutrition", "formnutrition.com", 12],
    ["woocommerce_gruum", "gruum.com", 13],
  ];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const row = providers.find(([, host]) => host === url.hostname);
    assert.ok(row, `unexpected WooCommerce host ${url.hostname}`);
    const [, host, id] = row;
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/wp-json/wc/store/v1/products") {
      assert.equal(url.searchParams.get("search"), "product");
      return new Response(JSON.stringify([{ id, name: `Woo Product ${id}`, slug: `woo-product-${id}`, permalink: `https://${host}/product/woo-product-${id}/`, prices: { price: "2499", currency_code: "GBP", currency_minor_unit: 2 }, images: [{ src: `https://${host}/media/${id}.jpg` },], average_rating: "4.5", review_count: 123, stock_status: "instock" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === `/wp-json/wc/store/v1/products/${id}`) {
      return new Response(JSON.stringify({ id, name: `Woo Product ${id}`, slug: `woo-product-${id}`, permalink: `https://${host}/product/woo-product-${id}/`, prices: { price: "2499", currency_code: "GBP", currency_minor_unit: 2 }, images: [{ src: `https://${host}/media/${id}.jpg` }], stock_status: "instock" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected WooCommerce request ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { query: "product", providers: providers.map(([id]) => id), max_results: 5 }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.results.length, 3);
    assert.deepEqual(result.body.data.results[0].price, { amount: 24.99, currency: "GBP" });
    const first = result.body.data.results[0];
    const detail = await executeConnectorRequest("commerce", "get_product", { provider: first.provider, product_id: first.product_id, canonical_url: first.canonical_url }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.product.product_id, first.product_id);
    assert.equal(detail.body.data.product.provider, first.provider);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured-state search and detail reject a generic shell", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const product = { productId: "next-lamp-1", title: "Next Lamp", price: { amount: 42, currency: "GBP" }, url: "https://www.currys.co.uk/products/next-lamp-1" };
  const page = (withProduct) => `<main id="__next"></main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: withProduct ? { products: [product] } : { navigation: { title: "Search" } } } })}</script>`;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/search") return new Response(page(true), { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/products/next-lamp-1") return new Response(`<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Next Lamp", sku: "next-lamp-1", url: "https://www.currys.co.uk/products/next-lamp-1", offers: { price: "42.00", priceCurrency: "GBP" } })}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    if (url.hostname === "decathlon.co.uk" || url.hostname === "www.decathlon.co.uk") return new Response(page(false), { status: 200, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected structured request ${url}`);
  };
  try {
    const search = await executeConnectorRequest("commerce", "search_products", { query: "lamp", providers: ["structured_currys"], max_results: 5 }, request());
    assert.equal(search.status, 200);
    assert.equal(search.body.data.results[0].product_id, "next-lamp-1");
    assert.equal(search.body.data.results[0].execution_mode, "public_http");
    const detail = await executeConnectorRequest("commerce", "get_product", { provider: "structured_currys", product_id: "next-lamp-1", canonical_url: search.body.data.results[0].canonical_url }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.product.price.amount, 42);
    const invalid = await executeConnectorRequest("commerce", "search_products", { query: "lamp", providers: ["structured_decathlon"], max_results: 5 }, request());
    assert.equal(invalid.status, 502);
    assert.notEqual(invalid.body.status, "success");
    assert.ok(["UPSTREAM_CHANGED", "NO_VALID_RESULTS"].includes(invalid.body.error.code));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manifest reports compatibility engines and observed generic provider health", async () => {
  const manifest = await gatewayManifest();
  assert.deepEqual(manifest.compatibility.route_order.slice(0, 3), ["shopify", "woocommerce", "nextjs"]);
  assert.ok(manifest.compatibility.engines.shopify.shared_modules.includes("compatibility.ts"));
  assert.equal(manifest.verticals.commerce.providers.shopify_represent.status, "online");
  assert.equal(manifest.verticals.commerce.providers.woocommerce_hardandware.status, "online");
  assert.ok(manifest.coverage.commerce.provider_metrics.shopify_represent.attempted >= 2);
});
