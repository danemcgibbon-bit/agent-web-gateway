# Agent Web Gateway

> **A WebMCP compatibility layer for the existing web.**

### Let the gateway find it. Experience it on the real site.

**[Live gateway](https://agent-web-gateway.djrookie99.chatgpt.site/)** · **[Source](https://github.com/danemcgibbon-bit/agent-web-gateway)**

Agent Web Gateway helps AI agents use ordinary public websites through a consistent, read-only WebMCP interface — without requiring the target website to install anything, change its code, or integrate with the gateway.

The key idea is simple:

```text
the agent should reason about what you want
the gateway should handle the repetitive web mechanics
the original website should remain the place you experience the result
```

That produces a **gateway-first, browser-last** workflow:

```text
you ask
   ↓
AI agent
   ↓
Agent Web Gateway
find → normalize → filter → rank → verify
   ↓
best verified canonical result
   ↓
agent opens the real webpage
   ↓
you + your agent inspect it together
```

The gateway does not try to replace the web.

It helps the agent get you to the right part of it.

---

## Quickstart

### 1. Open Agent Web Gateway

**https://agent-web-gateway.djrookie99.chatgpt.site/**

You can first check whether the website you want to use already exposes detectable native WebMCP support.

If strong native WebMCP is available, prefer the site's own tools.

If not, Agent Web Gateway can provide the compatibility path.

### 2. Give your agent one simple starter prompt

For OpenRent:

> **Use https://agent-web-gateway.djrookie99.chatgpt.site/ to help you access https://openrent.co.uk/ more naturally. I’ll tell you what I want to do.**

That is the whole handshake.

You do not need to know tool names, schemas, APIs, or provider routes.

### 3. Tell your agent what you actually want

For example:

> **Find the cheapest available whole 2+ bedroom flat in Bromley, London under £2,000 that allows families.**

The agent can then use the gateway's WebMCP tools to do the structured work.

### 4. Continue on the real website

For a concrete answer-ready result, the gateway can return the selected canonical page as a presentation hint.

A browser-capable agent can open that page once for final inspection and show it to you before answering.

So instead of ending at:

```text
"Here is a URL."
```

the intended experience is:

```text
"I found the best verified match — I've opened it for you."
```

---

## The handshake

Agent Web Gateway is designed around a very small handoff between human, agent, gateway, and website.

```text
┌───────────────┐
│     Human     │
│ "Help me use  │
│  this site."  │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│   AI agent    │
│ discovers AWG │
│ through WebMCP│
└───────┬───────┘
        │
        ▼
┌──────────────────────┐
│  Agent Web Gateway   │
│                      │
│ acquire              │
│ normalize            │
│ filter               │
│ verify               │
│ rank                 │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ canonical result URL │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Original website   │
│                      │
│ human + agent inspect│
│ the real page        │
└──────────────────────┘
```

The human stays in a natural conversation.

The agent gets structured capabilities.

The gateway handles deterministic web work.

The website still gets the user.

---

## Why this exists

WebMCP gives websites a way to expose structured capabilities directly to AI agents.

That is the ideal direction for the web.

But adoption will be uneven.

Today, an agent using an ordinary website often has to repeatedly decide:

```text
which page?
which route?
which result set?
how do I paginate?
which fields are reliable?
is this a room or a whole property?
is this actually in stock?
does "2 bedrooms" mean exactly 2 or at least 2?
have I searched enough to claim "cheapest"?
should I trust this search card or inspect the detail page?
```

Those are mechanical, site-specific decisions.

They consume model context and create opportunities for plausible-looking mistakes.

Agent Web Gateway asks:

> **What if those repetitive web decisions were moved out of the model and into deterministic software?**

The model can focus on the user's goal.

The gateway can focus on acquiring, normalizing, filtering, ranking, and verifying the web data needed to answer it.

---

## Co-browsing without replacing the website

The project began as a WebMCP compatibility layer.

The browser-last workflow adds an important second idea:

> **Structured agent work should lead back to the real web whenever the result is something worth seeing.**

For a result-oriented task:

```text
Agent Web Gateway
        ↓
finds the answer efficiently
        ↓
returns the selected canonical page
        ↓
agent opens that page
        ↓
user sees the site's own interface, photos, maps, content and context
```

The browser does **not** repeat the search.

It opens the winner.

This keeps a useful division of labour:

### The gateway is good at

- traversing bounded result sets
- normalizing inconsistent records
- applying hard constraints
- ranking candidates
- verifying finalists
- deciding whether a global claim is justified

### The browser is good at

- showing the real website
- letting the user see rich visual context
- exposing the site's own interface
- catching obvious last-mile changes
- letting the human and agent continue together

This is deliberately different from proxying, mirroring, or replacing third-party websites.

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

The human-facing gateway includes a WebMCP checker to help make that distinction visible.

Conceptually:

```text
Does this site already expose WebMCP?
        ↓
   ┌────┴────┐
   │         │
  YES      NO SIGNAL
   │         │
   ▼         ▼
use native  use Agent Web Gateway
WebMCP      where compatible
```

A failed static check is not treated as proof that WebMCP is absent. Sites can register tools dynamically, so the checker distinguishes between detected support, possible support, no detected signal, disabled support, and an inability to check.

The gateway is the bridge, not the destination.

---

## OpenRent: the flagship workflow

OpenRent is the clearest demonstration because rental search looks simple until the constraints become real.

Consider:

> Find the cheapest available whole 2+ bedroom flat in Bromley, London under £2,000 that allows families.

A browser agent can easily make subtle mistakes:

```text
2+ bedrooms        ≠ exactly 2 bedrooms
flat               ≠ room in a shared flat
room rent          ≠ whole-property rent
max occupants      ≠ proof that families are allowed
search card        ≠ verified listing detail
last updated       ≠ newly listed
partial search     ≠ proof of "cheapest"
```

Agent Web Gateway treats search results as candidates, not truth.

The rental flow is approximately:

```text
search
  ↓
normalize candidates
  ↓
apply safe pre-filters
  ↓
inspect relevant listing details
  ↓
reconcile conflicting fields
  ↓
build canonical verified listings
  ↓
reapply every hard constraint
  ↓
rank verified matches
  ↓
return winner + canonical page
  ↓
browser opens the actual OpenRent listing
```

That last step turns a structured answer into a co-browsing experience.

The user can immediately see the listing photos, description and context on OpenRent itself.

---

## One WebMCP entry point for normal tasks

The default agent-facing tool is:

```text
gateway_task
```

It accepts the user's ordinary read-only goal and lets the gateway choose the appropriate workflow.

Example:

```json
{
  "goal": "Find the cheapest available whole 2+ bedroom flat in Bromley, London under £2,000 that allows families on OpenRent."
}
```

The agent does not need to plan provider routes, inspect manifests, manage pagination, or understand the internal connector architecture.

For normal tasks:

```text
user goal
   ↓
gateway_task
   ↓
deterministic route selection
   ↓
semantic workflow
   ↓
answer-ready result
```

Specialist commerce, jobs, and rental tools remain available when explicit control is useful.

---

## Gateway-first, browser-last

For an answer-ready concrete result, the response can include an additive presentation hint:

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

The intended agent behavior is:

```text
gateway says answer-ready
        ↓
stop gateway discovery
        ↓
presentation.action = open_result?
        ↓
YES
        ↓
open the selected URL once
        ↓
briefly inspect the live page
        ↓
answer the user
```

The agent should **not** independently repeat the search in the browser.

If browser navigation is unavailable, the same gateway result remains answer-ready and the agent can simply answer in chat.

Presentation is additive, not required for correctness.

---

## What makes the gateway different?

### 1. It works with websites that do not control the integration

The target website does not need:

- repository access
- a plugin
- a script tag
- a local MCP server
- a merchant integration
- a developer integration
- a code change

Agent Web Gateway is externally operated compatibility infrastructure for public, read-only web tasks.

### 2. It exposes semantic tasks, not browsing primitives

The agent asks for outcomes such as:

```text
find products
find jobs
find rental properties
get a verified detail record
```

It does not receive a remote mouse and a pile of DOM primitives.

### 3. It keeps large working sets out of the model context

Instead of:

```text
hundreds of records
       ↓
      model
       ↓
model filters, compares and ranks
```

the intended flow is:

```text
hundreds of records
       ↓
Agent Web Gateway
normalize → filter → verify → rank
       ↓
small answer-ready result
       ↓
      model
```

### 4. It fails closed

If the gateway cannot justify a hard constraint, it does not silently convert uncertainty into a match.

### 5. It brings the user back to the original site

The gateway helps the agent find the right page.

It does not try to become that page.

---

## Reliability model

The core principle is:

> **False confidence is worse than honest failure.**

Hard constraints are handled with semantics equivalent to:

```text
MATCH
NO_MATCH
UNKNOWN
```

`UNKNOWN` does not silently become `MATCH`.

For global claims such as **cheapest**, the gateway separately asks:

```text
Did we acquire enough of the relevant result space?
        +
Was the acquisition scope appropriate?
        +
Were the records interpreted reliably?
        +
Were the finalists verified?
        ↓
Can we safely make the claim?
```

This prevents failures such as:

```text
completely searching the wrong product collection
        ↓
incorrectly claiming no matching product exists
```

or:

```text
search card looks like a flat
        ↓
detail page reveals it is a room
        ↓
incorrectly treating it as a whole-property match
```

The system prefers an explicit partial or unsupported state over a confident-looking invention.

---

## Current scope

The project is intentionally transparent about maturity.

| Area | Role | Current maturity |
|---|---|---|
| **OpenRent** | Flagship rental workflow | **Verified direct-site path** |
| OnTheMarket | Secondary rental source | Partial / upstream-dependent |
| Shopify-compatible storefronts | Reusable commerce compatibility | Experimental / site-dependent |
| WooCommerce-compatible storefronts | Reusable commerce compatibility | Experimental / site-dependent |
| IKEA UK | Commerce source | Working read-only search/detail path |
| Argos UK | Commerce source | Working read-only search/detail path |
| Amazon UK | Commerce experiment | Degraded / upstream-dependent |
| John Lewis | Commerce source | Partial |
| Greenhouse | Reusable jobs adapter | Experimental |
| Lever | Reusable jobs adapter | Experimental |

These are not allowlists for the architecture.

Where dynamic targeting is supported, previously untested compatible public sites can be attempted within bounded rules.

Upstream sites can change at any time.

**Unsupported is a valid state.**

---

## WebMCP surface

The public page exposes a fixed, atomically registered WebMCP surface for normal agent use.

The core tools are:

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

The normal path is deliberately simple:

```text
discover once
   ↓
gateway_task
   ↓
answer / clarify / follow next action / report partial
```

Advanced provider and diagnostic operations remain behind the deterministic `gateway_find_tool` → `gateway_call_tool` path rather than consuming the normal agent's context.

The same core contract is designed to work across compatible WebMCP clients including ChatGPT and OpenClaw.

---

## Human view + agent view

The same public URL serves two audiences.

### Humans see

- a simple explanation of the compatibility-layer idea
- a WebMCP support checker
- a one-click starter prompt
- useful continuation paths when native support is not detected
- a clear explanation of what the gateway can help with

### Agents receive

- WebMCP tool definitions
- concise operating guidance
- strict input schemas
- structured answer states
- coverage information
- verification state
- continuation signals
- optional presentation hints for browser-capable clients

The human should not need to learn the machine contract.

The agent should not need the human interface explained to it.

---

## The WebMCP checker

The landing page can inspect a public website for detectable WebMCP support.

The checker is intentionally evidence-based rather than absolute.

Possible outcomes include:

```text
WebMCP detected
Possible WebMCP
No WebMCP signal detected
WebMCP disabled
Unable to check
```

When native support cannot be confirmed, the page gives the human a simple starter prompt such as:

> Use https://agent-web-gateway.djrookie99.chatgpt.site/ to help you access https://openrent.co.uk/ more naturally. I’ll tell you what I want to do.

That turns a technical compatibility problem into a one-sentence handoff.

---

## Acquisition strategy

The gateway prefers the strongest bounded read-only source available.

Conceptually:

```text
native WebMCP
      ↓
official / first-party public API
      ↓
platform-family API
      ↓
known public route
      ↓
embedded structured state
      ↓
public HTML
      ↓
honest failure
```

The caller does not choose the acquisition route.

That decision stays in deterministic gateway code.

---

## Platform-family compatibility

Rather than building every site as an unrelated one-off scraper, the project experiments with reusable compatibility families.

Current examples include:

```text
Shopify
WooCommerce
Greenhouse
Lever
```

The architecture can:

```text
detect compatible platform
        ↓
use known bounded public surfaces
        ↓
normalize provider-specific data
        ↓
return common semantic records
```

This is the direction of the project:

> **platform compatibility rather than endless site-specific prompting.**

---

## Safety

Agent Web Gateway is intentionally **read-only**.

It supports:

- search
- retrieval
- filtering
- comparison
- ranking
- verification
- result presentation

It does not currently perform:

- purchases
- payments
- bookings
- job applications
- arbitrary form submissions
- authenticated account actions

The design also avoids relying on:

- CAPTCHA bypass
- fingerprint spoofing
- residential proxy rotation
- stealth-browser infrastructure
- arbitrary HTTP proxying

Public dynamic targets are constrained to bounded HTTPS acquisition with URL safety checks.

---

## Testing philosophy

The gateway is tested at several levels.

### Deterministic tests

Cover areas such as:

```text
normalization
filtering
ranking
route selection
semantic validation
coverage logic
cache behavior
URL safety
false-success prevention
```

### WebMCP interoperability

Tests focus on:

```text
registration
discovery
invocation
cold-start behavior
stable contracts
cross-client behavior
```

### Golden journeys

Real end-to-end tasks are retained as regression cases.

The flagship is the multi-constraint OpenRent journey because it tests:

```text
provider acquisition
semantic normalization
hard constraints
detail verification
ranking
canonical URLs
presentation
browser-last behavior
```

### Recognition corpus

The human-facing WebMCP checker is also tested against known-positive implementations and controlled negative fixtures so that improvements in recall do not quietly create false positives.

---

## What Agent Web Gateway is not

The project is not trying to become:

- a universal scraper
- a stealth-browser platform
- an unrestricted remote browser
- an arbitrary HTTP proxy
- a replacement for a strong first-party WebMCP implementation
- a transactional autonomous agent

The project is exploring a narrower question:

> **Can a compatibility layer make the existing public web meaningfully easier and more reliable for browser agents while keeping the human connected to the original website?**

---

## Architecture

```text
┌─────────────────────────────────────────┐
│              Human + agent              │
└───────────────────┬─────────────────────┘
                    │ natural-language goal
                    ▼
┌─────────────────────────────────────────┐
│                WebMCP                   │
│        fixed semantic tool surface      │
└───────────────────┬─────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│           Agent Web Gateway             │
│                                         │
│  normalize intent                       │
│  select acquisition strategy            │
│  acquire bounded public data            │
│  build canonical records                │
│  apply hard constraints                 │
│  verify finalists                       │
│  rank qualifying results                │
│  select canonical presentation URL      │
└───────────────────┬─────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
 answer-ready data      canonical result page
        │                       │
        └───────────┬───────────┘
                    ▼
┌─────────────────────────────────────────┐
│              AI agent                   │
│      answers + opens selected page      │
└───────────────────┬─────────────────────┘
                    ▼
┌─────────────────────────────────────────┐
│          Original public website        │
│       human + agent inspect result      │
└─────────────────────────────────────────┘
```

---

## Design principles

1. **Native WebMCP first**
2. **Semantic tasks over browsing primitives**
3. **Deterministic mechanics over repeated model interpretation**
4. **Platform families over endless one-off scripts**
5. **Hard constraints fail closed**
6. **False success is worse than honest failure**
7. **Verify before making global claims**
8. **Keep large working sets outside model context**
9. **One stable WebMCP contract across compatible agents**
10. **Gateway first, browser last**
11. **Return the human to the real website**
12. **Read-only by default**

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

The project is primarily TypeScript/JavaScript and uses WebMCP, TypeScript, React, Next.js/Vinext, Vite, Zod, and ordinary web primitives such as `fetch`, parsing, filtering, sorting, bounded concurrency, and caching.

---

## Deployment

The live gateway is:

**https://agent-web-gateway.djrookie99.chatgpt.site/**

No local MCP server, browser extension, VPS, Docker runtime, or user-side helper is required for the normal public experience.

---

## Project status

Agent Web Gateway is an experimental open-source project, not a production guarantee for the entire web.

The current flagship is:

> **OpenRent multi-constraint rental search with verification, canonical result selection, and browser-last presentation.**

The broader architecture is being explored across commerce, jobs, platform-family compatibility, WebMCP recognition, cross-client interoperability, and co-browsing-style handoff.

Useful contributions include:

- compatibility testing against public site families
- parser and normalizer fixtures
- WebMCP interoperability tests
- false-success regression cases
- direct-browsing vs gateway comparisons
- platform-family coverage improvements
- browser-last presentation testing

For compatibility reports, include:

```text
target public URL
user goal
observed result
expected result
WebMCP consumer
whether the gateway selected the correct canonical page
whether the browser opened the selected result
```

Do not include credentials or authenticated session data.

---

## License

MIT © 2026 Dane McGibbon

See [`LICENSE`](./LICENSE).

---

## Closing

Native WebMCP is the destination.

Agent Web Gateway explores what happens during the transition.

```text
heterogeneous existing web
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

The goal is not to make agents better at scraping.

**The goal is to make scraping-like reasoning increasingly unnecessary.**

And when the answer is something worth seeing:

> **The gateway finds it. The browser shows it.**
