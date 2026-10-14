# Review site

## What it is

By default, people sign in with GitHub and see reviews only for repositories they can already read. Every signed-in request is checked as that person. Nothing is stored; reports are read from workflow artifacts kept 90 days. Report pages run in a sandbox, so their content cannot act as the signed-in person. Optional share links below grant guests read-only access to one report without signing in.

## What a user approves at sign-in

GitHub's consent screen lists “Verify your GitHub identity”, “Know which resources you can access” and “Act on your behalf”. The app can do only what both the person and the app may do.

## Create the GitHub App

The owner does this once.

1. Go to **Settings → Developer settings → GitHub Apps → New**.
2. Set the callback URL to `http://localhost:8787/callback` for local testing. Then add `https://<name>.<account>.workers.dev/callback`.
3. Turn **Expire user authorization tokens** on and leave webhooks off.
4. Under repository permissions, grant Metadata read, Contents read and write, Actions read and write, and Pull requests read and write. Actions write is used to start a comparison and, with `threads.block_merge`, to re-run the review. Pull requests write is only used to create, reply to and resolve review threads as the signed-in person. Threads also need Contents read and write because GitHub requires Contents write to resolve review threads.
5. Generate a client secret. Install the app on the chosen repositories.
6. Keep the client secret out of the repository, chat and logs.

## Run locally

```sh
cd site
npx wrangler dev
```

`wrangler` is fetched by `npx`; nothing is added to the repository. Put local secrets in `site/.dev.vars`, which is git-ignored:

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
npx wrangler deploy
```

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

## Settings

`ALLOWED_OWNERS` in `wrangler.toml` is a comma-separated list of GitHub owners whose repositories the site will serve.

## Moving to an organisation

Install the app on the organisation and select its repositories; add the organisation to `ALLOWED_OWNERS`; redeploy. GitHub Apps are not subject to the organisation's OAuth app access restrictions.

## Cost

Cloudflare Workers' free plan has 100,000 requests a day and costs $0. Reports stream from GitHub's storage through the worker and are not stored by the site.

## Limits

- A review whose artifact expired shows “expired — rerun”.
- The report page's Copy link may be limited inside the sandbox.
- Sign-in tokens last 8 hours and are refreshed for up to 6 months.
