# Agent Web Gateway

> **A WebMCP compatibility layer for the existing web.**

Agent Web Gateway lets browser agents interact with ordinary public websites through a small, consistent WebMCP interface — even when those websites do not expose WebMCP themselves.

Instead of asking an AI agent to manually browse, paginate, interpret, filter, compare, and verify every site-specific page, the gateway moves more of that mechanical work into deterministic software and returns compact, structured results.

**Live demo:** https://agent-web-gateway.djrookie99.chatgpt.site/

---

## Why this exists

WebMCP gives websites a better way to expose capabilities to AI agents. But the existing web will not become agent-native overnight, and different websites already expose very different structures, APIs, schemas, and browsing experiences.

Agent Web Gateway explores the compatibility layer between those worlds.

```text
Existing public website
        ↓
Agent Web Gateway
        ↓
normalized semantic workflow
        ↓
WebMCP
        ↓
ChatGPT / OpenClaw / compatible browser agents
```

The goal is not to make agents better at scraping.

The goal is to make scraping-like reasoning increasingly unnecessary.

---

## What it does

Agent Web Gateway currently focuses on public, read-only web tasks.

Examples include:

- **Commerce** — search, filter, compare, rank, and verify products
- **Rentals** — search and verify rental listings across structured constraints
- **Jobs** — search compatible job boards through a consistent interface
- **Dynamic website targeting** — pass a specific public website URL without pre-registering that domain
- **Cross-site normalization** — convert different provider structures into common semantic records
- **Answer-ready results** — return compact conclusions instead of dumping large raw datasets into model context

The gateway is designed so that an agent can express the goal while the gateway handles as much deterministic work as possible.

---

## Example

A user can ask:

> Find the cheapest available whole 1+ bedroom flat in Croydon under £1,500 that accepts couples on OpenRent.

A browser agent can invoke Agent Web Gateway through WebMCP rather than manually navigating and interpreting OpenRent.

Internally, the gateway can:

```text
normalize intent
→ select a safe provider route
→ apply provider-native filters where possible
→ paginate
→ normalize candidates
→ verify finalists
→ reconcile conflicting fields
→ apply hard constraints
→ rank
→ return a compact verified result
```

The agent receives the result, not the entire browsing process.

---

## Why WebMCP?

A conventional MCP server could expose similar backend operations, but WebMCP enables a different user experience:

```text
open webpage
→ browser agent discovers tools
→ use them immediately
```

There is no separate MCP server installation or client configuration required for the user.

Agent Web Gateway is therefore intentionally a **browser-native compatibility service**.

The same live page has been tested with multiple WebMCP consumers, including:

- ChatGPT Site Tools / in-app browser
- OpenClaw browser agents

The project aims to keep one shared WebMCP contract rather than client-specific implementations.

---

## How it differs from native WebMCP

Native WebMCP is the ideal path when a website already exposes a high-quality first-party agent interface.

Agent Web Gateway focuses on the rest of the web.

```text
Website has strong native WebMCP?
        ↓ yes
prefer native capability where appropriate

        ↓ no
official/public API?
        ↓
platform-family adapter?
        ↓
structured public data?
        ↓
bounded read-only fallback
```

The long-term idea is not to compete with native WebMCP, but to provide a compatibility and normalization layer around a heterogeneous agentic web.

---

## Current compatibility

The prototype has reusable support or active compatibility work across several website families and verticals, including:

### Commerce

- Shopify storefronts
- WooCommerce storefronts
- selected direct commerce adapters

### Jobs

- Greenhouse
- Lever

### Rentals

- OpenRent

Compatibility is **capability-based, not domain-allowlist based**.

A tested website is evidence that an adapter works; it is not a requirement that every usable site be pre-registered.

Not every deployment of a supported platform is guaranteed to work. Sites can customize their storefronts, change public routes, or block the gateway's hosting environment.

The gateway prefers an honest failure over a plausible but incorrect result.

---

## Architecture

Agent Web Gateway is deliberately lightweight.

```text
┌─────────────────────────────────────┐
│          Browser / WebMCP           │
└─────────────────┬───────────────────┘
                  │
          small semantic tool surface
                  │
┌─────────────────▼───────────────────┐
│          Agent Web Gateway          │
│                                     │
│  intent normalization               │
│  provider / platform routing        │
│  acquisition                        │
│  canonical normalization            │
│  filtering                          │
│  ranking                            │
│  verification                       │
│  compact result projection          │
└─────────────────┬───────────────────┘
                  │
      public HTTPS / structured data
                  │
┌─────────────────▼───────────────────┐
│        Existing public web          │
└─────────────────────────────────────┘
```

The production design intentionally avoids requiring:

- browser extensions
- a local MCP server
- Docker
- a user-managed Chromium instance
- a VPS
- an LLM inside the gateway
- a vector database
- anti-bot evasion infrastructure

Most workflow logic is conventional TypeScript/JavaScript: `fetch`, parsing, normalization, maps, sets, filters, sorting, bounded concurrency, and caching.

---

## Reliability model

A major focus of the project is preventing **false confidence**.

For example, the gateway should not call something “the cheapest” simply because it fully searched the wrong collection.

A trustworthy superlative requires:

```text
acquisition complete enough
        +
scope appropriate for the query
        +
semantic interpretation reliable
        ↓
safe to rank globally
```

The project also uses strict distinctions such as:

```text
MATCH
NO_MATCH
UNKNOWN
```

for hard constraints.

`UNKNOWN` does not silently become a match.

For rentals, for example:

```text
flat ≠ room in a shared flat
room rent ≠ whole-property rent
max occupants ≠ couples allowed
last updated ≠ newly listed
```

The same principle is applied across commerce and other verticals.

---

## Context efficiency

Large intermediate datasets stay inside the gateway wherever possible.

Instead of:

```text
thousands of products
→ model context
→ model filters them
```

the intended workflow is:

```text
thousands of products
→ gateway memory / snapshot
→ deterministic filter + rank + verify
→ 1 winner + a few useful alternatives
→ model context
```

This reduces both context usage and the number of opportunities for agent-side mistakes.

Rich product or listing details can be requested later without repeating the original search.

---

## Human view and agent view

The root website serves two audiences at once.

### Humans see

A simple explanation of:

- what Agent Web Gateway is
- why agent browsing can be unreliable
- what the gateway improves
- example use cases

### Agents get

A compact machine-readable operating guide and WebMCP tool definitions that explain:

- which tool to use
- how to pass a target site
- when a result is answer-ready
- when to stop
- when to request richer detail
- how to access uncommon capabilities

The agent instructions are non-rendered machine metadata, so they do not clutter the human landing page.

---

## Safety

The current prototype is intentionally **read-only**.

It is designed for tasks such as:

- search
- retrieval
- filtering
- comparison
- verification

It does **not** currently perform:

- purchases
- payments
- booking submissions
- job applications
- arbitrary form submissions

Dynamic target handling is also constrained.

The gateway is not intended to be an unrestricted URL proxy and should enforce protections such as:

- public HTTPS origins only
- no localhost or private-network targets
- redirect revalidation
- bounded requests and response sizes
- known read-only execution patterns

The project does not rely on CAPTCHA bypass, fingerprint spoofing, residential proxies, or similar anti-bot evasion.

---

## Testing

Agent Web Gateway is tested at several layers.

### Deterministic tests

Used for schemas, parsers, normalization, filtering, ranking, cache semantics, false-success prevention, and provider routing.

### WebMCP / browser tests

Used for tool registration, discovery, invocation, cold-start reliability, and cross-agent compatibility.

### Golden journeys

Real end-to-end tasks are used as permanent regressions, including dynamic commerce searches, product superlatives, OpenRent rental searches, and Greenhouse/Lever job searches.

### Gateway vs direct browsing

One of the central experiments behind the project is comparing the **same model** on the **same task**:

```text
direct website browsing
vs
Agent Web Gateway
```

The hypothesis is that moving repetitive web interpretation into deterministic software makes browser agents more accurate, faster, and cheaper.

---

## Hackathon

Agent Web Gateway was built as a proof of concept for the **OpenAI WebMCP Challenge**.

The project explores a simple question:

> **What happens if the complexity of the existing web is normalized before it reaches the model?**

Native WebMCP is the destination.

Agent Web Gateway explores the compatibility layer for everything that is not there yet.

---

## Design principles

1. **Semantic tools over scraping primitives**
2. **Platform families over one-off site scripts**
3. **Verified examples, not domain allowlists**
4. **Native/structured routes before expensive fallbacks**
5. **Deterministic software over repeated LLM reasoning**
6. **Large working datasets stay outside model context**
7. **False success is worse than honest failure**
8. **Hard constraints fail closed**
9. **Verify before making global claims**
10. **One shared WebMCP contract across compatible agents**
11. **Read-only by default**
12. **No anti-bot arms race**
13. **Zero-install for users**
14. **Measure real agent journeys, not just endpoint health**

---

## Project status

Agent Web Gateway is an experimental proof of concept, not a production guarantee for the entire web.

What the prototype already demonstrates:

- a live WebMCP-enabled compatibility gateway
- dynamic targeting of third-party public websites
- reusable platform-family adapters
- common commerce, jobs, and rental workflows
- cross-agent WebMCP compatibility work
- structured failure semantics
- verification and false-success prevention
- context-efficient server-side filtering and ranking
- a human-facing site and separate machine-facing agent guidance

Current work is focused on broader reliability across unfamiliar sites, provider scope selection, semantic normalization, coverage proofs for superlatives, cache correctness, cross-agent consistency, and benchmarked comparison against direct browsing.

---

## Running locally

> Replace the commands below if the repository uses a different package manager or scripts.

```bash
git clone <YOUR_REPOSITORY_URL>
cd agent-web-gateway

npm install
npm run dev
```

Then open the local development URL in a WebMCP-capable browser.

---

## Deployment

The current proof of concept is publicly hosted at:

https://agent-web-gateway.djrookie99.chatgpt.site/

The architecture is intended to remain portable to normal serverless/web platforms because it does not depend on a local browser worker or persistent user-side infrastructure.

---

## Contributing

Useful contributions include:

- compatibility testing against new public website families
- deterministic parser and normalizer fixtures
- WebMCP interoperability tests
- false-success regression cases
- agent-vs-direct-browsing benchmarks
- improvements to provider coverage without introducing anti-bot evasion

If reporting a compatibility issue, please include:

- target public URL
- user goal
- WebMCP tool used
- observed result
- expected result
- whether direct browsing produced a different answer

Avoid including private credentials or authenticated session data.

---

## Non-goals

Agent Web Gateway is not trying to become:

- a universal anti-bot scraper
- a stealth browser platform
- an unrestricted remote browser
- an arbitrary HTTP proxy
- a transactional autonomous agent
- a replacement for high-quality native WebMCP

Where a website exposes a reliable first-party semantic interface, that is preferable.

---

## Closing

The web is becoming agent-native, but unevenly.

Agent Web Gateway explores what a transition layer could look like:

```text
heterogeneous existing web
        ↓
compatibility + normalization
        ↓
consistent WebMCP interface
        ↓
more reliable browser agents
```

**Native WebMCP is the destination. Agent Web Gateway is the compatibility layer for everything that is not there yet.**
