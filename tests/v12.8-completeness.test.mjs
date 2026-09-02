import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest } = await import("../lib/gateway-server.ts");
const {
  createStoreSnapshot,
  resetCompatibilityCaches,
  scopeHintForSite,
  snapshotCacheState,
} = await import("../lib/compatibility.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
}

function product(host, handle, title, amount) {
  return {
    id: handle,
    handle,
    title,
    product_type: "Sweater",
    currency_code: "USD",
    options: [{ name: "Color", values: ["Forest Green"] }, { name: "Size", values: ["L"] }],
    variants: [{ id: `${handle}-l`, option1: "Forest Green", option2: "L", price: amount.toFixed(2), available: true }],
    url: `/products/${handle}`,
  };
}

function shopifyHome(name) {
  return new Response(`<html><body><script>window.Shopify={shop:"${name}"}</script></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
}

test("Shopify collection pagination reaches true termination and skips the whole-store crawl", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "v128-paged-collection.example";
  const pageOne = Array.from({ length: 250 }, (_, index) => product(host, `mens-sweater-${index}`, `Men's Green Sweater ${index}`, 100 + index));
  const winner = product(host, "mens-sweater-winner", "Men's Green Sweater Winner", 5);
  const allProducts = new Map([...pageOne, winner].map((item) => [item.handle, item]));
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return shopifyHome("paged-collection");
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [winner] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [pageOne[0]] });
    if (url.pathname === "/collections.json") return json({ collections: [{ handle: "mens-sweaters", title: "Men's Sweaters" }] });
    if (url.pathname === "/collections/mens-sweaters/products.json") {
      return url.searchParams.get("page") === "1" ? json({ products: pageOne }) : json({ products: [winner] });
    }
    if (url.pathname.startsWith("/products/") && url.pathname.endsWith(".js")) {
      const handle = url.pathname.split("/").at(-1).replace(/\.js$/, "");
      return json(allProducts.get(handle) ?? winner);
    }
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "250") assert.fail(`unexpected whole-store crawl ${url}`);
    if (url.pathname === "/wp-json/") return json({}, 404);
    throw new Error(`unexpected route ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: `https://${host}`,
      query: "cheapest men's sweater",
      sort_by: "price_asc",
      max_results: 3,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.coverage_level, "complete_for_query");
    assert.equal(result.body.data.coverage_sufficient_for_superlative, true);
    assert.equal(result.body.data.scope?.kind, "collection", JSON.stringify(result.body));
    assert.equal(result.body.data.scope.key, "mens-sweaters");
    const providerDiagnostics = result.body.data.diagnostics.provider_diagnostics[host];
    assert.equal(providerDiagnostics.acquisition_strategy, "collection");
    assert.equal(providerDiagnostics.collection_pages_fetched, 2);
    assert.equal(providerDiagnostics.termination_reason, "end_of_collection");
    assert.equal(providerDiagnostics.acquisition.pagination_complete, true);
    assert.equal(result.body.data.results[0].product_id, "mens-sweater-winner");
    assert.equal(calls.some((url) => url.pathname === "/products.json" && url.searchParams.get("limit") === "250"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a meaningful collection path is retained as the acquisition scope", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "v128-direct-collection.example";
  const item = product(host, "mens-scope-sweater", "Men's Scope Sweater", 19);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return shopifyHome("direct-collection");
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [item] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [item] });
    if (url.pathname === "/collections/mens-sweaters/products.json") return json({ products: [item] });
    if (url.pathname === "/collections.json" || url.pathname === "/products.json") assert.fail(`unexpected broad route ${url}`);
    if (url.pathname === "/products/mens-scope-sweater.js") return json(item);
    if (url.pathname === "/wp-json/") return json({}, 404);
    throw new Error(`unexpected route ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: `https://${host}/collections/mens-sweaters`,
      query: "cheapest sweater",
      sort_by: "price_asc",
      max_results: 3,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.site_scope.kind, "collection");
    assert.equal(result.body.data.site_scope.path, "/collections/mens-sweaters");
    assert.equal(result.body.data.scope.path, "/collections/mens-sweaters");
    const providerDiagnostics = result.body.data.diagnostics.provider_diagnostics[host];
    assert.equal(providerDiagnostics.collection_pages_fetched, 1, JSON.stringify(result.body));
    assert.equal(providerDiagnostics.catalogue_pages_fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("truncated Shopify catalogue pagination remains bounded partial coverage", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "v128-truncated-catalogue.example";
  const rows = Array.from({ length: 250 }, (_, index) => product(host, `catalogue-sweater-${index}`, `Men's Catalogue Sweater ${index}`, 20 + index));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return shopifyHome("truncated-catalogue");
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [rows[0]] });
    if (url.pathname === "/collections.json") return json({ collections: [] });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "250") return json({ products: rows });
    if (url.pathname.startsWith("/products/") && url.pathname.endsWith(".js")) return json(rows[0]);
    if (url.pathname === "/wp-json/") return json({}, 404);
    throw new Error(`unexpected route ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: `https://${host}`,
      query: "cheapest men's sweater",
      sort_by: "price_asc",
      max_results: 3,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.coverage_level, "bounded_partial");
    assert.equal(result.body.data.coverage_sufficient_for_superlative, false);
    assert.equal(result.body.data.answer_state, "partial");
    assert.equal(result.body.data.answer_ready, true);
    const providerDiagnostics = result.body.data.diagnostics.provider_diagnostics[host];
    assert.equal(providerDiagnostics.catalogue_pages_fetched, 32, JSON.stringify(result.body));
    assert.equal(providerDiagnostics.pagination_complete, false);
    assert.equal(providerDiagnostics.termination_reason, "max_pages");
    assert.equal(providerDiagnostics.coverage_reason, "bounded_partial_max_pages");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("snapshot cache distinguishes exact, superset, insufficient, miss, and stale scopes", () => {
  resetCompatibilityCaches();
  const provider = {
    id: "v128-cache.example",
    name: "v128-cache.example",
    domain: "v128-cache.example",
    base_url: "https://v128-cache.example",
    engine: "shopify",
    categories: ["fashion"],
    keywords: [],
    enabled: true,
    dynamic: true,
    site_origin: "https://v128-cache.example",
  };
  const store = createStoreSnapshot(provider, [], {
    coverage_level: "complete_for_query",
    source_url: "https://v128-cache.example/products.json",
    acquisition_tier: "fixture",
    network_requests: 2,
    routes: ["shopify_products_json"],
    scope: { kind: "store", key: "store", path: "/" },
    acquisition: { scope: { kind: "store", key: "store", path: "/" }, pages_fetched: 2, pagination_complete: true, records_acquired: 0, records_capped: false, termination_reason: "end_of_catalogue" },
  });
  const collection = scopeHintForSite("https://v128-cache.example/collections/mens-sweaters", "sweater");
  assert.equal(snapshotCacheState(store, collection, true), "hit_superset");
  assert.equal(snapshotCacheState(store, { kind: "store", key: "store", path: "/" }, true), "hit_exact");
  const legacy = createStoreSnapshot(provider, [], {
    coverage_level: "complete_for_query",
    source_url: "https://v128-cache.example/products.json",
    acquisition_tier: "legacy-fixture",
    network_requests: 1,
    routes: ["legacy_route"],
  });
  assert.equal(snapshotCacheState(legacy, { kind: "store", key: "store", path: "/" }, true), "hit_insufficient");
  const partial = createStoreSnapshot(provider, [], {
    coverage_level: "bounded_partial",
    source_url: "https://v128-cache.example/search",
    acquisition_tier: "fixture",
    network_requests: 1,
    routes: ["shopify_search_suggest_json"],
    scope: collection,
    acquisition: { scope: collection, pages_fetched: 1, pagination_complete: false, records_acquired: 0, records_capped: false, termination_reason: "max_pages" },
  });
  assert.equal(snapshotCacheState(partial, collection, true), "hit_insufficient");
  assert.equal(snapshotCacheState(null, collection), "miss");
  partial.expiresAt = Date.now() - 1;
  assert.equal(snapshotCacheState(partial, collection), "stale");
});
