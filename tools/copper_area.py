"""Container-only signed copper differences; only disposable copies are saved.

Areas describe KiCad's exported copper polygons, not drill-subtracted metal.
Both revisions use the same 0.005 mm chord approximation.
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

import pcbnew


def refill_board(path):
    """Refill with the revision's adjacent project and custom-rule context."""
    # ponytail: let the KiCad CLI establish project/custom-rule context; no SWIG project loader.
    source = pathlib.Path(path)
    with tempfile.TemporaryDirectory(prefix="br03-copper-") as tmp:
        root = pathlib.Path(tmp)
        for suffix in (".kicad_pcb", ".kicad_pro", ".kicad_dru"):
            item = source.with_suffix(suffix)
            if item.is_file():
                shutil.copy2(item, root / item.name)
        target = root / source.name
        # --save-board writes only the disposable copy, never a source revision.
        original = (target.stat().st_mtime_ns, target.stat().st_size)
        run = subprocess.run(
            ["kicad-cli", "pcb", "drc", "--format", "json", "--severity-error",
             "--exit-code-violations", "--refill-zones", "--save-board",
             "-o", str(root / "drc.json"), str(target)],
            capture_output=True, text=True, timeout=55)
        if run.returncode not in (0, 5):
            detail = (run.stderr or run.stdout or "no diagnostic output").strip()
            raise RuntimeError(
                f"project-context refill failed (exit {run.returncode}): {detail}"
            )
        saved = target.stat()
        if (saved.st_mtime_ns, saved.st_size) == original:
            raise RuntimeError(
                f"project-context refill failed (exit {run.returncode}): "
                "kicad-cli did not save the refilled board"
            )
        board = pcbnew.LoadBoard(str(target))
        if board is None:
            raise ValueError("refilled board missing")
        return board


def collect(path):
    """Union copper tracks, pads, zones and copper graphics/text by layer and net.

    KiCad exports transformed copper graphics as filled polygon approximations;
    non-copper-layer drawings are ignored.
    """
    if path == "-":
        return {}
    board = refill_board(path)
    board.BuildConnectivity()
    out = {}

    def add(layer, net, poly):
        key = (board.GetLayerName(layer), net or "")
        if key not in out:
            out[key] = pcbnew.SHAPE_POLY_SET()
        out[key].BooleanAdd(poly)

    graphics = list(board.GetDrawings())
    for footprint in board.GetFootprints():
        graphics.extend(footprint.GraphicalItems())
    # Reference/Value fields are not GraphicalItems; include copper-layer fields too.
    for footprint in board.GetFootprints():
        for field in (footprint.Reference(), footprint.Value()):
            if field.IsOnCopperLayer():
                graphics.append(field)

    for layer in board.GetEnabledLayers().CuStack():
        for item in [*board.GetTracks(), *board.GetPads()]:
            if not item.IsOnLayer(layer):
                continue
            poly = pcbnew.SHAPE_POLY_SET()
            item.TransformShapeToPolygon(poly, layer, 0, 5000, pcbnew.ERROR_INSIDE)
            add(layer, item.GetNetname(), poly)
        for zone in board.Zones():
            if zone.IsOnLayer(layer) and not zone.GetIsRuleArea():
                add(layer, zone.GetNetname(), zone.GetFilledPolysList(layer))
        # Include standalone and footprint-attached copper drawings and text.
        for item in graphics:
            if not item.IsOnLayer(layer):
                continue
            poly = pcbnew.SHAPE_POLY_SET()
            item.TransformShapeToPolygon(poly, layer, 0, 5000, pcbnew.ERROR_INSIDE)
            if poly.OutlineCount():
                get_netname = getattr(item, "GetNetname", None)
                add(layer, get_netname() if get_netname else "", poly)
    for poly in out.values():
        poly.Simplify()
    return out


def contours(poly):
    """Return outer and hole contours as numeric millimetre points, never SVG."""
    result = []
    for i in range(poly.OutlineCount()):
        for line in [poly.Outline(i), *[poly.Hole(i, j) for j in range(poly.HoleCount(i))]]:
            result.append([[line.CPoint(k).x / 1e6, line.CPoint(k).y / 1e6]
                           for k in range(line.PointCount())])
    return result


def compare(base, head):
    """Compute true signed differences without mutating either input union."""
    rows = []
    for layer, net in sorted(base.keys() | head.keys()):
        before = base.get((layer, net), pcbnew.SHAPE_POLY_SET())
        after = head.get((layer, net), pcbnew.SHAPE_POLY_SET())
        added, removed = pcbnew.SHAPE_POLY_SET(after), pcbnew.SHAPE_POLY_SET(before)
        added.BooleanSubtract(before)
        removed.BooleanSubtract(after)
        added.Simplify()
        removed.Simplify()
        a, r = added.Area() / 1e12, removed.Area() / 1e12
        if max(a, r) <= 0.05:
            continue
        rows.append({"net": net, "layer": layer, "addedMm2": a, "removedMm2": r,
                     "addedContours": contours(added), "removedContours": contours(removed)})
    return {"rows": rows, "incomplete": []}


if __name__ == "__main__":
    result = compare(collect(sys.argv[1]), collect(sys.argv[2]))
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))
