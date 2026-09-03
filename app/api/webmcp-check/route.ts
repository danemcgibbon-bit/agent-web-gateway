import { checkWebMcp } from "../../../lib/webmcp-checker";

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export async function OPTIONS(): Promise<Response> {
  return Response.json({ status: "success", service: "agent-web-gateway-webmcp-check" }, { headers });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4_000) return Response.json({ status: "error", error_code: "INPUT_INVALID" }, { status: 400, headers });
    const parsed: unknown = JSON.parse(raw);
    const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { url?: unknown }).url : undefined;
    if (typeof value !== "string" || !value.trim()) return Response.json({ status: "error", error_code: "INPUT_INVALID" }, { status: 400, headers });
    return Response.json(await checkWebMcp(value, request.signal), { headers });
  } catch {
    return Response.json({ status: "error", error_code: "INPUT_INVALID" }, { status: 400, headers });
  }
}
