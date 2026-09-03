# Agent Web Gateway v0.13.2

An experimental, read-only WebMCP gateway for useful structured access to
ordinary public web services. It is not affiliated with IKEA, Amazon, Argos,
John Lewis, Greenhouse, Lever, or OpenAI.

Live demo (Sites): https://agent-web-gateway.djrookie99.chatgpt.site
Cloudflare Worker endpoint: https://agent-web-gateway.danemcgibbon.workers.dev

The public page exposes one stable internal registry plus a fixed ten-tool
WebMCP surface. The server chooses
the least expensive usable route for each request: bounded in-memory cache,
first-party HTTP, public HTTP, embedded page state, or a deterministic parser.
Dynamic storefront searches escalate internally into short-lived normalized
server-side snapshots with opaque `search_context` handles; agents never select
a route or receive the raw catalogue.
Snapshots retain the requested scope, acquisition strategy, page and record
counts, pagination termination, route context, and a precise coverage reason.
Incomplete snapshots are refetched for ranked or exhaustive requests; a
superlative is marked sufficient only after the relevant collection or
catalogue has reached a proven terminal page.

## WebMCP surface

The live page registers tools with the imperative WebMCP API:

```js
document.modelContext.registerTool(tool, { signal });
```

The same page exposes the discovery and invocation contract through
`document.modelContext.getTools()` and `document.modelContext.executeTool()`.
All contracts come from the single `TOOL_DEFINITIONS` registry, but exactly ten
stable contracts register atomically at client-module bootstrap. The retained
implementation registry contains dormant adapters and specialist operations;
those do not consume normal model context. Advanced contracts are found
deterministically by `gateway_find_tool` and invoked through the strict
`gateway_call_tool` escape hatch. `script#agent-webmcp-registry` and
`script#agent-webmcp-runtime` provide machine-readable contract and runtime
diagnostics for compatible agents.

Static contracts start at client-module bootstrap before UI hydration and
operational health loading. The fixed registration order starts with the
one-shot default:

- `gateway_task`
- `gateway_capabilities`
- `gateway_find_tool`, `gateway_call_tool`
- `commerce_search_products`, `commerce_get_product`
- `jobs_search`, `jobs_get_listing`
- `rentals_search_properties`, `rentals_get_listing`

The full registry remains available at `GET /api/manifest`; the compact
default manifest is `GET /api/manifest?surface=semantic`. This is a visibility
tier, not a deletion of advanced provider and diagnostic tools. Use
`gateway_find_tool` for a scoped metadata search, then `gateway_call_tool` with
the exact returned operation when an integration task explicitly needs an
advanced contract. The legacy page-scoped `gateway_expand_tools` definition is
retained only as a deprecated compatibility marker; it is not part of normal
registration or discovery.

The full registry also includes:

- gateway diagnostics/planning: `gateway_echo`, `gateway_status`, `gateway_manifest`, `gateway_capabilities`, `gateway_find_tool`, `gateway_call_tool`, `gateway_expand_tools` (deprecated), `commerce_platform_diagnostics`
- IKEA UK: `ikea_search_products`, `ikea_get_product`, `ikea_check_availability`
- Amazon UK: `amazon_search_products`, `amazon_get_product`
- Argos UK: `argos_search_products`, `argos_get_product`
- John Lewis UK: `johnlewis_search_products`, `johnlewis_get_product`
- unified commerce: `commerce_search_products`, `commerce_get_product`
- unified UK rentals: `rentals_search_properties`, `rentals_get_listing`
- unified jobs: `jobs_search`, `jobs_get_listing`

Every connector contract is read-only, strict, bounded, and backed by
provider-specific semantic validation. External text is data and is returned
with `source.trust: "external_untrusted"`; it is never an instruction.

## Execution and response contract

The implementation execution endpoint is:

```text
POST /api/execute
```

```json
{
  "provider": "ikea | amazon | argos | johnlewis | commerce | rentals | jobs",
  "tool": "search_products",
  "arguments": {}
}
```

The caller does not choose the execution route. Successful responses include
`meta`, `coverage`, `execution.mode`, timestamps, semantic-validation status,
route provenance, source freshness, bounded data, and declarative
`actions.detail` links when a search result can be chained. For an answer-ready
verified result, the response may also include a generic `presentation` hint
with the selected canonical page URL; otherwise it is `{ "action": "none" }`.
Errors carry the same decision trace and machine-readable provider coverage.

The default one-shot task is available at `POST /api/task`:

```json
{
  "goal": "Find the cheapest green men's sweater on https://www.tentree.com/"
}
```

It routes deterministically into the existing commerce, jobs, or rentals
workflow; it does not add an internal model or arbitrary web proxy.

Normal search responses return up to three records by default (five when
requested) and are concise and decision-ready: route diagnostics and
variants are omitted by default, and the result includes `response_format`, `answer_state`,
`exact_matches`, optional `closest_matches`, `failed_constraints`,
`verification_status`, `answer_ready`, `next_action`, and, for ranked storefront
`agent_action`, and, for ranked storefront searches, `search_objective`,
`coverage_level`, `coverage_confidence`, and
`coverage_sufficient_for_superlative`. A caller can pass
`response_format: "detailed"` for richer bounded fields or
`response_format: "diagnostic"` (equivalent to `include_diagnostics: true`)
when bounded route evidence is needed for QA. Detail tools retain deeper
product, listing, and job fields. Commerce detail accepts bounded `include`
sections such as `sizes`, `colors`, `materials`, `description`, `images`, and
`provenance`; search results expose `details_available` so agents can request
only what is needed.

Canonical agent workflow:

1. After one native WebMCP discovery, call `gateway_task` with the user's
   normal-language request in `goal`. It deterministically chooses commerce,
   jobs, or rentals, extracts a supplied URL and obvious constraints, and
   routes to the existing workflow. For a specific compatible Shopify or
   WooCommerce storefront, a URL in `goal` or `site` is targeted directly.
2. When `agent_action` is `answer`, stop additional gateway discovery. If
   `presentation.action` is `open_result` and the client can navigate, open
   that selected canonical URL once for final inspection and presentation,
   then answer; otherwise answer directly. For `report_partial`, explain the
   safe limitation without restarting the same search. If it is
   `follow_next_action`, execute the supplied `next_action` exactly. The
   underlying semantic call performs bounded acquisition, filtering, ranking,
   currency checks, snapshot projection, and finalist verification.
3. Use the relevant semantic search tool directly when explicit specialist
   control is useful. Use `gateway_capabilities` only when the goal is broad
   or ambiguous.
4. If the task explicitly needs route or compatibility diagnostics, call
   `gateway_find_tool` once with a narrow scope, then call `gateway_call_tool`
   with the exact registered operation and its existing schema-shaped arguments.

The one-shot task response includes a compact deterministic summary, an
optional first-result capsule, extracted routing data, `answer_ready`, and one
of `answer`, `follow_next_action`, `clarify`, or `report_partial`.

The gateway finds and verifies the result; a browser-capable agent can then
show the selected page on the original website:

```text
ask → Agent Web Gateway (find + filter + verify)
    → selected canonical page → original website
```

The presentation hint is additive. It never makes the gateway a browser or
asks the agent to repeat discovery on the source site.

Do not pre-inspect the manifest or provider catalog for ordinary tasks, and do
not infer zero results from an unavailable provider.
The equivalent read-only HTTP planning route is
`GET /api/capabilities?capability=commerce`.

Use `include_diagnostics: true` only when inspecting a route or eval; normal
agents should use the compact result plus `coverage` and `actions.detail`.

Execution modes currently used are `cache`, `public_http`,
`first_party_api`, and `mixed`. The public gateway works with no setup.

Explicit error codes include `INPUT_INVALID`, `PROVIDER_UNSUPPORTED`,
`UNSUPPORTED_SITE`, `PLATFORM_DETECTED_ROUTE_UNAVAILABLE`,
`UPSTREAM_TIMEOUT`, `UPSTREAM_BLOCKED`, `UPSTREAM_CHANGED`,
`PROVIDER_RESTRICTED`, `NO_VALID_RESULTS`, `NOT_FOUND`, `RATE_LIMITED`, and
`ROUTE_BLOCKED`, `PLATFORM_PROBE_FAILED`, `SITE_UNREACHABLE`,
`RUNTIME_EGRESS_BLOCKED`, and `INTERNAL_ERROR`.

`gateway_find_tool` searches only registered metadata and returns a few
operation names and short purposes; it never returns every schema. The
`gateway_call_tool` dispatcher rejects unknown operations and cannot proxy
arbitrary URLs, methods, headers, code, shell, or filesystem requests.

`gateway_status` reports the live gateway, observed connector health, bounded
metrics, and the last execution mode for each tool. `gateway_manifest` reports
each tool's current status, usable execution modes, completeness hints, and a
concise reason when a route is unavailable. With `site` and `query`, its
advanced route diagnostic performs one bounded read-only compatibility probe.
WebMCP status diagnostics include the fixed-core registry invariant and a
page-runtime TTFSI field (time to first successful semantic invocation);
client/CDP target-loss errors are classified separately as
`CLIENT_INTEROP_TARGET_LIFECYCLE`.
The homepage is a concise human landing page. Its non-rendered machine-facing
manual is available in `script#agent-web-gateway-manual` and at `/agent.json`;
both are generated from the same source object. The page's fixed WebMCP
bootstrap remains independent of the visual landing content.

## Provider notes

- IKEA search and detail use the live first-party catalogue route and strict
  product validation. Availability remains conservative and does not infer
  stock from generic product text.
- Amazon uses an explicitly identifying `Agent/AgentWebGateway` public HTTP
  route for UK catalogue search and detail. Product pages and search pages are
  classified before parsing; challenge, interstitial, generic, and incomplete
  pages cannot become successful product results. ASINs and Amazon URLs chain
  through the detail tool.
- Argos uses a bounded, identified, robots-compliant public HTTP route. Search
  cards and product detail are validated separately and stable Argos IDs chain
  between the two tools.
- John Lewis uses identified public HTTP with robots compliance and bounded
  embedded catalogue-state extraction. Stable product IDs, prices, ratings,
  and canonical URLs are retained only when present in the source.
- Commerce combines validated IKEA, Amazon UK, Argos, and John Lewis results
  behind one search/detail contract and adds a bounded compatibility catalog.
  Provider failures are partial diagnostics; `coverage` makes those outcomes
  explicit, and a blocked or generic page never becomes a product.
  `commerce_search_products` also accepts an optional public `site` for
  dynamically detected compatible Shopify or WooCommerce storefronts. The
  site may be previously untested; the gateway only
  generates bounded platform routes, normalizes variants, and applies strict
  audience/color/size/availability constraints; unsupported sites fail with a
  structured diagnostic. Dynamic discovery records the robots check, homepage
  signal, Shopify predictive-search probe, Shopify catalogue-signal probe, and
  WooCommerce REST-index probe independently. A valid Shopify search payload can
  establish the platform even when the homepage is challenged; selected search
  payloads are reused for the same request and product handles chain through
  `/products/{handle}.js`.
- Rentals combines OnTheMarket and OpenRent into a common property record. It
  normalizes monthly/effective cost, bills, furnishing, availability, and
 whole-property eligibility, then verifies only the top finalists. Search
 results expose declarative detail actions for finalist verification.
- Jobs combines public Greenhouse and Lever postings into a common job record.
  One shared adapter normalizes titles, companies, locations, remote signals,
  departments, employment types, structured salary fields, dates, canonical
  URLs, and stable composite IDs. Search results expose declarative detail
  actions, and a failing board does not poison results from the other platform.
- Sources with no usable zero-setup public route are not included in the public
  connector registry. Their dormant adapters may remain in the codebase for
  future revalidation, but they are not advertised through WebMCP, manifests,
  capabilities, status, or the page registry.

### Rental acquisition policy

The rental adapters use an identifying `Agent/AgentWebGateway` User-Agent,
check each provider's current `robots.txt`, and use read-only server-rendered
pages only. No challenge circumvention, identity rotation, or write action is
used.

## Platform compatibility and bounded discovery

The gateway has a reusable, deterministic page-state layer for modern
server-rendered and framework-backed sites. It detects Next.js, Nuxt, React,
SvelteKit, Angular, Remix, Shopify, Apollo/GraphQL, and generic SSR/CSR
signals, then parses bounded `application/ld+json`, `__NEXT_DATA__`, Next RSC /
Flight payloads, Apollo, Redux/preloaded, Nuxt, SvelteKit, Angular
TransferState, and generic JSON script payloads. Scripts are parsed as data;
downloaded JavaScript is never executed.

The compatibility layer uses the same deterministic code for tested Shopify
examples, caller-supplied Shopify/WooCommerce storefronts, Next.js/hydration
pages, and structured SSR/JSON-LD catalogue pages. It selects routes in this
order:
Shopify, WooCommerce, Next.js state, Algolia clues, structured Product data,
then a known recipe. Product records must have a stable identifier, a
canonical HTTPS URL, and a non-generic title; missing prices remain explicitly
partial.

For caller-supplied Shopify/WooCommerce domains, platform acquisition uses a
small known-route probe set rather than making the homepage a prerequisite.
Each probe reports its requested route, HTTP status, redirect chain,
classification, and elapsed time without retaining the upstream response body.
Route-level blocks, site-level unreachability, and platform-probe failures are
kept distinct in the structured error details.

Same-origin bundle inspection is a bounded reconnaissance aid. It can inspect
a small number of public HTTPS bundles for read-only route clues without
blindly probing every candidate. Successful strategies are represented in the
in-memory recipe registry so healthy production calls remain deterministic; a
stateless isolate may rediscover a recipe after it is recycled. The manifest
and status metrics report engine family, site observations, framework/state
findings, field completeness, ID chaining, and false-success counts.

No provider is enabled merely because a bundle contains a URL-looking string;
the connector still needs a reproducible read-only route and strict semantic
validation.

The same state layer feeds `lib/extraction-benchmark.ts`, which records
framework detection, embedded-state kinds, field completeness, stable-ID
chaining, latency, and false-success counts. Its summary is available inside
the status metrics.

The point-in-time compatibility benchmark is available at
`GET /api/compatibility`. It reports site-level search/detail chaining across
10 Shopify targets, 10 WooCommerce targets, five Greenhouse boards, and five
Lever boards, plus reconnaissance for Booking.com, Argos, Currys, and John
Lewis. It also records the canonical commerce, rentals, jobs, and Amazon
sample queries, framework/state findings, bounded API clues, failure classes,
and formal maturity (`verified`, `partial`, `experimental`, or `unavailable`).
Benchmark targets are fixed public HTTPS samples and do not become an
unrestricted URL proxy or default unified-routing providers.

The targeted v0.11.1 live probe is recorded in
`data/targeted-site-benchmark-v0.11.1.json`; run it with
`npm run benchmark:targeted`. Its dynamic-site targets are reconnaissance
inputs only and are not eligibility gates or default unified-routing providers.

The v0.11.2 fresh-Shopify matrix can be run against the public deployment with
`npm run benchmark:shopify-matrix`; pass an output path as the first argument
when the report should be kept outside the repository.

## WebMCP recognition checker

The human-facing homepage includes a bounded, no-autorun WebMCP check. It
combines independent static inspection of the requested page (including a
small same-origin bundle budget) with the Agent Web Gateway catalog. A catalog
match is reported as verified even when the target page is blocked or its
registration is runtime-only; an unlisted site continues through the
independent scan and is never treated as proven unsupported. Results keep
catalog and live-scan provenance separate, show cataloged tool names and page
hints, and retain the distinction between detected, possible, no signal,
disabled, and unable to check.

The checker recognizes current `document.modelContext` registration,
bracket/aliased and legacy compatibility forms, bounded declarative WebMCP
forms, and the current MCP-B polyfill registration signal. It does not execute
downloaded JavaScript, use browser automation, follow arbitrary third-party
scripts, or expose upstream response bodies. The gateway's existing fixed
WebMCP registry and connector behavior are unchanged.

Run the catalog coverage benchmark with:

```bash
npm run benchmark:webmcp-corpus -- /tmp/webmcp-corpus-report.json
```

It fetches a temporary live-site sample, tests the root and bounded tool pages,
and reports catalog-assisted recall separately from independent static-scan
recall. It intentionally does not claim runtime verification; use Chrome's
[WebMCP Tool Inspector](https://developer.chrome.com/docs/ai/webmcp) for that
development-only oracle when available.

## Agent-native quality report

`GET /api/agent-evals` exposes the permanent golden-journey suite, deterministic
contract-fixture checks, the full-versus-default serialized schema comparison,
progressive-disclosure checks, annotation policy, and the status of repeated
model-backed trials. It deliberately keeps model results separate from
deterministic and live compatibility evidence.

The development runner is:

```bash
npm run benchmark:agent-evals -- data/agent-evals-v0.13.0.json
```

Set `AGENT_EVAL_MODELS=GPT-5.6-Luna=model-a,DeepSeek-V4-Flash=model-b`,
`AGENT_EVAL_MODEL_ENDPOINT`, and `AGENT_EVAL_API_KEY` (where required) to run
five repeated trials per journey and across the legacy/full, lean-tools,
lean-deterministic, and lean-deterministic-advanced interface variants. The
runner records model turns, first correct semantic call, tool errors, gateway
execution time, output size, token usage when supplied, and context overflow.
It uses the read-only gateway API and never adds model-specific behavior to
production.

## Caching and metrics

The stateless runtime keeps a bounded per-isolate cache for safe public IKEA,
Amazon, Argos, John Lewis, unified commerce, rental, and jobs responses. Dynamic
storefront product answers are fetched live; only route and collection knowledge
is retained structurally. Responses expose `source.retrieved_at`, `source.freshness`, and
`source.cache_age_seconds` when applicable.
Dynamic snapshot reuse is scope-aware and reports `hit_exact`, `hit_superset`,
`hit_insufficient`, `miss`, or `stale`; incomplete cache entries are upgraded
before a completeness-sensitive answer.

The status response keeps bounded metrics with provider, tool, latency, HTTP
attempt and outcome, semantic-validation outcome, selected mode, and error
code. Tool health is updated from observed calls and records
`last_success_at`, `last_failure_at`, `last_error_code`, and
`last_execution_mode`.

## Safety boundaries

- public information retrieval only;
- no accounts, carts, purchases, reservations, payments, messages, saved
  sessions, personal data, or write actions;
- no arbitrary URLs, arbitrary code execution, CAPTCHA solving, proxy
  rotation, or challenge circumvention;
- result count, body size, execution time, cache, and retained metrics are
  bounded;
- empty/invalid results and upstream failures cannot cross the semantic success
  boundary.

## Local development

Prerequisites: Node.js `>=22.13.0` and a Linux environment with `flock`,
`curl`, and GNU `timeout`.

```bash
npm run install:ci
npm test
npm run test:live
```

The Site is built with vinext for a lightweight Cloudflare-compatible
deployment and works as a normal public web application with no setup.

## Sources

- [WebMCP and AI agents](https://developer.chrome.com/docs/ai/agents)
- [WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [OnTheMarket Terms of Use](https://www.onthemarket.com/terms/)
- [OpenRent robots.txt](https://www.openrent.co.uk/robots.txt)
