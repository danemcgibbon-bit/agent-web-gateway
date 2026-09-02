import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest, gatewayManifest } = await import("../lib/gateway-server.ts");
const { amazonAsinFromInput } = await import("../lib/provider-identifiers.ts");
const { classifyBills, resetRentalCaches, robotsAllows } = await import("../connectors/rentals/index.ts");
const { validateConnectorExecution } = await import("../lib/semantic-validation.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

test("Amazon UK accepts supported product URL shapes and canonicalizes them", () => {
  for (const value of [
    "B0TEST1234",
    "https://www.amazon.co.uk/dp/B0TEST1234?tag=tracking#reviews",
    "https://www.amazon.co.uk/gp/product/B0TEST1234/ref=abc",
    "https://www.amazon.co.uk/gp/aw/d/B0TEST1234?psc=1",
    "https://www.amazon.co.uk/aw/d/B0TEST1234",
  ]) assert.equal(amazonAsinFromInput(value), "B0TEST1234");
  assert.equal(amazonAsinFromInput("https://www.amazon.com/dp/B0TEST1234"), null);
});

test("Amazon product detail uses product-specific fields and preserves the UK canonical URL", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), "https://www.amazon.co.uk/dp/B0TEST1234");
    return new Response(`<!doctype html><html><head><link rel="canonical" href="https://www.amazon.co.uk/dp/B0TEST1234?tag=tracking"><meta property="og:image" content="https://m.media-amazon.co.uk/images/test.jpg"></head><body>
      <span id="productTitle">Wireless Headphones</span>
      <div id="corePrice_feature_div"><span>£39.99</span></div>
      <span id="acrPopover" title="4.4 out of 5 stars"></span><span id="acrCustomerReviewText">1,234 ratings</span>
      <div id="feature-bullets"><ul><li>Noise cancelling</li><li>Bluetooth</li></ul></div>
      <div id="availability">In stock</div><div data-hook="review-body">Comfortable and clear.</div>
    </body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const result = await executeConnectorRequest("amazon", "get_product", {
      product_id: "https://www.amazon.co.uk/gp/aw/d/B0TEST1234?tag=tracking",
      currency: "GBP",
      locale: "en-GB",
    }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.product.product_id, "B0TEST1234");
    assert.equal(result.body.data.product.url, "https://www.amazon.co.uk/dp/B0TEST1234");
    assert.deepEqual(result.body.data.product.price, { amount: 39.99, currency: "GBP" });
    assert.equal(result.body.data.product.review_count, 1234);
    assert.deepEqual(result.body.data.product.features, ["Noise cancelling", "Bluetooth"]);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Amazon challenge pages are blocked rather than exposed as products", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("We are sorry for the inconvenience. We do not support your session or client.", { status: 503 });
  try {
    const result = await executeConnectorRequest("amazon", "search_products", { query: "headphones-v06", max_results: 5, currency: "GBP", locale: "en-GB" }, request());
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, "UPSTREAM_BLOCKED");
    assert.equal(result.body.execution.mode, "public_http");
    assert.equal(result.body.execution.fallback.reason, "no_alternate_zero_config_route");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rental robots policy distinguishes allowed paths from disallowed query filters", () => {
  const robots = "User-agent: *\nAllow: /to-rent/\nDisallow: *max-price=\nDisallow: /account/\n";
  assert.equal(robotsAllows(robots, "https://www.onthemarket.com/to-rent/property/croydon/"), true);
  assert.equal(robotsAllows(robots, "https://www.onthemarket.com/to-rent/property/croydon/?max-price=1800"), false);
  assert.deepEqual(classifyBills("£1,200 pcm + £200 mandatory bills package"), { classification: "some", surcharge_pcm: 200 });
  assert.deepEqual(classifyBills("Bills Included No"), { classification: "none", surcharge_pcm: null });
});

test("rental search returns live-shaped OnTheMarket records with partial OpenRent diagnostics", async () => {
  resetRentalCaches();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("onthemarket.com/robots.txt") || url.includes("openrent.co.uk/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    if (url.includes("onthemarket.com/to-rent/property/croydon")) return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { initialReduxState: { results: { list: [{ id: "1234567", "details-url": "/details/1234567/", "property-title": "2 Bed Flat, Test Road", address: "10 Test Road, CR0 1AA", price: "£1,500 pcm", bedrooms: 2, bathrooms: 1, features: ["Furnished"], summary: "A whole property with £200 mandatory bills package." }] } } } })}</script>`, { status: 200 });
    if (url.includes("onthemarket.com/details/1234567")) return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { initialReduxState: { property: { id: "1234567", canonicalUrl: "https://www.onthemarket.com/details/1234567/", propertyTitle: "2 Bed Flat, Test Road", displayAddress: "10 Test Road, CR0 1AA", priceRaw: 1500, bedrooms: 2, bathrooms: 1, features: ["Furnished"], summary: "A whole property with £200 mandatory bills package." } } } })}</script>`, { status: 200 });
    if (url.includes("openrent.co.uk/properties-to-rent")) return new Response("upstream timeout", { status: 504 });
    throw new Error(`unexpected rental request: ${url}`);
  };
  try {
    const result = await executeConnectorRequest("rentals", "search_properties", { location: "Croydon", min_bedrooms: 2, max_price_pcm: 1800, whole_property_only: true, max_results: 5 }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.results.length, 1);
    assert.equal(result.body.data.results[0].provider, "onthemarket");
    assert.equal(result.body.data.results[0].listing_id, "1234567");
    assert.equal(result.body.data.results[0].effective_price_pcm, 1700);
    assert.deepEqual(result.body.data.results[0].actions.detail, {
      tool: "rentals_get_listing",
      arguments: {
        provider: "onthemarket",
        listing_id: "1234567",
        canonical_url: result.body.data.results[0].canonical_url,
      },
    });
    assert.equal(result.body.data.results[0].bills.surcharge_pcm, 200);
    assert.equal(result.body.data.providers.onthemarket.status, "success");
    assert.equal(result.body.data.providers.openrent.status, "error");
    assert.equal(result.body.data.providers.openrent.code, "UPSTREAM_TIMEOUT");
    const detail = await executeConnectorRequest("rentals", "get_listing", { provider: "onthemarket", listing_id: "1234567", canonical_url: result.body.data.results[0].canonical_url }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.listing.listing_id, "1234567");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unified commerce returns useful IKEA coverage when Amazon is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("sik.search.blue.cdtapps.com")) return new Response(JSON.stringify({ products: [{ itemNo: "12345678", name: "KALLAX alternative lamp", price: 49, url: "https://www.ikea.com/gb/en/p/kallax-alternative-lamp-12345678/" }] }), { status: 200 });
    if (url.includes("amazon.co.uk/s")) return new Response("We do not support your session or client.", { status: 503 });
    throw new Error(`unexpected commerce request: ${url}`);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", { query: "lamp-v06", max_price: 60, max_results: 5 }, request());
    assert.equal(result.status, 200);
    assert.equal(result.body.data.results[0].provider, "ikea");
    assert.equal(result.body.data.results[0].product_id, "12345678");
    assert.deepEqual(result.body.data.results[0].actions.detail, {
      tool: "commerce_get_product",
      arguments: { provider: "ikea", product_id: "12345678", currency: "GBP", locale: "en-GB" },
    });
    assert.equal(result.body.coverage.ikea.status, "success");
    assert.equal(result.body.data.providers.amazon.status, "error");
    assert.equal(result.body.data.providers.ebay, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unified semantic validation rejects a generic rental shell", () => {
  assert.throws(
    () => validateConnectorExecution("rentals", "search_properties", { location: "Croydon" }, { mode: "public_http", sourceUrl: "https://www.openrent.co.uk/properties-to-rent/croydon", data: { location: "Croydon", results: [{ provider: "openrent", listing_id: "search", title: "Properties", canonical_url: "https://www.openrent.co.uk/" }] } }),
    (error) => error.code === "UPSTREAM_CHANGED",
  );
});

test("v0.6 manifest exposes vertical capability metadata", async () => {
  const manifest = await gatewayManifest();
  assert.ok(manifest.verticals.commerce);
  assert.ok(manifest.verticals.rentals);
  assert.equal(manifest.verticals.rentals.providers.rightmove, undefined);
  assert.equal(manifest.verticals.rentals.providers.airbnb, undefined);
  assert.ok(manifest.tools.some((tool) => tool.tool === "commerce_search_products"));
  assert.ok(manifest.tools.some((tool) => tool.tool === "rentals_search_properties"));
});
