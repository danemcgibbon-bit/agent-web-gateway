import assert from "node:assert/strict";
import test from "node:test";

const { resetCompatibilityCaches } = await import("../lib/compatibility.ts");
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

function frontendSearch(host, id, slug, title, amount) {
  return `<html class="woocommerce"><body><ul class="products"><li class="product type-product post-${id}" data-product_id="${id}"><a class="woocommerce-LoopProduct-link" href="/product/${slug}/"><h2>${title}</h2><span class="price">£${amount}</span></a></li></ul></body></html>`;
}

function shopifyProduct(host) {
  return {
    id: 5101,
    handle: "smooth-peanut-butter",
    title: "Smooth Peanut Butter",
    variants: [{ price: "5.99" }],
    images: [{ src: `https://${host}/cdn/peanut-butter.jpg` }],
    available: true,
  };
}

function blocked() {
  return new Response("temporary upstream failure", { status: 503 });
}

test("A. protein intent selects Form Nutrition and excludes IKEA leakage", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.hostname === "formnutrition.com") {
      if (url.pathname === "/robots.txt") return robots();
      if (url.pathname === "/wp-json/") return json({ namespaces: ["wp/v2"], routes: { "/wp/v2": {} } });
      if (url.pathname === "/" && url.searchParams.get("s") === "protein powder") {
        return new Response(frontendSearch(url.hostname, "6101", "plant-protein-powder", "Plant Protein Powder", "27.00"), { status: 200, headers: { "content-type": "text/html" } });
      }
    }
    return blocked();
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { query: "protein powder under £40", max_results: 5, include_diagnostics: true }, request());
    assert.equal(result.status, 200);
    const data = result.body.data;
    assert.ok(data.diagnostics.provider_selection.selected.includes("woocommerce_formnutrition"));
    assert.ok(!data.diagnostics.provider_selection.selected.includes("ikea"));
    assert.equal(data.intent.product_query, "protein powder");
    assert.equal(data.intent.max_price, 40);
    assert.ok(data.results.some((item) => item.provider === "woocommerce_formnutrition"));
    assert.ok(seen.every((url) => !url.hostname.includes("ikea") && !url.hostname.startsWith("sik.search")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("B. storage intent strongly considers IKEA without nutrition stores", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.hostname === "sik.search.blue.cdtapps.com") {
      return json({ products: [{ itemNo: "62010001", name: "KALLAX storage unit", price: 79, url: "https://www.ikea.com/gb/en/p/kallax-storage-unit-62010001/" }] });
    }
    if (url.hostname === "formnutrition.com" || url.hostname === "pipandnut.com") return blocked();
    return blocked();
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { query: "storage unit under £100", max_results: 5, include_diagnostics: true }, request());
    assert.equal(result.status, 200);
    const selection = result.body.data.diagnostics.provider_selection;
    assert.ok(selection.selected.includes("ikea"));
    assert.ok(!selection.selected.includes("woocommerce_formnutrition"));
    assert.ok(!selection.selected.includes("shopify_pipandnut"));
    assert.equal(result.body.data.results[0].provider, "ikea");
    assert.ok(seen.every((url) => !["formnutrition.com", "pipandnut.com"].includes(url.hostname)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C. nut butter intent includes the relevant Shopify store", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.hostname === "pipandnut.com") {
      if (url.pathname === "/robots.txt") return robots();
      if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [shopifyProduct(url.hostname)] } } });
    }
    return blocked();
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { query: "nut butter under £15", max_results: 5, include_diagnostics: true }, request());
    assert.equal(result.status, 200);
    const selection = result.body.data.diagnostics.provider_selection;
    assert.ok(selection.selected.includes("shopify_pipandnut"));
    assert.ok(!selection.selected.includes("ikea"));
    assert.ok(result.body.data.results.some((item) => item.provider === "shopify_pipandnut"));
    assert.ok(seen.some((url) => url.hostname === "pipandnut.com"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D. one bounded retry survives a transient Woo search failure", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  let frontendAttempts = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== "formnutrition.com") return blocked();
    if (url.pathname === "/robots.txt") return robots();
    if (url.pathname === "/wp-json/") return json({ namespaces: ["wp/v2"], routes: { "/wp/v2": {} } });
    if (url.pathname === "/" && url.searchParams.get("s") === "protein powder") {
      frontendAttempts += 1;
      if (frontendAttempts === 1) return blocked();
      return new Response(frontendSearch(url.hostname, "6401", "plant-protein-powder", "Plant Protein Powder", "27.00"), { status: 200, headers: { "content-type": "text/html" } });
    }
    return blocked();
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      query: "protein powder under £40",
      providers: ["woocommerce_formnutrition"],
      max_results: 6,
      include_diagnostics: true,
    }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.providers.woocommerce_formnutrition.status, "success");
    assert.ok(result.body.data.results.length > 0);
    assert.ok(frontendAttempts >= 2);
    assert.equal(result.body.data.diagnostics.provider_diagnostics.woocommerce_formnutrition.transient_retry.outcome, "success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
