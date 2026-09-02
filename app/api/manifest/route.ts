import { gatewayManifest } from "../../../lib/gateway-server";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const surface = params.get("surface") ?? "full";
  if (surface !== "full" && surface !== "semantic") {
    return Response.json({
      status: "error",
      error: { code: "INPUT_INVALID", message: "surface must be full or semantic.", retryable: false },
    }, { status: 400, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
  }
  return Response.json(await gatewayManifest({
    surface,
    ...(params.has("site") ? { site: params.get("site") } : {}),
    ...(params.has("query") ? { query: params.get("query") } : {}),
  }), {
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
