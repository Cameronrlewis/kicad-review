#!/usr/bin/env python3
"""KiCad review: compare two revisions of the KiCad projects in a git repository.

Standard library only. Subcommands are called from the reusable workflow.
"""
import filecmp
import shutil
import argparse
import datetime
import http.client
import time
import urllib.error
import urllib.parse
import urllib.request
import base64
import csv
import datetime
import gzip
import hashlib
import importlib.util
import io
import json
import math
import os
import pathlib
import posixpath
import re
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from collections import Counter
from urllib.parse import urlsplit

# Files that change what KiCad renders or checks. .kicad_prl is per-user UI state, so it is left out.
KICAD_SUFFIXES = (".kicad_sch", ".kicad_pcb", ".kicad_pro", ".kicad_sym", ".kicad_mod", ".kicad_dru", ".kicad_wks")
KICAD_NAMES = ("sym-lib-table", "fp-lib-table")
SETTINGS_FILE = "kicad-review.toml"


def git(*args, check=True):
    r = subprocess.run(["git", "-c", "core.quotePath=false", *args], capture_output=True, text=True)
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


def is_junk(path):
    """macOS archive leftovers: __MACOSX folders and ._ AppleDouble files look like KiCad files but are not."""
    return "__MACOSX" in path.split("/") or posixpath.basename(path).startswith("._")


def is_kicad_file(path):
    name = posixpath.basename(path)
    return (name.endswith(KICAD_SUFFIXES) or name in KICAD_NAMES) and not is_junk(path)


def resolve_revisions(env):
    """Return (base, head, reason) for the triggering event. base may be None (nothing to compare with)."""
    if env.get("TAG"):
        tag = env["TAG"]
        prev = git("describe", "--tags", "--abbrev=0", "--match", "v*", f"{tag}^", check=False) or None
        head = commit(tag) or env["AFTER"]
        return (commit(prev) if prev else None), head, f"release {tag} vs {prev}" if prev else f"release {tag} (first release)"
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
    before = env.get("BEFORE", "")
    if before.strip("0") and commit(before):  # all zeros: the branch is new
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
    pros = [f for f in files if f.endswith(".kicad_pro") and not is_junk(f)]
    dirs = [posixpath.dirname(f) for f in pros]
    if len(set(dirs)) < len(dirs):
        sys.exit(f"Multiple .kicad_pro files in {next(d or '.' for d in dirs if dirs.count(d) > 1)!r}; KiCad allows one project per directory")
    return {posixpath.dirname(f): f for f in pros}


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
    settings_changed = SETTINGS_FILE in changed or any(is_kicad_file(f) and owner_project(f, dirs) is None for f in changed)
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
    for d in sorted(dirs, key=lambda d: (d not in by_project, d)):
        status = "removed" if d not in head_projects else "added" if d not in base_projects or base_projects[d] != head_projects[d] else "modified" if d in by_project else "unchanged"
        pro = head_projects.get(d) or base_projects[d]
        projects.append({
            "dir": d,
            "name": posixpath.basename(pro)[: -len(".kicad_pro")],
            "status": status,
        })
    return projects


def cmd_detect(args):
    env = dict(os.environ)
    if env.get("TAG"):
        try:
            review = load_settings(("",))["release"]["review"]
        except (SystemExit, tomllib.TOMLDecodeError, OSError):
            print("::warning::Cannot read tag review settings; tag review stays off.")
            review = False
        if not review:
            with open(env.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as fh:
                fh.write("base=\nhead=\nchanged=false\n")
            print("Tag review is off ([release] review = false); only fabrication outputs are made.")
            return
    base, head, reason = resolve_revisions(env)
    projects = detect(base, head)
    ids = [project_id(p["dir"]) for p in projects]
    if len(set(ids)) < len(ids):
        sys.exit("Detected project ids collide; rename one project directory")
    result = {"base": base, "head": head, "reason": reason, "projects": projects}
    os.makedirs("../review", exist_ok=True)  # runs inside the project checkout
    with open("../review/detect.json", "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
    with open(env.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as fh:
        fh.write(f"base={base or ''}\nhead={head}\nchanged={'true' if projects else 'false'}\n")
    print(f"Comparing {base} -> {head} ({reason})")
    for p in projects:
        print(f"  {p['name']} ({p['dir'] or '.'}, {p['status']})")
    if not projects:  # changed runs get their summary from the summary step
        with open(env.get("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as fh:
            fh.write("No KiCad files changed. Nothing to review.\n")


def project_id(d):
    return d.replace("/", "__") or "_root"


def kicad_cli(*args):
    r = subprocess.run(["kicad-cli", *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"kicad-cli {' '.join(args)} failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")


def board_layers(pcb_path):
    """Layer names declared in the board's (layers ...) block, in KiCad order."""
    names, inside = [], False
    with open(pcb_path, encoding="utf-8") as fh:
        for line in fh:
            s = line.strip()
            if s == "(layers":
                inside = True
            elif inside and s == ")":
                break
            elif inside and s.startswith("("):
                names.append(s.split('"')[1])
    return names


def render_side(src_dir, name, out, netlist=False):
    """SVG renders, ERC and DRC reports of one revision of one project."""
    sch, pcb = f"{src_dir}/{name}.kicad_sch", f"{src_dir}/{name}.kicad_pcb"
    if os.path.exists(sch):
        kicad_cli("sch", "export", "svg", "--no-background-color", "-o", f"{out}/sch", sch)
        kicad_cli("sch", "erc", "--format", "json", "--severity-all", "-o", f"{out}/erc.json", sch)
        if netlist:
            kicad_cli("sch", "export", "netlist", "--format", "kicadsexpr", "-o", f"{out}/netlist.net", sch)
    if os.path.exists(pcb):
        # Drill marks off: with them every layer, even an empty one, is full of holes.
        # Page-size mode 1 keeps page coordinates (mm from the page origin), so both revisions overlay exactly.
        kicad_cli("pcb", "export", "svg", "--mode-multi", "--exclude-drawing-sheet", "--page-size-mode", "1",
                  "--drill-shape-opt", "0", "-l", ",".join(board_layers(pcb)), "-o", f"{out}/pcb", pcb)
        parity = ["--schematic-parity"] if os.path.exists(sch) else []
        kicad_cli("pcb", "drc", "--format", "json", "--severity-all", *parity, "-o", f"{out}/drc.json", pcb)


def board_path(p, side):
    return posixpath.join(side, p["dir"], f"{p['name']}.kicad_pcb")


def board_changed(p):
    """Whether the project's board bytes differ between the two checked-out revisions."""
    paths = [board_path(p, side) for side in ("base", "head")]
    contents = [pathlib.Path(path).read_bytes() if os.path.exists(path) else None for path in paths]
    return contents[0] != contents[1]


def glb_inputs(p, side):
    """Board plus repository model assets; model-only edits must not reuse old exports."""
    pcb = pathlib.Path(board_path(p, side))
    if not pcb.is_file():
        return None
    models = sorted(path for path in pathlib.Path(side).rglob("*")
                    if path.is_file() and path.suffix.lower() in (".step", ".stp", ".wrl", ".glb", ".gz"))
    return (pcb.read_bytes(), [(str(path.relative_to(side)), path.read_bytes()) for path in models])


def export_glb(p, side, out):
    """Best-effort 3D export. Its output is useful evidence when a footprint model is absent."""
    pcb, log = board_path(p, side), f"{out}/glb.log"
    if not os.path.exists(pcb):
        return
    try:
        r = subprocess.run(["kicad-cli", "pcb", "export", "glb", "--include-silkscreen", "--include-soldermask",
                            "--output", f"{out}/board.glb", pcb], capture_output=True, text=True)
        output = r.stdout + r.stderr  # KiCad 10.0.0 writes missing-model warnings to stdout.
    except OSError as e:
        r, output = None, str(e)
    with open(log, "w", encoding="utf-8") as fh:
        fh.write(output)
    if r is None or r.returncode:
        print(f"{p['name']}: 3D export failed for {side}; see {log}")


def render_cache(p, side, det, settings):
    """Revision/project/tool/settings identity; outputs remain independent of report change IDs."""
    revision = det.get(side) or ""
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        return None
    identity = pathlib.Path(__file__).read_bytes() + json.dumps(settings, sort_keys=True).encode() + os.environ.get("KICAD_IMAGE", "local").encode()
    return pathlib.Path(".render-cache") / revision / project_id(p["dir"]) / hashlib.sha256(identity).hexdigest()[:16]


def restore_renders(args=None):
    """Use complete revision caches without starting/downloading the KiCad container."""
    det = json.loads(pathlib.Path("review/detect.json").read_text())
    settings = load_settings()
    # Library drawings are selected by the compared pair, not the revision alone.
    if settings["libraries"]["enabled"]:
        raise SystemExit(1)
    entries = [(p, side, render_cache(p, side, det, settings)) for p in det["projects"]
               for side in ("base", "head")
               if not (side == "base" and p["status"] == "added" or side == "head" and p["status"] == "removed")]
    if any(not cache or not (cache / ".complete").is_file() for p, side, cache in entries):
        raise SystemExit(1)
    for p, side, cache in entries:
        shutil.copytree(cache, f"review/{project_id(p['dir'])}/{side}", dirs_exist_ok=True)
        print(f"{p['name']}: {side} render cache hit ({det[side]})")


def cache_renders(args=None):
    """Snapshot final outputs, including workflow-compressed GLBs."""
    det = json.loads(pathlib.Path("review/detect.json").read_text())
    settings = load_settings()
    for p in det["projects"]:
        for side in ("base", "head"):
            cache = render_cache(p, side, det, settings)
            out = pathlib.Path(f"review/{project_id(p['dir'])}/{side}")
            if cache and out.is_dir():
                shutil.copytree(out, cache, dirs_exist_ok=True)
                (cache / ".complete").write_text("complete")


def cmd_render(args):
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    settings = load_settings()
    for p in det["projects"]:
        export_3d = settings["3d"]["enabled"]
        shared_3d = export_3d and glb_inputs(p, "base") == glb_inputs(p, "head")
        for side in ("base", "head"):
            if (side == "base" and p["status"] == "added") or (side == "head" and p["status"] == "removed"):
                continue
            out = f"review/{project_id(p['dir'])}/{side}"
            cache = render_cache(p, side, det, settings)
            if cache and (cache / ".complete").is_file():
                shutil.copytree(cache, out, dirs_exist_ok=True)
                print(f"{p['name']}: {side} render cache hit ({det[side]})")
                continue
            render_side(posixpath.join(side, p["dir"]), p["name"], out, netlist=settings["checks"].get("interfaces", "off") != "off")
            if export_3d:
                if side == "head" and shared_3d:
                    os.makedirs(out, exist_ok=True)
                    for name in ("board.glb", "glb.log"):
                        source = f"review/{project_id(p['dir'])}/base/{name}"
                        if os.path.isfile(source):
                            shutil.copyfile(source, f"{out}/{name}")
                else:
                    export_glb(p, side, out)
            if settings["checks"].get("release", "off") != "off":
                pro = posixpath.join(side, p["dir"], f"{p['name']}.kicad_pro")
                if os.path.exists(pro):
                    os.makedirs(f"{out}/fab", exist_ok=True)
                    release_project(pro, "review", settings, f"{out}/fab", p["name"])
            print(f"{p['name']}: rendered {side}")
        if settings["libraries"]["enabled"]:
            roots = {side: posixpath.join(side, p["dir"]) for side in ("base", "head")}
            items = {side: library_items(root) for side, root in roots.items()}
            for c in library_changes(items["base"], items["head"]):
                for side in ("base", "head"):
                    source = items[side].get((c["lib"], c["item"], c["kind"]))
                    if source is None:
                        continue
                    lib = posixpath.join(roots[side], source["file"])
                    dest = f"review/{project_id(p['dir'])}/{side}/lib"
                    os.makedirs(dest, exist_ok=True)
                    with tempfile.TemporaryDirectory() as tmp:
                        args = (["sym", "export", "svg", f"--symbol={c['item']}", "-o", tmp, lib] if c["kind"] == "symbol"
                                else ["fp", "export", "svg", f"--footprint={c['item']}", "-o", tmp, posixpath.dirname(lib)])
                        try:
                            r = subprocess.run(["kicad-cli", *args], capture_output=True, text=True)
                            made = sorted(pathlib.Path(tmp).glob("*.svg"), key=lambda path: natural(path.name))
                            if r.returncode or not made:
                                raise OSError("no SVG exported")
                            # ponytail: unit 1 drawing; compare all units' pins, add unit views when requested.
                            pathlib.Path(f"{dest}/{lib_slug(c)}.svg").write_bytes(made[0].read_bytes())
                        except OSError:
                            print(f"::warning::No drawing for library item {c['lib']}:{c['item']} ({side})")

    cache_renders()


TOKEN = re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))')


class Quoted(str):
    """A quoted S-expression token, with normal string equality and serialization."""


def is_net_number(token):
    return not isinstance(token, Quoted) and token.isdigit()


def parse_sexpr(text):
    """KiCad S-expression text to nested lists of strings, preserving quoted tokens."""
    stack = [[]]
    for m in TOKEN.finditer(text):
        if m.group(1):
            stack.append([])
        elif m.group(2):
            node = stack.pop()
            stack[-1].append(node)
        elif m.group(3) is not None:
            stack[-1].append(Quoted(re.sub(r"\\(.)", lambda e: "\n" if e.group(1) == "n" else e.group(1), m.group(3))))
        elif m.group(4):
            stack[-1].append(m.group(4))
    return stack[0][0]


def findall(node, key):
    return [c for c in node[1:] if isinstance(c, list) and c and c[0] == key]


def find(node, key):
    found = findall(node, key)
    return found[0] if found else None


def sheet_instance_page(node, project, parent_uuid_path):
    """Resolve a child sheet's page for this project and parent UUID path."""
    for entry in findall(find(node, "instances") or [], "project"):
        if entry[1] != project:
            continue
        for path in findall(entry, "path"):
            if path[1].rstrip("/") == parent_uuid_path.rstrip("/"):
                page = find(path, "page")
                if page and len(page) > 1 and str(page[1]).strip():
                    return str(page[1])
    return None


def sheet_pages(proj_dir, name):
    """Schematic pages in hierarchy order, with instance page numbers and UUID paths."""
    root_file = posixpath.join(proj_dir, f"{name}.kicad_sch")
    if not os.path.exists(root_file):
        return []
    with open(root_file, encoding="utf-8") as fh:
        root = parse_sexpr(fh.read())
    root_uuid = (find(root, "uuid") or ["", ""])[1]
    legacy = {}
    for instance in findall(find(root, "sheet_instances") or [], "path"):
        page = find(instance, "page")
        if page and len(page) > 1 and str(page[1]).strip():
            legacy[instance[1].rstrip("/") or "/"] = str(page[1])
    pages = []

    # stem: the file name kicad-cli gives the page's SVG, the sheet names along its path joined by "-".
    def walk(file, path, sheet_name, parent, depth, stem, page=None):
        pages.append({"path": path, "name": sheet_name, "file": file, "parent": parent, "stem": stem,
                      "page": page or legacy.get(path.rstrip("/") or "/") or str(len(pages) + 1)})
        full = posixpath.join(proj_dir, file)
        if depth > 32 or not os.path.exists(full):
            return
        with open(full, encoding="utf-8") as fh:
            node = parse_sexpr(fh.read())
        names = set()
        for s in findall(node, "sheet"):
            props = properties(s)
            child = props.get("Sheetname", "?")
            if child in names:
                sys.exit(f"{file} has two sheets with the same name {child!r}; kicad-cli renders both to one file, "
                         "so neither drawing can be shown. Rename one of them.")
            names.add(child)
            safe = re.sub(r"[\\/]", "_", child)
            child_path = f"{path}{find(s, 'uuid')[1]}/"
            parent_uuid_path = f'/{root_uuid}{path.rstrip("/")}'
            child_page = sheet_instance_page(s, name, parent_uuid_path)
            walk(posixpath.normpath(posixpath.join(posixpath.dirname(file), props.get("Sheetfile", ""))),
                 child_path, child, path, depth + 1, f"{stem}-{safe}", child_page)

    walk(f"{name}.kicad_sch", "/", name, None, 0, name)
    return pages


# ---- Object model: every reviewable object as {kind, ref, props, pos, box, where}, keyed by UUID. ----

def val(node, key, default=None):
    n = find(node, key) if node else None
    return n[1] if n and len(n) > 1 else default


def num(s):
    """Format a KiCad number without float noise: '10.160000' -> '10.16'."""
    try:
        return f"{float(s):.4f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return s


def at(node):
    a = find(node, "at")
    return [float(v) for v in a[1:4] if re.match(r"^-?[\d.]+$", v)] if a else None


def fmt_at(a):
    if not a:
        return None
    return f"({num(a[0])}, {num(a[1])})" + (f" {num(a[2])}°" if len(a) > 2 and float(a[2]) else "")


def points(node):
    pts = find(node, "pts")
    return [(float(p[1]), float(p[2])) for p in findall(pts, "xy")] if pts else []


def box_of(pts, pad=0.5):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad] if pts else None


def properties(node):
    return {p[1]: p[2] for p in findall(node, "property") if len(p) > 2}


def flatten(obj, prefix=""):
    """JSON settings to dotted keys. Lists of named dicts are keyed by name, so reordering is not a change."""
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}{k}."))
    elif isinstance(obj, list) and obj and all(isinstance(v, dict) and "name" in v for v in obj):
        for v in obj:
            out.update(flatten(v, f"{prefix}{v['name']}."))
    elif isinstance(obj, list) and any(isinstance(v, (dict, list)) for v in obj):
        for i, v in enumerate(obj):
            out.update(flatten(v, f"{prefix}{i}."))
    else:
        out[prefix.rstrip(".")] = json.dumps(obj) if isinstance(obj, list) else str(obj)
    return out


def title_block(root, where):
    tb = find(root, "title_block")
    if not tb:
        return {}
    props = {c[0] if c[0] != "comment" else f"comment {c[1]}": c[-1] for c in tb[1:] if isinstance(c, list)}
    return {f"meta:title_block:{where}": {"kind": "title block", "ref": where, "props": props, "where": None}}


def sch_objects(proj_dir, name):
    objs = {}
    root_uuid = None
    for page in sheet_pages(proj_dir, name):
        full = posixpath.join(proj_dir, page["file"])
        if not os.path.exists(full):
            continue
        with open(full, encoding="utf-8") as fh:
            root = parse_sexpr(fh.read())
        if page["parent"] is None:
            root_uuid = val(root, "uuid")
            objs.update(title_block(root, "schematic"))
        inst_path = f"/{root_uuid}{page['path'].rstrip('/')}" if page["parent"] else f"/{root_uuid}"
        where = {"sheet": page["path"]}
        for n in root[1:]:
            if not isinstance(n, list) or not n:
                continue
            kind, uid = n[0], val(n, "uuid")
            if not uid:
                continue
            key = f"{page['path']}{uid}"
            if kind == "symbol":
                props = properties(n)
                ref = props.get("Reference", "?")
                for inst in findall(find(n, "instances") or [], "project"):
                    for p in findall(inst, "path"):
                        if p[1] == inst_path:
                            ref = val(p, "reference", ref)
                unit = val(n, "unit", "1")
                a = at(n)
                if props.get("Reference", "").startswith("#"):  # power symbols and flags: track as net labels
                    objs[key] = {"kind": "power symbol", "ref": props.get("Value", "?"),
                                 "props": {"net": props.get("Value"), "symbol": val(n, "lib_id"), "position": fmt_at(a)}, "pos": a, "where": where}
                    continue
                p = {k: v for k, v in props.items() if k != "Reference"}
                p.update({"reference": ref, "symbol": val(n, "lib_id"), "position": fmt_at(a), "unit": unit,
                          "mirror": val(n, "mirror"), "dnp": val(n, "dnp"), "in_bom": val(n, "in_bom"),
                          "on_board": val(n, "on_board")})
                objs[key] = {"kind": "symbol", "ref": ref if unit == "1" else f"{ref} unit {unit}",
                             "match": ("symbol", ref, unit), "props": p, "pos": a, "where": where}
            elif kind in ("wire", "bus"):
                pts = points(n)
                objs[key] = {"kind": kind, "ref": "", "props": {"points": " ".join(fmt_at(p) for p in pts)},
                             "pos": list(pts[0]) if pts else None, "box": box_of(pts), "where": where}
            elif kind in ("label", "global_label", "hierarchical_label"):
                a = at(n)
                objs[key] = {"kind": kind.replace("_", " "), "ref": n[1], "props": {"text": n[1], "shape": val(n, "shape"), "position": fmt_at(a)},
                             "pos": a, "where": where}
            elif kind == "sheet":
                props = properties(n)
                objs[key] = {"kind": "sheet", "ref": props.get("Sheetname", "?"),
                             "props": {"name": props.get("Sheetname"), "file": props.get("Sheetfile"), "position": fmt_at(at(n))},
                             "pos": at(n), "where": where}
            elif kind in ("junction", "no_connect"):
                objs[key] = {"kind": kind.replace("_", " "), "ref": "", "props": {"position": fmt_at(at(n))},
                             "pos": at(n), "where": where}
    return objs


def pcb_objects(path):
    with open(path, encoding="utf-8") as fh:
        root = parse_sexpr(fh.read())
    net_names = {n[1]: n[2] for n in findall(root, "net") if len(n) > 2 and is_net_number(n[1])}  # older files number their nets
    net = lambda node: (lambda n: (net_names.get(n[1], n[-1]) if is_net_number(n[1]) else n[1]) if n else None)(find(node, "net"))
    where = {"board": True}
    objs = dict(title_block(root, "board"))
    setup = find(root, "setup")
    if setup:
        objs["meta:setup"] = {"kind": "design rules", "ref": "board setup", "where": None,
                              "props": flatten_sexpr(setup)}
    for n in root[1:]:
        if not isinstance(n, list) or not n:
            continue
        kind, uid = n[0], val(n, "uuid") or val(n, "tstamp")  # tstamp: KiCad 7 and older; upgrading keeps the value
        if not uid:
            continue
        if kind == "footprint":
            props = {t[1].capitalize(): t[2] for t in findall(n, "fp_text") if t[1] in ("reference", "value")}
            props.update(Sheetname=val(n, "sheetname"), Sheetfile=val(n, "sheetfile"))  # tokens since KiCad 8, properties before
            props.update(properties(n))
            props = {k: v for k, v in props.items() if v}  # an empty field and a missing one are the same
            a = at(n)
            p = {k: v for k, v in props.items() if k != "Reference"}
            p.update({"reference": props.get("Reference", "?"), "footprint": n[1], "layer": val(n, "layer"),
                      "position": fmt_at(a), "attributes": " ".join(x for x in (find(n, "attr") or [])[1:] if isinstance(x, str)) or None,
                      "locked": "yes" if "locked" in n or val(n, "locked") == "yes" else None})
            pads = [([c for c in pad[1:] if not (isinstance(c, list) and c and c[0] in ("net", "uuid", "tstamp", "at"))],
                     [round(v, 4) + 0.0 for v in pa[:2]] if (pa := at(pad)) else None,
                     round(((pa[2] if len(pa) > 2 else 0.0) - (a[2] if a and len(a) > 2 else 0.0)) % 360, 3) % 360 if pa else None) for pad in findall(n, "pad")]
            p["pads"] = f"{len(pads)} pads, geom {hashlib.sha1(repr(pads).encode()).hexdigest()[:10]}" if pads else None
            p["3D model"] = "; ".join(f"{m[1]} " + " ".join(f"{k}={v}" for k, v in flatten_sexpr(m).items()) for m in findall(n, "model")) or None
            pad_numbers, occurrences = Counter(pad[1] for pad in findall(n, "pad")), Counter()
            for pad in findall(n, "pad"):
                occurrences[pad[1]] += 1
                if find(pad, "net"):
                    p[f"pad {pad[1]}{f'#{occurrences[pad[1]]}' if pad_numbers[pad[1]] > 1 else ''} net"] = net(pad)
            objs[uid] = {"kind": "footprint", "ref": p["reference"], "match": ("footprint", p["reference"]),
                         "props": p, "pos": a, "box": box_of(pad_points(n, a), 1), "where": where,
                         "has_model": bool(findall(n, "model"))}
        elif kind in ("segment", "arc"):
            s, e = at_xy(n, "start"), at_xy(n, "end")
            objs[uid] = {"kind": "track", "ref": net(n) or "", "where": where, "pos": mid(s, e), "box": box_of([s, e]),
                         "props": {"net": net(n), "layer": val(n, "layer"), "width": num(val(n, "width")),
                                   "start": fmt_at(s), "end": fmt_at(e), **({"mid": fmt_at(at_xy(n, "mid"))} if kind == "arc" else {})}}
        elif kind == "via":
            a = at(n)
            objs[uid] = {"kind": "via", "ref": net(n) or "", "pos": a, "where": where,
                         "props": {"net": net(n), "position": fmt_at(a), "size": num(val(n, "size")),
                                   "drill": num(val(n, "drill")), "layers": " ".join((find(n, "layers") or [])[1:])}}
        elif kind == "zone":
            outline = [p for poly in findall(n, "polygon") for p in points(poly)]
            layers = val(n, "layer") or " ".join((find(n, "layers") or [])[1:])
            objs[uid] = {"kind": "zone", "ref": net(n) or "", "where": where,
                         "pos": list(outline[0]) if outline else None, "box": box_of(outline, 0),
                         "props": {"net": net(n), "layers": layers, "name": val(n, "name"),
                                   "priority": val(n, "priority"), "outline": " ".join(fmt_at(p) for p in outline),
                                   **{f"setting {k}": v for k, v in flatten_sexpr(n, skip=("polygon", "filled_polygon", "uuid", "tstamp", "net", "net_name", "layer", "layers", "name", "priority")).items()}}}
        elif kind.startswith("gr_") or kind == "dimension":
            layer = val(n, "layer")
            pts = [p for p in (at_xy(n, k) for k in ("start", "end", "center", "mid")) if p] + points(n) or ([tuple(at(n)[:2])] if at(n) else [])
            props = {"layer": layer, "geometry": " ".join(fmt_at(p) for p in pts)}
            if kind == "gr_text":
                props["text"] = n[1]
            objs[uid] = {"kind": "board outline" if layer == "Edge.Cuts" else "graphic", "ref": kind[3:], "where": where,
                         "pos": list(pts[0]) if pts else None, "box": box_of(pts), "props": props}
    return objs


def geometry_um(value):
    """Round millimetres to integer micrometres, with a bounded scene range."""
    from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
    try:
        n = Decimal(str(value)) * 1000
        if not n.is_finite() or abs(n) > 2_000_000_000:
            raise ValueError("board coordinate outside supported range")
        return int(n.to_integral_value(rounding=ROUND_HALF_UP))
    except InvalidOperation as error:
        raise ValueError("invalid board coordinate") from error


def geometry_point(point, footprint_at=None):
    # Validate before converting to float, including when rotating local coordinates.
    for value in point[:2]:
        geometry_um(value)
    if not footprint_at:
        return [geometry_um(value) for value in point[:2]]
    for value in footprint_at:
        geometry_um(value)
    x, y = map(float, point[:2])
    fx, fy, *angle = footprint_at
    degrees = float(angle[0]) if angle else 0
    t = math.radians(degrees)
    c, s = ((1, 0), (0, 1), (-1, 0), (0, -1))[int(degrees / 90) % 4] if degrees % 90 == 0 else (math.cos(t), math.sin(t))
    return [geometry_um(float(fx) + x * c + y * s),
            geometry_um(float(fy) - x * s + y * c)]


def geometry_arc(start, middle, end, width):
    for point in (start, middle, end):
        geometry_point(point)
    w = geometry_um(width)
    if w < 0:
        raise ValueError("negative geometry size")
    ax, ay = map(float, start); bx, by = map(float, middle); cx, cy = map(float, end)
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return [[*geometry_point(start), *geometry_point(end), w]]
    aa, bb, cc = ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy
    ox = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / d
    oy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / d
    a, b, c = [math.atan2(y - oy, x - ox) for x, y in ((ax, ay), (bx, by), (cx, cy))]
    sweep = (c - a) % math.tau
    if (b - a) % math.tau > sweep:
        sweep -= math.tau
    radius = math.hypot(ax - ox, ay - oy)
    step = 2 * math.acos(max(-1, 1 - .001 / max(radius, .001)))
    count = max(1, math.ceil(abs(sweep) / max(step, 1e-8)))
    if count > 65536:
        raise ValueError("arc exceeds geometry budget")
    pts = [geometry_point((ox + radius * math.cos(a + sweep * i / count),
                           oy + radius * math.sin(a + sweep * i / count))) for i in range(count + 1)]
    pts[0], pts[-1] = geometry_point(start), geometry_point(end)
    return [[*p, *q, w] for p, q in zip(pts, pts[1:])]


class GeometryFallback(ValueError):
    """A drawable needs authoritative SVG instead of an incomplete approximation."""


def geometry_cubic(points):
    """Flatten a cubic in mm with a 1 um control-to-chord error bound."""
    if len(points) != 4:
        raise GeometryFallback("cubic requires four control points")
    for point in points:
        geometry_point(point)
    result = [points[0]]

    def distance(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) if dx or dy else 0
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)

    def subdivide(a, b, c, d, depth):
        if max(distance(b, a, d), distance(c, a, d)) <= .001:
            if len(result) > 65536:
                raise GeometryFallback("cubic exceeds geometry budget")
            result.append(d)
            return
        if depth == 24:
            raise GeometryFallback("cubic subdivision depth limit")
        ab, bc, cd = [[(p[i] + q[i]) / 2 for i in (0, 1)] for p, q in ((a, b), (b, c), (c, d))]
        abc, bcd = [[(p[i] + q[i]) / 2 for i in (0, 1)] for p, q in ((ab, bc), (bc, cd))]
        mid = [(abc[i] + bcd[i]) / 2 for i in (0, 1)]
        subdivide(a, ab, abc, mid, depth + 1)
        subdivide(mid, bcd, cd, d, depth + 1)

    subdivide(*[[float(v) for v in p] for p in points], 0)
    return result


def geometry_shape(node, footprint_at=None):
    """Shared board/footprint graphic dispatch; only filled shapes have rings."""
    kind = node[0][3:]
    width = val(find(node, "stroke"), "width", val(node, "width", "0"))
    w = geometry_um(width)
    if w < 0:
        raise ValueError("negative geometry size")
    def point(key):
        p = find(node, key)
        if not p or len(p) < 3:
            raise GeometryFallback(f"{node[0]} missing {key}")
        geometry_point(p[1:3])
        return p[1:3]
    def world(p):
        return geometry_point(p, footprint_at)
    closed = kind in ("rect", "circle", "poly")
    if kind == "line":
        pts = [world(point("start")), world(point("end"))]
    elif kind in ("arc", "circle"):
        if kind == "arc":
            arcs = [(point("start"), point("mid"), point("end"))]
        else:
            c, e = [[float(v) for v in point(key)] for key in ("center", "end")]
            dx, dy = e[0] - c[0], e[1] - c[1]
            opposite = [c[0] - dx, c[1] - dy]
            arcs = [(e, [c[0] - dy, c[1] + dx], opposite), (opposite, [c[0] + dy, c[1] - dx], e)]
        try:
            segments = [s for a, b, c in arcs for s in geometry_arc(a, b, c, width)]
        except ValueError as error:
            if "budget" in str(error):
                raise GeometryFallback(str(error)) from error
            raise
        if len(segments) > 65536:
            raise GeometryFallback("circle exceeds geometry budget")
        pts = [world([s[0] / 1000, s[1] / 1000]) for s in segments]
        if not closed:
            pts.append(world([v / 1000 for v in segments[-1][2:4]]))
    elif kind == "rect":
        a, b = point("start"), point("end")
        pts = [world(p) for p in (a, [b[0], a[1]], b, [a[0], b[1]])]
    elif kind in ("poly", "curve"):
        path = find(node, "pts") or []
        if any(isinstance(p, list) and p[0] != "xy" for p in path[1:]):
            raise GeometryFallback("unsupported graphic path points")
        points = [p[1:3] for p in findall(path, "xy")]
        if kind == "curve":
            points = geometry_cubic(points)
        elif len(points) < 3:
            raise GeometryFallback("polygon requires at least three points")
        pts = [world(p) for p in points]
    else:
        raise GeometryFallback(f"unsupported graphic {node[0]}")
    filled = closed and val(node, "fill", "none") in ("yes", "solid")
    segments = [[*a, *b, w] for a, b in zip(pts, pts[1:] + (pts[:1] if closed else []))] if w or not filled else []
    return {"segments": segments, "rings": [pts] if filled else []}


def geometry_box(geometry):
    """Integer bbox of normalized drawable geometry (not a filled footprint box)."""
    boxes = []
    for ax, ay, bx, by, width in geometry.get("segments", []):
        r = width / 2
        boxes.append([math.floor(min(ax, bx) - r), math.floor(min(ay, by) - r),
                      math.ceil(max(ax, bx) + r), math.ceil(max(ay, by) + r)])
    for ring in geometry.get("rings", []):
        if ring:
            xs, ys = zip(*ring)
            boxes.append([min(xs), min(ys), max(xs), max(ys)])
    if "text" in geometry:
        # System-monospace atlas approximation, not KiCad stroke-font metrics.
        text = geometry["text"]
        lines = text["value"].split("\n")
        w = max(map(len, lines), default=0) * text["size"][0]
        h = len(lines) * text["size"][1]
        justify = text["justify"]
        left = 0 if "left" in justify else (-w if "right" in justify else -w / 2)
        top = 0 if "top" in justify else (-h if "bottom" in justify else -h / 2)
        t = math.radians(text["angle"] / 1000)
        x, y = text["at"]
        corners = [(px * (-1 if text["mirror"] else 1), py) for px, py in
                   ((left, top), (left + w, top), (left + w, top + h), (left, top + h))]
        xs = [x + px * math.cos(t) + py * math.sin(t) for px, py in corners]
        ys = [y - px * math.sin(t) + py * math.cos(t) for px, py in corners]
        r = text["thickness"] / 2
        boxes.append([math.floor(min(xs) - r), math.floor(min(ys) - r),
                      math.ceil(max(xs) + r), math.ceil(max(ys) + r)])
    primitives = [geometry["primitive"]] if "primitive" in geometry else []
    if "drill" in geometry:
        primitives.append({**geometry["drill"], "shape": "oval"})
    primitives += list(geometry.get("layerPrimitives", {}).values())
    for p in primitives:
        x, y = p["center"]; w, h = p["size"]
        t = math.radians(p.get("angle", 0) / 1000)
        c, s = abs(math.cos(t)), abs(math.sin(t))
        if p.get("shape") == "circle":
            dx, dy = w / 2, h / 2
        elif p.get("shape") == "oval":
            r = min(w, h) / 2
            dx, dy = c * (w / 2 - r) + s * (h / 2 - r) + r, s * (w / 2 - r) + c * (h / 2 - r) + r
        elif p.get("shape") == "trapezoid":
            dx, dy = p.get("delta", [0, 0])
            corners = [(sx * w / 2 - sx * sy * dy / 2,
                        sy * h / 2 + sx * sy * dx / 2)
                       for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            xs = [x + px * math.cos(t) + py * math.sin(t) for px, py in corners]
            ys = [y - px * math.sin(t) + py * math.cos(t) for px, py in corners]
            boxes.append([math.floor(round(min(xs), 8)), math.floor(round(min(ys), 8)),
                          math.ceil(round(max(xs), 8)), math.ceil(round(max(ys), 8))])
            continue
        elif p.get("shape") == "roundrect":
            r = p.get("radius", 0)
            dx, dy = c * (w / 2 - r) + s * (h / 2 - r) + r, s * (w / 2 - r) + c * (h / 2 - r) + r
        else:
            delta = p.get("delta", [0, 0])
            dx, dy = c * (w + abs(delta[1])) / 2 + s * (h + abs(delta[0])) / 2, s * (w + abs(delta[1])) / 2 + c * (h + abs(delta[0])) / 2
        # Suppress trig noise at exact quarter turns before outward rounding.
        boxes.append([math.floor(round(x - dx, 8)), math.floor(round(y - dy, 8)),
                      math.ceil(round(x + dx, 8)), math.ceil(round(y + dy, 8))])
    return geometry_union(boxes)


def geometry_union(boxes):
    boxes = [b for b in boxes if b is not None]
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)] if boxes else None


def board_geometry(pcb_path):
    """Extract the revision scene without altering pcb_objects' diff identities.

    Default text is metadata for a system-monospace glyph atlas, a visual
    approximation, not KiCad stroke-font outlines. Named fonts require SVG.
    """
    with open(pcb_path, encoding="utf-8") as fh:
        root = parse_sexpr(fh.read())
    scene = {"version": 1, "units": "um", "complete": True, "warnings": [],
             "bounds": [0, 0, 0, 0], "layers": [], "nets": [], "objects": []}
    for layer in (find(root, "layers") or [])[1:]:
        if isinstance(layer, list) and len(layer) >= 3:
            scene["layers"].append({"id": int(layer[0]), "name": layer[1], "type": layer[2], "enabled": True})
    names = [l["name"] for l in scene["layers"]]
    # File order and KiCad numeric enums are not physical stack order.
    copper = sorted((name for name in names if name.endswith(".Cu")),
                    key=lambda name: -1 if name == "F.Cu" else (1000 if name == "B.Cu" else int(name[2:-3])))

    # Stackup lists physical layers, including dielectric entries. Older boards
    # omit it; their canonical copper names define the stack, not numeric IDs.
    stackup = find(find(root, "setup") or [], "stackup") or []
    defined = [layer[1] for layer in findall(stackup, "layer")
               if len(layer) > 1 and layer[1] in copper]
    if len(defined) == len(copper) and set(defined) == set(copper):
        copper = defined
    scene["copperStack"] = copper

    def warn(uid, kind, reason, unsupported=True):
        scene["warnings"].append({"uuid": uid, "kind": kind, "reason": reason})
        if unsupported:
            scene["complete"] = False

    def walk(node):
        yield node
        for child in node[1:]:
            if isinstance(child, list):
                yield from walk(child)

    nets = {int(n[1]): n[2] for n in findall(root, "net") if len(n) > 2 and is_net_number(n[1])}
    nets[0] = ""
    named, numbered = set(), set()
    for node in walk(root):
        n = find(node, "net")
        if n and len(n) > 1 and is_net_number(n[1]) and val(node, "net_name") is not None:
            nets.setdefault(int(n[1]), val(node, "net_name"))
        if node[0] == "net" and len(node) > 1:
            if is_net_number(node[1]) and len(node) > 2:
                nets.setdefault(int(node[1]), node[2])
                named.add(nets[int(node[1])])
            elif is_net_number(node[1]):
                numbered.add(int(node[1]))
            else:
                named.add(node[1])
        elif node[0] == "net_name" and len(node) > 1:
            named.add(node[1])
    for number in sorted(numbered - nets.keys()):
        nets[number] = f"Net {number}"
        warn(str(number), "net", "numeric net has no declared name", False)
    for name in sorted(named - set(nets.values())):
        nets[max(nets) + 1] = name
    nets[0] = ""
    net_ids = {name: number for number, name in sorted(nets.items(), reverse=True)}
    scene["nets"] = [{"id": number, "name": name} for number, name in sorted(nets.items())]

    def net_id(node):
        n = find(node, "net")
        if n and len(n) > 1:
            return int(n[1]) if is_net_number(n[1]) else net_ids[n[1]]
        return net_ids.get(val(node, "net_name", ""), 0)

    def layers(node, via=False):
        tokens = (find(node, "layers") or [])[1:] or [val(node, "layer")]
        result = []
        for token in tokens:
            expanded = [n for n in names if n.endswith(token[1:])] if token in ("*.Cu", "*.Mask") else ([n for n in ("F.Cu", "B.Cu") if n in names] if token == "F&B.Cu" else [token])
            for name in expanded:
                if name in names and name not in result:
                    result.append(name)
                elif name not in names and name is not None:
                    warn(val(node, "uuid", ""), node[0], f"undeclared layer {name}")
        if via and len(result) == 2 and all(n in copper for n in result):
            a, b = sorted(copper.index(n) for n in result)
            result = copper[a:b + 1]
        return result

    def hidden(node):
        effects = find(node, "effects") or []
        return ("hide" in node or find(node, "hide") == ["hide"] or val(node, "hide") == "yes"
                or "hide" in effects or find(effects, "hide") == ["hide"] or val(effects, "hide") == "yes")

    def emit(kind, uid, change, ref, ls, net, side, category, geometry, hide=False):
        obj = {"kind": kind, "uuid": uid, "changeUuid": change, "ref": ref,
               "layers": ls, "net": net, "side": side, "category": category,
               "hidden": hide, "geometry": geometry, "box": geometry_box(geometry)}
        scene["objects"].append(obj)
        return obj

    def xy(node, key):
        return (find(node, key) or [key, "0", "0"])[1:3]

    def positive(value):
        n = geometry_um(value)
        if n < 0:
            raise ValueError("negative geometry size")
        return n

    setup = find(root, "setup")

    def pad_geometry(pad, fp, fp_at, uid):
        pa = (find(pad, "at") or ["at", "0", "0"])[1:4]
        center = geometry_point(pa, fp_at)
        angle = geometry_um(pa[2] if len(pa) > 2 else 0)  # stored in the board frame
        size = [positive(v) for v in xy(pad, "size")]
        shape = pad[3]
        visible = not hidden(fp) and not hidden(pad)
        if visible and find(pad, "padstack"):
            warn(uid, "pad", "per-layer padstack geometry not yet supported")
        p = {"shape": shape, "center": center, "size": size, "angle": angle,
             "radius": 0, "delta": [geometry_um(v) for v in xy(pad, "rect_delta")]}
        if shape == "roundrect":
            ratio = float(val(pad, "roundrect_rratio", 0))
            if not math.isfinite(ratio) or not 0 <= ratio <= .5:
                raise ValueError("invalid roundrect radius ratio")
            p["radius"] = geometry_um(min(size) / 1000 * ratio)
        geometry = {"primitive": p}
        if shape not in ("circle", "rect", "oval", "roundrect", "trapezoid", "custom"):
            if visible:
                warn(uid, "pad", f"unsupported pad shape {shape}")
            geometry = {}
        if shape == "custom":
            geometry = {"segments": [], "rings": []}
            world_at = [center[0] / 1000, center[1] / 1000, angle / 1000]
            def local(point):
                return geometry_point(point, world_at)
            options = find(pad, "options")
            anchor = val(options, "anchor", "rect")
            geometry["primitive"] = {**p, "shape": anchor}
            for primitive in (find(pad, "primitives") or [])[1:]:
                if not isinstance(primitive, list):
                    continue
                kind = primitive[0]
                width = val(primitive, "width", "0")
                if kind in ("gr_line", "gr_arc"):
                    segments = geometry_arc(xy(primitive, "start"), xy(primitive, "mid"), xy(primitive, "end"), width) if kind == "gr_arc" else [[*geometry_point(xy(primitive, "start")), *geometry_point(xy(primitive, "end")), positive(width)]]
                    geometry["segments"] += [[*local([s[0] / 1000, s[1] / 1000]), *local([s[2] / 1000, s[3] / 1000]), s[4]] for s in segments]
                elif kind in ("gr_poly", "gr_rect"):
                    ring = [local(n[1:3]) for n in findall(find(primitive, "pts") or [], "xy")] if kind == "gr_poly" else [local(v) for v in (xy(primitive, "start"), [xy(primitive, "end")[0], xy(primitive, "start")[1]], xy(primitive, "end"), [xy(primitive, "start")[0], xy(primitive, "end")[1]])]
                    filled = val(primitive, "fill", "yes") in ("yes", "solid")
                    if filled:
                        geometry["rings"].append(ring)
                    if positive(width) or not filled:
                        geometry["segments"] += [[*a, *b, positive(width)] for a, b in zip(ring, ring[1:] + ring[:1])]
                elif kind == "gr_circle":
                    c, e = xy(primitive, "center"), xy(primitive, "end")
                    # Split a circle into two bounded-error arcs, including its stroke.
                    opposite = [2 * float(c[0]) - float(e[0]), 2 * float(c[1]) - float(e[1])]
                    dx, dy = float(e[0]) - float(c[0]), float(e[1]) - float(c[1])
                    segments = geometry_arc(e, [float(c[0]) - dy, float(c[1]) + dx], opposite, width) + geometry_arc(opposite, [float(c[0]) + dy, float(c[1]) - dx], e, width)
                    transformed = [[*local([s[0] / 1000, s[1] / 1000]), *local([s[2] / 1000, s[3] / 1000]), s[4]] for s in segments]
                    geometry["segments"] += transformed
                    if val(primitive, "fill", "no") in ("yes", "solid"):
                        geometry["rings"].append([s[:2] for s in transformed])
                elif visible:
                    warn(uid, "pad", f"unsupported custom primitive {kind}")
        drill = find(pad, "drill")
        if drill:
            values = [v for v in drill[1:] if isinstance(v, str) and v != "oval"]
            dims = [positive(v) for v in values]
            if len(dims) == 1:
                dims *= 2
            if len(dims) != 2:
                raise ValueError("invalid pad drill")
            geometry["drill"] = {"center": geometry_point(xy(drill, "offset"), [center[0] / 1000, center[1] / 1000, angle / 1000]),
                                 "size": dims, "angle": angle, "plated": pad[2] != "np_thru_hole"}
        def override(key, setup_key=None):
            return next((val(node, key) for node in (pad, fp) if val(node, key) is not None), val(setup, setup_key or key, "0"))
        mask = geometry_um(override("solder_mask_margin", "pad_to_mask_clearance"))
        paste = geometry_um(override("solder_paste_margin", "pad_to_paste_clearance"))
        ratio = float(override("solder_paste_margin_ratio", "pad_to_paste_clearance_ratio"))
        if not math.isfinite(ratio):
            raise ValueError("invalid paste margin ratio")
        # Ratio is dimensionless integer thousandths; all dimensions remain micrometres.
        geometry["maskMargin"], geometry["pasteMargin"], geometry["pasteRatio"] = mask, paste, geometry_um(ratio)
        ls = layers(pad)
        exclusions = []
        tenting = find(pad, "tenting")
        for side, layer in (("front", "F.Mask"), ("back", "B.Mask")):
            if find(tenting or [], side) and val(tenting, side, "yes") != "no":
                exclusions.append(layer)
        if pad[2] == "np_thru_hole":
            exclusions += [n for n in ls if n.endswith(".Cu")]
        geometry["removeUnusedLayers"] = find(pad, "remove_unused_layers") is not None and val(pad, "remove_unused_layers", "yes") != "no"
        geometry["keepEndLayers"] = find(pad, "keep_end_layers") is not None and val(pad, "keep_end_layers", "yes") != "no"
        geometry["zoneLayerConnections"] = (find(pad, "zone_layer_connections") or [])[1:]
        if geometry["removeUnusedLayers"] and not hidden(fp) and not hidden(pad):
            warn(uid, "pad", "unconnected pad layer removal requires connectivity")
        ls = [n for n in ls if n not in exclusions]
        geometry["layerExclusions"] = exclusions
        if shape == "custom" and visible and ((mask and any(n.endswith(".Mask") for n in ls)) or ((paste or ratio) and any(n.endswith(".Paste") for n in ls))):
            warn(uid, "pad", "custom pad mask/paste offset not yet supported")
        if "primitive" in geometry:
            derived = {}
            for layer in ls:
                if layer.endswith((".Mask", ".Paste")):
                    margin = mask if layer.endswith(".Mask") else paste
                    dims = [max(0, n + 2 * margin + (geometry_um(n / 1000 * ratio * 2) if layer.endswith(".Paste") else 0)) for n in size]
                    derived[layer] = {**geometry["primitive"], "size": dims,
                                      "radius": max(0, min(min(dims) // 2, p["radius"] + margin))}
            if derived:
                geometry["layerPrimitives"] = derived
        return geometry, ls

    def drawable(node, uid, change, ref="", side=None, fp_at=None, fp=None, hide=False):
        kind = node[0]
        hide = hide or hidden(node)
        ls = layers(node)
        geometry = {}
        if kind == "zone":
            net = net_id(node)
            paths = [pts for region in findall(node, "polygon") + findall(node, "filled_polygon")
                     for pts in findall(region, "pts")]
            if not hide and any(isinstance(p, list) and p[0] != "xy" for pts in paths for p in pts[1:]):
                warn(uid, kind, "unsupported zone path points; using SVG")
            outlines = [[geometry_point(p[1:3], fp_at) for p in findall(pts, "xy")]
                        for polygon in findall(node, "polygon") for pts in findall(polygon, "pts")]
            segments = [[*a, *b, 50] for ring in outlines for a, b in zip(ring, ring[1:] + ring[:1])]
            fills = findall(node, "filled_polygon")
            keepout = find(node, "keepout") is not None or val(node, "rule_area") == "yes"
            if not fills or keepout:
                if not fills and not keepout and not hide:
                    warn(uid, kind, f"zone {uid}: no stored fill; showing outline", False)
                return [emit("zone", uid, change, ref or nets[net], ls, net, side, "zones",
                             {"segments": segments, "rings": []}, hide)]
            records = []
            counts = Counter()
            for fill in fills:
                fill_ls = layers(fill) if find(fill, "layer") else ls
                rings = [[geometry_point(p[1:3], fp_at) for p in findall(pts, "xy")]
                         for pts in findall(fill, "pts")]
                if not rings or any(len(r) < 3 for r in rings):
                    if not hide:
                        warn(uid, kind, "invalid stored fill; using SVG")
                    continue
                # Each source region is independent. Do not join islands or cancel overlaps.
                for layer in fill_ls:
                    counts[layer] += 1
                    child_uid = f"{uid}/fill:{layer}:{counts[layer]}"
                    records.append(emit("zone", child_uid, change, ref or nets[net], [layer], net, side,
                                        "zones", {"segments": [], "rings": rings}, hide))
            return records
        if kind in ("gr_text", "fp_text", "property"):
            effects = find(node, "effects") or []
            font = find(effects, "font") or []
            value = node[2] if kind in ("property", "fp_text") else node[1]
            if fp is not None:
                substitutions = {"REFERENCE": ref, "VALUE": properties(fp).get("Value", next((t[2] for t in findall(fp, "fp_text") if t[1] == "value"), ""))}
                value = re.sub(r"\$\{(REFERENCE|VALUE)\}", lambda m: substitutions[m[1]], value)
            if not hide:
                if "knockout" in (find(node, "layer") or []):
                    warn(uid, kind, "knockout text requires SVG")
                if find(font, "line_spacing") is not None:
                    warn(uid, kind, "custom text line spacing requires SVG")
                if "${" in value:
                    warn(uid, kind, "unresolved text substitution; using SVG")
                if re.search(r"[~^_]\{", value) or "\\" in value:
                    warn(uid, kind, "unsupported rich text; using SVG")
                if val(font, "face"):
                    warn(uid, kind, "named outline font requires SVG")
            position = [v for v in (find(node, "at") or ["at", "0", "0"])[1:] if v != "unlocked"]
            justify = (find(effects, "justify") or [])[1:]
            geometry = {"text": {"value": value, "at": geometry_point(position, fp_at),
                                 "size": [positive(v) for v in (find(font, "size") or ["size", "1", "1"])[1:3]][::-1],  # file: height, width
                                 # KiCad stores footprint text angles in the board frame.
                                 "angle": geometry_um(position[2] if len(position) > 2 else 0),
                                 "thickness": positive(val(font, "thickness", "0.15")),
                                 "justify": [v for v in justify if v in ("left", "right", "top", "bottom")],
                                 "mirror": "mirror" in justify,
                                 "italic": "italic" in font or (find(font, "italic") is not None and val(font, "italic", "yes") != "no"),
                                 "bold": "bold" in font or (find(font, "bold") is not None and val(font, "bold", "yes") != "no"),
                                 "unlocked": "unlocked" in node or val(node, "unlocked") == "yes" or "unlocked" in (find(node, "at") or [])}}
            return [emit("text", uid, change, ref, ls, 0, side, "text", geometry, hide)]
        try:
            geometry = geometry_shape(node, fp_at)
        except GeometryFallback as error:
            if not hide:
                warn(uid, kind, str(error))
        return [emit("shape", uid, change, ref, ls, 0, side, "graphics", geometry, hide)]

    for index, node in enumerate(root[1:]):
        if not isinstance(node, list) or not node:
            continue
        kind = node[0]
        uid = val(node, "uuid") or val(node, "tstamp") or f"board/{kind}:{index}"
        if kind in ("segment", "arc"):
            width = positive(val(node, "width", "0"))
            segments = geometry_arc(xy(node, "start"), xy(node, "mid"), xy(node, "end"), val(node, "width", "0")) if kind == "arc" else [[*geometry_point(xy(node, "start")), *geometry_point(xy(node, "end")), width]]
            net = net_id(node)
            emit("arc" if kind == "arc" else "track", uid, uid, nets[net], layers(node), net, None, "tracks", {"segments": segments}, hidden(node))
        elif kind == "via":
            center = geometry_point(xy(node, "at")); size = positive(val(node, "size", "0")); drill = positive(val(node, "drill", "0"))
            emit("via", uid, uid, nets[net_id(node)], layers(node, True), net_id(node), None, "vias",
                 {"primitive": {"shape": "circle", "center": center, "size": [size, size], "angle": 0, "radius": size // 2, "delta": [0, 0]},
                  "drill": {"center": center, "size": [drill, drill], "angle": 0, "plated": True}}, hidden(node))
        elif kind == "footprint":
            # Same UUID/tstamp and Reference precedence as pcb_objects; no new diff model.
            ref = properties(node).get("Reference") or next((t[2] for t in findall(node, "fp_text") if t[1] == "reference"), "?")
            side = "back" if val(node, "layer") == "B.Cu" else "front"
            fp_at = (find(node, "at") or ["at", "0", "0"])[1:4]
            geometry_point([0, 0], fp_at)
            parent = emit("footprint", uid, uid, ref, layers(node), 0, side, "footprints", {}, hidden(node))
            counts = Counter()
            children = []
            for child in node[1:]:
                if not isinstance(child, list) or not child:
                    continue
                child_kind = child[0]
                if child_kind == "pad":
                    counts[child[1]] += 1
                    child_uid = val(child, "uuid") or val(child, "tstamp") or f"{uid}/pad:{child[1]}:{counts[child[1]]}"
                    geometry, ls = pad_geometry(child, node, fp_at, child_uid)
                    children.append(emit("pad", child_uid, uid, ref, ls, net_id(child), side, "pads", geometry, parent["hidden"] or hidden(child)))
                elif (child_kind in ("fp_text", "fp_text_box", "fp_line", "fp_arc", "fp_circle",
                                      "fp_rect", "fp_poly", "fp_curve", "image", "zone", "dimension", "table")
                      or (child_kind == "property" and all(find(child, key) for key in ("at", "layer", "effects")))):
                    counts[child_kind] += 1
                    child_uid = val(child, "uuid") or val(child, "tstamp") or f"{uid}/{child_kind}:{counts[child_kind]}"
                    children += drawable(child, child_uid, uid, ref, side, fp_at, node, parent["hidden"])
            parent["box"] = geometry_union([c["box"] for c in children]) or [0, 0, 0, 0]
        elif kind == "zone" or kind.startswith("gr_") or kind in ("dimension", "target", "image", "table", "text_box"):
            drawable(node, uid, uid)
    scene["bounds"] = geometry_union([o["box"] for o in scene["objects"] if not o["hidden"] and o["kind"] != "footprint"]) or [0, 0, 0, 0]
    def check_numbers(value):
        if isinstance(value, dict):
            for child in value.values():
                check_numbers(child)
        elif isinstance(value, list):
            for child in value:
                check_numbers(child)
        elif isinstance(value, (int, float)) and (not isinstance(value, int) or abs(value) > 2_000_000_000):
            raise ValueError("board geometry outside supported integer range")
    check_numbers(scene)
    return scene


def pad_points(fp, a):
    """Absolute pad centres of a footprint at a = [x, y, rotation]."""
    if not a:
        return []
    t = math.radians(a[2] if len(a) > 2 else 0)
    pts = []
    for pad in findall(fp, "pad"):
        pa = at(pad)
        if pa:  # KiCad rotates counter-clockwise on screen with y pointing down
            pts.append((a[0] + pa[0] * math.cos(t) + pa[1] * math.sin(t), a[1] - pa[0] * math.sin(t) + pa[1] * math.cos(t)))
    return pts


def at_xy(node, key):
    n = find(node, key)
    return (float(n[1]), float(n[2])) if n and len(n) > 2 else None


def mid(a, b):
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] if a and b else None


def flatten_sexpr(node, prefix="", skip=()):
    """Leaf values of an S-expression block as dotted keys (design rules, zone settings)."""
    out = {}
    for c in node[1:]:
        if isinstance(c, list) and c and c[0] not in skip:
            if all(isinstance(x, str) for x in c[1:]):
                out[f"{prefix}{c[0]}"] = " ".join(c[1:])
            else:
                key = f"{prefix}{c[0]}" + (f"[{c[1]}]" if len(c) > 1 and isinstance(c[1], str) else "")
                out.update(flatten_sexpr(c, key + "."))
    return out


def pro_objects(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        pro = json.load(fh)
    keep = {"net_settings": pro.get("net_settings")}
    keep["board"] = (pro.get("board") or {}).get("design_settings")
    keep["erc"] = (pro.get("erc") or {}).get("rule_severities")
    return {"meta:pro": {"kind": "design rules", "ref": posixpath.basename(path), "where": None,
                         "props": {k: v for k, v in flatten(keep).items() if v != "None"}}}


def project_objects(proj_dir, name):
    if not os.path.isdir(proj_dir):
        return {}
    objs = sch_objects(proj_dir, name)
    pcb = posixpath.join(proj_dir, f"{name}.kicad_pcb")
    if os.path.exists(pcb):
        objs.update(pcb_objects(pcb))
    objs.update(pro_objects(posixpath.join(proj_dir, f"{name}.kicad_pro")))
    dru = posixpath.join(proj_dir, f"{name}.kicad_dru")
    if os.path.exists(dru):
        with open(dru, encoding="utf-8") as fh:
            objs["meta:dru"] = {"kind": "design rules", "ref": f"{name}.kicad_dru", "where": None,
                                "props": {"custom rules": hashlib.sha1(fh.read().encode()).hexdigest()[:10]}}
    return objs


def diff_objects(base, head):
    """Rows of added / removed / modified objects. UUID first; unmatched symbols and footprints by reference."""
    pairs = [(k, k) for k in base if k in head]
    b_left = {k: o for k, o in base.items() if k not in head}
    h_left = {k: o for k, o in head.items() if k not in base}
    by_match = {o["match"]: k for k, o in h_left.items() if o.get("match")}
    for k, o in list(b_left.items()):
        hk = by_match.get(o.get("match"))
        if hk in h_left:
            pairs.append((k, hk))
            del b_left[k], h_left[hk]
    rows = []
    for bk, hk in pairs:
        b, h = base[bk], head[hk]
        changes = [[p, b["props"].get(p), h["props"].get(p)] for p in sorted(set(b["props"]) | set(h["props"]))
                   if b["props"].get(p) != h["props"].get(p)]
        if changes:
            rows.append({**row("modified", h, changes, b), "uuid": hk, **({"uuid_before": bk} if bk != hk else {})})
    rows += [{**row("removed", o), "uuid": k} for k, o in b_left.items()]
    rows += [{**row("added", o), "uuid": k} for k, o in h_left.items()]
    order = ["title block", "design rules", "symbol", "footprint", "sheet", "label", "global label", "hierarchical label",
             "power symbol", "zone", "board outline", "track", "via", "wire", "bus", "junction", "no connect", "graphic"]
    rows.sort(key=lambda r: (order.index(r["kind"]) if r["kind"] in order else 99, natural(r["ref"])))
    return rows


def row(action, o, changes=None, before=None):
    r = {"action": action, "kind": o["kind"], "ref": o["ref"], "where": o["where"], "pos": o.get("pos"),
         "box": o.get("box")}
    if changes is not None:
        r["changes"] = changes
        if before and before.get("pos") != o.get("pos"):
            r["pos_before"] = before.get("pos")
    else:
        r["props"] = {k: v for k, v in o["props"].items() if v is not None and not k.startswith("setting ")}
    return r


def natural(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s or "")]


def object_index(base, head, libraries=False):
    """Every symbol and footprint of head, then the base-only ones: what a thread can be pinned to.
    uuid is the KiCad UUID (schematic keys are sheet path + UUID); sheet or layer says which drawing it is on."""
    def entry(key, o, side):
        e = {"uuid": key.rsplit("/", 1)[-1], "kind": o["kind"], "ref": o["ref"], "value": o["props"].get("Value"),
             "footprint": o["props"].get("Footprint") or o["props"].get("footprint"),
             "side": side, "pos": o.get("pos"), "box": o.get("box")}
        if libraries:
            e["lib"] = o["props"].get("symbol") if o["kind"] == "symbol" else o["props"].get("footprint")
        if o["where"].get("sheet") is not None:
            e["sheet"] = o["where"]["sheet"]
        else:
            e["layer"] = o["props"].get("layer")
        return e
    keep = lambda objs: {k: o for k, o in objs.items() if o["kind"] in ("symbol", "footprint")}
    b, h = keep(base), keep(head)
    used = set(b) & set(h)  # Reserve exact keys before any reference fallback.
    by_match = {}
    for k, o in b.items():
        if k not in used and o.get("match"):
            by_match.setdefault(o["match"], []).append(k)
    out = []
    for k, o in h.items():
        matches = by_match.get(o.get("match"), [])
        bk = k if k in b else (matches.pop(0) if matches else None)
        e = entry(k, o, "head")
        if bk is None:
            e["added"] = True
        else:
            used.add(bk)
            if b[bk].get("pos") != o.get("pos"):
                e["pos_before"] = b[bk].get("pos")
        out.append(e)
    out += [entry(k, o, "base") for k, o in b.items() if k not in used]
    return out


# ---- Library review: project-local symbol and footprint libraries. ----
def _strip(node):
    """Node without uuid/tstamp children, so regenerated ids do not count as edits."""
    return [c if not isinstance(c, list) else _strip(c) for c in node if not (isinstance(c, list) and c and c[0] in ("uuid", "tstamp"))]


def library_items(proj_dir):
    """Symbols of *.kicad_sym and footprints of *.pretty/*.kicad_mod under the project folder.
    ponytail: nickname = file stem, KiCad's default; read the lib tables if a team renames nicknames. Libraries outside the folder are not reviewed."""
    items = {}
    for root, dirs, files in os.walk(proj_dir):
        dirs[:] = sorted(x for x in dirs if not x.startswith(".") and not os.path.islink(posixpath.join(root, x)))
        rel = posixpath.relpath(root, proj_dir)
        for f in sorted(files):
            path = posixpath.join(root, f)
            if os.path.islink(path):
                continue
            if f.endswith(".kicad_sym") and not is_junk(path):
                lib = f[: -len(".kicad_sym")]
                for s in findall(parse_sexpr(open(path, encoding="utf-8").read()), "symbol"):
                    pins = {}
                    for unit in [s] + findall(s, "symbol"):
                        for p in findall(unit, "pin"):
                            number = val(p, "number")
                            if number is not None:
                                pins[number] = {"type": p[1], "name": val(p, "name"), "geometry": repr([find(p, "at"), find(p, "length")])}
                    items[(lib, s[1].rsplit(":", 1)[-1], "symbol")] = {"pins": pins, "hash": hashlib.sha1(repr(_strip(s)).encode()).hexdigest(), "file": posixpath.normpath(posixpath.join(rel, f))}
            elif f.endswith(".kicad_mod") and root.endswith(".pretty") and not is_junk(path):
                fp = parse_sexpr(open(path, encoding="utf-8").read())
                pads = {}
                for p in findall(fp, "pad"):
                    a, sz = at(p), find(p, "size")
                    summary = f"{p[2]} {p[3]} {fmt_at(a[:2]) if a else '?'} {num(sz[1]) if sz else '?'}×{num(sz[2]) if sz and len(sz) > 2 else '?'}"
                    pads[p[1]] = pads[p[1]] + '; ' + summary if p[1] in pads else summary
                items[(posixpath.basename(root)[: -len(".pretty")], f[:-len(".kicad_mod")], "footprint")] = {
                    "pins": pads, "hash": hashlib.sha1(repr(_strip(fp)).encode()).hexdigest(), "file": posixpath.normpath(posixpath.join(rel, f))}
    return items


def library_changes(b, h):
    out = []
    for key in sorted(set(b) | set(h), key=lambda k: (k[2], k[0], natural(k[1]))):
        x, y = b.get(key), h.get(key)
        if x and y and x["hash"] == y["hash"]:
            continue
        diff = []
        before, after = (x or {"pins": {}})["pins"], (y or {"pins": {}})["pins"]
        for pin in sorted(set(before) | set(after), key=natural):
            p, q = before.get(pin), after.get(pin)
            if p == q:
                continue
            if p is None or q is None:
                diff.append({"pin": pin, "change": "added" if p is None else "removed", "before": p if isinstance(p, str) else (p and f"{p['name']} ({p['type']})"),
                             "after": q if isinstance(q, str) else (q and f"{q['name']} ({q['type']})")})
            elif isinstance(p, dict):
                for field_ in ("type", "name", "geometry"):
                    if p[field_] != q[field_]:
                        diff.append({"pin": pin, "change": field_, "before": p[field_], "after": q[field_]})
            else:
                diff.append({"pin": pin, "change": "geometry", "before": p, "after": q})
        out.append({"lib": key[0], "item": key[1], "kind": key[2], "status": "added" if not x else "removed" if not y else "modified",
                    "file": (y or x)["file"], "pins_diff": diff})
    return out


def lib_slug(c):
    identity = repr((c["kind"], c["lib"], c["item"]))
    return re.sub(r"[^A-Za-z0-9_.-]", "_", f"{c['kind']}-{c['lib']}-{c['item']}")[:100] + "-" + hashlib.sha256(identity.encode()).hexdigest()[:16]


def library_report(changes, objects, out_dir, blobs, *, local_items=None):
    """Changed library items for the report: drawings, who uses them, and warnings for edits that break placed parts."""
    local_items = set(local_items if local_items is not None else ((c["lib"], c["item"], c["kind"]) for c in changes))
    libraries = {(kind, lib) for lib, item, kind in local_items}
    by_item = {}
    for lib, item, kind in local_items:
        by_item.setdefault((kind, item), set()).add(lib)
    out = []
    for c in changes:
        key = f"{c['lib']}:{c['item']}"
        users = set()
        for o in objects:
            if o["kind"] != c["kind"] or o["side"] != "head":
                continue
            identity = o.get("lib") or ""
            nickname, _, item = identity.rpartition(":")
            if identity == key or ((c["kind"], nickname) not in libraries and item == c["item"]
                                   and by_item.get((c["kind"], item)) == {c["lib"]}):
                users.add(o["ref"].split(" unit ")[0])
        users = sorted(users, key=natural)
        svg, sizes = {}, {}
        for side in ("base", "head"):
            text = svg_body(f"{out_dir}/{side}/lib/{lib_slug(c)}.svg")
            svg[side] = None
            if text and has_drawing(text):
                try:
                    sizes[side] = svg_size(text)
                    svg[side] = text
                except ValueError:
                    pass  # A malformed export stays listed without a drawing.
        entry = {**c, "used_by": users, "svg": {s: add_blob(blobs, t) for s, t in svg.items()}, "warnings": []}
        drawn = "head" if svg["head"] else "base" if svg["base"] else None
        if drawn:
            entry["size"] = sizes[drawn]
        else:
            entry["note"] = "no drawing"
        for d in c["pins_diff"] if users else []:
            word = "pin" if c["kind"] == "symbol" else "pad"
            if d["change"] == "removed":
                entry["warnings"].append(f"⚠ {word} {d['pin']} removed while {', '.join(users)} {'uses' if len(users) == 1 else 'use'} {c['item']}")
            elif d["change"] == "type":
                entry["warnings"].append(f"⚠ pin {d['pin']} type {d['before']} → {d['after']} on {c['item']}, used by {', '.join(users)}")
        out.append(entry)
    return out


# ---- Checks: ERC, DRC, schematic parity, BOM fields. Violations new since base are called out. ----

DEFAULT_SETTINGS = {
    "checks": {"erc": "required", "drc": "required", "parity": "required", "bom": "informational", "release": "off", "interfaces": "off"},
    "interfaces": {},  # pattern overrides for the interfaces check
    "fail_on": "new",  # "new": only errors this change introduced fail a required check; "all": any error does
    "bom": {"required_fields": ["Value", "Footprint"], "critical_prefixes": ["U", "J", "Q", "D", "Y", "X", "K", "F"],
            "order_ready_fields": []},  # empty: the fabrication preset's fields
    "fabrication": {"preset": "jlcpcb", "part_field": None},  # part_field defaults to the preset's (LCSC / MPN)
    "3d": {"enabled": False},
    "parts": {"enabled": False},
    "release": {"review": False},
    "digikey": {"enabled": False, "site": "US", "currency": "USD", "max_lookups": 100},
    "pdf": {"enabled": False},

    "threads": {"enabled": False, "block_merge": False},
    "issues": {"enabled": False},
    "github": {"check_runs": False},
    "waivers": {"enabled": False},
    "inventory": {"enabled": False},
    "libraries": {"enabled": False},
}
CHECK_NAMES = {"erc": "ERC", "drc": "DRC", "parity": "Schematic/board parity", "bom": "BOM fields", "interfaces": "Interfaces", "release": "Release package"}


INTERFACE_PATTERNS = {
    "uart_tx": ["TX", "TXD", "UART_TX", "USART_TX"],
    "i2c_sda": ["SDA", "I2C_SDA"], "i2c_scl": ["SCL", "I2C_SCL"], "can_h": ["CANH", "CAN_H"], "can_l": ["CANL", "CAN_L"],
    "spi": [],  # accepted for compatibility with existing settings; no SPI rule
    "esd_parts": ["ESD", "TVS", "USBLC", "PESD", "PRTR", "SRV05", "TPD", "SP05", "SMAJ", "SMBJ"],
}


def load_settings(roots=("base", "head")):
    """Repository settings from kicad-review.toml. The base revision's copy wins, so a change cannot relax its own checks."""
    settings = json.loads(json.dumps(DEFAULT_SETTINGS))
    for side in roots:
        path = f"{side}/{SETTINGS_FILE}" if side else SETTINGS_FILE
        if os.path.exists(path):
            with open(path, "rb") as fh:
                user = tomllib.load(fh)
            for k, v in user.items():
                if isinstance(v, dict) and isinstance(settings.get(k), dict):
                    settings[k].update(v)
                else:
                    settings[k] = v
            break
    for section in ("checks", "bom", "fabrication", "3d", "parts", "release", "digikey", "threads", "issues", "github", "waivers", "inventory", "libraries", "interfaces", "pdf"):
        if not isinstance(settings[section], dict):
            sys.exit(f"{SETTINGS_FILE}: {section} must be a table")
    if not isinstance(settings["bom"]["required_fields"], list) or not all(isinstance(f, str) for f in settings["bom"]["required_fields"]):
        sys.exit(f"{SETTINGS_FILE}: bom.required_fields must be a list of strings")
    for key in ("critical_prefixes", "order_ready_fields"):
        if not isinstance(settings["bom"][key], list) or not all(isinstance(f, str) for f in settings["bom"][key]):
            sys.exit(f"{SETTINGS_FILE}: bom.{key} must be a list of strings")
    bad = [f for f in settings["bom"]["order_ready_fields"] if f not in COVERAGE_FIELDS]
    if bad:
        sys.exit(f"{SETTINGS_FILE}: bom.order_ready_fields: unknown {', '.join(bad)}; use {', '.join(COVERAGE_FIELDS)}")
    for name, level in settings["checks"].items():
        if name not in CHECK_NAMES or level not in ("required", "informational", "off"):
            sys.exit(f"{SETTINGS_FILE}: checks.{name} = {level!r}; expected one of {', '.join(CHECK_NAMES)} = required/informational/off")
    for k, v in settings["interfaces"].items():
        if k not in INTERFACE_PATTERNS or not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
            sys.exit(f"{SETTINGS_FILE}: interfaces.{k} must be one of {', '.join(INTERFACE_PATTERNS)} with a list of names")
    if settings["fabrication"]["preset"] not in PRESETS:
        sys.exit(f"{SETTINGS_FILE}: fabrication.preset must be one of {', '.join(PRESETS)}")
    if settings["fail_on"] not in ("new", "all"):
        sys.exit(f"{SETTINGS_FILE}: fail_on must be \"new\" or \"all\"")
    if not isinstance(settings["3d"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: 3d.enabled must be true or false")
    if not isinstance(settings["parts"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: parts.enabled must be true or false")
    if not isinstance(settings["release"]["review"], bool):
        sys.exit(f"{SETTINGS_FILE}: release.review must be true or false")
    cfg = settings["digikey"]
    if not isinstance(cfg["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: digikey.enabled must be true or false")
    if cfg["enabled"] and not settings["parts"]["enabled"]:
        sys.exit(f"{SETTINGS_FILE}: digikey.enabled requires parts.enabled")
    for key, pattern in (("site", r"[A-Z]{2}"), ("currency", r"[A-Z]{3}")):
        if not isinstance(cfg[key], str) or not re.fullmatch(pattern, cfg[key]):
            sys.exit(f"{SETTINGS_FILE}: digikey.{key} must match {pattern}")
    if type(cfg["max_lookups"]) is not int or not 1 <= cfg["max_lookups"] <= 900:
        sys.exit(f"{SETTINGS_FILE}: digikey.max_lookups must be an integer from 1 to 900")
    if not isinstance(settings["pdf"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: pdf.enabled must be true or false")

    if not isinstance(settings["threads"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: threads.enabled must be true or false")
    if not isinstance(settings["issues"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: issues.enabled must be true or false")
    if not isinstance(settings["inventory"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: inventory.enabled must be true or false")
    if not isinstance(settings["libraries"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: libraries.enabled must be true or false")
    for key, value in (("threads.block_merge", settings["threads"]["block_merge"]), ("github.check_runs", settings["github"]["check_runs"])):
        if not isinstance(value, bool):
            sys.exit(f"{SETTINGS_FILE}: {key} must be true or false")
    if not isinstance(settings["waivers"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: waivers.enabled must be true or false")
    if settings["threads"]["block_merge"] and not settings["threads"]["enabled"]:
        sys.exit(f"{SETTINGS_FILE}: threads.block_merge needs threads.enabled = true")
    return settings


# ---- Release outputs: Gerbers + drill (one zip), BOM and position file, per fabrication house. ----

PRESETS = {
    # JLCPCB's KiCad guide: Protel extensions, no X2/netlist attributes, separate PTH/NPTH Excellon in mm.
    "jlcpcb": {
        "gerbers": ["--no-x2", "--no-netlist", "--subtract-soldermask"],
        "drill": ["--excellon-separate-th", "--generate-map", "--map-format", "gerberx2"],
        "part_field": "LCSC",
        "bom": [("Value", "Comment"), ("Reference", "Designator"), ("Footprint", "Footprint"), ("{part}", "LCSC Part #")],
    },
    # PCBWay accepts KiCad defaults; one Excellon file, BOM in its assembly-quote column layout.
    "pcbway": {
        "gerbers": ["--no-x2", "--no-netlist"],
        "drill": ["--generate-map", "--map-format", "gerberx2"],
        "part_field": "MPN",
        "bom": [("Reference", "Designator"), ("${QUANTITY}", "Qty"), ("Manufacturer", "Manufacturer"),
                ("{part}", "Mfg Part #"), ("Value", "Description/Value"), ("Footprint", "Package/Footprint")],
    },
}
POS_COLUMNS = {"Ref": "Designator", "Val": "Val", "Package": "Package", "PosX": "Mid X", "PosY": "Mid Y",
               "Rot": "Rotation", "Side": "Layer"}
FAB_LAYER = re.compile(r"\.(Cu|Mask|SilkS|Paste)$|^Edge\.Cuts$")


def release_project(pro_path, tag, settings, out_dir, label):
    src, name = posixpath.dirname(pro_path), posixpath.basename(pro_path)[: -len(".kicad_pro")]
    preset_name = settings["fabrication"]["preset"]
    preset = PRESETS[preset_name]
    part = settings["fabrication"].get("part_field") or preset["part_field"]
    pcb, sch = f"{src}/{name}.kicad_pcb", f"{src}/{name}.kicad_sch"
    stem = f"{out_dir}/{label}-{tag}-{preset_name}"
    made = []
    if os.path.exists(pcb):
        work = tempfile.mkdtemp()
        layers = [l for l in board_layers(pcb) if FAB_LAYER.search(l)]
        kicad_cli("pcb", "export", "gerbers", *preset["gerbers"], "--check-zones", "-l", ",".join(layers), "-o", work, pcb)
        kicad_cli("pcb", "export", "drill", "--format", "excellon", "--excellon-units", "mm", "--excellon-zeros-format", "decimal",
                  "--excellon-oval-format", "alternate", *preset["drill"], "-o", work + "/", pcb)
        with zipfile.ZipFile(f"{stem}-gerbers.zip", "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(os.listdir(work)):
                z.write(f"{work}/{f}", f)
        kicad_cli("pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "--exclude-dnp",
                  "-o", f"{work}/pos.csv", pcb)
        with open(f"{work}/pos.csv", newline="", encoding="utf-8") as fh, open(f"{stem}-positions.csv", "w", newline="", encoding="utf-8") as out:
            rows = list(csv.reader(fh))
            w = csv.writer(out)
            w.writerow([POS_COLUMNS.get(h, h) for h in rows[0]])
            side = rows[0].index("Side")
            w.writerows([*r[:side], r[side].capitalize(), *r[side + 1:]] for r in rows[1:])
        made += [f"{stem}-gerbers.zip", f"{stem}-positions.csv"]
    if os.path.exists(sch):
        fields = [f.replace("{part}", part) for f, _ in preset["bom"]]
        group = [f for f in ("Value", "Footprint", part) if f in fields]
        kicad_cli("sch", "export", "bom", "--fields", ",".join(fields), "--labels", ",".join(l for _, l in preset["bom"]),
                  "--group-by", ",".join(group), "--exclude-dnp", "-o", f"{stem}-bom.csv", sch)
        made.append(f"{stem}-bom.csv")
    return made


def fab_violation(type_, severity, description, items=()):
    # The key ignores items, so a finding that only regroups (one part's BOM line moved) is neither new nor fixed.
    return {"type": type_, "severity": severity, "description": description, "items": list(items), "uuids": [],
            "pos": None, "box": None, "where": {"board": True}, "key": ("release", type_, description)}


def bom_refs_expand(designators):
    """'C1,C3-C5' -> {'C1', 'C3', 'C4', 'C5'}: fab BOMs write runs of references as ranges."""
    out = set()
    for part in (designators or "").split(","):
        part = part.strip()
        m = re.fullmatch(r"([A-Za-z_]+)(\d+)-\1?(\d+)", part)
        if m and int(m.group(3)) >= int(m.group(2)) and int(m.group(3)) - int(m.group(2)) < 10000:
            out |= {f"{m.group(1)}{n}" for n in range(int(m.group(2)), int(m.group(3)) + 1)}
        elif part:
            out.add(part)
    return out


def smd_pad_sides(pcb_text):
    """Board sides ('F', 'B') with at least one SMD pad: only those need paste."""
    sides = set()
    for m in re.finditer(r'\(footprint\s+"[^"]*"\s*(?:(?:locked|placed)\s+)*\(layer\s+"([FB])\.Cu"\)', pcb_text):
        end = pcb_text.find("(footprint ", m.end())
        if re.search(r'\(pad\s+"[^"]*"\s+smd\b', pcb_text[m.end():end if end != -1 else None]):
            sides.add(m.group(1))
    return sides


def has_draw(text):
    return re.search(r"D0?[13]\*", text) is not None  # any draw (D01) or flash (D03): the layer is not empty


def release_findings(fab_dir, label, preset, pcb_path, board_objs):
    """What would stop a fab from building this board from the package kicad-review generates."""
    stem = f"{fab_dir}/{label}-review-{preset}"
    if not os.path.exists(f"{stem}-gerbers.zip"):
        return [fab_violation("missing_package", "error", "No fabrication package was produced")]
    with zipfile.ZipFile(f"{stem}-gerbers.zip") as z:
        files = {n: z.read(n).decode("latin-1") for n in z.namelist()}
    # KiCad names a Gerber after the layer's user name when it has one (e.g. In1.Cu renamed "GND_PLANE").
    pcb_text = open(pcb_path, encoding="utf-8").read() if os.path.exists(pcb_path) else ""
    alias = {c: u for c, u in re.findall(r'\(\d+\s+"([^"]+)"\s+\w+\s+"([^"]+)"\)', pcb_text)}
    names = lambda layer: {layer.replace(".", "_"), alias.get(layer, layer).replace(".", "_").replace(" ", "_")}
    find_layer = lambda layer: next((t for n, t in files.items() if any(f"-{x}." in n for x in names(layer))), None)
    out = []
    for layer in [l for l in board_layers(pcb_path) if l.endswith(".Cu")] + ["Edge.Cuts"]:
        if find_layer(layer) is None:
            out.append(fab_violation("missing_layer", "error", f"No Gerber for {'copper layer ' if layer.endswith('.Cu') else ''}{layer}"))
    fps = [o for o in board_objs.values() if o["kind"] == "footprint"]
    attrs = lambda o: (o["props"].get("attributes") or "").split()
    smd = [o for o in fps if "smd" in attrs(o) and "dnp" not in attrs(o)]
    # Pads come from the board file, so pcb_objects (and every report's change list) needs no new prop.
    paste_sides = smd_pad_sides(pcb_text) | {o["props"]["layer"][0] for o in smd if "smd" in (o["props"].get("pads_kind") or "").split()}
    for side in ("F", "B"):
        if any(o["props"].get("layer") == f"{side}.Cu" for o in smd):
            for kind in ("Mask", "Paste") if side in paste_sides else ("Mask",):
                t = find_layer(f"{side}.{kind}")
                if t is None or not has_draw(t):
                    out.append(fab_violation("missing_layer", "error", f"{side}.{kind} is missing or empty but {side} side has SMD parts"))
    holes = any(o["kind"] == "via" for o in board_objs.values()) or re.search(r'\(pad\s+"[^"]*"\s+(?:np_)?thru_hole\b', pcb_text) is not None \
        or any("thru_hole" in (o["props"].get("pads_kind") or "") for o in fps)
    if holes and not any(n.lower().endswith(".drl") for n in files):
        out.append(fab_violation("missing_drill", "error", "The board has holes but the package has no drill file"))
    pos, bom = f"{stem}-positions.csv", f"{stem}-bom.csv"
    pos_refs = set()
    if os.path.exists(pos):
        with open(pos, newline="", encoding="utf-8") as fh:
            pos_refs = {r["Designator"] for r in csv.DictReader(fh)}
    if smd and not pos_refs:
        out.append(fab_violation("missing_positions", "error", "SMD parts are fitted but the position file is empty"))
    if os.path.exists(bom):
        with open(bom, newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        part_col = PRESETS[preset]["bom"][-1][1] if preset == "jlcpcb" else "Mfg Part #"
        bom_refs = set().union(*(bom_refs_expand(row.get("Designator")) for row in rows))
        missing_pn = [row.get("Designator", "") for row in rows if not (row.get(part_col) or "").strip()]
        if missing_pn:
            out.append(fab_violation("bom_missing_part_number", "warning", f"BOM lines without {part_col}", missing_pn))
        extra = sorted(pos_refs - bom_refs, key=natural)
        if extra:
            out.append(fab_violation("position_not_in_bom", "warning", "Parts placed by the position file but missing from the BOM", extra))
    return out


def package_summary(fab_dir):
    files = sorted(f for f in os.listdir(fab_dir) if "-review-" in f) if os.path.isdir(fab_dir) else []
    zip_ = next((f for f in files if f.endswith("-gerbers.zip")), None)
    sha = None
    if zip_:
        with open(f"{fab_dir}/{zip_}", "rb") as fh:
            sha = hashlib.file_digest(fh, "sha256").hexdigest()
    return {"files": [{"path": f, "bytes": os.path.getsize(f"{fab_dir}/{f}")} for f in files], "sha256": sha}


def cmd_release(args):
    settings = load_settings(("repo",))
    pros = sorted(posixpath.join(d, f) for d, _, files in os.walk("repo") if "/." not in d for f in files
                  if f.endswith(".kicad_pro") and not is_junk(posixpath.join(d, f)))
    names = [posixpath.basename(p) for p in pros]
    labels = {}
    for pro in pros:
        label = posixpath.basename(pro)[: -len(".kicad_pro")]
        if names.count(posixpath.basename(pro)) > 1 and posixpath.dirname(pro) != "repo":  # keep same-named projects apart
            label = posixpath.dirname(pro)[len("repo/"):].replace("/", "-") + "-" + label
        if label in labels:
            sys.exit(f"Duplicate release label {label!r}; rename one project or directory")
        labels[label] = pro
    os.makedirs("release", exist_ok=True)
    for label, pro in labels.items():
        for f in release_project(pro, args.tag, settings, "release", label):
            print(f)
    os.makedirs("release", exist_ok=True)
    sums = []
    for f in sorted(os.listdir("release")):
        if f != "SHA256SUMS":
            with open(f"release/{f}", "rb") as fh:
                sums.append(f"{hashlib.file_digest(fh, 'sha256').hexdigest()}  {f}")
    if sums:
        with open("release/SHA256SUMS", "w", encoding="utf-8") as fh:
            fh.write("\n".join(sums) + "\n")
        print("release/SHA256SUMS")


def violation(v, scale, where):
    items = v.get("items", [])
    pos = [[round(i["pos"]["x"] * scale, 4), round(i["pos"]["y"] * scale, 4)] for i in items if "pos" in i]
    return {"type": v["type"], "severity": v["severity"], "description": v["description"],
            "items": [i.get("description", "") for i in items], "uuids": sorted(i["uuid"] for i in items if i.get("uuid")),
            "pos": pos[0] if pos else None, "box": box_of(pos, 1.5), "where": where}


def erc_position_scale(sheets, objects, kicad_version=None):
    """Infer the ERC JSON writer's 1/100 bug from referenced schematic geometry."""
    exact, pins = [], []
    for sheet in sheets:
        parts = sheet.get("uuid_path", "/").strip("/").split("/")[1:]
        page = "/" + "".join(f"{p}/" for p in parts)
        refs = {o["ref"]: o for o in objects.values() if o.get("where") == {"sheet": page} and o.get("kind") == "symbol"}
        for v in sheet.get("violations", []):
            for item in v.get("items", []):
                if "pos" not in item:
                    continue
                obj = objects.get(page + item.get("uuid", ""))
                direct = obj is not None
                if not direct:
                    match = re.match(r"Symbol (\S+) Pin ", item.get("description", ""))
                    obj = refs.get(match[1]) if match else None
                if not obj or not obj.get("pos"):
                    continue
                p = item["pos"]
                distances = [math.hypot(p["x"] * scale - obj["pos"][0], p["y"] * scale - obj["pos"][1]) for scale in (1, 100)]
                if direct:
                    if min(distances) < 0.02 and max(distances) > 0.02:
                        exact.append(distances[1] < distances[0])
                # Pin UUIDs are not in the object model; require a 10x closer symbol anchor.
                # Exact UUID matches take precedence over this pin-only fallback.
                elif max(distances) > 10 * max(min(distances), 0.02):
                    pins.append(distances[1] < distances[0])
    votes = exact or pins
    if votes.count(True) != votes.count(False):
        return 100 if votes.count(True) > votes.count(False) else 1
    # KiCad #25582 is fixed in 10.0.7; use the report version only without decisive geometry.
    version = re.search(r"(?<![\d.])(\d+)\.(\d+)\.(\d+)(?![\d.])", kicad_version) if isinstance(kicad_version, str) else None
    return 100 if version and (10, 0, 0) <= tuple(map(int, version.groups())) <= (10, 0, 6) else 1


def load_violations(path, kind, objects=None):
    """ERC/DRC JSON as a flat list of errors and warnings. kind: erc, drc or parity."""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    out = []
    if kind == "erc":
        scale = erc_position_scale(d.get("sheets", []), objects or {}, d.get("kicad_version"))
        for sheet in d.get("sheets", []):
            parts = sheet.get("uuid_path", "/").strip("/").split("/")[1:]  # drop the root sheet UUID
            page = "/" + "".join(f"{p}/" for p in parts)
            out += [violation(v, scale, {"sheet": page}) for v in sheet.get("violations", [])]
    else:
        for key in (("violations", "unconnected_items") if kind == "drc" else ("schematic_parity",)):
            out += [violation(v, 1, {"board": True}) for v in d.get(key, [])]
    out = [v for v in out if v["severity"] in ("error", "warning")]
    # Unconnected items are ratsnest edges; moving one pad re-pairs them. Match by count per net instead of by pair.
    seen = {}
    for v in out:
        if v["type"] == "unconnected_items":
            nets = tuple(sorted({n for i in v["items"] for n in re.findall(r"\[([^\]]*)\]", i)}))
            seen[nets] = seen.get(nets, 0) + 1
            v["key"] = ("unconnected", nets, seen[nets])
    return out


def bom_violations(objs, fields):
    out = []
    for o in objs.values():
        p = o["props"]
        if o["kind"] != "symbol" or p.get("in_bom") == "no" or p.get("dnp") == "yes" or o["ref"].endswith("?"):
            continue
        missing = [f for f in fields if (p.get(f) or "").strip() in ("", "~")]
        if missing and not o["ref"].split(" unit ")[0] in {v["ref"] for v in out}:
            out.append({"type": "missing_fields", "severity": "error", "ref": o["ref"].split(" unit ")[0],
                        "description": f"{o['ref'].split(' unit ')[0]} has no {', '.join(missing)}",
                        "items": [], "uuids": [], "pos": o["pos"], "box": None, "where": o["where"],
                        "key": ("bom", o["ref"].split(" unit ")[0], tuple(missing))})
    return out


# ---- DigiKey lookup. Only MPNs leave the runner; results live only in this run's report. ----
DIGIKEY = "https://api.digikey.com"
MPN_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._/+#,()-]{0,79}$")


class DigiKeyError(Exception):
    pass


class DigiKeyStop(DigiKeyError):
    """Rate limit or suspension: no further calls this run."""


class DigiKeyAuth(DigiKeyError):
    """A search token expired or was rejected (401)."""


def digikey_placeholder(value):
    return value.lower() in ("", "~", "tbd", "?", "x", "todo", "na", "n/a", "-")


def mpn_for_lookup(mpn):
    v = " ".join((mpn or "").split())
    return v if not digikey_placeholder(v) and MPN_OK.fullmatch(v) else None


def _digikey_open(req, urlopen):
    try:
        with urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
            if not isinstance(data, dict):
                raise DigiKeyError("invalid response")
            return data
    except urllib.error.HTTPError as e:
        if e.code in (429, 403):
            raise DigiKeyStop("rate limit reached" if e.code == 429 else "access refused (403; possibly a 10-minute suspension)")
        if e.code == 401:
            raise DigiKeyAuth("HTTP 401")
        if e.code == 404:
            return {"ExactMatches": [], "Products": [], "ProductsCount": 0}
        raise DigiKeyError(f"HTTP {e.code}")
    except (OSError, ValueError, http.client.HTTPException) as e:
        raise DigiKeyError(type(e).__name__)


def digikey_token(client_id, secret, urlopen=urllib.request.urlopen):
    body = urllib.parse.urlencode({"client_id": client_id, "client_secret": secret, "grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(f"{DIGIKEY}/v1/oauth2/token", data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    tok = _digikey_open(req, urlopen).get("access_token")
    if not tok:
        raise DigiKeyError("no access token")
    return tok


def digikey_search(token, client_id, mpn, locale, urlopen=urllib.request.urlopen):
    req = urllib.request.Request(f"{DIGIKEY}/products/v4/search/keyword", method="POST",
                                 data=json.dumps({"Keywords": mpn, "Limit": 10, "Offset": 0}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                                          "X-DIGIKEY-Client-Id": client_id, "X-DIGIKEY-Locale-Site": locale["site"],
                                          "X-DIGIKEY-Locale-Currency": locale["currency"], "X-DIGIKEY-Locale-Language": "en"})
    return _digikey_open(req, urlopen)


def digikey_product_url(value):
    try:
        url = urllib.parse.urlsplit(value or "")
        host = r"www\.digikey\.(com|ca|co\.uk|de|fr|it|es|nl|be|at|ch|se|dk|fi|no|ie|pl|cz|com\.au|co\.nz|jp|cn|com\.mx|com\.br|in|sg|hk|tw|kr)"
        if url.scheme == "https" and url.username is None and url.password is None and url.port is None and re.fullmatch(host, url.hostname or ""):
            return value
    except (ValueError, TypeError, AttributeError):
        pass
    return None


def digikey_pick(resp, mpn, manufacturer):
    exact = [p for p in resp.get("ExactMatches") or [] if str(p.get("ManufacturerProductNumber") or "").upper() == mpn.upper()]
    manufacturer = str(manufacturer or "").strip().lower()
    if manufacturer and len(exact) > 1:
        exact = [p for p in exact if str((p.get("Manufacturer") or {}).get("Name") or "").lower().startswith(manufacturer)] or exact
    if not exact:
        return {"status": "not_found", "mpn": mpn}
    if len(exact) > 1:
        return {"status": "ambiguous", "mpn": mpn, "matches": len(exact)}
    p = exact[0]
    var = (p.get("ProductVariations") or [{}])[0]
    status = "discontinued" if p.get("Discontinued") or p.get("EndOfLife") else "out_of_stock" if not p.get("QuantityAvailable") else "ok"
    return {"status": status, "mpn": mpn,
            "quantity": p.get("QuantityAvailable"), "unit_price": p.get("UnitPrice"),
            "breaks": [[b.get("BreakQuantity"), round(b["UnitPrice"], 12) if isinstance(b.get("UnitPrice"), (int, float)) else None] for b in var.get("StandardPricing") or []][:6],
            "product_status": (p.get("ProductStatus") or {}).get("Status"),
            "url": digikey_product_url(p.get("ProductUrl"))}


def supplier_info(currency, fetched_at=None, error=None):
    return {"name": "DigiKey", "fetched_at": fetched_at, "currency": currency, "calls": 0, "error": error, "skipped": None}


def digikey_lookup(wanted, creds, settings, urlopen=urllib.request.urlopen, sleep=time.sleep,
                   now=lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")):
    cfg = settings["digikey"]
    sup = supplier_info(cfg["currency"], now())
    results, stop = {}, None
    failures, consecutive, last_error, refreshed = 0, 0, None, False
    locale = {"site": cfg["site"], "currency": cfg["currency"]}
    try:
        sup["calls"] += 1
        token = digikey_token(creds[0], creds[1], urlopen)
    except DigiKeyError as e:
        stop = f"sign-in failed: {e}"
    def call(mpn):
        nonlocal token, refreshed
        sup["calls"] += 1
        try:
            return digikey_search(token, creds[0], mpn, locale, urlopen)
        except DigiKeyAuth as e:
            if refreshed:
                raise DigiKeyStop(str(e))
        refreshed = True
        sleep(0.6)
        sup["calls"] += 1
        try:
            token = digikey_token(creds[0], creds[1], urlopen)
        except DigiKeyError as e:
            raise DigiKeyStop(f"sign-in failed: {e}")
        sleep(0.6)
        return call(mpn)

    for i, k in enumerate(sorted(wanted)):
        if stop or i >= cfg["max_lookups"]:
            results[k] = {"status": "unavailable" if stop else "run_limit", "mpn": wanted[k]["mpn"]}
            continue
        if i:
            sleep(0.6)  # stays under DigiKey's 120/min burst limit
        try:
            response = call(wanted[k]["mpn"])
            try:
                results[k] = digikey_pick(response, wanted[k]["mpn"], wanted[k]["manufacturer"])
            except (AttributeError, TypeError, KeyError, IndexError, ValueError):
                raise DigiKeyError("invalid response")
            consecutive = 0
        except DigiKeyStop as e:
            stop = str(e)
            results[k] = {"status": "unavailable", "mpn": wanted[k]["mpn"]}
        except DigiKeyError as e:
            failures += 1
            consecutive += 1
            last_error = str(e)
            results[k] = {"status": "unavailable", "mpn": wanted[k]["mpn"]}
            if consecutive >= 3:
                stop = f"3 consecutive lookups failed (last: {last_error})"
    sup["error"] = stop or (f"{failures} lookups failed (last: {last_error})" if failures else None)
    return {"supplier": sup, "results": results}


LCSC_FIELDS = ("lcsc", "lcsc part", "lcsc part #", "lcsc part number", "jlcpcb part #")
MPN_FIELDS = ("mpn", "manufacturer_part_number", "manufacturer part number", "mfr. part #", "mfg part #")
MANUFACTURER_FIELDS = ("manufacturer", "mfr", "mfr.", "manufacturer_name", "manufacturer name")
PLACEHOLDERS = {"tbd", "?", "x", "todo", "na", "n/a", "-", "~", ""}


def field(props, names):
    v = next((props[k] for k in props if k.strip().lower() in names), "")
    v = (v or "").strip()
    return None if v in ("", "~") else v


def present(v):
    return (v or "").strip().lower() not in PLACEHOLDERS


def placeholder(v):
    return (v or "").strip() not in ("", "~") and not present(v)


COVERAGE_FIELDS = {
    "Value": lambda p: p.get("Value"), "Footprint": lambda p: p.get("Footprint"),
    "LCSC": lambda p: field(p, LCSC_FIELDS), "MPN": lambda p: field(p, MPN_FIELDS),
    "Manufacturer": lambda p: field(p, MANUFACTURER_FIELDS), "Datasheet": lambda p: field(p, ("datasheet",)),
}


def bom_parts(objs):
    """BOM symbols, one entry per reference (units of one part count once); DNP, excluded and unannotated parts left out."""
    out = {}
    for o in objs.values():
        p = o["props"]
        if o["kind"] != "symbol" or p.get("in_bom") == "no" or p.get("dnp") == "yes" or o["ref"].endswith("?"):
            continue
        out.setdefault(o["ref"].split(" unit ")[0], p)
    return out


def bom_coverage(objs, settings):
    """Covered and total parts per BOM field; critical-part datasheets; parts with every order-ready field."""
    parts = bom_parts(objs)
    has = lambda p, f: present(COVERAGE_FIELDS[f](p))
    cov = {f: [sum(has(p, f) for p in parts.values()), len(parts)] for f in COVERAGE_FIELDS}
    prefixes = set(settings["bom"]["critical_prefixes"])
    critical = [p for r, p in parts.items() if (m := re.match(r"[A-Za-z]+", r)) and m.group(0) in prefixes]
    cov["Datasheet (critical)"] = [sum(has(p, "Datasheet") for p in critical), len(critical)]
    order = settings["bom"]["order_ready_fields"] or (["Value", "Footprint", "LCSC"] if settings["fabrication"]["preset"] == "jlcpcb" else ["Value", "Footprint", "MPN"])
    cov["Order ready"] = [sum(all(has(p, f) for f in order) for p in parts.values()), len(parts)]
    return cov


def bom_identity(obj):
    """Canonical BOM contract for one schematic object (spec 08). Fields are unclipped; display clipping belongs to 09."""
    p = obj.get("props") or {}
    ref = (obj.get("ref") or "").split(" unit ")[0]  # units of one part share their base reference
    reason = ("not_symbol" if obj.get("kind") != "symbol" else "dnp" if p.get("dnp") == "yes" else
              "excluded" if p.get("in_bom") == "no" else "unannotated" if ref.endswith("?") else None)
    value, footprint = p.get("Value", ""), p.get("Footprint", "")
    lcsc, mpn = (field(p, LCSC_FIELDS) or "").upper() or None, field(p, MPN_FIELDS)
    ds = field(p, ("datasheet",))
    return {"included": reason is None, "excludedReason": reason, "ref": ref, "value": value, "footprint": footprint,
            "lcsc": lcsc, "mpn": mpn, "manufacturer": field(p, MANUFACTURER_FIELDS),
            "datasheet": ds if ds and ds.lower().startswith(("http://", "https://")) else None,
            "category": bom_category(ref, p.get("symbol")),
            # ensure_ascii=False, compact separators. 10 uses this key as received from 09 and never recomputes it.
            "key": json.dumps([value, footprint, lcsc or "", mpn or ""], ensure_ascii=False, separators=(",", ":"))}


def parts_lines(objs):
    """One line per distinct part on the schematic (Value + Footprint + LCSC + MPN), with what blocks a supplier lookup."""
    lines, first_key, conflicts = {}, {}, set()
    for o in objs.values():
        b = bom_identity(o)
        if not b["included"]:
            continue
        if first_key.setdefault(b["ref"], b["key"]) != b["key"]:
            conflicts.add(b["ref"])  # units of one reference disagree: count once and flag below
            continue
        line = lines.setdefault(b["key"], {
            "value": b["value"], "footprint": b["footprint"], "lcsc": b["lcsc"], "mpn": b["mpn"],
            "manufacturer": b["manufacturer"], "category": b["category"], "datasheet": b["datasheet"],
            "key": b["key"], "refs": [], "problems": []})
        if b["ref"] not in line["refs"]:
            line["refs"].append(b["ref"])
            # Per-reference values: a grouped line can hide one reference's MPN or placeholder behind another's.
            line.setdefault("_each", []).append((b["ref"], b["mpn"], (b["value"], b["mpn"], b["lcsc"])))
    by_lcsc = {}
    for l in lines.values():
        l["refs"].sort(key=natural)
        if l["lcsc"] and not re.fullmatch(r"C\d+", l["lcsc"]):
            l["problems"].append("bad_lcsc")
        if not l["lcsc"]:
            l["problems"].append("missing_lcsc")
        if not l["mpn"] and not l["lcsc"]:
            l["problems"].append("missing_mpn")
        bad = [r for r, _, vals in l["_each"] if any(placeholder(v) for v in vals)]
        if bad:
            l["problems"].append("placeholder")
            l.setdefault("problem_refs", {})["placeholder"] = bad
        if l["lcsc"]:
            by_lcsc.setdefault(l["lcsc"], set()).add(l["value"])
    for l in lines.values():
        if l["lcsc"] and len(by_lcsc[l["lcsc"]]) > 1:
            l["problems"].append("lcsc_conflict")
    by_mpn = {}
    for l in lines.values():
        for _, mpn, _ in l["_each"]:
            if mpn and present(mpn):
                by_mpn.setdefault(mpn.upper(), set()).add(l["footprint"])
    for l in lines.values():
        hit = [r for r, mpn, _ in l.pop("_each") if mpn and len(by_mpn.get(mpn.upper(), ())) > 1]
        if hit:
            l["problems"].append("mpn_footprint_conflict")
            l.setdefault("problem_refs", {})["mpn_footprint_conflict"] = hit
        l["refsCompressed"] = ref_ranges(l["refs"])
        if conflicts.intersection(l["refs"]):
            l["problems"].append("unit_identity_conflict")
    return sorted(lines.values(), key=lambda l: natural(l["refs"][0]))


# ---- BOM view: categories, reference ranges and summary (spec 08). ----

BOM_CATEGORIES = ("Resistors", "Capacitors", "Inductors & Ferrites", "Diodes & LEDs", "Transistors",
                  "ICs & Modules", "Connectors", "Test Points", "Mechanical", "Other")
BOM_PREFIXES = {"R": "Resistors", "RN": "Resistors", "RV": "Resistors", "C": "Capacitors", "L": "Inductors & Ferrites",
                "FB": "Inductors & Ferrites", "D": "Diodes & LEDs", "LED": "Diodes & LEDs", "Q": "Transistors",
                "U": "ICs & Modules", "IC": "ICs & Modules", "J": "Connectors", "P": "Connectors", "CN": "Connectors",
                "TP": "Test Points", "H": "Mechanical", "MH": "Mechanical"}
# KiCad library nicknames that say what a part is when its reference prefix does not.
BOM_LIBRARY_WORDS = (("connector", "Connectors"), ("testpoint", "Test Points"), ("mountinghole", "Mechanical"),
                     ("transistor", "Transistors"), ("mcu", "ICs & Modules"), ("regulator", "ICs & Modules"),
                     ("amplifier", "ICs & Modules"), ("memory", "ICs & Modules"), ("interface", "ICs & Modules"),
                     ("sensor", "ICs & Modules"), ("rf_module", "ICs & Modules"))


def bom_category(ref, lib_id):
    """Category from the reference prefix (R, C, L/FB, D/LED, Q, U, J/P, TP, H/MH), then the symbol name
    (Device:R_Small is an R), then the library nickname (Connector_Generic); Other for the rest."""
    prefix = re.match(r"[A-Za-z]+", ref or "")
    if prefix and prefix.group(0).upper() in BOM_PREFIXES:
        return BOM_PREFIXES[prefix.group(0).upper()]
    library, _, item = (lib_id or "").rpartition(":")
    head = re.match(r"([A-Za-z]+)(?:_|$)", item)  # "R_Small" is an R; "L7805" is not an inductor
    if head and head.group(1).upper() in BOM_PREFIXES:
        return BOM_PREFIXES[head.group(1).upper()]
    return next((category for word, category in BOM_LIBRARY_WORDS if word in library.lower()), "Other")


def ref_ranges(refs):
    """['R1','R3','R7','R8','R9','R12'] -> 'R1, R3, R7-R9, R12'. Runs of two or more join. Prefixes stay apart;
    sub-parts (U1A), suffixes (R5A), leading zeros (R01) and non-numeric references stay literal and break a run."""
    out, run = [], []

    def flush():
        out.append(f"{run[0][0]}{run[0][1]}-{run[-1][0]}{run[-1][1]}" if len(run) > 1 else "".join(run[0]))
        run.clear()

    for ref in sorted(set(refs), key=lambda ref: (natural(ref), ref)):
        m = re.fullmatch(r"([A-Za-z_]+)([1-9]\d*)", ref)
        if m and run and run[-1][0] == m.group(1) and int(run[-1][1]) + 1 == int(m.group(2)):
            run.append(m.groups())
            continue
        if run:
            flush()
        if m:
            run.append(m.groups())
        else:
            out.append(ref)
    if run:
        flush()
    return ", ".join(out)


def bom_summary(lines):
    """Header numbers of the BOM view; byCategory counts components and keeps BOM_CATEGORIES order."""
    by = Counter()
    for line in lines:
        by[line["category"]] += len(line["refs"])
    return {"components": sum(by.values()), "unique": len(lines), "withMpn": sum(1 for l in lines if present(l["mpn"])),
            "byCategory": {c: by[c] for c in BOM_CATEGORIES if by[c]}}


# Vendored bom_csv.py (Bouni/kicad-jlcpcb-tools, MIT; commit and licence in vendor/bom_csv.py). Loaded by path, so this
# module's own bom_csv(lines) writer keeps its name.
_VENDOR_SPEC = importlib.util.spec_from_file_location("vendor_bom_csv", pathlib.Path(__file__).with_name("vendor") / "bom_csv.py")
vendor_bom_csv = importlib.util.module_from_spec(_VENDOR_SPEC)
_VENDOR_SPEC.loader.exec_module(vendor_bom_csv)


# ---- BOM files for the report (spec 08): the generic CSV, the JLCPCB file through the vendored planner, and PCBWay. ----
# ponytail: ceiling: these writers serve the report only; the release (07) keeps KiCad's own export (Owner decision 2026-10-26:
# option A). Ceiling of the JLCPCB file: the planner splits by the bytes-less-CRLF rule, so a split that is 2,049-2,050 bytes with its
# CRLF refuses the whole file (fail closed) rather than re-splitting under the stricter rule.

BOM_LINE_MAX_BYTES = vendor_bom_csv.BOM_LINE_MAX_BYTES  # 2048, the vendored rule; JLCPCB rejects longer designator cells
BOM_JLCPCB_HEADER = ("Comment", "Designator", "Footprint", "LCSC", "Quantity")
BOM_PCBWAY_HEADER = ("Designator", "Qty", "Manufacturer", "Mfg Part #", "Description/Value", "Package/Footprint")
BOM_HEADER = ("Category", "Quantity", "Value", "Footprint", "References", "MPN", "LCSC", "Datasheet")


def neutral(text):
    """A cell a spreadsheet would run as a formula (=, +, -, @, tab, CR) gets a leading quote. Applied once per cell."""
    text = "" if text is None else str(text)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def csv_line(cells):
    """One CSV line with CRLF; every cell passes through neutral()."""
    out = io.StringIO()
    csv.writer(out, lineterminator="\r\n").writerow([neutral(c) for c in cells])
    return out.getvalue()


def bom_order(lines):
    return sorted(lines, key=lambda l: (BOM_CATEGORIES.index(l["category"]), natural(l["refs"][0])))


def bom_csv(lines):
    return csv_line(BOM_HEADER) + "".join(
        csv_line([l["category"], len(l["refs"]), l["value"], l["footprint"], ", ".join(l["refs"]), l["mpn"], l["lcsc"], l["datasheet"]])
        for l in bom_order(lines))


def bom_fabrication_lines(lines, objects, part_field, preset):
    """Split ordering fields separately without changing displayed LCSC/MPN lines."""
    if objects is None:
        if part_field and part_field != PRESETS[preset]["part_field"]:
            raise ValueError("Custom fabrication.part_field needs head symbol properties")
        return lines
    selected = (part_field.strip().lower(),) if part_field else (LCSC_FIELDS if preset == "jlcpcb" else MPN_FIELDS)
    by_ref = {}
    for obj in objects.values():
        identity = bom_identity(obj)
        if not identity["included"] or identity["ref"] in by_ref:
            continue  # match parts_lines: the first eligible unit supplies each reference's fields
        number = field(obj["props"], selected)
        if preset == "jlcpcb" and not part_field:
            number = number.upper() if number else None  # same normalization as parts_lines
        by_ref[identity["ref"]] = number
    out = []
    for line in lines:
        groups = {}
        for ref in line["refs"]:
            groups.setdefault(by_ref.get(ref), []).append(ref)
        out.extend({**line, "refs": refs, "orderingPart": number} for number, refs in groups.items())
    return out


def bom_jlcpcb_csv(lines):
    """Comment, Designator, Footprint, LCSC, Quantity. The vendored planner (vendor_bom_csv.plan_bom) decides every row,
    so a longer designator list continues on another row of the same part with its own Quantity. This adapter adds the
    formula guard before planning and fails closed: a reference that cannot fit, or a written record over
    BOM_LINE_MAX_BYTES including its CRLF, raises ValueError instead of writing an oversize row."""
    groups = [vendor_bom_csv.BomGroup(neutral(l["value"]), tuple(neutral(ref) for ref in l["refs"]), neutral(l["footprint"]),
                                      neutral(l.get("orderingPart", l["lcsc"]))) for l in bom_order(lines)]
    plan = vendor_bom_csv.plan_bom(groups, None)
    if plan.warnings:
        raise ValueError(f"JLCPCB export unavailable: {plan.warnings[0]}. Shorten Value, Footprint or the ordering field, or use the generic CSV.")
    out = [csv_line(BOM_JLCPCB_HEADER)]
    for row in plan.lines:
        text = csv_line(row)
        if len(text.encode("utf-8")) > BOM_LINE_MAX_BYTES:
            raise ValueError(f"JLCPCB export unavailable: the BOM row for {row[1].split(',')[0]} is {len(text.encode('utf-8'))} UTF-8 bytes with its line break, over {BOM_LINE_MAX_BYTES}. Shorten Value, Footprint or the ordering field, or use the generic CSV.")
        out.append(text)
    return "".join(out)


def bom_pcbway_csv(lines):
    return csv_line(BOM_PCBWAY_HEADER) + "".join(
        csv_line([",".join(l["refs"]), len(l["refs"]), l["manufacturer"], l.get("orderingPart", l["mpn"]), l["value"], l["footprint"]]) for l in bom_order(lines))


def bom_exports(lines, preset, part_field=None, objects=None):
    """Keep report/generic CSV usable if fabrication export fails."""
    out = {"preset": preset, "csv": bom_csv(lines), "fab": None, "fabError": None}
    try:
        fabrication = bom_fabrication_lines(lines, objects, part_field, preset)
        out["fab"] = bom_pcbway_csv(fabrication) if preset == "pcbway" else bom_jlcpcb_csv(fabrication)
    except ValueError as exc:
        out["fabError"] = str(exc)
    return out


def diff_parts(base, head):
    """What a change did to the parts list, per reference designator, grouped back into lines."""
    at = lambda lines: {r: l for l in lines for r in l["refs"]}
    b, h = at(base), at(head)
    rows = {}
    for ref in sorted(set(b) | set(h), key=natural):
        x, y = b.get(ref), h.get(ref)
        if x and y and x["key"] == y["key"]:
            continue
        action = "added" if not x else "removed" if not y else "swapped" if x["lcsc"] != y["lcsc"] else "value" if x["value"] != y["value"] else "footprint" if x["footprint"] != y["footprint"] else "mpn"
        r = rows.setdefault((action, x and x["key"], y and y["key"]), {"action": action, "refs": [], "before": x, "after": y})
        r["refs"].append(ref)
    return list(rows.values())


def field_changes(base, head):
    """BOM field edits per reference, grouped when several references changed the same way."""
    b, h = bom_parts(base), bom_parts(head)
    norm = lambda v: v.strip() if present(v) else None
    rows = {}
    for ref in sorted(set(b) & set(h), key=natural):
        for f, get in COVERAGE_FIELDS.items():
            x, y = norm(get(b[ref])), norm(get(h[ref]))
            if x != y:
                rows.setdefault((f, x, y), {"refs": [], "field": f, "before": x, "after": y})["refs"].append(ref)
    order = list(COVERAGE_FIELDS)
    return sorted(rows.values(), key=lambda r: (natural(r["refs"][0]), order.index(r["field"])))


def mark_new_problems(base_lines, head_lines):
    """A head problem is new when any of its references did not have it in base, even if the line itself did not change."""
    before = {r: set(l["problems"]) for l in base_lines for r in l["refs"]}
    for l in head_lines:
        l["new_problems"] = [p for p in l["problems"] if any(p not in before.get(r, set()) for r in l.get("problem_refs", {}).get(p, l["refs"]))]


def dnp_mismatches(objs):
    """References fitted on one of schematic and board and DNP on the other."""
    sym = {o["ref"].split(" unit ")[0]: o["props"].get("dnp") == "yes" for o in objs.values() if o["kind"] == "symbol"}
    fp = {o["ref"]: "dnp" in (o["props"].get("attributes") or "").split() for o in objs.values() if o["kind"] == "footprint"}
    return sorted((r for r in sym.keys() & fp.keys() if sym[r] != fp[r]), key=natural)


def vkeys(v):
    """Identities of a violation for matching base and head: its item UUIDs, and its type plus what and where."""
    sig = (v["severity"], tuple(sorted(v["where"].items())))
    if v.get("key"):
        return {v["key"] + sig}
    desc = re.sub(r"[\d.]+", "#", v["description"])
    keys = {("p", v["type"], desc, tuple(v["items"]), tuple(tuple(round(c, 1) for c in p) for p in ([v["pos"]] if v["pos"] else [])))}
    if v["uuids"]:
        keys.add(("u", v["type"], tuple(v["uuids"])))
    return {k + sig for k in keys}


def waiver_key(v):
    """One stable identity per violation for kicad-review-waivers.toml: the strongest of the identities vkeys matches on."""
    ident = max(vkeys(v if v.get("key") else {**v, "uuids": sorted(v["uuids"])}), key=lambda k: k[0] == "u")
    return "w-" + hashlib.sha1(repr(ident).encode()).hexdigest()[:12]


WAIVERS_FILE = "kicad-review-waivers.toml"
WAIVABLE = ("erc", "drc", "parity")


def parse_waivers(text, source):
    """Entries of one waivers file, and messages for the ones that cannot apply. Never exits: a bad entry must not stop reviews."""
    try:
        raw = tomllib.loads(text).get("waiver", [])
    except tomllib.TOMLDecodeError as e:
        return [], [f"{source}: not valid TOML ({e})"]
    if not isinstance(raw, list):
        return [], [f"{source}: waiver must be a list of tables"]
    good, bad = [], []
    for i, w in enumerate(raw, 1):
        where = f"{source} waiver {i}"
        if not isinstance(w, dict):
            bad.append(f"{where}: must be a table")
            continue
        problems = [p for p, ok in (
            (f"check must be one of {', '.join(WAIVABLE)}, not {w.get('check')!r}", w.get("check") in WAIVABLE),
            ("match must be a waiver key like w-1a2b3c4d5e6f", isinstance(w.get("match"), str) and re.fullmatch(r"w-[0-9a-f]{12}", w["match"])),
            ("reason must not be empty", isinstance(w.get("reason"), str) and w["reason"].strip()),
            ("by must be a GitHub login", isinstance(w.get("by"), str) and w["by"].strip()),
            ("date must be a date like 2026-10-12", type(w.get("date")) is datetime.date),
            ("permanent must be true or false", "permanent" not in w or isinstance(w["permanent"], bool)),
            ("ref must be a string", "ref" not in w or isinstance(w["ref"], str)),
            ("until must be a date like 2026-12-31", "until" not in w or type(w["until"]) is datetime.date),
            ("set until = <date> or permanent = true", type(w.get("until")) is datetime.date or w.get("permanent") is True),
        ) if not ok]
        if problems:
            bad.append(f"{where}: {'; '.join(problems)}")
            continue
        good.append({"check": w["check"], "match": w["match"], "reason": w["reason"].strip(), "by": w["by"].strip(),
                     "date": w["date"].isoformat(), "until": w["until"].isoformat() if type(w.get("until")) is datetime.date else None,
                     "permanent": w.get("permanent") is True, "ref": w.get("ref") if isinstance(w.get("ref"), str) else None})
    return good, bad


def load_waivers(ref):
    """Waivers that apply come from the target branch at ref (repo/ history), so a change cannot waive its own violations.
    The head copy's extra entries are only proposals."""
    today = datetime.datetime.now(datetime.timezone.utc).date()
    head_path = f"head/{WAIVERS_FILE}"
    out = {"active": {}, "expired": [], "proposed": [], "invalid": []}
    resolved = git("-C", "repo", "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}", check=False) if ref else None
    if ref and not resolved:
        out["invalid"].append(f"{WAIVERS_FILE}: cannot resolve {ref}")
    label = resolved[:7] if resolved else ref
    try:
        result = subprocess.run(["git", "-C", "repo", "show", f"{resolved}:{WAIVERS_FILE}"], capture_output=True) if resolved else None
        text = result.stdout.decode("utf-8") if result and result.returncode == 0 else None
    except UnicodeError as e:
        text = None
        out["invalid"].append(f"{WAIVERS_FILE} at {label}: cannot read ({e})")
    if text:
        entries, out["invalid"] = parse_waivers(text, f"{WAIVERS_FILE} at {label}")
        for e in entries:
            if e["until"] and datetime.date.fromisoformat(e["until"]) < today:
                out["expired"].append(e)
            else:
                out["active"][(e["check"], e["match"])] = e
    if os.path.islink(head_path) or (os.path.exists(head_path) and not os.path.isfile(head_path)):
        out["invalid"].append(f"{WAIVERS_FILE} in this change: must be a regular file, not a symlink")
    elif os.path.isfile(head_path):
        try:
            with open(head_path, "rb") as fh:
                content = fh.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                entries, invalid = [], [f"{WAIVERS_FILE} in this change: exceeds 1 MiB"]
            else:
                head_text = content.decode("utf-8")
                entries, invalid = parse_waivers(head_text, f"{WAIVERS_FILE} in this change")
                if head_text == text:
                    invalid = []
        except (OSError, UnicodeError) as e:
            entries, invalid = [], [f"{WAIVERS_FILE} in this change: cannot read ({e})"]
        out["proposed"] = [e for e in entries if (e["check"], e["match"]) not in out["active"]]
        out["invalid"] += invalid
    for m in out["invalid"]:
        print(f"::warning::{m}")
    return out


def run_check(name, settings, head, base, waivers=None):
    level = settings["checks"].get(name, "off")
    if level == "off" or head is None:
        return None
    base_keys = set().union(*(vkeys(v) for v in base or []))
    head_keys = set().union(*(vkeys(v) for v in head))
    for v in head:
        v["new"] = not (vkeys(v) & base_keys)
        if waivers is not None:
            v["waiver_key"] = waiver_key(v)
            w = waivers["active"].get((name, v["waiver_key"]))
            if w:
                v["waived"] = {"reason": w["reason"], "by": w["by"], "until": w["until"], "ref": w["ref"]}
    live = [v for v in head if not v.get("waived")]
    count = lambda sev, new=False: sum(1 for v in live if v["severity"] == sev and (v["new"] or not new))
    failing = count("error", new=settings["fail_on"] == "new") > 0
    head.sort(key=lambda v: (not v["new"], v["severity"] != "error", v["type"]))
    result = {"name": name, "title": CHECK_NAMES[name], "level": level,
              "status": "pass" if not failing else "fail" if level == "required" else "warn",
              "errors": count("error"), "warnings": count("warning"),
              "new_errors": count("error", True), "new_warnings": count("warning", True),
              "fixed": sum(1 for v in base or [] if not (vkeys(v) & head_keys)),
              "violations": head}
    if waivers is not None:
        result["waived"] = len(head) - len(live)
    return result


def project_checks(p, settings, objs, waivers=None):
    out_dir = f"review/{project_id(p['dir'])}"
    sch = lambda s: os.path.exists(posixpath.join(s, p["dir"], f"{p['name']}.kicad_sch"))

    def side(s, f, k):
        src = posixpath.join(s, p["dir"], f"{p['name']}.{'kicad_sch' if k == 'erc' else 'kicad_pcb'}")
        if os.path.exists(src) and not os.path.exists(f"{out_dir}/{s}/{f}"):  # never drop a check because its output is missing
            sys.exit(f"kicad-cli wrote no {f} for {src}")
        return load_violations(f"{out_dir}/{s}/{f}", k, objs[s])
    fields = settings["bom"]["required_fields"]
    checks = [
        run_check("erc", settings, side("head", "erc.json", "erc"), side("base", "erc.json", "erc"), waivers),
        run_check("drc", settings, side("head", "drc.json", "drc"), side("base", "drc.json", "drc"), waivers),
        run_check("parity", settings, side("head", "drc.json", "parity") if sch("head") else None,
                  side("base", "drc.json", "parity") if sch("base") else None, waivers),
        run_check("bom", settings, bom_violations(objs["head"], fields) if sch("head") else None,
                  bom_violations(objs["base"], fields) if sch("base") else None),
    ]
    out = [c for c in checks if c] + [
        {"name": name, "title": CHECK_NAMES[name], "level": settings["checks"][name], "status": "not_run", "reason": "no schematic",
         "errors": 0, "new_errors": 0, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}
        for name in ("parity", "bom") if not sch("head") and settings["checks"].get(name, "off") != "off"]
    if settings["checks"].get("release", "off") != "off":
        pcb = lambda s: posixpath.join(s, p["dir"], f"{p['name']}.kicad_pcb")
        preset = settings["fabrication"]["preset"]
        if not os.path.exists(pcb("head")):
            out.append({"name": "release", "title": CHECK_NAMES["release"], "level": settings["checks"]["release"], "status": "not_run",
                        "reason": "no board", "errors": 0, "new_errors": 0, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []})
        else:
            side = lambda s: release_findings(f"{out_dir}/{s}/fab", p["name"], preset, pcb(s), objs[s]) if os.path.exists(pcb(s)) else None
            c = run_check("release", settings, side("head"), side("base"))
            c["package"] = package_summary(f"{out_dir}/head/fab")
            out.append(c)
    ic = interface_check(p, settings, objs, f"review/{project_id(p['dir'])}")
    return out + ([ic] if ic else [])


# ---- Interface checks: design-review rules on the schematic netlist. ----
GROUND = re.compile(r"^[ADP]?GND\w*$|^VSS\w*$|^EARTH$", re.I)
RAIL = re.compile(r"^\+|^V(CC|DD|BUS|IN|BAT|SYS)|^P\d+V\d*|^\d+V\d*(?:[A-Z_].*)?$|^\d+\.\d+V$|_\d+V\d*$", re.I)


def parse_netlist(text):
    root = parse_sexpr(text)
    comps = {}
    for c in findall(find(root, "components") or [], "comp"):
        ls = find(c, "libsource")
        comps[val(c, "ref")] = {"value": val(c, "value", ""), "footprint": val(c, "footprint", ""),
                                "lib": f"{val(ls, 'lib', '')}:{val(ls, 'part', '')}", "description": val(ls, "description", "")}
    nets = {val(n, "name"): [{"ref": val(x, "ref"), "pin": val(x, "pin"), "function": val(x, "pinfunction", ""), "type": val(x, "pintype", "")}
                             for x in findall(n, "node")] for n in findall(find(root, "nets") or [], "net")}
    return comps, nets


def ohms(value):
    if not value or len(value) > 32:
        return None
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*([rRkKmM]?)(\d*)(?=\s|Ω|$|[oO][hH][mM])", value)
    if not m:
        return None
    whole, unit, frac = m.groups()
    return float(f"{whole}.{frac}" if frac else whole) * {"": 1, "r": 1, "R": 1, "k": 1e3, "K": 1e3, "m": 1e-3, "M": 1e6}[unit]


short = lambda net: re.sub(r"^NET-\((.*)\)$", r"\1", (net or "").rstrip("/").split("/")[-1].upper())  # Net-(U1-SDA) -> U1-SDA
is_ground = lambda net: bool(GROUND.match(short(net)))
is_power = lambda net, nodes: is_ground(net) or bool(RAIL.search(short(net))) or any(n["type"] == "power_out" for n in nodes)


def matches(name, patterns):
    tokens = re.split(r"[^A-Z0-9]+", (name or "").upper())
    return any(p.upper() in tokens or (name or "").upper() == p.upper() for p in patterns)


def interface_check(p, settings, objs, out_dir):
    if settings["checks"].get("interfaces", "off") == "off":
        return None
    patterns = {k: INTERFACE_PATTERNS[k] + settings["interfaces"].get(k, []) for k in INTERFACE_PATTERNS}
    def side(s):
        path = f"{out_dir}/{s}/netlist.net"
        if not os.path.exists(path):
            return None, None
        syms = {o["ref"].split(" unit ")[0]: o for o in (objs.get(s) or {}).values() if o["kind"] == "symbol"}
        where_of = lambda ref: (syms[ref]["where"], syms[ref]["pos"][:2] if syms[ref].get("pos") else None) if ref in syms else ({"sheet": "/"}, None)
        with open(path, encoding="utf-8") as fh:
            return interface_findings(*parse_netlist(fh.read()), patterns, where_of)
    (head, coverage), (base, _) = side("head"), side("base")
    if head is None:
        return {"name": "interfaces", "title": CHECK_NAMES["interfaces"], "level": settings["checks"]["interfaces"], "status": "not_run",
                "reason": "no schematic", "errors": 0, "new_errors": 0, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}
    c = run_check("interfaces", settings, head, base)
    c["coverage"] = coverage
    return c


def interface_findings(comps, nets, patterns, where_of):
    """Design-review rules on one revision's netlist. Every finding carries its nets and pins as evidence."""
    out, detected = [], {}
    pin_net = {(n["ref"], n["pin"]): name for name, nodes in nets.items() for n in nodes}
    # ponytail: resistor arrays are ignored; add per-element topology if array support is needed.
    is_res = lambda ref: re.match(r"R\d", ref) and ohms(comps.get(ref, {}).get("value")) is not None
    other = lambda ref, pin: next((name for (r, p), name in pin_net.items() if r == ref and p != pin), None)
    esd = lambda r: re.search("|".join(map(re.escape, patterns["esd_parts"])), f"{comps.get(r, {}).get('lib', '')} {comps.get(r, {}).get('value', '')} {comps.get(r, {}).get('description', '')}", re.I)
    node_txt = lambda n: f"{n['ref']} pin {n['pin']}" + (f" ({n['function']})" if n["function"] else "")

    def add(type_, severity, description, ref, items):
        where, pos = where_of(ref)
        out.append({"type": type_, "severity": severity, "description": description, "items": items, "uuids": [],
                    "pos": pos, "box": None, "where": where})

    for name, nodes in nets.items():
        if any(matches(n["function"], patterns["can_h"] + patterns["can_l"]) or
               re.search(r"CAN|RS485|RS-485|LIN|transceiver", " ".join(comps.get(n["ref"], {}).get(k, "") for k in ("lib", "value", "description")), re.I) for n in nodes):
            continue
        tx = [n for n in nodes if n["type"] in ("output", "bidirectional") and matches(n["function"], patterns["uart_tx"])]
        if tx: detected["UART"] = detected.get("UART", 0) + 1
        if len({n["ref"] for n in tx}) > 1:
            add("uart_tx_to_tx", "error", f"Two transmit pins drive {name}. Assumes pin functions name UART directions.", tx[0]["ref"], [node_txt(n) for n in tx])
    for key in ("i2c_sda", "i2c_scl"):
        for name, nodes in nets.items():
            if not matches(short(name), patterns[key]) and not any(matches(n["function"], patterns[key]) for n in nodes):
                continue
            detected["I2C nets"] = detected.get("I2C nets", 0) + 1
            nearby = {name} | {o for n in nodes if is_res(n["ref"]) and ohms(comps[n["ref"]]["value"]) < 1000 and (o := other(n["ref"], n["pin"])) and not is_power(o, nets.get(o, []))}
            ups = [n for bus in nearby for n in nets.get(bus, []) if is_res(n["ref"]) and (o := other(n["ref"], n["pin"])) and is_power(o, nets.get(o, [])) and not is_ground(o)]
            ic = next((n["ref"] for n in nodes if not is_res(n["ref"])), nodes[0]["ref"] if nodes else "")
            if not ups:
                add("i2c_no_pullup", "error", f"{name} has no pull-up resistor to a supply. Assumes the pull-up is on this board.", ic, [node_txt(n) for n in nodes])
            elif len(ups) > 1:
                par = 1 / sum(1 / ohms(comps[n["ref"]]["value"]) for n in ups)
                add("i2c_multiple_pullups", "warning", f"{name} has {len(ups)} pull-ups in parallel ({round(par)} Ω).", ups[0]["ref"], [node_txt(n) for n in ups])
    def matching_nets(key):
        return [name for name, nodes in nets.items() if matches(short(name), patterns[key]) or any(matches(n["function"], patterns[key]) for n in nodes)]

    can_h, can_l = matching_nets("can_h"), matching_nets("can_l")
    if can_h and can_l:
        detected["CAN"] = len(can_h)
        terminated = any(is_res(n["ref"]) and 114 <= ohms(comps[n["ref"]]["value"]) <= 126 and other(n["ref"], n["pin"]) in can_l for h in can_h for n in nets[h])
        if not terminated:
            ref = next((n["ref"] for n in nets[can_h[0]] if not is_res(n["ref"])), nets[can_h[0]][0]["ref"])
            add("can_no_termination", "warning", f"No 120 Ω resistor between {can_h[0]} and {can_l[0]}. Fine if this node is not at a bus end.", ref, [can_h[0], can_l[0]])
    for ref, c in comps.items():
        if not (re.match(r"J\d", ref) and re.search(r"USB.?C|TYPE.?C", f"{c['lib']} {c['value']} {c['footprint']}", re.I)):
            continue
        detected["USB-C"] = detected.get("USB-C", 0) + 1
        for name, nodes in nets.items():
            for node in nodes:
                if node["ref"] != ref or not re.fullmatch(r"CC\d?", node["function"].upper()):
                    continue
                pulled = any(is_res(n["ref"]) and 4850 <= ohms(comps[n["ref"]]["value"]) <= 5360 and is_ground(other(n["ref"], n["pin"]) or "") for n in nets[name])
                driven = any(n["ref"] != ref and not is_res(n["ref"]) and not esd(n["ref"]) for n in nets[name])
                if not pulled and not driven:
                    add("usb_cc_floating", "error", f"{node['function']} of {ref} floats: needs 5.1 kΩ to GND or a PD controller.", ref, [node_txt(node)])
    # ponytail: same-net only; follow series resistors one hop if teams protect through them
    total = prot = 0
    for ref in sorted((r for r in comps if re.match(r"J\d", r)), key=natural):
        bare = []
        for (r, pin), name in sorted(pin_net.items(), key=lambda e: natural(e[0][1])):
            if r != ref or is_power(name, nets[name]) or len(nets[name]) < 2:
                continue
            total += 1
            if any(esd(n["ref"]) for n in nets[name] if n["ref"] != ref):
                prot += 1
            else:
                bare.append(f"{ref} pin {pin} on {name}")
        if bare:
            add("connector_no_esd", "warning", f"{ref} signal pins without an ESD or TVS part on the same net. Assumes protection is not elsewhere on the cable.", ref, bare)
    rails = {}
    for name, nodes in nets.items():
        if is_power(name, nodes) and not is_ground(name):
            for n in nodes:
                if n["type"] == "power_in" and n["ref"].startswith("U"):
                    rails.setdefault(n["ref"], set()).add(name)
    for name, nodes in nets.items():
        if is_power(name, nodes):
            continue
        ics = sorted({n["ref"] for n in nodes if n["ref"] in rails}, key=natural)
        for a, b in ((x, y) for i, x in enumerate(ics) for y in ics[i + 1:]):
            if rails[a].isdisjoint(rails[b]):
                add("voltage_domain", "warning", f"{name} joins {a} ({', '.join(sorted(rails[a]))}) and {b} ({', '.join(sorted(rails[b]))}). Check levels.", a, [name])
                break
    return out, {"detected": detected, "protected": [prot, total]}


def page_svg(out_dir, name, page):
    """The SVG kicad-cli wrote for a page: <project>-<sheet>-<subsheet>....svg, <project>.svg for the root."""
    path = f"{out_dir}/sch/{page['stem']}.svg"
    if not os.path.exists(path):  # never show a page as unchanged because its drawing is missing
        sys.exit(f"kicad-cli wrote no drawing for sheet {page['name']!r} (expected {path})")
    return path


def svg_body(path):
    """SVG text without the export timestamp, so identical drawings compare equal."""
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return re.sub(r"<title>.*?</title>", "", fh.read(), count=1, flags=re.S)


def svg_size(text):
    match = re.search(r"viewBox\s*=\s*[\"']([^\"']+)[\"']", text)
    values = [float(v) for v in re.split(r"[\s,]+", match[1].strip())] if match else []
    if len(values) != 4 or not all(math.isfinite(v) for v in values) or min(values[2:]) <= 0:
        raise ValueError("SVG needs a finite viewBox with positive width and height")
    return values[2:]


def has_drawing(text):
    return re.search(r"<(path|polyline|polygon|circle|rect|line|ellipse|text)\b", text) is not None


def add_blob(blobs, content):
    """Store text or bytes gzip+base64 in blobs, deduplicated by content; return its key."""
    if content is None:
        return None
    content = content.encode() if isinstance(content, str) else content
    key = hashlib.sha1(content).hexdigest()[:12]
    if key not in blobs:
        blobs[key] = base64.b64encode(gzip.compress(content, mtime=0)).decode()
    return key


def model3d_missing(out, objs):
    """Missing 3D models from KiCad's export log and footprints without a model declaration."""
    missing = {}
    add = lambda ref, side, reason: missing.setdefault((ref, reason), set()).add(side)
    for side in ("base", "head"):
        log = f"{out}/{side}/glb.log"
        if os.path.exists(log):
            with open(log, encoding="utf-8") as fh:
                for ref in re.findall(r"Could not add 3D model for ([^.\s]+)", fh.read()):
                    add(ref, side, "file not found")
        for obj in objs[side].values():
            if obj["kind"] == "footprint" and not obj.get("has_model"):
                add(obj["ref"], side, "no model in footprint")
    rows = []
    for (ref, reason), sides in sorted(missing.items(), key=lambda e: (natural(e[0][0]), e[0][1])):
        side = "both" if sides == {"base", "head"} else next(iter(sides))
        # The block is rendered from the footprint's board-space data, including unchanged parts.
        obj = next((o for s in ("head", "base") for o in objs[s].values()
                    if o["kind"] == "footprint" and o["ref"] == ref and s in sides), None)
        row = {"ref": ref, "side": side, "reason": reason}
        if obj:
            pos = obj.get("pos")
            row.update({"pos": (pos + [0])[:3] if pos else None, "box": obj.get("box"), "layer": obj.get("props", {}).get("layer")})
        rows.append(row)
    return rows


def build_project(p, blobs, settings, waivers=None, change_offset=0):
    out = f"review/{project_id(p['dir'])}"
    sides = [s for s in ("base", "head") if os.path.isdir(f"{out}/{s}")]
    pages = {}
    for side in sides:
        for pg in sheet_pages(posixpath.join(side, p["dir"]), p["name"]):
            entry = pages.setdefault(pg["path"], {**pg, "svg": {}})
            entry.update(pg)
            entry["svg"][side] = svg_body(page_svg(f"{out}/{side}", p["name"], pg))
    sheets = []
    for pg in pages.values():
        texts = pg.pop("svg")
        del pg["stem"]
        b, h = texts.get("base"), texts.get("head")
        pg["status"] = "added" if b is None and h else "removed" if h is None and b else "modified" if b != h else "unchanged"
        pg["size"] = svg_size(h or b)
        pg["svg"] = {"base": add_blob(blobs, b), "head": add_blob(blobs, h)}
        sheets.append(pg)
    layers, changed = [], False
    names = sorted({f for s in sides if os.path.isdir(f"{out}/{s}/pcb") for f in os.listdir(f"{out}/{s}/pcb")})
    for f in names:
        b, h = (svg_body(f"{out}/{s}/pcb/{f}") for s in ("base", "head"))
        changed |= b != h
        if b is not None or h is not None:
            layers.append({"name": f[len(p["name"]) + 1: -4], "base": b, "head": h})
    has = {s: os.path.isfile(board_path(p, s)) for s in ("base", "head")}
    board = {"changed": changed, "layers": [],
             "status": "added" if not has["base"] else "removed" if not has["head"] else "modified" if changed else "unchanged"}
    if layers:
        board["size"] = svg_size(next(t for l in layers for t in (l["head"], l["base"]) if t))
        board["layers"] = [{"name": l["name"], "changed": l["base"] != l["head"],
                            "svg": {"base": add_blob(blobs, l["base"]), "head": add_blob(blobs, l["head"])}}
                           for l in layers]
    objs = {side: project_objects(posixpath.join(side, p["dir"]), p["name"]) for side in ("base", "head")}
    changes = diff_objects(objs["base"], objs["head"])
    for n, change in enumerate(changes, change_offset + 1):
        change["id"] = f"c{n}"
    geometry = {}
    pcbs = {side: posixpath.join(side, p["dir"], p["name"] + ".kicad_pcb") for side in ("base", "head")}
    same_board = all(os.path.isfile(f) for f in pcbs.values()) and filecmp.cmp(pcbs["base"], pcbs["head"], shallow=False)
    for side in ("base", "head"):
        pcb = pcbs[side]
        geometry[side] = None
        if side == "head" and same_board:
            geometry[side] = geometry["base"]
            continue
        if os.path.isfile(pcb):
            try:
                scene = board_geometry(pcb)
                # Child pads, text and graphics use their owning footprint's UUID;
                # standalone tracks/vias/zones use their own. Never match by net/ref.
                ids = {(r["kind"], r.get("uuid_before", r["uuid"]) if side == "base" else r["uuid"]): r["id"]
                       for r in changes if (r.get("where") or {}).get("board")
                       and r["action"] != ("added" if side == "base" else "removed")}
                for obj in scene["objects"]:
                    uid = obj["changeUuid"]
                    kind = objs[side].get(uid, {}).get("kind")
                    change_id = ids.get((kind, uid))
                    obj["changeIds"] = [change_id] if change_id else []
                geometry[side] = add_blob(blobs, json.dumps(scene, separators=(",", ":"), sort_keys=True))
            except Exception as exc:  # any unforeseen board construct falls back to SVG
                print(f"{pcb}: geometry unavailable; retaining SVG: {exc!r}", file=sys.stderr)
    if any(geometry.values()):
        board["geometry"] = geometry
    parts = None
    if settings["parts"]["enabled"]:
        lines = {s: parts_lines(objs[s]) for s in ("base", "head")}
        mark_new_problems(lines["base"], lines["head"])
        has_base = any(o["kind"] == "symbol" for o in objs["base"].values())
        parts = {"lines": lines["head"], "changes": diff_parts(lines["base"], lines["head"]),
                 "supplier": None,  # Filled only when DigiKey lookup is enabled.
                 "summary": bom_summary(lines["head"]), "exports": bom_exports(lines["head"], settings["fabrication"]["preset"], settings["fabrication"].get("part_field"), objs["head"]),
                 "coverage": {"base": bom_coverage(objs["base"], settings) if has_base else None, "head": bom_coverage(objs["head"], settings)},
                 "field_changes": field_changes(objs["base"], objs["head"]), "dnp_mismatch": dnp_mismatches(objs["head"])}
    if settings["3d"]["enabled"]:
        models = {side: f"{out}/{side}/board.glb" for side in ("base", "head")}
        logs = {side: f"{out}/{side}/glb.log" for side in ("base", "head")}
        board["model3d"] = {side: add_blob(blobs, pathlib.Path(path).read_bytes()) if os.path.exists(path) else None
                            for side, path in models.items()}
        board["model3d"].update({"enabled": True,
                                 "changed": board["model3d"]["base"] != board["model3d"]["head"],
                                 "errors": {side: "3D export unavailable" for side in ("base", "head")
                                            if has[side] and not board["model3d"][side]}})
        board["no_model"] = model3d_missing(out, objs)
    index = object_index(objs["base"], objs["head"], libraries=settings["libraries"]["enabled"]) if any(
        settings[name]["enabled"] for name in ("threads", "issues", "inventory", "libraries")) else None
    libraries = None
    if settings["libraries"]["enabled"]:
        roots = {side: posixpath.join(side, p["dir"]) for side in ("base", "head")}
        items = {side: library_items(root) for side, root in roots.items()}
        libraries = library_report(library_changes(items["base"], items["head"]), index, out, blobs,
                                   local_items=set(items["base"]) | set(items["head"])) or None
    return {"name": p["name"], "dir": p["dir"], "status": p["status"], "sheets": sheets, "board": board,
            "changes": changes, "checks": project_checks(p, settings, objs, waivers),
            **({"parts": parts} if parts else {}),
            **({"libraries": libraries} if libraries else {}),
            **({"objects": index} if index is not None else {})}


def assign_ids(projects):
    """Give every change row and violation an id unique within this report, for selection and addresses."""
    n = 0
    for p in projects:
        for r in p["changes"]:
            n += 1
            r["id"] = f"c{n}"
    n = 0
    for p in projects:
        for c in p["checks"]:
            for v in c["violations"]:
                n += 1
                v["id"] = f"v{n}"


def review_links(env, det):
    """github.com links for the header. Empty strings outside GitHub Actions."""
    server, repo = env.get("GITHUB_SERVER_URL", ""), env.get("GITHUB_REPOSITORY", "")
    if not (server and repo):
        return {"review": "", "base": "", "head": "", "run": ""}
    base_url = f"{server}/{repo}"
    pr = env.get("PR_NUMBER", "")
    return {
        "review": f"{base_url}/pull/{pr}" if pr else (f"{base_url}/compare/{det['base']}...{det['head']}" if det["base"] else ""),
        "base": f"{base_url}/commit/{det['base']}" if det["base"] else "",
        "head": f"{base_url}/commit/{det['head']}",
        "run": f"{base_url}/actions/runs/{env['GITHUB_RUN_ID']}" if env.get("GITHUB_RUN_ID") else "",
    }


UI_DIR = posixpath.join(posixpath.dirname(os.path.abspath(__file__)), "ui")


def inline_page(data_js):
    """ui/review.html with its CSS, the run's data and its JS inlined: one file that works offline."""
    read = lambda name: open(posixpath.join(UI_DIR, name), encoding="utf-8").read()
    has_3d = '"model3d"' in data_js
    page = (read("review.html")
            .replace('<link rel="stylesheet" href="tokens.css">\n<link rel="stylesheet" href="review.css">', f"<style>\n{read('tokens.css')}</style>\n<style>\n{read('review.css')}</style>")
            .replace('<script src="sample/review-data.js"></script>', f"<script>{data_js}</script>"))
    page = page.replace('<!-- KR_ICONS -->', read('icons/sprite.svg'))
    page = page.replace('<script src="theme.js"></script>', f"<script>\n{read('theme.js')}</script>")
    prefix = ""
    if has_3d:
        bundle = base64.b64encode(gzip.compress(open(posixpath.join(UI_DIR, "vendor/three-viewer.min.js"), "rb").read(), mtime=0)).decode()
        prefix = f'<script type="application/octet-stream" id="three-bundle">{bundle}</script><script>\n{read("review3d.js")}</script>'
    page = page.replace('<script src="review.js"></script>', f"{prefix}<script>\n{read('review.js')}</script>")
    for asset in ("kicad-colors.js", "appearance-state.js", "board-gl.js", "appearance.js", "board-marks.js", "board-diff.js"):
        page = page.replace(f'<script src="{asset}"></script>', f'<script>\n{read(asset)}</script>')
    if re.search(r'''(?:href|src)=(["'])(?:theme\.js|tokens\.css|review\.css|sample/review-data\.js|review\.js|kicad-colors\.js|board-gl\.js|appearance-state\.js|appearance\.js|board-marks\.js|board-diff\.js)\1''', page): raise RuntimeError("external report assets remain: template did not match")
    return page


def cmd_lookup(args):
    settings = load_settings()
    if not settings["digikey"]["enabled"]:
        return
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    wanted, manufacturers = {}, {}
    for project in det["projects"]:
        objects = project_objects(posixpath.join("head", project["dir"]), project["name"])
        for line in parts_lines(objects):
            raw = " ".join((line["mpn"] or "").split())
            mpn = mpn_for_lookup(raw)
            if not mpn:
                continue
            key = mpn.upper()
            wanted.setdefault(key, {"mpn": key, "manufacturer": None})
            hints = manufacturers.setdefault(key, set())
            for obj in objects.values():
                if obj["kind"] == "symbol" and obj["ref"] in line["refs"]:
                    name = field(obj["props"], ("manufacturer",))
                    if name and not digikey_placeholder(name.lower()):
                        hints.add(name.strip().lower())
    for key, hints in manufacturers.items():
        wanted[key]["manufacturer"] = next(iter(hints)) if len(hints) == 1 else None
    cfg = settings["digikey"]
    supplier = supplier_info(cfg["currency"])
    creds = (os.environ.get("DIGIKEY_CLIENT_ID", ""), os.environ.get("DIGIKEY_CLIENT_SECRET", ""))
    output = {"supplier": supplier, "results": {}}
    if not all(creds):
        supplier["skipped"] = "no credentials (forked pull request or secrets not set)"
    elif wanted:
        try:
            output = digikey_lookup(wanted, creds, settings)
        except Exception as error:
            # No response bodies or exception messages: they may contain credentials.
            supplier["error"] = f"lookup unavailable ({type(error).__name__})"
    else:
        supplier["skipped"] = "no valid MPNs"
    with open("review/supplier.json", "w", encoding="utf-8") as fh:
        json.dump(output, fh)
    print(f"DigiKey lookup: {output['supplier']['calls']} calls")


def merge_supplier(projects, lookup):
    for project in projects:
        parts = project.get("parts")
        if parts is None:
            continue
        counts = {"no_mpn": 0, "invalid_mpn": 0, "run_limit": 0}
        looked_up = set()
        for line in parts["lines"]:
            raw = line["mpn"] or ""
            mpn = mpn_for_lookup(raw)
            if not mpn:
                reason = "no_mpn" if digikey_placeholder(" ".join(raw.split())) else "invalid_mpn"
                counts[reason] += 1
                line["supplier"] = {"status": reason}
                continue
            result = lookup["results"].get(mpn.upper())
            if result:
                line["supplier"] = result
                if result["status"] == "run_limit":
                    counts["run_limit"] += 1
                elif result["status"] != "unavailable":
                    looked_up.add(mpn.upper())
            elif not lookup["supplier"].get("skipped"):
                line["supplier"] = {"status": "unavailable", "mpn": mpn}
        for change in parts.get("changes", []):
            if change["action"] == "removed" and change.get("before"):
                line = change["before"]
                line["supplier"] = {"status": "no_mpn" if digikey_placeholder(" ".join((line.get("mpn") or "").split())) else "invalid_mpn"}
        parts["supplier"] = {**lookup["supplier"], "looked_up": len(looked_up), "not_looked_up": counts}


def cmd_report(args):
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    blobs = {}
    env = os.environ
    settings = load_settings()
    # An opted-out report must remain byte-for-byte compatible with reports made before this feature.
    report_settings = {k: v for k, v in settings.items()
                       if k != "release" and not ((k in ("3d", "parts", "digikey", "threads", "issues", "waivers", "inventory", "libraries", "pdf") and not v["enabled"]) or (k == "github" and not v["check_runs"]))}
    if not settings["parts"]["enabled"]:
        report_settings["bom"] = {"required_fields": settings["bom"]["required_fields"]}
    if settings["checks"].get("interfaces") == "off":  # opted-out reports stay byte-identical
        report_settings["checks"] = {k: v for k, v in settings["checks"].items() if k != "interfaces"}
        report_settings.pop("interfaces", None)
    if settings["checks"].get("release") == "off":  # opted-out reports stay byte-identical
        report_settings["checks"] = {k: v for k, v in report_settings["checks"].items() if k != "release"}
    data = {
        "version": 1,
        "repo": env.get("GITHUB_REPOSITORY", ""),
        "links": review_links(env, det),
        "base": det["base"], "head": det["head"], "reason": det["reason"],
        "settings": report_settings,
        "run_id": env.get("GITHUB_RUN_ID", ""),
    }
    waivers = load_waivers(env.get("WAIVERS_REF") or det["base"]) if settings["waivers"]["enabled"] else None
    data["projects"] = []
    change_offset = 0
    for p in det["projects"]:
        project = build_project(p, blobs, settings, waivers, change_offset)
        data["projects"].append(project)
        change_offset += len(project["changes"])
    if settings.get("digikey", {}).get("enabled"):
        try:
            with open("review/supplier.json", encoding="utf-8") as fh:
                lookup = json.load(fh)
            if not isinstance(lookup.get("supplier"), dict) or not isinstance(lookup.get("results"), dict):
                raise ValueError("invalid supplier file")
        except (OSError, ValueError, AttributeError):
            lookup = {"supplier": supplier_info(settings["digikey"]["currency"], error="lookup unavailable (lookup step did not finish)"), "results": {}}
        merge_supplier(data["projects"], lookup)
    assign_ids(data["projects"])
    if waivers is not None:
        used = {(c["name"], v["waiver_key"]) for p in data["projects"] for c in p["checks"]
                for v in c["violations"] if v.get("waived")}
        data["waivers"] = {"stale": [e for key, e in waivers["active"].items() if key not in used],
                           "expired": waivers["expired"], "proposed": waivers["proposed"], "invalid": waivers["invalid"]}
    data["blobs"] = blobs
    payload = json.dumps(data, separators=(",", ":")).replace("<", "\\u003c")  # no </script> or <!-- in the data
    html = inline_page(f"window.REVIEW_DATA = {payload};")
    with open("review/kicad-review.html", "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"review/kicad-review.html: {len(html) / 1e6:.2f} MB, {len(blobs)} embedded drawings")
    del data["blobs"]
    with open("review/data.json", "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    failed = [f"{p['name']} {c['title']}" for p in data["projects"] for c in p["checks"] if c["status"] == "fail"]
    base = det["base"][:7] if det["base"] else "none"
    name = f"kicad-review-{base}-{det['head'][:7]}-{'fail' if failed else 'pass'}.html"
    with open(env.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as fh:
        fh.write(f"failed={', '.join(failed)}\n")
        fh.write(f"name={name}\n")
        fh.write(f"issues={'true' if settings['issues']['enabled'] else 'false'}\n")
        fh.write(f"pdf={'true' if settings.get('pdf', {}).get('enabled') else 'false'}\npdf_name={name[:-5]}.pdf\n")

        fh.write(f"threads={'true' if settings['threads']['enabled'] else 'false'}\n")


STATUS_ICON = {"pass": "✅", "fail": "❌", "warn": "⚠️", "not_run": "—"}
MARKER = "<!-- kicad-review -->"
TABLE_KINDS = ("title block", "design rules", "symbol", "footprint", "sheet", "label", "global label",
               "hierarchical label", "zone", "board outline")


def plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def md(v):
    """Text from a KiCad file as literal markdown: no HTML, images, links, emphasis or @mentions.
    Bare URLs (datasheets) stay as GitHub shows them, a visible auto-link, since escapes would end up inside the link."""
    v = str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "".join(part.replace("\\", "%5C").replace("[", "%5B").replace("]", "%5D").replace("|", "%7C") if i % 2 else re.sub(r"([\\`*_\[\]()!~#])", r"\\\1", part).replace("@", "@\u200b")
                   for i, part in enumerate(re.split(r"((?:https?://|www\.)[^\s<>]+)", v))).replace("|", "\\|")


def refs(rows, limit=3):
    names = [md(r["ref"]) for r in rows if r["ref"]]
    return f" ({', '.join(names[:limit])}{', …' if len(names) > limit else ''})" if names else ""


def summary_sentence(p):
    """'3 footprints moved (R1, R2, R3), R12 value 10k → 4.7k, 2 new DRC errors'."""
    rows, parts = p["changes"], []
    mod = lambda kind: [r for r in rows if r["action"] == "modified" and r["kind"] == kind]
    changed = lambda r, prop: any(c[0] == prop for c in r.get("changes", []))
    moved = [r for r in mod("footprint") if changed(r, "position")]
    if moved:
        parts.append(f"{plural(len(moved), 'footprint')} moved{refs(moved)}")
    values = [(r["ref"], c) for r in mod("symbol") + mod("footprint") for c in r["changes"] if c[0] == "Value"]
    seen = set()
    for ref, c in values:
        if ref not in seen and len(seen) < 5:
            seen.add(ref)
            parts.append(f"{md(ref)} value {md(c[1] or '—')} → {md(c[2] or '—')}")
    if len({v[0] for v in values}) > 5:
        parts.append(f"{len({v[0] for v in values}) - 5} more value changes")
    swapped = [r for r in mod("symbol") + mod("footprint") if changed(r, "Footprint") or changed(r, "footprint")]
    if swapped:
        parts.append(f"{plural(len(swapped), 'footprint assignment')} changed{refs(swapped)}")
    for kind, word in (("symbol", "part"), ("footprint", "footprint")):
        for action in ("added", "removed"):
            rs = [r for r in rows if r["action"] == action and r["kind"] == kind]
            if rs:
                parts.append(f"{plural(len(rs), word)} {action}{refs(rs)}")
    for kind in ("track", "via", "zone", "wire", "board outline"):
        a, d, m = (sum(1 for r in rows if r["kind"] == kind and r["action"] == x) for x in ("added", "removed", "modified"))
        if a or d or m:
            parts.append(f"{kind}s: " + ", ".join(x for x in (a and f"+{a}", d and f"−{d}", m and f"{m} changed") if x))
    for kind in ("title block", "design rules"):
        if any(r["kind"] == kind for r in rows):
            parts.append(f"{kind} changed")
    for c in p.get("libraries", []):
        parts.append(f"{c['kind']} {md(c['item'])} {c['status']}" + (f" (used by {md(', '.join(c['used_by'][:3]))}{', …' if len(c['used_by']) > 3 else ''})" if c["used_by"] else "")
                     + (f" — **{len(c['warnings'])} warning{'s' if len(c['warnings']) > 1 else ''}**" if c["warnings"] else ""))
    for c in p["checks"]:
        if c["new_errors"] and c["name"] == "bom":
            parts.append(f"**{plural(c['new_errors'], 'part')} newly missing BOM fields**")
        elif c["new_errors"]:
            parts.append(f"**{plural(c['new_errors'], 'new ' + c['title'] + ' error')}**")
        if c["fixed"]:
            parts.append(f"{c['fixed']} {c['title']} issue{'s' if c['fixed'] > 1 else ''} fixed")
    return ", ".join(parts) or "no reviewable changes"


def cell(v):
    v = "—" if v in (None, "") else str(v)
    v = v if len(v) <= 60 else v[:57] + "…"
    return md(v.replace("\n", " "))


def changes_markdown(p, limit=60):
    rows = [r for r in p["changes"] if r["kind"] in TABLE_KINDS]
    if not rows:
        return []
    lines = ["| Change | Object | Ref | Details |", "|---|---|---|---|"]
    for r in rows[:limit]:
        if r.get("changes"):
            det = "<br>".join(f"{cell(k)}: {cell(a)} → {cell(b)}" for k, a, b in r["changes"][:6])
            if len(r["changes"]) > 6:
                det += f"<br>… {len(r['changes']) - 6} more"
        else:
            det = ", ".join(f"{k}: {cell(r['props'][k])}" for k in ("Value", "Footprint", "footprint", "net", "layer", "text") if r["props"].get(k))
        lines.append(f"| {r['action']} | {r['kind']} | {cell(r['ref'])} | {det or '—'} |")
    if len(rows) > limit:
        lines.append(f"| … | | | {len(rows) - limit} more rows in the report |")
    return lines


def comment_markdown(data, images, artifact_url, artifact_id="", rows=60, site="", threads=None, log="", issues=None):
    out = [MARKER, "## KiCad review", ""]
    short = lambda s: s[:9] if s else "nothing"
    out.append(f"Comparing `{short(data['base'])}` → `{short(data['head'])}` ({data['reason']}). "
               + (f"[Workflow run]({data['links']['run']})" if data["links"].get("run") else ""))
    if site and artifact_id and data.get("repo"):
        site = site.rstrip("/")
        pdf_hint = "?pdf=1" if data.get("settings", {}).get("pdf", {}).get("enabled", False) else ""
        out.append(f"**[Open the review]({site}/r/{data['repo']}/a/{artifact_id}{pdf_hint})**")
    if artifact_url:
        out.append(f"**[Open the review page]({artifact_url})** — downloads `kicad-review.html`; open it in a browser.")
    if threads is not None:
        out.append(f"Threads: {threads['open']} open ({threads['blocking']} blocking), {threads['resolved']} resolved.")
    if issues:
        out.append(f"Touches parts named in {', '.join(f'#{n}' for n in issues)}.")
    if artifact_id and data.get("repo"):
        out += ["", "<details><summary>From a terminal</summary>", "",
                "```sh", f"gh api repos/{data['repo']}/actions/artifacts/{artifact_id}/zip > kicad-review.html && open kicad-review.html", "```",
                "", "`open` is macOS; use `xdg-open` on Linux or `start` on Windows.", "", "</details>"]
    for i, p in enumerate(data["projects"]):
        out += ["", f"### {md(p['name'])}" + (f" (`{p['dir'].replace('`', "'").replace('\n', ' ').replace('\r', ' ')}`, {p['status']})" if p["dir"] or p["status"] != "modified" else ""), "",
                summary_sentence(p) + "."]
        shots = [s for s in images if s["project"] == i]
        if shots:
            out += [""]
            for s in shots:
                out += [f"**{md(s['title'])}**", "", f"![{md(s['title'])}: before and after]({s['url']})", ""]
        table = changes_markdown(p, rows)
        other = {k: sum(1 for r in p["changes"] if r["kind"] == k) for k in ("track", "via", "wire", "bus", "junction", "no connect", "power symbol", "graphic")}
        other = ", ".join(plural(n, k) for k, n in other.items() if n)
        if table:
            out += ["", f"<details{' open' if len(table) <= 12 else ''}><summary>Object changes ({len(p['changes'])})</summary>", "", *table, ""]
            if other:
                out += [f"Also changed: {other}. Full list in the report.", ""]
            out += ["</details>"]
        elif other:
            out += ["", f"Changed: {other}. Full list in the report."]
    body = "\n".join(out)
    checks = "\n".join(readiness_markdown(data, threads, threads_required=data.get("settings", {}).get("threads", {}).get("block_merge", False))) + checks_markdown(data)
    if len(log) > 30000:
        log = "\n" + merge_log(extract_log(log), "")
    if log and len(checks) + len(log) > 59000:
        checks = checks[:max(0, 58900 - len(log))].rsplit("\n", 1)[0] + "\n\n… checks truncated. Full list in the report.\n"
        checks += "\n</details>" * (checks.count("<details") - checks.count("</details>"))
    checks += log
    parts = parts_markdown(data)
    if parts:
        # Reserve room for the body truncation notice and closing details tags.
        budget = max(0, 60000 - len(checks) - 200)
        notice = "\n\n… Parts truncated. The full list is in the report.\n"
        if len(parts) > budget:
            parts = parts[:max(0, budget - len(notice))].rsplit("\n", 1)[0] + notice if budget >= len(notice) else ""  # whole lines only
        checks += "\n" + parts + "\n"
    if len(body) + len(checks) > 60000:  # GitHub comments are limited to 65536 characters; the checks always stay
        if rows:
            return comment_markdown(data, images, artifact_url, artifact_id, rows // 2, site, threads, log, issues)
        body = body[:max(0, 60000 - len(checks))] + "\n\n… truncated. The full list is in the report.\n"
        body += "\n</details>" * (body.count("<details") - body.count("</details>"))
    return body + "\n" + checks


def shot_list(data, limit=8):
    """Drawings worth a before/after picture in the comment: changed sheets, then each changed board."""
    shots = []
    for i, p in enumerate(data["projects"]):
        for pg in p["sheets"]:
            if pg["status"] != "unchanged":
                shots.append({"project": i, "title": f"{p['name']}: sheet {pg['name']}",
                              "hash": f"p={i}&v=sheet:{pg['path']}", "file": f"p{i}-sheet-{len(shots)}.png"})
        if p["board"]["changed"]:
            shots.append({"project": i, "title": f"{p['name']}: board", "hash": f"p={i}&v=board",
                          "file": f"p{i}-board.png"})
    return shots[:limit]


def cmd_shots(args):
    with open(f"review/data.json", encoding="utf-8") as fh:
        data = json.load(fh)
    os.makedirs(f"review/images", exist_ok=True)
    report = os.path.abspath(f"review/kicad-review.html")
    done = []
    for s in shot_list(data):
        out = os.path.abspath(f"review/images/{s['file']}")
        r = subprocess.run([args.chrome, "--headless=new", "--no-sandbox", "--hide-scrollbars", "--window-size=1400,560",
                            "--virtual-time-budget=20000", f"--screenshot={out}", f"file://{report}#{s['hash']}&shot=1"],
                           capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and os.path.exists(out):
            done.append(s)
        else:
            print(f"::warning::Screenshot of {s['title']} failed: {r.stderr[-300:]}")
    with open(f"review/images/shots.json", "w", encoding="utf-8") as fh:
        json.dump(done, fh, indent=2)
    print(f"{len(done)} screenshot(s)")


def cmd_summary(args):
    with open(f"review/data.json", encoding="utf-8") as fh:
        data = json.load(fh)
    images = []
    if args.image_base and os.path.exists(f"review/images/shots.json"):
        with open(f"review/images/shots.json", encoding="utf-8") as fh:
            images = [{**s, "url": f"{args.image_base}/{s['file']}"} for s in json.load(fh)]
    site = os.environ.get("SITE", "").rstrip("/")
    threads = None
    if data["settings"].get("threads", {}).get("enabled") and os.path.exists("review/threads.json"):
        with open("review/threads.json", encoding="utf-8") as fh:
            try:
                raw = json.load(fh)
                review_threads = raw
                for key in ("data", "repository", "pullRequest", "reviewThreads"):
                    review_threads = review_threads.get(key) if isinstance(review_threads, dict) else None
                if not isinstance(raw, dict) or raw.get("errors") or not isinstance(review_threads, dict) or not review_threads:
                    print("::warning::review/threads.json has no review threads; thread counts left out")
                elif review_threads.get("totalCount", 0) > len(review_threads.get("nodes") or []):
                    # ponytail: first 100 threads; fail closed beyond the ceiling until paginated.
                    print("::warning::review/threads.json is incomplete; thread counts left out")
                else:
                    threads = thread_counts(raw)
            except ValueError:
                print("::warning::review/threads.json is not JSON; thread counts left out")
    issues = None
    if data["settings"].get("issues", {}).get("enabled") and os.path.exists("review/issues.json"):
        with open("review/issues.json", encoding="utf-8") as fh:
            try:
                issues = touched_issues(json.load(fh), data)
            except ValueError:
                print("::warning::review/issues.json is not JSON; issue links left out")
    log = ""
    if os.environ.get("HISTORY") == "true":
        previous = ""
        if os.path.exists("review/previous-log.md"):
            with open("review/previous-log.md", encoding="utf-8") as fh:
                previous = fh.read()
        when = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")
        log = "\n" + merge_log(extract_log(previous), log_row(data, when))
    body = comment_markdown(data, images, args.artifact_url, args.artifact_id, site=site, threads=threads, log=log, issues=issues)
    with open(f"review/comment.md", "w", encoding="utf-8") as fh:
        fh.write(body)
    settings = data["settings"]
    block_merge = settings.get("threads", {}).get("block_merge")
    publish_checks = settings.get("github", {}).get("check_runs")
    threads_failed = ""
    if block_merge:
        threads_failed = "blocking threads could not be read" if threads is None else (plural(threads["blocking"], "blocking thread") + " open" if threads["blocking"] else "")
    if publish_checks:
        runs = check_runs(data)
        if block_merge:
            runs.append({"name": "kicad-review / Threads", "conclusion": "failure" if threads_failed else "success",
                         "output": {"title": threads_failed or "no blocking threads open",
                                    "summary": "Resolve blocking threads in the review site or on GitHub."}})
        with open("review/check-runs.json", "w", encoding="utf-8") as fh:
            json.dump(runs, fh)
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as fh:
        fh.write(f"check_runs={'true' if publish_checks else 'false'}\n")
        fh.write(f"threads_failed={threads_failed}\n")
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as fh:
        fh.write(body.replace(MARKER, ""))
    print(body)


PROBLEM_TEXT = {"missing_lcsc": "missing LCSC number", "bad_lcsc": "LCSC number malformed", "lcsc_conflict": "one LCSC number on several values",
                "placeholder": "placeholder value", "mpn_footprint_conflict": "one MPN on several footprints",
                "unit_identity_conflict": "conflicting identities across symbol units",
                "out_of_stock": "out of stock", "not_found": "not found at DigiKey", "ambiguous": "several DigiKey matches", "discontinued": "discontinued", "unavailable": "lookup unavailable"}
BLOCKING = {"missing_lcsc", "bad_lcsc", "lcsc_conflict", "placeholder", "mpn_footprint_conflict", "unit_identity_conflict", "out_of_stock", "not_found", "discontinued"}


def parts_markdown(data):
    out = []
    for p in data["projects"]:
        parts = p.get("parts")
        if not parts:
            continue
        if any("new_problems" in l for l in parts["lines"]):
            introduced = [(l.get("problem_refs", {}).get(pr, l["refs"]), pr) for l in parts["lines"] for pr in l.get("new_problems", []) if pr in BLOCKING]
        else:
            introduced = [(r["refs"], pr) for r in parts["changes"] if r["after"] and r["action"] != "removed"
                          for pr in r["after"]["problems"] if pr in BLOCKING and pr not in ((r["before"] or {}).get("problems") or [])]
        s = parts["supplier"]
        head = f"#### Parts: {md(p['name'])}" + (f" — {plural(len(introduced), 'problem')} introduced" if introduced else "")
        literal = lambda value: md(" ".join(str(value).split()))
        if s and s.get("skipped"):
            reason = s["skipped"]
            safe_reason = reason if reason in ("no credentials (forked pull request or secrets not set)", "no valid MPNs") else literal(reason)
            when = f"DigiKey lookup skipped: {safe_reason}."
        elif s and s.get("fetched_at"):
            stamp = str(s["fetched_at"]).replace("T", " ")[:16]
            when = f"DigiKey data as of {literal(stamp)} UTC (stock and price from DigiKey)."
        else:
            when = f"Supplier lookup not run ({literal((s or {}).get('error') or 'not available')})."
        bad = sum(1 for l in parts["lines"] if BLOCKING & set(l["problems"]))
        out += [head, "", f"{when} {plural(len(parts['lines']), 'line')}, {bad} with a problem.", ""]
        if s:
            if not s.get("skipped"):
                statuses = [(l.get("supplier") or {}).get("status") for l in parts["lines"]]
                summary = [(status, {"ok": "in stock", "unavailable": "unavailable"}.get(status, PROBLEM_TEXT.get(status)))
                           for status in ("ok", "out_of_stock", "not_found", "ambiguous", "discontinued", "unavailable")]
                counts = [f"{statuses.count(status)} {label}" for status, label in summary if status in statuses]
                out.append(f"{s.get('looked_up', 0)} looked up" + (": " + ", ".join(counts) if counts else "") + ".")
            if s.get("error"):
                out.append(f"DigiKey lookup unavailable: {literal(s['error'])}.")
            for key, reason in (("no_mpn", "no MPN"), ("invalid_mpn", "invalid MPN"), ("run_limit", "run limit")):
                count = (s.get("not_looked_up") or {}).get(key, 0)
                if count:
                    out.append(f"{plural(count, 'part')} not looked up: {reason}.")
        out += [f"- {md(', '.join(refs))} {PROBLEM_TEXT[pr]}" for refs, pr in introduced]
        cov = parts.get("coverage")
        if cov:
            def item(f, label):
                c, t = cov["head"][f]
                d = c - cov["base"][f][0] if cov.get("base") else 0
                return f"{label} {c}/{t}" + (f" ({'+' if d > 0 else ''}{d})" if d else "")
            out += ["", "BOM coverage: " + ", ".join(item(f, l) for f, l in (("Order ready", "order ready"), ("MPN", "MPN"), ("LCSC", "LCSC"), ("Datasheet (critical)", "datasheet on critical parts"))) + "."]
        if parts.get("dnp_mismatch"):
            out.append(f"DNP differs between schematic and board: {md(', '.join(parts['dnp_mismatch']))}.")
    return "\n".join(out)


ANCHOR = re.compile(r"<!-- kicad-review-anchor ([A-Za-z0-9_-]+) -->[ \t\r\n]*$")


def thread_anchor(body):
    """The anchor a review-site thread carries in its first comment, or None for any other comment."""
    m = ANCHOR.search(body or "")
    if not m:
        return None
    try:
        a = json.loads(base64.urlsafe_b64decode(m.group(1) + "=" * (-len(m.group(1)) % 4)))
    except ValueError:  # bad base64, bad UTF-8 and bad JSON all subclass ValueError
        return None
    return a if isinstance(a, dict) and a.get("v") == 1 else None


def touched_issues(issues, data):
    """Open non-PR issues whose anchor names a part this change touched."""
    changed = {(p["dir"], r["ref"]) for p in data["projects"] for r in p["changes"] if r.get("ref")}
    out = set()
    for issue in issues if isinstance(issues, list) else []:
        if not isinstance(issue, dict) or "pull_request" in issue or issue.get("state", "open") != "open":
            continue
        number, body = issue.get("number"), issue.get("body")
        anchor = thread_anchor(body) if isinstance(body, str) else None
        if (anchor and isinstance(anchor.get("project", ""), str) and isinstance(anchor.get("ref"), str)
                and (anchor.get("project", ""), anchor["ref"]) in changed
                and type(number) is int and number > 0):
            out.add(number)
    return sorted(out)


def thread_counts(response):
    """Open, blocking-and-open, and resolved review-site threads in a reviewThreads GraphQL response."""
    c = {"open": 0, "blocking": 0, "resolved": 0}
    nodes = (((((response or {}).get("data") or {}).get("repository") or {}).get("pullRequest") or {})
             .get("reviewThreads") or {}).get("nodes") or []
    for n in nodes:
        first = ((n.get("comments") or {}).get("nodes") or [{}])[0]
        a = thread_anchor(first.get("body"))
        if not a:
            continue
        if n.get("isResolved"):
            c["resolved"] += 1
        else:
            c["open"] += 1
            c["blocking"] += a.get("severity") == "blocking"
    return c


def waiver_lines(data):
    """Comment summaries for covered findings and waivers that need attention."""
    w = data.get("waivers")
    if not w:
        return []
    waived = sum(c.get("waived", 0) for p in data["projects"] for c in p["checks"])
    if not waived and not any(w.values()):
        return []
    one = lambda s: md(" ".join(str(s).split()))
    out = ["", f"{plural(waived, 'finding')} waived by kicad-review-waivers.toml (reasons in the report)."]
    say = lambda e: f"{one(e['check'])} {one(e['match'])} ({one(e['reason'])}, by {one(e['by'])})"
    out += [f"- Waiver not matched in this review: {say(e)} (if its finding is gone, remove it)." for e in w["stale"]]
    out += [f"- Expired waiver: {say(e)} ended {one(e['until'])}." for e in w["expired"]]
    out += [f"- Proposed in this change (applies after it merges): {say(e)}." for e in w["proposed"]]
    out += [f"- Ignored: {one(m)}" for m in w["invalid"]]
    return out


def checks_markdown(data):
    lines = ["", "### Checks", "", "| Project | Check | Result | Errors (new) | Warnings (new) | Fixed |", "|---|---|---|---|---|---|"]
    for p in data["projects"]:
        for c in p["checks"]:
            lines.append(f"| {md(p['name'])} | {c['title']} ({c['level']}) | {STATUS_ICON[c['status']]} {c['status'].replace('_', ' ')}{': ' + md(c['reason']) if c.get('reason') else ''} | "
                         f"{c['errors']} ({c['new_errors']}) | {c['warnings']} ({c['new_warnings']}) | {c['fixed']} |")
    news = [(p["name"], c["title"], v) for p in data["projects"] for c in p["checks"] for v in c["violations"]
            if v["new"] and v["severity"] == "error" and not v.get("waived")]
    if news:
        lines += ["", "<details><summary>New errors</summary>", ""]
        lines += [f"- **{md(n)}** {t}: {md(v['description'][:300])}" + (f" ({md('; '.join(v['items'][:2]))})" if v["items"] else "")
                  for n, t, v in news[:50]]
        lines += ["", "</details>"]
    checks = "\n".join(lines + waiver_lines(data)) + "\n"
    if len(checks) > 50000:  # leave room for the comment body and closing details tags
        checks = checks[:49900].rsplit("\n", 1)[0] + "\n\n… checks truncated. Full list in the report.\n"
        checks += "\n</details>" * (checks.count("<details") - checks.count("</details>"))
    return checks


NOTES_START, NOTES_END = "<!-- kicad-review-release -->", "<!-- /kicad-review-release -->"


def release_notes(data, site, artifact_id):
    """A marked review section; repository and KiCad text stays literal markdown."""
    literal = lambda value: md(" ".join(str(value).splitlines()))
    out = [NOTES_START, "## KiCad review", "", f"{literal(data['reason'])}."]
    site = site.rstrip("/")
    try:
        url = urlsplit(site)
        valid_site = url.scheme in ("https", "http") and url.hostname and url.username is None and url.password is None and not url.query and not url.fragment
        url.port  # Access validates malformed or out-of-range ports.
    except ValueError:
        valid_site = False
    if valid_site and not re.search(r'[\s\\()\[\]<>"\x00-\x1f\x7f]', site) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", data.get("repo", "")) and re.fullmatch(r"\d{1,20}", str(artifact_id)):
        out.append(f"[Open the review]({site}/r/{data['repo']}/a/{artifact_id})")
    for p in data["projects"]:
        out += ["", f"**{literal(p['name'])}**: {' '.join(summary_sentence(p).splitlines())}.", ""]
        out += [f"- {literal(c['title'])} {STATUS_ICON[c['status']]} {literal(c['status'].replace('_', ' '))} ({literal(plural(c['errors'], 'error'))}, {literal(plural(c['warnings'], 'warning'))})" for c in p["checks"]]
    return "\n".join(out + ["", NOTES_END, ""])


def merge_notes(existing, section):
    """Replace only the marked section, preserving surrounding manual notes."""
    existing = existing or ""
    end = existing.find(NOTES_END)
    start = existing.rfind(NOTES_START, 0, end) if end >= 0 else -1
    if 0 <= start < end:
        return existing[:start] + section.rstrip("\n") + existing[end + len(NOTES_END):]
    return existing.rstrip("\n") + ("\n\n" if existing.strip() else "") + section


def cmd_release_notes(args):
    with open("review/data.json", encoding="utf-8") as fh:
        data = json.load(fh)
    existing = ""
    if args.existing and os.path.exists(args.existing):
        with open(args.existing, encoding="utf-8") as fh:
            existing = fh.read()
    with open("review/release-notes.md", "w", encoding="utf-8") as fh:
        fh.write(merge_notes(existing, release_notes(data, os.environ.get("SITE", ""), args.artifact_id)))
import html as htmllib

PRINT_CSS = """@page { size: A4 landscape; margin: 14mm 12mm;
  @top-left { content: string(revs); font: 9px sans-serif; color: #555; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 9px sans-serif; color: #555; } }
body { font: 11px/1.4 system-ui, sans-serif; color: #111; } h1 { font-size: 22px; } h2 { font-size: 16px; break-before: page; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; } th, td { border: 1px solid #bbb; padding: 2px 4px; text-align: left; vertical-align: top; }
img { max-width: 100%; max-height: 150mm; display: block; margin: 4px 0; } .fail { font-weight: 700; } figure { break-inside: avoid; margin: 0 0 8px; }"""


def print_html(data, images, pr_title, pr_author, now):
    """A static, script-free page for Chrome to print: cover, then per project its summary, pictures, changes and new errors."""
    e = lambda v: htmllib.escape(str(v if v is not None else "—"))
    plain = lambda s: htmllib.unescape(re.sub(r"\\(.)", r"\1", s)).replace("​", "")
    bold = lambda s: re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", e(plain(s)))
    failed = [f"{p['name']} {c['title']}" for p in data["projects"] for c in p["checks"] if c["status"] == "fail"]
    short = lambda s: (s or "none")[:7]
    # Chromium supports literal @page margin content, but not running strings.
    header = f"{data['repo']} · {short(data['base'])} → {short(data['head'])}"
    css_header = '"' + ''.join(f"\\{ord(c):x} " for c in header) + '"'
    css = PRINT_CSS.replace("string(revs)", css_header)
    out = [f"<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\"><title>KiCad review {e(short(data['base']))} → {e(short(data['head']))}</title><style>{css}</style></head><body>",
           f"<p class='revs'>{e(header)}</p>",
           f"<h1>KiCad review</h1><table><tr><th>Repository</th><td>{e(data['repo'])}</td></tr><tr><th>Revisions</th><td>{e(short(data['base']))} → {e(short(data['head']))} ({e(data['reason'])})</td></tr>"
           + (f"<tr><th>Pull request</th><td>{e(pr_title)} by {e(pr_author)}</td></tr>" if pr_title else "")
           + f"<tr><th>Made</th><td>{e(now)}</td></tr><tr><th>Verdict</th><td class='{'fail' if failed else ''}'>{'✕ failing: ' + e(', '.join(failed)) if failed else '✓ required checks passing'}</td></tr>"
           + "</table>"]
    for i, p in enumerate(data["projects"]):
        out.append(f"<h2>{e(p['name'])}</h2><p>{bold(summary_sentence(p))}.</p>")
        out.append("<table><tr><th>Check</th><th>Result</th><th>Errors (new)</th><th>Warnings (new)</th><th>Fixed</th></tr>" + "".join(
            f"<tr><td>{e(c['title'])} ({e(c['level'])})</td><td>{e(c['status'].replace('_', ' '))}</td><td>{e(c['errors'])} ({e(c['new_errors'])})</td><td>{e(c['warnings'])} ({e(c['new_warnings'])})</td><td>{e(c['fixed'])}</td></tr>" for c in p["checks"]) + "</table>")
        pics = [s for s in images if s["project"] == i and os.path.exists(s["path"])]
        out += [f"<figure><figcaption>{e(s['title'])}: before and after</figcaption><img src='data:image/png;base64,{base64.b64encode(open(s['path'], 'rb').read()).decode()}'></figure>" for s in pics] \
            or ["<p><i>Before/after pictures unavailable for this run.</i></p>"]
        rows = p["changes"][:200]
        out.append("<table><tr><th>Change</th><th>Object</th><th>Ref</th><th>Details</th></tr>" + "".join(
            f"<tr class=\"change\"><td>{e(r['action'])}</td><td>{e(r['kind'])}</td><td>{e(r.get('ref'))}</td><td>"
            + ("<br>".join(f"{e(k)}: {e(a)} → {e(b)}" for k, a, b in r.get("changes", [])[:6]) or ", ".join(f"{e(k)}: {e(v)}" for k, v in list((r.get('props') or {}).items())[:4]))
            + "</td></tr>" for r in rows) + "</table>")
        if len(p["changes"]) > 200:
            out.append(f"<p>{len(p['changes']) - 200} more changes are in the interactive report.</p>")
        news = [(c["title"], v) for c in p["checks"] for v in c["violations"] if v.get("new") and v["severity"] == "error"]
        if news:
            out.append("<h3>New errors</h3><ul>" + "".join(f"<li><b>{e(t)}</b>: {e(v['description'])}" + (f" ({e('; '.join(v['items'][:2]))})" if v["items"] else "") + "</li>" for t, v in news) + "</ul>")
    return "\n".join(out) + "</body></html>"


def cmd_pdf(args):
    with open("review/data.json", encoding="utf-8") as fh:
        data = json.load(fh)
    if not data.get("settings", {}).get("pdf", {}).get("enabled", False):
        return
    shots = json.load(open("review/images/shots.json", encoding="utf-8")) if os.path.exists("review/images/shots.json") else []
    images = [{**s, "path": f"review/images/{s['file']}"} for s in shots]
    page = print_html(data, images, os.environ.get("PR_TITLE", ""), os.environ.get("PR_AUTHOR", ""),
                      datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
    with open("review/print.html", "w", encoding="utf-8") as fh:
        fh.write(page)
    name = os.environ.get("PDF_NAME", "")
    if not re.fullmatch(r"kicad-review-(?:[0-9a-f]{7}|none)-[0-9a-f]{7}-(?:pass|fail)\.pdf", name):
        print("::warning::PDF report failed: invalid PDF_NAME")
        return
    out = os.path.abspath(f"review/{name}")
    try:
        if os.path.exists(out):
            os.remove(out)
        result = subprocess.run([args.chrome, "--headless=new", "--no-sandbox", "--no-pdf-header-footer", f"--print-to-pdf={out}",
                                 f"file://{os.path.abspath('review/print.html')}"], capture_output=True, text=True, timeout=120)
        if result.returncode or not os.path.exists(out) or os.path.getsize(out) == 0:
            raise OSError("Chrome did not produce a PDF")
    except (OSError, subprocess.TimeoutExpired):
        if os.path.exists(out):
            os.remove(out)
        print("::warning::PDF report failed: Chrome unavailable, failed or timed out")
        return
    print(f"{out}: {os.path.getsize(out) / 1e6:.2f} MB")


LOG_START, LOG_END = "<!-- kicad-review-log -->", "<!-- /kicad-review-log -->"
LOG_HEAD = ["| Run (UTC) | Commit | Result | Checks |", "|---|---|---|---|"]
LOG_ROW = re.compile(r"^\| \[\d{4}-\d\d-\d\d \d\d:\d\d\]\(https://[^)]*/actions/runs/\d+\) \| `[0-9a-f]{7}` \| (✅ pass|❌ fail) \| .* \|$")


def log_row(data, when: str) -> str:
    """One strict review-log row; local runs without a run URL have no row."""
    failed = any(c["status"] == "fail" for p in data["projects"] for c in p["checks"])
    per = [("" if len(data["projects"]) == 1 else f"{md(p['name'])}: ")
           + " · ".join(f"{md(c['title'])} {c['errors']} ({c['new_errors']})" for c in p["checks"])
           for p in data["projects"]]
    row = f"| [{when}]({data['links'].get('run', '')}) | `{(data['head'] or '')[:7]}` | {'❌ fail' if failed else '✅ pass'} | {' ; '.join(per) or '—'} |"
    row = row.replace("\n", " ").replace("\r", " ")
    return row if LOG_ROW.fullmatch(row) else ""


def extract_log(text) -> list[str]:
    """Validated rows of a log block, or [] for missing or broken markers."""
    text = text or ""
    start, end = text.find(LOG_START), text.find(LOG_END)
    if start < 0 or end < start:
        return []
    return [line for line in text[start + len(LOG_START):end].splitlines() if LOG_ROW.fullmatch(line)]


def merge_log(previous_rows, row, keep=50) -> str:
    rows = [line for line in [*previous_rows, row] if LOG_ROW.fullmatch(line)]
    rows = rows[-keep:] if keep > 0 else []
    # Keep whole newest rows; leave ample room for checks and the comment body.
    while sum(len(line) + 1 for line in rows) > 29500:
        rows.pop(0)
    return "\n".join([LOG_START, "<details><summary>Review log</summary>", "", *LOG_HEAD, *rows, "", "</details>", LOG_END, ""])

CHECK_RESULTS = [("fail", "failure", "failing"), ("warn", "neutral", "warnings"),
                 ("pass", "success", "passing"), ("not_run", "skipped", "not run")]


def check_runs(data):
    """One GitHub check run per check name across all projects; the worst project result is the run's conclusion."""
    runs = {}
    for p in data["projects"]:
        for c in p["checks"]:
            r = runs.setdefault(c["name"], {"name": f"kicad-review / {c['title']}", "rows": [], "conclusions": [], "new": 0})
            rank = next((i for i, result in enumerate(CHECK_RESULTS) if result[0] == c["status"]), None)
            if rank is None:
                raise KeyError(c["status"])
            r["conclusions"].append(rank)
            r["new"] += c["new_errors"]
            r["rows"].append(f"| {md(p['name'])} | {STATUS_ICON[c['status']]} {c['status'].replace('_', ' ')} | {c['errors']} ({c['new_errors']}) | {c['warnings']} ({c['new_warnings']}) |")
    out = []
    for r in runs.values():
        _, conclusion, title = CHECK_RESULTS[min(r["conclusions"])]
        if r["new"]:
            title = plural(r["new"], "new error")
        summary = "\n".join(["| Project | Result | Errors (new) | Warnings (new) |", "|---|---|---|---|", *r["rows"]])
        out.append({"name": r["name"], "conclusion": conclusion, "output": {"title": title, "summary": summary}})
    return out


def readiness_markdown(data, threads=None, threads_required=False):
    """The 'Ready to merge?' block: required checks, blocking threads, and where approvals live."""
    failing = [f"{p['name']} {c['title']}" for p in data["projects"] for c in p["checks"] if c["status"] == "fail"]
    failures = ", ".join(failing)
    if len(failures) > 1000:
        failures = failures[:1000] + "… (full list in Checks)"
    failures = md(failures)
    lines = ["", "#### Ready to merge?", "",
             f"- ✕ **Required checks:** failing ({failures})" if failing else "- ✓ **Required checks:** passing"]
    if threads is not None:
        lines.append(f"- ✕ **Blocking threads:** {threads['blocking']} open" if threads["blocking"] else "- ✓ **Blocking threads:** none open")
    elif threads_required:
        lines.append("- ✕ **Blocking threads:** could not be read")
    if data.get("waivers") is not None:
        waived = sum(c.get("waived", 0) for p in data["projects"] for c in p["checks"])
        lines.append(f"- ↷ **Waived findings:** {waived} (not blocking)")
    lines.append("- ↗ **Approvals:** see the pull request's reviewers (the review site shows them per commit).")
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(required=True)
    p = sub.add_parser("detect", help="resolve base/head and list changed KiCad projects")
    p.set_defaults(func=cmd_detect)
    p = sub.add_parser("restore-renders", help="restore complete revision caches without KiCad")
    p.set_defaults(func=restore_renders)
    p = sub.add_parser("cache-renders", help="snapshot rendered outputs after optional compression")
    p.set_defaults(func=cache_renders)
    p = sub.add_parser("render", help="SVG renders, ERC and DRC of both revisions (run inside the KiCad container)")
    p.set_defaults(func=cmd_render)
    p = sub.add_parser("release", help="fabrication outputs for a version tag (run inside the KiCad container)")
    p.add_argument("--tag", required=True)
    p.set_defaults(func=cmd_release)
    p = sub.add_parser("release-notes", help="merge the KiCad review section into a release body")
    p.add_argument("--existing", default="")
    p.add_argument("--artifact-id", default="")
    p.set_defaults(func=cmd_release_notes)
    p = sub.add_parser("shots", help="before/after screenshots of changed drawings for the comment")
    p.add_argument("--chrome", default="google-chrome")
    p.set_defaults(func=cmd_shots)
    p = sub.add_parser("pdf", help="printable PDF of the review (needs Chrome)")
    p.add_argument("--chrome", default="google-chrome")
    p.set_defaults(func=cmd_pdf)
    p = sub.add_parser("summary", help="markdown for the pull request comment and job summary")
    p.add_argument("--image-base", default="")
    p.add_argument("--artifact-url", default="")
    p.add_argument("--artifact-id", default="")
    p.set_defaults(func=cmd_summary)
    p = sub.add_parser("lookup", help="DigiKey stock and price for MPNs (needs DIGIKEY_CLIENT_ID/SECRET; off by default)")
    p.set_defaults(func=cmd_lookup)
    p = sub.add_parser("report", help="self-contained HTML comparison report")
    p.set_defaults(func=cmd_report)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # comment text has → and —, whatever the locale
    args.func(args)


if __name__ == "__main__":
    main()
