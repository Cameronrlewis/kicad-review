# Stage 2: Site Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild every Worker site screen as dense, accessible CAD application chrome without changing existing access rules, routes, comparisons, discussions, sharing or report behaviour.

**Architecture:** Keep server-rendered string templates in `site/pages.js`, inline assets and vanilla clients. Stage 1 owns tokens, first-paint theme bootstrap/toggle and the inline icon sprite; this stage consumes them, adds compact site layouts, and preserves all existing form and message contracts. After Task 1, Tasks 2–8 are independent bounded patches suitable for parallel agents in isolated worktrees; the integration owner applies their disjoint hunks and runs the complete suite before Task 9.

**Tech Stack:** Cloudflare Worker, JavaScript ES modules, CSS custom properties, native forms/dialogs, Node built-in test runner, installed Chrome; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-ui-redesign-design.md`, especially Design system, Chrome and site, Stages 1–2, Testing and Limits. Visual source: `/Users/cameron/Code/kicad-review-ui-reference/draft/design-system.md` §§2–6 and adjacent `mockup.html`.


**Cross-stage contracts:** `docs/superpowers/plans/2026-10-14-ui-0-contracts.md` overrides any differing interface name in this plan.

## Global Constraints

- No new UI framework or component library; plain CSS custom properties + vanilla JS as today. No new npm runtime dependency in the report.
- Offline single-file report keeps working (kicad_review.py inlines all assets; no external URLs).
- Existing hash deep-link keys p v m x y z s t l c h and all existing ui/checks.mjs checks keep passing.
- Change marks never rely on colour alone (glyph + dash/border style + word).
- Dark default, light available, choice stored in localStorage key `kr.theme` (try/catch).
- KiCad reuse: colour values/layer order as data with NOTICE credit; KiCad icons CC-BY-SA 4.0 with attribution in ui/icons/LICENSE; no GPL source copied.
- No pushes to main, no merging, no moving the v1 tag, nothing in the ParadigmEngineering organisation; private Aux board never committed.
- Commits: no Co-Authored-By Claude line, no "Generated with Claude Code" line.
- No feature code before plan approval. Execution happens on a non-main implementation branch in a worktree, not on `plans/ui-redesign`.
- Every UI-building task is assigned to a **general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling** and returns before/after screenshots in both themes. Inside the change viewer KiCad reference wins over skill suggestions.
- Keep system fonts, 13px body, 24px controls/rows, 28px dock headings, 32px toolbar, 2px focus ring. No green action accent, OLED black, webfonts, glow or new component package. Minimum text 11px; do not use draft `--fs-2xs` for site text.
- Binding spec wins over draft discrepancies: use `kr.theme`, not draft bootstrap key `theme`; absent/invalid choice starts dark, not OS-light. Stage 1 supplies this policy. Do not add a second bootstrap/toggle implementation.
- Preserve sandbox `allow-scripts allow-popups allow-popups-to-escape-sandbox` without `allow-same-origin`; retain clipboard permission, CSP, request-origin checks, cookies, escaping, link validation and no-referrer/noindex guest protections.
- Do not invent data or backend features for mockup columns. Current repository data has no open-review count; current review rows need not represent PRs; milestone counts mean deduplicated open/merged PRs, not arbitrary completion. Readiness has no merge mutation; sharing has only read-only access and 1–30 days. Show unavailable values as words or omit unsupported columns. No cosmetic “Merge” action that implies functionality we do not have.

## Review Focus

1. Hostile/very long repository, milestone, commit, history and comment text must remain escaped, readable and contained; never turn it into executable markup or unsafe navigation. Tasks 2, 3, 4, 6 and 8 add representative tests.
2. Sandbox frames have opaque origins and blocked storage: wrapper theme sync must verify `event.source`, tolerate storage errors, keep hashes/ready events and never require same-origin access. Task 5 pins markup/protocol; Task 9 exercises a browser.
3. Stale/unknown readiness and unavailable permissions must remain visibly unknown or blocked, never appear passing; quick thread changes must not let an older response overwrite a newer one. Task 6 keeps and extends existing executable client tests.
4. Failed/duplicate async dialog actions and clipboard denial must preserve text, restore enabled controls, announce errors and retain focus; Esc closes without a mutation. Tasks 6–7 add tests and Task 9 exercises native dialog behaviour.
5. Every invalid share outcome must use the same anonymous 404 presentation and status without disclosing token, repository, identity or expiry reason; raw failures must keep their sandbox/security policy. Task 7 adds route tests.

## File ownership, dependencies and contracts

Read `site/pages.js`, `site/site.css`, `site/test.mjs`, `site/{worker,share,readiness-client,threads-client,csp}.js` before execution. Current source anchors below refer to the pre-redesign checkout, not immutable line numbers.

- Task 1 owns `frame` (pages.js:29–33), base rules in `site.css`, shared site-only helpers, `site/proof.mjs` and the initial proof fixtures. Stage 1 theme/sprite markup in `frame` must remain intact.
- Task 2 owns `signedOutPage`, `homePage` (35–58); scoped `.signed-out-*` / `.repository-*` CSS.
- Task 3 owns `historyPage`, `reviewsPage`, `status` (14–27, 60–84, 267–273); scoped `.history-*` / `.review-list-*` / `.milestone-*` CSS.
- Task 4 owns `commitsPage`, `runPage` and their helpers (86–144, 171–253); `.compare-*` / `.steps` / `.run-*` CSS. Keep stage mapping logic unchanged.
- Task 5 owns `reviewPage` return layout only and `reportFrameScript` (168, 275–277); `.review-page`, `.review-bar`, `.review-stage`, `.review-loading` CSS. It does not edit the thread/readiness template declarations.
- Task 6 owns only `reviewPage`'s `readiness`/`threads` declarations (158–167), `readiness-client.js`, `threads-client.js`, `.readiness` / `.thread-*` CSS. It does not edit the wrapper return or frame script.
- Task 7 owns `sharedPage`, `shareControls` (279–313), adds `sharedNotFoundPage`, and makes only its dependency/import wiring changes in `worker.js` and response-body changes in `share.js`; `.share-*` / `.shared-*` CSS.
- Task 8 owns `messagePage` (255–265), its error status argument wiring in `worker.js:errorPage`, and `.message-*` CSS. Task 7's worker edit is imports/dependency injection only; Task 8's is errorPage only.
- Every task appends a uniquely prefixed test block to `site/test.mjs`; no whole-file formatting. CSS patches replace their owned existing selectors rather than layering contradictory override piles. Agents must not rebaseline the whole suite or modify another agent's ranges. Parallelism means independent patches from the Task 1 base, not concurrent writes to one working directory.
- Integration owner alone resolves shared import lines and the reviewPage template boundaries. Do not merge branches. Apply reviewed file hunks under the surrounding approved execution workflow.

**Public interfaces remain unchanged:** all existing `pages.js` exports and their argument shapes, form actions/names, query filters, route methods and client config keys. Additional exports from this stage: `siteBadge(value: string, label?: string): string`, `siteTable(headings: string[], rows: string, label: string): string`, and `sharedNotFoundPage(): string`. Helpers return escaped HTML; `siteTable` accepts trusted renderer-produced row markup, never user HTML. Existing `escapeHtml` is the one escaping function.

**Stage 1 dependency gate:** before Task 1, inspect its completed implementation and copy its actual helper import names into `frame`; this plan does not guess a theme-helper JS export. Required observable interface is one `[data-theme-toggle]` button, inline sprite symbols `#i-sun`, `#i-moon`, `#i-copy`, `#i-close`, `#i-refresh`, first-paint `html[data-theme=dark|light]`, safe `kr.theme` persistence and theme postMessage consumer in the report accepting `{theme: 'dark'|'light'}` from its parent. If Stage 1 did not supply this consumer, finish that dependency there before starting Task 5; do not duplicate ownership here.

### Exact token contract

Use the draft's actual names, never ad-hoc `--color-*` substitutes:

- Surfaces/text: `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--surface-sel`, `--line`, `--line-strong`, `--text`, `--muted`, `--accent`, `--accent-fill`, `--on-accent`, `--focus`.
- State: `--added`, `--removed`, `--modified`, `--waived`, `--added-bg`, `--removed-bg`, `--modified-bg`, `--waived-bg`, `--info-bg`, `--scrim`, `--shadow-pop`.
- Typography/space/shape: `--font-ui`, `--font-mono`, `--fs-xs`, `--fs-sm`, `--fs-md`, `--fs-lg`, `--fs-xl`, `--fs-2xl`, `--lh-base`, `--lh-tight`, `--fw-medium`, `--fw-semibold`, `--sp-0` through `--sp-6`, `--h-xs`, `--h-sm`, `--h-md`, `--h-lg`, `--r-1`, `--r-2`, `--r-3`, `--r-pill`, `--bw`, `--dur-fast`, `--dur`, `--ease`, `--z-dialog`.
- Components: `--toolbar-h`, `--toolbar-bg`, `--btn-h`, `--btn-bg`, `--btn-bg-hover`, `--btn-border`, `--btn-primary-bg`, `--btn-primary-fg`, `--icon-btn-size`, `--icon-size`, `--tab-h`, `--tab-underline`, `--panel-head-h`, `--panel-head-bg`, `--panel-bg`, `--row-h`, `--row-hover`, `--row-sel`, `--th-h`, `--td-pad-x`, `--chip-h`, `--badge-h`, `--statusbar-h`, `--statusbar-bg`, `--input-h`, `--input-bg`, `--input-border`, `--dialog-bg`, `--dialog-w`.
- Do not theme the iframe drawing through site CSS. `--board:#001023` and `--paper:#f5f4ef` are drawing data, not page surfaces. Read-only reference evidence: KiCad 10 source `common/settings/builtin_color_themes.h:32` (paper), `:160` (board), at commit `3e051f88`. No source implementation is copied. The inspected `pcb-01-default.png` and `sch-01-default.png` show restrained flat chrome, compact toolbars, dark board and pale schematic; site screens borrow chrome density, not private geometry.

## Verification conventions

Run all commands from `/Users/cameron/Code/kicad-review-worktrees/ui-redesign` during implementation. Set `PROOF_DIR` to a new directory inside the active session scratchpad and `REPORT` to a locally generated Thermal_Camera HTML. `REPORT` must contain Thermal_Camera, never Aux. No screenshots or profiles are committed. `site/proof.mjs` is a test-only fixture server; it never calls OAuth/GitHub and never requires `.dev.vars`. Real authenticated browser proof can additionally use `cd site && npx wrangler dev --port 8788` with the owner's existing secrets; never print or copy them.

Every task runs its new named test first (expected FAIL), then the complete `node --import ./site/css-loader.mjs --test site/test.mjs` (expected PASS). Existing tests are kept. Exact markup assertions may change only when the intended layout changes: preserve their behavioural assertions, executable VM exercises and security checks. A fixed digest at test.mjs:2080 intentionally pins old HTML, so it cannot stay numerically identical after a redesign. Rebaseline once, only after Task 9 review, using a literal reviewed digest; do not replace it with a runtime self-comparison. Task 1 can run the targeted test while the known digest is red, but an integration gate must never report the full suite green until that rebaseline.

---

### Task 1: Shared compact page primitives and deterministic browser fixtures

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:29–33`, `site/site.css:1–17,25–35,45–49`; Create `site/proof.mjs`; Test `site/test.mjs`.

**Interfaces:** Consumes Stage 1 tokens/toggle/sprite through `frame`. Produces `siteBadge`, `siteTable`, consistent base styles and CLI `node --import ./site/css-loader.mjs site/proof.mjs [fixture-name-substring]`. The CLI emits `<fixture>-<theme>.png` to `PROOF_DIR`, requires `REPORT`, uses an ephemeral loopback port, and closes server/Chrome profiles.

- [ ] **Step 1: Add failing markup tests.** Append these tests; add imports for `frame`, `siteBadge`, `siteTable` to the existing pages import (missing exports intentionally fail initially).

```js
test('S2 shell and primitives have dense accessible contracts', () => {
  const html = frame({ title: '<x>', body: '<main>Body</main>' });
  assert.match(html, /data-theme-toggle/);
  assert.match(html, /<header class="top">/);
  assert.match(html, /--toolbar-h/);
  assert.match(html, /--input-border/);
  assert.match(siteBadge('removed', '<bad>'), /−[^<]*&lt;bad&gt;/);
  assert.match(siteBadge('modified'), /status-modified/);
  assert.match(siteTable(['Name'], '<tr><td>R16</td></tr>', 'Parts'), /aria-label="Parts"/);
  assert.match(siteTable(['<b>'], '', 'Empty'), /&lt;b&gt;/);
});
```

- [ ] **Step 2: Run red test.** Run `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 shell' site/test.mjs`. Expected FAIL: missing helper exports, then absent component styles. Record pre-task both-theme screenshots using the fixture runner added in Step 4 before applying CSS changes; retaining a test-only runner does not alter page appearance.

- [ ] **Step 3: Add site-only primitives and replace owned base styles.** Keep `frame`'s Stage 1 bootstrap/toggle/sprite unchanged. Preserve exact `<header class="top">`, account POST logout and escaping. Add helpers after `repoPath`/`link`:

```js
export function siteBadge(value, label) {
  const states = {
    pass: ['✓', 'passing'], fail: ['✕', 'failing'], new: ['+', 'New'],
    error: ['✕', 'Error'], removed: ['−', 'Removed'], modified: ['~', 'Modified'],
    waived: ['○', 'Waived'], notrun: ['·', 'not recorded'],
  };
  const key = Object.hasOwn(states, value) ? value : 'notrun';
  const [glyph, word] = states[key];
  return `<span class="status status-${key}">${glyph} ${e(label ?? word)}</span>`;
}
export function siteTable(headings, rows, label) {
  return `<div class="table-scroll"><table class="table" aria-label="${e(label)}"><thead><tr>${headings.map(h => `<th scope="col">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headings.length}" class="muted">No items</td></tr>`}</tbody></table></div>`;
}
```

```css
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: var(--fs-md)/var(--lh-base) var(--font-ui); }
a { color: var(--accent); }
a.btn { text-decoration: none; display: inline-block; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.top { height: var(--toolbar-h); display: flex; align-items: center; gap: var(--sp-3); padding: 0 var(--sp-4); background: var(--toolbar-bg); border-bottom: 1px solid var(--line); min-width: 0; }
.product { color: var(--text); font-weight: var(--fw-semibold); text-decoration: none; white-space: nowrap; }
.crumbs { display: flex; gap: var(--sp-2); min-width: 0; color: var(--muted); }
.crumbs span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crumbs span + span::before { content: "/"; margin-right: var(--sp-2); }
.account { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; white-space: nowrap; }
.account form { margin: 0; }
.page { max-width: 960px; margin: 0 auto; padding: var(--sp-4); }
.page-wide { max-width: 1200px; }
.page-head { display: flex; align-items: start; flex-wrap: wrap; gap: var(--sp-3); margin-bottom: var(--sp-4); }
h1 { margin: 0; font-size: var(--fs-xl); font-weight: var(--fw-semibold); line-height: var(--lh-tight); }
h2 { font-size: var(--fs-lg); }
.lead { margin: var(--sp-1) 0 0; color: var(--muted); }
.page-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); margin-left: auto; }
.page-actions form { margin: 0; }
.btn { min-height: var(--btn-h); padding: var(--sp-0) var(--sp-3); border: 1px solid var(--btn-border); border-radius: var(--r-2); color: var(--text); background: var(--btn-bg); font: var(--fs-sm)/var(--lh-base) var(--font-ui); cursor: pointer; }
.btn:hover { background: var(--btn-bg-hover); }
.btn-primary { background: var(--btn-primary-bg); color: var(--btn-primary-fg); }
.btn-primary:hover { background: var(--btn-primary-bg); }
.btn[disabled] { cursor: not-allowed; opacity: .45; }
.btn-ghost { background: transparent; }
.table-scroll { overflow-x: auto; border: 1px solid var(--line); background: var(--surface); }
.table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.table th, .table td { height: var(--row-h); padding: var(--sp-0) var(--td-pad-x); text-align: left; border-bottom: 1px solid var(--line); vertical-align: middle; }
.table th { height: var(--th-h); position: sticky; top: 0; background: var(--surface-2); color: var(--muted); font-size: var(--fs-xs); font-weight: var(--fw-semibold); border-bottom-color: var(--line-strong); }
.table tbody tr:hover { background: var(--row-hover); }
.table .numeric { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.status { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: var(--badge-h); white-space: nowrap; padding: 0 var(--sp-1); border: 1px solid currentColor; border-radius: var(--r-1); font: var(--fw-semibold) var(--fs-xs)/var(--lh-base) var(--font-mono); }
.status-pass, .status-new { color: var(--added); background: var(--added-bg); }
.status-fail, .status-error, .status-removed { color: var(--removed); background: var(--removed-bg); }
.status-removed { border-style: dashed; }
.status-modified { color: var(--modified); background: var(--modified-bg); border: 2px dotted currentColor; }
.status-waived { color: var(--waived); background: var(--waived-bg); }
.status-notrun { color: var(--muted); }
.filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); margin: 0 0 var(--sp-3); }
.filter-chip { display: inline-flex; align-items: center; min-height: var(--chip-h); border: 1px solid var(--line-strong); border-radius: var(--r-pill); padding: 0 var(--sp-2); color: var(--muted); text-decoration: none; font-size: var(--fs-xs); }
.filter-chip[aria-current="page"] { background: var(--surface-sel); color: var(--text); border-color: var(--accent); font-weight: var(--fw-medium); }
.filter-chip[aria-current="page"]::before { content: "✓ "; white-space: pre; }
.card { padding: var(--sp-4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-3); }
.notice { margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--accent); border-left-width: 3px; background: var(--info-bg); }
.notice-info::before { content: "i "; }
.notice-error { border-color: var(--removed); background: var(--removed-bg); }
.notice-error::before { content: "✕ "; }
.notice-warn { border-color: var(--modified); background: var(--modified-bg); }
.notice-warn::before { content: "! "; }
.muted { color: var(--muted); }
.mono, code, time { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
form { margin: 0 0 var(--sp-3); }
input, select, textarea { min-height: var(--input-h); max-width: 100%; padding: var(--sp-0) var(--sp-2); font: inherit; color: var(--text); background: var(--input-bg); border: 1px solid var(--input-border); border-radius: var(--r-2); }
input[type=radio], input[type=checkbox] { min-height: auto; accent-color: var(--accent-fill); }
textarea { min-height: 64px; padding-block: var(--sp-2); }
input:read-only { font-family: var(--font-mono); }
dialog { width: var(--dialog-w); max-width: 92vw; max-height: 90vh; overflow: auto; padding: var(--sp-4); background: var(--dialog-bg); color: var(--text); border: 1px solid var(--line); border-radius: var(--r-3); box-shadow: var(--shadow-pop); }
dialog::backdrop { background: var(--scrim); }
dialog h2 { margin: 0 0 var(--sp-3); }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
@media (pointer: coarse) { :root { --h-sm: 32px; --row-h: 32px; } }
@media (max-width: 700px) { .account > span { max-width: 12ch; overflow: hidden; text-overflow: ellipsis; } .crumbs { flex: 1; } .page-actions { margin-left: 0; } }
```

- [ ] **Step 4: Add the fixture/screenshot runner.** The code below is complete test-only infrastructure. Use Node 22+ (global fetch/WebSocket are also required by existing `ui/check.mjs`). It deliberately uses public/synthetic metadata, a local Thermal_Camera report and no credentials. Add this file before the pre-change capture; then capture again after CSS changes.

```js
// site/proof.mjs — local-only visual fixtures, no runtime dependency.
import * as pages from './pages.js';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function fixturePages() {
  const common = { user: 'reviewer', owner: 'demo', repo: 'Thermal_Camera' };
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const item = { id: 123, branch: 'move-R16', base: a.slice(0, 7), head: b.slice(0, 7), result: 'pass', createdAt: '2026-10-14T10:00:00Z', date: '2026-10-14', pdf: true };
  const review = pages.reviewPage({ ...common, id: 123, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflowRunId: 99, pull: 7, share: true, pdf: true });
  const run = { ...common, base: a, head: b, startedAt: '2026-10-14T10:00:00Z', githubUrl: 'https://github.com/demo/Thermal_Camera/actions/runs/99' };
  return {
    signin: pages.signedOutPage(),
    'signin-ended': pages.signedOutPage({ sessionEnded: true }),
    repositories: pages.homePage({ user: common.user, repositories: [{ owner: { login: 'demo' }, name: 'Thermal_Camera', private: true, default_branch: 'main', pushed_at: '2026-10-14T10:00:00Z' }] }),
    'repositories-empty': pages.homePage({ user: common.user, repositories: [] }),
    reviews: pages.reviewsPage({ ...common, items: [item, { ...item, id: 124, result: 'fail', legacy: true }], counts: { all: 2, passing: 1, failing: 1 } }),
    'reviews-empty': pages.reviewsPage({ ...common, items: [], started: true }),
    milestones: pages.reviewsPage({ ...common, items: [item], view: 'milestones', groups: [{ title: 'Prototype', open: 2, merged: 1, items: [item], url: 'https://github.com/demo/Thermal_Camera/milestone/1' }] }),
    'milestones-permission': pages.reviewsPage({ ...common, items: [], view: 'milestones', groups: null }),
    compare: pages.commitsPage({ ...common, branch: 'main', branches: ['main'], tags: [], base: a, head: b, commits: [{ sha: b, message: 'Move R16', author: 'Ada', date: 'today' }, { sha: a, message: 'Initial board', author: 'Ada', date: 'yesterday' }] }),
    'compare-identical': pages.commitsPage({ ...common, branch: 'main', branches: ['main'], commits: [{ sha: a, message: 'Initial board', author: 'Ada', date: 'today' }], base: a, head: a }),
    progress: pages.runPage({ ...run, running: true, status: 'in_progress', jobs: [{ steps: [{ name: 'Check out files', status: 'completed', conclusion: 'success' }, { name: 'Render board', status: 'in_progress' }] }] }),
    'run-failed': pages.runPage({ ...run, state: 'failed', failedStage: 'Rendering and checking', failedStep: 'Render board' }),
    'run-expired': pages.runPage({ ...run, state: 'expired' }),
    'run-nothing': pages.runPage({ ...run, state: 'nothing' }),
    wrapper: review,
    readiness: review,
    'thread-composer': review,
    'thread-view': review,
    history: pages.historyPage({ ...common, pull: 7, title: 'Move R16', filter: 'all', events: ['commit', 'thread', 'review', 'checks'].map(kind => ({ kind, text: `${kind} on R16`, who: 'Ada', time: '2026-10-14T10:00:00Z', href: '/r/demo/Thermal_Camera/a/123' })) }),
    share: review,
    shared: pages.sharedPage({ token: 'body.signature', name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' }),
    'shared-invalid': pages.sharedNotFoundPage ? pages.sharedNotFoundPage() : pages.messagePage({ title: 'Not found', message: 'This shared review is unavailable.' }),
    error: pages.messagePage({ title: 'Could not load reviews', message: 'Try again later.', details: ['Request ID: local-proof'], links: [{ href: '/', label: 'Retry' }, { href: '/', label: 'Back to reviews' }], code: 502 }),
  };
}

async function main() {
  if (!process.env.PROOF_DIR || !process.env.REPORT) throw new Error('Set PROOF_DIR and REPORT to session-scratchpad paths.');
  const out = resolve(process.env.PROOF_DIR); mkdirSync(out, { recursive: true });
  const report = readFileSync(resolve(process.env.REPORT), 'utf8');
  if (!report.includes('Thermal_Camera')) throw new Error('Proof requires Thermal_Camera report.');
  const fixtures = fixturePages();
  const filter = process.argv[2] || '';
  const names = Object.keys(fixtures).filter(name => name.includes(filter));
  if (!names.length) throw new Error('No fixture matches.');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname.endsWith('/raw')) { res.setHeader('Content-Type', 'text/html'); res.end(report); return; }
    if (url.pathname.endsWith('/readiness')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ head: 'b'.repeat(40), decisions: [{ login: 'Ada', state: 'APPROVED', stale: false }], requested: [], blocking: 0, open: 1 })); return; }
    if (url.pathname.endsWith('/threads') || url.pathname.endsWith('/issues')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ threads: [], issues: [] })); return; }
    const name = url.pathname.slice(1); const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
    const html = fixtures[name];
    if (!html) { res.writeHead(404); res.end('Unknown fixture'); return; }
    const setup = `<script>try{localStorage.setItem('kr.theme',${JSON.stringify(theme)})}catch(e){}document.documentElement.dataset.theme=${JSON.stringify(theme)};</script>`;
    const end = `<script>document.querySelectorAll('meta[http-equiv=refresh]').forEach(n=>n.remove());const n=${JSON.stringify(name)};if(n==='thread-composer')document.getElementById(n).showModal();if(n==='thread-view'){document.querySelector('#thread-view h2').textContent='Comment on R16';const li=document.createElement('li');li.textContent='Ada · Verify placement before fabrication.';document.querySelector('#thread-view ol').append(li);document.getElementById(n).showModal()}if(n==='share')document.getElementById('share-dialog').showModal();</script>`;
    res.setHeader('Content-Type', 'text/html'); res.end(html.replace('<head>', '<head>' + setup).replace('</body>', end + '</body>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try {
    for (const name of names) for (const theme of ['dark', 'light']) {
      const profile = mkdtempSync(join(out, 'profile-'));
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1600,1000', '--force-device-scale-factor=1', '--hide-scrollbars', '--virtual-time-budget=3500', `--screenshot=${join(out, `${name}-${theme}.png`)}`, `${origin}/${name}?theme=${theme}`], { stdio: 'ignore' });
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Chrome timed out: ${name}`)); }, 30000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Chrome exited ${code}: ${name}`)); });
        });
        console.log(join(out, `${name}-${theme}.png`));
      } finally { rmSync(profile, { recursive: true, force: true }); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
```

`shared-invalid` uses the existing generic renderer only for the before baseline; Task 7 supplies the designed renderer. Screenshot fixtures do not fake readiness or report success: they load the real serialized client against deterministic local API responses. Dialog specimen bodies test layout only; mutation correctness remains in executable `site/test.mjs` and browser Task 9.

- [ ] **Step 5: Run green test and both-theme proof.** Run targeted test again; expected PASS. Run full site suite; only the explicitly tracked fixed HTML digest may fail until Task 9. With `PROOF_DIR="$SESSION_SCRATCHPAD/site-before" REPORT="$THERMAL_REPORT" node --import ./site/css-loader.mjs site/proof.mjs` capture the baseline before visual edits, then use `site-task-1` after edits. `SESSION_SCRATCHPAD` and `THERMAL_REPORT` are owner/session-provided absolute paths; fail if either is unset. Expected 46 PNGs per capture, no empty report frame and both themes genuinely different. Inspect screenshots, not just file existence. Check computed 32px header, 24px buttons and visible focus in Chrome.

- [ ] **Step 6: Commit owned changes.** `git add site/pages.js site/site.css site/proof.mjs site/test.mjs && git commit -m "feat(site): add compact screen primitives and visual fixtures"`. Do not add scratch screenshots. Return baseline directory and both-theme shell evidence to integration owner.

### Task 2: Sign-in and repository table

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:signedOutPage,homePage`; Modify owned selectors in `site/site.css`; Test `site/test.mjs`.

**Interfaces:** Consumes `frame`, `siteTable`, existing `{user,repositories}` data. Produces identical login, logout, repository and compare URLs; no new API calls. Repository rows expose only name, visibility, default branch and last activity.

- [ ] **Step 1: Add red tests.**

```js
test('S2 repositories use a compact safe table and explicit empty state', () => {
  const html = homePage({ user: 'u', repositories: [{ owner: { login: 'o' }, name: '<r>', private: true, default_branch: 'main', pushed_at: 'invalid' }] });
  assert.match(html, /aria-label="Repositories"/);
  assert.match(html, /&lt;r&gt;/);
  assert.match(html, /\/r\/o\/%3Cr%3E\/commits/);
  assert.match(html, /unknown time/);
  assert.match(html, /<code>main<\/code>/);
  assert.doesNotMatch(html, /<h2><r>/);
  assert.match(homePage({ user: 'u', repositories: [] }), /No repositories granted/);
  assert.match(signedOutPage({ sessionEnded: true }), /role="status"/);
});
```

- [ ] **Step 2: Run red.** `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 repositories' site/test.mjs`. Expected FAIL on absent table.

- [ ] **Step 3: Replace repository cards, refine existing sign-in markup.** Replace `homePage` with:

```js
export function homePage({ user, repositories }) {
  const rows = repositories.map(repo => {
    const path = repoPath(repo.owner.login, repo.name);
    return `<tr><td>${link(path, `${repo.owner.login}/${repo.name}`)}</td><td><span class="badge">${repo.private ? 'private' : 'public'}</span></td><td><code>${e(repo.default_branch || 'not recorded')}</code></td><td class="mono" title="${e(repo.pushed_at)}">${e(relativeTime(repo.pushed_at))}</td><td>${link(`${path}/commits`, 'Compare commits')}</td></tr>`;
  }).join('');
  const empty = `<section class="card repository-empty"><h2>No repositories granted</h2><p>No repositories yet. An owner or admin installs the KiCad review GitHub App on the repositories you can open.</p><p class="muted">Signed in as ${e(user)}</p></section>`;
  return frame({ title: 'Repositories', user, crumbs: [{ label: 'Repositories' }], body: `<main class="page page-wide"><div class="page-head"><div><h1>Repositories</h1><p class="lead">Repositories you can open. Each one needs the KiCad review GitHub App installed.</p></div></div>${rows ? siteTable(['Repository', 'Visibility', 'Default branch', 'Updated', 'Compare'], rows, 'Repositories') : empty}</main>` });
}
```

In `signedOutPage`, retain the exact GitHub permission disclosure and `/login` link. Change the session-ended paragraph to `<p class="notice notice-info" role="status">You were signed out. Sign in again to continue.</p>`. Add `class="signed-out-intro"` to its existing explanatory paragraph. Do not introduce a fake GitHub App install URL: this page has no installation URL in its input. Do not add a filter until there is an actual filtering requirement; all existing repositories remain reachable.

```css
.signed-out-page { min-height: calc(100dvh - var(--toolbar-h)); display: grid; place-items: start center; padding-top: clamp(32px, 15vh, 160px); }
.signed-out-card { width: 360px; max-width: 100%; }
.signed-out-card h1 { font-size: var(--fs-2xl); }
.signed-out-card .btn-primary { min-height: var(--h-lg); width: 100%; text-align: center; }
.signed-out-card p { margin: var(--sp-3) 0; }
.signed-out-permissions { color: var(--muted); font-size: var(--fs-sm); }
.signed-out-permissions ul { padding-left: var(--sp-4); }
.repository-empty { max-width: 480px; margin: var(--sp-6) auto; text-align: center; }
.badge { display: inline-flex; min-height: var(--badge-h); align-items: center; padding: 0 var(--sp-1); font: var(--fs-xs) var(--font-mono); border: 1px solid var(--line-strong); border-radius: var(--r-1); }
```

- [ ] **Step 4: Verify and capture.** Run new test (PASS) and full site suite (no new failures beyond tracked digest). Run fixture CLI with filters `signin` and `repositories`, writing to `$SESSION_SCRATCHPAD/site-task-2`; inspect all eight images. At 900px and 1600px, long owner/repo text must scroll within the table, not widen body. Keyboard Tab reaches repository/compare links and login, with visible focus. Compare both themes with the Stage 1 before images.

- [ ] **Step 5: Commit.** `git add site/pages.js site/site.css site/test.mjs && git commit -m "feat(site): redesign sign-in and repositories"`.

### Task 3: Reviews, milestones and PR history

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:historyPage,reviewsPage,status`; Modify scoped CSS in `site/site.css`; Test `site/test.mjs`.

**Interfaces:** Consumes existing filters `all|passing|failing|older`, `view=milestones`, history kinds and `milestoneGroups` output. Produces compact tables and timeline; all `?filter=`, `?view=`, `?f=` URLs, manual comparisons, legacy/PDF links and safe milestone/history link validation remain unchanged. Does not replace current status filters with unsupported Open/Merged/Closed filters.

- [ ] **Step 1: Add red tests.**

```js
test('S2 review tables retain manual legacy and milestone semantics', () => {
  const item = { id: 9, branch: '<branch>', manual: true, legacy: true, result: 'new', createdAt: 'bad', date: 'today', pdf: true };
  const html = reviewsPage({ user: 'u', owner: 'o', repo: 'r', items: [item], counts: {}, view: 'milestones', groups: [{ title: '<M>', url: 'javascript:bad', open: 0, merged: 0, items: [item] }] });
  assert.match(html, /aria-label="Reviews"/);
  assert.match(html, /Manual comparison/);
  assert.match(html, /Revisions not recorded \(older report\)/);
  assert.match(html, /\/a\/9\?pdf=1/);
  assert.match(html, /&lt;M&gt;/);
  assert.match(html, /0\/0/);
  assert.doesNotMatch(html, /javascript:bad/);
});
test('S2 timeline identifies event types without colour', () => {
  for (const kind of ['commit', 'thread', 'review', 'checks']) {
    const html = historyPage({ owner: 'o', repo: 'r', pull: 7, title: 'R16', filter: 'all', events: [{ kind, text: '<event>', who: 'Ada', time: '2026-10-14T10:00:00Z' }] });
    assert.match(html, new RegExp(`data-kind="${kind}"`));
    assert.match(html, /&lt;event&gt;/);
  }
});
```

- [ ] **Step 2: Run red.** `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 review tables|S2 timeline' site/test.mjs`. Expected FAIL on absent table/event marker.

- [ ] **Step 3: Replace the local review card renderer and containers.** Keep `reviewsPage`'s input signature, chip construction, started/permission/empty copy and safe milestone URL test. Replace local `card` with this row renderer; replace both `.review-list` section constructions with `table(items.map(card).join(''))` / `table(group.items.map(card).join(''))`. Use the existing empty section when items are empty, including its Compare commits link. `status` delegates to `siteBadge`.

```js
const table = rows => siteTable(['Review', 'Revisions', 'Result', 'Updated', 'Open'], rows, 'Reviews');
const card = item => {
  const branch = item.manual ? 'Manual comparison' : item.branch;
  const revision = item.legacy ? 'Revisions not recorded (older report)' : `${item.base} → ${item.head}`;
  const pr = item.pull ? `<span class="muted">PR #${e(item.pull.number)} (${e(item.pull.merged ? 'merged' : item.pull.state)})</span>` : '';
  return `<tr class="review-card"><td class="review-list-title">${e(branch)} ${item.label ? `<span class="muted">${e(item.label)}</span>` : ''} ${pr}</td><td class="mono">${e(revision)}</td><td>${status(item.result)}</td><td class="mono" title="${e(item.createdAt)}">${e(relativeTime(item.createdAt))} · ${e(item.date)}</td><td>${link(`${path}/a/${encodeURIComponent(item.id)}${item.pdf ? '?pdf=1' : ''}`, 'Open review →')}</td></tr>`;
};
// Replace the existing top-level status(value) function with:
function status(value) { return siteBadge(value); }
```

For each milestone section, preserve its heading link and add the ratio below. Do not change `milestoneGroups` to make nicer-looking numbers. The ratio is explicitly labelled merged/open-or-merged, not “all closed”:

```js
const total = group.open + group.merged;
const progress = `<p class="milestone-progress"><progress max="${Math.max(1, total)}" value="${group.merged}" aria-label="Merged pull requests"></progress><span class="mono">${group.merged}/${total}</span><span class="muted">merged of open or merged · ${e(group.open)} open · ${e(group.merged)} merged</span></p>`;
```

In `historyPage` retain `shown`, safe href logic and exact filter links/classes/attribute order; change only each `<li class="hist">` opening to `<li class="hist" data-kind="${e(ev.kind)}">`. Put `<span class="history-node" aria-hidden="true"></span>` before its existing `<time>`; event words remain visible. Add `page-wide` to reviews main only.

```css
.review-list-title { min-width: 180px; max-width: 36ch; overflow-wrap: anywhere; }
.milestone-progress { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
.milestone-progress progress { width: 80px; height: 6px; accent-color: var(--added); }
.history { margin: var(--sp-3) 0; padding: 0; list-style: none; }
.hist { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); min-height: var(--h-md); padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-5); border-left: 1px solid var(--line); overflow-wrap: anywhere; }
.hist:hover { background: var(--row-hover); }
.history-node { position: absolute; left: -6px; top: 8px; width: 12px; height: 12px; background: var(--surface-2); border: 1px solid var(--line-strong); }
.hist[data-kind=thread] .history-node { border-radius: 50%; }
.hist[data-kind=review] .history-node { transform: rotate(45deg); }
.hist-kind { min-width: 6em; font-weight: var(--fw-medium); text-transform: capitalize; }
.hist time { color: var(--muted); font-size: var(--fs-sm); }
```

- [ ] **Step 4: Verify and capture.** New tests PASS; retain all existing milestone escaping/deduplication/permission and history route tests. Fixture CLI filters `reviews`, `milestones`, `history`; capture both themes under `site-task-3`. Inspect zero-total ratio, permission notice, no-milestone group (add a second group in a local browser specimen), legacy/manual rows, selected chips and timeline shapes. Existing history filter links remain links, not inaccessible pseudo-tabs.

- [ ] **Step 5: Commit.** `git add site/pages.js site/site.css site/test.mjs && git commit -m "feat(site): redesign review lists milestones and history"`.

### Task 4: Compare commits and run progress/outcomes

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:commitsPage,runPage`; Modify owned CSS in `site/site.css`; Test `site/test.mjs`.

**Interfaces:** Consumes existing branch/tag/commit data and workflow stage mapping. Produces the same POST `/compare`, GET source-picker, radio names/order, slot/status targets, refresh behaviour and recovery actions. No dispatch or elapsed-time algorithms change.

- [ ] **Step 1: Add failing tests.**

```js
test('S2 compare carries non-colour A B labels and safe source metadata', () => {
  const html = commitsPage({ owner: 'o', repo: 'r', branch: '<main>', branches: ['<main>'], commits: [{ sha: 'a'.repeat(40), message: '<script>', author: '<Ada>', date: 'today' }] });
  assert.match(html, /Base <span class="compare-letter" aria-hidden="true">A<\/span>/);
  assert.match(html, /Head <span class="compare-letter" aria-hidden="true">B<\/span>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;Ada&gt;/);
  assert.match(html, /aria-label="Commit revisions"/);
});
test('S2 progress announces current state and keeps recoverable outcomes', () => {
  const args = { owner: 'o', repo: 'r', base: 'a'.repeat(40), head: 'b'.repeat(40) };
  assert.match(runPage({ ...args, status: 'queued', running: true }), /aria-label="Review stages"/);
  for (const state of ['failed', 'expired', 'nothing']) {
    const html = runPage({ ...args, state });
    assert.match(html, /Back to reviews/);
    assert.doesNotMatch(html, /http-equiv="refresh"/);
  }
});
```

- [ ] **Step 2: Run red.** `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 compare|S2 progress' site/test.mjs`. Expected FAIL on A/B label and stages name.

- [ ] **Step 3: Restyle without breaking the compare client's positional contract.** Preserve commit row children order: base radio, head radio, SHA, message, author, date, reviewed link. Do not add leading row cells; the inline client reads `children[3..5]`. Keep `Start review`, `Show`, `.compare-slot` and their existing script selectors, older-head warning and Swap behaviour. Make these exact markup changes in `commitsPage`:

```html
<th>Base <span class="compare-letter" aria-hidden="true">A</span></th>
<th>Head <span class="compare-letter" aria-hidden="true">B</span></th>
```

Add `aria-label="Commit revisions"` to the existing table. Add a `.table-scroll` div around that table, inside `.compare-form`. Move the existing `.compare-bar` interpolation to after that table wrapper but still inside `.compare-form`; this is the sticky bottom selection/action footer, not a duplicated form. Existing script finds the same `.compare-bar` anywhere in the document. Keep initial submit enabled in SSR because existing tests pin that behaviour; client `update()` disables immediately until two distinct choices are selected, while server POST validation stays authoritative without JS.

Keep the existing stage `<li class="done|active|todo|failed">` structure and exact glyph/word text, which multiple workflow tests parse. Add `aria-label="Review stages"` to `<ul class="steps">`; add `role="status" aria-live="polite"` to the existing elapsed-time paragraph, not the whole changing document. Do not invent log excerpts that the Worker does not fetch. On failed pages retain escaped stage and step plus existing retry/GitHub links. A static elapsed snapshot is honest because the server refreshes only while running.

```css
.compare-form .table-scroll { max-height: 60dvh; }
.compare-form .table td { height: var(--h-md); }
.compare-letter { display: inline-grid; place-items: center; width: var(--h-xs); height: var(--h-xs); margin-left: var(--sp-1); font-family: var(--font-mono); border: 1px solid var(--line-strong); border-radius: var(--r-1); }
.compare-bar { position: sticky; bottom: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin-top: var(--sp-3); margin-bottom: var(--sp-3); padding: var(--sp-2); background: var(--surface-2); border: 1px solid var(--line); }
.compare-slot { min-height: calc(3 * 1.4em); min-width: 180px; flex: 1; overflow-wrap: anywhere; }
.compare-slot strong, .compare-slot small { display: block; }
.compare-action { margin-left: auto; min-width: 220px; }
.compare-action [role=status] { margin-top: var(--sp-1); }
.source-picker { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.steps { display: grid; gap: 0; list-style: none; margin: 0; padding: 0; }
.steps li { display: flex; flex-wrap: wrap; align-items: center; min-height: var(--h-md); gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--line); }
.steps .done { color: var(--added); }
.steps .active { background: var(--surface-sel); border-left: 2px solid var(--accent); font-weight: var(--fw-semibold); }
.steps .failed { color: var(--removed); }
.steps .todo, .steps .step-state { color: var(--muted); }
.steps .step-state { font: var(--fs-xs) var(--font-mono); }
.changed-files { overflow-wrap: anywhere; }
```

- [ ] **Step 4: Verify and capture.** New tests PASS, all compare VM tests and workflow-stage mapping tests retained and PASS. Run filters `compare`, `progress`, `run-` in `site/proof.mjs`, both themes under `site-task-4`. In browser choose identical SHAs (disabled + explanation), choose older head (Swap restores direction), change source branch/tag and follow Reviewed link. Confirm sticky footer does not hide final row at 900px width. Capture failed, nothing and expired states; no automatic refresh outside generating state.

- [ ] **Step 5: Commit.** `git add site/pages.js site/site.css site/test.mjs && git commit -m "feat(site): redesign comparison and run screens"`.

### Task 5: Full-viewport review wrapper and secure theme forwarding

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:reviewPage return,reportFrameScript`; Modify wrapper CSS in `site/site.css`; Test `site/test.mjs`.

**Interfaces:** Consumes Stage 1 report `{theme}` receiver, existing `kicadReviewReady`/`kicadReviewHash` events. Produces postMessage `{theme:'dark'|'light'}` on iframe load, valid readiness and root-theme mutation. Preserve loading timeout (20 seconds), raw-plus-hash assignment, `reportedHash` echo suppression and source-identity checks. No iframe DOM access.

- [ ] **Step 1: Add red tests.**

```js
test('S2 wrapper themes the opaque sandbox without changing raw routes', () => {
  const html = reviewPage({ user: 'u', owner: 'o', repo: 'r', id: 9, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' });
  assert.match(html, /new MutationObserver/);
  assert.match(html, /attributeFilter: \['data-theme'\]/);
  assert.match(html, /postMessage\(\{ theme \}, '\*'\)/);
  assert.match(html, /sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"/);
  assert.doesNotMatch(html, /allow-same-origin|contentDocument/);
  assert.match(html, /aria-label="Review navigation"/);
});
```

- [ ] **Step 2: Run red.** `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 wrapper' site/test.mjs`. Expected FAIL on missing observer.

- [ ] **Step 3: Keep the existing frame script body and add this theme bridge inside its IIFE after `iframe` is assigned.** Do not replace the existing `load` function or its exact hash/ready message handling; tests intentionally assert those behaviours. The stringified script can contain the following literal code without external names:

```js
const syncTheme = () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  iframe.contentWindow?.postMessage({ theme }, '*');
};
iframe.addEventListener('load', syncTheme);
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
addEventListener('message', event => {
  if (event.source === iframe.contentWindow && event.data?.kicadReviewReady === true) syncTheme();
});
```

`'*'` is necessary for an opaque sandbox origin; it is not permission to accept messages from arbitrary windows. Stage 1's report receiver must accept only `event.source === parent` and exactly dark/light. This observer does not read localStorage, so blocked storage cannot break wrapper boot. No same-origin privilege is added. Shared review uses this same helper automatically.

In `reviewPage` preserve the exact outer `<div class="review-bar">` and its closing `</div><div class="review-stage">` sequence: the existing serialized-thread-client test pins this boundary. Inside that div wrap all existing contents in `<nav class="wrapper-navigation" aria-label="Review navigation">` and matching `</nav>`. Retain every existing link, status, readiness section, notice and Share button, including PDF condition and run URL validation. Do not add tabs that hide live controls from keyboard users. History remains a real route link; readiness remains an inline dock section rather than a new route. Existing `.top` header is 32px and the wrapper navigation is a second compact strip.

```css
.review-page { height: calc(100dvh - var(--toolbar-h)); display: flex; flex-direction: column; min-width: 0; }
.review-bar { display: flex; flex-wrap: wrap; align-items: center; flex-shrink: 0; gap: var(--sp-2); min-height: var(--tab-h); padding: var(--sp-0) var(--sp-2); border-bottom: 1px solid var(--line); background: var(--panel-head-bg); font-size: var(--fs-sm); }
.wrapper-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); width: 100%; min-width: 0; }
.review-stage { position: relative; flex: 1; min-height: 0; }
.review-stage iframe { display: block; width: 100%; height: 100%; border: 0; }
.review-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); color: var(--muted); background: var(--surface); pointer-events: none; }
.review-loading[hidden] { display: none; }
```

- [ ] **Step 4: Verify and capture.** New test PASS; keep exact existing loading/hash tests and source-check tests PASS. Fixture filter `wrapper`, both themes under `site-task-5`. Task 9 must toggle after the report becomes ready and inspect iframe theme through DevTools execution context, not cross-origin DOM in production code. Deep-link with every existing key and compare hash before/after toggle; no frame reload and no lost camera or selection. At 1600×1000 report remains largest surface; at narrow widths navigation may wrap and iframe fills remaining space without document scroll.

- [ ] **Step 5: Commit.** `git add site/pages.js site/site.css site/test.mjs && git commit -m "feat(site): redesign review wrapper and forward themes"`.

### Task 6: Merge readiness and native thread composer/viewer dialogs

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:reviewPage readiness/threads declarations`; Modify `site/readiness-client.js`, `site/threads-client.js`; Modify scoped CSS in `site/site.css`; Test `site/test.mjs`.

**Interfaces:** Consumes unchanged readiness and thread configs/API payloads. Retains `#readiness`, `#thread-composer`, `#thread-view`, hidden issue title, severity radios, target text, textarea names, `[role=status]`, `[data-act=reply|resolve|issue|close]` and `kicad-review-threads-changed`. Produces labelled native dialogs and 28px readiness rows, not a new merge endpoint.

- [ ] **Step 1: Add red markup and readiness tests.** Existing client VM tests at the end of `site/test.mjs` already execute stale/unknown data and racing responses; keep them. Add:

```js
test('S2 thread dialogs have names labels and keyboard hint', () => {
  const html = reviewPage({ owner: 'o', repo: 'r', id: 9, pull: 7, name: 'kicad-review.html' });
  assert.match(html, /id="thread-composer" class="thread-dialog" aria-labelledby="thread-composer-title"/);
  assert.match(html, /id="thread-view" class="thread-dialog" aria-labelledby="thread-view-title"/);
  assert.match(html, /id="thread-composer-title"/);
  assert.match(html, /Ctrl\+Enter/);
  assert.match(html, /<label>Text<textarea name="text"/);
  assert.match(html, /data-act="issue" hidden/);
});
test('S2 readiness uses bordered states even when unknown', async () => {
  const panel = { children: [], replaceChildren(...items) { this.children = items; } };
  const node = () => ({ children: [], append(...items) { this.children.push(...items); } });
  await runInNewContext(`(${readinessClient.toString()})({readiness:'/ready',reviewHead:null})`, {
    document: { getElementById: () => panel, createElement: node, addEventListener() {} },
    fetch: async () => new Response(JSON.stringify({ head: 'b'.repeat(40), decisions: [], requested: [], blocking: null, open: null })),
  });
  assert.equal(panel.children[0].children[0].className, 'wait');
  assert.match(panel.children[0].children[0].textContent, /waiting.*freshness unknown/);
  assert.match(panel.children[0].children[2].textContent, /could not be read/);
});
```

- [ ] **Step 2: Run red.** `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 thread dialogs|S2 readiness' site/test.mjs`. Expected first test FAIL on accessible names; second is a regression guard that already passes.

- [ ] **Step 3: Change only owned template declarations and styles.** Add `aria-labelledby` to composer/view openings; add matching IDs to their existing `h2`s. Keep `h2` as the first heading so `.querySelector('h2')` continues working. Add `<p class="muted thread-shortcut">Ctrl+Enter to submit · Esc to close</p>` before each existing status paragraph. Keep Cancel/Close as `type=button`; do not move them before the primary button because current code uses the first button's disabled state and composer primary label. Use existing native `showModal()`/Esc trap; no replacement custom overlay.

Append the following inside `threadsClient` before the closing brace. It submits through existing listeners, so duplicate guards, draft retention and async errors remain authoritative. Respect multiline Shift+Enter and composition input.

```js
for (const dialog of [composer, view]) {
  dialog.querySelector('textarea').addEventListener('keydown', event => {
    if (event.isComposing || event.key !== 'Enter' || !event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    const form = dialog.querySelector('form');
    const button = dialog === composer ? form.querySelector('button:not([type=button])') : form.querySelector('[data-act=reply]');
    if (button && !button.disabled) form.requestSubmit(button);
  });
}
```

Extend existing thread VM fixture element stubs with `addEventListener`/`requestSubmit` on textarea/form where necessary, recording listeners rather than silently dropping them; do not remove existing mutation assertions. Add this executable keyboard/close regression to `site/test.mjs` (the existing file already imports `threadsClient`):

```js
test('S2 thread keyboard respects composition disabled state and native close', () => {
  const submits = [], events = {}, nodes = {};
  const element = () => ({ disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  function dialog() {
    const children = {};
    return { open: true, querySelector(s) {
      const node = children[s] ||= element();
      if (s === 'form') {
        node.querySelector = selector => children[selector] ||= element();
        node.requestSubmit = button => submits.push(button);
      }
      return node;
    }, close() { this.open = false; } };
  }
  const composer = dialog(), view = dialog();
  Object.assign(nodes, { 'review-report': { contentWindow: {} }, 'thread-composer': composer, 'thread-view': view, 'thread-notice': {} });
  runInNewContext(`(${threadsClient.toString()})({})`, {
    document: { getElementById: id => nodes[id] },
    addEventListener(type, fn) { events[type] = fn; },
    fetch() { assert.fail('keyboard or close must not fetch directly'); },
  });
  const key = view.querySelector('textarea').listeners.keydown;
  let prevented = 0;
  const event = { key: 'Enter', ctrlKey: true, preventDefault() { prevented++; } };
  key({ ...event, isComposing: true }); key({ ...event, shiftKey: true });
  assert.equal(submits.length, 0);
  key(event);
  assert.equal(submits.length, 1);
  assert.equal(submits[0], view.querySelector('form').querySelector('[data-act=reply]'));
  submits[0].disabled = true; key(event); assert.equal(submits.length, 1);
  composer.querySelector('[data-act=close]').listeners.click();
  view.querySelector('[data-act=close]').listeners.click();
  assert.equal(composer.open, false); assert.equal(view.open, false);
  assert.equal(prevented, 2);
});
```

Real browser checks in Task 9 cover native validation, successful/failed mutations and focus.

Keep `readinessClient` text construction and race generation unchanged; styling existing `.ok`, `.bad`, `.wait` is sufficient to preserve glyph + word + border. It must never relabel a stale approval as current. Do not add a summary “Ready to merge”: API lacks all GitHub merge requirements. Add an explanatory muted paragraph outside `#readiness` only if needed: `Readiness summary; merge on GitHub after checking repository rules.` The existing GitHub run/history links stay usable.

```css
.readiness { flex-basis: 100%; max-height: 124px; overflow: auto; border-top: 1px solid var(--line); }
.readiness p { margin: var(--sp-1) 0; }
.readiness ul { display: grid; gap: 0; list-style: none; margin: 0; padding: 0; }
.readiness li { display: flex; align-items: center; min-height: var(--h-md); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--line); overflow-wrap: anywhere; }
.readiness .ok { color: var(--added); background: var(--added-bg); }
.readiness .bad { color: var(--removed); background: var(--removed-bg); border-color: var(--removed); }
.readiness .wait { color: var(--muted); border-style: dotted; }
.thread-dialog { width: var(--dialog-w); }
.thread-dialog label { display: block; font-size: var(--fs-sm); }
.thread-dialog textarea { display: block; width: 100%; margin-top: var(--sp-1); }
#thread-composer textarea { min-height: 96px; }
.thread-dialog fieldset { border: 0; padding: 0; margin: var(--sp-3) 0; }
.thread-dialog fieldset label { display: inline-block; }
.thread-target { overflow-wrap: anywhere; color: var(--muted); }
.thread-comments { max-height: 40dvh; overflow: auto; padding-left: var(--sp-4); }
.thread-comments p { white-space: pre-wrap; overflow-wrap: anywhere; margin: var(--sp-1) 0 var(--sp-3); }
.thread-dialog [role=status] { min-height: 1.4em; overflow-wrap: anywhere; }
.thread-shortcut { font-size: var(--fs-xs); }
.dialog-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: flex-end; margin-bottom: 0; }
```

- [ ] **Step 4: Verify client safety with concrete inputs.** Run targeted tests, all `readiness`/`thread client`/`thread changes` tests and full site suite. In existing executable thread-client fixture, add a comment body `<img src=x onerror=alert(1)>` and assert the created body node's `textContent` equals that literal; there is no `innerHTML` path. Reject a reply POST with `403` and assert textarea retains text, all buttons re-enable and status contains the server error. Keep existing disappeared-thread, tracked-issue, rerun-failure and non-PR no-thread-fetch checks. New keyboard handlers require real captured event listeners in VM doubles, not source-regex assertions alone.

- [ ] **Step 5: Capture both themes.** Fixture filters `readiness`, `thread-`, output `site-task-6`; inspect 480px dialogs, 96px composer, long anchor wrapping, reply list scrolling and all three readiness rows. Show stale/unknown readiness in local browser by changing fixture response in DevTools, without modifying production API or committing fixture secrets. Record native focus trap, Ctrl+Enter once, Shift+Enter newline, Esc no mutation, failed request retains draft.

- [ ] **Step 6: Commit.** `git add site/pages.js site/site.css site/readiness-client.js site/threads-client.js site/test.mjs && git commit -m "feat(site): redesign readiness and thread dialogs"`.

### Task 7: Share dialog, anonymous review and designed invalid-share 404

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:sharedPage,shareControls`; Add `sharedNotFoundPage` there; Modify `site/share.js:serveShare missing`; Modify `site/worker.js:pages import and serveShare deps`; Modify scoped CSS in `site/site.css`; Test `site/test.mjs`.

**Interfaces:** Consumes unchanged create/revoke JSON endpoints and HMAC access pipeline. Produces read-only shared review, Copy feedback and one neutral HTML 404 for anonymous missing links. Keeps `#share-form`, `#share-days`, `#share-result`, `#share-status`, `#share-open`, `#share-revoke`, form min/max/default, same-origin URL validation and repo-wide revoke confirmation. New `sharedNotFoundPage(): string` has no token or identity arguments.

- [ ] **Step 1: Add red markup and route tests.** Import `sharedPage`, `sharedNotFoundPage` in the existing test imports.

```js
test('S2 share presents read-only access and copy control', () => {
  const html = reviewPage({ owner: 'o', repo: 'r', id: 9, name: 'kicad-review.html', share: true });
  assert.match(html, /id="share-copy" type="button"/);
  assert.match(html, /Read-only access/);
  assert.match(html, /min="1" max="30" step="1" value="7"/);
  assert.match(sharedPage({ token: 'body.signature', name: 'kicad-review.html' }), /Read-only shared review/);
});
test('S2 invalid share page is neutral accessible HTML without identity', async () => {
  const html = sharedNotFoundPage();
  assert.match(html, /Shared review unavailable/);
  assert.match(html, /404/);
  assert.doesNotMatch(html, /Signed in as|class="account"|\/logout|\/login/);
  const restore = mockFetch(async () => { throw new Error('must not call upstream'); });
  try {
    const response = await worker.fetch(request('/s/not-a-capability'), env);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(await response.text(), html);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run red.** `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 share|S2 invalid share' site/test.mjs`. Expected FAIL on absent export/copy control and current plain-text 404.

- [ ] **Step 3: Implement neutral missing-page renderer and wire all missing outcomes to it.**

```js
export function sharedNotFoundPage() {
  return frame({ title: 'Shared review unavailable', navigation: false, body: `<main class="page shared-missing"><section class="card"><p class="mono muted">404</p><h1>Shared review unavailable</h1><p>This link is invalid or no longer available. Ask the person who shared it for a new link.</p><p class="muted">No review information is shown.</p></section></main>` });
}
```

Add `sharedNotFoundPage` to the existing pages import in worker.js and the object passed to `serveShare`. Replace only its `missing` closure in share.js:

```js
const missing = () => guestResponse(deps, deps.sharedNotFoundPage(), {
  status: 404,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-ancestors 'none'" },
});
```

Retain `guestResponse` for every failure. Do not reflect reason, token, repo or artifact name. Raw invalid responses use the same neutral body and deny embedding; valid raw responses retain `reportCsp`/SAMEORIGIN and navigation redirect rules. Malformed, disabled, bad-signature, expired, revoked, inaccessible, invalid artifact, failed download and thrown upstream paths must all use `missing()`. Never move verification after an upstream request. Add the helper to any direct `serveShare` dependency doubles used by tests.

In `sharedPage` retain `navigation:false`, no user/account, raw route, no-referrer iframe and `reportFrameScript`. Change its bar wrapper to `<nav class="review-bar shared-bar" aria-label="Shared review">` and matching close. Do not expose Threads/Share/Revoke or account navigation to anonymous users. The shared report's backend remains read-only.

In `shareControls` add `<p class="muted">Read-only access · Anyone with this link</p>`, `class="share-dialog"` to its dialog, `class="mono"` to read-only URL input and a sibling `<button class="btn" id="share-copy" type="button">Copy</button>`. Keep the `min="1" max="30" step="1" value="7"` attribute order. Add this handler inside the existing share IIFE after `result` assignment:

```js
const copy = document.getElementById('share-copy');
if (copy) copy.onclick = async () => {
  if (!result.value || copy.disabled) return;
  copy.disabled = true;
  try {
    await navigator.clipboard.writeText(result.value);
    status.textContent = 'Copied ✓';
    setTimeout(() => { if (status.textContent === 'Copied ✓') status.textContent = ''; }, 2000);
  } catch { status.textContent = 'Copy was blocked. Select and copy the read-only link.'; result.focus(); result.select(); }
  finally { copy.disabled = false; }
};
```

Add `let creating = false;` inside the IIFE and guard the beginning of the existing create submit handler immediately after `event.preventDefault()` with `if (creating) return; creating = true;`. Add `finally { creating = false; }` to its existing try/catch. Preserve result clearing, URL allow-list validation and error `textContent`. This prevents duplicate requests without a new dependency or changing API. Keep revoke confirmation unchanged. Do not add editable access/expiry date controls that the server cannot honour.

```css
.share-dialog label { display: block; margin-bottom: var(--sp-2); font-size: var(--fs-sm); }
.share-dialog #share-result { display: block; width: 100%; margin-top: var(--sp-1); }
.share-dialog #share-status { min-height: 1.4em; overflow-wrap: anywhere; }
.share-dialog #share-revoke { color: var(--removed); border-color: var(--removed); margin-bottom: var(--sp-3); }
.shared-bar { color: var(--muted); }
.shared-missing { max-width: 480px; padding-top: clamp(32px, 15vh, 160px); }
.shared-missing h1 { font-size: var(--fs-2xl); }
```

- [ ] **Step 4: Extend executable share tests and retain all access tests.** In the existing share-dialog VM test's `elements` map add `share-copy`; provide `navigator:{clipboard:{writeText:async value=>copied.push(value)}}`, `setTimeout:fn=>{timers.push(fn)}`, and `result.focus`/`result.select` spies. After successful create, call copy handler and assert one exact URL, `Copied ✓`, enabled copy, then run captured timer and assert feedback clears. Re-run with clipboard throwing and assert manual-copy message and selection spies. This is an actual handler exercise, not `toString()` inspection. Keep existing unsafe URL, POST origin/JSON, expiry, artifact binding, token, revocation, cookie and no-privileged-call tests. Extend each existing invalid guest route assertion with `content-type`, neutral `sharedNotFoundPage()` body and no account/token leak; do not delete old status/security checks. Add concurrent submit exercise with a deferred fetch: two handler calls before resolving yield one POST, rejection permits a third retry.

- [ ] **Step 5: Verify and capture.** Targeted/new tests PASS. Full site suite has no new failures beyond tracked digest. Fixture filters `share` (includes `shared`, `shared-invalid`) to `site-task-7`, both themes. Inspect Copy denied/success and revoke confirmation in a real browser. Compare invalid-signature and expired route screenshots: same visual body, real HTTP 404, no metadata. Theme toggle remains available anonymously; account controls do not.

- [ ] **Step 6: Commit.** `git add site/pages.js site/site.css site/share.js site/worker.js site/test.mjs && git commit -m "feat(site): redesign sharing and anonymous missing links"`.

### Task 8: Generic error/recovery page

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Modify `site/pages.js:messagePage`; Modify `site/worker.js:errorPage` only; Modify owned `.message-*` CSS; Test `site/test.mjs`.

**Interfaces:** Consumes current errorPage status/title/message/details/links and session flow. Extends `messagePage` with optional `code` (number) without changing existing arguments. Produces compact 480px recovery layout, readable HTTP status and collapsible escaped diagnostics. Existing caller-provided recovery destinations remain authoritative; never invent Retry for a non-retryable request.

- [ ] **Step 1: Add red test.**

```js
test('S2 message page shows status and safe collapsible diagnostics', () => {
  const html = messagePage({ title: '<bad>', message: '<script>', code: 502, details: ['Request ID: <id>'], links: [{ href: '/r/o/r', label: 'Back to reviews' }] });
  assert.match(html, /class="message-code mono muted">502/);
  assert.match(html, /<details class="message-diagnostics"><summary>Details<\/summary>/);
  assert.match(html, /Request ID: &lt;id&gt;/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="\/r\/o\/r"/);
  assert.doesNotMatch(messagePage({ title: 'Missing', message: 'No details' }), /message-diagnostics/);
});
```

- [ ] **Step 2: Run red.** `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 message page' site/test.mjs`. Expected FAIL on missing status/details.

- [ ] **Step 3: Preserve status-word/glyph/links, refine layout.** Add `code` to `messagePage` destructuring. Replace only `detailList` with:

```js
const detailList = details.length ? `<details class="message-diagnostics"><summary>Details</summary><ul class="message-details muted mono">${details.map(detail => `<li>${e(detail)}</li>`).join('')}</ul></details>` : '';
const codeLine = Number.isInteger(code) && code >= 400 && code <= 599 ? `<p class="message-code mono muted">${code}</p>` : '';
```

Interpolate `${codeLine}` immediately before existing `h1` in the returned card. Keep error/warn/info glyph + word, escaped details and the first-link primary class behaviour. In `worker.js:errorPage`, add `code: status` to the existing `messagePage` argument object; preserve HTTP response status, sessionResponse, headers, active login, includeHome and details construction. Do not turn API JSON errors into HTML. Do not expose stack traces, access tokens or arbitrary request headers. Existing details remain what the caller already intentionally provides; no random request-ID generator is added.

```css
.message-page { min-height: calc(100dvh - var(--toolbar-h)); padding-top: clamp(32px, 15vh, 160px); }
.message-card { width: 480px; max-width: 100%; margin: 0 auto; }
.message-card > p { margin: var(--sp-3) 0; }
.message-head { display: flex; align-items: start; gap: var(--sp-2); font-size: var(--fs-2xl); }
.message-symbol { display: inline-grid; place-items: center; width: var(--h-sm); height: var(--h-sm); border: 1px solid currentColor; border-radius: var(--r-1); font-size: var(--fs-sm); flex: none; }
.message-symbol-error { color: var(--removed); }
.message-symbol-warn { color: var(--modified); }
.message-symbol-info { color: var(--accent); }
.message-kind { display: block; margin-top: var(--sp-1); color: var(--muted); font-size: var(--fs-sm); font-weight: var(--fw-medium); }
.message-diagnostics { margin-top: var(--sp-3); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.message-details { padding-left: var(--sp-4); }
.message-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
```

- [ ] **Step 4: Verify and capture.** New test PASS; existing callback failure, message escaping, prioritized action, permissions/rate-limit and security tests retained. Fixture `error` both themes under `site-task-8`. In browser expand Details with keyboard, verify focus ring, long ID wrapping and 480px width. Verify status 400/403/404/429/500/502 on existing route fixtures remains actual HTTP status, not merely displayed text. Invalid shares remain Task 7's identity-free renderer, not this signed-in generic page.

- [ ] **Step 5: Commit.** `git add site/pages.js site/site.css site/worker.js site/test.mjs && git commit -m "feat(site): redesign error and recovery pages"`.

### Task 9: Integrated browser proof, regression gate and reviewed snapshot rebaseline

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling.

**Files:** Test `site/test.mjs`; Modify `site/proof.mjs` only for final evidence assertions/fixture corrections; inspect all site output and `ui/checks.mjs` without removing checks. No report renderer changes belong to this task.

**Interfaces:** Consumes reviewed patches from Tasks 1–8 and a locally generated Thermal_Camera report. Produces passing old/new site tests, both-theme before/after evidence for all site screen states and unchanged report behaviour. Private KiCad reference screenshots stay outside the repository.

- [ ] **Step 1: Add a final failing screen inventory test before integration.** Import `fixturePages` from `./proof.mjs` into site/test.mjs; importing must not start a server. Add:

```js
test('S2 complete screen inventory has labelled pages and no external UI assets', () => {
  const fixtures = fixturePages();
  assert.equal(Object.keys(fixtures).length, 23);
  for (const [name, html] of Object.entries(fixtures)) {
    assert.match(html, /<html lang="en"/, name);
    assert.match(html, /<title>[^<]+<\/title>/, name);
    assert.match(html, /data-theme-toggle/, name);
    assert.match(html, /<main\b/, name);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+rel="stylesheet"|fonts\.googleapis/, name);
  }
  assert.match(fixtures['shared-invalid'], /Shared review unavailable/);
  assert.match(fixtures.repositories, /aria-label="Repositories"/);
  assert.match(fixtures.reviews, /aria-label="Reviews"/);
});
```

Run `node --import ./site/css-loader.mjs --test --test-name-pattern='S2 complete screen' site/test.mjs` against the Task 1 base: expected FAIL on compact table/designed 404 before screen patches. With Tasks 2–8 applied, expected PASS. If the exact `<html>` opening gained Stage 1 attributes, retain semantic language assertion by matching `<html\b[^>]*\blang="en"`; never strip theme attributes to satisfy a test.

- [ ] **Step 2: Integrate only reviewed, owned hunks and run the complete suite.** Do not merge branches or push. Preserve all existing tests; narrowly adapt byte-oriented expectations only where deliberately changed markup warrants it. There should be no stale card selectors in screen CSS or duplicate `siteBadge` definitions. Run:

```bash
python3 test_kicad_review.py
node --import ./site/css-loader.mjs --test site/test.mjs
```

Expected Python PASS; site PASS apart from the one tracked old fixed digest until Step 5. Any other failure is a defect to fix in its owning task, not a tolerated baseline. Preserve exact stage `<li>` markup and compare cell positions to avoid gratuitous test rewrites.

- [ ] **Step 3: Capture every screen in both themes, compare against before.** Use a fresh scratch evidence directory:

```bash
: "${SESSION_SCRATCHPAD:?Set the active session scratchpad}"
: "${THERMAL_REPORT:?Set a generated Thermal_Camera HTML path}"
PROOF_DIR="$SESSION_SCRATCHPAD/site-after" REPORT="$THERMAL_REPORT" \
  node --import ./site/css-loader.mjs site/proof.mjs
CHECK_PORT=9397 node ui/check.mjs --page "$THERMAL_REPORT" \
  --shot "$SESSION_SCRATCHPAD/thermal-report-light.png"
CHECK_PORT=9398 node ui/check.mjs --dark --page "$THERMAL_REPORT" \
  --shot "$SESSION_SCRATCHPAD/thermal-report-dark.png"
```

Check ports are free before use; select another free port if occupied, never 9341/9344. Expected 46 after PNGs, every existing report check PASS or its existing documented fixture-data SKIP, no new SKIP used to conceal regression. Use the same report/camera/hash/viewport as the before images. Inspect before/after in both themes for all 23 fixtures. Compare Thermal_Camera wrapper/report to `pcb-01-default.png` and `sch-01-default.png` for density, hierarchy and calm neutral chrome, and to draft `mock-dark.png`/`mock-light.png` for token consistency; this stage does not claim renderer fidelity to stages 4–6. Never put Aux geometry into screenshots being committed. Evidence remains local scratchpad; return absolute paths.

- [ ] **Step 4: Execute browser interaction proof, not screenshots alone.** Open the local fixture server while paused under a debugger or use the owner's existing Wrangler session; no production mutation is required. Use DevTools and keyboard to perform each assertion below in dark and light, recording screenshots after state changes. These are explicit release gates, not optional exploratory notes:

  1. At 1600×1000 and 900×900, no page-wide overflow except deliberate table scroll; header 32px, normal controls/rows 24px, dialog 480px max 92vw; focus ring visible on login, repo links, filter chips and recovery links. Long 300-character commit/repository/milestone/comment text stays contained.
  2. Compare radios select Base/Head; same SHA disables Start review and explains why; older Head offers functional Swap; branch and tag Show submit only source-picker values. Keyboard Enter on a radio does not dispatch. Ordinary Reviewed link remains navigable.
  3. Progress has distinct pending/active/done/failed glyph+word states; reduced-motion emulation stops spinner; refresh only while generating; retry retains validated SHA values.
  4. Wrapper toggles theme without reload; iframe context `document.documentElement.dataset.theme` equals parent after ready and after each toggle. Use DevTools frame execution context, never production DOM access. Block localStorage and repeat: dark first paint, toggle usable, no exception. Set `#p=0&v=board&m=side&x=12&y=34&z=5&s=0&t=changes&l=F.Cu&c=R16&h=1`; toggle and verify same hash and selected camera state. A second iframe/window posting ready/hash/theme cannot change target wrapper.
  5. Readiness stale/unknown/error does not show green ready. Simulate two delayed API responses and confirm latest wins (also pinned by executable tests). Non-PR wrapper never fetches thread endpoint.
  6. Composer/viewer: Tab/Shift+Tab trapped by native dialog, first editable field reachable, Esc closes and returns focus, close/Cancel performs no POST. Ctrl+Enter sends once; IME composition and Shift+Enter do not submit. Rejected POST retains draft and re-enables controls; plain HTML-like comment renders literally; resolve/reopen and issue conversion still work through existing client tests.
  7. Share create respects 1–30 days, read-only copy succeeds/announces or offers manual selection on permission denial; revoke retains confirmation and repo-wide wording. Anonymous valid shared view has no account/Share/thread-write controls, no login requirement; invalid/revoked/expired views are visually identical HTTP 404s with no token/metadata in DOM.
  8. Error details expand using keyboard; caller's Retry/Back destination is preserved and status headers match body. No external UI asset request appears in Network; iframe/report assets remain single-file. Confirm dark and light text contrast against inherited token surfaces, selected chips include check glyph and badges retain words/borders under grayscale simulation.

If a browser assertion fails, write the smallest executable regression in `site/test.mjs` using the existing VM/client fixture pattern, fix the owning code and repeat both themes. No test removal, arbitrary delay increase or screenshot-only waiver.

- [ ] **Step 5: Rebaseline the intentionally changed fixed HTML digest once.** After visual and security review, compute the new literal digest:

```bash
node --import ./site/css-loader.mjs --input-type=module -e '
import {createHash} from "node:crypto";
import {reviewPage} from "./site/pages.js";
const html=reviewPage({user:"octocat",owner:"Cameronrlewis",repo:"repo",id:"123",name:"kicad-review-aaaaaaa-bbbbbbb-pass.html",share:false}).replace(/<style>[\s\S]*?<\/style>/,"<style>\n</style>");
console.log(createHash("sha256").update(html).digest("hex"));'
```

Replace only the old literal `82be67bc0030511bc6cca251252770b78a742053b98f7e08d74ba0e027824daa` in its existing test with the printed value and update its comment to describe the reviewed Stage 2 wrapper. Keep the missing-secrets loop's byte-equality assertion, guest 404 and create-share 404 assertions unchanged. Review actual normalized HTML diff before accepting the new digest. This is an explicit visual snapshot migration, not weakened behaviour coverage.

- [ ] **Step 6: Final green and commit.** Run `python3 test_kicad_review.py`, full site suite, both-theme report harness again: expected PASS, with no new skips or known failures. Run `git diff --check`; expected no whitespace errors. Commit only proof/test corrections with `git add site/test.mjs site/proof.mjs && git commit -m "test(site): prove every redesigned screen in both themes"`. Return task completion and absolute before/after screenshot paths to the owner; no push, merge, v1-tag move, private board upload or generated report commit.

## Completion criteria

All 15 requested screen families are covered: sign-in (Task 2), repositories (2), reviews/milestones (3), compare (4), progress/outcomes (4), iframe review wrapper (5), readiness (6), thread composer and viewer (6), PR history (3), share dialog (7), anonymous shared review (7), generic error (8), invalid-share designed 404 (7). All behaviour/routes and existing site tests remain, with only a reviewed literal HTML snapshot migration. Every UI task returns both-theme screenshots; stage ends with Thermal_Camera browser proof compared to KiCad references. Stage 3 report chrome and later renderer/appearance work remain untouched.
