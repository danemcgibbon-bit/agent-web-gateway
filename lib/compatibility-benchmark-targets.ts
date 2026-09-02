import { COMPATIBILITY_PROVIDERS, type CompatibilityProviderDefinition } from "./compatibility-catalog";

export type CompatibilityBenchmarkTarget = CompatibilityProviderDefinition & {
  benchmark_query: string;
  benchmark_category: string;
  benchmark_notes?: string;
};

function catalogTarget(id: string, benchmark_query: string, benchmark_category: string): CompatibilityBenchmarkTarget {
  const provider = COMPATIBILITY_PROVIDERS.find((item) => item.id === id);
  if (!provider) throw new Error(`Missing catalog provider ${id}`);
  return { ...provider, benchmark_query, benchmark_category };
}

function target(
  id: string,
  name: string,
  domain: string,
  base_url: string,
  engine: "shopify" | "woocommerce",
  categories: string[],
  keywords: string[],
  benchmark_query: string,
  benchmark_category: string,
): CompatibilityBenchmarkTarget {
  return { id, name, domain, base_url, engine, categories, keywords, enabled: true, benchmark_query, benchmark_category };
}

/**
 * Fixed public HTTPS targets for the v0.11 compatibility benchmark. These
 * are benchmark-only definitions: they are not accepted as caller-supplied
 * URLs and are not added to the default unified-provider routing pool.
 */
export const SHOPIFY_BENCHMARK_TARGETS: readonly CompatibilityBenchmarkTarget[] = [
  catalogTarget("shopify_represent", "hoodie", "fashion"),
  catalogTarget("shopify_rapanuiclothing", "t-shirt", "fashion"),
  catalogTarget("shopify_pipandnut", "peanut butter", "food"),
  target("shopify_heatonist", "Heatonist", "heatonist.com", "https://heatonist.com", "shopify", ["food", "grocery", "hot sauce"], ["hot sauce", "sauce", "chilli", "food"], "hot sauce", "food"),
  target("shopify_deathwishcoffee", "Death Wish Coffee", "deathwishcoffee.com", "https://deathwishcoffee.com", "shopify", ["food", "grocery", "coffee"], ["coffee", "espresso", "ground", "food"], "coffee", "food"),
  target("shopify_bombas", "Bombas", "bombas.com", "https://bombas.com", "shopify", ["fashion", "clothing", "socks"], ["sock", "socks", "apparel", "clothing"], "socks", "fashion"),
  target("shopify_gymshark", "Gymshark", "gymshark.com", "https://gymshark.com", "shopify", ["fashion", "clothing", "fitness"], ["leggings", "shorts", "sports bra", "activewear"], "leggings", "fashion"),
  target("shopify_pipcorn", "Pipcorn", "pipsnacks.com", "https://pipsnacks.com", "shopify", ["food", "grocery", "snacks"], ["popcorn", "snack", "food"], "popcorn", "food"),
  target("shopify_allbirds", "Allbirds", "allbirds.com", "https://www.allbirds.com", "shopify", ["fashion", "clothing", "shoes"], ["shoes", "sneakers", "runner", "wool"], "shoes", "fashion"),
  target("shopify_blueland", "Blueland", "blueland.com", "https://www.blueland.com", "shopify", ["home", "cleaning", "household"], ["cleaner", "cleaning", "soap", "home"], "cleaning", "home"),
];

export const WOOCOMMERCE_BENCHMARK_TARGETS: readonly CompatibilityBenchmarkTarget[] = [
  catalogTarget("woocommerce_hardandware", "storage", "home"),
  catalogTarget("woocommerce_formnutrition", "protein", "nutrition"),
  catalogTarget("woocommerce_gruum", "moisturiser", "beauty"),
  target("woocommerce_chucklinggoat", "Chuckling Goat", "chucklinggoat.co.uk", "https://www.chucklinggoat.co.uk", "woocommerce", ["food", "nutrition", "skincare"], ["kefir", "probiotic", "collagen", "gut"], "kefir", "nutrition"),
  target("woocommerce_landyachtz", "Landyachtz", "landyachtz.com", "https://landyachtz.com", "woocommerce", ["sport", "outdoor", "skateboarding"], ["skateboard", "longboard", "wheels", "outdoor"], "skateboard", "sport"),
  target("woocommerce_bonsoy", "Bonsoy", "bonsoy.com", "https://bonsoy.com", "woocommerce", ["food", "grocery", "drinks"], ["soy", "milk", "drink", "food"], "soy milk", "food"),
  target("woocommerce_chaniahoney", "Chania Honey", "chania-honey.gr", "https://chania-honey.gr", "woocommerce", ["food", "grocery", "honey"], ["honey", "food", "grocery"], "honey", "food"),
  target("woocommerce_eamesoffice", "Eames Office", "eamesoffice.com", "https://eamesoffice.com", "woocommerce", ["home", "furniture", "design"], ["chair", "furniture", "poster", "design"], "chair", "home"),
  target("woocommerce_maisonkayser", "Maison Kayser", "maison-kayser.com", "https://maison-kayser.com", "woocommerce", ["food", "bakery", "grocery"], ["bread", "pastry", "bakery", "food"], "bread", "food"),
  target("woocommerce_thompsonhanson", "Thompson + Hanson", "thompsonhanson.com", "https://thompsonhanson.com", "woocommerce", ["home", "furniture", "decor"], ["furniture", "home", "decor", "table"], "furniture", "home"),
];

export const COMPATIBILITY_BENCHMARK_TARGETS = [
  ...SHOPIFY_BENCHMARK_TARGETS,
  ...WOOCOMMERCE_BENCHMARK_TARGETS,
] as const;
