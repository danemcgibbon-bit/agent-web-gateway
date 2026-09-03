import assert from "node:assert/strict";
import test from "node:test";

const { CORE_WEBMCP_TOOL_NAMES, TOOL_DEFINITIONS } = await import("../lib/gateway-contract.ts");
const { gatewayTask } = await import("../lib/gateway-server.ts");
const { successEnvelope } = await import("../lib/gateway-runtime.ts");

function envelope(provider, tool, data) {
  return successEnvelope(provider, tool, "gw_presentation", new Date().toISOString(), {
    data,
    sourceUrl: "https://source.example/search",
    mode: "public_http",
  }, {});
}

test("presentation points to the selected verified OpenRent winner", () => {
  const winner = "https://www.openrent.co.uk/property-to-rent/bromley/2-bed-flat-homesdale-road-br2/3006966";
  const result = envelope("rentals", "search_properties", {
    results: [
      {
        provider: "openrent",
        listing_id: "3006966",
        title: "2 Bed Flat, Homesdale Road, BR2",
        canonical_url: winner,
        verification: { status: "verified" },
      },
      {
        provider: "openrent",
        listing_id: "2941236",
        title: "2 Bed Flat, Widmore Road, BR1",
        canonical_url: "https://www.openrent.co.uk/property-to-rent/bromley/2-bed-flat-widmore-road-br1/2941236",
        verification: { status: "verified" },
      },
    ],
    answer_state: "exact_match",
    verification_status: "verified",
    coverage_level: "complete_for_query",
    answer_ready: true,
    agent_action: "answer",
  });
  assert.deepEqual(result.presentation, {
    action: "open_result",
    url: winner,
    title: "2 Bed Flat, Homesdale Road, BR2",
    reason: "Top verified match",
  });
});

test("commerce and jobs expose exact product and job detail URLs", () => {
  const productUrl = "https://store.example/products/black-sneaker";
  const product = envelope("commerce", "search_products", {
    results: [{ provider: "store.example", product_id: "shoe-1", title: "Black sneaker", canonical_url: productUrl }],
    answer_state: "exact_match",
    verification_status: "verified",
    answer_ready: true,
    agent_action: "answer",
  });
  assert.equal(product.presentation.action, "open_result");
  assert.equal(product.presentation.url, productUrl);

  const greenhouseUrl = "https://job-boards.greenhouse.io/stripe/jobs/12345";
  const greenhouse = envelope("jobs", "search", {
    results: [{ provider: "greenhouse", job_id: "greenhouse:stripe:12345", title: "Staff Engineer", canonical_url: greenhouseUrl }],
    answer_state: "exact_matches",
    verification_status: "verified",
    answer_ready: true,
    agent_action: "answer",
  });
  assert.equal(greenhouse.presentation.url, greenhouseUrl);

  const leverUrl = "https://jobs.lever.co/binance/role-1";
  const lever = envelope("jobs", "search", {
    results: [{ provider: "lever", job_id: "lever:binance:role-1", title: "Product Manager", canonical_url: leverUrl }],
    answer_state: "exact_matches",
    answer_ready: true,
    agent_action: "answer",
  });
  assert.equal(lever.presentation.url, leverUrl);
});

test("non-result, partial, zero-result, and unsafe responses never open a page", () => {
  const cases = [
    ["commerce", "search_products", { results: [], answer_state: "no_exact_match", answer_ready: true, agent_action: "answer" }],
    ["rentals", "search_properties", { results: [{ title: "Unverified flat", canonical_url: "https://openrent.co.uk/property-to-rent/example/1", verification: { status: "unverified_candidate" } }], answer_state: "partial", answer_ready: true, agent_action: "report_partial" }],
    ["commerce", "search_products", { results: [{ title: "Unsafe", canonical_url: "javascript:alert(1)" }], answer_state: "exact_match", answer_ready: true, agent_action: "answer" }],
    ["commerce", "search_products", { results: [{ title: "Secret", canonical_url: "https://store.example/products/shoe?access_token=secret" }], answer_state: "exact_match", answer_ready: true, agent_action: "answer" }],
  ];
  for (const [provider, tool, data] of cases) assert.deepEqual(envelope(provider, tool, data).presentation, { action: "none" });
});

test("gateway_task clarification has no presentation destination", async () => {
  const result = await gatewayTask({ goal: "What can Agent Web Gateway do?" }, new Request("https://gateway.example/api/task"));
  assert.equal(result.body.answer_ready, false);
  assert.deepEqual(result.body.presentation, { action: "none" });
});

test("the fixed WebMCP surface remains unchanged", () => {
  assert.equal(CORE_WEBMCP_TOOL_NAMES.length, 10);
  assert.deepEqual(CORE_WEBMCP_TOOL_NAMES, [
    "gateway_task",
    "gateway_capabilities",
    "gateway_find_tool",
    "gateway_call_tool",
    "commerce_search_products",
    "commerce_get_product",
    "jobs_search",
    "jobs_get_listing",
    "rentals_search_properties",
    "rentals_get_listing",
  ]);
  assert.ok(CORE_WEBMCP_TOOL_NAMES.every((name) => TOOL_DEFINITIONS.some((tool) => tool.name === name)));
});
