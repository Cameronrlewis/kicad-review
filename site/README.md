# Review site

## What it is

People sign in with GitHub and see reviews only for repositories they can already read. Every request is checked as that person. Nothing is stored; reports are read from workflow artifacts kept 90 days. Report pages run in a sandbox, so their content cannot act as the signed-in person.

## What a user approves at sign-in

GitHub's consent screen lists “Verify your GitHub identity”, “Know which resources you can access” and “Act on your behalf”. The app can do only what both the person and the app may do.

## Create the GitHub App

The owner does this once.

1. Go to **Settings → Developer settings → GitHub Apps → New**.
2. Set the callback URL to `http://localhost:8787/callback` for local testing. Then add `https://<name>.<account>.workers.dev/callback`.
3. Turn **Expire user authorization tokens** on and leave webhooks off.
4. Under repository permissions, grant Metadata read, Contents read, and Actions read and write. Actions write is only used to start a comparison.
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

Make a session key with `openssl rand -base64 32`. Open <http://localhost:8787>. Run the tests with `node --test site/test.mjs`.

## Deploy

Each deploy needs the owner's approval.

```sh
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_KEY
npx wrangler deploy
```

Or use the manual workflow below. Then set the Actions variable `KICAD_REVIEW_SITE` to the site URL in each KiCad repository, or for the organisation, so that comments link to it.

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
