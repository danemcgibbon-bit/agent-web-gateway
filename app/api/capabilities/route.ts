import { gatewayCapabilities } from "../../../lib/gateway-server";

const headers = {
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const body = gatewayCapabilities({
    capability: params.get("capability") ?? "all",
    ...(params.has("scope") ? { scope: params.get("scope") } : {}),
    ...(params.has("goal") ? { goal: params.get("goal") } : {}),
    ...(params.has("level") ? { level: params.get("level") } : {}),
  });
  const status = body.status === "error" ? 400 : 200;
  return Response.json(body, { status, headers });
}

export async function OPTIONS(): Promise<Response> {
  return Response.json({ status: "success", service: "agent-web-gateway-capabilities" }, { headers });
}
