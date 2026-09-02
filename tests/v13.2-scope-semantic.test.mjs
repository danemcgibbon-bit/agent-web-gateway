import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest } = await import("../lib/gateway-server.ts");
const {
  normalizeCompatibilityProducts,
  resetCompatibilityCaches,
  scoreCompatibilityCollection,
  scopeRouteCacheKey,
} = await import("../lib/compatibility.ts");
const { getRecipe } = await import("../lib/embedded-state.ts");

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
}

function request() {
  return new Request("https://gateway.example/api/execute");
}

function dynamicProvider(host) {
  return {
    id: host,
    name: host,
    domain: host,
    base_url: `https://${host}`,
    engine: "shopify",
    categories: ["fashion"],
    keywords: ["sneakers"],
    enabled: true,
    dynamic: true,
    site_origin: `https://${host}`,
  };
}

function product(host, { id, handle, title, collection, price, available = true, productAvailable = undefined }) {
  return {
    id,
    handle,
    title,
    product_type: "Sneakers",
    collections: [collection],
    currency_code: "USD",
    ...(productAvailable === undefined ? {} : { available: productAvailable }),
    variants: [
      { id: `${id}-7`, price: price.toFixed(2), available, option1: "7" },
      { id: `${id}-8`, price: price.toFixed(2), available: false, option1: "8" },
    ],
    url: `/products/${handle}`,
    images: [{ src: `https://${host}/cdn/${handle}.jpg` }],
  };
}

function shopifyPage(host) {
  return new Response(`<html><head><link href="https://cdn.shopify.com/theme.css"></head><body><script>window.Shopify={shop:"${host}"}</script></body></html>`, {
    headers: { "content-type": "text/html" },
  });
}

test("structural collection scoring prefers aligned departments over merchandising scopes", () => {
  const intent = {
    query: "sneakers",
    audience: "men",
    color: "black",
    intent_structure: {
      structural: { category: "sneakers", audience: "men" },
      attributes: { color: "black", size: null, in_stock: true },
      objective: { sort: "price_asc", superlative: true },
    },
  };
  const aligned = scoreCompatibilityCollection({ handle: "mens-sneakers", title: "Men's Sneakers" }, intent);
  const specialized = scoreCompatibilityCollection({ handle: "colorful-sneakers", title: "Colorful Sneakers" }, intent);
  assert.equal(aligned.scope_sufficient_for_query, true);
  assert.equal(specialized.scope_sufficient_for_query, false);
  assert.ok(aligned.score > specialized.score);
  assert.ok(specialized.reasons.includes("color_specialization_conflict"));

  for (const [query, audience, handle] of [
    ["boots", "women", "womens-boots"],
    ["jackets", "men", "mens-jackets"],
    ["sneakers", "kids", "kids-sneakers"],
  ]) {
    const result = scoreCompatibilityCollection({ handle, title: handle.replaceAll("-", " ") }, { query, audience });
    assert.equal(result.scope_sufficient_for_query, true, handle);
  }
});

test("CYRUS BLACK uses identity colour evidence and variant-priority availability", () => {
  const host = "cyrus-semantic-v132.example";
  const provider = dynamicProvider(host);
  const [normalized] = normalizeCompatibilityProducts({ products: [product(host, {
    id: "cyrus-black",
    handle: "cyrus-black",
    title: "CYRUS BLACK",
    collection: "Men's Sneakers",
    price: 39.99,
    available: true,
    productAvailable: false,
  })] }, provider);
  assert.equal(normalized.color_family, "black");
  assert.equal(normalized.color_confidence, "high");
  assert.equal(normalized.audience, "men");
  assert.equal(normalized.availability, "in stock");
  assert.ok(normalized.semantic_conflicts.includes("variant_availability_vs_product_availability"));
  assert.equal(normalized.variants.some((variant) => variant.available === true), true);
});

test("Steve Madden golden journey selects the structural scope and verifies the black winner", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "stevemadden-v132.example";
  const cyrus = product(host, {
    id: "cyrus-black",
    handle: "cyrus-black",
    title: "CYRUS BLACK",
    collection: "Men's Sneakers",
    price: 39.99,
    available: true,
    productAvailable: false,
  });
  const grey = product(host, {
    id: "cyrus-grey-multi",
    handle: "cyrus-grey-multi",
    title: "CYRUS GREY MULTI",
    collection: "Colorful Sneakers",
    price: 59.99,
  });
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname !== host) throw new Error(`unexpected host ${url.hostname}`);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return shopifyPage(host);
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [grey] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [grey] });
    if (url.pathname === "/wp-json/") return new Response("not found", { status: 404 });
    if (url.pathname === "/collections.json") return json({ collections: [
      { handle: "colorful-sneakers", title: "Colorful Sneakers" },
      { handle: "mens-sneakers", title: "Men's Sneakers" },
      { handle: "black-accessories", title: "Black Accessories" },
      { handle: "sale", title: "Sale" },
    ] });
    if (url.pathname === "/collections/mens-sneakers/products.json") return json({ products: [cyrus] });
    if (url.pathname === "/collections/colorful-sneakers/products.json") return json({ products: [grey] });
    if (url.pathname === "/products/cyrus-black.js") return json(cyrus);
    throw new Error(`unexpected route ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: host,
      query: "cheapest men's black sneakers",
      sort_by: "price_asc",
      in_stock: true,
      max_results: 1,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const data = result.body.data;
    assert.equal(data.results[0].product_id, "cyrus-black");
    assert.deepEqual(data.results[0].price, { amount: 39.99, currency: "USD" });
    assert.equal(data.results[0].color_family, "black");
    assert.equal(data.results[0].availability, "in stock");
    assert.equal(data.scope.key, "mens-sneakers");
    assert.equal(data.acquisition_complete, true);
    assert.equal(data.scope_sufficient_for_query, true);
    assert.equal(data.semantic_confidence, "high");
    assert.equal(data.sufficient_for_superlative, true);
    assert.equal(data.coverage_sufficient_for_superlative, true);
    assert.deepEqual(data.closest_matches, []);
    assert.equal(data.diagnostics.normalized_intent.structural.category, "sneakers");
    assert.equal(data.diagnostics.normalized_intent.structural.audience, "men");
    assert.equal(data.diagnostics.normalized_intent.attributes.color, "black");
    assert.equal(data.diagnostics.normalized_intent.objective.sort, "price_asc");
    assert.equal(data.diagnostics.winner, "cyrus-black");
    assert.ok(data.diagnostics.semantic_conflicts.includes("variant_availability_vs_product_availability"));
    assert.ok(data.diagnostics.provider_diagnostics[host].candidate_scopes.some((scope) => scope.handle === "colorful-sneakers" && scope.scope_relevance.scope_sufficient_for_query === false));
    assert.ok(data.diagnostics.provider_diagnostics[host].candidate_scopes.some((scope) => scope.handle === "mens-sneakers" && scope.selected === true));
    assert.equal(calls.some((url) => url.pathname === "/collections/colorful-sneakers/products.json"), false);

    const recipe = getRecipe(host, "commerce.search");
    const key = scopeRouteCacheKey({ query: "sneakers", audience: "men", color: "black" });
    assert.equal(recipe.scope_routes[key].handle, "mens-sneakers");
    assert.equal(key.includes("black"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("semantically bad collection routes are not promoted and can self-heal", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "scope-cache-v132.example";
  const cyrus = product(host, { id: "cyrus-black", handle: "cyrus-black", title: "CYRUS BLACK", collection: "Men's Sneakers", price: 39.99 });
  const grey = product(host, { id: "grey-multi", handle: "grey-multi", title: "GREY MULTI", collection: "Colorful Sneakers", price: 59.99 });
  let phase = 1;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== host) throw new Error(`unexpected host ${url.hostname}`);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/") return shopifyPage(host);
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [grey] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [grey] });
    if (url.pathname === "/wp-json/") return new Response("not found", { status: 404 });
    if (url.pathname === "/collections.json") return json({ collections: phase === 1
      ? [{ handle: "colorful-sneakers", title: "Colorful Sneakers" }]
      : [{ handle: "colorful-sneakers", title: "Colorful Sneakers" }, { handle: "mens-sneakers", title: "Men's Sneakers" }] });
    if (url.pathname === "/collections/colorful-sneakers/products.json") return json({ products: [grey] });
    if (url.pathname === "/collections/mens-sneakers/products.json") return json({ products: [cyrus] });
    if (url.pathname === "/products.json") return json({ products: [grey] });
    if (url.pathname === "/products/cyrus-black.js") return json(cyrus);
    throw new Error(`unexpected route ${url}`);
  };
  try {
    const input = { site: host, query: "cheapest men's black sneakers", sort_by: "price_asc", in_stock: true, max_results: 1 };
    await executeConnectorRequest("commerce", "search_products", input, request());
    const key = scopeRouteCacheKey({ query: "sneakers", audience: "men" });
    assert.equal(getRecipe(host, "commerce.search")?.scope_routes?.[key], undefined);

    phase = 2;
    resetCompatibilityCaches();
    const healed = await executeConnectorRequest("commerce", "search_products", input, request());
    assert.equal(healed.status, 200, JSON.stringify(healed.body));
    assert.equal(healed.body.data.results[0].product_id, "cyrus-black");
    assert.equal(healed.body.data.scope.key, "mens-sneakers");
    assert.equal(healed.body.data.scope_sufficient_for_query, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
