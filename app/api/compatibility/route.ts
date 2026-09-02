import { compatibilityBenchmarkReport } from "../../../lib/compatibility-benchmark";

export async function GET(): Promise<Response> {
  return Response.json(compatibilityBenchmarkReport(), {
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
