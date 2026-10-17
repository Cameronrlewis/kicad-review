# Stage 4: Board Geometry, WebGL Renderer, and Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render both board revisions with KiCad colours, a retained WebGL2 scene, a KiCad-style Appearance panel, and shared CAD navigation, retaining the offline SVG fallback.

**Architecture:** Parse normalized geometry from the existing S-expression reader without changing semantic diff extraction. Embed revision scenes through the existing deduplicated gzip/base64 blob store. Keep camera, navigation, selection overlays, and report ownership in `review.js`; `board-gl.js` owns GPU resources and `appearance.js` owns validated display settings. Use SVG for old reports, unsupported geometry, unavailable WebGL2, and context loss. Stage 5 owns the new diff compositor; do not regress existing comparison modes while introducing the renderer.

**Tech Stack:** Python standard library, vanilla JavaScript, WebGL2/GLSL ES 3.00, native HTML controls, CSS custom properties, existing assertion and Chrome/CDP test harnesses. No new package.

**Spec:** `docs/superpowers/specs/2026-10-14-ui-redesign-design.md`, especially Data, Board renderer, Appearance, controls, errors, and Stage 4 proof.


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
- Worktree: `/Users/cameron/Code/kicad-review-worktrees/ui-redesign`; stages 1 and 3 must be integrated before UI execution. Do not create another shell, theme bootstrap, or status bar.
- Every UI-building task uses a **general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling** and returns screenshots in both themes. Inside the change viewer, the KiCad references override skill suggestions.
- Board background remains `#001023` in both chrome themes. Appearance colours are drawing data, not semantic chrome tokens.
- No feature implementation during plan approval. Commands and commits below are execution instructions, not work performed by the plan author.

## Review Focus

1. A rotated back-side footprint with duplicate pad numbers must retain exact world coordinates, unique child IDs, and the same parent change identity; Task 2 tests this.
2. Concave zone fills with holes, disconnected islands, repeated vertices, and absent stored fills must not create copper across clearances; Tasks 3 and 5 test this.
3. A saved link into a different project during an asynchronous scene decode must show only the latest project and retain explicit `x/y/z`, even under flip or context loss; Tasks 6 and 7 test this.
4. Malformed or blocked localStorage, hostile layer/net names, and stale settings from another board must neither execute HTML nor hide new layers accidentally; Task 8 tests this.
5. DPR changes, zero-sized docks, pointer cancellation, right-click thread pins, and keyboard focus in sliders must not corrupt navigation or consume native editing keys; Tasks 5 and 9 test this.

---

## Evidence, boundaries, and file map

Read before execution:

- References: `/Users/cameron/Code/kicad-review-ui-reference/kicad/pcb-01-default.png` through `pcb-07-active-bcu.png`. The reference has swatch, eye, name; active row indicator; bottom layer-display controls. Objects sliders precede visibility rows. Nets has a compact name list. Do not copy editing-only Selection Filter, Viewports, or net-class editing controls.
- Design tokens/mockup: `/Users/cameron/Code/kicad-review-ui-reference/draft/design-system.md` and `mockup.html`. Binding spec wins where draft differs (`kr.theme`, dark default, Appearance dock).
- Measurement baseline: `/Users/cameron/Code/kicad-review-ui-reference/draft/render-eval.md`. Thermal_Camera has 185 segments, 15 vias, 239 pads, 56 footprints, two stored fills. Aux has 536 segments, 188 vias, 345 pads, 102 nets. Existing single-revision KiCanvas FPS is not evidence for this renderer.
- Read-only KiCad source root: `/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/ui-research/kicad-source`, commit `3e051f88`.

File responsibilities:

| File | Responsibility |
|---|---|
| `kicad_review.py` | `board_geometry`, normalization helpers, blob integration, asset inlining |
| `test_kicad_review.py` | Small in-memory KiCad board fixtures and report assertions |
| `ui/kicad-colors.js` | Data-only palette, Appearance order, independently expressed draw priority |
| `ui/board-gl.js` | Scene validation, CPU batches, shaders, GPU buffers, grid, resource lifecycle |
| `ui/appearance.js` | Validated appearance state, Layers/Objects/Nets controls, persistence |
| `ui/review.js` | Decode/cache integration, shared camera, renderer routing, shortcuts/status |
| `ui/review.html`, `ui/review.css` | Script tags, panel mount, board canvas and panel layout |
| `ui/board-test.mjs` | Dependency-free Node assertions for pure JS geometry/state |
| `ui/checks.mjs` | Real-browser pixel, lifecycle, input, and FPS checks |
| `NOTICE`, `README.md` | Data attribution, format extension, supported/fallback behavior |

Do not grow a parallel semantic object model. `pcb_objects` remains the source of diff identities. Its top-level UUID is the scene object's `changeUuid`; pad/text/shape children of a footprint inherit that UUID. Keep child `uuid` separately. A regenerated footprint UUID still resolves through existing `object_index` and reference matching. No scene field replaces numeric report change IDs.

### Shared scene and JavaScript contract

```js
// project.board.geometry contains blob keys, not embedded nested scenes.
// Null represents a revision that has no board, not an empty board.
const geometry = {base: "blob-key-or-null", head: "blob-key-or-null"};
// gzip-decoded blob schema, version independent of REVIEW_DATA.format:
const scene = {
  version: 1, units: "um", complete: true, warnings: [],
  bounds: [0, 0, 10000, 10000], // minX,minY,maxX,maxY in board coordinates
  layers: [{id: 0, name: "F.Cu", type: "signal", enabled: true}],
  nets: [{id: 0, name: ""}, {id: 1, name: "GND"}],
  objects: [{
    kind: "track", uuid: "track-uuid", changeUuid: "track-uuid", ref: "GND",
    layers: ["F.Cu"], net: 1, side: null, category: "tracks", hidden: false,
    geometry: {segments: [[1000, 2000, 3000, 2000, 250]]},
    box: [875, 1875, 3125, 2125]
  }]
};
// Every dimensional number is an integer micrometre. Angles: integer millidegrees.
// geometry variants:
// segments: [ax,ay,bx,by,width][] (arc objects retain kind:"arc")
// rings: [x,y][][], even-odd rule, no implicit fill of zone outline
// primitive: {shape, center:[x,y], size:[w,h], angle, radius, delta:[dx,dy]}
// drill: {center:[x,y], size:[w,h], angle, plated:boolean}
// text: {value, at:[x,y], size:[w,h], angle, thickness, justify, mirror, italic,bold}
// footprint: geometry:{}, box is union of children, never a filled bbox
```

Names are canonical file layer names (`F.SilkS`, not SVG export `F_Silkscreen`). Keep one explicit adapter between scene names and existing `board.layers[].name`; `l` hash serialization remains the existing SVG names. Never replace underscore with dot indiscriminately: `User_Drawings` maps to `Dwgs.User`, for example.

```js
// Classic scripts; usable through globalThis in both Node and an offline HTML.
// KicadColors: {layers, objects, appearanceOrder, drawPriority}
// BoardGL: {validateScene, buildBatches, layerFactor, worldToScreen,
//           screenToWorld, create}
// create(canvas, scene, revision, onFailure) => renderer|null
// renderer: {render(camera, appearance), dispose(), stats, readPixel(x,y)}
// camera: {x,y,z,width,height,dpr,flip} (mm and CSS px/mm)
// stats: {uploads, draws, vertices, instances, disposed}; readPixel dev diagnostic
// Appearance: {defaults, normalize, load, save, mount}
// mount(root,{layers,nets,state,onChange,fallback}) => {update,dispose}
// review.js owns const boardView = {scenes, renderers, appearance, generation};
// boardAppearance() returns active state; changeBoardAppearance(patch) validates,
// updates persistence, invokes apply(), then updates controls without losing focus.
```

A retained batch is keyed by `(revision, canonical layer, kind)`. Within a batch keep object ranges plus per-vertex integer net ID/category/side data. Layer/kind settings are uniforms; net colours/visibility are a nearest-sampled RGBA32F texture plus a selected-net uniform. Updating appearance may update this small lookup texture but must never call `bufferData`/`bufferSubData`. This resolves Nets controls without exploding batches per net.

### Task 1: Pin KiCad data and display-order contracts

**Files:**
- Create: `ui/kicad-colors.js`, `ui/board-test.mjs`
- Modify: `NOTICE`

**Interfaces:**
- Consumes: data values from the source revision cited above, not source algorithms.
- Produces: global `KicadColors` containing `layers` RGBA bytes-plus-alpha, `objects`, `appearanceOrder`, and `drawPriority`.

- [ ] **Step 1: Add failing data assertions.** Start `ui/board-test.mjs` with:

```js
import assert from "node:assert/strict";
await import("./kicad-colors.js");
const C = globalThis.KicadColors;
assert.deepEqual(C.layers["F.Cu"], [200,52,52,1]);
assert.deepEqual(C.layers["B.Cu"], [77,127,196,1]);
assert.deepEqual(C.layers["F.Mask"], [216,100,255,.4]);
assert.deepEqual(C.layers["User.9"], [232,178,167,1]);
assert.deepEqual(C.layers["In13.Cu"], [167,165,198,1]);
assert.equal(Object.keys(C.layers).length, 95); // 32 copper + 18 tech +45 user
assert.equal(C.appearanceOrder.indexOf("F.Adhes") + 1,
             C.appearanceOrder.indexOf("B.Adhes"));
assert.equal(C.appearanceOrder.at(-1), "User.45");
assert.deepEqual(C.objects.background, [0,16,35,1]);
assert.deepEqual(C.objects.ratsnest, [0,248,255,.35]);
```

- [ ] **Step 2: Run red.** Run `node ui/board-test.mjs`. Expected: missing module.
- [ ] **Step 3: Implement the full table, including non-repeating inner copper.** Use this independently written data assembly, not a copied GPL initializer:

```js
(() => {
  const layers = {"F.Cu":[200,52,52,1], "B.Cu":[77,127,196,1]};
  // KiCad 3e051f88 common/settings/builtin_color_themes.h:181-212
  const inner = [
    [127,200,127],[206,125,44],[79,203,203],[219,98,139],
    [167,165,198],[40,204,217],[232,178,167],[242,237,161],
    [141,203,129],[237,124,51],[91,195,235],[247,111,142],
    [167,165,198],[40,204,217],[232,178,167],[242,237,161],
    [237,124,51],[91,195,235],[247,111,142],[167,165,198],
    [40,204,217],[232,178,167],[242,237,161],[237,124,51],
    [91,195,235],[247,111,142],[167,165,198],[40,204,217],
    [232,178,167],[242,237,161]
  ];
  inner.forEach((rgb,i) => layers[`In${i+1}.Cu`] = [...rgb,1]);
  // builtin_color_themes.h:214-231
  Object.assign(layers, {
    "F.Adhes":[132,0,132,1], "B.Adhes":[0,0,132,1],
    "F.Paste":[180,160,154,.9], "B.Paste":[0,194,194,.9],
    "F.SilkS":[242,237,161,1], "B.SilkS":[232,178,167,1],
    "F.Mask":[216,100,255,.4], "B.Mask":[2,255,238,.4],
    "Dwgs.User":[194,194,194,1], "Cmts.User":[89,148,220,1],
    "Eco1.User":[180,219,210,1], "Eco2.User":[216,200,82,1],
    "Edge.Cuts":[208,210,205,1], "Margin":[255,38,226,1],
    "F.CrtYd":[255,38,226,1], "B.CrtYd":[38,233,255,1],
    "F.Fab":[175,175,175,1], "B.Fab":[88,93,132,1]
  });
  // builtin_color_themes.h:232-276. User.9 is an exception.
  const user = [[194,194,194],[89,148,220],[180,219,210],[216,200,82]];
  for (let i=1;i<=45;i++) layers[`User.${i}`] = [...(i===9?[232,178,167]:user[(i-1)%4]),1];
  // builtin_color_themes.h:156-179, all PCB non-layer defaults.
  const objects = {
    anchor:[255,38,226,1], lockedShadow:[255,38,226,.5],
    conflictsShadow:[255,0,5,.5], auxItems:[255,255,255,1],
    background:[0,16,35,1], cursor:[255,255,255,1],
    drcError:[215,91,107,.8], drcWarning:[255,208,66,.8],
    drcExclusion:[255,255,255,.8], grid:[132,132,132,1],
    gridAxes:[194,194,194,1], platedHoles:[194,194,0,1],
    nonPlatedHoles:[26,196,210,1], ratsnest:[0,248,255,.35],
    selection:[4,255,67,1], viaHoles:[227,183,46,1],
    viaHolewalls:[236,236,236,1], drawingSheet:[200,114,171,1],
    pageLimits:[132,132,132,1], boardArea:[100,100,100,.35],
    netnames:[255,255,255,.7], padNetnames:[255,255,255,.9],
    viaNetnames:[50,50,50,.9], points:[255,38,226,1]
  };
  // pcbnew/widgets/appearance_controls.cpp:1750-1820, copper stack loop:1860-1882.
  const tech = ["F.Adhes","B.Adhes","F.Paste","B.Paste","F.SilkS","B.SilkS",
    "F.Mask","B.Mask","Dwgs.User","Cmts.User","Eco1.User","Eco2.User",
    "Edge.Cuts","Margin","F.CrtYd","B.CrtYd","F.Fab","B.Fab"];
  const users = Array.from({length:45},(_,i)=>`User.${i+1}`);
  const copper = ["F.Cu",...inner.map((_,i)=>`In${i+1}.Cu`),"B.Cu"];
  const appearanceOrder = [...copper,...tech,...users];
  // Draw priority is NOT Appearance order. Values express top-to-bottom roles.
  // pcbnew/pcb_draw_panel_gal.cpp:66-297, active-side promotion:585-635.
  const drawPriority = ["overlay","netnames","Dwgs.User","Cmts.User","Eco1.User",
    "Eco2.User","Edge.Cuts","Margin",...users,"text","ratsnest","holes",
    "F.Cu","F.Mask","F.SilkS","F.Paste","F.Adhes","F.CrtYd","F.Fab",
    ...inner.map((_,i)=>`In${i+1}.Cu`),
    "B.Cu","B.Mask","B.SilkS","B.Paste","B.Adhes","B.CrtYd","B.Fab",
    "drawingSheet","grid"];
  globalThis.KicadColors = {layers,objects,appearanceOrder,drawPriority};
})();
```

Render priority is expressed independently: reverse the top-to-bottom list for painter drawing; zones precede other objects on their own layer; pad/via copper precedes their drill overlays. Promote the selected side's layer family and then the selected layer, while leaving hole and review overlays above copper. Active B.Cu does not itself flip the view. Add `NOTICE` credit: “PCB default colour values and layer ordering data are derived from KiCad 10, KiCad contributors, source revision 3e051f88. No KiCad implementation source is included.”

- [ ] **Step 4: Run green.** `node ui/board-test.mjs`. Expected: all assertions pass. Inspect all 95 entries against source; do not replace inner colours with a modulo palette.
- [ ] **Step 5: Commit.** `git add ui/kicad-colors.js ui/board-test.mjs NOTICE && git commit -m "feat: define attributed KiCad PCB display data"`

### Task 2: Extract stable scene identity, units, tracks, vias, footprints, and pads

**Files:**
- Modify: `kicad_review.py:468` (add helpers after `pcb_objects`, leave its behavior unchanged)
- Test: `test_kicad_review.py`

**Interfaces:**
- Consumes: `parse_sexpr`, `find`, `findall`, `val`, `pcb_objects`, `pad_points`.
- Produces: `board_geometry(pcb_path) -> dict`, `geometry_um(value) -> int`, `geometry_point(point, footprint_at=None) -> list[int]`, `geometry_arc(start,mid,end,width) -> list[list[int]]`.
- Produces complete scenes for these object types; Task 3 extends the same function, not another parser.

- [ ] **Step 1: Add a minimal fixture and exact assertions.** Follow the existing file's assert-based style; use `TemporaryDirectory`, not a committed private board.

```python
from pathlib import Path
from tempfile import TemporaryDirectory
from kicad_review import board_geometry, geometry_um
GEOMETRY_FIXTURE = '''(kicad_pcb (version 20260206)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
 (net 0 "") (net 1 "GND")
 (segment (start 1 2) (end 3 2) (width .25) (layer "F.Cu") (net 1) (uuid tr))
 (via (at 4 5) (size .8) (drill .4) (layers "F.Cu" "B.Cu") (net 1) (uuid vi))
 (footprint "Test:X" (layer "B.Cu") (at 10 20 90) (uuid fp)
  (property "Reference" "J1")
  (pad "1" thru_hole oval (at 2 0 90) (size 2 1) (drill oval .8 .4)
   (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid pa))
  (pad "1" smd roundrect (at 0 2 90) (size 1 1) (roundrect_rratio .25)
   (layers "B.Cu") (net 1 "GND") (uuid pb))))'''
def scene_from_text(text):
    with TemporaryDirectory() as d:
        p = Path(d) / "test.kicad_pcb"
        p.write_text(text)
        return board_geometry(p)
s = scene_from_text(GEOMETRY_FIXTURE)
assert (s["version"], s["units"]) == (1, "um")
assert geometry_um("-0.0005") == -1
assert geometry_um("1.2345") == 1235
assert s["nets"] == [{"id": 0, "name": ""}, {"id": 1, "name": "GND"}]
assert [l["id"] for l in s["layers"]] == [0, 2, 44]  # never assume old KiCad IDs
by_id = {o["uuid"]: o for o in s["objects"]}
assert by_id["tr"]["geometry"]["segments"] == [[1000,2000,3000,2000,250]]
assert by_id["pa"]["geometry"]["primitive"]["center"] == [10000,18000]
assert by_id["pb"]["geometry"]["primitive"]["center"] == [12000,20000]
assert by_id["pa"]["changeUuid"] == by_id["pb"]["changeUuid"] == "fp"
assert by_id["pa"]["ref"] == "J1" and by_id["pa"]["net"] == 1
assert by_id["pa"]["geometry"]["primitive"]["angle"] == 90000
assert by_id["pa"]["geometry"]["drill"]["size"] == [800,400]
assert by_id["pb"]["geometry"]["primitive"]["radius"] == 250
assert all(l in {x["name"] for x in s["layers"]} for o in s["objects"] for l in o["layers"])
assert len({o["uuid"] for o in s["objects"]}) == len(s["objects"])
```

KiCad 10 stores pad orientation in the board frame; do not add footprint rotation twice. Footprint-local pad position rotates with `pad_points`' sign convention; a back footprint saved in a board already has mirrored local coordinates. Do not mirror it again based only on `B.Cu`. An old pad without UUID gets `parentUuid/pad:<number>:<occurrence>`; UUID-containing children retain the file UUID.

- [ ] **Step 2: Run red.** `python3 test_kicad_review.py`. Expected: missing `board_geometry` import.
- [ ] **Step 3: Implement normalized extraction with these numerical kernels.**

```python
from decimal import Decimal, ROUND_HALF_UP

def geometry_um(value):
    n = Decimal(str(value)) * 1000
    if not n.is_finite() or abs(n) > 2_000_000_000:
        raise ValueError("board coordinate outside supported range")
    return int(n.to_integral_value(rounding=ROUND_HALF_UP))

def geometry_point(point, footprint_at=None):
    x, y = map(float, point[:2])
    if footprint_at:
        fx, fy, *angle = footprint_at
        t = math.radians(float(angle[0]) if angle else 0)
        x, y = float(fx)+x*math.cos(t)+y*math.sin(t), float(fy)-x*math.sin(t)+y*math.cos(t)
    return [geometry_um(x), geometry_um(y)]

def geometry_arc(start, middle, end, width):
    ax, ay = map(float, start); bx, by = map(float, middle); cx, cy = map(float, end)
    d = 2*(ax*(by-cy)+bx*(cy-ay)+cx*(ay-by))
    if abs(d) < 1e-12:
        return [[*geometry_point(start), *geometry_point(end), geometry_um(width)]]
    aa, bb, cc = ax*ax+ay*ay, bx*bx+by*by, cx*cx+cy*cy
    ox = (aa*(by-cy)+bb*(cy-ay)+cc*(ay-by))/d
    oy = (aa*(cx-bx)+bb*(ax-cx)+cc*(bx-ax))/d
    a,b,c = [math.atan2(y-oy,x-ox) for x,y in ((ax,ay),(bx,by),(cx,cy))]
    sweep = (c-a) % math.tau
    if (b-a) % math.tau > sweep:
        sweep -= math.tau
    radius = math.hypot(ax-ox,ay-oy)
    # 1 um maximum chord error; cap protects hostile inputs, never silently coarsen.
    step = 2*math.acos(max(-1,1-.001/max(radius,.001)))
    count = max(1,math.ceil(abs(sweep)/max(step,1e-8)))
    if count > 65536:
        raise ValueError("arc exceeds geometry budget")
    pts = [geometry_point((ox+radius*math.cos(a+sweep*i/count),
                           oy+radius*math.sin(a+sweep*i/count))) for i in range(count+1)]
    pts[0],pts[-1] = geometry_point(start),geometry_point(end)
    return [[*p,*q,geometry_um(width)] for p,q in zip(pts,pts[1:])]
```

Build `board_geometry` by reading one root, then:

1. Read `layers` records without hardcoded KiCad numeric enums. Every declared board layer is enabled; don't confuse hidden `hide` display state with disabled board layers. Include empty declared layers. Expand `*.Cu`, `*.Mask`, and `F&B.Cu` against declared names. Blind/buried via copper spans the ordered copper interval between its two endpoints.
2. Read root `(net id name)` records. Also collect modern named `(net "GND")` leaves and zone `(net_name ...)`. Give names not in the root table deterministic IDs sorted by name, while preserving numeric IDs where present. Net zero always exists; keep an unnamed numeric net's stable placeholder and a warning, not a wrong net name.
3. Emit one track/arc/via per source node. Track width belongs in bounds. A via primitive is circular, with a drill. Through-via copper is duplicated across its copper span at batching time, not duplicated as different semantic objects.
4. Emit a metadata-only footprint then children. Reference comes from `properties(n)` with `fp_text reference` fallback. Children inherit `changeUuid`, `ref`, front/back side, and visibility. `category` distinguishes values, references, other text, and filled shapes.
5. Pad geometry supports circle, rect, oval, roundrect, trapezoid, custom primitives. Store pad `rect_delta`, local drill offset transformed into the board frame, plated/NPTH type, mask margin, paste margin/ratio, and per-pad layer exclusions. Derive mask/paste primitive dimensions using those margins (pad override, footprint override, board setup fallback). NPTH is not copper by default. Custom primitive segments/rings use pad-local transform with the pad's world angle. Unsupported custom primitive tags set `complete:false` and a warning instead of inventing a rectangle.
6. Every object has the contract's fields, finite integer geometry, and an actual geometry bbox. Footprint bbox is union of children. `bounds` is the union of drawable bboxes, empty board `[0,0,0,0]`.
7. Return `complete:false` plus a precise `uuid/kind/reason` warning for visible drawable types not yet supported. Unknown metadata must not force fallback. Invalid numeric geometry raises `ValueError`; the pipeline records the warning and uses SVG.

Pin these rules with additional actual assertions:

```python
from kicad_review import geometry_arc
arc = geometry_arc((1,0),(0,1),(-1,0),".2")
assert arc[0][:2] == [1000,0] and arc[-1][2:4] == [-1000,0]
assert max(max(x[1],x[3]) for x in arc) == 1000
without_ids = GEOMETRY_FIXTURE.replace('(uuid pa)','').replace('(uuid pb)','')
a = scene_from_text(without_ids)
ids = [o["uuid"] for o in a["objects"] if o["kind"] == "pad"]
assert ids == ["fp/pad:1:1", "fp/pad:1:2"]
modern = GEOMETRY_FIXTURE.replace('(net 1 "GND")','(net "GND")').replace('(net 1)', '(net "GND")')
assert len([n for n in scene_from_text(modern)["nets"] if n["name"] == "GND"]) == 1
for bad in ("NaN", "Infinity", "3000000"):
    try:
        geometry_um(bad)
        raise AssertionError(bad)
    except ValueError:
        pass
```

- [ ] **Step 4: Run green.** `python3 test_kicad_review.py`. Expected: existing object-diff assertions and new scene assertions pass. No change to `pcb_objects` output.
- [ ] **Step 5: Commit.** `git add kicad_review.py test_kicad_review.py && git commit -m "feat: extract micrometre PCB primitives with stable identities"`

### Task 3: Preserve zone topology, graphics, and drawable text

**Files:**
- Modify: `kicad_review.py` (`board_geometry` and geometry helpers)
- Test: `test_kicad_review.py`

**Interfaces:**
- Consumes: Task 2 scene schema and transform kernels.
- Produces: `zone.geometry.rings`, shape segments/rings, text metadata, completeness warnings. Rings retain even-odd topology; no triangulation dependency.

- [ ] **Step 1: Add topology/text fixtures.**

```python
EXTRA = '''
(zone (net 1) (layer "F.Cu") (uuid zone)
 (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
 (filled_polygon (layer "F.Cu")
  (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10) (xy 0 0)
       (xy 2 2) (xy 2 8) (xy 8 8) (xy 8 2) (xy 2 2) (xy 0 0))))
(gr_line (start -1 -1) (end 11 -1) (stroke (width .05) (type default))
 (layer "Edge.Cuts") (uuid edge))
(gr_text "<& Board" (at 5 6 30) (layer "F.SilkS") (uuid text)
 (effects (font (size 1 1) (thickness .15)) (justify left mirror)))
'''
s = scene_from_text(GEOMETRY_FIXTURE[:-1] + EXTRA + ')')
u = {o["uuid"]:o for o in s["objects"]}
u["zone"] = next(o for o in s["objects"] if o["changeUuid"] == "zone" and o["geometry"].get("rings"))
assert u["zone"]["geometry"]["rings"][0][1] == [10000,0]
assert u["edge"]["geometry"]["segments"] == [[-1000,-1000,11000,-1000,50]]
assert u["text"]["geometry"]["text"]["value"] == "<& Board"
assert u["text"]["geometry"]["text"]["angle"] == 30000
assert u["text"]["geometry"]["text"]["mirror"] is True
unfilled = EXTRA[:EXTRA.index('(gr_line')].replace('filled_polygon','not_a_fill')
z = scene_from_text(GEOMETRY_FIXTURE[:-1]+unfilled+')')
assert next(o for o in z["objects"] if o["changeUuid"] == "zone")["geometry"]["rings"] == []
assert any("stored fill" in w for w in z["warnings"])
```

- [ ] **Step 2: Run red.** `python3 test_kicad_review.py`. Expected: missing zone/text/shape geometry assertion.
- [ ] **Step 3: Implement the geometry dispatch.** For each `filled_polygon`, retain its `layer` and all points in order; KiCad's slit bridges and repeated endpoints are meaningful. Emit separate zone geometry records per layer using unique child IDs such as `zoneUuid/fill:F.Cu`, with `changeUuid:zoneUuid`. Merge islands into one even-odd rings list only when they belong to the same source fill region. Do not concatenate independent rings with a spurious closing edge. Unfilled zones have outline segments only, no fill; warning says `zone <uuid>: no stored fill; showing outline`. Rule areas/keepouts are outline geometry, not poured copper.

Flatten `gr_line/fp_line`, `gr_arc/fp_arc`, `gr_rect/fp_rect`, `gr_circle/fp_circle`, `gr_poly/fp_poly`, and cubic `gr_curve/fp_curve`. Rectangle outline uses four segments; a filled rectangle has a ring. Circle and cubic flattening use 1 µm chord error with a 65,536-segment guard. A cubic uses recursive de Casteljau subdivision until both control-point distances to the chord are ≤.001 mm; depth limit 24 causes explicit SVG fallback, not geometry loss. Use stroke width from `stroke.width` with legacy `width` fallback. Apply footprint transform to points once; use closed rings only for filled shapes. Dimension/table/text-box/image nodes unsupported by this implementation cause `complete:false` if visible, preserving the authoritative SVG. Do not claim full KiCad object coverage when a node falls back.

For text, preserve hidden flags (both atom `hide` and `(hide yes)`), `unlocked`, font size/thickness, angle, left/right/top/bottom justification, mirrored glyphs, bold and italic. Footprint `property Reference/Value` is drawable only with position/layer/effects and no hide flag. Resolve `${REFERENCE}` and `${VALUE}` from the footprint; unresolved substitution becomes a completeness warning. Named embedded outline fonts or unsupported rich text use SVG, not incorrect labels. For default text, the renderer uses a local system monospace atlas, a documented visual approximation rather than KiCad's GPL stroke-font implementation. Compare label placement and legibility in Task 10; if the difference fails owner review, keep that revision on SVG pending an explicitly licensed font-data decision.

Use a shape/text fixture extension to pin hidden properties and unsupported visible objects:

```python
hidden = '(gr_text "SECRET" (at 0 0) (layer "F.SilkS") hide (uuid hidden) (effects (font (size 1 1))))'
ss = scene_from_text(GEOMETRY_FIXTURE[:-1]+hidden+')')
assert next(o for o in ss["objects"] if o["uuid"] == "hidden")["hidden"]
unsupported = '(dimension (type aligned) (layer "Dwgs.User") (uuid dimension))'
ss = scene_from_text(GEOMETRY_FIXTURE[:-1]+unsupported+')')
assert ss["complete"] is False and any("dimension" in w for w in ss["warnings"])
```

- [ ] **Step 4: Run green.** `python3 test_kicad_review.py`. Expected: all assertions pass. No zone is filled from its unfilled outline.
- [ ] **Step 5: Commit.** `git add kicad_review.py test_kicad_review.py && git commit -m "feat: preserve PCB zone fills graphics and label geometry"`

### Task 4: Build retained batches and round-segment/via GPU programs

**Files:**
- Create: `ui/board-gl.js`
- Modify: `ui/board-test.mjs`, `ui/checks.mjs`, `ui/review.html`, `kicad_review.py` (load and inline the new classic scripts)

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots of the synthetic primitives. KiCad references win.

**Interfaces:**
- Consumes: Task 1 palette, Tasks 2–3 scene.
- Produces: global `BoardGL` methods in shared contract; renderer with retained buffers and diagnostic counters. Task 5 extends it to rings/text/grid.

- [ ] **Step 1: Add a CPU batch/no-rebuild test.**

```js
await import("./board-gl.js");
const G = globalThis.BoardGL;
const primitiveScene = {version:1,units:"um",complete:true,warnings:[],bounds:[0,0,4000,4000],
 layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],
 objects:[{kind:"track",uuid:"a",changeUuid:"a",ref:"",layers:["F.Cu"],net:0,
 category:"tracks",side:null,hidden:false,box:[0,0,4000,1000],
 geometry:{segments:[[500,500,3500,500,500]]}}]};
G.validateScene(primitiveScene);
const batches = G.buildBatches(primitiveScene,"base");
assert.equal(batches.length,1);
assert.equal(batches[0].key,"base|F.Cu|track");
assert.equal(batches[0].instances.length,9); // a.xy,b.xy,radius,net,category,side,objectIndex
assert.equal(batches[0].ranges[0].uuid,"a");
assert.equal(G.layerFactor("B.Cu",{activeLayer:"F.Cu",contrast:"dim"}),.2);
assert.equal(G.layerFactor("B.Cu",{activeLayer:"F.Cu",contrast:"hide"}),0);
assert.equal(G.layerFactor("Edge.Cuts",{activeLayer:"F.Cu",contrast:"hide"}),.3);
```

Add a browser check that creates a canvas, renders this scene twice, records `stats.uploads`, changes layer RGB/alpha and tracks opacity, renders again, and asserts unchanged uploads plus a changed center pixel. Keep scene input inline in the check so it cannot skip against a report without geometry.

- [ ] **Step 2: Run red.** `node ui/board-test.mjs`; `CHECK_PORT=9357 node ui/check.mjs 'board uniform'`. Expected: missing renderer API.
- [ ] **Step 3: Implement retained segment instances.** `validateScene` rejects wrong version/units, nonfinite bounds, invalid layer IDs, missing arrays, geometry coordinates outside safe integer range, unknown net references, and >2,000,000 primitive vertices. Return null renderer if WebGL2 or stencil bits unavailable; do not fake a successful empty render. GPU allocations happen once in `create`; every shader compilation/link failure calls `onFailure` once and disposes allocated resources.

Use a static six-vertex unit quad and one nine-float instance per segment. Float coordinates in buffers are **mm relative to the scene bounds center**, not absolute µm; this preserves precision on offset designs. Uniform camera center uses the same origin. Segment width and position conversion happens once. A zero-length segment is a disc. Vias/pad circles use the same program with equal endpoints. A separate drill pass renders actual capsule holes with hole-wall colour then board-background center, above copper, respecting blind-via active-span visibility.

```glsl
#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
layout(location=1) in vec4 endpoints;
layout(location=2) in float radius;
layout(location=3) in float netId;
layout(location=4) in float categoryId;
layout(location=5) in float sideId;
layout(location=6) in float objectId;
uniform vec2 cameraCenter;
uniform vec2 viewportSize;
uniform float zoom;
uniform float mirrorX;
out vec2 localPoint;
flat out float halfLength;
flat out float r;
flat out int netIndex;
void main() {
  vec2 delta = endpoints.zw-endpoints.xy;
  float len = length(delta);
  vec2 tangent = len>0.0 ? delta/len : vec2(1,0);
  vec2 normal = vec2(-tangent.y,tangent.x);
  vec2 center=(endpoints.xy+endpoints.zw)*0.5;
  float margin=1.0/zoom;
  localPoint=corner*vec2(len*0.5+radius+margin,radius+margin);
  vec2 world=center+tangent*localPoint.x+normal*localPoint.y;
  vec2 pixel=(world-cameraCenter)*zoom*vec2(mirrorX,1.0);
  gl_Position=vec4(pixel/viewportSize*vec2(2,-2),0,1);
  halfLength=len*0.5; r=radius; netIndex=int(netId);
}
```

```glsl
#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 localPoint;
flat in float halfLength;
flat in float r;
flat in int netIndex;
uniform vec4 layerColor;
uniform vec3 backgroundColor;
uniform float kindOpacity;
uniform float contrastFactor;
uniform sampler2D netStyle;
uniform int selectedNet;
out vec4 outColor;
void main() {
  float distanceToLine=length(vec2(max(abs(localPoint.x)-halfLength,0.0),localPoint.y))-r;
  float aa=max(fwidth(distanceToLine),0.000001);
  float coverage=1.0-smoothstep(-aa,aa,distanceToLine);
  vec4 ns=texelFetch(netStyle,ivec2(netIndex,0),0);
  if(ns.a<0.0 || coverage==0.0) discard;
  vec3 rgb=ns.a>0.0 ? ns.rgb : layerColor.rgb;
  float retained=selectedNet>=0 && netIndex!=selectedNet ? 0.2 : 1.0;
  rgb=mix(backgroundColor,rgb,contrastFactor*retained);
  outColor=vec4(rgb,layerColor.a*kindOpacity*coverage);
}
```

The net table is compact-indexed during batch construction because file net IDs may be sparse. Invisible-net alpha sentinel is `-1`, default inherit is `0`, explicit override alpha is `(0,1]`. Multiply explicit net alpha into output alpha; extend the fragment's final alpha with `ns.a>0.0 ? ns.a : 1.0`. Net zero is not highlighted/dimmed unless explicitly selected. Apply category and footprint-side visibility in shader lookup uniforms before output; category/side data already exists in the instance buffer. Keep shader enum IDs defined once in JS, not inferred from source-layer names.

Expose the renderer to the existing browser harness in this task. Insert classic script tags for `kicad-colors.js` and `board-gl.js` immediately before `review.js` in `review.html`. In `inline_page`, before its final external-asset assertion, add:

```python
for asset in ("kicad-colors.js", "board-gl.js"):
    page = page.replace(f'<script src="{asset}"></script>', f'<script>\n{read(asset)}</script>')
```

Extend the final assertion's filename alternatives to these two scripts. This is functional offline integration of the independently tested renderer, not an empty scaffold. Pixel tests instantiate synthetic scenes directly with `BoardGL.create`; they do not require generated project geometry or a report camera adapter yet.

Draw with `drawArraysInstanced(TRIANGLES,0,6,count)`, `vertexAttribDivisor(...,1)`, standard nonpremultiplied `SRC_ALPHA/ONE_MINUS_SRC_ALPHA` blending, disabled depth. Set viewport backing pixels while `viewportSize` remains CSS pixels. `stats.uploads` increments at the actual buffer upload sites, not only high-level calls. Invisible layer means skip its draw, not upload zeros. `layerFactor` blends RGB toward background; it does **not** set opacity to .2 and expose underlying copper incorrectly. Honor explicit layer visibility before Edge.Cuts' retained ≥.3 exception.

- [ ] **Step 4: Run green.** Node batch tests and Chrome pixel/no-upload test pass. Capture synthetic tracks and via holes in both themes; their board pixels must be identical.
- [ ] **Step 5: Commit.** `git add ui/board-gl.js ui/board-test.mjs ui/checks.mjs ui/review.html kicad_review.py && git commit -m "feat: render retained PCB segment and via batches in WebGL2"`

### Task 5: Render pad primitives, even-odd fills, text, grid, and resize safely

**Files:**
- Modify: `ui/board-gl.js`, `ui/board-test.mjs`, `ui/checks.mjs`, `ui/review.css`

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots. KiCad references win.

**Interfaces:**
- Consumes: `geometry.primitive`, `geometry.rings`, `geometry.text` and retained renderer from Task 4.
- Produces: all supported scene objects rendered; stencil fills preserve holes; `worldToScreen`/`screenToWorld`; renderer `readPixel` and complete resource disposal.

- [ ] **Step 1: Add camera and topology checks.**

```js
const camera={x:10,y:20,z:8,width:800,height:600,dpr:2,flip:true};
const px=G.worldToScreen([12,23],camera);
assert.deepEqual(px,[384,324]);
assert.deepEqual(G.screenToWorld(px,camera),[12,23]);
assert.deepEqual(G.worldToScreen([10,20],camera),[400,300]);
```

Add a browser check named `board rings holes islands and DPR`. Its synthetic zone has outer ring `[[0,0],[10000,0],[10000,10000],[0,10000]]`, inner ring `[[2000,2000],[8000,2000],[8000,8000],[2000,8000]]`, and disconnected island `[[12000,0],[14000,0],[14000,2000],[12000,2000]]`. At camera `{x:7,y:5,z:20,width:400,height:300,dpr:1,flip:false}`, render with zone opacity 1 and grid off. Assert pixel at world `(1,1)` equals copper, `(5,5)` equals background, `(13,1)` equals copper, `(11,1)` equals background. Repeat with reversed inner winding, a repeated closing point, DPR 2, and a concave outer ring. Assert no bridge across the hole. Create a second overlapping zone and ensure stencil clears per object, not per whole batch.

- [ ] **Step 2: Run red.** `node ui/board-test.mjs`; `CHECK_PORT=9358 node ui/check.mjs 'board rings'`. Expected: missing camera API or incorrect/no filled pixels.
- [ ] **Step 3: Implement fills without a triangulator dependency.** For each source ring upload triangle-fan vertices once (`v0,vi,vi+1`), even for concave polygons. During drawing, invert stencil on all covered fragments with colour writes disabled, then draw the object's bbox quad only where stencil parity equals 1. This parity construction fills concave polygons and holes; a plain colour triangle fan would be wrong. Keep object draw ranges inside the layer/kind buffer. Custom pads combine unioned source primitives before stencil parity: overlapping positive primitives must not cancel. Render each custom primitive as a stencil union (`REPLACE 1` for positive primitives), then apply explicit holes; arbitrary custom boolean subtraction without a declared role is unsupported and must fall back.

```js
// Per filled object; arrays and bbox quads have already been uploaded.
gl.enable(gl.STENCIL_TEST);
gl.stencilMask(0xff);
gl.clearStencil(0);
gl.clear(gl.STENCIL_BUFFER_BIT);
gl.colorMask(false,false,false,false);
gl.stencilFunc(gl.ALWAYS,0,0xff);
gl.stencilOp(gl.KEEP,gl.KEEP,gl.INVERT);
gl.drawArrays(gl.TRIANGLES,range.first,range.count);
gl.colorMask(true,true,true,true);
gl.stencilMask(0);
gl.stencilFunc(gl.EQUAL,1,1);
gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);
gl.drawArrays(gl.TRIANGLES,range.boxFirst,6);
gl.disable(gl.STENCIL_TEST);
```

Resolve drill holes in copper/pads as geometry cutouts or per-fragment drill rejection, not by painting the hole per copper layer (later layers could cover it). Final coloured hole-wall/center pass matches the reference. Rect/roundrect/oval pads use transformed signed-distance quads, using `angle/1000` with the board Y-down convention. Trapezoids and custom pad polygons use retained rings. One upload per layer/kind includes all ranges; colour edits remain uniforms. Text glyph atlas is generated locally with Canvas2D system monospace, uploaded once per scene font/size family, no external fonts. Glyph quad positions are mm, honoring rotation, mirror, justification, font flags, and hidden properties. Store category values/references/text so their eye toggles work independently. Unknown glyph rendering and named fonts follow Task 3's completeness policy.

Use camera transforms for all passes:

```js
function worldToScreen([x,y],c) {
  return [c.width/2+(x-c.x)*c.z*(c.flip?-1:1), c.height/2+(y-c.y)*c.z];
}
function screenToWorld([x,y],c) {
  return [c.x+(x-c.width/2)/c.z*(c.flip?-1:1), c.y+(y-c.height/2)/c.z];
}
```

Grid is a fullscreen fragment pass behind objects, not thousands of DOM dots. Invert camera to board mm, calculate `abs(fract(world/grid+.5)-.5)*grid*zoom*dpr`, render ≤1 device-pixel round dots at intersections; hide grid when spacing is <4 CSS px to avoid a solid sheet. Default .5 mm; grid off leaves board geometry unchanged. Grid origin is board `(0,0)`, not viewport origin, so pan does not swim. Flip affects X only, never layer order or stored coordinates.

Resize at render start: backing width/height `round(clientWidth*dpr)`; skip if either is zero, preserving last valid camera and scene. Observe canvas/container resize and request one rAF draw, not a permanent loop. Dispose all VAOs, buffers, programs, textures, renderbuffers/framebuffers, ResizeObservers, and listeners. `dispose()` is idempotent. Scene buffers survive pan/zoom; replacing a board or leaving it releases them.

- [ ] **Step 4: Run green.** Node assertions and stencil/DPR browser checks pass. Render all primitive types together with labels; inspect each hole at enlarged zoom. Capture both themes.
- [ ] **Step 5: Commit.** `git add ui/board-gl.js ui/board-test.mjs ui/checks.mjs ui/review.css && git commit -m "feat: render PCB fills pads labels and stable dot grid"`

### Task 6: Embed scenes and load them without stale asynchronous results

**Files:**
- Modify: `kicad_review.py:1810-1875,1909-1924` (`build_project`, `inline_page`)
- Modify: `ui/review.html`, `ui/review.js:250-264`
- Test: `test_kicad_review.py`, `ui/checks.mjs`

**Interfaces:**
- Consumes: `board_geometry`, `add_blob`, `svgText(blobKey)` (existing decoded text helper).
- Produces: optional `board.geometry:{base,head}`, `loadBoardScene(key) -> Promise<scene|null>`, `boardView` lifecycle record.

- [ ] **Step 1: Add blob/inlining assertions and a stale-load browser check.**

```python
import json, gzip, base64
from kicad_review import add_blob, inline_page
blobs = {}
scene = scene_from_text(GEOMETRY_FIXTURE)
raw = json.dumps(scene,separators=(',',':'),sort_keys=True)
key = add_blob(blobs,raw)
assert add_blob(blobs,raw) == key and len(blobs) == 1
assert json.loads(gzip.decompress(base64.b64decode(blobs[key]))) == scene
page = inline_page('window.REVIEW_DATA = {"projects":[],"blobs":{}};')
for asset in ('kicad-colors.js','board-gl.js'):
    assert f'src="{asset}"' not in page
assert 'KicadColors' in page and 'BoardGL' in page
```

Add to `CHECKS`:

```js
["board scene stale decode does not replace current view", "v=board&x=10&y=20&z=5", `
  const old = loadBoardScene;
  let release;
  loadBoardScene = async key => { await new Promise(r => release = r); return old(key); };
  const a = draw();
  const sheet = proj().sheets.find(s => s.svg);
  if (!sheet) { loadBoardScene=old; release?.(); await a; return "skip"; }
  S.v = "sheet:"+sheet.path; const b = draw(); release?.();
  await Promise.all([a,b]); loadBoardScene=old;
  return S.v.startsWith("sheet:") && !document.querySelector(".board-gl");
`]
```

- [ ] **Step 2: Run red.** `python3 test_kicad_review.py`; `CHECK_PORT=9356 node ui/check.mjs 'board scene stale'`. Expected: new asset/global checks fail, then undefined loader before implementation.
- [ ] **Step 3: Integrate the format extension.** Add geometry keys using this body beside `board` assembly, not inside SVG layer iteration:

```python
geometry = {}
for side in ("base", "head"):
    pcb = posixpath.join(side, p["dir"], p["name"] + ".kicad_pcb")
    geometry[side] = None
    if os.path.isfile(pcb):
        try:
            scene = board_geometry(pcb)
            geometry[side] = add_blob(blobs, json.dumps(scene, separators=(",", ":"), sort_keys=True))
        except (ValueError, IndexError, TypeError) as exc:
            print(f"{pcb}: geometry unavailable; retaining SVG: {exc}", file=sys.stderr)
if any(geometry.values()):
    board["geometry"] = geometry
```

Absence of a board is valid and creates no warning. Preserve unchanged-board rendering policy: adding geometry must not mark an unchanged project changed or force all reports to include layers.

Keep classic script tags in `review.html` in order: `kicad-colors.js`, `board-gl.js`, `review.js`. The renderer task already inlines these first two assets; preserve that path here. The Appearance task later inserts and inlines `appearance.js` immediately before `review.js`. Extend the external-asset assertion to each new name when it is added. No `type=module`, runtime imports, fetch, or CDN URLs in generated HTML.

```js
const boardView = {scenes: null, renderers: [], appearance: null, generation: 0};
const boardSceneCache = new Map();
async function loadBoardScene(key) {
  if (!key) return null;
  if (!boardSceneCache.has(key)) boardSceneCache.set(key, (async () => {
    const text = await svgText(key);
    const scene = JSON.parse(text);
    BoardGL.validateScene(scene);
    return scene;
  })().catch(error => { boardSceneCache.delete(key); throw error; }));
  return boardSceneCache.get(key);
}
```

`svgText` already decodes gzip bytes to text; despite its name it need not parse SVG. Confirm this before reuse. Never pass geometry JSON to the SVG DOM loader. Reuse `draw`'s generation guard after **every** asynchronous load and before replacing stage or disposing current GPU resources. Catch JSON/decompression/schema errors and route to SVG with a status message. Cache only scene data; disposing a renderer must release GPU resources even if scene data remains cached. Test added-only, removed-only, no geometry, and corrupt geometry blob reports.

- [ ] **Step 4: Run green.** `python3 test_kicad_review.py`; `CHECK_PORT=9356 node ui/check.mjs 'board scene stale'`. Expected: pass; no stale canvas on a schematic. Run the complete browser suite again after Task 7.
- [ ] **Step 5: Commit.** `git add kicad_review.py test_kicad_review.py ui/review.html ui/review.js ui/checks.mjs && git commit -m "feat: inline and safely load revision board scenes"`

### Task 7: Route the report through WebGL without breaking SVG or existing modes

**Files:**
- Create: `ui/appearance.js` (functional default state; Task 8 extends persistence and controls)
- Modify: `ui/review.html`, `kicad_review.py` (load and inline Appearance state)
- Modify: `ui/review.js:210-338` (`currentView`, `draw`, `apply`, `fit`, input coordinate adapters)
- Modify: `ui/review.css`, `ui/checks.mjs`

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots. KiCad references win.

**Interfaces:**
- Consumes: `loadBoardScene`, `BoardGL.create`, shared camera/state, existing `MODES`, selection/pin overlays.
- Produces: WebGL Side view with linked cameras; SVG fallback for old/incomplete scenes or unsupported mode; existing review behavior remains available.

- [ ] **Step 1: Add explicit fallback and camera checks.**

```js
["board WebGL cameras fallback and context loss", "v=board&x=10&y=20&z=5", `
  if (!proj().board.geometry) return "skip";
  S.m="side"; await draw();
  if (boardView.renderers.length!==2) return "expected two supported revision canvases";
  const before={x:S.x,y:S.y,z:S.z};
  setT({x:12,y:22,z:6});
  if (boardView.renderers.some(r=>r.stats.disposed)) return "disposed current scene";
  const canvas=document.querySelector(".board-gl");
  canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
  await new Promise(r=>setTimeout(r,100));
  if (document.querySelector(".board-gl") || !document.querySelector(".stack .layer")) return "no SVG fallback";
  return S.x===12 && S.y===22 && S.z===6 && !!before;
`]
```

Add a synthetic two-revision scene when the sample lacks geometry so the primary context-loss path is not solely skipped. Separately delete `board.geometry`, redraw all five modes, and assert `.stack .layer` still exists with old checks unchanged. Force `BoardGL.create` to return null to test missing WebGL2. Add corrupt/unsupported scene cases and added-only/removed-only board cases.

- [ ] **Step 2: Run red.** `CHECK_PORT=9359 node ui/check.mjs 'board WebGL'`. Expected: no board canvases yet.
- [ ] **Step 3: Integrate rendering and fallback.** First introduce the functional initial state in `ui/appearance.js`, before wiring the report. Implement `Appearance.defaults(names)` with the complete default-state function and `OBJECT_ROWS` table printed in Task 8; this code has one implementation and is not duplicated in `review.js`. Load the new classic script before `review.js`, inline it through the existing asset loop, and expose:

```js
function boardAppearance() {
  if (!boardView.appearance) {
    const names = [...new Set((boardView.scenes||[]).filter(Boolean)
      .flatMap(scene=>scene.layers.filter(layer=>layer.enabled).map(layer=>layer.name)))];
    boardView.appearance = Appearance.defaults(names);
  }
  return boardView.appearance;
}
```

Reset that in-memory state on project change, not every draw. Task 8 extends this same state owner with validated persisted overrides and `changeBoardAppearance`; no temporary alternate schema is needed. Renderer tests use the default settings directly now. Record `boardView.scenes=[baseScene,headScene]` in that exact order, including null for an absent board revision.

Use connected canvases inside existing `.vp` wrappers. Keep `.world` selection/pin overlays and existing `.marker` elements, but do not CSS-transform the WebGL canvas itself. `apply()` updates SVG `.world` transforms and calls `renderer.render` with `S.x/S.y/S.z` for every live board canvas. Fit uses scene bounds divided by 1000, never `getBBox()` on absent SVG. Hash serialization is untouched.

```js
function boardCamera(vp) {
  return {x:S.x,y:S.y,z:S.z,width:vp.clientWidth,height:vp.clientHeight,
    dpr:devicePixelRatio||1,flip:!!boardAppearance().flip};
}
function disposeBoardRenderers() {
  for (const r of boardView.renderers) r.dispose();
  boardView.renderers=[];
}
```

On missing/invalid geometry or GPU failure, dispose **both** revisions and redraw using existing layered SVG; do not leave one pane WebGL and another with a different camera convention. Announce “WebGL unavailable — showing SVG” or “Geometry unsupported — showing SVG” in the stage-3 status message cell. Keep detailed scene warnings in a text-only expandable diagnostics section. `webglcontextlost` prevents default, records renderer unavailable for this view generation, and routes once to SVG; do not auto-loop recreate failed contexts. On a later project navigation a new renderer may be attempted.

Stage boundary: enable WebGL in `side` mode now. Retain the existing SVG `overlay`, `wipe`, `blend`, `semantic` modes unmodified until Stage 5 supplies their exact GL compositing semantics. Keep Appearance's layer settings effective in these SVG modes; disable type/net controls there with the reason “Available in the geometry viewer”. Stage 5 can enable those modes through the same `renderer.render` contract. Benchmark two revisions in Side and on a single synthetic overlay canvas using two retained renderer scene sets only if Stage 5 has already landed; never claim the existing SVG modes are WebGL-complete.

All pointer-to-world consumers (`pickAt`, `proposePin`, click-to-place, anchor hit testing) use a shared inverse camera adapter; all marker/pin projection uses its forward adapter. Flip never changes anchor coordinates, UUIDs, diff IDs, hash `x/y`, or net names. In fallback, apply horizontal mirror to SVG content and its overlay together, while keeping marker words readable with counter-mirroring. Layer colour rewriting must preserve `none` fills/strokes and existing inline opacity, as the rendering evaluation warns; map each layer's original non-`none` RGB to its configured layer colour, retaining custom object/diff colours. Keep 3D mode and schematic routing unchanged.

- [ ] **Step 4: Run green and all regressions.**

```sh
python3 test_kicad_review.py
node ui/board-test.mjs
node --import ./site/css-loader.mjs --test site/test.mjs
CHECK_PORT=9359 node ui/check.mjs
CHECK_PORT=9360 node ui/check.mjs --dark
```

Expected: all existing checks pass unchanged, plus new WebGL/fallback checks. Existing DOM-sensitive checks still run against the shipped sample SVG path; add geometry-specific checks without deleting or weakening the originals.

- [ ] **Step 5: Commit.** `git add ui/appearance.js ui/review.html kicad_review.py ui/review.js ui/review.css ui/checks.mjs && git commit -m "feat: integrate shared board camera with safe SVG fallback"`

### Task 8: Build Appearance Layers, Objects, and Nets with safe persistence

**Files:**
- Modify: `ui/appearance.js` (extend the default state introduced in Task 7)
- Modify: `kicad_review.py` (`inline_page` asset substitution and external-asset assertion)
- Modify: `ui/review.html`, `ui/review.css`, `ui/review.js` (`renderLayers`, board state adapters)
- Modify: `ui/board-test.mjs`, `ui/checks.mjs`

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return screenshots in both themes for Layers, Objects, Nets, Dim, Hide, flip, and active B.Cu.

**Interfaces:**
- Consumes: canonical union of revision layers, union of net names, KicadColors, renderer settings.
- Produces: global `Appearance`, `boardAppearance()`, `changeBoardAppearance(patch)`. Stage 7 theme import/reset will reuse normalization; expose reset defaults now but do not add an incomplete importer.

- [ ] **Step 1: Add state corruption and UI checks.**

```js
await import("./appearance.js");
const A=globalThis.Appearance;
const layerNames=["F.Cu","B.Cu","Edge.Cuts"];
const defaults=A.defaults(layerNames);
assert.equal(defaults.objects.tracks.opacity,1);
assert.equal(defaults.objects.vias.opacity,1);
assert.equal(defaults.objects.pads.opacity,1);
assert.equal(defaults.objects.zones.opacity,.6);
assert.equal(defaults.objects.images.opacity,.6);
assert.equal(defaults.contrast,"normal");
assert.equal(A.normalize({layers:{"F.Cu":{opacity:NaN}},contrast:"bad"},layerNames).contrast,"normal");
assert.equal(A.normalize({layers:{"F.Cu":{visible:false}}},[...layerNames,"In1.Cu"]).layers["In1.Cu"].visible,true);
const blocked={getItem(){throw new Error("blocked")},setItem(){throw new Error("blocked")}};
assert.deepEqual(A.load(blocked,layerNames),defaults);
assert.doesNotThrow(()=>A.save(blocked,defaults));
```

Browser check `board appearance native controls and no uploads` selects `Objects`, moves Tracks opacity to `.25`, checks `boardAppearance().objects.tracks.opacity`, and verifies unchanged GPU upload count. Toggle a layer eye, choose B.Cu active, cycle Dim/Hide, check factor .2 and retained Edge.Cuts .3 through `BoardGL.layerFactor`. Filter Nets using a literal `<img onerror=...>` net name inserted into synthetic scene; verify text is literal and no `img` element exists. Select a net, set colour and visibility, verify net lookup changes without geometry uploads. Reload and verify persisted state, then simulate malformed JSON and throwing storage.

- [ ] **Step 2: Run red.** `node ui/board-test.mjs`; `CHECK_PORT=9361 node ui/check.mjs 'board appearance'`. Expected: missing Appearance module/API.
- [ ] **Step 3: Implement schema, storage, and dense native controls.**

```js
const OBJECT_ROWS = [
 ["tracks","Tracks",1],["vias","Vias",1],["pads","Pads",1],
 ["zones","Zones",.6],["filledShapes","Filled Shapes",1],["images","Images",.6],
 ["frontFootprints","Footprints Front"],["backFootprints","Footprints Back"],
 ["values","Values"],["references","References"],["footprintText","Footprint Text"],
 ["ratsnest","Ratsnest"],["drcMarkers","DRC markers"],["drawingSheet","Drawing Sheet"],["grid","Grid"]
];
function defaults(names) {
  return {version:1,activeLayer:names.includes("F.Cu")?"F.Cu":names[0]||null,
    contrast:"normal",flip:false,units:"mm",grid:.5,markStyle:"outline",
    layers:Object.fromEntries(names.map(name=>[name,{visible:true,
      color:[...(KicadColors.layers[name]||[194,194,194,1])],opacity:1}])),
    objects:Object.fromEntries(OBJECT_ROWS.map(([id,label,opacity])=>[id,{visible:true,opacity:opacity??1}])),
    nets:{},selectedNet:null};
}
function load(storage,names) {
  try { return normalize(JSON.parse(storage.getItem("kr.appearance.v1")),names); }
  catch { return defaults(names); }
}
function save(storage,state) {
  try { storage.setItem("kr.appearance.v1",JSON.stringify(state)); } catch {}
}
```

`normalize(input,names)` starts from defaults, returns defaults for null/wrong version/non-object, and copies only own allowlisted properties into fresh objects. Accept partial v1 records. Clamp finite opacity/alpha to `[0,1]`, RGB integers `[0,255]`; reject nonfinite components. Accept only known contrast/units/markStyle enums, existing active layer, finite positive grid from the supported list, boolean visibility and flip, bounded net colour/visibility records. Use net **name** as persistent key, not numeric ID: base/head net IDs can be different for the same name. `selectedNet` is a transient name; clear when absent in current union. Nets from distinct revisions map independently to compact GPU texture indices. Clear stale entries rather than applying their IDs to another net.

Persist `layers` overrides by canonical name; new board layers start visible even if the saved board had fewer. Existing `S.layers` from the `l` hash takes priority over stored visibility for the initial view. A UI eye change updates `S.layers` through the canonical-to-SVG adapter and saves hash, so links still work. CurrentView/fallback still consults existing layer names.

Build nodes with `createElement` and `textContent`; no user-provided names inside HTML. Layer row: separate native colour input, alpha range, eye button `aria-pressed`, active-layer button `aria-current=true`. Swatch alpha is the RGBA alpha; layer opacity is a separate retained multiplier for `{`/`}`. Colour change and alpha change update only uniforms. Active row includes an inset bar and active indicator, not colour alone. Display disabled/nonexistent layers nowhere. Sort via `KicadColors.appearanceOrder`, not numeric ID. For union rows present on one side only, title names that revision; they still control matching layers there.

Tabs use `role=tablist/tab/tabpanel`, roving tabindex and ArrowLeft/Right/Home/End; do not rebuild the tablist on each range input event. Objects match the specified row order with 0–100 sliders for the first six, using `input` for immediate feedback and `change` for persisted settings. Remaining rows have visibility. Rows for data unavailable in this report (images, ratsnest, DRC markers, drawing sheet) remain visible but disabled with “Not present in this report”; do not provide a control that silently does nothing. Grid is always available on WebGL. Footprint front/back eyes gate all that side's children. Tracks opacity controls both `track` and `arc` kinds.

Nets: filter `input type=search`, per-name swatch/alpha, eye and highlight button with `aria-pressed`; clicking the highlighted net again clears highlight. No regex parsing of filter text. Net colour inherits layer by default; provide “Use layer colour” clear action. Exclude net zero from list unless named. All per-kind/per-net operations update state, small uniforms/lookup texture, not geometry buffers. Nets controls are disabled in SVG fallback; fallback panel reduces to layer colour/alpha/visibility and a clear explanatory message. No misleading active-layer contrast/net/type controls in reduced mode.

Insert `<script src="appearance.js"></script>` immediately before `review.js` and extend the `inline_page` asset loop with `"appearance.js"`; add the inlining assertion for this file now. Use the stage-3 Appearance dock mount with 24px rows, 28px tabs, scrollable body and sticky bottom `Layer Display Options`: inactive Normal/Dim/Hide radio group and `Flip board view` checkbox. Native colour input may open its OS picker; do not design a custom colour dialog. Wire a “Reset to KiCad defaults” button through `defaults`; import UI belongs to Stage 7. Persist markStyle as reserved schema data for Stage 5, without adding a nonfunctional toolbar control.

```css
.appearance-tabs { display:flex; min-height:var(--h-md); }
.appearance-body { min-height:0; overflow:auto; }
.appearance-row { display:grid; grid-template-columns:24px 24px minmax(0,1fr) 80px;
  align-items:center; min-height:24px; gap:4px; }
.appearance-row input[type=color] { width:24px; height:24px; padding:1px; }
.appearance-row input[type=range] { width:100%; min-width:0; }
.appearance-row [aria-current=true] { box-shadow:inset 2px 0 var(--accent); font-weight:600; }
.appearance-options { border-top:1px solid var(--line); padding:8px; }
.appearance-row button { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.board-gl { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
```

- [ ] **Step 4: Run green.** `node ui/board-test.mjs`; `CHECK_PORT=9361 node ui/check.mjs 'board appearance'`; repeat `--dark`. Expected: safe persistence, focus retained, no buffer uploads, tabs fit within the 320px dock. Inspect at 1600px and 1920px viewport widths.
- [ ] **Step 5: Commit.** `git add kicad_review.py ui/appearance.js ui/review.html ui/review.css ui/review.js ui/board-test.mjs ui/checks.mjs && git commit -m "feat: add persistent KiCad-style board Appearance controls"`

### Task 9: Implement KiCad navigation, status coordinates, units, grid, and keys

**Files:**
- Modify: `ui/review.js:271-330,809-850` (`attachPanZoom`, key handler, camera controls)
- Modify: `ui/review.html`, `ui/review.css`, `ui/checks.mjs`

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots with cursor coordinates and shortcut sheet.

**Interfaces:**
- Consumes: shared camera projection, `changeBoardAppearance`, stage-3 status elements.
- Produces: clamped cursor-anchored zoom, all specified board keys, accurate coordinates under flip, cancellation-safe pan. Existing schematic/3D and j/k/f/c/Esc/b behavior remains.

- [ ] **Step 1: Add keyboard/input checks.**

```js
["board keys units grid contrast and editing focus", "v=board", `
  const key=(key,extra={})=>document.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...extra}));
  const before={x:S.x,y:S.y,z:S.z};
  key("F1"); if(S.z<before.z*1.3) return "F1 zoom";
  key("F2"); key("h"); if(boardAppearance().contrast!=="dim") return "H dim";
  key("h"); if(boardAppearance().contrast!=="hide") return "H hide";
  key("h"); key("PageDown"); if(boardAppearance().activeLayer!=="B.Cu") return "bottom";
  key("PageUp"); if(boardAppearance().activeLayer!=="F.Cu") return "top";
  key("u",{ctrlKey:true}); if(boardAppearance().units!=="mil") return "units";
  const g=boardAppearance().grid; key("n"); key("N",{shiftKey:true});
  if(boardAppearance().grid!==g) return "grid inverse";
  const input=document.querySelector("#zoombar .goto"); input.focus();
  const contrast=boardAppearance().contrast;
  input.dispatchEvent(new KeyboardEvent("keydown",{key:"h",bubbles:true}));
  if(boardAppearance().contrast!==contrast) return "editing consumed";
  input.blur(); key("?"); return !!document.querySelector("#shortcuts[open]");
`]
```

Add browser checks using `PointerEvent`: left, middle, right drags by 40px move both panes identically; `pointercancel` releases move listener and click suppression; right click with <4px movement still proposes an existing thread pin, right drag never posts a pin. Set flip true, pointer position 16px right of center at z8 yields X `S.x-2`, not `S.x+2`; click/pin round trip resolves same point. Wheel event at a fixed off-center cursor preserves inverse world position within .001mm after clamping. Repeat at z=.1 and 50000, pixel/line/page delta modes, and zero-size viewport.

- [ ] **Step 2: Run red.** `CHECK_PORT=9362 node ui/check.mjs 'board keys'`; then new pointer check. Expected: key bindings and middle/right pan absent.
- [ ] **Step 3: Implement board controls before the existing blanket modifier guard.** Use one key dispatcher; do not leave two handlers processing the same shortcut. Ignore `input,textarea,select,[contenteditable=true]` and native colour/range controls. Preserve native tab/arrow operation in panels. Plain `+/-` change layer, Ctrl+=/Ctrl+- zoom; test Ctrl+Shift+= separately. Prevent browser default only for a handled shortcut. Never consume Cmd+C/Ctrl+C, browser back, or unrelated modifier combinations.

```js
const BOARD_GRID_MM=[5,2.5,2,1,.5,.25,.2,.1,.05,.025,.02,.01];
const BOARD_GRID_MIL=[1000,500,250,200,100,50,25,20,10,5,2,1].map(n=>n*.0254);
const clampBoardZoom=z=>Math.max(.1,Math.min(50000,z));
function zoomBoardAt(vp,clientX,clientY,factor) {
  const r=vp.getBoundingClientRect(); if(!r.width||!r.height||!placed()) return;
  const c=boardCamera(vp), p=[clientX-r.left,clientY-r.top];
  const before=BoardGL.screenToWorld(p,c), z=clampBoardZoom(S.z*factor);
  const after=BoardGL.screenToWorld(p,{...c,z});
  setT({z,x:S.x+before[0]-after[0],y:S.y+before[1]-after[1]});
}
```

Wheel normalize `deltaMode`: pixels `deltaY`, lines `deltaY*16`, pages `deltaY*viewportHeight`; on Mac use .01 per normalized rotation unit (`deltaPixels/100`), otherwise keep calibrated .0015 per pixel from today's implementation. This maps typical 100px non-Mac notch to exp(.15). Mac trackpad pixel deltas must be measured in Task 10; use a named constant and tests rather than guessing based on `navigator.platform` alone. All wheel paths clamp the exponent before `exp` and clamp zoom; preserve cursor anchor with the **actual clamped ratio**.

Pointer capture tracks start/current coordinates and distance; accepts buttons 0/1/2, suppresses `auxclick`/contextmenu for a drag, and releases listeners on pointerup, pointercancel, lostpointercapture. Pan X delta changes sign under flip. Only left click selects, and only right click without drag invokes the old `proposePin` behavior. Existing c-to-place pin and Esc remain functional. A pointermove updates last board cursor, shared status, and crosshair through rAF; no `draw()`/DOM stage rebuild during a gesture.

Keys, exact actions:

| Keys | Action |
|---|---|
| Home, Ctrl+0 | fit scene bounds (both revisions), preserving current selection |
| F1, Ctrl+= | zoom in ≥1.3; snap upward to next 1.3-spaced preset |
| F2, Ctrl+- | zoom out ≥1.3; snap downward; clamp .1–50000 |
| F4 | center on last pointer world point; no zoom change |
| PageUp / PageDown | active F.Cu / B.Cu if enabled; no accidental view flip |
| + / - | next/previous enabled layer in Appearance order; wrap |
| H | Normal → Dim → Hide → Normal |
| Ctrl+U | mm → mil → in → mm; model/hash coordinates remain mm |
| N / Shift+N | next finer/coarser grid in current unit family, wrap |
| { / } | active layer opacity −/+ .1; clamp 0–1 |
| ? | native modal shortcut sheet with keyboard-readable labels |
| j/k/f/c/Esc/b | preserve existing actions and view-specific behavior |

Status fields: `Z %.2f`, `X … Y …`, `dx … dy … dist …`, `grid …`, units. Use board mm internally, divide by .0254 for mil, by 25.4 for in. Delta anchor is selected change position when available, otherwise last pointerdown world point. No live region for every coordinate; only message is `aria-live=polite`. Round presentation only, never camera state. Draw board grid in both themes using the KiCad colour. Shortcuts sheet includes all old and new bindings and modal close/focus restoration. Schematic PageUp/PageDown remains stage-6 territory; do not add a board handler that consumes schematic navigation.

- [ ] **Step 4: Run green.** New keyboard, pointer, flip/pin, status, and cursor-anchor checks pass in both themes. Run full `ui/check.mjs` suites to catch focus, deep-link, and legacy pin regressions.
- [ ] **Step 5: Commit.** `git add ui/review.js ui/review.html ui/review.css ui/checks.mjs && git commit -m "feat: add KiCad board navigation and coordinate status"`

### Task 10: Browser proof, two-revision FPS gate, offline budget, and documentation

**Files:**
- Modify: `ui/checks.mjs`, `README.md`
- Local evidence only: session scratchpad `ui-4-proof/`; never commit Aux data/screenshots or copied board sources.

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return before/after screenshots in both themes on Thermal_Camera, compared to `pcb-01..07`.

**Interfaces:**
- Consumes: complete stage, existing Chrome/CDP harness and locally generated reports.
- Produces: repeatable FPS check, passing regression evidence, supported-format/fallback documentation. No unmeasured performance claim.

- [ ] **Step 1: Add a failing performance gate that cannot pass on SVG or one revision.** Add the following check body under name `board fps two revisions pan zoom`; its fixture requirement is strict when explicitly invoked with the private generated report.

```js
["board fps two revisions pan zoom", "v=board&m=side", `
  S.m="side"; await draw();
  if(boardView.renderers.length!==2) return "requires two WebGL revision renderers";
  const [base,head]=boardView.scenes||[];
  if(!base||!head) return "missing revision scene";
  const kinds=s=>Object.fromEntries(["track","via","pad"].map(k=>[k,s.objects.filter(o=>o.kind===k).length]));
  const before=boardView.renderers.reduce((n,r)=>n+r.stats.uploads,0);
  const original={x:S.x,y:S.y,z:S.z};
  const intervals=[]; let previous=0,frames=0;
  await new Promise(resolve=>{
    const start=performance.now();
    const tick=now=>{
      const elapsed=now-start;
      setT({x:original.x+Math.sin(elapsed/160)*2,
        y:original.y+Math.cos(elapsed/180)*2,
        z:original.z*(1+.12*Math.sin(elapsed/230))});
      if(elapsed>1000) { if(previous) intervals.push(now-previous); previous=now; frames++; }
      if(elapsed<6000) requestAnimationFrame(tick); else resolve();
    }; requestAnimationFrame(tick);
  });
  setT(original);
  const seconds=intervals.reduce((a,b)=>a+b,0)/1000;
  const fps=intervals.length/seconds;
  const after=boardView.renderers.reduce((n,r)=>n+r.stats.uploads,0);
  const sorted=[...intervals].sort((a,b)=>a-b);
  const evidence={fps,frames,p95:sorted[Math.floor(sorted.length*.95)],
    base:kinds(base),head:kinds(head),uploads:after-before,
    viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,
    draws:boardView.renderers.map(r=>r.stats.draws)};
  console.log("BOARD_FPS "+JSON.stringify(evidence));
  return fps>=50 && after===before && evidence.draws.every(n=>n>frames)
    || JSON.stringify(evidence);
`]
```

Do not include this hardware gate in the default sample suite if it lacks scenes: wrap its invocation behind `CHECK_PERF=1` or keep its sample return `"skip"` only when not explicitly requested. Extend the harness option minimally so `CHECK_PERF=1` turns missing scenes, unsupported geometry, or SVG routing into failure. Existing `--no-skip` can instead enforce this on a generated report; never report a skipped FPS gate as success. Use the harness's **positional** name filter; it currently does not implement `--name`.

- [ ] **Step 2: Run red against a baseline SVG report.** `CHECK_PORT=9363 CHECK_TIMEOUT=30000 node ui/check.mjs 'board fps two revisions' --no-skip --page "$THERMAL_REPORT"`. Expected: requires two WebGL revision renderers before implementation; after implementation the actual generated scene report must pass.
- [ ] **Step 3: Generate and measure local reports.** Use the existing pipeline documented in `README.md` to generate both revision reports from the locally checked out Thermal_Camera test repo and the Aux copy. Inputs live under session scratchpad `ui-research/test/Thermal_Camera/` and `aux/`. Do not fetch private boards or place them in `ui/sample`. If either board has unsupported drawable geometry and routes to SVG, stop: the FPS gate is unmet; implement the supported primitive with its own fixture test or return the precise blocker. Do not strip objects just to pass.

Record `THERMAL_REPORT` and `AUX_REPORT` as absolute generated report paths under the session scratchpad. Use actual base/head revisions if available. If the private copy has only one board revision, duplicate the scene into two revision inputs locally and clearly label “same board twice; two full retained scenes” in evidence, not “measured a real diff”. The draw count and upload assertions still apply.

```sh
python3 test_kicad_review.py
node ui/board-test.mjs
node --import ./site/css-loader.mjs --test site/test.mjs
CHECK_PORT=9363 node ui/check.mjs
CHECK_PORT=9364 node ui/check.mjs --dark
CHECK_PORT=9365 CHECK_TIMEOUT=30000 node ui/check.mjs 'board fps two revisions' --no-skip --page "$THERMAL_REPORT"
CHECK_PORT=9366 CHECK_TIMEOUT=30000 node ui/check.mjs 'board fps two revisions' --no-skip --page "$AUX_REPORT"
```

Use free ports; never 9341/9344. Current harness forces ANGLE SwiftShader, 1920×1080, DPR1. Record that fact, Chrome version, macOS version, object counts, first-draw duration, three warm runs per board, FPS median/min, p95 interval, no-upload count, and any GPU/GL errors. Target ≥50 FPS for **every** warm run of Aux ×2. Require the same on Thermal_Camera. This measures scheduled pan/zoom with actual draws, not guaranteed GPU completion; separately measure draw CPU duration and one `gl.finish()`-bounded diagnostic sample outside the FPS loop. Never insert `gl.finish` into production or claim rAF proves GPU completion. Re-run at DPR2 as a robustness check and report separately from the specified DPR1 target.

Calculate added offline bytes as the **raw HTML delta**, including base64 geometry and new JS/CSS versus the pre-stage report for identical inputs/settings. Aux two-revision added payload ≤1,500,000 bytes. Also report compressed blob and total HTML sizes. Assert decoded identical scenes deduplicate. If budget fails, remove redundant geometry metadata/duplicate arrays, not SVG fallback or object identity. Offline proof opens the generated file with network blocked and confirms both revisions, controls, selection links and fallback still work; no external fonts/textures/scripts requested.

- [ ] **Step 4: Capture and compare all seven states in both themes.** Take Thermal_Camera before/after screenshots, normal Layers/Objects/Nets, Dim, Hide, flip, active B.Cu. Keep local captures in scratchpad. Use the harness screenshot option with named proof checks setting each state deterministically:

```sh
CHECK_PORT=9367 node ui/check.mjs 'board proof Layers Normal' --page "$THERMAL_REPORT" --shot "$PROOF_DIR/thermal-layers-light.png"
CHECK_PORT=9368 node ui/check.mjs 'board proof Layers Normal' --dark --page "$THERMAL_REPORT" --shot "$PROOF_DIR/thermal-layers-dark.png"
```

Add seven `board proof ...` checks that set `S.v='board'`, `S.m='side'`, fit, reset appearance, select the requested tab/state, render, wait two rAFs, and return true only with the matching active row/controls and live canvases. The B.Cu proof must use a board with B.Cu and compare real crossing-track pixels before/after active-layer promotion, not only the row highlight. Aux screenshots are private: view locally only, never commit or upload. Compare reference layout, layer palette, text placement, drill holes, zone clearances, grid, active layer emphasis, dim/hide, and horizontal-only flip. Do not pixel-diff different board layouts as though they should be identical. Record actionable mismatches and fix them before passing this stage.

In `README.md`, document optional `board.geometry`, µm units and mm camera, supported primitives, authoritative SVG fallback on unsupported types, text atlas approximation, default opacity values, storage key, keyboard table, browser requirements, performance invocation, and that Stage 5 enables new diff compositing. Keep current SVG comparison features documented. Add no private board paths or images to repository docs.

- [ ] **Step 5: Commit only source/tests/docs.** `git add ui/checks.mjs README.md && git commit -m "test: prove board rendering controls and two-revision frame budget"`. If a minimal harness guard was needed, include `ui/check.mjs` explicitly. Inspect staged file names before committing; no generated HTML, screenshots, measurement JSON, or private inputs.

## Stage completion gate

- Python geometry fixtures cover declared layers/IDs, numeric and named nets, µm rounding, arcs, pads/drills/transforms, child identity, filled zones and text/shape dispatch.
- Full KiCad PCB palette and Appearance order have exact source citations; draw order is separate and active-side aware.
- Two retained scenes render Side mode with no buffer rebuild for pan, zoom, colours, opacity, visibility, contrast, flip, or net controls.
- Appearance matches pcb-01..07's viewer subset; native colour+alpha controls, object defaults, safe `kr.appearance.v1` persistence and reduced SVG panel work.
- All specified keys, grid dots, units, status coordinates, shared camera, click selection, and pin inverse transforms pass.
- WebGL absence, context loss, old reports, malformed scenes and unsupported geometry reliably use SVG with a notice.
- Existing Python/site/browser suites pass unchanged in both themes; before/after browser proof is returned.
- Local Thermal_Camera ×2 and Aux ×2 each measure ≥50 FPS; Aux raw added report budget ≤1.5 MB. Private inputs and screenshots remain outside Git.
- No claims of completed Stage 5 diff passes or Stage 7 theme import. The renderer/state interfaces above are their handoff.

## Explicit owner-review question

Default-font text uses a native system monospace atlas, not copied KiCad stroke-font source. If visual review requires pixel-exact KiCad glyphs, approve a separately licensed font-data strategy before enabling WebGL on those reports. Until then, text placement/legibility is tested and any unacceptable revision remains on SVG; an SVG-only Aux result does not satisfy the WebGL FPS gate.
