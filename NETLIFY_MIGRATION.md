# Netlify migration

This repository is a Vinext App Router site. The Netlify path uses the Nitro
Netlify preset, so the rendered page and the existing `/api/*` route handlers
continue to run as one Netlify function. The Cloudflare/Sites build remains
the default `npm run build` path.

## Files already prepared

- `netlify.toml` sets the Node version, Netlify build command, publish folder,
  and generated functions folder.
- `package.json` adds `build:netlify` and the pinned `nitro` build dependency.
- `vite.config.ts` selects Nitro when `NETLIFY=1` or
  `NITRO_PRESET=netlify`; the Cloudflare plugin is still used everywhere else.
- `app/globals.css` uses the package-exported Tailwind stylesheet path that
  works with both Vite's Cloudflare pipeline and Nitro.
- `package-lock.json` records the exact dependency graph.
- `.netlify/` is ignored because it is generated during each Netlify build.

No separate hand-written function file is required. Nitro generates
`.netlify/functions-internal/server/` and its route manifest from the app at
build time.

## Recommended setup: connect the Git repository

1. Push this commit to the Git repository that contains the site.
2. Create or sign in to a Netlify account and choose **Add new project →
   Import an existing project**.
3. Choose the Git provider and repository, select the branch to publish
   (normally `main`), and keep the base directory at the repository root.
4. Netlify reads `netlify.toml`. Confirm the displayed values are:
   - Build command: `npm run build:netlify`
   - Publish directory: `dist`
   - Functions directory: `.netlify/functions-internal`
5. Select **Deploy**. The build installs dev dependencies, runs the Nitro
   Netlify build, and deploys both `dist` and the generated function.
6. Open the generated `https://<project-name>.netlify.app` URL and run the
   smoke checks below before changing DNS.

## Optional CLI path

From a clean clone of this repository:

```bash
npm install
npm run build:netlify

# One-time authentication and site linking.
npm install -g netlify-cli
netlify login
netlify init                 # create/connect a site with continuous deploys
# or: netlify link            # link to a site that already exists

# Validate the Netlify build locally (optional).
netlify build

# Draft deploy for review.
netlify deploy --dir=dist --functions=.netlify/functions-internal

# Production deploy after the draft passes the checks.
netlify deploy --prod --dir=dist --functions=.netlify/functions-internal
```

If you use continuous deployment, later pushes to the selected branch rebuild
and deploy automatically; the CLI `deploy` commands are only needed for
manual deployments.

## Smoke checks

Replace `<project-name>` with the Netlify subdomain (or custom domain):

```bash
curl -fsS https://<project-name>.netlify.app/agent.json
curl -fsS https://<project-name>.netlify.app/api/status
curl -fsS https://<project-name>.netlify.app/api/manifest
```

Also open `/` in a browser and exercise the page's **Check status** action.
The first two JSON responses should be HTTP 200 and the manifest should list
the same gateway contract and tools as the current deployment.

## Domain cutover

Keep the current Site deployment live while testing the Netlify URL. In
Netlify, add the custom domain under **Domain management**, follow the DNS
records Netlify provides, wait for HTTPS to become active, and then switch the
domain's DNS. Re-run all three smoke checks on the custom domain. Roll back by
restoring the previous DNS records if a check fails.

## Runtime and secrets notes

The current repository has no D1/R2 binding and its connector calls use the
standard `fetch` API, so there are no required Netlify secrets for this build.
If future code adds API keys, set them in Netlify's environment-variable UI
with the **Builds** and/or **Functions** scope; do not commit them to `.env`
files or `netlify.toml`.

If future code depends on Cloudflare-only bindings (`cloudflare:workers`, D1,
R2, or the Images binding), it will need a Netlify-compatible replacement or
an external service before the Netlify build can use that feature.

## Rollback

The migration files are additive. To return to the Sites/Cloudflare build,
leave the repository as-is and run `npm run build`; the Netlify-specific
branch in `vite.config.ts` is selected only when Netlify sets
`NITRO_PRESET=netlify` (or `NETLIFY=1`).

