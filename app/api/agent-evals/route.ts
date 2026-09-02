import { agentEvalReport } from "../../../lib/agent-evals";

export async function GET(): Promise<Response> {
  return Response.json(agentEvalReport(), {
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
