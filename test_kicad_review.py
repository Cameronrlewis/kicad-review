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

# TS-S1: CI exercises default, real 3D and unchanged two-project pages without extra installs.
test_wf = pathlib.Path(".github/workflows/test.yml").read_text(encoding="utf-8")
assert "uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0" in test_wf and "node-version: 22" in test_wf and test_wf.index("actions/setup-node@") < test_wf.index("- run: node"), "TS-S1 Node 22 before browser tests"
assert "google-chrome" in test_wf and "CHROME" in test_wf and "inline_page" in test_wf, "TS-S1 CI browser setup"
for command in ('node ui/check.mjs', 'node ui/check.mjs --dark', 'node ui/check.mjs --no-skip "selection-only address"', 'node ui/check.mjs --no-skip "pasted selection address preserves an explicit position"', 'node ui/check.mjs --no-skip "passing checks with baseline findings"', 'node ui/check.mjs --no-skip 3D --page "$PAGES/3d.html"', 'node ui/check.mjs --no-skip 3D --dark --page "$PAGES/3d.html"', 'node ui/check.mjs --no-skip "unchanged sheet" --page "$PAGES/two.html"', 'node ui/check.mjs --no-skip "unchanged project" --page "$PAGES/two.html"', 'node ui/check.mjs --no-skip "Parts fixture" --page "$PAGES/parts.html"', 'node ui/check.mjs --no-skip "Parts fixture" --dark --page "$PAGES/parts.html"'):
    assert "      - run: " + command in test_wf.splitlines(), "TS-S1 CI missing " + command
assert "    runs-on: ubuntu-24.04\n    timeout-minutes: 40\n" in test_wf and test_wf.count("timeout-minutes:") == 1, "TS-S1 CI job timeout missing or duplicated"
assert "npm install" not in test_wf and "apt-get" not in test_wf, "TS-S1 no extra installs"
print("ok TS-S1 CI browser matrix")
print("ok")

# Parts lines: group by value+footprint+LCSC, normalise LCSC, flag missing numbers and conflicts.
from kicad_review import parts_lines
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
                data = json.loads(pathlib.Path("review/data.json").read_text())
                p = data["projects"][0]
                assert ("parts" in data["settings"]) == ("parts" in p) == parts_enabled
                assert ("3d" in data["settings"]) == models_enabled
                if parts_enabled:
                    lines = {s: parts_lines(objects[s]) for s in ("base", "head")}
                    assert p["parts"] == {"lines": lines["head"], "changes": diff_parts(lines["base"], lines["head"]), "supplier": None}
                    assert p["parts"]["changes"][0]["action"] == "swapped"
                html = pathlib.Path("review/kicad-review.html").read_text()
                payload = html.split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0]
                embedded = json.loads(payload)
                del embedded["blobs"]
                assert embedded == data
        settings["parts"]["enabled"] = True
        with patch("kicad_review.project_objects", return_value={}):
            assert build_project(project, {}, settings)["parts"] == {"lines": [], "changes": [], "supplier": None}
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
assert "JLCPCB data as of 2026-10-08T14:02:00Z." in parts_markdown({"projects": [p]})
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

# Threads: object index for anchoring. Head objects first; base-only objects keep their base position.
from kicad_review import object_index, load_settings
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
assert t1_by["head", "symbol", "R1"] == {"uuid": "s1", "kind": "symbol", "ref": "R1", "value": "10k", "side": "head",
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

import os, tempfile
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
        assert load_settings()["threads"] == {"enabled": True}
    finally:
        os.chdir(_cwd)
from kicad_review import DEFAULT_SETTINGS
assert DEFAULT_SETTINGS["threads"] == {"enabled": False}
print("ok threads settings")

# Threads: anchors in comment bodies and the summary line.
import base64 as _b64, json as _json
from kicad_review import thread_anchor, thread_counts, comment_markdown
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

