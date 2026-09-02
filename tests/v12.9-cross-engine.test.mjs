import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest } = await import("../lib/gateway-server.ts");
const { resetCompatibilityCaches } = await import("../lib/compatibility.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function amazonPage(products, terminal) {
  const cards = products.map(({ id, title, price }) => `<div class="s-result-item" data-asin="${id}"><a href="/dp/${id}"><h2>${title}</h2><span>£${price}</span></a></div>`).join("");
  const next = terminal
    ? `<span class="s-pagination-item s-pagination-next s-pagination-disabled">Next</span>`
    : `<a class="s-pagination-item s-pagination-next" href="#">Next</a>`;
  return `<html><body>${cards}${next}</body></html>`;
}

test("Amazon uses bounded pagination for ranked commerce and reports terminal evidence", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/s") {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (page === 1) return new Response(amazonPage([
        { id: "B0V1290001", title: "Wireless headphones v129 one", price: "39.99" },
        { id: "B0V1290002", title: "Wireless headphones v129 two", price: "29.99" },
      ], false), { status: 200, headers: { "content-type": "text/html" } });
      return new Response(amazonPage([
        { id: "B0V1290003", title: "Wireless headphones v129 three", price: "19.99" },
        { id: "B0V1290004", title: "Wireless headphones v129 four", price: "49.99" },
      ], true), { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected Amazon request: ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      providers: ["amazon"],
      query: "wireless headphones v129",
      max_results: 2,
      sort_by: "price_asc",
      currency: "GBP",
      locale: "en-GB",
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.coverage_level, "complete_for_query");
    assert.equal(result.body.data.coverage_sufficient_for_superlative, true);
    assert.equal(result.body.data.results[0].product_id, "B0V1290003");
    const diagnostics = result.body.data.diagnostics.provider_diagnostics.amazon;
    assert.equal(diagnostics.acquisition.pages_fetched, 2);
    assert.equal(diagnostics.acquisition.pagination_complete, true);
    assert.equal(diagnostics.acquisition.termination_reason, "end_of_catalogue");
    assert.equal(diagnostics.acquisition.records_acquired, 4);
    assert.equal(calls.filter((url) => url.pathname === "/s").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Amazon stops at its ranked page budget instead of claiming complete coverage", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/s") throw new Error(`unexpected Amazon request: ${url}`);
    calls.push(url);
    const page = Number(url.searchParams.get("page") ?? "1");
    return new Response(amazonPage([
      { id: `B0V1291${String(page).padStart(3, "0")}`, title: "Wireless headphones v129 budget", price: `${page + 10}.99` },
    ], false), { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      providers: ["amazon"],
      query: "wireless headphones v129 budget",
      max_results: 1,
      sort_by: "price_asc",
      currency: "GBP",
      locale: "en-GB",
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.coverage_level, "bounded_partial");
    assert.equal(result.body.data.coverage_sufficient_for_superlative, false);
    const diagnostics = result.body.data.diagnostics.provider_diagnostics.amazon;
    assert.equal(diagnostics.acquisition.pages_fetched, 4);
    assert.equal(diagnostics.acquisition.pagination_complete, false);
    assert.equal(diagnostics.acquisition.termination_reason, "max_pages");
    const retry = await executeConnectorRequest("commerce", "search_products", {
      providers: ["amazon"],
      query: "wireless headphones v129 budget",
      max_results: 1,
      sort_by: "price_asc",
      currency: "GBP",
      locale: "en-GB",
      include_diagnostics: true,
    }, request());
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.coverage_sufficient_for_superlative, false);
    assert.equal(calls.length, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dynamic WooCommerce HTML fallback creates a bounded search snapshot", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "https://woo-v129.example";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== "woo-v129.example") throw new Error(`unexpected host: ${url}`);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    if (url.pathname === "/" && !url.searchParams.size) return new Response('<html class="woocommerce"><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/client.css"></html>', { status: 200 });
    if (url.pathname === "/wp-json/") return new Response(JSON.stringify({ namespaces: ["wc/store/v1"] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/search/suggest.json" || url.pathname === "/products.json") return new Response("not found", { status: 404 });
    if (url.pathname === "/wp-json/wc/store/v1/products") return new Response("not found", { status: 404 });
    if (url.pathname === "/wp-json/wc/store/v1/products/4041") return new Response(JSON.stringify({ id: 4041, name: "V129 Lamp", slug: "v129-lamp", permalink: `${host}/product/v129-lamp/`, prices: { price: "2500", currency_code: "GBP", currency_minor_unit: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.searchParams.get("s") === "lamp v129" && url.searchParams.get("post_type") === "product") return new Response('<html class="woocommerce"><ul class="products"><li class="product type-product" data-product_id="4041"><a class="woocommerce-LoopProduct-link" href="/product/v129-lamp/"><h2>V129 Lamp</h2><span class="price">£25.00</span></a></li></ul></html>', { status: 200 });
    throw new Error(`unexpected WooCommerce request: ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: host,
      query: "lamp v129",
      max_results: 1,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.platform, "woocommerce");
    assert.equal(result.body.data.coverage_level, "bounded_partial");
    assert.equal(result.body.data.results[0].product_id, "4041");
    const provider = result.body.data.providers["woo-v129.example"];
    assert.equal(provider.coverage_sufficient_for_superlative, false);
    assert.equal(provider.scope.kind, "search");
    assert.equal(provider.acquisition.pagination_complete, false);
    assert.equal(provider.acquisition.termination_reason, "query_results");
    assert.equal(result.body.data.diagnostics.provider_diagnostics["woo-v129.example"].acquisition.strategy, "woocommerce_woo_frontend_search_targeted");
  } finally {
    globalThis.fetch = originalFetch;
    resetCompatibilityCaches();
  }
});

test("dynamic WooCommerce category paths use bounded collection pagination", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "https://woo-v129-category.example";
  const products = [
    { id: 5001, name: "V129 Category Lamp", slug: "v129-category-lamp", permalink: `${host}/product/v129-category-lamp/`, prices: { price: "1900", currency_code: "GBP", currency_minor_unit: 2 } },
    { id: 5002, name: "V129 Category Floor Lamp", slug: "v129-category-floor-lamp", permalink: `${host}/product/v129-category-floor-lamp/`, prices: { price: "3900", currency_code: "GBP", currency_minor_unit: 2 } },
  ];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== "woo-v129-category.example") throw new Error(`unexpected host: ${url}`);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    if (url.pathname === "/" && !url.searchParams.size) return new Response('<html class="woocommerce"><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/client.css"></html>', { status: 200 });
    if (url.pathname === "/wp-json/") return new Response(JSON.stringify({ namespaces: ["wc/store/v1"] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/search/suggest.json" || url.pathname === "/products.json") return new Response("not found", { status: 404 });
    if (url.pathname === "/wp-json/wc/store/v1/products/categories") return new Response(JSON.stringify([{ id: 77, slug: "lamps", name: "Lamps" }]), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/wp-json/wc/store/v1/products" && url.searchParams.get("category") === "77") return new Response(JSON.stringify(products), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/wp-json/wc/store/v1/products/5001") return new Response(JSON.stringify(products[0]), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected WooCommerce request: ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: `${host}/product-category/lamps`,
      query: "lamp v129",
      max_results: 1,
      sort_by: "price_asc",
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.platform, "woocommerce");
    assert.equal(result.body.data.coverage_level, "complete_for_query");
    assert.equal(result.body.data.coverage_sufficient_for_superlative, true);
    assert.equal(result.body.data.scope.kind, "collection");
    assert.equal(result.body.data.scope.key, "lamps");
    assert.equal(result.body.data.results[0].product_id, "5001");
    const provider = result.body.data.providers["woo-v129-category.example"];
    assert.equal(provider.coverage_sufficient_for_superlative, true);
    assert.equal(provider.acquisition.strategy, "woocommerce_category_pagination");
    assert.equal(provider.acquisition.pagination_complete, true);
    assert.equal(provider.acquisition.termination_reason, "end_of_collection");
    assert.equal(provider.acquisition.pages_fetched, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetCompatibilityCaches();
  }
});
