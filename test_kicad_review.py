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
html = inline_page("window.REVIEW_DATA = {\"version\": 1};")
assert 'href="tokens.css"' not in html and 'href="review.css"' not in html and 'src="review.js"' not in html and 'src="sample/' not in html
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
import json, os, subprocess, sys
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

# Reports expose an artifact filename containing the compared revisions and result.
import re
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
from kicad_review import load_settings, build_project, board_changed, export_glb
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
from kicad_review import sch_objects
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
assert detect(commit("HEAD~1"), commit("HEAD")) == [], "DR-S3: unrelated files remain ignored"
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
from kicad_review import sch_objects
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
    files = {"svg": {"P.svg": "<svg/>"}, "gerbers": {"P-F_Cu.gbr": "copper"}, "drill": {"P.drl": "drill"}}
    if kind in files:
        out.mkdir(parents=True, exist_ok=True)
        for name, text in files[kind].items(): (out / name).write_text(text, encoding="utf-8")
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(positions if kind == "pos" else bom if kind == "bom" else "{}", encoding="utf-8")
    return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
kicad_review.subprocess.run = fake_cli
try:
    render_side(f"{t}/P", "P", f"{t}/render")
    assert calls == [
        ["kicad-cli", "sch", "export", "svg", "--exclude-drawing-sheet", "--no-background-color", "-o", f"{t}/render/sch", f"{t}/P/P.kicad_sch"],
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
print("ok")

