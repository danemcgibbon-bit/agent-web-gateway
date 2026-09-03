import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest } = await import("../lib/gateway-server.ts");
const { evaluateRentalConstraints, normalizeRentalListing, resetRentalCaches } = await import("../connectors/rentals/index.ts");
const { resetCompatibilityCaches } = await import("../lib/compatibility.ts");
const { planGatewayTask } = await import("../lib/gateway-task.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function openRentCard(id, title, price) {
  return `<a href="https://www.openrent.co.uk/property-to-rent/bromley/${id}"><div class="fs-3">${title}</div><address>High St, BR1</address><span>${price} pcm</span><ul><li>2 beds</li><li>1 bath</li></ul></a>`;
}

function openRentDetail(id, price, familiesAllowed) {
  return `<!doctype html><html><head><link rel="canonical" href="https://www.openrent.co.uk/property-to-rent/bromley/${id}"></head><body>
    <h1>2 Bed Flat, High St, BR1</h1>
    <div>Rent PCM £${price}</div><div>Maximum Tenants 4</div>
    <table><tr><td>Families Allowed</td><td class="${familiesAllowed ? "text-success" : "text-danger"}">${familiesAllowed ? "Yes" : "No"}</td></tr></table>
  </body></html>`;
}

test("gateway_task extracts family requirements for whole-property rental searches", () => {
  const plan = planGatewayTask({ goal: "Find the cheapest available whole 2+ bedroom flat in Bromley, London under £2,000 that allows families on OpenRent" });
  assert.ok(plan.route);
  assert.equal(plan.route.arguments.families_required, true);
  assert.equal(plan.route.arguments.whole_property_only, true);
  assert.equal(plan.route.arguments.min_bedrooms, 2);
  assert.deepEqual(plan.route.arguments.providers, ["openrent"]);
});

test("family eligibility is unknown without positive evidence and matches explicit allowance", () => {
  const base = { provider: "openrent", listing_id: "family-test", title: "2 Bed Flat, High St, BR1", property_type: "flat", bedrooms: 2, price_pcm: 1600, max_occupants: 4, verification: { status: "verified" } };
  const unknown = normalizeRentalListing(base);
  const unknownEvaluation = evaluateRentalConstraints(unknown, { location: "Bromley", families_required: true });
  assert.equal(unknownEvaluation.states.families, "UNKNOWN");
  const allowed = normalizeRentalListing({ ...base, description: "Families allowed." });
  const allowedEvaluation = evaluateRentalConstraints(allowed, { location: "Bromley", families_required: true });
  assert.equal(allowed.families_allowed, true);
  assert.equal(allowedEvaluation.states.families, "MATCH");
});

test("OpenRent skip pagination reaches cheaper later-page flats and verifies family policy", async () => {
  resetRentalCaches();
  const originalFetch = globalThis.fetch;
  const requestedPages = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    if (url.pathname === "/properties-to-rent/bromley-london") {
      const skip = Number(url.searchParams.get("skip") ?? 0);
      requestedPages.push(skip);
      if (skip === 0) return new Response(`<main>${openRentCard("3006966", "2 Bed Flat, Homesdale Road, BR2", "£1,750")}<a href="${url.toString().replace(/&/g, "&amp;")}&amp;skip=20">2</a></main>`, { status: 200 });
      if (skip === 20) return new Response(`<main>${openRentCard("3012961", "2 Bed Flat, High St, BR1", "£1,600")}</main>`, { status: 200 });
    }
    if (url.pathname.includes("/property-to-rent/bromley/3006966")) return new Response(openRentDetail("3006966", "1,750", true), { status: 200 });
    if (url.pathname.includes("/property-to-rent/bromley/3012961")) return new Response(openRentDetail("3012961", "1,600", true), { status: 200 });
    throw new Error(`unexpected rental request: ${url}`);
  };
  try {
    const result = await executeConnectorRequest("rentals", "search_properties", {
      location: "Bromley, London",
      min_bedrooms: 2,
      max_price_pcm: 2000,
      property_type: "flat",
      whole_property_only: true,
      families_required: true,
      providers: ["openrent"],
      sort_by: "price_asc",
      max_results: 1,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.results[0].listing_id, "3012961");
    assert.equal(result.body.data.results[0].effective_price_pcm, 1600);
    assert.equal(result.body.data.results[0].families_allowed, true);
    assert.deepEqual(requestedPages, [0, 20]);
    assert.equal(result.body.data.providers.openrent.acquisition.pagination_complete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Shopify intent keeps audience-unknown products out of exact results", async () => {
  resetCompatibilityCaches();
  const originalFetch = globalThis.fetch;
  const host = "semantic-unknown-shop.example";
  const unknownAudience = {
    id: "black-sneaker",
    handle: "black-sneaker",
    title: "Black Sneaker",
    product_type: "Sneakers",
    options: [{ name: "Color", values: ["Black"] }, { name: "Size", values: ["L"] }],
    variants: [{ id: "black-sneaker-l", option1: "Black", option2: "L", price: "40.00", available: true }],
    url: "/products/black-sneaker",
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, host);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200 });
    if (url.pathname === "/") return new Response('<html><body><script>window.Shopify={shop:"semantic-unknown"}</script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname === "/search/suggest.json") return json({ resources: { results: { products: [unknownAudience] } } });
    if (url.pathname === "/products.json" && url.searchParams.get("limit") === "1") return json({ products: [unknownAudience] });
    if (url.pathname === "/collections.json") return json({ collections: [] });
    if (url.pathname === "/products.json") return json({ products: [unknownAudience] });
    if (url.pathname === "/products/black-sneaker.js") return json(unknownAudience);
    if (url.pathname === "/wp-json/") return json({}, 404);
    return json({}, 404);
  };
  try {
    const result = await executeConnectorRequest("commerce", "search_products", {
      site: host,
      query: "cheapest men's black sneakers",
      sort_by: "price_asc",
      in_stock: true,
      max_results: 5,
    }, request());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.data.results, []);
    assert.equal(result.body.data.answer_state, "no_exact_match");
    assert.ok(result.body.data.closest_matches.some((item) => item.failed_constraints.includes("audience")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
