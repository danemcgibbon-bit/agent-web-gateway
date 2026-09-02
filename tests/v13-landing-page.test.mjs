import assert from "node:assert/strict";
import test from "node:test";

const { AGENT_MANUAL, AGENT_MANUAL_TOOL_NAMES, validateAgentManualReferences } = await import("../lib/agent-manual.ts");
const { TOOL_DEFINITIONS } = await import("../lib/gateway-contract.ts");
const { GET } = await import("../app/agent.json/route.ts");

test("v0.13.0 agent manual is compact and references only public tools", async () => {
  const serialized = JSON.stringify(AGENT_MANUAL);
  assert.ok(Buffer.byteLength(serialized) >= 1000);
  assert.ok(Buffer.byteLength(serialized) <= 3072);
  assert.deepEqual(validateAgentManualReferences(), {
    valid: true,
    references: [...new Set(AGENT_MANUAL_TOOL_NAMES)],
    missing: [],
  });
  assert.equal(AGENT_MANUAL.quickstart.default_tool, "gateway_task");
  assert.match(AGENT_MANUAL.rules.join(" "), /stop using tools/i);

  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.deepEqual(await response.json(), AGENT_MANUAL);

  const publicNames = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.ok(AGENT_MANUAL_TOOL_NAMES.every((name) => publicNames.has(name)));
});

test("core tool descriptions teach targeting, stopping, and bounded advanced access", () => {
  const descriptions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool.description]));
  assert.match(descriptions.get("gateway_task") ?? "", /agent_action.*answer.*stop/i);
  assert.match(descriptions.get("commerce_search_products") ?? "", /site/i);
  assert.match(descriptions.get("commerce_search_products") ?? "", /manually paginate|browse the source/i);
  assert.match(descriptions.get("commerce_get_product") ?? "", /additional information/i);
  assert.match(descriptions.get("jobs_search") ?? "", /agent_action.*answer.*stop/i);
  assert.match(descriptions.get("rentals_search_properties") ?? "", /agent_action.*answer.*stop/i);
  assert.match(descriptions.get("gateway_find_tool") ?? "", /gateway_call_tool/i);
  assert.match(descriptions.get("gateway_call_tool") ?? "", /exact operation/i);
});
