# Agent Web Gateway

> **A WebMCP compatibility layer for the existing web.**

### The gateway finds it. The browser shows it.

**[Live gateway](https://agent-web-gateway.djrookie99.chatgpt.site/)** · **[Source](https://github.com/danemcgibbon-bit/agent-web-gateway)**

WebMCP is a better way for AI agents to use websites. But most of the web is not there yet.

**Agent Web Gateway bridges that gap.**

A user gives their agent a website and a goal. The gateway handles the repetitive search, filtering, ranking and verification through WebMCP. When it finds the best verified result, a browser-capable agent opens the real page so the human and agent can continue there together.

```text
Human asks
    ↓
AI agent
    ↓ WebMCP
Agent Web Gateway
find → normalize → filter → rank → verify
    ↓
selected canonical page
    ↓
original website
    ↓
Human + agent inspect it together
```

The gateway does not try to replace the web.

**It helps the agent get you to the right part of it.**

---

## Quickstart

Open:

**https://agent-web-gateway.djrookie99.chatgpt.site/**

If you want to use OpenRent, give your agent this:

> **Use https://agent-web-gateway.djrookie99.chatgpt.site/ to help you access https://openrent.co.uk/ more naturally. I’ll tell you what I want to do.**

Then simply say what you want:

> **Find the cheapest available whole 2+ bedroom flat in Bromley, London under £2,000 that allows families.**

That is the handshake.

The human does not need to know tool names, schemas, provider routes or gateway internals.

For a concrete answer-ready result, the gateway can return the selected canonical page. A browser-capable agent can open it once for final inspection before answering.

The intended experience is:

> **“I found the best verified match — I’ve opened it for you.”**

---

## Why WebMCP matters here

Without a structured interface, a browser agent may repeatedly have to decide:

```text
which page?
how do I search?
how do I paginate?
which fields are reliable?
what counts as a match?
have I searched enough to claim "cheapest"?
should I trust this card or inspect the detail page?
```

Those are mechanical, site-specific decisions. They consume model context and create opportunities for plausible-looking mistakes.

Agent Web Gateway moves as much of that work as practical into deterministic software.

### Without the gateway

```text
Human → Agent → interpret + navigate + compare + verify → maybe answer
```

### With Agent Web Gateway

```text
Human → Agent → WebMCP → Gateway → verified result → real webpage
```

Without WebMCP, this could be exposed as an API.

**With WebMCP, a browser agent can discover the gateway in-page, invoke semantic tools without a separate integration setup, and then return the human to the real website.**

That interaction is the point.

---

## Gateway-first, browser-last

Agent Web Gateway uses a simple co-browsing pattern:

```text
gateway does the mechanical work
        ↓
gateway selects one canonical result
        ↓
browser opens that real page
        ↓
human + agent inspect it together
```

The browser does **not** repeat the search.

It opens the winner.

That creates a useful division of labour:

| Gateway | Browser |
|---|---|
| Traverse bounded result sets | Show the real site |
| Normalize inconsistent records | Show images, maps and layout |
| Apply hard constraints | Catch obvious last-mile changes |
| Rank candidates | Let the user stay in control |
| Verify finalists | Continue the browsing experience |

This is deliberately different from proxying, mirroring or replacing third-party websites.

---

## OpenRent: the flagship workflow

Rental search looks simple until the constraints become real:

```text
2+ bedrooms        ≠ exactly 2 bedrooms
flat               ≠ room in a shared flat
room rent          ≠ whole-property rent
max occupants      ≠ proof that families are allowed
search card        ≠ verified listing detail
partial search     ≠ proof of "cheapest"
```

For the flagship query, the gateway follows a flow like:

```text
search
  ↓
normalize candidates
  ↓
apply safe pre-filters
  ↓
verify relevant listing details
  ↓
reapply every hard constraint
  ↓
rank verified matches
  ↓
return winner + canonical URL
  ↓
browser opens the actual OpenRent listing
```

Search results are candidates, not truth.

A listing cannot become an exact match if its verified detail fails a hard constraint.

The final step matters too: the user sees the real OpenRent page, not a gateway-generated imitation of it.

---

## Native WebMCP still comes first

Agent Web Gateway is not intended to replace a strong first-party WebMCP implementation.

The preferred path is:

```text
native WebMCP
      ↓
official / first-party public interface
      ↓
platform-family interface
      ↓
structured public data
      ↓
bounded compatibility fallback
```

The human-facing gateway includes a WebMCP checker to make that distinction visible.

If native WebMCP is detected, use it.

If native support cannot be confirmed, Agent Web Gateway can provide the compatibility path where supported.

A static miss is not treated as proof that WebMCP is absent: the checker keeps **detected**, **possible**, **no signal**, **disabled**, and **unable to check** distinct.

---

## One WebMCP entry point for normal tasks

The default tool is:

```text
gateway_task
```

It accepts the user's normal-language read-only goal and lets the gateway choose the appropriate semantic workflow.

```json
{
  "goal": "Find the cheapest available whole 2+ bedroom flat in Bromley, London under £2,000 that allows families on OpenRent."
}
```

The agent does not need to manage provider routing, pagination, acquisition strategy or cache behavior.

For a concrete answer-ready result, the response may include:

```json
{
  "answer_ready": true,
  "agent_action": "answer",
  "presentation": {
    "action": "open_result",
    "url": "https://www.example.com/the-selected-result",
    "title": "Selected result",
    "reason": "Top verified match"
  }
}
```

A browser-capable agent can then open `presentation.url` once, briefly inspect the live page, and answer.

If no browser is available, the same result remains answer-ready.

---

## Reliability over plausible answers

The core principle is:

> **False confidence is worse than honest failure.**

Hard constraints use semantics equivalent to:

```text
MATCH
NO_MATCH
UNKNOWN
```

`UNKNOWN` does not silently become `MATCH`.

For global claims such as **cheapest**, the gateway separately asks:

```text
enough of the relevant result space acquired?
        +
scope appropriate?
        +
records interpreted reliably?
        +
finalists verified?
        ↓
safe to make the claim?
```

This prevents failures such as completely searching the wrong collection and then confidently claiming no matching product exists.

When the gateway cannot justify a result, it returns an explicit partial, unsupported or no-match state instead of inventing certainty.

---

## Current scope

| Area | Role | Current maturity |
|---|---|---|
| **OpenRent** | Flagship rental workflow | **Verified direct-site path** |
| OnTheMarket | Secondary rental source | Partial / upstream-dependent |
| Shopify-compatible storefronts | Reusable commerce compatibility | Experimental / site-dependent |
| WooCommerce-compatible storefronts | Reusable commerce compatibility | Experimental / site-dependent |
| IKEA UK | Commerce | Working read-only search/detail |
| Argos UK | Commerce | Working read-only search/detail |
| Amazon UK | Commerce experiment | Degraded / upstream-dependent |
| John Lewis | Commerce | Partial |
| Greenhouse | Reusable jobs adapter | Experimental |
| Lever | Reusable jobs adapter | Experimental |

These are evidence of the architecture, not a claim that the entire web is supported.

Where dynamic targeting exists, previously untested compatible public sites can be attempted within bounded rules.

**Unsupported is a valid state.**

---

## Beyond individual websites

The longer-term architecture is not “one scraper per site.”

The gateway experiments with reusable platform families including:

```text
Shopify
WooCommerce
Greenhouse
Lever
```

The pattern is:

```text
detect compatible platform
        ↓
use bounded known public surfaces
        ↓
normalize provider-specific data
        ↓
return a common semantic record
```

OpenRent is the clearest proof of the experience.

Platform-family normalization is the broader direction.

---

## WebMCP surface

The public page exposes a fixed ten-tool WebMCP surface:

```text
gateway_task
gateway_capabilities
gateway_find_tool
gateway_call_tool

commerce_search_products
commerce_get_product

jobs_search
jobs_get_listing

rentals_search_properties
rentals_get_listing
```

The normal path is intentionally small:

```text
discover once
   ↓
gateway_task
   ↓
answer / clarify / follow next action / report partial
```

Advanced provider and diagnostic operations remain behind `gateway_find_tool` → `gateway_call_tool` rather than consuming the normal agent's context.

The same core contract is designed for compatible clients including ChatGPT and OpenClaw.

---

## What makes it different?

- **No target-site integration required.** Compatible public tasks do not require repository access, a plugin, a script tag, code changes or a local MCP server.
- **Semantic tasks, not browser primitives.** The agent asks for outcomes such as finding products, rentals or jobs rather than operating a remote mouse.
- **Large working sets stay outside model context.** The gateway filters and verifies before returning a compact result.
- **Hard constraints fail closed.** Uncertain evidence does not silently become a match.
- **The original site remains the destination.** The gateway finds the right page; the browser shows it.

---

## Human view + agent view

The same public URL serves two audiences.

Humans get:

- a simple explanation of the idea
- a WebMCP support checker
- a one-click starter prompt
- useful continuation paths when native support is not detected

Agents get:

- WebMCP tool definitions
- concise operating guidance
- strict input schemas
- answer and coverage states
- verification information
- optional browser presentation hints

The human should not need to learn the machine contract.

---

## Safety

Agent Web Gateway is intentionally **read-only**.

It supports search, retrieval, filtering, comparison, ranking, verification and result presentation.

It does not currently perform purchases, payments, bookings, job applications, arbitrary form submissions or authenticated account actions.

The project also avoids CAPTCHA bypass, fingerprint spoofing, residential proxy rotation, stealth-browser infrastructure and unrestricted HTTP proxying.

---

## Testing

Testing focuses on complete agent journeys.

**Deterministic tests** cover normalization, filtering, ranking, route selection, semantic validation, coverage logic, cache behavior, URL safety and false-success prevention.

**WebMCP tests** cover registration, discovery, invocation, cold-start behavior, stable contracts and cross-client behavior.

**Golden journeys** include the OpenRent multi-constraint flow from acquisition through verification, canonical URL selection and browser-last presentation.

**Recognition tests** use known-positive WebMCP implementations plus controlled negative fixtures so improvements in recall do not quietly create false positives.

---

## Architecture

```text
Human + agent
     │
     │ natural-language goal
     ▼
WebMCP
     │
     ▼
Agent Web Gateway
     │
     ├─ normalize intent
     ├─ acquire bounded public data
     ├─ apply hard constraints
     ├─ verify finalists
     ├─ rank qualifying results
     └─ choose canonical presentation URL
     │
     ▼
answer-ready data + selected page
     │
     ▼
AI agent
     │
     ├─ answer
     └─ open selected page
     │
     ▼
Original website
     │
     ▼
Human + agent continue together
```

---

## Design principles

1. Native WebMCP first
2. Semantic tasks over browsing primitives
3. Deterministic mechanics over repeated model interpretation
4. Platform families over endless one-off scripts
5. Hard constraints fail closed
6. False success is worse than honest failure
7. Verify before making global claims
8. Keep large working sets outside model context
9. One stable WebMCP contract across compatible agents
10. Gateway first, browser last
11. Return the human to the real website
12. Read-only by default

---

## What this is not

Agent Web Gateway is not trying to become a universal scraper, stealth-browser platform, unrestricted remote browser, arbitrary HTTP proxy, transactional autonomous agent, or replacement for strong native WebMCP.

The project is exploring a narrower question:

> **Can a compatibility layer make today's public web meaningfully easier and more reliable for browser agents while keeping the human connected to the original website?**

---

## Run locally

Requires **Node.js >= 22.13.0**.

```bash
git clone https://github.com/danemcgibbon-bit/agent-web-gateway.git
cd agent-web-gateway
npm install
npm run dev
```

Useful commands:

```bash
npm run build
npm test
npm run lint
```

The project is primarily TypeScript/JavaScript and uses WebMCP, TypeScript, React, Next.js/Vinext, Vite and Zod.

---

## Deployment

Live gateway:

**https://agent-web-gateway.djrookie99.chatgpt.site/**

No local MCP server, browser extension, VPS, Docker runtime or user-side helper is required for the normal public experience.

---

## Project status

Agent Web Gateway is an experimental open-source project, not a production guarantee for the entire web.

The current flagship is:

> **OpenRent multi-constraint rental search with verification, canonical result selection and browser-last presentation.**

The broader architecture is being explored across commerce, jobs, platform-family compatibility, WebMCP recognition, cross-client interoperability and co-browsing-style handoff.

Useful contributions include compatibility testing, parser/normalizer fixtures, WebMCP interoperability tests, false-success regressions, platform-family coverage improvements and browser-last presentation testing.

---

## License

MIT © 2026 Dane McGibbon

See [`LICENSE`](./LICENSE).

---

## Closing Thoughts

Native WebMCP is the destination.

Agent Web Gateway explores what happens during the transition.

```text
existing public web
        ↓
compatibility + normalization
        ↓
structured agent workflow
        ↓
verified canonical result
        ↓
original website
        ↓
human + agent together
```

**WebMCP is the ideal future, but most of the web isn't there yet. Agent Web Gateway gives agents a structured way through today's web, then brings people back to the real site.**

The goal is not to make agents better at scraping.

**The goal is to make scraping-like reasoning increasingly unnecessary.**

> **The gateway finds it. The browser shows it.**
