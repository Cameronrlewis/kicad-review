# Stage 5 — Diff on the Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render all five board comparison modes in WebGL, with accessible geometry marks, linked selection and pins, without breaking addresses or the offline report.

**Architecture:** Keep the existing report state, camera, change IDs, anchor protocol and SVG fallback. Add a small WebGL compositor over Stage 4's retained revision scenes; render diff masks from those same geometry buffers, not bounding boxes or SVG guesses. Appearance owns persistence; the compositor owns only disposable GPU resources and screen-space mark labels.

**Tech Stack:** Vanilla JavaScript, WebGL2/GLSL ES 3.00, CSS custom properties, Python stdlib, existing Node/CDP browser harness. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-14-ui-redesign-design.md`, especially “Diff on the board”, error handling and testing.


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
- Implement only after plan approval, on the existing UI implementation branch/worktree, never on main.
- Every UI-building task is assigned to a **general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling** and returns screenshots in both themes. Inside the change viewer, KiCad reference wins over skill suggestions.
- Preserve `semantic` as the URL/internal mode value; display **Changes only**. Do not rename hash values or add a second camera model.
- Rendering colour changes, mark toggles, wipe/blend movements and camera gestures must not rebuild scene vertex buffers.
- WebGL2 unavailable, missing geometry, allocation failure or context loss uses the existing SVG route with a status-bar notice. Do not replace the schematic or library renderer in this stage.

## Review Focus

1. A moved, removed or one-sided board must remain selectable and pinnable on the revision actually visible, including both sides of Wipe. Tests in Tasks 2, 5 and 7.
2. Hidden layers/nets, holes and overlapping footprints must not produce invisible hits, drill-hole hits or bbox-only hits. Tests in Tasks 1 and 5.
3. Repeated redraw, resize, project changes and context loss must not leak WebGL contexts, retain stale scenes or apply an old async result. Tests in Tasks 2 and 7.
4. Blocked/corrupt storage and custom canvas backgrounds must preserve other appearance fields and produce marks with at least 3:1 contrast. Tests in Tasks 3 and 4.
5. DPR 2, flipped view, extreme zoom and wipe endpoints must preserve CSS-pixel mark widths, pointer coordinates and pin alignment. Tests in Tasks 2, 3 and 5.

---

## Grounding and scope

Read these before implementation:

- Existing `ui/review.js`: `draw` 250–263, `apply` 272–282, modes 334–390, marks/picking 392–469, anchors 478–516. Current code is SVG; line numbers will move after Stages 3–4.
- Existing `ui/checks.mjs`: modes and blend 298–319, board layers 322–331, selection and non-colour marks 333–366; explicit-position address checks 50–63; cancelled wipe drag near 611. Retain every check name and assertion purpose.
- `kicad_review.py:inline_page` 1909–1922 and `test_kicad_review.py` 74 onward. Assets are ordinary scripts inlined into one HTML file; do not introduce dynamic imports.
- `~/Code/kicad-review-ui-reference/draft/design-system.md` and `mockup.html`. The mockup establishes dense controls, not a replacement for board colours. Binding spec overrides draft's incorrect storage example (`theme`): use `kr.theme`.
- `~/Code/kicad-review-ui-reference/draft/render-eval.md`: exported board SVG has no reliable per-object IDs. Recolour/picking must use retained geometry. Thermal_Camera has 185 tracks, 15 vias, 239 pads and 56 footprints; do not use a toy board alone for browser acceptance.
- Look at `~/Code/kicad-review-ui-reference/kicad/pcb-01-default.png`, `pcb-04-dim.png`, `pcb-05-hide.png`, `pcb-06-flip.png`, `pcb-07-active-bcu.png`. Preserve navy canvas, subdued inactive detail, layer-coloured copper and sharp marks. These private images stay outside git.
- KiCad 10 source clone, commit `3e051f88`, read-only: `common/settings/builtin_color_themes.h:160` defines PCB background `(0,16,35,1)` (`#001023`). Use Stage 4's credited colour data, not copied GPL code. Diff action colours are this project's design data, not KiCad defaults.

### File map

| File | Responsibility |
|---|---|
| `ui/board-diff.js` (new) | Render plan, compositor targets, five modes, screen-side routing, lifecycle |
| `ui/board-marks.js` (new) | Action colour selection, mask effects, glyph/word labels and mark configuration |
| `ui/board-gl.js` (Stage 4 file) | Existing retained draw/pick API; only narrow adapter additions if the agreed contract needs them |
| `ui/appearance.js` (Stage 4 file) | Validated mark-style field and non-destructive persistence |
| `ui/review.js` | Integrate board controller into existing draw/apply/pick/pin/selection paths |
| `ui/review.css`, `ui/review.html` | Toolbar control, board HUD and ordered classic-script tags |
| `ui/board-diff.test.mjs` (new) | Pure model/contrast/side-routing tests, using Node stdlib and VM |
| `ui/checks.mjs`, `ui/check.mjs` | Keep existing checks; add actual WebGL/pixel, offline, input and vision proof |
| `test_kicad_review.py`, `kicad_review.py` | Inline the two new assets and test zero external runtime references |

### Stage 4 boundary — agree before Task 1

Stage 4 supplies `window.BoardGL` and `window.Appearance` as classic-script globals. This is an explicit **consumed interface**, not permission to assume an unimplemented renderer. If Stage 4 used other spellings, add a thin local adapter in `board-gl.js`; do not build another parser or parallel state owner. The executors of Stages 4 and 5 must agree this table before either integrates their controller.

```js
// Camera values are mm and CSS px/mm, never scene µm or framebuffer pixels.
// Normalized Scene is Stage 4's decoded, retained scene, not REVIEW_DATA itself.
// Scene.objects includes leaf primitives and container identity metadata.
// All object keys are revision-local; changeIds contains existing cN IDs.
// A footprint's children inherit the footprint change ID where the diff is aggregate.
// bounds and anchor are mm; meshes remain Stage 4's µm buffers.
// Object = {key, uuid, kind, ref, layer, changeIds:string[], parentKey,
//           bounds:[x0,y0,x1,y1], anchor:[x,y], pickable:boolean}
// Scene = {revision:'base'|'head', objects:Object[], bounds:[x0,y0,x1,y1]}

BoardGL.decode(board) // Promise<{base:Scene|null, head:Scene|null}>; old reports => null
BoardGL.create(canvas, {onLost}) // Renderer; throws on unavailable WebGL2
// Renderer owns a single WebGL2 context, retained revision buffers and normal grid.
renderer.gl // WebGL2RenderingContext
renderer.setScenes({base, head}) // upload once when project/scene changes
renderer.resize(widthCSS, heightCSS, dpr) // no-op if unchanged
renderer.draw({revision, camera, appearance, target, clear, background,
               filter, override})
// target: null or {framebuffer, texture, width, height}; dimensions in device px
// clear:boolean, background:[r,g,b,a] (0..1), filter:(Object)=>boolean
// override:(Object, normalStyle)=>({color:[r,g,b], opacity:number})
// normalStyle includes current layer/net/object alpha and high-contrast policy.
// Renderer enforces appearance visibility before filter/override. Mask passes set
// opacity 1 only for objects whose effective normal opacity is >0. Mask passes
// omit grid/background/worksheet; all other passes keep Stage 4 semantics.
// draw uses ordinary source-over, unpremultiplied input colour; targets store
// premultiplied RGBA. It restores its own GL state on every invocation.
renderer.hits({revision, x, y, toleranceCSS, camera, appearance}) // Object[]
// Exact visible geometry, frontmost first, then smallest occupied area/key.
// Excludes pad/via drills, zone holes, hidden primitives and footprint empty bbox.
// Includes parent changeIds; containers are not independent bbox hit targets.
renderer.project([x,y], camera) // [xCSS,yCSS], includes appearance flip
renderer.unproject([xCSS,yCSS], camera) // [xMM,yMM], exact inverse, includes flip
renderer.dispose() // idempotent; deletes buffers/programs, releases listeners

Appearance.get() // validated object; includes background RGB and flip
Appearance.patch(patch) // shallow validated patch, persist entire merged object
Appearance.subscribe(listener) // returns unsubscribe; synchronous notification
// Existing layers/objects/nets/highContrast fields remain owned by Stage 4.
```

`renderer.draw` masks need a `mask:true` option to omit decorative primitives; add that one option in Task 1 if Stage 4 does not already have it. The compositor does not inspect or modify private vertex buffers. The draw callback is the extension point for revision/action subsets. `normalStyle.opacity === 0` always remains invisible, even in a mask pass.

**Produced controller contract used below:**

```js
BoardDiff.mount({stage, scenes, changes, state, appearance, onLost}) // Controller
// mount called only after stage is connected and state is fitted/restored.
controller.render()                 // synchronous draw from current S/appearance
controller.panes                   // [{vp, canvas, renderer, scenes, sides}]
controller.pick(vp, event, afterId)  // {id, object, side, point}|null
controller.point(vp, event)         // {point:[xMM,yMM], side:'base'|'head'}
controller.bounds(id, side)         // union geometry bounds mm, null if absent
controller.dispose()               // targets + renderers + observers + subscriptions
controller.readPixel(paneIndex, xCSS, yCSS) // Uint8Array(4), test/proof only on demand
```

Use one renderer/context per Side pane, one renderer for every other mode. Never create separate contexts per revision or per mark. Selection must render on the compositor after mode composition, not by changing revision colours.

### Task 1: Pin identity, rendering and geometry-pick contract

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots of the contract fixture.

**Files:**
- Create: `ui/board-diff.js`, `ui/board-diff.test.mjs`
- Modify: `ui/board-gl.js` (Stage 4 draw callback/mask adapter only)
- Modify: `ui/checks.mjs` (contract fixture checks)

**Interfaces:**
- Consumes: Stage 4 boundary above, existing `proj().changes` with `id/action/where`, and retained `Object.changeIds`.
- Produces: `BoardDiff.actionMap(changes)`, `BoardDiff.actionFor(object,map)`, `BoardDiff.sidesAt(mode,fraction,wipe,blend,scenes)` and `BoardDiff.pickFromHits(hits,afterId)`.

- [ ] **Step 1: Add failing pure tests.** Load classic scripts with VM instead of adding a bundler.

```js
// ui/board-diff.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({window: {}, console});
vm.runInContext(readFileSync(new URL('./board-diff.js', import.meta.url), 'utf8'), context);
const B = context.window.BoardDiff;
test('aggregate identities never collapse to reference alone', () => {
  const actions = B.actionMap([{id:'c1',action:'modified'}, {id:'c2',action:'removed'}]);
  assert.equal(B.actionFor({changeIds:['c1'],ref:'R1'},actions), 'modified');
  assert.equal(B.actionFor({changeIds:[],ref:'R1'},actions), null);
  assert.equal(B.pickFromHits([{changeIds:['c1']},{changeIds:['c2']}], 'c1').id, 'c2');
  assert.equal(B.pickFromHits([{changeIds:[]}], null), null);
});
test('wipe endpoints and one-sided scenes route to visible revisions', () => {
  const both = {base:{},head:{}};
  assert.equal(B.sidesAt('wipe',.2,.5,.5,both).join(','),'base');
  assert.equal(B.sidesAt('wipe',.8,.5,.5,both).join(','),'head');
  assert.equal(B.sidesAt('wipe',0,0,.5,both).join(','),'head');
  assert.equal(B.sidesAt('wipe',1,1,.5,both).join(','),'base');
  assert.equal(B.sidesAt('blend',.5,.5,0,both).join(','),'base');
  assert.equal(B.sidesAt('overlay',.5,.5,.5,{base:null,head:{}}).join(','),'head');
});
```

- [ ] **Step 2: Run failing tests.**

Run: `node --test ui/board-diff.test.mjs`
Expected: FAIL because `board-diff.js`/its exported model does not exist.

- [ ] **Step 3: Implement identity and side routing.** Use existing cN IDs, not a new diff-ID generator.

```js
(() => {
  const actionMap = rows => new Map(rows.map(r => [r.id,r.action]));
  const actionFor = (o, actions) => o.changeIds.map(id => actions.get(id)).find(Boolean) || null;
  function sidesAt(mode, fraction, wipe, blend, scenes) {
    const order = mode === 'wipe' ? [fraction < wipe || wipe === 1 ? 'base' : 'head']
      : mode === 'blend' && blend === 0 ? ['base'] : ['head','base'];
    return order.filter(side => scenes[side]);
  }
  function pickFromHits(hits, afterId) {
    const choices = [];
    for (const object of hits) for (const id of object.changeIds) {
      if (!choices.some(c => c.id === id)) choices.push({id, object});
    }
    if (!choices.length) return null;
    const i = choices.findIndex(c => c.id === afterId);
    return choices[(i + 1) % choices.length];
  }
  window.BoardDiff = {actionMap, actionFor, sidesAt, pickFromHits};
})();
```

In Stage 4 draw loop use the following ordering; keep its existing geometry draw call and uniforms. `visible`/`normal` below denote Stage 4's already-computed effective appearance result, not a new implementation of appearance.

```js
// Inside the existing per-object/range dispatch, after effective style resolution:
if (!visible || normal.opacity <= 0 || options.filter && !options.filter(object)) continue;
if (options.mask && !object.pickable) continue;
const style = options.override ? options.override(object, normal) : normal;
// Feed style.color and style.opacity into the existing uniform setters.
```

Add a browser contract check to `CHECKS` against Stage 4's synthetic ring/zone fixture: query hits at the hole centre, on its annulus and at a footprint's empty bbox corner. Assert respectively zero hits, expected child/parent ID and zero hits. Hide the object's layer and assert no hit. Use actual fixture geometry coordinates from Stage 4's fixture and `renderer.project`, not coordinates guessed from a photograph. If Stage 4 lacks this fixture, add a synthetic pad with outer radius 2 mm, drill radius 1 mm centred at `[10,10]` and a footprint containing only that pad; test points `[10,10]`, `[11.5,10]`, `[8,8]` with `toleranceCSS:0`.

- [ ] **Step 4: Run tests and browser contract check.**

Run: `node --test ui/board-diff.test.mjs` and `CHECK_PORT=9355 node ui/check.mjs 'board geometry contract'`
Expected: PASS; the browser check must not return `skip` on the geometry fixture. Include both-theme fixture screenshots.

- [ ] **Step 5: Commit.**

```sh
git add ui/board-diff.js ui/board-diff.test.mjs ui/board-gl.js ui/checks.mjs
git commit -m "feat: pin retained board diff and picking contract"
```

### Task 2: Compose Side, Overlay, Wipe, Blend and Changes only

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return mode contact sheets in both themes.

**Files:**
- Modify: `ui/board-diff.js`
- Modify: `ui/review.js:250-390` (board route, apply and shared divider)
- Modify: `ui/review.css:39-64`
- Test: `ui/board-diff.test.mjs`, `ui/checks.mjs`

**Interfaces:**
- Consumes: Task 1 helpers and Stage 4 renderer contract.
- Produces: `BoardDiff.mount`, controller `render`, `panes`, `readPixel` and idempotent `dispose`. Tasks 3 and 5 extend the controller with marks and hit routing.

- [ ] **Step 1: Add failing browser tests for the actual composite.** Add checks on the Stage 4 synthetic geometry fixture, whose non-overlapping and overlapping revision pads are positioned at `[10,10]`, `[20,10]` and `[30,10]`. Base occupies the first/third, head the second/third. Disable grid for pixel sampling. Each expression calls `await draw()` then `boardDiff.readPixel(0,...boardDiff.panes[0].renderer.project(point,S))`.

```js
// Add as one CHECKS entry with hash v=board&m=overlay on the synthetic fixture.
const near = (a,b) => a.every((v,i) => Math.abs(v-b[i]) <= 3);
const sample = p => boardDiff.readPixel(0,...boardDiff.panes[0].renderer.project(p,S));
const rgba = p => Array.from(sample(p)).slice(0,3);
return near(rgba([10,10]),[255,64,64])
  && near(rgba([20,10]),[64,255,64])
  && near(rgba([30,10]),[64,64,16])
  && near(rgba([40,10]),[255,255,255]);
```

Add model tests for render weights and device-pixel clips:

```js
test('mode weights preserve changes and use exact dim/group-alpha factors',()=>{
  assert.equal(B.weights('semantic','head',null,.5),.2);
  assert.equal(B.weights('semantic','head','added',.5),1);
  assert.equal(B.weights('blend','head','added',0),0);
  assert.equal(B.weights('blend','head','added',1),1);
  assert.equal(B.weights('blend','base',null,0),1);
  for(const dpr of [1,2])for(const wipe of [0,.333,.5,1]){
    const r=B.clipRects(801*dpr,400*dpr,wipe);
    assert.equal(r.base[2]+r.head[2],801*dpr);
    assert.equal(r.base[2],r.head[0]);
    assert.equal(r.head[0]+r.head[2],801*dpr);
  }
});
```

Add browser checks that Wipe `0`, `.5`, `1` renders the appropriate revision at the same pixel; moving the camera must not move the scissor boundary. Empty revisions must clear white in Overlay and board background otherwise, not retain the previous frame.

- [ ] **Step 2: Run to see failure.**

Run: `CHECK_PORT=9355 node ui/check.mjs 'board composite'`
Expected: FAIL, controller/composite absent. `node --test ui/board-diff.test.mjs` fails on the new render-weight API.

- [ ] **Step 3: Implement targets and deterministic render plan.** Extend the existing `BoardDiff` object, retaining Task 1 exports.

```js
function weights(mode, revision, action, blend) {
  return (mode === 'blend' && revision === 'head' ? blend : 1)
    * (mode === 'semantic' && !action ? .2 : 1);
}
function clipRects(width, height, wipe) {
  const split = Math.round(width * Math.max(0, Math.min(1, wipe)));
  return {base:[0,0,split,height],head:[split,0,width-split,height]};
}
function target(gl, width, height) {
  const texture=gl.createTexture(), framebuffer=gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);gl.deleteFramebuffer(framebuffer);
    throw Error('Board diff framebuffer unavailable');
  }
  return {texture,framebuffer,width,height};
}
function deleteTarget(gl,t) {gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.framebuffer);}
const vertexSource=`#version 300 es
out vec2 uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
const compositeSource=`#version 300 es
precision highp float;
in vec2 uv;out vec4 outColor;
uniform sampler2D baseImage;uniform sampler2D headImage;
uniform int mode; // 0 source-over, 1 multiply, 2 base-only, 3 head-only
uniform float headAlpha;
void main(){vec4 b=texture(baseImage,uv),h=texture(headImage,uv);
  if(mode==1){outColor=vec4(b.rgb*h.rgb,1.);return;}
  if(mode==2){outColor=b;return;}
  if(mode==3){outColor=h;return;}
  h*=headAlpha;outColor=h+b*(1.-h.a);
}`;
function program(gl,vs,fs) {
  const shaders=[gl.VERTEX_SHADER,gl.FRAGMENT_SHADER].map((type,i)=>{
    const s=gl.createShader(type);gl.shaderSource(s,i?fs:vs);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const m=gl.getShaderInfoLog(s);gl.deleteShader(s);throw Error(m);}
    return s;
  });
  const p=gl.createProgram();shaders.forEach(s=>gl.attachShader(p,s));gl.linkProgram(p);
  shaders.forEach(s=>gl.deleteShader(s));
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const m=gl.getProgramInfoLog(p);gl.deleteProgram(p);throw Error(m);}
  return p;
}
function composite(gl,p,base,head,clip=null) {
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,base.width,base.height);
  if(clip){gl.enable(gl.SCISSOR_TEST);gl.scissor(...clip);}else gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);gl.useProgram(p.program);gl.bindVertexArray(p.vao);
  for(const [i,t] of [base,head].entries()) {
    gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,t.texture);
    gl.uniform1i(gl.getUniformLocation(p.program,i?'headImage':'baseImage'),i);
  }
  gl.uniform1i(gl.getUniformLocation(p.program,'mode'),p.mode);
  gl.uniform1f(gl.getUniformLocation(p.program,'headAlpha'),p.headAlpha ?? 1);
  gl.drawArrays(gl.TRIANGLES,0,3);
  gl.disable(gl.SCISSOR_TEST);
}
Object.assign(window.BoardDiff,{weights,clipRects});
```

For Overlay, clear each revision FBO opaque white and override every visible primitive's colour to base `[1,.25,.25]`, head `[.25,1,.25]`; preserve normal opacity. Multiply the two opaque FBOs in the shader. This matches today's `--tint-del/add` semantics, including the intentionally white Overlay background. If Stage 1 retained different tint values, read its `--tint-del`/`--tint-add` resolved RGB instead of silently changing them; update pixel expected values to their product. Do not apply source-over twice to the same textured revision.

For all other combined modes: clear base FBO opaque current board background; clear head FBO transparent. Blend is base source-over head with **head scene group alpha**, not alpha applied to each overlapping primitive. Apply the head alpha to the sampled head RGBA in the composite shader (`h *= headAlpha`), and leave individual object alpha unchanged. Expose `headAlpha` as a uniform; `weights` is the tested group weight, not an instruction to multiply overlapping head primitives independently.

For Wipe, use actual `gl.scissor` on the final composite. Draw base texture over the whole viewport, then draw head texture over the right rect returned by `clipRects`. Head's framebuffer is opaque board background for Wipe so head erases the old side instead of revealing it. Disable scissor immediately afterwards. `gl.scissor` uses framebuffer pixels and bottom-left origin. Vertical split needs no Y inversion. Reuse the existing `.divider` event handling, `S.wipe` and 5% arrow-key steps; add Home/End = 0/1 and `aria-valuemin=0 aria-valuemax=100`. Divider drag must never pan/select; pointercancel must remove its move listener.

For Changes only (`semantic`): draw head unchanged objects once at `.2 * normal.opacity`; if there is no head draw base unchanged once. Draw all changed base and head geometry at normal opacity above context so removed and moved-before geometry remain visible. Do not render unchanged geometry twice. Both revisions of modified objects receive `~` marks. In other modes unchanged objects retain Stage 4 appearance; outline-style changed geometry retains its KiCad fill colours.

Implement `mount` with `document.createElement`, one `.vp.board[data-board-gl]` per pane, a full-size canvas, and a separate untransformed `.board-hud` for labels/pins. Register the existing Stage 4 camera input hooks on each vp; they update shared `S`. Do not attach the old SVG CSS transform to these canvases. `render` calls `renderer.resize(vp.clientWidth,vp.clientHeight,devicePixelRatio)`, allocates targets only when device dimensions change, and follows the pass rules above. `ResizeObserver` schedules one `requestAnimationFrame` render for any resize. Track and cancel that request during `dispose`. Every disposal deletes targets, compositor program, VAO, observer and renderers; call subscription unsubscribe once.

Side calls the same draw plan once for `base`, once for `head`; each pane uses its own actual CSS width for project/unproject, with the same S camera. Empty Side panes still display revision label and board background. The combined modes upload both scenes once; Side uploads only its own revision to each renderer. `readPixel` binds the default framebuffer and reads `[floor(x*dpr),height-1-floor(y*dpr)]`; invoke immediately after `render()` so default framebuffer preservation is not required. Do not enable `preserveDrawingBuffer` globally.

Integration with `draw`: decode before replacing the stage, compare the existing `gen` token after await, dispose the old board controller exactly once, connect the new stage, fit/restore using scene bounds, then mount/render. When the generation is stale, discard the decoded result without mounting. Guard against zero-width hidden stage. On the board route, `apply` calls `boardDiff.render()` and updates the existing status/zoom text; on SVG it keeps current behavior. `onApply` must not dereference `.stack.head` for WebGL Wipe. Blend's existing range callback sets `S.blend` then calls `apply` for the WebGL board, while keeping SVG/3D paths intact.

```css
.vp[data-board-gl] > canvas {position:absolute;inset:0;width:100%;height:100%;display:block;}
.vp[data-board-gl] > .board-hud {position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.vp[data-board-gl] .pin {pointer-events:auto;}
```

- [ ] **Step 4: Verify modes, lifecycle and input.**

Run: `node --test ui/board-diff.test.mjs`; `CHECK_PORT=9355 node ui/check.mjs 'board composite'`; `CHECK_PORT=9355 node ui/check.mjs 'wipe'`.
Expected: PASS. Repeat fifty mode switches and ten resizes, checking stable scene upload count and live context count (Side 2, all others 1). Verify DPR 2 clips and one-sided added/removed boards with actual readPixels, not only DOM/diagnostic flags. Capture all five modes in both themes.

- [ ] **Step 5: Commit.**

```sh
git add ui/board-diff.js ui/board-diff.test.mjs ui/review.js ui/review.css ui/checks.mjs
git commit -m "feat: compose all board comparison modes in WebGL"
```

### Task 3: Geometry outlines, recolour and contrast-safe non-colour marks

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return closeups of all actions, both styles, both themes.

**Files:**
- Create: `ui/board-marks.js`
- Modify: `ui/board-diff.js`, `ui/review.css`
- Test: `ui/board-diff.test.mjs`, `ui/checks.mjs`

**Interfaces:**
- Consumes: controller panes and `renderer.draw({mask:true,...})`, Task 1 action map, current canvas background.
- Produces: `BoardMarks.pickColor(action,backgroundRGB)`, `BoardMarks.contrast(a,b)`, `BoardMarks.styles`, `BoardMarks.fragmentSource`; compositor mark passes and DOM glyph/word labels.

- [ ] **Step 1: Add failing contrast and mark tests.** Load `board-marks.js` in the same VM before running tests.

```js
const M=context.window.BoardMarks;
test('each action passes 3:1 on dark, light and imported backgrounds',()=>{
  for(const bg of [[0,16,35],[244,246,248],[255,255,255],[125,125,125],[0,255,0]])
    for(const action of ['added','removed','modified'])
      assert.ok(M.contrast(M.pickColor(action,bg),bg)>=3);
  for(let gray=0;gray<256;gray++)for(const action of ['added','removed','modified']){
    const bg=[gray,gray,gray];
    assert.ok(M.contrast(M.pickColor(action,bg),bg)>=3,`${action} on ${gray}`);
  }
  assert.equal(M.styles.added.glyph,'+');
  assert.equal(M.styles.removed.glyph,'−');
  assert.equal(M.styles.modified.glyph,'~');
  assert.equal(new Set(Object.values(M.styles).map(s=>s.dash)).size,3);
});
```

Add a real browser pixel test: changed ring pad retains KiCad fill in outline style; pixels outside its exterior and on its drill boundary show a 4 CSS px dark halo under a 2 CSS px action stroke. At zoom 5 and 50 and DPR 1/2 the width differs by at most one device pixel of rasterization. In recolour, sample an added primitive for its action fill; sample two removed-fill pixels across a diagonal hatch and assert different luminance. An unchanged neighbour must keep its layer fill, not turn action-coloured.

- [ ] **Step 2: Run failing tests.**

Run: `node --test ui/board-diff.test.mjs`; `CHECK_PORT=9355 node ui/check.mjs 'board marks'`.
Expected: FAIL, BoardMarks missing.

- [ ] **Step 3: Implement action colours and geometry-mask effects.** Three candidates per action must cover arbitrary backgrounds, not only the two default themes.

```js
(() => {
  const candidates={
    added:[[76,194,106],[6,60,20],[222,255,230]],
    removed:[[255,123,114],[95,5,5],[255,230,228]],
    modified:[[227,179,65],[70,38,0],[255,246,205]]
  };
  const styles={added:{glyph:'+',dash:'solid',word:'Added'},
    removed:{glyph:'−',dash:'dashed',word:'Removed'},
    modified:{glyph:'~',dash:'dotted',word:'Modified'}};
  const luminance=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;})
    .reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  function pickColor(action,bg){
    const ordered=[...candidates[action]].sort((a,b)=>contrast(b,bg)-contrast(a,bg));
    if(contrast(ordered[0],bg)<3) throw Error('Action palette contrast invariant');
    return ordered[0];
  }
  window.BoardMarks={styles,contrast,pickColor};
})();
```

Use effective drawing background, not only chrome `--bg`: navy by default in both themes, imported background if present, white in Overlay. Recompute on Appearance/theme changes without geometry upload. Use resolved mark colour for both GPU marks and the legend; panel badges retain semantic theme tokens with AA text.

Render each action/revision's changed geometry into a reusable transparent mask FBO with visible primitives white at alpha 1. Unchanged primitives are excluded. This uses actual retained pad/track/text/zone coverage, including holes; no bounding-box outlines. Two framebuffer targets can be reused serially for all six action/revision passes. The mask effect shader samples in CSS units; use `dpr` to map each offset to texels. A silhouette mask union per action is sufficient; glyph labels retain individual identities when same-action shapes touch. Reject an implementation that draws rectangles around objects as its only outline.

```glsl
#version 300 es
precision highp float;
in vec2 uv;out vec4 outColor;
uniform sampler2D maskImage;
uniform vec2 size;
uniform float dpr;
uniform vec3 markColor;
uniform int action; // 0 added, 1 removed, 2 modified
uniform int style;  // 0 outline, 1 recolour hatch-only pass
float coverage(vec2 p){
  if(any(lessThan(p,vec2(0)))||any(greaterThan(p,vec2(1)))) return 0.;
  return texture(maskImage,p).a;
}
void main(){
  float own=coverage(uv), halo=0., core=0.;
  // Boundary on both sides: 4px full halo under 2px full colour stroke.
  for(int y=-2;y<=2;y++) for(int x=-2;x<=2;x++){
    vec2 delta=vec2(float(x),float(y));
    if(length(delta)>2.)continue;
    float n=coverage(uv+delta*dpr/size);
    float edge=abs(n-own);
    halo=max(halo,edge);
    if(length(delta)<=1.)core=max(core,edge);
  }
  vec2 css=gl_FragCoord.xy/dpr;
  float phase=mod(css.x+css.y,10.);
  float pattern=action==0?1.:action==1?step(phase,6.):
    (length(mod(css,vec2(6.))-vec2(3.))<1.5?1.:0.);
  if(style==1){
    if(action!=1||own<.5)discard;
    float stripe=step(mod(css.x+css.y,8.),2.);
    if(stripe==0.)discard;
    outColor=vec4(vec3(.035,.045,.06),.85);return;
  }
  if(halo<.5)discard;
  outColor=vec4(vec3(.035,.045,.06),1.);
  if(core>.5&&pattern>.5)outColor=vec4(markColor,1.);
}
```

Store this string in `BoardMarks.fragmentSource`, compile with Task 2's `program`, bind the mask sampler and uniforms and draw the same fullscreen triangle with source-over blending. Halo remains solid; action core is solid/dashed/dotted. The 2D dotted lattice and diagonal dash phase are screen-anchored, independent of camera zoom; non-colour meaning also comes from glyph/word. At very small geometry the solid halo and label preserve detection even when one dash/dot falls between samples. Sample right at viewport edges using explicit out-of-range zero above, not clamped mask repetition.

For recolour: use renderer override to replace only changed objects' normal RGB with selected action RGB and preserve normal opacity. Draw removed hatch through its exact mask as a second pass. Keep outline-style dash/glyph legend available and attach glyph/word to every changed-object label in both styles. The controller must apply revision clipping/group alpha to marks as well as geometry: Side marks remain in their pane; Wipe masks and labels clip to the same half; Blend marks inherit their revision group alpha; Overlay marks are added **after** multiply and never multiplied into unreadable colours. Selected geometry gets a separate neutral/focus-colour mask boundary after action marks; it must not erase its action glyph.

Build labels with `textContent`, never object-reference HTML. Place the label at `renderer.project([bounds[0],bounds[1]],S)`; with flip project all four corners and choose screen top-left. Keep glyph upright and CSS-pixel sized. Include a visible word, not only `title`:

```js
const style=BoardMarks.styles[action];
const label=document.createElement('span');
label.className=`board-mark-label ${action}`;
label.dataset.id=id;label.dataset.action=action;label.dataset.glyph=style.glyph;
label.dataset.dash=style.dash;
label.textContent=`${style.glyph} ${style.word}`;
label.setAttribute('aria-label',`${style.word} ${object.ref || object.kind}`);
```

```css
.board-mark-label {position:absolute;font:600 11px/14px var(--font-mono);color:var(--mark-color);
  background:#090c10;border:1px solid currentColor;padding:0 2px;white-space:nowrap;pointer-events:none;}
.board-mark-label.removed {border-style:dashed;}
.board-mark-label.modified {border-style:dotted;}
```

Set inline `--mark-color` to chosen `rgb(...)`. Dark label backing guarantees readable bright candidates; if a dark candidate is chosen on white canvas, use a light label backing or choose a separate text colour with at least 4.5:1. Preserve `Added/Removed/Modified` text in the always-visible legend so densely overlapping labels do not become the sole explanation. For offscreen labels hide them instead of clamping all labels to the same viewport corner.

- [ ] **Step 4: Verify contrast, shape and CSS widths.**

Run: `node --test ui/board-diff.test.mjs`; `CHECK_PORT=9355 node ui/check.mjs 'board marks'` in light and with `--dark`.
Expected: PASS. Include zoomed pad/drill, removed hatch and moved-object before/after screenshots in both themes. Compare unchanged board fill against KiCad default/dim reference shots; no whole-board recolour in outline mode.

- [ ] **Step 5: Commit.**

```sh
git add ui/board-marks.js ui/board-diff.js ui/board-diff.test.mjs ui/review.css ui/checks.mjs
git commit -m "feat: add accessible geometry marks and contrast-safe action colours"
```

### Task 4: Persist toolbar mark style through Appearance

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return toolbar and legend screenshots in both themes.

**Files:**
- Modify: `ui/appearance.js`, `ui/review.js:378-390`, `ui/review.css`
- Test: `ui/checks.mjs`, `ui/board-diff.test.mjs`

**Interfaces:**
- Consumes: `Appearance.get/patch/subscribe` and `BoardMarks.styles`.
- Produces: validated `Appearance.get().markStyle`, exactly `'outline'|'recolour'`, stored as a field in `kr.appearance.v1`; default `'outline'`.

- [ ] **Step 1: Add failing browser tests.**

```js
// CHECKS entry: "board mark style preserves appearance and focus", v=board
const before=Appearance.get();
const saved=JSON.stringify({layers:before.layers,nets:before.nets,objects:before.objects});
const b=document.querySelector('[data-mark-style="recolour"]');b.focus();b.click();
const after=Appearance.get();
const raw=JSON.parse(localStorage.getItem('kr.appearance.v1'));
return after.markStyle==='recolour' && raw.markStyle==='recolour'
  && JSON.stringify({layers:after.layers,nets:after.nets,objects:after.objects})===saved
  && document.activeElement===document.querySelector('[data-mark-style="recolour"]');
```

Add storage-blocked test by injecting a Storage prototype `getItem/setItem` throwing `SecurityError` **before page startup** in the CDP harness. Add corrupt JSON and unknown markStyle (`'rainbow'`) cases; check fallback outline and working controls, without clearing valid layer/net preferences. Reload using the same browser origin/profile and assert persistence; also test changing style on a second report project does not overwrite colour/opacity settings.

- [ ] **Step 2: Run failing tests.**

Run: `CHECK_PORT=9355 node ui/check.mjs 'board mark style'`
Expected: FAIL, toolbar/field absent.

- [ ] **Step 3: Extend existing validation and patching, not a second storage writer.** Add `markStyle:'outline'` to Stage 4 defaults and normalize the imported/stored value exactly:

```js
markStyle: value.markStyle === 'recolour' ? 'recolour' : 'outline'
```

Add a two-option toolbar radiogroup. Build buttons once or restore focus after render like existing modes. Disable/hide it outside WebGL board views; do not promise exact recolour on old SVG reports. Keep fallback's existing marks and show `Geometry mark styles require WebGL board data` in the status message when needed.

```js
const marks=document.createElement('div');marks.className='mark-styles';
marks.setAttribute('role','radiogroup');marks.setAttribute('aria-label','Change mark style');
for(const [value,text] of [['outline','Outline'],['recolour','Recolour']]){
  const b=document.createElement('button');b.dataset.markStyle=value;b.textContent=text;
  b.setAttribute('role','radio');
  const selected=Appearance.get().markStyle===value;
  b.setAttribute('aria-checked',String(selected));b.tabIndex=selected?0:-1;
  b.onclick=()=>Appearance.patch({markStyle:value});
  b.onkeydown=e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();
    const next=e.key==='Home'?'outline':e.key==='End'?'recolour':value==='outline'?'recolour':'outline';
    Appearance.patch({markStyle:next});
    document.querySelector(`[data-mark-style="${next}"]`).focus();
  };
  marks.append(b);
}
```

The controller subscription refreshes button checked/tabindex state, legend colours and GPU passes. It must not call full `draw()` for an appearance change. Reset-to-KiCad-defaults resets markStyle to outline; theme import preserves markStyle unless the user explicitly invokes reset. Storage uses the existing try/catch around read/write. Do not replace the `kr.appearance.v1` object with `{markStyle}`.

- [ ] **Step 4: Verify style persistence and resilience.**

Run: `CHECK_PORT=9355 node ui/check.mjs 'board mark style'` and repeat with `--dark`.
Expected: PASS including reload/blocked storage. Mark toggle changes uniforms/passes but leaves scene upload counter unchanged. Both-theme screenshots show readable checked control and legend.

- [ ] **Step 5: Commit.**

```sh
git add ui/appearance.js ui/review.js ui/review.css ui/checks.mjs ui/board-diff.test.mjs
git commit -m "feat: persist board mark style with appearance"
```

### Task 5: Link geometry selection, comment pins and existing addresses

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return selected-object/pin screenshots in both themes, including flipped Wipe.

**Files:**
- Modify: `ui/board-diff.js`
- Modify: `ui/review.js:52-57,392-516` and `goToObject`
- Modify: `ui/checks.mjs`
- Test: `ui/board-diff.test.mjs`

**Interfaces:**
- Consumes: renderer exact hits/project/unproject, Task 1 ID cycling, existing `anchorAt`, `resolveAnchor`, `goTo`, `markSelected`, `saveHash`, `S.placing` and parent messaging.
- Produces: controller `point`, `pick`, `bounds`; `pickAt` uses geometry for WebGL while legacy `hitTest` keeps existing SVG semantics; anchor protocol remains v1/mm.

- [ ] **Step 1: Add failing browser checks for shape hits and pin routing.**

```js
// "board geometry pick links row without bounding-box false positives"
const pane=boardDiff.panes[0], rr=pane.vp.getBoundingClientRect();
const eventAt=p=>{const q=pane.renderer.project(p,S);return{clientX:rr.left+q[0],clientY:rr.top+q[1]};};
// Contract fixture pad: annulus [10,10], outer 2mm, hole 1mm.
const ring=boardDiff.pick(pane.vp,eventAt([11.5,10]),null);
const hole=boardDiff.pick(pane.vp,eventAt([10,10]),null);
const corner=boardDiff.pick(pane.vp,eventAt([8,8]),null);
if(!ring||hole||corner)return false;
pickAt(pane.vp,eventAt([11.5,10]));
return S.s===ring.id && document.querySelector('#panel [aria-selected="true"]')?.dataset.id===ring.id;
```

Add checks for repeat-click cycle, removed base object, moved head/base object, Wipe left/right anchors, Blend zero head alpha, hidden net, flipped DPR 2 pin projection and placing mode. Exercise actual pointer inputs in `ui/check.mjs` for at least one selection and pin placement (like existing 3D mouse-input checks), not only direct calls. A drag >4 CSS px must not select or propose a pin. Preserve context-menu behavior without interference from right-drag pan supplied by Stage 4.

- [ ] **Step 2: Run failing checks.**

Run: `CHECK_PORT=9355 node ui/check.mjs 'board geometry pick'`
Expected: FAIL, controller has no geometry routing.

- [ ] **Step 3: Implement controller hit routing.** Preserve the renderer's hit order while allowing cycling through all visible revision IDs.

```js
function panePoint(pane,event,state){
  const r=pane.vp.getBoundingClientRect();
  return {point:pane.renderer.unproject([event.clientX-r.left,event.clientY-r.top],state),
    fraction:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width))};
}
function pickInPane(pane,event,afterId,state,appearance){
  const {point,fraction}=panePoint(pane,event,state);
  const sides=pane.sides.length===1?pane.sides:
    BoardDiff.sidesAt(state.m,fraction,state.wipe,state.blend,pane.scenes);
  const hits=[];
  for(const side of sides) for(const object of pane.renderer.hits({revision:side,
    x:point[0],y:point[1],toleranceCSS:4,camera:state,appearance})) {
    hits.push({object,side});
  }
  const hit=BoardDiff.pickFromHits(hits.map(h=>h.object),afterId);
  return hit?{...hit,side:hits.find(h=>h.object===hit.object).side,point}:null;
}
```

For anchors, `point` selects primary visible side with the same routing, then `renderer.hits` on **all** visible objects, including unchanged objects with no change IDs. Use the first exact hit to construct the existing `target:'object'` anchor with UUID/kind/ref/layer and the object's anchor in mm. A miss creates `target:'point'` at unprojected mm. Never coerce an unchanged object's anchor to a change-list row.

For controller `bounds(id,side)`, union `bounds` of objects whose `changeIds.includes(id)` on that revision. `goTo` uses these geometry bounds only when they exist; it keeps `rowBox` for violations/old reports. Removed selection prefers base; added prefers head; modified prefers head but retains before geometry marks. If an explicit hash includes x/y/z, do not recenter it merely because it also has s. `p/v/m/x/y/z/s/t/l/c/h` encode/decode remains untouched.

`pickAt` WebGL route calls controller.pick, then existing `S.s`, `markSelected`, `saveHash`, row scroll and `boardDiff.render` without a scene rebuild. Keep the original bbox `hitTest` for SVG/schematic/library. `goToObject` and finding selection use the same camera and focus policy.

`drawPins` WebGL route creates ordinary `.pin` buttons in each pane HUD; no `.world`/`.stack` probing. Resolve each anchor with existing `resolveAnchor`; map to head/base position (including `pos_before`) and project with the pane renderer. For combined Wipe show a pin only if its revision occupies that pixel. For overlay/blend show both revision pins when applicable, deduplicate identical thread/position pairs; at Blend zero hide head-only pins. Keep removed threads at base, moved before positions on base in Side, unchanged head threads on both Side panes under existing added-rule. Pin pointerdown/click stops propagation. Keep aria-label, thread opening, issue link security checks and parent protocol unchanged.

When a pin's anchor is detached, retain its thread panel row and detached explanation but draw no pin. For an anchor whose layer is explicitly hidden, hide the pin with geometry and keep its thread row discoverable. Pin placement always uses actual pointer side/flip transform, never `vp.querySelector('.stack.head')`.

- [ ] **Step 4: Verify linking, pins and address behavior.**

Run: `CHECK_PORT=9355 node ui/check.mjs 'board geometry pick'`; `CHECK_PORT=9355 node ui/check.mjs 'pin'`; `CHECK_PORT=9355 node ui/check.mjs 'address'`; `CHECK_PORT=9355 node ui/check.mjs 'hitTest'`.
Expected: PASS on geometry fixture and original sample. Round-trip a full `p=0&v=board&m=wipe&x=10&y=20&z=5&s=c1&t=changes&l=F_Cu&c=1,2,3,4,5,6&h=silk` address; preserve recognized key values even when not used by the current view. `semantic` still opens Changes only. Capture both-theme selected annulus, removed pin and flipped Wipe pin.

- [ ] **Step 5: Commit.**

```sh
git add ui/board-diff.js ui/review.js ui/checks.mjs ui/check.mjs ui/board-diff.test.mjs
git commit -m "feat: link board geometry selection and revision-aware pins"
```

### Task 6: Inline new assets and prove network-free reports

**Agent:** general-purpose agent; browser portion invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling and returns screenshots in both themes.

**Files:**
- Modify: `ui/review.html`, `kicad_review.py:inline_page`
- Modify: `test_kicad_review.py`, `ui/check.mjs`, `ui/checks.mjs`

**Interfaces:**
- Consumes: Stage 4 ordered classic scripts and `inline_page(data_js)`.
- Produces: report containing appearance, board renderer, marks, compositor and review controller inline, with no external assets or dynamic imports; old data still renders SVG.

- [ ] **Step 1: Add failing Python offline assertions.** Use the existing top-level assert style.

```python
page = inline_page('window.REVIEW_DATA = {"version":1};')
for asset in ("board-gl.js", "appearance.js", "board-marks.js", "board-diff.js"):
    assert not re.search(r'(?:src|href)=[\"\']' + re.escape(asset), page), asset
assert "window.BoardDiff" in page
assert "window.BoardMarks" in page
assert page.index("window.BoardMarks") < page.index("window.BoardDiff")
assert not re.search(r'<script[^>]+src=', page)
```

Add browser `--offline` support with `Network.enable` and `Network.emulateNetworkConditions({offline:true,latency:0,downloadThroughput:0,uploadThroughput:0})` **before** navigation. Record attempted HTTP(S) requests with `Network.requestWillBeSent`; fail if any runtime request occurs. Reading local `file://` HTML is allowed. This verifies real network isolation, not just searching for URLs in source/comments.

- [ ] **Step 2: Run failing Python test.**

Run: `python3 test_kicad_review.py`
Expected: FAIL on missing inline BoardDiff/BoardMarks before template changes.

- [ ] **Step 3: Inline in deterministic order.** Add template tags before review.js, after Stage 4 appearance/renderer tags:

```html
<script src="board-marks.js"></script>
<script src="board-diff.js"></script>
<script src="review.js"></script>
```

Extend Stage 4's existing inline asset list rather than creating a second injection prefix. If it uses exact tag replacements, use this loop and include the names in its remaining-external-assets check:

```python
for name in ("board-marks.js", "board-diff.js"):
    page = page.replace(f'<script src="{name}"></script>',
                        f"<script>\n{read(name)}</script>")
```

Do not fetch shaders, fonts, icons, textures or JS. Shader strings live in the inlined JS. Preserve optional 3D bundling and content-security-policy behavior. Generate a geometry report from the local Thermal_Camera fixture with the existing pipeline; generate a legacy report from `ui/sample/review-data.js` with `inline_page` using Python and write both to the session scratchpad, not the repo. Both reports use the same template/inliner.

- [ ] **Step 4: Verify all report variants offline.**

Run: `python3 test_kicad_review.py`; `CHECK_PORT=9355 node ui/check.mjs --offline --page "$GEOMETRY_REPORT" 'board'`; `CHECK_PORT=9355 node ui/check.mjs --offline --page "$LEGACY_REPORT"`.
Expected: PASS, no HTTP(S) attempts; Side/Overlay/Wipe/Blend/Changes only and both styles work offline in geometry report. Original report remains SVG, no inaccessible toolbar promise. Repeat geometry run with `--dark`. `GEOMETRY_REPORT` and `LEGACY_REPORT` are absolute scratchpad output paths generated in this step.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.html kicad_review.py test_kicad_review.py ui/check.mjs ui/checks.mjs
git commit -m "feat: inline WebGL board diff assets for offline reports"
```

### Task 7: Preserve existing browser checks and exercise fallback/lifecycle

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return fallback and restored-board screenshots in both themes.

**Files:**
- Modify: `ui/checks.mjs`, `ui/check.mjs`
- Modify: `ui/review.js` (failure boundary and stale-generation cleanup)
- Modify: `ui/board-diff.js` (resource cleanup only)

**Interfaces:**
- Consumes: existing CHECKS triplets and test harness CDP `send/evaluate`, controller readPixel/render and Stage 4 `onLost`.
- Produces: unchanged existing check names with equivalent assertions on both backends; new lifecycle checks that cannot silently skip on geometry reports.

- [ ] **Step 1: Add failing fallback and lifecycle tests.**

```js
// "board context loss falls back and keeps camera selection"
const before={x:S.x,y:S.y,z:S.z,s:S.s,m:S.m};
const ext=boardDiff.panes[0].renderer.gl.getExtension('WEBGL_lose_context');
if(!ext)throw Error('Test WebGL context-loss extension unavailable');
ext.loseContext();
const until=performance.now()+5000;
while(!document.querySelector('#stage .stack svg')&&performance.now()<until)
  await new Promise(r=>setTimeout(r,25));
return !!document.querySelector('#stage .stack svg')
  && ['x','y','z','s','m'].every(k=>S[k]===before[k])
  && /SVG|WebGL/i.test(document.querySelector('[role="status"]').textContent);
```

Also test a fresh page with WebGL2 acquisition returning null (CDP pre-start injection), geometry missing, head-only/base-only scenes, rapid project changes and 50 mode switches. Assert a lost board is not immediately remounted into a context-loss loop; explicit retry/new project may attempt WebGL again. The SVG fallback must still use the current mode, layer selection and restored S values.

- [ ] **Step 2: Run failing tests.**

Run: `CHECK_PORT=9355 node ui/check.mjs 'board context loss'`
Expected: FAIL before unified fallback boundary.

- [ ] **Step 3: Add fallback guard and update—not delete—legacy assertions.** `draw` catches decode/mount/render/allocation exceptions only on the board branch, disposes partial resources, records a per-project-session WebGL failure and executes existing SVG mode renderer. Use the existing status-bar message API from Stage 3 for `WebGL unavailable — using SVG board view`; never swallow an unrelated schematic error. Context-loss handler calls `event.preventDefault()`, stops scheduled renders, requests SVG redraw through the same generation guard and retains camera/selection.

Do not fake invisible SVG `.layer` elements to satisfy tests. Update each affected existing check to branch on the actual backend:

```js
// Replacement for SVG-only 'mode ... draws' terminal geometry assertion:
const boardCanvas=document.querySelector('#stage .vp[data-board-gl] canvas');
const drawn=boardCanvas
  ? boardDiff.panes.every(p=>p.canvas.width>0&&p.canvas.height>0)
    && Array.from(boardDiff.readPixel(0,10,10)).length===4
  : [...document.querySelectorAll('#stage svg path, #stage svg line, #stage svg rect, #stage svg circle, #stage svg polyline, #stage svg polygon, #stage svg text')]
    .some(e=>{const r=e.getBoundingClientRect();return(r.width>0||r.height>0)&&getComputedStyle(e).visibility==='visible';});
```

Pair this with Task 2 actual content-pixel checks; canvas dimensions alone are not rendering proof. Update existing board framing/layer checks to project visible scene bounds and assert viewport containment or effective draw coverage; toggling a layer tests geometry/pixels and hit disappearance plus S.layers. Retain SVG assertions for fallback. For blend, assert sampled overlap colour at `.2` and head group alpha `.2`, not nonexistent `.stack.head` CSS. For drawing click tests, click an actual occupied geometry point projected by the renderer, not the centre of a footprint bbox that may contain no geometry. For selected-marker checks, assert selected geometry mask plus matching `.board-mark-label[data-id]`/selected HUD hook on WebGL, `.marker.sel` on SVG. For `markers differ by more than colour`, assert each action has the correct glyph, word and dash/hatch in the new marks, still test legacy marker styles in fallback. Do not relax these tests to unconditional backend success.

A geometry fixture check returning `skip` is failure. Preserve optional 3D skips in reports without 3D, and library/schematic behavior. This harness accepts the name filter as a positional argument; do not pass `--name` unless separately adding support. Use `--no-skip` only on a targeted fixture set that intentionally supplies all required data.

- [ ] **Step 4: Run complete regressions, both backends/themes.**

Run:

```sh
python3 test_kicad_review.py
node --import ./site/css-loader.mjs --test site/test.mjs
node --test ui/board-diff.test.mjs
CHECK_PORT=9355 node ui/check.mjs
CHECK_PORT=9355 node ui/check.mjs --dark
CHECK_PORT=9355 node ui/check.mjs --page "$GEOMETRY_REPORT"
CHECK_PORT=9355 node ui/check.mjs --dark --page "$GEOMETRY_REPORT"
```

Expected: every existing check retained and passing; newly added board checks run, not skip, on the geometry report. No new console exceptions. Before/after file inspection shows no removed CHECKS names. After each lifecycle loop, verify no pending observers/rAF callbacks, deleted GPU targets/programs and only the active renderer(s). Capture context-loss SVG fallback and successful fresh-project WebGL render in both themes.

- [ ] **Step 5: Commit.**

```sh
git add ui/checks.mjs ui/check.mjs ui/review.js ui/board-diff.js
git commit -m "test: retain board browser coverage across WebGL and SVG fallback"
```

### Task 8: Browser proof, colour-vision proof and performance gate

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return before/after screenshots in both themes and simulated deuteranopia/protanopia screenshots.

**Files:**
- Modify: `ui/check.mjs` (proof options), `ui/checks.mjs` (stable Thermal_Camera proof check)
- Evidence: session scratchpad only; no private board/reference screenshots committed

**Interfaces:**
- Consumes: actual Thermal_Camera geometry report, preserved baseline screenshots from immediately before Stage 5, existing CDP captureScreenshot, Task 7 regressions.
- Produces: browser evidence for all modes/styles/themes, vision simulation and measurable two-revision pan/zoom acceptance. No new runtime API.

- [ ] **Step 1: Add a failing proof check that establishes real board state.** The check name is `board Thermal proof`. It selects the Thermal_Camera project by name, selects board, awaits `draw`, asserts the WebGL backend, fits, hides nondeterministic thread timestamps and waits two rAFs. Add harness options `--mode`, `--marks`, `--theme`, `--vision`, `--dpr` applied after this check and before its final capture; reject unknown values instead of silently producing the wrong screenshot.

```js
// CHECKS expression for "board Thermal proof":
const i=D.projects.findIndex(p=>p.name==='Thermal_Camera');
if(i<0)throw Error('Thermal_Camera report required for proof');
S.p=i;S.v='board';S.s=null;renderNav();renderPanel();await draw();fit();
await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
return !!boardDiff && boardDiff.panes.length>0;
```

- [ ] **Step 2: Run to see failure on the wrong fixture.**

Run: `CHECK_PORT=9355 node ui/check.mjs 'board Thermal proof'`
Expected: FAIL with `Thermal_Camera report required for proof` on the shipped sample. This prevents evidence accidentally being taken from a trivial sample.

- [ ] **Step 3: Implement CDP proof options and capture.** Extend the existing parser before it consumes the positional filter. Add vision simulation after page render and before screenshot:

```js
const vision=opt('--vision');
if(vision && !['none','deuteranopia','protanopia'].includes(vision))throw Error('Unknown vision simulation');
if(vision)await send('Emulation.setEmulatedVisionDeficiency',{type:vision});
```

For theme use the actual toolbar/theme API or `document.documentElement.dataset.theme` with its existing theme notification; do not simulate a theme by recolouring a saved PNG. Mark/mode options use existing toolbar controls and wait for controller render. Include a screenshot name containing theme, mode, marks, DPR and vision. Capture before baseline from the prior Stage 4 commit **before implementation starts**, without resetting this worktree; use its existing report artifact or a separate read-only baseline checkout. No merging or tag changes.

- [ ] **Step 4: Run browser proof and inspect evidence.**

Use a free port other than 9341/9344. `9355` below is an example; choose another if occupied. `PROOF_DIR` is an absolute directory inside this session's scratchpad, created by the executor. Run from the implementation worktree:

```sh
for theme in dark light; do
  for mode in side overlay wipe blend semantic; do
    for marks in outline recolour; do
      CHECK_PORT=9355 node ui/check.mjs 'board Thermal proof' --page "$GEOMETRY_REPORT" \
        --theme "$theme" --mode "$mode" --marks "$marks" --vision none \
        --shot "$PROOF_DIR/after-$theme-$mode-$marks.png"
    done
  done
  for vision in deuteranopia protanopia; do
    for marks in outline recolour; do
      CHECK_PORT=9355 node ui/check.mjs 'board Thermal proof' --page "$GEOMETRY_REPORT" \
        --theme "$theme" --mode semantic --marks "$marks" --vision "$vision" \
        --shot "$PROOF_DIR/after-$theme-semantic-$marks-$vision.png"
    done
  done
done
```

Expected: 20 normal mode/style/theme captures plus 8 vision captures, and Stage 4 before captures in both themes. Open images, do not judge only a passing process exit. If Thermal_Camera's selected comparison lacks any action, use its established three-action fixture revision pair or a clearly labelled synthetic fixture **in addition**; never claim a screenshot proves distinctions for actions it does not contain. Ensure the vision contact sheets show `+ Added`, `− Removed`, `~ Modified`, solid/dashed/dotted outlines, removed hatch and selection. Colour simulation is evidence of redundant coding, not a claim of clinical accessibility certification.

Compare ordinary unchanged detail with `pcb-01-default`, inactive detail with `pcb-04-dim`/`pcb-05-hide`, flipped positioning with `pcb-06-flip`, and active back layer with `pcb-07-active-bcu`. Board navy remains navy in the light chrome theme except deliberately white multiply Overlay. Confirm mark words, selected row, linked canvases, pins, Wipe keyboard focus and toolbar state in both themes. Capture an additional DPR 2 flipped Wipe closeup in both themes with a pin beside a removed/moved object.

Run the Stage 4 pan/zoom benchmark on the private Aux board ×2 revisions with this compositor enabled, both styles, Side and Overlay and Changes only. Measure at least 3 seconds of actual render/rAF, not only camera mutation; record median frame interval, p95, total frames and scene buffer-upload count. Expected: at least 50 fps on the agreed headless Chrome/Mac setup, zero geometry uploads during gesture, no repeated GPU allocations outside resize, no leaked contexts. Aux data/screenshots remain scratch-only. If the mask passes miss the budget, cache action masks until camera/appearance/resize changes and restrict mark work to the changed projected bounds using scissor; never disable marks or lower the target silently.

Finally rerun Task 7's full suite and Task 6's offline geometry proof. Return screenshot paths and pass counts to the reviewer. Do not commit private evidence or generated report payloads.

- [ ] **Step 5: Commit harness/proof checks only.**

```sh
git add ui/check.mjs ui/checks.mjs
git commit -m "test: prove board modes and colour-vision-safe diff marks"
```

## Completion gate

- All five board modes draw from retained geometry; Side has two linked canvases, Wipe uses device-pixel scissor, Overlay really multiplies revision textures, Blend uses head group alpha and Changes only dims unchanged context to 0.2.
- Both styles operate on actual geometry. Outline halo/core widths are 4/2 CSS px; added/removed/modified have `+`/`−`/`~`, words and solid/dashed/dotted encoding. Recolour has removed hatching. Default outline persists in `kr.appearance.v1` without destroying other fields.
- Every action colour passes 3:1 against actual canvas background, including white Overlay/imported themes. Selection remains independently visible.
- Geometry selection, list focus, pins, moved/removed anchors and all existing hash keys survive both themes, flip and DPR 2.
- Original checks are updated rather than deleted; full Python/site/browser regressions pass. Old reports and unavailable/lost WebGL use working SVG fallback.
- Offline report runs with network disabled; no additional runtime dependency or external asset.
- Both-theme Thermal_Camera before/after and deuteranopia/protanopia evidence is inspected. Private reference/Aux data is never committed. At least 50 fps two-revision benchmark remains met.

## Handoff questions resolved by this plan

- Canvas background is KiCad navy in both themes by default; mark contrast follows actual canvas background. Overlay alone retains today's white multiply background.
- `semantic` remains an internal/hash name while toolbar says Changes only.
- Stage 4 must expose retained object identity, exact visible-geometry hits and filtered uniform drawing. Stage 5 consumes that interface and does not infer identity from exported SVG or refs alone.
- No Stage 5 feature code is authorized by this document's creation; approval precedes implementation.
