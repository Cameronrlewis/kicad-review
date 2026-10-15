# Stage 1: Tokens and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish shared dark-default design tokens, a persisted accessible theme switch, licensed inline icons, and two shell fixes without changing the comparison renderer.

**Architecture:** Keep the existing HTML/CSS/vanilla-JS structure. Both Worker pages and Python-generated reports embed the same token, classic theme-script, and SVG-sprite files; no asset request is needed in a generated report. Add only the shell controls and fixes required for Stage 1; site screen reconstruction, Appearance, geometry, grid, and keyboard expansion belong to later stages.

**Tech Stack:** CSS custom properties, vanilla JavaScript, Python standard library, Cloudflare Worker Text imports, existing Chrome DevTools check harness and Node tests.

**Spec:** `docs/superpowers/specs/2026-10-14-ui-redesign-design.md`, Stage 1 and Design system / KiCad reuse decisions. Supporting references: `/Users/cameron/Code/kicad-review-ui-reference/draft/design-system.md`, `mockup.html`, and `render-eval.md`.


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
- No feature code before plan approval. Execute in `/Users/cameron/Code/kicad-review-worktrees/ui-redesign`, not the main checkout.
- Each UI-building task uses a **general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling** and returns screenshots in both themes. Inside the change viewer KiCad reference wins over skill suggestions.
- Every stage ends with browser proof: before/after screenshots in both themes on Thermal_Camera compared with the reference shots. Private reference screenshots remain outside git.
- 13 px UI type, system fonts only; mono coordinates/SHAs/refs; control heights 24 px, dock headers 28 px, toolbars 32 px.
- Changes to sandbox or CSP are not required and are not permitted by this stage.

## Review Focus

1. Blocked, corrupt, or throwing localStorage: first paint stays dark, controls still work, and invalid stored strings never become DOM attributes (Task 2).
2. Sandboxed opaque-origin report and shared wrapper: theme messages accept only the actual iframe/parent source; switching either control updates both without reload or message loops (Task 2).
3. Large tab counts / Parts and Threads simultaneously present at 1600 px: every tab label is readable and reachable by mouse and keyboard, with no document-wide horizontal scroll (Task 4).
4. Negative and fractional cursor positions, side-by-side panes, and non-drawing/3D views: X/Y are honest drawing-mm values or explicit unavailable values, never stale coordinates from another view (Task 4).
5. Fully disconnected generated report, including lazy 3D: local fragment SVG uses and theme assets resolve in-file, and theme changes recolour 3D without reparsing or moving the camera (Tasks 2, 3, 5).

---

## Scope and inspected seams

- `ui/tokens.css` is already imported by `site/pages.js` and inlined by `kicad_review.inline_page()` at `kicad_review.py:1909-1922`.
- `ui/review.html` has stable CSS/script tags used by exact replacements. Keep the adjacent token/review CSS links unchanged.
- `site/pages.js:30-35` owns `frame()` for all site pages, including signed-out, generic errors, and shared pages. `reportFrameScript()` owns wrapper/iframe loading; do not duplicate its hash handling.
- `site/csp.js` deliberately makes report origins opaque (`sandbox allow-scripts`, not allow-same-origin). Reading report localStorage can throw even though wrapper storage works. Do not weaken it.
- `ui/review.js:118` rebuilds `#hdr`, `:734` rebuilds the right dock, `:826` rebuilds zoom controls. Put the theme control outside `#hdr`'s replaced contents, and the coordinate bar outside `#zoombar` so the 3D camera bar cannot delete it.
- `ui/review3d.js:16,51` currently selects/polls theme via OS media. Stage 1 must change that seam to effective theme while keeping disposal and material/camera checks.
- Existing check `theme follows the system and keeps text contrast` and two 3D theme-switch checks encode the superseded OS-following behavior. Preserve their contrast/material/camera assertions, but drive explicit user theme rather than OS. Do not delete or skip them.
- Draft conflicts resolved in favor of binding spec: do **not** copy the draft's OS-light media block or `localStorage['theme']`; use dark default and `kr.theme`. Status bar includes absolute **X/Y**, not only dx/dy. Full grid/delta/unit controls wait for their renderer stages.

## File map

| File | Responsibility |
|---|---|
| `ui/tokens.css` | Primitive, semantic, component tokens and existing shared utility/component selectors |
| `ui/theme.js` (new) | Classic early bootstrap, delegated toggle, safe persistence, validated frame theme bridge |
| `ui/theme.test.mjs` (new) | Node VM tests for the shared classic theme script |
| `ui/icons/kicad/{light,dark}/*.svg` (new) | Six attributed source icons, three per theme |
| `ui/icons/build.py` (new) | Standard-library deterministic sprite assembly, no runtime build requirement |
| `ui/icons/sprite.svg` (new) | Inline symbol definitions, both icon palettes and one original theme icon |
| `ui/icons/LICENSE` (new) | Attribution, modification statement, complete CC-BY-SA 4.0 text |
| `NOTICE` (new) | KiCad colour-data provenance and icon license boundary |
| `ui/review.html`, `ui/review.css`, `ui/review.js` | Embed shared assets, theme button, tab overflow fix, X/Y status bar |
| `ui/review3d.js` | Effective-theme rendering and unavailable 3D X/Y |
| `kicad_review.py`, `test_kicad_review.py` | Inline and assert all new report assets |
| `site/pages.js`, `site/site.css` | Embed identical theme/sprite and theme control on every framed page |
| `site/wrangler.toml`, `site/css-loader.mjs` | Text-load exact shared classic script and sprite in Worker and Node |
| `site/test.mjs`, `ui/checks.mjs`, `ui/check.mjs` | Integration, computed-style, geometry, explicit-theme browser coverage |

### Task 1: Replace tokens without breaking existing consumers

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return report and signed-out-site screenshots in both themes.

**Files:**
- Modify: `ui/tokens.css:1-45`
- Test: `ui/checks.mjs` (prepend two checks)

**Interfaces:**
- Consumes: existing CSS names `--bg --surface --surface-2 --line --text --muted --accent --focus --added --removed --modified --space-1..4 --radius` and existing shared selectors.
- Produces: primitive → semantic → component token API below; `html[data-theme="light"|"dark"]` overrides OS; absent attribute is dark. Raw colour values live only in primitive declarations. Board/paper do not change with chrome theme.

- [ ] **Step 1: Add failing token/browser tests** at the beginning of `CHECKS`.

```js
["Stage 1 dark default ignores OS and tokens resolve", "", `
  const root = document.documentElement; root.removeAttribute('data-theme');
  const c = getComputedStyle(root), b = getComputedStyle(document.body);
  return c.colorScheme === 'dark' && b.backgroundColor === 'rgb(20, 23, 28)'
    && c.getPropertyValue('--btn-h').trim() === '24px'
    && c.getPropertyValue('--tab-h').trim() === '28px'
    && c.getPropertyValue('--toolbar-h').trim() === '32px'
    && c.getPropertyValue('--space-2').trim() === '8px';`],
["Stage 1 both token themes pass text contrast", "", `
  const root = document.documentElement, old = root.getAttribute('data-theme');
  const probe = document.createElement('span'); document.body.append(probe);
  const lum = s => { const rgb = s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => {v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;}); return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
  const ratio = (a,b) => (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  try {
    for (const theme of ['dark','light']) {
      root.dataset.theme = theme;
      for (const surface of ['bg','surface','surface-2','surface-3']) {
        probe.style.backgroundColor = 'var(--'+surface+')';
        for (const text of ['text','muted','accent','added','removed','modified','waived']) {
          probe.style.color = 'var(--'+text+')'; const s = getComputedStyle(probe);
          if (ratio(lum(s.color),lum(s.backgroundColor)) < 4.5) return theme+': '+text+' on '+surface;
        }
      }
      probe.style.backgroundColor = 'var(--accent-fill)'; probe.style.color = 'var(--on-accent)';
      let s = getComputedStyle(probe); if (ratio(lum(s.color),lum(s.backgroundColor)) < 4.5) return 'primary';
      probe.style.color = 'var(--line-strong)'; probe.style.backgroundColor = 'var(--surface)';
      s = getComputedStyle(probe); if (ratio(lum(s.color),lum(s.backgroundColor)) < 3) return 'control border';
    }
    return true;
  } finally { probe.remove(); if(old === null) root.removeAttribute('data-theme'); else root.dataset.theme=old; }`],
```

- [ ] **Step 2: Run failing tests.**

Run from the worktree: `CHECK_PORT=9357 node ui/check.mjs 'Stage 1'`
Expected: FAIL for dark default and the old light added/modified colours. Use positional filters: current harness does not implement `--name`.

- [ ] **Step 3: Replace `ui/tokens.css` with this token set and shared-selector tail.** The draft's 10 px size is retained as a primitive for later count pills, but body text and Stage 1 labels use at least 11 px.

```css
/* Primitive: all literal colour values are kept in this layer. */
:root {
  --n-0:#fff; --n-50:#f4f6f8; --n-100:#e9edf1; --n-150:#dde3ea; --n-200:#e4e8ed;
  --n-300:#c3cad3; --n-400:#7a8594; --n-500:#55606d; --n-900:#1c2128;
  --d-0:#14171c; --d-1:#1b1f26; --d-2:#232831; --d-3:#2c323c;
  --d-line:#343b46; --d-line-strong:#6b7585; --d-text:#d8dde4; --d-muted:#99a3b0;
  --blue-300:#5aa9ff; --blue-400:#79b8ff; --blue-500:#2f6fd0; --blue-600:#0b5cc4;
  --green-300:#4cc26a; --green-600:#146c2e; --red-300:#ff7b72; --red-600:#b3201f;
  --amber-300:#e3b341; --amber-600:#8a5a00; --violet-300:#b79cff; --violet-600:#6b3fc4;
  --board:#001023; --paper:#f5f4ef;
  --d-selected:#1f3a5f; --l-selected:#cfe2fb; --hud:#c8d0dc;
  --d-added:#12301c; --d-removed:#3a1b1a; --d-modified:#352a0c; --d-waived:#2a2140; --d-info:#1a2c47;
  --l-added:#dff3e4; --l-removed:#fbe1e0; --l-modified:#f8ecc8; --l-waived:#e9e1fa; --l-info:#dbe9fb;
  --d-scrim:rgb(0 0 0 / .55); --l-scrim:rgb(20 28 40 / .35);
  --d-shadow:0 6px 18px rgb(0 0 0 / .5); --l-shadow:0 6px 18px rgb(20 28 40 / .22);
  --font-ui:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --fs-2xs:10px; --fs-xs:11px; --fs-sm:12px; --fs-md:13px; --fs-lg:15px; --fs-xl:18px; --fs-2xl:22px;
  --lh-tight:1.2; --lh-base:1.4; --fw-regular:400; --fw-medium:500; --fw-semibold:600;
  --sp-0:2px; --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px;
  --h-xs:20px; --h-sm:24px; --h-md:28px; --h-lg:32px;
  --r-0:0; --r-1:2px; --r-2:3px; --r-3:6px; --r-pill:999px; --bw:1px;
  --dur-fast:80ms; --dur:140ms; --ease:cubic-bezier(.2,0,0,1);
  --z-dock:1; --z-popover:20; --z-dialog:30; --z-toast:40;
}
/* Semantic: no OS media rule. Unset/invalid theme remains dark. */
:root, :root[data-theme="dark"] {
  color-scheme:dark;
  --bg:var(--d-0); --surface:var(--d-1); --surface-2:var(--d-2); --surface-3:var(--d-3);
  --surface-sel:var(--d-selected); --line:var(--d-line); --line-strong:var(--d-line-strong);
  --text:var(--d-text); --muted:var(--d-muted); --accent:var(--blue-300);
  --accent-fill:var(--blue-500); --on-accent:var(--n-0); --focus:var(--blue-400);
  --added:var(--green-300); --removed:var(--red-300); --modified:var(--amber-300); --waived:var(--violet-300);
  --added-bg:var(--d-added); --removed-bg:var(--d-removed); --modified-bg:var(--d-modified); --waived-bg:var(--d-waived); --info-bg:var(--d-info);
  --scrim:var(--d-scrim); --shadow-pop:var(--d-shadow),0 0 0 1px var(--line);
  --canvas:var(--board); --canvas-chrome:var(--hud);
}
:root[data-theme="light"] {
  color-scheme:light;
  --bg:var(--n-200); --surface:var(--n-50); --surface-2:var(--n-100); --surface-3:var(--n-150);
  --surface-sel:var(--l-selected); --line:var(--n-300); --line-strong:var(--n-400);
  --text:var(--n-900); --muted:var(--n-500); --accent:var(--blue-600);
  --accent-fill:var(--blue-600); --on-accent:var(--n-0); --focus:var(--blue-600);
  --added:var(--green-600); --removed:var(--red-600); --modified:var(--amber-600); --waived:var(--violet-600);
  --added-bg:var(--l-added); --removed-bg:var(--l-removed); --modified-bg:var(--l-modified); --waived-bg:var(--l-waived); --info-bg:var(--l-info);
  --scrim:var(--l-scrim); --shadow-pop:var(--l-shadow),0 0 0 1px var(--line);
}
/* Component API plus migration aliases. */
:root {
  --space-1:var(--sp-1); --space-2:var(--sp-2); --space-3:var(--sp-3); --space-4:var(--sp-4); --radius:var(--r-3);
  --toolbar-h:var(--h-lg); --toolbar-bg:var(--surface-2);
  --btn-h:var(--h-sm); --btn-bg:var(--surface-2); --btn-bg-hover:var(--surface-3); --btn-border:var(--line-strong);
  --btn-primary-bg:var(--accent-fill); --btn-primary-fg:var(--on-accent);
  --icon-btn-size:var(--h-sm); --icon-size:16px;
  --seg-h:var(--h-sm); --seg-on-bg:var(--surface-sel); --seg-on-fg:var(--text);
  --tab-h:var(--h-md); --tab-underline:var(--accent);
  --panel-head-h:var(--h-md); --panel-head-bg:var(--surface-2); --panel-bg:var(--surface);
  --row-h:var(--h-sm); --row-hover:var(--surface-3); --row-sel:var(--surface-sel);
  --th-h:var(--h-sm); --td-pad-x:var(--sp-2); --chip-h:var(--h-xs); --badge-h:var(--h-xs);
  --statusbar-h:var(--h-sm); --statusbar-bg:var(--surface-2);
  --input-h:var(--h-sm); --input-bg:var(--bg); --input-border:var(--line-strong);
  --dialog-bg:var(--surface); --dialog-w:480px; --splitter:4px;
}
@media (prefers-reduced-motion:reduce) { * { transition:none!important; animation:none!important; } }
:focus-visible { outline:2px solid var(--focus); outline-offset:-2px; }
.btn, .btn-primary { box-sizing:border-box; min-height:var(--btn-h); font:inherit; color:var(--text); background:var(--btn-bg); border:1px solid var(--btn-border); border-radius:var(--r-2); padding:0 var(--sp-3); cursor:pointer; }
.btn:hover, .btn-primary:hover { background:var(--btn-bg-hover); }
.btn-primary { background:var(--btn-primary-bg); color:var(--btn-primary-fg); }
.btn-primary:hover { background:var(--btn-primary-bg); }
.shared-card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:var(--space-4); }
.shared-chip { font:11px var(--font-mono); border:1px solid currentColor; border-radius:var(--r-1); padding:0 4px; }
.shared-badge { font:700 11px var(--font-mono); text-transform:uppercase; letter-spacing:.06em; }
.shared-tbl { border-collapse:collapse; }
.shared-tbl tr { border-bottom:1px solid var(--line); }
.shared-tbl th, .shared-tbl td { padding:var(--space-2); }
.shared-status { display:inline-block; }
.shared-status.is-pass { color:var(--added); }
.shared-status.is-fail, .shared-status.is-error { color:var(--removed); }
.shared-status.is-new { color:var(--modified); }
.shared-status.is-notrun, .shared-muted { color:var(--muted); }
.mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
```

Do not overhaul component markup or site layout in this task. Retain existing glyphs and change marker dash styles. The token colour change is not permission to recolour schematic SVGs or overlay filters.

- [ ] **Step 4: Re-run targeted tests** with `CHECK_PORT=9357 node ui/check.mjs 'Stage 1'` and `node --import ./site/css-loader.mjs --test site/test.mjs`. Expected: PASS. For task screenshots set the html attribute explicitly in Chrome; the shared toggle arrives in Task 2.
- [ ] **Step 5: Commit.**

```sh
git add ui/tokens.css ui/checks.mjs
git commit -m "feat(ui): establish dark-default shared design tokens"
```

### Task 2: Share persisted theme behavior across site, report and 3D

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return report, wrapper, and signed-out screenshots in both themes.

**Files:**
- Create: `ui/theme.js`, `ui/theme.test.mjs`
- Modify: `ui/review.html`, `ui/review.css`, `ui/review3d.js:16,51`, `ui/check.mjs`, `ui/checks.mjs:169-185,505-510`
- Modify: `site/pages.js:1-3,30-35`, `site/site.css`, `site/wrangler.toml`, `site/css-loader.mjs`, `site/test.mjs`
- Modify: `kicad_review.py:inline_page`, `test_kicad_review.py:74-81`

**Interfaces:**
- Consumes: Task 1 tokens and existing `#review-report` iframe ID / `kicadReviewReady` notification.
- Produces: `window.KRTheme.get(): 'dark'|'light'`; `window.KRTheme.set(theme, {persist?:boolean, broadcast?:boolean}={}): void`; DOM `kr-theme-change` event with `detail: 'dark'|'light'`; button selector `[data-theme-toggle]`; message `{kicadReviewTheme:'dark'|'light'}`.
- Theme messages are presentation only. Actual iframe `event.source` is required; a global wildcard listener never trusts arbitrary windows. `'*'` is required when posting into the existing opaque-origin report; do not add allow-same-origin.

- [ ] **Step 1: Create executable VM tests.** Put this complete file at `ui/theme.test.mjs`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('./theme.js', import.meta.url), 'utf8');
function boot(value, blocked=false, child=false) {
  const handlers = {}, posts = [], writes = [], attrs = {};
  const button = {setAttribute:(k,v)=>attrs[k]=v};
  const frame = {postMessage:(...args)=>posts.push(args)};
  const root = {dataset:{}};
  const document = {documentElement:root, readyState:'complete',
    querySelectorAll:()=>[button], getElementById:()=>child?null:{contentWindow:frame},
    addEventListener:(k,fn)=>handlers[k]=fn, dispatchEvent:()=>{}};
  const window = {};
  const parent = child ? {postMessage:(...args)=>posts.push(args)} : window;
  const storage = {getItem:()=>{if(blocked)throw Error('denied'); return value;},
    setItem:(k,v)=>{if(blocked)throw Error('denied');writes.push([k,v]);}};
  runInNewContext(source,{window,parent,document,localStorage:storage,
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    addEventListener:(k,fn)=>handlers[k]=fn});
  return {api:window.KRTheme,root,handlers,posts,writes,attrs,parent,frame};
}
test('theme dark default, invalid storage, blocked storage and persistence',()=>{
  for(const value of [null,'','system','<script>']) assert.equal(boot(value).api.get(),'dark');
  const denied=boot('light',true); assert.equal(denied.api.get(),'dark');
  denied.api.set('light'); assert.equal(denied.api.get(),'light');
  const x=boot('light'); assert.equal(x.root.dataset.theme,'light');
  x.api.set('dark'); assert.deepEqual(x.writes,[['kr.theme','dark']]);
  assert.equal(x.attrs['aria-pressed'],'true');
  assert.equal(x.attrs['aria-label'],'Switch to light theme');
  x.api.set('bogus'); assert.equal(x.api.get(),'dark');
});
test('opaque child only accepts its parent and never echoes inbound theme',()=>{
  const x=boot(null,true,true);
  x.handlers.message({source:{},data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'dark');
  x.handlers.message({source:x.parent,data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'light');
  assert.equal(x.posts.length,0);
  x.api.set('dark'); assert.equal(x.posts.length,1);
  assert.equal(x.posts[0][0].kicadReviewTheme,'dark');
});
test('wrapper synchronizes only actual frame, storage changes and ready events',()=>{
  const x=boot(null);
  x.handlers.message({source:{},data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'dark');
  x.handlers.message({source:x.frame,data:{kicadReviewTheme:'light'}});assert.equal(x.api.get(),'light');
  assert.equal(x.posts.length,0);
  x.handlers.message({source:x.frame,data:{kicadReviewReady:true}});assert.equal(x.posts.length,1);
  x.handlers.storage({key:'kr.theme',newValue:'dark'});assert.equal(x.api.get(),'dark');
  x.handlers.storage({key:'kr.theme',newValue:null});assert.equal(x.api.get(),'dark');
});
```

Add to `site/test.mjs`:

```js
test('every frame carries early shared theme script and a labeled toggle',()=>{
  for(const html of [signedOutPage(),homePage({user:'cam',repositories:[]}),
    messagePage({title:'Error',message:'Unavailable'})]) {
    assert.match(html,/data-theme-toggle/);
    assert.match(html,/kr\.theme/);
    assert.ok(html.indexOf('kr.theme') < html.indexOf('<style>'));
    assert.match(html,/aria-label="Switch to light theme"/);
  }
});
```

First check `messagePage()`'s existing arguments; omitted optional fields are fine, no test should require credentials. Add Python assertions adjacent to the first `inline_page()` test:

```python
assert 'src="theme.js"' not in html
assert "kr.theme" in html and "window.KRTheme" in html
assert html.index("kr.theme") < html.index("<style>")
assert "data-theme-toggle" in html
```

- [ ] **Step 2: Run red tests.**

Run: `node --test ui/theme.test.mjs`; `node --import ./site/css-loader.mjs --test site/test.mjs`; `python3 test_kicad_review.py`.
Expected: missing `theme.js`, site missing control, Python missing embedded theme script.

- [ ] **Step 3: Implement shared classic `ui/theme.js`.** Loaded in `<head>` before CSS; event handlers are delegated because report headers can be rebuilt. No imports, inline handler attributes, timers, or dependency globals.

```js
(() => {
  const root = document.documentElement;
  const valid = t => t === 'dark' || t === 'light';
  const get = () => root.dataset.theme === 'light' ? 'light' : 'dark';
  const frame = () => document.getElementById('review-report');
  const sync = () => {
    for (const b of document.querySelectorAll('[data-theme-toggle]')) {
      const label = `Switch to ${get() === 'dark' ? 'light' : 'dark'} theme`;
      b.setAttribute('aria-label', label); b.setAttribute('title', label);
      b.setAttribute('aria-pressed', String(get() === 'dark'));
    }
  };
  const send = () => {
    const message = {kicadReviewTheme:get()};
    if (parent !== window) parent.postMessage(message, '*');
    else frame()?.contentWindow?.postMessage(message, '*');
  };
  const set = (theme, {persist=true, broadcast=true}={}) => {
    if (!valid(theme)) return;
    root.dataset.theme = theme;
    if (persist) { try { localStorage.setItem('kr.theme', theme); } catch {} }
    sync(); document.dispatchEvent(new CustomEvent('kr-theme-change',{detail:theme}));
    if (broadcast) send();
  };
  let stored;
  try { stored = localStorage.getItem('kr.theme'); } catch {}
  root.dataset.theme = valid(stored) ? stored : 'dark';
  window.KRTheme = {get,set};
  document.addEventListener('click', event => {
    if (event.target.closest('[data-theme-toggle]')) set(get() === 'dark' ? 'light' : 'dark');
  });
  addEventListener('storage', event => {
    if (event.key === 'kr.theme' || event.key === null)
      set(valid(event.newValue) ? event.newValue : 'dark', {persist:false});
  });
  addEventListener('message', event => {
    const peer = parent !== window ? parent : frame()?.contentWindow;
    if (!peer || event.source !== peer) return;
    if (valid(event.data?.kicadReviewTheme))
      set(event.data.kicadReviewTheme, {persist:parent === window, broadcast:false});
    if (parent === window && event.data?.kicadReviewReady === true) send();
  });
  // Capture the non-bubbling iframe load event, also covering legacy reports.
  document.addEventListener('load', event => { if(event.target === frame()) send(); }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, {once:true});
  else sync();
})();
```

In `ui/review.html`, insert `<script src="theme.js"></script>` immediately after the title and **before** existing CSS links. Replace `<header id="hdr"></header>` with the following wrapper. The stable `.report-head` keeps the control alive across `renderHeader()`:

```html
<div class="report-head"><header id="hdr"></header><button type="button" class="btn theme-toggle" data-theme-toggle aria-label="Switch to light theme" title="Switch to light theme" aria-pressed="true">Theme</button></div>
```

Append CSS to `ui/review.css`:

```css
.report-head { display:flex; align-items:center; min-width:0; background:var(--surface); border-bottom:1px solid var(--line); }
.report-head #hdr { flex:1; min-width:0; border-bottom:0; }
.report-head .theme-toggle { flex:none; margin:0 var(--sp-2); }
body.shot .report-head { display:none; }
```

In `site/pages.js`, add `import theme from '../ui/theme.js';`. In `frame()` insert `<script>${theme}</script>` before `<style>`, and the same toggle button before `${account}`. Give the button `class="btn theme-toggle"`. Add `.top > .theme-toggle { margin-left:auto; flex:none; }` to `site/site.css`; keep existing account spacing until Stage 2.

Worker bundler: add a separate Text rule to `site/wrangler.toml`:

```toml
[[rules]]
type = "Text"
globs = ["**/ui/theme.js", "**/ui/icons/sprite.svg"]
fallthrough = true
```

Node loader: change the existing `if (url.endsWith('.css'))` condition to:

```js
if (url.endsWith('.css') || url.endsWith('/ui/theme.js') || url.endsWith('/ui/icons/sprite.svg')) {
```

This is deliberately a raw text import of a **classic script**, not a module imported and executed by the Worker. Keep the existing source/shortCircuit return unchanged.

In `inline_page()`, after composing `page` and before 3D-prefix handling, add:

```python
page = page.replace('<script src="theme.js"></script>', f"<script>\n{read('theme.js')}</script>")
```

Extend the existing final asset regex alternation with `theme\.js`. Do not move theme behind the CSS or data script. The offline test must still reject any remaining recognized external asset even under `python3 -O`.

For `ui/review3d.js`, replace `bg()` and the existing theme-poll fragment inside `show()` with these exact expressions. Keep the existing abort signal, media listener, timer cleanup, parse count and camera handling:

```js
const bg = () => css(window.KRTheme.get() === 'dark' ? '--bg' : '--paper');
```

```js
const media=matchMedia('(prefers-color-scheme: dark)');
let signature=[bg(),css('--added'),css('--removed'),css('--modified'),css('--accent')].join('|');
const theme=()=>{const next=[bg(),css('--added'),css('--removed'),css('--modified'),css('--accent')].join('|');if(signature!==next){signature=next;recolour();}};
document.addEventListener('kr-theme-change',theme,{signal});
media.addEventListener('change',theme,{signal});
session.themeTimer=setInterval(theme,250);
```

The poll continues to catch CSS changes; OS changes alone do not override user theme. No new GPU buffers, material clones, or GLB parses on theme change.

- [ ] **Step 4: Make the harness exercise explicit light/dark rather than misusing OS emulation.**

In `ui/check.mjs`, change `--dark` to select explicit dark while the existing default selects explicit light for backwards-compatible two-theme invocations. Add width selection now for Task 4:

```js
const width = Number(opt('--width') || 1920);
```

Use `width` in `Emulation.setDeviceMetricsOverride`. Before the per-check loop, seed the chosen theme on every new page:

```js
await send('Page.addScriptToEvaluateOnNewDocument', {source:
  `try{localStorage.setItem('kr.theme',${JSON.stringify(dark ? 'dark' : 'light')})}catch{}`});
```

Do **not** modify the product's default: this is only a test harness override. The Task 1 default check explicitly removes the attribute, and VM tests pin initial no-storage behavior.

Replace the `Runtime.bindingCalled` `__flipTheme` handler body with explicit application followed by the existing completion callback:

```js
send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:m.params.payload}]})
  .then(()=>evaluate(`window.KRTheme.set(${JSON.stringify(m.params.payload)}); window.__themeFlipped()`));
```

In the existing contrast test, retain its full contrast calculation, rename it to `theme override keeps text contrast`, and replace only `const dark = matchMedia(...).matches;` with `const dark = window.KRTheme.get() === 'dark';`. In the two 3D switch tests replace `dark = !matchMedia(...).matches` with `dark = window.KRTheme.get() !== 'dark'`; retain every existing clear/highlight/outline/camera/parse assertion.

Append a browser test to `CHECKS`:

```js
["Stage 1 theme button survives header render and keyboard activation", "", `
  const before=KRTheme.get(); renderHeader();
  const b=document.querySelector('[data-theme-toggle]'); b.focus(); b.click();
  const next=KRTheme.get(), good=next!==before && document.activeElement===b && b.title.includes(before);
  KRTheme.set(before); return good;`],
```

The real Enter/Space keyboard activation is exercised in final browser proof; this check pins focus through the existing header replacement path.

- [ ] **Step 5: Run green tests and all existing browser checks.**

```sh
node --test ui/theme.test.mjs
node --import ./site/css-loader.mjs --test site/test.mjs
python3 test_kicad_review.py
CHECK_PORT=9357 node ui/check.mjs
CHECK_PORT=9358 node ui/check.mjs --dark
```

Expected: all pass, including the existing 3D material/camera checks where the fixture has 3D. Missing fixture 3D remains an existing skip, not evidence of 3D proof; final task uses a generated 3D report as well. Record screenshots before returning.

- [ ] **Step 6: Commit.**

```sh
git add ui/theme.js ui/theme.test.mjs ui/review.html ui/review.css ui/review3d.js ui/check.mjs ui/checks.mjs site/pages.js site/site.css site/wrangler.toml site/css-loader.mjs site/test.mjs kicad_review.py test_kicad_review.py
git commit -m "feat(ui): share persisted theme control across report and site"
```

### Task 3: Inline SVG icons with narrow KiCad attribution boundary

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return zoom-control and theme-control screenshots in both themes.

**Files:**
- Create: `ui/icons/build.py`, `ui/icons/sprite.svg`, `ui/icons/LICENSE`, `NOTICE`
- Create: `ui/icons/kicad/light/zoom_in.svg`, `zoom_out.svg`, `zoom_fit_in_page.svg`; matching three files in `ui/icons/kicad/dark/`
- Modify: `ui/review.html`, `ui/review.js:827-829`, `ui/tokens.css`, `site/pages.js:frame`, `kicad_review.py:inline_page`, `test_kicad_review.py`, `site/test.mjs`, `ui/checks.mjs`

**Interfaces:**
- Consumes: `data-theme` on html and raw Text loading from Task 2.
- Produces: symbols `kr-zoom-in-light`, `kr-zoom-in-dark`, `kr-zoom-out-light`, `kr-zoom-out-dark`, `kr-fit-light`, `kr-fit-dark`, `kr-theme`; `<use href="#...">` only, no external hrefs. The first six are CC-BY-SA artwork; `kr-theme` is original kicad-review artwork under the repository's existing terms. Sprite is shipped, not generated at runtime.

- [ ] **Step 1: Add failing inlining, license and browser tests.**

Append adjacent to Python's first inlining assertions:

```python
assert '<!-- KR_ICONS -->' not in html
assert 'id="kr-zoom-in-dark"' in html and 'id="kr-theme"' in html
assert 'href="icons/' not in html and 'src="icons/' not in html
assert 'CC-BY-SA-4.0' in html
for name in ('zoom_in.svg', 'zoom_out.svg', 'zoom_fit_in_page.svg'):
    assert name in open('ui/icons/LICENSE', encoding='utf-8').read()
assert 'builtin_color_themes.h:160' in open('NOTICE', encoding='utf-8').read()
```

Append a site test:

```js
test('site embeds sprite and theme icon without external asset URLs',()=>{
  const html=signedOutPage();
  assert.match(html,/id="kr-theme"/); assert.match(html,/href="#kr-theme"/);
  assert.ok(!html.includes('href="icons/'));
});
```

Append a browser check:

```js
["Stage 1 icon references resolve in-file in both themes", "", `
  const old=KRTheme.get();
  try {
    for(const theme of ['dark','light']) {
      KRTheme.set(theme);
      for(const use of document.querySelectorAll('button use')) {
        if(!document.querySelector(use.getAttribute('href'))) return 'unresolved '+use.getAttribute('href');
      }
      const b=document.querySelector('#zoombar [data-z="1.25"]');
      const icons=[...b.querySelectorAll('svg')].filter(s=>getComputedStyle(s).display!=='none');
      if(icons.length!==1 || !icons[0].querySelector('use').getAttribute('href').endsWith(theme)) return 'palette';
      const box=icons[0].getBBox(); if(!box.width || !box.height) return 'empty icon';
      if(!b.getAttribute('aria-label') || !b.title) return 'unlabeled';
    }
    return true;
  } finally { KRTheme.set(old); }`],
```

- [ ] **Step 2: Run failing tests.** `python3 test_kicad_review.py`; `node --import ./site/css-loader.mjs --test site/test.mjs`; `CHECK_PORT=9357 node ui/check.mjs 'Stage 1 icon'`. Expected: missing sprite/license/symbols.

- [ ] **Step 3: Copy only artwork and license data from the read-only source; generate a sanitized sprite.**

Source root for these commands:

```sh
SRC=/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/ui-research/kicad-source
mkdir -p ui/icons/kicad/light ui/icons/kicad/dark
for theme in light dark; do
  for icon in zoom_in zoom_out zoom_fit_in_page; do
    cp "$SRC/resources/bitmaps_png/sources/$theme/$icon.svg" "ui/icons/kicad/$theme/$icon.svg"
  done
done
```

Exact provenance inspected: `resources/bitmaps_png/sources/CREDITS:1-9` identifies original authors Inigo Zuluaga and Fabrizio Tappero among others, 2020 redesign Aleksandr Zyrianov, and CC-BY-SA 4.0. These paths are `resources/bitmaps_png`, **not** top-level `bitmaps_png`.

Create `ui/icons/build.py` with this complete content. Run from the repository worktree, not the downloaded source directory.

```python
"""Rebuild the checked-in local-fragment SVG sprite using Python's stdlib."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)
root = ET.Element(f'{{{SVG}}}svg', {
    'width': '0', 'height': '0', 'aria-hidden': 'true', 'focusable': 'false',
    'style': 'position:absolute;overflow:hidden', 'id': 'kr-icons',
})
root.append(ET.Comment(
    ' KiCad-derived symbols: CC-BY-SA-4.0. Original icons: Inigo Zuluaga, '
    'Fabrizio Tappero and contributors; 2020 redesign: Aleksandr Zyrianov. '
    'Source: https://gitlab.com/kicad/code/kicad/-/tree/3e051f88/resources/bitmaps_png/sources '
    'License: https://creativecommons.org/licenses/by-sa/4.0/ '
    'Changes: metadata removed; IDs and CSS classes namespaced; symbol wrappers. '
    'Only derived artwork is share-alike. Full terms: ui/icons/LICENSE. '
))
allowed = {'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
           'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'style'}
for name, filename in [('zoom-in', 'zoom_in'), ('zoom-out', 'zoom_out'), ('fit', 'zoom_fit_in_page')]:
    for theme in ('light', 'dark'):
        key = f'kr-{name}-{theme}'
        source = ET.parse(HERE / 'kicad' / theme / f'{filename}.svg').getroot()
        symbol = ET.SubElement(root, f'{{{SVG}}}symbol', {
            'id': key, 'viewBox': source.attrib['viewBox'],
        })
        ids = {n.attrib['id']: f'{key}-{n.attrib["id"]}' for n in source.iter() if 'id' in n.attrib}
        def clean(node):
            local = node.tag.rsplit('}', 1)[-1]
            if not node.tag.startswith('{' + SVG + '}') or local not in allowed:
                return None
            out = ET.Element(f'{{{SVG}}}{local}')
            for attr, value in node.attrib.items():
                if attr.startswith('{'):
                    if attr == '{http://www.w3.org/1999/xlink}href': attr = 'href'
                    else: continue
                if attr.lower().startswith('on'): raise ValueError('event attribute')
                if attr == 'id': value = ids[value]
                elif attr == 'class': value = ' '.join(key + '-' + item for item in value.split())
                elif attr == 'href':
                    if not value.startswith('#'): raise ValueError('external href')
                    value = '#' + ids[value[1:]]
                value = re.sub(r'url\(#([^)]*)\)', lambda m: 'url(#' + ids[m[1]] + ')', value)
                if re.search(r'url\((?!#)', value): raise ValueError('external URL')
                out.set(attr, value)
            out.text = node.text
            if local == 'style' and out.text:
                out.text = re.sub(r'\.([A-Za-z_][\w-]*)', lambda m: '.' + key + '-' + m[1], out.text)
                for old, new in sorted(ids.items(), key=lambda pair: -len(pair[0])):
                    out.text = out.text.replace('#' + old, '#' + new)
                if '@import' in out.text or re.search(r'url\((?!#)', out.text):
                    raise ValueError('external style')
            for child in node:
                result = clean(child)
                if result is not None: out.append(result)
            return out
        for child in source:
            result = clean(child)
            if result is not None: symbol.append(result)
# Original artwork, not a redraw of a KiCad icon: a split light/dark disc.
symbol = ET.SubElement(root, f'{{{SVG}}}symbol', {'id':'kr-theme', 'viewBox':'0 0 24 24'})
ET.SubElement(symbol, f'{{{SVG}}}circle', {'cx':'12','cy':'12','r':'8','fill':'none','stroke':'currentColor','stroke-width':'1.5'})
ET.SubElement(symbol, f'{{{SVG}}}path', {'d':'M12 4a8 8 0 0 1 0 16Z','fill':'currentColor'})
serialized = ET.tostring(root, encoding='unicode')
serialized = serialized.replace(' xmlns="http://www.w3.org/2000/svg"', '', 1)
(HERE / 'sprite.svg').write_text(serialized + '\n', encoding='utf-8')
```

Run `python3 -I ui/icons/build.py`. Inspect rendered shapes and verify none of the six source SVGs relies on root-level style/transform omitted by the wrapper. If one does, transfer that presentation attribute to a child `<g>` in the builder and add an assertion for it; never silently substitute a home-grown magnifier for an available KiCad icon.

Create `ui/icons/LICENSE` using this exact attribution preamble, followed by the **complete** verbatim contents of `$SRC/LICENSE.CC-BY-SA-4.0` (copying license text is allowed):

```text
KiCad-derived artwork in kicad/light/{zoom_in.svg,zoom_out.svg,zoom_fit_in_page.svg}
and kicad/dark/{zoom_in.svg,zoom_out.svg,zoom_fit_in_page.svg}, and the six
kr-zoom-in-*, kr-zoom-out-*, kr-fit-* symbols in sprite.svg:

Source: KiCad 10.0, commit 3e051f88, resources/bitmaps_png/sources/{light,dark}/
https://gitlab.com/kicad/code/kicad/-/tree/3e051f88/resources/bitmaps_png/sources
Original work: Inigo Zuluaga and Fabrizio Tappero among others.
2020 icon redesign: Aleksandr Zyrianov. Copyright the KiCad icon contributors.
License: Creative Commons Attribution-ShareAlike 4.0 International (CC-BY-SA-4.0).
https://creativecommons.org/licenses/by-sa/4.0/
Changes by kicad-review contributors: SVG metadata removed for inline symbols;
IDs/references namespaced; original viewBox, geometry and colours retained.
The derived symbols remain licensed under CC-BY-SA-4.0.

The kr-theme symbol is original kicad-review artwork under the repository's
existing terms, not KiCad artwork. build.py is original project code.
No KiCad GPL source code is included. The artwork license does not relicense
this application's JavaScript, Python, CSS, or the repository as a whole.

Complete CC-BY-SA-4.0 license text follows.
```

Create `NOTICE`:

```text
KiCad colour data

The PCB background #001023 and schematic paper #F5F4EF used by ui/tokens.css
are numeric default-colour data from KiCad 10.0, source commit 3e051f88:
common/settings/builtin_color_themes.h:160 (PCB background, RGB 0,16,35)
common/settings/builtin_color_themes.h:32 (schematic background, RGB 245,244,239).
https://gitlab.com/kicad/code/kicad/-/blob/3e051f88/common/settings/builtin_color_themes.h
Credit: The KiCad Developers; colour settings copyright Jon Evans (2020).
Only numeric colour data is reused; no KiCad GPL implementation source is copied.
Additional layer-colour data and layer-order citations will accompany the board
renderer when introduced; this stage does not claim to implement that table.

KiCad icons

Six toolbar icon variants and their derived inline SVG symbols are reused under
CC-BY-SA-4.0. Authors, source, modifications and complete license: ui/icons/LICENSE.
Only this artwork is share-alike; application code and the repository's existing
licensing are unchanged. The theme-control disc icon is original project artwork.
```

- [ ] **Step 4: Embed the sprite and consume it without runtime fetches.**

Add `<!-- KR_ICONS -->` immediately after `<body>` in `ui/review.html`. Add this replacement to `inline_page()`:

```python
page = page.replace('<!-- KR_ICONS -->', read('icons/sprite.svg'))
```

Import `icons` from `../ui/icons/sprite.svg` in `site/pages.js` and insert `${icons}` immediately after `<body>` in `frame()`. The Task 2 Text rule/loader already supports it. Sprite metadata/credits must not contain `http://` namespace metadata: inline SVG is HTML, so after serialization remove ` xmlns="http://www.w3.org/2000/svg"` from the **outer root only** in the builder before writing; the existing offline test rejects literal `http://` in the final HTML. Namespace-aware source parsing remains unchanged.

Replace theme button's `Theme` text in **both** templates with the same markup:

```html
<svg class="icon" aria-hidden="true" focusable="false"><use href="#kr-theme"></use></svg><span>Theme</span>
```

In `renderZoombar()` define this local helper, then replace **only** the three controls; retain `.pct`, all data attributes, Copy link, Go to, and their text-based existing test expectations:

```js
const icon = name => ['light','dark'].map(theme=>`<svg class="icon icon-${theme}" aria-hidden="true" focusable="false"><use href="#kr-${name}-${theme}"></use></svg>`).join('');
```

```html
<button data-z="0.8" aria-label="Zoom out" title="Zoom out">${icon('zoom-out')}</button><span class="pct"></span><button data-z="1.25" aria-label="Zoom in" title="Zoom in">${icon('zoom-in')}</button>
<button data-act="fit" aria-label="Fit drawing (f)" title="Fit drawing (f)">${icon('fit')}<span>Fit</span></button>
```

Append shared icon CSS to `ui/tokens.css`:

```css
.icon { width:var(--icon-size); height:var(--icon-size); flex:none; vertical-align:middle; }
.icon-light { display:none; }
:root[data-theme="light"] .icon-light { display:inline-block; }
:root[data-theme="light"] .icon-dark { display:none; }
.theme-toggle { display:inline-flex; align-items:center; gap:var(--sp-1); white-space:nowrap; }
```

- [ ] **Step 5: Verify deterministic assets, legal boundary, and tests.**

```sh
python3 -I ui/icons/build.py
shasum ui/icons/sprite.svg
python3 -I ui/icons/build.py
shasum ui/icons/sprite.svg
python3 test_kicad_review.py
node --import ./site/css-loader.mjs --test site/test.mjs
CHECK_PORT=9357 node ui/check.mjs 'Stage 1 icon'
CHECK_PORT=9358 node ui/check.mjs 'Stage 1 icon' --dark
```

Expected: identical hashes, all tests pass, visible 16 px icons in both palettes, no external use references or GPL source. Return screenshots in both themes.

- [ ] **Step 6: Commit.**

```sh
git add ui/icons NOTICE ui/review.html ui/review.js ui/tokens.css site/pages.js kicad_review.py test_kicad_review.py site/test.mjs ui/checks.mjs
git commit -m "feat(ui): inline attributed KiCad toolbar icon sprite"
```

### Task 4: Fix right-dock clipping and show drawing X/Y

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return 1600 px report screenshots with Parts and Threads tabs present in both themes.

**Files:**
- Modify: `ui/review.html`, `ui/review.css`, `ui/review.js:250-266,293-310,734-786`, `ui/checks.mjs`

**Interfaces:**
- Consumes: current camera (`S.x`, `S.y` mm, `S.z` CSS px/mm), each `.vp` rectangle, existing tab `data-tab` / `S.t` values.
- Produces: `#statusbar` with `[data-coordinate="x"]`, `[data-coordinate="y"]`, explicit mm units; `updateCoordinates(vp:HTMLElement,event:{clientX:number,clientY:number}):void`; `resetCoordinates():void`.
- Tab IDs/hash/state are unchanged. No Appearance tab until Stage 4. At 1600 px existing tabs wrap inside the dock, with no clipping; at narrower sizes they remain reachable. Full report-chrome reconstruction belongs to Stage 3.

- [ ] **Step 1: Add executable geometry/coordinate tests.** Prepend these to `CHECKS`. Run the tab test at `--width 1600` so it measures the actual browser viewport, not a simulated body width.

```js
["Stage 1 dock tabs remain readable and reachable at 1600", "", `
  const P=proj();
  P.parts ||= {lines:[],supplier:{skipped:true}};
  const line=P.parts.lines[0] || {problems:[]}; P.parts.lines=Array(999).fill(line);
  S.threads=[]; S.issues=[]; renderPanel();
  const panel=document.querySelector('#panel').getBoundingClientRect();
  const tabs=[...document.querySelectorAll('#panel [role=tab]')];
  if(tabs.length!==4) return 'missing tabs';
  for(const b of tabs) {
    const r=b.getBoundingClientRect();
    if(r.left<panel.left || r.right>panel.right+.5 || b.scrollWidth>b.clientWidth+1) return b.textContent;
  }
  const checks=tabs.find(t=>t.dataset.tab==='checks'); checks.focus();
  checks.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
  const last=document.querySelector('#panel [data-tab="threads"]');
  const good=document.activeElement===last && last.getAttribute('aria-selected')==='true';
  return good && document.documentElement.scrollWidth<=innerWidth || 'keyboard/overflow';`],
["Stage 1 X Y map each pane and reset outside drawing", "v=board", `
  await draw(); setT({x:-12.125,y:34.375,z:8});
  const viewports=[...document.querySelectorAll('#stage .vp')];
  if(viewports.length!==2) return 'side fixture';
  for(const vp of viewports) {
    const r=vp.getBoundingClientRect();
    updateCoordinates(vp,{clientX:r.left+r.width/2+10,clientY:r.top+r.height/2-6});
    if(document.querySelector('[data-coordinate=x]').textContent!=='-10.875' ||
       document.querySelector('[data-coordinate=y]').textContent!=='33.625') return 'mapping';
  }
  const hash=location.hash; resetCoordinates();
  if(document.querySelector('[data-coordinate=x]').textContent!=='—') return 'stale';
  await draw();
  return document.querySelector('[data-coordinate=y]').textContent==='—' && location.hash===hash;`],
```

The 999-line replacement only mutates the isolated browser-check fixture. Do not ship fabricated project data. Check no-render and 3D reset in Step 4 browser proof as well.

- [ ] **Step 2: Run red checks.** `CHECK_PORT=9357 node ui/check.mjs 'Stage 1 dock' --width 1600`; `CHECK_PORT=9358 node ui/check.mjs 'Stage 1 X Y'`. Expected: clipped tab or missing End navigation, undefined coordinate helper.

- [ ] **Step 3: Implement the two bounded shell changes.**

Insert after `#zoombar` in `ui/review.html`:

```html
<footer id="statusbar" aria-label="Drawing status"><span>X <span data-coordinate="x">—</span></span><span>Y <span data-coordinate="y">—</span></span><span>mm</span><span class="status-message" role="status" aria-live="polite">Ready</span></footer>
```

Coordinates are intentionally **not** live regions; pointer movement must not flood assistive technology. No fake zero when the drawing is absent. Append to `ui/review.css`:

```css
body { grid-template-rows:auto var(--toolbar-h) minmax(0,1fr) auto var(--statusbar-h); }
#app { grid-template-columns:var(--nav-w) minmax(0,1fr) var(--panel-w); }
#panel > [role=tablist] { display:flex; flex-wrap:wrap; align-items:stretch; gap:0; width:100%; box-sizing:border-box; background:var(--panel-head-bg); }
#panel > [role=tablist] > [role=tab] { box-sizing:border-box; flex:0 0 auto; min-height:var(--tab-h); max-width:100%; padding:0 var(--sp-2); border-radius:0; font-size:var(--fs-sm); white-space:normal; overflow-wrap:anywhere; border:0; border-bottom:2px solid transparent; }
#panel > [role=tablist] > [role=tab][aria-selected=true] { background:var(--panel-bg); color:var(--text); border-bottom-color:var(--tab-underline); font-weight:var(--fw-medium); }
#statusbar { display:flex; align-items:center; gap:var(--sp-3); box-sizing:border-box; min-width:0; height:var(--statusbar-h); padding:0 var(--sp-2); background:var(--statusbar-bg); color:var(--muted); border-top:1px solid var(--line); font:var(--fs-xs)/var(--lh-base) var(--font-mono); font-variant-numeric:tabular-nums; }
#statusbar [data-coordinate] { display:inline-block; min-width:8ch; color:var(--text); text-align:right; }
#statusbar .status-message { margin-left:auto; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
body.shot #statusbar { display:none; }
body.shot { grid-template-rows:minmax(0,1fr); }
```

Preserve the existing `#app:has([data-tab=parts][aria-selected=true])` sizing rule and its table scroll container; this fix does not redesign the Parts table. Wrapping the tab strip is deliberate: labels never disappear into horizontal overflow, even at high counts. Its height can be two 28 px rows; individual dock headers retain the token height.

Add these functions beside `attachPanZoom()` in `ui/review.js`:

```js
function resetCoordinates() {
  for(const node of document.querySelectorAll('#statusbar [data-coordinate]')) node.textContent='—';
}
function updateCoordinates(vp,event) {
  if(!placed() || !vp.isConnected || S.v==='3d') { resetCoordinates(); return; }
  const r=vp.getBoundingClientRect();
  const x=S.x+(event.clientX-r.left-r.width/2)/S.z;
  const y=S.y+(event.clientY-r.top-r.height/2)/S.z;
  const values={x,y};
  for(const key of ['x','y']) {
    const node=document.querySelector('#statusbar [data-coordinate='+key+']');
    if(node) node.textContent=Number.isFinite(values[key]) ? (Math.abs(values[key])<.0005?0:values[key]).toFixed(3) : '—';
  }
}
```

At the start of `draw()` add `resetCoordinates();`. In `attachPanZoom()` add these listeners **after** existing pan listeners so the pan-updated camera is used in the same event:

```js
vp.addEventListener('pointermove',event=>updateCoordinates(vp,event));
vp.addEventListener('pointerleave',resetCoordinates);
vp.addEventListener('pointercancel',resetCoordinates);
```

No camera, hash, pin, selection, or rendering mutation is allowed inside these helpers. The displayed numbers use the exact same drawing coordinate transform as `proposePin()`; they are not local footprint coordinates and not screen pixels. For 3D leave X/Y unavailable rather than pretending camera orbit positions are PCB coordinates.

At the end of `renderPanel()`, after existing tab click handlers are assigned and before its focus restoration, add keyboard handling:

```js
const tabs=[...document.querySelectorAll('#panel [role=tab]')];
for(const tab of tabs) {
  tab.tabIndex=tab.getAttribute('aria-selected')==='true'?0:-1;
  tab.addEventListener('keydown',event=>{
    const i=tabs.indexOf(tab), key=event.key;
    const target=key==='Home'?tabs[0]:key==='End'?tabs.at(-1):key==='ArrowRight'?tabs[(i+1)%tabs.length]:key==='ArrowLeft'?tabs[(i+tabs.length-1)%tabs.length]:null;
    if(!target) return;
    event.preventDefault(); const name=target.dataset.tab;
    target.click();
    const next=document.querySelector('#panel [data-tab="'+name+'"]');
    next?.focus(); next?.scrollIntoView({block:'nearest',inline:'nearest'});
  });
}
```

Keep native Enter/Space behavior and existing click selection. Do not attach handlers to removed pre-render elements after the panel rebuilds.

- [ ] **Step 4: Run geometry, hash and regression checks.**

```sh
CHECK_PORT=9357 node ui/check.mjs 'Stage 1 dock' --width 1600
CHECK_PORT=9358 node ui/check.mjs 'Stage 1 dock' --width 1600 --dark
CHECK_PORT=9357 node ui/check.mjs 'Stage 1 X Y'
CHECK_PORT=9358 node ui/check.mjs --dark
CHECK_PORT=9357 node ui/check.mjs
python3 test_kicad_review.py
node --import ./site/css-loader.mjs --test site/test.mjs
```

Expected: all pass. In Chrome move pointer to two different points in **each** Side pane, switch to Overlay and a schematic, then to 3D/no-render: X/Y reset, update in mm on drawings, and never alter the URL. Keyboard navigate all dock tabs and inspect the inset focus ring at 1600 px in both themes. Capture screenshots with real Thermal_Camera report data, not Aux.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.html ui/review.css ui/review.js ui/checks.mjs
git commit -m "fix(ui): keep dock tabs visible and expose drawing coordinates"
```

### Task 5: Stage browser proof and fully offline regression gate

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return the before/after image paths in both themes and test counts. This is a proof gate, not permission to begin Stage 2 or 3.

**Files:**
- Modify: `ui/checks.mjs` (offline proof check below)
- Test: `ui/theme.test.mjs`, `site/test.mjs`, `test_kicad_review.py`, generated report in session scratchpad
- Evidence: session scratchpad only; no private design or reference images committed.

**Interfaces:**
- Consumes: all Stage 1 APIs; existing `inline_page(data_js)` and `ui/check.mjs [filter] --page PATH --shot PATH [--dark] [--width N]`.
- Produces: passing full test matrix, real Thermal_Camera before/after screenshots at 1600 px in both themes, and offline report/site-wrapper proof without CSP changes.

- [ ] **Step 1: Write failing asset-closure browser assertion.** Add this check (it should catch any integration mistake; if already green, record that instead of manufacturing a failure).

```js
["Stage 1 offline asset closure and shell proof", "v=board", `
  const external=[...document.querySelectorAll('script[src],link[rel=stylesheet][href],use[href]')]
    .filter(el=>!(el.getAttribute('href')||'').startsWith('#'));
  const embedded=!document.querySelector('script[src="review.js"]');
  if(embedded && external.length) return external.map(el=>el.outerHTML).join(' ');
  if(!document.querySelector('[data-theme-toggle]') || !document.querySelector('#statusbar')) return 'missing shell';
  const old=KRTheme.get();
  KRTheme.set('light'); const light=getComputedStyle(document.body).backgroundColor;
  KRTheme.set('dark'); const dark=getComputedStyle(document.body).backgroundColor;
  KRTheme.set(old);
  return light==='rgb(228, 232, 237)' && dark==='rgb(20, 23, 28)';`],
```

The `embedded` condition applies asset closure to the **generated single-file report** and preserves development `ui/review.html`, which intentionally uses local external assets. Shell/theme assertions run in both.

- [ ] **Step 2: Prepare a reproducible Thermal_Camera report without network access.** Before Task 1 execution, preserve the baseline report and screenshots in the same session scratchpad; that is a prerequisite for honest before/after proof. The known input report `/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/3d/ci3d.html` must be inspected to confirm its project is Thermal_Camera before using it. Otherwise generate through the existing local review workflow on the private test repo; never use the Aux board for committed/evidence screenshots. Use Python to transplant the existing generated payload into the current template, preserving compressed blobs and 3D data exactly:

```sh
export PROOF_DIR=/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/stage1-proof
mkdir -p "$PROOF_DIR"
python3 -I - "$PROOF_DIR" <<'PY'
from pathlib import Path
import re, runpy, sys
root=Path('/Users/cameron/Code/kicad-review-worktrees/ui-redesign')
source=Path('/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/3d/ci3d.html')
html=source.read_text(encoding='utf-8')
payload=next((s for s in re.findall(r'<script>(.*?)</script>',html,re.S)
              if re.match(r'\s*(?:window\.)?REVIEW_DATA\s*=',s)),None)
if not payload or 'Thermal_Camera' not in payload: raise SystemExit('Need generated Thermal_Camera input report')
api=runpy.run_path(str(root/'kicad_review.py'))
out=Path(sys.argv[1]); (out/'after.html').write_text(api['inline_page'](payload),encoding='utf-8')
if not (out/'before.html').exists(): (out/'before.html').write_text(html,encoding='utf-8')
PY
```

If the source has a nonmatching payload tag, inspect its exact data assignment and correct the extraction rather than evaluating untrusted HTML. Never concatenate arbitrary scripts from a report into tests.

- [ ] **Step 3: Run full matrix on development and fully embedded reports.**

```sh
python3 test_kicad_review.py
node --test ui/theme.test.mjs
node --import ./site/css-loader.mjs --test site/test.mjs
CHECK_PORT=9357 node ui/check.mjs
CHECK_PORT=9358 node ui/check.mjs --dark
CHECK_PORT=9357 node ui/check.mjs 'Stage 1' --page "$PROOF_DIR/after.html" --width 1600 --shot "$PROOF_DIR/after-light.png"
CHECK_PORT=9358 node ui/check.mjs 'Stage 1' --page "$PROOF_DIR/after.html" --width 1600 --dark --shot "$PROOF_DIR/after-dark.png"
CHECK_PORT=9357 node ui/check.mjs '3D theme switch' --page "$PROOF_DIR/after.html"
CHECK_PORT=9358 node ui/check.mjs '3D theme switch' --page "$PROOF_DIR/after.html" --dark
```

Expected: all tests PASS with no console exceptions; the 3D report's two theme tests must not skip. Test order mutates fixture data, so use a separate clean page for the final screenshots; the harness navigates anew before each check. The final `Stage 1 offline asset closure and shell proof` check uses real data without fabricated counts. Arrange it last among the Stage 1 checks.

- [ ] **Step 4: Prove real browser behavior beyond VM.** Use Chrome DevTools / the existing CDP harness (no new browser dependency). Block network using `Network.enable` plus `Network.emulateNetworkConditions({offline:true,latency:0,downloadThroughput:0,uploadThroughput:0})` while opening `file://` after.html; verify no network requests, zoom icon visibility, theme toggle, selection, Copy link fallback, hash round trip and lazy 3D. For actual persistence, open a local HTTP-served report, switch light, reload and verify light; clear `kr.theme`, emulate OS light, reload and verify **dark**. Use a pre-navigation script that replaces `localStorage.getItem`/`setItem` with throwing functions to verify normal controls under denied storage. On the site signed-out and shared/review wrapper pages, use Tab and Space/Enter on theme controls; verify both report and wrapper update, hash/camera unchanged, and unrelated `postMessage` sources do nothing. Keep report sandbox and both CSP strings unchanged.

The local site needs the owner's `.dev.vars`; do not create credentials or change permissions. If credentials are unavailable, render the actual pages through `site/pages.js` with the existing Node loader and serve those strings on loopback for shell proof; authenticated APIs are not part of Stage 1. For the sandbox test, serve the real inlined report in an iframe with the existing sandbox attribute and `reportCsp` header, not an unsandboxed surrogate.

Capture clean before/after report **board and schematic** views in both themes at 1600×1000, a wrapper page in both themes, and signed-out site in both themes. The baseline has no user toggle: set its original theme with OS media for the before screenshots. Compare shell density, readable tabs, X/Y position, colours, focus and icon clarity against `/Users/cameron/Code/kicad-review-ui-reference/kicad/pcb-01-default.png` and `sch-01-default.png`, and the design-system mockup. Stage 1 is not expected to reproduce KiCad geometry, grid or Appearance; do not mark their absence as Stage 1 failure. Do not put the private reference images in git or public PR attachments.

- [ ] **Step 5: Close the gate and commit the check.** Return command outcomes, non-skipped 3D proof, and absolute image paths in the executor response. Fix any Stage 1 regression before declaring complete, including minor focus/contrast/overflow issues; do not defer those to later plans.

```sh
git add ui/checks.mjs
git commit -m "test(ui): prove token shell and offline theme integration"
```

## Acceptance checklist

- [ ] Dark default is independent of OS, valid stored `kr.theme` restores before first styled paint, invalid/blocked storage stays usable.
- [ ] Report, signed-out/error pages, authenticated wrapper and shared wrapper consume one token file and one theme script.
- [ ] Actual sandboxed iframe and parent agree without reload, new permissions, or cross-window message spoofing.
- [ ] Existing CSS token/selector consumers and deep links remain working; all existing browser assertions retain their behavior coverage.
- [ ] KiCad zoom icons use the actual source artwork, both palettes work, each icon button has a name/title, all `<use>` references are local.
- [ ] `ui/icons/LICENSE` includes authors, source, modifications and full CC-BY-SA text; `NOTICE` cites numeric colour data without copying GPL code.
- [ ] At 1600 px every right-dock tab is legible/clickable/keyboard-reachable, with 999 counts and Parts/Threads present.
- [ ] Status bar shows correct absolute X/Y mm for both Side panes, resets between views, and never reports a stale 3D value.
- [ ] Generated report works offline, including lazy 3D and explicit theme changes; no external asset URLs or network requests.
- [ ] Real Thermal_Camera before/after images in both themes were reviewed against KiCad references; private data stayed outside git.
