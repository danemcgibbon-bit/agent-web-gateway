const AMAZON_UK_HOSTS = new Set(["amazon.co.uk", "www.amazon.co.uk"]);

/** Return an Amazon UK ASIN from a bare ID or a supported UK product URL. */
export function amazonAsinFromInput(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^[A-Z0-9]{10}$/i.test(raw)) return raw.toUpperCase();
  try {
    const url = new URL(raw);
    if (!AMAZON_UK_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/(?:^|\/)(?:dp|gp\/product|gp\/aw\/d|aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    return match?.[1]?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

export function canonicalAmazonUkUrl(value: unknown): string | null {
  const productId = amazonAsinFromInput(value);
  return productId ? `https://www.amazon.co.uk/dp/${productId}` : null;
}

