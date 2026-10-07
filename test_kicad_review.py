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
