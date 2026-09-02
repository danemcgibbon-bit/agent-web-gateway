import { gatewayStatus } from "../../../lib/gateway-server";

export async function GET(): Promise<Response> {
  return Response.json(await gatewayStatus(), {
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
