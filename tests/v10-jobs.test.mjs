import assert from "node:assert/strict";
import test from "node:test";

const { executeConnectorRequest, gatewayCapabilities, gatewayManifest } = await import("../lib/gateway-server.ts");
const { compatibilityProvider } = await import("../lib/compatibility-catalog.ts");
const { compatibilityProviderRelevance } = await import("../lib/compatibility.ts");

function request() {
  return new Request("https://gateway.example/api/execute");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function greenhouseJob(board, id = 101) {
  return {
    id,
    title: "Senior Software Engineer",
    location: { name: "London, United Kingdom" },
    departments: [{ name: "Engineering" }],
    content: "<p>Build reliable systems for customers.</p>",
    absolute_url: "https://job-boards.greenhouse.io/" + board + "/jobs/" + id,
    metadata: [{ name: "Salary", value: "£90,000 - £110,000 per year" }],
    updated_at: "2026-08-30T10:00:00Z",
  };
}

function leverJob(board, id = "abc123") {
  return {
    id,
    text: "Product Manager",
    categories: {
      location: "Remote",
      department: "Product",
      team: "Core Product",
      commitment: "Full-time",
    },
    descriptionPlain: "Own the product roadmap and customer discovery programme.",
    hostedUrl: "https://jobs.lever.co/" + board + "/" + id,
    salaryRange: { min: 80000, max: 100000, currency: "GBP", interval: "year" },
    workplaceType: "remote",
    updatedAt: 1788084000000,
  };
}

test("one Greenhouse engine supports search, detail, and explicit chaining", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "boards-api.greenhouse.io");
    if (url.pathname === "/v1/boards/stripe/jobs") return json([greenhouseJob("stripe")]);
    if (url.pathname === "/v1/boards/stripe/jobs/101") return json(greenhouseJob("stripe"));
    throw new Error("unexpected Greenhouse request " + url);
  };
  try {
    const search = await executeConnectorRequest("jobs", "search", {
      company: "stripe",
      query: "software engineer",
      location: "London",
      max_results: 5,
      include_diagnostics: true,
    }, request());
    assert.equal(search.status, 200);
    const result = search.body.data.results[0];
    assert.equal(result.provider, "greenhouse");
    assert.equal(result.platform, "greenhouse");
    assert.equal(result.job_id, "greenhouse:stripe:101");
    assert.equal(result.salary.min, 90000);
    assert.equal(result.actions.detail.tool, "jobs_get_listing");
    assert.deepEqual(result.actions.detail.arguments, {
      provider: "greenhouse",
      job_id: "greenhouse:stripe:101",
      company: "stripe",
      canonical_url: "https://job-boards.greenhouse.io/stripe/jobs/101",
    });
    const detail = await executeConnectorRequest("jobs", "get_listing", { ...result.actions.detail.arguments, include_diagnostics: true }, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.listing.job_id, result.job_id);
    assert.equal(detail.body.data.listing.title, result.title);
    assert.equal(detail.body.data.diagnostics.identity_verified, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one Lever engine normalizes public posting fields and chains detail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.lever.co");
    if (url.pathname === "/v0/postings/binance") {
      assert.equal(url.searchParams.get("limit"), "20");
      return json([leverJob("binance")]);
    }
    if (url.pathname === "/v0/postings/binance/abc123") {
      assert.equal(url.searchParams.get("limit"), null);
      return json(leverJob("binance"));
    }
    throw new Error("unexpected Lever request " + url);
  };
  try {
    const search = await executeConnectorRequest("jobs", "search", {
      company: "binance",
      query: "product manager",
      remote: true,
      max_results: 5,
    }, request());
    assert.equal(search.status, 200);
    const result = search.body.data.results[0];
    assert.equal(result.provider, "lever");
    assert.equal(result.job_id, "lever:binance:abc123");
    assert.equal(result.remote, true);
    assert.deepEqual(result.salary, { min: 80000, max: 100000, currency: "GBP", interval: "year" });
    const detail = await executeConnectorRequest("jobs", "get_listing", result.actions.detail.arguments, request());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.listing.job_id, result.job_id);
    assert.equal(detail.body.source.compatibility_engine, "lever");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unified jobs preserves useful results when one platform fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "boards-api.greenhouse.io") return json([greenhouseJob(url.pathname.split("/")[3], 202)]);
    if (url.hostname === "api.lever.co") throw new Error("simulated Lever outage");
    throw new Error("unexpected request " + url);
  };
  try {
    const result = await executeConnectorRequest("jobs", "search", { query: "engineer", max_results: 5, include_diagnostics: true }, request());
    assert.equal(result.status, 200);
    assert.ok(result.body.data.results.length > 0);
    assert.equal(result.body.data.coverage.greenhouse.status, "success");
    assert.equal(result.body.coverage.lever.status, "upstream_blocked");
    assert.ok(result.body.data.diagnostics.provider_diagnostics["lever:binance"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("job semantic validation rejects a generic shell as a false success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json([{
    id: 303,
    title: "Jobs",
    absolute_url: "https://job-boards.greenhouse.io/stripe/jobs/303",
  }]);
  try {
    const result = await executeConnectorRequest("jobs", "search", { company: "stripe", query: "jobs", max_results: 5 }, request());
    assert.equal(result.status, 502);
    assert.equal(result.body.status, "error");
    assert.equal(result.body.error.code, "UPSTREAM_CHANGED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("jobs capability metadata and unified commerce relevance are agent-readable", async () => {
  const form = compatibilityProvider("woocommerce_formnutrition");
  assert.ok(form);
  assert.equal(compatibilityProviderRelevance("protein powder", form), true);
  assert.equal(compatibilityProviderRelevance("floor lamp", form), false);
  const capabilities = gatewayCapabilities("jobs");
  assert.equal(capabilities.status, "success");
  assert.deepEqual(capabilities.data.capabilities.jobs.recommended_tools, ["jobs_search", "jobs_get_listing"]);
  assert.ok(capabilities.data.capabilities.jobs.platform_families.greenhouse.companies_available >= 5);
  const manifest = await gatewayManifest();
  assert.ok(manifest.tools.some((tool) => tool.tool === "jobs_search"));
  assert.ok(manifest.tools.some((tool) => tool.tool === "jobs_get_listing"));
  assert.ok(manifest.verticals.jobs.providers.greenhouse.support_maturity);
});
