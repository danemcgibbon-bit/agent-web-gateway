import { AGENT_MANUAL } from "../../lib/agent-manual";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return Response.json(AGENT_MANUAL, {
    headers: {
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
