import type { JsonObject } from "../../../lib/gateway-contract";
import { gatewayFindTool } from "../../../lib/gateway-server";

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function bodyStatus(body: JsonObject): number {
  return body.status === "error" ? 400 : 200;
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const body = gatewayFindTool({
    query: params.get("query") ?? "",
    ...(params.has("scope") ? { scope: params.get("scope") } : {}),
    ...(params.has("max_results") ? { max_results: Number(params.get("max_results")) } : {}),
  });
  return Response.json(body, { status: bodyStatus(body), headers });
}

export async function POST(request: Request): Promise<Response> {
  let payload: JsonObject = {};
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 16_000) throw new Error("request body too large");
    const parsed: unknown = JSON.parse(raw);
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    payload = {};
  }
  const body = gatewayFindTool(payload);
  return Response.json(body, { status: bodyStatus(body), headers });
}

export async function OPTIONS(): Promise<Response> {
  return Response.json({ status: "success", service: "agent-web-gateway-find-tool" }, { headers });
}
