# Deployment

Agent Web Gateway is a Vinext application deployed as a Cloudflare Worker with
static assets. The live demo is:

https://agent-web-gateway.danemcgibbon.workers.dev

## Cloudflare Workers

Connect the GitHub repository in **Workers & Pages → Create application →
Import a repository**. Use the repository root and the `main` branch.

```text
Build command:  npm run build
Deploy command: npx wrangler deploy
Node version:   22.13.0 or newer
```

The normal build produces the Worker entrypoint and browser assets. Wrangler
deploys the generated configuration and publishes the Worker on a
`workers.dev` address. No provider credentials are required for the public,
read-only demo.

## Smoke checks

After deployment, confirm these endpoints return successfully:

```text
https://YOUR-WORKER.workers.dev/agent.json
https://YOUR-WORKER.workers.dev/api/status
https://YOUR-WORKER.workers.dev/api/manifest
```

Then open the root page and exercise the WebMCP gateway workflow.

## Local development

Prerequisites are Node.js `>=22.13.0` and the project dependencies.

```bash
npm run install:ci
npm run dev
```

To validate the production build:

```bash
npm run build
```
