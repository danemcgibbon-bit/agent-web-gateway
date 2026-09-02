import { decodeHtmlEntities, extractJsonLd } from "./upstream-parser";
import { fetchText, type ConnectorContext } from "./gateway-runtime";
import type { JsonObject } from "./gateway-contract";

/**
 * Bounded, deterministic helpers for pages that ship useful state alongside
 * their HTML. These helpers deliberately parse data; they never evaluate
 * page JavaScript.
 */

export type FrameworkName =
  | "nextjs"
  | "nuxt"
  | "react"
  | "sveltekit"
  | "angular"
  | "remix"
  | "shopify"
  | "algolia"
  | "apollo_graphql"
  | "ssr"
  | "csr"
  | "unknown";

export type FrameworkDetection = {
  frameworks: FrameworkName[];
  rendering: "ssr" | "csr" | "mixed" | "unknown";
  signals: string[];
};

export type EmbeddedStateKind =
  | "json_ld"
  | "next_data"
  | "next_flight"
  | "apollo_state"
  | "redux_state"
  | "nuxt_state"
  | "sveltekit_state"
  | "angular_transfer_state"
  | "bootstrap_state"
  | "inline_json";

export type EmbeddedState = {
  kind: EmbeddedStateKind;
  source: string;
  value: unknown;
  size: number;
};

export type ApiCandidate = {
  url: string;
  kind: "rest" | "graphql" | "search" | "product" | "listing" | "availability";
  evidence: string;
  source_url: string;
};

export type AlgoliaDetection = {
  application_id: string | null;
  has_public_config: boolean;
  index_names: string[];
  endpoint_hint: string | null;
  evidence: string[];
};

export type BundleInspection = {
  script_urls: string[];
  inspected_scripts: string[];
  candidates: ApiCandidate[];
  failures: Array<{ url: string; reason: string }>;
};

export type ConnectorRecipe = {
  domain: string;
  capability: string;
  execution_mode: "official_api" | "first_party_api" | "public_http";
  engine?: string;
  request: {
    method: "GET" | "POST";
    url_template: string;
  };
  parser: string;
  validator: string;
  last_verified_at: string;
  success_rate?: number;
  shared_code?: string[];
  site_overrides?: string[];
  route_order?: string[];
  preferred_route?: string;
  /** Route-level knowledge only; product answers are never stored here. */
  search_knowledge?: JsonObject;
  /** Semantically validated structural scope routes; colour/price are not cache keys. */
  scope_routes?: JsonObject;
};

export const EMBEDDED_STATE_LIMITS = {
  html_chars: 2_500_000,
  scripts: 40,
  script_chars: 220_000,
  flight_payloads: 12,
  states: 40,
  state_chars: 220_000,
  bundle_urls: 12,
  inspected_bundles: 6,
  bundle_chars: 320_000,
  api_candidates: 40,
} as const;

function boundedHtml(html: string): string {
  return html.slice(0, EMBEDDED_STATE_LIMITS.html_chars);
}

function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;
}

function scriptTags(html: string): Array<{ open: string; body: string }> {
  const output: Array<{ open: string; body: string }> = [];
  const source = boundedHtml(html);
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    output.push({ open: match[1] ?? "", body: (match[2] ?? "").slice(0, EMBEDDED_STATE_LIMITS.script_chars) });
    if (output.length >= EMBEDDED_STATE_LIMITS.scripts) break;
  }
  return output;
}

function parseJson(value: string): unknown | null {
  const decoded = decodeHtmlEntities(value).trim();
  if (!decoded || decoded.length > EMBEDDED_STATE_LIMITS.state_chars) return null;
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
}

function stateKind(id: string, type: string, body: string): EmbeddedStateKind | null {
  const normalized = `${id} ${type}`.toLowerCase();
  const bodyNormalized = body.toLowerCase();
  if (normalized.includes("__next_data__") || bodyNormalized.includes("__next_data__")) return "next_data";
  if (normalized.includes("__apollo_state__") || normalized.includes("apollo") || bodyNormalized.includes("__apollo_state__")) return "apollo_state";
  if (normalized.includes("__nuxt") || normalized.includes("nuxt") || bodyNormalized.includes("__nuxt__")) return "nuxt_state";
  if (normalized.includes("sveltekit") || normalized.includes("svelte-kit") || normalized.includes("data-sveltekit")) return "sveltekit_state";
  if (normalized.includes("transferstate") || normalized.includes("transfer-state") || normalized.includes("ng-state") || normalized.includes("angular") || bodyNormalized.includes("transferstate")) return "angular_transfer_state";
  if (normalized.includes("bootstrap") || normalized.includes("initial_data") || bodyNormalized.includes("__bootstrap__")) return "bootstrap_state";
  if (normalized.includes("redux") || normalized.includes("preloaded") || normalized.includes("initialstate") || normalized.includes("initial-state") || bodyNormalized.includes("__preloaded_state__") || bodyNormalized.includes("__initial_state__")) return "redux_state";
  if (type.toLowerCase() === "application/json") return "inline_json";
  if (/^\s*(?:window\.|self\.|globalThis\.)?(?:__nuxt__|__apollo_state__|__preloaded_state__|__initial_state__)/i.test(body)) return "inline_json";
  return null;
}

function parseScriptState(body: string): unknown | null {
  const direct = parseJson(body);
  if (direct !== null) return direct;
  const assignment = /(?:window|self|globalThis)\s*\.\s*(?:__NUXT__|__APOLLO_STATE__|__PRELOADED_STATE__|__INITIAL_STATE__|__BOOTSTRAP__|__INITIAL_DATA__)\s*=\s*([\[{][\s\S]{0,220000})\s*;?\s*$/i.exec(body.trim())?.[1];
  return assignment ? parseJson(assignment) : null;
}

function flightStates(html: string): EmbeddedState[] {
  const states: EmbeddedState[] = [];
  const pattern = /self\.__next_f\.push\(\s*(\[[\s\S]{0,18000}?\])\s*\)/g;
  for (const match of boundedHtml(html).matchAll(pattern)) {
    const raw = match[1] ?? "";
    const parsed = parseJson(raw);
    if (parsed !== null) {
      states.push({ kind: "next_flight", source: "self.__next_f.push", value: parsed, size: raw.length });
    } else {
      const quoted = /["']((?:\\.|[^"'\\]){1,16_000})["']/.exec(raw)?.[1];
      if (!quoted) continue;
      try {
        const payload = JSON.parse(`"${quoted.replace(/"/g, '\\"')}"`) as string;
        states.push({ kind: "next_flight", source: "self.__next_f.push", value: { payload: decodeHtmlEntities(payload).slice(0, 16_000) }, size: raw.length });
      } catch {
        // Flight payloads can contain transport escapes that are not JSON.
      }
    }
    if (states.length >= EMBEDDED_STATE_LIMITS.flight_payloads) break;
  }
  return states;
}

export function detectFrameworks(html: string): FrameworkDetection {
  const source = boundedHtml(html);
  const lower = source.toLowerCase();
  const frameworks: FrameworkName[] = [];
  const signals: string[] = [];
  const add = (framework: FrameworkName, signal: string): void => {
    if (!frameworks.includes(framework)) frameworks.push(framework);
    if (!signals.includes(signal)) signals.push(signal);
  };

  if (/id=["']__next_data__["']|self\.__next_f\.push|\/_next\//i.test(source)) add("nextjs", "Next.js markers");
  if (/__NUXT__|\/_nuxt\//i.test(source)) add("nuxt", "Nuxt markers");
  if (/data-reactroot|\breact(?:-dom)?\b|__REACT_DEVTOOLS_GLOBAL_HOOK__/i.test(source)) add("react", "React markers");
  if (/__sveltekit|data-sveltekit|\/_app\/immutable\//i.test(source)) add("sveltekit", "SvelteKit markers");
  if (/ng-version|ng-state|transferstate|angular/i.test(source)) add("angular", "Angular markers");
  if (/__remixcontext|remix-run|__remixmanifest/i.test(source)) add("remix", "Remix markers");
  if (/shopifyanalytics|cdn\.shopify|shopify\.theme|window\.shopify|\/products\.json|myshopify\.com/i.test(source)) add("shopify", "Shopify markers");
  if (/(?:algolia|applicationID|applicationId|indexName)/i.test(source)) add("algolia", "Algolia markers");
  if (/__apollo_state__|\bapollo\b|\/graphql(?:[/?"'])/i.test(source)) add("apollo_graphql", "Apollo/GraphQL markers");

  const hasRoot = /<(?:main|article|h1|title)\b|id=["'][^"']*(?:root|app|__next)[^"']*["']/i.test(source);
  const hasState = /application\/ld\+json|__next_data__|self\.__next_f\.push|__nuxt__|__apollo_state__|__bootstrap__|__initial_data__|transferstate|type=["']application\/json["']/i.test(source);
  const visibleText = source.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const likelyClientRendered = /<(?:div|main)[^>]+(?:id|class)=["'][^"']*(?:root|app)[^"']*["'][^>]*>\s*<\/(?:div|main)>/i.test(source)
    || (hasRoot && visibleText.length < 220 && /(?:hydrate|createRoot|webpack|vite|chunk)/i.test(lower));
  const rendering: FrameworkDetection["rendering"] = hasState || visibleText.length > 500
    ? (likelyClientRendered ? "mixed" : "ssr")
    : likelyClientRendered
      ? "csr"
      : "unknown";
  if (!frameworks.length) add(rendering === "ssr" ? "ssr" : rendering === "csr" ? "csr" : "unknown", rendering === "unknown" ? "no framework marker" : `${rendering.toUpperCase()} evidence`);
  return { frameworks, rendering, signals };
}

export function extractEmbeddedState(html: string): EmbeddedState[] {
  const states: EmbeddedState[] = [];
  for (const object of extractJsonLd(boundedHtml(html)).slice(0, EMBEDDED_STATE_LIMITS.states)) {
    states.push({ kind: "json_ld", source: "application/ld+json", value: object, size: JSON.stringify(object).length });
  }
  for (const script of scriptTags(html)) {
    const id = attribute(script.open, "id") ?? "";
    const type = attribute(script.open, "type") ?? "";
    if (/application\/ld\+json/i.test(type)) continue;
    const kind = stateKind(id, type, script.body);
    if (!kind) continue;
    const parsed = parseScriptState(script.body);
    if (parsed === null) continue;
    states.push({ kind, source: id || type || "inline script", value: parsed, size: script.body.length });
    if (states.length >= EMBEDDED_STATE_LIMITS.states) break;
  }
  if (states.length < EMBEDDED_STATE_LIMITS.states) states.push(...flightStates(html).slice(0, EMBEDDED_STATE_LIMITS.states - states.length));
  return states.slice(0, EMBEDDED_STATE_LIMITS.states);
}

function walkObjects(value: unknown, callback: (object: Record<string, unknown>) => void, depth = 0, seen = 0): number {
  if (depth > 7 || seen > 800) return seen;
  if (Array.isArray(value)) {
    for (const child of value) seen = walkObjects(child, callback, depth + 1, seen);
    return seen;
  }
  if (!value || typeof value !== "object") return seen;
  const object = value as Record<string, unknown>;
  callback(object);
  seen += 1;
  for (const child of Object.values(object)) seen = walkObjects(child, callback, depth + 1, seen);
  return seen;
}

export function findEmbeddedObjects(
  states: EmbeddedState[],
  predicate: (object: Record<string, unknown>) => boolean,
  limit = 20,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const state of states) {
    walkObjects(state.value, (object) => {
      if (output.length < limit && predicate(object)) output.push(object);
    });
    if (output.length >= limit) break;
  }
  return output;
}

function safeSameOriginUrl(value: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function discoverScriptUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const match of boundedHtml(html).matchAll(/<script\b([^>]*)>/gi)) {
    const src = attribute(match[1] ?? "", "src");
    if (!src) continue;
    const url = safeSameOriginUrl(src, baseUrl);
    if (!url) continue;
    const path = new URL(url).pathname.toLowerCase();
    if (!/\.m?js$|\/_next\/|\/_nuxt\/|\/_app\/|\/assets\//i.test(path)) continue;
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= EMBEDDED_STATE_LIMITS.bundle_urls) break;
  }
  return urls;
}

function unsafeApiPath(path: string): boolean {
  return /(?:\/login|\/logout|\/account|\/cart|\/checkout|\/basket|\/purchase|\/order|\/delete|\/update|\/create|\/payment|\/subscribe)/i.test(path);
}

export function extractApiCandidates(source: string, sourceUrl: string): ApiCandidate[] {
  const candidates: ApiCandidate[] = [];
  const seen = new Set<string>();
  const pattern = /["'`]((?:https:\/\/[^"'`\s]+|\/(?:api|graphql|search|products?|listings?|availability|catalogue|catalog|items?)[^"'`\s]{0,200}))["'`]/gi;
  for (const match of source.slice(0, EMBEDDED_STATE_LIMITS.bundle_chars).matchAll(pattern)) {
    const raw = match[1] ?? "";
    const url = safeSameOriginUrl(raw, sourceUrl);
    if (!url) continue;
    const parsed = new URL(url);
    const pathLower = parsed.pathname.toLowerCase();
    const pathLooksRelevant = /(?:\/api(?:\/|$)|\/graphql(?:\/|$)|search|products?|listings?|availability|stock|inventory|catalogue|catalog|items?)/i.test(pathLower);
    if (!pathLooksRelevant || unsafeApiPath(parsed.pathname)) continue;
    const nearby = source.slice(Math.max(0, (match.index ?? 0) - 160), Math.min(source.length, (match.index ?? 0) + 260));
    const lower = `${pathLower} ${nearby}`.toLowerCase();
    const kind: ApiCandidate["kind"] = /graphql|operationname/.test(lower)
      ? "graphql"
      : /availability|stock|inventory/.test(pathLower)
        ? "availability"
        : /listing|property|rental/.test(pathLower)
          ? "listing"
          : /product|catalogue|catalog|item/.test(pathLower)
            ? "product"
            : /search|query|autocomplete/.test(pathLower)
              ? "search"
              : "rest";
    const key = `${kind}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ url, kind, evidence: nearby.replace(/\s+/g, " ").slice(0, 240), source_url: sourceUrl });
    if (candidates.length >= EMBEDDED_STATE_LIMITS.api_candidates) break;
  }
  if (candidates.length < EMBEDDED_STATE_LIMITS.api_candidates && /(?:\/graphql|operationName|graphql\.)/i.test(source)) {
    const graphqlUrl = safeSameOriginUrl("/graphql", sourceUrl);
    if (graphqlUrl && !unsafeApiPath(new URL(graphqlUrl).pathname) && !seen.has(`graphql:${graphqlUrl}`)) {
      candidates.push({ url: graphqlUrl, kind: "graphql", evidence: "GraphQL/operationName marker without a literal endpoint", source_url: sourceUrl });
    }
  }
  return candidates;
}

/**
 * Detect the public search configuration that many sites ship to browsers.
 * Replaying a discovered service is left to a fixed, bounded connector route
 * selected by the compatibility engine.
 */
export function detectAlgoliaConfig(source: string): AlgoliaDetection | null {
  const bounded = source.slice(0, EMBEDDED_STATE_LIMITS.bundle_chars);
  if (!/algolia|applicationID|applicationId|indexName/i.test(bounded)) return null;
  const applicationId = /(?:applicationID|applicationId|appId|algoliaAppId)\s*["']?\s*[:=]\s*["']([A-Z0-9]{4,32})["']/i.exec(bounded)?.[1]
    ?? null;
  const indexNames = [...bounded.matchAll(/(?:indexName|index_name)\s*["']?\s*[:=]\s*["']([^"']{1,120})["']/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 12);
  const endpointHint = /https?:\/\/[^"'\s]{1,220}algolia[^"'\s]*/i.exec(bounded)?.[0] ?? null;
  const evidence = [
    ...(applicationId ? ["application_id"] : []),
    ...(indexNames.length ? ["public_search_config"] : []),
    ...(indexNames.length ? ["index_name"] : []),
    ...(endpointHint ? ["endpoint"] : []),
  ];
  return { application_id: applicationId, has_public_config: Boolean(applicationId && indexNames.length), index_names: indexNames, endpoint_hint: endpointHint, evidence };
}

export async function inspectJavascriptBundles(html: string, baseUrl: string, context: ConnectorContext, allowedOrigin?: string): Promise<BundleInspection> {
  const scriptUrls = discoverScriptUrls(html, baseUrl);
  const selected = scriptUrls.slice(0, EMBEDDED_STATE_LIMITS.inspected_bundles);
  const inspectedScripts: string[] = [];
  const candidates: ApiCandidate[] = [];
  const failures: Array<{ url: string; reason: string }> = [];
  for (const url of selected) {
    try {
      const result = await fetchText(url, context, { accept: "application/javascript,text/javascript,*/*;q=0.2", ...(allowedOrigin ? { allowedOrigin } : {}) });
      const source = result.text.slice(0, EMBEDDED_STATE_LIMITS.bundle_chars);
      inspectedScripts.push(url);
      for (const candidate of extractApiCandidates(source, url)) {
        if (!candidates.some((item) => item.url === candidate.url && item.kind === candidate.kind)) candidates.push(candidate);
        if (candidates.length >= EMBEDDED_STATE_LIMITS.api_candidates) break;
      }
    } catch (error) {
      failures.push({ url, reason: error instanceof Error ? error.message.slice(0, 160) : "bundle_fetch_failed" });
    }
    if (candidates.length >= EMBEDDED_STATE_LIMITS.api_candidates) break;
  }
  return { script_urls: scriptUrls, inspected_scripts: inspectedScripts, candidates: candidates.slice(0, EMBEDDED_STATE_LIMITS.api_candidates), failures };
}

const recipeCache = new Map<string, ConnectorRecipe>();

export function rememberRecipe(recipe: ConnectorRecipe): void {
  const key = `${recipe.domain}:${recipe.capability}`;
  recipeCache.set(key, { ...recipe, last_verified_at: recipe.last_verified_at || new Date().toISOString() });
  while (recipeCache.size > 64) {
    const first = recipeCache.keys().next().value;
    if (typeof first === "string") recipeCache.delete(first);
    else break;
  }
}

export function forgetRecipe(domain: string, capability: string): void {
  recipeCache.delete(`${domain}:${capability}`);
}

export function getRecipe(domain: string, capability: string): ConnectorRecipe | null {
  return recipeCache.get(`${domain}:${capability}`) ?? null;
}

export function listRecipes(): ConnectorRecipe[] {
  return [...recipeCache.values()];
}
