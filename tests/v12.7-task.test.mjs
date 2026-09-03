import assert from "node:assert/strict";
import test from "node:test";

const {
  AGENT_QUICKSTART,
  CORE_WEBMCP_TOOL_NAMES,
  getToolDefinition,
  TOOL_DEFINITIONS,
} = await import("../lib/gateway-contract.ts");
const { validateToolInput } = await import("../lib/gateway-validation.ts");
const { planGatewayTask, taskResultSummary } = await import("../lib/gateway-task.ts");
const { gatewayTask } = await import("../lib/gateway-server.ts");

test("gateway_task is the first fixed WebMCP tool and the guide names real contracts", () => {
  assert.equal(CORE_WEBMCP_TOOL_NAMES[0], "gateway_task");
  assert.equal(getToolDefinition("gateway_task")?.operation, "task");
  assert.equal(getToolDefinition("gateway_task")?.deprecated, undefined);
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.name === "gateway_task"));
  for (const [name, example] of Object.entries(AGENT_QUICKSTART.examples)) {
    const definition = getToolDefinition(name);
    assert.ok(definition, `missing example tool ${name}`);
    assert.doesNotThrow(() => validateToolInput(definition, example), name);
  }
});

test("gateway_task deterministically extracts a targeted commerce request", () => {
  const plan = planGatewayTask({ goal: "Find the cheapest green men's sweater currently available in size Large on https://www.tentree.com/" });
  assert.ok(plan.route);
  assert.equal(plan.route.vertical, "commerce");
  assert.equal(plan.route.provider + "_" + plan.route.tool, "commerce_search_products");
  assert.deepEqual(plan.route.arguments, {
    query: "sweater",
    response_format: "concise",
    site: "https://www.tentree.com",
    audience: "men",
    color: "green",
    size: "L",
    in_stock: true,
    sort_by: "price_asc",
  });
});

test("gateway_task routes jobs and rentals without an architecture lesson", () => {
  const jobs = planGatewayTask({ goal: "Find strategy consulting jobs in London." });
  assert.ok(jobs.route);
  assert.equal(jobs.route.provider + "_" + jobs.route.tool, "jobs_search");
  assert.deepEqual(jobs.route.arguments, { response_format: "concise", query: "strategy consulting", location: "London" });

  const rentals = planGatewayTask({ goal: "Find two-bedroom whole properties under £1,800 in Bristol." });
  assert.ok(rentals.route);
  assert.equal(rentals.route.provider + "_" + rentals.route.tool, "rentals_search_properties");
  assert.deepEqual(rentals.route.arguments, {
    location: "Bristol",
    response_format: "concise",
    min_bedrooms: 2,
    max_bedrooms: 2,
    max_price_pcm: 1800,
    whole_property_only: true,
  });
});

test("specialist contracts accept the documented human aliases", () => {
  const definition = getToolDefinition("commerce_search_products");
  assert.ok(definition);
  const normalized = validateToolInput(definition, { query: "sweater", colour: "green", audience: "mens", size: "large", sort: "price_asc" });
  assert.equal(normalized.color, "green");
  assert.equal(normalized.audience, "men");
  assert.equal(normalized.size, "L");
  assert.equal(normalized.sort_by, "price_asc");
  assert.equal(normalized.sort, undefined);
});

test("ambiguous gateway_task requests return a clear clarification", async () => {
  const result = await gatewayTask({ goal: "Find something useful." }, new Request("https://gateway.example/api/task"));
  assert.equal(result.status, 200);
  assert.equal(result.body.agent_action, "clarify");
  assert.equal(result.body.answer_ready, false);
  assert.equal(result.body.next_action, null);
  assert.match(String(result.body.clarification), /product|job|rental/i);
});

test("gateway task summaries are deterministic answer capsules", () => {
  assert.equal(taskResultSummary("commerce", { results: [{ title: "Hudson Sweater" }], search_objective: "exhaustive_ranked" }), "Hudson Sweater is the best matching result currently found.");
  assert.equal(taskResultSummary("jobs", { results: [{ title: "Strategy Lead" }] }), "Found 1 qualifying job listing.");
  assert.match(taskResultSummary("rentals", { results: [] }, true), /partial source coverage/);
});
