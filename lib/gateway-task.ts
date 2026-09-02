import type { JsonObject } from "./gateway-contract";
import { normalizePublicSite, type PublicSite } from "./gateway-runtime";

export type GatewayTaskVertical = "commerce" | "jobs" | "rentals";

export type GatewayTaskRoute = {
  vertical: GatewayTaskVertical;
  provider: "commerce" | "jobs" | "rentals";
  tool: "search_products" | "search" | "search_properties";
  arguments: JsonObject;
  site: PublicSite | null;
  extracted: JsonObject;
};

export type GatewayTaskPlan =
  | { route: GatewayTaskRoute }
  | { route: null; clarification: string; reason: string };

function firstObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![@\w-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?/gi;
const LEADING_TASK_WORDS = /\b(?:please|find|look\s+for|search\s+for|show\s+me|give\s+me|can\s+you|could\s+you|i\s+want|i\s+need|get|find\s+me|me)\b/gi;
const AUDIENCE_WORDS = /\b(?:men['’]?s?|male|menswear|women['’]?s?|female|womenswear|kids?|children['’]?s?|boys?|girls?)\b/gi;
const COLOR_WORDS = /\b(?:green|forest\s+green|sage|olive|moss|pine|emerald|lichen|blue|navy|teal|sky\s+blue|cobalt|royal\s+blue|aqua|red|burgundy|maroon|crimson|wine|black|charcoal|onyx|white|ivory|cream|ecru|brown|tan|camel|beige|chocolate|pink|rose|coral|fuchsia|purple|violet|lilac|plum|yellow|mustard|gold|orange|rust|terracotta|grey|gray|silver|slate)\b/gi;
const SIZE_PHRASE = /\b(?:in\s+)?size\s+(?:extra\s+small|extra\s+large|x[- ]?small|x[- ]?large|small|medium|large|xs|s|m|l|xl|xxl|xxxl)\b/gi;
const PRICE_PHRASE = /\b(?:under|below|less\s+than|up\s+to|no\s+more\s+than|max(?:imum)?)\s*(?:£|gbp\s*)?[\d][\d,]*(?:\.\d+)?/gi;
const JOB_WORDS = /\b(?:job|jobs|role|roles|career|careers|hiring|position|positions|vacancy|vacancies|employment|recruit(?:ment)?)\b/gi;
const RENTAL_WORDS = /\b(?:rent|rental|rentals|flat|flats|apartment|apartments|house|houses|home|homes|property|properties|bedroom|bedrooms|landlord|letting|let|room|rooms|housemate|housemates|shared)\b/gi;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

function cleanCandidate(value: string): string {
  return value.replace(/[),.;!?]+$/g, "").replace(/[\]}]+$/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

function stripUrls(value: string): string {
  return compact(value.replace(URL_PATTERN, " "));
}

function detectSite(value: string): PublicSite | null {
  const candidates = value.match(URL_PATTERN) ?? [];
  for (const candidate of candidates) {
    try {
      return normalizePublicSite(cleanCandidate(candidate));
    } catch {
      // Keep looking if a punctuation-adjacent token was not a public URL.
    }
  }
  return null;
}

function siteFromInput(input: JsonObject, goal: string): PublicSite | null {
  if (typeof input.site === "string") return normalizePublicSite(input.site);
  return detectSite(goal);
}

function parseMoney(value: string): number | null {
  const match = /(?:£|gbp\s*)?([\d][\d,]*(?:\.\d+)?)/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(amount) ? amount : null;
}

function budgetFrom(value: string): number | null {
  const pattern = /\b(?:under|below|less\s+than|up\s+to|no\s+more\s+than|max(?:imum)?)\s*(?:£|gbp\s*)?[\d][\d,]*(?:\.\d+)?/gi;
  for (const match of value.matchAll(pattern)) {
    const suffix = value.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 24);
    if (/^\s*(?:bed(?:room)?s?|beds?|bath(?:room)?s?|occupants?|tenants?|people|persons?)\b/i.test(suffix)) continue;
    const amount = parseMoney(match[0]);
    if (amount !== null) return amount;
  }
  return null;
}

function canonicalAudience(value: string): "men" | "women" | "kids" | null {
  if (/\b(?:men['’]?s?|male|menswear)\b/i.test(value)) return "men";
  if (/\b(?:women['’]?s?|female|womenswear)\b/i.test(value)) return "women";
  if (/\b(?:kids?|children['’]?s?|boys?|girls?)\b/i.test(value)) return "kids";
  return null;
}

function canonicalColor(value: string): string | null {
  const colors: Array<[string, string[]]> = [
    ["green", ["green", "forest green", "sage", "olive", "moss", "pine", "emerald", "lichen"]],
    ["blue", ["blue", "navy", "teal", "sky blue", "cobalt", "royal blue", "aqua"]],
    ["red", ["red", "burgundy", "maroon", "crimson", "wine"]],
    ["black", ["black", "charcoal", "onyx"]],
    ["white", ["white", "ivory", "cream", "ecru"]],
    ["brown", ["brown", "tan", "camel", "beige", "chocolate"]],
    ["pink", ["pink", "rose", "coral", "fuchsia"]],
    ["purple", ["purple", "violet", "lilac", "plum"]],
    ["yellow", ["yellow", "mustard", "gold"]],
    ["orange", ["orange", "rust", "terracotta"]],
    ["grey", ["grey", "gray", "silver", "slate"]],
  ];
  const lower = value.toLowerCase();
  for (const [canonical, variants] of colors) {
    if (variants.some((variant) => new RegExp(`\\b${escapeRegex(variant)}\\b`, "i").test(lower))) return canonical;
  }
  return null;
}

function canonicalSize(value: string): string | null {
  const match = /\b(?:in\s+)?size\s+(extra\s+small|extra\s+large|x[- ]?small|x[- ]?large|small|medium|large|xs|s|m|l|xl|xxl|xxxl)\b/i.exec(value);
  if (!match) return null;
  const normalized = match[1].toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    small: "S",
    medium: "M",
    large: "L",
    extra_small: "XS",
    x_small: "XS",
    extra_large: "XL",
    x_large: "XL",
  };
  return aliases[normalized] ?? normalized.toUpperCase();
}

function locationFrom(value: string): string | null {
  const source = stripUrls(value);
  const expression = /\b(?:based\s+in|located\s+in|in|near|around)\s+(.+?)(?=\s+(?:under|below|less|up\s+to|with|for|and|or|remote|whole|entire|available|that|which|accepts?|allows?|on)\b|[.!?;]|$)/gi;
  let selected: string | null = null;
  for (const match of source.matchAll(expression)) {
    const candidate = compact(match[1]).replace(/\b(?:jobs?|roles?|properties?|flats?|houses?|rooms?)\b$/i, "").trim().replace(/[,;]+$/, "").trim();
    if (candidate && candidate.length <= 120) selected = candidate;
  }
  if (selected) return selected;
  const postcode = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.exec(source);
  return postcode ? postcode[0].toUpperCase().replace(/\s+/g, " ") : null;
}

function removeLocationPhrase(value: string, location: string | null): string {
  if (!location) return value;
  const locationPattern = escapeRegex(location);
  return value.replace(new RegExp(`\\b(?:based\\s+in|located\\s+in|in|near|around)\\s+${locationPattern}\\b`, "i"), " ");
}

function commerceQuery(goal: string, site: PublicSite | null): string {
  let value = stripUrls(goal);
  if (site) value = value.replace(new RegExp(`\\b${escapeRegex(site.domain)}\\b`, "ig"), " ");
  value = value
    .replace(LEADING_TASK_WORDS, " ")
    .replace(PRICE_PHRASE, " ")
    .replace(/\b(?:cheapest|lowest(?:\s+price)?|most\s+expensive|highest(?:\s+price)?|best(?:\s+value)?|currently\s+available|available\s+now|in\s+stock|available)\b/gi, " ")
    .replace(SIZE_PHRASE, " ")
    .replace(AUDIENCE_WORDS, " ")
    .replace(COLOR_WORDS, " ")
    .replace(/\b(?:the|a|an|on|at|from|across|market|store|storefront|website|please)\b/gi, " ")
    .replace(/\b(?:product|products)\s+(?:on|from)\b/gi, " product ");
  return compact(value).replace(/^[\s'’]+|[\s'’]+$/g, "").replace(/[.?!,;:]+$/g, "") || "product";
}

function jobsQuery(goal: string, location: string | null, site: PublicSite | null): string {
  let value = stripUrls(goal);
  if (site) value = value.replace(new RegExp(`\\b${escapeRegex(site.domain)}\\b`, "ig"), " ");
  value = removeLocationPhrase(value, location)
    .replace(LEADING_TASK_WORDS, " ")
    .replace(JOB_WORDS, " ")
    .replace(/\b(?:remote|hybrid|onsite|on[-\s]?site)\b/gi, " ")
    .replace(/\b(?:in|near|around|at|with)\b/gi, " ");
  return compact(value).replace(/[.?!,;:]+$/g, "");
}

function rentalBedrooms(goal: string): { min_bedrooms?: number; max_bedrooms?: number } {
  const match = /\b(one|two|three|four|five|six|seven|eight|\d+)\s*(?:\+\s*)?[- ]?bed(?:room)?s?\b/i.exec(goal);
  if (!match) return {};
  const value = NUMBER_WORDS[match[1].toLowerCase()] ?? Number(match[1]);
  if (!Number.isInteger(value) || value < 0 || value > 20) return {};
  const prefix = goal.slice(Math.max(0, match.index - 36), match.index).toLowerCase();
  const hasPlus = /\+\s*$/.test(goal.slice(match.index, match.index + match[0].length));
  const suffix = goal.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 28).toLowerCase();
  if (/at\s+least|minimum|min\.?/.test(prefix) || /^\s*(?:minimum|min\.?|or\s+more|\+)/.test(suffix) || hasPlus || /\+\s*bed/i.test(match[0])) return { min_bedrooms: value };
  if (/up\s+to|maximum|max\.?/.test(prefix)) return { max_bedrooms: value };
  return { min_bedrooms: value, max_bedrooms: value };
}

function rentalPropertyType(goal: string): string | null {
  if (/\b(?:flat|flats|apartment|apartments)\b/i.test(goal)) return "flat";
  if (/\b(?:house|houses|bungalow|bungalows)\b/i.test(goal)) return "house";
  if (/\bstudio\b/i.test(goal)) return "studio";
  if (/\bmaisonette\b/i.test(goal)) return "maisonette";
  if (/\b(?:room|rooms|housemate|shared)\b/i.test(goal)) return "room";
  return null;
}

function rentalCouplesRequired(goal: string): boolean {
  return /\b(?:accepts?|allows?|suitable\s+for|welcomes?)\s+couples?\b|\bcouples?\s+(?:allowed|welcome|accepted|permitted)\b/i.test(goal);
}

function rentalFamiliesRequired(goal: string): boolean {
  return /\b(?:accepts?|allows?|suitable\s+for|welcomes?)\s+famil(?:y|ies)\b|\bfamil(?:y|ies)\s+(?:allowed|welcome|accepted|permitted)\b/i.test(goal);
}

function rentalProviderFromSite(site: PublicSite | null): "openrent" | "onthemarket" | null {
  if (!site) return null;
  if (/^openrent\.co\.uk$/i.test(site.domain)) return "openrent";
  if (/^onthemarket\.com$/i.test(site.domain)) return "onthemarket";
  return null;
}

function rentalProviderFromGoal(goal: string, site: PublicSite | null): "openrent" | "onthemarket" | null {
  return rentalProviderFromSite(site)
    ?? (/\bopenrent\b/i.test(goal) ? "openrent" : /\b(?:on\s*the\s*market|onthemarket)\b/i.test(goal) ? "onthemarket" : null);
}

function classifyGoal(goal: string, site: PublicSite | null): GatewayTaskVertical | null {
  const jobSignal = JOB_WORDS.test(goal) || /\b(?:hiring|employment|recruitment)\b/i.test(goal);
  JOB_WORDS.lastIndex = 0;
  const rentalSignal = RENTAL_WORDS.test(goal);
  RENTAL_WORDS.lastIndex = 0;
  const commerceSignal = /\b(?:product|products|buy|shop|shopping|store|price|prices|cheapest|cost|sweater|shirt|trousers|powder|protein|lamp|furniture|food|clothing|overshirt|kefir|butter|laptop|headphones)\b/i.test(goal);
  if (jobSignal && rentalSignal) return null;
  if (jobSignal) return "jobs";
  if (rentalSignal) return "rentals";
  if (commerceSignal || site) return "commerce";
  return null;
}

export function planGatewayTask(input: JsonObject): GatewayTaskPlan {
  const goal = typeof input.goal === "string" ? compact(input.goal) : "";
  const site = siteFromInput(input, goal);
  const vertical = classifyGoal(goal, site);
  const responseFormat = input.response_format === "detailed" ? "detailed" : "concise";
  if (!vertical) {
    return {
      route: null,
      clarification: "Are you looking for a product, a public job, or a rental property?",
      reason: "The request does not contain enough unambiguous vertical information to choose a safe workflow.",
    };
  }

  if (vertical === "commerce") {
    const query = commerceQuery(goal, site);
    const argumentsValue: JsonObject = { query, response_format: responseFormat };
    if (site) argumentsValue.site = site.origin;
    const maxPrice = budgetFrom(goal);
    const audience = canonicalAudience(goal);
    const color = canonicalColor(goal);
    const size = canonicalSize(goal);
    if (maxPrice !== null) argumentsValue.max_price = maxPrice;
    if (audience) argumentsValue.audience = audience;
    if (color) argumentsValue.color = color;
    if (size) argumentsValue.size = size;
    if (/\b(?:currently\s+available|available\s+now|in\s+stock|available)\b/i.test(goal)) argumentsValue.in_stock = true;
    if (/\b(?:cheapest|lowest(?:\s+price)?|best\s+value)\b/i.test(goal)) argumentsValue.sort_by = "price_asc";
    if (/\b(?:most\s+expensive|highest(?:\s+price)?)\b/i.test(goal)) argumentsValue.sort_by = "price_desc";
    return {
      route: {
        vertical,
        provider: "commerce",
        tool: "search_products",
        arguments: argumentsValue,
        site,
        extracted: { vertical, query, ...(site ? { site: site.origin } : {}), ...(maxPrice !== null ? { max_price: maxPrice } : {}), ...(audience ? { audience } : {}), ...(color ? { color } : {}), ...(size ? { size } : {}), ...(argumentsValue.in_stock ? { in_stock: true } : {}), ...(argumentsValue.sort_by ? { sort_by: argumentsValue.sort_by } : {}) },
      },
    };
  }

  const targetedRentalProvider = vertical === "rentals" ? rentalProviderFromGoal(goal, site) : null;
  if (site && !targetedRentalProvider) {
    return {
      route: null,
      clarification: "Targeted storefront routing is currently available for commerce sites. For jobs or rentals, leave the URL in the goal and provide the location so the supported public sources can be searched.",
      reason: "The existing jobs and rentals workflows do not accept an arbitrary site target.",
    };
  }

  if (vertical === "jobs") {
    const location = locationFrom(goal);
    const query = jobsQuery(goal, location, site);
    const argumentsValue: JsonObject = { response_format: responseFormat };
    if (query) argumentsValue.query = query;
    if (location) argumentsValue.location = location;
    if (/\bremote\b/i.test(goal)) argumentsValue.remote = true;
    return {
      route: {
        vertical,
        provider: "jobs",
        tool: "search",
        arguments: argumentsValue,
        site: null,
        extracted: { vertical, ...(query ? { query } : {}), ...(location ? { location } : {}), ...(argumentsValue.remote ? { remote: true } : {}) },
      },
    };
  }

  const location = locationFrom(goal);
  if (!location) {
    return {
      route: null,
      clarification: "What town, city, area, or postcode should I search for the rental?",
      reason: "The rental workflow requires a location before it can search safely.",
    };
  }
  const bedrooms = rentalBedrooms(goal);
  const propertyType = rentalPropertyType(goal);
  const couplesRequired = rentalCouplesRequired(goal);
  const familiesRequired = rentalFamiliesRequired(goal);
  const argumentsValue: JsonObject = { location, response_format: responseFormat, ...bedrooms };
  const maxPrice = budgetFrom(goal);
  if (maxPrice !== null) argumentsValue.max_price_pcm = maxPrice;
  if (propertyType) argumentsValue.property_type = propertyType;
  if (couplesRequired) argumentsValue.couples_required = true;
  if (familiesRequired) argumentsValue.families_required = true;
  if (targetedRentalProvider) argumentsValue.providers = [targetedRentalProvider];
  // Housing queries conventionally mean the whole dwelling.  Keep room
  // searches opt-in so a flat priced per room cannot satisfy a property query.
  if (propertyType !== "room" && !/\b(?:room|rooms|housemate|shared\s+(?:flat|house|property))\b/i.test(goal)) argumentsValue.whole_property_only = true;
  if (/\b(?:whole|entire|full)\s+(?:property|properties|home|house|flat)|\bnot\s+a\s+room\b/i.test(goal)) argumentsValue.whole_property_only = true;
  if (/\b(?:cheapest|lowest(?:\s+price)?)\b/i.test(goal)) argumentsValue.sort_by = "price_asc";
  if (/\b(?:most\s+expensive|highest(?:\s+price)?)\b/i.test(goal)) argumentsValue.sort_by = "price_desc";
  if (/\b(?:newest|newly\s+listed|most\s+recent(?:ly)?\s+listed|latest\s+listing)\b/i.test(goal)) argumentsValue.sort_by = "newest";
  return {
    route: {
      vertical,
      provider: "rentals",
      tool: "search_properties",
      arguments: argumentsValue,
      site: null,
      extracted: { vertical, location, ...bedrooms, ...(propertyType ? { property_type: propertyType } : {}), ...(maxPrice !== null ? { max_price_pcm: maxPrice } : {}), ...(couplesRequired ? { couples_required: true } : {}), ...(familiesRequired ? { families_required: true } : {}), ...(targetedRentalProvider ? { provider: targetedRentalProvider } : {}), ...(argumentsValue.whole_property_only ? { whole_property_only: true } : {}), ...(argumentsValue.sort_by ? { sort_by: argumentsValue.sort_by } : {}) },
    },
  };
}

export function taskResultSummary(vertical: GatewayTaskVertical, data: JsonObject, partial = false): string {
  const results = Array.isArray(data.results) ? data.results : [];
  const first = results[0] && typeof results[0] === "object" && !Array.isArray(results[0]) ? results[0] as JsonObject : null;
  const title = typeof first?.title === "string" ? first.title : typeof first?.name === "string" ? first.name : null;
  if (!results.length) return partial ? "The gateway could not establish a complete result set because some public sources were unavailable (partial source coverage)." : "No qualifying matches were found in the searched public sources.";
  const noun = vertical === "commerce" ? "product" : vertical === "jobs" ? "job listing" : "rental listing";
  if (vertical === "rentals" && data.objective_requested === "newest_listing" && data.objective_verified !== true) {
    return "Qualifying properties were found, but the gateway cannot reliably establish which was newly listed most recently.";
  }
  if (vertical === "rentals" && (partial || data.answer_state === "partial") && first) {
    return `Found ${results.length} qualifying rental propert${results.length === 1 ? "y" : "ies"} with bounded public-source coverage.`;
  }
  if (vertical === "commerce" && first) {
    const intent = firstObject(data.intent);
    const price = firstObject(first.price);
    const amount = typeof price?.amount === "number" && Number.isFinite(price.amount) ? price.amount : null;
    const currency = typeof price?.currency === "string" ? price.currency.toUpperCase() : typeof first.currency === "string" ? first.currency.toUpperCase() : null;
    const color = typeof first.matched_color === "string" ? first.matched_color : typeof first.color === "string" ? first.color : null;
    const audience = intent?.audience === "men" ? "men's" : intent?.audience === "women" ? "women's" : typeof intent?.audience === "string" ? String(intent.audience) : null;
    const family = typeof intent?.color_family === "string" ? intent.color_family : typeof intent?.color === "string" ? intent.color : null;
    const productQuery = typeof intent?.product_query === "string" ? intent.product_query : null;
    const descriptor = [family, audience, productQuery].filter((value): value is string => Boolean(value)).join(" ");
    const symbol = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
    if (amount !== null && currency && (data.sort_by === "price_asc" || data.search_objective === "exhaustive_ranked")) {
      const priceText = `${symbol}${amount.toFixed(2)} ${currency}`.trim();
      return `${title ?? `A qualifying ${noun}`}${color ? ` in ${color}` : ""} is the cheapest qualifying ${descriptor || noun} at ${priceText}${partial ? " with partial source coverage" : ""}.`;
    }
  }
  if (data.search_objective === "exhaustive_ranked" || data.search_objective === "ranked" || data.sort_by === "price_asc") {
    return `${title ?? `A qualifying ${noun}`} is the best matching result currently found${partial ? " with partial source coverage" : ""}.`;
  }
  return `Found ${results.length} qualifying ${noun}${results.length === 1 ? "" : "s"}${partial ? " with partial source coverage" : ""}.`;
}
