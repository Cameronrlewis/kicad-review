"""Self-checks for kicad_review.py. Run: python3 test_kicad_review.py"""
from kicad_review import is_kicad_file, owner_project

dirs = {"", "boards/a", "boards/a/sub", "b"}
assert owner_project("boards/a/x.kicad_sch", dirs) == "boards/a"
assert owner_project("boards/a/sub/Libraries/y.kicad_mod", dirs) == "boards/a/sub"
assert owner_project("boards/ab/x.kicad_sch", dirs) == ""  # not a prefix match on 'boards/a'
assert owner_project("x.kicad_pcb", {"b"}) is None
assert is_kicad_file("p/fp-lib-table") and is_kicad_file("p/L.pretty/R.kicad_mod")
assert not is_kicad_file("p/p.kicad_prl") and not is_kicad_file("p/m.step")

# Object diff: UUID match, reference fallback when the UUID was regenerated, a move is one modified row.
from kicad_review import diff_objects, parse_sexpr, find, flatten
fp = lambda ref, x, v: {"kind": "footprint", "ref": ref, "match": ("footprint", ref), "where": {"board": True},
                        "pos": [x, 0], "props": {"reference": ref, "Value": v, "position": f"({x}, 0)"}}
base = {"u1": fp("R1", 1, "10k"), "u2": fp("R2", 2, "1k"), "u3": fp("R3", 3, "1k")}
head = {"u3": fp("R3", 3, "1k"), "u1": fp("R1", 5, "4.7k"), "new-uuid": fp("R2", 2, "1k"), "u4": fp("R4", 4, "1k")}
rows = {(r["action"], r["ref"]): r for r in diff_objects(base, head)}
assert set(rows) == {("modified", "R1"), ("added", "R4")}, rows.keys()  # R2 regenerated UUID: matched, unchanged
assert rows["modified", "R1"]["changes"] == [["Value", "10k", "4.7k"], ["position", "(1, 0)", "(5, 0)"]]
assert rows["modified", "R1"]["pos_before"] == [1, 0]

# Image exports discover declared layers regardless of whitespace or declaration layout.
import pathlib
from tempfile import TemporaryDirectory
from unittest.mock import patch
import kicad_review as kr

four = pathlib.Path('ui/fixtures/vf-order-4.kicad_pcb')
assert kr.board_layers(str(four)) == ['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu']
with TemporaryDirectory() as d:
    p = pathlib.Path(d, 'four.kicad_pcb')
    p.write_text(four.read_text().replace('(layers ', '(layers\n '))
    assert kr.board_layers(str(p)) == kr.board_layers(str(four))
    with patch('kicad_review.kicad_cli') as cli:
        kr.render_side(d, 'four', str(pathlib.Path(d, 'out')))
    svg_call = next(c.args for c in cli.call_args_list if c.args[:3] == ('pcb', 'export', 'svg'))
    layer_flag = '--layers' if '--layers' in svg_call else '-l'
    assert svg_call[svg_call.index(layer_flag) + 1] == 'B.Cu,In2.Cu,In1.Cu,F.Cu'
print('ok image export layer discovery')

# Only plain, absolutely-started stroke runs may join; preserve metadata and custom paint.
import xml.etree.ElementTree as ET
svg = '<svg xmlns="http://www.w3.org/2000/svg"><g style="fill:none"><path d="M 0 0 L 1 1"/><desc>x</desc><path d="M 1 1 L 2 2"/><path d="m 3 3 l 1 1"/><path transform="translate(1)" d="M 0 0"/></g><g fill="#abcdef"><path d="M 0 0"/><path d="M 1 1"/></g></svg>'
out = ET.fromstring(kr.simplify_sheet_svg(svg))
ns = {'s': 'http://www.w3.org/2000/svg'}
assert len(out.findall('.//s:path', ns)) == 5
assert out.findall('.//s:path', ns)[0].get('d') == 'M 0 0 L 1 1 M 1 1 L 2 2'
assert out.findall('.//s:g', ns)[1].get('fill') == '#abcdef'
assert out.find('.//s:desc', ns).text == 'x'
assert out.findall('.//s:path', ns)[1].get('d') == 'm 3 3 l 1 1'
assert out.findall('.//s:path', ns)[2].get('transform') == 'translate(1)'
inherited = '<svg xmlns="http://www.w3.org/2000/svg" fill="none"><g stroke="#abcdef"><path d="M0 0"/><path d="M1 1"/><circle r="1"/><path d="M2 2"/><path d="M3 3"/></g><g style="fill:#123456"><path d="M0 0"/><path d="M1 1"/></g></svg>'
out = ET.fromstring(kr.simplify_sheet_svg(inherited))
assert [p.get('d') for p in out.findall('.//s:path', ns)] == ['M0 0 M1 1', 'M2 2 M3 3', 'M0 0', 'M1 1']
assert out.find('.//s:circle', ns).get('r') == '1'
assert out.findall('.//s:g', ns)[0].get('stroke') == '#abcdef'
assert out.findall('.//s:g', ns)[1].get('style') == 'fill:#123456'
assert kr.simplify_sheet_svg(kr.simplify_sheet_svg(svg)) == kr.simplify_sheet_svg(svg)

# Separate translucent strokes composite twice at overlaps; a compound path paints once.
plain_pair = '<path d="M0 0 L10 0"/><path d="M0 0 L10 0"/>'
for paint in ('stroke="red" stroke-opacity="0.5"',
              'style="stroke:red;stroke-opacity:50%"',
              'stroke="rgba(255,0,0,0.5)"', 'stroke="#ff000080"',
              'stroke="currentColor"', 'stroke="url(#paint)"',
              'stroke="red" opacity="0.5"', 'stroke="red" filter="url(#blur)"',
              'stroke="red" mask="url(#mask)"', 'stroke="red" marker-end="url(#arrow)"',
              'style="stroke:red;mix-blend-mode:multiply"',
              'style="stroke:red;/* inherited alpha */stroke-opacity:.5"',
              'stroke="red" stroke-dasharray="1 2"'):
    unsafe = f'<svg xmlns="{ns["s"]}" fill="none"><g {paint}><g>{plain_pair}</g></g></svg>'
    optimized = ET.fromstring(kr.simplify_sheet_svg(unsafe))
    assert len(optimized.findall('.//s:path', ns)) == 2, paint
    assert [p.get('d') for p in optimized.findall('.//s:path', ns)] == ['M0 0 L10 0'] * 2
    assert kr.simplify_sheet_svg(kr.simplify_sheet_svg(unsafe)) == kr.simplify_sheet_svg(unsafe)
# CSS may target otherwise plain paths; do not infer paint from presentation attributes alone.
css_svg = f'<svg xmlns="{ns["s"]}"><style>path {{ stroke-opacity: .5 }}</style><g fill="none" stroke="red">{plain_pair}</g></svg>'
assert len(ET.fromstring(kr.simplify_sheet_svg(css_svg)).findall('.//s:path', ns)) == 2
animated_svg = f'<svg xmlns="{ns["s"]}"><g fill="none" stroke="red">{plain_pair}<animate attributeName="stroke-opacity" values="1;.5" dur="1s"/></g></svg>'
assert len(ET.fromstring(kr.simplify_sheet_svg(animated_svg)).findall('.//s:path', ns)) == 2
opaque_svg = f'<svg xmlns="{ns["s"]}" fill="none" stroke="#ff0000" stroke-opacity="1.0000"><g>{plain_pair}</g></svg>'
assert len(ET.fromstring(kr.simplify_sheet_svg(opaque_svg)).findall('.//s:path', ns)) == 1
print('ok image export inherited compositing safety')
assert kr.IMAGE_EXPORT_OPTIONS == {'page_size_mode': '1', 'drill_shape_opt': '0',
                                   'check_zones': True, 'themes': ['light', 'dark']}
print('ok image export contracts')

# S-expression parsing: quoted strings with escapes, nesting.
n = parse_sexpr('(a (b "x \\"y\\" z") (c 1 2))')
assert find(n, "b") == ["b", 'x "y" z'] and find(n, "c") == ["c", "1", "2"]
import json
import pickle
from kicad_review import Quoted, is_net_number
numeric_tokens = parse_sexpr('(net "12" 12)')
assert numeric_tokens == ['net', '12', '12']
assert isinstance(numeric_tokens[1], Quoted) and not is_net_number(numeric_tokens[1])
assert is_net_number(numeric_tokens[2])
assert len(set(numeric_tokens[1:])) == 1 and {numeric_tokens[1]: 'name'}['12'] == 'name'
assert json.dumps(numeric_tokens) == '["net", "12", "12"]'
restored_tokens = pickle.loads(pickle.dumps(numeric_tokens))
assert restored_tokens == numeric_tokens and isinstance(restored_tokens[1], Quoted)
assert not is_net_number(restored_tokens[1]) and is_net_number(restored_tokens[2])
assert flatten({"classes": [{"name": "Power", "w": 1}, {"name": "Default", "w": 2}]}) == {"classes.Power.w": "1", "classes.Power.name": "Power", "classes.Default.w": "2", "classes.Default.name": "Default"}
print("ok")

# Checks: a violation is new only if neither its item UUIDs nor its type/items/position match the base.
from kicad_review import run_check, DEFAULT_SETTINGS
V = lambda t, sev, uu, pos, items=("Pad 1 of R1",): {"type": t, "severity": sev, "description": f"{t} 0.1 mm", "items": list(items),
                                                     "uuids": uu, "pos": pos, "box": None, "where": {"board": True}}
base = [V("clearance", "error", ["a", "b"], [1, 1]), V("silk_overlap", "warning", [], [5, 5])]
head = [V("clearance", "error", ["a", "b"], [9, 9]),        # same items moved: not new
        V("silk_overlap", "warning", [], [5.04, 5]),        # no UUIDs, same place: not new
        V("clearance", "error", ["c"], [2, 2])]              # new error
c = run_check("drc", DEFAULT_SETTINGS, head, base)
assert (c["errors"], c["new_errors"], c["new_warnings"], c["status"]) == (2, 1, 0, "fail"), c
assert run_check("drc", {**DEFAULT_SETTINGS, "checks": {"drc": "informational"}}, head, base)["status"] == "warn"
print("ok")

# Reused schematic sheets have distinct violation identities, even with the same pin UUIDs and positions.
for uuids in (["pin"], []):
    base = [{**V("pin_not_connected", "error", uuids, [1, 1]), "where": {"sheet": "/a/"}}]
    head = [dict(base[0]), {**base[0], "where": {"sheet": "/b/"}}]
    c = run_check("erc", DEFAULT_SETTINGS, head, base)
    assert (c["new_errors"], c["fixed"], c["status"]) == (1, 0, "fail"), "CK-S1: second sheet error must be new"
print("ok CK-S1 sheet instance")

# Promoting a warning to an error is new for UUID, positional and explicit violation keys.
for identity in ({"uuids": ["pin"]}, {"uuids": []}, {"key": ("unconnected", ("GND",), 1)}):
    base = [{**V("clearance", "warning", [], [1, 1]), **identity}]
    c = run_check("drc", DEFAULT_SETTINGS, [{**base[0], "severity": "error"}], base)
    assert (c["new_errors"], c["fixed"], c["status"]) == (1, 1, "fail"), "CK-S2: promoted warning must be a new error"
print("ok CK-S2 severity promotion")

# Data format v1: ids unique per file, layer changed flags, links.
from kicad_review import assign_ids, review_links
projects = [{"changes": [{"kind": "symbol"}, {"kind": "track"}],
             "checks": [{"violations": [{"type": "x"}, {"type": "y"}]}]},
            {"changes": [{"kind": "via"}], "checks": []}]
assign_ids(projects)
ids = [r["id"] for p in projects for r in p["changes"]] + [v["id"] for p in projects for c in p["checks"] for v in c["violations"]]
assert ids == ["c1", "c2", "c3", "v1", "v2"], ids
env = {"GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "9",
       "PR_NUMBER": "2"}
links = review_links(env, {"base": "aaa", "head": "bbb"})
assert links == {"review": "https://github.com/o/r/pull/2", "base": "https://github.com/o/r/commit/aaa",
                 "head": "https://github.com/o/r/commit/bbb", "run": "https://github.com/o/r/actions/runs/9"}, links
assert review_links({**env, "PR_NUMBER": ""}, {"base": "aaa", "head": "bbb"})["review"] == "https://github.com/o/r/compare/aaa...bbb"
assert review_links({}, {"base": None, "head": "bbb"}) == {"review": "", "base": "", "head": "", "run": ""}
print("ok")

# The shipped page is one file: CSS, data and JS inlined, no external references left.
from kicad_review import inline_page
import re
html = inline_page("window.REVIEW_DATA = {\"version\": 1};")
assert 'href="tokens.css"' not in html and 'href="review.css"' not in html and 'src="review.js"' not in html and 'src="sample/' not in html
assert "window.REVIEW_DATA = {\"version\": 1};" in html and "<style>" in html
assert "http://" not in html and "https://fonts" not in html
for asset in ('board-gl.js', 'appearance-state.js', 'appearance.js', 'board-marks.js', 'board-diff.js'):
    assert not re.search(r'''(?:src|href)=["']''' + re.escape(asset), html), asset
assert 'window.BoardMarks' in html and 'window.BoardDiff' in html
assert html.index('window.BoardMarks') < html.index('window.BoardDiff') < html.index('const D = window.REVIEW_DATA')
assert not re.search(r'<script[^>]+src=', html)
assert 'src="appearance-state.js"' not in html
assert 'function createStore(' in html
assert html.index('function createStore(') < html.index('const D = window.REVIEW_DATA')
# Theme import/reset and defaults must work from the standalone file, not fetch fixtures.
from html.parser import HTMLParser
class InlineAppearanceAssets(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            assert not attrs.get('src'), ('external script', attrs)
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            assert not attrs.get('href'), ('external stylesheet', attrs)
InlineAppearanceAssets().feed(html)
assert html.index('window.KicadColors') < html.index('function createStore(')
assert html.index('function createStore(') < html.index('const stores = new Map()')
assert 'data-appearance-file' in html and 'data-appearance-reset' in html
assert 'fixtures/themes/' not in html
assert 'src="theme.js"' not in html
assert "kr.theme" in html and "window.KRTheme" in html
assert html.index("kr.theme") < html.index("<style>")
assert '<!-- KR_ICONS -->' not in html
assert 'id="kr-zoom-in-dark"' in html and 'id="kr-theme"' in html
assert 'href="icons/' not in html and 'src="icons/' not in html
assert 'CC-BY-SA-4.0' in html
for name in ('zoom_in.svg', 'zoom_out.svg', 'zoom_fit_in_page.svg'):
    assert name in open('ui/icons/LICENSE', encoding='utf-8').read()
assert 'builtin_color_themes.h:160' in open('NOTICE', encoding='utf-8').read()
assert "data-theme-toggle" in html
print("ok")

# Comment: direct link to the single HTML file plus a gh one-liner.
from kicad_review import comment_markdown
d = {"base": "a" * 40, "head": "b" * 40, "reason": "r", "links": {"run": "https://github.com/o/r/actions/runs/9"},
     "repo": "o/r", "run_id": "9", "projects": []}
body = comment_markdown(d, [], "https://github.com/o/r/actions/runs/9/artifacts/5", "5")
assert "[Open the review page](https://github.com/o/r/actions/runs/9/artifacts/5)" in body
assert "gh api repos/o/r/actions/artifacts/5/zip > kicad-review.html" in body
assert "unzip" not in body.lower()
print("ok")

# README describes the review page as it is: the five modes, keyboard stepping, Copy link and Go to.
readme = open("README.md").read()
assert all(m in readme for m in ("Side by side", "Overlay", "Wipe", "Blend", "Semantic", "j / k", "Copy link", "Go to")), "README modes"
assert "swipe and changed-regions" not in readme and "Open it from the link" not in readme
print("ok")

# Review fixes (ponytail + caveman, 2026-10-07).
import io, json, os, subprocess, sys
from unittest.mock import patch
d2 = {"base": "a" * 40, "head": "b" * 40, "reason": "r", "repo": "o/r",
      "links": {"run": "https://github.com/o/r/actions/runs/9"}, "projects": []}
body = comment_markdown(d2, [], "https://github.com/o/r/actions/runs/9/artifacts/5", "77")
assert "[Workflow run](https://github.com/o/r/actions/runs/9)" in body, "run link from links.run"
assert "gh api repos/o/r/actions/artifacts/77/zip" in body, "artifact id passed explicitly"
src = open("kicad_review.py").read()
assert '"run_url"' not in src and "review-data.js\", \"w\"" not in src and "rsplit('/', 1)" not in src
r = subprocess.run([sys.executable, "-c", "import kicad_review as k; k.inline_page('')"],
                   env={**os.environ, "LC_ALL": "C", "LANG": "C", "PYTHONCOERCECLOCALE": "0", "PYTHONUTF8": "0"},
                   capture_output=True, text=True)
assert r.returncode == 0, "inline_page must read UTF-8 regardless of locale: " + r.stderr[-200:]
js = open("ui/review.js").read()
assert "typeof " not in js and "const KEYS" not in js and "markersFor(view);" not in js and "Task 5" not in js, "leftover scaffolding"
assert "docs/superpowers" not in js and "docs/superpowers" not in readme, "plan paths stay out of shipped assets"
assert "window.REVIEW_DATA" in readme, "README documents regenerating the sample"
print("ok")

# Code review fixes (2026-10-07). Each block guards one finding.
import tempfile
from kicad_review import sheet_pages, page_svg, md

def sheet(name, file, uid):
    return f'(sheet (uuid "{uid}") (property "Sheetname" "{name}") (property "Sheetfile" "{file}"))'

def write(root, files):
    for path, text in files.items():
        os.makedirs(os.path.dirname(f"{root}/{path}") or root, exist_ok=True)
        with open(f"{root}/{path}", "w", encoding="utf-8") as fh:
            fh.write(text)

# 1. Nested sheets: kicad-cli names a page's SVG after its whole sheet path, with / and \ replaced by _.
t = tempfile.mkdtemp()
write(t, {"p/H.kicad_sch": "(kicad_sch " + sheet("A: x/y é", "a.kicad_sch", "u1") + sheet("B", "b.kicad_sch", "u2") + ")",
          "p/a.kicad_sch": "(kicad_sch " + sheet("Power", "pw.kicad_sch", "u3") + ")",
          "p/b.kicad_sch": "(kicad_sch " + sheet("Power", "pw.kicad_sch", "u4") + ")", "p/pw.kicad_sch": '(kicad_sch (symbol (uuid "r1") (at 10 20 0) (property "Reference" "R1") (property "Value" "10k")))',
          **{f"out/sch/{f}": "<svg/>" for f in ("H.svg", "H-A: x_y é.svg", "H-A: x_y é-Power.svg", "H-B.svg", "H-B-Power.svg")}})
found = {pg["path"]: page_svg(f"{t}/out", "H", pg) for pg in sheet_pages(f"{t}/p", "H")}
assert found == {"/": f"{t}/out/sch/H.svg", "/u1/": f"{t}/out/sch/H-A: x_y é.svg", "/u1/u3/": f"{t}/out/sch/H-A: x_y é-Power.svg",
                 "/u2/": f"{t}/out/sch/H-B.svg", "/u2/u4/": f"{t}/out/sch/H-B-Power.svg"}, found
from kicad_review import sch_objects
symbols = sch_objects(f"{t}/p", "H")
assert all(symbols[path]["ref"] == "R1" and symbols[path]["props"]["Value"] == "10k" and symbols[path]["pos"] == [10, 20, 0] for path in ("/u1/u3/r1", "/u2/u4/r1")), "TS-S2 schematic symbols"
print("ok TS-S2 schematic symbols")
# Sibling sheets with one name share one SVG file, so neither drawing can be trusted: stop with a message.
write(t, {"p/H.kicad_sch": "(kicad_sch " + sheet("A", "a.kicad_sch", "u1") + sheet("A", "b.kicad_sch", "u2") + ")"})
try:
    sheet_pages(f"{t}/p", "H")
    raise AssertionError("duplicate sibling sheet names must stop the review")
except SystemExit as e:
    assert "same name" in str(e), e
print("ok")

# SCH6: page numbers belong to the project and parent instance, not the shared file.
from tempfile import TemporaryDirectory
import kicad_review as kr

with TemporaryDirectory() as t:
    def child(uid, label, page, parent="/root", project="H"):
        return (f'(sheet (uuid "{uid}") (property "Sheetname" "{label}") '
                '(property "Sheetfile" "shared.kicad_sch") '
                f'(instances (project "Other" (path "{parent}" (page "99"))) '
                f'(project "{project}" (path "{parent}" (page "{page}")))))')
    write(t, {"H.kicad_sch": '(kicad_sch (uuid "root") '
          '(sheet_instances (path "/" (page "1"))) '
          + child("ten", "Ten", "10") + child("two", "Two", "2") + ')',
          "shared.kicad_sch": '(kicad_sch ' +
          child("nested", "Nested", "3", "/root/ten").replace('"shared.kicad_sch"', '"leaf.kicad_sch"')[:-2] +
          '(project "H" (path "/root/two" (page "7"))))))'})
    pages = kr.sheet_pages(t, "H")
    assert {p["path"]: p["page"] for p in pages} == {
        "/": "1", "/ten/": "10", "/ten/nested/": "3", "/two/": "2", "/two/nested/": "7"}
    assert pages[1]["file"] == pages[3]["file"] == "shared.kicad_sch"
    write(t, {"H.kicad_sch": '(kicad_sch (uuid "root") '
          '(sheet_instances (path "/" (page "1")) (path "/two" (page "A2"))) '
          + sheet("Two", "shared.kicad_sch", "two") + ')',
          "shared.kicad_sch": '(kicad_sch)'})
    assert kr.sheet_pages(t, "H")[1]["page"] == "A2"
    n = kr.parse_sexpr('(sheet (instances (project "H" '
        '(path "/root/a" (page "3")) (path "/root/b" (page "7")))))')
    assert kr.sheet_instance_page(n, "H", "/root/b/") == "7"
    assert kr.sheet_instance_page(n, "H", "/root/c") is None
    assert kr.sheet_instance_page(n, "Other", "/root/b") is None
    write(t, {"H.kicad_sch": '(kicad_sch ' + sheet("Two", "shared.kicad_sch", "two") + ')'})
    assert [p["page"] for p in kr.sheet_pages(t, "H")] == ["1", "2"]
    write(t, {"P.kicad_sch": '(kicad_sch)'})
    calls = []
    with patch.object(kr, "kicad_cli", side_effect=lambda *a: calls.append(a)):
        kr.render_side(t, "P", t + "/out")
    sch = next(c for c in calls if c[:3] == ("sch", "export", "svg"))
    assert "--exclude-drawing-sheet" not in sch
    assert "--no-background-color" in sch
print("ok SCH6 instance pages and transparent framed export")

# Unchanged drawings remain viewable, deduplicate blobs, and prefer head metadata.
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        for side, page in [("base", "2"), ("head", "10")]:
            write(t, {f"{side}/H/H.kicad_sch":
                f'(kicad_sch (sheet_instances (path "/" (page "{page}"))))',
                f"review/H/{side}/erc.json": '{"sheets": []}',
                f"review/H/{side}/sch/H.svg":
                '<svg viewBox="0 0 320 213"><path d="M10 10H310"/></svg>'})
        blobs = {}
        p = kr.build_project({"dir": "H", "name": "H", "status": "modified"},
                             blobs, kr.DEFAULT_SETTINGS)
        pg = p["sheets"][0]
        assert pg["page"] == "10" and pg["status"] == "unchanged"
        assert pg["svg"]["base"] == pg["svg"]["head"]
        assert pg["size"] == [320, 213] and "stem" not in pg
        assert len(blobs) == 1
        os.remove("head/H/H.kicad_sch")
        removed = kr.build_project({"dir": "H", "name": "H", "status": "modified"},
                                   {}, kr.DEFAULT_SETTINGS)["sheets"][0]
        assert removed["page"] == "2" and removed["status"] == "removed"
        assert removed["svg"]["base"] and removed["svg"]["head"] is None
    finally:
        os.chdir(old_cwd)
print("ok SCH6 unchanged drawing blobs and head page metadata")

# 2. Project folders with non-ASCII names and spaces are found (git quotes such paths unless told not to).
from kicad_review import detect, commit
here = os.getcwd()
t = tempfile.mkdtemp()
os.chdir(t)
g = lambda *a: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], check=True, capture_output=True)
g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "base")
write(t, {"Caméra 2024-01/cam.kicad_pro": "{}", "Caméra 2024-01/cam.kicad_sch": "(kicad_sch)"})
g("add", "-A"); g("commit", "-q", "-m", "head")
found = detect(commit("HEAD~1"), commit("HEAD"))
os.chdir(here)
assert found == [{"dir": "Caméra 2024-01", "name": "cam", "status": "added"}], found
print("ok")

# 3. macOS archive junk (__MACOSX folders, ._ AppleDouble files) is never a project or a KiCad file.
import kicad_review
from kicad_review import projects_at
assert not is_kicad_file("__MACOSX/Board/._Board.kicad_pcb") and not is_kicad_file("Board/._Board.kicad_sch")
t = tempfile.mkdtemp()
os.chdir(t)
g("init", "-q")
write(t, {"__MACOSX/B/._B.kicad_pro": "x", "B/._B.kicad_pro": "x", "B/B.kicad_pro": "{}"})
g("add", "-A"); g("commit", "-q", "-m", "junk")
found = projects_at(commit("HEAD"))
os.makedirs("repo"); os.rename("B", "repo/B"); os.rename("__MACOSX", "repo/__MACOSX")
seen, real = [], kicad_review.release_project
kicad_review.release_project = lambda pro, *a: seen.append(pro) or []
kicad_review.cmd_release(type("A", (), {"tag": "v1"}))
kicad_review.release_project = real
os.chdir(here)
assert found == {"B": "B/B.kicad_pro"}, found
assert seen == ["repo/B/B.kicad_pro"], seen
print("ok")

# DR-S4: KiCad allows only one project per directory.
for directory in ("", "P/"):
    t = tempfile.mkdtemp()
    os.chdir(t)
    try:
        g("init", "-q")
        write(t, {directory + "A.kicad_pro": "{}", directory + "Z.kicad_pro": "{}"})
        g("add", "-A"); g("commit", "-q", "-m", "two projects")
        duplicate = commit("HEAD")
        g("rm", directory + "Z.kicad_pro"); g("commit", "-q", "-m", "one project")
        assert projects_at(commit("HEAD")) == {directory.rstrip("/"): directory + "A.kicad_pro"}
        try:
            detect(None, duplicate)
            raise AssertionError("DR-S4: duplicate project directory must stop detection")
        except SystemExit as e:
            assert str(e) == f"Multiple .kicad_pro files in {directory.rstrip('/') or '.'!r}; KiCad allows one project per directory", e
    finally:
        os.chdir(here)
print("ok DR-S4 duplicate project directory")

# DR-S5: detect rejects output id collisions but allows noncolliding __ names.
for directories, collision in ((("a/b", "a__b"), True), (("a__b", "c"), False)):
    t = tempfile.mkdtemp()
    os.makedirs(f"{t}/repo")
    os.chdir(f"{t}/repo")
    try:
        g("init", "-q")
        write(os.getcwd(), {os.path.join(d, "P.kicad_pro"): "{}" for d in directories})
        g("add", "-A"); g("commit", "-q", "-m", "projects")
        r = subprocess.run([sys.executable, f"{here}/kicad_review.py", "detect"], capture_output=True, text=True,
                           env={**os.environ, "EVENT": "push", "AFTER": commit("HEAD"), "BEFORE": "0" * 40,
                                "DEFAULT_BRANCH": "missing", "GITHUB_OUTPUT": f"{t}/output", "GITHUB_STEP_SUMMARY": f"{t}/summary"})
        if collision:
            assert r.returncode != 0, "DR-S5: colliding project ids must stop detection"
            assert "project ids collide" in r.stderr, r.stderr
        else:
            assert r.returncode == 0, r.stderr
            assert len(json.load(open(f"{t}/review/detect.json"))["projects"]) == 2
    finally:
        os.chdir(here)
print("ok DR-S5 project id collision")

# 4. A large change never pushes the checks out of the comment, and every <details> stays closed.
long = lambda i: [[f"Field{k}", "x" * 50, "y" * 50] for k in range(6)]
big = lambda n: {"name": f"P{n}", "dir": f"p{n}", "status": "modified", "sheets": [], "board": {"changed": False},
                 "changes": [{"action": "modified", "kind": "symbol", "ref": f"R{i}", "changes": long(i)} for i in range(60)],
                 "checks": [{"name": "drc", "title": "DRC", "level": "required", "status": "fail", "errors": 3,
                             "new_errors": 1, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}]}
body = comment_markdown({**d2, "projects": [big(n) for n in range(3)]}, [], "", "")
assert len(body) <= 65536 and "| P2 | DRC (required) | ❌ fail |" in body, (len(body), body[-300:])
assert body.count("<details") == body.count("</details>"), (body.count("<details"), body.count("</details>"))
print("ok")

# 5. Text from KiCad files cannot add images, links, mentions or HTML to the comment.
evil = "<!-- ![x](https://e.example/p.png) [l](https://e.example) @org/team *b* `c`"
p = big(0)
p.update(name=evil, dir=evil, sheets=[], changes=[
    {"action": "modified", "kind": "symbol", "ref": evil, "changes": [["Value", evil, evil], [evil, "1", "2"]]},
    {"action": "added", "kind": "footprint", "ref": evil, "props": {"Value": evil}}])
p["checks"][0]["violations"] = [{"new": True, "severity": "error", "description": evil, "items": [evil]}]
body = comment_markdown({**d2, "projects": [p]}, [{"project": 0, "title": evil, "url": "https://img/x.png"}], "", "")
import re
plain = re.sub(r"```.*?```|`[^`\n]*`", "", body, flags=re.S)  # code is shown literally by GitHub
assert "<!-- ![" not in plain and "![x]" not in plain and "[l](" not in plain and "@org" not in plain, plain
assert "*b*" not in plain and "`c`" not in body, plain
print("ok")
assert md("https://x.com/a_b(1).pdf") == "https://x.com/a_b(1).pdf" and md("a|b") == "a\\|b", md("https://x.com/a_b(1).pdf")
print("ok")

# RC-S2: Long check descriptions fit the comment limit; an exhausted body budget never slices backwards.
p = big(0)
p["changes"] = []
p["checks"][0]["violations"] = [{"new": True, "severity": "error", "description": "Long net " + "x" * 1500, "items": []} for _ in range(50)]
body = comment_markdown({**d2, "projects": [p]}, [], "")
assert len(body) < 65536 and "x" * 301 not in body, "RC-S2: long check descriptions exceed the comment budget"
real_checks = kicad_review.checks_markdown
try:
    kicad_review.checks_markdown = lambda data: "x" * 60001
    body = comment_markdown(d2, [], "", rows=0)
    assert body.startswith("\n\n… truncated."), "RC-S2: negative body budget retains comment text"
finally:
    kicad_review.checks_markdown = real_checks
print("ok RC-S2 check budget")

# RC-A: titles, reasons and item names cannot exhaust the checks section budget.
for field in ("title", "reason", "items"):
    p = big(0)
    p["changes"] = []
    c = p["checks"][0]
    c["violations"] = [{"new": True, "severity": "error", "description": "net changed", "items": []}]
    if field == "items":
        c["violations"][0][field] = ["x" * 70000, "y" * 70000]
    else:
        c[field] = "x" * 70000
    data = {**d2, "projects": [p]}
    body = comment_markdown(data, [], "")
    assert len(body) < 65536 and "… checks truncated" in body, "RC-A: long " + field + " exceeds comment limit"
    assert body.count("<details") == body.count("</details>"), "RC-A: truncated checks leave details open"
# Place the section limit inside each opening tag, not only inside long text.
for tag_offset in (5, 13):
    p = big(0)
    p["checks"][0].update(title="", violations=[{"new": True, "severity": "error", "description": "x", "items": []}])
    data = {**d2, "projects": [p]}
    start = kicad_review.checks_markdown(data).index("<details>")
    p["checks"][0]["title"] = "x" * (49900 - start - tag_offset)
    p["checks"][0]["violations"][0]["items"] = ["x" * 70000]
    checks = kicad_review.checks_markdown(data)
    assert checks.count("<details>") == checks.count("</details>") and not re.search(r"<[^>\n]*(?:\n|$)", checks), "RC-A: checks cap splits a details tag"
print("ok RC-A checks section cap")

# RC-S3: Directory CR/LF cannot break out of the literal code span.
p = big(0)
p["dir"] = "foo\r\n\n![proof](https://e.example/dir.png)\r\n\nbar`"
body = comment_markdown({**d2, "projects": [p]}, [], "")
assert "(`foo   ![proof](https://e.example/dir.png)   bar'`, modified)" in body, "RC-S3: directory line breaks escape the code span"
print("ok RC-S3 directory line breaks")

# RC-S4: Template changes must not silently leave any of the four external assets, even under -O.
r = subprocess.run([sys.executable, "-O", "-c", 'import io, kicad_review as k; from unittest.mock import patch\nwith patch("kicad_review.open", side_effect=lambda path, **kw: io.StringIO(\'<script data-check src="review.js"></script>\' if path.endswith("review.html") else ""), create=True):\n k.inline_page("")'], capture_output=True, text=True)
assert r.returncode != 0 and "RuntimeError: external report assets remain" in r.stderr, "RC-S4: optimized Python silently leaves external assets"
template = open("ui/review.html", encoding="utf-8").read()
for marker in ('href="tokens.css"', 'href="review.css"', 'src="sample/review-data.js"', 'src="review.js"'):
    changed = template.replace(marker, "data-check " + marker)
    single_quoted = "<" + ("script " if marker.startswith("src") else "link ") + marker.replace('"', "'") + ("></script>" if marker.startswith("src") else ">")
    with patch("kicad_review.open", side_effect=lambda path, **kw: io.StringIO(single_quoted if path.endswith("review.html") else ""), create=True):
        try:
            inline_page("window.REVIEW_DATA={};")
        except RuntimeError as e:
            assert "external report assets remain" in str(e), e
        else:
            raise AssertionError("RC-S4: single-quoted asset silently remains " + marker)
    with patch("kicad_review.open", side_effect=lambda path, **kw: io.StringIO(changed if path.endswith("review.html") else ""), create=True):
        try:
            inline_page("window.REVIEW_DATA={};")
        except RuntimeError as e:
            assert "external report assets remain" in str(e), e
        else:
            raise AssertionError("RC-S4: template change silently leaves " + marker)
print("ok RC-S4 external asset guard")

# RC-S1: URL-looking text cannot supply Markdown links or images, including screenshot alt text.
for value in ("https://x/![proof](https://e.example/p.png)", "www.x/[proof](https://e.example/p.png)"):
    assert md(value) == value.replace("[", "%5B").replace("]", "%5D"), "RC-S1: URL Markdown delimiters are not encoded"
shot = {"project": 0, "title": "sheet https://x/](https://e.example/p.png)", "url": "https://trusted.example/shot.png"}
body = comment_markdown({**d2, "projects": [big(0)]}, [shot], "")
assert "![sheet https://x/%5D(https://e.example/p.png): before and after](https://trusted.example/shot.png)" in body, "RC-S1: screenshot alt text is unescaped"
for value in ("https://x/![proof](https://e.example/p.png)", "www.x/[proof](https://e.example/p.png)", shot["title"],
              r"https://x/\[p\](https://e.example/p.png)", r"https://x/\](https://e.example/p.png)"):
    assert all(len(m[1]) % 2 for m in re.finditer(r"(\\*)([\[\]])", md(value))), "RC-S1: URL bracket escape has even backslash count"
from urllib.parse import unquote
url = r"https://x.com/a[b]\c|d(1).pdf"
assert md(url) == "https://x.com/a%5Bb%5D%5Cc%7Cd(1).pdf" and unquote(md(url)) == url, "RC-S1: datasheet URL target changes"
print("ok RC-S1 URL delimiters")

# 6. No text in the data can end or re-open the data <script> (e.g. "<!--<script>" blanked the page).
t = tempfile.mkdtemp()
os.chdir(t)
write(t, {"review/detect.json": json.dumps({"base": "a", "head": "b", "reason": "<!--<script></script>", "projects": []})})
kicad_review.cmd_report(None)
html = open("review/kicad-review.html", encoding="utf-8").read()
os.chdir(here)
data = html[html.index("window.REVIEW_DATA"):]
data = data[:data.index("</script>")]
assert "<" not in data and json.loads(data[len("window.REVIEW_DATA = "):-1])["reason"] == "<!--<script></script>", data[:200]
print("ok")

# 7. Screenshots of a branch with / in its name survive the next run's clean-up. Runs the workflow step itself.
wf = open(".github/workflows/review.yml", encoding="utf-8").read()
step = wf[wf.index("- name: Publish screenshots"):]
step = step[step.index("run: |") + 7:]
step = "\n".join(l[10:] for l in step[:step.index("\n\n")].splitlines())
t = tempfile.mkdtemp()
subprocess.run(["git", "init", "-q", "--bare", f"{t}/origin.git"], check=True)
write(t, {"ws/review/images/a.png": "png"})
for run, key in (("1", "branch-feature/x"), ("2", "pr-3")):
    env = {**os.environ, "TOKEN": "x", "KEY": key, "GITHUB_SERVER_URL": f"file://{t}", "GITHUB_REPOSITORY": "origin",
           "RUNNER_TEMP": f"{t}/tmp{run}", "GITHUB_WORKSPACE": f"{t}/ws", "GITHUB_RUN_ID": run, "GITHUB_OUTPUT": f"{t}/out{run}"}
    r = subprocess.run(["bash", "-e", "-c", step], env=env, cwd=f"{t}/ws", capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
files = subprocess.run(["git", "-C", f"{t}/origin.git", "ls-tree", "-r", "--name-only", "kicad-review-assets"],
                       capture_output=True, text=True).stdout.split()
url = open(f"{t}/out1").read().strip().split("/raw/kicad-review-assets/")[1]
assert f"{url}/a.png" in files and "pr-3/2/a.png" in files, (url, files)
print("ok")

# 8. Boards saved by KiCad 7 or earlier: objects carry (tstamp ...) and footprints use fp_text for reference/value.
from kicad_review import pcb_objects
k7 = '''(kicad_pcb (version 20221018) (generator pcbnew)
  (net 0 "") (net 1 "GND")
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (tstamp 0a1b2c3d-0000-0000-0000-000000000001) (at 100 50)
    (fp_text reference "R12" (at 0 -1.4) (layer "F.SilkS") (tstamp 0a1b2c3d-0000-0000-0000-000000000002))
    (fp_text value "10k" (at 0 1.4) (layer "F.Fab") (tstamp 0a1b2c3d-0000-0000-0000-000000000003))
    (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu") (net 1 "GND") (tstamp 0a1b2c3d-0000-0000-0000-000000000004)))
  (segment (start 1 1) (end 2 2) (width 0.25) (layer "F.Cu") (net 1) (tstamp 0a1b2c3d-0000-0000-0000-000000000005))
  (via (at 3 3) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (tstamp 0a1b2c3d-0000-0000-0000-000000000006)))'''
t = tempfile.mkdtemp()
write(t, {"b.kicad_pcb": k7})
objs = pcb_objects(f"{t}/b.kicad_pcb")
fp = objs.get("0a1b2c3d-0000-0000-0000-000000000001", {})
assert {o["kind"] for o in objs.values()} >= {"footprint", "track", "via"}, objs
assert fp["ref"] == "R12" and fp["props"]["Value"] == "10k", fp
print("ok")
# The same board after KiCad 10 upgraded it: sheet file and name move to tokens, empty fields appear. No change.
k10 = k7.replace('(tstamp 0a1b2c3d-0000-0000-0000-000000000001) (at 100 50)', '(uuid 0a1b2c3d-0000-0000-0000-000000000001) (at 100 50) '
                 '(property "Datasheet" "") (property "Description" "") (sheetfile "b.kicad_sch")')
k7b = k7.replace('(at 100 50)', '(at 100 50) (property "Sheetname" "") (property "Sheetfile" "b.kicad_sch")')
write(t, {"b.kicad_pcb": k7b, "h.kicad_pcb": k10})
rows = diff_objects(pcb_objects(f"{t}/b.kicad_pcb"), pcb_objects(f"{t}/h.kicad_pcb"))
assert not [r for r in rows if r["kind"] == "footprint"], rows
print("ok")

# New: KiCad 10 zones name their net as (net "GND") without net_name, so a zone moved to another net must show.
zone = lambda n: f'(kicad_pcb (version 20260206) (zone (net "{n}") (layer "B.Cu") (uuid "z1") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))))'
write(t, {"b.kicad_pcb": zone("GND"), "h.kicad_pcb": zone("VCC")})
rows = diff_objects(pcb_objects(f"{t}/b.kicad_pcb"), pcb_objects(f"{t}/h.kicad_pcb"))
assert rows and rows[0]["ref"] == "VCC" and ["net", "GND", "VCC"] in rows[0]["changes"], rows
print("ok")

# Minor: every file is read and written as UTF-8 whatever the locale (non-ASCII text, → and — in the comment).
t = tempfile.mkdtemp()
write(t, {"review/detect.json": json.dumps({"base": "a", "head": "b", "reason": "Caméra → ü", "projects": []}),
          "kicad-review.toml": "# réglages\n"})
for cmd in (["report"], ["summary"]):
    r = subprocess.run([sys.executable, os.path.abspath("kicad_review.py"), *cmd], cwd=t, capture_output=True, text=True,
                       env={**os.environ, "LC_ALL": "C", "LANG": "C", "PYTHONCOERCECLOCALE": "0", "PYTHONUTF8": "0",
                            "GITHUB_STEP_SUMMARY": f"{t}/summary.md"})
    assert r.returncode == 0, (cmd, r.stderr[-300:])
print("ok")

# Minor: a check whose kicad-cli output is missing stops the review instead of disappearing from it.
from kicad_review import project_checks
t = tempfile.mkdtemp()
os.chdir(t)
write(t, {"head/P/P.kicad_pcb": "(kicad_pcb)", "review/P/head/erc.json": "{}"})
try:
    project_checks({"dir": "P", "name": "P"}, DEFAULT_SETTINGS, {"head": {}, "base": {}})
    raise AssertionError("missing drc.json must stop the review")
except SystemExit as e:
    assert "drc.json" in str(e), e
finally:
    os.chdir(here)
print("ok")

# Board-only projects cannot pass parity or BOM checks that require a schematic.
t = tempfile.mkdtemp()
os.chdir(t)
try:
    write(t, {"head/P/P.kicad_pcb": "(kicad_pcb)", "review/P/head/drc.json": "{}"})
    objs = {"head": {"r1": {"kind": "footprint", "props": {}}}, "base": {}}
    checks = project_checks({"dir": "P", "name": "P"}, DEFAULT_SETTINGS, objs)
    assert [c["name"] for c in checks] == ["drc", "parity", "bom"], "CK-S3: board-only parity and BOM must explicitly report not run"
    assert all(c["status"] == "not_run" and c["reason"] == "no schematic" and not c["violations"] for c in checks[1:]), checks
    assert all(c["status"] != "fail" for c in checks), checks
    comment = kicad_review.checks_markdown({"projects": [{"name": "P", "checks": checks}]})
    assert comment.count("not run") == 2 and comment.count("no schematic") == 2, comment
    off = {**DEFAULT_SETTINGS, "checks": {**DEFAULT_SETTINGS["checks"], "parity": "off", "bom": "off"}}
    assert [c["name"] for c in project_checks({"dir": "P", "name": "P"}, off, objs)] == ["drc"]
    write(t, {"head/P/P.kicad_sch": "(kicad_sch)", "review/P/head/erc.json": "{}"})
    checks = project_checks({"dir": "P", "name": "P"}, DEFAULT_SETTINGS, objs)
    assert [c["name"] for c in checks] == ["erc", "drc", "parity", "bom"], checks
    assert all(c["status"] == "pass" for c in checks), checks
finally:
    os.chdir(here)
print("ok CK-S3 schematic-required checks")

# Minor: two projects with one file name get release files that do not overwrite each other.
t = tempfile.mkdtemp()
os.chdir(t)
write(t, {"repo/a/B.kicad_pro": "{}", "repo/b/x/B.kicad_pro": "{}", "repo/c/C.kicad_pro": "{}"})
seen = []
kicad_review.release_project = lambda pro, tag, s, out, label=None: seen.append(label) or []
kicad_review.cmd_release(type("A", (), {"tag": "v1"}))
kicad_review.release_project = real
os.chdir(here)
assert seen == ["a-B", "b-x-B", "C"], seen
print("ok")

# DR-S6: flattened directory labels must not overwrite earlier fabrication outputs.
t = tempfile.mkdtemp()
os.chdir(t)
write(t, {f"repo/{p}.kicad_pro": "{}" for p in ("a/b/P", "a-b/P")})
seen = []
kicad_review.release_project = lambda pro, tag, s, out, label: seen.append(label) or []
try:
    try:
        kicad_review.cmd_release(type("A", (), {"tag": "v1"}))
        raise AssertionError("DR-S6: duplicate release label must stop fabrication")
    except SystemExit as e:
        assert "Duplicate release label" in str(e) and "a-b-P" in str(e), e
    assert seen == [], "DR-S6: duplicate label must stop before any export"
    assert not os.path.exists("release"), "DR-S6: duplicate label creates release output"
finally:
    kicad_review.release_project = real
    os.chdir(here)
print("ok DR-S6 duplicate release label")

# Minor: the README says what the arrow keys really do (they step only while focus is outside the list and buttons).
readme = open("README.md", encoding="utf-8").read()
assert "(or the arrow keys)" not in readme and "arrow keys step too after a click on the drawing" in readme, "README arrow keys"
print("ok")

# Only pull request runs share a concurrency group: each push and manual run reviews its own commits, so none may be cancelled.
group = wf[wf.index("group:"):].splitlines()[0]
assert group.endswith("${{ github.event.pull_request.number || github.run_id }}") and "github.ref" not in group, group
print("ok")

# WF-S1: fork PRs cannot write comments; keep report and required-check steps running.
wf = open(".github/workflows/review.yml", encoding="utf-8").read()
comment = wf[wf.index("- name: Pull request comment"):wf.index("- name: Fail on required checks")]
assert "github.event.pull_request.head.repo.full_name == github.repository" in comment.splitlines()[2], "WF-S1: fork comment guard missing"
print("ok WF-S1: fork comment guard")

# A failed run replaces the comment with "Review failed — see run"; a later good run restores the summary.
wf = open(".github/workflows/review.yml", encoding="utf-8").read()
step = wf[wf.index("- name: Pull request comment"):]
assert "!cancelled()" in step.splitlines()[2] and "success()" not in step.splitlines()[2], step.splitlines()[2]
step = step[step.index("run: |") + 7:]
step = "\n".join(l[10:] for l in step[:step.index("\n\n")].splitlines())
t = tempfile.mkdtemp()
write(t, {"bin/gh": '''#!/bin/bash
if [[ "$*" == *"issues/7/comments"* && "$*" == *"--paginate"* ]]; then
  printf '%s\\n' "${GH_TEST_ID-99}"
elif [[ "$*" == *"-X PATCH"* ]]; then
  for arg in "$@"; do
    [[ "$arg" == body=@* ]] && cp "${arg#body=@}" "$GH_TEST_DIR/patched.md"
  done
  printf 'https://github.com/o/r/issues/7#issuecomment-99\\n'
elif [[ "$*" == *"-X POST"* ]]; then
  for arg in "$@"; do
    [[ "$arg" == body=@* ]] && cp "${arg#body=@}" "$GH_TEST_DIR/posted.md"
  done
  printf 'https://github.com/o/r/issues/7#issuecomment-100\\n'
fi
'''})
os.chmod(f"{t}/bin/gh", 0o755)
env = {**os.environ, "PATH": f"{t}/bin:{os.environ['PATH']}", "GH_TEST_DIR": t, "PR": "7", "SUMMARY": "failure",
       "RUN_URL": "https://github.com/o/r/actions/runs/123", "SHA": "abcdef1234", "GITHUB_REPOSITORY": "o/r"}
r = subprocess.run(["bash", "-e", "-c", step], env=env, cwd=t, capture_output=True, text=True)
assert r.returncode == 0, r.stderr
patched = open(f"{t}/patched.md", encoding="utf-8").read()
assert patched.startswith("<!-- kicad-review -->") and "Review failed".lower() in patched.lower() and env["RUN_URL"] in patched and "abcdef1" in patched, patched
assert not os.path.exists(f"{t}/posted.md")
normal = "<!-- kicad-review -->\nnormal summary\n"
write(t, {"review/comment.md": normal})
env["SUMMARY"] = "success"
r = subprocess.run(["bash", "-e", "-c", step], env=env, cwd=t, capture_output=True, text=True)
assert r.returncode == 0, r.stderr
assert open(f"{t}/patched.md", encoding="utf-8").read() == normal
print("ok")

# WF-S2: unchanged PRs clear an existing comment, never create one; detect failure still reports failure.
comment = wf[wf.index("- name: Pull request comment"):wf.index("- name: Fail on required checks")]
assert "steps.detect.outputs.changed" not in comment.splitlines()[2], "WF-S2: unchanged PR comment is skipped"
assert "CHANGED: ${{ steps.detect.outputs.changed }}" in comment, "WF-S2: changed output missing"
for changed, summary, existing in (("false", "skipped", "99"), ("false", "skipped", ""), ("", "failure", "99"), ("", "failure", "")):
    t = tempfile.mkdtemp()
    r = subprocess.run(["bash", "-e", "-c", step], cwd=t, capture_output=True, text=True,
                       env={**env, "GH_TEST_DIR": t, "CHANGED": changed, "SUMMARY": summary, "GH_TEST_ID": existing})
    assert r.returncode == 0, r.stderr
    target = "patched.md" if existing else "posted.md"
    if changed == "false" and not existing:
        assert not os.path.exists(f"{t}/{target}"), "WF-S2: unchanged PR creates a comment"
    else:
        body = open(f"{t}/{target}", encoding="utf-8").read()
        assert ("No KiCad changes in this commit" if changed == "false" else "KiCad review failed") in body, body
    assert not os.path.exists(f"{t}/{'posted.md' if existing else 'patched.md'}")
print("ok WF-S2: unchanged comment and detect failure")

# History survives both non-report paths without changing their headings.
for changed, summary, heading in (("", "failure", "KiCad review failed"), ("false", "skipped", "No KiCad changes")):
    t = tempfile.mkdtemp()
    previous = "<!-- kicad-review-log -->\nold log\n<!-- /kicad-review-log -->\n"
    write(t, {"review/previous-log.md": previous})
    r = subprocess.run(["bash", "-e", "-c", step], cwd=t, capture_output=True, text=True,
                       env={**env, "GH_TEST_DIR": t, "CHANGED": changed, "SUMMARY": summary, "GH_TEST_ID": "99"})
    assert r.returncode == 0, r.stderr
    body = open(f"{t}/patched.md", encoding="utf-8").read()
    assert heading in body and body.endswith(previous) and body.startswith("<!-- kicad-review -->"), body
print("ok failure and no-change keep the review log")
assert wf.index("- name: Fetch previous review log") < wf.index("- name: Job summary")
fetch_log = wf[wf.index("- name: Fetch previous review log"):wf.index("- name: Job summary")]
assert "vars.KICAD_REVIEW_HISTORY == 'true'" in fetch_log
assert "github.event.pull_request.head.repo.full_name == github.repository" in fetch_log
assert "comments?per_page=100" in fetch_log
assert "HISTORY: ${{ vars.KICAD_REVIEW_HISTORY }}" in wf
print("ok history fetch opt-in and fork guard")

# Readiness gates required checks and blocking threads; optional publishing never fails the job.
fail = wf[wf.index("- name: Fail on required checks"):wf.index("- name: Fabrication outputs")]
assert "if: ${{ !startsWith(github.ref, 'refs/tags/') && (steps.report.outputs.failed != '' || steps.summary.outputs.threads_failed != '') }}" in fail
assert "THREADS: ${{ steps.summary.outputs.threads_failed }}" in fail
publish = wf[wf.index("- name: Publish check runs"):wf.index("- name: Pull request comment")]
assert "if: ${{ !cancelled() && steps.summary.outputs.check_runs == 'true' }}" in publish
assert "HEAD: ${{ steps.detect.outputs.head }}" in publish
assert "review/check-runs.json" in publish and "continue-on-error: true" in publish and "exit 0; }" in publish
print("ok readiness workflow gate and optional check runs")

# Reports expose an artifact filename containing the compared revisions and result.
def report_output(base, head):
    t = tempfile.mkdtemp()
    out = f"{t}/github-output"
    write(t, {"review/detect.json": json.dumps({"base": base, "head": head, "reason": "test", "projects": []})})
    r = subprocess.run([sys.executable, os.path.abspath("kicad_review.py"), "report"], cwd=t, capture_output=True, text=True,
                       env={**os.environ, "GITHUB_OUTPUT": out})
    assert r.returncode == 0, r.stderr[-300:]
    return open(out, encoding="utf-8").read()
assert re.search(r"^name=kicad-review-1234567-abcdef0-pass\.html$", report_output("1234567890abcdef", "abcdef0123456789"), re.M)
assert re.search(r"^name=kicad-review-none-fedcba9-pass\.html$", report_output("", "fedcba9876543210"), re.M)
print("ok")

# Reports remain available for 90 days, including the documented retention period.
wf = open(".github/workflows/review.yml", encoding="utf-8").read()
readme = open("README.md", encoding="utf-8").read()
assert "retention-days: 90" in wf, "workflow retention"
assert "reports are kept 90 days" in readme, "README retention"
print("ok")

# A configured review site is the primary comment link without changing comments otherwise.
site_default = comment_markdown(d, [], "https://github.com/o/r/actions/runs/9/artifacts/5", "5")
site_empty = comment_markdown(d, [], "https://github.com/o/r/actions/runs/9/artifacts/5", "5", site="")
site_body = comment_markdown(d, [], "https://github.com/o/r/actions/runs/9/artifacts/5", "5", site="https://kicad-review.example.workers.dev/")
site_url = "https://kicad-review.example.workers.dev/r/o/r/a/5"
assert site_default == site_empty, "empty site changes the existing comment"
assert site_body.count(site_url) == 1 and f"**[Open the review]({site_url})**" in site_body, site_body
assert "[Open the review page](https://github.com/o/r/actions/runs/9/artifacts/5)" in site_body
pdf_link_args = ([], "https://github.com/o/r/actions/runs/9/artifacts/5", "5")
pdf_off_data = {**d, "settings": {**d.get("settings", {}), "pdf": {"enabled": False}}}
pdf_on_data = {**d, "settings": {**d.get("settings", {}), "pdf": {"enabled": True}}}
assert comment_markdown(pdf_off_data, *pdf_link_args, site="https://kicad-review.example.workers.dev/") == site_body
pdf_site_body = comment_markdown(pdf_on_data, *pdf_link_args, site="https://kicad-review.example.workers.dev/")
assert pdf_site_body == site_body.replace(f"({site_url})", f"({site_url}?pdf=1)")
assert comment_markdown(pdf_on_data, *pdf_link_args) == site_default
print("ok PDF site comment link opt-in and off byte identity")
print("ok")

# The site deploy workflow is manual, least-privileged, pin-only, and does not contain credentials.
workflow = open(".github/workflows/site-deploy.yml", encoding="utf-8").read()
on_block = re.search(r"(?m)^on:\n((?:^[ \t]+[^\n]*\n?)*)", workflow)
assert on_block and on_block.group(1).strip() == "workflow_dispatch:", on_block.group(1) if on_block else "missing on"
assert re.search(r"(?m)^permissions:\n[ \t]+contents: read$", workflow), "contents: read"
for line in workflow.splitlines():
    if re.match(r"^\s*(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID):", line):
        assert "secrets." in line, line
assert not re.search(r"(?im)^\s*(?:GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET|SESSION_KEY):\s*[^$\s]", workflow), "literal secret"
for action in re.findall(r"(?m)^\s*-?\s*uses:\s*[^@\s]+@([^\s#]+)", workflow):
    assert re.fullmatch(r"[0-9a-f]{40}", action), action
print("ok")


# WF-S3: deployment tooling with credentials must use an exact Wrangler 4.x version.
assert re.search(r"npx --yes wrangler@4\.\d+\.\d+ deploy", workflow), "WF-S3: floating Wrangler version"
print("ok WF-S3: exact Wrangler version")

# Settings reject invalid BOM fields and non-table sections with a clear configuration error.
from kicad_review import load_settings
t = tempfile.mkdtemp()
invalid = [("[bom]\nrequired_fields = " + value, "bom.required_fields", "list of strings")
           for value in ('"MPN"', '[1]', '["MPN", 1]', 'true', '{ MPN = "x" }')]
invalid += [(f'{section} = "x"', section, "table") for section in ("checks", "bom", "fabrication")]
invalid += [("3d = true", "3d", "table")]
failures = []
for text, field, expected in invalid:
    write(t, {"kicad-review.toml": text + "\n"})
    try:
        load_settings((t,))
    except SystemExit as e:
        assert "kicad-review.toml" in str(e) and field in str(e) and expected in str(e), e
    except (TypeError, AttributeError):
        failures.append(field + " traceback")
    else:
        failures.append(field + " accepted")
assert not failures, "CK-S4: invalid settings must exit clearly: " + ", ".join(failures)
for fields in ('[]', '["MPN", "Value"]'):
    write(t, {"kicad-review.toml": "[bom]\nrequired_fields = " + fields + "\n"})
    assert load_settings((t,))["bom"]["required_fields"] == json.loads(fields)
print("ok CK-S4 settings validation")


# Optional 3D export: off by default, opt-in settings, binary GLB blobs, missing-model report data, and no-op render decision.
import base64, gzip
from kicad_review import build_project, board_changed, export_glb
here = os.getcwd()
t = tempfile.mkdtemp()
os.chdir(t)
write(t, {"base/kicad-review.toml": "[3d]\nenabled = true\n[checks]\nerc = 'required'\n",
          "head/kicad-review.toml": "[3d]\nenabled = false\n[checks]\nerc = 'off'\n",
          "base/P/P.kicad_pcb": '''(kicad_pcb (footprint "Package:U" (layer "F.Cu") (at 10 10 0) (uuid "u5") (fp_text reference "U5") (pad "1" smd (at 0 0)) (model "u.wrl"))
(footprint "Package:R" (layer "F.Cu") (at 20 10 0) (uuid "r1") (fp_text reference "R1") (pad "1" smd (at -1 0)) (pad "2" smd (at 1 0))))''',
          "head/P/P.kicad_pcb": '''(kicad_pcb (footprint "Package:U" (layer "F.Cu") (at 10 10 0) (uuid "u5") (fp_text reference "U5") (pad "1" smd (at 0 0)) (model "u.wrl"))
(footprint "Package:R" (layer "F.Cu") (at 20 10 0) (uuid "r1") (fp_text reference "R1") (pad "1" smd (at -1 0)) (pad "2" smd (at 1 0))))''',
          "review/P/base/board.glb": "base glb\x00", "review/P/head/board.glb": "head glb\x00",
          "review/P/head/glb.log": "Could not add 3D model for U5.\n",
          "review/P/base/pcb/P-F.Cu.svg": '<svg viewBox="0 0 1 1"><path/></svg>',
          "review/P/head/pcb/P-F.Cu.svg": '<svg viewBox="0 0 1 1"><path/></svg>',
          "review/P/base/drc.json": "{}", "review/P/head/drc.json": "{}"})
assert DEFAULT_SETTINGS["3d"]["enabled"] is False
assert load_settings()["3d"]["enabled"] is True and load_settings()["checks"]["erc"] == "required", "TS-S2 base settings win"
print("ok TS-S2 base settings win")
# A report with 3D disabled is deterministic; this is the pre-feature HTML baseline for the same fixture.
os.remove("base/kicad-review.toml")
write(t, {"review/detect.json": json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": []})})
kicad_review.cmd_report(None)
html_before = open("review/kicad-review.html", "rb").read()
# A disabled report is still byte-for-byte deterministic even though the viewer code is bundled.
kicad_review.cmd_report(None)
assert open("review/kicad-review.html", "rb").read() == html_before
write(t, {"base/kicad-review.toml": "[3d]\nenabled = true\n"})
# KiCad 10.0.0 emits this warning on stdout; the retained log must include both streams.
real_run = kicad_review.subprocess.run
kicad_review.subprocess.run = lambda *a, **kw: type("R", (), {"returncode": 0, "stdout": "Could not add 3D model for U5.\n", "stderr": "other diagnostic\n"})()
export_glb({"dir": "P", "name": "P"}, "head", "review/P/head")
kicad_review.subprocess.run = real_run
assert open("review/P/head/glb.log", encoding="utf-8").read() == "Could not add 3D model for U5.\nother diagnostic\n"
settings = load_settings(("base", "head"))
blobs = {}
p = build_project({"dir": "P", "name": "P", "status": "modified"}, blobs, settings)
assert gzip.decompress(base64.b64decode(blobs[p["board"]["model3d"]["base"]])) == b"base glb\x00"
assert gzip.decompress(base64.b64decode(blobs[p["board"]["model3d"]["head"]])) == b"head glb\x00"
missing = {x["ref"]: x for x in p["board"]["no_model"]}
assert {ref: (x["side"], x["reason"]) for ref, x in missing.items()} == {
    "U5": ("head", "file not found"), "R1": ("both", "no model in footprint")}, missing
# 3D fallback blocks need geometry for unchanged as well as changed footprints.
for x in missing.values():
    assert len(x["pos"]) == 3 and len(x["box"]) == 4 and x["layer"] in ("F.Cu", "B.Cu"), x
assert not board_changed({"dir": "P", "name": "P"})
write(t, {"head/P/P.kicad_pcb": "(kicad_pcb changed)"})
assert board_changed({"dir": "P", "name": "P"})
os.chdir(here)
print("ok")

# DR-S2: child sheet files are relative to their parent, including ..; objects use the same paths.
t = tempfile.mkdtemp()
write(t, {"P/H.kicad_sch": '(kicad_sch (uuid "root") ' + sheet("Child", "sub/child.kicad_sch", "child") + ')',
          "P/sub/child.kicad_sch": '(kicad_sch ' + sheet("Grand", "grand.kicad_sch", "grand") + ')',
          "P/sub/grand.kicad_sch": '(kicad_sch ' + sheet("Leaf", "../leaf.kicad_sch", "leaf") + ')',
          "P/leaf.kicad_sch": '(kicad_sch (symbol (uuid "symbol") (property "Reference" "R1")))'})
pages = sheet_pages(f"{t}/P", "H")
assert [p["file"] for p in pages] == ["H.kicad_sch", "sub/child.kicad_sch", "sub/grand.kicad_sch", "leaf.kicad_sch"], "DR-S2: parent-relative sheet paths"
assert sch_objects(f"{t}/P", "H")["/child/grand/leaf/symbol"]["ref"] == "R1", "DR-S2: nested sheet objects"
print("ok DR-S2 parent-relative pages and objects")

# DR-S3: changes to shared KiCad files schedule all head projects; unrelated files do not.
t = tempfile.mkdtemp()
os.chdir(t)
g("init", "-q")
write(t, {"A/A.kicad_pro": "{}", "B/B.kicad_pro": "{}", "Shared/common.kicad_sch": "(kicad_sch)"})
g("add", "-A"); g("commit", "-q", "-m", "base")
expected = [{"dir": d, "name": d, "status": "modified"} for d in ("A", "B")]
for file in ("Shared/common.kicad_sch", "Shared/common.kicad_sym"):
    write(t, {file: "changed"})
    g("add", "-A"); g("commit", "-q", "-m", "shared")
    assert detect(commit("HEAD~1"), commit("HEAD")) == expected, "DR-S3: unowned KiCad change schedules all projects"
os.remove("Shared/common.kicad_sch")
g("add", "-A"); g("commit", "-q", "-m", "delete shared")
assert detect(commit("HEAD~1"), commit("HEAD")) == expected, "DR-S3: deleted shared sheet schedules all projects"
write(t, {"notes.txt": "notes", "__MACOSX/._common.kicad_sch": "junk"})
g("add", "-A"); g("commit", "-q", "-m", "unrelated")
assert detect(commit("HEAD~1"), commit("HEAD")) == [{"dir": d, "name": d, "status": "unchanged"} for d in ("A", "B")], "every review retains unchanged projects"
write(t, {"B/B.kicad_sch": "(kicad_sch)"})
g("add", "-A"); g("commit", "-q", "-m", "one project")
assert detect(commit("HEAD~1"), commit("HEAD")) == [{"dir": "B", "name": "B", "status": "modified"}, {"dir": "A", "name": "A", "status": "unchanged"}], "changed projects first, unchanged projects retained"
os.chdir(here)
print("ok DR-S3 unowned KiCad changes schedule all projects")

# DR-S1: a project renamed in place is new; unchanged names retain modified/removed statuses.
t = tempfile.mkdtemp()
os.chdir(t)
g("init", "-q")
write(t, {f"P/old.{ext}": "{}" for ext in ("kicad_pro", "kicad_sch", "kicad_pcb")})
g("add", "-A"); g("commit", "-q", "-m", "base")
for ext in ("kicad_pro", "kicad_sch", "kicad_pcb"):
    os.rename(f"P/old.{ext}", f"P/new.{ext}")
g("add", "-A"); g("commit", "-q", "-m", "rename")
assert detect(commit("HEAD~1"), commit("HEAD")) == [{"dir": "P", "name": "new", "status": "added"}], "DR-S1: renamed project is added"
write(t, {"P/new.kicad_sch": "changed"})
g("add", "-A"); g("commit", "-q", "-m", "modify")
assert detect(commit("HEAD~1"), commit("HEAD")) == [{"dir": "P", "name": "new", "status": "modified"}], "DR-S1: same name is modified"
for ext in ("kicad_pro", "kicad_sch", "kicad_pcb"):
    os.remove(f"P/new.{ext}")
g("add", "-A"); g("commit", "-q", "-m", "remove")
assert detect(commit("HEAD~1"), commit("HEAD")) == [{"dir": "P", "name": "new", "status": "removed"}], "DR-S1: deleted project is removed"
os.chdir(here)
print("ok DR-S1 renamed project is added")
# OB-S1: power net and library symbol changes retain UUID and position.
t = tempfile.mkdtemp()
power = '(kicad_sch (uuid "root") (symbol (uuid "power") (at 1 2 0) (lib_id "power:+3V3") (property "Reference" "#PWR01") (property "Value" "+3V3")))'
write(t, {"b/P.kicad_sch": power})
for changed, expected in ((power.replace('+3V3', '+5V'), [["net", "+3V3", "+5V"], ["symbol", "power:+3V3", "power:+5V"]]),
                          (power.replace('power:+3V3', 'power:VCC'), [["symbol", "power:+3V3", "power:VCC"]])):
    write(t, {"h/P.kicad_sch": changed})
    rows = diff_objects(sch_objects(f"{t}/b", "P"), sch_objects(f"{t}/h", "P"))
    assert len(rows) == 1 and rows[0]["changes"] == expected, f"OB-S1 power props: {rows}"
print("ok OB-S1 power props")

# OB-S4: a sheet rename alone changes its review properties.
t = tempfile.mkdtemp()
write(t, {"b/P.kicad_sch": "(kicad_sch " + sheet("Old", "child.kicad_sch", "sheet1") + ")",
          "h/P.kicad_sch": "(kicad_sch " + sheet("New", "child.kicad_sch", "sheet1") + ")"})
rows = diff_objects(sch_objects(f"{t}/b", "P"), sch_objects(f"{t}/h", "P"))
assert len(rows) == 1 and rows[0]["changes"] == [["name", "Old", "New"]], f"OB-S4 sheet name: {rows}"
print("ok OB-S4 sheet name")

# OB-O1: global and hierarchical label direction changes show one shape property.
t = tempfile.mkdtemp()
for kind in ("global_label", "hierarchical_label"):
    label = f'(kicad_sch ({kind} "DATA" (uuid "label1") (at 1 2 0) (shape input)))'
    write(t, {"b/P.kicad_sch": label, "h/P.kicad_sch": label.replace('shape input', 'shape output')})
    rows = diff_objects(sch_objects(f"{t}/b", "P"), sch_objects(f"{t}/h", "P"))
    assert len(rows) == 1 and rows[0]["changes"] == [["shape", "input", "output"]], f"OB-O1 label shape: {rows}"
print("ok OB-O1 label shape")

# OB-S3: all models and their transforms are one property; absent models stay absent in rows.
t = tempfile.mkdtemp()
model = '(model "part.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))'
board = '(kicad_pcb (footprint "Lib:Part" (uuid "fp1") (at 10 20 0) (property "Reference" "R1") MODEL))'
write(t, {"b.kicad_pcb": board.replace('MODEL', model)})
for changed in (model.replace('part.step', 'new.step'), model.replace('offset (xyz 0', 'offset (xyz 2'),
                model.replace('scale (xyz 1', 'scale (xyz 2'), model.replace('rotate (xyz 0', 'rotate (xyz 90'),
                model + ' (model "second.step")', ''):
    write(t, {"h.kicad_pcb": board.replace('MODEL', changed)})
    rows = diff_objects(pcb_objects(f"{t}/b.kicad_pcb"), pcb_objects(f"{t}/h.kicad_pcb"))
    assert len(rows) == 1 and [c[0] for c in rows[0]["changes"]] == ["3D model"], f"OB-S3 model props: {rows}"
write(t, {"h.kicad_pcb": board.replace('MODEL', '')})
empty_model = pcb_objects(f"{t}/h.kicad_pcb")
assert empty_model["fp1"]["props"].get("3D model") is None and "3D model" not in diff_objects({}, empty_model)[0]["props"]
print("ok OB-S3 model props")

# OB-S2: one compact pad geometry prop, excluding identity/nets and absolute rotation.
t = tempfile.mkdtemp()
pad = '(pad "1" thru_hole oval (at 1 2) (size 1 2) (drill 0.5) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "pad1") (tstamp "old"))'
board = '(kicad_pcb (footprint "Lib:Part" (uuid "fp1") (at 10 20 0) (property "Reference" "R1") PAD))'
write(t, {"b.kicad_pcb": board.replace('PAD', pad)})
pad_base = pcb_objects(f"{t}/b.kicad_pcb")
for changed in (pad.replace('size 1 2', 'size 2 2'), pad.replace('oval', 'circle'), pad.replace('thru_hole', 'np_thru_hole'),
                pad.replace('drill 0.5', 'drill 0.8'), pad.replace('"*.Cu"', '"F.Cu"'), pad.replace('at 1 2', 'at 2 2'),
                pad.replace('at 1 2', 'at 1 2 45'), pad + ' (pad "2" smd rect (size 1 1))'):
    write(t, {"h.kicad_pcb": board.replace('PAD', changed)})
    rows = diff_objects(pad_base, pcb_objects(f"{t}/h.kicad_pcb"))
    assert len(rows) == 1 and [c[0] for c in rows[0]["changes"]] == ["pads"], f"OB-S2 pad geometry: {rows}"
assert re.fullmatch(r"1 pads, geom [0-9a-f]{10}", pad_base["fp1"]["props"]["pads"])
for angle in (90, -90, 360):
    rotated = board.replace('at 10 20 0', f'at 10 20 {angle}').replace('PAD', pad.replace('at 1 2', f'at 1 2 {angle}'))
    write(t, {"h.kicad_pcb": rotated})
    rows = diff_objects(pad_base, pcb_objects(f"{t}/h.kicad_pcb"))
    assert len(rows) == 1 and [c[0] for c in rows[0]["changes"]] == ["position"], f"OB-S2 rotate invariant: {rows}"
for changed in (pad.replace('"pad1"', '"pad2"').replace('"old"', '"new"'), pad.replace('net 1 "GND"', 'net 2 "VCC"')):
    write(t, {"h.kicad_pcb": board.replace('PAD', changed)})
    rows = diff_objects(pad_base, pcb_objects(f"{t}/h.kicad_pcb"))
    assert all(c[0] != "pads" for r in rows for c in r["changes"]), f"OB-S2 excluded fields: {rows}"
write(t, {"h.kicad_pcb": board.replace('PAD', '')})
assert pcb_objects(f"{t}/h.kicad_pcb")["fp1"]["props"].get("pads") is None
# KiCad's rotate/save round trip leaves float noise in local coordinates.
for noise in ("0.000001", "-0.000001", "0.0"):
    write(t, {"b.kicad_pcb": board.replace('PAD', pad.replace('at 1 2', 'at 1 -0.0 0')),
              "h.kicad_pcb": board.replace('at 10 20 0', 'at 10 20 90').replace('PAD', pad.replace('at 1 2', f'at 1 {noise} 90'))})
    rows = diff_objects(pcb_objects(f"{t}/b.kicad_pcb"), pcb_objects(f"{t}/h.kicad_pcb"))
    assert len(rows) == 1 and [c[0] for c in rows[0]["changes"]] == ["position"], f"OB-S2 pad position noise: {rows}"
print("ok OB-S2 pad position noise")
print("ok OB-S2 pad geometry and rotate invariant")

# OB-C: duplicate pad numbers retain each net, while unique numbers keep readable keys.
for numbers in (("1", "1"), ("1", "2")):
    pads = [pad.replace('"1" thru_hole', f'"{number}" thru_hole').replace('"pad1"', f'"pad{i}"') for i, number in enumerate(numbers)]
    write(t, {"b.kicad_pcb": board.replace("PAD", " ".join(pads))})
    before = pcb_objects(f"{t}/b.kicad_pcb")
    if numbers == ("1", "2"):
        assert {k: v for k, v in before["fp1"]["props"].items() if k.startswith("pad ")} == {"pad 1 net": "GND", "pad 2 net": "GND"}, "OB-C: unique pad keys changed"
    for index in (0, 1):
        changed = [p.replace('net 1 "GND"', 'net 2 "VCC"') if i == index else p for i, p in enumerate(pads)]
        write(t, {"h.kicad_pcb": board.replace("PAD", " ".join(changed))})
        rows = diff_objects(before, pcb_objects(f"{t}/h.kicad_pcb"))
        assert len(rows) == 1 and len(rows[0]["changes"]) == 1 and rows[0]["changes"][0][1:] == ["GND", "VCC"], f"OB-C: pad {index} net change lost for {numbers}: {rows}"
    if numbers == ("1", "1"):
        unrelated = '(pad "2" smd rect (at 0 0) (size 1 1))'
        for changed in (False, True):
            head_pads = [pads[0], pads[1].replace('net 1 "GND"', 'net 2 "VCC"') if changed else pads[1]]
            write(t, {"h.kicad_pcb": board.replace("PAD", " ".join([unrelated, *head_pads]))})
            rows = diff_objects(before, pcb_objects(f"{t}/h.kicad_pcb"))
            nets = [c for r in rows for c in r["changes"] if c[0].startswith("pad ")]
            assert nets == ([["pad 1#2 net", "GND", "VCC"]] if changed else []), f"OB-C: unrelated pad shifts duplicate net keys: {nets}"
print("ok OB-C duplicate pad nets and unique keys")

# TS-S2: exercise render/release above the process boundary, not stubs of the functions under test.
import csv, pathlib, zipfile
from kicad_review import render_side
t = tempfile.mkdtemp()
write(t, {"P/P.kicad_pro": "{}", "P/P.kicad_sch": "(kicad_sch)",
          "P/P.kicad_pcb": '(kicad_pcb\n(layers\n(0 "F.Cu" signal)\n(31 "B.Cu" signal)\n(44 "Edge.Cuts" user)\n)\n)'})
os.makedirs(f"{t}/release")
calls, fail_cli = [], False
real_run = kicad_review.subprocess.run
positions = "Ref,Val,Package,PosX,PosY,Rot,Side\nR1,10k,R_0603,10,20,90,top\n"
bom = "Comment,Designator,Footprint,LCSC Part #\n10k,R1,R_0603,C123\n"
def fake_cli(args, **kw):
    if not args[0].endswith("kicad-cli"):
        return real_run(args, **kw)
    calls.append(args)
    if fail_cli:
        return type("R", (), {"returncode": 7, "stdout": "failure stdout", "stderr": "failure stderr"})()
    out = pathlib.Path(args[args.index("-o") + 1])
    kind = args[3] if args[2] == "export" else args[2]
    name, text = {"svg": ("P.svg", "<svg/>"), "gerbers": ("P-F_Cu.gbr", "copper"), "drill": ("P.drl", "drill"), "pos": ("", positions), "bom": ("", bom)}.get(kind, ("", "{}"))
    out /= name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
kicad_review.subprocess.run = fake_cli
try:
    render_side(f"{t}/P", "P", f"{t}/render")
    assert calls == [
        ["kicad-cli", "sch", "export", "svg", "--no-background-color", "-o", f"{t}/render/sch", f"{t}/P/P.kicad_sch"],
        ["kicad-cli", "sch", "erc", "--format", "json", "--severity-all", "-o", f"{t}/render/erc.json", f"{t}/P/P.kicad_sch"],
        ["kicad-cli", "pcb", "export", "svg", "--mode-multi", "--exclude-drawing-sheet", "--page-size-mode", "1", "--drill-shape-opt", "0", "-l", "F.Cu,B.Cu,Edge.Cuts", "-o", f"{t}/render/pcb", f"{t}/P/P.kicad_pcb"],
        ["kicad-cli", "pcb", "drc", "--format", "json", "--severity-all", "--schematic-parity", "-o", f"{t}/render/drc.json", f"{t}/P/P.kicad_pcb"]], "TS-S2 render commands"
    assert all(pathlib.Path(f"{t}/render/{f}").read_text() == text for f, text in {"sch/P.svg": "<svg/>", "pcb/P.svg": "<svg/>", "erc.json": "{}", "drc.json": "{}"}.items())
    fail_cli = True
    try:
        render_side(f"{t}/P", "P", f"{t}/render")
        raise AssertionError("TS-S2 render must propagate CLI failure")
    except SystemExit as e:
        assert "failed (7)" in str(e) and "failure stdout" in str(e) and "failure stderr" in str(e), e
    fail_cli = False
    print("ok TS-S2 render commands, outputs and failure")
    calls.clear()
    made = kicad_review.release_project(f"{t}/P/P.kicad_pro", "v1", DEFAULT_SETTINGS, f"{t}/release", "P")
    stem = f"{t}/release/P-v1-jlcpcb"
    assert made == [stem + suffix for suffix in ("-gerbers.zip", "-positions.csv", "-bom.csv")], "TS-S2 release files"
    with zipfile.ZipFile(made[0]) as z:
        assert sorted(z.namelist()) == ["P-F_Cu.gbr", "P.drl"] and z.read("P-F_Cu.gbr") == b"copper" and z.read("P.drl") == b"drill"
    with open(made[1], newline="", encoding="utf-8") as f:
        assert list(csv.reader(f)) == [["Designator", "Val", "Package", "Mid X", "Mid Y", "Rotation", "Layer"], ["R1", "10k", "R_0603", "10", "20", "90", "Top"]]
    assert pathlib.Path(made[2]).read_text() == bom
    assert [c[3] for c in calls] == ["gerbers", "drill", "pos", "bom"] and "--check-zones" in calls[0] and "--exclude-dnp" in calls[2] and "--exclude-dnp" in calls[3]
finally:
    kicad_review.subprocess.run = real_run
print("ok TS-S2 release zip and CSV contents")

# TS-S1: CI exercises default, real 3D and unchanged two-project pages without extra installs.
test_wf = pathlib.Path(".github/workflows/test.yml").read_text(encoding="utf-8")
assert "uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0" in test_wf and "node-version: 22" in test_wf and test_wf.index("actions/setup-node@") < test_wf.index("- run: node"), "TS-S1 Node 22 before browser tests"
assert "google-chrome" in test_wf and "CHROME" in test_wf and "inline_page" in test_wf, "TS-S1 CI browser setup"
for command in ('node ui/check.mjs --no-skip "Waivers"', 'node ui/check.mjs', 'node ui/check.mjs --dark', 'node ui/check.mjs --no-skip "selection-only address"', 'node ui/check.mjs --no-skip "pasted selection address preserves an explicit position"', 'node ui/check.mjs --no-skip "passing checks with baseline findings"', 'node ui/check.mjs --no-skip 3D --page "$PAGES/3d.html"', 'node ui/check.mjs --no-skip 3D --dark --page "$PAGES/3d.html"', 'node ui/check.mjs --no-skip "unchanged sheet" --page "$PAGES/two.html"', 'node ui/check.mjs --no-skip "unchanged project" --page "$PAGES/two.html"', 'node ui/check.mjs --no-skip "Parts fixture" --page "$PAGES/parts.html"', 'node ui/check.mjs --no-skip "Parts fixture" --dark --page "$PAGES/parts.html"'):
    assert "      - run: " + command in test_wf.splitlines(), "TS-S1 CI missing " + command
assert "    runs-on: ubuntu-24.04\n    timeout-minutes: 60\n" in test_wf and test_wf.count("timeout-minutes:") == 1, "TS-S1 CI job timeout missing or duplicated"
assert "npm install" not in test_wf and "apt-get" not in test_wf, "TS-S1 no extra installs"
print("ok TS-S1 CI browser matrix")
print("ok")

# Parts lines: group by value+footprint+LCSC, normalise LCSC, flag missing numbers and conflicts.
from kicad_review import parts_lines, mark_new_problems
sym = lambda ref, v, lcsc=None, ds="~", mpn=None: {"kind": "symbol", "ref": ref, "props": {
    "Value": v, "Footprint": "R_0805", "Datasheet": ds, **({"LCSC": lcsc} if lcsc is not None else {}),
    **({"MPN": mpn} if mpn else {})}}
objs = {"a": sym("R1", "10k", " c17414 "), "b": sym("R2", "10k", "C17414"), "c": sym("R3", "1k", "~"),
        "d": sym("U1", "AP63203WU-7", ds="https://x/ap.pdf", mpn="AP63203WU-7"), "e": sym("R4", "4.7k", "C17414"),
        "f": {"kind": "footprint", "ref": "R1", "props": {}},
        "g": {"kind": "power symbol", "ref": "GND", "props": {"net": "GND", "symbol": "power:GND"}}}
L = {l["key"]: l for l in parts_lines(objs)}
r = next(l for l in L.values() if l["refs"] == ["R1", "R2"])
assert r["lcsc"] == "C17414" and "lcsc_conflict" in r["problems"], r   # C17414 also on 4.7k
assert next(l for l in L.values() if l["refs"] == ["R3"])["problems"] == ["missing_lcsc", "missing_mpn"]
u = next(l for l in L.values() if l["refs"] == ["U1"])
assert u["datasheet"] == "https://x/ap.pdf" and u["problems"] == ["missing_lcsc"]
assert not any("#PWR01" in l["refs"] or "GND" in l["refs"] for l in L.values())
assert parts_lines({}) == []
for props, ref in (({"in_bom": "no"}, "R5"), ({"dnp": "yes"}, "R6"), ({}, "R?")):
    o = sym(ref, "skip")
    o["props"].update(props)
    assert parts_lines({"x": o}) == [], o
from kicad_review import LCSC_FIELDS, MPN_FIELDS
for lcsc_field in LCSC_FIELDS:
    for mpn_field in MPN_FIELDS:
        o = sym("R10", "10k", ds="local.pdf")
        o["props"].update({f" {lcsc_field.upper()} ": " c12 ", mpn_field: " Part "})
        l = parts_lines({"x": o})[0]
        assert (l["lcsc"], l["mpn"], l["datasheet"], l["problems"]) == ("C12", "Part", None, []), l
objs = {"a": sym("R10", "10k", "bad"), "b": sym("R2", "10k", "BAD"), "c": sym("R2", "10k", "bad")}
l = parts_lines(objs)[0]
assert l["refs"] == ["R2", "R10"] and l["problems"] == ["bad_lcsc"], l
print("ok parts lines")

# Parts settings: off by default, base wins, tables and booleans only.
assert DEFAULT_SETTINGS["parts"]["enabled"] is False
with patch("kicad_review.os.path.exists", return_value=False):
    assert load_settings()["parts"]["enabled"] is False
for enabled in ("true", "false"):
    with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(f"[parts]\nenabled = {enabled}\n".encode()), create=True) as opened:
        assert load_settings()["parts"]["enabled"] is (enabled == "true")
        opened.assert_called_once_with("base/kicad-review.toml", "rb")
for text, error in (("parts = true", "parts must be a table"),
                    *[(f"[parts]\nenabled = {value}", "parts.enabled must be true or false") for value in ('"true"', "1", "[]")]):
    with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(text.encode()), create=True):
        try:
            load_settings()
            raise AssertionError("invalid parts settings accepted")
        except SystemExit as e:
            assert str(e) == "kicad-review.toml: " + error, e
print("ok parts settings")

# Parts changes follow reference designators, not matching part numbers on different refs.
from kicad_review import diff_parts
b = [{"refs": ["R1"], "value": "10k", "lcsc": "C1", "key": "10k|F|C1"}, {"refs": ["R2"], "value": "1k", "lcsc": "C2", "key": "1k|F|C2"},
     {"refs": ["R9"], "value": "5", "lcsc": None, "key": "5|F|"}]
h = [{"refs": ["R1"], "value": "10k", "lcsc": "C9", "key": "10k|F|C9"}, {"refs": ["R3"], "value": "1k", "lcsc": "C2", "key": "1k|F|C2"},
     {"refs": ["R9"], "value": "5", "lcsc": None, "key": "5|F|"}]
d = {(r["action"], tuple(r["refs"])) for r in diff_parts(b, h)}
assert d == {("swapped", ("R1",)), ("removed", ("R2",)), ("added", ("R3",))}, d
assert diff_parts(b, b) == [] and diff_parts([], []) == []
assert all(r["before"] is None for r in diff_parts([], h))
assert all(r["after"] is None for r in diff_parts(b, []))
old = parts_lines({r: sym(r, "10k", "C1") for r in ("R10", "R2")})
new = parts_lines({r: sym(r, "20k", "C1") for r in ("R10", "R2")})
assert diff_parts(old, new) == [{"action": "value", "refs": ["R2", "R10"], "before": old[0], "after": new[0]}]
footprint = [{**new[0], "footprint": "F", "key": "20k|F|C1"}]
assert diff_parts(new, footprint)[0]["action"] == "footprint", "same value and LCSC, new footprint"
assert parts_lines({"r": sym("R1", "1k", "C1", ds="HTTPS://x/r.pdf")})[0]["datasheet"] == "HTTPS://x/r.pdf", "scheme is case-insensitive"
print("ok parts diff")

# Project payload and report settings omit opted-out features; supplier lookup remains deferred.
import copy
here = os.getcwd()
t = tempfile.mkdtemp()
try:
    os.chdir(t)
    project = {"dir": "P", "name": "P", "status": "modified"}
    write(t, {"review/detect.json": json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": [project]})})
    objects = {"base": {"r": sym("R1", "10k", "C1")}, "head": {"r": sym("R1", "10k", "C9")}}
    with patch("kicad_review.project_objects", side_effect=lambda path, name: objects[path.split("/")[0]]), \
         patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
        for parts_enabled in (False, True):
            for models_enabled in (False, True):
                settings = copy.deepcopy(DEFAULT_SETTINGS)
                settings["parts"]["enabled"] = parts_enabled
                settings["3d"]["enabled"] = models_enabled
                with patch("kicad_review.load_settings", return_value=settings):
                    kicad_review.cmd_report(None)
                opted_out = json.loads(pathlib.Path("review/data.json").read_text())
                opted_out_embedded = json.loads(pathlib.Path("review/kicad-review.html").read_text().split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0])
                legacy_settings = copy.deepcopy(settings)
                del legacy_settings["digikey"]
                with patch("kicad_review.load_settings", return_value=legacy_settings):
                    kicad_review.cmd_report(None)
                data = json.loads(pathlib.Path("review/data.json").read_text())
                assert data == opted_out, "DigiKey opt-out must preserve pre-feature report data and settings"
                assert "digikey" not in data["settings"]
                p = data["projects"][0]
                assert ("parts" in data["settings"]) == ("parts" in p) == parts_enabled
                assert ("3d" in data["settings"]) == models_enabled
                assert "waivers" not in data["settings"] and "waivers" not in data
                if parts_enabled:
                    lines = {s: parts_lines(objects[s]) for s in ("base", "head")}
                    mark_new_problems(lines["base"], lines["head"])
                    assert {k: p["parts"][k] for k in ("lines", "changes", "supplier")} == {"lines": lines["head"], "changes": diff_parts(lines["base"], lines["head"]), "supplier": None}
                    assert set(p["parts"]) == {"lines", "changes", "supplier", "coverage", "field_changes", "dnp_mismatch"}
                    assert p["parts"]["changes"][0]["action"] == "swapped"
                    assert all("supplier" not in line for line in p["parts"]["lines"])
                html = pathlib.Path("review/kicad-review.html").read_text()
                for old_label in ("not found at JLCPCB", "JLCPCB data as of", '"LCSC", "JLCPCB", "PCBWay"'):
                    assert old_label not in html, old_label
                payload = html.split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0]
                embedded = json.loads(payload)
                assert embedded == opted_out_embedded
                del embedded["blobs"]
                assert embedded == data
        settings["parts"]["enabled"] = True
        with patch("kicad_review.project_objects", return_value={}):
            empty = build_project(project, {}, settings)["parts"]
            assert {k: empty[k] for k in ("lines", "changes", "supplier", "field_changes", "dnp_mismatch")} == {"lines": [], "changes": [], "supplier": None, "field_changes": [], "dnp_mismatch": []}
            assert empty["coverage"]["base"] is None and all(v == [0, 0] for v in empty["coverage"]["head"].values())
finally:
    os.chdir(here)
print("ok parts report data")

# Parts comments count only newly introduced blocking problems, not missing MPN or removals.
from kicad_review import parts_markdown
line = {"refs": ["R1"], "value": "10k", "lcsc": None, "problems": ["missing_lcsc", "missing_mpn"]}
p = {"name": "X", "parts": {"lines": [line], "changes": [
    {"action": "added", "refs": ["R1"], "before": None, "after": line}], "supplier": None}}
m = parts_markdown({"projects": [p]})
assert "1 problem introduced" in m and "R1 missing LCSC number" in m and "Supplier lookup not run (not available)." in m, m
assert parts_markdown({"projects": [{"name": "Y"}]}) == ""
for action, before, after in (("value", line, line), ("removed", line, None)):
    p["parts"]["changes"] = [{"action": action, "refs": ["R1"], "before": before, "after": after}]
    assert "introduced" not in parts_markdown({"projects": [p]})
p["parts"]["supplier"] = {"fetched_at": "2026-10-08T14:02:00Z", "error": None}
assert "DigiKey data as of 2026-10-08 14:02 UTC" in parts_markdown({"projects": [p]})
assert "#### Parts: X" in comment_markdown({**d2, "projects": [{**p, "dir": "", "status": "modified", "changes": [], "checks": []}]}, [], "")
conflict = {"refs": ["R2"], "value": "1k", "lcsc": "C1", "problems": ["lcsc_conflict"]}
m = parts_markdown({"projects": [{"name": "C", "parts": {"lines": [conflict], "supplier": None,
    "changes": [{"action": "added", "refs": ["R2"], "before": None, "after": conflict}]}}]})
assert "1 with a problem" in m and "R2 one LCSC number on several values" in m, "conflict counts as a problem: " + m
print("ok parts markdown")

# A large introduced-parts list stays within GitHub's comment limit, preserving checks.
large_parts = {"lines": [line], "supplier": None, "changes": [
    {"action": "added", "refs": ["R" + str(i)], "before": None, "after": line} for i in range(4000)]}
budget_project = {"name": "Budget", "dir": "", "status": "modified", "changes": [], "checks": [], "parts": large_parts}
budget_data = {**d2, "projects": [budget_project]}
body = comment_markdown(budget_data, [], "")
assert len(body) <= 65536 and "Parts truncated" in body and "### Checks" in body, len(body)
cut = body[:body.index("… Parts truncated")].rstrip("\n").rsplit("\n", 1)[1]
assert cut.startswith("- R") and cut.endswith(" missing LCSC number"), "parts cut at a whole line: " + cut
assert "#### Parts: Budget" in body
print("ok parts comment budget")

# Tag review resolves lightweight/annotated tags, ignoring non-v predecessors.
from kicad_review import resolve_revisions
here = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        def g(*args):
            return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True, capture_output=True, text=True).stdout.strip()
        g("init", "-q")
        pathlib.Path("P.kicad_pro").write_text("1")
        g("add", "."); g("commit", "-qm", "one"); g("tag", "v1.0")
        first = g("rev-parse", "HEAD")
        pathlib.Path("P.kicad_pro").write_text("2")
        g("commit", "-qam", "two"); g("tag", "test-1")
        pathlib.Path("P.kicad_pro").write_text("3")
        g("commit", "-qam", "three"); g("tag", "-am", "release", "v1.1")
        head = g("rev-parse", "HEAD")
        g("branch", "v1.1", first)  # A same-named branch must not shadow the pushed tag.
        assert resolve_revisions({"EVENT": "push", "TAG": "test-1", "AFTER": head}) == (first, g("rev-parse", "test-1"), "release test-1 vs v1.0")
        assert resolve_revisions({"EVENT": "push", "TAG": "v1.1", "AFTER": head}) == (first, head, "release v1.1 vs v1.0")
        assert resolve_revisions({"EVENT": "push", "TAG": "v1.0", "AFTER": first}) == (None, first, "release v1.0 (first release)")
        print("ok previous tag is the last v-tag")
        print("ok first tag has no base")
        assert DEFAULT_SETTINGS["release"] == {"review": False}
        output = pathlib.Path("outputs")
        with patch.dict(os.environ, {"TAG": "v1.1", "GITHUB_OUTPUT": str(output)}, clear=True), patch("kicad_review.resolve_revisions", side_effect=AssertionError("off must skip detection")):
            kicad_review.cmd_detect(None)
        assert output.read_text() == "base=\nhead=\nchanged=false\n"
        pathlib.Path("kicad-review.toml").write_text("[release]\nreview = true\n")
        assert load_settings(("",))["release"]["review"] is True
        for invalid in ('"true"', '1', '[]'):
            pathlib.Path("kicad-review.toml").write_text("[release]\nreview = " + invalid + "\n")
            try:
                load_settings(("",))
                raise AssertionError("invalid release.review accepted")
            except SystemExit as exc:
                assert str(exc) == "kicad-review.toml: release.review must be true or false"
        print("ok tag detection opt-in and settings")
    finally:
        os.chdir(here)

# Workflow-only release settings cannot change existing report/comment/summary bytes.
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        write(t, {"review/detect.json": json.dumps({"base": "a" * 40, "head": "b" * 40, "reason": "fixture", "projects": []})})
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings.pop("release")
        results = []
        for option in (None, False, True):
            current = copy.deepcopy(settings)
            if option is not None:
                current["release"] = {"review": option}
            with patch("kicad_review.load_settings", return_value=current):
                kicad_review.cmd_report(None)
            data = json.loads(pathlib.Path("review/data.json").read_text())
            pathlib.Path("summary.md").write_text("")
            with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": "summary.md"}), patch("sys.stdout", new=io.StringIO()):
                kicad_review.cmd_summary(type("A", (), {"image_base": "", "artifact_url": "", "artifact_id": ""}))
            results.append((pathlib.Path("review/data.json").read_bytes(), pathlib.Path("review/kicad-review.html").read_bytes(), pathlib.Path("review/comment.md").read_bytes(), pathlib.Path("summary.md").read_bytes()))
        assert results[0] == results[1] == results[2]
        print("ok release settings preserve report and summary bytes")
    finally:
        os.chdir(here)

# Release section preserves manual notes, is idempotent, and escapes untrusted data.
from kicad_review import release_notes, merge_notes, cmd_release_notes
rdata = {**d2, "repo": "o/r", "reason": "release v1.1 vs v1.0", "projects": [{"name": "Cam", "dir": "", "status": "modified", "changes": [], "checks": [
    {"name": "drc", "title": "DRC", "level": "required", "status": "pass", "errors": 0, "new_errors": 0, "warnings": 2, "new_warnings": 0, "fixed": 0, "violations": []}]}]}
sec = release_notes(rdata, "https://site.example", "77")
assert sec.startswith("<!-- kicad-review-release -->") and sec.rstrip().endswith("<!-- /kicad-review-release -->")
assert "release v1.1 vs v1.0" in sec and "**Cam**: no reviewable changes" in sec and "DRC ✅ pass (0 errors, 2 warnings)" in sec
assert "[Open the review](https://site.example/r/o/r/a/77)" in sec
once = merge_notes("## What's Changed\n* x\n", sec)
twice = merge_notes(once + "\nhand-written footer\n", sec.replace("2 warnings", "3 warnings"))
assert twice.count("<!-- kicad-review-release -->") == 1
assert "## What's Changed\n* x" in twice and "hand-written footer" in twice and "3 warnings" in twice and "2 warnings" not in twice
assert merge_notes(twice, sec.replace("2 warnings", "3 warnings")) == twice
assert "Open the review" not in release_notes(rdata, "javascript:alert(1)", "77")
assert "Open the review" not in release_notes(rdata, "https://site.example:bad", "77")
assert "Open the review" not in release_notes(rdata, "https://@site.example", "77")
assert "Open the review" not in release_notes(rdata, "https://site.example/x)\n# injected", "77")
assert "Open the review" not in release_notes(rdata, "https://site.example", "x")
evil = copy.deepcopy(rdata)
evil["reason"] = "release <b>\n# injected"
evil["projects"][0]["name"] = "Cam\n# injected"
evil["projects"][0]["checks"][0]["title"] = "DRC\n<script>"
escaped = release_notes(evil, "", "")
assert "\n# injected" not in escaped and "<script>" not in escaped and "<b>" not in escaped
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        write(t, {"review/data.json": json.dumps(rdata), "existing.md": "manual body"})
        with patch.dict(os.environ, {"SITE": "https://site.example"}):
            cmd_release_notes(type("A", (), {"existing": "existing.md", "artifact_id": "77"}))
        assert pathlib.Path("review/release-notes.md").read_text() == merge_notes("manual body", sec)
    finally:
        os.chdir(here)
print("ok notes section is replaced, not added twice")

wf = pathlib.Path(".github/workflows/review.yml").read_text()
detect_step = wf[wf.index("- name: Find all KiCad projects (changed first)"):wf.index("- name: Check out both")]
assert "refs/tags" not in detect_step.splitlines()[2]
assert "TAG: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}" in detect_step
fail_step = wf[wf.index("- name: Fail on required checks"):wf.index("- name: Fabrication outputs")]
assert "!startsWith(github.ref, 'refs/tags/')" in fail_step
fab_step = wf[wf.index("- name: Fabrication outputs"):wf.index("- name: Attach to")]
attach_step = wf[wf.index("- name: Attach to"):wf.index("- name: Write release notes")]
assert "always()" in fab_step and "!cancelled()" in fab_step and "id: fabrication" in fab_step
assert "always()" in attach_step and "steps.fabrication.outcome == 'success'" in attach_step
notes_step = wf[wf.index("- name: Write release notes"):]
assert "continue-on-error: true" in notes_step and "steps.report.outcome == 'success'" in notes_step
assert '--existing review/release-body.md --artifact-id "$ARTIFACT_ID"' in notes_step
print("ok tag workflow wiring")

# Final review: an orphan marker must never consume subsequent manual notes.
orphan = "<!-- kicad-review-release -->\nhuman text that must survive\n"
merged = merge_notes(orphan, sec)
merged_again = merge_notes(merged, sec.replace("2 warnings", "3 warnings"))
assert merged_again.startswith(orphan) and "human text that must survive" in merged_again
assert merge_notes(merged_again, sec.replace("2 warnings", "3 warnings")) == merged_again
print("ok orphaned release marker preserves human notes")

# Invalid tag settings remain off without invoking revision detection.
for settings_error in (SystemExit("invalid settings"), kicad_review.tomllib.TOMLDecodeError("bad TOML")):
    output = io.StringIO()
    class KeepOpen(io.StringIO):
        def close(self):
            pass
    written = KeepOpen()
    with patch.dict(os.environ, {"TAG": "v1"}, clear=True), patch("kicad_review.load_settings", side_effect=settings_error), patch("kicad_review.open", return_value=written), patch("sys.stdout", new=output), patch("kicad_review.resolve_revisions", side_effect=AssertionError("must stay off")):
        kicad_review.cmd_detect(None)
    assert written.getvalue() == "base=\nhead=\nchanged=false\n"
    assert "::warning::" in output.getvalue()
print("ok invalid tagged settings keep detection off")

checkout_tools = wf[wf.index("- name: Check out review tools"):wf.index("- name: Find all KiCad projects (changed first)")]
assert "id: tools" in checkout_tools
assert "steps.tools.outcome == 'success'" in fab_step
assert "steps.report.outcome" not in fab_step, "review failures must not suppress fabrication"
print("ok fabrication requires successful tool checkout")

# Execute the notes shell with a local gh stub, proving a changed body is not overwritten.
import textwrap
script = textwrap.dedent(notes_step.split("run: |\n", 1)[1])
tool_source = pathlib.Path(kicad_review.__file__).read_text()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        write(t, {"review/data.json": json.dumps(rdata), "tools/kicad_review.py": tool_source,
                  "bin/gh": "#!" + sys.executable + "\nimport os, pathlib, sys\nif sys.argv[2] == 'view':\n p = pathlib.Path('view-count'); n = int(p.read_text()) if p.exists() else 0; p.write_text(str(n + 1)); print('changed notes' if n and os.environ['BODY_CHANGED'] == '1' else 'human notes')\nelif sys.argv[2] == 'edit':\n pathlib.Path('edited').write_text('yes')\n"})
        pathlib.Path("bin/gh").chmod(0o755)
        for changed in (False, True):
            pathlib.Path("view-count").unlink(missing_ok=True)
            pathlib.Path("edited").unlink(missing_ok=True)
            result = subprocess.run(["bash", "-e", "-c", script], capture_output=True, text=True, env={**os.environ, "PATH": f"{t}/bin:" + os.environ["PATH"], "BODY_CHANGED": str(int(changed)), "GITHUB_REF_NAME": "v1", "GITHUB_REPOSITORY": "o/r", "ARTIFACT_ID": "77"})
            assert result.returncode == 0, result.stderr
            assert pathlib.Path("edited").exists() is not changed
            assert int(pathlib.Path("view-count").read_text()) == 2
            if changed:
                assert "::warning::" in result.stdout
    finally:
        os.chdir(here)
print("ok release notes re-read prevents stale body edits")


# DigiKey client: only the MPN is sent; each MPN once; 429 stops the run; ambiguous MPNs show no price.
import io as _io, urllib.error
from kicad_review import mpn_for_lookup, digikey_lookup, digikey_pick
assert mpn_for_lookup(" mp3302dj-lf-z ") == "mp3302dj-lf-z" and mpn_for_lookup("TBD") is None and mpn_for_lookup("<script>") is None
calls = []
def resp(obj, status=200, headers=None):
    r = _io.BytesIO(json.dumps(obj).encode()); r.status = status; r.headers = headers or {}; return r
prod = lambda mpn, mfr, qty, price: {"ManufacturerProductNumber": mpn, "Manufacturer": {"Name": mfr}, "QuantityAvailable": qty, "UnitPrice": price,
    "ProductStatus": {"Status": "Active"}, "Discontinued": False, "EndOfLife": False, "ProductUrl": "https://www.digikey.com/x",
    "ProductVariations": [{"DigiKeyProductNumber": "DK-1", "StandardPricing": [{"BreakQuantity": 1, "UnitPrice": price}, {"BreakQuantity": 10, "UnitPrice": price * 0.8}]}]}
def fake(req, timeout=None):
    body = req.data.decode() if req.data else ""
    calls.append((req.full_url, body))
    if req.full_url.endswith("/oauth2/token"):
        return resp({"access_token": "T", "expires_in": 599})
    kw = json.loads(body)["Keywords"]
    if kw == "LIMIT":
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {"Retry-After": "60"}, _io.BytesIO(b"{}"))
    if kw == "CR2032":
        return resp({"ExactMatches": [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)], "Products": [], "ProductsCount": 2})
    if kw == "NOPE":
        return resp({"ExactMatches": [], "Products": [], "ProductsCount": 0})
    return resp({"ExactMatches": [prod(kw, "MPS", 1234, 1.5)], "Products": [], "ProductsCount": 1, "SearchLocaleUsed": {"Currency": "USD"}})
s = json.loads(json.dumps(DEFAULT_SETTINGS)); s["parts"]["enabled"] = True; s["digikey"]["enabled"] = True
wanted = {"MP3302DJ-LF-Z": {"mpn": "MP3302DJ-LF-Z", "manufacturer": None}, "CR2032": {"mpn": "CR2032", "manufacturer": None},
          "NOPE": {"mpn": "NOPE", "manufacturer": None}}
out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fake, sleep=lambda t: None, now=lambda: "2026-10-13T12:00:00Z")
assert sum(u.endswith("/oauth2/token") for u, _ in calls) == 1 and len(calls) == 4, calls
assert all(json.loads(b) == {"Keywords": json.loads(b)["Keywords"], "Limit": 10, "Offset": 0} for u, b in calls[1:]), calls
r = out["results"]
assert r["MP3302DJ-LF-Z"]["status"] == "ok" and r["MP3302DJ-LF-Z"]["quantity"] == 1234 and r["MP3302DJ-LF-Z"]["breaks"][1] == [10, 1.2]
assert r["CR2032"]["status"] == "ambiguous" and r["CR2032"].get("unit_price") is None and r["CR2032"]["matches"] == 2
assert r["NOPE"]["status"] == "not_found"
assert out["supplier"]["calls"] == 4 and out["supplier"]["fetched_at"] == "2026-10-13T12:00:00Z" and out["supplier"]["error"] is None
print("ok each MPN fetched once")
print("ok ambiguous MPN")
assert digikey_pick({"ExactMatches": [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)]}, "CR2032", "renata")["quantity"] == 7
calls.clear()
wanted = {"A": {"mpn": "A", "manufacturer": None}, "LIMIT": {"mpn": "LIMIT", "manufacturer": None}, "Z": {"mpn": "Z", "manufacturer": None}}
out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fake, sleep=lambda t: None, now=lambda: "2026-10-13T12:00:00Z")
assert out["results"]["A"]["status"] == "ok" and out["results"]["LIMIT"]["status"] == "unavailable" and out["results"]["Z"]["status"] == "unavailable"
assert len(calls) == 3 and "rate limit" in out["supplier"]["error"], (calls, out["supplier"])
print("ok rate limit stops the run")

# DigiKey settings validate even when disabled; booleans are not lookup counts.
for value in ("", "~", "TBD", "?", "X", "todo", "NA", "n/a", "-"):
    assert mpn_for_lookup(value) is None
assert mpn_for_lookup(" A   B ") == "A B"
for text in ('[digikey]\nenabled = "yes"', '[digikey]\nenabled = true', '[digikey]\nsite = "us"',
             '[digikey]\ncurrency = "US"', '[digikey]\nmax_lookups = true', '[digikey]\nmax_lookups = 0',
             '[digikey]\nmax_lookups = 901', 'digikey = false'):
    with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(text.encode()), create=True):
        try:
            load_settings()
        except SystemExit:
            pass
        else:
            raise AssertionError(text)
with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(b'[parts]\nenabled = true\n[digikey]\nenabled = true\nsite = "CA"\ncurrency = "CAD"\nmax_lookups = 900'), create=True):
    assert load_settings()["digikey"] == {"enabled": True, "site": "CA", "currency": "CAD", "max_lookups": 900}

# Error paths use only injected transports; a failed run never leaks response bodies.
for code in (403,):
    calls.clear()
    def fail(req, timeout=None):
        calls.append(req.full_url)
        if req.full_url.endswith("/oauth2/token"):
            return resp({"access_token": "T"})
        raise urllib.error.HTTPError(req.full_url, code, "secret response", {}, _io.BytesIO(b"secret"))
    out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fail, sleep=lambda t: None)
    assert len(calls) == 2 and all(v["status"] == "unavailable" for v in out["results"].values())
    assert out["supplier"]["error"] and "secret" not in json.dumps(out)
calls.clear()
s["digikey"]["max_lookups"] = 1
out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fake, sleep=lambda t: None)
assert len(calls) == 2 and out["results"]["Z"]["status"] == "run_limit"
print("ok DigiKey validation, failure handling, and run limit")

from kicad_review import digikey_search, DigiKeyError
for data in ({}, [], "invalid"):
    out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=lambda req, timeout=None: resp(data), sleep=lambda t: None)
    assert out["supplier"]["calls"] == 1 and out["supplier"]["error"].startswith("sign-in failed:")
def missing(req, timeout=None):
    raise urllib.error.HTTPError(req.full_url, 404, "missing", {}, _io.BytesIO(b"{}"))
assert digikey_pick(digikey_search("T", "id", "NOPE", {"site": "US", "currency": "USD"}, urlopen=missing), "NOPE", None)["status"] == "not_found"
assert digikey_pick({"ExactMatches": [prod("A", "MPS", 0, 1.5)]}, "A", None)["status"] == "out_of_stock"
p = prod("A", "MPS", 5, 1.5); p["EndOfLife"] = True
assert digikey_pick({"ExactMatches": [p]}, "A", None)["status"] == "discontinued"
s["digikey"]["max_lookups"] = 100
pauses = []
digikey_lookup({"A": {"mpn": "A", "manufacturer": None}, "B": {"mpn": "B", "manufacturer": None}}, ("id", "secret"), s, urlopen=fake, sleep=pauses.append)
assert pauses == [0.6]
print("ok DigiKey token errors, 404, statuses, and pacing")

# Task 2 review regressions. Each transport is local; no real HTTP requests.
import unittest
import inspect
import http.client

class DigiKeyReviewTests(unittest.TestCase):
    def run_lookup(self, events):
        calls, pauses = [], []
        queue = iter(events)
        def transport(req, timeout=None):
            calls.append(req.full_url)
            self.assertEqual(timeout, 15)
            if req.full_url.endswith("/oauth2/token"):
                return resp({"access_token": "T"})
            event = next(queue)
            if isinstance(event, int):
                raise urllib.error.HTTPError(req.full_url, event, "secret", {}, _io.BytesIO(b"secret"))
            if isinstance(event, Exception):
                raise event
            mpn = json.loads(req.data)["Keywords"]
            return resp(event if event is not None else {"ExactMatches": [prod(mpn, "MPS", 10, 1.5)]})
        wanted = {key: {"mpn": key, "manufacturer": None} for key in "ABCDE"}
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings["parts"]["enabled"] = settings["digikey"]["enabled"] = True
        return digikey_lookup(wanted, ("id", "secret"), settings, urlopen=transport, sleep=pauses.append), calls, pauses

    def test_1_product_urls(self):
        for url in ("https://www.digikey.evil.com/x", "https://www.digikey.com@evil.com/x",
                    "https://www.digikey.com:443/x", "https://user@www.digikey.com/x", "http://www.digikey.com/x"):
            p = prod("A", "MPS", 10, 1.5); p["ProductUrl"] = url
            self.assertIsNone(digikey_pick({"ExactMatches": [p]}, "A", None)["url"], url)
        p["ProductUrl"] = "https://www.digikey.ca/en/products/x"
        self.assertEqual(digikey_pick({"ExactMatches": [p]}, "A", None)["url"], p["ProductUrl"])

    def test_2_malformed_responses(self):
        out, calls, _ = self.run_lookup([http.client.IncompleteRead(b"secret"), None, None, None, None])
        self.assertEqual(out["results"]["A"]["status"], "unavailable")
        self.assertEqual(out["results"]["B"]["status"], "ok")
        p = prod("CR2032", "MPS", 10, 1.5); p["Manufacturer"]["Name"] = None
        other = prod("CR2032", "Renata", 20, 2)
        self.assertEqual(digikey_pick({"ExactMatches": [p, other]}, "CR2032", "Renata")["quantity"], 20)
        p["ManufacturerProductNumber"] = 123
        self.assertEqual(digikey_pick({"ExactMatches": [p]}, "123", None)["status"], "ok")
        out, _, _ = self.run_lookup([{"ExactMatches": [None]}, None, None, None, None])
        self.assertEqual(out["results"]["A"], {"status": "unavailable", "mpn": "A"})
        self.assertEqual(out["supplier"]["error"], "1 lookups failed (last: invalid response)")

    def test_3_transient_and_consecutive_errors(self):
        out, calls, _ = self.run_lookup([None, 500, None, None, None])
        self.assertEqual(out["results"]["C"]["status"], "ok")
        self.assertEqual(out["supplier"]["error"], "1 lookups failed (last: HTTP 500)")
        self.assertEqual(len(calls), 6)
        out, calls, _ = self.run_lookup([500, 500, 500])
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(p["status"] == "unavailable" for p in out["results"].values()))
        out, calls, _ = self.run_lookup([500, None, 500, None, 500])
        self.assertEqual(len(calls), 6)
        self.assertEqual(out["supplier"]["error"], "3 lookups failed (last: HTTP 500)")

    def test_4_token_refresh(self):
        out, calls, pauses = self.run_lookup([401, None, None, None, None, None])
        self.assertEqual(out["results"]["A"]["status"], "ok")
        self.assertEqual(sum(u.endswith("/oauth2/token") for u in calls), 2)
        self.assertEqual(out["supplier"]["calls"], 8)
        self.assertNotIn("looked_up", out["supplier"])
        self.assertIsNone(out["supplier"]["error"])
        self.assertTrue(all(t >= 0.6 for t in pauses))
        out, calls, _ = self.run_lookup([401, 401])
        self.assertEqual(len(calls), 4)
        self.assertEqual(out["supplier"]["error"], "HTTP 401")
        out, calls, _ = self.run_lookup([401, None, 401])
        self.assertEqual(len(calls), 5)
        self.assertTrue(all("error" not in p for p in out["results"].values()))

    def test_5_no_line_errors(self):
        out, _, _ = self.run_lookup([500, None, None, None, None])
        self.assertEqual(out["results"]["A"], {"status": "unavailable", "mpn": "A"})
        self.assertNotIn("secret", json.dumps(out))

    def test_6_no_redundant_urlerror(self):
        self.assertNotIn("urllib.error.URLError", inspect.getsource(kicad_review._digikey_open))

    def test_7_manufacturer_whitespace(self):
        products = [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)]
        self.assertEqual(digikey_pick({"ExactMatches": products}, "CR2032", "  RENATA  ")["quantity"], 7)

    def test_8_unmatched_manufacturer(self):
        products = [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)]
        result = digikey_pick({"ExactMatches": products}, "CR2032", "Unknown")
        self.assertEqual(result, {"status": "ambiguous", "mpn": "CR2032", "matches": 2})
        self.assertNotIn("unit_price", result)

review_result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DigiKeyReviewTests))
assert review_result.wasSuccessful(), "DigiKey review regressions failed"

class DigiKeyIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.here = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)
        write(self.tmp.name, {"review/detect.json": json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": [{"dir": "p", "name": "P", "status": "modified"}]})})
        self.settings = copy.deepcopy(DEFAULT_SETTINGS)
        self.settings["parts"]["enabled"] = self.settings["digikey"]["enabled"] = True
        self.objects = {"1": sym("U1", "reg", "C1"), "2": sym("R1", "10k", "C2"), "3": sym("R2", "20k", "C3")}
        self.objects["1"]["props"].update(MPN=" mp3302dj-lf-z ", Manufacturer=" MPS ")
        self.objects["3"]["props"]["MPN"] = "<invalid>"

    def tearDown(self):
        os.chdir(self.here)
        self.tmp.cleanup()

    def lookup(self, creds=("", "")):
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch.dict(os.environ, {"DIGIKEY_CLIENT_ID": creds[0], "DIGIKEY_CLIENT_SECRET": creds[1]}), patch("kicad_review.digikey_lookup") as client:
            client.return_value = {"supplier": {"name": "DigiKey", "fetched_at": "2026-10-13T12:00:00Z", "currency": "USD", "calls": 2, "error": None, "skipped": None}, "results": {"MP3302DJ-LF-Z": {"status": "ok", "mpn": "MP3302DJ-LF-Z", "quantity": 1234, "unit_price": 1.5}}}
            kicad_review.cmd_lookup(None)
            return client

    def test_no_credentials_and_off(self):
        client = self.lookup()
        self.assertFalse(client.called)
        data = json.loads(pathlib.Path("review/supplier.json").read_text())
        self.assertEqual(data["supplier"]["calls"], 0)
        self.assertEqual(data["supplier"]["skipped"], "no credentials (forked pull request or secrets not set)")
        self.assertEqual(data["results"], {})
        self.assertNotIn("projects", data)
        self.assertNotIn("looked_up", data["supplier"])
        pathlib.Path("review/supplier.json").unlink()
        self.settings["digikey"]["enabled"] = False
        self.assertFalse(self.lookup(("id", "secret")).called)
        self.assertFalse(pathlib.Path("review/supplier.json").exists())

    def test_deduplication_and_conflicting_manufacturers(self):
        self.objects["3"]["props"].update(MPN="MP3302DJ-LF-Z", Manufacturer="Renata")
        client = self.lookup(("id", "secret"))
        self.assertEqual(client.call_args.args[0], {"MP3302DJ-LF-Z": {"mpn": "MP3302DJ-LF-Z", "manufacturer": None}})
        self.assertNotIn("secret", pathlib.Path("review/supplier.json").read_text())

    def test_merge_and_opt_out_identity(self):
        self.lookup(("id", "secret"))
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
            kicad_review.cmd_report(None)
            data = json.loads(pathlib.Path("review/data.json").read_text())
            parts = data["projects"][0]["parts"]
            self.assertEqual(next(line for line in parts["lines"] if "U1" in line["refs"])["supplier"]["status"], "ok")
            self.assertEqual(parts["supplier"]["not_looked_up"], {"no_mpn": 1, "invalid_mpn": 1, "run_limit": 0})
            self.settings["digikey"]["enabled"] = False
            kicad_review.cmd_report(None)
            before = {name: pathlib.Path(f"review/{name}").read_bytes() for name in ("data.json", "kicad-review.html")}
            pathlib.Path("review/supplier.json").unlink()
            kicad_review.cmd_report(None)
            self.assertTrue(all(pathlib.Path(f"review/{name}").read_bytes() == content for name, content in before.items()))
            self.assertIsNone(json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]["supplier"])

    def test_missing_lookup_and_run_limit(self):
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
            kicad_review.cmd_report(None)
            parts = json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]
            self.assertIn("did not finish", parts["supplier"]["error"])
            self.assertEqual(next(l for l in parts["lines"] if "U1" in l["refs"])["supplier"]["status"], "unavailable")
            pathlib.Path("review/supplier.json").write_text(json.dumps({"supplier": {"name": "DigiKey", "error": None}, "results": {"MP3302DJ-LF-Z": {"status": "run_limit", "mpn": "MP3302DJ-LF-Z"}}}))
            kicad_review.cmd_report(None)
            self.assertEqual(json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]["supplier"]["not_looked_up"]["run_limit"], 1)

    def test_whitespace_placeholder_counts(self):
        self.objects["3"]["props"]["MPN"] = " TBD "
        self.lookup()
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
            kicad_review.cmd_report(None)
        parts = json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]
        self.assertEqual(parts["supplier"]["not_looked_up"], {"no_mpn": 2, "invalid_mpn": 0, "run_limit": 0})
        raw_parts = [{"parts": {"lines": [{"mpn": " TBD "}]}}]
        kicad_review.merge_supplier(raw_parts, {"supplier": {}, "results": {}})
        self.assertEqual(raw_parts[0]["parts"]["supplier"]["not_looked_up"], {"no_mpn": 1, "invalid_mpn": 0, "run_limit": 0})

    def test_workflow_secrets_step_scope(self):
        workflow = pathlib.Path(self.here, ".github/workflows/review.yml").read_text()
        self.assertIn("DIGIKEY_CLIENT_ID:\n        required: false", workflow)
        self.assertIn("DIGIKEY_CLIENT_SECRET:\n        required: false", workflow)
        step = workflow.split("      - name: Look up parts at DigiKey\n")[1].split("      - name:")[0]
        self.assertIn("continue-on-error: true", step)
        self.assertIn("timeout-minutes: 5", step)
        self.assertIn("if: steps.detect.outputs.changed == 'true'", step)
        self.assertIn("run: python3 tools/kicad_review.py lookup", step)
        self.assertNotIn("${{", step.split("run:")[1])
        self.assertEqual(workflow.count("${{ secrets.DIGIKEY_CLIENT_ID }}"), 1)
        self.assertEqual(workflow.count("${{ secrets.DIGIKEY_CLIENT_SECRET }}"), 1)

integration_result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DigiKeyIntegrationTests))
assert integration_result.wasSuccessful(), "DigiKey integration regressions failed"


supplier_lines = [{"refs": ["U1"], "problems": [], "supplier": {"status": "ok", "quantity": 1234, "unit_price": 1.5}},
                  {"refs": ["U2"], "problems": [], "supplier": {"status": "out_of_stock", "quantity": 0, "unit_price": 7.25}},
                  {"refs": ["U3"], "problems": [], "supplier": {"status": "not_found"}}]
supplier_parts = {"lines": supplier_lines, "changes": [], "supplier": {"name": "DigiKey", "fetched_at": "2026-10-13T12:00:00Z", "looked_up": 2, "not_looked_up": {"no_mpn": 54, "invalid_mpn": 1, "run_limit": 2}, "error": None, "skipped": None}}
supplier_data = {"projects": [{"name": "P", "parts": supplier_parts}]}
text = parts_markdown(supplier_data)
assert "DigiKey data as of 2026-10-13 12:00 UTC (stock and price from DigiKey)." in text
assert "2 looked up: 1 in stock, 1 out of stock, 1 not found at DigiKey." in text
assert "54 parts not looked up: no MPN." in text
assert "1 part not looked up: invalid MPN." in text and "2 parts not looked up: run limit." in text
assert "1234" not in text and "1.5" not in text and "7.25" not in text and "$" not in text
supplier_parts["supplier"]["skipped"] = "no credentials (forked pull request or secrets not set)"
assert "DigiKey lookup skipped: no credentials (forked pull request or secrets not set)." in parts_markdown(supplier_data)
supplier_parts["supplier"]["skipped"] = None
supplier_parts["supplier"]["error"] = "HTTP 500\n<script>"
assert "DigiKey lookup unavailable: HTTP 500 &lt;script&gt;." in parts_markdown(supplier_data)
print("ok DigiKey comment counts, skipped lookup, and not looked up counts")

assert '"LCSC", "DigiKey", "PCBWay"' in inline_page('window.REVIEW_DATA = {"version":1};')
assert 'https://www.digikey.evil.com/x' not in text
# No lookup leaves comment and job-summary content unchanged.
assert parts_markdown({"projects": [{"name": "P", "parts": {"lines": [], "changes": [], "supplier": None}}]}) == "#### Parts: P\n\nSupplier lookup not run (not available). 0 lines, 0 with a problem.\n"
print("ok DigiKey disabled comment and enabled asset selection")

project_counts = [{"parts": {"lines": [{"mpn": "A"}, {"mpn": "a"}, {"mpn": "B"}]}}, {"parts": {"lines": [{"mpn": "C"}]}}]
kicad_review.merge_supplier(project_counts, {"supplier": {"looked_up": 3}, "results": {"A": {"status": "ok"}, "B": {"status": "unavailable"}, "C": {"status": "not_found"}}})
assert [p["parts"]["supplier"]["looked_up"] for p in project_counts] == [1, 1], "Supplier lookup count must belong to the project"

# Setup docs cover opt-in, credentials, terms and the conservative manufacturer rule.
readme = pathlib.Path(kicad_review.__file__).with_name("README.md").read_text()
for wording in ("### DigiKey stock and price (optional)", "DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET", "secrets: inherit", "MPNs only",
                "120 per minute", "1000 per day", "case-insensitive prefix", "Keep it off in public repositories", "only in the run's report",
                "digikey.enabled", "digikey.site", "digikey.currency", "digikey.max_lookups"):
    assert wording in readme, wording
assert "JLCPCB Components API lookup" not in readme
example = pathlib.Path(kicad_review.__file__).parent.joinpath("examples/kicad-review.toml").read_text()
for wording in ('# [digikey]', '# enabled = false', '# site = "US"', '# currency = "USD"', '# max_lookups = 100'):
    assert wording in example, wording
print("ok DigiKey setup, limits, terms and manufacturer docs")
# PDF: a static print page.
from kicad_review import print_html
pdata = {**d2, "repo": "o/r", "base": "a" * 40, "head": "b" * 40, "projects": [{"name": "A&B", "dir": "", "status": "modified", "checks": [
    {"name": "drc", "title": "DRC", "level": "required", "status": "fail", "errors": 1, "new_errors": 1, "warnings": 0, "new_warnings": 0, "fixed": 0,
     "violations": [{"new": True, "severity": "error", "description": "Clearance <1mm>", "items": ["J1"], "where": {"board": True}}]}],
    "changes": [{"action": "modified", "kind": "footprint", "ref": f"R{i}", "changes": [["Value", "1k", "2k"]]} for i in range(250)], "sheets": [], "board": {"changed": False}}]}
with tempfile.TemporaryDirectory() as d:
    png = f"{d}/p0-board.png"; open(png, "wb").write(b"\x89PNG\r\n\x1a\nfake")
    html = print_html(pdata, [{"project": 0, "title": "A&B: board", "path": png}], "<script>x</script> & y", "ann", "2026-10-12 10:00 UTC")
assert "<script" not in html.replace("&lt;script&gt;", "") and "&lt;script&gt;x&lt;/script&gt; &amp; y" in html and "A&amp;B" in html
assert "data:image/png;base64," in html and "Clearance &lt;1mm&gt;" in html and "aaaaaaa → bbbbbbb" in html
assert "http-equiv='Content-Security-Policy'" in html
assert "default-src 'none'; img-src data:; style-src 'unsafe-inline'" in html
assert html.count("pictures unavailable") == 0
missing = print_html(pdata, [], "", "", "now")
assert missing.count("pictures unavailable") == 1
print("ok print page escapes everything")
assert html.count("<tr class=\"change\">") == 200 and "50 more changes are in the interactive report" in html
print("ok long change lists are capped")
assert "pictures unavailable" in print_html(pdata, [], "", "", "now")
print("ok missing screenshots are explained")

from kicad_review import cmd_pdf
import types as _types, kicad_review as kr
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d); os.makedirs("review/images")
    json.dump({**pdata, "settings": {"pdf": {"enabled": True}}, "links": d2["links"], "reason": "x"}, open("review/data.json", "w"))
    seen = []
    saved = kr.subprocess.run
    kr.subprocess.run = lambda cmd, **k: seen.append(cmd) or _types.SimpleNamespace(returncode=1, stderr="chrome crashed", stdout="")
    try:
        os.environ.update(PDF_NAME="kicad-review-aaaaaaa-bbbbbbb-fail.pdf")
        with patch('sys.stdout', new_callable=io.StringIO) as warnings:
            cmd_pdf(_types.SimpleNamespace(chrome="chrome"))
        assert warnings.getvalue() == '::warning::PDF report failed: Chrome unavailable, failed or timed out\n'
    finally:
        kr.subprocess.run = saved; os.environ.pop("PDF_NAME")
    assert os.path.exists("review/print.html") and seen and "--print-to-pdf=" + os.path.abspath("review/kicad-review-aaaaaaa-bbbbbbb-fail.pdf") in seen[0]
    os.chdir(_cwd)
print("ok chrome failure does not fail the review")

# Disabled PDF is byte-identical to settings predating PDF, including summaries.
with tempfile.TemporaryDirectory() as d:
    old_cwd = os.getcwd()
    try:
        os.chdir(d)
        os.makedirs("review")
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "a" * 40, "head": "b" * 40, "reason": "test", "projects": []}))
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        before = copy.deepcopy(settings)
        before.pop("pdf")
        outputs = []
        for current in (before, settings):
            with patch("kicad_review.load_settings", return_value=current):
                kr.cmd_report(None)
            outputs.append(tuple(pathlib.Path("review/" + name).read_bytes() for name in ("kicad-review.html", "data.json")))
        assert outputs[0] == outputs[1]
        assert not os.path.exists("review/print.html")
        with patch("kicad_review.subprocess.run", side_effect=AssertionError("Chrome must not run")):
            cmd_pdf(_types.SimpleNamespace(chrome="chrome"))
        assert not os.path.exists("review/print.html")
    finally:
        os.chdir(old_cwd)
print("ok PDF disabled report byte identity and no files")

for invalid in ("enabled = 1", "enabled = 'yes'"):
    with tempfile.TemporaryDirectory() as d:
        pathlib.Path(d, "kicad-review.toml").write_text("[pdf]\n" + invalid)
        try:
            load_settings((d,))
            raise AssertionError("invalid PDF setting accepted")
        except SystemExit as error:
            assert "pdf.enabled must be true or false" in str(error)
print("ok PDF settings validate booleans")

with tempfile.TemporaryDirectory() as d:
    old_cwd = os.getcwd()
    try:
        os.chdir(d)
        os.makedirs("review")
        pathlib.Path("review/data.json").write_text(json.dumps({**pdata, "settings": {"pdf": {"enabled": True}}}))
        with patch.dict(os.environ, {"PDF_NAME": "kicad-review-aaaaaaa-bbbbbbb-fail.pdf"}):
            for failure in (kr.subprocess.TimeoutExpired("chrome", 120), FileNotFoundError("chrome")):
                with patch("kicad_review.subprocess.run", side_effect=failure), patch('sys.stdout', new_callable=io.StringIO) as warnings:
                    cmd_pdf(_types.SimpleNamespace(chrome="chrome"))
                assert warnings.getvalue() == '::warning::PDF report failed: Chrome unavailable, failed or timed out\n'
                assert not pathlib.Path("review/kicad-review-aaaaaaa-bbbbbbb-fail.pdf").exists()
    finally:
        os.chdir(old_cwd)
print("ok PDF timeout and launch failure are nonfatal")



# Interface checks: netlist parsing and helpers.
from kicad_review import parse_netlist, ohms, short, is_ground, is_power, matches
def netlist(comps, nets):
    c = "".join(f'(comp (ref "{r}") (value "{v}") (footprint "{fp}") (libsource (lib "{lib.split(":")[0]}") (part "{lib.split(":")[1]}") (description "")))'
                for r, (v, fp, lib) in comps.items())
    n = "".join(f'(net (code "{i}") (name "{name}") ' + "".join(f'(node (ref "{r}") (pin "{p}") (pinfunction "{f}") (pintype "{t}"))' for r, p, f, t in nodes) + ")"
                for i, (name, nodes) in enumerate(nets.items(), 1))
    return f'(export (version "E") (components {c}) (nets {n}))'
comps, nets = parse_netlist(netlist({"R1": ("4k7", "R_0402", "Device:R")}, {"/MCU/SDA": [("R1", "1", "", "passive"), ("U1", "5", "PB7/I2C1_SDA", "bidirectional")]}))
assert comps["R1"] == {"value": "4k7", "footprint": "R_0402", "lib": "Device:R", "description": ""}
assert nets["/MCU/SDA"][1] == {"ref": "U1", "pin": "5", "function": "PB7/I2C1_SDA", "type": "bidirectional"}
for v, want in (("4k7", 4700), ("4.7k", 4700), ("4K7 1%", 4700), ("120R", 120), ("120", 120), ("5k1", 5100), ("1M", 1e6), ("10k Ω", 10000)):
    assert ohms(v) == want, (v, ohms(v))
assert ohms("DNP") is None and ohms("100n") is None
print("ok resistor values parse")
assert short("/MCU/SDA") == "SDA" and short("Net-(U1-SDA)") == "U1-SDA"
assert matches("SDA", ["SDA"]) and matches("I2C1_SDA", ["SDA"]) and not matches("SDAX", ["SDA"]) and matches("PB7/I2C1_SDA", ["SDA"])
assert all(is_power(n, []) for n in ("+3V3", "VDD_3V3", "3.3V", "VBUS", "+5V", "GND")) and is_ground("AGND") and not is_power("/SDA", [])
assert is_power("/RAIL", [{"type": "power_out"}])
print("ok power nets are recognised")

from kicad_review import interface_findings, INTERFACE_PATTERNS
W = lambda ref: ({"sheet": "/"}, [1.0, 2.0])
types = lambda vs: sorted((v["type"], v["severity"]) for v in vs)
# UART TX to TX
c, n = parse_netlist(netlist({"U1": ("MCU", "", "MCU:M"), "U2": ("GPS", "", "GPS:G")},
    {"/TX": [("U1", "1", "USART1_TX", "output"), ("U2", "3", "TXD", "output")]}))
vs, cov = interface_findings(c, n, INTERFACE_PATTERNS, W)
assert types(vs) == [("uart_tx_to_tx", "error")] and "U1 pin 1 (USART1_TX)" in vs[0]["items"] and vs[0]["where"] == {"sheet": "/"}, vs
# I2C: none, then two pull-ups
i2c = lambda pullups: netlist({"U1": ("MCU", "", "MCU:M"), **{f"R{i}": ("4k7", "", "Device:R") for i in range(1, pullups + 1)}},
    {"/MCU/SDA": [("U1", "5", "SDA", "bidirectional")] + [(f"R{i}", "1", "", "passive") for i in range(1, pullups + 1)],
     "/MCU/SCL": [("U1", "6", "SCL", "bidirectional")], "+3V3": [(f"R{i}", "2", "", "passive") for i in range(1, pullups + 1)]})
assert types(interface_findings(*parse_netlist(i2c(0)), INTERFACE_PATTERNS, W)[0]) == [("i2c_no_pullup", "error"), ("i2c_no_pullup", "error")]
vs = interface_findings(*parse_netlist(i2c(2)), INTERFACE_PATTERNS, W)[0]
assert ("i2c_multiple_pullups", "warning") in types(vs) and any("2350" in v["description"] for v in vs), vs
print("ok hierarchical net names match")
# CAN termination
can = lambda r: netlist({"U3": ("TCAN", "", "If:T"), **({"R9": (r, "", "Device:R")} if r else {})},
    {"/CANH": [("U3", "7", "CANH", "bidirectional")] + ([("R9", "1", "", "passive")] if r else []), "/CANL": [("U3", "6", "CANL", "bidirectional")] + ([("R9", "2", "", "passive")] if r else [])})
assert types(interface_findings(*parse_netlist(can(None)), INTERFACE_PATTERNS, W)[0]) == [("can_no_termination", "warning")]
assert interface_findings(*parse_netlist(can("120R")), INTERFACE_PATTERNS, W)[0] == []
# USB-C CC: floating, resistor, controller
usb = lambda cc_nodes: netlist({"J1": ("USB_C_Receptacle", "USB_C", "Connector:USB_C_Receptacle"), "R1": ("5.1k", "", "Device:R"), "U9": ("TPS65987", "", "PD:T")},
    {"/CC1": [("J1", "A5", "CC1", "bidirectional")] + cc_nodes, "GND": [("R1", "2", "", "passive"), ("J1", "A1", "GND", "power_in")]})
assert types(interface_findings(*parse_netlist(usb([])), INTERFACE_PATTERNS, W)[0]) == [("usb_cc_floating", "error")]
cc_errors = lambda nodes: [v for v in interface_findings(*parse_netlist(usb(nodes)), INTERFACE_PATTERNS, W)[0] if v["type"] == "usb_cc_floating"]
assert cc_errors([("R1", "1", "", "passive")]) == [] and cc_errors([("U9", "4", "CC1", "bidirectional")]) == []
print("ok CC to a controller is fine")
# Connector ESD: J2 pin 2 unprotected, pin 3 protected by a TVS on the same net
c, n = parse_netlist(netlist({"J2": ("Conn_01x03", "", "Connector:Conn"), "D1": ("PESD5V0", "", "Diode:ESD"), "U1": ("MCU", "", "MCU:M")},
    {"GND": [("J2", "1", "", "passive")], "/SIG_A": [("J2", "2", "", "passive"), ("U1", "8", "PA0", "input")],
     "/SIG_B": [("J2", "3", "", "passive"), ("U1", "9", "PA1", "input"), ("D1", "1", "", "passive")]}))
vs, cov = interface_findings(c, n, INTERFACE_PATTERNS, W)
assert types(vs) == [("connector_no_esd", "warning")] and vs[0]["items"] == ["J2 pin 2 on /SIG_A"] and cov["protected"] == [1, 2], (vs, cov)
# Voltage domains
c, n = parse_netlist(netlist({"U1": ("MCU", "", "MCU:M"), "U2": ("SENSOR", "", "S:S")},
    {"+3V3": [("U1", "1", "VDD", "power_in")], "+5V": [("U2", "1", "VCC", "power_in")], "/INT": [("U1", "2", "PA2", "input"), ("U2", "4", "INT", "output")]}))
vs = interface_findings(c, n, INTERFACE_PATTERNS, W)[0]
assert types(vs) == [("voltage_domain", "warning")] and "+3V3" in vs[0]["description"] and "+5V" in vs[0]["description"], vs

from kicad_review import interface_check
settings = json.loads(json.dumps(DEFAULT_SETTINGS)); settings["checks"]["interfaces"] = "required"
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    for s in ("base", "head"):
        os.makedirs(f"review/p/{s}")
        open(f"review/p/{s}/netlist.net", "w").write(netlist({"R1": ("10k", "", "Device:R")}, {"GND": [("R1", "1", "", "passive")]}))
    c = interface_check({"dir": "p", "name": "b"}, settings, {"base": {}, "head": {}}, "review/p")
    os.chdir(_cwd)
assert c["name"] == "interfaces" and c["status"] == "pass" and c["coverage"]["detected"] == {} and c["coverage"]["protected"] == [0, 0], c
print("ok no interfaces is reported, not hidden")
assert DEFAULT_SETTINGS["checks"]["interfaces"] == "off" and interface_check({"dir": "p", "name": "b"}, json.loads(json.dumps(DEFAULT_SETTINGS)), {}, "x") is None
_src = open("kicad_review.py", encoding="utf-8").read()
assert 'report_settings["checks"] = {k: v for k, v in settings["checks"].items() if k != "interfaces"}' in _src and 'report_settings.pop("interfaces", None)' in _src
print("ok interfaces settings stay out of opted-out reports")

# Final-review regressions run together so every pre-fix failure is visible.
import unittest
class FinalReviewTests(unittest.TestCase):
    def findings(self, c, n):
        return interface_findings(*parse_netlist(netlist(c, n)), INTERFACE_PATTERNS, W)

    def test_uart_transceivers_and_pin_types(self):
        for value in ("TJA1050 CAN", "RS485", "RS-485", "LIN", "transceiver"):
            with self.subTest(value=value):
                vs, _ = self.findings({"U1": ("MCU", "", "MCU:M"), "U2": (value, "", "If:T")},
                    {"TX": [("U1", "1", "CAN1_TX", "output"), ("U2", "1", "TXD", "output")]})
                self.assertEqual(vs, [])
        for pin_type in ("input", "passive"):
            with self.subTest(pin_type=pin_type):
                vs, _ = self.findings({}, {"TX": [("U1", "1", "TX", "output"), ("U2", "1", "TXD", pin_type)]})
                self.assertEqual(vs, [])
        vs, _ = self.findings({}, {"TX": [("U1", "1", "TX", "output"), ("U2", "1", "TXD", "output"), ("U3", "1", "CAN_H", "input")]})
        self.assertEqual(vs, [])

    def test_i2c_series(self):
        for resistance, pullup, errors in (("33R", True, 0), ("4.7k", False, 2), ("1k", True, 1)):
            with self.subTest(resistance=resistance, pullup=pullup):
                c = {"R1": (resistance, "", "Device:R"), "R2": ("4k7", "", "Device:R")}
                n = {"SDA": [("R1", "1", "", "passive")], "IC_SDA": [("R1", "2", "", "passive"), ("U1", "1", "SDA", "bidirectional")]}
                if pullup:
                    n["SDA"].append(("R2", "1", "", "passive"))
                    n["+3V3"] = [("R2", "2", "", "passive")]
                vs, _ = self.findings(c, n)
                self.assertEqual(sum(v["type"] == "i2c_no_pullup" for v in vs), errors)

    def test_jumper(self):
        vs, cov = self.findings({"JP1": ("USB_C", "USB_C", "Connector:USB_C")},
            {"CC1": [("JP1", "1", "CC1", "passive"), ("U1", "1", "", "input")]})
        self.assertEqual(vs, [])
        self.assertEqual(cov["protected"], [0, 0])
        self.assertNotIn("USB-C", cov["detected"])

    def test_patterns_extend(self):
        settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        settings["checks"]["interfaces"] = "required"
        settings["interfaces"] = {"uart_tx": ["SEND"]}
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(f"{d}/head")
            with open(f"{d}/head/netlist.net", "w") as f:
                f.write(netlist({}, {"TX": [("U1", "1", "TX", "output"), ("U2", "1", "SEND", "output")]}))
            result = interface_check({}, settings, {}, d)
        self.assertIn(("uart_tx_to_tx", "error"), types(result["violations"]))

    def test_ohms(self):
        for value, expected in (("1m", .001), ("1M", 1e6), ("2.2k 0402", 2200), ("1" * 33, None), ("100n", None)):
            with self.subTest(value=value):
                self.assertEqual(ohms(value), expected)

    def test_arrays_ignored(self):
        vs, _ = self.findings({"RN1": ("4k7", "", "Device:R")}, {"SDA": [("U1", "1", "SDA", "bidirectional"), ("RN1", "1", "", "passive")], "+3V3": [("RN1", "2", "", "passive")]})
        self.assertIn(("i2c_no_pullup", "error"), types(vs))

    def test_cc_tvs(self):
        vs, _ = self.findings({"J1": ("USB_C", "USB_C", "Connector:USB_C"), "D1": ("TVS", "", "Diode:ESD")},
            {"CC1": [("J1", "1", "CC1", "passive"), ("D1", "1", "", "passive")]})
        self.assertIn(("usb_cc_floating", "error"), types(vs))

    def test_rails(self):
        for name in ("P3V3", "P5V", "3V3A_SENSOR", "3V3_A"):
            with self.subTest(name=name):
                self.assertTrue(is_power(name, []))

    def test_unused_rx_removed(self):
        self.assertNotIn("uart_rx", INTERFACE_PATTERNS)

    def test_coverage_units(self):
        _, cov = self.findings({}, {"SDA": [("U1", "1", "SDA", "bidirectional")], "SCK": []})
        self.assertEqual(cov["detected"], {"I2C nets": 1})
        self.assertEqual(cov["protected"], [0, 0])

_result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(FinalReviewTests))
assert _result.wasSuccessful(), "final-review regressions failed"
# Release readiness: setting and export in render.
from kicad_review import CHECK_NAMES, cmd_render
import kicad_review as kr
assert CHECK_NAMES["release"] == "Release package" and DEFAULT_SETTINGS["checks"]["release"] == "off"
calls = []
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    os.makedirs("review"); os.makedirs("base/p"); os.makedirs("head/p")
    for s in ("base", "head"): open(f"{s}/p/b.kicad_pro", "w").write("{}")
    json.dump({"projects": [{"dir": "p", "name": "b", "status": "modified"}]}, open("review/detect.json", "w"))
    saved = (kr.render_side, kr.release_project)
    kr.render_side = lambda *a, **kw: None
    kr.release_project = lambda pro, tag, s, out, label: calls.append((pro, tag, out, label)) or []
    try:
        cmd_render(None); assert calls == []            # off by default
        open("base/kicad-review.toml", "w").write('[checks]\nrelease = "informational"\n')
        cmd_render(None)
    finally:
        kr.render_side, kr.release_project = saved
    os.chdir(_cwd)
assert calls == [("base/p/b.kicad_pro", "review", "review/p/base/fab", "b"), ("head/p/b.kicad_pro", "review", "review/p/head/fab", "b")], calls
print("ok release export in render")
assert 'report_settings["checks"] = {k: v for k, v in report_settings["checks"].items() if k != "release"}' in open("kicad_review.py", encoding="utf-8").read()
print("ok release setting stays out of opted-out reports")

from kicad_review import release_findings, package_summary
import zipfile as zf
def fab(d, files, pos_rows, bom_rows, preset="jlcpcb"):
    os.makedirs(d, exist_ok=True)
    with zf.ZipFile(f"{d}/b-review-{preset}-gerbers.zip", "w") as z:
        for name, body in files.items(): z.writestr(name, body)
    with open(f"{d}/b-review-{preset}-positions.csv", "w") as fh:
        fh.write("Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\n" + "".join(f"{r},x,y,0,0,0,Top\n" for r in pos_rows))
    part = "LCSC Part #" if preset == "jlcpcb" else "Mfg Part #"
    with open(f"{d}/b-review-{preset}-bom.csv", "w") as fh:
        fh.write(f"Comment,Designator,Footprint,{part}\n" + "".join(f'x,"{refs}",y,{pn}\n' for refs, pn in bom_rows))
def pcb(d, layers):
    open(f"{d}/b.kicad_pcb", "w").write("(kicad_pcb\n  (layers\n" + "".join(f'    (0 "{l}" signal)\n' for l in layers) + "  )\n)\n")
    return f"{d}/b.kicad_pcb"
fpd = lambda ref, side, attrs, pads="smd": {"kind": "footprint", "ref": ref, "props": {"layer": side, "attributes": attrs, "pads_kind": pads}}
G = "%FSLAX46Y46*%\nD10*\nX0Y0D03*\nM02*\n"
with tempfile.TemporaryDirectory() as d:
    full = {"b-F_Cu.gtl": G, "b-B_Cu.gbl": G, "b-F_Mask.gts": G, "b-F_Paste.gtp": G, "b-B_Mask.gbs": G, "b-F_Silkscreen.gto": G, "b-Edge_Cuts.gm1": G, "b-PTH.drl": "M48\n"}
    objs = {"1": fpd("R1", "F.Cu", "smd"), "2": {"kind": "via", "ref": "GND", "props": {}}}
    fab(d, full, ["R1"], [("R1", "C1")])
    assert release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "F.Mask", "Edge.Cuts"]), objs) == []
    s = package_summary(d)
    assert s["sha256"] and len(s["files"]) == 3 and all(f["bytes"] > 0 for f in s["files"]), s
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if k != "b-PTH.drl"}, ["R1"], [("R1", "C1")])
    v = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    assert [x["type"] for x in v] == ["missing_drill"] and v[0]["severity"] == "error" and v[0]["where"] == {"board": True}, v
print("ok vias require a drill file")
with tempfile.TemporaryDirectory() as d:
    fab(d, full, ["R1"], [("R1", "C1")])
    v = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "Edge.Cuts"]), objs)
    assert sorted(x["description"] for x in v) == ["No Gerber for copper layer In1.Cu", "No Gerber for copper layer In2.Cu"], v
print("ok inner copper layers are required")
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if "Paste" not in k}, [], [("J1", "C9")])
    tht = {"1": fpd("J1", "F.Cu", "through_hole", "thru_hole")}
    assert release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), tht) == []
print("ok THT-only board needs no paste or position")
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if not k.endswith(".drl")}, ["R1", "R2"], [("R1", "")], preset="pcbway")
    v = release_findings(d, "b", "pcbway", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    types = sorted(x["type"] for x in v)
    assert types == ["bom_missing_part_number", "missing_drill", "position_not_in_bom"], types
print("ok pcbway drill detected")
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if not k.endswith(".drl")}, [], [("J1", "C9")])
    p = pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"])
    open(p, "a").write('(footprint "J" (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.6)))\n')
    v = release_findings(d, "b", "jlcpcb", p, {"1": {"kind": "footprint", "ref": "J1", "props": {"layer": "F.Cu", "attributes": "through_hole"}}})
    assert [x["type"] for x in v] == ["missing_drill"], v
print("ok plated pads in the board file require a drill file")

_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    settings = json.loads(json.dumps(DEFAULT_SETTINGS)); settings["checks"].update(erc="off", drc="off", parity="off", bom="off", release="informational")
    os.makedirs("head/p")   # a project folder with no board (and no schematic, so the other checks read nothing)
    c = project_checks({"dir": "p", "name": "b"}, settings, {"base": {}, "head": {}})
    os.chdir(_cwd)
assert [(x["name"], x["status"], x.get("reason")) for x in c] == [("release", "not_run", "no board")], c
print("ok no board is not run")

# Tagged releases also publish SHA256SUMS for every release asset.
import hashlib
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    os.makedirs("repo/B"); open("repo/B/B.kicad_pro", "w").write("{}")
    def fake(pro, tag, s, out, label):
        os.makedirs(out, exist_ok=True); open(f"{out}/{label}-{tag}-gerbers.zip", "wb").write(b"zip"); return [f"{out}/{label}-{tag}-gerbers.zip"]
    saved = kr.release_project; kr.release_project = fake
    try:
        with patch("sys.stdout", new_callable=io.StringIO):
            kr.cmd_release(type("A", (), {"tag": "v1"}))
        sums = open("release/SHA256SUMS").read()
    finally:
        kr.release_project = saved; os.chdir(_cwd)
assert sums == f"{hashlib.sha256(b'zip').hexdigest()}  B-v1-gerbers.zip\n", sums
print("ok release SHA256SUMS")

# Live-test fixes: paste needs real SMD pads; BOM designator ranges expand; release findings keep a stable identity.
from kicad_review import bom_refs_expand
assert bom_refs_expand("C1,C3-C5, R10") == {"C1", "C3", "C4", "C5", "R10"}
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if "Paste" not in k and "B_Mask" not in k}, ["A1"], [("A1", "C5")])
    p = pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"])
    open(p, "a").write('(footprint "Sensor:TO39" (layer "B.Cu") (attr smd) (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.6) (layers "*.Cu" "*.Mask")))\n')
    v = release_findings(d, "b", "jlcpcb", p, {"1": {"kind": "footprint", "ref": "A1", "props": {"layer": "B.Cu", "attributes": "smd"}}})
    assert not any("Paste" in x["description"] for x in v), v
with tempfile.TemporaryDirectory() as d:
    fab(d, full, ["C3", "C4"], [("C1,C3-C5", "C1")])
    assert [x["type"] for x in release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)] == []
    fab(d, full, ["R1"], [("R1", ""), ("R2", "")])
    a = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    fab(d, full, ["R1"], [("R1,R2", "")])
    b = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    assert [x["key"] for x in a] == [x["key"] for x in b], (a, b)
print("ok release findings: smd pads, ranges, stable keys")

# Final-review fixes: NPTH-only drill, locked footprints, renamed inner layers, missing Designator, empty SHA256SUMS.
from kicad_review import smd_pad_sides
assert smd_pad_sides('(footprint "R" locked (layer "B.Cu") (pad "1" smd rect))') == {"B"}
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if not k.endswith(".drl")}, [], [("J1", "C9")])
    p = pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]); open(p, "a").write('(footprint "H" (pad "" np_thru_hole circle (at 0 0) (size 3 3) (drill 3)))\n')
    assert [x["type"] for x in release_findings(d, "b", "jlcpcb", p, {})] == ["missing_drill"]
with tempfile.TemporaryDirectory() as d:
    fab(d, {**full, "b-GND_PLANE.g2": G}, ["R1"], [("R1", "C1")])
    p = f"{d}/b.kicad_pcb"
    open(p, "w").write('(kicad_pcb\n  (layers\n    (0 "F.Cu" signal)\n    (1 "In1.Cu" signal "GND_PLANE")\n    (2 "B.Cu" signal)\n    (25 "Edge.Cuts" user)\n  )\n)\n')
    assert not any("In1.Cu" in x["description"] for x in release_findings(d, "b", "jlcpcb", p, objs))
with tempfile.TemporaryDirectory() as d:
    fab(d, full, ["R1"], [("R1", "C1")])
    with open(f"{d}/b-review-jlcpcb-bom.csv", "w") as fh: fh.write("Comment,Footprint,LCSC Part #\nx,y,\n")
    release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)   # no Designator column: no KeyError
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d); os.makedirs("repo")
    try:
        with patch("sys.stdout", new_callable=io.StringIO):
            kr.cmd_release(type("A", (), {"tag": "v1"}))
        assert not os.path.exists("release/SHA256SUMS")
    finally:
        os.chdir(_cwd)
print("ok release final-review fixes")
# BOM readiness: per-field coverage over BOM parts; placeholders count as missing; multi-unit parts count once.
from kicad_review import bom_coverage, bom_parts, present
symp = lambda ref, **p: {"kind": "symbol", "ref": ref, "where": {"sheet": "/"}, "pos": [0, 0], "props": {"in_bom": "yes", **p}}
objs = {"a": symp("U1", Value="STM32", Footprint="QFN", LCSC="C123", MPN="STM32G0", Manufacturer="ST", Datasheet="https://x/ds.pdf"),
        "b": symp("U1 unit 2", Value="STM32", Footprint="QFN"),
        "c": symp("R1", Value="10k", Footprint="0402", LCSC="C25744", MPN="TBD"),
        "d": symp("J1", Value="USB-C", Footprint="USB", Datasheet="~"),
        "e": symp("R2", Value="1k", Footprint="0402", dnp="yes"),
        "f": symp("TP1", Value="TP", Footprint="TP", in_bom="no")}
assert set(bom_parts(objs)) == {"U1", "R1", "J1"}
assert not present("TBD") and not present("~") and not present("  ") and present("10k")
s = json.loads(json.dumps(DEFAULT_SETTINGS))
cov = bom_coverage(objs, s)
assert cov["Value"] == [3, 3] and cov["MPN"] == [1, 3] and cov["LCSC"] == [2, 3] and cov["Manufacturer"] == [1, 3]
assert cov["Datasheet (critical)"] == [1, 2]   # U1 has one, J1 has "~"
assert cov["Order ready"] == [2, 3]            # jlcpcb preset: Value, Footprint, LCSC
s["fabrication"]["preset"] = "pcbway"
assert bom_coverage(objs, s)["Order ready"] == [1, 3]   # pcbway: MPN; R1's "TBD" is a placeholder
s["bom"]["order_ready_fields"] = ["Value"]
assert bom_coverage(objs, s)["Order ready"] == [3, 3]
print("ok placeholders count as missing")
print("ok multi-unit symbol counts once")

# BOM readiness settings stay out of opted-out reports.
src = open("kicad_review.py", encoding="utf-8").read()
assert 'report_settings["bom"] = {"required_fields": settings["bom"]["required_fields"]}' in src
s = json.loads(json.dumps(DEFAULT_SETTINGS))
assert s["parts"]["enabled"] is False and set(s["bom"]) == {"required_fields", "critical_prefixes", "order_ready_fields"}
print("ok bom readiness settings opt-in")

from kicad_review import field_changes
b = {"1": symp("R1", Value="10k", Footprint="0402", MPN="RC0402-10K"), "2": symp("R2", Value="10k", Footprint="0402", MPN="RC0402-10K"),
     "3": symp("U1", Value="LDO", Footprint="SOT23", Datasheet="https://a")}
h = {"1": symp("R1", Value="10k", Footprint="0402", MPN="ERJ-2RKF1002"), "2": symp("R2", Value="10k", Footprint="0402", MPN="RC0402-10K"),
     "3": symp("U1", Value="LDO", Footprint="SOT23", Datasheet="https://b", Manufacturer="TI"), "4": symp("C1", Value="1u", Footprint="0402")}
assert field_changes(b, h) == [
    {"refs": ["R1"], "field": "MPN", "before": "RC0402-10K", "after": "ERJ-2RKF1002"},
    {"refs": ["U1"], "field": "Manufacturer", "before": None, "after": "TI"},
    {"refs": ["U1"], "field": "Datasheet", "before": "https://a", "after": "https://b"}], field_changes(b, h)
h["2"] = symp("R2", Value="10k", Footprint="0402", MPN="ERJ-2RKF1002")
assert field_changes(b, h)[0]["refs"] == ["R1", "R2"]
print("ok MPN-only edit shows per reference")

from kicad_review import dnp_mismatches
L = parts_lines({"1": symp("R1", Value="TBD", Footprint="0402", LCSC="C1"), "2": symp("U2", Value="LDO", Footprint="SOT23", LCSC="C9", MPN="AP2112"),
                 "3": symp("U3", Value="LDO", Footprint="SOT89", LCSC="C10", MPN="AP2112")})
probs = {l["refs"][0]: l["problems"] for l in L}
assert "placeholder" in probs["R1"] and "mpn_footprint_conflict" in probs["U2"] and "mpn_footprint_conflict" in probs["U3"], probs
base_lines = parts_lines({"1": symp("R5", Value="1k", Footprint="0402", LCSC="C7"), "2": symp("R6", Value="2k", Footprint="0402", LCSC="C8")})
head_lines = parts_lines({"1": symp("R5", Value="1k", Footprint="0402", LCSC="C7"), "2": symp("R6", Value="2k", Footprint="0402", LCSC="C7")})
mark_new_problems(base_lines, head_lines)
r5 = next(l for l in head_lines if "R5" in l["refs"])
assert r5["new_problems"] == ["lcsc_conflict"], r5   # R5's line did not change, but its LCSC number now conflicts
print("ok problem on unchanged line is new")
fp = lambda ref, attrs: {"kind": "footprint", "ref": ref, "where": {"board": True}, "pos": [0, 0], "props": {"attributes": attrs, **({"dnp": "yes"} if "dnp" in (attrs or "") else {})}}
mis = dnp_mismatches({"s1": symp("R1", dnp="no"), "s2": symp("R2", dnp="yes"), "s3": symp("R3"), "f1": fp("R1", "smd dnp"), "f2": fp("R2", "smd dnp"), "f3": fp("R3", "smd")})
assert mis == ["R1"], mis
print("ok DNP mismatch symbol vs footprint")
pm = parts_markdown({"projects": [{"name": "X", "parts": {"lines": head_lines, "changes": [], "supplier": None, "dnp_mismatch": ["R1"],
      "coverage": {"base": {"MPN": [1, 4], "Order ready": [2, 4], "LCSC": [4, 4], "Datasheet (critical)": [0, 0]},
                   "head": {"MPN": [3, 4], "Order ready": [2, 4], "LCSC": [4, 4], "Datasheet (critical)": [0, 0]}}}}]})
assert "R5 one LCSC number on several values" in pm and "BOM coverage: order ready 2/4, MPN 3/4 (+2), LCSC 4/4" in pm and "DNP differs between schematic and board: R1" in pm, pm
print("ok bom readiness comment")

# Grouped lines: every reference's MPN and values are checked, and the comment names only the offending references.
L = parts_lines({"1": symp("R1", Value="10k", Footprint="0805", MPN="TBD"), "2": symp("R2", Value="10k", Footprint="0805", MPN="AP2112"),
                 "3": symp("R3", Value="10k", Footprint="0805"), "4": symp("U1", Value="LDO", Footprint="SOT23", MPN="AP2112")})
r = next(l for l in L if "R1" in l["refs"])
assert "placeholder" in r["problems"] and "mpn_footprint_conflict" in r["problems"], r
assert r["problem_refs"] == {"placeholder": ["R1"], "mpn_footprint_conflict": ["R2"]}, r
u = next(l for l in L if "U1" in l["refs"])
assert u["problem_refs"] == {"mpn_footprint_conflict": ["U1"]}, u
mark_new_problems([], L)
pm = parts_markdown({"projects": [{"name": "X", "parts": {"lines": L, "changes": [], "supplier": None}}]})
assert "- R1 placeholder value" in pm and "- R2 one MPN on several footprints" in pm and "R3 placeholder" not in pm and "R1, R2, R3 placeholder" not in pm, pm
print("ok grouped line problems name their references")

# A problem the named references already had in base is not new, even when another reference joins the line.
bl = parts_lines({"1": symp("R1", Value="TBD", Footprint="0402", LCSC="C1")})
hl = parts_lines({"1": symp("R1", Value="TBD", Footprint="0402", LCSC="C1"), "2": symp("R2", Value="TBD", Footprint="0402", LCSC="C1")})
mark_new_problems(bl, hl)
assert "placeholder" in hl[0]["new_problems"] and hl[0]["problem_refs"]["placeholder"] == ["R1", "R2"], hl
bl = parts_lines({"1": symp("R1", Value="10k", Footprint="0402", LCSC="C1", MPN="TBD")})
hl = parts_lines({"1": symp("R1", Value="10k", Footprint="0402", LCSC="C1", MPN="TBD"), "2": symp("R2", Value="10k", Footprint="0402", LCSC="C1")})
mark_new_problems(bl, hl)
assert "placeholder" not in hl[0]["new_problems"], hl
print("ok old problem not new when a reference joins")
# Threads: object index for anchoring. Head objects first; base-only objects keep their base position.
from kicad_review import object_index
t1_sym = lambda ref, x: {"kind": "symbol", "ref": ref, "match": ("symbol", ref, "1"), "where": {"sheet": "/sub-uuid/"},
                      "pos": [x, 1, 0], "props": {"Value": "10k"}}
t1_fpo = lambda ref, x: {"kind": "footprint", "ref": ref, "match": ("footprint", ref), "where": {"board": True},
                      "pos": [x, 2, 90], "box": [x - 1, 1, x + 1, 3], "props": {"Value": "1k", "layer": "F.Cu"}}
t1_wire = {"kind": "wire", "ref": "", "where": {"sheet": "/"}, "pos": [0, 0], "props": {}}
t1_base = {"/sub-uuid/s1": t1_sym("R1", 1), "f1": t1_fpo("R1", 1), "f2": t1_fpo("R2", 2), "/w": t1_wire}
t1_head = {"/sub-uuid/s1": t1_sym("R1", 1), "f1": t1_fpo("R1", 5), "new-f3": t1_fpo("R3", 3), "/w": t1_wire}
t1_idx = object_index(t1_base, t1_head)
t1_by = {(e["side"], e["kind"], e["ref"]): e for e in t1_idx}
assert set(t1_by) == {("head", "symbol", "R1"), ("head", "footprint", "R1"), ("head", "footprint", "R3"), ("base", "footprint", "R2")}, t1_by.keys()
assert t1_by["head", "symbol", "R1"] == {"uuid": "s1", "kind": "symbol", "ref": "R1", "value": "10k", "footprint": None, "side": "head",
                                      "pos": [1, 1, 0], "box": None, "sheet": "/sub-uuid/"}, t1_by["head", "symbol", "R1"]
assert t1_by["head", "footprint", "R1"]["pos_before"] == [1, 2, 90] and t1_by["head", "footprint", "R1"]["layer"] == "F.Cu"
assert t1_by["head", "footprint", "R3"]["added"] is True and "pos_before" not in t1_by["head", "footprint", "R3"]
assert t1_by["base", "footprint", "R2"]["uuid"] == "f2" and "sheet" not in t1_by["base", "footprint", "R2"]
assert [e["side"] for e in t1_idx] == ["head", "head", "head", "base"]
# Regenerated UUID: matched by reference, so not reported as added.
assert "added" not in object_index({"/sub-uuid/s1": t1_sym("R1", 1)}, {"/sub-uuid/other": t1_sym("R1", 1)})[0]
print("ok threads object index")

# Exact UUID matches take priority over reference matches in either head order.
for t1_head in ({"X": t1_sym("R2", 5), "Y": t1_sym("R1", 1)},
                {"Y": t1_sym("R1", 1), "X": t1_sym("R2", 5)}):
    t1_idx = object_index({"X": t1_sym("R1", 1)}, t1_head)
    t1_by = {e["uuid"]: e for e in t1_idx}
    assert len(t1_idx) == 2 and all(e["side"] == "head" for e in t1_idx), t1_idx
    assert "added" not in t1_by["X"] and t1_by["X"]["pos_before"] == [1, 1, 0], t1_idx
    assert t1_by["Y"]["added"] is True and "pos_before" not in t1_by["Y"], t1_idx
print("ok threads object index exact-key priority")

# Duplicate unannotated references pair one-to-one in base order.
t1_idx = object_index({"a": t1_sym("R?", 1), "b": t1_sym("R?", 2)},
                      {"c": t1_sym("R?", 3), "d": t1_sym("R?", 4)})
assert len(t1_idx) == 2 and all(e["side"] == "head" and "added" not in e for e in t1_idx), t1_idx
assert [(e["uuid"], e["pos_before"]) for e in t1_idx] == [("c", [1, 1, 0]), ("d", [2, 1, 0])], t1_idx
print("ok threads object index duplicate matches")

_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d); os.makedirs("base")
        with open("base/kicad-review.toml", "w") as fh: fh.write('[threads]\nenabled = "yes"\n')
        try:
            load_settings(); raise AssertionError("threads.enabled must be validated")
        except SystemExit as e:
            assert "threads.enabled must be true or false" in str(e)
        with open("base/kicad-review.toml", "w") as fh: fh.write('[threads]\nenabled = true\n')
        assert load_settings()["threads"] == {"enabled": True, "block_merge": False}
    finally:
        os.chdir(_cwd)
assert DEFAULT_SETTINGS["threads"] == {"enabled": False, "block_merge": False}
print("ok threads settings")

# Threads: anchors in comment bodies and the summary line.
import base64 as _b64, json as _json
from kicad_review import thread_anchor, thread_counts
enc = lambda a: "<!-- kicad-review-anchor " + _b64.urlsafe_b64encode(_json.dumps(a).encode()).decode().rstrip("=") + " -->"
a_block = {"v": 1, "severity": "blocking", "target": "object", "ref": "R1--> x"}
assert thread_anchor("📍 R1\n\ntext\n\n" + enc(a_block)) == a_block
assert thread_anchor("no anchor") is None and thread_anchor(None) is None
assert thread_anchor("<!-- kicad-review-anchor !!!notbase64 -->") is None
assert thread_anchor("<!-- kicad-review-anchor abc -->") is None
assert thread_anchor(enc([1])) is None
assert thread_anchor("<!-- kicad-review-anchor " + _b64.urlsafe_b64encode(b'{"v":2}').decode().rstrip("=") + " -->") is None
a_other = {**a_block, "ref": "R99"}
assert thread_anchor("mine " + enc(a_other) + "\n\nstill mine\n\n" + enc(a_block)) == a_block
assert thread_anchor(enc(a_block) + "\ntext after marker") is None
assert thread_anchor(enc(a_block) + "\n  \t") == a_block
for suffix in ["﻿", "\x85", "\x1c", "\x1d", "\x1e", "\x1f"]:
    assert thread_anchor(enc(a_block) + suffix) is None, repr(suffix)
print("ok threads anchor decode failures and trailing-only markers")
gql = {"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": [
    {"isResolved": False, "comments": {"nodes": [{"body": enc({"v": 1, "severity": "blocking"})}]}},
    {"isResolved": False, "comments": {"nodes": [{"body": enc({"v": 1, "severity": "comment"})}]}},
    {"isResolved": True, "comments": {"nodes": [{"body": enc({"v": 1, "severity": "blocking"})}]}},
    {"isResolved": False, "comments": {"nodes": [{"body": "an ordinary code review comment"}]}},
    {"isResolved": False, "comments": {"nodes": []}}]}}}}}
assert thread_counts(gql) == {"open": 2, "blocking": 1, "resolved": 1}, thread_counts(gql)
assert thread_counts({"errors": [{"message": "x"}]}) == {"open": 0, "blocking": 0, "resolved": 0}
tdata = {**d2, "projects": [{"name": "T", "dir": "", "status": "modified", "changes": [], "checks": []}]}
body = comment_markdown(tdata, [], "", "77", site="https://site.example",
                        threads={"open": 2, "blocking": 1, "resolved": 1})
assert "Threads: 2 open (1 blocking), 1 resolved." in body.splitlines(), body
assert body.count("https://site.example/r/o/r/a/77") == 1, body
assert "Threads:" not in comment_markdown(tdata, [], "")
print("ok threads summary")

# Threads: cmd_summary reads counts only when opted in and warns on malformed JSON.
from types import SimpleNamespace
from kicad_review import cmd_summary
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        os.makedirs("review")
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": os.devnull, "GITHUB_OUTPUT": os.devnull}):
            for settings, contents, expected in (
                ({"threads": {"enabled": True}}, _json.dumps(gql), "Threads: 2 open (1 blocking), 1 resolved."),
                ({"threads": {"enabled": True}}, "not json", None),
                ({}, _json.dumps(gql), None),
            ):
                if os.path.exists("review/comment.md"):
                    os.remove("review/comment.md")
                with open("review/data.json", "w", encoding="utf-8") as fh:
                    _json.dump({**tdata, "settings": settings}, fh)
                with open("review/threads.json", "w", encoding="utf-8") as fh:
                    fh.write(contents)
                with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                    cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
                with open("review/comment.md", encoding="utf-8") as fh:
                    comment = fh.read()
                if expected:
                    assert expected in comment, comment
                else:
                    assert "Threads:" not in comment, comment
                if contents == "not json":
                    assert "::warning::review/threads.json is not JSON" in stdout.getvalue(), stdout.getvalue()
    finally:
        os.chdir(_cwd)
print("ok threads cmd_summary")

# History: strict rows, newest last, and damaged blocks start fresh.
from kicad_review import log_row, merge_log, extract_log, LOG_START, LOG_END, CHECK_NAMES, MARKER
ck2 = lambda name, title, e, ne: {"name": name, "title": title, "level": "required", "status": "fail" if ne else "pass", "errors": e,
                               "new_errors": ne, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}
ld = {**d2, "head": "abc1234def", "settings": {}, "links": {**d2["links"], "run": "https://github.com/o/r/actions/runs/123"},
      "projects": [{"name": "A", "dir": "", "status": "modified", "changes": [], "checks": [ck2("erc", "ERC", 0, 0), ck2("drc", "DRC", 2, 1)]}]}
row = log_row(ld, "2026-10-12 10:04")
assert row == "| [2026-10-12 10:04](https://github.com/o/r/actions/runs/123) | `abc1234` | ❌ fail | ERC 0 (0) · DRC 2 (1) |", row
block = merge_log([], row)
assert block.startswith(LOG_START) and block.rstrip().endswith(LOG_END) and extract_log(block) == [row]
rows = [row.replace("runs/123", f"runs/{i}") for i in range(60)]
merged = extract_log(merge_log(rows, row))
assert len(merged) == 50 and merged[-1] == row and merged[0] == rows[11]
assert extract_log(merge_log(rows, row, keep=0)) == []
print("ok log keeps the newest 50")
assert extract_log("no markers") == [] and extract_log(LOG_START + "\n| broken") == []
assert extract_log(LOG_END + "\n" + LOG_START + "\n" + row) == []
assert extract_log(merge_log(["| junk | | | |", row.replace("`abc1234`", "`bad`")], row)) == [row]
assert log_row({**ld, "links": {}}, "2026-10-12 10:04") == ""
assert log_row(ld, "bad timestamp") == ""
pipe_data = {**ld, "projects": [ld["projects"][0], {**ld["projects"][0], "name": "B|C\nD"}]}
pipe_row = log_row(pipe_data, "2026-10-12 10:04")
assert "B\\|C D" in pipe_row and extract_log(merge_log([], pipe_row)) == [pipe_row]
print("ok broken log starts fresh and strict row contract")

# A real four-project/four-check log survives body truncation within GitHub's limit.
large = {**ld, "projects": [{**ld["projects"][0], "name": f"Project {i}",
         "checks": [ck2(n, title, 2, 1) for n, title in list(CHECK_NAMES.items())[:4]]} for i in range(4)], "reason": "x" * 60000}
large_row = log_row(large, "2026-10-12 10:04")
large_log = "\n" + merge_log([large_row] * 49, large_row)
large_body = comment_markdown(large, [], "", log=large_log)
assert len(large_body) <= 65536 and extract_log(large_body) == [large_row] * 50
assert large_body.index("### Checks") < large_body.index(LOG_START)
capped_checks = {**large, "projects": [{**p, "name": "x" * 20000} for p in large["projects"]]}
capped_body = comment_markdown(capped_checks, [], "", log=large_log)
assert len(capped_body) <= 65536 and extract_log(capped_body) == [large_row] * 50
print("ok history counts inside comment size budget")
huge_row = row[:-2] + "x" * 70000 + " |"
huge_log = "\n" + merge_log([huge_row] * 49, row)
assert len(huge_log) <= 30000 and extract_log(huge_log) == [row]
assert len(comment_markdown(large, [], "", log=huge_log)) < 65536
raw_huge_log = block.replace(row, huge_row)
assert len(comment_markdown(large, [], "", log=raw_huge_log)) < 65536
print("ok oversized history drops oldest rows within comment budget")

# Off means identical comment, job summary, and stdout, even with an old log on disk.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        os.makedirs("review")
        pathlib.Path("review/data.json").write_text(_json.dumps(ld), encoding="utf-8")
        pathlib.Path("review/previous-log.md").write_text(block, encoding="utf-8")
        expected = comment_markdown(ld, [], "")
        assert "#### Ready to merge?" in expected
        with patch.dict(os.environ, {"SITE": "", "GITHUB_STEP_SUMMARY": "summary.md"}):
            for gate in (None, "false", "TRUE", "true"):
                os.environ.pop("HISTORY", None)
                if gate is not None:
                    os.environ["HISTORY"] = gate
                pathlib.Path("summary.md").write_bytes(b"")
                with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                    cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
                comment = pathlib.Path("review/comment.md").read_bytes()
                if gate == "true":
                    assert len(extract_log(comment.decode())) == 2
                else:
                    assert comment == expected.encode()
                    assert pathlib.Path("summary.md").read_bytes() == expected.replace(MARKER, "").encode()
                    assert stdout.getvalue() == expected + "\n"
    finally:
        os.chdir(_cwd)
print("ok history opt-out byte identity and opt-in summary")



# Inventory: footprint in the object index; emitted for inventory as well as threads.
s1 = {"kind": "symbol", "ref": "R1", "match": ("symbol", "R1", "1"), "where": {"sheet": "/"}, "pos": [1, 1, 0], "props": {"Value": "10k", "Footprint": "Resistor_SMD:R_0402"}}
f1 = {"kind": "footprint", "ref": "R1", "match": ("footprint", "R1"), "where": {"board": True}, "pos": [5, 5, 0], "box": [4, 4, 6, 6],
      "props": {"Value": "10k", "footprint": "Resistor_SMD:R_0402", "layer": "F.Cu"}}
idx = object_index({}, {"/s1": s1, "f1": f1})
assert [e["footprint"] for e in idx] == ["Resistor_SMD:R_0402", "Resistor_SMD:R_0402"], idx
assert DEFAULT_SETTINGS["inventory"] == {"enabled": False}
print("ok inventory footprint field")

# Libraries: changed symbols and footprints with pin/pad diffs.
from kicad_review import library_items, library_changes
SYM = lambda pins, extra="": ('(kicad_symbol_lib (version 20231120) (symbol "LDO" (property "Reference" "U") ' + extra
    + '(symbol "LDO_1_1" ' + "".join(f'(pin {t} line (at 0 {i} 0) (length 2.54) (name "{n}" (effects)) (number "{num}" (effects)))' for i, (num, n, t) in enumerate(pins) if num != "4")
    + ') (symbol "LDO_2_1" ' + "".join(f'(pin {t} line (at 5 {i} 0) (length 2.54) (name "{n}" (effects)) (number "{num}" (effects)))' for i, (num, n, t) in enumerate(pins) if num == "4") + ')))')
FP = lambda pads, model="a.step": ('(footprint "SOT23" (layer "F.Cu") (uuid "11111111-0000-0000-0000-000000000000") '
    + "".join(f'(pad "{n}" smd rect (at {x} 0) (size 0.6 1) (layers "F.Cu") (uuid "{n}{n}"))' for n, x in pads) + f'(model "{model}"))')
def lib_tree(root, sym, fp, extra_fp=None):
    os.makedirs(f"{root}/Parts.pretty", exist_ok=True)
    open(f"{root}/Parts.kicad_sym", "w").write(sym)
    open(f"{root}/Parts.pretty/SOT23.kicad_mod", "w").write(fp)
    if extra_fp: open(f"{root}/Parts.pretty/{extra_fp[0]}.kicad_mod", "w").write(extra_fp[1].replace('"SOT23"', f'"{extra_fp[0]}"'))
with tempfile.TemporaryDirectory() as d:
    lib_tree(f"{d}/b", SYM([("1", "IN", "power_in"), ("2", "GND", "power_in"), ("3", "OUT", "power_out"), ("4", "EN", "input")]), FP([("1", 0), ("2", 1), ("3", 2)]))
    lib_tree(f"{d}/h", SYM([("1", "IN", "power_in"), ("2", "GND", "power_in"), ("3", "OUT", "power_out"), ("4", "EN", "passive")]), FP([("1", 0), ("2", 1)], model="b.step"),
             extra_fp=("SOT23-5", FP([("1", 0)])))
    items = library_items(f"{d}/b")
    assert set(items) == {("Parts", "LDO", "symbol"), ("Parts", "SOT23", "footprint")} and set(items["Parts", "LDO", "symbol"]["pins"]) == {"1", "2", "3", "4"}
    ch = {(c["kind"], c["item"]): c for c in library_changes(library_items(f"{d}/b"), library_items(f"{d}/h"))}
    assert ch["symbol", "LDO"]["status"] == "modified" and ch["symbol", "LDO"]["pins_diff"] == [{"pin": "4", "change": "type", "before": "input", "after": "passive"}], ch["symbol", "LDO"]
    print("ok multi-unit symbol pins are compared together")
    assert ch["footprint", "SOT23"]["pins_diff"] == [{"pin": "3", "change": "removed", "before": "smd rect (2, 0) 0.6×1", "after": None}]
    assert ch["footprint", "SOT23-5"]["status"] == "added"
    print("ok renamed item is removed plus added")
with tempfile.TemporaryDirectory() as d:
    lib_tree(f"{d}/b", SYM([("1", "A", "passive")]), FP([("1", 0)], model="a.step")); lib_tree(f"{d}/h", SYM([("1", "A", "passive")]), FP([("1", 0)], model="b.step"))
    ch = library_changes(library_items(f"{d}/b"), library_items(f"{d}/h"))
    assert [(c["item"], c["status"], c["pins_diff"]) for c in ch] == [("SOT23", "modified", [])], ch
print("ok non-pad edits are modified without warnings")

with tempfile.TemporaryDirectory() as d:
    lib_tree(f"{d}/b", SYM([("1", "A", "passive")]), FP([("1", 0), ("1", 1)]))
    lib_tree(f"{d}/h", SYM([("1", "A", "passive")]).replace('(length 2.54)', '(length 3)'), FP([("1", 0), ("1", 2)]))
    changed = library_changes(library_items(f"{d}/b"), library_items(f"{d}/h"))
    assert all(c["pins_diff"][0]["change"] == "geometry" for c in changed)
    os.remove(f"{d}/h/Parts.pretty/SOT23.kicad_mod")
    pathlib.Path(f"{d}/h/Parts.pretty/Renamed.kicad_mod").write_text(FP([("1", 0)]).replace('"SOT23"', '"Renamed"'))
    renamed = [c for c in library_changes(library_items(f"{d}/b"), library_items(f"{d}/h")) if c["kind"] == "footprint"]
    assert {(c["item"], c["status"]) for c in renamed} == {("SOT23", "removed"), ("Renamed", "added")}
    assert next(c for c in renamed if c["status"] == "removed")["pins_diff"][0]["change"] == "removed"
print("ok library geometry and true rename")

from kicad_review import library_report, lib_slug
objs_idx = [{"uuid": "a", "kind": "footprint", "ref": "U1", "side": "head", "lib": "Parts:SOT23"}, {"uuid": "b", "kind": "footprint", "ref": "U3", "side": "head", "lib": "Parts:SOT23"},
            {"uuid": "c", "kind": "symbol", "ref": "U1", "side": "head", "lib": "Parts:LDO"}]
changes = [{"lib": "Parts", "item": "SOT23", "kind": "footprint", "status": "modified", "file": "Parts.pretty/SOT23.kicad_mod",
            "pins_diff": [{"pin": "3", "change": "removed", "before": "smd rect (2, 0) 0.6×1", "after": None}]},
           {"lib": "Parts", "item": "LDO", "kind": "symbol", "status": "modified", "file": "Parts.kicad_sym",
            "pins_diff": [{"pin": "4", "change": "type", "before": "input", "after": "passive"}]}]
with tempfile.TemporaryDirectory() as d:
    os.makedirs(f"{d}/head/lib"); os.makedirs(f"{d}/base/lib")
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 5"><path d="M0 0L1 1"/></svg>'
    for s in ("base", "head"): open(f"{d}/{s}/lib/{lib_slug(changes[0])}.svg", "w").write(svg)
    blobs = {}
    rep = library_report(changes, objs_idx, d, blobs)
assert rep[0]["used_by"] == ["U1", "U3"] and rep[0]["warnings"] == ["⚠ pad 3 removed while U1, U3 use SOT23"] and rep[0]["svg"]["head"] in blobs and rep[0]["size"] == [10.0, 5.0], rep[0]
print("ok removed pad in use warns")
assert rep[1]["warnings"] == ["⚠ pin 4 type input → passive on LDO, used by U1"] and rep[1]["svg"] == {"base": None, "head": None} and rep[1]["note"] == "no drawing", rep[1]
print("ok missing library drawing is listed")

assert lib_slug({"kind": "symbol", "lib": "a/b", "item": "X"}) != lib_slug({"kind": "symbol", "lib": "a_b", "item": "X"})
assert "lib" not in object_index(t1_base, t1_head)[0]
with tempfile.TemporaryDirectory() as d:
    pathlib.Path(d, "kicad-review.toml").write_text('[libraries]\nenabled = true\n')
    assert load_settings((d,))["libraries"] == {"enabled": True}
    pathlib.Path(d, "kicad-review.toml").write_text('[libraries]\nenabled = "yes"\n')
    try:
        load_settings((d,))
        assert False
    except SystemExit as e:
        assert "libraries.enabled" in str(e)
print("ok library settings and safe slugs")

here = os.getcwd()
try:
    with tempfile.TemporaryDirectory() as d:
        os.chdir(d)
        lib_tree("base", SYM([("1", "IN", "input")]).replace('"LDO"', '"--output"'), FP([("1", 0), ("2", 1)]))
        lib_tree("head", SYM([("1", "IN", "passive")]).replace('"LDO"', '"--output"'), FP([("1", 0)]))
        os.makedirs("review")
        project = {"name": "X", "dir": "", "status": "modified"}
        pathlib.Path("review/detect.json").write_text(json.dumps({"projects": [project], "base": "b", "head": "h", "reason": "changed"}))
        settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.render_side"), patch("kicad_review.library_changes", side_effect=AssertionError("off parsed libraries")), patch("kicad_review.subprocess.run", side_effect=AssertionError("off exported libraries")):
            kicad_review.cmd_render(None)
        settings["libraries"]["enabled"] = True
        calls = []
        def library_export(args, **kwargs):
            calls.append(args)
            pathlib.Path(args[args.index("-o")+1], "item.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 5"><path d="M0 0L1 1"/></svg>')
            return SimpleNamespace(returncode=0)
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.render_side"), patch("kicad_review.subprocess.run", side_effect=library_export), patch("kicad_review.library_items", wraps=library_items) as parsed:
            kicad_review.cmd_render(None)
            assert parsed.call_count == 2
        assert len(calls) == 4 and all(a[:3] in (["kicad-cli", "sym", "export"], ["kicad-cli", "fp", "export"]) for a in calls)
        assert any("--symbol=--output" in a for a in calls) and any("--footprint=SOT23" in a for a in calls)
        objects = {"f1": {**t1_fpo("U1", 1), "props": {"footprint": "Parts:SOT23"}}}
        with patch("kicad_review.project_objects", return_value=objects):
            blobs = {}
            with patch("kicad_review.object_index", wraps=object_index) as indexed:
                report = build_project(project, blobs, settings)
                assert indexed.call_count == 1
            assert len(report["libraries"]) == 2 and report["objects"][0]["lib"] == "Parts:SOT23"
            assert report["libraries"][0]["used_by"] == ["U1"] and report["libraries"][0]["warnings"]
            settings["libraries"]["enabled"] = False
            settings["inventory"]["enabled"] = True
            with patch("kicad_review.library_changes", side_effect=AssertionError("off parsed libraries")):
                off = build_project(project, {}, settings)
                assert "libraries" not in off and "lib" not in off["objects"][0]
                with patch("kicad_review.object_index", return_value=object_index(objects, objects)):
                    legacy = build_project(project, {}, settings)
                assert json.dumps(off, sort_keys=True) == json.dumps(legacy, sort_keys=True)
                # Golden JSON bytes from the pre-libraries parent, with inventory enabled.
                import hashlib
                assert hashlib.sha256(json.dumps(off, sort_keys=True).encode()).hexdigest() == "b937e0cb731bbe1beced3891a85e9cfd37a8353c23eae0c84c24fc2e35809c0c"
                assert comment_markdown({**d2, "projects": [off]}, [], "") == comment_markdown({**d2, "projects": [legacy]}, [], "")
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.build_project", return_value=off):
            kicad_review.cmd_report(None)
            assert "libraries" not in json.loads(pathlib.Path("review/data.json").read_text())["settings"]
finally:
    os.chdir(here)
print("ok library exports, objects emission and off byte identity")

# Final review: precomputed item maps avoid parsing; absent/invalid SVGs cannot produce drawable views.
from kicad_review import svg_size
with patch("kicad_review.library_items", side_effect=AssertionError("parsed precomputed items")):
    assert library_changes({}, {}) == []
assert svg_size('<svg viewBox="-2e1 -3.5 1e2 5E+1"/>') == [100.0, 50.0]
with tempfile.TemporaryDirectory() as d:
    os.makedirs(f"{d}/head/lib"); os.makedirs(f"{d}/base/lib")
    path = pathlib.Path(f"{d}/head/lib/{lib_slug(changes[0])}.svg")
    for svg in ('<svg viewBox="0 0 10 5"/>', '<svg><path d="M0 0L1 1"/></svg>', '<svg viewBox="0 0 nan 5"><path d="M0 0L1 1"/></svg>'):
        path.write_text(svg)
        report = library_report(changes[:1], objs_idx, d, {})[0]
        assert report["note"] == "no drawing" and report["svg"] == {"base": None, "head": None} and "size" not in report
    path.write_text('<svg viewBox="-2e1 -3.5 1e2 5E+1"><path d="M0 0L1 1"/></svg>')
    assert library_report(changes[:1], objs_idx, d, {})[0]["size"] == [100.0, 50.0]
print("ok library final-review parsing, argv and drawing validation")

# Live PR regression fixtures: legacy module names, exported stems, and nickname fallback.
import json, os, pathlib, tempfile

_LIVE_ITEM = 'ESOP-8_L4.9-W3.9-P1.27-LS6.0-BL-EP'
def _live_tree(root, removed=False):
    folder = pathlib.Path(root, 'Libraries/footprints.pretty'); folder.mkdir(parents=True)
    pads = '(pad 1 smd rect (at -1.91 2.91 0) (size 0.60 1.20) (layers F.Cu F.Paste F.Mask))'
    if not removed:
        pads += '(pad 9 smd rect (at 0 0) (size 2.4 3.1) (layers F.Cu F.Paste F.Mask))'
    (folder / (_LIVE_ITEM + '.kicad_mod')).write_text('(module easyeda2kicad:' + _LIVE_ITEM + ' (layer F.Cu) (tedit 5DC5F6A4)' + pads + ')')
    pathlib.Path(root, 'Parts.kicad_sym').write_text('(kicad_symbol_lib (version 20231120) (symbol "Imported:LDO" (symbol "LDO_1_1" (pin input line (at 0 0 0) (length 2.54) (name "IN") (number "1")))))')

def _live_names():
    with tempfile.TemporaryDirectory() as d:
        _live_tree(d)
        items = kicad_review.library_items(d)
        assert set(items) == {('footprints', _LIVE_ITEM, 'footprint'), ('Parts', 'LDO', 'symbol')}, set(items)
        assert set(items['footprints', _LIVE_ITEM, 'footprint']['pins']) == {'1', '9'}

def _live_export():
    here = os.getcwd()
    try:
        with tempfile.TemporaryDirectory() as d:
            os.chdir(d); _live_tree('base'); _live_tree('head', removed=True)
            pathlib.Path('review').mkdir()
            pathlib.Path('review/detect.json').write_text(json.dumps({'projects': [{'dir': '', 'name': 'Thermal_Camera', 'status': 'modified'}]}))
            settings = json.loads(json.dumps(kicad_review.DEFAULT_SETTINGS)); settings['libraries']['enabled'] = True
            calls = []
            def export(args, **kwargs):
                calls.append(args)
                pathlib.Path(args[args.index('-o') + 1], 'item.svg').write_text('<svg viewBox="0 0 10 5"><path d="M0 0L1 1"/></svg>')
                return SimpleNamespace(returncode=0)
            with patch('kicad_review.load_settings', return_value=settings), patch('kicad_review.render_side'), patch('kicad_review.subprocess.run', side_effect=export):
                kicad_review.cmd_render(None)
            assert len(calls) == 2 and all('--footprint=' + _LIVE_ITEM in args for args in calls), calls
    finally:
        os.chdir(here)

def _live_usage():
    with tempfile.TemporaryDirectory() as d:
        _live_tree(d + '/base'); _live_tree(d + '/head', removed=True)
        items = {side: kicad_review.library_items(d + '/' + side) for side in ('base', 'head')}
        changes = kicad_review.library_changes(items['base'], items['head'])
        # Use the correct item identity independently of parser assertions.
        change = next(c for c in changes if c['kind'] == 'footprint'); change['item'] = _LIVE_ITEM
        objects = [{'kind': 'footprint', 'lib': 'Thermal Footprints:' + _LIVE_ITEM, 'ref': 'U1', 'side': 'head'}]
        report = kicad_review.library_report([change], objects, d, {}, local_items=set(items['base']) | set(items['head']))[0]
        assert report['used_by'] == ['U1'] and report['warnings'] == ['⚠ pad 9 removed while U1 uses ' + _LIVE_ITEM], report
        keys = set(items['head']) | {('Other', _LIVE_ITEM, 'footprint')}
        assert kicad_review.library_report([change], objects, d, {}, local_items=keys)[0]['used_by'] == []
        # A known local nickname must not fall back to a different library's same-named item.
        keys = set(items['head']) | {('Thermal Footprints', 'Different', 'footprint')}
        assert kicad_review.library_report([change], objects, d, {}, local_items=keys)[0]['used_by'] == []
        # Exact matches remain valid even when another library has a duplicate item name.
        objects[0]['lib'] = 'footprints:' + _LIVE_ITEM
        assert kicad_review.library_report([change], objects, d, {}, local_items=set(items['head']) | {('Other', _LIVE_ITEM, 'footprint')})[0]['used_by'] == ['U1']


_live_names(); _live_export(); _live_usage()
print("ok live library identity, legacy export and placed-part usage")
# Readiness: one check run per check across projects, worst result wins; comment block.
from kicad_review import check_runs, readiness_markdown
ck = lambda name, title, status, e=0, ne=0: {"name": name, "title": title, "level": "required", "status": status,
                                             "errors": e, "new_errors": ne, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}
rd = {**d2, "projects": [
    {"name": "A", "dir": "a", "status": "modified", "changes": [], "checks": [ck("erc", "ERC", "pass"), ck("drc", "DRC", "fail", 2, 1)]},
    {"name": "B", "dir": "b", "status": "modified", "changes": [], "checks": [ck("erc", "ERC", "warn", 1, 0),
        {**ck("parity", "Schematic/board parity", "not_run"), "reason": "no schematic"}]}]}
runs = {r["name"]: r for r in check_runs(rd)}
assert set(runs) == {"kicad-review / ERC", "kicad-review / DRC", "kicad-review / Schematic/board parity"}, runs.keys()
assert runs["kicad-review / ERC"]["conclusion"] == "neutral" and runs["kicad-review / DRC"]["conclusion"] == "failure"
assert runs["kicad-review / Schematic/board parity"]["conclusion"] == "skipped"
assert "| B | ⚠️ warn | 1 (0) |" in runs["kicad-review / ERC"]["output"]["summary"], runs["kicad-review / ERC"]["output"]["summary"]
assert runs["kicad-review / DRC"]["output"]["title"] == "1 new error"
block = "\n".join(readiness_markdown(rd, threads={"open": 3, "blocking": 2, "resolved": 0}))
assert "#### Ready to merge?" in block and "✕ **Required checks:** failing (A DRC)" in block, block
assert "✕ **Blocking threads:** 2 open" in block and "**Approvals:** see the pull request's reviewers" in block
ok = {**d2, "projects": [{"name": "A", "dir": "", "status": "modified", "changes": [], "checks": [ck("erc", "ERC", "pass")]}]}
assert "✓ **Required checks:** passing" in "\n".join(readiness_markdown(ok)) and "Blocking threads" not in "\n".join(readiness_markdown(ok))
assert "✓ **Blocking threads:** none open" in "\n".join(readiness_markdown(ok, threads={"open": 1, "blocking": 0, "resolved": 0}))
assert DEFAULT_SETTINGS["github"] == {"check_runs": False} and DEFAULT_SETTINGS["threads"] == {"enabled": False, "block_merge": False}
assert "#### Ready to merge?" in comment_markdown(ok, [], "")
print("ok readiness payloads")

_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d); os.makedirs("base")
        for text, error in (('[threads]\nblock_merge = true\n', "threads.block_merge needs threads.enabled = true"),
                            ('[github]\ncheck_runs = 1\n', "github.check_runs must be true or false")):
            with open("base/kicad-review.toml", "w") as fh: fh.write(text)
            try:
                load_settings(); raise AssertionError(error)
            except SystemExit as e:
                assert error in str(e), str(e)
    finally:
        os.chdir(_cwd)
print("ok readiness settings")

# Readiness stays visible after the project body is truncated.
large = {**ok, "projects": [{**ok["projects"][0], "name": "A" * 300} for _ in range(300)]}
body = comment_markdown(large, [], "")
assert "… truncated" in body and "#### Ready to merge?" in body and len(body) < 65536
assert "↗ **Approvals:**" in body
print("ok readiness comment truncation")

# The opted-in gate fails closed without readable thread counts.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d); os.makedirs("review")
        for check_runs, gate, contents, failed in (
            (True, True, None, "blocking threads could not be read"),
            (True, True, "not json", "blocking threads could not be read"),
            (True, True, _json.dumps({"errors": [{"type": "FORBIDDEN"}]}), "blocking threads could not be read"),
            (True, True, _json.dumps({"data": {"repository": {"pullRequest": {}}}}), "blocking threads could not be read"),
            (True, True, _json.dumps([]), "blocking threads could not be read"),
            (True, True, _json.dumps({"data": {"repository": {"pullRequest": {"reviewThreads": {"totalCount": 101, "nodes": []}}}}}), "blocking threads could not be read"),
            (True, True, _json.dumps(gql), "1 blocking thread open"),
            (True, True, _json.dumps({"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}}), ""),
            (False, True, None, "blocking threads could not be read"),
            (True, False, None, ""),
        ):
            if os.path.exists("review/threads.json"):
                os.remove("review/threads.json")
            if os.path.exists("review/check-runs.json"):
                os.remove("review/check-runs.json")
            if contents is not None:
                with open("review/threads.json", "w") as fh: fh.write(contents)
            with open("review/data.json", "w") as fh:
                _json.dump({**ok, "settings": {"threads": {"enabled": True, "block_merge": gate}, "github": {"check_runs": check_runs}}}, fh)
            with open("outputs", "w") as fh: pass
            with patch.dict(os.environ, {"GITHUB_OUTPUT": "outputs", "GITHUB_STEP_SUMMARY": os.devnull}), patch("sys.stdout", new_callable=io.StringIO):
                cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
            with open("review/comment.md") as fh: comment = fh.read()
            assert ("- ✕ **Blocking threads:** could not be read" in comment) == (failed == "blocking threads could not be read"), comment
            with open("outputs") as fh: outputs = fh.read()
            assert outputs == f"check_runs={'true' if check_runs else 'false'}\nthreads_failed={failed}\n", outputs
            assert os.path.exists("review/check-runs.json") == check_runs
            if check_runs:
                with open("review/check-runs.json") as fh: runs = _json.load(fh)
                thread_runs = [r for r in runs if r["name"] == "kicad-review / Threads"]
                assert len(thread_runs) == int(gate)
                if gate:
                    assert thread_runs[0]["conclusion"] == ("failure" if failed else "success")
                    assert thread_runs[0]["output"]["title"] == (failed or "no blocking threads open")
    finally:
        os.chdir(_cwd)
print("ok readiness summary gate")

# Cap raw names before Markdown escaping, including an escape at the boundary.
escaped = {**ok, "projects": [{**ok["projects"][0], "name": "a" * 999 + "*", "checks": [ck("erc", "ERC", "fail")]}]}
assert md("a" * 999 + "*… (full list in Checks)") in "\n".join(readiness_markdown(escaped))
assert "- ✕ **Blocking threads:** could not be read" in readiness_markdown(ok, threads_required=True)
print("ok readiness unreadable threads and escape boundary")

# Readiness: the gate passes with threads enabled but none blocking.
assert "✓ **Blocking threads:** none open" in "\n".join(readiness_markdown(ok, threads={"open": 0, "blocking": 0, "resolved": 0}))
print("ok gate passes with no blocking threads")

# Waivers: a stable key per violation, from the same identity used to call a violation "new".
from kicad_review import waiver_key, load_violations
v1 = {"type": "clearance", "severity": "error", "description": "Clearance violation (0.15 mm < 0.2 mm)", "items": ["Pad 1 of J1", "Track"],
      "uuids": ["u-b", "u-a"], "pos": [10.0, 5.0], "box": None, "where": {"board": True}}
k = waiver_key(v1)
assert re.fullmatch(r"w-[0-9a-f]{12}", k), k
assert k == "w-9ca330438b76"
assert waiver_key({**v1, "uuids": []}) == "w-6a0c64898488"
assert waiver_key({**v1, "key": ("custom", "id")}) == "w-07981c798d2b"
assert waiver_key({**v1, "severity": "warning"}) == "w-46e733a72221"
assert waiver_key({**v1, "uuids": ["u-a", "u-b"]}) == k
assert waiver_key({**v1, "description": "Clearance violation (0.11 mm < 0.2 mm)", "pos": [11, 6]}) == k  # same UUIDs: same finding
assert waiver_key({**v1, "uuids": ["u-c"]}) != k
assert waiver_key({**v1, "severity": "warning"}) != k
no_uuid = {**v1, "uuids": []}
assert waiver_key(no_uuid) == waiver_key({**no_uuid, "description": "Clearance violation (0.1 mm < 0.2 mm)"})  # numbers normalised
assert waiver_key(no_uuid) != waiver_key({**no_uuid, "pos": [30.0, 5.0]})
print("ok waiver keys")

import json as _j, tempfile as _t, os as _o
with _t.TemporaryDirectory() as d:
    unc = lambda: {"type": "unconnected_items", "severity": "error", "description": "Missing connection",
                   "items": [{"description": "Pad 1 [GND] of R1", "pos": {"x": 1, "y": 1}}, {"description": "Pad 2 [GND] of R2", "pos": {"x": 2, "y": 2}}]}
    with open(f"{d}/drc.json", "w") as fh:
        _j.dump({"violations": [], "unconnected_items": [unc(), unc()]}, fh)
    vs = load_violations(f"{d}/drc.json", "drc")
    assert len({waiver_key(v) for v in vs}) == 2, [waiver_key(v) for v in vs]
    assert [waiver_key(v) for v in vs] == [waiver_key(v) for v in load_violations(f"{d}/drc.json", "drc")]
print("ok unconnected duplicates get distinct keys")

# ERC scale comes from referenced schematic geometry, never the KiCad version.
with _t.TemporaryDirectory() as d:
    old_cwd = os.getcwd()
    try:
        os.chdir(d)
        objects = {"/symbol": {"kind": "symbol", "ref": "U1", "pos": [127, 88.9, 0], "props": {}, "where": {"sheet": "/"}},
                   "/child/symbol": {"kind": "symbol", "ref": "U1", "pos": [254, 177.8, 0], "props": {}, "where": {"sheet": "/child/"}}}
        settings = {**DEFAULT_SETTINGS, "checks": {"erc": "required"}}
        for divisor in (1, 100):
            for pins_only in (False, True):
                sheets = []
                for page, x, y in (("/", 127, 88.9), ("/child/", 254, 177.8)):
                    items = [{"uuid": "pin" if pins_only else "symbol", "description": "Symbol U1 Pin 1 [Input]" if pins_only else "Symbol U1 [Test]",
                              "pos": {"x": x / divisor, "y": (y + (2.54 if pins_only else 0)) / divisor}},
                             {"uuid": "unknown", "description": "Unmapped item", "pos": {"x": (x + 5) / divisor, "y": y / divisor}}]
                    sheets.append({"uuid_path": "/root" + page.rstrip("/"), "violations": [
                        {"type": "pin_not_connected", "severity": "error", "description": "Test", "items": items},
                        {"type": "test", "severity": "warning", "description": "No position", "items": []}]})
                report = {"coordinate_units": "mm", "kicad_version": "10.0.6", "sheets": sheets}
                write(d, {"head/G/G.kicad_sch": "", "review/G/head/erc.json": _j.dumps(report)})
                check = project_checks({"dir": "G", "name": "G"}, settings, {"head": objects, "base": {}})[0]
                located = [v for v in check["violations"] if v["pos"]]
                assert [v["pos"] for v in located] == [[127, 91.44 if pins_only else 88.9], [254, 180.34 if pins_only else 177.8]], "ERC must detect bad scale without rescaling correct mm"
                assert located[0]["box"] == [125.5, 87.4, 133.5, 92.94 if pins_only else 90.4], located[0]
                assert all(v["pos"] is None and v["box"] is None for v in check["violations"] if not v["pos"])
        # An exact UUID match wins over pin-anchor proximity; small coordinates alone prove nothing.
        from kicad_review import erc_position_scale
        evidence = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "symbol", "pos": {"x": 127, "y": 88.9}},
            {"uuid": "pin", "description": "Symbol U1 Pin 1 [Input]", "pos": {"x": 1.27, "y": 0.889}}]}]}]
        assert erc_position_scale(evidence, objects) == 1
        assert erc_position_scale([], objects) == 1
        # Inconclusive geometry falls back to the report version; evidence still wins.
        report["sheets"] = [{"uuid_path": "/root", "violations": [{"type": "test", "severity": "error", "description": "Test", "items": [
            {"uuid": "unknown", "pos": {"x": 0.5, "y": 0.8}}]}]}]
        for version, scale in (("10.0.6", 100), ("10.0.6-1", 100), ("(10.0.6)", 100),
                               ("10.0.0", 100), ("10.0.7", 1), ("10.0.60", 1), ("11.0.0", 1),
                               (None, 1), ("unknown", 1), ({}, 1)):
            report["kicad_version"] = version
            write(d, {"review/G/head/erc.json": _j.dumps(report)})
            assert load_violations("review/G/head/erc.json", "erc")[0]["pos"] == [0.5 * scale, 0.8 * scale], version
        assert erc_position_scale(evidence, objects, "10.0.6") == 1
        # A tied vote is also inconclusive, not evidence that the writer is fixed.
        tied = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "symbol", "pos": {"x": 127, "y": 88.9}},
            {"uuid": "symbol", "pos": {"x": 1.27, "y": 0.889}}]}]}]
        assert erc_position_scale(tied, objects, "10.0.6") == 100
        assert erc_position_scale(tied, objects, "10.0.7") == 1
        # Ambiguous pin anchors must not outvote the version for a multi-unit symbol.
        multi = {"/unit1": {"kind": "symbol", "ref": "U1", "pos": [30, 30], "where": {"sheet": "/"}},
                 "/unit2": {"kind": "symbol", "ref": "U1 unit 2", "pos": [200, 150], "where": {"sheet": "/"}}}
        ambiguous = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "pin5", "description": "Symbol U1 Pin 5", "pos": {"x": 2.0, "y": 1.5254}}]}]}]
        assert erc_position_scale(ambiguous, multi, "10.0.6") == 100, "ambiguous pin must defer to version"
        # A far UUID match is not exact evidence and must not override a decisive pin vote.
        far_objects = {**multi, "/other": {"kind": "symbol", "ref": "U2", "pos": [200, 150], "where": {"sheet": "/"}}}
        far = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "unit1", "pos": {"x": 2.0, "y": 0.3}},
            {"uuid": "pin", "description": "Symbol U2 Pin 1", "pos": {"x": 2.0, "y": 1.5254}}]}]}]
        assert erc_position_scale(far, far_objects, "10.0.7") == 100, "far exact match must not override pins"
    finally:
        os.chdir(old_cwd)
print("ok ERC scale detection for fixed and buggy reports, pins and reused sheets")

# Waivers: read from the target ref with git, head copy only proposes; invalid entries skipped; expiry by date.
import datetime
from kicad_review import load_waivers

def load_waivers_on(ref, today):
    with patch("kicad_review.datetime.datetime") as clock:
        clock.now.return_value.date.return_value = today
        return load_waivers(ref)

WFILE = '''[[waiver]]
check = "drc"
match = "%s"
reason = "intended"
by = "ann"
date = 2026-10-01
until = 2026-12-31

[[waiver]]
check = "drc"
match = "w-000000000000"
reason = "old"
by = "ann"
date = 2026-01-01
until = 2026-02-01

[[waiver]]
check = "bom"
match = "w-111111111111"
reason = "nope"
by = "ann"
date = 2026-10-01
permanent = true

[[waiver]]
check = "drc"
match = "w-222222222222"
reason = ""
by = "ann"
date = 2026-10-01
permanent = true
''' % k
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d, patch("sys.stdout", new_callable=io.StringIO):
    try:
        os.chdir(d)
        subprocess.run(["git", "init", "-q", "repo"], check=True)
        open("repo/kicad-review-waivers.toml", "w").write(WFILE)
        subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "add", "."], check=True)
        subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "w"], check=True)
        ref = subprocess.run(["git", "-C", "repo", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        os.makedirs("head")
        open("head/kicad-review-waivers.toml", "w").write(WFILE + '\n[[waiver]]\ncheck = "erc"\nmatch = "w-333333333333"\nreason = "new"\nby = "bo"\ndate = 2026-10-12\npermanent = true\n')
        w = load_waivers_on(ref, datetime.date(2026, 10, 12))
        assert set(w["active"]) == {("drc", k)}, w["active"]
        assert [e["match"] for e in w["expired"]] == ["w-000000000000"]
        assert [e["match"] for e in w["proposed"]] == ["w-000000000000", "w-333333333333"]
        assert len(w["invalid"]) == 4, w["invalid"]  # changed head retains all invalid entries
        head_file = pathlib.Path("head/kicad-review-waivers.toml")
        head_file.write_text(WFILE)
        assert len(load_waivers_on(ref, datetime.date(2026, 10, 12))["invalid"]) == 2  # identical files report once
        head_file.write_text(WFILE + "\n")
        assert len(load_waivers_on(ref, datetime.date(2026, 10, 12))["invalid"]) == 4  # even whitespace makes the text distinct
        head_file.write_text(WFILE.replace("until = 2026-02-01", "until = 2026-12-31"))
        renewed = load_waivers_on(ref, datetime.date(2026, 10, 12))
        assert [e["match"] for e in renewed["proposed"]] == ["w-000000000000"], renewed
        assert renewed["proposed"][0]["until"] == "2026-12-31"
        head_file.write_text(WFILE.replace("w-222222222222", "w-444444444444"))
        invalid = load_waivers_on(ref, datetime.date(2026, 10, 12))["invalid"]
        assert len([m for m in invalid if "reason must not be empty" in m]) == 2, invalid
        assert load_waivers_on(ref, datetime.date(2027, 1, 1))["active"] == {}  # the day after until
        assert load_waivers(None)["active"] == {}  # no target ref: nothing applies
    finally:
        os.chdir(_cwd)
print("ok waivers come from the target ref, not the merge base")
print("ok expired waivers do not apply")
print("ok invalid waiver entries are skipped, not fatal")

# Applying: the waived error stops failing the check but stays listed.
settings = json.loads(json.dumps(DEFAULT_SETTINGS)); settings["waivers"] = {"enabled": True}
active = {"active": {("drc", k): {"check": "drc", "match": k, "reason": "intended", "by": "ann", "until": "2026-12-31", "permanent": False, "ref": None}},
          "expired": [], "proposed": [], "invalid": []}
c = run_check("drc", settings, [dict(v1)], [], waivers=active)
assert c["status"] == "pass" and c["errors"] == 0 and c["new_errors"] == 0 and c["waived"] == 1, c
assert c["violations"][0]["waived"] == {"reason": "intended", "by": "ann", "until": "2026-12-31", "ref": None}
assert c["violations"][0]["waiver_key"] == k
assert run_check("drc", settings, [dict(v1)], [], waivers=None)["status"] == "fail"
assert "waiver_key" not in run_check("drc", settings, [dict(v1)], [])["violations"][0]
print("ok waived findings stop failing")

# Invalid TOML shapes and field types must warn, never crash or apply.
from kicad_review import parse_waivers
valid = WFILE.split("\n[[waiver]]", 1)[0]
for bad_text in ("waiver = [1]", "[waiver]\ncheck = 'drc'", "waiver = 'wrong'", "[[waiver]",
                 valid.replace("until = 2026-12-31", "until = 2026-12-31T00:00:00"),
                 valid.replace("date = 2026-10-01", "date = 2026-10-01T00:00:00"),
                 valid.replace('check = "drc"', 'check = ["drc"]'),
                 valid.replace('match = "' + k + '"', "match = 1"),
                 valid.replace('reason = "intended"', "reason = false"),
                 valid.replace('by = "ann"', "by = 1"),
                 valid + "\npermanent = 'true'", valid + "\nref = 1",
                 valid.replace("until = 2026-12-31", "until = '2026-12-31'\npermanent = true")):
    entries, invalid = parse_waivers(bad_text, "fixture")
    assert entries == [] and invalid, (bad_text, entries, invalid)
print("ok invalid waiver shapes and types are rejected")

_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        subprocess.run(["git", "init", "-q", "repo"], check=True)
        path = pathlib.Path("repo/kicad-review-waivers.toml")
        path.write_text(valid)
        subprocess.run(["git", "-C", "repo", "add", "."], check=True)
        subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "valid"], check=True)
        sha = subprocess.check_output(["git", "-C", "repo", "rev-parse", "HEAD"], text=True).strip()
        subprocess.run(["git", "-C", "repo", "update-ref", "refs/remotes/origin/main", sha], check=True)
        assert set(load_waivers_on("origin/main", datetime.date(2026, 12, 31))["active"]) == {("drc", k)}
        for bad_text in ("waiver = [1]", "[waiver]\ncheck = 'drc'",
                         valid.replace("until = 2026-12-31", "until = 2026-12-31T00:00:00")):
            path.write_text(bad_text)
            subprocess.run(["git", "-C", "repo", "add", "."], check=True)
            subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "invalid"], check=True)
            sha = subprocess.check_output(["git", "-C", "repo", "rev-parse", "HEAD"], text=True).strip()
            subprocess.run(["git", "-C", "repo", "update-ref", "refs/remotes/origin/main", sha], check=True)
            with patch("sys.stdout", new_callable=io.StringIO) as warnings:
                result = load_waivers("origin/main")
            assert not result["active"] and result["invalid"]
            assert "::warning::" in warnings.getvalue() and sha[:7] in warnings.getvalue()
    finally:
        os.chdir(_cwd)
print("ok live target ref and invalid target files")

warning = {**v1, "severity": "warning"}
warning_key = waiver_key(warning)
all_active = copy.deepcopy(active)
all_active["active"][("drc", warning_key)] = {**active["active"][("drc", k)], "match": warning_key}
settings["fail_on"] = "all"
c = run_check("drc", settings, [dict(v1), warning], [dict(v1)], all_active)
assert c["status"] == "pass" and c["waived"] == 2 and c["warnings"] == c["new_warnings"] == c["errors"] == c["new_errors"] == c["fixed"] == 0
plain = run_check("drc", settings, [dict(v1)], [])
assert "waived" not in plain and "waiver_key" not in plain["violations"][0]
print("ok waiver counters and opted-out violation fields")

# Report wiring reads no waiver file when off; live target ref wins over local fallback.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        pathlib.Path("review").mkdir()
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "local-base", "head": "h", "reason": "fixture", "projects": [project]}))
        for enabled, target in ((False, "origin/main"), (True, "origin/release"), (True, "")):
            settings = copy.deepcopy(DEFAULT_SETTINGS)
            settings["waivers"]["enabled"] = enabled
            with patch.dict(os.environ, {"WAIVERS_REF": target}), patch("kicad_review.load_settings", return_value=settings), \
                 patch("kicad_review.load_waivers", return_value=active) as loader, \
                 patch("kicad_review.build_project", return_value={"checks": [], "changes": []}) as builder, \
                 patch("sys.stdout", new_callable=io.StringIO):
                kicad_review.cmd_report(None)
            if enabled:
                loader.assert_called_once_with(target or "local-base")
            else:
                loader.assert_not_called()
                assert "waivers" not in json.loads(pathlib.Path("review/data.json").read_text())
            assert builder.call_args.args[3] == (active if enabled else None)
    finally:
        os.chdir(_cwd)
print("ok waiver report opt-in and target-ref wiring")

# Untrusted refs cannot become git options; unsafe or huge head files are never parsed.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        subprocess.run(["git", "init", "-q", "repo"], check=True)
        for ref in ("--output=x", "missing-target"):
            with patch("sys.stdout", new_callable=io.StringIO) as warnings:
                result = load_waivers(ref)
            assert not result["active"] and result["invalid"] == [f"kicad-review-waivers.toml: cannot resolve {ref}"]
            assert "::warning::" in warnings.getvalue()
            assert not pathlib.Path("x").exists() and not pathlib.Path("repo/x").exists()
        pathlib.Path("head").mkdir()
        head_file = pathlib.Path("head/kicad-review-waivers.toml")
        head_file.symlink_to("/dev/zero")
        with patch("sys.stdout", new_callable=io.StringIO), patch("builtins.open", side_effect=AssertionError("symlink must not be opened")):
            result = load_waivers(None)
        assert not result["proposed"] and any("symlink" in m for m in result["invalid"])
        head_file.unlink()
        head_file.write_bytes(b" " * (1024 * 1024 + 1))
        with patch("sys.stdout", new_callable=io.StringIO):
            result = load_waivers(None)
        assert not result["proposed"] and any("exceeds 1 MiB" in m for m in result["invalid"])
    finally:
        os.chdir(_cwd)
print("ok waiver ref options, missing refs, symlinks and size limit")

# Comment summaries distinguish waived findings from new errors and escape waiver text.
from kicad_review import waiver_lines, checks_markdown
entry = {"check": "erc", "match": "w-444444444444", "reason": "gone", "by": "bo"}
wd = {"projects": [{"name": "A", "checks": [{**c, "violations": [{**v1, "new": True, "waived": {"reason": "intended"}}], "waived": 1}]}],
      "waivers": {"stale": [entry], "expired": [{**entry, "until": "2026-02-01"}],
                  "proposed": [entry], "invalid": ["waiver 3: reason must not be empty"]}}
text = "\n".join(waiver_lines(wd))
assert "1 finding waived" in text
assert "Waiver not matched in this review: erc w-444444444444 (gone, by bo) (if its finding is gone, remove it)." in text
assert "Expired waiver: erc w-444444444444 (gone, by bo) ended 2026-02-01." in text
assert "Proposed in this change (applies after it merges): erc w-444444444444 (gone, by bo)." in text
assert "waiver 3: reason must not be empty" in text
assert "New errors" not in checks_markdown(wd) and "1 finding waived" in checks_markdown(wd)
unwaived = copy.deepcopy(wd)
unwaived["projects"][0]["checks"][0]["violations"].append({**v1, "new": True, "description": "real new error"})
assert "real new error" in checks_markdown(unwaived)
assert waiver_lines(d2) == [] and "waived" not in checks_markdown(d2)
unsafe = "[link](x) *bold* <img> @ann | `code`"
for field in ("check", "match", "reason", "by", "until"):
    escaped = copy.deepcopy(wd)
    escaped["waivers"]["expired"][0][field] = unsafe
    rendered = "\n".join(waiver_lines(escaped))
    assert md(unsafe) in rendered and unsafe not in rendered, (field, rendered)
empty = {"projects": [], "waivers": {"stale": [], "expired": [], "proposed": [], "invalid": []}}
assert waiver_lines(empty) == [] and "waived" not in checks_markdown(empty)
for field in ("check", "match", "reason", "by", "until"):
    multiline = copy.deepcopy(wd)
    multiline["waivers"]["expired"][0][field] = "a\nb\r\n\t c"
    lines = waiver_lines(multiline)
    assert any("a b c" in line for line in lines)
    assert all("\n" not in line and "\r" not in line and "\t" not in line for line in lines)
multiline["waivers"]["invalid"] = ["a\nb"]
assert "- Ignored: a b" in waiver_lines(multiline)
print("ok stale waivers are listed and waived errors stay out of new errors")
print("ok waiver text stays on one line and empty waiver summaries are omitted")

# Exercise stale classification in cmd_report, including repeated keys across projects.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        pathlib.Path("review").mkdir()
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": [project, project]}))
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings["waivers"]["enabled"] = True
        loaded = {"active": {("drc", k): {**entry, "check": "drc", "match": k}, ("erc", entry["match"]): entry},
                  "expired": wd["waivers"]["expired"], "proposed": [entry], "invalid": ["bad entry"]}
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.load_waivers", return_value=loaded), \
             patch("kicad_review.build_project", side_effect=lambda *args: {"checks": [{"name": "drc", "violations": [{"waiver_key": k, "waived": {"reason": "intended"}}], "status": "pass"}], "changes": []}), \
             patch("sys.stdout", new_callable=io.StringIO):
            kicad_review.cmd_report(None)
        data = json.loads(pathlib.Path("review/data.json").read_text())
        assert data["waivers"] == {"stale": [entry], "expired": loaded["expired"], "proposed": [entry], "invalid": ["bad entry"]}
        payload = pathlib.Path("review/kicad-review.html").read_text().split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0]
        assert json.loads(payload)["waivers"] == data["waivers"]
    finally:
        os.chdir(_cwd)
print("ok report stale classification and embedded waiver data")

# Checkout's full-history fetch populates all remote branches even for detached PR heads.
wf = pathlib.Path(".github/workflows/review.yml").read_text()
checkout = wf.split("- name: Check out project history", 1)[1].split("- name: Check out review tools", 1)[0]
assert "fetch-depth: 0" in checkout and "path: repo" in checkout
assert "ref: ${{ github.event.pull_request.head.sha || github.sha }}" in checkout, "SHA checkout must not reset a live origin branch to the event's old commit"
assert "WAIVERS_REF: origin/${{ github.event.pull_request.base.ref || github.event.repository.default_branch }}" in wf
print("ok workflow live waiver target and full-history project checkout")

# Readiness keeps waived findings visible without treating them as blockers.
assert "- ↷ **Waived findings:** 1 (not blocking)" in readiness_markdown(wd)
assert not any("Waived" in line for line in readiness_markdown(d2))
assert "- ↷ **Waived findings:** 0 (not blocking)" in readiness_markdown(empty)
assert readiness_markdown(wd)[-2].startswith("- ↷ **Waived findings:**")
print("ok waived row in readiness")

# Issues: match only open anchored issues, keep the disabled summary identical.
from kicad_review import touched_issues
enc_issue = lambda n, ref, project="": {"number": n, "body": enc({"v": 1, "project": project, "ref": ref, "severity": "comment"})}
idata = {**d2, "projects": [{"name": "A", "dir": "", "status": "modified", "checks": [], "changes": [{"ref": "R16", "kind": "footprint", "action": "modified", "changes": [], "props": {}}]}]}
issues = [enc_issue(12, "R16"), enc_issue(15, "C3"), {"number": 20, "body": "plain issue"}, enc_issue(21, "R16", "other"), {**enc_issue(22, "R16"), "pull_request": {}}, {**enc_issue(23, "R16"), "state": "closed"}, enc_issue(12, "R16"), {**enc_issue(24, "R16"), "body": 5}, enc_issue("unsafe", "R16")]
assert touched_issues(issues, idata) == [12]
assert touched_issues({"message": "denied"}, idata) == []
assert "Touches parts named in #12, #15." in comment_markdown(idata, [], "", issues=[12, 15])
assert comment_markdown(idata, [], "") == comment_markdown(idata, [], "", issues=None) == comment_markdown(idata, [], "", issues=[])
assert DEFAULT_SETTINGS["issues"] == {"enabled": False}
print("ok touched issues and disabled summary byte identity")

# Issues: opt-out data and summary bytes keep the legacy shape, including an existing issues file.
from kicad_review import cmd_report, review_links
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        os.makedirs("review")
        det = {"base": "a" * 40, "head": "b" * 40, "reason": "test", "projects": []}
        with open("review/detect.json", "w") as fh: _json.dump(det, fh)
        with patch.dict(os.environ, {"GITHUB_OUTPUT": os.devnull, "GITHUB_STEP_SUMMARY": os.devnull}, clear=True):
            with patch("kicad_review.inline_page", side_effect=lambda payload: payload), patch("sys.stdout", new_callable=io.StringIO):
                cmd_report(SimpleNamespace())
            legacy = {"version": 1, "repo": "", "links": review_links(os.environ, det), "base": det["base"], "head": det["head"], "reason": "test",
                      "settings": {k: ({name: value for name, value in v.items() if name not in ("interfaces", "release")} if k == "checks" else {"required_fields": v["required_fields"]} if k == "bom" else v) for k, v in DEFAULT_SETTINGS.items() if k not in ("3d", "parts", "digikey", "pdf", "threads", "issues", "waivers", "inventory", "libraries", "github", "interfaces", "release")}, "run_id": "", "projects": []}
            assert open("review/data.json").read() == _json.dumps(legacy)
            assert open("review/kicad-review.html").read() == "window.REVIEW_DATA = " + _json.dumps({**legacy, "blobs": {}}, separators=(",", ":")) + ";"
            with open("review/issues.json", "w") as fh: _json.dump(issues, fh)
            with patch("sys.stdout", new_callable=io.StringIO): cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
            assert open("review/comment.md").read() == comment_markdown(legacy, [], "")
            assert "issues" not in _json.load(open("review/data.json"))["settings"]
        os.makedirs("base")
        for value in ['"yes"', '3', '[]']:
            with open("base/kicad-review.toml", "w") as fh: fh.write('[issues]\nenabled = ' + value + '\n')
            try: load_settings(); raise AssertionError("bad issue enabled accepted")
            except SystemExit as error: assert "issues.enabled must be true or false" in str(error)
    finally: os.chdir(_cwd)
print("ok issues disabled report payload, data and comment byte identity")

# Issues: cmd_summary opts in and degrades on invalid JSON.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t); os.makedirs("review")
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": os.devnull}):
            for contents, expected in [(_json.dumps(issues), True), ('not json', False), (_json.dumps({"message": "denied"}), False)]:
                with open("review/data.json", "w") as fh: _json.dump({**idata, "settings": {"issues": {"enabled": True}}}, fh)
                with open("review/issues.json", "w") as fh: fh.write(contents)
                with patch("sys.stdout", new_callable=io.StringIO) as stdout: cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
                assert ("Touches parts named in #12." in open("review/comment.md").read()) == expected
                if contents == 'not json': assert "::warning::review/issues.json is not JSON" in stdout.getvalue()
    finally: os.chdir(_cwd)
print("ok issues cmd_summary opt-in and malformed data")


# Normalized board scenes: stable identity and exact micrometre geometry.
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
# KiCad 10 has no net table: a quoted numeric name is not a numbered reference.
numeric_name_board = '''(kicad_pcb (version 20260206)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (segment (start 0 0) (end 1 0) (width .25) (layer "F.Cu") (net "12") (uuid digits))
 (via (at 1 0) (size .8) (drill .4) (layers "F.Cu" "B.Cu") (net "GND") (uuid ground))
 (footprint "Test:X" (layer "F.Cu") (at 0 0) (uuid fp)
  (property "Reference" "J1")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "12") (uuid pad))))'''
numeric_scene = scene_from_text(numeric_name_board)
assert {n['name'] for n in numeric_scene['nets']} == {'', '12', 'GND'}, numeric_scene['nets']
assert numeric_scene['warnings'] == [], numeric_scene['warnings']
numeric_ids = {n['name']: n['id'] for n in numeric_scene['nets']}
numeric_objects = {o['uuid']: o for o in numeric_scene['objects']}
assert numeric_objects['digits']['net'] == numeric_objects['pad']['net'] == numeric_ids['12']
assert numeric_objects['ground']['net'] == numeric_ids['GND'] != numeric_ids['12']
with TemporaryDirectory() as d:
    p = Path(d) / 'nets.kicad_pcb'
    p.write_text(numeric_name_board)
    objects = pcb_objects(p)
    assert objects['digits']['props']['net'] == objects['fp']['props']['pad 1 net'] == '12'
    assert objects['ground']['props']['net'] == 'GND'
    # Old net tables resolve both bare and inline numbered references.
    old_board = numeric_name_board.replace('20260206', '20221018').replace(
        '(layers', '(net 12 "GND") (net 13 "12") (layers', 1).replace(
        '(net "12")', '(net 13)').replace('(net "GND")', '(net 12 "GND")')
    old_scene = scene_from_text(old_board)
    assert old_scene['nets'] == [{'id': 0, 'name': ''}, {'id': 12, 'name': 'GND'}, {'id': 13, 'name': '12'}]
    assert old_scene['warnings'] == []
    assert {o['uuid']: o['net'] for o in old_scene['objects'] if o['kind'] != 'footprint'} == {
        'digits': 13, 'ground': 12, 'pad': 13}
    p.write_text(old_board)
    assert pcb_objects(p) == objects
    # A modern name must not resolve through an unrelated old numeric table key.
    p.write_text(old_board.replace('(net 13)', '(net "12")'))
    assert pcb_objects(p) == objects
print('ok quoted numeric net names and older numbered references')
for bad in ("NaN", "Infinity", "3000000"):
    try:
        geometry_um(bad)
        raise AssertionError(bad)
    except ValueError:
        pass
print("ok board scene identity, units, pad transforms, nets and arcs")

# Empty and metadata-only boards stay complete; unsupported visible drawables fall back.
empty_scene = scene_from_text('(kicad_pcb (version 20260206) (general (thickness 1.6)))')
assert empty_scene['complete'] and empty_scene['bounds'] == [0, 0, 0, 0]
assert empty_scene['objects'] == [] and empty_scene['nets'] == [{'id': 0, 'name': ''}]
assert s['complete'] and s['warnings'] == []
assert by_id['tr']['box'] == [875, 1875, 3125, 2125]
assert by_id['vi']['box'] == [3600, 4600, 4400, 5400]
assert by_id['fp']['geometry'] == {} and by_id['fp']['box'] == [9500, 17000, 12500, 20500]
assert by_id['pa']['side'] == by_id['pb']['side'] == 'back'
unknown = scene_from_text(GEOMETRY_FIXTURE[:-1] + '(gr_curve (uuid curve) (layer "F.Cu")))')
assert not unknown['complete']
assert unknown['warnings'] == [{'uuid': 'curve', 'kind': 'gr_curve', 'reason': 'cubic requires four control points'}]
assert scene_from_text(GEOMETRY_FIXTURE[:-1] + '(gr_curve (uuid curve) hide))')['complete']

# Copper ordering comes from canonical names, not numeric enums or layer declaration order.
span_fixture = '''(kicad_pcb
 (layers (0 "F.Cu" signal hide) (2 "B.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal)
 (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user))
 (via (at 0 0) (size 1) (drill .4) (layers "F.Cu" "B.Cu") (uuid through))
 (via blind (at 2 0) (size 1) (drill .4) (layers "In1.Cu" "B.Cu") (uuid blind))
 (footprint "Test" (uuid parent) (layer "F.Cu") (at 0 0)
  (fp_text reference "R9" (hide yes))
  (pad "1" smd rect (uuid margin) (at 0 0) (size 2 1)
   (layers "F.Cu" "F.Mask" "F.Paste") (solder_mask_margin .1)
   (solder_paste_margin -.05) (solder_paste_margin_ratio -.1))
  (pad "2" np_thru_hole circle (uuid hole) (at 4 0) (size 1 1) (drill .8) (layers "*.Cu" "*.Mask"))))'''
span = scene_from_text(span_fixture)
span_ids = {o['uuid']: o for o in span['objects']}
assert span_ids['through']['layers'] == ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
assert span_ids['blind']['layers'] == ['In1.Cu', 'In2.Cu', 'B.Cu']
assert all(layer['enabled'] for layer in span['layers'])
assert span_ids['hole']['layers'] == ['F.Mask', 'B.Mask']
assert not span_ids['hole']['geometry']['drill']['plated']
assert span_ids['margin']['ref'] == 'R9'
assert span_ids['margin']['geometry']['layerPrimitives']['F.Mask']['size'] == [2200, 1200]
assert span_ids['margin']['geometry']['layerPrimitives']['F.Paste']['size'] == [1500, 700]

# Numeric unknown nets stay numeric; mixed modern names receive deterministic IDs.
mixed = scene_from_text(GEOMETRY_FIXTURE.replace('(net 1 "GND")', '(net 1 "GND") (net "Z") (net "A")', 1).replace('(net 1) (uuid tr)', '(net 8) (uuid tr)'))
assert mixed['nets'] == [{'id': 0, 'name': ''}, {'id': 1, 'name': 'GND'}, {'id': 8, 'name': 'Net 8'}, {'id': 9, 'name': 'A'}, {'id': 10, 'name': 'Z'}]
assert next(o for o in mixed['objects'] if o['uuid'] == 'tr')['net'] == 8
assert mixed['complete'] and mixed['warnings'][0]['kind'] == 'net'
zone_named = scene_from_text('(kicad_pcb (zone (uuid z) (net 7) (net_name "Earth")))')
assert zone_named['nets'] == [{'id': 0, 'name': ''}, {'id': 7, 'name': 'Earth'}]

# Drill offsets rotate once with the world pad angle. Board setup is the last margin fallback.
offset = scene_from_text(GEOMETRY_FIXTURE.replace('(drill oval .8 .4)', '(drill oval .8 .4 (offset .2 .1))'))
assert next(o for o in offset['objects'] if o['uuid'] == 'pa')['geometry']['drill']['center'] == [10100, 17800]
setup_margin = scene_from_text(span_fixture.replace('(via (at 0 0)', '(setup (pad_to_mask_clearance .3)) (via (at 0 0)').replace('(solder_mask_margin .1)', ''))
assert next(o for o in setup_margin['objects'] if o['uuid'] == 'margin')['geometry']['layerPrimitives']['F.Mask']['size'] == [2600, 1600]
print('ok board scene bounds, copper spans, NPTH, margins and mixed net syntax')

# Custom pads retain their anchor and transformed primitives, never a replacement rectangle.
custom_fixture = '''(kicad_pcb (layers (0 "F.Cu" signal))
 (footprint "Custom" (layer "F.Cu") (uuid custom-fp) (at 10 20 90)
  (property "Reference" "J2")
  (pad "1" smd custom (uuid custom) (at 2 0 90) (size .2 .2) (layers "F.Cu")
   (options (anchor circle))
   (primitives
    (gr_line (start 0 0) (end 1 0) (width .2))
    (gr_poly (pts (xy 0 0) (xy 1 0) (xy 0 1)) (width .1) (fill yes))))))'''
custom_scene = scene_from_text(custom_fixture)
custom_pad = next(o for o in custom_scene['objects'] if o['uuid'] == 'custom')
assert custom_scene['complete']
assert custom_pad['geometry']['primitive']['shape'] == 'circle'
assert custom_pad['geometry']['segments'][0] == [10000, 18000, 10000, 17000, 200]
assert custom_pad['geometry']['rings'] == [[[10000, 18000], [10000, 17000], [11000, 18000]]]
assert custom_pad['box'] == [9900, 16900, 11050, 18100]
unsupported_custom = scene_from_text(custom_fixture.replace('(gr_line (start 0 0) (end 1 0) (width .2))', '(gr_curve (width .2))'))
assert not unsupported_custom['complete']
assert unsupported_custom['warnings'][0] == {'uuid': 'custom', 'kind': 'pad', 'reason': 'unsupported custom primitive gr_curve'}

# Ordinary pad shapes, tented masks, footprint overrides and hidden parent inheritance.
for shape in ('circle', 'rect', 'oval', 'roundrect', 'trapezoid'):
    pad_scene = scene_from_text(span_fixture.replace('smd rect', 'smd ' + shape))
    assert next(o for o in pad_scene['objects'] if o['uuid'] == 'margin')['geometry']['primitive']['shape'] == shape
trapezoid = scene_from_text(span_fixture.replace('smd rect', 'smd trapezoid').replace('(uuid margin)', '(uuid margin) (rect_delta .2 .4)'))
assert next(o for o in trapezoid['objects'] if o['uuid'] == 'margin')['geometry']['primitive']['delta'] == [200, 400]
tented = scene_from_text(span_fixture.replace('(uuid hole)', '(uuid hole) (tenting (front yes) (back no))'))
assert next(o for o in tented['objects'] if o['uuid'] == 'hole')['layers'] == ['B.Mask']
fp_margin = scene_from_text(span_fixture.replace('(uuid parent)', '(uuid parent) (solder_mask_margin .4)').replace('(solder_mask_margin .1)', ''))
assert next(o for o in fp_margin['objects'] if o['uuid'] == 'margin')['geometry']['layerPrimitives']['F.Mask']['size'] == [2800, 1800]
hidden_parent = scene_from_text(GEOMETRY_FIXTURE.replace('(uuid fp)', '(uuid fp) (hide yes)'))
assert all(o['hidden'] for o in hidden_parent['objects'] if o['changeUuid'] == 'fp')
assert hidden_parent['bounds'] == [875, 1875, 4400, 5400]
conditional = scene_from_text(span_fixture.replace('(uuid margin)', '(uuid margin) (remove_unused_layers) (keep_end_layers)'))
assert not conditional['complete'] and 'requires connectivity' in conditional['warnings'][0]['reason']

# Numerical guards apply to parsed geometry too, including reflected and rotated pad positions.
from kicad_review import geometry_point, pcb_objects
assert geometry_point(('-0.0005', '0.0005')) == [-1, 1]
assert geometry_point(('0.0005', '0.0005'), ('0', '0', '90')) == [1, -1]
assert geometry_arc((0, 0), (1, 0), (2, 0), '.1') == [[0, 0, 2000, 0, 100]]
assert geometry_arc((1, 0), (0, -1), (-1, 0), '.2')[0][3] < 0
for bad in ('NaN', 'Infinity', '3000000', '-.25'):
    try:
        scene_from_text(GEOMETRY_FIXTURE.replace('(width .25)', '(width ' + bad + ')'))
        raise AssertionError('invalid track width accepted: ' + bad)
    except ValueError:
        pass
try:
    geometry_arc((2000000, 0), (-2000000, 0), (0, -2000000), '.1')
    raise AssertionError('arc budget not enforced')
except ValueError as error:
    assert 'budget' in str(error)
with TemporaryDirectory() as d:
    board = Path(d) / 'identity.kicad_pcb'
    board.write_text(GEOMETRY_FIXTURE)
    semantic_before = pcb_objects(board)
    identity_scene = board_geometry(board)
    assert pcb_objects(board) == semantic_before
    assert all(o['changeUuid'] in semantic_before for o in identity_scene['objects'])
print('ok board custom pads, shape variants, visibility, margins, numeric guards and semantic identity')

# Unsupported conditional/offset geometry is explicit SVG fallback, never guessed copper.
hidden_text = scene_from_text(GEOMETRY_FIXTURE.replace('(property "Reference" "J1")', '(property "Reference" "J1" (effects (hide yes)))'))
assert hidden_text['complete']
hidden_custom = scene_from_text(custom_fixture.replace('(uuid custom-fp)', '(uuid custom-fp) (hide yes)').replace('(gr_line (start 0 0) (end 1 0) (width .2))', '(gr_curve (width .2))'))
assert hidden_custom['complete'] and hidden_custom['bounds'] == [0, 0, 0, 0]
custom_mask = scene_from_text(custom_fixture.replace('(0 "F.Cu" signal)', '(0 "F.Cu" signal) (1 "F.Mask" user)').replace('(layers "F.Cu")', '(layers "F.Cu" "F.Mask") (solder_mask_margin .1)'))
assert not custom_mask['complete'] and 'offset not yet supported' in custom_mask['warnings'][0]['reason']
try:
    scene_from_text(GEOMETRY_FIXTURE.replace('(start 1 2)', '(start 2000000 2)'))
    raise AssertionError('out-of-range stroked bbox accepted')
except ValueError:
    pass
print('ok board fallback warnings, hidden effects and stroked extent limits')

assert scene_from_text(GEOMETRY_FIXTURE.replace('(uuid fp)', '(uuid fp) (fp_metadata "opaque")'))["complete"]

# Stored zone paths retain slit bridges, holes and independent islands verbatim.
DRAW_FIXTURE = GEOMETRY_FIXTURE.replace('(44 "Edge.Cuts" user)', '(44 "Edge.Cuts" user) (37 "F.SilkS" user) (36 "B.SilkS" user) (40 "Dwgs.User" user)')
EXTRA = '''
(zone (net 1) (layer "F.Cu") (uuid zone)
 (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
 (filled_polygon (layer "F.Cu")
  (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10) (xy 0 0)
       (xy 2 2) (xy 2 8) (xy 8 8) (xy 8 2) (xy 2 2) (xy 0 0)))
 (filled_polygon (layer "F.Cu") (pts (xy 20 0) (xy 21 0) (xy 21 1)))
 (filled_polygon (layer "B.Cu") (pts (xy 30 0) (xy 31 0) (xy 31 1))))
(gr_line (start -1 -1) (end 11 -1) (stroke (width .05) (type default))
 (layer "Edge.Cuts") (uuid edge))
(gr_text "<& Board" (at 5 6 30) (layer "F.SilkS") (uuid text) unlocked
 (effects (font (size 1 2) (thickness .15) bold italic) (justify left top mirror)))
'''
ss = scene_from_text(DRAW_FIXTURE[:-1] + EXTRA + ')')
u = {o['uuid']: o for o in ss['objects']}
zones = [o for o in ss['objects'] if o['changeUuid'] == 'zone']
assert ss['complete'], ss['warnings']
assert len(zones) == 3 and len({o['uuid'] for o in zones}) == 3
assert [o['layers'] for o in zones] == [['F.Cu'], ['F.Cu'], ['B.Cu']]
assert zones[0]['geometry']['rings'][0] == [[0,0],[10000,0],[10000,10000],[0,10000],[0,0],[2000,2000],[2000,8000],[8000,8000],[8000,2000],[2000,2000],[0,0]]
assert zones[1]['geometry']['rings'] == [[[20000,0],[21000,0],[21000,1000]]]
assert u['edge']['geometry']['segments'] == [[-1000,-1000,11000,-1000,50]]
t = u['text']['geometry']['text']
assert t == {'value': '<& Board', 'at': [5000,6000], 'size': [2000,1000], 'angle': 30000,
             'thickness': 150, 'justify': ['left','top'], 'mirror': True, 'italic': True, 'bold': True, 'unlocked': True}
assert u['text']['box'] is not None
unfilled = EXTRA[:EXTRA.index('(gr_line')].replace('filled_polygon', 'not_a_fill')
zz = scene_from_text(DRAW_FIXTURE[:-1] + unfilled + ')')
zo = next(o for o in zz['objects'] if o['changeUuid'] == 'zone')
assert zz['complete'] and zo['geometry']['rings'] == [] and len(zo['geometry']['segments']) == 4
assert any('no stored fill; showing outline' in w['reason'] for w in zz['warnings'])
keepout = scene_from_text(DRAW_FIXTURE[:-1] + EXTRA[:EXTRA.index('(gr_line')].replace('(uuid zone)', '(uuid zone) (keepout (tracks not_allowed))') + ')')
assert keepout['complete'] and all(o['geometry']['rings'] == [] for o in keepout['objects'] if o['changeUuid'] == 'zone')
print('ok board stored zone topology, islands, layers, keepouts and unfilled outlines')

SHAPES = '''
(gr_rect (start 0 0) (end 2 1) (stroke (width .1)) (fill none) (layer "F.SilkS") (uuid rect))
(gr_rect (start 3 0) (end 5 1) (width .2) (fill solid) (layer "F.SilkS") (uuid solid))
(gr_circle (center 0 0) (end 1 0) (stroke (width .1)) (fill solid) (layer "F.SilkS") (uuid circle))
(gr_arc (start 1 0) (mid 0 1) (end -1 0) (width .1) (layer "F.SilkS") (uuid arc-shape))
(gr_poly (pts (xy 0 0) (xy 2 0) (xy 1 1)) (width .1) (fill none) (layer "F.SilkS") (uuid poly))
(gr_curve (pts (xy 0 0) (xy 0 2) (xy 2 2) (xy 2 0)) (stroke (width .1)) (layer "F.SilkS") (uuid curve-ok))
'''
shape_scene = scene_from_text(DRAW_FIXTURE[:-1] + SHAPES + ')')
assert shape_scene['complete'], shape_scene['warnings']
shapes = {o['uuid']: o for o in shape_scene['objects']}
assert len(shapes['rect']['geometry']['segments']) == 4 and shapes['rect']['geometry']['rings'] == []
assert shapes['solid']['geometry']['rings'] == [[[3000,0],[5000,0],[5000,1000],[3000,1000]]]
assert len(shapes['circle']['geometry']['segments']) > 32 and len(shapes['circle']['geometry']['rings']) == 1
assert shapes['arc-shape']['geometry']['segments'][0][:2] == [1000,0]
assert len(shapes['poly']['geometry']['segments']) == 3 and shapes['poly']['geometry']['rings'] == []
curve = shapes['curve-ok']['geometry']['segments']
assert len(curve) > 16 and curve[0][:2] == [0,0] and curve[-1][2:4] == [2000,0]
assert all(a[2:4] == b[:2] for a,b in zip(curve,curve[1:]))
# Collinear controls beyond the chord must subdivide, not collapse a retracing curve.
retraced = scene_from_text(DRAW_FIXTURE[:-1] + SHAPES[SHAPES.index('(gr_curve'):].replace('(xy 0 2) (xy 2 2)', '(xy 5 0) (xy -3 0)') + ')')
assert len(next(o for o in retraced['objects'] if o['uuid'] == 'curve-ok')['geometry']['segments']) > 1
print('ok board graphics shapes, fills, circle/arc and bounded cubic flattening')

FP_DRAW = '''
 (fp_line (start 1 0) (end 2 0) (stroke (width .1)) (layer "B.SilkS") (uuid fp-line))
 (fp_text user "${REFERENCE}/${VALUE}" (at 1 0 90) (layer "B.SilkS") (uuid fp-label)
  (effects (font (size 1 1)) (justify right bottom mirror)))
 (property "Value" "Connector" (at 0 1 90) (layer "B.SilkS") (uuid value-label) (effects (font (size 1 1))))
 (property "Reference" "J1" (at 0 0 90) (layer "B.SilkS") hide (uuid hidden-property) (effects (font (size 1 1))))
'''
fp_scene = scene_from_text(DRAW_FIXTURE.replace('(uuid fp)', '(uuid fp)' + FP_DRAW))
fpo = {o['uuid']: o for o in fp_scene['objects']}
assert fp_scene['complete'], fp_scene['warnings']
assert fpo['fp-line']['geometry']['segments'] == [[10000,19000,10000,18000,100]]
assert fpo['fp-label']['geometry']['text']['at'] == [10000,19000]
assert fpo['fp-label']['geometry']['text']['angle'] == 90000  # already board-frame, not doubled
assert fpo['fp-label']['geometry']['text']['value'] == 'J1/Connector'
assert fpo['fp-label']['changeUuid'] == 'fp' and fpo['fp-label']['side'] == 'back'
assert fpo['hidden-property']['hidden']
for hide in ('hide', '(hide yes)', '(effects (hide yes))'):
    hidden_scene = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "SECRET" (at 0 0) (layer "F.SilkS") ' + hide + ' (uuid hidden) (effects (font (size 1 1))))' + ')')
    assert hidden_scene['complete'] and next(o for o in hidden_scene['objects'] if o['uuid'] == 'hidden')['hidden']
for unsupported in ('dimension', 'table', 'gr_text_box', 'image'):
    ss = scene_from_text(DRAW_FIXTURE[:-1] + '(' + unsupported + ' (layer "Dwgs.User") (uuid unsupported))' + ')')
    assert not ss['complete'] and any(w['kind'] == unsupported for w in ss['warnings'])
for label in ('${UNKNOWN}', '~{rich}', '^{rich}'):
    ss = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "' + label + '" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1))))' + ')')
    assert not ss['complete'], label
font_scene = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "Label" (at 0 0) (layer "F.SilkS") (effects (font (face "Embedded") (size 1 1))))' + ')')
assert not font_scene['complete'] and any('font' in w['reason'] for w in font_scene['warnings'])
print('ok board text metadata, hidden properties, footprint transforms and explicit SVG fallbacks')

# Guard pathological flattening and new/legacy text flags without silent geometry loss.
for huge_shape in (
    '(gr_circle (center 0 0) (end 2000000 0) (width .1) (layer "F.Cu") (uuid huge))',
    '(gr_curve (pts (xy -2000000 -2000000) (xy -2000000 2000000) (xy 2000000 -2000000) (xy 2000000 2000000)) (layer "F.Cu") (uuid huge))',
):
    huge_scene = scene_from_text(DRAW_FIXTURE[:-1] + huge_shape + ')')
    assert not huge_scene['complete'] and any('budget' in w['reason'] for w in huge_scene['warnings'])
    assert next(o for o in huge_scene['objects'] if o['uuid'] == 'huge')['geometry'] == {}
# Numeric error bound against a sampled cubic before integer rounding.
from kicad_review import geometry_cubic
import math
flattened = geometry_cubic([[0,0], [0,2], [2,2], [2,0]])
for i in range(1001):
    t = i / 1000
    p = [6*t*t - 4*t*t*t, 6*t*(1-t)]
    def chord_distance(a, b):
        dx, dy = b[0]-a[0], b[1]-a[1]
        u = max(0, min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)))
        return math.hypot(p[0]-a[0]-u*dx, p[1]-a[1]-u*dy)
    assert min(chord_distance(a,b) for a,b in zip(flattened,flattened[1:])) <= .001
flags = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "Flags" (at 1 2 45 unlocked) (layer "F.SilkS") (uuid flags) (effects (font (size 1 2) (bold yes) (italic no))))' + ')')
flag_text = next(o for o in flags['objects'] if o['uuid'] == 'flags')['geometry']['text']
assert flag_text['size'] == [2000,1000] and flag_text['unlocked'] and flag_text['bold'] and not flag_text['italic']
for unsupported_text in ('(layer "F.SilkS" knockout) (effects (font (size 1 1)))', '(layer "F.SilkS") (effects (font (size 1 1) (line_spacing 2)))'):
    assert not scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "Special" (at 0 0) ' + unsupported_text + '))')['complete']
for shape in ('gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly', 'gr_curve'):
    # Board and footprint use exactly the same shape kernel and transform once.
    from kicad_review import geometry_shape, parse_sexpr, geometry_point
    node = next(n for n in parse_sexpr('(kicad_pcb ' + SHAPES + ')')[1:] if n[0] == shape) if shape != 'gr_line' else parse_sexpr('(gr_line (start 1 0) (end 2 0) (width .1))')
    local_shape = geometry_shape(node)
    node[0] = shape.replace('gr_', 'fp_')
    world_shape = geometry_shape(node, [10,20,90])
    for a,b in zip(local_shape['segments'], world_shape['segments']):
        expected = [*geometry_point([a[0]/1000,a[1]/1000], [10,20,90]), *geometry_point([a[2]/1000,a[3]/1000], [10,20,90]), a[4]]
        # Cubics transform unrounded points, so a half-um tie can differ from
        # transforming an already rounded local coordinate by one um.
        assert all(abs(x-y) <= (1 if shape == 'gr_curve' else 0) for x,y in zip(b,expected))
print('ok board flattening budgets, cubic error bound, graphic transforms and text flag variants')

# Force the depth guard deterministically; it must choose SVG, not a truncated path.
from unittest.mock import patch
with patch('kicad_review.math.hypot', return_value=1):
    limited = scene_from_text(DRAW_FIXTURE[:-1] + SHAPES[SHAPES.index('(gr_curve'):] + ')')
assert not limited['complete'] and any('depth limit' in w['reason'] for w in limited['warnings'])
assert next(o for o in limited['objects'] if o['uuid'] == 'curve-ok')['geometry'] == {}
concave = scene_from_text(DRAW_FIXTURE[:-1] + '(zone (uuid concave) (layer "F.Cu") (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 4 0) (xy 4 1) (xy 1 1) (xy 1 4) (xy 0 4))))' + ')')
assert concave['complete'] and next(o for o in concave['objects'] if o['changeUuid'] == 'concave')['geometry']['rings'] == [[[0,0],[4000,0],[4000,1000],[1000,1000],[1000,4000],[0,4000]]]
# New child IDs without file UUIDs are deterministic and never alias another child.
no_ids = scene_from_text(DRAW_FIXTURE.replace('(uuid fp)', '(uuid fp)' + FP_DRAW.replace('(uuid fp-line)', '').replace('(uuid fp-label)', '').replace('(uuid value-label)', '').replace('(uuid hidden-property)', '')))
assert len({o['uuid'] for o in no_ids['objects']}) == len(no_ids['objects'])
assert {o['uuid'] for o in no_ids['objects']} >= {'fp/fp_line:1', 'fp/fp_text:1', 'fp/property:1', 'fp/property:2'}
print('ok board cubic depth fallback, concave fill paths and stable drawable child IDs')

# Board scenes are embedded as deduplicated gzip blobs; absence or corruption never breaks the report.
import gzip, base64, contextlib
from kicad_review import add_blob
gblobs = {}
graw = json.dumps(s, separators=(',', ':'), sort_keys=True)
gkey = add_blob(gblobs, graw)
assert add_blob(gblobs, graw) == gkey and len(gblobs) == 1
assert json.loads(gzip.decompress(base64.b64decode(gblobs[gkey]))) == s
gpage = inline_page('window.REVIEW_DATA = {"projects":[],"blobs":{}};')
for asset in ('kicad-colors.js', 'board-gl.js', 'board-diff.js'):
    assert f'src="{asset}"' not in gpage
assert 'KicadColors' in gpage and 'BoardGL' in gpage
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        for side in ("base", "head"):
            write(t, {f"review/G/{side}/erc.json": '{"sheets": []}'})
        pr = {"dir": "G", "name": "G", "status": "modified"}
        patch("kicad_review.project_checks", return_value=[]).start()
        gb = {}
        assert "geometry" not in kr.build_project(pr, gb, kr.DEFAULT_SETTINGS)["board"] and not gb
        write(t, {"base/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        gb = {}
        geo = kr.build_project(pr, gb, kr.DEFAULT_SETTINGS)["board"]["geometry"]
        assert geo["head"] is None and json.loads(gzip.decompress(base64.b64decode(gb[geo["base"]])))["version"] == 1
        write(t, {"head/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        os.remove("base/G/G.kicad_pcb")
        geo = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]["geometry"]
        assert geo["base"] is None and geo["head"]
        write(t, {"head/G/G.kicad_pcb": "(kicad_pcb (layers (x y z)))"})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            bad = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]
        assert "geometry" not in bad and "geometry unavailable" in err.getvalue()
        # Unchanged boards retain both revisions, parsing identical geometry once.
        write(t, {"base/G/G.kicad_pcb": GEOMETRY_FIXTURE, "head/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        same = {}
        with patch("kicad_review.board_geometry", wraps=kr.board_geometry) as parse:
            board = kr.build_project(pr, same, kr.DEFAULT_SETTINGS)["board"]
        assert board["geometry"]["base"] == board["geometry"]["head"] and board["geometry"]["base"]
        assert parse.call_count == 1
        assert board["status"] == "unchanged"
        os.remove("base/G/G.kicad_pcb")
        err = io.StringIO()
        with patch("kicad_review.board_geometry", side_effect=KeyError("unexpected")), contextlib.redirect_stderr(err):
            odd = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]
        assert "geometry" not in odd and "geometry unavailable" in err.getvalue()
    finally:
        patch.stopall()
        os.chdir(old_cwd)
print('ok board scene blobs, added/removed/no/corrupt geometry')

# Production geometry carries typed, revision-aware change identity, not reference guesses.
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        base = GEOMETRY_FIXTURE.replace('(via ', '(footprint "Test:X" (layer "F.Cu") (at 30 30) (uuid other) (property "Reference" "J1")) (via ')
        head = base.replace('(at 10 20 90)', '(at 11 20 90)').replace('(width .25)', '(width .5)')
        head = head.replace('(kicad_pcb ', '(kicad_pcb (setup (pad_to_mask_clearance .1)) ')
        write(t, {"base/G/G.kicad_pcb": base, "head/G/G.kicad_pcb": head})
        blobs = {}
        with patch("kicad_review.project_checks", return_value=[]):
            report = kr.build_project({"dir": "G", "name": "G", "status": "modified"}, blobs, kr.DEFAULT_SETTINGS)
        changes = {r["uuid"]: r for r in report["changes"]}
        assert set(changes) == {"fp", "tr", "meta:setup"}
        for side in ("base", "head"):
            scene = json.loads(gzip.decompress(base64.b64decode(blobs[report["board"]["geometry"][side]])))
            for o in scene["objects"]:
                expected = [changes[o["changeUuid"]]["id"]] if o["changeUuid"] in changes else []
                assert o["changeIds"] == expected, (side, o)
        # Reference-paired regenerated footprint UUIDs must link both revisions explicitly.
        write(t, {"head/G/G.kicad_pcb": head.replace('(uuid fp)', '(uuid new-fp)')})
        with patch("kicad_review.project_checks", return_value=[]):
            second = kr.build_project({"dir": "G", "name": "G", "status": "modified"}, blobs, kr.DEFAULT_SETTINGS, change_offset=len(report["changes"]))
        moved = next(r for r in second["changes"] if r["kind"] == "footprint")
        assert moved["uuid"] == "new-fp" and moved["uuid_before"] == "fp"
        kr.assign_ids([report, second])
        for side in ("base", "head"):
            scene = json.loads(gzip.decompress(base64.b64decode(blobs[second["board"]["geometry"][side]])))
            assert all(o["changeIds"] == [moved["id"]] for o in scene["objects"] if o["changeUuid"] in ("fp", "new-fp"))
            assert all(o["changeIds"] == [] for o in scene["objects"] if o["changeUuid"] in ("vi", "other"))
    finally:
        os.chdir(old_cwd)
print("ok production geometry typed change IDs, unchanged isolation and multi-project IDs")

# SCH6: schematic rendering and styles ship inside the offline report.
page = kr.inline_page('window.REVIEW_DATA={"version":1};')
assert '--sch-paper:#f5f4ef' in page
assert 'function themeSchematic(' in page
assert 'function schematicGridPlan(' in page
assert not re.search(r'<script[^>]+src=["\'](?!data:)', page)
assert not re.search(r'<link[^>]+href=["\'](?:https?:|tokens\.css|review\.css)', page)
print('ok SCH6 offline schematic assets')

# vf-order: physical stack survives scrambled KiCad 10 file IDs and dielectrics.
for count in (4, 6):
    fixture = Path(__file__).parent / "ui" / "fixtures" / f"vf-order-{count}.kicad_pcb"
    text = fixture.read_text()
    expected = ["F.Cu", *[f"In{i}.Cu" for i in range(1, count - 1)], "B.Cu"]
    scene = kr.board_geometry(fixture)
    assert scene["complete"] and scene["copperStack"] == expected, scene
    assert [l["name"] for l in scene["layers"]] == expected[::-1]
    assert len(scene["objects"]) == count
    # Explicit stackup, not file order or enum values, is authoritative.
    swapped = text.replace('(layer "In1.Cu" (type', '(layer "TEMP" (type').replace(
        '(layer "In2.Cu" (type', '(layer "In1.Cu" (type').replace('(layer "TEMP" (type', '(layer "In2.Cu" (type')
    explicit = expected.copy()
    explicit[1], explicit[2] = explicit[2], explicit[1]
    assert scene_from_text(swapped)["copperStack"] == explicit
    # Older boards omit setup; canonical layer names still define the stack.
    legacy = re.sub(r' \(setup \(stackup.*?\)\)\)\n', '', text, flags=re.S)
    assert "(setup" not in legacy
    assert scene_from_text(legacy)["copperStack"] == expected
print("ok vf-order 4/6-layer explicit stackup and legacy physical order")

# A schematic-only review still exports 3D once and retains every board layer.
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        pr = {"dir": "G", "name": "G", "status": "modified"}
        svg = '<svg width="20mm" height="10mm" viewBox="0 0 20 10"><g/></svg>'
        for side in ("base", "head"):
            write(t, {f"{side}/G/G.kicad_pcb": GEOMETRY_FIXTURE,
                      f"review/G/{side}/pcb/G-F_Cu.svg": svg,
                      f"review/G/{side}/pcb/G-B_Cu.svg": svg})
        write(t, {"review/detect.json": json.dumps({"projects": [pr]}),
                  "base/kicad-review.toml": "[3d]\nenabled = true\n"})
        def fake_export(p, side, out):
            write(t, {f"{out}/board.glb": "timestamped model", f"{out}/glb.log": ""})
        with patch("kicad_review.render_side"), patch("kicad_review.export_glb", side_effect=fake_export) as export:
            kr.cmd_render(None)
        assert export.call_count == 1, "identical 3D inputs export once even when board unchanged"
        assert pathlib.Path("review/G/base/board.glb").read_bytes() == pathlib.Path("review/G/head/board.glb").read_bytes()
        with patch("kicad_review.project_checks", return_value=[]):
            board = kr.build_project(pr, {}, kr.load_settings())["board"]
        assert not board["changed"] and board["status"] == "unchanged"
        assert len(board["layers"]) == 2 and board["size"] == [20.0, 10.0]
        assert all(l["svg"]["base"] == l["svg"]["head"] and l["svg"]["base"] for l in board["layers"])
        assert board["model3d"]["base"] == board["model3d"]["head"] and board["model3d"]["enabled"]
        # A local model edit with identical PCB bytes needs separate exports.
        write(t, {"base/G/body.step": "old model", "head/G/body.step": "new model"})
        with patch("kicad_review.render_side"), patch("kicad_review.export_glb", side_effect=fake_export) as export:
            kr.cmd_render(None)
        assert export.call_count == 2, "model-only edits must not share an export"
        for side in ("base", "head"):
            os.remove(f"review/G/{side}/board.glb")
            os.remove(f"review/G/{side}/glb.log")
        with patch("kicad_review.project_checks", return_value=[]):
            failed = kr.build_project(pr, {}, kr.load_settings())["board"]["model3d"]
            disabled = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]
        assert failed["enabled"] and failed["base"] is None and failed["head"] is None
        assert set(failed["errors"]) == {"base", "head"}
        assert "model3d" not in disabled
    finally:
        os.chdir(old_cwd)
print("ok unchanged board full SVG inventory, shared geometry and shared 3D")

# Revision render caches avoid all KiCad exports on a warm run and track settings/tool identity.
import shutil
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        pr = {"dir": "G", "name": "G", "status": "unchanged"}
        write(t, {"review/detect.json": json.dumps({"base": "1"*40, "head": "2"*40, "projects": [pr]}),
                  "base/G/G.kicad_pcb": GEOMETRY_FIXTURE, "head/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        def fake_render(src, name, out, **kw):
            write(t, {f"{out}/drc.json": '{"violations": []}'})
        with patch("kicad_review.render_side", side_effect=fake_render) as render:
            kr.cmd_render(None)
            assert render.call_count == 2
            shutil.rmtree("review/G")
            kr.restore_renders(None)
            assert pathlib.Path("review/G/base/drc.json").exists()
            kr.cmd_render(None)
            assert render.call_count == 2, "warm revision caches must skip all exports"
        assert pathlib.Path("review/G/base/drc.json").exists() and pathlib.Path("review/G/head/drc.json").exists()
        # Library exports compare a pair of commits, unlike standalone board/sheet exports.
        lib_settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
        lib_settings["libraries"]["enabled"] = True
        with patch("kicad_review.load_settings", return_value=lib_settings):
            kr.cache_renders()
            try:
                kr.restore_renders(None)
                raise AssertionError("pair-dependent library exports must not be skipped")
            except SystemExit as exc:
                assert exc.code == 1
    finally:
        os.chdir(old_cwd)
print("ok per-commit project render cache hits retain both revisions")

assert '-e KICAD_IMAGE' in pathlib.Path('.github/workflows/review.yml').read_text(), "host and container cache identity must match"
assert 'restore-renders' in pathlib.Path('.github/workflows/review.yml').read_text(), "warm caches must not pull the KiCad image"
