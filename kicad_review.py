#!/usr/bin/env python3
"""KiCad review: compare two revisions of the KiCad projects in a git repository.

Standard library only. Subcommands are called from the reusable workflow.
"""
import argparse
import base64
import csv
import datetime
import gzip
import hashlib
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
    for d in sorted(by_project):
        status = "removed" if d not in head_projects else "added" if d not in base_projects or base_projects[d] != head_projects[d] else "modified"
        pro = head_projects.get(d) or base_projects[d]
        projects.append({
            "dir": d,
            "name": posixpath.basename(pro)[: -len(".kicad_pro")],
            "status": status,
        })
    return projects


def cmd_detect(args):
    env = dict(os.environ)
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
        kicad_cli("sch", "export", "svg", "--exclude-drawing-sheet", "--no-background-color", "-o", f"{out}/sch", sch)
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


def cmd_render(args):
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    settings = load_settings()
    for p in det["projects"]:
        export_3d = settings["3d"]["enabled"] and board_changed(p)
        for side in ("base", "head"):
            if (side == "base" and p["status"] == "added") or (side == "head" and p["status"] == "removed"):
                continue
            out = f"review/{project_id(p['dir'])}/{side}"
            render_side(posixpath.join(side, p["dir"]), p["name"], out, netlist=settings["checks"].get("interfaces", "off") != "off")
            if export_3d:
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

    # stem: the file name kicad-cli gives the page's SVG, the sheet names along its path joined by "-".
    def walk(file, path, sheet_name, parent, depth, stem):
        pages.append({"path": path, "name": sheet_name, "file": file, "parent": parent, "stem": stem})
        full = posixpath.join(proj_dir, file)
        if depth > 32 or not os.path.exists(full):
            return
        with open(full, encoding="utf-8") as fh:
            root = parse_sexpr(fh.read())
        names = set()
        for s in findall(root, "sheet"):
            props = properties(s)
            child = props.get("Sheetname", "?")
            if child in names:
                sys.exit(f"{file} has two sheets with the same name {child!r}; kicad-cli renders both to one file, "
                         "so neither drawing can be shown. Rename one of them.")
            names.add(child)
            safe = re.sub(r"[\\/]", "_", child)
            walk(posixpath.normpath(posixpath.join(posixpath.dirname(file), props.get("Sheetfile", ""))), f"{path}{find(s, 'uuid')[1]}/", child, path, depth + 1, f"{stem}-{safe}")

    if os.path.exists(posixpath.join(proj_dir, f"{name}.kicad_sch")):
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
    net_names = {n[1]: n[2] for n in findall(root, "net") if len(n) > 2}  # older files number their nets
    net = lambda node: (lambda n: net_names.get(n[1], n[-1]) if n else None)(find(node, "net"))
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
            rows.append(row("modified", h, changes, b))
    rows += [row("removed", o) for o in b_left.values()]
    rows += [row("added", o) for o in h_left.values()]
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
        path = f"{side}/{SETTINGS_FILE}"
        if os.path.exists(path):
            with open(path, "rb") as fh:
                user = tomllib.load(fh)
            for k, v in user.items():
                if isinstance(v, dict) and isinstance(settings.get(k), dict):
                    settings[k].update(v)
                else:
                    settings[k] = v
            break
    for section in ("checks", "bom", "fabrication", "3d", "parts", "threads", "issues", "github", "waivers", "inventory", "libraries", "interfaces"):
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


def load_violations(path, kind):
    """ERC/DRC JSON as a flat list of errors and warnings. kind: erc, drc or parity."""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    out = []
    if kind == "erc":
        for sheet in d.get("sheets", []):
            parts = sheet.get("uuid_path", "/").strip("/").split("/")[1:]  # drop the root sheet UUID
            page = "/" + "".join(f"{p}/" for p in parts)
            # ponytail: kicad-cli 10 writes ERC positions in units of 100 mm; DRC positions are mm
            out += [violation(v, 100, {"sheet": page}) for v in sheet.get("violations", [])]
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


def parts_lines(objs):
    """One line per distinct part on the schematic (Value + Footprint + LCSC), with what blocks a supplier lookup."""
    lines = {}
    for o in objs.values():
        p = o["props"]
        if o["kind"] != "symbol" or p.get("in_bom") == "no" or p.get("dnp") == "yes" or o["ref"].endswith("?"):
            continue
        lcsc = (field(p, LCSC_FIELDS) or "").upper() or None
        ds = field(p, ("datasheet",))
        line = lines.setdefault((p.get("Value", ""), p.get("Footprint", ""), lcsc), {
            "value": p.get("Value", ""), "footprint": p.get("Footprint", ""), "lcsc": lcsc,
            "mpn": field(p, MPN_FIELDS), "datasheet": ds if ds and ds.lower().startswith(("http://", "https://")) else None,
            "refs": [], "problems": []})
        if o["ref"] not in line["refs"]:
            line["refs"].append(o["ref"])
            # Per-reference values: a grouped line can hide one reference's MPN or placeholder behind another's.
            line.setdefault("_each", []).append((o["ref"], field(p, MPN_FIELDS), (p.get("Value", ""), field(p, MPN_FIELDS), lcsc)))
    by_lcsc = {}
    for l in lines.values():
        l["refs"].sort(key=natural)
        l["key"] = "|".join([l["value"], l["footprint"], l["lcsc"] or ""])
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
    return sorted(lines.values(), key=lambda l: natural(l["refs"][0]))


def diff_parts(base, head):
    """What a change did to the parts list, per reference designator, grouped back into lines."""
    at = lambda lines: {r: l for l in lines for r in l["refs"]}
    b, h = at(base), at(head)
    rows = {}
    for ref in sorted(set(b) | set(h), key=natural):
        x, y = b.get(ref), h.get(ref)
        if x and y and x["key"] == y["key"]:
            continue
        action = "added" if not x else "removed" if not y else "swapped" if x["lcsc"] != y["lcsc"] else "value" if x["value"] != y["value"] else "footprint"
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
        return load_violations(f"{out_dir}/{s}/{f}", k)
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


def build_project(p, blobs, settings, waivers=None):
    out = f"review/{project_id(p['dir'])}"
    sides = [s for s in ("base", "head") if os.path.isdir(f"{out}/{s}")]
    pages = {}
    for side in sides:
        for pg in sheet_pages(posixpath.join(side, p["dir"]), p["name"]):
            entry = pages.setdefault(pg["path"], {**pg, "svg": {}})
            entry["svg"][side] = svg_body(page_svg(f"{out}/{side}", p["name"], pg))
    sheets = []
    for pg in pages.values():
        texts = pg.pop("svg")
        del pg["stem"]
        b, h = texts.get("base"), texts.get("head")
        pg["status"] = "added" if b is None and h else "removed" if h is None and b else "modified" if b != h else "unchanged"
        if pg["status"] != "unchanged":
            pg["size"] = svg_size(h or b)
            pg["svg"] = {"base": add_blob(blobs, b), "head": add_blob(blobs, h)}
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
        board["layers"] = [{"name": l["name"], "changed": l["base"] != l["head"],
                            "svg": {"base": add_blob(blobs, l["base"]), "head": add_blob(blobs, l["head"])}}
                           for l in layers]
    objs = {side: project_objects(posixpath.join(side, p["dir"]), p["name"]) for side in ("base", "head")}
    parts = None
    if settings["parts"]["enabled"]:
        lines = {s: parts_lines(objs[s]) for s in ("base", "head")}
        mark_new_problems(lines["base"], lines["head"])
        has_base = any(o["kind"] == "symbol" for o in objs["base"].values())
        parts = {"lines": lines["head"], "changes": diff_parts(lines["base"], lines["head"]),
                 "supplier": None,  # JLCPCB lookup not built yet: no approved API access
                 "coverage": {"base": bom_coverage(objs["base"], settings) if has_base else None, "head": bom_coverage(objs["head"], settings)},
                 "field_changes": field_changes(objs["base"], objs["head"]), "dnp_mismatch": dnp_mismatches(objs["head"])}
    if settings["3d"]["enabled"]:
        models = {side: f"{out}/{side}/board.glb" for side in ("base", "head")}
        logs = {side: f"{out}/{side}/glb.log" for side in ("base", "head")}
        if any(os.path.exists(path) for path in (*models.values(), *logs.values())):
            board["model3d"] = {side: add_blob(blobs, pathlib.Path(path).read_bytes()) if os.path.exists(path) else None
                                for side, path in models.items()}
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
            "changes": diff_objects(objs["base"], objs["head"]), "checks": project_checks(p, settings, objs, waivers),
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
    prefix = ""
    if has_3d:
        bundle = base64.b64encode(gzip.compress(open(posixpath.join(UI_DIR, "vendor/three-viewer.min.js"), "rb").read(), mtime=0)).decode()
        prefix = f'<script type="application/octet-stream" id="three-bundle">{bundle}</script><script>\n{read("review3d.js")}</script>'
    page = page.replace('<script src="review.js"></script>', f"{prefix}<script>\n{read('review.js')}</script>")
    if re.search(r'''(?:href|src)=(["'])(?:tokens\.css|review\.css|sample/review-data\.js|review\.js)\1''', page): raise RuntimeError("external report assets remain: template did not match")
    return page


def cmd_report(args):
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    blobs = {}
    env = os.environ
    settings = load_settings()
    # An opted-out report must remain byte-for-byte compatible with reports made before this feature.
    report_settings = {k: v for k, v in settings.items()
                       if not ((k in ("3d", "parts", "threads", "issues", "waivers", "inventory", "libraries") and not v["enabled"]) or (k == "github" and not v["check_runs"]))}
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
    data["projects"] = [build_project(p, blobs, settings, waivers) for p in det["projects"]]
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
        out.append(f"**[Open the review]({site}/r/{data['repo']}/a/{artifact_id})**")
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
                "out_of_stock": "out of stock", "not_found": "not found at JLCPCB", "discontinued": "discontinued", "unavailable": "lookup unavailable"}
BLOCKING = {"missing_lcsc", "bad_lcsc", "lcsc_conflict", "placeholder", "mpn_footprint_conflict", "out_of_stock", "not_found", "discontinued"}


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
        when = f"JLCPCB data as of {md(s['fetched_at'])}." if s and s.get("fetched_at") else \
               f"Supplier lookup not run ({md((s or {}).get('error') or 'not available')})."
        bad = sum(1 for l in parts["lines"] if BLOCKING & set(l["problems"]))
        out += [head, "", f"{when} {plural(len(parts['lines']), 'line')}, {bad} with a problem.", ""]
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
    p = sub.add_parser("render", help="SVG renders, ERC and DRC of both revisions (run inside the KiCad container)")
    p.set_defaults(func=cmd_render)
    p = sub.add_parser("release", help="fabrication outputs for a version tag (run inside the KiCad container)")
    p.add_argument("--tag", required=True)
    p.set_defaults(func=cmd_release)
    p = sub.add_parser("shots", help="before/after screenshots of changed drawings for the comment")
    p.add_argument("--chrome", default="google-chrome")
    p.set_defaults(func=cmd_shots)
    p = sub.add_parser("summary", help="markdown for the pull request comment and job summary")
    p.add_argument("--image-base", default="")
    p.add_argument("--artifact-url", default="")
    p.add_argument("--artifact-id", default="")
    p.set_defaults(func=cmd_summary)
    p = sub.add_parser("report", help="self-contained HTML comparison report")
    p.set_defaults(func=cmd_report)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # comment text has → and —, whatever the locale
    args.func(args)


if __name__ == "__main__":
    main()
