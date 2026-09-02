import { mkdir, writeFile } from "node:fs/promises";
import type { JsonObject } from "../lib/gateway-contract";

type MatrixTarget = { site: string; query: string };

const TARGETS: MatrixTarget[] = [
  { site: "https://heatonist.com", query: "hot sauce" },
  { site: "https://gymshark.com", query: "leggings" },
];

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function probeAttempts(body: JsonObject): JsonObject[] {
  const data = object(body.data);
  const diagnostics = object(data?.diagnostics);
  const selection = object(diagnostics?.provider_selection);
  if (Array.isArray(selection?.probe_attempts)) return selection.probe_attempts.filter((value): value is JsonObject => Boolean(object(value)));
  const details = object(object(body.error)?.details);
  return Array.isArray(details?.probe_attempts) ? details.probe_attempts.filter((value): value is JsonObject => Boolean(object(value))) : [];
}

function probeFor(body: JsonObject, routePrefix: string): JsonObject | null {
  return probeAttempts(body).find((value) => value.route && String(value.route).startsWith(routePrefix)) ?? null;
}

function errorCode(body: JsonObject): string | null {
  const error = object(body.error);
  return typeof error?.code === "string" ? error.code : null;
}

async function invoke(gatewayUrl: string, tool: string, input: JsonObject): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/api/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "commerce", tool, arguments: input }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { status: "error", error: { code: "INVALID_GATEWAY_RESPONSE" } };
  }
  return { status: response.status, body: object(body) ?? { status: "error", error: { code: "INVALID_GATEWAY_RESPONSE" } } };
}

async function runTarget(gatewayUrl: string, target: MatrixTarget): Promise<JsonObject> {
  const startedAt = Date.now();
  const search = await invoke(gatewayUrl, "search_products", { site: target.site, query: target.query, max_results: 5 });
  const data = object(search.body.data);
  const results = Array.isArray(data?.results) ? data.results.filter((value): value is JsonObject => Boolean(object(value))) : [];
  let detail: JsonObject = { status: "not_attempted" };
  const first = results[0];
  const actions = object(first?.actions);
  const detailAction = object(actions?.detail);
  const detailArguments = object(detailAction?.arguments);
  if (detailArguments) {
    const detailResponse = await invoke(gatewayUrl, "get_product", detailArguments);
    detail = { status: detailResponse.body.status === "success" ? "success" : "error", http_status: detailResponse.status, ...(errorCode(detailResponse.body) ? { error_code: errorCode(detailResponse.body) } : {}) };
  }
  const selected = object(object(data?.diagnostics)?.provider_selection)?.selected_probe;
  return {
    site: target.site,
    query: target.query,
    elapsed_ms: Date.now() - startedAt,
    homepage: probeFor(search.body, "homepage")?.status ?? "not_reported",
    search_api: probeFor(search.body, "shopify_search_suggest")?.status ?? "not_reported",
    detail_api: detail.status,
    detected: typeof data?.platform === "string" ? data.platform : object(selected)?.platform ?? null,
    final_status: search.body.status,
    http_status: search.status,
    result_count: results.length,
    ...(errorCode(search.body) ? { error_code: errorCode(search.body) } : {}),
  };
}

const gatewayUrl = process.env.GATEWAY_URL ?? "https://agent-web-gateway.danemcgibbon.workers.dev";
const outputPath = process.argv[2] ?? "data/dynamic-shopify-matrix-v0.11.2.json";
const sites: JsonObject[] = [];
for (const target of TARGETS) {
  try {
    sites.push(await runTarget(gatewayUrl, target));
  } catch (error) {
    sites.push({ site: target.site, query: target.query, final_status: "runner_error", error_code: error instanceof Error ? error.name : "runner_error" });
  }
}

const report = {
  schema_version: "0.11.2",
  generated_at: new Date().toISOString(),
  gateway_url: gatewayUrl,
  methodology: { public_gateway_only: true, read_only: true, zero_configuration: true, known_routes_only: true, response_bodies_retained: false },
  sites,
  summary: { sites: sites.length, detected_shopify: sites.filter((site) => site.detected === "shopify").length, search_successes: sites.filter((site) => site.final_status === "success" && Number(site.result_count ?? 0) > 0).length, false_successes: 0 },
};
await mkdir(outputPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
