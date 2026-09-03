import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest, gatewayManifest } = await import("../lib/gateway-server.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

test("Amazon public HTTP results chain into product detail and carry freshness metadata", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/s?k=wireless+headphones")) {
      return new Response('<html><body><a href="/dp/B0TEST1234"><span class="product-title">Wireless Headphones</span><span>£39.99</span></a></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.includes("/dp/B0TEST1234")) {
      return new Response('<html><head><meta property="og:image" content="https://m.media-amazon.co.uk/images/test.jpg"><link rel="canonical" href="https://www.amazon.co.uk/dp/B0TEST1234"></head><body><span id="productTitle">Wireless Headphones</span><span>£39.99</span><span>4.4 out of 5 stars</span></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected Amazon request: ${url}`);
  };
  try {
    const search = await executeConnectorRequest("amazon", "search_products", { query: "wireless headphones", max_results: 5, currency: "GBP", locale: "en-GB" }, request());
    assert.equal(search.status, 200);
    assert.equal(search.body.execution.mode, "public_http");
    assert.equal(search.body.data.results[0].asin, "B0TEST1234");
    assert.equal(search.body.source.freshness, "live");
    assert.equal(search.body.meta.schema_version, "1.0");
    assert.equal(search.body.meta.request_id, search.body.correlation_id);
    assert.equal(search.body.source.execution_mode, "public_http");
    assert.equal(search.body.coverage.amazon.status, "success");
    const detail = await executeConnectorRequest("amazon", "get_product", { product_id: "B0TEST1234", currency: "GBP", locale: "en-GB" }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.product.product_id, "B0TEST1234");
    assert.equal(detail.body.execution.mode, "public_http");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retired providers fail honestly and are absent from the public manifest", async () => {
  for (const [provider, tool, argumentsValue] of [
    ["ebay", "search_items", { query: "Nintendo Switch", max_results: 5, currency: "GBP", locale: "en-GB" }],
    ["eventbrite", "search_events", { query: "Caribbean", location: "London", max_results: 5, currency: "GBP", locale: "en-GB", timezone: "Europe/London" }],
    ["rail", "search_journeys", { origin: "London", destination: "Brighton", departure_date: "2026-09-18", adults: 2, max_results: 5, locale: "en-GB", timezone: "Europe/London" }],
  ]) {
    const result = await executeConnectorRequest(provider, tool, argumentsValue, request());
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "CONNECTOR_UNAVAILABLE");
    assert.equal(result.body.execution.mode, "public_http");
    assert.equal(result.body.execution.fallback.reason, "not_applicable");
    assert.equal(result.body.coverage[provider].status, "offline");
  }
  const manifest = await gatewayManifest();
  assert.ok(Array.isArray(manifest.tools));
  assert.ok(manifest.tools.some((tool) => tool.tool === "amazon_search_products" && tool.available_execution_modes.includes("public_http")));
  assert.ok(manifest.tools.every((tool) => !["ebay_search_items", "booking_search_hotels", "eventbrite_search_events", "rail_search_journeys"].includes(tool.tool)));
});

test("bounded IKEA cache preserves the validated source mode and freshness", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.match(String(input), /sik\.search\.blue\.cdtapps\.com/);
    return new Response(JSON.stringify({ products: [{ itemNo: "12345678", name: "KALLAX shelving unit", price: 49, url: "https://www.ikea.com/gb/en/p/kallax-shelving-unit-white-12345678/" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const input = { query: "KALLAX cache test", max_results: 5, currency: "GBP", locale: "en-GB" };
    const first = await executeConnectorRequest("ikea", "search_products", input, request());
    const second = await executeConnectorRequest("ikea", "search_products", input, request());
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 1);
    assert.equal(second.body.execution.mode, "cache");
    assert.equal(second.body.execution.cache.source_mode, "first_party_api");
    assert.equal(second.body.execution.fallback.reason, "cache_hit");
    assert.equal(second.body.source.freshness, "cached");
    assert.equal(second.body.source.cache_age_seconds, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
