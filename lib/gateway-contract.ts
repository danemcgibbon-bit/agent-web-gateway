import { COMPATIBILITY_PROVIDERS, COMPATIBILITY_PROVIDER_IDS } from "./compatibility-catalog";

export const GATEWAY_VERSION = "0.13.2";
export const GATEWAY_SCHEMA_VERSION = "1.0";
export const WEBMCP_CONTRACT_VERSION = "1.0";
export const BUILD_ID = "agent-web-gateway-v0.13.2";
export const MAX_RESULTS = 20;
export const DEFAULT_RESULT_COUNT = 3;

export type JsonObject = Record<string, unknown>;
export type SchemaProperty = Record<string, unknown>;
export type ResponseFormat = "concise" | "detailed" | "diagnostic";

export type ConnectorId = "ikea" | "eventbrite" | "booking" | "amazon" | "ebay" | "argos" | "johnlewis" | "rail" | "travel" | "commerce" | "rentals" | "jobs";

/** Providers with no usable zero-setup public route are kept out of the public registry. */
export const RETIRED_PUBLIC_CONNECTOR_IDS = new Set<ConnectorId>(["eventbrite", "booking", "ebay", "rail", "travel"]);
const RETIRED_PUBLIC_PROVIDER_IDS = new Set<string>([
  ...RETIRED_PUBLIC_CONNECTOR_IDS,
  "airbnb",
  "rightmove",
  "zoopla",
  "google_flights",
  "google_hotels",
]);

export type GatewayExpansionScope = "commerce" | "rentals" | "jobs" | "diagnostics" | "compatibility" | "all";

export const GATEWAY_EXPANSION_SCOPES: Record<GatewayExpansionScope, { description: string }> = {
  commerce: { description: "Provider-specific commerce contracts for a deliberate source-level investigation." },
  rentals: { description: "No extra contracts are normally required; the default rental pair is complete." },
  jobs: { description: "No extra contracts are normally required; the default jobs pair is complete." },
  diagnostics: { description: "Gateway status, manifest, and echo diagnostics for QA or integration debugging." },
  compatibility: { description: "Compatibility route and tested-example manifest detail." },
  all: { description: "The complete advanced registry for controlled integration diagnostics." },
};

export type ConnectorSummary = {
  id: ConnectorId;
  name: string;
  domain: string;
  mark: string;
  tone: string;
  tools: string[];
};

export const CONNECTORS: ConnectorSummary[] = [
  {
    id: "ikea",
    name: "IKEA UK",
    domain: "ikea.com/gb",
    mark: "IK",
    tone: "sun",
    tools: ["search_products", "get_product", "check_availability"],
  },
  {
    id: "amazon",
    name: "Amazon UK",
    domain: "amazon.co.uk",
    mark: "AM",
    tone: "amber",
    tools: ["search_products", "get_product"],
  },
  {
    id: "argos",
    name: "Argos UK",
    domain: "argos.co.uk",
    mark: "AR",
    tone: "coral",
    tools: ["search_products", "get_product"],
  },
  {
    id: "johnlewis",
    name: "John Lewis UK",
    domain: "johnlewis.com",
    mark: "JL",
    tone: "green",
    tools: ["search_products", "get_product"],
  },
  {
    id: "commerce",
    name: "Commerce",
    domain: "IKEA · Amazon · Argos · John Lewis · compatible storefronts",
    mark: "CO",
    tone: "violet",
    tools: ["search_products", "get_product"],
  },
  {
    id: "rentals",
    name: "UK rentals",
    domain: "OnTheMarket · OpenRent",
    mark: "RE",
    tone: "teal",
    tools: ["search_properties", "get_listing"],
  },
  {
    id: "jobs",
    name: "Jobs",
    domain: "Greenhouse · Lever",
    mark: "JB",
    tone: "violet",
    tools: ["search", "get_listing"],
  },
];

export const connectorById: Record<ConnectorId, ConnectorSummary> =
  Object.fromEntries(CONNECTORS.map((connector) => [connector.id, connector])) as Record<ConnectorId, ConnectorSummary>;

export type CapabilityId = "commerce" | "rentals" | "jobs";
export type SupportMaturity = "verified_platform_family" | "verified_direct_site" | "partial" | "experimental" | "detected";
export type CapabilityStatus = "online" | "partial" | "degraded" | "offline" | "unknown";
export type CapabilityToolOverride = {
  status: CapabilityStatus;
  execution_modes: string[];
  reason: string;
  completeness?: JsonObject;
};
export type ProviderCapabilityDefinition = {
  name: string;
  status: CapabilityStatus;
  execution_modes: string[];
  reason: string;
  support_maturity?: SupportMaturity;
  engine?: string;
  domain?: string;
  categories?: string[];
  keywords?: string[];
  completeness?: JsonObject;
  tool_overrides?: Record<string, CapabilityToolOverride>;
};
export type CapabilityDefinition = {
  id: CapabilityId;
  title: string;
  description: string;
  recommended_tools: string[];
  providers: string[];
  dynamic_site_targeting?: boolean;
  dynamic_platforms?: string[];
};

/**
 * The baseline provider registry. Runtime observations in gateway-server.ts
 * refine these states; this remains the single source for declared coverage,
 * planning metadata, and unavailable-route explanations.
 */
const ALL_PROVIDER_CAPABILITIES: Record<string, ProviderCapabilityDefinition> = {
  ikea: {
    name: "IKEA UK",
    status: "online",
    execution_modes: ["first_party_api", "public_http"],
    reason: "Live IKEA catalogue search and detail are available through the public route.",
    tool_overrides: {
      check_availability: {
        status: "offline",
        execution_modes: [],
        reason: "IKEA availability is not available through the public lightweight route; no stock inference is performed.",
      },
    },
  },
  amazon: {
    name: "Amazon UK",
    status: "degraded",
    execution_modes: ["public_http"],
    reason: "Identified public HTTP may be blocked; generic or incomplete pages are rejected.",
    support_maturity: "experimental",
    completeness: { title: 1, canonical_url: 1, price: null },
  },
  argos: {
    name: "Argos UK",
    status: "online",
    execution_modes: ["public_http"],
    reason: "Argos search and detail use identified public HTTP with strict validation.",
  },
  johnlewis: {
    name: "John Lewis UK",
    status: "partial",
    execution_modes: ["public_http"],
    reason: "John Lewis search and detail are available; some records may omit a verified price.",
    support_maturity: "partial",
    completeness: { title: 1, canonical_url: 1, price: null },
  },
  ebay: {
    name: "eBay UK",
    status: "offline",
    execution_modes: [],
    reason: "No permitted zero-setup public route is enabled for eBay.",
  },
  eventbrite: {
    name: "Eventbrite UK",
    status: "offline",
    execution_modes: [],
    reason: "No permitted zero-setup public route is enabled for Eventbrite.",
  },
  booking: {
    name: "Booking.com",
    status: "offline",
    execution_modes: [],
    reason: "No validated zero-setup public Booking.com route is currently enabled.",
  },
  rail: {
    name: "UK rail",
    status: "offline",
    execution_modes: [],
    reason: "No permitted zero-setup public route is enabled for UK rail.",
  },
  travel: {
    name: "Travel search",
    status: "offline",
    execution_modes: [],
    reason: "No validated zero-setup public travel route is currently enabled.",
  },
  google_flights: {
    name: "Google Flights",
    status: "offline",
    execution_modes: [],
    reason: "No validated zero-setup public flight route is currently enabled.",
  },
  google_hotels: {
    name: "Google Hotels",
    status: "offline",
    execution_modes: [],
    reason: "No validated zero-setup public hotel route is currently enabled.",
  },
  commerce: {
    name: "Commerce",
    status: "online",
    execution_modes: ["first_party_api", "public_http"],
    reason: "IKEA, Amazon, Argos, and John Lewis are attempted independently; unavailable providers do not poison results.",
  },
  rentals: {
    name: "UK rentals",
    status: "online",
    execution_modes: ["public_http"],
    reason: "OpenRent and OnTheMarket are attempted independently; provider failures are reported separately.",
  },
  openrent: {
    name: "OpenRent",
    status: "online",
    execution_modes: ["public_http"],
    reason: "OpenRent public rental search and detail are available through read-only HTTP.",
    support_maturity: "verified_direct_site",
  },
  onthemarket: {
    name: "OnTheMarket",
    status: "degraded",
    execution_modes: ["public_http"],
    reason: "OnTheMarket is retained as an independent rental source and may be unavailable upstream.",
    support_maturity: "partial",
  },
  airbnb: {
    name: "Airbnb",
    status: "offline",
    execution_modes: [],
    reason: "No validated zero-setup public route is enabled for Airbnb.",
  },
  rightmove: {
    name: "Rightmove",
    status: "offline",
    execution_modes: [],
    reason: "No validated zero-setup public route is enabled for Rightmove.",
  },
  zoopla: {
    name: "Zoopla",
    status: "offline",
    execution_modes: [],
    reason: "No validated zero-setup public route is enabled for Zoopla.",
  },
  greenhouse: {
    name: "Greenhouse",
    status: "unknown",
    execution_modes: ["public_http"],
    reason: "Public Greenhouse job-board endpoints are selected through the shared jobs engine and validated before exposure.",
    support_maturity: "experimental",
    domain: "boards-api.greenhouse.io",
    engine: "greenhouse",
  },
  lever: {
    name: "Lever",
    status: "unknown",
    execution_modes: ["public_http"],
    reason: "Public Lever posting endpoints are selected through the shared jobs engine and validated before exposure.",
    support_maturity: "experimental",
    domain: "api.lever.co",
    engine: "lever",
  },
  jobs: {
    name: "Jobs",
    status: "unknown",
    execution_modes: ["public_http"],
    reason: "Greenhouse and Lever public job boards are attempted independently; unsupported boards fail without poisoning usable results.",
    support_maturity: "experimental",
  },
  ...Object.fromEntries(COMPATIBILITY_PROVIDERS.map((provider) => [provider.id, {
    name: provider.name,
    status: "unknown" as CapabilityStatus,
    execution_modes: ["public_http"],
    reason: `Tested ${provider.engine} example; compatible public sites can be targeted dynamically.`,
    engine: provider.engine,
    domain: provider.domain,
    categories: [...provider.categories],
    ...(provider.keywords ? { keywords: [...provider.keywords] } : {}),
    support_maturity: "experimental" as SupportMaturity,
  }])),
};

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilityDefinition> = Object.fromEntries(
  Object.entries(ALL_PROVIDER_CAPABILITIES).filter(([provider]) => !RETIRED_PUBLIC_PROVIDER_IDS.has(provider)),
) as Record<string, ProviderCapabilityDefinition>;

/** The task-level groups agents should plan against first. */
export const CAPABILITY_REGISTRY: Record<CapabilityId, CapabilityDefinition> = {
  commerce: {
    id: "commerce",
    title: "Commerce",
    description: "Search and inspect products across public sources, including targeted compatible storefronts by URL.",
    recommended_tools: ["commerce_search_products", "commerce_get_product"],
    providers: ["ikea", "amazon", "argos", "johnlewis", ...COMPATIBILITY_PROVIDER_IDS],
    dynamic_site_targeting: true,
    dynamic_platforms: ["shopify", "woocommerce"],
  },
  rentals: {
    id: "rentals",
    title: "UK rentals",
    description: "Search, filter, rank, and verify current UK rental listings.",
    recommended_tools: ["rentals_search_properties", "rentals_get_listing"],
    providers: ["openrent", "onthemarket"],
  },
  jobs: {
    id: "jobs",
    title: "Jobs",
    description: "Search and inspect current public job listings through reusable Greenhouse and Lever board adapters.",
    recommended_tools: ["jobs_search", "jobs_get_listing"],
    providers: ["greenhouse", "lever"],
  },
};

export function providerCapability(provider: string, tool?: string): ProviderCapabilityDefinition | undefined {
  const base = PROVIDER_CAPABILITIES[provider];
  if (!base) return undefined;
  const override = tool ? base.tool_overrides?.[tool] : undefined;
  if (!override) return base;
  return {
    ...base,
    status: override.status,
    execution_modes: override.execution_modes,
    reason: override.reason,
    ...(override.completeness ? { completeness: override.completeness } : {}),
  };
}

const strictObject = (
  properties: Record<string, SchemaProperty>,
  required: string[] = [],
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const textField = (description: string, maxLength = 120): SchemaProperty => ({
  type: "string",
  minLength: 1,
  maxLength,
  description,
});

const idField = (description: string): SchemaProperty => ({
  type: "string",
  minLength: 1,
  maxLength: 160,
  description,
});

const maxResultsField: SchemaProperty = {
  type: "integer",
  minimum: 1,
  maximum: MAX_RESULTS,
  description: `Maximum number of results to return; hard cap ${MAX_RESULTS}.`,
};

const gbpField: SchemaProperty = {
  type: "string",
  enum: ["GBP"],
  description: "Currency for monetary fields.",
};

const localeField: SchemaProperty = {
  type: "string",
  enum: ["en-GB"],
  description: "Locale used for the UK source.",
};

const providerField = (values: string[], description: string): SchemaProperty => ({
  type: "string",
  enum: values,
  description,
});

const commerceDetailIncludeField: SchemaProperty = {
  type: "array",
  maxItems: 8,
  items: providerField(["price", "availability", "sizes", "colors", "variants", "materials", "description", "images", "sale", "provenance"], "Detail section to include."),
  description: "Optional rich sections; omit for a concise verified product record.",
};

const stringArrayField = (description: string, maxItems = 20, itemMaxLength = 160): SchemaProperty => ({
  type: "array",
  minItems: 1,
  maxItems,
  items: { type: "string", minLength: 1, maxLength: itemMaxLength },
  description,
});

const timezoneField: SchemaProperty = {
  type: "string",
  enum: ["Europe/London"],
  description: "Time zone used for date and time interpretation.",
};

export type ToolDefinition = {
  name: string;
  provider: "gateway" | ConnectorId;
  operation: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  required: string[];
  readOnlyHint: true;
  /** Preferred semantic tools are discoverable without implementation detail. */
  surface?: "semantic" | "advanced";
  /** Retained only as a compatibility marker; never part of normal discovery. */
  deprecated?: boolean;
  /** Stable metadata used by deterministic just-in-time discovery. */
  keywords?: string[];
  discovery_scopes?: GatewayExpansionScope[];
};

const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "gateway_task",
    provider: "gateway",
    operation: "task",
    title: "Run a normal gateway task",
    description:
      `Default tool for normal read-only requests. Pass the user's goal largely as written, including any website URL. The gateway selects the workflow, searches, filters, ranks, and verifies results. If agent_action="answer", stop using tools and answer the user. Example: gateway_task({ goal: "Find the cheapest green men's sweater on tentree.com" }).`,
    inputSchema: strictObject({
      goal: textField("The user's normal-language read-only request; pass it mostly as written.", 1000),
      site: {
        type: "string",
        minLength: 3,
        maxLength: 300,
        description: "Optional public site URL or domain; a URL in goal is also extracted automatically.",
      },
      response_format: providerField(["concise", "detailed"], "Optional response size; concise is the default."),
    }, ["goal"]),
    required: ["goal"],
    readOnlyHint: true,
    keywords: ["task", "default", "normal", "goal", "commerce", "jobs", "rentals", "search"],
    discovery_scopes: ["commerce", "rentals", "jobs", "all"],
  },
  {
    name: "gateway_echo",
    provider: "gateway",
    operation: "echo",
    title: "Gateway echo test",
    description:
      "Confirm that an agent can reach and execute the Agent Web Gateway. Returns the received message without changing external state.",
    inputSchema: strictObject(
      { message: textField("A short message to echo back.", 240) },
      ["message"],
    ),
    required: ["message"],
    readOnlyHint: true,
  },
  {
    name: "gateway_status",
    provider: "gateway",
    operation: "status",
    title: "Gateway status",
    description:
      "Advanced diagnostics for gateway health, execution state, connector coverage, and rolling metrics. Use gateway_capabilities first when planning a user task.",
    inputSchema: strictObject({}),
    required: [],
    readOnlyHint: true,
  },
  {
    name: "gateway_manifest",
    provider: "gateway",
    operation: "manifest",
    title: "Gateway tool manifest",
    description:
      "Advanced route and contract diagnostics. Inspect the full or default read-only surface, schemas, current availability, and bounded route evidence when QA requires it; do not pre-inspect this for ordinary tasks.",
    inputSchema: strictObject({
      surface: providerField(["full", "semantic"], "Return all tools or only the preferred semantic tools."),
      site: {
        type: "string",
        minLength: 3,
        maxLength: 300,
        description: "Optional public storefront URL/domain for one bounded compatibility route diagnostic.",
      },
      query: textField("Optional product query used with site for one bounded route diagnostic.", 120),
    }),
    required: [],
    readOnlyHint: true,
  },
  {
    name: "gateway_capabilities",
    provider: "gateway",
    operation: "capabilities",
    title: "Gateway capability planner",
    description:
      "Use when the user asks what the gateway can do or the goal is broad or ambiguous. For a clear task, use gateway_task or the matching specialist tool directly after WebMCP discovery; never inspect the manifest first. If the result is answer-ready, stop using tools.",
    inputSchema: strictObject({
      capability: providerField(["commerce", "rentals", "jobs", "all"], "Capability group to plan for; defaults to all."),
      scope: providerField(["commerce", "rentals", "jobs", "diagnostics", "compatibility", "all"], "Optional planning scope; use diagnostics or compatibility only when the task needs advanced inspection."),
      goal: textField("Optional short description of the user's goal; helps choose the narrowest recipe.", 240),
      level: providerField(["overview", "advanced"], "Use advanced only when the task explicitly needs diagnostics or compatibility detail."),
    }),
    required: [],
    readOnlyHint: true,
  },
  {
    name: "gateway_find_tool",
    provider: "gateway",
    operation: "find_tool",
    title: "Find an advanced gateway tool",
    description:
      "Use only for uncommon functionality not covered by the normal tools. Search the bounded advanced registry once; then use gateway_call_tool with the exact returned operation. This tool does not execute anything.",
    inputSchema: strictObject({
      query: textField("Short description of the specialist capability needed.", 240),
      scope: providerField(["commerce", "rentals", "jobs", "compatibility", "diagnostics", "all"], "Optional scope to keep discovery narrow."),
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description: "Maximum number of matching operations to return; hard cap 5.",
      },
    }, ["query"]),
    required: ["query"],
    readOnlyHint: true,
    keywords: ["discover", "search", "advanced", "specialist", "operation", "tool"],
    discovery_scopes: ["commerce", "rentals", "jobs", "compatibility", "diagnostics", "all"],
  },
  {
    name: "gateway_call_tool",
    provider: "gateway",
    operation: "call_tool",
    title: "Call a registered advanced gateway tool",
    description:
      "Execute only the exact operation and validated arguments returned by gateway_find_tool. Use this after advanced discovery, not for normal tasks. Unknown operations, arbitrary URLs, methods, headers, code, shell, and filesystem access are rejected.",
    inputSchema: strictObject({
      operation: idField("Exact registered operation name returned by gateway_find_tool."),
      arguments: {
        type: "object",
        description: "Arguments for the selected registered operation; its existing schema is validated before execution.",
        additionalProperties: true,
      },
    }, ["operation", "arguments"]),
    required: ["operation", "arguments"],
    readOnlyHint: true,
    keywords: ["invoke", "dispatch", "advanced", "registered", "validated"],
    discovery_scopes: ["commerce", "rentals", "jobs", "compatibility", "diagnostics", "all"],
  },
  {
    name: "gateway_expand_tools",
    provider: "gateway",
    operation: "expand_tools",
    title: "Expand gateway tools by scope",
    description:
      "Deprecated compatibility shim. The fixed WebMCP surface is registered at startup; use gateway_find_tool and gateway_call_tool for deliberate advanced inspection.",
    inputSchema: strictObject({
      scope: providerField(["commerce", "rentals", "jobs", "diagnostics", "compatibility", "all"], "Advanced group to register just in time."),
      level: providerField(["advanced"], "Optional explicit confirmation that advanced contracts are needed."),
    }, ["scope"]),
    required: ["scope"],
    readOnlyHint: true,
    deprecated: true,
    keywords: ["expand", "register", "advanced", "scope", "rediscover"],
    discovery_scopes: ["commerce", "rentals", "jobs", "compatibility", "diagnostics", "all"],
  },
  {
    name: "commerce_platform_diagnostics",
    provider: "gateway",
    operation: "commerce_platform_diagnostics",
    title: "Diagnose a compatible storefront route",
    description:
      "Inspect bounded platform detection and route evidence for one public Shopify or WooCommerce storefront. This is read-only and never proxies arbitrary requests.",
    inputSchema: strictObject({
      site: {
        type: "string",
        minLength: 3,
        maxLength: 300,
        description: "Public HTTPS storefront URL or domain to diagnose.",
      },
      query: textField("Optional short product query used for one bounded route check.", 120),
    }, ["site"]),
    required: ["site"],
    readOnlyHint: true,
    keywords: ["commerce", "platform", "shopify", "woocommerce", "storefront", "route", "routes", "diagnostics", "diagnostic", "compatibility"],
    discovery_scopes: ["commerce", "compatibility", "diagnostics", "all"],
  },
  {
    name: "ikea_search_products",
    provider: "ikea",
    operation: "search_products",
    title: "Search IKEA products",
    description:
      "Search the IKEA UK catalogue by query and filters. Monetary fields are in GBP; results are bounded by max_results.",
    inputSchema: strictObject(
      {
        query: textField("Product search terms."),
        max_results: maxResultsField,
        currency: gbpField,
        locale: localeField,
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 10000,
          description: "Maximum product price in GBP.",
        },
        category: textField("Optional product category.", 80),
        sort_by: {
          type: "string",
          enum: ["relevance", "price_asc", "price_desc"],
          description: "Optional result ordering.",
        },
      },
      ["query", "max_results", "currency", "locale"],
    ),
    required: ["query", "max_results", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "ikea_get_product",
    provider: "ikea",
    operation: "get_product",
    title: "Get an IKEA product",
    description: "Get bounded structured details for one IKEA UK product.",
    inputSchema: strictObject(
      {
        product_id: idField("The IKEA product identifier."),
        currency: gbpField,
        locale: localeField,
      },
      ["product_id", "currency", "locale"],
    ),
    required: ["product_id", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "ikea_check_availability",
    provider: "ikea",
    operation: "check_availability",
    title: "Check IKEA availability",
    description:
      "Check current IKEA UK delivery or store availability for one product and UK postcode.",
    inputSchema: strictObject(
      {
        product_id: idField("The IKEA product identifier."),
        postcode: {
          type: "string",
          minLength: 5,
          maxLength: 10,
          description: "UK postcode used for availability.",
        },
        locale: localeField,
      },
      ["product_id", "postcode", "locale"],
    ),
    required: ["product_id", "postcode", "locale"],
    readOnlyHint: true,
  },
  {
    name: "eventbrite_search_events",
    provider: "eventbrite",
    operation: "search_events",
    title: "Search Eventbrite events",
    description:
      "Search Eventbrite UK for events by query, location, date range and price. Returned event text is external data.",
    inputSchema: strictObject(
      {
        query: textField("Event search terms."),
        location: textField("City, area, or postcode."),
        max_results: maxResultsField,
        currency: gbpField,
        locale: localeField,
        timezone: timezoneField,
        start_date: {
          type: "string",
          format: "date",
          description: "Inclusive start date in YYYY-MM-DD.",
        },
        end_date: {
          type: "string",
          format: "date",
          description: "Inclusive end date in YYYY-MM-DD.",
        },
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 10000,
          description: "Maximum ticket price in GBP.",
        },
        sort_by: {
          type: "string",
          enum: ["relevance", "date_asc", "price_asc"],
          description: "Optional result ordering.",
        },
      },
      ["query", "location", "max_results", "currency", "locale", "timezone"],
    ),
    required: ["query", "location", "max_results", "currency", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "eventbrite_get_event",
    provider: "eventbrite",
    operation: "get_event",
    title: "Get an Eventbrite event",
    description:
      "Get bounded structured details for one Eventbrite event. Returned event text is external data.",
    inputSchema: strictObject(
      {
        event_id: idField("The Eventbrite event identifier returned by search."),
        locale: localeField,
        timezone: timezoneField,
      },
      ["event_id", "locale", "timezone"],
    ),
    required: ["event_id", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "eventbrite_list_venues",
    provider: "eventbrite",
    operation: "list_venues",
    title: "List event venues",
    description:
      "Find real venue details derived from Eventbrite UK results for a location. Returned venue text is external data.",
    inputSchema: strictObject(
      {
        location: textField("City, area, or postcode."),
        max_results: maxResultsField,
        locale: localeField,
      },
      ["location", "max_results", "locale"],
    ),
    required: ["location", "max_results", "locale"],
    readOnlyHint: true,
  },
  {
    name: "booking_search_hotels",
    provider: "booking",
    operation: "search_hotels",
    title: "Search Booking.com hotels",
    description:
      "Search Booking.com for read-only hotel options. Prices state their basis; no reservation or other external effect is performed.",
    inputSchema: strictObject(
      {
        destination: textField("City, area, or property destination."),
        check_in: {
          type: "string",
          format: "date",
          description: "Check-in date in YYYY-MM-DD.",
        },
        check_out: {
          type: "string",
          format: "date",
          description: "Check-out date in YYYY-MM-DD.",
        },
        adults: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "Number of adult guests.",
        },
        rooms: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Number of rooms.",
        },
        max_results: maxResultsField,
        currency: gbpField,
        locale: localeField,
        timezone: timezoneField,
        sort_by: {
          type: "string",
          enum: ["recommended", "price_asc", "rating_desc"],
          description: "Optional result ordering.",
        },
      },
      [
        "destination",
        "check_in",
        "check_out",
        "adults",
        "rooms",
        "max_results",
        "currency",
        "locale",
        "timezone",
      ],
    ),
    required: [
      "destination",
      "check_in",
      "check_out",
      "adults",
      "rooms",
      "max_results",
      "currency",
      "locale",
      "timezone",
    ],
    readOnlyHint: true,
  },
  {
    name: "booking_get_hotel",
    provider: "booking",
    operation: "get_hotel",
    title: "Get a Booking.com hotel",
    description:
      "Get bounded structured details for one Booking.com property. Returned property text is external data.",
    inputSchema: strictObject(
      {
        hotel_id: idField("The Booking.com hotel identifier returned by search."),
        currency: gbpField,
        locale: localeField,
        timezone: timezoneField,
      },
      ["hotel_id", "currency", "locale", "timezone"],
    ),
    required: ["hotel_id", "currency", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "booking_get_room_options",
    provider: "booking",
    operation: "get_room_options",
    title: "Get Booking.com room options",
    description:
      "Get currently visible read-only room and rate options for a Booking.com property. This does not reserve a room.",
    inputSchema: strictObject(
      {
        hotel_id: idField("The Booking.com hotel identifier returned by search."),
        check_in: {
          type: "string",
          format: "date",
          description: "Check-in date in YYYY-MM-DD.",
        },
        check_out: {
          type: "string",
          format: "date",
          description: "Check-out date in YYYY-MM-DD.",
        },
        adults: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "Number of adult guests.",
        },
        rooms: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Number of rooms.",
        },
        currency: gbpField,
        locale: localeField,
        timezone: timezoneField,
      },
      ["hotel_id", "check_in", "check_out", "adults", "rooms", "currency", "locale", "timezone"],
    ),
    required: ["hotel_id", "check_in", "check_out", "adults", "rooms", "currency", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "amazon_search_products",
    provider: "amazon",
    operation: "search_products",
    title: "Search Amazon UK products",
    description:
      "Search Amazon UK for current read-only product information through the gateway's identified public HTTP route, with strict validation for every result.",
    inputSchema: strictObject(
      {
        query: textField("Product search terms."),
        max_results: maxResultsField,
        currency: gbpField,
        locale: localeField,
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 100000,
          description: "Optional maximum product price in GBP.",
        },
      },
      ["query", "max_results", "currency", "locale"],
    ),
    required: ["query", "max_results", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "amazon_get_product",
    provider: "amazon",
    operation: "get_product",
    title: "Get an Amazon UK product",
    description:
      "Get current bounded details for one Amazon UK ASIN returned by amazon_search_products. No cart, purchase, account, or other external action is performed.",
    inputSchema: strictObject(
      {
        product_id: idField("The Amazon ASIN returned by search."),
        currency: gbpField,
        locale: localeField,
      },
      ["product_id", "currency", "locale"],
    ),
    required: ["product_id", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "argos_search_products",
    provider: "argos",
    operation: "search_products",
    title: "Search Argos UK products",
    description:
      "Search Argos UK catalogue pages using identified, robots-compliant public HTTP. Results are bounded and validated before they are returned.",
    inputSchema: strictObject(
      {
        query: textField("Product search terms."),
        max_results: maxResultsField,
        currency: gbpField,
        locale: localeField,
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 100000,
          description: "Optional maximum product price in GBP.",
        },
      },
      ["query", "max_results", "currency", "locale"],
    ),
    required: ["query", "max_results", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "argos_get_product",
    provider: "argos",
    operation: "get_product",
    title: "Get an Argos UK product",
    description:
      "Get current bounded details for one Argos UK product ID returned by argos_search_products. No basket, purchase, account, or other external action is performed.",
    inputSchema: strictObject(
      {
        product_id: idField("The Argos product ID returned by search."),
        currency: gbpField,
        locale: localeField,
      },
      ["product_id", "currency", "locale"],
    ),
    required: ["product_id", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "johnlewis_search_products",
    provider: "johnlewis",
    operation: "search_products",
    title: "Search John Lewis products",
    description:
      "Search John Lewis UK product pages using identified public HTTP and bounded embedded catalogue state. Results are validated before they are returned.",
    inputSchema: strictObject(
      {
        query: textField("Product search terms."),
        max_results: maxResultsField,
        currency: gbpField,
        locale: localeField,
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 100000,
          description: "Optional maximum product price in GBP.",
        },
      },
      ["query", "max_results", "currency", "locale"],
    ),
    required: ["query", "max_results", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "johnlewis_get_product",
    provider: "johnlewis",
    operation: "get_product",
    title: "Get a John Lewis product",
    description:
      "Get current bounded details for one John Lewis UK product ID or canonical product URL returned by johnlewis_search_products. No basket, purchase, account, or other external action is performed.",
    inputSchema: strictObject(
      {
        product_id: idField("The John Lewis numeric product ID or canonical product URL returned by search."),
        currency: gbpField,
        locale: localeField,
      },
      ["product_id", "currency", "locale"],
    ),
    required: ["product_id", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "ebay_search_items",
    provider: "ebay",
    operation: "search_items",
    title: "Search eBay UK items",
    description:
      "Search current eBay UK listings when a permitted public route is available. Results are bounded, read-only, and chain directly into ebay_get_item.",
    inputSchema: strictObject(
      {
        query: textField("Listing search terms."),
        max_results: maxResultsField,
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 100000,
          description: "Optional maximum item price in GBP.",
        },
        condition: {
          type: "string",
          enum: ["all", "new", "used", "refurbished"],
          description: "Optional listing condition filter.",
        },
        sort_by: {
          type: "string",
          enum: ["best_match", "price_low_to_high", "price_high_to_low", "newly_listed"],
          description: "Optional deterministic listing sort order.",
        },
        currency: gbpField,
        locale: localeField,
      },
      ["query", "max_results", "currency", "locale"],
    ),
    required: ["query", "max_results", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "ebay_get_item",
    provider: "ebay",
    operation: "get_item",
    title: "Get an eBay UK item",
    description:
      "Get current bounded details for one eBay item ID returned by ebay_search_items when a permitted public route is available.",
    inputSchema: strictObject(
      {
        item_id: idField("The eBay item ID returned by search."),
        currency: gbpField,
        locale: localeField,
      },
      ["item_id", "currency", "locale"],
    ),
    required: ["item_id", "currency", "locale"],
    readOnlyHint: true,
  },
  {
    name: "rail_search_journeys",
    provider: "rail",
    operation: "search_journeys",
    title: "Search UK rail journeys",
    description:
      "Search read-only UK rail journeys when a permitted public route is available. The source provider is named in provenance; this is not Trainline.",
    inputSchema: strictObject(
      {
        origin: textField("Origin station or location."),
        destination: textField("Destination station or location."),
        departure_date: {
          type: "string",
          format: "date",
          description: "Travel date in YYYY-MM-DD.",
        },
        departure_time: {
          type: "string",
          minLength: 4,
          maxLength: 5,
          description: "Optional earliest departure time in HH:MM local time.",
        },
        adults: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "Number of adult passengers.",
        },
        max_results: maxResultsField,
        locale: localeField,
        timezone: timezoneField,
      },
      ["origin", "destination", "departure_date", "adults", "max_results", "locale", "timezone"],
    ),
    required: ["origin", "destination", "departure_date", "adults", "max_results", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "rail_get_service",
    provider: "rail",
    operation: "get_service",
    title: "Get a UK rail service",
    description:
      "Get bounded read-only details for one service identifier returned by rail_search_journeys when a permitted public route is available.",
    inputSchema: strictObject(
      {
        service_id: idField("The rail service identifier returned by search."),
        departure_date: {
          type: "string",
          format: "date",
          description: "Service date in YYYY-MM-DD.",
        },
        locale: localeField,
        timezone: timezoneField,
      },
      ["service_id", "departure_date", "locale", "timezone"],
    ),
    required: ["service_id", "departure_date", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "travel_search_flights",
    provider: "travel",
    operation: "search_flights",
    title: "Search flights",
    description:
      "Search current flight options through the gateway's public read-only travel route when available; no booking or reservation is performed.",
    inputSchema: strictObject(
      {
        origin: textField("Origin airport code or location.", 120),
        destination: textField("Destination airport code or location.", 120),
        departure_date: { type: "string", format: "date", description: "Outbound date in YYYY-MM-DD." },
        return_date: { type: "string", format: "date", description: "Optional return date in YYYY-MM-DD; omit for one-way travel." },
        adults: { type: "integer", minimum: 1, maximum: 12, description: "Number of adult travellers." },
        children: { type: "integer", minimum: 0, maximum: 12, description: "Optional number of child travellers." },
        max_results: maxResultsField,
        max_price: { type: "number", minimum: 0, maximum: 100000, description: "Optional maximum total fare in GBP." },
        stops: providerField(["any", "nonstop", "one_stop_or_fewer"], "Optional stop-count filter."),
        sort_by: providerField(["recommended", "price_asc", "departure_asc", "duration_asc"], "Optional deterministic ordering."),
        currency: gbpField,
        locale: localeField,
        timezone: timezoneField,
      },
      ["origin", "destination", "departure_date", "adults", "max_results", "currency", "locale", "timezone"],
    ),
    required: ["origin", "destination", "departure_date", "adults", "max_results", "currency", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "travel_search_hotels",
    provider: "travel",
    operation: "search_hotels",
    title: "Search hotels",
    description:
      "Search current hotel options through the gateway's public read-only travel route when available. Results are validated and dates/occupancy are echoed so an agent can audit the search state.",
    inputSchema: strictObject(
      {
        destination: textField("City, area, or hotel destination.", 160),
        check_in: { type: "string", format: "date", description: "Check-in date in YYYY-MM-DD." },
        check_out: { type: "string", format: "date", description: "Check-out date in YYYY-MM-DD." },
        adults: { type: "integer", minimum: 1, maximum: 12, description: "Number of adult guests." },
        children: { type: "integer", minimum: 0, maximum: 12, description: "Optional number of child guests." },
        rooms: { type: "integer", minimum: 1, maximum: 8, description: "Optional number of rooms." },
        max_results: maxResultsField,
        max_price: { type: "number", minimum: 0, maximum: 100000, description: "Optional maximum nightly price in GBP." },
        min_rating: { type: "number", minimum: 0, maximum: 5, description: "Optional minimum hotel rating." },
        sort_by: providerField(["recommended", "price_asc", "rating_desc", "most_reviewed"], "Optional deterministic ordering."),
        currency: gbpField,
        locale: localeField,
        timezone: timezoneField,
      },
      ["destination", "check_in", "check_out", "adults", "max_results", "currency", "locale", "timezone"],
    ),
    required: ["destination", "check_in", "check_out", "adults", "max_results", "currency", "locale", "timezone"],
    readOnlyHint: true,
  },
  {
    name: "jobs_search",
    provider: "jobs",
    operation: "search",
    title: "Search public jobs",
    description:
      `Search public job listings when you already know this is a jobs task. The gateway handles board selection, filtering, ranking, and verification. If agent_action="answer" or the result is answer-ready, stop using tools and answer. Example: jobs_search({ query: "strategy consulting", location: "London" }).`,
    inputSchema: strictObject({
      query: textField("Optional job title, skill, or keyword query.", 160),
      location: textField("Optional city, country, or location filter.", 160),
      remote: { type: "boolean", description: "Optional explicit remote-work filter." },
      company: textField("Optional supported company or board name.", 120),
      department: textField("Optional department or team filter.", 120),
      employment_type: textField("Optional employment type or commitment filter.", 100),
      max_results: maxResultsField,
      sort_by: providerField(["relevance", "date_desc", "title_asc"], "Optional deterministic ordering."),
    }),
    required: [],
    readOnlyHint: true,
  },
  {
    name: "jobs_get_listing",
    provider: "jobs",
    operation: "get_listing",
    title: "Get a public job listing",
    description:
      "Use only when the user asks for additional details about a listing returned by jobs_search. Pass its provider and stable ID; no application is submitted. Example: jobs_get_listing({ provider: \"greenhouse\", job_id: \"...\" }).",
    inputSchema: strictObject({
      provider: providerField(["greenhouse", "lever"], "Job-board platform that issued job_id."),
      job_id: idField("Stable job identifier returned by jobs_search."),
      company: textField("Optional supported company or board name when using a platform-local ID.", 120),
      canonical_url: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Optional canonical job URL returned by search.",
      },
    }, ["provider", "job_id"]),
    required: ["provider", "job_id"],
    readOnlyHint: true,
  },
  {
    name: "commerce_search_products",
    provider: "commerce",
    operation: "search_products",
    title: "Search products across commerce providers",
    description:
      "Search products when you already know this is a commerce task. If the user names a store, pass its URL in site; the gateway handles platform detection, acquisition, semantic filtering, ranking, and verification. If agent_action=answer or answer_ready is true, stop using tools and answer; do not manually paginate or browse the source. Example: query sweater, site tentree.com.",
    inputSchema: strictObject(
      {
        query: textField("Product search terms."),
        max_results: maxResultsField,
        min_price: {
          type: "number",
          minimum: 0,
          maximum: 100000,
          description: "Optional minimum price; records without a verified comparable price are excluded when set.",
        },
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 100000,
          description: "Optional maximum price; records without a verified comparable price are excluded when set.",
        },
        providers: {
          type: "array",
          minItems: 1,
          maxItems: 14,
          items: providerField(["ikea", "amazon", "argos", "johnlewis", ...COMPATIBILITY_PROVIDER_IDS], "Commerce provider identifier."),
          description: "Optional source selection when the user names providers. Otherwise the gateway picks relevant public sources; not required for normal search.",
        },
        condition: providerField(["all", "new", "used", "refurbished"], "Optional condition filter."),
        site: {
          type: "string",
          minLength: 3,
          maxLength: 300,
          description: "Optional public storefront URL or domain. The gateway attempts dynamic Shopify/WooCommerce adaptation; the site need not be pre-registered.",
        },
        search_context: {
          type: "string",
          minLength: 3,
          maxLength: 160,
          description: "Optional opaque context returned by a prior search for the same storefront; enables reuse and refinement.",
        },
        audience: providerField(["men", "women", "kids", "unisex"], "Optional audience constraint; explicit values override natural-language inference."),
        color: textField("Optional exact or normalized color constraint.", 80),
        size: textField("Optional size constraint, such as S, M, L, or XL.", 40),
        in_stock: { type: "boolean", description: "Require the requested product variant to be explicitly available." },
        sort_by: providerField(["relevance", "price_asc", "price_desc", "rating_desc"], "Optional deterministic ordering."),
        currency: gbpField,
        locale: localeField,
      },
      ["query"],
    ),
    required: ["query"],
    readOnlyHint: true,
  },
  {
    name: "commerce_get_product",
    provider: "commerce",
    operation: "get_product",
    title: "Get a commerce product",
    description:
      "Use only when the user asks for additional information about one returned product, or when a search next_action requests it. Do not call after an answer-ready search just to recheck it. Example: commerce_get_product({ provider: \"shopify.example\", product_id: \"...\" }). It never buys or changes state.",
    inputSchema: strictObject(
      {
        provider: {
          type: "string",
          minLength: 1,
          maxLength: 180,
          description: "Provider that issued product_id, including a normalized dynamic Shopify/WooCommerce domain.",
        },
        product_id: idField("The provider product ID or ASIN returned by search."),
        canonical_url: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional canonical URL returned by search; useful for providers whose stable path identifier is not reconstructable.",
        },
        site: {
          type: "string",
          minLength: 3,
          maxLength: 300,
          description: "Optional public storefront URL/domain for targeted dynamic detail verification.",
        },
        search_context: {
          type: "string",
          minLength: 3,
          maxLength: 160,
          description: "Optional opaque search context from commerce_search_products for cheap same-store detail reuse.",
        },
        include: commerceDetailIncludeField,
        currency: gbpField,
        locale: localeField,
      },
      ["provider", "product_id"],
    ),
    required: ["provider", "product_id"],
    readOnlyHint: true,
  },
  {
    name: "rentals_search_properties",
    provider: "rentals",
    operation: "search_properties",
    title: "Search UK rental properties",
    description:
      `Search public rental listings when you already know this is a rentals task. The gateway handles provider selection, filtering, ranking, and verification. If agent_action="answer" or the result is answer-ready, stop using tools and answer. Example: rentals_search_properties({ location: "London", min_bedrooms: 2 }).`,
    inputSchema: strictObject(
      {
        location: textField("Town, city, area, or postcode."),
        min_bedrooms: { type: "integer", minimum: 0, maximum: 20, description: "Minimum bedrooms." },
        max_bedrooms: { type: "integer", minimum: 0, maximum: 20, description: "Maximum bedrooms." },
        min_price_pcm: { type: "number", minimum: 0, maximum: 100000, description: "Minimum monthly rent in GBP." },
        max_price_pcm: { type: "number", minimum: 0, maximum: 100000, description: "Maximum effective monthly cost in GBP." },
        radius_miles: { type: "number", minimum: 0, maximum: 100, description: "Optional search radius in miles when a provider supports it." },
        property_type: textField("Optional property type, such as flat or house.", 80),
        furnishing: providerField(["furnished", "part_furnished", "unfurnished"], "Optional furnishing requirement."),
        bills_included: { type: "boolean", description: "Require explicit evidence that bills are included." },
        pets_allowed: { type: "boolean", description: "Require explicit evidence that pets are allowed." },
        available_before: { type: "string", format: "date", description: "Require availability on or before this date." },
        freshness_days: { type: "integer", minimum: 0, maximum: 365, description: "Only include listings no older than this many days when listed date is known." },
        whole_property_only: { type: "boolean", description: "Exclude rooms, shares, student-only, retirement, and clearly unavailable supply." },
        max_results: maxResultsField,
        sort_by: providerField(["relevance", "price_asc", "price_desc", "freshest"], "Optional deterministic ordering."),
        providers: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: providerField(["onthemarket", "openrent"], "Rental provider identifier."),
          description: "Optional provider allow-list. Defaults to OnTheMarket and OpenRent.",
        },
        exclude_listing_ids: stringArrayField("Stable listing IDs already seen by the caller.", 100, 160),
        exclude_urls: stringArrayField("Canonical listing URLs already seen by the caller.", 100, 500),
      },
      ["location"],
    ),
    required: ["location"],
    readOnlyHint: true,
  },
  {
    name: "rentals_get_listing",
    provider: "rentals",
    operation: "get_listing",
    title: "Verify a UK rental listing",
    description:
      "Use only when the user asks for additional details about one listing returned by rentals_search_properties, or when a search next_action requests verification. Pass its provider and stable ID. No application or booking is performed. Example: rentals_get_listing({ provider: \"openrent\", listing_id: \"...\" }).",
    inputSchema: strictObject(
      {
        provider: providerField(["onthemarket", "openrent"], "Provider that issued listing_id."),
        listing_id: idField("Stable listing ID returned by rentals_search_properties."),
        canonical_url: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Canonical listing URL returned by search; required for OpenRent when the slug is not otherwise known.",
        },
      },
      ["provider", "listing_id"],
    ),
    required: ["provider", "listing_id"],
    readOnlyHint: true,
  },
];

/** Full implementation registry, including dormant adapters kept for compatibility and maintenance. */
export const INTERNAL_OPERATION_COUNT = ALL_TOOL_DEFINITIONS.length;

/** The public registry excludes contracts whose upstream route is unavailable. */
export const TOOL_DEFINITIONS: ToolDefinition[] = ALL_TOOL_DEFINITIONS.filter((definition) => (
  definition.provider === "gateway" || !RETIRED_PUBLIC_CONNECTOR_IDS.has(definition.provider)
));

const includeDiagnosticsField: SchemaProperty = {
  type: "boolean",
  description: "Include bounded route diagnostics for QA; omit for the compact normal response.",
};

const responseFormatField: SchemaProperty = {
  type: "string",
  enum: ["concise", "detailed", "diagnostic"],
  description: "Response size: concise by default, detailed for richer fields, diagnostic for bounded route evidence.",
};

// Keep the normal agent contract small without taking advanced connectors
// away. The option is added uniformly after the literal registry is built so
// every connector can opt into its own bounded route evidence when debugging.
for (const definition of TOOL_DEFINITIONS) {
  if (definition.provider === "gateway") continue;
  const currentProperties = definition.inputSchema.properties;
  const properties = currentProperties && typeof currentProperties === "object" && !Array.isArray(currentProperties)
    ? currentProperties as Record<string, SchemaProperty>
    : {};
  definition.inputSchema = {
    ...definition.inputSchema,
    properties: { ...properties, response_format: responseFormatField, include_diagnostics: includeDiagnosticsField },
  };
}

/** The fixed, atomically registered WebMCP surface for ordinary agent work. */
export const CORE_WEBMCP_TOOL_NAMES = [
  "gateway_task",
  "gateway_capabilities",
  "gateway_find_tool",
  "gateway_call_tool",
  "commerce_search_products",
  "commerce_get_product",
  "jobs_search",
  "jobs_get_listing",
  "rentals_search_properties",
  "rentals_get_listing",
] as string[];

/** The compact operating contract shown to unfamiliar agents at the root page. */
export const AGENT_QUICKSTART = {
  default_tool: "gateway_task",
  purpose: "Run an ordinary read-only web request without requiring the agent to understand provider routing.",
  normal_workflow: [
    "Call gateway_task with the user's request in goal.",
    "If agent_action is answer, answer the user now; do not repeat the search, inspect diagnostics, or browse the source unless independent verification was requested.",
    "If agent_action is report_partial, stop and explain the safe coverage limitation without restarting the same search independently.",
    "If agent_action is follow_next_action, execute next_action exactly.",
    "If agent_action is clarify, ask the user the returned clarification.",
  ],
  automatic_steps: [
    "Choose commerce, jobs, or rentals deterministically.",
    "Extract a supplied URL and obvious constraints such as price, audience, color, size, stock, or location.",
    "Run the existing bounded search, filtering, ranking, and finalist-verification workflow.",
  ],
  stop_signals: {
    answer: "The result is ready; stop using tools and answer.",
    follow_next_action: "Execute the supplied next_action tool and arguments exactly.",
    clarify: "Ask the returned clarification before continuing.",
    report_partial: "Explain the safe coverage limitation; do not restart the same search independently.",
  },
  specialist_tools: {
    commerce: "commerce_search_products",
    jobs: "jobs_search",
    rentals: "rentals_search_properties",
  },
  advanced: "gateway_find_tool",
  rules: [
    "Leave a supplied site URL in goal or pass it in site.",
    "Do not inspect the manifest or capabilities for a normal clear task.",
    "Do not browse a source directly or manage acquisition tiers.",
  ],
  examples: {
    gateway_task: { goal: "Find the cheapest green men's sweater on https://www.tentree.com/" },
    commerce_search_products: { query: "green sweater", site: "https://www.tentree.com" },
    commerce_get_product: { provider: "tentree.com", product_id: "example-id" },
    jobs_search: { query: "strategy consulting", location: "London" },
    rentals_search_properties: { location: "London", min_bedrooms: 2 },
  },
} as const;

/** Keep page, OpenClaw, and ChatGPT discovery measurements separate. */
export const WEBMCP_DISCOVERY_LAYERS = {
  PAGE_DISCOVERY: {
    api: "document.modelContext.getTools()",
    owner: "page_runtime",
    status: "runtime_self_check",
  },
  OPENCLAW_DISCOVERY: {
    api: "OpenClaw adapter discovery",
    owner: "openclaw_client",
    status: "external_black_box",
  },
  CHATGPT_DISCOVERY: {
    api: "ChatGPT Site Tools discovery",
    owner: "chatgpt_site_tools",
    status: "external_black_box",
  },
} as const;

/** Backwards-compatible name for consumers of the v0.12.x semantic surface. */
export const PREFERRED_SEMANTIC_TOOL_NAMES = CORE_WEBMCP_TOOL_NAMES;

for (const definition of TOOL_DEFINITIONS) {
  definition.surface = CORE_WEBMCP_TOOL_NAMES.includes(definition.name) ? "semantic" : "advanced";
}

export type ToolSurface = "full" | "semantic";

export function toolSurface(name: string): "semantic" | "advanced" {
  return CORE_WEBMCP_TOOL_NAMES.includes(name) ? "semantic" : "advanced";
}

export function toolsForSurface(surface: unknown = "full"): ToolDefinition[] {
  return surface === "semantic"
    ? CORE_WEBMCP_TOOL_NAMES.map((name) => TOOL_DEFINITIONS.find((definition) => definition.name === name)).filter((definition): definition is ToolDefinition => Boolean(definition))
    : [...TOOL_DEFINITIONS];
}

/**
 * Compile-time/runtime invariant for the one canonical WebMCP surface.
 * The native host reports the actual page registration separately; these
 * counts prove that the page and server derive it from the same definitions.
 */
export function webmcpRegistryInvariant(): JsonObject {
  const registered = toolsForSurface("semantic").map((definition) => definition.name);
  const sameOrder = registered.length === CORE_WEBMCP_TOOL_NAMES.length
    && registered.every((name, index) => name === CORE_WEBMCP_TOOL_NAMES[index]);
  return {
    expected_core_tools: CORE_WEBMCP_TOOL_NAMES.length,
    registered_core_tools: registered.length,
    expected_core_tool_names: [...CORE_WEBMCP_TOOL_NAMES],
    registered_core_tool_names: registered,
    registry_match: sameOrder,
    ...(sameOrder ? {} : { error_code: "WEBMCP_REGISTRY_MISMATCH" }),
  };
}

const DIRECT_COMMERCE_PROVIDER_IDS = new Set(["ikea", "amazon", "argos", "johnlewis"]);

/**
 * Return only non-deprecated advanced contracts for internal compatibility
 * callers. The WebMCP vocabulary never changes after page startup.
 */
export function toolsForExpansionScope(scope: unknown): ToolDefinition[] {
  const normalized = typeof scope === "string" ? scope : "";
  return TOOL_DEFINITIONS.filter((definition) => {
    if (definition.surface !== "advanced" || definition.deprecated) return false;
    if (normalized === "all") return true;
    if (normalized === "commerce") return DIRECT_COMMERCE_PROVIDER_IDS.has(definition.provider) || definition.name === "commerce_platform_diagnostics";
    if (normalized === "rentals" || normalized === "jobs") return false;
    if (normalized === "diagnostics") return definition.provider === "gateway" && definition.name !== "gateway_find_tool" && definition.name !== "gateway_call_tool";
    if (normalized === "compatibility") return COMPATIBILITY_PROVIDER_IDS.some((provider) => provider === String(definition.provider)) || ["gateway_manifest", "commerce_platform_diagnostics"].includes(definition.name);
    return false;
  });
}

export function toolSurfaceCounts(): JsonObject {
  const semantic = toolsForSurface("semantic").length;
  return { full: TOOL_DEFINITIONS.length, semantic, advanced: TOOL_DEFINITIONS.length - semantic };
}

const toolByName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolByName.get(name);
}

export function isConnectorId(value: unknown): value is ConnectorId {
  return value === "ikea" || value === "eventbrite" || value === "booking" || value === "amazon" || value === "ebay" || value === "argos" || value === "johnlewis" || value === "rail" || value === "travel" || value === "commerce" || value === "rentals" || value === "jobs";
}

export function isConnectorToolDefinition(tool: ToolDefinition): boolean {
  return tool.provider !== "gateway";
}

export function sourceUrlFor(provider: string): string {
  if (provider === "jobs") return "https://boards-api.greenhouse.io";
  return `https://${connectorById[provider as ConnectorId]?.domain ?? "agent-web-gateway"}`;
}
