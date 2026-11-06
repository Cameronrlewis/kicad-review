#!/usr/bin/env python3
"""Build offline browser-check pages from the shared sample and BOM fixtures."""
import argparse
import copy
import json
import pathlib
import sys
import tempfile
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import kicad_review as k


def fab_test_raw(uid, kind="track_width"):
    return {
        "type": kind,
        "severity": "error",
        "description": "too narrow",
        "items": [{"uuid": uid, "description": uid, "pos": {"x": 42.5, "y": 20}}],
    }


def fab_produced_checks():
    with tempfile.TemporaryDirectory() as td:
        root = pathlib.Path(td).resolve()
        source = root / "four.kicad_pcb"
        source.write_text(
            (ROOT / "ui" / "fixtures" / "vf-order-4.kicad_pcb")
            .read_text(encoding="utf-8")
            .replace("(thickness 0.035)", "", 1),
            encoding="utf-8",
        )
        project = source.with_suffix(".kicad_pro")
        project.write_text(
            json.dumps({
                "board": {
                    "design_settings": {
                        "drc_exclusions": ["unrelated-house-exclusion"],
                        "rule_severities": {"invalid_outline": "error", "via_diameter": "ignore"},
                    }
                }
            }),
            encoding="utf-8",
        )
        rule = source.with_suffix(".kicad_dru")
        rule.write_text("(version 1)\n# house bytes\n", encoding="utf-8")
        settings = copy.deepcopy(k.DEFAULT_SETTINGS)
        settings["fabrication"]["check_limits"] = True
        settings["checks"]["fab_limits"] = "required"
        ordinary, extra = fab_test_raw("house"), fab_test_raw("track")

        def fake_drc(pcb, out):
            mode = pcb.parent.name
            rows = [ordinary, extra] if mode != "board" else [ordinary]
            return {"coordinate_units": "mm", "violations": rows}

        p = {"name": "Four", "dir": "", "status": "modified"}
        output = root / "report" / "head"
        with patch.object(k, "board_path", return_value=str(source)), patch.object(k, "fab_drc", side_effect=fake_drc):
            k.render_fab(p, "head", str(output))
        with patch.object(
            k, "board_path", side_effect=lambda p, side: str(source) if side == "head" else str(source.with_name("no-base.kicad_pcb"))
        ):
            return {c["vendor"]: c for c in k.fab_checks(p, settings, str(root / "report"), {"active": {}})}


def build_pages(output):
    output.mkdir(parents=True, exist_ok=True)
    for name, data in (
        ("3d", "review-data-3d.js"),
        ("two", "review-data-2.js"),
        ("parts", "review-data-parts.js"),
        ("images", "review-data-images.js"),
        ("processed", "review-data-3d-processed.js"),
    ):
        payload = (ROOT / "ui" / "sample" / data).read_text(encoding="utf-8")
        (output / f"{name}.html").write_text(k.inline_page(payload), encoding="utf-8")

    source = (ROOT / "ui" / "sample" / "review-data-3d-processed.js").read_text(encoding="utf-8")
    data = json.loads(source.split("=", 1)[1].strip().removesuffix(";"))
    data['mode'] = 'single'
    for project in data["projects"]:
        for key in ("model3d", "poster3d", "parts3d", "assets3d", "coverage3dBySide"):
            project["board"][key]["base"] = None
    (output / "single.html").write_text(k.inline_page("window.REVIEW_DATA = " + json.dumps(data) + ";"), encoding="utf-8")

    fixture = json.loads((ROOT / "ui/fixtures/bom-multiboard.json").read_text(encoding="utf-8"))
    boards, projects = [], []
    for board in fixture["boards"]:
        lines = k.parts_lines(board["objects"])
        boards.append({"name": board["name"], "lines": lines, "objects": board["objects"]})
        projects.append({
            "name": board["name"],
            "dir": "",
            "status": "modified",
            "sheets": [],
            "changes": [],
            "checks": [],
            "board": {"changed": False, "layers": []},
            "parts": {
                "supplier": None,
                "summary": k.bom_summary(lines),
                "exports": k.bom_exports(lines, "jlcpcb", None, board["objects"]),
                "lines": lines,
                "changes": [],
            },
        })
    data = {
        "version": 1,
        "repo": "example/multi",
        "base": "base",
        "head": "head",
        "reason": "Multi-board fixture",
        "links": {},
        "blobs": {},
        "projects": projects,
        "bom": k.bom_repository(boards, "jlcpcb"),
    }
    payload = json.dumps(k.compact_bom_lines(data), ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    (output / "multiboard.html").write_text(k.inline_page(f"window.REVIEW_DATA = {payload};"), encoding="utf-8")

    sample = (ROOT / "ui" / "sample" / "review-data.js").read_text(encoding="utf-8")
    data = json.loads(sample.split("=", 1)[1].strip().rstrip(";"))
    project = next(p for p in data["projects"] if p.get("board", {}).get("layers"))
    data["fabProducerFixture"] = True
    produced = fab_produced_checks()
    project["checks"] = [*project["checks"], *(copy.deepcopy(c) for c in produced.values())]
    data.setdefault("settings", {}).setdefault("checks", {})["fab_limits"] = "required"
    k.assign_ids(data["projects"])
    payload = "window.REVIEW_DATA = " + json.dumps(data).replace("<", "\\u003c") + ";"
    (output / "fab.html").write_text(k.inline_page(payload), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=pathlib.Path)
    build_pages(parser.parse_args().output)
