import assert from "node:assert/strict";
import test from "node:test";

const appUrl = new URL("../dist/server/index.js", import.meta.url);
appUrl.searchParams.set("gateway-api", `${process.pid}-${Date.now()}`);
const { default: app } = await import(appUrl.href);
const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function execute(body) {
  const response = await app.fetch(new Request("http://localhost/api/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, ctx);
  return { status: response.status, body: await response.json() };
}

test("execution API validates the shared connector schema end to end", async () => {
  const result = await execute({
    provider: "ikea",
    tool: "search_products",
    arguments: { query: "KALLAX", currency: "GBP", locale: "en-GB" },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.status, "error");
  assert.equal(result.body.error.code, "INPUT_INVALID");
  assert.match(result.body.correlation_id, /^gw_/);
  assert.equal(result.body.provider, "ikea");
  assert.equal(result.body.tool, "search_products");
});

test("execution API rejects tools outside the provider allowlist", async () => {
  const result = await execute({
    provider: "booking",
    tool: "search_products",
    arguments: {},
  });

  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "CONNECTOR_UNAVAILABLE");
  assert.equal(result.body.error.retryable, false);
});

test("status API reports execution reality rather than a pending placeholder", async () => {
  const response = await app.fetch(new Request("http://localhost/api/status", { headers: { accept: "application/json" } }), env, ctx);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.deepEqual(body.execution_api, { path: "/api/execute", status: "online", request_contract: "{ provider, tool, arguments }", advanced_discovery: "/api/find-tool", advanced_dispatch: "/api/call-tool" });
  assert.ok(body.connectors.every((connector) => ["online", "degraded", "blocked", "offline", "unknown"].includes(connector.health_status)));
  assert.ok(body.connectors.every((connector) => connector.health_status !== "pending"));
  assert.equal(body.connectors.some((connector) => ["booking", "ebay", "eventbrite", "rail", "travel"].includes(connector.id)), false);
  assert.equal(typeof body.metrics.retained, "number");
});

test("manifest API exposes tool capability metadata for zero-setup use", async () => {
  const response = await app.fetch(new Request("http://localhost/api/manifest", { headers: { accept: "application/json" } }), env, ctx);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.ok(body.tools.some((tool) => tool.tool === "amazon_search_products" && tool.available_execution_modes.includes("public_http")));
  assert.equal(body.tools.some((tool) => ["ebay_search_items", "rail_search_journeys"].includes(tool.tool)), false);
});

test("capabilities API exposes a compact planning response", async () => {
  const response = await app.fetch(new Request("http://localhost/api/capabilities?capability=commerce", { headers: { accept: "application/json" } }), env, ctx);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.data.capabilities.commerce.recommended_tool, "commerce_search_products");
  assert.equal(body.data.capabilities.commerce.providers.ikea, "online");
  assert.equal(body.source.trust, "gateway_interface");
  assert.equal(body.meta.schema_version, "1.0");
});
