#!/usr/bin/env python3
"""KiCad review: compare two revisions of the KiCad projects in a git repository.

Standard library only. Subcommands are called from the reusable workflow.
"""
import argparse
import base64
import csv
import gzip
import hashlib
import json
import math
import os
import posixpath
import re
import subprocess
import sys
import tempfile
import tomllib
import zipfile

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
    return {posixpath.dirname(f): f for f in files if f.endswith(".kicad_pro") and not is_junk(f)}


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
        })
    return projects


def cmd_detect(args):
    env = dict(os.environ)
    base, head, reason = resolve_revisions(env)
    projects = detect(base, head)
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


def render_side(src_dir, name, out):
    """SVG renders, ERC and DRC reports of one revision of one project."""
    sch, pcb = f"{src_dir}/{name}.kicad_sch", f"{src_dir}/{name}.kicad_pcb"
    if os.path.exists(sch):
        kicad_cli("sch", "export", "svg", "--exclude-drawing-sheet", "--no-background-color", "-o", f"{out}/sch", sch)
        kicad_cli("sch", "erc", "--format", "json", "--severity-all", "-o", f"{out}/erc.json", sch)
    if os.path.exists(pcb):
        # Drill marks off: with them every layer, even an empty one, is full of holes.
        # Page-size mode 1 keeps page coordinates (mm from the page origin), so both revisions overlay exactly.
        kicad_cli("pcb", "export", "svg", "--mode-multi", "--exclude-drawing-sheet", "--page-size-mode", "1",
                  "--drill-shape-opt", "0", "-l", ",".join(board_layers(pcb)), "-o", f"{out}/pcb", pcb)
        parity = ["--schematic-parity"] if os.path.exists(sch) else []
        kicad_cli("pcb", "drc", "--format", "json", "--severity-all", *parity, "-o", f"{out}/drc.json", pcb)


def cmd_render(args):
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    for p in det["projects"]:
        for side in ("base", "head"):
            if (side == "base" and p["status"] == "added") or (side == "head" and p["status"] == "removed"):
                continue
            render_side(posixpath.join(side, p["dir"]), p["name"], f"review/{project_id(p['dir'])}/{side}")
            print(f"{p['name']}: rendered {side}")


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
            walk(props.get("Sheetfile", ""), f"{path}{find(s, 'uuid')[1]}/", child, path, depth + 1, f"{stem}-{safe}")

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
                                 "props": {"position": fmt_at(a)}, "pos": a, "where": where}
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
                objs[key] = {"kind": kind.replace("_", " "), "ref": n[1], "props": {"text": n[1], "position": fmt_at(a)},
                             "pos": a, "where": where}
            elif kind == "sheet":
                props = properties(n)
                objs[key] = {"kind": "sheet", "ref": props.get("Sheetname", "?"),
                             "props": {"file": props.get("Sheetfile"), "position": fmt_at(at(n))},
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
            for pad in findall(n, "pad"):
                if find(pad, "net"):
                    p[f"pad {pad[1]} net"] = net(pad)
            objs[uid] = {"kind": "footprint", "ref": p["reference"], "match": ("footprint", p["reference"]),
                         "props": p, "pos": a, "box": box_of(pad_points(n, a), 1), "where": where}
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


# ---- Checks: ERC, DRC, schematic parity, BOM fields. Violations new since base are called out. ----

DEFAULT_SETTINGS = {
    "checks": {"erc": "required", "drc": "required", "parity": "required", "bom": "informational"},
    "fail_on": "new",  # "new": only errors this change introduced fail a required check; "all": any error does
    "bom": {"required_fields": ["Value", "Footprint"]},
    "fabrication": {"preset": "jlcpcb", "part_field": None},  # part_field defaults to the preset's (LCSC / MPN)
}
CHECK_NAMES = {"erc": "ERC", "drc": "DRC", "parity": "Schematic/board parity", "bom": "BOM fields"}


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
    for name, level in settings["checks"].items():
        if name not in CHECK_NAMES or level not in ("required", "informational", "off"):
            sys.exit(f"{SETTINGS_FILE}: checks.{name} = {level!r}; expected one of erc/drc/parity/bom = required/informational/off")
    if settings["fabrication"]["preset"] not in PRESETS:
        sys.exit(f"{SETTINGS_FILE}: fabrication.preset must be one of {', '.join(PRESETS)}")
    if settings["fail_on"] not in ("new", "all"):
        sys.exit(f"{SETTINGS_FILE}: fail_on must be \"new\" or \"all\"")
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


def cmd_release(args):
    settings = load_settings(("repo",))
    os.makedirs("release", exist_ok=True)
    pros = sorted(posixpath.join(d, f) for d, _, files in os.walk("repo") if "/." not in d for f in files
                  if f.endswith(".kicad_pro") and not is_junk(posixpath.join(d, f)))
    names = [posixpath.basename(p) for p in pros]
    for pro in pros:
        label = posixpath.basename(pro)[: -len(".kicad_pro")]
        if names.count(posixpath.basename(pro)) > 1 and posixpath.dirname(pro) != "repo":  # keep same-named projects apart
            label = posixpath.dirname(pro)[len("repo/"):].replace("/", "-") + "-" + label
        for f in release_project(pro, args.tag, settings, "release", label):
            print(f)


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


def vkeys(v):
    """Identities of a violation for matching base and head: its item UUIDs, and its type plus what and where."""
    if v.get("key"):
        return {v["key"]}
    desc = re.sub(r"[\d.]+", "#", v["description"])
    keys = {("p", v["type"], desc, tuple(v["items"]), tuple(tuple(round(c, 1) for c in p) for p in ([v["pos"]] if v["pos"] else [])))}
    if v["uuids"]:
        keys.add(("u", v["type"], tuple(v["uuids"])))
    return keys


def run_check(name, settings, head, base):
    level = settings["checks"].get(name, "off")
    if level == "off" or head is None:
        return None
    base_keys = set().union(*(vkeys(v) for v in base or []))
    head_keys = set().union(*(vkeys(v) for v in head))
    for v in head:
        v["new"] = not (vkeys(v) & base_keys)
    count = lambda sev, new=False: sum(1 for v in head if v["severity"] == sev and (v["new"] or not new))
    failing = count("error", new=settings["fail_on"] == "new") > 0
    head.sort(key=lambda v: (not v["new"], v["severity"] != "error", v["type"]))
    return {"name": name, "title": CHECK_NAMES[name], "level": level,
            "status": "pass" if not failing else "fail" if level == "required" else "warn",
            "errors": count("error"), "warnings": count("warning"),
            "new_errors": count("error", True), "new_warnings": count("warning", True),
            "fixed": sum(1 for v in base or [] if not (vkeys(v) & head_keys)),
            "violations": head}


def project_checks(p, settings, objs):
    out = f"review/{project_id(p['dir'])}"

    def side(s, f, k):
        src = posixpath.join(s, p["dir"], f"{p['name']}.{'kicad_sch' if k == 'erc' else 'kicad_pcb'}")
        if os.path.exists(src) and not os.path.exists(f"{out}/{s}/{f}"):  # never drop a check because its output is missing
            sys.exit(f"kicad-cli wrote no {f} for {src}")
        return load_violations(f"{out}/{s}/{f}", k)
    fields = settings["bom"]["required_fields"]
    checks = [
        run_check("erc", settings, side("head", "erc.json", "erc"), side("base", "erc.json", "erc")),
        run_check("drc", settings, side("head", "drc.json", "drc"), side("base", "drc.json", "drc")),
        run_check("parity", settings, side("head", "drc.json", "parity"), side("base", "drc.json", "parity")),
        run_check("bom", settings, bom_violations(objs["head"], fields) if objs["head"] else None,
                  bom_violations(objs["base"], fields) if objs["base"] else None),
    ]
    return [c for c in checks if c]


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
    w, h = re.search(r'viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"', text).groups()
    return [float(w), float(h)]


def has_drawing(text):
    return re.search(r"<(path|polyline|polygon|circle|rect|line|ellipse|text)\b", text) is not None


def add_blob(blobs, text):
    """Store SVG text gzip+base64 in blobs, deduplicated by content; return its key."""
    if text is None:
        return None
    key = hashlib.sha1(text.encode()).hexdigest()[:12]
    if key not in blobs:
        blobs[key] = base64.b64encode(gzip.compress(text.encode(), mtime=0)).decode()
    return key


def build_project(p, blobs, settings):
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
    return {"name": p["name"], "dir": p["dir"], "status": p["status"], "sheets": sheets, "board": board,
            "changes": diff_objects(objs["base"], objs["head"]), "checks": project_checks(p, settings, objs)}


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
    return (read("review.html")
            .replace('<link rel="stylesheet" href="review.css">', f"<style>\n{read('review.css')}</style>")
            .replace('<script src="sample/review-data.js"></script>', f"<script>{data_js}</script>")
            .replace('<script src="review.js"></script>', f"<script>\n{read('review.js')}</script>"))


def cmd_report(args):
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    blobs = {}
    env = os.environ
    data = {
        "version": 1,
        "repo": env.get("GITHUB_REPOSITORY", ""),
        "links": review_links(env, det),
        "base": det["base"], "head": det["head"], "reason": det["reason"],
        "settings": load_settings(),
        "run_id": env.get("GITHUB_RUN_ID", ""),
    }
    data["projects"] = [build_project(p, blobs, data["settings"]) for p in det["projects"]]
    assign_ids(data["projects"])
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


STATUS_ICON = {"pass": "✅", "fail": "❌", "warn": "⚠️"}
MARKER = "<!-- kicad-review -->"
TABLE_KINDS = ("title block", "design rules", "symbol", "footprint", "sheet", "label", "global label",
               "hierarchical label", "zone", "board outline")


def plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def md(v):
    """Text from a KiCad file as literal markdown: no HTML, images, links, emphasis or @mentions.
    Bare URLs (datasheets) stay as GitHub shows them, a visible auto-link, since escapes would end up inside the link."""
    v = str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "".join(part if i % 2 else re.sub(r"([\\`*_\[\]()!~#])", r"\\\1", part).replace("@", "@\u200b")
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


def comment_markdown(data, images, artifact_url, artifact_id="", rows=60, site=""):
    out = [MARKER, "## KiCad review", ""]
    short = lambda s: s[:9] if s else "nothing"
    out.append(f"Comparing `{short(data['base'])}` → `{short(data['head'])}` ({data['reason']}). "
               + (f"[Workflow run]({data['links']['run']})" if data["links"].get("run") else ""))
    if site and artifact_id and data.get("repo"):
        site = site.rstrip("/")
        out.append(f"**[Open the review]({site}/r/{data['repo']}/a/{artifact_id})**")
    if artifact_url:
        out.append(f"**[Open the review page]({artifact_url})** — downloads `kicad-review.html`; open it in a browser.")
    if artifact_id and data.get("repo"):
        out += ["", "<details><summary>From a terminal</summary>", "",
                "```sh", f"gh api repos/{data['repo']}/actions/artifacts/{artifact_id}/zip > kicad-review.html && open kicad-review.html", "```",
                "", "`open` is macOS; use `xdg-open` on Linux or `start` on Windows.", "", "</details>"]
    for i, p in enumerate(data["projects"]):
        out += ["", f"### {md(p['name'])}" + (f" (`{p['dir'].replace('`', "'")}`, {p['status']})" if p["dir"] or p["status"] != "modified" else ""), "",
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
    body, checks = "\n".join(out), checks_markdown(data)
    if len(body) + len(checks) > 60000:  # GitHub comments are limited to 65536 characters; the checks always stay
        if rows:
            return comment_markdown(data, images, artifact_url, artifact_id, rows // 2, site)
        body = body[:60000 - len(checks)] + "\n\n… truncated. The full list is in the report.\n"
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
    body = comment_markdown(data, images, args.artifact_url, args.artifact_id, site=site)
    with open(f"review/comment.md", "w", encoding="utf-8") as fh:
        fh.write(body)
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as fh:
        fh.write(body.replace(MARKER, ""))
    print(body)


def checks_markdown(data):
    lines = ["", "### Checks", "", "| Project | Check | Result | Errors (new) | Warnings (new) | Fixed |", "|---|---|---|---|---|---|"]
    for p in data["projects"]:
        for c in p["checks"]:
            lines.append(f"| {md(p['name'])} | {c['title']} ({c['level']}) | {STATUS_ICON[c['status']]} {c['status']} | "
                         f"{c['errors']} ({c['new_errors']}) | {c['warnings']} ({c['new_warnings']}) | {c['fixed']} |")
    news = [(p["name"], c["title"], v) for p in data["projects"] for c in p["checks"] for v in c["violations"]
            if v["new"] and v["severity"] == "error"]
    if news:
        lines += ["", "<details><summary>New errors</summary>", ""]
        lines += [f"- **{md(n)}** {t}: {md(v['description'])}" + (f" ({md('; '.join(v['items'][:2]))})" if v["items"] else "")
                  for n, t, v in news[:50]]
        lines += ["", "</details>"]
    return "\n".join(lines) + "\n"


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
