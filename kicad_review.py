#!/usr/bin/env python3
"""KiCad review: compare two revisions of the KiCad projects in a git repository.

Standard library only. Subcommands are called from the reusable workflow.
"""
import argparse
import json
import os
import posixpath
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
        kicad_cli("sch", "export", "svg", "--exclude-drawing-sheet", "-o", f"{out}/sch", sch)
        files["sch"] = sorted(f"sch/{f}" for f in os.listdir(f"{out}/sch"))
    if os.path.exists(pcb):
        # Page-size mode 1 keeps page coordinates (mm from the page origin), so both revisions overlay exactly.
        kicad_cli("pcb", "export", "svg", "--mode-multi", "--exclude-drawing-sheet", "--page-size-mode", "1",
                  "--drill-shape-opt", "2", "-l", ",".join(board_layers(pcb)), "-o", f"{out}/pcb", pcb)
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
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
