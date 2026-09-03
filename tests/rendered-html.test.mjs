import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const appUrl = new URL("../dist/server/index.js", import.meta.url);
  appUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: app } = await import(appUrl.href);

  const response = await app.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /id="agent-gateway-brief"/);
  assert.match(html, /id="agent-web-gateway-manual"/);
  assert.match(html, /rel="alternate"[^>]+type="application\/json"[^>]+href="\/agent\.json"/i);
  assert.match(html, /"primary_interface":"native_webmcp"/);
  assert.match(html, /"gateway_mode":"read_only"/);
  assert.match(html, /Turn ordinary websites into/);
  assert.match(html, /More reliable/);
  const visibleHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  assert.match(visibleHtml, /Does your favorite website use WebMCP\?/);
  assert.doesNotMatch(visibleHtml, /gateway_task|agent_action|Shopify Ajax|JSON schema/i);

  const manualMatch = html.match(/<script id="agent-web-gateway-manual" type="application\/json">([\s\S]*?)<\/script>/i);
  assert.ok(manualMatch);
  const inlineManual = JSON.parse(manualMatch[1]);
  const agentResponse = await app.fetch(
    new Request("http://localhost/agent.json", {
      headers: { accept: "application/json" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
  assert.equal(agentResponse.status, 200);
  assert.deepEqual(await agentResponse.json(), inlineManual);
});
