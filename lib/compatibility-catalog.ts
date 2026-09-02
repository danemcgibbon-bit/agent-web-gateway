/**
 * Tested public examples used by the generic compatibility engines.
 *
 * This catalog is deliberately small and explicit for benchmarking, health,
 * and routing optimization. It is not an eligibility list or a public URL
 * proxy: caller-supplied sites use the separate dynamic path with a fixed
 * platform family and bounded read-only routes.
 */

export type CompatibilityEngine =
  | "shopify"
  | "woocommerce"
  | "nextjs"
  | "algolia"
  | "structured_ssr"
  | "known_recipe";

export type CompatibilityProviderDefinition = {
  id: string;
  name: string;
  domain: string;
  base_url: string;
  engine: CompatibilityEngine;
  categories: string[];
  keywords?: string[];
  search_path?: string;
  enabled: boolean;
  dynamic?: boolean;
  site_origin?: string;
};

export const COMPATIBILITY_PROVIDERS = [
  {
    id: "shopify_represent",
    name: "Represent",
    domain: "representclo.com",
    base_url: "https://representclo.com",
    engine: "shopify",
    categories: ["fashion", "clothing", "streetwear"],
    keywords: ["hoodie", "t-shirt", "jacket", "sneaker", "streetwear"],
    enabled: true,
  },
  {
    id: "shopify_rapanuiclothing",
    name: "Rapanui",
    domain: "rapanuiclothing.com",
    base_url: "https://rapanuiclothing.com",
    engine: "shopify",
    categories: ["fashion", "clothing", "sustainable"],
    keywords: ["t-shirt", "hoodie", "clothing", "organic", "sustainable"],
    enabled: true,
  },
  {
    id: "shopify_pipandnut",
    name: "Pip & Nut",
    domain: "pipandnut.com",
    base_url: "https://pipandnut.com",
    engine: "shopify",
    categories: ["food", "grocery", "nutrition"],
    keywords: ["nut", "nuts", "butter", "snack", "spread", "food"],
    enabled: true,
  },
  {
    id: "woocommerce_hardandware",
    name: "Hard & Ware",
    domain: "hardandware.com",
    base_url: "https://www.hardandware.com",
    engine: "woocommerce",
    categories: ["home", "garden", "hardware"],
    keywords: ["tool", "hardware", "garden", "screw", "storage", "workshop"],
    enabled: true,
  },
  {
    id: "woocommerce_formnutrition",
    name: "Form Nutrition",
    domain: "formnutrition.com",
    base_url: "https://formnutrition.com",
    engine: "woocommerce",
    categories: ["nutrition", "food", "fitness"],
    keywords: ["protein", "powder", "supplement", "bar", "vegan", "nutrition", "shake"],
    enabled: true,
  },
  {
    id: "woocommerce_gruum",
    name: "Gruum",
    domain: "gruum.com",
    base_url: "https://gruum.com",
    engine: "woocommerce",
    categories: ["beauty", "grooming", "skincare"],
    keywords: ["shampoo", "soap", "beard", "grooming", "skincare", "moisturiser"],
    enabled: true,
  },
  {
    id: "structured_decathlon",
    name: "Decathlon UK",
    domain: "decathlon.co.uk",
    base_url: "https://www.decathlon.co.uk",
    engine: "structured_ssr",
    search_path: "/search?Ntt={query}",
    categories: ["sport", "fitness", "cycling", "running", "outdoor"],
    keywords: ["bike", "cycling", "running", "football", "tent", "fitness"],
    enabled: true,
  },
  {
    id: "structured_currys",
    name: "Currys UK",
    domain: "currys.co.uk",
    base_url: "https://www.currys.co.uk",
    engine: "structured_ssr",
    search_path: "/search?q={query}",
    categories: ["electronics", "computers", "appliances", "gaming"],
    keywords: ["laptop", "monitor", "headphones", "television", "gaming", "computer"],
    enabled: true,
  },
  {
    id: "structured_dunelm",
    name: "Dunelm UK",
    domain: "dunelm.com",
    base_url: "https://www.dunelm.com",
    engine: "structured_ssr",
    search_path: "/search?q={query}",
    categories: ["home", "furniture", "lighting", "bedding", "storage"],
    keywords: ["lamp", "sofa", "desk", "bed", "bedding", "curtain", "furniture", "storage", "wardrobe"],
    enabled: true,
  },
] as const satisfies readonly CompatibilityProviderDefinition[];

export const COMPATIBILITY_PROVIDER_IDS = COMPATIBILITY_PROVIDERS.map((provider) => provider.id);

export function compatibilityProvider(value: unknown): CompatibilityProviderDefinition | undefined {
  return COMPATIBILITY_PROVIDERS.find((provider) => provider.id === value);
}

export function isCompatibilityProvider(value: unknown): value is (typeof COMPATIBILITY_PROVIDER_IDS)[number] {
  return COMPATIBILITY_PROVIDER_IDS.includes(value as (typeof COMPATIBILITY_PROVIDER_IDS)[number]);
}

export function compatibilityHostMatches(hostname: string, provider: CompatibilityProviderDefinition): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const domain = provider.domain.toLowerCase().replace(/^www\./, "");
  if (provider.dynamic) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

/** A normalized public domain used by a dynamically detected compatible site. */
export function isDynamicProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value.replace(/^www\./i, ""));
}

export function dynamicProductPathAllowed(value: string, providerId: string): boolean {
  if (!isDynamicProviderId(providerId)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase().replace(/^www\./, "") !== providerId.toLowerCase().replace(/^www\./, "")) return false;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
    if (!segments.length || ["search", "cart", "checkout", "account", "login", "admin", "wp-admin", "wp-login.php", "wp-json", "api", "internal-api", "graphql", "feed", "tag", "category", "collections"].includes(segments[0])) return false;
    return segments[0] === "product" || segments[0] === "products" || segments[0] === "shop" || segments.length === 1;
  } catch {
    return false;
  }
}

/**
 * Keep URL acceptance platform-aware. WooCommerce themes commonly use a
 * single-slug permalink, while Shopify and the structured retailer fixtures
 * have more explicit product routes.
 */
export function compatibilityProductPathAllowed(value: string, provider: CompatibilityProviderDefinition): boolean {
  try {
    const url = new URL(value);
    if (!compatibilityHostMatches(url.hostname, provider)) return false;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
    if (!segments.length) return false;
    const first = segments[0];
    if (["search", "cart", "checkout", "account", "login", "admin", "wp-admin", "wp-login.php", "wp-json", "api", "internal-api", "graphql", "feed", "tag", "category", "product-category", "product-tag", "page"].includes(first)) return false;
    if (provider.engine === "shopify") return first === "product" || first === "products";
    if (provider.engine === "woocommerce") {
      if (first === "product" || first === "products" || first === "shop") return segments.length >= 2;
      return segments.length >= 2 || (segments.length === 1 && !["shop", "products", "product"].includes(first));
    }
    return /^(?:product|products|item|items|product-detail|p|dp)$/.test(first) && segments.length >= 2
      || segments.length >= 2;
  } catch {
    return false;
  }
}
