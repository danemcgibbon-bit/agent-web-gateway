# Agent Web Gateway

> **A WebMCP compatibility layer for the existing web.**

**[Live demo](https://agent-web-gateway.danemcgibbon.workers.dev/)** · **[Source code](https://github.com/danemcgibbon-bit/agent-web-gateway)**

Native WebMCP gives agents a much better way to use websites — but most of the existing web does not expose it yet.

**Agent Web Gateway lets WebMCP-capable browser agents use ordinary third-party public websites through a consistent semantic interface, without requiring the target website to install anything, expose its repository, add a script tag, or change its code.**

```text
ordinary public website
        ↓
Agent Web Gateway
        ↓
acquire → normalize → filter → verify
        ↓
one WebMCP interface
        ↓
ChatGPT / OpenClaw / compatible browser agents
```

The goal is not to make agents better at scraping.

**The goal is to make scraping-like reasoning increasingly unnecessary.**

---

## Try the idea

A user can ask:

> **Find the cheapest available whole 2+ bedroom flat in Croydon, London under £2,000 that accepts couples on OpenRent.**

OpenRent does not need to integrate with Agent Web Gateway.

Instead of making the model manually navigate search pages, interpret room-vs-property listings, reconcile prices, follow pagination, infer occupancy rules, compare candidates, and verify the winner, the gateway can do the mechanical work deterministically and return a compact WebMCP result.

```text
user goal
   ↓
intent normalization
   ↓
provider-native filtering where possible
   ↓
bounded acquisition + pagination
   ↓
canonical records
   ↓
hard-constraint verification
   ↓
ranking
   ↓
answer-ready result
```

The agent reasons about the user's goal.

The gateway handles the repetitive site-specific mechanics.

---

## What is different?

Most WebMCP implementations start with a website owner:

```text
website owner
→ implements or generates WebMCP
→ website becomes agent-native
```

Agent Web Gateway explores the other side of the transition:

```text
user needs an existing third-party website
→ website has no suitable agent interface
→ gateway adapts its public capabilities externally
→ browser agent gets a consistent WebMCP workflow
```

### No target-site integration required

For a compatible public site, Agent Web Gateway does **not** require:

- repository access
- a plugin
- a script tag on the target website
- cooperation from the website owner
- a merchant/developer account
- a local browser bridge
- a separately configured MCP server

That makes the project less like “add WebMCP to my app” and more like a **compatibility layer for the web that already exists**.

---

## Why WebMCP is essential to the idea

A normal remote MCP server could expose similar backend operations, but it would produce a different user experience:

```text
install/configure MCP
→ connect the agent
→ discover the server
→ use its tools
```

WebMCP enables:

```text
open webpage
→ browser agent discovers tools
→ use them
```

That browser-native, zero-install interaction is central to Agent Web Gateway.

The same deployed page has been tested with multiple WebMCP consumers, including:

- **ChatGPT Site Tools / in-app browser**
- **OpenClaw browser agents**

The goal is one shared WebMCP contract rather than client-specific integrations.

---

## The broader question

Agent Web Gateway is a proof of concept for a larger idea:

> **What happens if the complexity of the existing web is normalized before it reaches the model?**

Today, browser agents repeatedly spend model reasoning on tasks software can often perform more deterministically:

```text
find the right page
→ infer site structure
→ paginate
→ extract records
→ interpret fields
→ apply constraints
→ compare candidates
→ verify the result
```

Agent Web Gateway moves more of that work behind a semantic WebMCP interface.

The central evaluation is therefore deliberately simple:

```text
same model
same user goal
same target website

DIRECT BROWSING
       vs
AGENT WEB GATEWAY
```

Useful measures include correctness, tool interactions, recovery steps, elapsed time, and false-confident answers.

---

## Why this is a strong WebMCP use case

### WebMCP leverage

WebMCP is not a decorative wrapper around the project. It is the interface that lets a browser agent discover and use the compatibility layer directly from a webpage.

The gateway exposes a deliberately small semantic tool surface while keeping large intermediate datasets and provider-specific mechanics outside model context.

### Execution

This is a live deployed application operating against real third-party public websites, not mocked datasets.

**Live:** https://agent-web-gateway.danemcgibbon.workers.dev/

### Potential impact

Native WebMCP adoption will be uneven. During that transition, browser agents still need to use websites that expose human interfaces, inconsistent APIs, different schemas, or no agent interface at all.

A compatibility layer can reduce how much site-specific interpretation every model has to repeat.

### Creativity & ambition

Rather than adding WebMCP to one application, the project asks whether a single WebMCP-native service can normalize useful capabilities across **multiple unrelated existing website families**.

As native WebMCP adoption grows, the same architecture could evolve from legacy-web adaptation toward **normalization across independently designed WebMCP interfaces**.

---

## What it currently supports

The prototype focuses on **public, read-only research tasks**.

### Rentals

- OpenRent
- multi-constraint property search
- whole-property vs shared-room distinction
- bedroom/rent/occupancy semantics
- candidate verification and ranking

### Commerce

- Shopify storefronts
- WooCommerce storefronts
- selected direct commerce adapters
- category/audience/attribute filtering
- availability, price, and finalist verification

### Jobs

- Greenhouse
- Lever
- normalized job search and listing retrieval

Compatibility is **capability-based, not a domain allowlist**.

A tested website is evidence that an adapter works; it is not a requirement that every usable domain be manually registered first.

Not every deployment of a supported platform is guaranteed to work. Sites can customize public routes, change schemas, or block the gateway's hosting environment.

**Honest failure is preferable to a plausible but incorrect answer.**

---

## How it works

```text
┌─────────────────────────────────────┐
│         WebMCP browser agent        │
└─────────────────┬───────────────────┘
                  │
          semantic tool request
                  │
┌─────────────────▼───────────────────┐
│          Agent Web Gateway          │
│                                     │
│  1. normalize user intent           │
│  2. detect provider/platform        │
│  3. choose bounded acquisition      │
│  4. build canonical records         │
│  5. apply hard constraints          │
│  6. rank                            │
│  7. verify finalists                │
│  8. project compact result          │
└─────────────────┬───────────────────┘
                  │
        public HTTPS interfaces
                  │
┌─────────────────▼───────────────────┐
│         Existing public web         │
└─────────────────────────────────────┘
```

The implementation is intentionally deterministic wherever practical. There is no LLM inside the gateway deciding whether “black” means black, whether a shared room is a whole flat, or whether a price satisfies a numeric threshold.

---

## Reliability by design

A major focus of the project is preventing **false confidence**.

For example, fully searching the wrong collection does not prove that the cheapest product was found.

A trustworthy superlative requires:

```text
acquisition sufficiently complete
              +
scope appropriate to the query
              +
semantic interpretation reliable
              ↓
safe to make a global claim
```

Hard constraints use semantics equivalent to:

```text
MATCH
NO_MATCH
UNKNOWN
```

`UNKNOWN` does not silently become `MATCH`.

For rentals:

```text
flat ≠ room in a shared flat
room rent ≠ whole-property rent
max occupants ≠ couples allowed
last updated ≠ newly listed
```

For commerce:

```text
collection exhausted ≠ query universe exhausted
unknown colour ≠ wrong colour
some sold-out variants ≠ product unavailable
```

Search results are treated as candidates; finalists can be reconciled against more authoritative detail records before they are returned as exact matches.

---

## Context efficiency

The gateway keeps large working sets outside model context.

Instead of:

```text
hundreds or thousands of records
→ model context
→ model performs filtering/ranking
```

the intended workflow is:

```text
large source dataset
→ gateway
→ deterministic normalize/filter/rank/verify
→ winner + a few useful alternatives
→ model context
```

This reduces both context usage and the number of site-specific decisions left to the agent.

---

## Native WebMCP is still preferable

Agent Web Gateway is not intended to replace a high-quality first-party WebMCP implementation.

The preferred acquisition hierarchy is conceptually:

```text
strong native capability
        ↓
official/public API
        ↓
platform-family interface
        ↓
structured public data
        ↓
bounded fallback
```

If a target website already exposes a trustworthy native semantic interface, that is the better source.

**Native WebMCP is the destination. Agent Web Gateway explores the compatibility layer for everything that is not there yet.**

---

## Human view + agent view

The root application serves two audiences at the same URL.

### Humans

Humans see a normal landing page explaining:

- the problem
- the compatibility-layer idea
- example use cases
- the current proof-of-concept scope

### Agents

Compatible browser agents receive:

- WebMCP tool definitions
- concise parameter guidance
- answer-ready result contracts
- stopping/continuation signals
- machine-readable operating guidance

The agent instructions do not need to clutter the human interface.

---

## Safety and scope

The current prototype is intentionally **read-only**.

It is designed for:

- search
- retrieval
- filtering
- comparison
- ranking
- verification

It does not currently perform:

- purchases
- payments
- booking submissions
- job applications
- arbitrary form submissions

Dynamic targets are constrained to bounded public-web workflows. The project is not intended to be an unrestricted URL proxy.

The design avoids relying on:

- CAPTCHA bypass
- fingerprint spoofing
- residential proxy rotation
- stealth-browser infrastructure
- arbitrary authenticated-session extraction

---

## Testing

The project uses several layers of testing.

### Deterministic tests

For:

- schemas
- parsers
- normalization
- filtering
- ranking
- cache semantics
- route selection
- false-success prevention

### WebMCP compatibility tests

For:

- registration
- discovery
- invocation
- cold starts
- stable tool contracts
- cross-agent behavior

### Golden journeys

Real end-to-end tasks are retained as regressions, including:

- OpenRent multi-constraint property searches
- commerce superlatives involving category, audience, colour, stock, and price
- dynamic Shopify/WooCommerce acquisition
- Greenhouse and Lever job search

### Agent-vs-direct evaluation

The project also evaluates equivalent tasks as:

```text
same agent + direct browsing
vs
same agent + Agent Web Gateway
```

The purpose is to test whether moving mechanical web interpretation into deterministic software improves the agent's end result.

---

## Tech stack

The repository is primarily TypeScript/JavaScript and uses the existing web/serverless stack rather than a browser-automation service.

Key project dependencies include:

- React 19
- Next.js 16 / Vinext
- Vite
- TypeScript
- Zod
- Cloudflare Vite plugin / Wrangler

The gateway itself relies heavily on ordinary web primitives such as `fetch`, parsing, normalization, filtering, sorting, bounded concurrency, and caching.

---

## Run locally

### Requirements

- **Node.js >= 22.13.0**
- npm

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

Additional live/benchmark scripts are available in `package.json`.

---

## Deployment

The live proof of concept is deployed on **Cloudflare Workers**:

**https://agent-web-gateway.danemcgibbon.workers.dev/**

The architecture is intentionally lightweight and does not require a user-side browser worker, VPS, Docker runtime, or local MCP process.

---

## Hackathon

Agent Web Gateway was built as a proof of concept for the **OpenAI WebMCP Challenge**.

The project explores a transition problem in the agent-native web:

> Websites with first-party WebMCP can give agents excellent structured interfaces. What should agents do with the enormous existing web that has not made that transition?

Agent Web Gateway's answer is to experiment with a shared compatibility layer.

A useful demonstration is not that the gateway can retrieve one particular product or property.

It is that:

```text
an unmodified third-party website
        +
a WebMCP browser agent
        +
a compatibility layer
        ↓
a structured, verifiable task
without target-site integration
```

---

## Project status

Agent Web Gateway is an experimental proof of concept, not a production guarantee for the entire web.

The prototype currently demonstrates:

- a live WebMCP-enabled compatibility gateway
- external adaptation of unmodified third-party public websites
- reusable platform-family adapters
- shared commerce, rental, and job semantics
- cross-agent WebMCP compatibility
- canonical records and finalist verification
- explicit partial/failure semantics
- server-side filtering and ranking
- human-facing and machine-facing experiences at one URL

The most important remaining work is broader compatibility testing and empirical agent-vs-direct benchmarks.

---

## Design principles

1. **Semantic tools over browsing primitives**
2. **Deterministic software over repeated model interpretation**
3. **Platform families over one-off site scripts**
4. **Native interfaces before fallbacks**
5. **False success is worse than honest failure**
6. **Hard constraints fail closed**
7. **Verify before making global claims**
8. **Keep large working sets outside model context**
9. **One WebMCP contract across compatible agents**
10. **Read-only by default**
11. **No anti-bot arms race**
12. **Measure complete agent journeys, not just endpoint health**

---

## Non-goals

Agent Web Gateway is not trying to become:

- a universal scraper
- a stealth browser platform
- an unrestricted remote browser
- an arbitrary HTTP proxy
- a transactional autonomous agent
- a replacement for high-quality native WebMCP

---

## Contributing

Useful contributions include:

- compatibility testing against new public website families
- deterministic parser/normalizer fixtures
- WebMCP interoperability tests
- false-success regression cases
- direct-vs-gateway agent benchmarks
- provider coverage improvements that preserve the safety model

For compatibility reports, please include:

- target public URL
- user goal
- observed result
- expected result
- WebMCP consumer used
- whether direct browsing produced a different result

Do not include private credentials or authenticated session data.

---

## License

MIT © 2026 Dane McGibbon

See [`LICENSE`](./LICENSE).

---

## Closing

The web is becoming agent-native, but unevenly.

Agent Web Gateway asks whether every browser agent should have to independently rediscover and reinterpret that complexity on every task.

```text
heterogeneous existing web
        ↓
compatibility + normalization
        ↓
consistent WebMCP interface
        ↓
less site-specific reasoning in the model
```

**Native WebMCP is the destination. Agent Web Gateway is the compatibility layer for everything that is not there yet.**
