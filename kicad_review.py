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
import contextlib
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
import struct
import subprocess
import zlib
import sys
import tempfile
import tomllib
import zipfile
from collections import Counter
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

# Files that change what KiCad renders or checks. .kicad_prl is per-user UI state, so it is left out.
KICAD_SUFFIXES = (".kicad_sch", ".kicad_pcb", ".kicad_pro", ".kicad_sym", ".kicad_mod", ".kicad_dru", ".kicad_wks")
KICAD_NAMES = ("sym-lib-table", "fp-lib-table")
SETTINGS_FILE = "kicad-review.toml"
FAB_TABLE = pathlib.Path(__file__).with_name("fab_limits.json")


def workflow_command_escape(value, *, property=False):
    """Escape GitHub workflow-command data, with extra separators for properties."""
    value = str(value).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return value.replace(":", "%3A").replace(",", "%2C") if property else value


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
            print("::warning::" + workflow_command_escape("Cannot read tag review settings; tag review stays off."))
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
    """Declared layer names; physical draw order is resolved by the viewer."""
    with open(pcb_path, encoding="utf-8") as fh:
        root = parse_sexpr(fh.read())
    return [str(row[1]) for row in (find(root, "layers") or [])[1:]
            if isinstance(row, list) and len(row) > 1]


def simplify_sheet_svg(text):
    """Join plain sibling stroke paths without changing inherited paint or coordinates."""
    root = ET.fromstring(text)

    # Only optimize self-contained presentation paint. CSS, paint servers, alpha,
    # markers and effects can make one compound path differ from separate strokes.
    dynamic_paint = ('<?xml-stylesheet' in text or any(
        node.tag.rsplit('}', 1)[-1] in {'style', 'link', 'animate', 'animateTransform', 'set'}
        for node in root.iter()))
    paint_attrs = {'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width',
                   'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit'}
    container_attrs = {'class', 'style', 'transform', 'version', 'width', 'height', 'viewBox'}

    def walk(group, unfilled=False, safe=True):
        style = dict(re.findall(r'(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)', group.get('style', '')))
        fill = style.get('fill', group.get('fill'))
        if fill is not None:
            unfilled = fill.strip() == 'none'
        paint = {**group.attrib, **style}
        safe = (safe and not dynamic_paint
                and group.get('class') in (None, 'stroked-text')
                and all(re.fullmatch(r'\s*[\w-]+\s*:\s*[^;]+', declaration)
                        for declaration in group.get('style', '').split(';') if declaration.strip())
                and set(group.attrib) <= paint_attrs | container_attrs
                and set(style) <= paint_attrs)
        if 'stroke-opacity' in paint:
            safe = safe and bool(re.fullmatch(r'(?:1(?:\.0*)?|100(?:\.0*)?%)', paint['stroke-opacity'].strip()))
        if 'stroke' in paint:
            stroke = paint['stroke'].strip().lower()
            safe = safe and bool(re.fullmatch(
                r'#[0-9a-f]{3}(?:[0-9a-f]{3})?|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)'
                r'|none|black|white|red|green|blue', stroke))
        run = None
        for child in list(group):
            tag = child.tag.rsplit('}', 1)[-1]
            if safe and unfilled and tag == 'path' and set(child.attrib) == {'d'} and re.match(r'\s*M', child.get('d', '')):
                if run is None:
                    run = child
                else:
                    run.set('d', run.get('d') + ' ' + child.get('d'))
                    group.remove(child)
            elif tag != 'desc':
                run = None
                if tag == 'g':
                    walk(child, unfilled, safe)

    walk(root)
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    return ET.tostring(root, encoding='unicode')


IMAGE_EXPORT_OPTIONS = {'page_size_mode': '1', 'drill_shape_opt': '0',
                        'check_zones': True, 'themes': ['light', 'dark']}


IMAGE_PALETTES = json.loads(pathlib.Path(__file__).with_name('image-palettes.json').read_text(encoding='utf-8'))
IMAGE_RENDERER = os.environ.get('KICAD_IMAGE') or os.environ.get('KICAD_RENDERER_VERSION', 'local-unverified')


def write_image_themes(config_home):
    """Write renderer-owned KiCad 10 themes from the checked-in canonical inks."""
    target = pathlib.Path(config_home, '10.0', 'colors')
    target.mkdir(parents=True, exist_ok=True)
    for theme, palette in IMAGE_PALETTES.items():
        data = {'meta': {'name': 'kicad-review-' + theme, 'version': 5}}
        for key, rgba in palette['colors'].items():
            parent = data
            *parts, leaf = key.split('.')
            for part in parts:
                parent = parent.setdefault(part, {})
            parent[leaf] = 'rgb(%d, %d, %d)' % tuple(round(v * 255) for v in rgba[:3])
        (target / f'kicad-review-{theme}.json').write_text(json.dumps(data, sort_keys=True), encoding='utf-8')


def export_board_stats(pcb, out):
    """Optional revision facts: publish validated JSON atomically, or a diagnostic."""
    root = pathlib.Path(out)
    root.mkdir(parents=True, exist_ok=True)
    target, pending, marker = (root / name for name in ('stats.json', 'stats.pending.json', 'stats.json.error'))
    for path in (target, pending, marker):
        path.unlink(missing_ok=True)
    command = ['kicad-cli', 'pcb', 'export', 'stats', '--format', 'json', '--units', 'mm', '-o', str(pending), pcb]
    try:
        # One synchronous export per revision, capped at 60 seconds; no retry queue.
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ValueError('statistics export failed (%s): %s' %
                             (result.returncode, (result.stderr or result.stdout).strip()[:500]))
        if not pending.is_file():
            raise ValueError('statistics export produced no output')
        if not isinstance(json.loads(pending.read_text(encoding='utf-8')), dict):
            raise ValueError('statistics export produced a non-object JSON value')
        os.replace(pending, target)
        return None
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        target.unlink(missing_ok=True)
        pending.unlink(missing_ok=True)
        error = ('statistics unavailable: ' + str(exc)).replace('\n', ' ')[:1000]
        marker.write_text(error, encoding='utf-8')
        return error


def export_netlist(sch, out):
    """Soft schematic connectivity evidence: validated netlist.net, or a one-line netlist.net.error."""
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    target, pending, marker = (out / n for n in ('netlist.net', 'netlist.pending.net', 'netlist.net.error'))
    for path in (target, pending, marker):
        path.unlink(missing_ok=True)
    try:
        run = subprocess.run(['kicad-cli', 'sch', 'export', 'netlist', '--format', 'kicadsexpr',
                              '-o', str(pending), sch], capture_output=True, text=True, timeout=60)
        if run.returncode:
            raise ValueError(f'netlist export failed ({run.returncode}): {run.stderr or run.stdout}')
        if not pending.is_file():
            raise ValueError('netlist export produced no output')
        validate_netlist(pending.read_text(encoding='utf-8'))
        os.replace(pending, target)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        target.unlink(missing_ok=True)
        reason = ' '.join(f'{sch}: connectivity unavailable: {exc}'.split())[:500]
        marker.write_text(reason, encoding='utf-8')
        print(reason, file=sys.stderr)
    finally:
        pending.unlink(missing_ok=True)


def read_netlist(out):
    """The one consumer path: a failure marker wins over any coincident netlist.net."""
    out = pathlib.Path(out)
    marker = out / 'netlist.net.error'
    if marker.exists():
        raise ValueError(marker.read_text(encoding='utf-8')[:500] or 'netlist export unavailable')
    text = (out / 'netlist.net').read_text(encoding='utf-8')
    validate_netlist(text)
    return text


def render_side(src_dir, name, out, netlist=False):
    """SVG renders, ERC and DRC reports of one revision of one project."""
    sch, pcb = f"{src_dir}/{name}.kicad_sch", f"{src_dir}/{name}.kicad_pcb"
    with tempfile.TemporaryDirectory() as cfg:
        write_image_themes(cfg)
        previous = os.environ.get('KICAD_CONFIG_HOME')
        os.environ['KICAD_CONFIG_HOME'] = cfg
        mapping = {}
        try:
            for theme in ('light', 'dark'):
                suffix = '' if theme == 'light' else '-dark'
                if os.path.exists(sch):
                    kicad_cli('sch', 'export', 'svg', '--no-background-color', '--theme', 'kicad-review-' + theme,
                              '-o', f'{out}/sch{suffix}', sch)
                    resolved = set()
                    for pg in sheet_pages(src_dir, name):
                        light = pathlib.Path(page_svg(out, name, pg))
                        path = light if theme == 'light' else pathlib.Path(out, 'sch-dark', light.name)
                        if not path.is_file():
                            raise ValueError('missing sheet export ' + str(path))
                        if path in resolved or theme in mapping.get(pg['path'], {}):
                            raise ValueError('ambiguous sheet export ' + str(path))
                        resolved.add(path)
                        path.write_text(simplify_sheet_svg(path.read_text(encoding='utf-8')), encoding='utf-8')
                        mapping.setdefault(pg['path'], {})[theme] = str(path.relative_to(out))
                if os.path.exists(pcb):
                    # Drill marks off; page coordinates keep both revisions aligned in mm.
                    kicad_cli('pcb', 'export', 'svg', '--mode-multi', '--exclude-drawing-sheet',
                              '--page-size-mode', '1', '--drill-shape-opt', '0', '--check-zones',
                              '--layers', ','.join(board_layers(pcb)), '--theme', 'kicad-review-' + theme,
                              '-o', f'{out}/pcb{suffix}', pcb)
            pathlib.Path(out).mkdir(parents=True, exist_ok=True)
            pathlib.Path(out, 'sheet-images.json').write_text(json.dumps(mapping, sort_keys=True), encoding='utf-8')
            if os.path.exists(pcb):
                export_board_stats(pcb, out)  # Shared optional facts, once per revision, outside the theme loop.
        finally:
            if previous is None:
                os.environ.pop('KICAD_CONFIG_HOME', None)
            else:
                os.environ['KICAD_CONFIG_HOME'] = previous
    if os.path.exists(sch):
        kicad_cli("sch", "erc", "--format", "json", "--severity-all", "-o", f"{out}/erc.json", sch)
        if netlist:
            export_netlist(sch, out)
    if os.path.exists(pcb):
        parity = ["--schematic-parity"] if os.path.exists(sch) else []
        kicad_cli("pcb", "drc", "--format", "json", "--severity-all", *parity, "-o", f"{out}/drc.json", pcb)


def board_path(p, side):
    return posixpath.join(side, p["dir"], f"{p['name']}.kicad_pcb")


def fab_enabled(settings):
    enabled = settings["fabrication"].get("check_limits", False) and settings["checks"].get("fab_limits") != "off"
    if enabled and settings["checks"].get("drc", "off") == "off":
        raise ValueError("fabrication.check_limits requires checks.drc != \"off\": board findings are the subtraction baseline")
    return enabled


def fab_drc(pcb, out):
    out.unlink(missing_ok=True)
    r = subprocess.run(["kicad-cli","pcb","drc","--format","json","--severity-error",
                        "--exit-code-violations","-o",str(out),str(pcb)],
                       capture_output=True, text=True)
    if r.returncode not in (0, 5):
        raise RuntimeError(f"fab DRC failed ({r.returncode}): {r.stdout}\n{r.stderr}")
    data = json.loads(out.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("coordinate_units") != "mm" or not isinstance(data.get("violations"), list):
        raise RuntimeError("fab DRC wrote invalid JSON or non-mm coordinates")
    for row in data["violations"]:
        if (not isinstance(row, dict) or not isinstance(row.get("type"), str) or not row["type"]
                or row.get("severity") != "error" or not isinstance(row.get("description"), str)
                or not isinstance(row.get("items"), list)):
            raise RuntimeError("fab DRC wrote malformed violation")
        for item in row["items"]:
            if (not isinstance(item, dict) or not isinstance(item.get("description"), str)
                    or ("uuid" in item and not isinstance(item["uuid"], str))):
                raise RuntimeError("fab DRC wrote malformed item")
            if "pos" in item:
                pos = item["pos"]
                if (not isinstance(pos, dict) or any(type(pos.get(k)) not in (int, float)
                        or not math.isfinite(pos[k]) for k in ("x", "y"))):
                    raise RuntimeError("fab DRC wrote invalid position")
    return data


def fab_regular_input(path):
    # ponytail: checkout is immutable during render; this is not a concurrent-write sandbox.
    # All ancestors are deliberate; resolving here would hide checkout symlinks.
    absolute = path.absolute()
    for part in reversed((absolute, *absolute.parents)):
        if part.is_symlink():
            raise RuntimeError(f"fab input must not be a symlink: {part}; "
                               "use a physical checkout path with no symlink ancestors "
                               "(on macOS, /private/tmp rather than /tmp and /private/var rather than /var)")
    if path.exists() and not path.is_file():
        raise RuntimeError(f"fab input must be a regular file: {path}")


def fab_lint_rules(text):
    """Reject lexical errors KiCad can silently ignore along with appended rules.

    This is a conservative syntax guard, not a replacement for KiCad's rule engine.
    Units, constraint names and condition semantics are not validated here. KiCad
    may silently discard appended rules for those errors; render_fab exposes this
    residual risk in coverageWarnings whenever an authored rule file is present.
    Never rewrite authored rules to guess what the author intended.
    """
    depth = 0
    for match in re.finditer(r"#[^\n]*|\"(?:\\.|[^\"\\])*\"|\s+|[()]|[^()\s\"#]+|.", text):
        token = match.group()
        if token.startswith(("#", "\"")) and token != "\"":
            continue
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
        elif token == "\"" or re.match(r"[+-]?\.\d", token):
            raise RuntimeError("fab rules contain an unterminated string or leading-dot numeric literal; use 0.3mm, not .3mm")
        if depth < 0:
            raise RuntimeError("fab rules contain unbalanced parentheses")
    if depth:
        raise RuntimeError("fab rules contain unbalanced parentheses")


def fab_run_drc(source, target, board_bytes, project_bytes, rules_bytes, vendor=None):
    """One isolated DRC pass. vendor is None for the board-only pass, or (owned_rules_text, covered_types)."""
    target.mkdir(parents=True)
    pcb = target / source.name
    pcb.write_bytes(board_bytes)
    original = rules_bytes.decode("utf-8") if rules_bytes else "(version 1)\n"
    if vendor is None:
        if project_bytes:
            pcb.with_suffix(".kicad_pro").write_bytes(project_bytes)
        pcb.with_suffix(".kicad_dru").write_text(original, encoding="utf-8")
    else:
        owned_rules, covered = vendor
        combined = fab_owned_rules(original, owned_rules)
        fab_lint_rules(combined)
        pcb.with_suffix(".kicad_dru").write_text(combined, encoding="utf-8")
        project = json.loads(project_bytes.decode("utf-8")) if project_bytes else {}
        if not isinstance(project, dict):
            raise RuntimeError("fab project must be a JSON object")
        board = project.setdefault("board", {})
        if not isinstance(board, dict):
            raise RuntimeError("fab project board must be a JSON object")
        design = board.setdefault("design_settings", {})
        if not isinstance(design, dict):
            raise RuntimeError("fab project board.design_settings must be a JSON object")
        severities = design.setdefault("rule_severities", {})
        if not isinstance(severities, dict):
            raise RuntimeError("fab project board.design_settings.rule_severities must be a JSON object")
        design["drc_exclusions"] = []
        for name in covered | {"invalid_outline"}:
            severities[name] = "error"
        pcb.with_suffix(".kicad_pro").write_text(json.dumps(project), encoding="utf-8")
    return fab_drc(pcb, target / "drc.json")["violations"]


def render_fab(p, side, out, settings):
    source = pathlib.Path(board_path(p, side))
    for path in (source, source.with_suffix(".kicad_pro"), source.with_suffix(".kicad_dru")):
        fab_regular_input(path)
    pathlib.Path(out).mkdir(parents=True, exist_ok=True)
    if not source.is_file():
        pathlib.Path(out, "fab-limits.json").write_text(
            json.dumps({"sections": [], "reason": f"no {side} board"}), encoding="utf-8")
        return
    board_bytes = source.read_bytes()
    project_bytes = source.with_suffix(".kicad_pro").read_bytes() if source.with_suffix(".kicad_pro").is_file() else b""
    rules_bytes = source.with_suffix(".kicad_dru").read_bytes() if source.with_suffix(".kicad_dru").is_file() else b""
    input_hash = hashlib.sha256(b"\0".join([board_bytes, FAB_TABLE.read_bytes(), project_bytes, rules_bytes])).hexdigest()
    sections = fab_context(source)
    for s in sections:
        s.update(checked=[], violations=[], inputHash=input_hash)
        if rules_bytes.strip():
            s["coverageWarnings"].append(
                "Authored rule file present: rule loading is not independently verified; "
                "lexical lint does not validate units, constraint names or conditions, "
                "and KiCad may silently ignore appended vendor rules")
    supported = [s for s in sections if not s["unsupported"]]
    if supported:
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            # Exact saved fills in every pass, matching ordinary render_side (no --refill-zones).
            board_rows = fab_run_drc(source, root / "board", board_bytes, project_bytes, rules_bytes)
            for s in supported:
                vendor_rules, covered = fab_vendor_rules(s)
                _, unchecked = fab_rule_section(s)
                s["unchecked"] = list(unchecked)
                vendor_rows = fab_run_drc(source, root / s["vendor"], board_bytes, project_bytes,
                                          rules_bytes, (vendor_rules, covered))
                s["violations"] = [v for v in fab_subtract(vendor_rows, board_rows) if v["type"] in covered]
                if any(v["type"] == "invalid_outline" for v in vendor_rows):
                    if "edgeClearanceMm" not in s["unchecked"]:
                        s["unchecked"].append("edgeClearanceMm")
                    warning = "Edge clearance not checked: no valid closed board outline"
                    if warning not in s["coverageWarnings"]:
                        s["coverageWarnings"].append(warning)
                s["checked"] = [k for k in s["values"] if k not in s["unchecked"]
                                and not (s["layers"] <= 2 and "Inner" in k)]
    pathlib.Path(out, "fab-limits.json").write_text(json.dumps({"sections": sections}, sort_keys=True), encoding="utf-8")


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


def kept_refs(base, head):
    """References of footprints changed between revisions, including UUID renames and deletions."""
    rows = diff_objects(base, head)
    ids = {r["uuid"] for r in rows if r["kind"] == "footprint"}
    ids |= {r["uuid_before"] for r in rows if r["kind"] == "footprint" and r.get("uuid_before")}
    return sorted({o["ref"] for objects in (base, head) for uid, o in objects.items()
                   if uid in ids and o["kind"] == "footprint"})


def metadata3d(side, objects, keep, finish, missing):
    """One revision's footprint identity, placement and model coverage, in board millimetres."""
    reasons = {r["ref"]: r["reason"] for r in missing if r["side"] in (side, "both")}
    footprints, warnings, skipped = [], [], set()
    counts = {}
    for obj in objects.values():
        if obj['kind'] == 'footprint':
            counts[obj['ref']] = counts.get(obj['ref'], 0) + 1
    for uid, obj in sorted(objects.items()):
        if obj["kind"] != "footprint":
            continue
        ref = obj["ref"]
        if not ref or '*' in ref or counts[ref] > 1:
            reason = 'unannotated footprint' if not ref or '*' in ref else 'duplicate reference'
            warning = f"{ref or '(empty reference)'} ({uid}): {reason} skipped"
            warnings.append(warning)
            skipped.add(ref)
            print("::warning::" + workflow_command_escape(warning))
            continue
        reason = reasons.get(ref) or (None if obj.get("has_model") else "no model in footprint")
        box, pos = obj.get("box"), obj.get("pos")
        valid_pos = (isinstance(pos, (list, tuple)) and len(pos) >= 2
                     and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in pos))
        if not valid_pos:
            raise ValueError("footprint has no finite position: " + ref)
        valid_box = (isinstance(box, (list, tuple)) and len(box) == 4
                     and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in box))
        if not valid_box:
            if box is not None:
                print("::warning::" + workflow_command_escape(f"{ref}: malformed bounding box {box!r}, using estimated bounds"))
            # Padless graphics get a 2 mm estimated box; it is not enclosure clearance.
            box = [pos[0] - 1, pos[1] - 1, pos[0] + 1, pos[1] + 1]
        layer = (obj.get("props") or {}).get("layer") or ""
        footprints.append({"uuid": uid, "ref": ref, "side": "bottom" if layer.startswith("B.") else "top",
                           "pos": list(pos), "box": box,
                           "hasModel": bool(obj.get("has_model")) and reason is None, "reason": reason})
    return {"version": 1, "side": side, "keep": sorted(set(keep)), "finish": finish, "footprints": footprints, "warnings": warnings, "skippedRefs": sorted(skipped)}


def prepare3d(p):
    """Write revision-local processor inputs. One shared keep set serves both revisions of a comparison.

    When both revision boards are present, a parsing failure on either side prevents computing
    the true comparison diff and shared keep set; in this case both sides are marked unavailable
    to avoid writing a degenerate keep set. When an absent revision is genuinely missing (e.g. initial
    revision or single mode), head footprints are treated as additions. When a side has metadata
    errors after successful comparison diff, only the failing side's input is unlinked.
    """
    paths = {side: pathlib.Path(board_path(p, side)) for side in ("base", "head")}
    out = pathlib.Path("review", project_id(p["dir"]))
    targets = {side: out / side / "board-3d-input.json" for side in paths}
    for side, path in paths.items():
        if not path.is_file():
            # Never create the side folder here: build_project treats an existing folder as a present revision.
            targets[side].unlink(missing_ok=True)
    try:
        objects = {side: pcb_objects(path) if path.is_file() else {} for side, path in paths.items()}
        keep = kept_refs(objects["base"], objects["head"])
        missing = model3d_missing(str(out), objects)
    except Exception as error:
        # A malformed board file prevents computing the comparison's shared keep set; both sides are unavailable.
        for target in targets.values():
            target.unlink(missing_ok=True)
        print(f"{p['name']}: 3D processing unavailable: {error}")
        return
    for side, path in paths.items():
        target = targets[side]
        if not path.is_file():
            continue
        try:
            root = parse_sexpr(path.read_text(encoding="utf-8"))
            stackup = find(find(root, "setup") or [], "stackup") or []
            finish = val(stackup, "copper_finish") or ""
            metadata = metadata3d(side, objects[side], keep, finish, missing)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(metadata, sort_keys=True) + "\n", encoding="utf-8")
        except Exception as error:
            target.unlink(missing_ok=True)
            print(f"{p['name']}: 3D processing unavailable: {error}")


def cmd_prepare3d(args):
    det = json.loads(pathlib.Path("review/detect.json").read_text(encoding="utf-8"))
    for p in det["projects"]:
        try:
            prepare3d(p)
        except Exception as error:
            print(f"{p.get('name', 'project')}: 3D processing unavailable: {error}")


def glb_argv(pcb, folder):
    return ["kicad-cli", "pcb", "export", "glb", "--include-tracks", "--include-pads",
            "--include-zones", "--include-silkscreen", "--include-soldermask",
            "--subst-models", "-f", "-o", str(folder / "board.raw.glb"), pcb]


def normalize_glb(path):
    """Drop KiCad's export timestamp so identical boards keep identical bytes and cache keys.

    Only cache stability depends on this, so anything unexpected leaves KiCad's file as written."""
    path = pathlib.Path(path)
    try:
        data = path.read_bytes()
        if len(data) < 20 or data[:4] != b'glTF' or data[16:20] != b'JSON':
            return
        size = struct.unpack('<I', data[12:16])[0]
        doc = json.loads(data[20:20 + size])
    except (OSError, ValueError):
        return
    asset = doc.get('asset') if isinstance(doc, dict) else None
    extras = asset.get('extras') if isinstance(asset, dict) else None
    if not isinstance(extras, dict) or 'generated_at' not in extras:
        return
    del extras['generated_at']
    chunk = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    chunk += b' ' * (-len(chunk) % 4)
    rest = data[20 + size:]
    staged = path.with_name(path.name + '.tmp')
    try:
        staged.write_bytes(b'glTF' + data[4:8] + struct.pack('<I', 20 + len(chunk) + len(rest))
                           + struct.pack('<I', len(chunk)) + b'JSON' + chunk + rest)
        os.replace(staged, path)
    except OSError:
        with contextlib.suppress(OSError):
            staged.unlink(missing_ok=True)


def poster_argv(pcb, folder):
    return ["kicad-cli", "pcb", "render", "--quality", "basic", "--perspective",
            "--rotate", "-45,0,45", "-w", "1600", "-h", "1000", "-o", str(folder / "poster.png"), pcb]


def poster_size(path):
    """Read a PNG's actual canvas size, including when checking cached stills."""
    try:
        with pathlib.Path(path).open('rb') as stream:
            header = stream.read(24)
        if len(header) == 24 and header[:16] == b'\x89PNG\r\n\x1a\n\0\0\0\rIHDR':
            return struct.unpack('>II', header[16:24])
    except OSError:
        pass
    return None


def normalize_poster(path):
    """Losslessly center KiCad's smaller drawable area on the shared 1600x1000 canvas.

    KiCad 10 on macOS can return a smaller drawable area than the requested size.
    Keep the prescribed argv and pixels; transparent padding avoids distortion.
    Normal-sized PNGs validate chunks and inflate only; smaller local exports need unfiltering.
    KiCad emits non-interlaced 8-bit RGB(A). Reject other/corrupt output rather
    than advertising a nonconforming successful still. No image dependency.
    """
    png = path.read_bytes()
    if png[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG')
    offset, chunks, compressed = 8, [], bytearray()
    while offset < len(png):
        if offset + 12 > len(png):
            raise ValueError('truncated PNG chunk')
        size = struct.unpack('>I', png[offset:offset+4])[0]
        end = offset + 12 + size
        if end > len(png):
            raise ValueError('truncated PNG payload')
        kind, data = png[offset+4:offset+8], png[offset+8:end-4]
        if zlib.crc32(kind + data) != struct.unpack('>I', png[end-4:end])[0]:
            raise ValueError('invalid PNG checksum')
        chunks.append((kind, data))
        if kind == b'IDAT':
            compressed.extend(data)
        offset = end
    if not chunks or chunks[0][0] != b'IHDR' or len(chunks[0][1]) != 13 or chunks[-1] != (b'IEND', b''):
        raise ValueError('missing PNG header/end')
    width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', chunks[0][1])
    if not (0 < width <= 1600 and 0 < height <= 1000):
        raise ValueError(f'unsupported poster size {width}x{height}')
    if depth != 8 or color not in (2, 6) or (compression, filtering, interlace) != (0, 0, 0):
        raise ValueError('unsupported poster PNG format')
    channels = 4 if color == 6 else 3
    stride = width * channels
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, (stride+1)*height+1)
    if len(raw) != (stride+1)*height or not decoder.eof or decoder.unused_data:
        raise ValueError('invalid PNG image data')
    # Fast path: validated normal exports need no row unfiltering or pixel rewriting.
    if (width, height) == (1600, 1000):
        return
    previous = bytearray(stride)
    output = bytearray((1+1600*4)*1000)  # filter 0, transparent RGBA border
    left, top = (1600-width)//2, (1000-height)//2
    for y in range(height):
        start = y*(stride+1)
        filter_type = raw[start]
        row = bytearray(raw[start+1:start+1+stride])
        if filter_type not in range(5):
            raise ValueError('invalid PNG row filter')
        if filter_type:
            for i in range(stride):
                a = row[i-channels] if i >= channels else 0
                b = previous[i]
                c = previous[i-channels] if i >= channels else 0
                if filter_type == 1:
                    predictor = a
                elif filter_type == 2:
                    predictor = b
                elif filter_type == 3:
                    predictor = (a+b)//2
                else:
                    p = a+b-c
                    pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                    predictor = a if pa <= pb and pa <= pc else b if pb <= pc else c
                row[i] = (row[i]+predictor) & 255
        previous = row
        if channels == 3:
            rgba = bytearray(b'\xff'*(width*4))
            for channel in range(3):
                rgba[channel::4] = row[channel::3]
        else:
            rgba = row
        dest = (top+y)*(1+1600*4)+1+left*4
        output[dest:dest+width*4] = rgba
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind+data))
    header = struct.pack('>IIBBBBB', 1600, 1000, 8, 6, 0, 0, 0)
    # Retain colour-space metadata, not offsets/backgrounds tied to the old canvas.
    metadata = b''.join(chunk(kind, data) for kind, data in chunks if kind in (b'sRGB', b'gAMA', b'cHRM', b'iCCP'))
    path.write_bytes(png[:8] + chunk(b'IHDR', header) + metadata + chunk(b'IDAT', zlib.compress(output)) + chunk(b'IEND', b''))


def export_glb(p, side, out, *, model=True, poster=True, viewer=True):
    """Best-effort raw/fallback model and shared still; render warnings never affect coverage."""
    pcb = board_path(p, side)
    folder = pathlib.Path(out)
    folder.mkdir(parents=True, exist_ok=True)

    def run(argv, name, log):
        dest = folder / name
        dest.unlink(missing_ok=True)
        marker = folder / (name + ".failed")
        marker.unlink(missing_ok=True)
        try:
            proc = subprocess.run(argv, capture_output=True, text=True)
            (folder / log).write_text((proc.stdout or "") + (proc.stderr or ""), encoding="utf-8")
            if proc.returncode == 0 and dest.is_file() and dest.stat().st_size:
                return True
        except OSError as error:
            (folder / log).write_text(str(error), encoding="utf-8")
        dest.unlink(missing_ok=True)
        marker.write_text("export attempted and failed")
        return False

    if model:
        if run(glb_argv(pcb, folder), "board.raw.glb", "glb.log"):
            normalize_glb(folder / "board.raw.glb")
            if viewer:
                shutil.copyfile(folder / "board.raw.glb", folder / "board.glb")
            else:
                (folder / "board.glb").unlink(missing_ok=True)
        else:
            (folder / "board.glb").unlink(missing_ok=True)
    if poster:
        if run(poster_argv(pcb, folder), "poster.png", "poster.log"):
            try:
                normalize_poster(folder / "poster.png")
            except (OSError, ValueError, zlib.error) as error:
                (folder / "poster.png").unlink(missing_ok=True)
                (folder / "poster.png.failed").write_text("normalization attempted and failed")
                with (folder / "poster.log").open('a', encoding='utf-8') as log:
                    log.write(f'\nPoster normalization failed: {error}\n')
    else:
        (folder / "poster.png").unlink(missing_ok=True)


def render_tool_identity():
    """The pinned image identifies CI's KiCad, including on the host before it is pulled."""
    if os.environ.get("KICAD_IMAGE"):
        return os.environ["KICAD_IMAGE"]
    try:
        proc = subprocess.run(["kicad-cli", "--version"], capture_output=True, text=True)
        if proc.returncode == 0:
            return (proc.stdout or "").strip()
    except OSError:
        pass
    return "local-kicad-unavailable"


def render_cache_complete(cache, p, side, settings, *, check_release=True):
    if not cache or not image_cache_complete(cache, p, side):
        return False
    board_exists = pathlib.Path(board_path(p, side)).is_file()
    if fab_enabled(settings):
        try:
            doc = json.loads((cache / "fab-limits.json").read_text(encoding="utf-8"))
            sections = doc.get("sections") if isinstance(doc, dict) else None
            if not isinstance(sections, list):
                return False
            if board_exists:
                if any(sum(1 for s in sections if isinstance(s, dict) and s.get("vendor") == v) != 1 for v in FAB_VENDORS):
                    return False
        except (OSError, ValueError):
            return False
    # board.raw.glb is required for head only when downloads.enabled is True (spec lines 27-28,
    # plan-context.md line 7). Release-only renders stage fab files but never produce raw GLB,
    # so requiring raw GLB for release-only would cause permanent cache misses.
    if side == "head" and settings.get("downloads", {}).get("enabled") and board_exists:
        raw = cache / "board.raw.glb"
        if (not raw.is_file() or not raw.stat().st_size) and not (cache / "board.raw.glb.failed").is_file():
            return False
    need_still = settings["3d"]["enabled"] or settings.get("design", {}).get("enabled", False)
    if need_still and board_exists:
        if settings["3d"]["enabled"]:
            raw = cache / "board.raw.glb"
            glb = cache / "board.glb"
            if not (cache / "board.raw.glb.failed").is_file():
                if not raw.is_file() or not raw.stat().st_size or not glb.is_file() or not glb.stat().st_size:
                    return False
        poster = cache / "poster.png"
        if not (poster_size(poster) == (1600, 1000) or (cache / "poster.png.failed").is_file()):
            return False
    if check_release and settings["checks"].get("release", "off") != "off":
        pro = posixpath.join(side, p["dir"], f"{p['name']}.kicad_pro")
        if os.path.exists(pro) and (board_exists or os.path.isfile(posixpath.join(side, p["dir"], f"{p['name']}.kicad_sch"))):
            try:
                fab_parts(pro, p["name"], settings, str(pathlib.Path(cache) / "fab"))
            except (SystemExit, OSError, ValueError, ArithmeticError, IndexError, KeyError, csv.Error, zipfile.BadZipFile):
                return False
    return True


def glb_input_digest(p, side):
    """Hash framed paths and bytes directly, without expanding binary data into repr strings."""
    digest = hashlib.sha256()
    inputs = glb_inputs(p, side)
    if inputs is not None:
        board, models = inputs
        for value in (board, *(value for name, data in models for value in (name.encode(), data))):
            digest.update(len(value).to_bytes(8, 'big'))
            digest.update(value)
    return digest.hexdigest()


def image_export_identity(p, side):
    """Explicit image inputs shared by host restore and the pinned renderer."""
    pcb = board_path(p, side)
    return {'renderer': IMAGE_RENDERER, 'options': IMAGE_EXPORT_OPTIONS,
            'layers': board_layers(pcb) if os.path.isfile(pcb) else [], 'palettes': IMAGE_PALETTES}


def image_cache_complete(cache, p, side):
    """Legacy/unversioned renders cannot satisfy the image export contract."""
    if IMAGE_RENDERER == 'local-unverified':
        return False
    try:
        return json.loads((cache / '.complete').read_text(encoding='utf-8')) == image_export_identity(p, side)
    except (OSError, ValueError):
        return False


def render_cache(p, side, det, settings):
    """Revision/project/tool/settings identity; outputs remain independent of report change IDs."""
    revision = det.get(side) or ""
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        return None
    # Normalize only input/output locations so the same revision can move from Head to Base.
    inputs = {"settings": settings, "tool": render_tool_identity(),
              "glb": glb_argv("PCB", pathlib.Path(".")), "poster": poster_argv("PCB", pathlib.Path(".")),
              "board_models": glb_input_digest(p, side)}
    identity = pathlib.Path(__file__).read_bytes() + json.dumps(inputs, sort_keys=True).encode()
    identity += json.dumps(image_export_identity(p, side), sort_keys=True, separators=(',', ':')).encode()
    needs_downloads = side == "head" and (settings.get("downloads", {}).get("enabled") or settings["checks"].get("release", "off") != "off")
    if needs_downloads:
        identity += b"\0head-downloads-v1"
    if fab_enabled(settings):
        identity += FAB_TABLE.read_bytes() + (b"fab-head" if side == "head" else b"fab-base")
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
    if any(not render_cache_complete(cache, p, side, settings) for p, side, cache in entries):
        raise SystemExit(1)
    for p, side, cache in entries:
        out = f"review/{project_id(p['dir'])}/{side}"
        shutil.rmtree(f"{out}/fab", ignore_errors=True)
        shutil.copytree(cache, out, dirs_exist_ok=True)
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
                if cache.exists():
                    shutil.rmtree(cache)
                shutil.copytree(out, cache, dirs_exist_ok=True)
                (cache / '.complete').write_text(json.dumps(image_export_identity(p, side), sort_keys=True), encoding='utf-8')


def cmd_copper(args):
    # ponytail: recompute pair-specific copper once per run; no polygon cache.
    # Each existing revision gets 120 s for CLI refill plus 60 s for collection;
    # reserve another 60 s for startup, signed booleans and JSON serialization.
    det = json.loads(pathlib.Path("review/detect.json").read_text())
    script = pathlib.Path(__file__).resolve().parent / "tools" / "copper_area.py"
    for p in det["projects"]:
        paths = [pathlib.Path(side) / p["dir"] / (p["name"] + ".kicad_pcb") for side in ("base", "head")]
        out = pathlib.Path("review") / project_id(p["dir"]) / "copper-diff.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        result = {"rows": [], "incomplete": []}
        if any(f.exists() for f in paths):
            try:
                run = subprocess.run([sys.executable, str(script), *[str(f) if f.exists() else "-" for f in paths]],
                                     capture_output=True, text=True,
                                     timeout=180 * sum(f.exists() for f in paths) + 60, check=True)
                result = json.loads(run.stdout)
            except (subprocess.SubprocessError, ValueError, OSError) as exc:
                result = {"rows": [], "incomplete": [{"channel": "routing", "reason": f"Copper comparison unavailable: {type(exc).__name__}"}]}
                print(f"{p['name']}: copper unavailable: {exc}", file=sys.stderr)
        out.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")), encoding="utf-8")


def cmd_render(args):
    _sheet_warnings.clear()
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    settings = load_settings()
    for p in det["projects"]:
        export_3d = settings["3d"]["enabled"]
        need_still = export_3d or settings.get("design", {}).get("enabled", False)
        shared_3d = need_still and glb_inputs(p, "base") == glb_inputs(p, "head")
        for side in ("base", "head"):
            if (side == "base" and p["status"] == "added") or (side == "head" and p["status"] == "removed"):
                continue
            out = f"review/{project_id(p['dir'])}/{side}"
            cache = render_cache(p, side, det, settings)
            if render_cache_complete(cache, p, side, settings):
                shutil.rmtree(f"{out}/fab", ignore_errors=True)
                shutil.copytree(cache, out, dirs_exist_ok=True)
                print(f"{p['name']}: {side} render cache hit ({det[side]})")
                continue
            if render_cache_complete(cache, p, side, settings, check_release=False):
                shutil.rmtree(f"{out}/fab", ignore_errors=True)
                shutil.copytree(cache, out, dirs_exist_ok=True)
            else:
                # Connectivity evidence for every present schematic, whatever the check settings.
                render_side(posixpath.join(side, p["dir"]), p["name"], out, netlist=True)
                if fab_enabled(settings):
                    try:
                        render_fab(p, side, out, settings)
                    except (OSError, ValueError, RuntimeError) as exc:
                        sys.exit(f"Fab limits could not run for {p['name']}: {exc}")
                if pathlib.Path(board_path(p, side)).is_file():
                    if side == "head" and shared_3d and (export_3d or not settings["downloads"]["enabled"]):
                        os.makedirs(out, exist_ok=True)
                        for name in ("board.raw.glb", "board.glb", "poster.png", "glb.log", "poster.log", "board.raw.glb.failed", "poster.png.failed"):
                            source = pathlib.Path(f"review/{project_id(p['dir'])}/base/{name}")
                            dest = pathlib.Path(out) / name
                            dest.unlink(missing_ok=True)
                            if source.is_file():
                                shutil.copyfile(source, dest)
                    elif side == "head" and settings["downloads"]["enabled"]:
                        export_glb(p, side, out, model=True, poster=need_still, viewer=export_3d)
                    elif need_still:
                        export_glb(p, side, out, model=export_3d)
            if settings["checks"].get("release", "off") != "off":
                pro = posixpath.join(side, p["dir"], f"{p['name']}.kicad_pro")
                if os.path.exists(pro):
                    shutil.rmtree(f"{out}/fab", ignore_errors=True)
                    os.makedirs(f"{out}/fab", exist_ok=True)
                    try:
                        release_project(pro, "review", settings, f"{out}/fab", p["name"])
                    except (SystemExit, OSError, ValueError, IndexError, KeyError, csv.Error, zipfile.BadZipFile):
                        print("::warning::" + workflow_command_escape(f"{p['name']}: release outputs incomplete; continuing other exports"))
            if side == "head" and det.get("head") and (settings["downloads"]["enabled"] or settings["checks"].get("release", "off") != "off"):
                export_downloads(p, posixpath.join(side, p["dir"]), out, settings, det["head"])
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
                            print("::warning::" + workflow_command_escape(f"No drawing for library item {c['lib']}:{c['item']} ({side})"))

    cache_renders()


TOKEN = re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))')


class Quoted(str):
    """A quoted S-expression token, with normal string equality and serialization."""


def is_net_number(token):
    return not isinstance(token, Quoted) and token.isdigit()


def parse_sexpr(text):
    """KiCad S-expression text to nested lists of strings, preserving quoted tokens."""
    stack, pos = [[]], 0
    for m in TOKEN.finditer(text):
        if m.start() != pos:
            raise ValueError("malformed S-expression")
        pos = m.end()
        if m.group(1):
            stack.append([])
        elif m.group(2):
            if len(stack) < 2:
                raise ValueError("malformed S-expression")
            node = stack.pop()
            stack[-1].append(node)
        elif m.group(3) is not None:
            stack[-1].append(Quoted(re.sub(r"\\(.)", lambda e: "\n" if e.group(1) == "n" else e.group(1), m.group(3))))
        elif m.group(4):
            stack[-1].append(m.group(4))
    if len(stack) != 1 or len(stack[0]) != 1 or not isinstance(stack[0][0], list) or text[pos:].strip():
        raise ValueError("malformed S-expression")
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


def revision_root(proj_dir):
    """Return the absolute path of the revision root containing proj_dir.

    In production, kicad-review passes relative project directories prefixed with the
    revision: 'base/<dir>' or 'head/<dir>' (and may have leading './').
    For relative paths starting with 'base' or 'head', that first segment is the revision
    prefix and defines the revision root, preventing sheets from escaping into sibling
    revisions or the workspace root.
    If no 'base' or 'head' prefix exists (e.g. standalone tests) or proj_dir is an
    absolute path, the containment root is the realpath of proj_dir itself.
    """
    if not os.path.isabs(proj_dir):
        parts = pathlib.Path(os.path.normpath(proj_dir)).parts
        if parts and parts[0] in ("base", "head"):
            return os.path.realpath(parts[0])
    return os.path.realpath(proj_dir)


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
    top = revision_root(proj_dir)

    def warn(message):
        key = (os.path.realpath(proj_dir), message)
        if key not in _sheet_warnings:  # sheet_pages runs several times per revision
            _sheet_warnings.add(key)
            print("::warning::" + workflow_command_escape(message), file=sys.stderr)

    # stem: the file name kicad-cli gives the page's SVG, the sheet names along its path joined by "-".
    def walk(file, path, sheet_name, parent, depth, stem, ancestors, page=None):
        pages.append({"path": path, "name": sheet_name, "file": file, "parent": parent, "stem": stem,
                      "page": page or legacy.get(path.rstrip("/") or "/") or str(len(pages) + 1)})
        full = posixpath.join(proj_dir, file)
        if depth > 32:
            return
        if not os.path.isfile(full):
            warn(f"{full}: sheet file missing or not a regular file; its drawing is not read")
            return
        with open(full, encoding="utf-8") as fh:
            node = parse_sexpr(fh.read())
        names = set()
        for s in findall(node, "sheet"):
            props = properties(s)
            child = props.get("Sheetname", "?")
            safe = re.sub(r"[\\/]", "_", child)
            if safe in names:  # kicad-cli names SVGs after the sanitized name, so A/B and A_B collide too
                warn(f"{full}: sheet {child!r} collides with another sheet using sanitized name {safe!r}; skipped")
                continue
            names.add(safe)
            uid, sheetfile = val(s, "uuid"), props.get("Sheetfile") or ""
            if not uid or not sheetfile:
                warn(f"{full}: sheet {child!r} has no uuid or Sheetfile; skipped")
                continue
            if "\0" in sheetfile:
                warn(f"{full}: sheet {child!r} file {sheetfile!r} contains a null byte; skipped")
                continue
            child_file = posixpath.normpath(posixpath.join(posixpath.dirname(file), sheetfile))
            try:
                real = os.path.realpath(posixpath.join(proj_dir, child_file))
            except ValueError:
                warn(f"{full}: sheet {child!r} file {sheetfile!r} path is invalid; skipped")
                continue
            if posixpath.isabs(sheetfile) or os.path.commonpath([top, real]) != top:
                warn(f"{full}: sheet {child!r} file {sheetfile!r} is outside the revision; skipped")
            elif child_file in ancestors:
                warn(f"{full}: sheet {child!r} includes {sheetfile!r}, which contains it; recursive hierarchy skipped")
            else:
                parent_uuid_path = f'/{root_uuid}{path.rstrip("/")}'
                walk(child_file, f"{path}{uid}/", child, path, depth + 1, f"{stem}-{safe}",
                     ancestors | {child_file}, sheet_instance_page(s, name, parent_uuid_path))

    walk(f"{name}.kicad_sch", "/", name, None, 0, name, {f"{name}.kicad_sch"})
    return pages


_sheet_warnings = set()


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


def symbol_primitives(libraries, identity, unit, style='1', trail=()):
    """Drawing primitives of a library symbol for one unit and body style, with inherited (extends) bodies first."""
    if identity in trail:
        raise ValueError('symbol inheritance cycle: ' + ' -> '.join((*trail, identity)))
    node = libraries[identity]
    parent = val(node, 'extends')
    out = symbol_primitives(libraries, parent, unit, style, (*trail, identity)) if parent else []
    for child in findall(node, 'symbol'):
        m = re.search(r'_(\d+)_(\d+)$', child[1])
        if m and m[1] in ('0', str(unit)) and m[2] in ('0', str(style)):
            out.extend(c for c in child[2:] if isinstance(c, list))
    return out


def symbol_geometry(parts):
    """Conservative bounds (coords), pin records and an approximate flag for symbol primitives in millimetres."""
    coords, pins, approximate = [], [], False
    for n in parts:
        kind = n[0]
        if kind == 'rectangle':
            a, b = find(n, 'start'), find(n, 'end')
            coords.extend([[float(a[1]), float(a[2])], [float(b[1]), float(b[2])],
                           [float(a[1]), float(b[2])], [float(b[1]), float(a[2])]])
        elif kind in ('polyline', 'bezier'):
            coords.extend([list(p) for p in points(n)])
            approximate |= kind == 'bezier'  # conservative control-point hull
        elif kind == 'circle':
            c, r = find(n, 'center'), float(val(n, 'radius'))
            coords.extend([[float(c[1]) + dx * r, float(c[2]) + dy * r] for dx in (-1, 1) for dy in (-1, 1)])
        elif kind == 'arc':
            a, m, b = [[float(v) for v in find(n, k)[1:3]] for k in ('start', 'mid', 'end')]
            ax, ay = a
            mx, my = m
            bx, by = b
            d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
            if abs(d) < 1e-12:
                coords.extend([a, m, b])
            else:
                aa = ax * ax + ay * ay
                mm = mx * mx + my * my
                bb = bx * bx + by * by
                cx = (aa * (my - by) + mm * (by - ay) + bb * (ay - my)) / d
                cy = (aa * (bx - mx) + mm * (ax - bx) + bb * (mx - ax)) / d
                r = math.hypot(ax - cx, ay - cy)
                coords.extend([[cx + dx * r, cy + dy * r] for dx in (-1, 1) for dy in (-1, 1)])
            approximate = True
        elif kind == 'pin':
            x, y, *angle = at(n)
            theta = math.radians(angle[0] if angle else 0)
            length = float(val(n, 'length', 0))
            coords.extend([[x, y], [x + math.cos(theta) * length, y + math.sin(theta) * length]])
            pins.append({'number': str(val(n, 'number', '')), 'name': str(val(n, 'name', '')), 'x': x, 'y': y})
    return coords, pins, approximate


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
        if not os.path.isfile(full):
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
                             "points_mm": pts, "pos": list(pts[0]) if pts else None, "box": box_of(pts), "where": where}
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


def sheet_point(point, placed):
    """A library-symbol point (y up) as a sheet point (y down) for the symbol's placement: mirror, rotate, translate."""
    x, y = map(float, point[:2])
    mirror = val(placed, 'mirror', '')
    if mirror == 'x':
        y = -y
    elif mirror == 'y':
        x = -x
    pos = at(placed)
    angle = math.radians(pos[2] if len(pos) > 2 else 0)
    c, s = math.cos(angle), math.sin(angle)
    return [round(pos[0] + c * x - s * y, 6),
            round(pos[1] - s * x - c * y, 6)]


def hotspot_box(points):
    if not points:
        return None
    return [min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points)]


def library_index(lib_symbols):
    """Embedded library symbols by qualified name and, when unique, by unqualified name (`extends` uses the latter)."""
    libraries = {str(n[1]): n for n in findall(lib_symbols, 'symbol')}
    for key in list(libraries):
        short = key.split(':')[-1]
        matches = [v for k, v in libraries.items() if k.split(':')[-1] == short]
        if short not in libraries and len(matches) == 1:
            libraries[short] = libraries[key]
    return libraries


def sheet_hotspots(proj_dir, name):
    """Per-sheet-instance hotspot manifest: symbols with bounding boxes and pin endpoints, labels, no-connects, wires (mm)."""
    views, warnings = [], []
    pages = sheet_pages(proj_dir, name)
    root_uuid = None
    for page in pages:
        view = {'sheet': page['path'], 'file': page['file'], 'viewBox': None,
                'elements': [], 'labels': [], 'noConnects': [], 'wires': []}
        views.append(view)
        full = pathlib.Path(proj_dir, page['file'])
        if not full.is_file():
            warnings.append({'sheet': page['path'], 'reason': 'sheet file missing'})
            continue
        root = parse_sexpr(full.read_text(encoding='utf-8'))
        if page['parent'] is None:
            root_uuid = val(root, 'uuid')
        libraries = library_index(find(root, 'lib_symbols') or [])
        # Instance paths are the root UUID plus the sheet UUID path; without a root identity use the properties.
        inst_path = ('/' + str(root_uuid) + page['path'].rstrip('/')) if root_uuid else None
        for n in root[1:]:
            if not isinstance(n, list) or not n:
                continue
            uid = val(n, 'uuid')
            if not uid:
                continue
            uid, kind = str(uid), n[0]
            if kind == 'symbol':
                props = {str(k): str(v) for k, v in properties(n).items()}
                unit = str(val(n, 'unit', '1'))
                ref = props.get('Reference', '?')
                if inst_path:
                    projects = findall(find(n, 'instances') or [], 'project')
                    # Prefer this project's record; renamed projects keep older records for the same path.
                    for project in sorted(projects, key=lambda p: p[1] != name):
                        paths = [p for p in findall(project, 'path') if p[1].rstrip('/') == inst_path]
                        if paths:
                            ref = str(val(paths[0], 'reference', ref))
                            break
                props['Reference'] = ref
                if not at(n):
                    warnings.append({'sheet': page['path'], 'uuid': uid, 'reason': 'symbol has no position'})
                    continue
                lib_id = str(val(n, 'lib_id', ''))
                style = str(val(n, 'body_style', val(n, 'convert', '1')))
                try:
                    coords, pins, approximate = symbol_geometry(symbol_primitives(
                        libraries, str(val(n, 'lib_name', lib_id)), unit, style))
                except KeyError:
                    coords, pins, approximate = [], [], True
                    warnings.append({'sheet': page['path'], 'uuid': uid, 'reason': 'library unavailable'})
                except (ValueError, TypeError, IndexError, AttributeError):
                    # Inheritance cycle or malformed primitive: keep the symbol as an approximate box.
                    coords, pins, approximate = [], [], True
                    warnings.append({'sheet': page['path'], 'uuid': uid, 'reason': 'symbol geometry unavailable'})
                if not coords:
                    coords, approximate = [[-1, -1], [1, 1]], True
                placed_pins = []
                for pin in pins:
                    x, y = sheet_point([pin['x'], pin['y']], n)
                    placed_pins.append(dict(pin, x=x, y=y))
                view['elements'].append({
                    'uuid': uid, 'ref': ref, 'unit': unit, 'lib_id': lib_id,
                    'value': props.get('Value', ''), 'footprint': props.get('Footprint', ''),
                    'datasheet': props.get('Datasheet', ''), 'fields': props,
                    'bbox': hotspot_box([sheet_point(p, n) for p in coords]), 'pins': placed_pins,
                    'confidence': 'approximate' if approximate else 'exact'})
            elif kind in ('label', 'global_label', 'hierarchical_label', 'no_connect'):
                pos = at(n)
                if not pos:
                    continue
                row = {'uuid': uid, 'x': pos[0], 'y': pos[1]}
                if kind == 'no_connect':
                    view['noConnects'].append(row)
                else:
                    view['labels'].append(dict(row, text=str(n[1]), kind=kind))
            elif kind in ('wire', 'bus'):
                pts = [list(p) for p in points(n)]
                view['wires'].append({'uuid': uid, 'points': pts, 'bbox': hotspot_box(pts)})
    return {'version': 1, 'units': 'mm', 'views': views, 'warnings': warnings}


def pcb_objects(path):
    with open(path, encoding="utf-8") as fh:
        root = parse_sexpr(fh.read())
    return pcb_objects_from_root(root)


def pcb_objects_from_root(root):
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
                    record = emit("pad", child_uid, uid, ref, ls, net_id(child), side, "pads", geometry, parent["hidden"] or hidden(child))
                    record.update(pin=child[1], attr=child[2])
                    children.append(record)
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


def stats_number(value):
    if value is None:
        return None
    m = re.match(r'^\s*([-+]?\d+(?:\.\d+)?)', str(value))
    return float(m.group(1)) if m else None


def board_inspect(scene, stats=None):
    names = {n['id']: n['name'] for n in scene['nets']}
    out = {'version': 1, 'units': 'mm', 'layers': scene['copperStack'],
           'nets': [{'name': n['name'], 'netClass': None} for n in scene['nets'] if n['name']],
           'pads': [], 'tracks': [], 'vias': [], 'footprintGraphics': [],
           'warnings': list(scene['warnings']),
           'truncated': dict.fromkeys(('nets', 'pads', 'tracks', 'vias', 'footprintGraphics'), False)}
    unsupported = dict.fromkeys(('pads', 'vias', 'tracks', 'footprintGraphics'), 0)
    length = 0.0
    for o in scene['objects']:
        # Scene tracks and arcs carry the net name; pads and vias carry the numeric net id.
        net = o.get('net')
        common = {k: o.get(k) for k in ('uuid', 'changeUuid', 'layers', 'side')}
        common.update(net=names.get(net, net if isinstance(net, str) else ''), hidden=bool(o.get('hidden')),
                      geometry=o['geometry'])
        geom = o['geometry']
        layers = o.get('layers') or []
        if o['kind'] in ('track', 'arc'):
            segments = geom.get('segments', [])
            if not segments:
                unsupported['tracks'] += 1
            length += sum(math.hypot(s[2] - s[0], s[3] - s[1]) / 1000 for s in segments)
            for i, s in enumerate(segments):
                out['tracks'].append(dict(common, kind=o['kind'], segment=i, layer=layers[0] if layers else '',
                                          x1=s[0] / 1000, y1=s[1] / 1000, x2=s[2] / 1000, y2=s[3] / 1000, width=s[4] / 1000))
        elif o['kind'] in ('pad', 'via'):
            if not geom.get('primitive'):
                unsupported['pads' if o['kind'] == 'pad' else 'vias'] += 1
            elif o['kind'] == 'via':
                p, drill = geom['primitive'], geom.get('drill')
                out['vias'].append(dict(common, x=p['center'][0] / 1000, y=p['center'][1] / 1000,
                                        diameter=p['size'][0] / 1000,
                                        fromLayer=layers[0] if layers else '', toLayer=layers[-1] if layers else '',
                                        drill=drill['size'][0] / 1000 if drill else None))
            else:
                p, drill = geom['primitive'], geom.get('drill')
                out['pads'].append(dict(common, ref=o.get('ref'), pin=o.get('pin', ''), attr=o.get('attr', ''),
                                        x=p['center'][0] / 1000, y=p['center'][1] / 1000,
                                        width=p['size'][0] / 1000, height=p['size'][1] / 1000,
                                        shape=p['shape'], angle=p['angle'] / 1000,
                                        radiusRatio=p.get('radius', 0) / min(p['size']) if min(p['size']) else 0,
                                        custom=geom.get('rings', []), hole=drill))
        elif o.get('ref') and o['kind'] in ('shape', 'text'):
            if geom:
                out['footprintGraphics'].append(dict(common, ref=o['ref'], kind=o['kind']))
            else:
                unsupported['footprintGraphics'] += 1
    out['unsupported'] = unsupported
    board = (stats or {}).get('board', {})
    width, height = stats_number(board.get('width')), stats_number(board.get('height'))
    cli = {key: (stats or {}).get(key) for key in ('pads', 'vias')}
    def counted(key, fallback):
        group = cli[key]
        if isinstance(group, dict) and group:
            return sum(v for v in group.values() if isinstance(v, (int, float)) and not isinstance(v, bool))
        return fallback
    out['stats'] = {'copperLayers': len(out['layers']), 'routedLengthMm': round(length, 6),
                    'boardSizeMm': [width, height] if board.get('has_outline') is True and width is not None and height is not None else None,
                    'padCount': counted('pads', len(out['pads'])), 'viaCount': counted('vias', len(out['vias'])),
                    'netCount': len(out['nets']),
                    'countsSource': 'kicad-cli' if all(isinstance(v, dict) and v for v in cli.values()) else 'inspection-graph'}
    return out


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

    def section(parent, key):
        if not isinstance(parent, dict):
            return None
        val = parent.get(key)
        if val is not None and not isinstance(val, dict):
            raise ValueError(f"{posixpath.basename(path)}: {key} is not a JSON object")
        return val

    if not isinstance(pro, dict):
        raise ValueError(f"{posixpath.basename(path)}: project settings are not JSON objects")
    net_settings = section(pro, "net_settings")
    board = section(pro, "board")
    design_settings = section(board, "design_settings")
    erc = section(pro, "erc")
    rule_severities = section(erc, "rule_severities")

    keep = {"net_settings": net_settings, "board": design_settings, "erc": rule_severities}
    return {"meta:pro": {"kind": "design rules", "ref": posixpath.basename(path), "where": None,
                         "props": {k: v for k, v in flatten(keep).items() if v != "None"}}}


MM_RULE_KEYS = {"min_clearance", "min_track_width", "min_via_diameter", "min_through_hole_diameter",
                "min_microvia_diameter", "min_microvia_drill", "min_hole_clearance", "min_hole_to_hole",
                "min_copper_edge_clearance", "clearance", "track_width", "via_diameter", "via_drill",
                "microvia_diameter", "microvia_drill", "diff_pair_width", "diff_pair_gap", "diff_pair_via_gap",
                "min_via_annular_width", "min_connection", "min_groove_width", "min_silk_clearance",
                "min_text_height", "min_text_thickness", "solder_mask_to_copper_clearance"}


def rule_values(root: str, name: str) -> dict[str, object]:
    """Read rule sources without flatten's stringification; absent revisions are empty.

    Malformed project JSON returns an explicit _unavailable marker; independent
    custom rules and board stackup remain readable.
    """
    out = {}

    def walk(value, key):
        if isinstance(value, dict):
            for k, v in sorted(value.items()):
                walk(v, f"{key}.{k}")
        elif isinstance(value, list) and value and all(isinstance(v, dict) and "name" in v for v in value):
            for v in sorted(value, key=lambda v: v["name"]):
                walk(v, f"{key}.{v['name']}")
        else:
            out[key] = value

    pro = pathlib.Path(root) / (name + ".kicad_pro")
    if pro.exists():
        try:
            data = json.loads(pro.read_text(encoding="utf-8"))
            # Valid JSON of the wrong shape is as unknown as invalid JSON; null sections are simply empty.
            def section(parent, key):
                value = parent.get(key)
                if value is not None and not isinstance(value, dict):
                    raise ValueError(f"{key} is not an object")
                return value or {}

            if not isinstance(data, dict):
                raise ValueError("project is not an object")
            net_settings = section(data, "net_settings")
            design_settings = section(section(data, "board"), "design_settings")
        except ValueError:
            out["_unavailable"] = f"Project rules unavailable: malformed {pro.name}"
        else:
            walk(design_settings.get("rules") or {}, "rules")
            if "classes" in net_settings:
                walk(net_settings["classes"], "net_settings.classes")
            # Pattern order is meaningful, unlike named class order. Keep assignments intact.
            if "netclass_patterns" in net_settings:
                out["net_settings.netclass_patterns"] = net_settings["netclass_patterns"]
    dru = pathlib.Path(root) / (name + ".kicad_dru")
    if dru.exists():
        out["custom rules"] = dru.read_text(encoding="utf-8").replace("\r\n", "\n")
    pcb = pathlib.Path(root) / (name + ".kicad_pcb")
    if pcb.exists():
        setup = find(parse_sexpr(pcb.read_text(encoding="utf-8")), "setup") or []
        stack = find(setup, "stackup")
        if stack:
            out["stackup"] = stack
    return out


def diff_rules(base_root, head_root, name, b=None, h=None) -> list[dict]:
    """Describe dimensional constraints, ordered assignments, custom text and stackup."""
    b = dict(rule_values(base_root, name) if b is None else b)
    h = dict(rule_values(head_root, name) if h is None else h)
    rows = []
    unavailable = {"before": b.pop("_unavailable", None), "after": h.pop("_unavailable", None)}
    if any(unavailable.values()):
        row = electrical_row("rules-unavailable", "Project rules unavailable", channel="rules",
                             detail={"kind": "unavailable", **unavailable})
        row["document"] = "board"
        rows.append(row)
        # Unknown project rules must not become fabricated additions or removals.
        for values in (b, h):
            for key in list(values):
                if key.startswith(("rules.", "net_settings.")):
                    del values[key]
    for key in sorted(b.keys() | h.keys()):
        before, after = b.get(key), h.get(key)
        if before == after:
            continue
        dimensional = key.rsplit(".", 1)[-1] in MM_RULE_KEYS
        numeric = dimensional and all(v is None or type(v) in (int, float) for v in (before, after))
        detail = {"kind": "number", "unit": "mm", "before": before, "after": after} if numeric else {
            "kind": "text", "before": before, "after": after}
        stackup = key == "stackup"
        row = electrical_row("stackup" if stackup else "rule", key,
                             channel="visual" if stackup else "rules",
                             weight="light" if stackup else "heavy", detail=detail)
        row["document"] = "board"
        rows.append(row)
    return rows


def project_objects(proj_dir, name, issues=None):
    if not os.path.isdir(proj_dir):
        return {}
    objs = sch_objects(proj_dir, name)
    pcb = posixpath.join(proj_dir, f"{name}.kicad_pcb")
    if os.path.exists(pcb):
        objs.update(pcb_objects(pcb))
    for key, suffix, load in (
        ("meta:pro", ".kicad_pro", pro_objects),
        ("meta:dru", ".kicad_dru", lambda path: {"meta:dru": {
            "kind": "design rules", "ref": name + ".kicad_dru", "where": None,
            "props": {"custom rules": hashlib.sha1(pathlib.Path(path).read_bytes()).hexdigest()[:10]}}}),
    ):
        path = posixpath.join(proj_dir, name + suffix)
        if not os.path.exists(path):
            continue
        try:
            objs.update(load(path))
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            if issues is not None:
                issues.append({"channel": "rules", "reason": f"Unreadable {suffix} evidence", "unknownMeta": key})
            print(f"{path}: optional rules unavailable: {exc}", file=sys.stderr)
    return objs


def project_pair(p):
    issues = []
    objs = {side: project_objects(posixpath.join(side, p["dir"]), p["name"], issues) for side in ("base", "head")}
    for key in {i["unknownMeta"] for i in issues if "unknownMeta" in i}:
        for side in objs:
            objs[side].pop(key, None)
    return objs, issues


def object_pairs(base, head):
    """UUID pairs first; unmatched objects pair by their match key (reference for footprints and symbols)."""
    pairs = [(k, k) for k in base if k in head]
    b_left = {k: o for k, o in base.items() if k not in head}
    h_left = {k: o for k, o in head.items() if k not in base}
    by_match = {o["match"]: k for k, o in h_left.items() if o.get("match")}
    for k, o in list(b_left.items()):
        hk = by_match.get(o.get("match"))
        if hk in h_left:
            pairs.append((k, hk))
            del b_left[k], h_left[hk]
    return pairs, b_left, h_left


def diff_objects(base, head):
    """Rows of added / removed / modified objects. UUID first; unmatched symbols and footprints by reference."""
    pairs, b_left, h_left = object_pairs(base, head)
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
                users.add(base_ref(o["ref"]))
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
    "checks": {"erc": "required", "drc": "required", "parity": "required", "bom": "informational", "release": "off", "interfaces": "off", "fab_limits": "informational"},
    "interfaces": {},  # pattern overrides for the interfaces check
    "fail_on": "new",  # "new": only errors this change introduced fail a required check; "all": any error does
    "bom": {"required_fields": ["Value", "Footprint"], "critical_prefixes": ["U", "J", "Q", "D", "Y", "X", "K", "F"],
            "order_ready_fields": []},  # empty: the fabrication preset's fields
    "fabrication": {"preset": "jlcpcb", "part_field": None, "check_limits": False},  # part_field defaults to the preset's (LCSC / MPN)
    "3d": {"enabled": False},
    "parts": {"enabled": False},
    "release": {"review": False},
    "digikey": {"enabled": False, "site": "US", "currency": "USD", "max_lookups": 100},
    "pdf": {"enabled": False},
    "downloads": {"enabled": False, "step": True},  # head-revision files for the report's Download dialog

    "threads": {"enabled": False, "block_merge": False},
    "issues": {"enabled": False},
    "github": {"check_runs": False},
    "waivers": {"enabled": False},
    "inventory": {"enabled": False},
    "libraries": {"enabled": False},
}
CHECK_NAMES = {"erc": "ERC", "drc": "DRC", "parity": "Schematic/board parity", "bom": "BOM fields", "interfaces": "Interfaces", "release": "Release package", "fab_limits": "Fab limits"}


def fab_profiles():
    return json.loads(FAB_TABLE.read_text(encoding="utf-8"))


def fab_context(pcb):
    tree = parse_sexpr(pcb.read_text(encoding="utf-8"))
    layers = [x[1] for x in (find(tree, "layers") or [])[1:]
              if len(x) > 2 and x[1].endswith(".Cu")]
    n = len(layers)
    coverage_warnings = []
    stack = find(find(tree, "setup") or [], "stackup") or []
    thickness = {x[1]: find(x, "thickness") for x in findall(stack, "layer") if x[1] in layers}
    for layer in layers:
        t = thickness.get(layer)
        if not t:
            coverage_warnings.append(f"{layer}: copper thickness unknown; limits assume 0.035 mm (1 oz)")
        elif abs(float(t[1]) - .035) > .000001:
            coverage_warnings.append(f"{layer}: copper thickness {t[1]} mm; limits assume 0.035 mm (1 oz)")
    sections = []
    for vendor, key in (("jlcpcb", "jlcpcb-2l" if n == 2 else "jlcpcb-multilayer"), ("pcbway", "pcbway-std")):
        profile = fab_profiles()[key]
        sections.append({"vendor": vendor, "profile": key, "layers": n, "checkedOn": profile["checkedOn"],
            "assumedCopperOz": 1, "unsupported": None if n in profile["layers"] else
            f"not checked: profile covers {', '.join(map(str, profile['layers']))} layers; board has {n}",
            "coverageWarnings": list(coverage_warnings), "unchecked": [], "values": profile["values"]})
    return sections


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
    for section in ("checks", "bom", "fabrication", "3d", "parts", "release", "digikey", "threads", "issues", "github", "waivers", "inventory", "libraries", "interfaces", "pdf", "downloads"):
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
    if type(settings["fabrication"]["check_limits"]) is not bool:
        sys.exit(f"{SETTINGS_FILE}: fabrication.check_limits must be true or false")
    if settings["fabrication"]["check_limits"] and settings["checks"]["fab_limits"] != "off" and settings["checks"]["drc"] == "off":
        sys.exit(f'{SETTINGS_FILE}: fabrication.check_limits requires checks.drc != "off"')
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
    for key in ("enabled", "step"):
        if not isinstance(settings["downloads"][key], bool):
            sys.exit(f"{SETTINGS_FILE}: downloads.{key} must be true or false")

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
        with tempfile.TemporaryDirectory() as work:
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


# ---- Downloads: head-revision files for the report's Download dialog (downloads.enabled). ----

DOWNLOAD_STEP_TIMEOUT = 120  # seconds; a slower STEP export is skipped and the reason recorded
DOWNLOAD_LABELS = {"fab": "For fabrication", "pdf": "Schematic PDF", "step": "3D model (STEP)", "glb": "3D model (GLB)"}


def safe_name(text):
    """File-name-safe label: the Worker route and the gh command only ever see [A-Za-z0-9_.-]."""
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip("-.") or "project"


def export_one(kind, args, dest, timeout=None):
    """Run one kicad-cli export; record failed, slow or empty exports instead of raising."""
    entry = {"kind": kind, "label": DOWNLOAD_LABELS[kind], "file": None, "error": None}
    try:
        if os.path.lexists(dest):
            os.remove(dest)
        r = subprocess.run(["kicad-cli", *args], capture_output=True, text=True, timeout=timeout)
        if r.returncode:
            entry["error"] = f"kicad-cli exited {r.returncode}"
        elif not os.path.isfile(dest) or os.path.getsize(dest) == 0:
            entry["error"] = "kicad-cli wrote no file"  # KiCad can exit 0 after printing an error (pcb export odb does)
    except subprocess.TimeoutExpired:
        entry["error"] = f"skipped: export took longer than {timeout} s"
    except OSError as e:
        entry["error"] = f"kicad-cli unavailable: {e}"
    if entry["error"]:
        try:
            if os.path.lexists(dest):
                os.remove(dest)
        except OSError as e:
            entry["error"] += f"; cannot remove output: {e}"
    else:
        entry["file"] = os.path.basename(dest)
    return entry


def fab_parts(pro, name, settings, fab_dir):
    """Require outputs for the source types actually present; never equate rc=0 with completeness."""
    stem = f"{fab_dir}/{name}-review-{settings['fabrication']['preset']}"
    pcb, sch = pro[:-len(".kicad_pro")] + ".kicad_pcb", pro[:-len(".kicad_pro")] + ".kicad_sch"
    parts = []
    def csv_ok(path, header):
        with open(path, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        # ponytail: header-only CSV is valid for a board with no placed parts; assembly readiness remains checks.release's job.
        if not rows or rows[0] != header or any(len(row) != len(header) for row in rows[1:]):
            raise ValueError("malformed fabrication CSV")
    if os.path.isfile(pcb):
        archive, pos = stem + "-gerbers.zip", stem + "-positions.csv"
        with zipfile.ZipFile(archive) as z:
            infos = z.infolist()
            if not infos or any(i.file_size == 0 or i.is_dir() for i in infos) or z.testzip():
                raise ValueError("empty or damaged Gerber archive")
            names = [i.filename.lower() for i in infos]
            if not any(n.endswith(".drl") for n in names):
                raise ValueError("missing drill output")
            # KiCad --no-x2 uses Protel extensions; also accept .gbr naming.
            for layer in (l for l in board_layers(pcb) if l.endswith(".Cu")):
                ext = {"F.Cu": ".gtl", "B.Cu": ".gbl"}.get(layer)
                if layer.startswith("In"):
                    ext = ".g" + layer[2:-3]
                if not any(n.endswith("-" + layer.replace(".", "_").lower() + ".gbr") or (ext and n.endswith(ext)) for n in names):
                    raise ValueError("missing copper Gerber: " + layer)
        csv_ok(pos, list(POS_COLUMNS.values()))
        parts += [archive, pos]
    if os.path.isfile(sch):
        bom = stem + "-bom.csv"
        csv_ok(bom, [label for _, label in PRESETS[settings["fabrication"]["preset"]]["bom"]])
        parts.append(bom)
    if not parts or any(not os.path.isfile(f) or not os.path.getsize(f) for f in parts):
        raise ValueError("missing fabrication output")
    return parts


CPL_TABLE = pathlib.Path(__file__).with_name("cpl_rotations") / "jlcpcb_cpl_rotations.csv"
CPL_TABLE_SHA256 = "fce26b890863fa56c6fc8d91a44241d9f3b420c78da28a10bc13204903542698"
CPL_OVERRIDE_HEADER = ["Designator", "Rotation", "Offset X", "Offset Y"]


def load_cpl_table(path=CPL_TABLE):
    """Rows of matthewlai/JLCKicadTools cpl_rotations_db.csv in file order: (compiled pattern, degrees, dx, dy)."""
    data = pathlib.Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != CPL_TABLE_SHA256:
        raise SystemExit(f"{path}: not the pinned CPL rotation table")
    rows = list(csv.reader(data.decode("utf-8").splitlines(), skipinitialspace=True))
    # The pinned source has whitespace before the final quoted header cell.
    if not rows or rows[0] != ["Footprint pattern", "Rotation", "Offset X", "Offset Y"]:
        raise SystemExit(f"{path}: unexpected CPL rotation table header")
    table = []
    for row in rows[1:]:
        dx = float(row[2]) if len(row) > 2 else 0.0
        dy = float(row[3]) if len(row) > 3 else 0.0
        table.append((re.compile(row[0]), int(row[1]), dx, dy))
    return table


def cpl_rule(table, package):
    """Last matching row wins, as in JLCKicadTools' FixRotations. re.match anchors only the start of the Package column."""
    hit = None
    for pattern, degrees, dx, dy in table:
        if pattern.match(package):
            hit = (degrees, dx, dy)
    return hit


def jlc_position(side, rotation, x, y, rule):
    """One CPL row with the arithmetic of cpl_fix_rotations.py FixRotations (JLCKicadTools cdd504e, lines 121-173).
    ponytail: the bottom-side mirror is the July 2022 rule the pinned code documents; unverified against JLCPCB's current behaviour (see cpl_rotations/SOURCE.md)."""
    bottom = side == "Bottom"
    if bottom and x < 0:
        x = -x
    if rule is not None:
        degrees, dx, dy = rule
        degrees %= 360  # Reduce integer overrides before float arithmetic, even beyond float range.
        rotation = (rotation - degrees) % 360 if bottom else (rotation + degrees) % 360
        x, y = x + dx, y + dy
    if bottom:
        rotation = (-rotation + 180) % 360
    return rotation, x, y


def load_cpl_overrides(path):
    """Per-part overrides from <project folder>/<name>.cpl-overrides.csv. A listed Designator replaces its table rule."""
    if not os.path.exists(path):
        return {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f, strict=True))
    if not rows or rows[0] != CPL_OVERRIDE_HEADER:
        raise ValueError("CPL overrides header must be Designator,Rotation,Offset X,Offset Y")
    overrides = {}
    for row in rows[1:]:
        if len(row) != 4 or not row[0]:
            raise ValueError("malformed CPL override row")
        if row[0] in overrides:
            raise ValueError("duplicate CPL override for " + row[0])
        dx, dy = float(row[2]), float(row[3])
        if not (math.isfinite(dx) and math.isfinite(dy)):
            raise ValueError("CPL override offset is not finite")
        overrides[row[0]] = (int(row[1]), dx, dy)
    return overrides


def correct_positions(src, dest, table, overrides):
    """Write the JLCPCB CPL with corrected rotation and offsets. Returns how many rows matched an override or a table rule."""
    with open(src, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    col = {name: rows[0].index(name) for name in ("Designator", "Package", "Mid X", "Mid Y", "Rotation", "Layer")}
    matched = 0
    with open(dest, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(rows[0])
        for row in rows[1:]:
            side = row[col["Layer"]]
            if side not in ("Top", "Bottom"):
                raise ValueError("unexpected CPL side: " + side)
            rule = overrides.get(row[col["Designator"]]) or cpl_rule(table, row[col["Package"]])
            if rule is not None:
                matched += 1
            rot, x, y = jlc_position(side, float(row[col["Rotation"]]), float(row[col["Mid X"]]), float(row[col["Mid Y"]]), rule)
            row[col["Rotation"]], row[col["Mid X"]], row[col["Mid Y"]] = f"{rot:.6f}", f"{x:.6f}", f"{y:.6f}"
            w.writerow(row)
    return matched


def cpl_for_download(pro, name, settings, raw, dest):
    """Corrected CPL for the download zip only. Release evidence and checks.release keep KiCad's raw export."""
    overrides_path = os.path.join(os.path.dirname(pro), f"{name}.cpl-overrides.csv")
    if settings["fabrication"]["preset"] != "jlcpcb":
        if os.path.exists(overrides_path):
            raise ValueError("CPL rotation overrides apply to the jlcpcb preset only")
        shutil.copyfile(raw, dest)  # no PCBWay rotation source is pinned, so PCBWay positions stay KiCad's
        return dest
    matched = correct_positions(raw, dest, load_cpl_table(), load_cpl_overrides(overrides_path))
    print("::notice::" + workflow_command_escape(f"{name}: JLCPCB CPL rotation rules matched {matched} rows (JLCKicadTools table, pinned)"))
    return dest


def fab_entry(pro, name, settings, fab_dir, dest):
    """Read raw release evidence; correct only the download zip's disposable CPL copy."""
    entry = {"kind": "fab", "label": DOWNLOAD_LABELS["fab"], "file": None, "error": None}
    expected = (SystemExit, OSError, ValueError, ArithmeticError, IndexError, KeyError, csv.Error, zipfile.BadZipFile)
    try:
        if os.path.lexists(dest):
            os.remove(dest)
        with tempfile.TemporaryDirectory(prefix=".fab-", dir=os.path.dirname(dest) or ".") as staging:
            try:
                parts = fab_parts(pro, name, settings, fab_dir)
            except expected:
                release_project(pro, "review", settings, staging, name)
                parts = fab_parts(pro, name, settings, staging)
            with zipfile.ZipFile(dest, "w") as z:
                for part in parts:
                    base = os.path.basename(part)
                    if base.endswith("-positions.csv"):
                        part = cpl_for_download(pro, name, settings, part, os.path.join(staging, "cpl-" + base))
                    z.write(part, base)
            fab_notices(name, settings, parts)
        entry["file"] = os.path.basename(dest)
    except expected:
        print("::warning::" + workflow_command_escape(f"{name}: fabrication export failed (incomplete outputs, invalid CSV/archive or CPL overrides)"))
        entry["error"] = "fabrication export failed"
        try:
            if os.path.lexists(dest):
                os.remove(dest)
        except OSError:
            pass
    return entry


def glb_entry(raw, dest):
    """Copy 02's raw head export; a missing or empty raw file is an error, never a second GLB export here."""
    entry = {"kind": "glb", "label": DOWNLOAD_LABELS["glb"], "file": None, "error": None}
    try:
        if os.path.lexists(dest):
            os.remove(dest)
        if os.path.isfile(raw) and os.path.getsize(raw) > 0:
            shutil.copyfile(raw, dest)
            entry["file"] = os.path.basename(dest)
        else:
            print("::warning::" + workflow_command_escape("3D model (GLB): board.raw.glb was not produced"))
            entry["error"] = "GLB export missing"
    except OSError as e:
        print("::warning::" + workflow_command_escape(f"3D model (GLB): {e}"))
        entry["error"] = f"GLB export unavailable: {e}"
        try:
            if os.path.lexists(dest):
                os.remove(dest)
        except OSError:
            pass
    return entry


def download_policy_key(policy):
    """Only byte-affecting export policy; enabled gates collection, not fabrication identity."""
    value = {"fabrication": policy["fabrication"], "step": policy.get("downloads", {}).get("step", True)}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def download_directory(out, purpose):
    if purpose not in ("comparison", "snapshot"):
        raise ValueError("invalid download purpose")
    return f"{out}/" + ("downloads-snapshot" if purpose == "snapshot" else "downloads")


def write_download_manifest(dl, entries, *, policy=None, purpose="comparison"):
    """Additive policy-bound files envelope; never confuse comparison and trusted snapshot exports."""
    if purpose == "snapshot" and policy is None:
        raise ValueError("snapshot downloads need the trusted snapshot policy")
    policy = DEFAULT_SETTINGS if policy is None else policy
    if purpose not in ("comparison", "snapshot"):
        raise ValueError("invalid download purpose")
    files = []
    for e in entries:
        item = {"kind": e["kind"], "label": e["label"]}
        if e["error"]:
            item["error"] = e["error"]
        else:
            path = pathlib.Path(dl, e["file"])
            with path.open("rb") as f:
                sha = hashlib.file_digest(f, "sha256").hexdigest()
            item.update(path=e["file"], bytes=path.stat().st_size, sha256=sha)
        files.append(item)
    pathlib.Path(dl, "downloads.json").write_text(json.dumps({"files": files, "purpose": purpose, "policy": download_policy_key(policy)}), encoding="utf-8")
    return files


def export_downloads(p, src, out, settings, head, *, policy=None, purpose="comparison"):
    """Best-effort exports under an explicit trusted/comparison policy and separate manifest."""
    if purpose == "snapshot" and policy is None:
        raise ValueError("snapshot downloads need the trusted snapshot policy")
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("head must be the full 40-character SHA")
    settings = settings if policy is None else policy
    name, dl = p["name"], download_directory(out, purpose)
    pcb, sch = f"{src}/{name}.kicad_pcb", f"{src}/{name}.kicad_sch"
    if purpose == "snapshot" and os.path.exists(pcb):
        # Task 9A gate: the raw exporter must record its verified source revision.
        # Never relabel comparison-head bytes as a different snapshot revision.
        marker = pathlib.Path(out, "board.raw.glb.revision")
        try:
            revision = marker.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            revision = None
        if revision != head:
            raise ValueError("snapshot GLB revision must match the requested full SHA (Task 9A gate)")
    shutil.rmtree(dl, ignore_errors=True)
    os.makedirs(dl, exist_ok=True)
    stem = f"{safe_name(name)}-{head[:7]}"
    entries = []
    if os.path.exists(pcb):
        fab_dir = f"{out}/" + ("fab-snapshot" if purpose == "snapshot" else "fab")
        entries.append(fab_entry(f"{src}/{name}.kicad_pro", name, settings, fab_dir, f"{dl}/fab-{stem}.zip"))
    if settings["downloads"]["enabled"] and os.path.exists(sch):
        dest = f"{dl}/{stem}-schematic.pdf"
        entries.append(export_one("pdf", ["sch", "export", "pdf", "-o", dest, sch], dest))
    if settings["downloads"]["enabled"] and os.path.exists(pcb):
        if settings["downloads"]["step"]:
            dest = f"{dl}/{stem}-board.step"
            entries.append(export_one("step", ["pcb", "export", "step", "--subst-models", "-f", "-o", dest, pcb], dest, DOWNLOAD_STEP_TIMEOUT))
        dest = f"{dl}/{stem}-board.glb"  # 02's uncompressed raw export, copied unchanged; never the Meshopt-compressed viewer GLB
        entries.append(glb_entry(f"{out}/board.raw.glb", dest))
    for e in entries:
        if e["error"] and e["kind"] != "fab":
            print("::warning::" + workflow_command_escape(f"{name}: {e['label']}: {e['error']}"))
    write_download_manifest(dl, entries, policy=settings, purpose=purpose)
    return entries


# Pinned KiBot v1.9.1 JLCPCB.kibot.yaml position columns (lines 94-106).
KIBOT_POSITION_HEADER = ["Designator", "Val", "Package", "Mid X", "Mid Y", "Rotation", "Layer"]
# Protel extensions (KiCad --no-x2) for the layers both templates plot (JLCPCB lines 161-167, PCBWay lines 87-93).
KIBOT_LAYER_SUFFIXES = {"F.Cu": ".gtl", "B.Cu": ".gbl", "F.SilkS": ".gto", "B.SilkS": ".gbo",
                        "F.Mask": ".gts", "B.Mask": ".gbs", "Edge.Cuts": ".gko"}


def kibot_differences(preset, gerber_names, bom_rows):
    """Only the differences Task 3A checks. Everything else is recorded in kibot_templates/v1.9.1/SOURCE.md."""
    lower = [n.lower() for n in gerber_names]
    diffs = [f"missing {layer} ({suffix})" for layer, suffix in KIBOT_LAYER_SUFFIXES.items()
             if not any(n.endswith(suffix) for n in lower)]
    if preset == "jlcpcb":
        if any(n.endswith((".gtp", ".gbp")) for n in lower):
            diffs.append("stencil layers exported; JLCPCB template excludes them (lines 147-148)")
        if bom_rows and "LCSC Part #" in bom_rows[0]:
            lcsc = bom_rows[0].index("LCSC Part #")
            if any(len(row) <= lcsc or not row[lcsc].strip() for row in bom_rows[1:]):
                diffs.append("BOM rows without LCSC number; JLCPCB template filters them (line 115)")
    return diffs


def fab_notices(name, settings, parts):
    """Print checked template differences as notices. They never fail the fabrication entry."""
    preset = settings["fabrication"]["preset"]
    archive = next((p for p in parts if p.endswith("-gerbers.zip")), None)
    if archive is None:  # a schematic-only project has no Gerbers to compare
        return
    bom = next((p for p in parts if p.endswith("-bom.csv")), None)
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
    rows = None
    if bom:
        with open(bom, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
    for diff in kibot_differences(preset, names, rows):
        print("::notice::" + workflow_command_escape(f"{name}: {preset} fabrication differs from KiBot v1.9.1 template: {diff}"))


def collect_downloads(p, index, head, *, policy=None, purpose="comparison", report=None):
    """The project's manifest, with its files copied into the purpose's staging folder for that run's downloads artifact."""
    if purpose not in ("comparison", "snapshot"):
        raise ValueError("invalid download purpose")
    if purpose == "snapshot" and policy is None:
        raise ValueError("snapshot downloads need the trusted snapshot policy")
    if report not in (None, "design") or (report == "design") != (purpose == "snapshot"):
        raise ValueError("report kind must match purpose: None with comparison, 'design' with snapshot")
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("head must be the full 40-character SHA")
    snapshot = report == "design"
    src = f"review/{project_id(p['dir'])}/head/" + ("downloads-snapshot" if snapshot else "downloads")
    staging = "review/design-downloads" if snapshot else "review/downloads"
    bundle = f"kicad-{'design' if snapshot else 'review'}-downloads-{head[:7]}"
    try:
        envelope = json.loads(pathlib.Path(f"{src}/downloads.json").read_text(encoding="utf-8"))
        entries = envelope["files"]
        if not isinstance(entries, list):
            return None
    except (OSError, KeyError, ValueError, TypeError):
        return None
    if snapshot and envelope.get("policy") != download_policy_key(policy):
        return None  # a comparison-policy package never reaches a trusted snapshot
    out = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        kind = e.get("kind")
        label = e.get("label")
        if not isinstance(kind, str) or not kind.strip():
            continue
        if not isinstance(label, str) or not label.strip():
            continue
        item = {"kind": kind, "label": label}
        epath = e.get("path")
        path = f"{src}/{epath}" if isinstance(epath, str) and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}", epath) else ""
        if path and os.path.isfile(path) and os.path.getsize(path) > 0:
            os.makedirs(f"{staging}/{index}", exist_ok=True)
            shutil.copyfile(path, f"{staging}/{index}/{epath}")
            with open(path, "rb") as fh:
                sha = hashlib.file_digest(fh, "sha256").hexdigest()
            item.update(bytes=os.path.getsize(path), sha256=sha, path=f"{index}/{epath}", artifact=bundle)
        else:
            err = e.get("error")
            item["error"] = str(err) if err is not None and str(err).strip() else "not exported"
        out.append(item)
    if out:
        os.makedirs(f"{staging}/{index}", exist_ok=True)
        pathlib.Path(f"{staging}/{index}/downloads.json").write_text(json.dumps({"files": out, "head": head}), encoding="utf-8")
    return out


FAB_START = "# kicad-review fab limits - start"
FAB_END = "# kicad-review fab limits - end"


def fab_owned_rules(text, section):
    """Replace only our disposable rule section, preserving authored bytes."""
    starts, ends = text.count(FAB_START), text.count(FAB_END)
    if starts != ends or starts > 1:
        raise ValueError("malformed fabrication rule markers")
    owned = FAB_START + "\n" + section + "\n" + FAB_END
    if starts:
        a, end_start = text.index(FAB_START), text.index(FAB_END)
        if end_start < a:
            raise ValueError("reversed fabrication rule markers")
        return text[:a] + owned + text[end_start + len(FAB_END):]
    return text + ("" if text.endswith("\n") else "\n") + owned + "\n"


def fab_identity(v):
    """Raw DRC identity, independent of rule-limit prose when UUIDs suffice."""
    items = v.get("items", [])
    # UUID identity where complete; description fallback can go stale after movement.
    complete = bool(items) and all(i.get("uuid") for i in items)
    identity = tuple(sorted(i["uuid"] for i in items)) if complete else tuple(sorted(
        json.dumps({"uuid": i.get("uuid"), "description": i.get("description", ""),
                    "pos": i.get("pos")}, sort_keys=True) for i in items))
    if not items:
        identity = (v.get("description", ""),)
    return (v["type"], "uuid" if complete else "fallback", identity)


def fab_subtract(after, before):
    """Subtract one matching occurrence at a time, retaining raw rows in order."""
    counts = Counter(fab_identity(v) for v in before)
    out = []
    for v in after:
        key = fab_identity(v)
        if counts[key]:
            counts[key] -= 1
        else:
            out.append(v)
    return out


def fab_rule_section(context):
    """Generate fixed vendor geometry bounds and an explicit unchecked ledger."""
    values, n = context["values"], context["layers"]
    rules, unchecked = [], []
    plated = "A.Type == 'Via' || (A.Type == 'Pad' && A.Pad_Type != 'NPTH, mechanical')"
    npth = "A.Type == 'Pad' && A.Pad_Type == 'NPTH, mechanical'"
    # Fixed vendor geometry only; no generated net-class conditions or escaping surface.
    mapping = [
        ("trackWidthOuterMm", "track_width", "outer", "", "min"),
        ("trackWidthInnerMm", "track_width", "inner", "", "min"),
        ("clearanceOuterMm", "clearance", "outer", "", "min"),
        ("clearanceInnerMm", "clearance", "inner", "", "min"),
        ("drillPlatedMinMm", "hole_size", "", plated, "min"),
        ("drillPlatedMaxMm", "hole_size", "", plated, "max"),
        ("drillNpthMinMm", "hole_size", "", npth, "min"),
        ("annularMinMm", "annular_width", "", plated, "min"),
        ("edgeClearanceMm", "edge_clearance", "", "", "min"),
        ("holeToHoleMm", "hole_to_hole", "", "A.Type == 'Pad' && B.Type == 'Pad'", "min"),
        ("holeToHoleViaMm", "hole_to_hole", "", "A.Type == 'Via' && B.Type == 'Via'", "min"),
        ("viaDiameterMinMm", "via_diameter", "", "A.Type == 'Via'", "min")]
    grouped = {}
    for key, constraint, layer, condition, bound in mapping:
        if layer == "inner" and n <= 2:
            continue
        if key not in values:
            unchecked.append(key)
            continue
        grouped.setdefault((constraint, layer, condition), []).append((bound, values[key]))
    for (constraint, layer, condition), bounds in grouped.items():
        suffix = f' (layer {layer})' if layer else ''
        suffix += f' (condition {json.dumps(condition)})' if condition else ''
        limits = ' '.join(f'({bound} {value:g}mm)' for bound, value in bounds)
        rules.append(f'(rule "fab {constraint} {layer}"{suffix} (constraint {constraint} {limits}))')
    return "\n".join(rules), unchecked + ["holeToHoleMixedMm"]


def fab_vendor_rules(context):
    """Neutralize house bounds only in the disposable vendor attribution pass."""
    rules, _ = fab_rule_section(context)
    categories = {
        'track_width': 'track_width', 'clearance': 'clearance',
        'hole_size': 'drill_out_of_range', 'annular_width': 'annular_width',
        'edge_clearance': 'copper_edge_clearance', 'hole_to_hole': 'hole_to_hole',
        'via_diameter': 'via_diameter'}
    covered = {diagnostic for constraint, diagnostic in categories.items()
               if '(constraint ' + constraint + ' ' in rules}
    # Fixed geometry bounds only; 1 km maximum is not a manufacturer limit.
    neutral = '\n'.join(
        f'(rule "fab neutral {constraint}" (constraint {constraint} (min 0mm)'
        + (' (max 1000000mm)' if constraint in ('track_width', 'hole_size', 'via_diameter') else '') + '))'
        for constraint in categories)
    return neutral + '\n' + rules, covered


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
        if missing and not base_ref(o["ref"]) in {v["ref"] for v in out}:
            out.append({"type": "missing_fields", "severity": "error", "ref": base_ref(o["ref"]),
                        "description": f"{base_ref(o['ref'])} has no {', '.join(missing)}",
                        "items": [], "uuids": [], "pos": o["pos"], "box": None, "where": o["where"],
                        "key": ("bom", base_ref(o["ref"]), tuple(missing))})
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


def base_ref(ref):
    """Strip the parser's symbol-unit suffix from a reference."""
    return (ref or "").split(" unit ")[0]


def bom_parts(objs):
    """BOM symbols, one entry per reference (units of one part count once); DNP, excluded and unannotated parts left out."""
    out = {}
    for o in objs.values():
        p = o["props"]
        if o["kind"] != "symbol" or p.get("in_bom") == "no" or p.get("dnp") == "yes" or o["ref"].endswith("?"):
            continue
        out.setdefault(base_ref(o["ref"]), p)
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
    ref = base_ref(obj.get("ref"))  # units of one part share their base reference
    reason = ("not_symbol" if obj.get("kind") != "symbol" else "dnp" if p.get("dnp") == "yes" else
              "excluded" if p.get("in_bom") == "no" else "unannotated" if ref.endswith("?") else None)
    value, footprint = p.get("Value", ""), p.get("Footprint", "")
    lcsc, mpn = (field(p, LCSC_FIELDS) or "").upper() or None, field(p, MPN_FIELDS)
    ds = field(p, ("datasheet",))
    datasheet = ds if ds and ds.lower().startswith(("http://", "https://")) else None
    manufacturer, category = field(p, MANUFACTURER_FIELDS), bom_category(ref, p.get("symbol"))
    return {"included": reason is None, "excludedReason": reason, "ref": ref, "value": value, "footprint": footprint,
            "lcsc": lcsc, "mpn": mpn, "manufacturer": manufacturer,
            "datasheet": datasheet, "category": category,
            # ensure_ascii=False, compact separators. 10 uses this key as received from 09 and never recomputes it.
            "key": json.dumps([value, footprint, lcsc or "", mpn or "", category, manufacturer, datasheet], ensure_ascii=False, separators=(",", ":"))}


def parts_lines(objs):
    """One line per distinct part on the schematic (Value + Footprint + LCSC + MPN + category + manufacturer + datasheet),
    with what blocks a supplier lookup."""
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
# option A). Ceiling of the JLCPCB file: the planner splits by the bytes-less-CRLF rule, so its configured budget reserves two
# bytes for the CRLF before planning. A split therefore fits the stricter written-record limit instead of refusing an otherwise
# splittable group; a reference that cannot fit still refuses the whole file (fail closed).

BOM_LINE_MAX_BYTES = vendor_bom_csv.BOM_LINE_MAX_BYTES  # 2048, the vendored rule; JLCPCB rejects longer designator cells
# Configure this private, path-loaded planner once; the vendored source and logic stay unchanged.
vendor_bom_csv.BOM_LINE_MAX_BYTES = BOM_LINE_MAX_BYTES - 2
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
        # Repository inputs carry the board separately: strip symbol units before qualifying,
        # never interpret a literal " unit " in a project name as a symbol-unit suffix.
        ref = f"{obj['_bomBoard']}:{identity['ref']}" if "_bomBoard" in obj else identity["ref"]
        if not identity["included"] or ref in by_ref:
            continue  # match parts_lines: the first eligible unit supplies each reference's fields
        number = field(obj["props"], selected)
        if preset == "jlcpcb" and not part_field:
            number = number.upper() if number else None  # same normalization as parts_lines
        by_ref[ref] = number
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
        raise ValueError(f"JLCPCB export unavailable ({BOM_LINE_MAX_BYTES} UTF-8 bytes including CRLF): {plan.warnings[0]}. Shorten Value, Footprint or the ordering field, or use the generic CSV.")
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


def bom_repository(boards, preset, part_field=None):
    """Combined BOM across the repository's projects (Owner decision 2026-10-26). A board line joins another board's line
    only when key, category, manufacturer and datasheet all match. Board-qualified references stay distinct;
    quantities add only inside a joined line."""
    names = [b["name"] for b in boards]
    if len(set(names)) != len(names) or not all(names):
        return {"boards": names, "error": "Combined BOM unavailable: project names must be unique and non-empty.", "summary": bom_summary([]), "lines": [], "exports": None}
    joined, objects = {}, {}
    for b in boards:
        for uid, obj in b["objects"].items():
            objects[(b["name"], uid)] = {**obj, "_bomBoard": b["name"]}
        for line in b["lines"]:
            ident = json.dumps([line["key"], line["category"], line["manufacturer"], line["datasheet"]], ensure_ascii=False, separators=(",", ":"))
            comb = joined.setdefault(ident, {"key": line["key"], "category": line["category"], "value": line["value"], "footprint": line["footprint"],
                                             "lcsc": line["lcsc"], "mpn": line["mpn"], "manufacturer": line["manufacturer"], "datasheet": line["datasheet"],
                                             "refs": [], "boards": {}})
            comb["refs"] += [(b["name"], ref) for ref in line["refs"]]
            comb["boards"][b["name"]] = len(line["refs"])
    lines = []
    for comb in joined.values():
        runs = {}
        for name, ref in comb["refs"]:
            runs.setdefault(name, []).append(ref)
        lines.append({**comb, "refs": [f"{name}:{ref}" for name, ref in comb["refs"]],
                      "refsCompressed": "; ".join(f"{name}:{ref_ranges(refs)}" for name, refs in runs.items())})
    lines = bom_order(lines)
    return {"boards": names, "error": None, "summary": bom_summary(lines), "lines": lines,
            "exports": bom_exports(lines, preset, part_field, objects)}


def compact_bom_lines(data):
    """Copy of the report data with each BOM line's derived `key` and null optional fields left out, for the embedded page only.
    Python keeps both in memory and in review/data.json; the page never reads `key` and treats a missing optional field as null."""
    slim = lambda l: l and {k: v for k, v in l.items() if k != "key" and not (v is None and k in ("lcsc", "mpn", "manufacturer", "datasheet"))}
    out = {**data, "projects": [{**p, "parts": {**p["parts"], "lines": [slim(l) for l in p["parts"]["lines"]],
                                                 "changes": [{**r, "before": slim(r["before"]), "after": slim(r["after"])} for r in p["parts"]["changes"]]}}
                                if p.get("parts") else p for p in data["projects"]]}
    if data.get("bom"):
        out["bom"] = {**data["bom"], "lines": [slim(l) for l in data["bom"]["lines"]]}
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
    sym = {base_ref(o["ref"]): o["props"].get("dnp") == "yes" for o in objs.values() if o["kind"] == "symbol"}
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
WAIVABLE = ("erc", "drc", "parity", "fab_limits")


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
        print("::warning::" + workflow_command_escape(f"{m}"))
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


FAB_EVIDENCE_SOURCE = ('kicad-cli pcb drc; isolated board-only and vendor DRC passes per revision; '
                       'vendor-only findings paired between head and base by multiset identity; '
                       'fab_limits.json dated profile; coverage limited to checked limits '
                       '(see unchecked, unsupported and coverageWarnings)')
FAB_VENDORS = ('jlcpcb', 'pcbway')
FAB_VENDOR_LABELS = {'jlcpcb': 'JLCPCB', 'pcbway': 'PCBWay'}


def fab_read_audit(out_dir, side, p, vendor):
    path = pathlib.Path(out_dir, side, 'fab-limits.json')
    if not path.is_file():
        sys.exit(f'Fab limits output missing for {p["name"]} ({side})')
    sections = [s for s in json.loads(path.read_text(encoding='utf-8'))['sections'] if s['vendor'] == vendor]
    if len(sections) != 1:
        sys.exit(f'Fab limits output for {p["name"]} ({side}) has no single {vendor} section')
    return sections[0]


def fab_check(p, settings, out_dir, waivers, vendor):
    if not fab_enabled(settings):
        return None
    level = settings['checks']['fab_limits']
    # Owner decision 2026-10-26: no default comparison values. not_run has no head audit, so it has no base
    # comparison and carries no baselineAvailable or fixed key. Every other result takes both from the base audit below.
    empty = {'name':'fab_limits','title':'Fab limits','vendor':vendor,'level':level,
             'errors':0,'new_errors':0,'warnings':0,'new_warnings':0,'violations':[],
             'checked':[],'unchecked':[],'coverageWarnings':[],
             'confidence':'deterministic','evidence_source':FAB_EVIDENCE_SOURCE}
    head_board = board_path(p, 'head')
    fab_regular_input(pathlib.Path(head_board))
    if not os.path.isfile(head_board):
        result = {**empty,'status':'not_run','reason':'no head board','unsupported':'no head board'}
        if waivers is not None:
            result['waived'] = 0
        return result
    head_meta = fab_read_audit(out_dir, 'head', p, vendor)
    base_board = board_path(p, 'base')
    fab_regular_input(pathlib.Path(base_board))
    base_meta = fab_read_audit(out_dir, 'base', p, vendor) if os.path.isfile(base_board) else None
    # A base comparison needs both audits to be supported; an unsupported side is never compared.
    baseline = base_meta is not None and not base_meta['unsupported'] and not head_meta['unsupported']
    head_raw = head_meta['violations']
    base_raw = base_meta['violations'] if baseline else []
    new_ids = {id(v) for v in fab_subtract(head_raw, base_raw)} if baseline else {id(v) for v in head_raw}
    head = []
    for raw in head_raw:
        row = {**violation(raw, 1, {'board':True}), 'confidence':'deterministic',
               'evidence_source':FAB_EVIDENCE_SOURCE}
        row['_new'] = id(raw) in new_ids
        head.append(row)
    # run_check supplies waivers and ordering; its set-based new flags are replaced by the multiset pairing.
    result = run_check('fab_limits', settings, head, None, waivers)
    for v in result['violations']:
        v['new'] = v.pop('_new')
    result['violations'].sort(key=lambda v: (not v['new'], v['severity'] != 'error', v['type']))
    live = [v for v in result['violations'] if not v.get('waived')]
    count = lambda sev, new=False: sum(1 for v in live if v['severity'] == sev and (v['new'] or not new))
    failing = count('error', new=settings['fail_on'] == 'new') > 0
    result.update(status='pass' if not failing else 'fail' if level == 'required' else 'warn',
                  errors=count('error'), warnings=count('warning'),
                  new_errors=count('error', True), new_warnings=count('warning', True),
                  fixed=len(fab_subtract(base_raw, head_raw)) if baseline else 0,
                  baselineAvailable=baseline, confidence='deterministic', evidence_source=FAB_EVIDENCE_SOURCE)
    for key in ('vendor','profile','checkedOn','assumedCopperOz','checked','unchecked','unsupported','coverageWarnings'):
        result[key] = head_meta[key]
    if head_meta['unsupported']:
        result.update(status='fail' if level == 'required' else 'warn', reason=head_meta['unsupported'])
    return result


def fab_checks(p, settings, out_dir, waivers=None):
    return [c for c in (fab_check(p, settings, out_dir, waivers, vendor) for vendor in FAB_VENDORS) if c]


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
    out.extend(fab_checks(p, settings, out_dir, waivers))
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


def candidate_identity_valid(candidates):
    """True when symbol candidates have known sheets and distinct unit numbers."""
    if not candidates:
        return False
    objs = [c[1] if isinstance(c, tuple) else c for c in candidates]
    units = [o.get("props", {}).get("unit", "1") for o in objs]
    if len(units) != len(set(units)):
        return False
    return not any((o.get("where") or {}).get("sheet") is None for o in objs)


def net_members(text, objects, commit):
    """Return observed members, candidate anchors and net-scoped wiring issues.

    None marks an unknown net, distinct from an observed empty set. Comparers must
    suppress a net pair if either side is unknown, not treat it as added/removed.
    Multi-unit anchors are candidates: only the pin manifest can select the owning
    unit (or units for shared pins); positions here are symbol, not pin, positions.
    Task 8 resolves candidates against that manifest. Missing sheet identity makes
    membership unknown rather than conflating distinct schematic instances.

    Per spec and plan prose, power symbols ('#' references) are skipped rather than
    fabricated into component pins. Per Open Question 4, missing or unannotated
    references (e.g. 'R?', '') fall back to symbol UUID only when exactly one candidate
    exists; otherwise connectivity identity is ambiguous and comparison is suppressed.
    """
    _, parsed = parse_netlist(text)
    by_ref = {}
    for uid, o in objects.items():
        if o["kind"] == "symbol":
            ref = o["props"].get("reference", o["ref"])
            by_ref.setdefault(ref, []).append((uid, o))
    nets, anchors, issues = {}, {}, []
    for name, nodes in sorted(parsed.items()):
        members, net_anchors, reasons = set(), {}, set()
        unknown = False
        for node in nodes:
            ref, pin = node["ref"] or "", node["pin"] or ""
            if ref.startswith("#"):  # Power symbols and flags (ref starts with '#') are skipped; they are not fabricated as component pins
                continue
            candidates = by_ref.get(ref, [])
            invalid = not ref or "?" in ref
            # A missing or unannotated reference has no UUID in the netlist node, so only a single matching symbol candidate can be disambiguated.
            ambiguous = (not pin
                         or not candidate_identity_valid(candidates)
                         or (invalid and len(candidates) != 1))
            if ambiguous:
                unknown = True
                reasons.add(("Connectivity identity is ambiguous; schematic membership comparison suppressed", True))
                continue
            if invalid:
                reasons.add(("Some connected pins have missing references; using symbol UUID and pin number", False))
            key = f"{candidates[0][0]}:{pin}" if invalid else f"{ref}.{pin}"
            members.add(key)
            net_anchors[key] = [{"uuid":uid.rsplit("/",1)[-1], "ref":ref, "pin":pin,
                                 "unit":o["props"].get("unit", "1"), "sheet":(o.get("where") or {}).get("sheet"),
                                 "pos":o.get("pos"), "commit":commit}
                                for uid, o in candidates]
        nets[name] = None if unknown else members
        if not unknown:
            anchors.update(net_anchors)
        issues.extend({"channel":"wiring", "net":name, "reason":r, "unknown":u} for r, u in sorted(reasons))
    return nets, anchors, issues


def validate_netlist(text):
    """Raise ValueError unless text is exactly one usable netlist export."""
    root = parse_sexpr(text)
    if not isinstance(root, list) or not root or root[0] != "export":
        raise ValueError("not a netlist export")
    if any(not isinstance(field, list) or not field or not isinstance(field[0], str) for field in root[1:]):
        raise ValueError("bad export field")
    sections = findall(root, "nets")
    if len(sections) != 1:
        raise ValueError("missing or duplicate nets section")
    def identity(node, key):
        fields = findall(node, key)
        if len(fields) != 1 or len(fields[0]) != 2 or not isinstance(fields[0][1], str) or not fields[0][1]:
            raise ValueError("invalid netlist " + key)
        return fields[0][1]
    names = set()
    for net in sections[0][1:]:
        if not isinstance(net, list) or not net or net[0] != "net":
            raise ValueError("bad net")
        if any(not isinstance(field, list) or not field for field in net[1:]):
            raise ValueError("bad net field")
        name = identity(net, "name")
        if name in names:
            raise ValueError("duplicate net name")
        names.add(name)
        for node in findall(net, "node"):
            identity(node, "ref"); identity(node, "pin")
    try:  # The legacy projection must also succeed, so every consumer sees the same envelope.
        parse_netlist(text)
    except (TypeError, AttributeError, IndexError, KeyError) as exc:
        raise ValueError(f"malformed netlist projection: {exc}") from exc


def validated_net_members(text, objects, commit):
    validate_netlist(text)
    return net_members(text, objects, commit)


def electrical_row(kind, ref, action="modified", channel="wiring", weight="heavy", detail=None, where=None):
    return {"kind":kind, "ref":ref, "action":action, "channel":channel, "weight":weight,
            "detail":detail or {}, "where":where, "pos":None, "box":None,
            "props":{}, "anchors":{"base":[], "head":[]}, "document":"schematic"}


def diff_nets(base, head):
    """Match equal memberships first, then compare connected overlap components.

    A None from net_members is unknown, not empty: suppress that name on both
    sides. The producer's issues carry the corresponding incompleteness reason.
    Anchors remain empty until the caller attaches the side-specific evidence.
    """
    unknown = {n for side in (base, head) for n, members in side.items() if members is None}
    b = {n:members for n, members in base.items() if n not in unknown}
    h = {n:members for n, members in head.items() if n not in unknown}
    rows = []

    def emit(kind, bs, hs):
        before = set().union(*(base[n] for n in bs))
        after = set().union(*(head[n] for n in hs))
        action = "added" if not bs else "removed" if not hs else "modified"
        transitions = []
        for pin in sorted(before | after):
            old = sorted(n for n in bs if pin in base[n])
            new = sorted(n for n in hs if pin in head[n])
            if old != new:
                transitions.append({"pin":pin, "before":old, "after":new})
        detail = {"kind":"members", "added":sorted(after - before), "removed":sorted(before - after),
                  "beforeNets":sorted(bs), "afterNets":sorted(hs), "transitions":transitions}
        if kind == "net-renamed":
            detail["autoNamed"] = any(n.startswith("Net-(") or n.startswith("unconnected-(") for n in [*bs, *hs])
        rows.append(electrical_row(kind, " + ".join(sorted(hs or bs)), action, detail=detail))

    for bn in sorted(list(b)):
        matches = [hn for hn in sorted(h) if b[bn] and b[bn] == h[hn]]
        if len(matches) == 1:
            hn = matches[0]
            if bn != hn:
                emit("net-renamed", [bn], [hn])
            del b[bn], h[hn]

    edges = {(bn, hn) for bn in b for hn in h if b[bn] & h[hn]}
    linked_b, linked_h = {bn for bn, hn in edges}, {hn for bn, hn in edges}
    # A name cannot pre-empt a member overlap, including a join or split.
    edges |= {(n, n) for n in b.keys() & h.keys() if n not in linked_b and n not in linked_h}
    while b or h:
        bs, hs = ({min(b)}, set()) if b else (set(), {min(h)})
        while True:
            nb = bs | {bn for bn, hn in edges if hn in hs}
            nh = hs | {hn for bn, hn in edges if bn in nb}
            if (nb, nh) == (bs, hs):
                break
            bs, hs = nb, nh
        if not bs:
            emit("net-added", bs, hs)
        elif not hs:
            emit("net-removed", bs, hs)
        elif len(bs) == len(hs) == 1:
            bn, hn = next(iter(bs)), next(iter(hs))
            if bn != hn or b[bn] != h[hn]:
                emit("net-members", bs, hs)
        else:
            if len(bs) > 1:
                emit("net-joined", bs, hs)
            if len(hs) > 1:
                emit("net-split", bs, hs)
        for n in bs:
            b.pop(n)
        for n in hs:
            h.pop(n)
        edges = {(bn, hn) for bn, hn in edges if bn in b and hn in h}
    return rows


def wire_counts(objects):
    """Connected collinear wire runs per sheet; source endpoints rounded once to 0.001 mm."""
    lines = {}
    for o in objects.values():
        if o["kind"] != "wire":
            continue
        raw_pts = o.get("points_mm")
        if raw_pts is None:
            values = [float(x) for x in re.findall(r"[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?", o.get("props", {}).get("points", ""))]
            raw_pts = [values[i:i + 2] for i in range(0, len(values), 2)]
        pts = [tuple(round(round(x, 3) * 1000) for x in p) for p in raw_pts]
        sheet = (o.get("where") or {}).get("sheet", "/")
        for a, b in zip(pts, pts[1:]):
            a, b = sorted((a, b))
            dx, dy = b[0] - a[0], b[1] - a[1]
            divisor = math.gcd(dx, dy)
            if not divisor:
                continue
            dx, dy = dx // divisor, dy // divisor
            # Integer direction and line offset avoid floating-point slope tolerances.
            key = (sheet, dx, dy, dx * a[1] - dy * a[0])
            lines.setdefault(key, []).append((a, b))
    result = Counter()
    for (sheet, *_), segments in lines.items():
        merged = []
        for a, b in sorted(segments):
            if merged and a <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
            else:
                merged.append((a, b))
        for a, b in merged:
            result[(sheet, tuple(x / 1000 for x in a), tuple(x / 1000 for x in b))] = 1
    return result


def diff_wires(base, head):
    b, h = wire_counts(base), wire_counts(head)
    drawn, erased = sum((h - b).values()), sum((b - h).values())
    return [electrical_row("wires", "Wires drawn / erased", weight="medium",
                           detail={"kind": "wires", "drawn": drawn, "erased": erased})] if drawn or erased else []


NUMBER_TOKEN = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def pad_geometry(tokens):
    """Pad geometry key: bare numbers rounded to 0.0001 mm as pcb_objects does, so re-saved spellings match."""
    def norm(x):
        if isinstance(x, list):
            return [norm(y) for y in x]
        if isinstance(x, Quoted) or not NUMBER_TOKEN.fullmatch(x):
            return str(x)
        return round(float(x), 4) + 0.0
    return repr([norm(x) for x in tokens])


def board_pads(path):
    """Physical pads per footprint UUID: UUID, number and local geometry from the PCB, net from the semantic parser."""
    if not pathlib.Path(path).is_file():
        return {}
    root = parse_sexpr(pathlib.Path(path).read_text(encoding="utf-8"))
    objects = pcb_objects_from_root(root)
    result = {}
    for fp in findall(root, "footprint"):
        uid = val(fp, "uuid") or val(fp, "tstamp")
        if uid not in objects:
            continue
        pads = findall(fp, "pad")
        fp_at = at(fp)
        fp_angle = fp_at[2] if fp_at and len(fp_at) > 2 else 0.0
        counts, seen = Counter(p[1] for p in pads), Counter()
        result[uid] = []
        for p in pads:
            number = p[1]
            seen[number] += 1
            suffix = "#" + str(seen[number]) if counts[number] > 1 else ""
            geom = [x for x in p[1:] if not (isinstance(x, list) and x and x[0] in ("net", "uuid", "tstamp", "pinfunction", "pintype"))]
            geom = [(["at", *x[1:3], str(round(((float(x[3]) if len(x) > 3 else 0.0) - fp_angle) % 360, 3) % 360)]
                     if isinstance(x, list) and x and x[0] == "at" else x) for x in geom]
            result[uid].append({"uuid": val(p, "uuid") or val(p, "tstamp"), "number": number,
                                "geom": pad_geometry(geom),
                                "net": objects[uid]["props"].get("pad " + number + suffix + " net") or ""})
    return result


def pad_pairs(base, head, replaced=False):
    """Pair physical pads by UUID, then by unique number plus geometry; repeated numbers never pair by number alone."""
    pairs, b, h = [], list(base), list(head)

    def take(predicate):
        for x in list(b):
            matches = [y for y in h if predicate(x, y)]
            if len(matches) != 1:
                continue
            y = matches[0]
            if sum(predicate(z, y) for z in b) != 1:
                continue
            pairs.append((x, y))
            b.remove(x)
            h.remove(y)

    take(lambda x, y: bool(x["uuid"]) and x["uuid"] == y["uuid"])
    # Duplicate-number pads never pair by number alone once UUIDs are gone; only unique number-plus-geometry evidence does.
    compatible = lambda x, y: not (x["uuid"] and y["uuid"] and x["uuid"] != y["uuid"])
    take(lambda x, y: (compatible(x, y) or replaced) and (x["number"], x["geom"]) == (y["number"], y["geom"]))
    # The replacement fallback pairs a pad by number only when that number is unique on both sides.
    take(lambda x, y: (compatible(x, y) or replaced) and x["number"] == y["number"] and
         sum(p["number"] == x["number"] for p in base) == 1 and
         sum(p["number"] == y["number"] for p in head) == 1)
    return pairs


def diff_board_pins(base, head, base_pads, head_pads, commits):
    """Rows for matched footprints whose physical pad net changed. Added or removed pads are not connectivity claims."""
    rows = []
    for bk, hk in object_pairs(base, head)[0]:
        b, h = base[bk], head[hk]
        if b["kind"] != "footprint" or h["kind"] != "footprint":
            continue
        for bp, hp in pad_pairs(base_pads.get(bk, []), head_pads.get(hk, []), replaced=bk != hk):
            if bp["net"] == hp["net"]:
                continue
            r = electrical_row("board-pad-net", h["ref"] + "." + hp["number"],
                               detail={"kind": "pad-net", "pin": hp["number"], "before": bp["net"],
                                       "after": hp["net"], "boardOnly": True},
                               where={"board": True})
            r.update(document="board", pos=h.get("pos"), box=h.get("box"))
            # Derived row does not own scene changeIds. Keep each revision identity separately.
            # Board anchors carry board=True and omit sheet (PCBs have no sheet; consumed by Task 8.1/8.2).
            for side, uid, o, pad in (("base", bk, b, bp), ("head", hk, h, hp)):
                r["anchors"][side] = [{"uuid": uid, "padUuid": pad["uuid"], "ref": o["ref"],
                                       "pin": pad["number"], "pos": o.get("pos"),
                                       "commit": commits.get(side), "board": True}]
            rows.append(r)
    return rows


def read_copper(path):
    """Strict reader of the optional copper-diff.json; any malformed field makes routing unavailable."""
    unavailable = lambda reason: ([], [{"channel": "routing", "reason": reason}])
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"),
                          parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        if not isinstance(data, dict) or not isinstance(data.get("rows"), list) or not isinstance(data.get("incomplete"), list):
            raise ValueError("bad envelope")
        rows = []
        for x in data["rows"]:
            if not isinstance(x.get("net"), str) or not isinstance(x.get("layer"), str):
                raise ValueError("bad identity")
            for key in ("addedMm2", "removedMm2"):
                # math.isfinite raises OverflowError for integers too large for a float.
                if type(x.get(key)) not in (int, float) or not math.isfinite(x[key]) or x[key] < 0:
                    raise ValueError("bad area")
            for key in ("addedContours", "removedContours"):
                if not isinstance(x.get(key), list):
                    raise ValueError("bad contours")
                for ring in x[key]:
                    if not isinstance(ring, list) or len(ring) < 3:
                        raise ValueError("bad ring")
                    for pt in ring:
                        if not isinstance(pt, list) or len(pt) != 2 or any(type(v) not in (int, float) or not math.isfinite(v) for v in pt):
                            raise ValueError("bad point")
            r = electrical_row("copper", f"{x['net'] or '(unconnected)'} on {x['layer']}", channel="routing", weight="medium",
                               detail={"kind": "area", **{k: x[k] for k in ("layer", "addedMm2", "removedMm2", "addedContours", "removedContours")}},
                               where={"board": True})
            r["document"] = "board"
            pts = [pt for key in ("addedContours", "removedContours") for ring in x[key] for pt in ring]
            r["box"] = [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)] if pts else None
            rows.append(r)
        issues = data["incomplete"]
        if any(not isinstance(i, dict) or i.get("channel") != "routing" or not isinstance(i.get("reason"), str) for i in issues):
            raise ValueError("bad issues")
        return rows, issues
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return unavailable("Copper comparison missing or malformed")


def schematic_pin_ids(text, objects):
    """Pins proven to exist: a uniquely resolved component whose exported libpart enumerates the pin.

    A missing net node alone is never proof of disconnection; without this proof a pin stays unknown.
    """
    def identity(node):
        key = (val(node, "lib"), val(node, "part"))
        return key if all(isinstance(k, str) and k for k in key) else None

    root = parse_sexpr(text)
    libraries = {}
    for part in findall(find(root, "libparts") or [], "libpart"):
        if identity(part):
            libraries[identity(part)] = {
                val(pin, "num") for pin in findall(find(part, "pins") or [], "pin") if val(pin, "num")}
    refs = {}
    for o in objects.values():
        if o["kind"] == "symbol":
            refs.setdefault(o["props"].get("reference", o.get("ref", "")), []).append(o)
    result = set()
    components = findall(find(root, "components") or [], "comp")
    for comp in components:
        ref = val(comp, "ref")
        candidates = refs.get(ref, [])
        if not ref or "?" in ref or not candidate_identity_valid(candidates):
            continue
        if sum(val(c, "ref") == ref for c in components) != 1:
            continue
        result.update(ref + "." + pin for pin in libraries.get(identity(find(comp, "libsource")), set()))
    return result


def electrical_changes(p, out, objs, commits):
    """Net, wire, board-pad, copper and rule rows for one project pair, plus channel incompleteness issues.

    A present schematic with missing, malformed or ambiguous netlist evidence makes the whole
    schematic membership pair unknown: no net rows, and board-pad board-only status unknown.
    """
    roots = {s: posixpath.join(s, p["dir"]) for s in ("base", "head")}
    members, anchors, issues = {}, {}, []
    known_pins = {"base": set(), "head": set()}
    usable = True
    for side, root in roots.items():
        members[side], anchors[side] = {}, {}
        if not pathlib.Path(root, p["name"] + ".kicad_sch").is_file():
            continue  # An absent schematic is an absent side, not unknown evidence.
        try:
            text = read_netlist(pathlib.Path(out) / side)
            members[side], anchors[side], found = validated_net_members(text, objs[side], commits.get(side, ""))
            known_pins[side] = schematic_pin_ids(text, objs[side])
            issues += [{**i, "document": "schematic"} for i in found]
            if any(i.get("unknown") for i in found):
                usable = False
        except (OSError, ValueError, TypeError, IndexError, KeyError, AttributeError) as exc:
            usable = False
            issues.append({"channel": "wiring", "document": "schematic",
                           "reason": f"{side} netlist unavailable: {str(exc)[:500]}"})
    netrows = diff_nets(members["base"], members["head"]) if usable else []
    for r in netrows:
        for side, key in (("base", "beforeNets"), ("head", "afterNets")):
            pins = set().union(*(members[side][n] for n in r["detail"][key]))
            r["anchors"][side] = [a for pin in sorted(pins) for a in anchors[side].get(pin, [])]
        first = next(iter(r["anchors"]["head"] or r["anchors"]["base"]), None)
        r["where"] = {"sheet": first["sheet"]} if first else None
    pcbs = {s: pathlib.Path(root, p["name"] + ".kicad_pcb") for s, root in roots.items()}
    try:
        base_pads = board_pads(pcbs["base"])
        head_pads = board_pads(pcbs["head"])
    except (OSError, ValueError, TypeError, AttributeError, IndexError, KeyError) as exc:
        padrows = []
        issues.append({"channel": "wiring", "document": "board",
                       "reason": f"Board pad evidence missing or malformed: {str(exc)[:500]}"})
    else:
        padrows = diff_board_pins(objs["base"], objs["head"], base_pads, head_pads, commits)

    def pin_net(side, key):
        """Schematic net of a pin: None means unknown; "" means a proven pin with no net assignment."""
        if not usable:
            return None
        found = [name for name, pins in members[side].items() if key in pins]
        if len(found) == 1:
            return found[0]
        if found:
            return None
        return "" if key in known_pins[side] else None

    for r in padrows:
        bp, hp = r["anchors"]["base"][0], r["anchors"]["head"][0]
        before, after = pin_net("base", bp["ref"] + "." + bp["pin"]), pin_net("head", hp["ref"] + "." + hp["pin"])
        r["detail"]["boardOnly"] = (None if before is None or after is None else
                                    (before, after) != (r["detail"]["before"], r["detail"]["after"]))
        if r["detail"]["boardOnly"] is None:
            r["detail"]["evidenceNote"] = "Schematic assignment unavailable; board-only status unknown"
    copperrows, found = read_copper(pathlib.Path(out) / "copper-diff.json") if any(f.is_file() for f in pcbs.values()) else ([], [])
    issues += [{**i, "document": "board"} for i in found]
    try:
        base_rules = rule_values(roots["base"], p["name"])
        head_rules = rule_values(roots["head"], p["name"])
    except (OSError, ValueError, TypeError, AttributeError, IndexError, KeyError) as exc:
        rulerows = []
        issues.append({"channel": "rules", "document": "board",
                       "reason": f"Rules evidence missing or malformed: {str(exc)[:500]}"})
    else:
        rulerows = diff_rules(roots["base"], roots["head"], p["name"], b=base_rules, h=head_rules)
    return netrows + diff_wires(objs["base"], objs["head"]) + padrows + copperrows + rulerows, issues


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
    def not_run(reason, incomplete=False):
        return {"name": "interfaces", "title": CHECK_NAMES["interfaces"], "level": settings["checks"]["interfaces"],
                "status": "not_run", "reason": reason, **({"incomplete": True} if incomplete else {}),
                "errors": 0, "new_errors": 0, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}
    if not pathlib.Path("head", p["dir"], p["name"] + ".kicad_sch").is_file():
        return not_run("no schematic")
    patterns = {k: INTERFACE_PATTERNS[k] + settings["interfaces"].get(k, []) for k in INTERFACE_PATTERNS}
    findings, coverage = {}, None
    for side in ("head", "base"):
        if not pathlib.Path(side, p["dir"], p["name"] + ".kicad_sch").is_file():
            findings[side] = None  # An absent base schematic is an empty baseline, not failed evidence.
            continue
        try:
            text = read_netlist(pathlib.Path(out_dir) / side)
            syms = {base_ref(o["ref"]): o for o in (objs.get(side) or {}).values() if o["kind"] == "symbol"}
            where_of = lambda ref: (syms[ref]["where"], syms[ref]["pos"][:2] if syms[ref].get("pos") else None) if ref in syms else ({"sheet": "/"}, None)
            findings[side], found = interface_findings(*parse_netlist(text), patterns, where_of)
            if side == "head":
                coverage = found
        except (OSError, ValueError, TypeError, IndexError, KeyError, AttributeError) as exc:
            # Never compute new/fixed counts against unavailable evidence for a present schematic.
            return not_run(f"{side} netlist unavailable: {exc}", True)
    c = run_check("interfaces", settings, findings["head"], findings["base"])
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


def comparison_svg(text, side, schematic=False):
    """Tint inside the decoded image, preserving custom source paints and alpha."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)
    ns = '{http://www.w3.org/2000/svg}'
    uid = 'kr-image-' + side
    rgb = (.85, .1, .15) if side == 'base' else (.1, .6, .2)
    alpha = '-.3 -.59 -.11 1 0' if schematic else '0 0 0 1 0'
    defs = ET.SubElement(root, ns + 'defs')
    box = svg_viewbox(text)
    filt = ET.SubElement(defs, ns + 'filter', {
        'id': uid, 'color-interpolation-filters': 'sRGB', 'filterUnits': 'userSpaceOnUse',
        'x': str(box[0]), 'y': str(box[1]), 'width': str(box[2]), 'height': str(box[3]),
    })
    matrix = ' '.join(f'0 0 0 0 {v}' for v in rgb) + ' ' + alpha
    ET.SubElement(filt, ns + 'feColorMatrix', {'type': 'matrix', 'values': matrix})
    group = ET.Element(ns + 'g', {'filter': f'url(#{uid})'})
    for child in list(root):
        if child is defs or child.tag.rsplit('}', 1)[-1] in ('defs', 'title', 'desc'):
            continue
        root.remove(child)
        group.append(child)
    root.append(group)
    # Keep SVG namespace explicit without mutating ElementTree's global registry.
    for attribute in list(root.attrib):
        if attribute == 'xmlns' or attribute.startswith('{http://www.w3.org/2000/xmlns/}'):
            del root.attrib[attribute]
    # Change SVG tag names only; namespace-like text and attribute values stay untouched.
    for node in root.iter():
        if isinstance(node.tag, str) and node.tag.startswith(ns):
            node.tag = node.tag[len(ns):]
    root.attrib = {'xmlns': ns[1:-1], **root.attrib}
    return ET.tostring(root, encoding='unicode')


def svg_viewbox(text):
    match = re.search(r"viewBox\s*=\s*[\"']([^\"']+)[\"']", text)
    values = [float(v) for v in re.split(r"[\s,]+", match[1].strip())] if match else []
    if len(values) != 4 or not all(math.isfinite(v) for v in values) or min(values[2:]) <= 0:
        raise ValueError("SVG needs a finite viewBox with positive width and height")
    return values


def svg_size(text):
    return svg_viewbox(text)[2:]


def has_drawing(text):
    return re.search(r"<(path|polyline|polygon|circle|rect|line|ellipse|text)\b", text) is not None


IMAGE_ASSET_LIMITS = {'svg': 8 * 1024 * 1024, 'json': 4 * 1024 * 1024}


def add_blob(blobs, content):
    """Store text or bytes gzip+base64 in blobs, deduplicated by content; return its key."""
    if content is None:
        return None
    content = content.encode() if isinstance(content, str) else content
    key = hashlib.sha1(content).hexdigest()[:12]
    if key not in blobs:
        blobs[key] = base64.b64encode(gzip.compress(content, mtime=0)).decode()
    return key


def artifact3d(raw, suffix, root=pathlib.Path('review/3d')):
    """Write a deterministic gzip asset keyed by its uncompressed SHA-256 digest."""
    digest = hashlib.sha256(raw).hexdigest()
    name = f'kicad-3d-{digest}-{suffix}.gz'
    root.mkdir(parents=True, exist_ok=True)
    packed = gzip.compress(raw, mtime=0)
    (root / name).write_bytes(packed)
    return {'digest': digest, 'artifactName': name, 'bytes': len(packed)}

def attach3d(board, out, blobs):
    """Attach stills independently, and coverage/index/assets only for verified processed sets."""
    board.pop('coverage3d', None)
    board.update({key:{side:None for side in ('base','head')}
                  for key in ('parts3d','poster3d','coverage3dBySide','assets3d')})
    for side in ("base", "head"):
        folder = pathlib.Path(out,side)
        poster = folder / 'poster.png'
        try:
            poster_raw = poster.read_bytes()
            if poster_raw.startswith(b'\x89PNG\r\n\x1a\n'):
                board['poster3d'][side] = add_blob(blobs, poster_raw)
        except OSError:
            pass
        try:
            manifest = json.loads((folder/'board-processed.json').read_text())
            files = {'board.glb':folder/'board.glb','parts.json':folder/'board-parts.json',
                     'stats.json':folder/'board-stats.json'}
            raw = {name:path.read_bytes() for name,path in files.items()}
            if any(hashlib.sha256(value).hexdigest()!=manifest['hashes'][name]
                   for name,value in raw.items()):
                raise ValueError('processed output hash mismatch')
            parts = json.loads(raw['parts.json'])
            stats = json.loads(raw['stats.json'])
            fields = ('footprints','withModel','placeholders','triangles','primitives')
            if not isinstance(parts,list) or any(not isinstance(part,dict) for part in parts) or not isinstance(stats,dict) or any(
                    type(stats.get(k)) is not int or stats[k]<0 for k in fields):
                raise ValueError('invalid coverage')
            warnings = stats.get('warnings', [])
            if not isinstance(warnings, list) or any(not isinstance(item, str) for item in warnings):
                raise ValueError('invalid coverage warnings')
            stats['warnings'] = warnings
            if stats['footprints']!=len(parts) or stats['withModel']+stats['placeholders']!=len(parts):
                raise ValueError('inconsistent coverage')
            stats = {key: stats[key] for key in (*fields, 'warnings') if key in stats}
            # The verified part index owns coverage; legacy log rows serve only unprocessed sides.
            board['no_model'] = [row for row in board.get('no_model', []) if row['side'] != side and row['side'] != 'both'] + [
                {**row, 'side': 'head' if side == 'base' else 'base'}
                for row in board.get('no_model', []) if row['side'] == 'both'
            ] + [{'ref':part['ref'], 'side':side, 'reason':part.get('reason') or 'no model in footprint',
                  'uuid':part['uuid']} for part in parts if not part['hasModel']]
            board['parts3d'][side] = add_blob(blobs,raw['parts.json'])
            board['coverage3dBySide'][side] = stats
            board['assets3d'][side] = {'model':artifact3d(raw['board.glb'],'board.glb'),
                                      'parts':artifact3d(raw['parts.json'],'board-parts.json')}
        except (OSError,ValueError,KeyError,TypeError) as error:
            if (folder/'board.glb').exists():
                print(f'{side}: optimized 3D coverage unavailable: {error}')
    coverage = board['coverage3dBySide']['head'] or board['coverage3dBySide']['base']
    if coverage is not None:
        board['coverage3d'] = coverage


def image_pair(base, head):
    return {'base': base, 'head': head}


def write_image_assets(blobs, assets, directory):
    # Validate and decode the complete batch before publishing any entry.
    pending = []
    for key, meta in assets.items():
        if (not re.fullmatch(r'[0-9a-f]{12}', key)
                or not isinstance(meta, dict)
                or meta.get('kind') not in ('svg', 'json')
                or key not in blobs):
            raise ValueError('invalid image asset')
        pending.append((f"{key}.{meta['kind']}.gz", base64.b64decode(blobs[key], validate=True)))
    dest = pathlib.Path(directory)
    dest.mkdir(parents=True, exist_ok=True)
    for filename, payload in pending:
        (dest / filename).write_bytes(payload)


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
        obj = next((o for s in ("base", "head") for o in objs[s].values()
                    if o["kind"] == "footprint" and o["ref"] == ref and s in sides), None)
        row = {"ref": ref, "side": side, "reason": reason}
        if obj:
            pos = obj.get("pos")
            row.update({"pos": (pos + [0])[:3] if pos else None, "box": obj.get("box"), "layer": obj.get("props", {}).get("layer")})
        rows.append(row)
    return rows


def read_optional_json(path, default=None):
    return json.loads(pathlib.Path(path).read_text()) if pathlib.Path(path).is_file() else default


CHANNELS = ("components","wiring","routing","rules","board","visual")


def dedupe_electrical(rows, typed):
    """Drop generic metadata keys that a typed rule or stackup row already describes.

    Typed rule refs are rule_values keys; meta:pro flattens design_settings under "board.",
    named classes by name and pattern lists by index, so map each ref to that flattened prefix.
    """
    refs = {r["ref"] for r in typed if r["kind"] in ("rule", "stackup")}
    prefixes = {"board." + k if k.startswith("rules.") else k for k in refs
                if k.startswith(("rules.", "net_settings.classes.")) or k == "net_settings.netclass_patterns"}
    under = lambda key, p: key == p or key.startswith((p + ".", p + "["))
    result = []
    for row in rows:
        uid = row.get("uuid")
        if uid == "meta:dru" and "custom rules" in refs:
            continue
        if uid == "meta:pro":
            superseded = lambda key: any(under(key, p) for p in prefixes)
        elif uid == "meta:setup":
            superseded = lambda key: "stackup" in refs and under(key, "stackup")
        else:
            result.append(row)
            continue
        row = dict(row)
        if "changes" in row:
            row["changes"] = [c for c in row["changes"] if not superseded(c[0])]
            if not row["changes"]:
                continue
        else:
            row["props"] = {k: v for k, v in row.get("props", {}).items() if not superseded(k)}
            if not row["props"]:
                continue
        result.append(row)
    return result


def classify_change(row, document=None):
    r = dict(row)
    k = r["kind"]
    channel = ("components" if k in ("symbol","footprint") else "wiring" if k in
               ("wire","bus","junction","no connect","power symbol","label","global label","hierarchical label")
               else "routing" if k in ("track","via","zone") else "rules" if k == "design rules"
               else "board" if k == "board outline" else "visual")
    props = {x[0].lower() for x in r.get("changes",[])}
    heavy = channel == "rules" or channel == "components" and (r["action"] != "modified" or "footprint" in props)
    weight = "heavy" if heavy else "medium" if channel in ("routing","board") or k == "wire" else "light"
    r.setdefault("channel",channel); r.setdefault("weight",weight)
    if document is not None:
        r["document"] = document
    else:
        r.setdefault("document", "board" if (r.get("where") or {}).get("board") or r.get("uuid") in ("meta:setup","meta:pro","meta:dru","meta:title_block:board") else "schematic")
    if "position" in props and r.get("pos") and r.get("pos_before"):
        a,b = r["pos_before"][:2],r["pos"][:2]
        r.setdefault("detail",{"kind":"position","before":a,"after":b,
                              "distanceMm":sum((x-y)**2 for x,y in zip(a,b))**0.5})
    return r


def electrical_summary(rows, issues, present=None):
    present = present if present is not None else {"schematic","board"}
    # Legacy issues infer their producer; new producers always set document explicitly.
    unique = {(i.get("document") or ("schematic" if i["channel"]=="wiring" else "board"),
               i["channel"],i["reason"]) for i in issues}
    issues = [{"document":d,"channel":c,"reason":r} for d,c,r in sorted(unique)]
    def headline(selected):
        component = lambda r: r["kind"] in ("symbol","footprint")
        counts = [
            (sum(component(r) and r["action"] == "added" for r in selected),"added"),
            (sum(component(r) and any(k.lower() == "value" for k,*_ in r.get("changes",[])) for r in selected),"values"),
            (sum(component(r) and any(k.lower() == "footprint" for k,*_ in r.get("changes",[])) for r in selected),"footprints"),
            (sum(r["kind"] == "net-added" for r in selected),"nets added"),
            (sum(r["kind"] == "net-removed" for r in selected),"nets removed"),
            (sum(r["kind"] == "net-joined" for r in selected),"net joins"),
            (sum(component(r) and any(k.lower() == "position" for k,*_ in r.get("changes",[])) for r in selected),"moved")]
        return " · ".join(f"{n} {label}" for n,label in counts if n) or "No headline changes"
    def channels(selected, documents, selected_issues):
        producers = {"schematic":{"components","wiring","visual"},
                     "board":{"components","wiring","routing","rules","board","visual"}}
        applicable = set().union(*(producers[d] for d in documents)) if documents else set()
        applicable |= {r.get("channel") for r in selected}
        applicable |= {i["channel"] for i in selected_issues}
        return [{"channel":c,"total":sum(r.get("channel") == c for r in selected),
                 "heavy":sum(r.get("channel") == c and r.get("weight") == "heavy" for r in selected),
                 "status":"incomplete" if any(i["channel"] == c for i in selected_issues) else
                          "complete" if c in applicable else "not_applicable"}
                for c in CHANNELS]
    documents = []
    for d in ("schematic","board"):
        if d not in present: continue
        selected = [r for r in rows if r.get("document") == d]
        found = [i for i in issues if i["document"] == d]
        documents.append({"document":d,"headline":headline(selected),
                          "channels":channels(selected,{d},found),"incomplete":found})
    return {"headline":headline(rows),"channels":channels(rows,present,issues),
            "incomplete":issues,"documents":documents}


def build_project(p, blobs, settings, waivers=None, change_offset=0, bom_sink=None):
    out = f"review/{project_id(p['dir'])}"
    sides = [s for s in ("base", "head") if os.path.isdir(f"{out}/{s}")]
    theme_paths = {side: read_optional_json(f'{out}/{side}/sheet-images.json', {}) for side in sides}
    pages_by_side = {side: sheet_pages(posixpath.join(side, p['dir']), p['name']) for side in sides}
    hotspot_ids = image_pair(None, None)
    for side in sides:
        src = posixpath.join(side, p['dir'])
        source = pathlib.Path(src, p['name'] + '.kicad_sch')
        # Legacy fixtures may lack a root identity. Keep artwork without inventing anchors.
        try:
            if source.is_file() and val(parse_sexpr(source.read_text()), 'uuid'):
                manifest = sheet_hotspots(src, p['name'])
                page_by_path = {page['path']: page for page in pages_by_side[side]}
                for view in manifest['views']:
                    rel = theme_paths[side].get(view['sheet'], {}).get('light')
                    page = page_by_path.get(view['sheet'])
                    path = str(pathlib.Path(out, side, rel)) if rel else page_svg(f'{out}/{side}', p['name'], page)
                    text = svg_body(path)
                    if text:
                        view['viewBox'] = svg_viewbox(text)
                payload = json.dumps(manifest, separators=(',', ':'), sort_keys=True)
                pathlib.Path(out, side, 'sheet-hotspots.json').write_text(payload)
                hotspot_ids[side] = add_blob(blobs, payload)
        except Exception as exc:  # optional evidence: any hotspot failure keeps the schematic SVGs
            print('::warning::' + workflow_command_escape(f'{source}: hotspots unavailable; retaining schematic SVGs: {exc!r}'), file=sys.stderr)
    pages = {}
    for side in sides:
        for pg in pages_by_side[side]:
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
        pg['hotspots'] = {side: hotspot_ids[side] if texts.get(side) is not None else None for side in ('base', 'head')}
        pg['svgThemes'] = {}
        for theme in ('light', 'dark'):
            pair = {}
            for side in ('base', 'head'):
                rel = theme_paths.get(side, {}).get(pg['path'], {}).get(theme)
                text = svg_body(str(pathlib.Path(out, side, rel))) if rel else texts.get(side)
                pair[side] = add_blob(blobs, text) if texts.get(side) is not None else None
            pg['svgThemes'][theme] = pair
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
    for row in board['layers']:
        row['svgThemes'] = {}
        for theme, folder in (('light', 'pcb'), ('dark', 'pcb-dark')):
            pair = {}
            for side in ('base', 'head'):
                path = pathlib.Path(out, side, folder, p['name'] + '-' + row['name'] + '.svg')
                pair[side] = add_blob(blobs, svg_body(str(path))) if row['svg'][side] and path.is_file() else row['svg'][side]
            row['svgThemes'][theme] = pair
        canonical = row['name'].replace('_', '.')
        row['sourceRGBThemes'] = {t: IMAGE_PALETTES[t]['sourceRGB'].get(canonical, [255, 255, 255]) for t in ('light', 'dark')}
    for rows, schematic in ((sheets, True), (board['layers'], False)):
        for row in rows:
            pair = {}
            for side in ('base', 'head'):
                key = row['svg'][side]
                text = gzip.decompress(base64.b64decode(blobs[key])).decode() if key else None
                pair[side] = add_blob(blobs, comparison_svg(text, side, schematic)) if text else None
            row['svgCompare'] = pair
    objs, source_issues = project_pair(p)
    det = read_optional_json("review/detect.json", {})
    extra, issues = electrical_changes(p, out, objs, {s: det.get(s, "") for s in ("base", "head")})
    changes = [classify_change(r) for r in dedupe_electrical(diff_objects(objs["base"], objs["head"]), extra)] + extra
    present = {d for d, suffix in (("schematic", ".kicad_sch"), ("board", ".kicad_pcb"))
               if any(pathlib.Path(s, p["dir"], p["name"] + suffix).is_file() for s in ("base", "head"))}
    summary = electrical_summary(changes, source_issues + issues, present)
    for n, change in enumerate(changes, change_offset + 1):
        change["id"] = f"c{n}"
    inspect = image_pair(None, None)
    geometry = {}
    pcbs = {side: posixpath.join(side, p["dir"], p["name"] + ".kicad_pcb") for side in ("base", "head")}
    same_board = all(os.path.isfile(f) for f in pcbs.values()) and filecmp.cmp(pcbs["base"], pcbs["head"], shallow=False)
    for side in ("base", "head"):
        pcb = pcbs[side]
        geometry[side] = None
        if side == "head" and same_board:
            geometry[side] = geometry["base"]
            inspect[side] = inspect["base"]
            if inspect[side]:
                pathlib.Path(out, side).mkdir(parents=True, exist_ok=True)
                pathlib.Path(out, side, "board-inspect.json").write_bytes(pathlib.Path(out, "base", "board-inspect.json").read_bytes())
            continue
        if os.path.isfile(pcb):
            try:
                scene = board_geometry(pcb)
                # Child pads, text and graphics use their owning footprint's UUID;
                # standalone tracks/vias/zones use their own. Never match by net/ref.
                # Derived electrical rows carry anchors, not owner UUIDs, so they never claim objects.
                ids = {(r["kind"], r.get("uuid_before", r["uuid"]) if side == "base" else r["uuid"]): r["id"]
                       for r in changes if r.get("uuid") and (r.get("where") or {}).get("board")
                       and r["action"] != ("added" if side == "base" else "removed")}
                for obj in scene["objects"]:
                    uid = obj["changeUuid"]
                    kind = objs[side].get(uid, {}).get("kind")
                    change_id = ids.get((kind, uid))
                    obj["changeIds"] = [change_id] if change_id else []
                geometry[side] = add_blob(blobs, json.dumps(scene, separators=(",", ":"), sort_keys=True))
            except Exception as exc:  # any unforeseen board construct falls back to SVG
                print(f"{pcb}: geometry unavailable; retaining SVG: {exc!r}", file=sys.stderr)
                continue
            try:
                manifest = board_inspect(scene, read_optional_json(f'{out}/{side}/stats.json'))
                payload = json.dumps(manifest, separators=(',', ':'), sort_keys=True)
                pathlib.Path(out, side).mkdir(parents=True, exist_ok=True)
                pathlib.Path(out, side, 'board-inspect.json').write_text(payload)
                inspect[side] = add_blob(blobs, payload)
            except Exception as exc:
                print(f"{pcb}: inspection unavailable; retaining geometry and SVG: {exc!r}", file=sys.stderr)
    board["inspect"] = inspect
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
        if bom_sink is not None:  # repository BOM (Task 5A) reads the head lines and objects
            bom_sink.append({"name": p["name"], "lines": lines["head"], "objects": objs["head"]})
    if settings["3d"]["enabled"]:
        models = {side: f"{out}/{side}/board.glb" for side in ("base", "head")}
        board["model3d"] = {side: add_blob(blobs, pathlib.Path(path).read_bytes()) if os.path.exists(path) else None
                            for side, path in models.items()}
        board["model3d"].update({"enabled": True,
                                 "changed": board["model3d"].get("base") != board["model3d"].get("head"),
                                 "errors": {side: "3D export unavailable" for side in ("base", "head")
                                            if has[side] and not board["model3d"].get(side)}})
        board["no_model"] = model3d_missing(out, objs)
    if settings["3d"]["enabled"] or settings.get("design", {}).get("enabled", False):
        attach3d(board, out, blobs)
    index = object_index(objs["base"], objs["head"], libraries=settings["libraries"]["enabled"]) if any(
        settings[name]["enabled"] for name in ("threads", "issues", "inventory", "libraries")) else None
    libraries = None
    if settings["libraries"]["enabled"]:
        roots = {side: posixpath.join(side, p["dir"]) for side in ("base", "head")}
        items = {side: library_items(root) for side, root in roots.items()}
        libraries = library_report(library_changes(items["base"], items["head"]), index, out, blobs,
                                   local_items=set(items["base"]) | set(items["head"])) or None
    return {"name": p["name"], "dir": p["dir"], "status": p["status"], "sheets": sheets, "board": board,
            "changes": changes, "summary": summary, "checks": project_checks(p, settings, objs, waivers),
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


def image_asset_declarations(projects):
    """Declare only optional image capabilities; legacy drawings stay embedded."""
    assets = {}
    # Shared content has one descriptor. Prefer board roles explicitly, not by
    # traversal order, preserving the established layer/inspection filenames.
    priority = {'sheet.svg': 0, 'layer.svg': 1,
                'sheet-hotspots.json': 0, 'board-inspect.json': 1, 'comparison.svg': 2}

    def declare(pair, kind, name):
        for key in (pair or {}).values():
            if key:
                previous = assets.get(key)
                if previous and previous['kind'] != kind:
                    raise ValueError('conflicting image asset kinds')
                if not previous or priority[name] > priority[previous['name']]:
                    assets[key] = {'kind': kind, 'name': name}

    for project in projects:
        for sheet in project.get('sheets', []):
            declare(sheet.get('hotspots'), 'json', 'sheet-hotspots.json')
            declare(sheet.get('svgCompare'), 'svg', 'comparison.svg')
            for pair in sheet.get('svgThemes', {}).values():
                declare(pair, 'svg', 'sheet.svg')
        declare(project.get('board', {}).get('inspect'), 'json', 'board-inspect.json')
        for layer in project.get('board', {}).get('layers', []):
            declare(layer.get('svgCompare'), 'svg', 'comparison.svg')
            for pair in layer.get('svgThemes', {}).values():
                declare(pair, 'svg', 'layer.svg')
    return assets


def finalize_report(data, assets_dir):
    """Share hosted declarations and sidecars without removing any offline blob."""
    data['assets'] = image_asset_declarations(data['projects'])
    for key, meta in list(data['assets'].items()):
        size = len(gzip.decompress(base64.b64decode(data['blobs'][key], validate=True)))
        cap = IMAGE_ASSET_LIMITS[meta['kind']]
        if size > cap:
            print(f"Warning: {meta['kind']} asset {key} decoded size {size} exceeds {cap} bytes; keeping inline.", file=sys.stderr)
            del data['assets'][key]
    write_image_assets(data['blobs'], data['assets'], assets_dir)
    payload = json.dumps(compact_bom_lines(data), separators=(',', ':')).replace('<', '\\u003c')
    return inline_page(f'window.REVIEW_DATA = {payload};')


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
        worker = base64.b64encode(open(posixpath.join(UI_DIR, "three-decode.js"), "rb").read()).decode()
        worker_tag = f'<script type="application/octet-stream" id="three-decode-worker">{worker}</script>'
        prefix = f'<script type="application/octet-stream" id="three-bundle">{bundle}</script>{worker_tag}<script>\n{read("three-parts.js")}</script><script>\n{read("review3d.js")}</script>'
    page = page.replace('<script src="review.js"></script>', f"{prefix}<script>\n{read('review.js')}</script>")
    for asset in ("kicad-colors.js", "appearance-state.js", "board-gl.js", "appearance.js", "board-marks.js", "board-diff.js", "three-studio.js", "image-view.js"):
        page = page.replace(f'<script src="{asset}"></script>', f'<script>\n{read(asset)}</script>')
    if re.search(r'''(?:href|src)=(["'])(?:theme\.js|tokens\.css|review\.css|sample/review-data\.js|review\.js|kicad-colors\.js|board-gl\.js|appearance-state\.js|appearance\.js|board-marks\.js|board-diff\.js|three-studio\.js|image-view\.js)\1''', page): raise RuntimeError("external report assets remain: template did not match")
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
    _sheet_warnings.clear()
    with open("review/detect.json", encoding="utf-8") as fh:
        det = json.load(fh)
    blobs = {}
    env = os.environ
    settings = load_settings()
    # An opted-out report must remain byte-for-byte compatible with reports made before this feature.
    report_settings = {k: v for k, v in settings.items()
                       if k != "release" and not ((k in ("3d", "parts", "digikey", "threads", "issues", "waivers", "inventory", "libraries", "pdf", "downloads") and not v["enabled"]) or (k == "github" and not v["check_runs"]))}
    if not settings["parts"]["enabled"]:
        report_settings["bom"] = {"required_fields": settings["bom"]["required_fields"]}
    if settings["checks"].get("interfaces") == "off":  # opted-out reports stay byte-identical
        report_settings["checks"] = {k: v for k, v in settings["checks"].items() if k != "interfaces"}
        report_settings.pop("interfaces", None)
    if settings["checks"].get("release") == "off":  # opted-out reports stay byte-identical
        report_settings["checks"] = {k: v for k, v in report_settings["checks"].items() if k != "release"}
    if not fab_enabled(settings):
        report_settings['checks'] = {k: v for k, v in report_settings['checks'].items() if k != 'fab_limits'}
        report_settings['fabrication'] = {k: v for k, v in report_settings['fabrication'].items() if k != 'check_limits'}
    data = {
        "version": 1,
        "repo": env.get("GITHUB_REPOSITORY", ""),
        "links": review_links(env, det),
        "base": det["base"], "head": det["head"], "reason": det["reason"],
        "settings": report_settings,
        "run_id": env.get("GITHUB_RUN_ID", ""),
    }
    waivers = load_waivers(env.get("WAIVERS_REF") or det["base"]) if settings["waivers"]["enabled"] else None
    shutil.rmtree("review/downloads", ignore_errors=True)
    data["projects"] = []
    change_offset = 0
    bom_boards = []
    for i, p in enumerate(det["projects"]):
        project = build_project(p, blobs, settings, waivers, change_offset, bom_boards)
        downloads = collect_downloads(p, i, det["head"]) if settings.get("downloads", {}).get("enabled") or settings["checks"].get("release", "off") != "off" else None
        if downloads:
            project["downloads"] = downloads
        data["projects"].append(project)
        change_offset += len(project["changes"])
    if len(bom_boards) >= 2:  # repository-wide BOM, only when there are several projects (Owner decision 2026-10-26)
        data["bom"] = bom_repository(bom_boards, settings["fabrication"]["preset"], settings["fabrication"].get("part_field"))
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
    html = finalize_report(data, "review/assets")
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
        fh.write(f"downloads={'true' if os.path.isdir('review/downloads') and os.listdir('review/downloads') else 'false'}\ndownloads_name=kicad-review-downloads-{det['head'][:7]}\n")
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


def connectivity_markdown(project, limit=20):
    rows = [
        r for r in project.get("changes", [])
        if r.get("kind") in (
            "net-added", "net-removed", "net-joined",
            "net-split", "net-renamed", "net-members"
        )
    ]
    if not rows:
        return []

    out = ["", "#### Connectivity", "", "| Change | Net | Members |", "|---|---|---|"]
    for r in rows[:limit]:
        d = r.get("detail") or {}
        added = d.get("added") or []
        removed = d.get("removed") or []
        pins = " ".join([*(f"+{p}" for p in added), *(f"−{p}" for p in removed)])

        before_nets = d.get("beforeNets") or []
        after_nets = d.get("afterNets") or []
        relation = (" + ".join(str(b) for b in before_nets) + " → " + " + ".join(str(a) for a in after_nets)) if (before_nets or after_nets) else ""

        transitions = []
        for t in d.get("transitions") or []:
            if not isinstance(t, dict):
                continue
            pin = str(t.get("pin", ""))
            before = " + ".join(str(b) for b in (t.get("before") or [])) or "(unconnected)"
            after = " + ".join(str(a) for a in (t.get("after") or [])) or "(unconnected)"
            transitions.append(f"{pin}: {before} → {after}")
        moved = "; ".join(transitions)

        summary_text = moved or pins or relation
        out.append(f"| {cell(r.get('kind', ''))} | {cell(r.get('ref', ''))} | {cell(summary_text)} |")

    if len(rows) > limit:
        out.append(f"| | | and {len(rows) - limit} more in the report |")
    return out


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
        summary = p.get("summary")
        if summary:
            headline = summary.get("headline", "")
            if headline:
                out += ["", md(headline[:200])]
            for issue in summary.get("incomplete", []):
                channel = str(issue.get("channel", ""))
                reason = str(issue.get("reason", ""))
                note = f"{channel}: {reason}"
                if len(note) > 200:
                    note = note[:199] + "…"
                out += ["", md(note)]
        out += connectivity_markdown(p)
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
            print("::warning::" + workflow_command_escape(f"Screenshot of {s['title']} failed: {r.stderr[-300:]}"))
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
                    print("::warning::" + workflow_command_escape("review/threads.json has no review threads; thread counts left out"))
                elif review_threads.get("totalCount", 0) > len(review_threads.get("nodes") or []):
                    # ponytail: first 100 threads; fail closed beyond the ceiling until paginated.
                    print("::warning::" + workflow_command_escape("review/threads.json is incomplete; thread counts left out"))
                else:
                    threads = thread_counts(raw)
            except ValueError:
                print("::warning::" + workflow_command_escape("review/threads.json is not JSON; thread counts left out"))
    issues = None
    if data["settings"].get("issues", {}).get("enabled") and os.path.exists("review/issues.json"):
        with open("review/issues.json", encoding="utf-8") as fh:
            try:
                issues = touched_issues(json.load(fh), data)
            except ValueError:
                print("::warning::" + workflow_command_escape("review/issues.json is not JSON; issue links left out"))
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
            vendor = FAB_VENDOR_LABELS.get(c.get('vendor'), c.get('vendor'))
            title = f"{c['title']} · {vendor}" if vendor else c['title']
            lines.append(f"| {md(p['name'])} | {md(title)} ({c['level']}) | {STATUS_ICON[c['status']]} {c['status'].replace('_', ' ')}{': ' + md(c['reason']) if c.get('reason') else ''} | "
                         f"{c['errors']} ({c['new_errors']}) | {c['warnings']} ({c['new_warnings']}) | {c.get('fixed', '—')} |")
    for p in data['projects']:
        for c in p['checks']:
            if c['name'] != 'fab_limits':
                continue
            vendor = FAB_VENDOR_LABELS.get(c.get('vendor'))
            label = f'Fab limits ({vendor})' if vendor else 'Fab limits'
            prefix = f"**{md(p['name'])}**: " if len(data['projects']) > 1 else ''
            if c.get('unsupported') or c['status'] == 'not_run':
                text = f"{label}: not checked — {md(c.get('unsupported') or c.get('reason', 'unavailable'))}."
            else:
                text = f"{label}: {c['errors'] + c['warnings']} violations" + (f" ({c['waived']} waived)" if c.get('waived') else '') + '. Eligible limits only; see coverage in Checks.'
            lines += ['', prefix + text]
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
        print("::warning::" + workflow_command_escape("PDF report failed: invalid PDF_NAME"))
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
        print("::warning::" + workflow_command_escape("PDF report failed: Chrome unavailable, failed or timed out"))
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
    for index, project in enumerate(data["projects"]):
        headline = project.get("summary",{}).get("headline","")
        if headline:
            per[index] += (" · " if per[index] else "") + md(headline[:200])
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
            project_label = md(p['name']) + (f" ({FAB_VENDOR_LABELS[c['vendor']]})" if c.get('vendor') in FAB_VENDOR_LABELS else '')
            r["rows"].append(f"| {project_label} | {STATUS_ICON[c['status']]} {c['status'].replace('_', ' ')} | {c['errors']} ({c['new_errors']}) | {c['warnings']} ({c['new_warnings']}) |")
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
    p = sub.add_parser("prepare-3d", help="write revision-scoped metadata for the 3D processor")
    p.set_defaults(func=cmd_prepare3d)
    p = sub.add_parser("copper", help="refilled copper differences of both revisions (run inside the KiCad container)")
    p.set_defaults(func=cmd_copper)
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
