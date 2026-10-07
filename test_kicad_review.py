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

# S-expression parsing: quoted strings with escapes, nesting.
n = parse_sexpr('(a (b "x \\"y\\" z") (c 1 2))')
assert find(n, "b") == ["b", 'x "y" z'] and find(n, "c") == ["c", "1", "2"]
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
html = inline_page("window.REVIEW_DATA = {\"version\": 1};")
assert 'href="review.css"' not in html and 'src="review.js"' not in html and 'src="sample/' not in html
assert "window.REVIEW_DATA = {\"version\": 1};" in html and "<style>" in html
assert "http://" not in html and "https://fonts" not in html
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
import os, subprocess, sys
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
assert "docs/superpowers" not in js and "docs/superpowers" not in readme and not os.path.exists("docs/superpowers"), "plan doc removed"
assert "window.REVIEW_DATA" in readme, "README documents regenerating the sample"
print("ok")

# Code review fixes (2026-10-07). Each block guards one finding.
import tempfile
from kicad_review import sheet_pages, page_svg

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
          "p/b.kicad_sch": "(kicad_sch " + sheet("Power", "pw.kicad_sch", "u4") + ")", "p/pw.kicad_sch": "(kicad_sch)",
          **{f"out/sch/{f}": "<svg/>" for f in ("H.svg", "H-A: x_y é.svg", "H-A: x_y é-Power.svg", "H-B.svg", "H-B-Power.svg")}})
found = {pg["path"]: page_svg(f"{t}/out", "H", pg) for pg in sheet_pages(f"{t}/p", "H")}
assert found == {"/": f"{t}/out/sch/H.svg", "/u1/": f"{t}/out/sch/H-A: x_y é.svg", "/u1/u3/": f"{t}/out/sch/H-A: x_y é-Power.svg",
                 "/u2/": f"{t}/out/sch/H-B.svg", "/u2/u4/": f"{t}/out/sch/H-B-Power.svg"}, found
# Sibling sheets with one name share one SVG file, so neither drawing can be trusted: stop with a message.
write(t, {"p/H.kicad_sch": "(kicad_sch " + sheet("A", "a.kicad_sch", "u1") + sheet("A", "b.kicad_sch", "u2") + ")"})
try:
    sheet_pages(f"{t}/p", "H")
    raise AssertionError("duplicate sibling sheet names must stop the review")
except SystemExit as e:
    assert "same name" in str(e), e
print("ok")
