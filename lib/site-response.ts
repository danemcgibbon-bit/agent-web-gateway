const FINGERPRINTED_ASSET_PATH = /^(?:\/_next\/static\/|\/assets\/).+-[A-Za-z0-9_-]{8,}\.[^/]+$/;
const REVALIDATED_ASSET_PATH = /^(?:\/_next\/static\/|\/assets\/|\/favicon\.svg$|\/[^/]+\.svg$)/;

/** Apply deployment cache policy without changing the rendered page. */
export function withSiteCacheHeaders(response: Response, pathname: string): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const headers = new Headers(response.headers);
  let changed = false;

  if (pathname === "/" && contentType.includes("text/html")) {
    headers.set("cache-control", "no-cache, must-revalidate");
    changed = true;
  } else if (FINGERPRINTED_ASSET_PATH.test(pathname)) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
    changed = true;
  } else if (REVALIDATED_ASSET_PATH.test(pathname) && !headers.get("cache-control")?.includes("no-store")) {
    headers.set("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
    changed = true;
  }

  if (!changed) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
