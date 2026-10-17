# Stage 3: Report Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the existing SVG report inside dense CAD chrome with a top comparison toolbar, left navigator, right dock, live coordinate status bar, and accessible shortcut sheet, without changing report semantics.

**Architecture:** Keep `S`, `MODES`, SVG stacks, selection, pin placement, and hash encoding intact. Move existing DOM roots into a grid shell rather than replacing their controllers; add status and shortcut controllers inside `review.js`, so Python's existing single-file inliner needs no new asset discovery. Stage 4 owns Appearance, grid rendering, units switching, and KiCad input expansion; Stage 5 owns mark-style behavior.

**Tech Stack:** Vanilla JavaScript, CSS custom properties from Stage 1, inline SVG icons from Stage 1, native HTML dialog, existing Chrome/CDP checks, Python standard-library report inliner.

**Spec:** `docs/superpowers/specs/2026-10-14-ui-redesign-design.md`, especially decisions, Chrome and site, Stages 3–6, and Testing.


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
- No feature implementation until plan approval. Execute in the approved worktree, not the owner's main checkout.
- Each UI-building task uses a **general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling** and returns screenshots in both themes. Inside the change viewer, KiCad references win over skill suggestions.
- Every stage ends with browser proof: before/after screenshots in both themes on Thermal_Camera, compared to the reference shots. Evidence stays in the session scratchpad, never includes committed private design screenshots.

## Review Focus

1. Different-sized Side panes, page offsets, and pan/zoom must report drawing millimetres, not CSS pixels; test both panes in Task 3.
2. A delayed pointer frame after a project/view change must not resurrect another drawing's coordinates or click origin; test view switches and missing renders in Task 3.
3. Long translated/user-provided labels, Parts tables, and a 1600 px viewport must not clip dock tabs or force the canvas offscreen; test sizing and escaped names in Task 1.
4. Shortcut sheet opened during selection or pin placement must trap focus and close without clearing the selection or consuming text entry shortcuts; test real Escape and focus restoration in Task 4.
5. Offline/old reports with no parts, no threads, no 3D, or unavailable localStorage must retain usable controls and truthful empty states; test absent capabilities in Task 1 and blocked storage in Task 2.

---

## Scope, sources, and contracts

Repository root for execution: `/Users/cameron/Code/kicad-review-worktrees/ui-redesign`. Run commands there unless stated otherwise. Source line numbers below describe the planning baseline; locate functions by name after Stage 1 lands.

Read before execution:

- `/Users/cameron/Code/kicad-review-ui-reference/draft/design-system.md`, sections 4, 5.1–5.5, 5.9, and Report screen; `/Users/cameron/Code/kicad-review-ui-reference/draft/mockup.html`.
- `/Users/cameron/Code/kicad-review-ui-reference/kicad/pcb-01-default.png` and `sch-01-default.png`: compact horizontal toolbar, squared dock boundaries, and bottom Z / X Y / dx dy dist / grid / units. Do not copy their private artwork into the repository.
- `/Users/cameron/Code/kicad-review-ui-reference/draft/render-eval.md`: SVG layers have no reliable object identity. This stage does not attempt per-object recolouring or a new renderer.
- Read-only KiCad 10 source root: `/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/ui-research/kicad-source`. `pcbnew/pcb_base_frame.cpp:790-813` establishes absolute X/Y, relative dx/dy and Euclidean distance; `common/eda_draw_frame.cpp:865-870` establishes `Z %.2f`. These are behavior/format references, not code to copy. Our Z is explicitly `S.z / PX`, the existing viewer's normalized zoom, not KiCad's internal zoom factor.

Execution order: capture Task 5 Step 2's baseline evidence first, then execute Tasks 1–4, then finish Task 5. This avoids reconstructing old files after implementation.

Precondition: Stage 1 tokens, icon sprite/license, and theme bootstrap are accepted and its existing checks are green. Keep its theme implementation and persistence; relocate its control, do not create a second theme subsystem. The design draft's `theme` storage key and delta-from-selection suggestion lose to the binding brief: use `kr.theme` and **last click** as delta origin.

File responsibilities (no new runtime files):

- `ui/review.html`: static shell roots, status cells, shortcut dialog. Preserve exact adjacent CSS links and script tags consumed by `kicad_review.py:inline_page` at lines 1909–1922.
- `ui/review.css`: grid shell and dense chrome only. Existing drawing filters, world transforms, and 3D CSS remain intact.
- `ui/review.js`: existing renderers plus small chrome helpers. No changes to the serialized camera or data format.
- `ui/checks.mjs`: append checks; never delete, weaken, or rewrite an existing check to accept a regression.

Stable DOM roots/selectors remain `#hdr`, `#modes [data-mode]`, `#app`, `#nav`, `#proj`, `#layers [data-layer]`, `#stage`, `#panel [data-tab]`, `#zoombar .goto`, `#zoombar [data-act=copy]`, `#zoombar [data-act=fit]`, and `#zoombar [data-z]`. `review3d.js:21,50` owns `#zoombar` camera controls and replaces its contents; it must remain a real connected root.

Stage boundaries:

- Mode labels are exactly **Side / Overlay / Wipe / Blend / Changes only**. Keep hash/internal mode `semantic`; never rename it to `changes`.
- Keep all 3D/library views reachable in the navigator. 3D is not a sixth comparison mode. Preserve disabled Wipe in 3D and existing 3D Blend controls.
- Mark style is a visibly disabled, explained control, not a fake working toggle. Stage 5 replaces it with functioning Outline/Recolour behavior.
- Right dock shows Changes, Checks, Parts, Threads, with disabled unavailable tabs. No visible Appearance tab until Stage 4; insertion point is the first child of the tablist.
- No grid is drawn yet. Status says `grid off` rather than claiming an active grid. Stage 4 supplies board grid state; Stage 6 supplies schematic grid. Units are read-only `mm` here.
- Preserve today's left-drag/click/right-click semantics. Do not introduce Stage 4 hotkeys or right-drag pan while right-click still creates threads.

### Task 1: Dock the existing report without replacing its content controllers

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return dark and light screenshots.

**Files:**
- Modify: `ui/review.html:11-18`
- Modify: `ui/review.css:2-38,60-63,84-102,128-137`
- Modify: `ui/review.js:128-150,734-785`
- Test: `ui/checks.mjs`

**Interfaces:**
- Consumes: `renderNav(): void`, `renderLayers(): void`, `renderPanel(): void`, existing `data-view`, `data-layer`, `data-tab` click contracts.
- Produces: `#toolbar` containing existing `#modes` and `#zoombar`; `#panel-tabs` tablist followed by `#panel-body`; `setDock(name: 'nav'|'panel', open: boolean): void`. Tabs retain their `data-tab` and focus restoration selectors.

- [ ] **Step 1: Append failing layout and capability checks.** Add tuples before the end of `CHECKS`.

```js
["chrome docks preserve space at 1600px", "", `
  document.documentElement.style.width = "1600px";
  document.body.style.width = "1600px";
  renderPanel();
  const app = document.querySelector("#app"), stage = document.querySelector("#stage");
  const tabs = [...document.querySelectorAll("#panel-tabs [data-tab]")];
  const bounds = document.querySelector("#panel-tabs")?.getBoundingClientRect();
  return app.getBoundingClientRect().width <= 1600 && stage.clientWidth >= 600 &&
    tabs.map(t => t.dataset.tab).join(",") === "changes,checks,parts,threads" &&
    tabs.every(t => { const r=t.getBoundingClientRect(); return r.left >= bounds.left && r.right <= bounds.right + 1; })
    || "dock tabs clipped or canvas squeezed";`],
["chrome absent Parts and Threads stay explained", "", `
  delete proj().parts; S.threads = null; S.issues = null; S.t = "changes";
  renderPanel();
  return ["parts", "threads"].every(name => {
    const b = document.querySelector('#panel [data-tab="' + name + '"]');
    return b?.disabled && !!b.title;
  }) && document.querySelector("#panel-body") !== null;`],
["chrome navigator escapes long project and sheet names", "", `
  proj().name = "<img src=x onerror=alert(1)>" + "Long".repeat(40);
  proj().sheets[0].name = "<script>bad</script>" + "Long".repeat(40);
  renderNav();
  const nav = document.querySelector("#nav");
  return !nav.querySelector("img,script") && nav.scrollWidth <= nav.clientWidth + 1
    && !!nav.querySelector("#proj") && !!nav.querySelector("[data-view]");`],
```

- [ ] **Step 2: Run the red checks.**

Run: `CHECK_PORT=9362 node ui/check.mjs 'chrome docks'`

Expected: FAIL because `#panel-tabs` does not exist. Run the other two filters individually; missing shell/capability behavior must fail, not skip.

- [ ] **Step 3: Move roots into the shell and add dense layout.** Replace the shell HTML with the following, keeping filter SVG and script tags in their existing order below it. Stage 1's sprite remains embedded once.

```html
<header id="hdr"></header>
<div id="toolbar" role="toolbar" aria-label="Review tools">
  <button type="button" data-dock="nav" aria-controls="nav" aria-expanded="false" title="Projects, sheets and layers">Navigator</button>
  <div id="modes" role="radiogroup" aria-label="Comparison mode"></div>
  <div id="change-nav" role="group" aria-label="Change navigation">
    <button type="button" data-step="-1" aria-label="Previous change" title="Previous change (k)">Previous</button>
    <button type="button" data-step="1" aria-label="Next change" title="Next change (j)">Next</button>
  </div>
  <div id="zoombar" role="group" aria-label="View"></div>
  <button type="button" id="mark-style" disabled title="Mark styles become available with the board diff renderer">Marks: Outline</button>
  <span id="theme-slot"></span>
  <button type="button" id="shortcuts-open" aria-haspopup="dialog" aria-controls="shortcuts" title="Keyboard shortcuts (?)">?</button>
  <button type="button" data-dock="panel" aria-controls="panel" aria-expanded="false" title="Changes, checks, parts and threads">Inspector</button>
</div>
<div id="app">
  <nav id="nav" aria-label="Projects, sheets and layers"></nav>
  <main id="stage" aria-label="Drawing"></main>
  <aside id="panel" aria-label="Review inspector"></aside>
</div>
<footer id="statusbar" aria-label="Drawing status"></footer>
```

Replace superseded shell rules rather than adding an override pile. Keep drawing rules (`.world`, `.stack`, filters, `.vp`, `.marker`) unchanged. Add:

```css
:root { --nav-w:220px; --panel-w:320px; }
body { margin:0; height:100dvh; overflow:hidden; display:grid;
  grid-template-rows:32px 32px minmax(0,1fr) 24px;
  background:var(--bg); color:var(--text); font:13px/1.4 var(--font-ui); }
#hdr { display:flex; align-items:center; gap:8px; padding:0 8px;
  flex-wrap:nowrap; min-width:0; overflow:hidden; background:var(--surface-2);
  border-bottom:1px solid var(--line); }
#hdr > .muted { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#toolbar { display:flex; align-items:center; gap:4px; min-width:0; padding:0 8px;
  overflow-x:auto; background:var(--surface-2); border-bottom:1px solid var(--line); }
#toolbar > *, #modes > *, #zoombar > * { flex-shrink:0; }
#modes, #zoombar, #change-nav { display:flex; align-items:center; gap:4px;
  padding:0; border:0; background:transparent; }
#toolbar button, #toolbar input { box-sizing:border-box; height:24px; font:12px var(--font-ui);
  color:var(--text); background:var(--surface-2); border:1px solid var(--line-strong);
  border-radius:3px; padding:0 6px; }
#toolbar button:hover:not(:disabled) { background:var(--surface-3); }
#toolbar button:disabled { opacity:.45; }
#toolbar [aria-checked=true] { background:var(--surface-sel);
  box-shadow:inset 0 -2px var(--accent); font-weight:500; }
#toolbar input.goto { width:112px; max-width:none; }
#zoombar .pct { min-width:40px; font:11px var(--font-mono); }
#zoombar .copyfield { width:180px; font-family:var(--font-mono); }
#app { position:relative; display:grid;
  grid-template-columns:var(--nav-w) minmax(0,1fr) var(--panel-w); min-height:0; overflow:hidden; }
#nav, #panel { min-width:0; min-height:0; background:var(--surface); }
#nav { overflow:auto; padding:8px; border-right:1px solid var(--line); }
#panel { display:flex; flex-direction:column; overflow:hidden; border-left:1px solid var(--line); }
#panel-tabs { display:flex; flex:none; height:28px; min-width:0;
  background:var(--surface-2); border-bottom:1px solid var(--line); }
#panel-tabs [role=tab] { flex:1 1 0; min-width:0; padding:0 4px; border:0;
  border-radius:0; font-size:12px; white-space:nowrap; background:transparent; color:var(--muted); }
#panel-tabs [role=tab][aria-selected=true] { color:var(--text); background:var(--surface);
  box-shadow:inset 0 -2px var(--accent); }
#panel-tabs .tab-count { font:10px var(--font-mono); }
#panel-tabs [role=tab]:disabled { opacity:.45; }
#panel-body { flex:1; min-height:0; overflow:auto; padding-top:8px; }
.tree button, #layers label { box-sizing:border-box; min-height:24px; font-size:12px; }
.tree button { padding-left:calc(8px + var(--depth,0)*24px); }
.tree button[aria-current=true] { background:var(--surface-sel); }
.projsel, .projsel select { min-width:0; max-width:100%; }
.card, .thread-card, .check, .check-group { border-radius:0; }
.card, .thread-card { margin-bottom:0; border-width:0 0 1px; padding:6px 8px; }
.chip.removed, .badge.removed, .chip-filter.removed { border-style:dashed; }
.chip.modified, .badge.modified, .chip-filter.modified { border-style:dotted; }
#panel .parts-table th { height:24px; position:sticky; top:0; background:var(--surface-2); }
#panel .parts-table th, #panel .parts-table td { padding:4px 8px; }
#panel .parts-scroll { overflow:auto; }
:focus-visible { outline:2px solid var(--focus); outline-offset:-2px; }
#toolbar [data-dock] { display:none; }
@media(max-width:899px) {
  #app { grid-template-columns:minmax(0,1fr); }
  #nav, #panel { display:none; position:absolute; top:0; bottom:0; z-index:var(--z-popover,20);
    width:min(320px,85vw); box-shadow:var(--shadow-pop); }
  #nav { left:0; box-sizing:border-box; }
  #panel { right:0; }
  #nav.dock-open { display:block; } #panel.dock-open { display:flex; }
  #toolbar [data-dock] { display:block; }
}
body.shot #hdr, body.shot #toolbar, body.shot #nav, body.shot #panel,
body.shot #statusbar { display:none; }
body.shot #app { grid-template-columns:1fr; } body.shot { grid-template-rows:1fr; }
```

Remove the old `#app:has([data-tab=parts]...)` width expansion. Parts gets an internal horizontal scroller instead; a Parts table must not steal 55% of the viewport.

In `renderNav`, change headings `Project` to `Projects` and `Schematic` to `Sheets`; preserve `#proj`, nested sheet lists, Board, Libraries, Layers and their escaped data. Add `aria-label="Project"` to `#proj`. Use the existing sheet parent nesting, not a second hierarchy model. The selector is a native project navigator; sheet rows remain nested lists with native buttons. Do not assign `role=tree` without implementing tree keyboard behavior.

In `renderPanel`, replace only the tab strip expression and wrap the existing body expression. Leave the body renderer expressions and every event binding unchanged:

```js
const tab = (name, label, enabled, count = "") =>
  `<button type="button" role="tab" id="tab-${name}" data-tab="${name}"
    aria-controls="panel-body" aria-selected="${S.t === name}"
    tabindex="${S.t === name ? 0 : -1}" ${enabled ? "" : `disabled title="${name === 'parts' ? 'Parts data was not included in this report' : 'Threads require the connected review site'}"`}>
    ${label}${count === "" ? "" : ` <span class="tab-count">${count}</span>`}</button>`;
const tabs = `<div id="panel-tabs" role="tablist" aria-label="Inspector">
  ${tab("changes", "Changes", true)}${tab("checks", "Checks", true)}
  ${tab("parts", "Parts", !!p.parts)}${tab("threads", "Threads", !!(S.threads || S.issues))}</div>`;
```

Keep counts in each panel's body/heading rather than cramming four counters into a 320 px strip. Assign `#panel.innerHTML = tabs + '<div id="panel-body" role="tabpanel" aria-labelledby="tab-' + S.t + '">' + body + '</div>';` where `body` is the existing `S.t === 'threads' ? ...` expression. Stage 4 inserts Appearance before Changes in `#panel-tabs` and extends `valid()` then, not now.

Tab bindings gain a disabled guard and arrow/Home/End selection (retain the existing focus restoration at the end of `renderPanel`):

```js
for (const t of document.querySelectorAll('#panel [role=tab]')) {
  t.onclick = () => { if (t.disabled) return; S.wantThreads = false; S.t = t.dataset.tab; renderPanel(); saveHash(); };
  t.onkeydown = e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const ts = [...document.querySelectorAll('#panel [role=tab]:not(:disabled)')];
    const i = ts.indexOf(t), n = e.key === "Home" ? 0 : e.key === "End" ? ts.length - 1
      : (i + (e.key === "ArrowRight" ? 1 : -1) + ts.length) % ts.length;
    ts[n].focus(); ts[n].click();
  };
}
function setDock(name, open) {
  document.getElementById(name).classList.toggle('dock-open', open);
  document.querySelector(`[data-dock="${name}"]`).setAttribute('aria-expanded', String(open));
}
for (const b of document.querySelectorAll('[data-dock]')) b.onclick = () => {
  const open = b.getAttribute('aria-expanded') !== 'true';
  setDock(b.dataset.dock === 'nav' ? 'panel' : 'nav', false);
  setDock(b.dataset.dock, open);
};
```

- [ ] **Step 4: Verify green and inspect both themes.**

Run: `CHECK_PORT=9362 node ui/check.mjs 'chrome'`

Expected: all three new checks PASS. Run `CHECK_PORT=9362 node ui/check.mjs` and `CHECK_PORT=9362 node ui/check.mjs --dark`; all pre-existing checks must pass. Capture dark/light chrome shots into the session scratchpad. Inspect 1600 px tabs and Parts internal scrolling, not only the default 1920 px shot.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.html ui/review.css ui/review.js ui/checks.mjs
git commit -m "feat(ui): dock the SVG report in a compact CAD shell"
```

### Task 2: Make the top toolbar a truthful, keyboard-accessible command surface

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return dark and light screenshots.

**Files:**
- Modify: `ui/review.js:334-390,825-845` and Stage 1 theme-control placement
- Modify: `ui/review.css` toolbar rules
- Test: `ui/checks.mjs`

**Interfaces:**
- Consumes: `step(dir: number): void`, `fit(): void`, `setT(t: object): void`, `renderModes(): void`, `renderZoombar(): void`, Stage 1 theme button and its existing handler.
- Produces: exact mode labels mapped to unchanged mode IDs, roving radio keyboard behavior, top navigation buttons bound to `step`, unchanged copy/paste/3D camera controls, disabled `#mark-style`.

- [ ] **Step 1: Append failing toolbar tests.**

```js
["chrome toolbar modes keep legacy IDs and radio focus", "", `
  const bs = [...document.querySelectorAll('#modes [data-mode]')];
  if (bs.map(b => b.textContent.trim()).join('|') !== 'Side|Overlay|Wipe|Blend|Changes only') return 'labels';
  const overlay = bs.find(b => b.dataset.mode === 'overlay'); overlay.focus();
  overlay.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
  return S.m === 'wipe' && document.activeElement?.dataset.mode === 'wipe'
    && document.activeElement.getAttribute('aria-checked') === 'true'
    && document.querySelector('#toolbar #zoombar') !== null
    && document.querySelector('#mark-style').disabled;`],
["chrome theme survives blocked storage", "", `
  const old = Storage.prototype.setItem;
  try {
    Storage.prototype.setItem = () => { throw new DOMException('blocked','SecurityError'); };
    const b = document.querySelector('#theme-slot button');
    if (!b) return 'missing theme control';
    const before = getComputedStyle(document.body).backgroundColor; b.click();
    await new Promise(r => requestAnimationFrame(r));
    const changed = before !== getComputedStyle(document.body).backgroundColor;
    b.click(); return changed;
  } finally { Storage.prototype.setItem = old; }`],
```

- [ ] **Step 2: Run red.**

Run: `CHECK_PORT=9363 node ui/check.mjs 'chrome toolbar'`

Expected: FAIL on labels/radio behavior. Existing `[data-mode]` focus check remains unchanged.

- [ ] **Step 3: Patch existing controllers, not comparison rendering.**

```js
const MODE_NAMES = { side: 'Side', overlay: 'Overlay', wipe: 'Wipe', blend: 'Blend', semantic: 'Changes only' };
```

In `renderModes`, add to every mode button `role="radio"`, `aria-checked="${S.m === m}"`, `tabindex="${S.m === m ? 0 : -1}"`; retain `aria-pressed`, existing `aria-disabled` on Wipe in 3D, and all existing click/blend handlers. Add after binding mode clicks:

```js
for (const b of document.querySelectorAll('#modes [data-mode]')) b.onkeydown = e => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const bs = [...document.querySelectorAll('#modes [data-mode]:not([aria-disabled=true])')];
  const i = bs.indexOf(b), n = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1
    : (i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
  bs[n].focus(); bs[n].click();
};
for (const b of document.querySelectorAll('[data-step]')) b.onclick = () => step(Number(b.dataset.step));
```

Remove only the old `j / k` hint and flexible spacer from `renderZoombar`'s markup; keep `.pct`, zoom buttons, Fit, Copy link, and `.goto` plus every handler. Give `.goto` `aria-label="Go to saved review position"`. Add titles `Zoom out`, `Zoom in`, `Fit drawing (f)`, and `Copy current review link`. Keep the special 3D `Review3D.cameraBar()` branch: its eight camera buttons are allowed extra toolbar content, not extra comparison modes. The horizontally scrollable toolbar makes them reachable.

Move Stage 1's existing theme button node into `#theme-slot` **after `renderHeader()`**, since `renderHeader` rebuilds its contents. Preserve its existing handler and theme synchronization. If Stage 1 currently creates the theme button on every header render, move that creation/ownership to the static slot, rather than retaining an orphaned duplicate. The exact persistence logic must remain:

```js
// Within the existing Stage 1 theme handler, never outside its guarded storage write:
try { localStorage.setItem('kr.theme', document.documentElement.dataset.theme); } catch {}
```

No new theme bootstrap is introduced in this task. Keep Stage 1's interface contract for wrapper theme messages and renderer observers. Use existing licensed sprite symbols for icon-only zoom/fit/previous/next buttons; retain their `aria-label`, title and `data-*` attributes. Keep `Copy link` as text because existing checks assert its completion text and reset.

- [ ] **Step 4: Run green and regression suite.**

Run: `CHECK_PORT=9363 node ui/check.mjs 'chrome toolbar'`; `CHECK_PORT=9363 node ui/check.mjs 'chrome theme'`; then full harness in both themes.

Expected: PASS, including existing mode-focus, Copy link, pasted-position, Wipe, Blend and 3D camera checks. Return screenshots showing each selected mode and 3D toolbar in both themes. Confirm no new mark behavior or persistence is claimed.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.js ui/review.css ui/checks.mjs
git commit -m "feat(ui): consolidate report comparison and view controls"
```

### Task 3: Add rAF-coalesced millimetre coordinates and click-relative measurements

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return dark and light screenshots.

**Files:**
- Modify: `ui/review.html` statusbar contents
- Modify: `ui/review.js:250-282,448-458,799-807` plus search/selection update sites
- Modify: `ui/review.css` statusbar rules
- Test: `ui/checks.mjs`

**Interfaces:**
- Consumes: `S.x/y` mm, `S.z` CSS px/mm, `PX = 4`, `.vp.getBoundingClientRect()`, existing `pickAt`, `step` selectors.
- Produces: `drawingPoint(vp: Element, clientX: number, clientY: number): {x:number,y:number}|null`; `queueStatus(): void`; `renderStatus(): void`; `statusPointer` transient state, never hash-serialized.
- Status IDs: `status-z`, `status-xy`, `status-delta`, `status-grid`, `status-units`, `status-change`, `status-message`. Coordinates are not live regions; only message is `role=status`.

- [ ] **Step 1: Append deterministic coordinate checks.**

```js
["status coordinates use each Side pane and camera mm", "m=side", `
  await draw(); setT({x:10,y:20,z:5});
  const panes=[...document.querySelectorAll('#stage .vp')];
  for (const vp of panes) {
    const r=vp.getBoundingClientRect();
    vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+r.width/2+15,clientY:r.top+r.height/2-20}));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(document.querySelector('#status-xy').textContent !== 'X 13.000 Y 16.000') return document.querySelector('#status-xy').textContent;
  }
  return document.querySelector('#status-z').textContent === 'Z 1.25';`],
["status click origin reports dx dy and Euclidean distance", "m=overlay", `
  await draw(); setT({x:100,y:200,z:10});
  let vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
  pickAt(vp,{clientX:r.left+r.width/2,clientY:r.top+r.height/2});
  vp=document.querySelector('#stage .vp'); r=vp.getBoundingClientRect();
  vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+r.width/2+30,clientY:r.top+r.height/2+40}));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return document.querySelector('#status-delta').textContent === 'dx 3.000 dy 4.000 dist 5.000'
    && document.querySelector('#status-units').textContent === 'mm';`],
["status discards queued pointer when view changes or render is absent", "", `
  await draw(); setT({x:10,y:20,z:5});
  const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
  vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+10,clientY:r.top+10}));
  S.v='sheet:/not-in-report'; await draw();
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return document.querySelector('#status-xy').textContent === 'X — Y —'
    && !/NaN|Infinity/.test(document.querySelector('#statusbar').textContent)
    && document.querySelector('#status-delta').textContent === 'dx — dy — dist —';`],
["status selection counter matches visible filtered change rows", "", `
  const row=proj().changes.find(r=>viewOf(r)&&currentView(viewOf(r)));
  if(!row) return 'skip'; await goTo(row.id); renderStatus();
  const rows=[...document.querySelectorAll('#panel .card[data-id]')];
  const i=rows.findIndex(e=>e.dataset.id===S.s);
  return document.querySelector('#status-change').textContent === 'Change '+(i+1)+'/'+rows.length;`],
```

- [ ] **Step 2: Run red.**

Run: `CHECK_PORT=9364 node ui/check.mjs 'status '`.

Expected: FAIL on missing status cells/helper, not false success from skipped fixtures.

- [ ] **Step 3: Implement transient status state and delegate pointer tracking.** Populate the static footer:

```html
<span id="status-z">Z —</span><span id="status-xy">X — Y —</span>
<span id="status-delta">dx — dy — dist —</span><span id="status-grid">grid off</span>
<span id="status-units">mm</span><span id="status-change">Change 0/0</span>
<span id="status-message" role="status" aria-live="polite">Ready</span>
```

Add the following after `PX` and before startup calls. The status key is project+view, not mode, so switching comparison mode preserves click origin on the same drawing.

```js
const statusPointer = { key: '', client: null, origin: null, frame: 0 };
const statusKey = () => JSON.stringify([S.p, S.v]);
function drawingPoint(vp, clientX, clientY) {
  if (!vp || !placed() || S.v === '3d' || String(S.v).startsWith('lib:')) return null;
  const r = vp.getBoundingClientRect();
  if (!r.width || !r.height || ![clientX,clientY].every(Number.isFinite)) return null;
  const x = S.x + (clientX-r.left-r.width/2)/S.z;
  const y = S.y + (clientY-r.top-r.height/2)/S.z;
  return [x,y].every(Number.isFinite) ? {x,y} : null;
}
function syncStatusView() {
  const key = statusKey();
  if (statusPointer.key !== key) {
    statusPointer.key = key; statusPointer.client = statusPointer.origin = null;
  }
}
function queueStatus() {
  if (statusPointer.frame) return;
  statusPointer.frame = requestAnimationFrame(() => { statusPointer.frame = 0; renderStatus(); });
}
function renderStatus() {
  syncStatusView();
  const set = (id, text) => { const e=document.getElementById(id); if(e && e.textContent !== text) e.textContent=text; };
  const client=statusPointer.client;
  const vp=client && [...document.querySelectorAll('#stage .vp')][client.pane];
  const p=client && client.key===statusKey() ? drawingPoint(vp,client.x,client.y) : null;
  const f=n => (Math.abs(n)<0.0005 ? 0 : n).toFixed(3);
  const valid2d=!!document.querySelector('#stage .vp:not(.view3d)') && placed()
    && S.v !== '3d' && !String(S.v).startsWith('lib:');
  set('status-z',valid2d ? 'Z '+(S.z/PX).toFixed(2) : 'Z —');
  set('status-xy',p ? 'X '+f(p.x)+' Y '+f(p.y) : 'X — Y —');
  const o=statusPointer.origin;
  set('status-delta',p&&o ? 'dx '+f(p.x-o.x)+' dy '+f(p.y-o.y)+' dist '+f(Math.hypot(p.x-o.x,p.y-o.y)) : 'dx — dy — dist —');
  set('status-grid', 'grid off'); set('status-units','mm');
  const rows=[...document.querySelectorAll('#panel .card[data-id]')];
  const i=rows.findIndex(e=>e.dataset.id===S.s);
  set('status-change','Change '+(i<0?0:i+1)+'/'+rows.length);
  set('status-message', S.v==='3d' ? '3D view' : valid2d ? 'Ready' : 'No drawing coordinates');
}
$('#app').addEventListener('pointermove', e => {
  const vp=e.target.closest?.('#stage .vp'); if (!vp) return;
  syncStatusView();
  statusPointer.client={key:statusKey(),pane:[...document.querySelectorAll('#stage .vp')].indexOf(vp),x:e.clientX,y:e.clientY};
  queueStatus();
});
$('#app').addEventListener('pointerleave', () => { statusPointer.client=null; queueStatus(); });
```

At the start of `pickAt(vp,e)`, before the pin-placement early return, record a point only for an eligible click:

```js
syncStatusView();
const point = drawingPoint(vp,e.clientX,e.clientY);
if (point) {
  statusPointer.origin=point;
  statusPointer.client={key:statusKey(),pane:[...document.querySelectorAll('#stage .vp')].indexOf(vp),x:e.clientX,y:e.clientY};
  queueStatus();
}
```

Do not set the origin on `pointerdown`; the existing `moved < 4` branch calls `pickAt` only for clicks, so a pan does not silently reset measurement. A thread-placement click does count as a click. Change-selection clicks that redraw the SVG retain the origin in drawing coordinates.

Add `queueStatus()` at the **start** of `apply()` before its early returns, at the start and completion of `draw()` (including its 3D return), at the end of `renderPanel()`, inside `markSelected()`, and after search handler replaces `.cards`. This covers camera, selection, filters, project/view, empty renders and 3D transitions without installing pointer listeners on every replaced viewport. A frame computes with the latest state, and `syncStatusView()` rejects stale client/origin data after view switches.

```css
#statusbar { display:flex; align-items:center; overflow-x:auto; white-space:nowrap;
  gap:0; background:var(--surface-2); border-top:1px solid var(--line);
  color:var(--muted); font:11px var(--font-mono); font-variant-numeric:tabular-nums; }
#statusbar > span { flex:none; padding:0 8px; border-right:1px solid var(--line); }
#status-xy, #status-delta { color:var(--text); }
#status-message { margin-left:auto; border-right:0; }
```

- [ ] **Step 4: Run green and regressions.**

Run: `CHECK_PORT=9364 node ui/check.mjs 'status '` and full harness in both themes.

Expected: all new checks PASS. Manually pan after a click, zoom under a stationary pointer, resize Side panes, switch sheets/projects/modes, select an unchanged sheet, and enter/leave 3D. X/Y must track the visible drawing point; dx/dy remain click-relative. Missing data shows em dashes, never stale values. No pointer updates modify hash keys or trigger SVG redraws. Return both-theme screenshots with nonzero X/Y and dx/dy/dist.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.html ui/review.css ui/review.js ui/checks.mjs
git commit -m "feat(ui): show live drawing coordinates and click measurements"
```

### Task 4: Add a shortcut sheet without stealing viewer or form input

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return dark and light screenshots.

**Files:**
- Modify: `ui/review.html` before asset scripts
- Modify: `ui/review.js:809-819` and shortcut setup before startup
- Modify: `ui/review.css` dialog rules
- Test: `ui/checks.mjs`

**Interfaces:**
- Consumes: existing `j/k/f/c/Escape/b` keydown controller and `THREADS_ON`; native dialog focus management.
- Produces: `openShortcuts(): void`, `closeShortcuts(): void`, `#shortcuts` dialog. `?` and button open it; Escape closes it without changing camera, selection, filters, or placement.

- [ ] **Step 1: Append failing dialog checks.**

```js
["shortcut sheet opens by question mark and preserves selection on Escape", "", `
  const before=S.s, placing=S.placing, opener=document.querySelector('#shortcuts-open'); opener.focus();
  opener.dispatchEvent(new KeyboardEvent('keydown',{key:'?',shiftKey:true,bubbles:true}));
  const d=document.querySelector('#shortcuts');
  if(!d?.open || !d.contains(document.activeElement)) return 'not modal/focused';
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await new Promise(r=>requestAnimationFrame(r));
  return !d.open && S.s===before && S.placing===placing && document.activeElement===opener;`],
["shortcut sheet ignores editors and describes only available keys", "", `
  const editor=document.createElement('div'); editor.contentEditable='true'; document.body.append(editor); editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}));
  const d=document.querySelector('#shortcuts'), ignored=!d.open; editor.remove();
  document.querySelector('#shortcuts-open').click();
  const text=d.textContent; const hash=encodeState();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}));
  const stayed=hash===encodeState(); closeShortcuts();
  return ignored && stayed && text.includes('j') && text.includes('k') && text.includes('f')
    && !text.includes('Ctrl+U') && !text.includes('PageDown');`],
```

- [ ] **Step 2: Run red.**

Run: `CHECK_PORT=9365 node ui/check.mjs 'shortcut sheet'`.

Expected: FAIL on missing dialog. Do not add a mock dialog solely for tests.

- [ ] **Step 3: Add native modal and early keyboard guards.**

```html
<dialog id="shortcuts" aria-labelledby="shortcuts-title">
  <form method="dialog"><header><h2 id="shortcuts-title">Keyboard shortcuts</h2>
    <button type="submit" aria-label="Close keyboard shortcuts" autofocus>Close</button></header></form>
  <dl>
    <dt>j / k</dt><dd>Next / previous listed change or finding</dd>
    <dt>↓ / ↑</dt><dd>Next / previous outside panel controls</dd>
    <dt>f</dt><dd>Fit drawing</dd>
    <dt>Escape</dt><dd>Cancel pin placement and clear selection; close this sheet first</dd>
    <dt>?</dt><dd>Open keyboard shortcuts</dd>
    <dt data-thread-shortcut>c</dt><dd data-thread-shortcut>Place a thread pin (connected review site)</dd>
    <dt>b</dt><dd>Swap Base / Head in 3D Blend</dd>
    <dt>Wheel</dt><dd>Zoom at pointer</dd>
    <dt>Left drag</dt><dd>Pan; click without dragging selects</dd>
    <dt data-thread-shortcut>Right click</dt><dd data-thread-shortcut>Start a thread (connected review site)</dd>
  </dl>
</dialog>
```

Do not advertise Stage 4 keys as working yet. Add those rows when their handlers ship.

```js
let shortcutOpener = null;
function openShortcuts() {
  const d=$('#shortcuts'); if(d.open) return;
  shortcutOpener=document.activeElement;
  for(const e of d.querySelectorAll('[data-thread-shortcut]')) e.hidden=!THREADS_ON;
  d.showModal();
}
function closeShortcuts() { if($('#shortcuts').open) $('#shortcuts').close(); }
$('#shortcuts-open').onclick=openShortcuts;
$('#shortcuts').addEventListener('close', () => {
  if(shortcutOpener?.isConnected) shortcutOpener.focus();
});
```

Put the following at the beginning of the existing global keydown handler, before its old modifier/form guard. Replace that old form guard with the expanded version below. Do not register a second global viewer keydown handler.

```js
if ($('#shortcuts').open) {
  if (e.key === 'Escape') { e.preventDefault(); closeShortcuts(); }
  return;
}
if (e.target.closest?.('input,select,textarea,[contenteditable]:not([contenteditable=false])')
    || e.metaKey || e.ctrlKey || e.altKey) return;
if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
```

Native `cancel` handles actual browser Escape; the keydown branch also gives deterministic programmatic key handling. Closing returns before existing viewer Escape clears `S.s`. Keep remaining shortcuts byte-for-byte unless adding a status refresh call from Task 3.

```css
#shortcuts { box-sizing:border-box; width:480px; max-width:92vw; max-height:85vh;
  overflow:auto; padding:16px; color:var(--text); background:var(--surface);
  border:1px solid var(--line-strong); border-radius:6px; box-shadow:var(--shadow-pop); }
#shortcuts::backdrop { background:var(--scrim); }
#shortcuts header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
#shortcuts h2 { margin:0; font:600 15px var(--font-ui); }
#shortcuts button { min-height:24px; font:12px var(--font-ui); color:var(--text);
  background:var(--surface-2); border:1px solid var(--line-strong); border-radius:3px; }
#shortcuts dl { display:grid; grid-template-columns:100px minmax(0,1fr); gap:8px; }
#shortcuts dt { font-family:var(--font-mono); } #shortcuts dd { margin:0; }
#shortcuts [hidden] { display:none; }
```

- [ ] **Step 4: Verify green and native keyboard behavior.**

Run: `CHECK_PORT=9365 node ui/check.mjs 'shortcut sheet'`, then full harness in both themes.

Expected: PASS. In the browser, select a change, open sheet, Tab/Shift+Tab through it, press Escape, verify focus returns and selected mark remains. Repeat while placing a pin, and with an editor focused; `?` must be typed rather than opening the sheet. Check existing `j/k/f/c/Escape/b` checks unchanged. Return both-theme modal screenshots.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.html ui/review.css ui/review.js ui/checks.mjs
git commit -m "feat(ui): add accessible review shortcut sheet"
```

### Task 5: Prove the whole SVG report offline and against KiCad reference chrome

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return before/after evidence in both themes. This task validates and fixes only Stage 3 regressions; no renderer work.

**Files:**
- Test: `ui/checks.mjs`
- Verify: `ui/review.html`, `ui/review.css`, `ui/review.js`, `kicad_review.py:inline_page`
- Evidence only: session scratchpad, never tracked private inputs or reference screenshots

**Interfaces:**
- Consumes: complete Stage 3 shell and all previous checks; `inline_page(data_js: str) -> str`.
- Produces: passing existing/new checks and four baseline/final Thermal_Camera screenshots, plus responsive and modal detail evidence.

- [ ] **Step 1: Add a browser proof check that selects Thermal_Camera explicitly.**

```js
["chrome browser proof Thermal_Camera", "", `
  const i=D.projects.findIndex(p=>p.name==='Thermal_Camera');
  if(i<0) return 'Thermal_Camera fixture required';
  await applyState({p:i,v:'board',m:'side'}); fit(); renderStatus();
  const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
  vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+r.width/2+12,clientY:r.top+r.height/2+8}));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return !!document.querySelector('#toolbar #zoombar') && !!document.querySelector('#panel-tabs')
    && document.querySelector('#status-xy').textContent.startsWith('X ')
    && !document.querySelector('#status-xy').textContent.includes('—')
    && !document.querySelector('#stage canvas') && !!document.querySelector('#stage svg');`],
```

The proof check sets an explicit theme from harness media **only for screenshot evidence**, so persisted storage cannot mask light evidence. The harness supplies media with `--dark`; all other checks retain Stage 1 production theme behavior. The proof asserts SVG, not a new WebGL canvas.

- [ ] **Step 2: Establish the pre-implementation evidence before Task 1 executes.**

Create baseline screenshots using the accepted Stage 1 report before changing chrome. Use the current harness with a board hash check, then capture using `--shot`; verify the displayed project really is Thermal_Camera. Use the following data inspection first:

```sh
python3 -I -c 'import json,pathlib; p=pathlib.Path("ui/sample/review-data.js"); s=p.read_text(); d=json.loads(s[s.index("=")+1:].strip().removesuffix(";")); print([(i,p["name"]) for i,p in enumerate(d["projects"])])'
```

The command reads relative to the repository root; it does not edit the sample. The planning baseline has `[(0, 'Second_Board'), (1, 'Thermal_Camera')]`. The existing check below opens project 1's board and fits every pane, providing the baseline composition. Set `SCRATCH` to the session scratchpad and run before Task 1:

```sh
CHECK_PORT=9366 node ui/check.mjs 'fit frames all drawn content in every pane' --shot "$SCRATCH/stage3-before-light.png"
CHECK_PORT=9366 node ui/check.mjs 'fit frames all drawn content in every pane' --dark --shot "$SCRATCH/stage3-before-dark.png"
```

If the sample no longer contains Thermal_Camera, use a local generated Thermal_Camera report from the private test checkout via `--page`; do not substitute the Aux board or commit a fixture from it. Capture baseline at 1920×1080 in both themes and additionally inspect at 1600 px. Verify actual chrome theme in each shot; if Stage 1's dark default overrides media, use its visible theme button before taking the light browser capture. Keep baseline generation outside git history; never checkout files over later tasks merely to obtain a baseline.

- [ ] **Step 3: Build an actual single-file report in the session scratchpad.**

Set `SCRATCH` to the current session scratchpad path, then run:

```sh
python3 -I - "$SCRATCH/stage3-report.html" <<'PY'
import pathlib, runpy, sys
root = pathlib.Path('/Users/cameron/Code/kicad-review-worktrees/ui-redesign')
module = runpy.run_path(str(root / 'kicad_review.py'), run_name='stage3_inline_probe')
data = (root / 'ui/sample/review-data.js').read_text()
html = module['inline_page'](data)
assert '<link rel="stylesheet" href="review.css">' not in html
assert '<script src="review.js">' not in html
assert 'id="statusbar"' in html and 'id="shortcuts"' in html
pathlib.Path(sys.argv[1]).write_text(html)
PY
```

Expected: report created with embedded CSS, data, JS, filters and icons; no external runtime assets. Do not modify Python's inliner just to accommodate changed whitespace; preserve the template contract in Task 1.

- [ ] **Step 4: Run complete regression suites and capture final browser evidence.**

Run, serially on a free allowed port (never 9341/9344):

```sh
python3 test_kicad_review.py
node --import ./site/css-loader.mjs --test site/test.mjs
CHECK_PORT=9366 node ui/check.mjs
CHECK_PORT=9366 node ui/check.mjs --dark
CHECK_PORT=9366 node ui/check.mjs --page "$SCRATCH/stage3-report.html"
CHECK_PORT=9366 node ui/check.mjs --dark --page "$SCRATCH/stage3-report.html"
CHECK_PORT=9366 node ui/check.mjs 'chrome browser proof Thermal_Camera' --shot "$SCRATCH/stage3-after-light.png"
CHECK_PORT=9366 node ui/check.mjs 'chrome browser proof Thermal_Camera' --dark --shot "$SCRATCH/stage3-after-dark.png"
```

Expected: zero failures; inspect any skips against baseline and require no newly skipped existing checks. The actual harness takes a **positional substring filter**, not `--name`. It loads `file://`, so these final report runs prove filesystem/offline asset use. Also disconnect browser network and exercise modes, link copy fallback, shortcut dialog and theme switch in the generated report. Ensure there are no CDN/font/image requests introduced by chrome.

Inspect screenshots side by side with `pcb-01-default.png` and `sch-01-default.png`. Compare toolbar density, squared docks, independent scrolling, mono coordinate fields, focus ring, and drawing area. Do not compare the Thermal_Camera drawing to private Aux geometry or demand Stage 4 colour/rendering fidelity. Additional manual matrix: 1600 px all four tabs, 899 px drawer toggles, long names, Parts overflow, unchanged drawing, 3D camera controls, library modes, disabled mark style, selected change and pin placement. No dock tab clips at 1600 px. Status always includes **X and Y**, not merely deltas.

- [ ] **Step 5: Commit only fixes/checks and deliver evidence paths.**

```sh
git add ui/review.html ui/review.css ui/review.js ui/checks.mjs
git commit -m "test(ui): prove CAD report chrome and offline behavior"
```

If no fixes beyond the new proof check were necessary, commit only `ui/checks.mjs`. Never stage screenshot directories, scratch reports, reference artwork, or private board files.

## Acceptance checklist

- [ ] Five mode labels only; legacy `m=semantic` and all hash keys round-trip unchanged.
- [ ] Existing SVG/3D/library selection, checking, parts lookup display, thread pins, copying and pasted links still work.
- [ ] Header 32 px, toolbar 32 px, controls 24 px, dock tabs 28 px, status 24 px; no new fonts or dependencies.
- [ ] Left navigator exposes Projects, Sheets, Board, Layers and optional Libraries/3D; right dock tabs fit at 1600 px.
- [ ] Status shows normalized Z, absolute X/Y mm, click-relative dx/dy/dist, truthful grid off, mm, and visible change n/N.
- [ ] Pointer status coalesces with rAF, stays out of live announcements and hashes, clears on view change, and does not redraw SVG.
- [ ] Theme control reuses Stage 1 `kr.theme` behavior; storage denial is harmless.
- [ ] Shortcut sheet works with mouse, keyboard, modal focus and Escape; future shortcuts are not falsely advertised.
- [ ] All original checks still run; new checks pass; Python/site suites pass; actual inlined report passes in both themes.
- [ ] Before/after browser evidence exists in both themes on Thermal_Camera; private reference images remain outside git.
