#!/usr/bin/env python3
"""Build offline browser-check pages from the shared sample and BOM fixtures."""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import kicad_review as k


def build_pages(output):
    output.mkdir(parents=True, exist_ok=True)
    for name, data in (("3d", "review-data-3d.js"), ("two", "review-data-2.js"), ("parts", "review-data-parts.js")):
        payload = (ROOT / "ui" / "sample" / data).read_text(encoding="utf-8")
        (output / f"{name}.html").write_text(k.inline_page(payload), encoding="utf-8")
    fixture = json.loads((ROOT / "ui/fixtures/bom-multiboard.json").read_text(encoding="utf-8"))
    boards, projects = [], []
    for board in fixture["boards"]:
        lines = k.parts_lines(board["objects"])
        boards.append({"name": board["name"], "lines": lines, "objects": board["objects"]})
        projects.append({
            "name": board["name"], "dir": "", "status": "modified", "sheets": [], "changes": [], "checks": [],
            "board": {"changed": False, "layers": []},
            "parts": {"supplier": None, "summary": k.bom_summary(lines),
                      "exports": k.bom_exports(lines, "jlcpcb", None, board["objects"]), "lines": lines, "changes": []},
        })
    data = {"version": 1, "repo": "example/multi", "base": "base", "head": "head", "reason": "Multi-board fixture",
            "links": {}, "blobs": {}, "projects": projects, "bom": k.bom_repository(boards, "jlcpcb")}
    payload = json.dumps(k.compact_bom_lines(data), ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    (output / "multiboard.html").write_text(k.inline_page(f"window.REVIEW_DATA = {payload};"), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=pathlib.Path)
    build_pages(parser.parse_args().output)
