import type { JsonObject } from "../../../lib/gateway-contract";
import { gatewayTask } from "../../../lib/gateway-server";

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function jsonBody(body: JsonObject, status = 200, correlationId?: string): Response {
  const responseHeaders = new Headers(headers);
  if (correlationId) responseHeaders.set("x-gateway-correlation-id", correlationId);
  return Response.json(body, { status, headers: responseHeaders });
}

export async function OPTIONS(): Promise<Response> {
  return jsonBody({ status: "success", service: "agent-web-gateway-task" });
}

export async function POST(request: Request): Promise<Response> {
  let payload: JsonObject;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 16_000) throw new Error("request body too large");
    const parsed: unknown = JSON.parse(raw);
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    payload = {};
  }
  const result = await gatewayTask(payload, request);
  return jsonBody(result.body, result.status, result.correlationId);
}
