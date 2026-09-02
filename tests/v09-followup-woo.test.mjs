import assert from "node:assert/strict";
import test from "node:test";

const {
  detectCompatibilityEngine,
  detectWooCommerce,
  resetCompatibilityCaches,
} = await import("../lib/compatibility.ts");
const { getRecipe } = await import("../lib/embedded-state.ts");
const { executeConnectorRequest } = await import("../lib/gateway-server.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function robots() {
  return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function product(host, id, slug, name, price = "2499") {
  return {
    id,
    name,
    slug,
    permalink: `https://${host}/product/${slug}/`,
    prices: { price, regular_price: price, currency_code: "GBP", currency_minor_unit: 2 },
    images: [{ src: `https://${host}/wp-content/uploads/${id}.jpg` }],
    stock_status: "instock",
  };
}

function frontendSearch(host, id, slug, title, amount) {
  return `<html class="woocommerce"><body><ul class="products"><li class="product type-product post-${id}" data-product_id="${id}"><a class="woocommerce-LoopProduct-link" href="/product/${slug}/"><h2>${title}</h2><span class="price">£${amount}</span></a></li></ul></body></html>`;
}

function detailPage(host, id, slug, title, amount, regular = "30.00") {
  const canonical = `https://${host}/product/${slug}/`;
  return `<html class="woocommerce"><body><div class="product type-product" data-product_id="${id}"><h1>${title}</h1><p class="price">£${amount}</p><form data-product_variations='[{"variation_id":${Number(id) + 1000},"display_price":${Number(amount)},"display_regular_price":${Number(regular)},"is_in_stock":true}]'></form></div><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: title, sku: String(id), url: canonical, offers: { price: amount, priceCurrency: "GBP" } })}</script></body></html>`;
}

test("Form Nutrition uses the generic Woo waterfall when Store API search is not usable", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "formnutrition.com";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/wp-json/") return json({ namespaces: ["wp/v2"], routes: { "/wp/v2": {} } });
    if (url.pathname === "/" && url.searchParams.get("s") === "protein") return new Response(frontendSearch(host, "2001", "plant-protein", "Plant Protein Vanilla", "27.00"), { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/product/plant-protein" || url.pathname === "/product/plant-protein/") return new Response(detailPage(host, "2001", "plant-protein", "Plant Protein Vanilla", "27.00"), { status: 200, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected Form Nutrition request ${url}`);
  };
  try {
    const search = await executeConnectorRequest("commerce", "search_products", { query: "protein", providers: ["woocommerce_formnutrition"], max_results: 5, include_diagnostics: true }, request());
    assert.equal(search.status, 200);
    assert.equal(search.body.data.results.length, 1);
    const first = search.body.data.results[0];
    assert.equal(first.product_id, "2001");
    assert.equal(first.price.amount, 27);
    assert.match(first.canonical_url, /formnutrition\.com\/product\/plant-protein$/);
    assert.equal(first.actions.detail.arguments.canonical_url, first.canonical_url);
    assert.equal(first.diagnostics, undefined);
    assert.equal(search.body.data.providers.woocommerce_formnutrition.compatibility_engine, "woocommerce");
    assert.equal(search.body.data.diagnostics.provider_diagnostics.woocommerce_formnutrition.woo_route_attempts.at(-1).route, "woo_frontend_search");
    assert.equal(getRecipe(host, "commerce.search")?.preferred_route, "woo_frontend_search");

    const detail = await executeConnectorRequest("commerce", "get_product", {
      provider: "woocommerce_formnutrition",
      product_id: first.product_id,
      canonical_url: first.canonical_url,
    }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.product.product_id, "2001");
    assert.equal(detail.body.data.product.price.amount, 27);
    assert.equal(detail.body.data.product.regular_price.amount, 30);
    assert.equal(detail.body.data.product.canonical_url, first.canonical_url);
    assert.equal(detail.body.data.product.actions, undefined);
    assert.equal(detail.body.execution.engine, "woocommerce");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the same WooCommerce engine supports Store API, WPS, and frontend surfaces", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const fixtures = {
    woocommerce_hardandware: { host: "www.hardandware.com", id: 3011, slug: "hard-lamp", title: "Hardware Lamp", route: "store" },
    woocommerce_formnutrition: { host: "formnutrition.com", id: 3012, slug: "form-protein", title: "Form Protein Powder", route: "frontend" },
    woocommerce_gruum: { host: "gruum.com", id: 3013, slug: "gruum-wash", title: "Grooming Wash", route: "wps" },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const fixture = Object.values(fixtures).find((value) => value.host === url.hostname);
    assert.ok(fixture, `unexpected Woo host ${url.hostname}`);
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/wp-json/") {
      if (fixture.route === "store") return json({ namespaces: ["wp/v2", "wc/store/v1"], routes: { "/wc/store/v1/products": {} } });
      if (fixture.route === "wps") return json({ namespaces: ["wp/v2", "wps/v1"], routes: { "/wps/v1/products": {} } });
      return json({ namespaces: ["wp/v2"], routes: { "/wp/v2": {} } });
    }
    if (fixture.route === "store" && url.pathname === "/wp-json/wc/store/v1/products" && url.searchParams.get("per_page") === "1") return json([product(fixture.host, fixture.id, fixture.slug, fixture.title, "2499")]);
    if (fixture.route === "store" && url.pathname === "/wp-json/wc/store/v1/products" && url.searchParams.get("search") === "hardware") return json([product(fixture.host, fixture.id, fixture.slug, fixture.title, "2499")]);
    if (fixture.route === "store" && url.pathname === `/wp-json/wc/store/v1/products/${fixture.id}`) return json(product(fixture.host, fixture.id, fixture.slug, fixture.title, "2499"));
    if (fixture.route === "wps" && url.pathname === "/wp-json/wps/v1/products" && url.searchParams.get("search") === "grooming") return json([product(fixture.host, fixture.id, fixture.slug, fixture.title, "1999")]);
    if (fixture.route === "wps" && url.pathname === `/wp-json/wps/v1/products/${fixture.id}`) return json(product(fixture.host, fixture.id, fixture.slug, fixture.title, "1999"));
    if (fixture.route === "frontend" && url.pathname === "/" && url.searchParams.get("s") === "protein powder") return new Response(frontendSearch(fixture.host, fixture.id, fixture.slug, fixture.title, "21.00"), { status: 200, headers: { "content-type": "text/html" } });
    if (fixture.route === "frontend" && (url.pathname === `/product/${fixture.slug}` || url.pathname === `/product/${fixture.slug}/`)) return new Response(detailPage(fixture.host, fixture.id, fixture.slug, fixture.title, "21.00"), { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  };
  try {
    const cases = [
      ["woocommerce_hardandware", "hardware"],
      ["woocommerce_formnutrition", "protein powder"],
      ["woocommerce_gruum", "grooming"],
    ];
    for (const [provider, query] of cases) {
      const search = await executeConnectorRequest("commerce", "search_products", { query, providers: [provider], max_results: 5 }, request());
      assert.equal(search.status, 200, provider);
      const first = search.body.data.results[0];
      assert.ok(first, provider);
      assert.equal(first.provider, provider);
      assert.equal(first.actions.detail.tool, "commerce_get_product");
      const detail = await executeConnectorRequest("commerce", "get_product", { provider, product_id: first.product_id, canonical_url: first.canonical_url }, request());
      assert.equal(detail.status, 200, provider);
      assert.equal(detail.body.data.product.product_id, first.product_id, provider);
      assert.equal(detail.body.data.product.canonical_url, first.canonical_url, provider);
    }
    assert.equal(getRecipe("hardandware.com", "commerce.search")?.preferred_route, "woo_store_api");
    assert.equal(getRecipe("gruum.com", "commerce.search")?.preferred_route, "woo_product_search_api");
    assert.equal(getRecipe("formnutrition.com", "commerce.search")?.preferred_route, "woo_frontend_search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WooCommerce plain REST routing is tried after an unverified Store API zero", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "www.hardandware.com";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/wp-json/") return json({ namespaces: ["wp/v2", "wc/store/v1"], routes: { "/wc/store/v1/products": {} } });
    if (url.pathname === "/wp-json/wc/store/v1/products") return json([]);
    if (url.searchParams.get("rest_route") === "/wc/store/v1/products" && url.searchParams.get("per_page") === "1") return json([{ id: 4021, name: "Plain Route Tool", slug: "plain-route-tool", permalink: `https://${host}/product/plain-route-tool/`, prices: { price: "1299", currency_code: "GBP", currency_minor_unit: 2 } }]);
    if (url.searchParams.get("rest_route") === "/wc/store/v1/products" && url.searchParams.get("search") === "tool") return json([{ id: 4021, name: "Plain Route Tool", slug: "plain-route-tool", permalink: `https://${host}/product/plain-route-tool/`, prices: { price: "1299", currency_code: "GBP", currency_minor_unit: 2 } }]);
    throw new Error(`unexpected plain-route request ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { query: "tool", providers: ["woocommerce_hardandware"], max_results: 5, include_diagnostics: true }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.results[0].product_id, "4021");
    const wooDiagnostics = result.body.data.diagnostics.provider_diagnostics.woocommerce_hardandware;
    assert.equal(wooDiagnostics.woo_preferred_search, "woo_store_api_plain");
    assert.ok(wooDiagnostics.woo_route_attempts.some((attempt) => attempt.route === "woo_store_api" && attempt.state === "GENUINE_ZERO_RESULTS"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WooCommerce detail rejects mismatched product identity", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "gruum.com";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/wp-json/") return json({ namespaces: ["wp/v2", "wc/store/v1"], routes: { "/wc/store/v1/products": {} } });
    if (url.pathname === "/wp-json/wc/store/v1/products/4999") return json(product(host, 5000, "other-product", "Other Product", "1499"));
    if (url.searchParams.get("rest_route")) return new Response("not found", { status: 404 });
    if (url.pathname === "/product/4999/") return new Response(detailPage(host, "5000", "other-product", "Other Product", "14.99"), { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await executeConnectorRequest("commerce", "get_product", { provider: "woocommerce_gruum", product_id: "4999" }, request());
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, "UPSTREAM_CHANGED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WooCommerce detection reports confidence rather than treating one weak marker as proof", () => {
  const weak = detectWooCommerce("<p>woocommerce</p>");
  assert.equal(weak.platform, null);
  const strongHtml = `<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/client.css"><div class="woocommerce product type-product" data-product_id="88"></div><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Structured Item", sku: "88", offers: { price: "10.00" } })}</script>`;
  const strong = detectWooCommerce(strongHtml);
  assert.equal(strong.platform, "woocommerce");
  assert.ok(strong.confidence >= 0.5);
  assert.ok(strong.signals.length >= 2);
  assert.equal(detectCompatibilityEngine(strongHtml, "https://example.co.uk/product/structured-item").engine, "woocommerce");
});
