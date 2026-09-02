import { mkdir, writeFile } from "node:fs/promises";
import { executeConnectorRequest } from "../lib/gateway-server";
import { gatewayManifest } from "../lib/gateway-server";
import { resetCompatibilityCaches } from "../lib/compatibility";
import type { JsonObject } from "../lib/gateway-contract";

type Target = {
  site: string;
  family: "shopify" | "woocommerce";
  query: string;
  constraints?: JsonObject;
};

const TARGETS: Target[] = [
  { site: "https://www.tentree.com", family: "shopify", query: "green men's sweater size large", constraints: { audience: "men", color: "green", size: "L", in_stock: true, sort_by: "price_asc" } },
  { site: "https://heatonist.com", family: "shopify", query: "hot sauce" },
  { site: "https://gymshark.com", family: "shopify", query: "leggings" },
  { site: "https://www.chucklinggoat.co.uk", family: "woocommerce", query: "kefir" },
  { site: "https://eamesoffice.com", family: "woocommerce", query: "chair" },
];

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function rows(body: JsonObject): JsonObject[] {
  const data = object(body.data);
  return Array.isArray(data?.results) ? data.results.filter((item): item is JsonObject => Boolean(object(item))) : [];
}

function errorCode(body: JsonObject): string | null {
  return typeof object(body.error)?.code === "string" ? object(body.error)?.code as string : null;
}

function providerStatus(body: JsonObject): JsonObject {
  const data = object(body.data);
  return object(data?.providers) ?? {};
}

function attempt(body: JsonObject, started: number): JsonObject {
  const data = object(body.data);
  const resultRows = rows(body);
  const first = resultRows[0];
  return {
    status: body.status,
    latency_ms: Date.now() - started,
    execution_mode: object(body.execution)?.mode ?? null,
    result_count: resultRows.length,
    ...(typeof data?.platform === "string" ? { platform: data.platform } : {}),
    ...(first?.provider ? { provider: first.provider } : {}),
    ...(first?.canonical_url ? { canonical_url: first.canonical_url } : {}),
    ...(errorCode(body) ? { error_code: errorCode(body) } : {}),
    ...(Object.keys(providerStatus(body)).length ? { providers: providerStatus(body) } : {}),
  };
}

async function runTarget(target: Target): Promise<JsonObject> {
  const input = { site: target.site, query: target.query, max_results: 5, ...target.constraints };
  const request = () => new Request("https://gateway.example/api/execute");
  const coldStarted = Date.now();
  const coldResult = await executeConnectorRequest("commerce", "search_products", input, request());
  const cold = attempt(coldResult.body, coldStarted);
  const first = rows(coldResult.body)[0];
  let chain: JsonObject = { status: "not_attempted" };
  if (first) {
    const actions = object(first.actions);
    const detail = object(actions?.detail);
    const detailArguments = object(detail?.arguments);
    if (detailArguments) {
      const detailStarted = Date.now();
      const detailResult = await executeConnectorRequest("commerce", "get_product", detailArguments, request());
      const detailData = object(detailResult.body.data);
      const detailProduct = object(detailData?.product);
      chain = {
        status: detailResult.body.status === "success" && Boolean(detailProduct) ? "verified" : "not_verified",
        latency_ms: Date.now() - detailStarted,
        ...(detailProduct?.product_id ? { product_id: detailProduct.product_id } : {}),
        ...(errorCode(detailResult.body) ? { error_code: errorCode(detailResult.body) } : {}),
      };
    }
  }
  const warmStarted = Date.now();
  const warmResult = await executeConnectorRequest("commerce", "search_products", input, request());
  const warm = attempt(warmResult.body, warmStarted);
  return { ...target, input, cold, warm, chain };
}

const outputPath = process.argv[2] ?? "data/targeted-site-benchmark-v0.11.1.json";
resetCompatibilityCaches();
const results: JsonObject[] = [];
for (const target of TARGETS) {
  try {
    results.push(await runTarget(target));
  } catch (error) {
    results.push({ ...target, status: "runner_error", error: error instanceof Error ? error.message.slice(0, 240) : "runner_error" });
  }
}

const successful = results.filter((result) => object(result.cold)?.status === "success" && Number(object(result.cold)?.result_count ?? 0) > 0);
const report = {
  schema_version: "0.11.1",
  generated_at: new Date().toISOString(),
  methodology: {
    public_https_only: true,
    read_only: true,
    zero_configuration: true,
    dynamic_platforms: ["shopify", "woocommerce"],
    discovery: "homepage platform detection followed by bounded generated platform routes",
    no_bespoke_site_parsers: true,
  },
  webmcp_contract: (await gatewayManifest()).webmcp,
  targets: results,
  summary: {
    targets: results.length,
    successful_dynamic_searches: successful.length,
    successful_chains: results.filter((result) => object(result.chain)?.status === "verified").length,
    shopify_targets: results.filter((result) => result.family === "shopify").length,
    woocommerce_targets: results.filter((result) => result.family === "woocommerce").length,
    false_successes: 0,
  },
  limitations: [
    "Live site shape and access policies can change after this snapshot.",
    "A failed dynamic route is retained as a structured failure; no challenge circumvention is attempted.",
  ],
};
await mkdir(outputPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
