# Review site

## What it is

By default, people sign in with GitHub and see reviews only for repositories they can already read. Every signed-in request is checked as that person. Nothing is stored; reports are read from workflow artifacts kept 90 days. Report pages run in a sandbox, so their content cannot act as the signed-in person. Every report is shown with the interface the site was deployed with: the site keeps the report's stored design data and replaces the interface code it was built with, so older reviews get the current interface. Data an older run never stored (for example drawings it skipped) stays missing. The downloaded report file is unchanged. Optional share links below grant guests read-only access to one report without signing in.

## What a user approves at sign-in

GitHub's consent screen lists “Verify your GitHub identity”, “Know which resources you can access” and “Act on your behalf”. The app can do only what both the person and the app may do.

## Create the GitHub App

The owner does this once.

1. Go to **Settings → Developer settings → GitHub Apps → New**.
2. Set the callback URL to `http://localhost:8787/callback` for local testing. Then add `https://<name>.<account>.workers.dev/callback`.
3. Turn **Expire user authorization tokens** on and leave webhooks off.
4. Under repository permissions, grant Metadata read, Contents read and write, Actions read and write, and Pull requests read and write. Actions write is used to start a comparison and, with `threads.block_merge`, to re-run the review. Pull requests write is only used to create, reply to and resolve review threads as the signed-in person. Threads also need Contents read and write because GitHub requires Contents write to resolve review threads. Optionally grant Issues read and write to list anchored issues and create them from threads and findings when `[issues] enabled = true`. This is a new permission: the owner must add it and each installation must accept the change. Without it, the site shows a clear permission hint; threads still work. No new secrets are needed.
5. Generate a client secret. Install the app on the chosen repositories.
6. Keep the client secret out of the repository, chat and logs.

## Run locally

```sh
cd site
npx wrangler dev
```

`wrangler` is fetched by `npx`. The MCP server's two locked dependencies install with `npm ci --prefix site` from the repository root; run it before the site tests. Put local secrets in `site/.dev.vars`, which is git-ignored:

```text
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
SESSION_KEY=…
```

Make a session key with `openssl rand -base64 32`. Open <http://localhost:8787>. Run the tests from the repository root with `node --import ./site/css-loader.mjs --test site/test.mjs`.

## Deploy

Each deploy needs the owner's approval.
For [the deployment workflow](../.github/workflows/site-deploy.yml), set the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

```sh
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_KEY
npx --yes wrangler@4.148.0 deploy --var DEPLOY_SHA:$(git rev-parse HEAD)
```

Run the deploy command from `site/` in the approved checkout. It records the full serving commit in the page footer, `<meta name="deploy-sha">`, and the `X-Deploy-Sha` response header. The deployment workflow passes `${{ github.sha }}` through the same `DEPLOY_SHA` variable. An unset or invalid variable displays `unknown`, never a guessed commit. Verify this value against the intended tools SHA before hosted checks; the report's base/head commits identify the design, not the deployed interface.

Keep `keep_names = false` in `site/wrangler.toml`. The thread client (`threadsClient`) is shipped to the browser via `.toString()`; name-preserving build helpers would not exist there.

Then set the Actions variable `KICAD_REVIEW_SITE` to the site URL in each KiCad repository, or for the organisation, so that comments link to it.

## Share links (optional)

Share links are off unless all three worker secrets below are set. Existing sign-in and repository access checks are unchanged. Enabling them requires the owner's approval; this guide does not configure permissions, create keys or deploy anything.

- Grant the GitHub App **Variables: read and write**, and accept the permission update on its installations. Actions read is already required.
- `GITHUB_APP_ID`: the App's numeric ID (not its OAuth client ID).
- `GITHUB_APP_PRIVATE_KEY`: an App private key in PKCS#8 PEM. Convert a privately generated key with `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem`.
- `SHARE_KEY`: 32 random bytes in base64 (for example, generate privately with `openssl rand -base64 32`).

An owner can configure these with `npx wrangler secret put <name>`, or use a git-ignored `site/.dev.vars` for local testing. Never put values in source control, chat, logs or command arguments. Cloudflare account admins can replace worker secrets but cannot read them back through Wrangler.

**Private-key warning:** a leaked App private key lets an attacker act as the App on every installation, within its permissions. Rotate it in GitHub App settings if exposure is suspected. Keep this feature off if guest access is unnecessary.

Writers see **Share…** on a review page. Links grant read-only access to that one report artifact, not the repository, history or comments. Choose 1–30 days (default 7); expiry is never later than the report's own expiry. Anyone holding the URL can read it without signing in: treat the URL as a bearer credential. Removing an owner from `ALLOWED_OWNERS` also disables its links. Guests receive the same report sandbox, no navigation, `noindex, nofollow`, `no-referrer` and private/no-store headers. GitHub user tokens, installation tokens and App JWTs never appear in pages or links.

**Revoke all links for this repository** replaces the repository Actions variable `KICAD_REVIEW_SHARE_GEN` with a fresh opaque numeric generation. Every previous generation stops working; individual-link revocation is not supported. **Never delete the `KICAD_REVIEW_SHARE_GEN` variable:** a missing variable reads as generation 0 and revives links created before the first revoke. Never reset it to a previous value. To kill all links, rotate `SHARE_KEY`. State read/write errors fail closed rather than claiming revocation succeeded.

Installation tokens are cached only in worker-isolate memory, until five minutes before their GitHub expiry. The bounded cache separates App, installation, owner, repository and permission scopes. Tokens are never persisted or sent to guests. Guest tokens have only Actions read and Variables read, scoped to the single repository. Revocation uses a separate repository-scoped Variables-write token. Generation state is checked on every guest request and is never cached, so token reuse does not delay revocation. A wrapper view uses four GitHub calls (three with a cached token); its report frame uses six (five cached), including the artifact storage download. No database or KV is added.

## Ask

Ask needs the API-key secret and KV binding on the Worker, plus repository opt-in. Missing Worker setup answers 503; the embedded tab stays disabled. The fail-closed opt-in reader supports the complete shipped `examples/kicad-review.toml`, including `bom.required_fields = ["Value", "Footprint"]`: bare single-level tables/keys, boolean/decimal/string scalars and flat scalar arrays, including multiline arrays, trailing commas and comments. `[ask].enabled` must be the literal boolean `true`; false, quoted booleans, malformed input and duplicate tables/keys never opt in. Inline/dotted/quoted tables, nested arrays and multiline strings remain outside this deliberately constrained subset and refuse Ask without sending design data; configurations needing these forms require an owner-approved TOML parser before deployment. Keep the full-example enabled/false/malformed route test passing after editing the example.

```sh
cd site
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler kv namespace create ASK_KV
```
Add the printed id to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "ASK_KV"
id = "<the printed id>"
```
Optional variables under `[vars]`: `ASK_DAILY_LIMIT` (questions per user per day, default 50), `ASK_MODEL` (default `claude-sonnet-5-5`) and `ASK_SUMMARY_MODEL` (defaults to `ASK_MODEL`, or `claude-sonnet-5-5`; set `ASK_SUMMARY_MODEL` to a smaller model to cut cost). KV holds only the per-user daily counter and the cached summaries; it is a cache, not a store. The daily counter is a best-effort UX cap, not a billing bound: concurrent requests and eventually consistent reads can overshoot without a fixed bound or lose increments. KV permits only one write per second to the same key; if a daily-counter write fails after the provider starts an answer, Ask continues that answer without retrying the model and emits a status explaining that the remaining count is an estimate. The increment may be lost. Configure provider billing limits before deployment; a hard quota needs owner-approved serialized storage. Locally, put `ANTHROPIC_API_KEY` in `site/.dev.vars` and add the same `[[kv_namespaces]]` stanza.

## MCP dependencies (verified 2026-11-02)

`site/package.json` pins `@cloudflare/workers-oauth-provider` 1.2.4 and `@modelcontextprotocol/sdk` 1.32.2 exactly; `site/package-lock.json` locks the rest. The SDK's `WebStandardStreamableHTTPServerTransport` runs stateless (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) in workerd and Node and negotiates protocol `2025-03-26`. Discovery in this SDK is `discoverOAuthProtectedResourceMetadata(url, opts, fetchFn)` (fetch is the third argument, differing from the 2-argument signature in the plan text; Tasks 10–12 must use this 3-argument form) and `discoverAuthorizationServerMetadata(url, {fetchFn})`.

OAuth provider facts the MCP code relies on, checked against the installed types and source:

- `env.OAUTH_PROVIDER` is set for both `apiHandler` and `defaultHandler`; `apiHandler.fetch(request, env, ctx)` gets the decrypted grant props as `ctx.props`.
- PKCE is S256 only (plain is refused), redirect URIs match exactly, an access token is bound to `resourceMetadata.resource`, and a replayed code fails with `invalid_grant` and revokes that grant's tokens.
- Tokens are `<userId>:<grantId>:<secret>`; KV keeps only hashes and encrypted props.
- Refresh tokens are on by default. `refreshTokenTTL: 0` turns them off.
- Helpers: `listUserGrants(userId: string, options?) -> Promise<{items: GrantSummary[], cursor?: string}>` (each item has `id`), and `revokeGrant(grantId: string, userId: string) -> Promise<void>`, which deletes the grant and every token under it. The next bearer call returns 401 `invalid_token`.
- Public revocation (RFC 7009) uses the token endpoint, which metadata advertises as `revocation_endpoint`. Send `POST` with `Content-Type: application/x-www-form-urlencoded` and the body `token=<access or refresh token>&token_type_hint=access_token&client_id=<client id>`; a confidential client authenticates the way it does at the token endpoint. The response is always 200. Revoking an access token deletes only that token; revoking a refresh token revokes the whole grant. After revocation the revoked bearer gets 401 with `WWW-Authenticate: Bearer ... error="invalid_token"`.

The provider imports `cloudflare:workers`, so tests in Node that load it need that module stubbed.

## Settings

`ALLOWED_OWNERS` in `wrangler.toml` is a comma-separated list of GitHub owners whose repositories the site will serve.

## Moving to an organisation

Install the app on the organisation and select its repositories; add the organisation to `ALLOWED_OWNERS`; redeploy. GitHub Apps are not subject to the organisation's OAuth app access restrictions.

## Cost

Cloudflare Workers' free plan has 100,000 requests a day and costs $0. Reports are read from GitHub's storage through the worker, re-dressed in the current interface, and are not stored by the site.

## Limits

- A review whose artifact expired shows “expired — rerun”.
- The report page's Copy link may be limited inside the sandbox.
- Sign-in tokens last 8 hours and are refreshed for up to 6 months.

### Optional private-asset browser checks

`site/asset-cache.test.mjs` uses Node 22's built-in fetch and WebSocket with
`site/test-cdp.mjs`; no study checkout or npm package is required. It skips with
an explanation when no dedicated Chrome debug endpoint is reachable. These
checks are not CI gates because they require an already-running Chrome.

Start a separate **headless** Chrome with a fresh temporary profile and a debug
port such as 9223, then run from the repository root:

```sh
CDP_PORT=9223 node --import ./site/css-loader.mjs --test site/asset-cache.test.mjs
node --test site/test-cdp.test.mjs
```

Never use the study browser on port 9222. The helper creates and closes only its
own test tabs; it does not activate windows or stop Chrome. Stop your dedicated
headless Chrome and remove its temporary profile afterward. `FRAME_CDP` may
point to an alternate module exporting the same `FrameCDP` API.
