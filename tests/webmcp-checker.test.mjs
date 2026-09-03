import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";

import {
  checkWebMcp,
  WEBMCP_CHECKER_TIMEOUT_MS,
  WEBMCP_DIRECTORY_TIMEOUT_MS,
  WEBMCP_CHECKER_MAX_HTML_BYTES,
} from "../lib/webmcp-checker.ts";
import { CONNECTOR_TIMEOUT_MS } from "../lib/gateway-runtime.ts";

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = defaultFetch;
});

function homepage(html, headers = {}) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html", ...headers },
  });
}

function directory(payload = { ok: true, supported: false, host: "example.com" }) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function defaultFetch(input) {
  const url = new URL(String(input));
  if (url.hostname === "webmcp.com") return directory();
  return homepage("<html></html>");
}

test("gateway self-test fixture detects an imperative registration", async () => {
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage("<script>document.modelContext.registerTool({ name: 'demo' });</script>");
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "detected");
  assert.equal(result.confidence, "high");
  assert.equal(result.signals.imperative_registration_detected, true);
  assert.equal(result.recommendation, "prefer_native_webmcp");
});

test("a normal page returns no_signal without treating page copy as evidence", async () => {
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage("<h1>WebMCP compatibility</h1><p>We help agents browse.</p>");
  const result = await checkWebMcp("example.com");

  assert.equal(result.status, "no_signal");
  assert.equal(result.signals.declarative_tool_count, 0);
  assert.equal(result.signals.webmcp_related_signal, false);
  assert.equal(result.inspection.html_checked, true);
  assert.equal(result.inspection.bounded, true);
  assert.equal(result.verification.directory.status, "not_indexed");
});

test("directory verification detects a known site even when live inspection is blocked", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "webmcp.com") return directory({
      ok: true,
      supported: true,
      host: "example.com",
      matchedHost: "example.com",
      site: {
        host: "example.com",
        url: "https://example.com",
        type: "live",
        apiSurface: "spec",
        toolCount: 2,
        tools: [
          { name: "search", description: "Search", kind: "answer", impl: "imperative", page: "/" },
          { name: "checkout", description: "Checkout", kind: "transact", impl: "imperative", page: "/checkout" },
        ],
      },
    });
    throw new Error("live page blocked");
  };
  const result = await checkWebMcp("https://example.com/checkout");

  assert.equal(result.status, "detected");
  assert.equal(result.confidence, "high");
  assert.equal(result.verification.directory.status, "verified");
  assert.equal(result.verification.directory.tool_count, 2);
  assert.equal(result.verification.directory.matching_tool_count, 1);
  assert.deepEqual(result.verification.directory.other_tool_pages, ["/"]);
  assert.equal(result.verification.live_scan.status, "unable_to_check");
  assert.match(result.evidence[0], /Verified in the Agent Web Gateway catalog/);
});

test("comments and string literals are not mistaken for registration code", async () => {
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage(
    "<script>// document.modelContext.registerTool({});</script>" +
    "<script>const copy = \"WebMCP document.modelContext.registerTool(\";</script>",
  );
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "no_signal");
  assert.equal(result.signals.imperative_registration_detected, false);
  assert.equal(result.signals.webmcp_related_signal, false);
});

test("bracket access, aliases, and the current polyfill signal are recognized", async () => {
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage(
    "<script>const ctx = document[\"modelContext\"]; ctx[\"registerTool\"]({name:'search'});</script>",
  );
  const current = await checkWebMcp("https://example.com/", undefined, { directory: false });
  assert.equal(current.status, "detected");
  assert.equal(current.signals.imperative_registration_detected, true);

  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage(
    "<script>import { provideContext } from '@mcp-b/webmcp-polyfill'; provideContext({name:'search'});</script>",
  );
  const polyfill = await checkWebMcp("https://example.com/", undefined, { directory: false });
  assert.equal(polyfill.status, "detected");
  assert.equal(polyfill.signals.polyfill_registration_detected, true);
});

test("declarative WebMCP forms are counted only when both required attributes exist", async () => {
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage(
    "<form toolname=\"search\" tooldescription=\"Search the catalogue\"></form>" +
    "<form toolname=\"incomplete\"></form>" +
    "<p>toolname=not-a-form tooldescription=not-a-tool</p>",
  );
  const result = await checkWebMcp("https://example.com/catalog");

  assert.equal(result.status, "detected");
  assert.equal(result.confidence, "high");
  assert.equal(result.signals.declarative_tool_count, 1);
});

test("imperative registration in a same-origin bundle is detected", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (new URL(url).hostname === "webmcp.com") return directory();
    if (url === "https://example.com/") return homepage("<script src=\"/assets/app.js\"></script>");
    if (url === "https://example.com/assets/app.js") return new Response(
      "window.ready = true; document.modelContext.registerTool({name:'search'});",
      { headers: { "content-type": "application/javascript" } },
    );
    throw new Error("unexpected request " + url);
  };
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "detected");
  assert.equal(result.signals.imperative_registration_detected, true);
  assert.equal(result.inspection.same_origin_scripts_checked, 1);
});

test("modulepreload bundles can prove the gateway's abstract registration path", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (new URL(url).hostname === "webmcp.com") return directory();
    if (url === "https://example.com/") return homepage("<link rel=\"modulepreload\" href=\"/assets/app.js\">");
    if (url === "https://example.com/assets/app.js") return new Response(
      "const modelContext = document.modelContext; modelContext.registerTool({name:'search'});",
      { headers: { "content-type": "application/javascript" } },
    );
    throw new Error("unexpected request " + url);
  };
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "detected");
  assert.equal(result.signals.imperative_registration_detected, true);
  assert.equal(result.inspection.same_origin_scripts_checked, 1);
});

test("legacy registration and weak runtime references are distinguished", async () => {
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage("<script>const mc = document.modelContext;</script>");
  const possible = await checkWebMcp("https://example.com/");
  assert.equal(possible.status, "possible");
  assert.equal(possible.signals.webmcp_related_signal, true);
  assert.equal(possible.signals.imperative_registration_detected, false);

  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage("<script>navigator.modelContext.registerTool({name:'legacy'});</script>");
  const legacy = await checkWebMcp("https://example.com/");
  assert.equal(legacy.status, "detected");
  assert.equal(legacy.signals.legacy_registration_detected, true);
});

test("Permissions-Policy tools=() is reported as disabled", async () => {
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "webmcp.com" ? directory() : homepage("<h1>Page</h1>", { "permissions-policy": "geolocation=(), tools=()" });
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "disabled");
  assert.equal(result.confidence, "high");
  assert.equal(result.signals.permissions_policy_tools_disabled, true);
});

test("unsafe targets are blocked before any outbound request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return homepage("<p>should not be fetched</p>");
  };
  const result = await checkWebMcp("http://127.0.0.1:8787/");

  assert.equal(result.status, "unable_to_check");
  assert.equal(result.error_code, "UNSAFE_TARGET");
  assert.equal(result.requested_url, "http://127.0.0.1:8787/");
  assert.equal(calls, 0);
});

test("redirects to a private address are rejected and not followed", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/internal" },
    });
  };
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "unable_to_check");
  assert.equal(calls, 2);
});

test("oversized responses return unable_to_check without exposing content", async () => {
  globalThis.fetch = async () => new Response("ignored", {
    headers: {
      "content-type": "text/html",
      "content-length": String(WEBMCP_CHECKER_MAX_HTML_BYTES + 1),
    },
  });
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "unable_to_check");
  assert.equal(result.error_code, "RESPONSE_TOO_LARGE");
  assert.equal(result.final_url, null);
  assert.deepEqual(result.evidence, []);
});

test("upstream timeout is reported without a false WebMCP result", async () => {
  globalThis.fetch = async () => {
    throw new DOMException("timed out", "AbortError");
  };
  const result = await checkWebMcp("https://example.com/");

  assert.equal(result.status, "unable_to_check");
  assert.equal(result.error_code, "UPSTREAM_TIMEOUT");
  assert.equal(result.signals.declarative_tool_count, 0);
});

test("checker budgets leave room for a bounded upstream response", () => {
  assert.ok(WEBMCP_DIRECTORY_TIMEOUT_MS >= CONNECTOR_TIMEOUT_MS);
  assert.ok(WEBMCP_CHECKER_TIMEOUT_MS > WEBMCP_DIRECTORY_TIMEOUT_MS);
});
