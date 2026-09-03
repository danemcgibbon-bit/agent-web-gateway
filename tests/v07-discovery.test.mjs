import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  detectFrameworks,
  discoverScriptUrls,
  extractApiCandidates,
  extractEmbeddedState,
  findEmbeddedObjects,
  inspectJavascriptBundles,
  rememberRecipe,
  getRecipe,
} = await import("../lib/embedded-state.ts");
const { classifyAmazonResponse } = await import("../connectors/amazon/index.ts");
const { parseArgosDetail, parseArgosSearch } = await import("../connectors/argos/index.ts");
const { resetJohnLewisCaches } = await import("../connectors/johnlewis/index.ts");
const { executeConnectorRequest } = await import("../lib/gateway-server.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

test("generic embedded-state extraction parses framework state without evaluating scripts", () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">{"@type":"Product","name":"State Lamp","sku":"B0STATE1234"}</script>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { product: { asin: "B0STATE1234", name: "State Lamp", price: { amount: 29.99, currency: "GBP" } } } } })}</script>
    <script id="__APOLLO_STATE__" type="application/json">${JSON.stringify({ ROOT_QUERY: { product: { asin: "B0STATE1234", name: "State Lamp" } } })}</script>
    <script>self.__next_f.push([1,"product payload"])</script>
  </head><body><div id="__next" data-reactroot></div></body></html>`;

  const frameworks = detectFrameworks(html);
  assert.ok(frameworks.frameworks.includes("nextjs"));
  assert.ok(frameworks.frameworks.includes("react"));
  assert.ok(frameworks.rendering === "mixed" || frameworks.rendering === "ssr");

  const states = extractEmbeddedState(html);
  assert.ok(states.some((state) => state.kind === "json_ld"));
  assert.ok(states.some((state) => state.kind === "next_data"));
  assert.ok(states.some((state) => state.kind === "apollo_state"));
  assert.ok(states.some((state) => state.kind === "next_flight"));
  const products = findEmbeddedObjects(states, (object) => object.asin === "B0STATE1234");
  assert.ok(products.length >= 1);
});

test("bundle and API discovery is same-origin, bounded, and read-only", () => {
  const html = `<script src="/_next/static/chunks/app.js"></script><script src="https://cdn.example.test/vendor.js"></script>`;
  assert.deepEqual(discoverScriptUrls(html, "https://www.amazon.co.uk/s?k=lamp"), ["https://www.amazon.co.uk/_next/static/chunks/app.js"]);
  const candidates = extractApiCandidates(`const search = "/api/search?term=lamp"; const gql = "/graphql"; const write = "/checkout";`, "https://www.amazon.co.uk/_next/static/chunks/app.js");
  assert.ok(candidates.some((candidate) => candidate.url === "https://www.amazon.co.uk/api/search?term=lamp"));
  assert.ok(candidates.some((candidate) => candidate.kind === "graphql"));
  assert.ok(!candidates.some((candidate) => candidate.url.includes("checkout")));
});

test("bundle inspection only fetches bounded same-origin scripts and records clues", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), "https://www.amazon.co.uk/_next/static/chunks/app.js");
    return new Response('const endpoint = "/api/search?term="; const product = "/api/products/";', { status: 200 });
  };
  try {
    const controller = new AbortController();
    const result = await inspectJavascriptBundles(
      '<script src="/_next/static/chunks/app.js"></script><script src="https://cdn.example.test/vendor.js"></script>',
      "https://www.amazon.co.uk/s?k=lamp",
      { signal: controller.signal, correlationId: "test", startedAt: new Date().toISOString() },
    );
    assert.equal(calls, 1);
    assert.equal(result.inspected_scripts.length, 1);
    assert.ok(result.candidates.some((candidate) => candidate.kind === "search"));
    assert.ok(result.candidates.some((candidate) => candidate.kind === "product"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recipe cache keeps validated access strategies for deterministic reuse", () => {
  rememberRecipe({
    domain: "example.co.uk",
    capability: "commerce.search",
    execution_mode: "first_party_api",
    request: { method: "GET", url_template: "https://example.co.uk/api/search?q={query}" },
    parser: "example_products_v1",
    validator: "validCommonProduct",
    last_verified_at: "2026-09-01T00:00:00.000Z",
    success_rate: 1,
  });
  assert.equal(getRecipe("example.co.uk", "commerce.search")?.execution_mode, "first_party_api");
});

test("Amazon classification and Argos parsing retain strict product boundaries", () => {
  assert.equal(classifyAmazonResponse("We do not support your session or client. Please verify you are human.", undefined, "search"), "CHALLENGE_OR_BLOCK");
  assert.equal(classifyAmazonResponse('<html><body><h1>Amazon search results</h1><div class="s-result-item" data-asin="B0STATE1234"><a href="/dp/B0STATE1234">State Lamp</a></div></body></html>', undefined, "search"), "SEARCH_RESULTS");

  const searchHtml = `<html><body><div data-testid="component-product-card" data-product-id="7751077"><a href="/product/7751077" aria-label="Argos Home Nyx Metal Floor Lamp"><img alt="Argos Home Nyx Metal Floor Lamp" src="https://www.4rgos.it/image.jpg"><span itemprop="price" content="30.00">£30.00</span><h2>Argos Home Nyx Metal Floor Lamp</h2></a></div></body></html>`;
  const search = parseArgosSearch(searchHtml);
  assert.equal(search.classification, "SEARCH_RESULTS");
  assert.equal(search.results[0].product_id, "7751077");
  assert.deepEqual(search.results[0].price, { amount: 30, currency: "GBP" });

  const detailHtml = `<html><head><link rel="canonical" href="https://www.argos.co.uk/product/7751077"><meta property="og:title" content="Buy Argos Home Nyx Metal Floor Lamp | Argos"></head><body><h1>Argos Home Nyx Metal Floor Lamp</h1><div data-product-id="7751077"><span itemprop="price" content="40.00">£40.00</span></div></body></html>`;
  const detail = parseArgosDetail(detailHtml, "https://www.argos.co.uk/product/7751077", "7751077");
  assert.equal(detail?.product_id, "7751077");
  assert.deepEqual(detail?.price, { amount: 40, currency: "GBP" });
});

test("John Lewis Next.js catalogue state supports validated search-to-detail chaining", async () => {
  resetJohnLewisCaches();
  const originalFetch = globalThis.fetch;
  const product = {
    productId: "110436965",
    title: "John Lewis Mushroom Rechargeable Portable Dimmable Table Lamp",
    url: "https://www.johnlewis.com/john-lewis-mushroom-rechargeable-portable-dimmable-table-lamp/p110436965",
    price: { amount: 70, currency: "GBP" },
    averageRating: 4.3,
    reviewCount: 253,
    image: "https://media.johnlewiscontent.com/i/JohnLewis/112418692",
    isAvailableToOrder: true,
  };
  const page = (detail = false) => `<!doctype html><html><head><link rel="canonical" href="${product.url}"></head><body><h1>${product.title}</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products: detail ? [product] : [product] } } })}</script></body></html>`;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\\nAllow: /\\n", { status: 200 });
    if (url.includes("/search?search-term=table")) return new Response(page(), { status: 200, headers: { "content-type": "text/html" } });
    if (url.includes("/product/p110436965")) return new Response(page(true), { status: 200, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected John Lewis request: ${url}`);
  };
  try {
    const search = await executeConnectorRequest("johnlewis", "search_products", { query: "table", max_results: 5, currency: "GBP", locale: "en-GB", include_diagnostics: true }, request());
    assert.equal(search.status, 200);
    assert.equal(search.body.execution.mode, "public_http");
    assert.equal(search.body.data.results[0].product_id, "110436965");
    assert.equal(search.body.data.results[0].price.amount, 70);
    assert.ok(search.body.data.diagnostics.frameworks_detected.includes("nextjs"));
    const detail = await executeConnectorRequest("johnlewis", "get_product", { product_id: search.body.data.results[0].product_id, currency: "GBP", locale: "en-GB" }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.source.provider, "John Lewis UK");
    assert.equal(detail.body.data.product.product_id, "110436965");
    assert.equal(detail.body.data.product.url, product.url);
    const unified = await executeConnectorRequest("commerce", "search_products", { query: "table", providers: ["johnlewis"], max_results: 5, currency: "GBP", locale: "en-GB" }, request());
    assert.equal(unified.status, 200);
    assert.equal(unified.body.data.results[0].provider, "johnlewis");
    assert.equal(unified.body.data.results[0].canonical_url, product.url);
    const unifiedDetail = await executeConnectorRequest("commerce", "get_product", { provider: "johnlewis", product_id: unified.body.data.results[0].product_id, currency: "GBP", locale: "en-GB" }, request());
    assert.equal(unifiedDetail.status, 200);
    assert.equal(unifiedDetail.body.data.product.product_id, "110436965");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connector registration keeps read-only tools invokable by generic WebMCP clients", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /annotations: \{ readOnlyHint: true \}/);
  assert.doesNotMatch(source, /untrustedContent/);
});
