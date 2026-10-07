#!/usr/bin/env python3
"""KiCad review: compare two revisions of the KiCad projects in a git repository.

Standard library only. Subcommands are called from the reusable workflow.
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import posixpath
import re
import subprocess
import sys

ZERO_SHA = "0" * 40
# Files that change what KiCad renders or checks. .kicad_prl is per-user UI state, so it is left out.
KICAD_SUFFIXES = (".kicad_sch", ".kicad_pcb", ".kicad_pro", ".kicad_sym", ".kicad_mod", ".kicad_dru", ".kicad_wks")
KICAD_NAMES = ("sym-lib-table", "fp-lib-table")
SETTINGS_FILE = "kicad-review.toml"


def git(*args, check=True):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip() if r.returncode == 0 else None


def commit(rev):
    """Resolve a commit, branch or tag name to a full SHA, or None."""
    for candidate in (rev, f"origin/{rev}"):
        sha = git("rev-parse", "--verify", "--quiet", f"{candidate}^{{commit}}", check=False)
        if sha:
            return sha
    return None


def is_kicad_file(path):
    name = posixpath.basename(path)
    return name.endswith(KICAD_SUFFIXES) or name in KICAD_NAMES


def resolve_revisions(env):
    """Return (base, head, reason) for the triggering event. base may be None (nothing to compare with)."""
    event = env["EVENT"]
    if event == "pull_request":
        head = env["PR_HEAD"]
        return git("merge-base", env["PR_BASE"], head), head, "pull request head vs merge base"
    if event == "workflow_dispatch":
        base, head = commit(env["IN_BASE"]), commit(env["IN_HEAD"])
        if not base or not head:
            sys.exit(f"Cannot resolve revisions: base={env['IN_BASE']!r} head={env['IN_HEAD']!r}")
        return base, head, "revisions given by hand"
    head = env["AFTER"]
    before = env.get("BEFORE") or ZERO_SHA
    if before != ZERO_SHA and commit(before):
        return before, head, "push: new commit vs previous branch tip"
    # New branch, or the old tip is gone after a force push: compare with where it left the default branch.
    base = git("merge-base", f"origin/{env['DEFAULT_BRANCH']}", head, check=False)
    if base and base != head:
        return base, head, "new or force-pushed branch vs default branch"
    parent = commit(f"{head}^")
    return parent, head, "previous commit" if parent else "first commit"


def projects_at(rev):
    """Directories holding a .kicad_pro at rev, mapped to the project file path."""
    if not rev:
        return {}
    files = git("ls-tree", "-r", "--name-only", rev).splitlines()
    return {posixpath.dirname(f): f for f in files if f.endswith(".kicad_pro")}


def owner_project(path, project_dirs):
    """The deepest project directory containing path, or None."""
    best = None
    for d in project_dirs:
        if (d == "" or path.startswith(d + "/")) and (best is None or len(d) > len(best)):
            best = d
    return best


def detect(base, head):
    base_projects, head_projects = projects_at(base), projects_at(head)
    dirs = set(base_projects) | set(head_projects)
    if base:
        changed = git("diff", "--name-only", "--no-renames", base, head).splitlines()
    else:
        changed = git("ls-tree", "-r", "--name-only", head).splitlines()
    settings_changed = SETTINGS_FILE in changed
    by_project = {}
    for f in changed:
        if is_kicad_file(f):
            d = owner_project(f, dirs)
            if d is not None:
                by_project.setdefault(d, []).append(f)
    if settings_changed:  # settings change can alter checks for every project
        for d in head_projects:
            by_project.setdefault(d, [])
    projects = []
    for d in sorted(by_project):
        status = "added" if d not in base_projects else "removed" if d not in head_projects else "modified"
        pro = head_projects.get(d) or base_projects[d]
        projects.append({
            "dir": d,
            "name": posixpath.basename(pro)[: -len(".kicad_pro")],
            "status": status,
            "changed_files": sorted(by_project[d]),
        })
    return projects


def cmd_detect(args):
    env = dict(os.environ)
    base, head, reason = resolve_revisions(env)
    projects = detect(base, head)
    result = {"base": base, "head": head, "reason": reason, "projects": projects}
    os.makedirs(posixpath.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(result, fh, indent=2)
    with open(env.get("GITHUB_OUTPUT", os.devnull), "a") as fh:
        fh.write(f"base={base or ''}\nhead={head}\nchanged={'true' if projects else 'false'}\n")
    lines = [
        "## KiCad review",
        "",
        f"Comparing `{(base or 'nothing')[:9]}` → `{head[:9]}` ({reason}).",
        "",
    ]
    if not projects:
        lines.append("No KiCad files changed. Nothing to review.")
    for p in projects:
        lines.append(f"- **{p['name']}** (`{p['dir'] or '.'}`, {p['status']}): "
                     + ", ".join(f"`{posixpath.relpath(f, p['dir'] or '.')}`" for f in p["changed_files"]))
    summary = "\n".join(lines) + "\n"
    with open(env.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as fh:
        fh.write(summary)
    print(summary)


def project_id(d):
    return d.replace("/", "__") or "_root"


def kicad_cli(*args):
    r = subprocess.run(["kicad-cli", *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"kicad-cli {' '.join(args)} failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
    return r


def board_layers(pcb_path):
    """Layer names declared in the board's (layers ...) block, in KiCad order."""
    names, inside = [], False
    with open(pcb_path) as fh:
        for line in fh:
            s = line.strip()
            if s == "(layers":
                inside = True
            elif inside and s == ")":
                break
            elif inside and s.startswith("("):
                names.append(s.split('"')[1])
    return names


def render_side(src_dir, name, out):
    """SVG renders of one revision of one project. Returns {"sch": [...], "pcb": [...]} of paths relative to out."""
    files = {"sch": [], "pcb": []}
    sch, pcb = f"{src_dir}/{name}.kicad_sch", f"{src_dir}/{name}.kicad_pcb"
    if os.path.exists(sch):
        kicad_cli("sch", "export", "svg", "--exclude-drawing-sheet", "--no-background-color", "-o", f"{out}/sch", sch)
        files["sch"] = sorted(f"sch/{f}" for f in os.listdir(f"{out}/sch"))
    if os.path.exists(pcb):
        # Drill marks off: with them every layer, even an empty one, is full of holes.
        # Page-size mode 1 keeps page coordinates (mm from the page origin), so both revisions overlay exactly.
        kicad_cli("pcb", "export", "svg", "--mode-multi", "--exclude-drawing-sheet", "--page-size-mode", "1",
                  "--drill-shape-opt", "0", "-l", ",".join(board_layers(pcb)), "-o", f"{out}/pcb", pcb)
        files["pcb"] = sorted(f"pcb/{f}" for f in os.listdir(f"{out}/pcb"))
    return files


def cmd_render(args):
    with open(args.detect) as fh:
        det = json.load(fh)
    for p in det["projects"]:
        out = f"{args.out}/{project_id(p['dir'])}"
        manifest = {"project": p, "sides": {}}
        for side in ("base", "head"):
            if (side == "base" and p["status"] == "added") or (side == "head" and p["status"] == "removed"):
                continue
            manifest["sides"][side] = render_side(posixpath.join(side, p["dir"]), p["name"], f"{out}/{side}")
        with open(f"{out}/manifest.json", "w") as fh:
            json.dump(manifest, fh, indent=2)
        print(f"{p['name']}: " + ", ".join(f"{s} {len(v['sch'])} sheet(s) {len(v['pcb'])} layer(s)"
                                          for s, v in manifest["sides"].items()))


TOKEN = re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))')


def parse_sexpr(text):
    """KiCad S-expression text to nested lists of strings."""
    stack = [[]]
    for m in TOKEN.finditer(text):
        if m.group(1):
            stack.append([])
        elif m.group(2):
            node = stack.pop()
            stack[-1].append(node)
        elif m.group(3) is not None:
            stack[-1].append(re.sub(r"\\(.)", lambda e: "\n" if e.group(1) == "n" else e.group(1), m.group(3)))
        elif m.group(4):
            stack[-1].append(m.group(4))
    return stack[0][0]


def findall(node, key):
    return [c for c in node[1:] if isinstance(c, list) and c and c[0] == key]


def find(node, key):
    found = findall(node, key)
    return found[0] if found else None


def sheet_pages(proj_dir, name):
    """Schematic pages in hierarchy order: [{path, name, file, parent}]. path is the sheet UUID path."""
    pages = []

    def walk(file, path, sheet_name, parent, depth):
        pages.append({"path": path, "name": sheet_name, "file": file, "parent": parent})
        full = posixpath.join(proj_dir, file)
        if depth > 32 or not os.path.exists(full):
            return
        with open(full) as fh:
            root = parse_sexpr(fh.read())
        for s in findall(root, "sheet"):
            props = {p[1]: p[2] for p in findall(s, "property") if len(p) > 2}
            walk(props.get("Sheetfile", ""), f"{path}{find(s, 'uuid')[1]}/", props.get("Sheetname", "?"), path, depth + 1)

    if os.path.exists(posixpath.join(proj_dir, f"{name}.kicad_sch")):
        walk(f"{name}.kicad_sch", "/", name, None, 0)
    return pages


def page_svg(out_dir, name, page):
    """The SVG kicad-cli wrote for a page: <project>.svg for the root, <project>-<sheet name>.svg otherwise."""
    if page["parent"] is None:
        return f"{out_dir}/sch/{name}.svg"
    for candidate in (page["name"], re.sub(r'[\\/:*?"<>|]', "_", page["name"])):
        if os.path.exists(f"{out_dir}/sch/{name}-{candidate}.svg"):
            return f"{out_dir}/sch/{name}-{candidate}.svg"
    return None  # ponytail: two sheets with the same name collide in kicad-cli output; first one wins


def svg_body(path):
    """SVG text without the export timestamp, so identical drawings compare equal."""
    if not path or not os.path.exists(path):
        return None
    with open(path) as fh:
        return re.sub(r"<title>.*?</title>", "", fh.read(), count=1, flags=re.S)


def svg_size(text):
    w, h = re.search(r'viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"', text).groups()
    return [float(w), float(h)]


def has_drawing(text):
    return re.search(r"<(path|polyline|polygon|circle|rect|line|ellipse|text)\b", text) is not None


class Blobs(dict):
    """gzip+base64 SVG store, deduplicated by content."""

    def add(self, text):
        if text is None:
            return None
        key = hashlib.sha1(text.encode()).hexdigest()[:12]
        if key not in self:
            self[key] = base64.b64encode(gzip.compress(text.encode(), mtime=0)).decode()
        return key


def build_project(p, review_dir, blobs):
    out = f"{review_dir}/{project_id(p['dir'])}"
    sides = [s for s in ("base", "head") if os.path.isdir(f"{out}/{s}")]
    pages = {}
    for side in sides:
        for pg in sheet_pages(posixpath.join(side, p["dir"]), p["name"]):
            entry = pages.setdefault(pg["path"], {**pg, "svg": {}})
            entry["svg"][side] = svg_body(page_svg(f"{out}/{side}", p["name"], pg))
    sheets = []
    for pg in pages.values():
        texts = pg.pop("svg")
        b, h = texts.get("base"), texts.get("head")
        pg["status"] = "added" if b is None and h else "removed" if h is None and b else "modified" if b != h else "unchanged"
        if pg["status"] != "unchanged":
            pg["size"] = svg_size(h or b)
            pg["svg"] = {"base": blobs.add(b), "head": blobs.add(h)}
        sheets.append(pg)
    layers, changed = [], False
    names = sorted({posixpath.basename(f) for s in sides for f in os.listdir(f"{out}/{s}/pcb")}
                   if any(os.path.isdir(f"{out}/{s}/pcb") for s in sides) else [])
    for f in names:
        b, h = (svg_body(f"{out}/{s}/pcb/{f}") for s in ("base", "head"))
        changed |= b != h
        if any(t and has_drawing(t) for t in (b, h)):
            layers.append({"name": f[len(p["name"]) + 1: -4], "base": b, "head": h})
    has = {s: any(l[s] for l in layers) for s in ("base", "head")}
    board = {"changed": changed, "layers": [],
             "status": "added" if not has["base"] else "removed" if not has["head"] else "modified"}
    if changed:
        board["size"] = svg_size(next(t for l in layers for t in (l["head"], l["base"]) if t))
        board["layers"] = [{"name": l["name"], "svg": {"base": blobs.add(l["base"]), "head": blobs.add(l["head"])}}
                           for l in layers]
    return {"name": p["name"], "dir": p["dir"], "status": p["status"], "sheets": sheets, "board": board}


def cmd_report(args):
    with open(args.detect) as fh:
        det = json.load(fh)
    blobs = Blobs()
    env = os.environ
    data = {
        "repo": env.get("GITHUB_REPOSITORY", ""),
        "run_url": f"{env.get('GITHUB_SERVER_URL', '')}/{env.get('GITHUB_REPOSITORY', '')}/actions/runs/{env.get('GITHUB_RUN_ID', '')}"
                   if env.get("GITHUB_RUN_ID") else "",
        "base": det["base"], "head": det["head"], "reason": det["reason"],
        "projects": [build_project(p, args.review, blobs) for p in det["projects"]],
    }
    data["blobs"] = blobs
    with open(posixpath.join(posixpath.dirname(os.path.abspath(__file__)), "report.html")) as fh:
        template = fh.read()
    html = template.replace("/*DATA*/", json.dumps(data, separators=(",", ":")).replace("</", "<\\/"))
    with open(args.out, "w") as fh:
        fh.write(html)
    print(f"{args.out}: {len(html) / 1e6:.2f} MB, {len(blobs)} embedded drawings")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(required=True)
    p = sub.add_parser("detect", help="resolve base/head and list changed KiCad projects")
    p.add_argument("--out", default="review/detect.json")
    p.set_defaults(func=cmd_detect)
    p = sub.add_parser("render", help="SVG renders of both revisions (run inside the KiCad container)")
    p.add_argument("--detect", default="review/detect.json")
    p.add_argument("--out", default="review")
    p.set_defaults(func=cmd_render)
    p = sub.add_parser("report", help="self-contained HTML comparison report")
    p.add_argument("--detect", default="review/detect.json")
    p.add_argument("--review", default="review")
    p.add_argument("--out", default="review/kicad-review.html")
    p.set_defaults(func=cmd_report)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
