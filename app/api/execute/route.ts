import type { JsonObject } from "../../../lib/gateway-contract";
import { executeConnectorRequest } from "../../../lib/gateway-server";

function jsonResponse(body: JsonObject, status = 200, correlationId?: string): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  });
  if (correlationId) headers.set("x-gateway-correlation-id", correlationId);
  return new Response(JSON.stringify(body), { status, headers });
}

export async function OPTIONS(): Promise<Response> {
  return jsonResponse({ status: "success", service: "agent-web-gateway-execute" });
}

export async function POST(request: Request): Promise<Response> {
  let payload: JsonObject;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 64_000) {
      throw new Error("request body too large");
    }
    const parsed: unknown = JSON.parse(raw);
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    const result = await executeConnectorRequest(undefined, undefined, null, request);
    return jsonResponse(result.body, 400, result.correlationId);
  }

  const result = await executeConnectorRequest(
    payload.provider,
    payload.tool,
    payload.arguments,
    request,
  );
  return jsonResponse(result.body, result.status, result.correlationId);
}
