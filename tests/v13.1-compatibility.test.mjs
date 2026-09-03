import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const baseline = JSON.parse(await fsPromises.readFile(path.join(root, "data/OPENCLAW_COMPAT_BASELINE-v0.13.0.json"), "utf8"));
const humanBaseline = JSON.parse(await fsPromises.readFile(path.join(root, "data/HUMAN_SURFACE_BASELINE-v0.13.0.json"), "utf8"));
const {
  BUILD_ID,
  CORE_WEBMCP_TOOL_NAMES,
  GATEWAY_VERSION,
  TOOL_DEFINITIONS,
  WEBMCP_CONTRACT_VERSION,
  WEBMCP_DISCOVERY_LAYERS,
} = await import("../lib/gateway-contract.ts");
const { validateToolInput } = await import("../lib/gateway-validation.ts");
const { normalizePublicSite, responseMeta, successEnvelope } = await import("../lib/gateway-runtime.ts");
const { gatewayCapabilities, gatewayManifest } = await import("../lib/gateway-server.ts");
const { registerWebMcpTools, runCrossClientBenchmarkFixture, runWebMcpTransportFixture } = await import("../lib/webmcp-bootstrap.ts");
const { withSiteCacheHeaders } = await import("../lib/site-response.ts");

test("v0.13.1 freezes the public names, order, schemas, and annotations", () => {
  assert.equal(GATEWAY_VERSION, "0.13.2");
  assert.equal(BUILD_ID, "agent-web-gateway-v0.13.2");
  assert.equal(WEBMCP_CONTRACT_VERSION, baseline.webmcp_contract_version);
  assert.equal(TOOL_DEFINITIONS.length, baseline.tool_count);
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), baseline.tool_names);
  assert.deepEqual([...CORE_WEBMCP_TOOL_NAMES], baseline.core_tool_names);

  const currentByName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  const changedDescriptions = [];
  for (const expected of baseline.tools) {
    const current = currentByName.get(expected.name);
    assert.ok(current, `missing baseline tool ${expected.name}`);
    assert.deepEqual(current.inputSchema, expected.inputSchema, `${expected.name} input schema changed`);
    assert.deepEqual(current.required, expected.required, `${expected.name} required fields changed`);
    assert.equal(current.readOnlyHint, expected.readOnlyHint, `${expected.name} annotation changed`);
    assert.equal(current.surface ?? null, expected.surface ?? null, `${expected.name} surface changed`);
    assert.deepEqual(current.keywords ?? null, expected.keywords ?? null, `${expected.name} keywords changed`);
    assert.deepEqual(current.discovery_scopes ?? null, expected.discovery_scopes ?? null, `${expected.name} discovery scopes changed`);
    assert.ok(current.description.length <= 500, `${expected.name} description is too long`);
    if (current.description !== expected.description) changedDescriptions.push(current.name);
  }
  assert.deepEqual(changedDescriptions, ["gateway_capabilities"]);
  assert.equal(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size, TOOL_DEFINITIONS.length);
});

test("core descriptions state invocation timing and stop behavior", () => {
  const descriptions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool.description]));
  const firstSentenceRules = {
    gateway_task: /^(?:Default tool|Use)\b/i,
    gateway_capabilities: /^Use when the user asks what the gateway can do/i,
    gateway_find_tool: /^Use only for uncommon functionality/i,
    gateway_call_tool: /^Execute only the exact operation/i,
    commerce_search_products: /^Search products when you already know/i,
    commerce_get_product: /^Use only when the user asks for additional information/i,
    jobs_search: /^Search public job listings when you already know/i,
    jobs_get_listing: /^Use only when the user asks for additional details/i,
    rentals_search_properties: /^Search public rental listings when you already know/i,
    rentals_get_listing: /^Use only when the user asks for additional details/i,
  };
  for (const [name, rule] of Object.entries(firstSentenceRules)) assert.match(descriptions.get(name) ?? "", rule, name);
  assert.match(descriptions.get("commerce_search_products") ?? "", /answer_ready.*stop|agent_action=answer.*stop/i);
  assert.match(descriptions.get("commerce_get_product") ?? "", /Do not call after an answer-ready search/i);
  assert.match(descriptions.get("gateway_find_tool") ?? "", /gateway_call_tool/);
  assert.match(descriptions.get("gateway_call_tool") ?? "", /validated arguments/);
});

test("accepted input aliases remain compatible across public site forms", () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "commerce_search_products");
  assert.ok(definition);
  const aliases = validateToolInput(definition, { query: "sweater", site: "tentree.com", audience: "men's", colour: "green", size: "large" });
  assert.equal(aliases.audience, "men");
  assert.equal(aliases.color, "green");
  assert.equal(aliases.size, "L");
  assert.equal(aliases.colour, undefined);
  assert.equal(aliases.site, "tentree.com");
  for (const value of baseline.accepted_input_forms.site) {
    const normalized = normalizePublicSite(value);
    assert.equal(normalized.domain, "tentree.com", value);
  }
});

test("all WebMCP registrations start before any async settlement and emit readiness telemetry", async () => {
  const events = [];
  const visible = [];
  const tools = CORE_WEBMCP_TOOL_NAMES.map((name) => ({ name }));
  const modelContext = {
    registerTool(tool) {
      events.push(`call:${tool.name}`);
      visible.push(tool);
      return Promise.resolve().then(() => events.push(`settled:${tool.name}`));
    },
    getTools() {
      return visible;
    },
  };
  const report = registerWebMcpTools(modelContext, tools, CORE_WEBMCP_TOOL_NAMES);
  assert.deepEqual(events, CORE_WEBMCP_TOOL_NAMES.map((name) => `call:${name}`));
  assert.equal(report.webmcp_ready, false);
  assert.equal(report.register_calls_started, CORE_WEBMCP_TOOL_NAMES.length);
  assert.equal(report.register_calls_completed, 0);

  const settled = await report.registration_settled;
  assert.ok(settled);
  assert.equal(settled.registration_state, "ready");
  assert.equal(settled.webmcp_ready, true);
  assert.equal(settled.register_calls_started, CORE_WEBMCP_TOOL_NAMES.length);
  assert.equal(settled.register_calls_completed, CORE_WEBMCP_TOOL_NAMES.length);
  assert.deepEqual(settled.registered_tool_names, CORE_WEBMCP_TOOL_NAMES);
  assert.deepEqual(settled.self_check.discovered_tool_names, CORE_WEBMCP_TOOL_NAMES);
  assert.equal(settled.self_check.match, true);
  assert.equal(settled.registration_failure_details.length, 0);
  assert.equal(settled.registration_telemetry.build_id, BUILD_ID);
  assert.equal(settled.registration_telemetry.webmcp_ready, true);
  assert.equal(events.filter((event) => event.startsWith("settled:")).length, CORE_WEBMCP_TOOL_NAMES.length);
  assert.ok(events.findIndex((event) => event.startsWith("settled:")) >= CORE_WEBMCP_TOOL_NAMES.length);
});

test("registration failures expose tool, DOMException name, message, and build identity", async () => {
  const failedTool = "commerce_search_products";
  const report = registerWebMcpTools({
    registerTool(tool) {
      if (tool.name === failedTool) return Promise.reject(new DOMException("permission denied", "NotAllowedError"));
      return undefined;
    },
    getTools() {
      return [];
    },
  }, CORE_WEBMCP_TOOL_NAMES.map((name) => ({ name })), CORE_WEBMCP_TOOL_NAMES);
  const settled = await report.registration_settled;
  assert.equal(settled.webmcp_ready, false);
  assert.equal(settled.registration_state, "partial");
  assert.deepEqual(settled.register_failures[0], {
    tool: failedTool,
    error_name: "NotAllowedError",
    message: "permission denied",
    build_id: BUILD_ID,
  });
});

test("deterministic cold-session producer keeps the fixed core usable", () => {
  const report = runWebMcpTransportFixture(20);
  assert.equal(report.fresh_sessions, 20);
  assert.equal(report.first_discovery_successes, 20);
  assert.equal(report.core_registry_complete, 20);
  assert.equal(report.first_gateway_task_invocation_successes, 20);
  assert.equal(report.first_commerce_invocation_successes, 20);
  assert.equal(report.commerce_get_product_invocation_successes, 20);
  assert.equal(report.find_tool_invocation_successes, 20);
  assert.equal(report.call_tool_invocation_successes, 20);
  assert.equal(report.rediscoveries_required, 0);
  assert.equal(report.stale_target_failures, 0);
  assert.equal(report.delayed_registration_failures, 0);
  assert.equal(report.tool_not_discovered_errors, 0);
});

test("minimum cross-client matrix covers five commerce, two jobs, two rentals, and one advanced journey", () => {
  const report = runCrossClientBenchmarkFixture(20);
  assert.equal(report.fresh_sessions_per_journey, 20);
  assert.equal(report.journey_count, 10);
  assert.deepEqual(
    Object.fromEntries(["commerce", "jobs", "rentals", "advanced"].map((category) => [category, report.journeys.filter((journey) => journey.category === category).length])),
    { commerce: 5, jobs: 2, rentals: 2, advanced: 1 },
  );
  assert.equal(report.fallback_count, 0);
  assert.equal(report.rediscoveries_required, 0);
  assert.ok(report.journeys.every((journey) => journey.first_discovery_successes === 20 && journey.first_invocation_successes === 20));
});

test("normal envelopes expose additive identity and deterministic semantic fields", () => {
  const startedAt = new Date().toISOString();
  const envelope = successEnvelope("commerce", "search_products", "gw_v131", startedAt, {
    data: {
      query: "green sweater",
      results: [{ provider: "fixture-shop", product_id: "p-1", title: "Green sweater", price: { amount: 20, currency: "GBP" } }],
      closest_matches: [{ provider: "fixture-shop", product_id: "p-2", title: "Blue sweater" }],
      answer_ready: true,
      agent_action: "answer",
      answer_state: "exact_matches",
    },
    sourceUrl: "https://fixture-shop.example",
    mode: "public_http",
  }, { query: "green sweater" });
  assert.equal(envelope.status, "success");
  assert.equal(envelope.gateway_version, GATEWAY_VERSION);
  assert.equal(envelope.build_id, BUILD_ID);
  assert.equal(envelope.webmcp_contract_version, WEBMCP_CONTRACT_VERSION);
  assert.equal(envelope.agent_action, "answer");
  assert.equal(envelope.answer_ready, true);
  assert.equal(envelope.summary, "Returned 1 matching result.");
  assert.equal(envelope.result.product_id, "p-1");
  assert.equal(envelope.alternatives[0].product_id, "p-2");
  assert.equal(envelope.meta.build_id, BUILD_ID);
  assert.equal(envelope.meta.webmcp_contract_version, WEBMCP_CONTRACT_VERSION);
  assert.deepEqual(gatewayCapabilities("commerce").meta.build_id, BUILD_ID);
  assert.deepEqual(responseMeta("gw_v131", startedAt).webmcp_contract_version, WEBMCP_CONTRACT_VERSION);
});

test("discovery telemetry keeps page, OpenClaw, and ChatGPT layers distinct", async () => {
  const manifest = await gatewayManifest("semantic");
  assert.deepEqual(Object.keys(manifest.webmcp.discovery_layers), Object.keys(WEBMCP_DISCOVERY_LAYERS));
  assert.equal(manifest.webmcp.discovery_layers.PAGE_DISCOVERY.api, "document.modelContext.getTools()");
  assert.equal(manifest.webmcp.discovery_layers.OPENCLAW_DISCOVERY.status, "external_black_box");
  assert.equal(manifest.webmcp.discovery_layers.CHATGPT_DISCOVERY.status, "external_black_box");
});

test("cache policy keeps root HTML fresh and assets cacheable without a service worker", async () => {
  const rootResponse = withSiteCacheHeaders(new Response("<html></html>", { headers: { "content-type": "text/html" } }), "/");
  assert.equal(rootResponse.headers.get("cache-control"), "no-cache, must-revalidate");
  const hashedAsset = withSiteCacheHeaders(new Response("body", { headers: { "content-type": "text/javascript" } }), "/assets/index-BA9tHv1n.js");
  assert.equal(hashedAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const publicAsset = withSiteCacheHeaders(new Response("body", { headers: { "content-type": "image/svg+xml" } }), "/favicon.svg");
  assert.equal(publicAsset.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.equal(rootResponse.headers.get("permissions-policy"), null);

  const assetFiles = (await fsPromises.readdir(path.join(root, "dist/client/assets"))).filter((name) => /\.(?:css|js|mjs)$/.test(name));
  assert.ok(assetFiles.length > 0);
  assert.ok(assetFiles.every((name) => /-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs)$/.test(name)), assetFiles.join(", "));
  const publicFiles = fs.readdirSync(path.join(root, "public"));
  assert.equal(publicFiles.some((name) => /service.?worker|sw\.js/i.test(name)), false);
});

test("rendered human surface stays byte-stable after hidden metadata changes", async () => {
  const source = await fsPromises.readFile(path.join(root, "app/page.tsx"), "utf8");
  const sourceStart = source.indexOf("export default function Home()");
  const visibleSource = source.slice(sourceStart).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<WebMcpChecker\s*\/>/g, "").replace(/\s+/g, " ").trim();
  assert.equal(Buffer.byteLength(visibleSource), humanBaseline.source_visible_jsx_bytes);
  assert.equal(crypto.createHash("sha256").update(visibleSource).digest("hex"), humanBaseline.source_visible_jsx_sha256);

  const appUrl = new URL("../dist/server/index.js", import.meta.url);
  appUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: app } = await import(appUrl.href);
  const response = await app.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  const html = await response.text();
  const runtimeMatch = html.match(/<script id="agent-webmcp-runtime" type="application\/json">([\s\S]*?)<\/script>/i);
  assert.ok(runtimeMatch);
  const runtime = JSON.parse(runtimeMatch[1]);
  assert.equal(runtime.build_id, BUILD_ID);
  assert.equal(runtime.webmcp_ready, false);
  for (const field of ["bootstrap_started_ms", "register_calls_started", "register_calls_completed", "register_failures", "registered_tool_names", "toolchange_count", "bootstrap_ready_ms", "document_visibility_state", "build_id"]) {
    assert.ok(Object.hasOwn(runtime, field), `missing runtime telemetry field ${field}`);
  }
  const bodyStart = html.indexOf("<body");
  const bodyEnd = html.indexOf("</body>");
  const visibleBody = html.slice(bodyStart, bodyEnd + "</body>".length).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<section class="webmcp-checker"[\s\S]*?<\/section>/i, "").replace(/\s+/g, " ").trim();
  const hash = crypto.createHash("sha256").update(visibleBody).digest("hex");
  assert.equal(Buffer.byteLength(visibleBody), humanBaseline.rendered_visible_body_bytes);
  assert.equal(hash, humanBaseline.rendered_visible_body_sha256);
  assert.equal(response.headers.get("permissions-policy"), null);
});
