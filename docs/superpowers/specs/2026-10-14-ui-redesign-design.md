# Interface redesign and KiCad-style change viewer — design

Date: 2026-10-14. Branch: `plans/ui-redesign`. Status: draft for owner review.

## Goal

1. Every screen of kicad-review looks like professional CAD software: dense,
   dark by default, toolbars, docked panels, a status bar, precise controls.
   Light theme stays, with a user toggle that is remembered.
2. The change viewer looks and behaves like KiCad 10's PCB and schematic
   editors, with the diff drawn on top, and every existing comparison mode,
   selection link, comment pin, deep link and the offline single-file report
   still working.

## Decisions made with the owner

| Topic | Decision |
|---|---|
| Rendering | **Hybrid.** Board: our own WebGL renderer drawing from geometry parsed by `kicad_review.py`. Schematic: keep `kicad-cli` SVG, recoloured to the theme, plus frame and hierarchy panel. |
| Diff marks | **Both, user toggle.** Default "outline": changed objects keep KiCad colours, get a haloed outline, a glyph (`+` `−` `~`) and a dash style (solid / dashed / dotted); unchanged objects dim as in KiCad high-contrast. Alternate "recolour": changed objects drawn in added/removed/modified colours, removed also hatched. |
| Controls | **Viewer subset of KiCad.** Wheel zoom about cursor; middle/right-drag pan plus left-drag pan (click still selects); Home and Ctrl+0 fit, F1/F2 and Ctrl+= / Ctrl+- zoom, F4 centre, PageUp/PageDown top/bottom layer, `+`/`-` next/previous layer, H high-contrast cycle, Ctrl+U units, N/Shift+N grid, `{` `}` layer opacity; existing j/k/f/c/Esc/b kept; `?` opens a shortcut sheet. |
| KiCad reuse | **Values and icons, no code.** KiCad default colour values and layer order used as data, credited in `NOTICE`. KiCad toolbar icons reused under CC-BY-SA 4.0 with attribution in `ui/icons/LICENSE`; only those icon files are share-alike. No GPL source copied; repo licence unaffected. |
| REA | Hopper installed (demo). Not registered with Claude Code; CLI only. |

## What was studied

**Reference screenshots** (KiCad 10, Aux Control Board copy; kept outside the
public repo because the design is private): `~/Code/kicad-review-ui-reference/kicad/`
— `pcb-01-default`, `pcb-02-objects`, `pcb-03-nets`, `pcb-04-dim`,
`pcb-05-hide`, `pcb-06-flip`, `pcb-07-active-bcu`, `sch-01-default`.
Each stage's browser proof is compared against these.

**KiCad source** (branch 10.0, commit 3e051f88):
- Colours: `common/settings/builtin_color_themes.h` — PCB background `#001023`,
  grid `#848484`, cursor `#FFFFFF`, F.Cu `#C83434`, B.Cu `#4D7FC4`, In1..In30
  table, all tech layers (F.Mask `#D864FF` α .4, F.SilkS `#F2EDA1`, Edge.Cuts
  `#D0D2CD`, F.CrtYd `#FF26E2`, F.Fab `#AFAFAF` …), via hole `#E3B72E`,
  ratsnest `#00F8FF` α .35. Schematic paper `#F5F4EF`, wire `#009600`,
  bus `#000084`, symbol body `#FFFFC2`, outline `#840000`, worksheet `#840000`,
  grid `#B5B5B5`. Full table is copied into `ui/kicad-colors.js` at build time
  of stage 4 with file:line citations.
- Theme file: JSON, `meta.version` 5, keys `board.*`, `schematic.*`,
  `board.copper.f|b|in1..in30`; colours as CSS strings `rgb()/rgba()`.
- Appearance: copper front-to-back then tech layers in order F.Adhes … B.Fab,
  User.1..45; disabled layers omitted. Objects rows: Tracks, Vias, Pads, Zones,
  Filled Shapes, Images (opacity sliders; defaults 1,1,1,0.6,1,0.6), then
  Footprints Front/Back, Values, References, Footprint Text, Ratsnest, DRC
  markers, Drawing Sheet, Grid. Nets tab: colour swatch, visibility, name, filter.
- High contrast: inactive layers blended toward background, retained factor
  0.2 (Dim); Hide removes them; Edge.Cuts retained ≥ 0.3.
- Flip: horizontal view mirror only.
- Zoom: wheel factor per platform (Mac 0.01 per rotation unit), limits PCB
  0.1–50000, schematic 0.01–100; hotkey zoom steps ≥1.3 snapping to presets.
- Grid: PCB default 0.5 mm, list 5…0.01 mm and 1000…1 mil; dots. Schematic 50 mil.
- Status bar fields: `Z %.2f`, `X … Y …`, `dx … dy … dist …`, `grid …`, units.
- Title block: embedded default drawing sheet (10 mm margins, coordinate
  cells 50 mm, title block 108×32 mm at bottom right).

**REA:** native window capture (`capture-native-ui-scenario`) returns
`capability_unavailable` for KiCad's wxWidgets window; Hopper analysis of the
pcbnew binary adds nothing the open source does not state exactly. REA gave
no findings used in this design.

**Rendering measurements** (Thermal_Camera, `~/Code/kicad-review-ui-reference/draft/render-eval.md`):
per-layer `kicad-cli` SVG 24 layers, 654 KB, 1.27 s, no per-object groups;
KiCanvas renders KiCad 10 with 123 board / 239 schematic parser warnings,
~60 fps, 3.0 s first load; board 185 tracks, 15 vias, 239 pads, 56 footprints.
Aux Control Board (denser): 345 pads, 188 vias, 536 track segments, 102 nets.
Performance target uses the Aux board ×2 revisions.

**Current screens:** all site screens, report tabs, modes, hash keys
(`p v m x y z s t l c h`), shortcuts, tokens and `ui/checks.mjs` coverage
inventoried; nothing is removed by this redesign.

## Design system

Draft by ui-ux-pro-max agent: `~/Code/kicad-review-ui-reference/draft/design-system.md`
and `mockup.html` (screenshots `mock-dark.png`, `mock-light.png`).
- Tokens primitive → semantic → component, replacing `ui/tokens.css`; dark
  default; `data-theme` on `<html>` overrides OS; choice in localStorage.
- Slate neutrals, one blue accent; added/removed/modified pass AA in both themes.
- 13 px UI type, mono for coordinates/SHAs/refs; system fonts only.
- Control heights 24 px, dock headers 28 px, toolbars 32 px.
- Status badges always glyph + word + border style, never colour alone.
- Icons: inline SVG sprite; KiCad icons where a KiCad equivalent exists.
- Rejected suggestions: green accent, OLED pure black, Google Fonts, 44 px
  touch targets, 16 px body, glow effects.
- No UI framework or component library added.

Fixes required before approval of tokens: right dock tabs must not clip
at 1600 px; status bar must include X/Y.

## Architecture

### Data (Python, `kicad_review.py`)
New `board_geometry(pcb_path)` emits, per revision, a compact JSON scene:
layers (name, KiCad id, type, enabled), and per object: kind (track, arc,
via, pad, zone, shape, text, footprint), layer(s), net id, uuid/ref,
geometry (segments, arcs as segments, polygons triangulated or as
flattened rings; pads as shape primitives), plus nets table. Numbers in
µm integers; gzip + base64 into the report like existing blobs. Matches
existing change ids so selection, pins and links resolve unchanged.
Offline report budget: Aux board both revisions ≤ 1.5 MB added.

### Board renderer (`ui/board-gl.js`)
- WebGL2; one vertex buffer per (revision, layer, object kind); colour and
  opacity as uniforms, so colour/opacity/visibility changes never rebuild
  buffers. Instanced quads for round segments and vias.
- Camera shares today's state model (`S.x S.y S.z`, mm and px/mm) so deep
  links and `ui/checks.mjs` camera checks keep working.
- Draw order: KiCad's (back to front relative to active layer side).
- High contrast Normal/Dim/Hide with factor 0.2; flip mirrors X in view.
- Fallback: if WebGL2 unavailable, current layered SVG path is used and the
  Appearance panel reduces to layer colour/visibility.

### Appearance panel (`ui/appearance.js`)
Layers tab (swatch → native `<input type=color>` + alpha slider, eye toggle,
active-layer highlight row, layer display options: inactive Normal/Dim/Hide,
Flip board view), Objects tab (rows and sliders above), Nets tab (filter,
swatch, visibility, highlight net). Presets: "Reset to KiCad defaults",
"Import KiCad theme (.json)". Stored per viewer in localStorage key
`kr.appearance.v1` (try/catch, works with storage blocked).

### Diff on the board
- Two scenes (base, head). Modes: Side (two linked canvases), Overlay (base
  and head tinted as today: red base, green head, multiply), Wipe (scissor
  split), Blend (head alpha), Changes only (unchanged dimmed to 0.2).
- Marks: outline mode draws a second pass of changed objects as outline
  with halo (4 px dark under 2 px colour), dash per action, glyph at bbox
  corner; recolour mode replaces fill colour + hatch for removed. Toggle in
  toolbar, stored with appearance.
- Readability under any theme: mark colour chosen per action from three
  candidates by contrast against the theme background (≥ 3:1), plus halo.

### Schematic
`kicad-cli` SVG kept. Recolour: SVG colours are attributes; the loader maps
KiCad default colours to theme colours by exact value table (wire, bus,
junction, labels, symbol body/outline, pins, text, worksheet). Paper
background and frame from the export (already includes drawing sheet);
hierarchy dock lists sheets as `<name> (page n)` tree, PageUp/PageDown
previous/next sheet, Alt+Up parent. Grid dots 50 mil drawn on a canvas under
the SVG; status bar coordinates in mil/mm.

### Chrome and site
All screens rebuilt on the new tokens and components: sign-in, repositories,
reviews list + milestones, compare commits, run progress, review wrapper,
readiness, thread dialogs, history, share dialog, shared review, errors.
Report chrome: top toolbar (modes, navigation, zoom, mark style, theme),
left dock (Projects/Sheets/Hierarchy), centre canvas, right dock tabs
(Appearance, Changes, Checks, Parts, Threads), bottom status bar.

## Stages (each provable in a real browser with before/after screenshots)

1. **Tokens and shell** — new `ui/tokens.css`, theme toggle, icon sprite,
   NOTICE. Proof: existing report and site render in both themes, all tests pass.
2. **Site screens** — parallel ui-ux-pro-max agents per screen group.
3. **Report chrome** — toolbar, docks, status bar, panels restyled; viewer
   still SVG. Proof: every `ui/checks.mjs` check passes.
4. **Board geometry + WebGL renderer + Appearance** — KiCad colours, grid,
   cursor coordinates, units, zoom/pan/keys, high contrast, flip. Proof:
   side-by-side with `pcb-01..07` reference shots; ≥ 50 fps pan/zoom on Aux
   board ×2 in headless Chrome.
5. **Diff on the board** — all modes, both mark styles, selection linking,
   pins, deep links, offline report.
6. **Schematic** — recolour, hierarchy dock, grid, coordinates.
7. **Themes** — persistence, reset, KiCad theme import, colour-blind check
   (simulated deuteranopia/protanopia screenshots still distinguish marks).

## Error handling
- WebGL2 missing or context lost: fall back to SVG path with a status-bar notice.
- Theme import invalid JSON or unknown version: inline error, nothing applied.
- localStorage blocked: defaults used, no error.
- Geometry missing in old reports: SVG path, as today.

## Testing
- Python: `board_geometry` unit tests on fixture boards (object counts,
  nets, layer list, µm values).
- `ui/checks.mjs`: new checks for appearance state, layer toggles, opacity,
  high contrast, flip, hotkeys, status bar coordinates, theme import/reset,
  mark toggle, fps budget; all existing checks kept.
- Site: `site/test.mjs` for rendered markup of each rebuilt screen.

## What could not be determined
- REA gave no usable evidence for KiCad (native capture unsupported).
- KiCad's colour-picker dialog and schematic hierarchy panel were not captured
  (Aux schematic has one sheet); hierarchy reference will use Thermal_Camera.
- KiCad's default wheel behaviour on macOS warps the cursor to centre; we use
  stable cursor-anchored zoom (KiCad's alternate setting) as warping a web
  page's cursor is impossible.
- Exact KiCad theme JSON serialiser output not confirmed; import will accept
  `rgb()`, `rgba()` and `#hex`.
- WebGL performance on the owner's oldest laptop is unmeasured; target taken
  from headless Chrome on this Mac.

## Limits
No feature code before plan approval; no pushes to `main`; no merging; no
moving `v1`; nothing in the ParadigmEngineering organisation; private design
screenshots never committed.
