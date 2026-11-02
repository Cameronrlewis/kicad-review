# Stage 6: Schematic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep KiCad's schematic SVG fidelity while adding exact-value theme colours, the exported drawing sheet, numbered hierarchy navigation, a physical 50 mil dot grid, and mm/mil cursor coordinates without breaking comparisons.

**Architecture:** Keep `kicad-cli` as the only schematic renderer. Extend existing page metadata and existing `review.js` SVG loading, navigation, camera and marker paths; do not introduce another renderer or a second camera. Rewrite only known SVG paint values to schematic CSS variables, leaving the original compressed SVG untouched for raster comparisons.

**Tech Stack:** Python standard library, KiCad CLI 10, inline SVG, Canvas2D for grid dots only, vanilla JavaScript, CSS custom properties, existing Chrome DevTools checks.

**Spec:** `docs/superpowers/specs/2026-10-14-ui-redesign-design.md`, especially lines 135–142 and Stage 6. Read `/Users/cameron/Code/kicad-review-ui-reference/draft/design-system.md`, `mockup.html`, `render-eval.md`, and `/Users/cameron/Code/kicad-review-ui-reference/kicad/sch-01-default.png` before implementation.


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
- Repository: `/Users/cameron/Code/kicad-review-worktrees/ui-redesign`, branch `plans/ui-redesign`. Execute only after plan approval and Stages 1–5. Commit commands below are execution steps, not permission to commit while planning.
- Every UI-building task uses a **general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling** and returns screenshots in both themes. Inside the viewer, KiCad reference wins over skill suggestions.
- Schematic paper is `#F5F4EF` in both chrome themes. A dark toolbar does not imply a black schematic page or pale-on-paper wires. Themeable ink variables initially retain KiCad defaults in both themes; Stage 7 can change the active schematic palette.
- Keep mode hash `m=semantic`; its visible label can be Changes only. Keep board and 3D key behavior from earlier stages.
- All temporary files, exports, browser profiles and proof images go under the session scratchpad, never into the repository. Do not commit private design screenshots.

## Review Focus

1. Shared subsheets and several project instances: choose the page number for this project and this parent UUID path, not the first instance in the file (Task 1 tests).
2. Unknown/custom paints, shared default colours and invisible text: exact paint matching must preserve `none`, opacity and unknown values, and must not claim UUID or semantic-role identity absent from SVG (Task 2 tests).
3. Renumbered, removed, unrendered and legacy sheets: navigation must use deterministic page order, keep UUID addresses, prefer head metadata, and stop at hierarchy boundaries (Tasks 1 and 3 tests).
4. Very distant/negative camera positions, tiny zoom, different viewport sizes and DPR: grid remains anchored in mm, work is bounded, and coordinates never change stored camera units (Task 4 tests).
5. Rapid theme/mode/sheet changes with one missing revision: grid/paper must not occlude comparison ink, stale draws must not win, markers and comment anchors must remain selectable (Tasks 2 and 5 tests).

---

## Evidence and implementation boundaries

### Export verified during planning

KiCad CLI at `/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli`, version 10.0.0. Input was the local Thermal_Camera schematic at:

`/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/ui-research/test/Thermal_Camera/Thermal_Camera.kicad_sch`

Three successful exports, XML-inspected on 2026-10-14:

| Options | Bytes | Drawing sheet | Paper paint |
|---|---:|---|---|
| no extra flags | 1,661,726 | present | `#F5F4EF`, two paint declarations on one background group |
| `--no-background-color` | 1,661,484 | present | absent |
| `--no-background-color --exclude-drawing-sheet` | 1,602,802 | absent | absent |

Outputs are under the same scratchpad at `stage6-export/{paper,transparent,noframe}/Thermal_Camera.svg`. CLI emitted existing library/fontconfig warnings but exited successfully and wrote all three SVGs.

All three have `viewBox="0.0000 0.0000 319.9892 212.9790"`, width `319.9892mm`, height `212.9790mm`. The full export's background rectangle is `(0,0,320,213)`. The drawing sheet has outer frame `(10,10)` to `(310,203)`, inner frame `(12,12)` to `(308,201)`, and title rectangle `(200,169)` to `(308,201)`: **108 × 32 mm**. These are observed export coordinates, not a proposed recreation. Retain actual frame paths and stroked title text. The SVG also contains invisible `<text opacity="0">` accessibility/search companions; do not turn them visible.

Actual hex paint occurrences in the transparent, framed export (counts count declarations, not objects):

| Paint | Count | Default meaning(s) |
|---|---:|---|
| `#840000` | 674 | body outline, pins, global label, sheet outline, worksheet |
| `#006464` | 401 | pin names, reference/value, sheet name/labels |
| `#A90000` | 262 | pin numbers |
| `#009600` | 51 | wires and junctions |
| `#0F0F0F` | 39 | local labels |
| `#0000C2` | 22 | notes |
| `#FFFFC2` | 11 | body fill |
| `#000000` | 2 | initial default group paints; not proof of black semantic objects |
| `#000084` | 1 | bus/no-connect family |

**Important correction to the short spec wording:** most paints are inline `style="fill:...;stroke:..."`, not just presentation attributes. Map both. Do not style an `<img>` or overwrite every fill/stroke. No semantic UUIDs exist in this export. Several categories have the same source hex; exact-value mapping cannot give them different destination colours. Keep these categories aliased, document this in NOTICE, and do not guess categories from path geometry. The thermal fixture is one sheet, page `1`; multi-sheet navigation needs synthetic hierarchy tests.

### KiCad source citations (read-only clone, commit 3e051f88)

Source root: `/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad/ui-research/kicad-source`.

All colour citations below are `common/settings/builtin_color_themes.h`:

| Source hex | Cite | Source category |
|---|---|---|
| `#F5F4EF` | :32 | schematic background |
| `#000000` | :31 | auxiliary/default black |
| `#000084` | :35–36, :47, :56 | bus, bus junction, grid axes, no-connect |
| `#FFFFC2` | :37 | device background |
| `#840000` | :38, :50, :60, :70, :78 | device, global label, pin, sheet, drawing sheet |
| `#840084` | :45, :73 | fields, sheet fields |
| `#B5B5B5` | :46, :79 | grid, page limits |
| `#C2C2C2` | :48 | hidden |
| `#009600` | :49, :77 | junction, wire |
| `#725600` | :51, :72 | hierarchical label, sheet filename |
| `#0F0F0F` | :39, :52 | cursor, local label |
| `#484848` | :53 | netclass references |
| `#FF0000` | :55 | rule areas |
| `#0000C2` | :57 | notes |
| `#4848FF` | :58 | private notes |
| `#006464` | :61, :63, :74–76 | pin name, reference, sheet label/name, value |
| `#A90000` | :62 | pin number |
| `#840032` | :80 | operating-point voltages |
| `#E0000C` | :81 | operating-point currents |

Do not map transient editor selection/ERC paints to normal drawing paints. Their alpha semantics are separate (:33–44, :54, :64–69).

Hierarchy: `eeschema/widgets/hierarchy_pane.cpp:61–66` compares page numbers; :144–152 formats and sorts siblings; :209–214 makes active sheet bold; :844–846 formats `<name> (page n)`. Page comparison: `eeschema/sch_sheet.cpp:1742–1772` integers first, then natural strings; equal numbers use virtual traversal order (`eeschema/sch_sheet_path.cpp:241–258`). Hotkeys: `eeschema/tools/sch_actions.cpp:1430` Alt+Up, :1451–1465 PageUp/PageDown by number. Data parsing: `eeschema/sch_io/kicad_sexpr/sch_io_kicad_sexpr_parser.cpp:2525–2605` root/legacy sheet instances; :3813–3868 project-specific child instances. Reimplement the behavior from data; copy no C++ implementation.

### File responsibilities and predecessor integration

- `kicad_review.py`: keep frame in export; resolve instance page numbers; merge head-preferred page metadata; retain schematic blobs for unchanged pages.
- `ui/review.js`: existing `stack`, `renderNav`, `select`, `apply`, `fit`, `afterDraw`, `raster` and keyboard dispatch remain owners. Add small schematic-only helpers here, not a parallel renderer/module loader.
- `ui/tokens.css`: exact schematic palette variables, identical default ink/paper in both chrome themes.
- `ui/review.css`: hierarchy emphasis, grid stacking, schematic-only comparison overrides and marker styles.
- `NOTICE`: source/data credit plus shared-colour limitation; preserve earlier stage notices.
- `test_kicad_review.py` and `ui/checks.mjs`: executable regression coverage. No new test dependencies.
- `README.md`: schematic shortcuts and export/theme limitations.

Line numbers below refer to the pre-redesign checkout. Earlier stages move them: match named functions, not stale numeric positions. Stage 4 already owns board coordinates/units/grid keys; route schematic branches through the **same** keyboard dispatcher and unit state. Use `S.units` (`mm` or `mil`) and `S.grid` (boolean) below, or rename references consistently to the predecessor's existing equivalents. Do not add a second Ctrl+U handler or duplicate status bar. New schematic status nodes go in the existing status bar; the concrete snippets use its existing `#zoombar` container.

### Execution preflight: capture the Stage 5 baseline before Task 1

Run Task 6 Step 3's local proof script **before changing renderer assets**, using `noframe` instead of `transparent` and output name `thermal-before`. Temporarily add Task 6's `SCH6 proof framed page` check first; it checks SVG visibility, so it works on the old renderer without grid/frame. Capture its before dark/light screenshots, then keep this check for Task 6. This preflight belongs to Task 6's evidence deliverable, not a seventh implementation task. All exports must already exist; rerun the three documented CLI variants if the planning-session scratchpad has expired, using the current session scratchpad for all output.

### Task 1: Preserve drawing-sheet exports and instance page metadata

**Files:**
- Modify: `kicad_review.py:199–206` (`render_side`), :316–341 (`sheet_pages`), :1810–1827 (`build_project`).
- Test: `test_kicad_review.py:120–150`, :866–906 and new Stage 6 assertions.

**Interfaces:**
- Consumes: `parse_sexpr(text)`, `find(node,key)`, `findall(node,key)`, `properties(node)`, `add_blob(blobs,text)`.
- Produces: page dictionaries preserve `path,name,file,parent,stem` and add `page: str`; public sheets omit only `stem` and always have `size` and `svg:{base:blobId|null,head:blobId|null}`, including unchanged sheets. Paths remain UUID paths without root UUID, exactly as before.
- Produces: `sheet_instance_page(node, project: str, parent_uuid_path: str) -> str | None`.

- [ ] **Step 1: Add failing Python assertions.** Append a block using existing `write` and `sheet` fixture helpers, with temporary files owned by `TemporaryDirectory`.

```python
from unittest.mock import patch
from tempfile import TemporaryDirectory
import kicad_review as kr

with TemporaryDirectory() as t:
    def child(uid, label, page, parent='/root', project='H'):
        return (f'(sheet (uuid "{uid}") (property "Sheetname" "{label}") '
                '(property "Sheetfile" "shared.kicad_sch") '
                f'(instances (project "Other" (path "{parent}" (page "99"))) '
                f'(project "{project}" (path "{parent}" (page "{page}")))))')
    write(t, {'H.kicad_sch': '(kicad_sch (uuid "root") '
          '(sheet_instances (path "/" (page "1"))) '
          + child('ten', 'Ten', '10') + child('two', 'Two', '2') + ')',
          'shared.kicad_sch': '(kicad_sch)'})
    pages = kr.sheet_pages(t, 'H')
    assert {p['path']: p['page'] for p in pages} == {
        '/': '1', '/ten/': '10', '/two/': '2'}
    assert pages[1]['file'] == pages[2]['file'] == 'shared.kicad_sch'
    write(t, {'H.kicad_sch': '(kicad_sch (uuid "root") '
          '(sheet_instances (path "/" (page "1")) (path "/two" (page "A2"))) '
          + sheet('Two', 'shared.kicad_sch', 'two') + ')'})
    assert kr.sheet_pages(t, 'H')[1]['page'] == 'A2'
    n = kr.parse_sexpr('(sheet (instances (project "H" '
        '(path "/root/a" (page "3")) (path "/root/b" (page "7")))))')
    assert kr.sheet_instance_page(n, 'H', '/root/b') == '7'
    assert kr.sheet_instance_page(n, 'H', '/root/c') is None
    write(t, {'P.kicad_sch': '(kicad_sch)'})
    calls = []
    with patch.object(kr, 'kicad_cli', side_effect=lambda *a: calls.append(a)):
        kr.render_side(t, 'P', t + '/out')
    sch = next(c for c in calls if c[:3] == ('sch', 'export', 'svg'))
    assert '--exclude-drawing-sheet' not in sch
    assert '--no-background-color' in sch
print('ok SCH6 instance pages and transparent framed export')
```

Add to an existing `build_project` fixture that already has both source revisions and exported sheets (or the following self-contained block):

```python
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        for side, page in [('base', '2'), ('head', '10')]:
            write(t, {f'{side}/H/H.kicad_sch':
                f'(kicad_sch (sheet_instances (path "/" (page "{page}"))))',
                f'review/H/{side}/sch/H.svg':
                '<svg viewBox="0 0 320 213"><path d="M10 10H310"/></svg>'})
        blobs = {}
        p = kr.build_project({'dir':'H', 'name':'H', 'status':'modified'},
                             blobs, kr.DEFAULT_SETTINGS)
        pg = p['sheets'][0]
        assert pg['page'] == '10'
        assert pg['status'] == 'unchanged'
        assert pg['svg']['base'] == pg['svg']['head']
        assert pg['size'] == [320, 213]
        assert len(blobs) == 1
    finally:
        os.chdir(old_cwd)
```

- [ ] **Step 2: Run failing tests.**

Run: `python3 test_kicad_review.py`

Expected: FAIL on missing `page`/helper, the old no-frame command, or unchanged sheets lacking blobs. The current test at line 114 also contains an obsolete `not os.path.exists("docs/superpowers")` assertion, which fails merely because approved plans now exist. Replace only that directory-absence clause; retain the checks that plan paths do not leak into shipped JS/README. Update the exact TS-S2 expected schematic command at line 894 to omit only `--exclude-drawing-sheet`; preserve the PCB command.

- [ ] **Step 3: Implement metadata and retain the export.** Use this helper before `sheet_pages`:

```python
def sheet_instance_page(node, project, parent_uuid_path):
    instances = find(node, 'instances') or []
    for entry in findall(instances, 'project'):
        if entry[1] != project:
            continue
        for path in findall(entry, 'path'):
            if path[1].rstrip('/') == parent_uuid_path.rstrip('/'):
                page = find(path, 'page')
                if page and len(page) > 1 and str(page[1]).strip():
                    return str(page[1])
    return None
```

Replace `sheet_pages` with this implementation. It retains the duplicate-sibling-name rejection and depth limit:

```python
def sheet_pages(proj_dir, name):
    root_file = posixpath.join(proj_dir, f'{name}.kicad_sch')
    if not os.path.exists(root_file):
        return []
    with open(root_file, encoding='utf-8') as fh:
        root_node = parse_sexpr(fh.read())
    root_uuid = (find(root_node, 'uuid') or ['', ''])[1]
    legacy = {}
    for instance in findall(find(root_node, 'sheet_instances') or [], 'path'):
        pg = find(instance, 'page')
        if pg and len(pg) > 1 and str(pg[1]).strip():
            legacy[instance[1].rstrip('/') or '/'] = str(pg[1])
    pages = []

    def walk(file, path, sheet_name, parent, depth, stem, page=None):
        pages.append({'path': path, 'name': sheet_name, 'file': file,
                      'parent': parent, 'stem': stem,
                      'page': page or legacy.get(path.rstrip('/') or '/')
                              or str(len(pages) + 1)})
        full = posixpath.join(proj_dir, file)
        if depth > 32 or not os.path.exists(full):
            return
        with open(full, encoding='utf-8') as fh:
            node = parse_sexpr(fh.read())
        names = set()
        for s in findall(node, 'sheet'):
            props = properties(s)
            child = props.get('Sheetname', '?')
            if child in names:
                sys.exit(f"{file} has two sheets with the same name {child!r}; kicad-cli renders both to one file, "
                         "so neither drawing can be shown. Rename one of them.")
            names.add(child)
            safe = re.sub(r'[\\/]', '_', child)
            child_path = f"{path}{find(s, 'uuid')[1]}/"
            parent_uuid_path = f'/{root_uuid}{path.rstrip("/")}'
            child_page = sheet_instance_page(s, name, parent_uuid_path)
            walk(posixpath.normpath(posixpath.join(posixpath.dirname(file),
                 props.get('Sheetfile', ''))), child_path, child, path,
                 depth + 1, f'{stem}-{safe}', child_page)

    walk(f'{name}.kicad_sch', '/', name, None, 0, name)
    return pages
```

In `render_side`, schematic command becomes:

```python
kicad_cli('sch', 'export', 'svg', '--no-background-color',
          '-o', f'{out}/sch', sch)
```

Keep paper on the viewport below the grid. Export without background to avoid an opaque rectangle covering grid dots and base ink; do not remove frame groups after export. In `build_project`, use head metadata when the same path occurs in both sides, and keep unchanged blobs:

```python
entry = pages.setdefault(pg['path'], {**pg, 'svg': {}})
entry.update({k: v for k, v in pg.items() if k != 'svg'})
entry['svg'][side] = svg_body(page_svg(f'{out}/{side}', p['name'], pg))

# Replace the status != unchanged guard around these assignments:
pg['size'] = svg_size(h or b)
pg['svg'] = {'base': add_blob(blobs, b), 'head': add_blob(blobs, h)}
```

This adds at most one deduplicated blob per unchanged page, not two. A base-only sheet keeps its base metadata; old reports without blobs still show their existing no-render message.

- [ ] **Step 4: Run passing tests.**

Run: `python3 test_kicad_review.py`

Expected: PASS, including nested relative sheet paths, duplicate-name rejection, exact CLI argument tests, unchanged blob deduplication and head page metadata.

- [ ] **Step 5: Commit.**

```sh
git add kicad_review.py test_kicad_review.py
git commit -m "feat: retain schematic drawing sheets and page metadata"
```

### Task 2: Exact-value SVG palette mapping

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots.

**Files:**
- Modify: `ui/review.js:227–239` (`stack`).
- Modify: `ui/tokens.css`, `NOTICE`.
- Test: `ui/checks.mjs`.

**Interfaces:**
- Consumes: original decompressed text from `svgText(id)`, `view.kind`, active CSS variables on document root.
- Produces: `schematicPaint(value: string) -> string`; `themeSchematic(svg: SVGElement) -> void`. Both are synchronous; cached source text is never mutated. Destination is `var(--sch-ink-<lowercase hex>, #<source hex>)`.
- Stage 7 may override these exact-value variables; shared source paints stay aliased. Do not couple ink to chrome `--text` or diff `--added`.

- [ ] **Step 1: Add this failing browser check.** Insert into `CHECKS`:

```javascript
["SCH6 exact paints preserve opacity unknown colours and geometry", "", `
  const host = document.createElement('div');
  host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g style="stroke:#009600;fill:none;stroke-opacity:.4"><path d="M1 1L9 9" fill="#FFFFC2"/><text opacity="0" stroke-opacity="0">Hidden</text></g><path fill="#123456" stroke="none"/><path style="fill:rgb(0,150,0);stroke:#009601"/></svg>';
  const svg = host.firstChild, before = svg.querySelector('path').getAttribute('d');
  document.body.append(host);
  try {
    themeSchematic(svg);
    const g = svg.querySelector('g'), unknown = svg.querySelectorAll('path')[1];
    document.documentElement.style.setProperty('--sch-ink-009600', '#135724');
    const first = getComputedStyle(svg.querySelector('path')).stroke;
    document.documentElement.style.setProperty('--sch-ink-009600', '#246813');
    const second = getComputedStyle(svg.querySelector('path')).stroke;
    return first === 'rgb(19, 87, 36)' && second === 'rgb(36, 104, 19)'
      && g.style.fill === 'none' && g.style.strokeOpacity === '0.4'
      && svg.querySelector('text').getAttribute('opacity') === '0'
      && unknown.getAttribute('fill') === '#123456'
      && unknown.getAttribute('stroke') === 'none'
      && svg.querySelector('path').getAttribute('d') === before
      && schematicPaint('rgb(0,150,0)') === 'rgb(0,150,0)'
      && schematicPaint('#009601') === '#009601'
      && schematicPaint('#009600') === schematicPaint('#009600'.toLowerCase());
  } finally {
    document.documentElement.style.removeProperty('--sch-ink-009600'); host.remove();
  }
`],
```

Exact means exact RGB value in canonical CLI hex spelling, case-insensitive; this stage does not parse arbitrary CSS colour syntax or remap near matches. User theme import accepts additional formats in Stage 7, not in this source matching function.

- [ ] **Step 2: Run failing check.**

Run: `CHECK_PORT=9356 node ui/check.mjs 'SCH6 exact paints'`

Expected: FAIL because `themeSchematic` does not exist. Harness currently takes a positional filter, not `--name`; use the positional form until a predecessor adds the alias.

- [ ] **Step 3: Implement the exact map and loader hook.**

```javascript
// KiCad 10, builtin_color_themes.h:31–81; data provenance in NOTICE.
const SCH_PAINTS = new Set([
  '000000','000084','ffffc2','840000','840084','b5b5b5','c2c2c2',
  '009600','725600','0f0f0f','484848','ff0000','0000c2','4848ff',
  '006464','a90000','840032','e0000c'
]);
function schematicPaint(value) {
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) && SCH_PAINTS.has(hex.slice(1))
    ? `var(--sch-ink-${hex.slice(1)}, ${hex})` : value;
}
function themeSchematic(svg) {
  for (const el of [svg, ...svg.querySelectorAll('[style],[fill],[stroke]')]) {
    if (el.hasAttribute('style')) {
      el.setAttribute('style', el.getAttribute('style').replace(
        /(^|;)\s*(fill|stroke)\s*:\s*(#[0-9a-f]{6})(\s*(?:!important)?\s*)(?=;|$)/gi,
        (all, separator, property, value, suffix) =>
          `${separator}${property}:${schematicPaint(value)}${suffix}`));
    }
    for (const property of ['fill', 'stroke']) {
      if (el.hasAttribute(property)) {
        el.setAttribute(property, schematicPaint(el.getAttribute(property)));
      }
    }
  }
}
```

After `d.innerHTML = t.slice(t.indexOf('<svg'));` in `stack`, insert:

```javascript
if (view.kind === 'sheet') themeSchematic(d.querySelector('svg'));
```

Match raw style declarations deliberately: CSSOM normalizes hex to `rgb(...)`, losing the canonical source spelling before an exact hex matcher can see it.

Do this once per SVG insertion, not every pointermove or theme change. CSS variables make already-inserted SVGs update immediately on palette changes. Keep raster comparison in `raster()` on original text, without CSS variables: Blob-loaded SVG images do not inherit the document's variables.

Add the following defaults once to `ui/tokens.css` (both themes inherit them). If Stage 4's `ui/kicad-colors.js` already has a schematic colour table, keep it consistent with these cited data values; do not add a competing theme system.

```css
:root {
  --sch-paper:#f5f4ef;
  --sch-ink-000000:#000000; --sch-ink-000084:#000084;
  --sch-ink-ffffc2:#ffffc2; --sch-ink-840000:#840000;
  --sch-ink-840084:#840084; --sch-ink-b5b5b5:#b5b5b5;
  --sch-ink-c2c2c2:#c2c2c2; --sch-ink-009600:#009600;
  --sch-ink-725600:#725600; --sch-ink-0f0f0f:#0f0f0f;
  --sch-ink-484848:#484848; --sch-ink-ff0000:#ff0000;
  --sch-ink-0000c2:#0000c2; --sch-ink-4848ff:#4848ff;
  --sch-ink-006464:#006464; --sch-ink-a90000:#a90000;
  --sch-ink-840032:#840032; --sch-ink-e0000c:#e0000c;
}
```

Append to existing NOTICE, without deleting prior credit:

```text
Schematic default colour values are data from KiCad 10, commit 3e051f88,
common/settings/builtin_color_themes.h:31–81, Copyright KiCad Contributors.
https://gitlab.com/kicad/code/kicad
No KiCad GPL implementation source is included. Several schematic roles
share an identical exported colour; the SVG exact-value palette maps them
together. Drawing-sheet paths and title text are generated by kicad-cli.
```

- [ ] **Step 4: Run checks in both themes and capture the result.**

```sh
CHECK_PORT=9356 node ui/check.mjs 'SCH6 exact paints' --dark
CHECK_PORT=9356 node ui/check.mjs 'SCH6 exact paints'
python3 test_kicad_review.py
```

Expected: PASS; source blobs unchanged; theme changes affect inserted ink only; no board/library repainting. Return dark/light screenshots from the final proof task.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.js ui/tokens.css ui/checks.mjs NOTICE
git commit -m "feat: map schematic SVG paints to exact-value theme tokens"
```

### Task 3: Page-number hierarchy dock and sheet hotkeys

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots.

**Files:**
- Modify: `ui/review.js:128–150` (`renderNav`), :809–819 (keyboard dispatcher).
- Modify: `ui/review.css` hierarchy rows.
- Test: `ui/checks.mjs`.

**Interfaces:**
- Consumes: Task 1 `sheet.page`, existing `sheet.parent/path/name`, existing `select(view)` and hash machinery.
- Produces: `sheetNumber(sheet) -> string`, `compareSheetPages(a,b) -> number`, `orderedSheets() -> Sheet[]`, `navigateSheet(direction: -1 | 1 | 'parent') -> void`.
- Sorting siblings makes a tree; previous/next uses a separate globally page-sorted sequence. Neither operation rewrites `proj().sheets` nor UUID paths.

- [ ] **Step 1: Add failing ordering/navigation check.**

```javascript
["SCH6 hierarchy page order boundaries legacy and escaped labels", "", `
  const p = proj(), source = p.sheets.find(s => s.svg);
  if (!source) throw Error('fixture needs a schematic');
  p.sheets = [
    {...source, path:'/', parent:null, name:'Root', page:'1'},
    {...source, path:'/ten/', parent:'/', name:'Ten', page:'10'},
    {...source, path:'/two/', parent:'/', name:'<b>Two</b>', page:'2'},
    {...source, path:'/two/sub/', parent:'/two/', name:'Sub', page:'3'},
    {...source, path:'/a10/', parent:'/', name:'A10', page:'A10'},
    {...source, path:'/a2/', parent:'/', name:'A2', page:'A2'},
    {...source, path:'/old/', parent:'/', name:'Legacy', page:undefined}
  ];
  S.v = 'sheet:/two/sub/'; renderNav();
  const text = document.querySelector('#nav').textContent;
  if (!text.includes('<b>Two</b> (page 2)') || document.querySelector('#nav .name b')) return 'label escaping';
  if (orderedSheets().map(s=>sheetNumber(s)).join(',') !== '1,2,3,7,10,A2,A10') return 'page order';
  navigateSheet('parent'); if (S.v !== 'sheet:/two/') return 'parent';
  navigateSheet(-1); if (S.v !== 'sheet:/') return 'previous';
  navigateSheet(-1); if (S.v !== 'sheet:/') return 'first boundary';
  S.v = 'sheet:/a10/'; renderNav(); navigateSheet(1);
  if (S.v !== 'sheet:/a10/') return 'last boundary';
  const row = document.querySelector('#nav [data-view="sheet:/a10/"]');
  return row?.getAttribute('aria-current') === 'true'
    && parseInt(getComputedStyle(row.querySelector('.name')).fontWeight) >= 600
    && text.includes('Legacy (page 7)');
`],
["SCH6 sheet keys leave editors and board keys alone", "", `
  const p=proj(), source=p.sheets.find(s=>s.svg);
  p.sheets=[{...source,path:'/',parent:null,page:'1'},
            {...source,path:'/c/',parent:'/',page:'2'}];
  S.v='sheet:/'; renderNav();
  const key=(target,key,extra={})=>target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  key(document.body,'PageDown'); if(S.v!=='sheet:/c/') return 'next key';
  key(document.body,'ArrowUp',{altKey:true}); if(S.v!=='sheet:/') return 'parent key';
  const input=document.createElement('div'); input.contentEditable='true'; document.body.append(input);
  key(input,'PageDown'); input.remove(); if(S.v!=='sheet:/') return 'editor stolen';
  S.v='board'; const old=S.v; key(document.body,'ArrowUp',{altKey:true});
  return S.v===old;
`],
```

Before returning from the first check, pin the virtual-page tie breaker:

```javascript
const ten=p.sheets.find(s=>s.path==='/ten/'), two=p.sheets.find(s=>s.path==='/two/');
ten.page='2';
if(compareSheetPages(ten,two)>=0) return 'duplicate-page traversal tie';
```

- [ ] **Step 2: Run failing checks.**

Run: `CHECK_PORT=9356 node ui/check.mjs 'SCH6 hierarchy'`

Expected: FAIL on missing helpers/labels.

- [ ] **Step 3: Implement hierarchy and key routing.**

```javascript
function sheetNumber(sheet) {
  return sheet.page == null || !String(sheet.page).trim()
    ? String(proj().sheets.indexOf(sheet) + 1) : String(sheet.page);
}
function compareSheetPages(a, b) {
  const x=sheetNumber(a), y=sheetNumber(b);
  const integer = s => /^[+-]?\d+$/.test(s);
  let order;
  if (integer(x) && integer(y)) order = x === y ? 0 : (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0);
  else if (integer(x) !== integer(y)) order = integer(x) ? -1 : 1;
  else order = x.localeCompare(y, 'en', {numeric:true, sensitivity:'variant'});
  return order || proj().sheets.indexOf(a) - proj().sheets.indexOf(b);
}
function orderedSheets() { return [...proj().sheets].sort(compareSheetPages); }
function navigateSheet(direction) {
  if (!String(S.v).startsWith('sheet:')) return;
  const pages=orderedSheets(), i=pages.findIndex(s=>`sheet:${s.path}`===S.v);
  if (i<0) return;
  const page = direction === 'parent'
    ? pages.find(s=>s.path===pages[i].parent) : pages[i+direction];
  if (page) select(`sheet:${page.path}`);
}
```

Change `kids` in `renderNav` to sort a filtered copy with `compareSheetPages`. Replace only the name text with escaped `${s.name} (page ${sheetNumber(s)})`; retain chips and `data-view` attributes. Give the schematic tree `aria-label="Schematic hierarchy"`. Preserve existing row buttons, their focus, and Stage 3's tree keyboard semantics. Add `.tree button[aria-current="true"] .name { font-weight:600; }`.

At the beginning of the **existing** keyboard handler, before its generic modifier guard:

```javascript
if (e.target.closest?.('input,select,textarea,[contenteditable]:not([contenteditable="false"]),dialog[open]')) return;
if (String(S.v).startsWith('sheet:') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
  const parent = e.altKey && e.key === 'ArrowUp';
  const next = !e.altKey && e.key === 'PageDown';
  const previous = !e.altKey && e.key === 'PageUp';
  if (parent || next || previous) {
    e.preventDefault(); navigateSheet(parent ? 'parent' : next ? 1 : -1); return;
  }
}
```

Board PageUp/PageDown must continue to reach Stage 4's layer commands. Do not intercept Alt+Left/Right browser history. Keep j/k/f/c/Esc/b handling. Add the three schematic shortcuts to the existing `?` shortcut sheet from Stage 4, with separate board/schematic PageUp/PageDown rows.

- [ ] **Step 4: Run passing checks in both themes.**

```sh
CHECK_PORT=9356 node ui/check.mjs 'SCH6 hierarchy' --dark
CHECK_PORT=9356 node ui/check.mjs 'SCH6 sheet keys'
CHECK_PORT=9356 node ui/check.mjs 'reloading a saved sheet address'
```

Expected: PASS; active bold label, unchanged legacy sheets selectable, no page-name HTML injection. Return both-theme hierarchy screenshots with nested synthetic pages, explicitly identified as test data.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.js ui/review.css ui/checks.mjs
git commit -m "feat: add numbered schematic hierarchy and sheet navigation"
```

### Task 4: Physical dot grid and mm/mil status coordinates

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots.

**Files:**
- Modify: `ui/review.js:241–247` (`viewport`), :250–263 (`draw`), :272–280 (`apply`), existing status/keyboard code.
- Modify: `ui/review.css`.
- Test: `ui/checks.mjs`.

**Interfaces:**
- Consumes: `S.x/S.y` in mm, `S.z` in CSS px/mm; physical spacing `1.27 mm = 50 mil`; shared `S.units/S.grid` from Stage 4.
- Produces: `schematicPoint(vp,event) -> {x:number,y:number}` in mm; `schematicGridPlan(width,height) -> {step:number,x:number,y:number}` in CSS pixels; `drawSchematicGrids() -> void`; `updateSchematicStatus() -> void`.
- DOM: one `.sch-grid` canvas per `.vp.sheet`, sibling **before** `.world`, `aria-hidden=true`; status `[data-sch-coordinates]`, `[data-sch-grid]` only for schematic views. No paper rectangle in the ink SVG.

- [ ] **Step 1: Add failing browser geometry and units check.**

```javascript
["SCH6 physical grid negative camera units DPR and viewport coordinates", "", `
  const sheet=proj().sheets.find(s=>s.svg); S.v='sheet:'+sheet.path; S.m='side'; await draw();
  S.x=-2.54; S.y=5.08; S.z=10; S.units='mm'; S.grid=true; apply();
  for(const vp of document.querySelectorAll('#stage .vp.sheet')) {
    const r=vp.getBoundingClientRect();
    const p=schematicPoint(vp,{clientX:r.left+r.width/2+25.4,clientY:r.top+r.height/2-12.7});
    if(Math.abs(p.x)>1e-8 || Math.abs(p.y-3.81)>1e-8) return JSON.stringify(p);
    const canvas=vp.querySelector('.sch-grid');
    if(!canvas || canvas.width!==Math.round(vp.clientWidth*devicePixelRatio)
      || canvas.compareDocumentPosition(vp.querySelector('.world'))!==Node.DOCUMENT_POSITION_FOLLOWING) return 'canvas geometry/order';
  }
  const a=schematicGridPlan(100,100); if(Math.abs(a.step-12.7)>1e-8) return a;
  S.z=.001; const tiny=schematicGridPlan(1920,1080);
  if(tiny.step<4 || !Number.isFinite(tiny.x) || Math.ceil(1920/tiny.step)*Math.ceil(1080/tiny.step)>140000) return 'unbounded';
  S.z=10; const before=[S.x,S.y,S.z];
  schematicCursor={x:25.4,y:-1.27}; updateSchematicStatus();
  if(!document.querySelector('[data-sch-coordinates]').textContent.includes('25.400')) return 'mm';
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'u',ctrlKey:true,bubbles:true,cancelable:true}));
  return S.units==='mil' && document.querySelector('[data-sch-coordinates]').textContent.includes('1000.000')
    && document.querySelector('[data-sch-grid]').textContent.includes('50')
    && JSON.stringify(before)===JSON.stringify([S.x,S.y,S.z]);
`],
```

- [ ] **Step 2: Run failing check.**

Run: `CHECK_PORT=9356 node ui/check.mjs 'SCH6 physical grid'`

Expected: FAIL on missing grid helper/canvas/status.

- [ ] **Step 3: Implement the camera-aligned canvas and status.**

```javascript
let schematicCursor = null;
function schematicPoint(vp, e) {
  const r=vp.getBoundingClientRect();
  return {x:S.x+(e.clientX-r.left-r.width/2)/S.z,
          y:S.y+(e.clientY-r.top-r.height/2)/S.z};
}
function schematicGridPlan(width,height) {
  const physical=1.27*S.z;
  const stride=Math.max(1,Math.ceil(4/physical));
  const step=physical*stride;
  const mod=(v,m)=>((v%m)+m)%m;
  return {step,x:mod(width/2-S.x*S.z,step),y:mod(height/2-S.y*S.z,step)};
}
function drawSchematicGrids() {
  if (!placed()) return;
  for(const canvas of document.querySelectorAll('#stage .sch-grid')) {
    const vp=canvas.parentElement, w=vp.clientWidth, h=vp.clientHeight, dpr=devicePixelRatio||1;
    const width=Math.round(w*dpr), height=Math.round(h*dpr);
    if(canvas.width!==width) canvas.width=width;
    if(canvas.height!==height) canvas.height=height;
    const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    if(S.grid===false || !w || !h) continue;
    const {step,x,y}=schematicGridPlan(w,h);
    ctx.fillStyle=getComputedStyle(vp).getPropertyValue('--sch-ink-b5b5b5').trim()||'#b5b5b5';
    ctx.beginPath();
    for(let px=x;px<w;px+=step) for(let py=y;py<h;py+=step) ctx.rect(Math.round(px),Math.round(py),1,1);
    ctx.fill();
  }
}
function updateSchematicStatus() {
  const coords=document.querySelector('[data-sch-coordinates]');
  const grid=document.querySelector('[data-sch-grid]');
  const sheet=String(S.v).startsWith('sheet:');
  if(coords) {
    coords.hidden=!sheet;
    const scale=S.units==='mil'?1/.0254:1, unit=S.units==='mil'?'mil':'mm';
    coords.textContent=schematicCursor
      ? `X ${(schematicCursor.x*scale).toFixed(3)} Y ${(schematicCursor.y*scale).toFixed(3)} ${unit}`
      : `X — Y — ${unit}`;
  }
  if(grid) { grid.hidden=!sheet; grid.textContent=`Grid ${S.grid===false?'off':S.units==='mil'?'50 mil':'1.270 mm'}`; }
}
```

Insert canvas creation in `viewport` only for `kind === 'sheet'`, **after saving the `.world` element into a local variable**. The existing `return vp.firstChild` becomes `return world`, otherwise callers append SVGs into the new canvas.

```javascript
const world=vp.querySelector('.world');
if(kind==='sheet') {
  const canvas=document.createElement('canvas'); canvas.className='sch-grid';
  canvas.setAttribute('aria-hidden','true'); vp.prepend(canvas);
  vp.addEventListener('pointermove', e=>{
    if(!placed()) return;
    schematicCursor=schematicPoint(vp,e); updateSchematicStatus();
  });
  vp.addEventListener('pointerleave',()=>{schematicCursor=null;updateSchematicStatus();});
}
// End viewport with: return world;
```

Use Stage 4's existing rAF status throttling instead of adding per-event DOM work if present. Append these two nodes to the existing status markup, **not** to a new bar:

```html
<span data-sch-coordinates hidden></span><span data-sch-grid hidden></span>
```

Run `drawSchematicGrids(); updateSchematicStatus();` at the end of `apply`, including paths with a camera already placed. Reset cursor on sheet selection/project changes. Use one `ResizeObserver` for mounted schematic viewports; disconnect it before every `draw()` replaces the stage, observe the new viewports after replacement, and redraw grid/status on resize. Reuse the predecessor's observer if it already owns this lifecycle.

```javascript
const schematicResize=new ResizeObserver(()=>{drawSchematicGrids();updateSchematicStatus();});
// At draw entry: schematicResize.disconnect();
// After replacing #stage and applying camera:
for(const vp of document.querySelectorAll('#stage .vp.sheet')) schematicResize.observe(vp);
```

Shared Ctrl+U dispatcher: when the active view is schematic, cycle `mm`/`mil` and call `updateSchematicStatus()`; prevent default. Do not change camera coordinates or deep links. Leave text editors and dialogs alone. Existing units button must call this same update, not maintain another units value. Existing grid button toggles `S.grid` and calls `drawSchematicGrids`. Schematic spacing is fixed at 50 mil; board N/Shift+N spacing commands must not mutate it. Adaptive draw stride only omits dots at zoom-out; all drawn dots remain on the same 50 mil lattice.

```css
.vp.sheet { background:var(--sch-paper); }
.sch-grid { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.vp.sheet .world { z-index:1; }
[data-sch-coordinates], [data-sch-grid] { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
```

No grid canvas is inside a `.stack`: blend opacity and wipe clipping affect revisions, not the grid. DOM ordering handles grid below SVG, markers and pins.

- [ ] **Step 4: Run passing checks and regression.**

```sh
CHECK_PORT=9356 node ui/check.mjs 'SCH6 physical grid' --dark
CHECK_PORT=9356 node ui/check.mjs 'SCH6 physical grid'
CHECK_PORT=9356 node ui/check.mjs 'camera'
```

Expected: PASS; dot spacing 12.7 CSS px at 10 px/mm; coordinates 25.4 mm = 1000 mil; no changed camera/hash state. Return screenshots at fit and close zoom in both themes.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.js ui/review.css ui/checks.mjs
git commit -m "feat: add physical schematic grid and mm mil coordinates"
```

### Task 5: Preserve SVG comparisons, marks, selection and pins

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return both-theme screenshots.

**Files:**
- Modify: `ui/review.js:310–332` (`contentBox/fit`), :406–425 (`markersFor/afterDraw`), :847 onward (`raster/computeRegions`) only where required.
- Modify: `ui/review.css` schematic comparison overrides.
- Test: `ui/checks.mjs`.

**Interfaces:**
- Consumes: all existing `MODES`, `rowBox`, `onView`, `drawPins`, `pickAt`, `resolveAnchor`, `encodeState/decodeState`; Stage 5 mark toggle state.
- Produces: existing bounding-region schematic marks retain action glyph, line style and word in both mark styles. No per-path identity is invented. SVG recolour mode uses bounding-region tint/hatch overlays, not false per-object paint replacement.
- `fit()` on schematics fits the full `view.size` page, keeping exported frame/title visible; board/library fit behavior stays unchanged.

- [ ] **Step 1: Add failing comparison and one-sided checks.**

```javascript
["SCH6 all SVG modes keep paper frame selection and missing revisions", "", `
  const p=proj(), sheet=p.sheets.find(s=>s.svg);
  S.v='sheet:'+sheet.path; S.grid=true;
  const row=p.changes.find(r=>r.where?.sheet===sheet.path && rowBox(r,'head'));
  if(!row) throw Error('sample needs schematic change');
  for(const mode of ['side','overlay','wipe','blend','semantic']) {
    S.m=mode; S.s=row.id; await draw();
    if(!document.querySelector('#stage .vp.sheet .layer svg')) return mode+' no SVG';
    if(!document.querySelector('#stage .marker.sel')) return mode+' no selection';
    if(getComputedStyle(document.querySelector('#stage .vp.sheet')).backgroundColor!=='rgb(245, 244, 239)') return mode+' paper';
    if(!document.querySelector('#stage .sch-grid')) return mode+' no grid';
    const hash=encodeState(); await applyState(decodeState('#'+hash));
    if(S.s!==row.id || S.v!=='sheet:'+sheet.path) return mode+' address';
  }
  const svg={...sheet.svg};
  try {
    for(const missing of ['base','head']) {
      sheet.svg={...svg,[missing]:null}; S.m='semantic'; await draw();
      const present=missing==='base'?'head':'base';
      const stack=document.querySelector('#stage .stack.'+present);
      if(!stack?.querySelector('svg') || getComputedStyle(stack).display==='none') return missing+' hid surviving revision';
    }
  } finally {sheet.svg=svg;}
  return true;
`],
["SCH6 source raster does not depend on active palette", "", `
  const sheet=proj().sheets.find(s=>s.svg); S.v='sheet:'+sheet.path;
  const view=currentView(), a=await raster('head',view,200,150);
  document.documentElement.style.setProperty('--sch-ink-009600','#ff00ff');
  try {
    const b=await raster('head',view,200,150);
    return a.some(v=>v!==0) && a.every((v,i)=>v===b[i]);
  } finally {document.documentElement.style.removeProperty('--sch-ink-009600');}
`],
```

Add a marker-specific check independent of sample actions:

```javascript
["SCH6 marks retain non-colour action cues in both styles", "", `
  const p=proj(), sheet=p.sheets.find(s=>s.svg); S.v='sheet:'+sheet.path; S.m='side';
  p.changes=['added','removed','modified'].map((action,i)=>({id:'sch6-'+i,action,kind:'symbol',ref:'U'+i,where:{sheet:sheet.path},pos:[20+10*i,20],box:[18+10*i,18,22+10*i,22]}));
  for(const style of ['outline','recolour']) {
    S.markStyle=style; await draw();
    for(const [action,glyph,line] of [['added','+','solid'],['removed','−','dashed'],['modified','~','dotted']]) {
      const m=document.querySelector('#stage .marker.'+action);
      if(!m || m.dataset.glyph!==glyph || !m.getAttribute('aria-label')?.includes(action)
        || getComputedStyle(m).borderTopStyle!==line) return style+' '+action;
    }
  }
  return true;
`],
```

Use the predecessor's actual mark-style state field instead of `S.markStyle` if named differently; update this test and implementation together. Do not let the check silently exercise only the default style.

- [ ] **Step 2: Run failing checks.**

Run: `CHECK_PORT=9356 node ui/check.mjs 'SCH6'`

Expected: existing preservation checks may pass already. New paper/mark cues fail where Stage 5 remains board-only.

- [ ] **Step 3: Apply schematic-only corrections.**

Modify fit with the existing function owners, not a second fit command:

```javascript
function fit() {
  const v=currentView();
  zoomTo(v?.kind==='sheet' ? [0,0,...v.size]
    : contentBox() || (v && [0,0,...v.size]),2);
}
```

For schematic mode, `markersFor` returns **all** changes on that sheet, not only modified symbols; keep the board path from Stage 5:

```javascript
if(view.kind==='sheet') return proj().changes.filter(r=>onView(r,S.v));
```

In existing `afterDraw`, assign `aria-label` to each region marker and preserve action glyph even for selected markers (selection can use a separate class/outline, not replace `+`/`−`/`~` with the only visible cue):

```javascript
m.dataset.glyph=GLYPH[r.action]||'!';
m.setAttribute('aria-label',`${r.action||'finding'} ${r.ref||r.kind||''}`.trim());
m.dataset.markStyle=S.markStyle||'outline';
```

Give the marker word a visible label without replacing its existing glyph pseudo-element:

```javascript
const label=document.createElement('span'); label.className='sch-mark-label';
label.textContent=`${r.action||'finding'} ${r.ref||r.kind||''}`.trim();
if(view.kind==='sheet') m.append(label);
```

Do not double-add selection marks for a row already marked: build one row per id, carrying `sel` when its id is `S.s`. Keep selected check violations and pins. Existing semantic regions still use original `raster()` text; no grid, paper canvas, label DOM or theme variable enters pixel comparisons. Preserve the current `gen` guard so rapid navigations cannot install stale SVGs.

```css
.mode-overlay .vp.sheet .world { background:transparent; }
.vp.sheet .marker.modified { border-style:dotted; border-width:calc(2px / var(--k,1)); }
.vp.sheet .marker.sel.added { border-style:solid; }
.vp.sheet .marker.sel.removed { border-style:dashed; }
.vp.sheet .marker.sel.modified { border-style:dotted; }
.sch-mark-label { position:absolute; left:0; top:100%; white-space:nowrap;
  font:11px var(--font-mono); transform:scale(calc(1 / var(--k,1))); transform-origin:0 0;
  color:#0f0f0f; background:#f5f4ef; padding:0 2px; }
.vp.sheet .marker[data-mark-style="recolour"].added { background:rgb(20 108 46 / .12); }
.vp.sheet .marker[data-mark-style="recolour"].modified { background:rgb(138 90 0 / .12); }
.vp.sheet .marker[data-mark-style="recolour"].removed {
  background:repeating-linear-gradient(135deg,transparent 0 4px,rgb(179 32 31 / .22) 4px 6px);
}
```

Use Stage 5's contrast picker against `#F5F4EF`, not chrome `--bg`, for marker borders. If that helper is board-local, keep schematic mark colours at paper-safe `#146c2e`, `#b3201f`, `#8a5a00` and halo from the earlier stage; no new contrast library. Expose bounding-region recolour as such in the mark control tooltip: `Schematic recolour uses changed regions; exported paths have no object IDs`. All markers remain pointer-events:none, so hit testing/pins still receive input. Do not claim exact per-object schematic recolouring.

- [ ] **Step 4: Run preservation suite.**

```sh
CHECK_PORT=9356 node ui/check.mjs 'SCH6' --dark
CHECK_PORT=9356 node ui/check.mjs 'SCH6'
CHECK_PORT=9356 node ui/check.mjs
CHECK_PORT=9356 node ui/check.mjs --dark
python3 test_kicad_review.py
node --import ./site/css-loader.mjs --test site/test.mjs
```

Expected: PASS all existing checks. Inspect existing thread/pin/selection checks in the full run; no skipped newly added SCH6 checks. Capture all five modes in each theme, including a removed-only schematic. Added/removed/modified remain distinguishable without colour.

- [ ] **Step 5: Commit.**

```sh
git add ui/review.js ui/review.css ui/checks.mjs
git commit -m "fix: preserve schematic comparison modes and accessible diff marks"
```

### Task 6: Thermal_Camera browser proof, offline packaging and documentation

**Agent:** general-purpose agent that invokes ui-ux-pro-max:ui-ux-pro-max and ui-ux-pro-max:ui-styling; return before/after screenshots in both themes, compared with the KiCad reference.

**Files:**
- Modify: `README.md` schematic controls section.
- Test: `test_kicad_review.py`, `ui/checks.mjs`.
- Local proof only: session scratchpad `stage6-proof/`; no private artifacts committed.

**Interfaces:**
- Consumes: complete Tasks 1–5, `inline_page(data_js) -> str`, existing sample data and actual Thermal_Camera transparent/framed export.
- Produces: offline proof HTML, before/after both-theme screenshots, browser results; final task report links scratch files and states any visual deviations. Proof images are not repository deliverables.

- [ ] **Step 1: Add failing packaging assertion and stable screenshot check.**

Append to `test_kicad_review.py`:

```python
page = kr.inline_page('window.REVIEW_DATA={"version":1};')
assert '--sch-paper:#f5f4ef' in page
assert 'function themeSchematic(' in page
assert 'function schematicGridPlan(' in page
assert not re.search(r'<script[^>]+src=["\'](?!data:)', page)
assert not re.search(r'<link[^>]+href=["\'](?:https?:|tokens\.css|review\.css)', page)
print('ok SCH6 offline schematic assets')
```

Add a screenshot-only stable check. It must return true only after the physical page is visible:

```javascript
["SCH6 proof framed page", "v=sheet:/&m=side", `
  await draw(); fit();
  const svg=document.querySelector('#stage .vp.sheet .layer svg');
  return !!svg && svg.querySelectorAll('path').length>100 && currentView().kind==='sheet';
`],
```

- [ ] **Step 2: Run packaging test.**

Run: `python3 test_kicad_review.py`

Expected: PASS if all assets stayed inline; FAIL if implementation accidentally introduced external schematic scripts/CSS or lost the template inlining hooks. Fix packaging at its existing `inline_page` owner, not by fetching runtime assets.

- [ ] **Step 3: Generate local real-design proof HTML.** Before executing Task 1, capture the same Thermal_Camera design through the current Stage 5 loader for the before images. After Task 5 repeat the script with current assets and full framed export. Keep project inputs outside this checkout. The following script uses the trusted repository module and sample metadata, and the actual CLI export only as data; it copies no Aux content.

Run from the worktree, with `TMPDIR` set to the session scratchpad so Chrome profiles also stay there:

```sh
export TMPDIR=/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad
mkdir -p "$TMPDIR/stage6-proof"
python3 - <<'PY'
import copy, json, pathlib
import kicad_review as k
scratch=pathlib.Path('/private/tmp/claude-501/-Users-cameron-Claude-KiCAD-Assistant/ccdf9c56-887f-4566-8c7e-16e25f4f9c1b/scratchpad')
text=pathlib.Path('ui/sample/review-data.js').read_text()
start=text.index('{'); end=text.rfind('}')+1
data=json.loads(text[start:end]); p=copy.deepcopy(data['projects'][0])
svg=(scratch/'stage6-export/transparent/Thermal_Camera.svg').read_text()
blobs={}; blob=k.add_blob(blobs,svg)
p.update(name='Thermal_Camera',dir='Thermal_Camera',status='unchanged',
    sheets=[dict(path='/',parent=None,name='Thermal_Camera',file='Thermal_Camera.kicad_sch',
      page='1',status='unchanged',size=k.svg_size(svg),svg=dict(base=blob,head=blob))],
    changes=[],checks=[],objects=[],libraries=[])
p['board']={'changed':False,'layers':[],'status':'unchanged'}
p.pop('parts',None)
data.update(projects=[p],blobs=blobs,reason='Local schematic rendering proof; identical revisions')
(scratch/'stage6-proof/thermal-after.html').write_text(k.inline_page('window.REVIEW_DATA = '+json.dumps(data)+';'))
PY
CHECK_PORT=9356 node ui/check.mjs 'SCH6 proof framed page' --dark --page "$TMPDIR/stage6-proof/thermal-after.html" --shot "$TMPDIR/stage6-proof/thermal-after-dark.png"
CHECK_PORT=9356 node ui/check.mjs 'SCH6 proof framed page' --page "$TMPDIR/stage6-proof/thermal-after.html" --shot "$TMPDIR/stage6-proof/thermal-after-light.png"
```

For before images follow the execution preflight: run this script **before implementation**, changing the source path from `transparent` to `noframe` and output stem from `thermal-after` to `thermal-before`. Install the proof check first and run only that filter; do not run the full sample suite on this one-project proof. Save these baseline files before subsequent asset changes. Full regression runs use the untouched sample data.

The proof intentionally compares identical revisions and says so. It proves paper, frame, palette, grid, status and fit without fabricating design changes. Task 5's separate browser checks prove diff behavior. For a real changed Thermal_Camera report available from the private test checkout, rerun its existing report generation pipeline with these assets and capture both revisions too; never substitute mismatched sample change coordinates on top of Thermal_Camera.

- [ ] **Step 4: Add user documentation.** Insert under the report controls in README:

```text
Schematics retain KiCad's exported drawing sheet and title block. Paper stays
warm white in both interface themes. The dot grid is 50 mil (1.27 mm), anchored
to the drawing origin; distant views omit intermediate dots for legibility.
Ctrl+U toggles schematic coordinates between mm and mil without moving the view.
PageUp/PageDown visit the previous/next sheet by page number; Alt+Up visits the
parent. The hierarchy shows Name (page n), with the active sheet in bold.

Schematic colours use an exact-value map from KiCad's default SVG palette.
Roles with the same exported RGB value stay linked. Unknown/custom export
colours are preserved. Schematic diff outlines and recolour/hatch marks use
changed bounding regions because CLI SVG paths do not carry object UUIDs.
Existing reports without sheet renders still show the no-render message.
```

- [ ] **Step 5: Verify visual evidence, offline behavior and full suites.**

Run the four suites in Task 5 again on the worktree. Open the saved proof HTML via `file://` with network disabled in Chrome DevTools; observe no required requests. Change palette variable `--sch-ink-009600` in Elements and confirm already-loaded wires update, while frame uses `--sch-ink-840000`. Restore default values before screenshots.

Compare before/after dark/light screenshots against `sch-01-default.png` locally: same warm paper, green wires, dark-red frame/body, pale-yellow body fills, cyan reference/value text, fine grid, visible lower-right title block. Do not copy the private reference into the repository. Confirm grid is below ink, title block comes from SVG, hierarchy has the page suffix/active bold, and X/Y are visible without clipping at 1600 px. Exercise close zoom, both side viewports, wipe divider, blend slider, all mark styles, comment pin placement and explicit `p/v/m/x/y/z/s/t/l/c/h` round trip. Changing units must leave saved x/y/z in mm/px-per-mm.

Expected: all suites PASS; new SCH6 checks do not skip; no external report asset URLs; before/after screenshots in both themes. Return the scratch screenshot paths with a short comparison to the reference. Missing title block, invisible grid at close zoom, shifted pins, stale frame, unreadable labels or altered original source raster blocks completion.

- [ ] **Step 6: Commit.**

```sh
git add README.md test_kicad_review.py ui/checks.mjs
git commit -m "test: prove schematic fidelity and offline comparison behavior"
```

## Completion gate

All six tasks complete only when the actual Thermal_Camera CLI export remains the ink renderer, its drawing sheet is visible, exact-value palette variables update existing SVGs, hierarchy navigates by page number without changing UUID links, grid/status share the existing camera and units, all modes/marks/pins survive, and before/after browser screenshots in both themes have been compared locally with KiCad. Stage 7 owns user-facing palette import/persistence; this stage delivers its schematic exact-value palette interface, not another settings screen.
