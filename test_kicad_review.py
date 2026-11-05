"""Self-checks for kicad_review.py. Run: python3 test_kicad_review.py"""
import os

# Only the KiCad interpreter imports pcbnew; ordinary host checks stay dependency-free.
if os.environ.get("BR03_PCBNEW_TEST") == "1":
    import importlib.util
    spec = importlib.util.spec_from_file_location("copper_area", "tools/copper_area.py")
    copper = importlib.util.module_from_spec(spec); spec.loader.exec_module(copper)
    import pcbnew

    def square(x0, y0, x1, y1):
        p = pcbnew.SHAPE_POLY_SET(); p.NewOutline()
        for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
            p.Append(int(x*1e6), int(y*1e6))
        return p

    a, b = square(0, 0, 2, 2), square(1, 0, 3, 2)
    result = copper.compare({("F.Cu", "GND"): a}, {("F.Cu", "GND"): b})["rows"][0]
    assert result["addedMm2"] == result["removedMm2"] == 2.0
    assert result["addedContours"] and result["removedContours"]
    u = square(0, 0, 2, 2); u.BooleanAdd(square(1, 0, 3, 2)); u.Simplify()
    assert abs(u.Area()/1e12 - 6) < 1e-9
    hole = square(0, 0, 4, 4); hole.BooleanSubtract(square(1, 1, 3, 3))
    assert len(copper.contours(hole)[0]) == 2
    assert not copper.compare({("F.Cu", "A"): square(0, 0, 1, 1)},
                              {("F.Cu", "A"): square(0, 0, 1.05, 1)})["rows"]
    # Strict threshold, deterministic rows, missing sides, and numeric-looking names.
    assert copper.collect("-") == {}
    assert copper.compare({}, {}) == {"rows": [], "incomplete": []}
    before = (a.Area(), b.Area())
    assert copper.compare({("F.Cu", "GND"): a}, {("F.Cu", "GND"): b})["rows"][0] == result
    assert (a.Area(), b.Area()) == before, "BR03 compare mutated input polygons"
    tiny = square(0, 0, 1.050001, 1)
    assert copper.compare({("F.Cu", "A"): square(0, 0, 1, 1)},
                          {("F.Cu", "A"): tiny})["rows"]
    polys = {("In1.Cu", "12"): square(-2, -1, 0, 0), ("F.Cu", ""): a}
    added = copper.compare({}, polys)
    removed = copper.compare(polys, {})
    assert [(r["layer"], r["net"]) for r in added["rows"]] == [("F.Cu", ""), ("In1.Cu", "12")]
    assert [r["addedMm2"] for r in added["rows"]] == [4.0, 2.0]
    assert all(r["removedMm2"] == 0 and not r["removedContours"] for r in added["rows"])
    assert [r["removedMm2"] for r in removed["rows"]] == [4.0, 2.0]
    assert all(r["addedMm2"] == 0 and not r["addedContours"] for r in removed["rows"])
    assert [-2.0, -1.0] in added["rows"][1]["addedContours"][0]
    # Coordinate budget spans every row and both signs; exact areas are unaffected.
    from unittest.mock import patch
    with patch.object(copper, "MAX_CONTOUR_POINTS", 4):
        bounded = copper.compare({}, polys)
        signed = copper.compare({("F.Cu", "GND"): a}, {("F.Cu", "GND"): b})["rows"][0]
    assert sum(len(c) for key in ("addedContours", "removedContours") for c in signed[key]) <= 4
    assert signed["truncated"] and signed["addedMm2"] == signed["removedMm2"] == 2.0
    assert copper.contours(a, 3) == ([], True)
    assert sum(len(c) for r in bounded["rows"] for key in ("addedContours", "removedContours")
               for c in r[key]) <= 4
    assert [r["addedMm2"] for r in bounded["rows"]] == [4.0, 2.0]
    assert bounded["rows"][1]["truncated"] and bounded["incomplete"]
    points, truncated = copper.contours(hole, 7)
    assert len(points) == 1 and truncated, "do not emit a partially cut contour"
    assert not result["truncated"]
    # Refill failures preserve actionable CLI diagnostics (and never reach LoadBoard).
    import pathlib
    import tempfile
    from unittest.mock import patch
    with tempfile.TemporaryDirectory(prefix="br03-refill-test-") as tmp:
        source = pathlib.Path(tmp) / "fixture.kicad_pcb"
        source.write_text("synthetic fixture path")
        failure = type("Run", (), {"returncode": 2, "stderr": "fixture CLI failure", "stdout": ""})()
        with patch.object(copper.subprocess, "run", return_value=failure):
            try:
                copper.refill_board(str(source))
            except RuntimeError as exc:
                assert "exit 2" in str(exc) and "fixture CLI failure" in str(exc)
            else:
                raise AssertionError("refill failure should retain CLI diagnostic")
    # Refill must actually update the copied board, not merely see its initial copy.
    with tempfile.TemporaryDirectory(prefix="br03-refill-save-test-") as tmp:
        source = pathlib.Path(tmp) / "fixture.kicad_pcb"
        source.write_text("stale")
        def silent_success(*args, **kwargs):
            assert kwargs["timeout"] == 120, "each revision needs an independent refill budget"
            target = pathlib.Path(args[0][-1])
            target.write_text("refilled")
            return type("Run", (), {"returncode": 0, "stderr": "", "stdout": ""})()
        fake_board = object()
        with patch.object(copper.subprocess, "run", side_effect=silent_success), patch.object(
                copper.pcbnew, "LoadBoard", return_value=fake_board):
            assert copper.refill_board(str(source)) is fake_board
        with patch.object(copper.subprocess, "run", return_value=type(
                "Run", (), {"returncode": 0, "stderr": "", "stdout": ""})()), patch.object(
                copper.pcbnew, "LoadBoard") as load_board:
            try:
                copper.refill_board(str(source))
            except RuntimeError as exc:
                assert "did not save" in str(exc)
            else:
                raise AssertionError("unchanged copied board must fail save verification")
            load_board.assert_not_called()
    # Hidden Reference/Value fields do not export copper; visible ones do.
    board = pcbnew.BOARD()
    footprint = pcbnew.FOOTPRINT(board)
    board.Add(footprint)
    fields = (footprint.Reference(), footprint.Value())
    for index, field in enumerate(fields):
        field.SetText("BR03")
        field.SetLayer(pcbnew.F_Cu)
        field.SetPosition(pcbnew.VECTOR2I(index * 10000000, 0))
        field.SetVisible(False)
    with patch.object(copper, "refill_board", return_value=board):
        assert copper.collect("fixture") == {}, "hidden fields must not contribute copper"
        for field in fields:
            field.SetVisible(True)
            original = copper.collect("fixture")
            assert original[("F.Cu", "")].Area() > 0
            board.SetLayerName(pcbnew.F_Cu, "Renamed front copper")
            renamed = copper.collect("fixture")
            assert set(renamed) == set(original) == {("F.Cu", "")}
            assert copper.compare(original, renamed)["rows"] == []
            field.SetVisible(False)
        fields[0].SetLayer(pcbnew.F_SilkS)
        fields[0].SetVisible(True)
        assert copper.collect("fixture") == {}, "non-copper fields must be ignored"
    # Identical bytes saved in the same coarse timestamp tick are still a save.
    with tempfile.TemporaryDirectory(prefix="br03-refill-coarse-time-test-") as tmp:
        source = pathlib.Path(tmp) / "fixture.kicad_pcb"
        source.write_text("unchanged")
        coarse_time = 1700000000
        os.utime(source, (coarse_time, coarse_time))
        source_stat = source.stat()
        def identical_save(*args, **kwargs):
            target = pathlib.Path(args[0][-1])
            target.write_bytes(source.read_bytes())
            os.utime(target, (coarse_time, coarse_time))
            return type("Run", (), {"returncode": 0, "stderr": "", "stdout": ""})()
        with patch.object(copper.subprocess, "run", side_effect=identical_save), patch.object(
                copper.pcbnew, "LoadBoard", return_value=fake_board):
            assert copper.refill_board(str(source)) is fake_board
        assert source.read_text() == "unchanged"
        assert source.stat().st_mtime_ns == source_stat.st_mtime_ns
    print("ok BR03 signed copper polygons")

from kicad_review import is_kicad_file, owner_project


def br02_png(width=1600, height=1000, *, channels=4, filter_type=0):
    """Real, tiny-compressed RGB(A) fixture; all PNG row filters, no image dependency."""
    import struct, zlib
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    pixel = bytes((31, 73, 119, 255)[:channels])
    row = pixel * width
    rows = []
    previous = bytes(len(row))
    for _ in range(height):
        filtered = bytearray()
        for i, value in enumerate(row) if filter_type else ():
            left = row[i-channels] if i >= channels else 0
            above = previous[i]
            corner = previous[i-channels] if i >= channels else 0
            p = left + above - corner
            distances = (abs(p-left), abs(p-above), abs(p-corner))
            paeth = (left, above, corner)[distances.index(min(distances))]
            predictor = (0, left, above, (left+above)//2, paeth)[filter_type]
            filtered.append((value-predictor) & 255)
        rows.append(bytes([filter_type]) + (filtered if filter_type else row))
        previous = row
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8,
            6 if channels == 4 else 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))

import copy, json, pathlib, tempfile
import kicad_review as kr

# FAB-04: waiver eligibility and DRC-scale coordinates.
settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
settings['fabrication']['check_limits'] = True
settings['checks']['fab_limits'] = 'required'
assert 'fab_limits' in kr.WAIVABLE, 'FAB-04 waiver parser accepts fab'
v = kr.violation({'type':'track_width','severity':'error','description':'too narrow',
                  'items':[{'uuid':'track','description':'track','pos':{'x':42.5,'y':20}}]},
                 1, {'board':True})
c = kr.run_check('fab_limits', settings, [v], None)
assert c['status'] == 'fail' and c['new_errors'] == 1 and c['fixed'] == 0
waivers = {'active':{('fab_limits',kr.waiver_key(v)):{'reason':'prototype','by':'reviewer',
            'until':'2026-12-31','ref':None}}}
c = kr.run_check('fab_limits', settings, [dict(v)], None, waivers)
assert c['waived'] == 1 and c['status'] == 'pass' and c['errors'] == 0
assert c['violations'][0]['pos'] == [42.5,20], 'FAB-04 DRC must not receive ERC scale'

# FAB-01: dated profiles, opt-in settings and copper coverage.
profiles = kr.fab_profiles()
assert len(profiles) == 12, "FAB-01 twelve exact profiles"
assert profiles["jlcpcb-2l"]["values"]["holeToHoleViaMm"] == .2
assert profiles["pcbway-std"]["values"]["drillPlatedMaxMm"] == 6
assert all(p["checkedOn"] >= "2026-10-24" and p["source"].startswith("https://")
           for p in profiles.values()), "FAB-01 dated provenance (Task 8 may later move the three sign-off profiles to a newer date)"
# FAB-08: refresh only the three sign-off profiles from current vendor pages.
FRESH_VENDOR_PROFILES = ('jlcpcb-2l', 'jlcpcb-multilayer', 'pcbway-std')
FRESH_VENDOR_SOURCES = {'https://jlcpcb.com/capabilities/pcb-capabilities',
                        'https://www.pcbway.com/capabilities.html'}
profiles = kr.fab_profiles()
for key in FRESH_VENDOR_PROFILES:
    assert profiles[key]['checkedOn'] >= '2026-10-26', key + ' still has the study date'
    assert profiles[key]['source'] in FRESH_VENDOR_SOURCES, key + ' cites an unlisted page'
assert all(profiles[k]['checkedOn'] == '2026-10-24' for k in profiles if k not in FRESH_VENDOR_PROFILES), 'other nine profiles keep the study date'
# Published changes are asserted; unverified study assumptions are recorded, not pinned.
assert all(profiles[k]['values']['drillPlatedMinMm'] == .15 for k in FRESH_VENDOR_PROFILES)
assert profiles['pcbway-std']['values']['holeToHoleMm'] == .45
assert 'holeToHoleViaMm' not in profiles['pcbway-std']['values']

assert kr.DEFAULT_SETTINGS["fabrication"]["check_limits"] is False
assert kr.DEFAULT_SETTINGS["checks"]["fab_limits"] == "informational"
with tempfile.TemporaryDirectory() as td:
    pcb = pathlib.Path(td, "four.kicad_pcb")
    pcb.write_text(pathlib.Path("ui/fixtures/vf-order-4.kicad_pcb").read_text())
    sections = {s["vendor"]: s for s in kr.fab_context(pcb)}
    assert (sections["jlcpcb"]["profile"], sections["jlcpcb"]["layers"], sections["jlcpcb"]["unsupported"]) == ("jlcpcb-multilayer", 4, None)
    assert (sections["pcbway"]["profile"], sections["pcbway"]["unsupported"]) == ("pcbway-std", None), "FAB-01 PCBWay checked on 4 layers"
    assert sections["jlcpcb"]["coverageWarnings"] == [], "FAB-01 explicit standard copper has no warning"
    pcb.write_text(pcb.read_text().replace('(thickness 0.035)', '', 1))
    assert all(any("thickness unknown" in x for x in s["coverageWarnings"]) for s in kr.fab_context(pcb)), "FAB-01 missing thickness is unknown in both sections"
    pcb.write_text('(kicad_pcb (layers (0 "F.Cu" signal)))')
    assert all(s["unsupported"] for s in kr.fab_context(pcb)), "FAB-01 unsupported is not pass in both sections"
    pcb.write_text('(kicad_pcb (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) '
                   '(setup (stackup (layer "F.Cu" (thickness 0.07)) '
                   '(layer "B.Cu" (thickness 0.035)))))')
    assert all(any("0.07" in x for x in s["coverageWarnings"]) for s in kr.fab_context(pcb))

with tempfile.TemporaryDirectory() as td:
    base, head = pathlib.Path(td, 'base'), pathlib.Path(td, 'head')
    base.mkdir(); head.mkdir()
    (base / kr.SETTINGS_FILE).write_text('[fabrication]\ncheck_limits = true\n')
    (head / kr.SETTINGS_FILE).write_text('[fabrication]\ncheck_limits = false\n')
    assert kr.load_settings((str(base), str(head)))['fabrication']['check_limits'] is True
    for toml, message in (
        ('[fabrication]\ncheck_limits = "true"\n', f'{kr.SETTINGS_FILE}: fabrication.check_limits must be true or false'),
        ('[fabrication]\ncheck_limits = true\n[checks]\ndrc = "off"\n', f'{kr.SETTINGS_FILE}: fabrication.check_limits requires checks.drc != "off"'),
        ('[fabrication]\ncheck_limits = 1\n', f'{kr.SETTINGS_FILE}: fabrication.check_limits must be true or false'),
        ('[checks]\nfab_limits = "banana"\n', f"{kr.SETTINGS_FILE}: checks.fab_limits = 'banana'; expected one of {', '.join(kr.CHECK_NAMES)} = required/informational/off")):
        (base / kr.SETTINGS_FILE).write_text(toml)
        try:
            kr.load_settings((str(base),))
            raise AssertionError('FAB-01 invalid setting accepted')
        except SystemExit as exc:
            assert str(exc) == message

print("ok FAB-01 profiles, copper coverage and settings")

# FAB-02: owned bytes, grouped bounds and one-to-one raw DRC subtraction.
raw = lambda ids: {"type": "track_width", "severity": "error", "description": "minimum changed",
                   "items": [{"uuid": u, "description": u} for u in ids]}
a, reverse = raw(["a", "b"]), raw(["b", "a"])
assert kr.fab_subtract([a, reverse, a], [reverse]) == [reverse, a], "FAB-02 multiset, not set"
no_uuid = {"type": "clearance", "items": [{"description": "Pad 1 of R1"}]}
assert kr.fab_subtract([no_uuid, no_uuid], [no_uuid]) == [no_uuid]
assert kr.fab_subtract([raw(["other"])], [a]) == [raw(["other"])]
assert kr.fab_subtract([a, a], [a, a]) == []
assert kr.fab_identity(a) == kr.fab_identity({**reverse, "description": "different numeric minimum"})
assert kr.fab_identity(a) != kr.fab_identity({**a, "type": "clearance"})
one = {"type": "clearance", "items": [{"description": "pad", "pos": {"x": 1, "y": 2}}]}
two = {"type": "clearance", "items": [{"description": "pad", "pos": {"x": 9, "y": 2}}]}
assert kr.fab_subtract([one, two], [one]) == [two]
partial = {"type": "clearance", "items": [{"uuid": "a", "description": "pad"}, {"description": "via"}]}
assert kr.fab_identity(partial) == kr.fab_identity({**partial, "items": partial["items"][::-1]})
assert kr.fab_identity(partial) != kr.fab_identity({**partial, "items": [{"uuid": "b", "description": "pad"}, {"description": "via"}]})
assert kr.fab_identity({"type": "clearance", "description": "first"}) != kr.fab_identity({"type": "clearance", "description": "second"})
original = '(version 1)\n# team rules\n(rule "house" (constraint track_width (min .3mm)))\n'
merged = kr.fab_owned_rules(original, '(rule "fab test" (constraint track_width (min .1mm)))')
assert original in merged and kr.fab_owned_rules(merged, 'new-section').count('new-section') == 1
assert kr.fab_owned_rules(merged, 'new-section').startswith(original)
for malformed in (original + kr.FAB_START + '\n', kr.FAB_END + kr.FAB_START,
                  kr.FAB_END, kr.FAB_START + kr.FAB_END + kr.FAB_START + kr.FAB_END):
    try:
        kr.fab_owned_rules(malformed, '')
        raise AssertionError('FAB-02 malformed markers accepted')
    except ValueError:
        pass
owned = original + kr.FAB_START + '\nold\n' + kr.FAB_END + '\n# after\n'
assert kr.fab_owned_rules(owned, 'new') == original + kr.FAB_START + '\nnew\n' + kr.FAB_END + '\n# after\n'
assert kr.fab_owned_rules('', '') == kr.fab_owned_rules(kr.fab_owned_rules('', ''), '')
context = {"layers": 2, "values": kr.fab_profiles()["jlcpcb-2l"]["values"]}
rules, unchecked = kr.fab_rule_section(context)
assert '(layer outer)' in rules and '(layer inner)' not in rules
assert '(max 6.3mm)' in rules and 'holeToHoleMixedMm' in unchecked
assert 'trackWidthInnerMm' not in unchecked, "FAB-02 inner does not apply on 2 layers"
hole_rules = [line for line in rules.splitlines() if 'constraint hole_size' in line and '(max' in line]
assert len(hole_rules) == 1 and '(min 0.15mm)' in hole_rules[0] and '(max 6.3mm)' in hole_rules[0]
assert 'viaDiameterMinMm' in unchecked
four_rules, four_unchecked = kr.fab_rule_section({"layers": 4, "values": kr.fab_profiles()["jlcpcb-multilayer"]["values"]})
assert '(layer inner)' in four_rules and 'trackWidthInnerMm' not in four_unchecked
_, missing_inner = kr.fab_rule_section({"layers": 4, "values": context["values"]})
assert 'trackWidthInnerMm' in missing_inner and 'clearanceInnerMm' in missing_inner
vendor_rules, covered = kr.fab_vendor_rules(context)
assert 'via_diameter' not in covered and 'track_width' in covered
assert covered == {'track_width', 'clearance', 'drill_out_of_range', 'annular_width',
                   'copper_edge_clearance', 'hole_to_hole'}
assert vendor_rules.index('fab neutral track_width') < vendor_rules.index('fab track_width')
assert vendor_rules.endswith(rules)
assert '(rule "fab neutral hole_size" (constraint hole_size (min 0mm) (max 1000000mm)))' in vendor_rules
empty_rules, empty_covered = kr.fab_vendor_rules({"layers": 2, "values": {}})
assert empty_covered == set() and empty_rules.count('(rule "fab neutral ') == 7
print("ok FAB-02 owned rules, grouping, multiset identity and attribution categories")

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

# Image exports discover declared layers regardless of whitespace or declaration layout.
import pathlib
from tempfile import TemporaryDirectory
from unittest.mock import patch
import kicad_review as kr

# Comparison resources preserve source paint and transparency; filtering happens inside the image.
s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path stroke="#009600" fill="none" d="M 1 1 L 2 2"/></svg>'
t = kr.comparison_svg(s, 'base', schematic=True)
assert '0 0 0 0 0.85' in t and 'fill="none"' in t
assert 'filterUnits="userSpaceOnUse"' in t and 'width="100.0"' in t and 'height="100.0"' in t
assert '-.3 -.59 -.11 1 0' in t and '<script' not in t
for side, first in (('base', '0.85'), ('head', '0.1')):
    for schematic in (False, True):
        text = kr.comparison_svg(s, side, schematic)
        assert '0 0 0 0 ' + first in text
        assert ('-.3 -.59 -.11 1 0' if schematic else '0 0 0 1 0') in text
# Definitions and metadata stay outside the single filtered artwork group.
import xml.etree.ElementTree as ET
source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><path id="shape" d="M0 0h1"/></defs><title>Artwork</title><use href="#shape"/></svg>'
root = ET.fromstring(kr.comparison_svg(source, 'base'))
assert [c.tag.rsplit('}', 1)[-1] for c in root] == ['defs', 'title', 'defs', 'g']
assert root[-1][0].get('href') == '#shape'
expected = kr.comparison_svg(source, 'head', True)
assert '<svg' in expected and 'xmlns="http://www.w3.org/2000/svg"' in expected
assert kr.comparison_svg(source, 'head', True) == expected
# A layer can contain only a horizontal/vertical stroke: its artwork bbox has zero area.
for path in ('M 10 60 H 250', 'M 100 -10 V 150'):
    source = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -30 300 200"><path d="{path}" stroke="black" stroke-width="20" fill="none"/></svg>'
    root = ET.fromstring(kr.comparison_svg(source, 'base'))
    filt = root.find('.//{http://www.w3.org/2000/svg}filter')
    assert filt.get('filterUnits') == 'userSpaceOnUse'
    assert [float(filt.get(key)) for key in ('x', 'y', 'width', 'height')] == [-20, -30, 300, 200]
source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text data-note="keep ns0:attribute">keep ns0:text</text></svg>'
root = ET.fromstring(kr.comparison_svg(source, 'base'))
label = root.find('.//{http://www.w3.org/2000/svg}text')
assert label.text == 'keep ns0:text' and label.get('data-note') == 'keep ns0:attribute'
print('ok image comparison source matrix, retained definitions, filter bounds and namespace content')

four = pathlib.Path('ui/fixtures/vf-order-4.kicad_pcb')
assert kr.board_layers(str(four)) == ['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu']
with TemporaryDirectory() as d:
    p = pathlib.Path(d, 'four.kicad_pcb')
    p.write_text(four.read_text().replace('(layers ', '(layers\n '))
    assert kr.board_layers(str(p)) == kr.board_layers(str(four))
    with patch('kicad_review.kicad_cli') as cli, patch.object(kr, 'export_board_stats'):
        kr.render_side(d, 'four', str(pathlib.Path(d, 'out')))
    svg_call = next(c.args for c in cli.call_args_list if c.args[:3] == ('pcb', 'export', 'svg'))
    layer_flag = '--layers' if '--layers' in svg_call else '-l'
    assert svg_call[svg_call.index(layer_flag) + 1] == 'B.Cu,In2.Cu,In1.Cu,F.Cu'
print('ok image export layer discovery')

# Only plain, absolutely-started stroke runs may join; preserve metadata and custom paint.
import xml.etree.ElementTree as ET
svg = '<svg xmlns="http://www.w3.org/2000/svg"><g style="fill:none"><path d="M 0 0 L 1 1"/><desc>x</desc><path d="M 1 1 L 2 2"/><path d="m 3 3 l 1 1"/><path transform="translate(1)" d="M 0 0"/></g><g fill="#abcdef"><path d="M 0 0"/><path d="M 1 1"/></g></svg>'
out = ET.fromstring(kr.simplify_sheet_svg(svg))
ns = {'s': 'http://www.w3.org/2000/svg'}
assert len(out.findall('.//s:path', ns)) == 5
assert out.findall('.//s:path', ns)[0].get('d') == 'M 0 0 L 1 1 M 1 1 L 2 2'
assert out.findall('.//s:g', ns)[1].get('fill') == '#abcdef'
assert out.find('.//s:desc', ns).text == 'x'
assert out.findall('.//s:path', ns)[1].get('d') == 'm 3 3 l 1 1'
assert out.findall('.//s:path', ns)[2].get('transform') == 'translate(1)'
inherited = '<svg xmlns="http://www.w3.org/2000/svg" fill="none"><g stroke="#abcdef"><path d="M0 0"/><path d="M1 1"/><circle r="1"/><path d="M2 2"/><path d="M3 3"/></g><g style="fill:#123456"><path d="M0 0"/><path d="M1 1"/></g></svg>'
out = ET.fromstring(kr.simplify_sheet_svg(inherited))
assert [p.get('d') for p in out.findall('.//s:path', ns)] == ['M0 0 M1 1', 'M2 2 M3 3', 'M0 0', 'M1 1']
assert out.find('.//s:circle', ns).get('r') == '1'
assert out.findall('.//s:g', ns)[0].get('stroke') == '#abcdef'
assert out.findall('.//s:g', ns)[1].get('style') == 'fill:#123456'
assert kr.simplify_sheet_svg(kr.simplify_sheet_svg(svg)) == kr.simplify_sheet_svg(svg)

# Separate translucent strokes composite twice at overlaps; a compound path paints once.
plain_pair = '<path d="M0 0 L10 0"/><path d="M0 0 L10 0"/>'
for paint in ('stroke="red" stroke-opacity="0.5"',
              'style="stroke:red;stroke-opacity:50%"',
              'stroke="rgba(255,0,0,0.5)"', 'stroke="#ff000080"',
              'stroke="currentColor"', 'stroke="url(#paint)"',
              'stroke="red" opacity="0.5"', 'stroke="red" filter="url(#blur)"',
              'stroke="red" mask="url(#mask)"', 'stroke="red" marker-end="url(#arrow)"',
              'style="stroke:red;mix-blend-mode:multiply"',
              'style="stroke:red;/* inherited alpha */stroke-opacity:.5"',
              'stroke="red" stroke-dasharray="1 2"'):
    unsafe = f'<svg xmlns="{ns["s"]}" fill="none"><g {paint}><g>{plain_pair}</g></g></svg>'
    optimized = ET.fromstring(kr.simplify_sheet_svg(unsafe))
    assert len(optimized.findall('.//s:path', ns)) == 2, paint
    assert [p.get('d') for p in optimized.findall('.//s:path', ns)] == ['M0 0 L10 0'] * 2
    assert kr.simplify_sheet_svg(kr.simplify_sheet_svg(unsafe)) == kr.simplify_sheet_svg(unsafe)
# CSS may target otherwise plain paths; do not infer paint from presentation attributes alone.
css_svg = f'<svg xmlns="{ns["s"]}"><style>path {{ stroke-opacity: .5 }}</style><g fill="none" stroke="red">{plain_pair}</g></svg>'
assert len(ET.fromstring(kr.simplify_sheet_svg(css_svg)).findall('.//s:path', ns)) == 2
animated_svg = f'<svg xmlns="{ns["s"]}"><g fill="none" stroke="red">{plain_pair}<animate attributeName="stroke-opacity" values="1;.5" dur="1s"/></g></svg>'
assert len(ET.fromstring(kr.simplify_sheet_svg(animated_svg)).findall('.//s:path', ns)) == 2
opaque_svg = f'<svg xmlns="{ns["s"]}" fill="none" stroke="#ff0000" stroke-opacity="1.0000"><g>{plain_pair}</g></svg>'
assert len(ET.fromstring(kr.simplify_sheet_svg(opaque_svg)).findall('.//s:path', ns)) == 1
stroked_text_svg = f'<svg xmlns="{ns["s"]}" fill="none" stroke="#840000" stroke-opacity="1"><g class="stroked-text"><desc>1</desc>{plain_pair}</g><g class="custom">{plain_pair}</g></svg>'
assert [len(g.findall('s:path', ns)) for g in ET.fromstring(kr.simplify_sheet_svg(stroked_text_svg)).findall('s:g', ns)] == [1, 2]
print('ok image export inherited compositing safety')
assert kr.IMAGE_EXPORT_OPTIONS == {'page_size_mode': '1', 'drill_shape_opt': '0',
                                   'check_zones': True, 'themes': ['light', 'dark']}
print('ok image export contracts')

# Optional revision statistics publish only validated, successful output, never stale/partial files.
import json
import subprocess
for mode in ('ok', 'nonzero', 'missing', 'malformed', 'nonobject', 'timeout', 'unavailable'):
    with TemporaryDirectory() as d:
        root = pathlib.Path(d)
        for name in ('stats.json', 'stats.pending.json', 'stats.json.error'):
            (root / name).write_text('stale')
        def stats_run(command, **kwargs):
            assert command[:8] == ['kicad-cli', 'pcb', 'export', 'stats', '--format', 'json', '--units', 'mm']
            assert kwargs == {'capture_output': True, 'text': True, 'timeout': 60}
            pending = pathlib.Path(command[command.index('-o') + 1])
            assert pending == root / 'stats.pending.json' and command[-1] == 'P.kicad_pcb'
            assert not (root / 'stats.json').exists() and not pending.exists()
            if mode == 'timeout':
                pending.write_text('{}')
                raise subprocess.TimeoutExpired(command, 60)
            if mode == 'unavailable':
                raise FileNotFoundError('kicad-cli unavailable')
            if mode != 'missing':
                pending.write_text('{broken' if mode == 'malformed' else '[]' if mode == 'nonobject' else '{"board":{}}')
            return subprocess.CompletedProcess(command, 1 if mode == 'nonzero' else 0, stdout='', stderr='stats failed')
        with patch.object(kr.subprocess, 'run', side_effect=stats_run) as run:
            error = kr.export_board_stats('P.kicad_pcb', d)
        assert run.call_count == 1
        assert not (root / 'stats.pending.json').exists()
        if mode == 'ok':
            assert error is None and json.loads((root / 'stats.json').read_text()) == {'board': {}}
            assert not (root / 'stats.json.error').exists()
        else:
            assert error and not (root / 'stats.json').exists()
            assert (root / 'stats.json.error').read_text() == error
            assert '\n' not in error and len(error) <= 1000
            if mode == 'nonzero':
                assert 'stats failed' in error
print('ok optional atomic board statistics: seven outcomes')

# Named export themes come from the entire canonical palette, with no runtime Node dependency.
import os
with TemporaryDirectory() as d:
    kr.write_image_themes(d)
    for theme in ('light', 'dark'):
        data = json.loads(pathlib.Path(d, '10.0/colors', f'kicad-review-{theme}.json').read_text())
        assert data['meta'] == {'name': 'kicad-review-' + theme, 'version': 5}
        assert data['board']['copper']['f'] == 'rgb(200, 52, 52)'
        assert data['schematic']['wire'] == 'rgb(0, 150, 0)'
        for key, rgba in kr.IMAGE_PALETTES[theme]['colors'].items():
            value = data
            for part in key.split('.'):
                value = value[part]
            assert value == 'rgb(%d, %d, %d)' % tuple(round(v * 255) for v in rgba[:3])
canonical = subprocess.check_output(['node', '--input-type=module', '-e',
    'import fs from "node:fs";import vm from "node:vm";const c=vm.createContext({});'
    'vm.runInContext(fs.readFileSync("ui/kicad-colors.js","utf8"),c);'
    'console.log(JSON.stringify(c.KicadColors))'], text=True)
colors = json.loads(canonical)
assert set(kr.IMAGE_PALETTES) == {'light', 'dark'}
for theme, palette in kr.IMAGE_PALETTES.items():
    assert palette['colors'] == colors['themeDefaults'], 'canonical image palette drift'
    assert palette['sourceRGB'] == {layer: [round(v * 255) for v in colors['themeDefaults'][key][:3]]
                                    for layer, key in colors['layerThemeKeys'].items()}, 'canonical image palette drift'
with patch.object(kr, 'kicad_cli') as cli, patch.object(kr.os.path, 'exists', return_value=True), \
     patch.object(kr, 'board_layers', return_value=['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']), \
     patch.object(kr, 'sheet_pages', return_value=[]), \
     patch.object(kr, 'export_board_stats', return_value=None) as stats_export, \
     patch.object(kr, 'export_netlist') as netlist_export:
    with TemporaryDirectory() as d:
        kr.render_side(d, 'H', d, netlist=True)
        stats_export.assert_called_once_with(f'{d}/H.kicad_pcb', d)
        netlist_export.assert_called_once_with(f'{d}/H.kicad_sch', d)  # bounded soft export, outside the theme loop
    commands = [call.args for call in cli.call_args_list]
    sheets = [c for c in commands if c[:3] == ('sch', 'export', 'svg')]
    boards = [c for c in commands if c[:3] == ('pcb', 'export', 'svg')]
    assert len(sheets) == len(boards) == 2
    for theme, sch, pcb in zip(('light', 'dark'), sheets, boards):
        for c in (sch, pcb):
            assert c[c.index('--theme') + 1] == 'kicad-review-' + theme
        assert '--no-background-color' in sch and '--exclude-drawing-sheet' not in sch
        assert '--mode-multi' in pcb and '--check-zones' in pcb and '--exclude-drawing-sheet' in pcb
        assert pcb[pcb.index('--layers') + 1] == 'F.Cu,In1.Cu,In2.Cu,B.Cu'
        assert pcb[pcb.index('--page-size-mode') + 1] == '1'
        assert pcb[pcb.index('--drill-shape-opt') + 1] == '0'
    assert sum(c[:2] == ('sch', 'erc') for c in commands) == 1
    assert sum(c[:2] == ('pcb', 'drc') and '--schematic-parity' in c for c in commands) == 1
    assert not any(c[:3] == ('sch', 'export', 'netlist') for c in commands), 'netlist export is not fatal'
    assert not any(c[:3] == ('pcb', 'export', 'stats') for c in commands), 'no fatal or duplicate statistics export'
print('ok canonical image palettes and dual-theme exports')

# Repeated source sheets resolve by instance UUID path; simplify each theme, restore private config even on failure.
for failure in (None, 'missing-light', 'missing-dark', 'ambiguous', 'cli'):
    for prior in (None, '/existing-kicad-config'):
        with TemporaryDirectory() as d, patch.dict(os.environ):
            if prior is None:
                os.environ.pop('KICAD_CONFIG_HOME', None)
            else:
                os.environ['KICAD_CONFIG_HOME'] = prior
            root = pathlib.Path(d)
            (root / 'H.kicad_sch').write_text('(kicad_sch (uuid root) '
                '(sheet (uuid a) (property "Sheetname" "One") (property "Sheetfile" "shared.kicad_sch")) '
                '(sheet (uuid b) (property "Sheetname" "Two") (property "Sheetfile" "shared.kicad_sch")))')
            (root / 'shared.kicad_sch').write_text('(kicad_sch)')
            pages = kr.sheet_pages(d, 'H')
            assert [p['path'] for p in pages] == ['/', '/a/', '/b/']
            if failure == 'ambiguous':
                pages[2]['stem'] = pages[1]['stem']
            configs = []
            raw = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="red"><path d="M0 0"/><path d="M1 1"/></svg>'
            def image_cli(*command):
                if command[:3] != ('sch', 'export', 'svg'):
                    return
                cfg = pathlib.Path(os.environ['KICAD_CONFIG_HOME'])
                configs.append(cfg)
                assert (cfg / '10.0/colors/kicad-review-light.json').is_file()
                if failure == 'cli':
                    raise SystemExit('export failed')
                dest = pathlib.Path(command[command.index('-o') + 1])
                dest.mkdir(parents=True, exist_ok=True)
                for page in pages:
                    if page['path'] == '/b/' and failure == ('missing-dark' if dest.name == 'sch-dark' else 'missing-light'):
                        continue
                    (dest / (page['stem'] + '.svg')).write_text(raw)
            with patch.object(kr, 'kicad_cli', side_effect=image_cli), patch.object(kr, 'sheet_pages', return_value=pages):
                try:
                    kr.render_side(d, 'H', str(root / 'out'))
                    assert failure is None, 'missing/ambiguous export must fail'
                except (ValueError, SystemExit):
                    assert failure is not None
            assert os.environ.get('KICAD_CONFIG_HOME') == prior
            assert configs and all(not cfg.exists() for cfg in configs)
            if failure is None:
                mapping = json.loads((root / 'out/sheet-images.json').read_text())
                assert mapping == {p['path']: {theme: f"sch{suffix}/{p['stem']}.svg"
                    for theme, suffix in (('light', ''), ('dark', '-dark'))} for p in pages}
                for themes in mapping.values():
                    for relative in themes.values():
                        assert len(ET.fromstring((root / 'out' / relative).read_text()).findall('.//s:path', ns)) == 1
print('ok instance image mappings, missing/ambiguous exports and config cleanup')

# Image cache identity covers renderer, complete palettes/options and declared layers; host restore never runs KiCad.
# CI exports KICAD_IMAGE job-wide, so the 3D tool identity needs no host kicad-cli probe.
with TemporaryDirectory() as d, patch.object(kr, 'IMAGE_RENDERER', 'verified-10.0.6'), \
     patch.dict(os.environ, {'KICAD_IMAGE': 'kicad/kicad:10.0.6-full@sha256:synthetic'}):
    previous = os.getcwd()
    try:
        os.chdir(d)
        p = {'dir': 'demo', 'name': 'H', 'status': 'modified'}
        det = {'base': 'a' * 40, 'head': 'b' * 40, 'projects': [p]}
        settings = json.loads(json.dumps(kr.DEFAULT_SETTINGS))
        before = kr.render_cache(p, 'head', det, settings)
        with patch.object(kr, 'IMAGE_EXPORT_OPTIONS', {**kr.IMAGE_EXPORT_OPTIONS, 'page_size_mode': '2'}):
            assert kr.render_cache(p, 'head', det, settings) != before, 'cache ignored image options'
        palette = json.loads(json.dumps(kr.IMAGE_PALETTES))
        palette['light']['colors']['schematic.wire'] = [1, 0, 0, 1]
        with patch.object(kr, 'IMAGE_PALETTES', palette):
            assert kr.render_cache(p, 'head', det, settings) != before, 'cache ignored image palette'
        with patch.object(kr, 'IMAGE_RENDERER', 'verified-10.0.0'):
            assert kr.render_cache(p, 'head', det, settings) != before, 'cache ignored renderer'
        pcb = pathlib.Path(kr.board_path(p, 'head'))
        pcb.parent.mkdir(parents=True)
        pcb.write_text('(kicad_pcb (layers (0 "F.Cu" signal)))')
        assert kr.render_cache(p, 'head', det, settings) != before, 'cache ignored declared layers'
        assert kr.image_export_identity(p, 'head')['layers'] == ['F.Cu']
        pathlib.Path('review').mkdir()
        pathlib.Path('review/detect.json').write_text(json.dumps(det))
        for side in ('base', 'head'):
            cache = kr.render_cache(p, side, det, settings)
            cache.mkdir(parents=True)
            marker = cache / '.complete'
            for invalid in ('complete', '{broken', 'null', '{}'):
                marker.write_text(invalid)
                assert not kr.image_cache_complete(cache, p, side), 'legacy/malformed identity accepted'
            marker.write_text(json.dumps(kr.image_export_identity(p, side), sort_keys=True))
            assert kr.image_cache_complete(cache, p, side)
            with patch.object(kr, 'IMAGE_RENDERER', 'local-unverified'):
                marker.write_text(json.dumps(kr.image_export_identity(p, side), sort_keys=True))
                assert not kr.image_cache_complete(cache, p, side), 'unverified local renderer reused cache'
            marker.write_text(json.dumps(kr.image_export_identity(p, side), sort_keys=True))
            (cache / 'proof.txt').write_text(side)
        with patch.object(kr, 'load_settings', return_value=settings), \
             patch.object(kr, 'kicad_cli', side_effect=AssertionError('host CLI forbidden')), \
             patch.object(kr.subprocess, 'run', side_effect=AssertionError('host subprocess forbidden')):
            kr.restore_renders()
        for side in ('base', 'head'):
            assert pathlib.Path('review', kr.project_id('demo'), side, 'proof.txt').read_text() == side
    finally:
        os.chdir(previous)
print('ok complete image cache fingerprint and CLI-free warm restore')

# S-expression parsing: quoted strings with escapes, nesting.
n = parse_sexpr('(a (b "x \\"y\\" z") (c 1 2))')
assert find(n, "b") == ["b", 'x "y" z'] and find(n, "c") == ["c", "1", "2"]
import json
import pickle
from kicad_review import Quoted, is_net_number
from kicad_review import compact_bom_lines

_l = {"value": "1k", "footprint": "F", "lcsc": None, "mpn": "M", "manufacturer": None, "datasheet": None, "category": "Resistors", "key": "k", "refs": ["R1"], "problems": []}
_slim = {"value": "1k", "footprint": "F", "mpn": "M", "category": "Resistors", "refs": ["R1"], "problems": []}
_in = {"projects": [{"parts": {"lines": [_l], "changes": [{"action": "added", "refs": ["R1"], "before": None, "after": _l},
                                                         {"action": "removed", "refs": ["R1"], "before": _l, "after": None}], "exports": {"csv": "x"}}},
                    {"name": "no parts"}],
       "bom": {"error": "Combined BOM unavailable", "lines": [], "exports": None}}
_out = compact_bom_lines(_in)
assert _out["projects"][0]["parts"]["lines"] == [_slim] and _out["projects"][0]["parts"]["exports"] == {"csv": "x"}
assert [(c["before"], c["after"]) for c in _out["projects"][0]["parts"]["changes"]] == [(None, _slim), (_slim, None)], "added/removed sides"
assert _out["projects"][1] == {"name": "no parts"}, "a project without parts is untouched"
assert _out["bom"] == _in["bom"], "repo BOM error case keeps its shape"
assert "key" in _l and _l["lcsc"] is None and "bom" not in compact_bom_lines({"projects": []}), "input is not mutated; no bom stays absent"
print("ok compact_bom_lines")
numeric_tokens = parse_sexpr('(net "12" 12)')
assert numeric_tokens == ['net', '12', '12']
assert isinstance(numeric_tokens[1], Quoted) and not is_net_number(numeric_tokens[1])
assert is_net_number(numeric_tokens[2])
assert len(set(numeric_tokens[1:])) == 1 and {numeric_tokens[1]: 'name'}['12'] == 'name'
assert json.dumps(numeric_tokens) == '["net", "12", "12"]'
restored_tokens = pickle.loads(pickle.dumps(numeric_tokens))
assert restored_tokens == numeric_tokens and isinstance(restored_tokens[1], Quoted)
assert not is_net_number(restored_tokens[1]) and is_net_number(restored_tokens[2])
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
import re
html = inline_page("window.REVIEW_DATA = {\"version\": 1};")
assert 'href="tokens.css"' not in html and 'href="review.css"' not in html and 'src="review.js"' not in html and 'src="sample/' not in html
assert "window.REVIEW_DATA = {\"version\": 1};" in html and "<style>" in html
assert "http://" not in html and "https://fonts" not in html
for asset in ('board-gl.js', 'appearance-state.js', 'appearance.js', 'board-marks.js', 'board-diff.js'):
    assert not re.search(r'''(?:src|href)=["']''' + re.escape(asset), html), asset
assert 'globalThis.ImageView' in inline_page('window.REVIEW_DATA={};')
assert 'window.BoardMarks' in html and 'window.BoardDiff' in html
assert html.index('window.BoardMarks') < html.index('window.BoardDiff') < html.index('const D = window.REVIEW_DATA')
assert not re.search(r'<script[^>]+src=', html)
assert html.count('window.ThreeStudio=') == 1 and 'function normalizeLighting(value)' in html
assert html.index('window.ThreeStudio=') < html.index('const D = window.REVIEW_DATA')
assert 'src="appearance-state.js"' not in html
assert 'function createStore(' in html
assert html.index('function createStore(') < html.index('const D = window.REVIEW_DATA')
# Theme import/reset and defaults must work from the standalone file, not fetch fixtures.
from html.parser import HTMLParser
class InlineAppearanceAssets(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            assert not attrs.get('src'), ('external script', attrs)
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            assert not attrs.get('href'), ('external stylesheet', attrs)
InlineAppearanceAssets().feed(html)
assert html.index('window.KicadColors') < html.index('function createStore(')
assert html.index('function createStore(') < html.index('const stores = new Map()')
assert 'data-appearance-file' in html and 'data-appearance-reset' in html
assert 'fixtures/themes/' not in html
assert 'src="theme.js"' not in html
assert "kr.theme" in html and "window.KRTheme" in html
assert html.index("kr.theme") < html.index("<style>")
assert '<!-- KR_ICONS -->' not in html
assert 'id="kr-zoom-in-dark"' in html and 'id="kr-theme"' in html
assert 'href="icons/' not in html and 'src="icons/' not in html
assert 'CC-BY-SA-4.0' in html
for name in ('zoom_in.svg', 'zoom_out.svg', 'zoom_fit_in_page.svg'):
    assert name in open('ui/icons/LICENSE', encoding='utf-8').read()
assert 'builtin_color_themes.h:160' in open('NOTICE', encoding='utf-8').read()
assert "data-theme-toggle" in html
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
# BOM downloads deliberately use typeof to reject unavailable export strings.
# Only expected runtime type checks remain; reject stray typeof scaffolding.
allowed_typeof = ('typeof x.fab === "string"', 'typeof x[kind] !== "string"',
                  "typeof D.blobs?.[id] !== 'string'",
                  "typeof v === 'object'", "typeof v === 'string'",
                  "typeof v === 'number' && Number.isFinite(v)", "typeof v === 'number' ? finite(v)",
                  "typeof o.hidden === 'boolean'", "typeof m.truncated[k] === 'boolean'")
scaffolding_js = js
for guard in allowed_typeof:
    assert js.count(guard) == 1, f"allowlisted guard must occur exactly once: {guard}"
    scaffolding_js = scaffolding_js.replace(guard, "")
assert "typeof " not in scaffolding_js and "const KEYS" not in js and "markersFor(view);" not in js and "Task 5" not in js, "leftover scaffolding"
assert "docs/superpowers" not in js and "docs/superpowers" not in readme, "plan paths stay out of shipped assets"
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
# Sibling sheets with one name share one SVG file: warn and skip the later sibling.
write(t, {"p/H.kicad_sch": "(kicad_sch " + sheet("A", "a.kicad_sch", "u1") + sheet("A", "b.kicad_sch", "u2") + ")"})
import io, contextlib
err = io.StringIO()
with contextlib.redirect_stderr(err):
    dup_pages = sheet_pages(f"{t}/p", "H")
assert [p["name"] for p in dup_pages] == ["H"], dup_pages
assert "collides with another sheet using sanitized name 'A'; all colliding sibling sheets skipped" in err.getvalue()
# Three siblings sharing one sanitized name: the warning must not say "both".
write(t, {"p3/H.kicad_sch": "(kicad_sch " + sheet("A/B", "a.kicad_sch", "u1") + sheet("A_B", "b.kicad_sch", "u2")
          + sheet("A\\\\B", "c.kicad_sch", "u3") + ")"})
err = io.StringIO()
with contextlib.redirect_stderr(err):
    tri_pages = sheet_pages(f"{t}/p3", "H")
assert [p["name"] for p in tri_pages] == ["H"], tri_pages
tri_lines = [l for l in err.getvalue().splitlines() if "sanitized name 'A_B'" in l]
assert len(tri_lines) == 3 and all(l.startswith("::warning::") and l.endswith("; all colliding sibling sheets skipped")
                                   for l in tri_lines), err.getvalue()
assert "both" not in err.getvalue(), err.getvalue()
print("ok")

# SCH6: page numbers belong to the project and parent instance, not the shared file.
from tempfile import TemporaryDirectory
import kicad_review as kr

with TemporaryDirectory() as t:
    def child(uid, label, page, parent="/root", project="H"):
        return (f'(sheet (uuid "{uid}") (property "Sheetname" "{label}") '
                '(property "Sheetfile" "shared.kicad_sch") '
                f'(instances (project "Other" (path "{parent}" (page "99"))) '
                f'(project "{project}" (path "{parent}" (page "{page}")))))')
    write(t, {"H.kicad_sch": '(kicad_sch (uuid "root") '
          '(sheet_instances (path "/" (page "1"))) '
          + child("ten", "Ten", "10") + child("two", "Two", "2") + ')',
          "shared.kicad_sch": '(kicad_sch ' +
          child("nested", "Nested", "3", "/root/ten").replace('"shared.kicad_sch"', '"leaf.kicad_sch"')[:-2] +
          '(project "H" (path "/root/two" (page "7"))))))'})
    pages = kr.sheet_pages(t, "H")
    assert {p["path"]: p["page"] for p in pages} == {
        "/": "1", "/ten/": "10", "/ten/nested/": "3", "/two/": "2", "/two/nested/": "7"}
    assert pages[1]["file"] == pages[3]["file"] == "shared.kicad_sch"
    write(t, {"H.kicad_sch": '(kicad_sch (uuid "root") '
          '(sheet_instances (path "/" (page "1")) (path "/two" (page "A2"))) '
          + sheet("Two", "shared.kicad_sch", "two") + ')',
          "shared.kicad_sch": '(kicad_sch)'})
    assert kr.sheet_pages(t, "H")[1]["page"] == "A2"
    n = kr.parse_sexpr('(sheet (instances (project "H" '
        '(path "/root/a" (page "3")) (path "/root/b" (page "7")))))')
    assert kr.sheet_instance_page(n, "H", "/root/b/") == "7"
    assert kr.sheet_instance_page(n, "H", "/root/c") is None
    assert kr.sheet_instance_page(n, "Other", "/root/b") is None
    write(t, {"H.kicad_sch": '(kicad_sch ' + sheet("Two", "shared.kicad_sch", "two") + ')'})
    assert [p["page"] for p in kr.sheet_pages(t, "H")] == ["1", "2"]
    write(t, {"P.kicad_sch": '(kicad_sch)'})
    calls = []
    with patch.object(kr, "kicad_cli", side_effect=lambda *a: calls.append(a)), \
         patch.object(kr, "sheet_pages", return_value=[]):
        kr.render_side(t, "P", t + "/out")
    sch = next(c for c in calls if c[:3] == ("sch", "export", "svg"))
    assert "--exclude-drawing-sheet" not in sch
    assert "--no-background-color" in sch
print("ok SCH6 instance pages and transparent framed export")

# Inherited symbol geometry: a derived symbol draws its base's shared body and selected unit only.
libs = {
    'Base': kr.parse_sexpr('(symbol "Base" (symbol "Base_0_1" (rectangle (start -2 -1) (end 2 1))) (symbol "Base_2_1" (pin input line (at -5 0 0) (length 2) (name "B") (number "3"))))'),
    'Derived': kr.parse_sexpr('(symbol "Derived" (extends "Base") (symbol "Derived_1_1" (circle (center 0 0) (radius 9))))')}
parts = kr.symbol_primitives(libs, 'Derived', '2')
coords, pins, approximate = kr.symbol_geometry(parts)
assert pins == [{'number': '3', 'name': 'B', 'x': -5.0, 'y': 0.0}], pins
assert [-3.0, 0.0] in coords and [-2.0, -1.0] in coords
assert not approximate and max(p[0] for p in coords) == 2

# Derived unit 1 selects circle and base rectangle, excluding unit 2 pin
parts_u1 = kr.symbol_primitives(libs, 'Derived', '1')
coords_u1, pins_u1, approx_u1 = kr.symbol_geometry(parts_u1)
assert pins_u1 == []
assert not approx_u1
assert max(p[0] for p in coords_u1) == 9 and min(p[0] for p in coords_u1) == -9
assert max(p[1] for p in coords_u1) == 9 and min(p[1] for p in coords_u1) == -9

# Multi-level inheritance: Grandchild extends Derived extends Base with inherited bodies first
libs['Grandchild'] = kr.parse_sexpr('(symbol "Grandchild" (extends "Derived") (symbol "Grandchild_0_1" (rectangle (start -10 -10) (end 10 10))))')
parts_gc = kr.symbol_primitives(libs, 'Grandchild', '2')
coords_gc, pins_gc, approx_gc = kr.symbol_geometry(parts_gc)
assert pins_gc == [{'number': '3', 'name': 'B', 'x': -5.0, 'y': 0.0}]
assert not approx_gc
assert max(p[0] for p in coords_gc) == 10 and min(p[0] for p in coords_gc) == -10
# Base rectangle (-2..2), Base pin (-5..-3), Grandchild rectangle (-10..10)
assert parts_gc[0][0] == 'rectangle' and kr.find(parts_gc[0], 'start')[1] == '-2'
assert parts_gc[-1][0] == 'rectangle' and kr.find(parts_gc[-1], 'start')[1] == '-10'

# Alternate body style (style='2') vs default (style='1')
libs['Alt'] = kr.parse_sexpr('(symbol "Alt" (symbol "Alt_1_1" (circle (center 0 0) (radius 1))) (symbol "Alt_1_2" (circle (center 0 0) (radius 5))))')
parts_alt1 = kr.symbol_primitives(libs, 'Alt', '1', style='1')
parts_alt2 = kr.symbol_primitives(libs, 'Alt', '1', style='2')
assert len(parts_alt1) == 1 and float(kr.val(parts_alt1[0], 'radius')) == 1.0
assert len(parts_alt2) == 1 and float(kr.val(parts_alt2[0], 'radius')) == 5.0

# Circle bounds at (c, r) produce its bounding square
circle_coords, _, circle_approx = kr.symbol_geometry([kr.parse_sexpr('(circle (center 2 3) (radius 4))')])
assert not circle_approx
assert sorted(circle_coords) == [[-2.0, -1.0], [-2.0, 7.0], [6.0, -1.0], [6.0, 7.0]]

# Arc bounds through (1, 0), (0, 1), (-1, 0) produce circumcircle bounds [-1, 1] x [-1, 1] with approximate=True
arc_coords, _, arc_approx = kr.symbol_geometry([kr.parse_sexpr('(arc (start 1 0) (mid 0 1) (end -1 0))')])
assert arc_approx
assert sorted(arc_coords) == [[-1.0, -1.0], [-1.0, 1.0], [1.0, -1.0], [1.0, 1.0]]

# Degenerate collinear arc falls back to control points with approximate=True
collinear_coords, _, collinear_approx = kr.symbol_geometry([kr.parse_sexpr('(arc (start 0 0) (mid 1 1) (end 2 2))')])
assert collinear_approx
assert collinear_coords == [[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]

# Bezier control-point hull has approximate=True
bezier_coords, _, bezier_approx = kr.symbol_geometry([kr.parse_sexpr('(bezier (pts (xy 0 0) (xy 2 5) (xy 4 1)))')])
assert bezier_approx
assert bezier_coords == [[0.0, 0.0], [2.0, 5.0], [4.0, 1.0]]

# Polyline points preserve approximate=False
poly_coords, _, poly_approx = kr.symbol_geometry([kr.parse_sexpr('(polyline (pts (xy 1 2) (xy 3 4)))')])
assert not poly_approx
assert poly_coords == [[1.0, 2.0], [3.0, 4.0]]

libs['Base'].append(['extends', 'Derived'])
try:
    kr.symbol_primitives(libs, 'Derived', '2')
    assert False, 'inheritance cycle must fail'
except ValueError as error:
    assert 'symbol inheritance cycle' in str(error)

# Missing definition raises KeyError per interface contract
try:
    kr.symbol_primitives(libs, 'NonExistent', '1')
    assert False, 'missing definition must raise KeyError'
except KeyError:
    pass

# Parent extends missing symbol raises KeyError
libs_broken = {'Broken': kr.parse_sexpr('(symbol "Broken" (extends "MissingParent"))')}
try:
    kr.symbol_primitives(libs_broken, 'Broken', '1')
    assert False, 'broken parent inheritance must raise KeyError'
except KeyError:
    pass

# Empty primitives produce empty coordinates and pins without approximation
assert kr.symbol_geometry([]) == ([], [], False)

# Angled pin rotates endpoint correctly across all cardinal orientations
for angle, (dx, dy) in [(0, (4.0, 0.0)), (90, (0.0, 4.0)), (180, (-4.0, 0.0)), (270, (0.0, -4.0))]:
    p_node = kr.parse_sexpr(f'(pin input line (at 10 20 {angle}) (length 4) (name "P") (number "1"))')
    p_coords, p_pins, p_approx = kr.symbol_geometry([p_node])
    assert not p_approx
    assert p_pins == [{'number': '1', 'name': 'P', 'x': 10.0, 'y': 20.0}]
    assert p_coords[0] == [10.0, 20.0]
    assert abs(p_coords[1][0] - (10.0 + dx)) < 1e-6 and abs(p_coords[1][1] - (20.0 + dy)) < 1e-6

print('ok inherited symbol geometry')

# Task 2.2: hotspot manifests resolve by sheet-instance path, never by export name.
def hotspot_regressions():
    import base64, gzip, json, math

    with TemporaryDirectory() as root:
        root_sch = ('(kicad_sch (uuid root) (paper A4) ' +
                    sheet('Left', 'shared.kicad_sch', 'left') +
                    sheet('Right', 'shared.kicad_sch', 'right') + ')')
        shared = '''(kicad_sch (uuid child) (paper A4)
          (lib_symbols (symbol "Test:Op"
            (symbol "Op_0_1" (rectangle (start -1 -1) (end 1 1)))
            (symbol "Op_1_1" (pin input line (at -5 0 0) (length 2)
              (name "A") (number "1")))
            (symbol "Op_2_1" (pin input line (at -5 0 0) (length 2)
              (name "B") (number "3")))))
          (symbol (uuid placed) (lib_id "Test:Op") (unit 2)
            (at 100 50 90) (mirror x)
            (property "Reference" "U?") (property "Value" "Op")
            (instances (project "Board"
              (path "/root/left" (reference "U1") (unit 2))
              (path "/root/right" (reference "U2") (unit 2)))))
          (label "SIGNAL" (uuid lab) (at 10 20 0))
          (no_connect (uuid nc) (at 10 20))
          (wire (uuid wire) (pts (xy 1 2) (xy 3 4))))'''
        write(root, {'Board.kicad_sch': root_sch, 'shared.kicad_sch': shared})
        m = kr.sheet_hotspots(root, 'Board')
        assert m['version'] == 1 and m['units'] == 'mm' and m['warnings'] == []
        by_sheet = {v['sheet']: v for v in m['views']}
        assert sorted(by_sheet) == ['/', '/left/', '/right/']
        assert by_sheet['/']['elements'] == [] and by_sheet['/']['viewBox'] is None
        assert by_sheet['/left/']['file'] == by_sheet['/right/']['file'] == 'shared.kicad_sch'
        assert by_sheet['/left/']['elements'][0]['ref'] == 'U1'
        assert by_sheet['/right/']['elements'][0]['ref'] == 'U2'
        a = by_sheet['/left/']['elements'][0]
        assert a['uuid'] == by_sheet['/right/']['elements'][0]['uuid'] == 'placed'
        assert a['unit'] == '2' and [p['number'] for p in a['pins']] == ['3']
        assert a['lib_id'] == 'Test:Op' and a['value'] == 'Op' and a['confidence'] == 'exact'
        assert a['fields']['Reference'] == 'U1', 'fields carry the instance reference, not the U? placeholder'
        assert all(math.isfinite(v) for v in a['bbox'])
        assert by_sheet['/left/']['noConnects'][0]['x'] == 10.0
        assert by_sheet['/left/']['labels'] == [{'uuid': 'lab', 'x': 10.0, 'y': 20.0, 'text': 'SIGNAL', 'kind': 'label'}]
        assert len(by_sheet['/left/']['wires'][0]['points']) == 2
        assert by_sheet['/left/']['wires'][0]['bbox'] == [1.0, 2.0, 3.0, 4.0]
        # Review Focus 1: same file and UUID under two sheet instances, resolved by instance path.
        assert a['pins'] == [{'number': '3', 'name': 'B', 'x': 100.0, 'y': 55.0}]
        assert by_sheet['/right/']['elements'][0]['pins'] == a['pins']
        assert by_sheet['/right/']['sheet'] != by_sheet['/left/']['sheet']
        assert a['bbox'][0] <= 100 <= a['bbox'][2]
        # Body corners land at x 99..101, y 49..51; the pin runs from its endpoint (100, 55) to (100, 53).
        assert a['bbox'] == [99.0, 49.0, 101.0, 55.0], a['bbox']
        json.dumps(m)  # plain JSON types only

    # Placement transform: library y-up to sheet y-down, mirror before rotation.
    assert kr.sheet_point([2, 3], kr.parse_sexpr('(symbol (at 100 50 90))')) == [97, 48]
    assert kr.sheet_point([2, 3], kr.parse_sexpr('(symbol (at 100 50 90) (mirror x))')) == [103, 48]
    assert kr.sheet_point([2, 3], kr.parse_sexpr('(symbol (at 100 50 0) (mirror y))')) == [98, 47]
    assert kr.sheet_point([2, 3], kr.parse_sexpr('(symbol (at 100 50))')) == [102, 47]
    assert kr.hotspot_box([]) is None and kr.hotspot_box([[1, 5], [-2, 3]]) == [-2, 3, 1, 5]

    # A nonzero-origin viewBox survives blob serialization and decode exactly.
    # Task 4 owns mapped_viewbox(); this pins the same parse and the blob round trip it relies on.
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (uuid root) (paper A4))',
                     'export/Board.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 40 30"><path d="M0 0"/></svg>'})
        manifest = kr.sheet_hotspots(root, 'Board')
        svg_root = ET.parse(pathlib.Path(root, 'export/Board.svg')).getroot()
        manifest['views'][0]['viewBox'] = [float(n) for n in svg_root.get('viewBox').replace(',', ' ').split()]
        blobs = {}
        key = kr.add_blob(blobs, json.dumps(manifest, sort_keys=True))
        decoded = json.loads(gzip.decompress(base64.b64decode(blobs[key])))
        assert decoded['views'][0]['viewBox'] == [10, 20, 40, 30]

    # Missing library symbol: approximate placeholder box, no pins, one warning.
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (uuid root) (lib_symbols) (symbol (uuid s1) (lib_id "X:Y") (at 10 10 0) (property "Reference" "R1")))'})
        m = kr.sheet_hotspots(root, 'Board')
        e = m['views'][0]['elements'][0]
        assert e['confidence'] == 'approximate' and e['pins'] == [] and e['bbox'] == [9.0, 9.0, 11.0, 11.0], e
        assert e['ref'] == 'R1' and e['unit'] == '1'
        assert m['warnings'] == [{'sheet': '/', 'uuid': 's1', 'reason': 'library unavailable'}], m['warnings']

    # Inherited symbols: embedded keys are qualified, `extends` names the unqualified parent.
    lib = '''(lib_symbols
      (symbol "L:Base" (symbol "Base_0_1" (rectangle (start -2 -1) (end 2 1))))
      (symbol "L:Derived" (extends "Base")
        (symbol "Derived_1_1" (pin input line (at -4 0 0) (length 1) (name "P") (number "7")))))'''
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (uuid root) ' + lib +
                     '(symbol (uuid s1) (lib_id "L:Derived") (at 0 0 0) (property "Reference" "U1")))'})
        m = kr.sheet_hotspots(root, 'Board')
        e = m['views'][0]['elements'][0]
        assert m['warnings'] == [] and e['confidence'] == 'exact'
        assert e['bbox'] == [-4.0, -1.0, 2.0, 1.0], e['bbox']
        assert e['pins'] == [{'number': '7', 'name': 'P', 'x': -4.0, 'y': 0.0}]
    # Two parents sharing an unqualified name make the suffix ambiguous: never guess one.
    ambiguous = lib.replace('(symbol "L:Base" (symbol "Base_0_1" (rectangle (start -2 -1) (end 2 1))))',
                            '(symbol "A:Base" (symbol "Base_0_1" (rectangle (start -2 -1) (end 2 1)))) '
                            '(symbol "B:Base" (symbol "Base_0_1" (rectangle (start -9 -9) (end 9 9))))')
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (uuid root) ' + ambiguous +
                     '(symbol (uuid s1) (lib_id "L:Derived") (at 0 0 0) (property "Reference" "U1")))'})
        m = kr.sheet_hotspots(root, 'Board')
        e = m['views'][0]['elements'][0]
        assert e['confidence'] == 'approximate' and e['pins'] == [] and len(m['warnings']) == 1, m

    # lib_name selects the embedded variant of a library symbol.
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (uuid root) (lib_symbols (symbol "Op_1" (symbol "Op_1_0_1" (rectangle (start -3 -3) (end 3 3))))) '
                     '(symbol (uuid s1) (lib_id "Lib:Op") (lib_name "Op_1") (at 0 0 0) (property "Reference" "U1")))'})
        e = kr.sheet_hotspots(root, 'Board')['views'][0]['elements'][0]
        assert e['confidence'] == 'exact' and e['bbox'] == [-3.0, -3.0, 3.0, 3.0] and e['lib_id'] == 'Lib:Op'

    # Without a root UUID there is no instance path: fall back to the property, never throw.
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (lib_symbols) (symbol (uuid s1) (lib_id "X:Y") (at 1 1 0) (property "Reference" "R9")))'})
        m = kr.sheet_hotspots(root, 'Board')
        assert m['views'][0]['elements'][0]['ref'] == 'R9'

    # A sheet file that cannot be read keeps its view and records a warning.
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (uuid root) ' + sheet('Gone', 'gone.kicad_sch', 'g') + ')'})
        m = kr.sheet_hotspots(root, 'Board')
        assert [v['sheet'] for v in m['views']] == ['/', '/g/'] and m['views'][1]['elements'] == []
        assert m['warnings'] == [{'sheet': '/g/', 'reason': 'sheet file missing'}], m['warnings']

    # A sheet that contains itself is skipped with a warning rather than expanded forever.
    with TemporaryDirectory() as root:
        write(root, {'Board.kicad_sch': '(kicad_sch (uuid root) ' + sheet('Again', 'Board.kicad_sch', 'again') + ')'})
        import contextlib, io
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            m = kr.sheet_hotspots(root, 'Board')
        assert [v['sheet'] for v in m['views']] == ['/'] and 'recursive hierarchy skipped' in err.getvalue(), err.getvalue()

hotspot_regressions()
print('ok instance-aware sheet hotspots and pins')

# Unchanged drawings remain viewable, deduplicate blobs, and prefer head metadata.
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        for side, page in [("base", "2"), ("head", "10")]:
            write(t, {f"{side}/H/H.kicad_sch":
                f'(kicad_sch (uuid root) (sheet_instances (path "/" (page "{page}"))))',
                f"review/H/{side}/erc.json": '{"sheets": []}',
                f"review/H/{side}/sch/H.svg":
                '<svg viewBox="0 0 320 213"><path d="M10 10H310"/></svg>'})
        blobs = {}
        p = kr.build_project({"dir": "H", "name": "H", "status": "modified"},
                             blobs, kr.DEFAULT_SETTINGS)
        pg = p["sheets"][0]
        assert pg["page"] == "10" and pg["status"] == "unchanged"
        assert pg["svg"]["base"] == pg["svg"]["head"]
        assert pg["size"] == [320, 213] and "stem" not in pg
        artwork = {key for pair in pg['svgThemes'].values() for key in pair.values()}
        assert artwork == {pg['svg']['head']}, 'unchanged artwork deduplicates independently of manifests'
        assert pg['hotspots']['base'] == pg['hotspots']['head']
        assert pg['svgCompare']['base'] != pg['svgCompare']['head'], 'tinted bytes never define identity'
        assert len(blobs) == 4, 'one drawing, one revision manifest and two comparison resources'
        # Missing root identity is a legacy compatibility case, not a fabricated anchor.
        pathlib.Path('head/H/H.kicad_sch').write_text('(kicad_sch (paper A4))')
        legacy = kr.build_project({'dir': 'H', 'name': 'H', 'status': 'modified'}, {}, kr.DEFAULT_SETTINGS)
        assert legacy['sheets'][0]['hotspots']['head'] is None
        os.remove("head/H/H.kicad_sch")
        removed = kr.build_project({"dir": "H", "name": "H", "status": "modified"},
                                   {}, kr.DEFAULT_SETTINGS)["sheets"][0]
        assert removed["page"] == "2" and removed["status"] == "removed"
        assert removed["svg"]["base"] and removed["svg"]["head"] is None
    finally:
        os.chdir(old_cwd)
print("ok SCH6 unchanged drawing blobs and head page metadata")

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
for marker in ('href="tokens.css"', 'href="review.css"', 'src="sample/review-data.js"', 'src="review.js"', 'src="three-studio.js"'):
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

# History survives both non-report paths without changing their headings.
for changed, summary, heading in (("", "failure", "KiCad review failed"), ("false", "skipped", "No KiCad changes")):
    t = tempfile.mkdtemp()
    previous = "<!-- kicad-review-log -->\nold log\n<!-- /kicad-review-log -->\n"
    write(t, {"review/previous-log.md": previous})
    r = subprocess.run(["bash", "-e", "-c", step], cwd=t, capture_output=True, text=True,
                       env={**env, "GH_TEST_DIR": t, "CHANGED": changed, "SUMMARY": summary, "GH_TEST_ID": "99"})
    assert r.returncode == 0, r.stderr
    body = open(f"{t}/patched.md", encoding="utf-8").read()
    assert heading in body and body.endswith(previous) and body.startswith("<!-- kicad-review -->"), body
print("ok failure and no-change keep the review log")
assert wf.index("- name: Fetch previous review log") < wf.index("- name: Job summary")
fetch_log = wf[wf.index("- name: Fetch previous review log"):wf.index("- name: Job summary")]
assert "vars.KICAD_REVIEW_HISTORY == 'true'" in fetch_log
assert "github.event.pull_request.head.repo.full_name == github.repository" in fetch_log
assert "comments?per_page=100" in fetch_log
assert "HISTORY: ${{ vars.KICAD_REVIEW_HISTORY }}" in wf
print("ok history fetch opt-in and fork guard")

# Readiness gates required checks and blocking threads; optional publishing never fails the job.
fail = wf[wf.index("- name: Fail on required checks"):wf.index("- name: Fabrication outputs")]
assert "if: ${{ !startsWith(github.ref, 'refs/tags/') && (steps.report.outputs.failed != '' || steps.summary.outputs.threads_failed != '') }}" in fail
assert "THREADS: ${{ steps.summary.outputs.threads_failed }}" in fail
publish = wf[wf.index("- name: Publish check runs"):wf.index("- name: Pull request comment")]
assert "if: ${{ !cancelled() && steps.summary.outputs.check_runs == 'true' }}" in publish
assert "HEAD: ${{ steps.detect.outputs.head }}" in publish
assert "review/check-runs.json" in publish and "continue-on-error: true" in publish and "exit 0; }" in publish
print("ok readiness workflow gate and optional check runs")

# Reports expose an artifact filename containing the compared revisions and result.
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
image_upload = wf.split("      - name: Upload image assets\n", 1)[1].split("      - name:", 1)[0]
assert "name: kicad-review-image-assets-${{ github.run_id }}-${{ github.run_attempt }}" in image_upload
assert "archive: true" in image_upload and "path: review/assets/" in image_upload
assert "retention-days: 90" in image_upload
assert "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" in image_upload
html_upload = wf.split("      - name: Upload report\n", 1)[1].split("      - name:", 1)[0]
assert "archive: false" in html_upload and "path: review/${{ steps.report.outputs.name }}" in html_upload

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
pdf_link_args = ([], "https://github.com/o/r/actions/runs/9/artifacts/5", "5")
pdf_off_data = {**d, "settings": {**d.get("settings", {}), "pdf": {"enabled": False}}}
pdf_on_data = {**d, "settings": {**d.get("settings", {}), "pdf": {"enabled": True}}}
assert comment_markdown(pdf_off_data, *pdf_link_args, site="https://kicad-review.example.workers.dev/") == site_body
pdf_site_body = comment_markdown(pdf_on_data, *pdf_link_args, site="https://kicad-review.example.workers.dev/")
assert pdf_site_body == site_body.replace(f"({site_url})", f"({site_url}?pdf=1)")
assert comment_markdown(pdf_on_data, *pdf_link_args) == site_default
print("ok PDF site comment link opt-in and off byte identity")
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
from kicad_review import build_project, board_changed, export_glb
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
def logged_export(args, **kw):
    import pathlib
    dest = pathlib.Path(args[args.index('-o') + 1])
    dest.write_bytes(b'head glb\x00' if 'glb' in args else b'\x89PNG\r\n\x1a\n')
    return type("R", (), {"returncode": 0, "stdout": "Could not add 3D model for U5.\n", "stderr": "other diagnostic\n"})()
kicad_review.subprocess.run = logged_export
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
assert detect(commit("HEAD~1"), commit("HEAD")) == [{"dir": d, "name": d, "status": "unchanged"} for d in ("A", "B")], "every review retains unchanged projects"
write(t, {"B/B.kicad_sch": "(kicad_sch)"})
g("add", "-A"); g("commit", "-q", "-m", "one project")
assert detect(commit("HEAD~1"), commit("HEAD")) == [{"dir": "B", "name": "B", "status": "modified"}, {"dir": "A", "name": "A", "status": "unchanged"}], "changed projects first, unchanged projects retained"
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
    expected = []
    for theme, suffix in (('light', ''), ('dark', '-dark')):
        expected.extend([
            ['kicad-cli', 'sch', 'export', 'svg', '--no-background-color', '--theme', 'kicad-review-' + theme,
             '-o', f'{t}/render/sch{suffix}', f'{t}/P/P.kicad_sch'],
            ['kicad-cli', 'pcb', 'export', 'svg', '--mode-multi', '--exclude-drawing-sheet', '--page-size-mode', '1',
             '--drill-shape-opt', '0', '--check-zones', '--layers', 'F.Cu,B.Cu,Edge.Cuts', '--theme', 'kicad-review-' + theme,
             '-o', f'{t}/render/pcb{suffix}', f'{t}/P/P.kicad_pcb']])
    expected.extend([
        ['kicad-cli', 'pcb', 'export', 'stats', '--format', 'json', '--units', 'mm', '-o', f'{t}/render/stats.pending.json', f'{t}/P/P.kicad_pcb'],
        ['kicad-cli', 'sch', 'erc', '--format', 'json', '--severity-all', '-o', f'{t}/render/erc.json', f'{t}/P/P.kicad_sch'],
        ['kicad-cli', 'pcb', 'drc', '--format', 'json', '--severity-all', '--schematic-parity', '-o', f'{t}/render/drc.json', f'{t}/P/P.kicad_pcb']])
    assert calls == expected, 'TS-S2 render commands'
    assert all(pathlib.Path(f'{t}/render/{f}').read_text() == text for f, text in {
        'sch/P.svg': '<svg />', 'sch-dark/P.svg': '<svg />', 'pcb/P.svg': '<svg/>', 'pcb-dark/P.svg': '<svg/>',
        'erc.json': '{}', 'drc.json': '{}', 'stats.json': '{}'}.items())
    assert json.loads(pathlib.Path(f'{t}/render/sheet-images.json').read_text()) == {
        '/': {'light': 'sch/P.svg', 'dark': 'sch-dark/P.svg'}}
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

# BR02: synthetic populated four-layer board for 3D export/index regression probes.
fixture = pathlib.Path('ui/fixtures/3d-four-layer.kicad_pcb')
assert fixture.is_file(), 'BR02 four-layer 3D fixture missing'
fixture_text = fixture.read_text(encoding='utf-8')
root = kicad_review.parse_sexpr(fixture_text)
assert all(name in fixture_text for name in ('F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'))
outline = kicad_review.findall(root, 'gr_line')
assert len(outline) == 4, 'BR02 closed rectangular outline'
assert [(kicad_review.find(n, 'start')[1:], kicad_review.find(n, 'end')[1:]) for n in outline] == [
    (['0', '0'], ['20', '0']), (['20', '0'], ['20', '20']),
    (['20', '20'], ['0', '20']), (['0', '20'], ['0', '0'])], 'BR02 20 mm closed outline'
assert all(kicad_review.find(n, 'layer')[1] == 'Edge.Cuts' for n in outline)
# KiCad 10 uses layer-table order for outer-side model placement. The separate
# vf-order-4 fixture deliberately remains scrambled for layer-order regression.
assert [n[1] for n in kicad_review.find(root, 'layers')[1:] if n[1].endswith('.Cu')] == [
    'F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'], 'BR02 physical copper layer table'
stackup = kicad_review.find(kicad_review.find(root, 'setup'), 'stackup')
assert [n[1] for n in kicad_review.findall(stackup, 'layer') if n[1].endswith('.Cu')] == [
    'F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'], 'BR02 physical stack order'
assert kicad_review.find(stackup, 'copper_finish') == ['copper_finish', 'ENIG']
footprints = {o['ref']: o for o in kicad_review.pcb_objects(str(fixture)).values() if o['kind'] == 'footprint'}
assert set(footprints) == {'R1', 'R2', 'J1', 'U3', 'U4', 'LOGO1'}
for ref, (pos, layer, model) in {
    'R1': ([5, 5], 'F.Cu', True), 'R2': ([15, 5], 'F.Cu', True),
    'J1': ([10, 15, 90], 'B.Cu', True), 'U3': ([15, 15], 'F.Cu', False),
    'U4': ([5, 15], 'B.Cu', False), 'LOGO1': ([10, 10], 'F.Cu', False),
}.items():
    obj = footprints[ref]
    assert obj['pos'] == pos and obj['props']['layer'] == layer and obj['has_model'] == model, ref
logo = footprints['LOGO1']
assert logo['box'] is None and all(isinstance(v, (int, float)) for v in logo['pos'][:2]), 'BR02 padless raw footprint'
nodes = kicad_review.findall(root, 'footprint')
by_ref = {next(p[2] for p in kicad_review.findall(n, 'property') if p[1] == 'Reference'): n for n in nodes}
assert kicad_review.findall(by_ref['LOGO1'], 'fp_rect') and not kicad_review.findall(by_ref['LOGO1'], 'pad')
# Flipping the stock header to B.Cu mirrors local Y; pin 2 must still align
# with its installed model after the footprint's 90-degree board rotation.
j1_pad2 = next(p for p in kicad_review.findall(by_ref['J1'], 'pad') if p[1] == '2')
assert kicad_review.find(j1_pad2, 'at')[1:] == ['0', '-2.54', '90'], 'BR02 bottom header pad/model alignment'
assert all(any(layer in kicad_review.find(p, 'layers')[1:] or '*.Cu' in kicad_review.find(p, 'layers')[1:]
               for n in nodes for p in kicad_review.findall(n, 'pad'))
           for layer in ('F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu')), 'BR02 pads on every copper layer'
assert {kicad_review.find(n, 'layer')[1] for n in kicad_review.findall(root, 'segment')} == {
    'F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'}, 'BR02 visible copper on every layer'
models = [m[1] for n in nodes for m in kicad_review.findall(n, 'model')]
assert len(models) == 3 and all(m.startswith('${KICAD10_3DMODEL_DIR}/') for m in models), 'BR02 portable installed models'
import uuid as uuid_module
def fixture_uuids(node):
    for child in node:
        if isinstance(child, list):
            if child and child[0] == 'uuid':
                yield child[1]
            else:
                yield from fixture_uuids(child)
uuids = list(fixture_uuids(root))
assert len(uuids) == len(set(uuids)) and all(str(uuid_module.UUID(u)) == u for u in uuids), 'BR02 unique valid identities'
print('ok BR02 synthetic four-layer 3D fixture')

# TS-S1: CI exercises default, real 3D and unchanged two-project pages without extra installs.
test_wf = pathlib.Path(".github/workflows/test.yml").read_text(encoding="utf-8")
assert "uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0" in test_wf and "node-version: 22" in test_wf and test_wf.index("actions/setup-node@") < test_wf.index("- run: node"), "TS-S1 Node 22 before browser tests"
assert "google-chrome" in test_wf and "CHROME" in test_wf and 'python3 ui/build-fixtures.py "$PAGES"' in test_wf, "TS-S1 CI browser setup"
assert "node --import ./site/css-loader.mjs --test ui/*.test.mjs" in test_wf, "CI must run sandbox downloads"
with tempfile.TemporaryDirectory() as output:
    subprocess.run([sys.executable, "ui/build-fixtures.py", output], check=True)
    assert {p.name for p in pathlib.Path(output).iterdir()} == {"3d.html", "two.html", "parts.html", "multiboard.html"}
    text = pathlib.Path(output, "multiboard.html").read_text(encoding="utf-8")
    data = json.loads(text.split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0])
    assert data["bom"]["summary"]["components"] == 7 and data["bom"]["boards"] == ["Alpha", "Beta"]
assert "google-chrome" in test_wf and "CHROME" in test_wf and "inline_page" in test_wf, "TS-S1 CI browser setup"
for command in ('node ui/check.mjs --no-skip "Download dialog"', 'node ui/check.mjs --no-skip "Multi-board BOM" --page "$PAGES/multiboard.html"', 'node ui/check.mjs --no-skip "Fab limits"', 'node ui/check.mjs --no-skip "Fab limits" --dark', 'node ui/check.mjs --no-skip "Fabrication producer contract" --page "$PAGES/fab.html"', 'node ui/check.mjs --no-skip "Fabrication producer contract" --dark --page "$PAGES/fab.html"', 'node ui/check.mjs --no-skip "Waivers"', 'node ui/check.mjs', 'node ui/check.mjs --dark', 'node ui/check.mjs --no-skip "selection-only address"', 'node ui/check.mjs --no-skip "pasted selection address preserves an explicit position"', 'node ui/check.mjs --no-skip "passing checks with baseline findings"', 'node ui/check.mjs --no-skip 3D --page "$PAGES/3d.html"', 'node ui/check.mjs --no-skip 3D --dark --page "$PAGES/3d.html"', 'node ui/check.mjs --no-skip "unchanged sheet" --page "$PAGES/two.html"', 'node ui/check.mjs --no-skip "unchanged project" --page "$PAGES/two.html"', 'node ui/check.mjs --no-skip "Parts fixture" --page "$PAGES/parts.html"', 'node ui/check.mjs --no-skip "Parts fixture" --dark --page "$PAGES/parts.html"'):
    assert "      - run: " + command in test_wf.splitlines(), "TS-S1 CI missing " + command
assert test_wf.count("    runs-on: ubuntu-24.04\n    timeout-minutes: 60\n") == test_wf.count("timeout-minutes:") == test_wf.count("runs-on:") == 2, "TS-S1 each CI job (test, dark) has one timeout"
assert "apt-get" not in test_wf and test_wf.count("npm install") == 1, "TS-S1 only pinned 3D integration dependencies"
for suffix in ('', ' --dark'):
    assert '      - run: node ui/check.mjs --no-skip "BR02 single renderer head only"' + suffix + ' --page "$PAGES/single.html"' in test_wf
assert "data['mode'] = 'single'" in test_wf and 'review-data-3d-processed.js' in test_wf
# BR02 processed fixture: CI builds it with inline_page and runs every processed check light and dark.
assert '("processed", "review-data-3d-processed.js")' in test_wf, 'TS-S1 processed fixture missing'
runner = pathlib.Path('ui/check.mjs').read_text()
for command in (
    'node ui/check.mjs --no-skip "BR02 processed" --page "$PAGES/processed.html"',
    'node ui/check.mjs --no-skip "BR02 processed" --dark --page "$PAGES/processed.html"',
    'node --import ./site/css-loader.mjs --test ui/*.test.mjs',
    'node ui/board-test.mjs'):
    assert '      - run: ' + command in test_wf.splitlines(), 'TS-S1 CI missing ' + command
# Image and supplemental fixture commands stay literal: CI and this contract change together.
for command in (
    'node ui/check.mjs --no-skip "images fallback selected export palettes" --page "$PAGES/two.html"',
    'node ui/check.mjs --no-skip "bench-t2 single offline chrome" --page "$PAGES/two.html"',
    'node ui/check.mjs --no-skip "images screen and legacy appearance"',
    'node ui/check.mjs --no-skip "images compare and four copper layers" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images gesture lifecycle" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images fallback appearance" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images manifests and home" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images active gesture pixels" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images missing added-sheet" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images missing removed-sheet" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images missing added-board" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images missing removed-board" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images inspect search and anchors" --page "$PAGES/images.html"',
    'node ui/check.mjs --persist-check --image-fallback --no-skip "Themes reload seed" --page "$PAGES/images.html"',
    'node ui/check.mjs --persist-check --no-skip "Themes reload seed" --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images screen and legacy appearance" --width 1440 --height 900 --dpr 2 --page "$PAGES/images.html"',
    'node ui/check.mjs --no-skip "images screen and legacy appearance" --dark --width 1440 --height 900 --dpr 2 --page "$PAGES/images.html"',
):
    assert "      - run: " + command in test_wf.splitlines(), "TS-S1 CI missing " + command
assert '("images", "review-data-images.js")' in test_wf, "TS-S1 image fixture missing"
fixture_block = test_wf.split("      - name: Build browser fixtures\n        run: |\n", 1)[1].split("\n      - ", 1)[0]
assert '          FAB_REPORT_FIXTURE="$PAGES/fab.html" python3 test_kicad_review.py' in fixture_block.splitlines(), "TS-S1 fab producer must run inside fixture-generation block"
assert fixture_block.index('export PAGES=') < fixture_block.index('FAB_REPORT_FIXTURE='), "TS-S1 fab producer needs PAGES"
print("ok TS-S1 CI browser matrix")
print("ok")

# Parts lines: group by value+footprint+LCSC, normalise LCSC, flag missing numbers and conflicts.
from kicad_review import parts_lines, mark_new_problems
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

# BOM view helpers: categories, reference ranges, summary (spec 08).
from kicad_review import BOM_CATEGORIES, bom_category, bom_summary, ref_ranges
assert ref_ranges(["R1", "R3", "R7", "R8", "R9", "R10", "R11", "R12", "R17"]) == "R1, R3, R7-R12, R17"
assert ref_ranges([f"C{n}" for n in (1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 17)]) == "C1-C8, C11-C12, C14-C15, C17"
assert ref_ranges(["R10", "R2", "R1"]) == "R1-R2, R10", "natural order"
assert ref_ranges(["R5", "R5A", "R6"]) == "R5, R5A, R6", "a suffix breaks the run and stays literal"
assert ref_ranges(["U1A", "U1B", "U2"]) == "U1A, U1B, U2", "sub-parts never join"
assert ref_ranges(["R01", "R02", "R03"]) == "R01, R02, R03", "leading zeros stay literal"
assert ref_ranges(["R1", "R01", "R2"]) == "R01, R1-R2", "equal natural keys use deterministic literal tie-break; padded references stay separate"
assert ref_ranges(["R1", "C1", "R2", "C2"]) == "C1-C2, R1-R2", "prefixes stay apart"
assert ref_ranges(["R1", "R1", "R2"]) == "R1-R2" and ref_ranges([]) == ""
assert ref_ranges(["TP", "R0", "R1"]) == "R0, R1, TP", "non-numeric and zero references stay literal"
assert ref_ranges([f"R{n}" for n in range(1, 501)]) == "R1-R500"
for ref, lib, want in (("R7", None, "Resistors"), ("r7", None, "Resistors"), ("C3", None, "Capacitors"), ("FB1", None, "Inductors & Ferrites"),
                       ("LED3", None, "Diodes & LEDs"), ("Q2", None, "Transistors"), ("U4", None, "ICs & Modules"), ("P1", None, "Connectors"),
                       ("TP5", None, "Test Points"), ("MH2", None, "Mechanical"), ("X1", "Device:Crystal", "Other"), ("SW1", "Switch:SW_SPST", "Other"),
                       ("MOT1", "Device:R_Small", "Resistors"), ("ANT1", "Device:Antenna", "Other"), ("A1", "Connector:USB_C_Receptacle", "Connectors"),
                       ("ZZ1", "Device:L7805", "Other"), ("", None, "Other"), ("U1", "Connector:Conn_01x02", "ICs & Modules")):
    assert bom_category(ref, lib) == want, (ref, lib, bom_category(ref, lib))
summary = bom_summary([{"category": "Other", "refs": ["X1"], "mpn": "TBD"}, {"category": "Resistors", "refs": ["R1", "R2"], "mpn": "RC0805"},
                       {"category": "Capacitors", "refs": ["C1"], "mpn": None}])
assert summary == {"components": 4, "unique": 3, "withMpn": 1, "byCategory": {"Resistors": 2, "Capacitors": 1, "Other": 1}}, summary
assert list(summary["byCategory"]) == [c for c in BOM_CATEGORIES if c in summary["byCategory"]], "chip order"
assert bom_summary([]) == {"components": 0, "unique": 0, "withMpn": 0, "byCategory": {}}
print("ok bom helpers")

# BOM lines: the MPN splits a part, units count once, every line carries category and ranges.
from kicad_review import base_ref, bom_identity
assert base_ref("U1 unit 2") == "U1" and base_ref("R1") == "R1" and base_ref(None) == ""
from pathlib import Path
sym2 = lambda ref, v, mpn=None, lib="Device:R_Small", mf=None: {"kind": "symbol", "ref": ref, "props": {
    "Value": v, "Footprint": "R_0805", "Datasheet": "~", "symbol": lib, **({"MPN": mpn} if mpn else {}), **({"Manufacturer": mf} if mf else {})}}
two = parts_lines({"a": sym2("R1", "5.1k", "A"), "b": sym2("R2", "5.1k", "B")})
assert [(l["refs"], l["mpn"]) for l in two] == [(["R1"], "A"), (["R2"], "B")] and two[0]["key"] != two[1]["key"], two
three = parts_lines({"a": sym2("R1", "5.1k", "A"), "b": sym2("R2", "5.1k", "B"), "c": sym2("R3", "5.1k")})
assert len(three) == 3 and [l["mpn"] for l in three] == ["A", "B", None], "no MPN is its own line too"
one = parts_lines({"a": sym2("R1", "5.1k", "A"), "b": sym2("R2", "5.1k", "A"), "c": sym2("R3", "5.1k", "A")})
assert len(one) == 1 and one[0]["refs"] == ["R1", "R2", "R3"] and one[0]["refsCompressed"] == "R1-R3" and one[0]["category"] == "Resistors", one
units = parts_lines({"a": sym2("U1", "TL072", lib="Amplifier_Operational:TL072"), "b": sym2("U1 unit 2", "TL072", lib="Amplifier_Operational:TL072"),
                     "c": sym2("U1 unit 3", "TL072", lib="Amplifier_Operational:TL072")})
assert len(units) == 1 and units[0]["refs"] == ["U1"] and units[0]["category"] == "ICs & Modules", units
fitted = parts_lines({"a": sym2("R1", "1k"), "b": {**sym2("R2", "1k"), "props": {**sym2("R2", "1k")["props"], "dnp": "yes"}},
                      "c": {**sym2("R3", "1k"), "props": {**sym2("R3", "1k")["props"], "in_bom": "no"}}})
assert len(fitted) == 1 and fitted[0]["refs"] == ["R1"], "DNP and excluded parts stay out of the BOM"
unannotated = parts_lines({"a": sym2("U?", "TL072"), "b": sym2("U? unit 2", "TL072")})
assert unannotated == [] and bom_summary(unannotated)["components"] == 0
only_symbol = sym2('H1', 'Watch glass', lib='Mechanical:Housing')
only_symbol['props'].update(Footprint='', on_board='no')
mechanical = parts_lines({'only-symbol': only_symbol})
assert len(mechanical) == 1 and mechanical[0]['category'] == 'Mechanical' and mechanical[0]['refs'] == ['H1'] and bom_summary(mechanical)['components'] == 1
assert parts_lines({"a": sym2("R1", "1k", mf="Yageo")})[0]["manufacturer"] == "Yageo"
old = parts_lines({"a": sym2("R1", "5.1k", "A")})
assert [r["action"] for r in diff_parts(old, parts_lines({"a": sym2("R1", "5.1k", "B")}))] == ["mpn"], "an MPN-only edit is a change"
assert [r['action'] for r in diff_parts(old, parts_lines({'a': sym2('R1', '5.1k')}))] == ['mpn'], 'removing an MPN is a change too'
# Exercise actual parser property values after the concurrent quoted-token fix; do not coerce them first.
from kicad_review import parse_sexpr, properties
raw_props = properties(parse_sexpr('(symbol (property "Value" "10k") (property "Footprint" "R_0805") (property "MPN" "RC"))'))
raw_objs = {ref: {'kind': 'symbol', 'ref': ref, 'props': dict(raw_props)} for ref in ('R1', 'R2')}
raw_lines = parts_lines(raw_objs)
assert len(raw_lines) == 1 and raw_lines[0]['value'] == raw_props['Value'] and raw_lines[0]['footprint'] == raw_props['Footprint']
assert raw_lines[0]['category'] == bom_category('R1', raw_props['Value']) == 'Resistors'
assert raw_lines[0]['refsCompressed'] == ref_ranges(raw_lines[0]['refs']) == 'R1-R2'
assert json.loads(json.dumps(raw_lines))[0]['value'] == '10k'
assert json.loads(json.dumps(raw_lines))[0]['footprint'] == 'R_0805'
# Category and ordering metadata must not disappear into the first grouped reference.
metadata_objects = {"tp": sym2("TP1", "", lib=""), "h": sym2("H1", "", lib="")}
for obj in metadata_objects.values():
    obj["props"]["Footprint"] = ""
assert len(parts_lines(metadata_objects)) == 2, "test points and mechanical parts must not merge"
from kicad_review import bom_repository
category_combined = bom_repository([{"name": name, "objects": metadata_objects, "lines": parts_lines(metadata_objects)}
                                    for name in ("Alpha", "Beta")], "jlcpcb")
assert len(category_combined["lines"]) == 2 and all(len(l["refs"]) == 2 for l in category_combined["lines"])
for prop, values in (("Manufacturer", ("Yageo", "Vishay")), ("Datasheet", ("https://a.test", "https://b.test"))):
    objects = {str(i): sym2(f"R{i}", "10k", "RC") for i in (1, 2)}
    for obj, value in zip(objects.values(), values):
        obj["props"][prop] = value
    lines = parts_lines(objects)
    assert len(lines) == 2 and len({l["key"] for l in lines}) == 2, (prop, lines)
    combined = bom_repository([{"name": "Alpha", "objects": objects, "lines": lines},
                               {"name": "Beta", "objects": objects, "lines": lines}], "pcbway")
    assert len(combined["lines"]) == 2 and all(len(l["refs"]) == 2 for l in combined["lines"]), (prop, combined)
    assert {l[prop.lower()] for l in combined["lines"]} == set(values)
print("ok bom lines")

# Vendored planner (Task 4A): the body is the pinned upstream bom_csv.py, and the licence header sits above it.
import hashlib as _vh
_vendored = pathlib.Path(__file__).with_name("vendor") / "bom_csv.py"
_data = _vendored.read_bytes()
_start = _data.index(b'"""Plan the JLC BOM CSV')
assert _vh.sha256(_data[_start:]).hexdigest() == "3deebff2f36376a561b4014dbbf6ea6c66cd4325b1f614c6bfe4def466569bec", "vendored body differs from kicad-jlcpcb-tools bom_csv.py at 9209edcd"
for marker in (b"MIT License", b"Copyright (c) 2022 bouni", b"9209edcdd682fc4df51e3a0325f967b78ef254ee"):
    assert marker in _data[:_start], marker
import kicad_review as _kr
assert _kr.vendor_bom_csv.BOM_LINE_MAX_BYTES == 2046 and _kr.vendor_bom_csv.BOM_HEADER == ("Comment", "Designator", "Footprint", "LCSC", "Quantity")
print("ok vendored bom_csv")

# BOM files: generic CSV, JLCPCB through the vendored planner with the 2,048-byte limit, PCBWay, and spreadsheet-formula neutering.
import csv as _csv, io as _io2
from kicad_review import BOM_LINE_MAX_BYTES, BOM_JLCPCB_HEADER, bom_exports, csv_line
read = lambda text: list(_csv.reader(_io2.StringIO(text, newline="")))
assert BOM_LINE_MAX_BYTES == 2048
many = parts_lines({f"r{n}": sym2(f"R{n}", "10kΩ", "RC") for n in range(1, 801)})
fab = bom_exports(many, "jlcpcb")["fab"]
rows = read(fab)
assert rows[0] == ["Comment", "Designator", "Footprint", "LCSC", "Quantity"] and len(rows) > 2, len(rows)
assert max(len(line.encode("utf-8")) for line in fab.splitlines(keepends=True)) <= BOM_LINE_MAX_BYTES, "every line within the limit"
assert sum(int(r[4]) for r in rows[1:]) == 800 and all(len(r[1].split(",")) == int(r[4]) for r in rows[1:]), "quantities add up, one per chunk"
assert [ref for r in rows[1:] for ref in r[1].split(",")] == [f"R{n}" for n in range(1, 801)], "no reference lost or reordered"
lone = [{"category": "Other", "refs": ["X1"], "value": "v" * 3000, "footprint": "F", "lcsc": None, "mpn": None, "manufacturer": None, "datasheet": None}]
failed = bom_exports(lone, "jlcpcb")
assert failed["fab"] is None and 'X1' in failed['fabError'] and '2048' in failed['fabError']
assert read(failed['csv'])[1][2] == 'v' * 3000, 'generic CSV stays lossless'
assert read(bom_exports(unannotated, 'jlcpcb')['fab']) == [list(BOM_JLCPCB_HEADER)]
risky = [{"category": "Other", "refs": ["X1"], "value": "=HYPERLINK(\"http://x\")", "footprint": "+3V3", "lcsc": "@x", "mpn": "-1", "manufacturer": None, "datasheet": None}]
assert read(bom_exports(risky, "jlcpcb")["fab"])[1] == ["'=HYPERLINK(\"http://x\")", "X1", "'+3V3", "'@x", "1"]
assert csv_line(["a,b", None, 3]) == '"a,b",,3\r\n'
mixed = parts_lines({"a": sym2("C1", "1u", lib="Device:C_Small"), "b": sym2("R1", "1k", "RC", mf="Yageo"), "c": sym2("R2", "1k", "RC", mf="Yageo")})
generic = read(bom_exports(mixed, "jlcpcb")["csv"])
assert generic[0] == ["Category", "Quantity", "Value", "Footprint", "References", "MPN", "LCSC", "Datasheet"]
assert [r[0] for r in generic[1:]] == ["Resistors", "Capacitors"] and generic[1][1] == "2" and generic[1][4] == "R1, R2", generic
pcbway = bom_exports(mixed, "pcbway")
assert pcbway["preset"] == "pcbway" and read(pcbway["fab"])[:2] == [["Designator", "Qty", "Manufacturer", "Mfg Part #", "Description/Value", "Package/Footprint"], ["R1,R2", "2", "Yageo", "RC", "1k", "R_0805"]]
assert read(bom_exports([], "jlcpcb")["fab"]) == [["Comment", "Designator", "Footprint", "LCSC", "Quantity"]]
# Round-trip hostile cells, including CR/LF, in both layouts and the generic CSV.
for value in ['a,b', 'a"b', 'a\r\nb', '\tleading', '\rleading', '=1', '+1', '-1', '@x']:
    safe = "'" + value if value[:1] in "=+-@\t\r" else value
    line = {**risky[0], 'value': value, 'footprint': value, 'mpn': value, 'lcsc': value, 'manufacturer': value}
    for preset in ('jlcpcb', 'pcbway'):
        x = bom_exports([line], preset)
        assert read(x['csv'])[1][2:8] == [safe, safe, 'X1', safe, safe, '']
        cells = read(x['fab'])[1]
        assert cells == ([safe, 'X1', safe, safe, '1'] if preset == 'jlcpcb' else ['X1', '1', safe, safe, safe, safe])
        if preset == 'jlcpcb':
            assert len(csv_line(cells).encode('utf-8')) <= BOM_LINE_MAX_BYTES
for preset in ('jlcpcb', 'pcbway'):
    objs = {'a': sym2('R1', '1k', 'display-mpn'), 'b': sym2('R2', '1k', 'display-mpn')}
    objs['a']['props']['Order Code'] = 'CUSTOM-A'; objs['b']['props']['Order Code'] = 'CUSTOM-B'
    displayed = parts_lines(objs)
    x = bom_exports(displayed, preset, 'Order Code', objs)
    assert [row[3] for row in read(x['fab'])[1:]] == ['CUSTOM-A', 'CUSTOM-B']
    assert len(displayed) == 1 and displayed[0]['mpn'] == 'display-mpn' and displayed[0]['lcsc'] is None
    default = bom_exports(displayed, preset, None, objs)
    assert read(default['fab'])[1][3] == ('' if preset == 'jlcpcb' else 'display-mpn')
# Fabrication ordering follows the same first eligible unit as the displayed BOM.
for rejected_props in ({'in_bom': 'no'}, {'dnp': 'yes'}):
    excluded_unit = sym2('U1 unit 2', 'TL072', 'EXCLUDED-MPN')
    excluded_unit['props'].update(rejected_props, LCSC='C999', **{'Order Code': 'EXCLUDED-ORDER'})
    fitted_unit = sym2('U1', 'TL072', 'FITTED-MPN')
    fitted_unit['props'].update(LCSC='c123', **{'Order Code': 'FITTED-ORDER'})
    later_unit = sym2('U1 unit 3', 'TL072', 'LATER-MPN')
    later_unit['props'].update(LCSC='C456', **{'Order Code': 'LATER-ORDER'})
    unit_objects = {'excluded': excluded_unit, 'fitted': fitted_unit, 'later': later_unit}
    displayed = parts_lines(unit_objects)
    assert len(displayed) == 1 and displayed[0]['refs'] == ['U1']
    assert (displayed[0]['mpn'], displayed[0]['lcsc']) == ('FITTED-MPN', 'C123')
    for preset, default_order in (('jlcpcb', 'C123'), ('pcbway', 'FITTED-MPN')):
        for part_field, want in ((None, default_order), ('Order Code', 'FITTED-ORDER')):
            exported = bom_exports(displayed, preset, part_field, unit_objects)
            assert exported['fabError'] is None, exported
            rows = read(exported['fab'])
            assert len(rows) == 2 and rows[1][3] == want, (rejected_props, preset, part_field, rows)
            assert rows[1][1 if preset == 'jlcpcb' else 0] == 'U1'
            assert rows[1][4 if preset == 'jlcpcb' else 1] == '1'
            assert read(exported['csv'])[1][5:7] == ['FITTED-MPN', 'C123']
    assert (displayed[0]['mpn'], displayed[0]['lcsc']) == ('FITTED-MPN', 'C123')
    assert 'orderingPart' not in displayed[0], 'fabrication fields must remain transient'
print('ok bom eligible-unit ordering')
# The build_project path passes objects; all supported aliases must survive that path.
from kicad_review import LCSC_FIELDS, MPN_FIELDS
for lcsc_alias in LCSC_FIELDS:
    for mpn_alias in MPN_FIELDS:
        alias_obj = sym2('R1', '1k')
        alias_obj['props'].update({lcsc_alias: 'C123', mpn_alias: 'ABC'})
        alias_objects = {'a': alias_obj}
        alias_lines = parts_lines(alias_objects)
        assert alias_lines[0]['lcsc'] == 'C123' and alias_lines[0]['mpn'] == 'ABC'
        for preset, want in (('jlcpcb', 'C123'), ('pcbway', 'ABC')):
            exported = bom_exports(alias_lines, preset, None, alias_objects)
            assert exported['fabError'] is None and read(exported['fab'])[1][3] == want, (lcsc_alias, mpn_alias, preset, exported)
            custom = bom_exports(alias_lines, preset, 'Order Code', alias_objects)
            assert read(custom['fab'])[1][3] == '', 'explicit missing custom field must not fall back to aliases'
raw_csv = read(bom_exports(raw_lines, 'jlcpcb', None, raw_objs)['csv'])
assert raw_csv[1][2:5] == ['10k', 'R_0805', 'R1, R2'], 'raw parser Value/Footprint serialize without coercion at grouping time'
# Owner decision 2026-10-26: option A, separate writers. Pin the release-writer behaviour without executing KiCad.
import kicad_review as _bomkr
from unittest.mock import patch
with tempfile.TemporaryDirectory() as d:
    pro = pathlib.Path(d, 'only.kicad_pro'); pro.write_text('{}')
    pro.with_suffix('.kicad_sch').write_text('(kicad_sch)')
    for preset in ('jlcpcb', 'pcbway'):
        with patch.object(_bomkr, 'kicad_cli') as cli:
            _bomkr.release_project(str(pro), 'v0', {'fabrication': {'preset': preset, 'part_field': 'Order Code'}}, d, 'only')
        args = cli.call_args.args
        assert args[:3] == ('sch', 'export', 'bom') and '--exclude-dnp' in args
        assert 'Order Code' in args[args.index('--fields') + 1]
        assert args[args.index('--group-by') + 1] == 'Value,Footprint,Order Code'
        assert args[args.index('--labels') + 1].split(',') == (['Comment', 'Designator', 'Footprint', 'LCSC Part #'] if preset == 'jlcpcb' else list(_bomkr.BOM_PCBWAY_HEADER))
# Shared cases with the vendored planner: the adapter writes exactly the rows that plan_bom plans.
import kicad_review as kr
groups = [kr.vendor_bom_csv.BomGroup("10kΩ", tuple(f"R{n}" for n in range(1, 801)), "R_0805", "C1")]
planned = [[str(c) for c in row] for row in kr.vendor_bom_csv.plan_bom(groups, None).lines]
shared = [{"category": "Resistors", "refs": [f"R{n}" for n in range(1, 801)], "value": "10kΩ", "footprint": "R_0805", "lcsc": "C1", "mpn": None, "manufacturer": None, "datasheet": None}]
# LCSC C1 must split successfully under the stricter written-record limit.
assert read(kr.bom_jlcpcb_csv(shared))[1:] == planned
for count in range(300, 701):
    refs = [f"R{n}" for n in range(1, count + 1)]
    exported = kr.bom_exports([{**shared[0], "refs": refs}], "jlcpcb")
    assert exported["fabError"] is None, (count, exported["fabError"])
    assert max(len(row.encode("utf-8")) for row in exported["fab"].splitlines(keepends=True)) <= 2048, count
    rows = read(exported["fab"])[1:]
    assert [ref for row in rows for ref in row[1].split(",")] == refs, count
    assert sum(int(row[4]) for row in rows) == count, count
# The same 800 references with LCSC "C123" plan within the stricter rule, so the adapter writes exactly the planner's rows.
groups = [kr.vendor_bom_csv.BomGroup("10kΩ", tuple(f"R{n}" for n in range(1, 801)), "R_0805", "C123")]
planned = [[str(c) for c in row] for row in kr.vendor_bom_csv.plan_bom(groups, None).lines]
shared = [{**shared[0], "lcsc": "C123"}]
assert read(kr.bom_jlcpcb_csv(shared))[1:] == planned and read(kr.bom_jlcpcb_csv(shared))[0] == list(kr.vendor_bom_csv.BOM_HEADER)
# Line edges, measured as written with the CRLF. A value of 2,031 characters gives a 2,048-byte record (written); 2,032 gives 2,049 (refused).
edge = lambda n: [{"category": "Other", "refs": ["X1"], "value": "v" * n, "footprint": "R_0805", "lcsc": "C1", "mpn": None, "manufacturer": None, "datasheet": None}]
assert len(kr.bom_jlcpcb_csv(edge(2031)).splitlines(keepends=True)[1].encode("utf-8")) == 2048
try:
    kr.bom_jlcpcb_csv(edge(2032))
except ValueError as exc:
    assert "X1" in str(exc) and "2048" in str(exc), exc
else:
    raise AssertionError("a 2,049-byte record with its CRLF must be refused, including the reserved CRLF bytes")
print("ok bom files")

# Repository BOM (Owner decision 2026-10-26: combined BOM): board-qualified references; lines join only on identical identity.
import json as _rjson
import kicad_review as kr
_fixture = _rjson.loads(pathlib.Path(__file__).with_name("ui").joinpath("fixtures", "bom-multiboard.json").read_text(encoding="utf-8"))
boards = [{"name": b["name"], "objects": b["objects"], "lines": kr.parts_lines(b["objects"])} for b in _fixture["boards"]]
combined = kr.bom_repository(boards, "jlcpcb")
assert combined["error"] is None
by_key = {f"{l['mpn']}/{l['lcsc'] or '-'}": l for l in combined["lines"]}
joined = by_key["RC0805/C17414"]
assert joined["refs"] == ["Alpha:R1", "Alpha:R2", "Beta:R1"] and joined["boards"] == {"Alpha": 2, "Beta": 1}, joined
assert joined["refsCompressed"] == "Alpha:R1-R2; Beta:R1", joined["refsCompressed"]
assert by_key["RC0805FR/C17414"]["refs"] == ["Beta:R2"], "same value and footprint, different MPN: never joined"
assert by_key["CC0603/C14663"]["refs"] == ["Alpha:C1"] and by_key["CC0603/-"]["refs"] == ["Beta:C1"], "a missing LCSC is a different line"
assert by_key["TL072/-"]["refs"] == ["Alpha:U1"], "units count once; the DNP R3 stays out"
assert combined["summary"] == {"components": 7, "unique": 5, "withMpn": 5, "byCategory": {"Resistors": 4, "Capacitors": 2, "ICs & Modules": 1}}, combined["summary"]
rows = read(combined["exports"]["csv"])
assert rows[0] == list(kr.BOM_HEADER) and rows[1] == ["Resistors", "3", "10k", "R_0805", "Alpha:R1, Alpha:R2, Beta:R1", "RC0805", "C17414", ""], rows[1]
assert rows[2][4] == "Beta:R2" and len(rows) == 6, rows
fab = read(combined["exports"]["fab"])
assert fab[0] == ["Comment", "Designator", "Footprint", "LCSC", "Quantity"]
assert fab[1] == ["10k", "Alpha:R1,Alpha:R2,Beta:R1", "R_0805", "C17414", "3"], fab[1]
assert fab[2] == ["10k", "Beta:R2", "R_0805", "C17414", "1"], fab[2]
assert fab[3] == ["100n", "Alpha:C1", "C_0603", "C14663", "1"] and fab[4] == ["100n", "Beta:C1", "C_0603", "", "1"] and fab[5] == ["TL072", "Alpha:U1", "SOIC-8", "", "1"], fab
custom = kr.bom_repository(boards, "jlcpcb", "Order Code")
cust = read(custom["exports"]["fab"])
assert cust[1] == ["10k", "Alpha:R1,Alpha:R2", "R_0805", "CUST-A", "2"] and cust[2] == ["10k", "Beta:R1", "R_0805", "CUST-B", "1"], cust[1:3]
assert cust[3] == ["10k", "Beta:R2", "R_0805", "", "1"], "a missing ordering field leaves its cell blank"
dup = kr.bom_repository([boards[0], {**boards[1], "name": "Alpha"}], "jlcpcb")
assert dup["error"] and dup["exports"] is None and dup["lines"] == [], dup
assert read(kr.bom_repository([], "jlcpcb")["exports"]["fab"]) == [list(kr.BOM_JLCPCB_HEADER)]
# PCBWay keeps every qualified reference, including custom ordering-field splits.
pcbway = kr.bom_repository(boards, "pcbway")
assert read(pcbway["exports"]["fab"])[1] == ["Alpha:R1,Alpha:R2,Beta:R1", "3", "Yageo", "RC0805", "10k", "R_0805"]
pcbway_custom = kr.bom_repository(boards, "pcbway", "Order Code")
assert [row[:4] for row in read(pcbway_custom["exports"]["fab"])[1:3]] == [
    ["Alpha:R1,Alpha:R2", "2", "Yageo", "CUST-A"], ["Beta:R1", "1", "Yageo", "CUST-B"]]
for exported, ref_column in ((combined, 1), (pcbway, 0), (custom, 1), (pcbway_custom, 0)):
    assert sorted(ref for row in read(exported["exports"]["fab"])[1:] for ref in row[ref_column].split(",")) == sorted(
        ref for line in combined["lines"] for ref in line["refs"]), "no qualified reference lost or duplicated"
# All four carried identity fields matter, not just the canonical BOM key.
import copy as _rcopy
before = _rcopy.deepcopy(boards)
for identity_field, different in (("key", "different-key"), ("category", "Other"),
                                  ("manufacturer", "Another maker"), ("datasheet", "https://example.test/part.pdf")):
    split_boards = _rcopy.deepcopy(boards)
    beta_shared = next(line for line in split_boards[1]["lines"] if line["mpn"] == "RC0805")
    beta_shared[identity_field] = different
    split = kr.bom_repository(split_boards, "jlcpcb")
    assert split["summary"]["components"] == 7 and split["summary"]["unique"] == 6, (identity_field, split)
    assert all(not {"Alpha:R1", "Beta:R1"} <= set(line["refs"]) for line in split["lines"])
# A board name is not a symbol reference: its literal " unit " must not be stripped.
unit_named = [{**boards[0], "name": "Control unit A"}, boards[1]]
for preset, want in (("jlcpcb", "C17414"), ("pcbway", "RC0805")):
    named = kr.bom_repository(unit_named, preset)
    named_rows = read(named["exports"]["fab"])
    assert all(row[3] == want for row in named_rows[1:] if "Control unit A:R1" in row[1 if preset == "jlcpcb" else 0]), named_rows
    custom_named = kr.bom_repository(unit_named, preset, "Order Code")
    assert any(row[3] == "CUST-A" and "Control unit A:R1" in row[1 if preset == "jlcpcb" else 0]
               for row in read(custom_named["exports"]["fab"])[1:])
assert boards == before, "combining/exporting does not mutate project lines or objects"
assert combined["boards"] == ["Alpha", "Beta"]
blank = kr.bom_repository([{**boards[0], "name": ""}], "jlcpcb")
assert blank["error"] and blank["exports"] is None and blank["lines"] == []
empty = kr.bom_repository([], "jlcpcb")
assert empty["boards"] == [] and empty["error"] is None and empty["summary"] == kr.bom_summary([])
print("ok repository bom")

bom_cases = json.loads((Path(__file__).parent / "ui/fixtures/bom-cases.json").read_text(encoding="utf-8"))
for case in bom_cases:
    identities = {i: bom_identity(o) for i, o in case["objects"].items()}
    expected = case["expect"]
    assert {i: b["included"] for i, b in identities.items()} == expected["included"], case["name"]
    assert {i: b["excludedReason"] for i, b in identities.items()} == expected["excludedReason"], case["name"]
    for i, b in identities.items():
        p = case["objects"][i]["props"]
        assert b["value"] == p.get("Value", "") and b["footprint"] == p.get("Footprint", ""), case["name"]
        assert b["key"] == json.dumps([b["value"], b["footprint"], b["lcsc"] or "", b["mpn"] or "", b["category"], b["manufacturer"], b["datasheet"]], ensure_ascii=False, separators=(",", ":")), case["name"]
    actual = parts_lines(case["objects"])
    assert len(actual) == len(expected["lines"]), (case["name"], actual)
    for got, want in zip(actual, expected["lines"]):
        assert {k: (len(got["refs"]) if k == "quantity" else got[k]) for k in want} == want, (case["name"], got)
        assert all(identities[i]["key"] == got["key"] for i in identities
                   if identities[i]["ref"] in got["refs"] and "unit_identity_conflict" not in got["problems"]), case["name"]
contract_obj = {"kind": "symbol", "ref": "R1 unit 2", "props": {
    "Value": "10kΩ", "Footprint": "R_0805", " LCSC Part # ": " c123 ", "Mfg Part #": " RC ",
    "Mfr.": " Yageo ", "Datasheet": "HTTPS://example.test/rc.pdf", "symbol": "Device:R_Small"}}
assert bom_identity(contract_obj) == {
    "included": True, "excludedReason": None, "ref": "R1", "value": "10kΩ", "footprint": "R_0805",
    "lcsc": "C123", "mpn": "RC", "manufacturer": "Yageo", "datasheet": "HTTPS://example.test/rc.pdf",
    "category": "Resistors", "key": '["10kΩ","R_0805","C123","RC","Resistors","Yageo","HTTPS://example.test/rc.pdf"]'}
contract_obj["props"]["Datasheet"] = "javascript:alert(1)"
assert bom_identity(contract_obj)["datasheet"] is None
print("ok bom shared cases")


# Project payload and report settings omit opted-out features; supplier lookup remains deferred.
import copy
here = os.getcwd()
t = tempfile.mkdtemp()
try:
    os.chdir(t)
    project = {"dir": "P", "name": "P", "status": "modified"}
    write(t, {"review/detect.json": json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": [project]})})
    objects = {"base": {"r": sym("R1", "10k", "C1")}, "head": {"r": sym("R1", "10k", "C9")}}
    with patch("kicad_review.project_objects", side_effect=lambda path, name, issues=None: objects[path.split("/")[0]]), \
         patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
        for parts_enabled in (False, True):
            for models_enabled in (False, True):
                settings = copy.deepcopy(DEFAULT_SETTINGS)
                settings["parts"]["enabled"] = parts_enabled
                settings["3d"]["enabled"] = models_enabled
                with patch("kicad_review.load_settings", return_value=settings):
                    kicad_review.cmd_report(None)
                opted_out = json.loads(pathlib.Path("review/data.json").read_text())
                opted_out_embedded = json.loads(pathlib.Path("review/kicad-review.html").read_text().split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0])
                legacy_settings = copy.deepcopy(settings)
                del legacy_settings["digikey"]
                with patch("kicad_review.load_settings", return_value=legacy_settings):
                    kicad_review.cmd_report(None)
                data = json.loads(pathlib.Path("review/data.json").read_text())
                assert data == opted_out, "DigiKey opt-out must preserve pre-feature report data and settings"
                assert "digikey" not in data["settings"]
                p = data["projects"][0]
                assert ("parts" in data["settings"]) == ("parts" in p) == parts_enabled
                assert ("3d" in data["settings"]) == models_enabled
                assert "waivers" not in data["settings"] and "waivers" not in data
                if parts_enabled:
                    lines = {s: parts_lines(objects[s]) for s in ("base", "head")}
                    mark_new_problems(lines["base"], lines["head"])
                    assert {k: p["parts"][k] for k in ("lines", "changes", "supplier")} == {"lines": lines["head"], "changes": diff_parts(lines["base"], lines["head"]), "supplier": None}
                    assert set(p["parts"]) == {"lines", "changes", "supplier", "summary", "exports", "coverage", "field_changes", "dnp_mismatch"}
                    assert p["parts"]["summary"] == {"components": 1, "unique": 1, "withMpn": 0, "byCategory": {"Resistors": 1}}
                    assert p["parts"]["exports"]["preset"] == "jlcpcb" and p["parts"]["exports"]["fab"].startswith("Comment,Designator,Footprint,LCSC,Quantity\r\n")
                    assert p["parts"]["lines"][0]["category"] == "Resistors" and p["parts"]["lines"][0]["refsCompressed"] == "R1"
                    assert p["parts"]["changes"][0]["action"] == "swapped"
                    assert all("supplier" not in line for line in p["parts"]["lines"])
                html = pathlib.Path("review/kicad-review.html").read_text()
                for old_label in ("not found at JLCPCB", "JLCPCB data as of", '"LCSC", "JLCPCB", "PCBWay"'):
                    assert old_label not in html, old_label
                payload = html.split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0]
                embedded = json.loads(payload)
                assert embedded == opted_out_embedded
                del embedded["blobs"]
                assert embedded == compact_bom_lines(data)
                assert all("key" not in l and None not in l.values() for q in embedded["projects"] if "parts" in q for l in q["parts"]["lines"]), "embedded lines drop key and null fields"
                assert all("key" in l for q in data["projects"] if "parts" in q for l in q["parts"]["lines"]), "data.json keeps them"
                changed_lines = lambda d: [x for q in d["projects"] if "parts" in q for c in q["parts"]["changes"] for x in (c["before"], c["after"]) if x]
                assert all("key" not in x and None not in x.values() for x in changed_lines(embedded)), "embedded change lines drop key and null fields"
                assert not parts_enabled or (changed_lines(data) and all("key" in x for x in changed_lines(data))), "data.json change lines keep key"
                assert "bom" not in data, "single-project reports keep their existing payload shape"
        # Report-level BOM appears in both offline HTML and JSON only with multiple opted-in projects.
        multi_projects = [{"dir": b["name"], "name": b["name"], "status": "modified"} for b in boards]
        write(t, {"review/detect.json": json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": multi_projects})})
        board_objects = {b["name"]: b["objects"] for b in boards}
        for enabled in (False, True):
            settings["parts"]["enabled"] = enabled
            with patch("kicad_review.project_objects", side_effect=lambda path, name, issues=None: board_objects[name]), \
                 patch("kicad_review.load_settings", return_value=settings), patch("sys.stdout", new=io.StringIO()):
                kicad_review.cmd_report(None)
            multi_data = json.loads(pathlib.Path("review/data.json").read_text())
            embedded = json.loads(pathlib.Path("review/kicad-review.html").read_text().split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0])
            del embedded["blobs"]
            assert embedded == compact_bom_lines(multi_data)
            assert ("bom" in multi_data) == enabled
            if enabled:
                assert embedded["bom"]["lines"] and all("key" not in l and None not in l.values() for l in embedded["bom"]["lines"]), "embedded repo lines drop key and null fields"
                assert all("key" in l for l in multi_data["bom"]["lines"]), "data.json repo lines keep key"
                assert multi_data["bom"] == combined
                assert multi_data["bom"]["summary"]["components"] == sum(p["parts"]["summary"]["components"] for p in multi_data["projects"])
            else:
                no_sink = []
                build_project(project, {}, settings, None, 0, no_sink)
                assert no_sink == [], "disabled parts must not append repository BOM inputs"
        settings["parts"]["enabled"] = True
        sink = []
        with_sink = build_project(project, {}, settings, None, 0, sink)
        assert [(s["name"], s["lines"]) for s in sink] == [(project["name"], with_sink["parts"]["lines"])], "build_project hands the head lines to the repository BOM"
        assert sink[0]["objects"] == objects["head"], "the sink carries head properties, not base properties"
        with patch("kicad_review.project_objects", return_value={}):
            empty = build_project(project, {}, settings)["parts"]
            assert {k: empty[k] for k in ("lines", "changes", "supplier", "field_changes", "dnp_mismatch")} == {"lines": [], "changes": [], "supplier": None, "field_changes": [], "dnp_mismatch": []}
            assert empty["coverage"]["base"] is None and all(v == [0, 0] for v in empty["coverage"]["head"].values())
            assert empty["summary"] == {"components": 0, "unique": 0, "withMpn": 0, "byCategory": {}} and empty["exports"]["fab"] == "Comment,Designator,Footprint,LCSC,Quantity\r\n"
            with patch('kicad_review.bom_jlcpcb_csv', side_effect=ValueError('X1 exceeds 2048 bytes')):
                usable = build_project(project, {}, settings)['parts']
                assert usable['exports']['fab'] is None and usable['exports']['csv'] and '2048' in usable['exports']['fabError']
                assert usable['summary']['components'] == 0
            settings["fabrication"]["preset"] = "pcbway"
            assert build_project(project, {}, settings)["parts"]["exports"]["preset"] == "pcbway"
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
assert "DigiKey data as of 2026-10-08 14:02 UTC" in parts_markdown({"projects": [p]})
assert "#### Parts: X" in comment_markdown({**d2, "projects": [{**p, "dir": "", "status": "modified", "changes": [], "checks": []}]}, [], "")
conflict = {"refs": ["R2"], "value": "1k", "lcsc": "C1", "problems": ["lcsc_conflict"]}
m = parts_markdown({"projects": [{"name": "C", "parts": {"lines": [conflict], "supplier": None,
    "changes": [{"action": "added", "refs": ["R2"], "before": None, "after": conflict}]}}]})
assert "1 with a problem" in m and "R2 one LCSC number on several values" in m, "conflict counts as a problem: " + m
# Otherwise-valid units must not hide their identity disagreement behind a clean report.
from kicad_review import BLOCKING, mark_new_problems
unit_objects = {str(i): {"kind": "symbol", "ref": ref, "props": {
    "Value": "TL072", "Footprint": "SOIC-8", "LCSC": "C123", "MPN": mpn}}
    for i, (ref, mpn) in enumerate((("U1", "A"), ("U1 unit 2", "B")))}
unit_lines = parts_lines(unit_objects)
assert len(unit_lines) == 1 and unit_lines[0]["refs"] == ["U1"], unit_lines
assert unit_lines[0]["problems"] == ["unit_identity_conflict"], unit_lines
assert BLOCKING & set(unit_lines[0]["problems"]), "unit identity conflict blocks ordering"
unit_parts = {"lines": unit_lines, "changes": diff_parts([], unit_lines), "supplier": None}
for canonical in (False, True):
    if canonical:
        mark_new_problems([], unit_lines)
    unit_markdown = parts_markdown({"projects": [{"name": "Units", "parts": unit_parts}]})
    assert "1 line, 1 with a problem." in unit_markdown, unit_markdown
    assert "1 problem introduced" in unit_markdown, unit_markdown
    assert "U1 conflicting identities across symbol units" in unit_markdown, unit_markdown
print("ok unit identity conflict report")
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

# Tag review resolves lightweight/annotated tags, ignoring non-v predecessors.
from kicad_review import resolve_revisions
here = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        def g(*args):
            return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True, capture_output=True, text=True).stdout.strip()
        g("init", "-q")
        pathlib.Path("P.kicad_pro").write_text("1")
        g("add", "."); g("commit", "-qm", "one"); g("tag", "v1.0")
        first = g("rev-parse", "HEAD")
        pathlib.Path("P.kicad_pro").write_text("2")
        g("commit", "-qam", "two"); g("tag", "test-1")
        pathlib.Path("P.kicad_pro").write_text("3")
        g("commit", "-qam", "three"); g("tag", "-am", "release", "v1.1")
        head = g("rev-parse", "HEAD")
        g("branch", "v1.1", first)  # A same-named branch must not shadow the pushed tag.
        assert resolve_revisions({"EVENT": "push", "TAG": "test-1", "AFTER": head}) == (first, g("rev-parse", "test-1"), "release test-1 vs v1.0")
        assert resolve_revisions({"EVENT": "push", "TAG": "v1.1", "AFTER": head}) == (first, head, "release v1.1 vs v1.0")
        assert resolve_revisions({"EVENT": "push", "TAG": "v1.0", "AFTER": first}) == (None, first, "release v1.0 (first release)")
        print("ok previous tag is the last v-tag")
        print("ok first tag has no base")
        assert DEFAULT_SETTINGS["release"] == {"review": False}
        output = pathlib.Path("outputs")
        with patch.dict(os.environ, {"TAG": "v1.1", "GITHUB_OUTPUT": str(output)}, clear=True), patch("kicad_review.resolve_revisions", side_effect=AssertionError("off must skip detection")):
            kicad_review.cmd_detect(None)
        assert output.read_text() == "base=\nhead=\nchanged=false\n"
        pathlib.Path("kicad-review.toml").write_text("[release]\nreview = true\n")
        assert load_settings(("",))["release"]["review"] is True
        for invalid in ('"true"', '1', '[]'):
            pathlib.Path("kicad-review.toml").write_text("[release]\nreview = " + invalid + "\n")
            try:
                load_settings(("",))
                raise AssertionError("invalid release.review accepted")
            except SystemExit as exc:
                assert str(exc) == "kicad-review.toml: release.review must be true or false"
        print("ok tag detection opt-in and settings")
    finally:
        os.chdir(here)

# Workflow-only release settings cannot change existing report/comment/summary bytes.
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        write(t, {"review/detect.json": json.dumps({"base": "a" * 40, "head": "b" * 40, "reason": "fixture", "projects": []})})
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings.pop("release")
        results = []
        for option in (None, False, True):
            current = copy.deepcopy(settings)
            if option is not None:
                current["release"] = {"review": option}
            with patch("kicad_review.load_settings", return_value=current):
                kicad_review.cmd_report(None)
            data = json.loads(pathlib.Path("review/data.json").read_text())
            pathlib.Path("summary.md").write_text("")
            with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": "summary.md"}), patch("sys.stdout", new=io.StringIO()):
                kicad_review.cmd_summary(type("A", (), {"image_base": "", "artifact_url": "", "artifact_id": ""}))
            results.append((pathlib.Path("review/data.json").read_bytes(), pathlib.Path("review/kicad-review.html").read_bytes(), pathlib.Path("review/comment.md").read_bytes(), pathlib.Path("summary.md").read_bytes()))
        assert results[0] == results[1] == results[2]
        print("ok release settings preserve report and summary bytes")
    finally:
        os.chdir(here)

# Release section preserves manual notes, is idempotent, and escapes untrusted data.
from kicad_review import release_notes, merge_notes, cmd_release_notes
rdata = {**d2, "repo": "o/r", "reason": "release v1.1 vs v1.0", "projects": [{"name": "Cam", "dir": "", "status": "modified", "changes": [], "checks": [
    {"name": "drc", "title": "DRC", "level": "required", "status": "pass", "errors": 0, "new_errors": 0, "warnings": 2, "new_warnings": 0, "fixed": 0, "violations": []}]}]}
sec = release_notes(rdata, "https://site.example", "77")
assert sec.startswith("<!-- kicad-review-release -->") and sec.rstrip().endswith("<!-- /kicad-review-release -->")
assert "release v1.1 vs v1.0" in sec and "**Cam**: no reviewable changes" in sec and "DRC ✅ pass (0 errors, 2 warnings)" in sec
assert "[Open the review](https://site.example/r/o/r/a/77)" in sec
once = merge_notes("## What's Changed\n* x\n", sec)
twice = merge_notes(once + "\nhand-written footer\n", sec.replace("2 warnings", "3 warnings"))
assert twice.count("<!-- kicad-review-release -->") == 1
assert "## What's Changed\n* x" in twice and "hand-written footer" in twice and "3 warnings" in twice and "2 warnings" not in twice
assert merge_notes(twice, sec.replace("2 warnings", "3 warnings")) == twice
assert "Open the review" not in release_notes(rdata, "javascript:alert(1)", "77")
assert "Open the review" not in release_notes(rdata, "https://site.example:bad", "77")
assert "Open the review" not in release_notes(rdata, "https://@site.example", "77")
assert "Open the review" not in release_notes(rdata, "https://site.example/x)\n# injected", "77")
assert "Open the review" not in release_notes(rdata, "https://site.example", "x")
evil = copy.deepcopy(rdata)
evil["reason"] = "release <b>\n# injected"
evil["projects"][0]["name"] = "Cam\n# injected"
evil["projects"][0]["checks"][0]["title"] = "DRC\n<script>"
escaped = release_notes(evil, "", "")
assert "\n# injected" not in escaped and "<script>" not in escaped and "<b>" not in escaped
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        write(t, {"review/data.json": json.dumps(rdata), "existing.md": "manual body"})
        with patch.dict(os.environ, {"SITE": "https://site.example"}):
            cmd_release_notes(type("A", (), {"existing": "existing.md", "artifact_id": "77"}))
        assert pathlib.Path("review/release-notes.md").read_text() == merge_notes("manual body", sec)
    finally:
        os.chdir(here)
print("ok notes section is replaced, not added twice")

wf = pathlib.Path(".github/workflows/review.yml").read_text()
detect_step = wf[wf.index("- name: Find all KiCad projects (changed first)"):wf.index("- name: Check out both")]
assert "refs/tags" not in detect_step.splitlines()[2]
assert "TAG: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}" in detect_step
fail_step = wf[wf.index("- name: Fail on required checks"):wf.index("- name: Fabrication outputs")]
assert "!startsWith(github.ref, 'refs/tags/')" in fail_step
fab_step = wf[wf.index("- name: Fabrication outputs"):wf.index("- name: Attach to")]
attach_step = wf[wf.index("- name: Attach to"):wf.index("- name: Write release notes")]
assert "always()" in fab_step and "!cancelled()" in fab_step and "id: fabrication" in fab_step
assert "always()" in attach_step and "steps.fabrication.outcome == 'success'" in attach_step
notes_step = wf[wf.index("- name: Write release notes"):]
assert "continue-on-error: true" in notes_step and "steps.report.outcome == 'success'" in notes_step
assert '--existing review/release-body.md --artifact-id "$ARTIFACT_ID"' in notes_step
print("ok tag workflow wiring")

# Final review: an orphan marker must never consume subsequent manual notes.
orphan = "<!-- kicad-review-release -->\nhuman text that must survive\n"
merged = merge_notes(orphan, sec)
merged_again = merge_notes(merged, sec.replace("2 warnings", "3 warnings"))
assert merged_again.startswith(orphan) and "human text that must survive" in merged_again
assert merge_notes(merged_again, sec.replace("2 warnings", "3 warnings")) == merged_again
print("ok orphaned release marker preserves human notes")

# Invalid tag settings remain off without invoking revision detection.
for settings_error in (SystemExit("invalid settings"), kicad_review.tomllib.TOMLDecodeError("bad TOML")):
    output = io.StringIO()
    class KeepOpen(io.StringIO):
        def close(self):
            pass
    written = KeepOpen()
    with patch.dict(os.environ, {"TAG": "v1"}, clear=True), patch("kicad_review.load_settings", side_effect=settings_error), patch("kicad_review.open", return_value=written), patch("sys.stdout", new=output), patch("kicad_review.resolve_revisions", side_effect=AssertionError("must stay off")):
        kicad_review.cmd_detect(None)
    assert written.getvalue() == "base=\nhead=\nchanged=false\n"
    assert "::warning::" in output.getvalue()
print("ok invalid tagged settings keep detection off")

checkout_tools = wf[wf.index("- name: Check out review tools"):wf.index("- name: Find all KiCad projects (changed first)")]
assert "id: tools" in checkout_tools
assert "steps.tools.outcome == 'success'" in fab_step
assert "steps.report.outcome" not in fab_step, "review failures must not suppress fabrication"
print("ok fabrication requires successful tool checkout")

# Execute the notes shell with a local gh stub, proving a changed body is not overwritten.
import textwrap
script = textwrap.dedent(notes_step.split("run: |\n", 1)[1])
tool_source = pathlib.Path(kicad_review.__file__).read_text()
vendor_source = pathlib.Path(kicad_review.__file__).with_name("vendor").joinpath("bom_csv.py").read_text()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        write(t, {"review/data.json": json.dumps(rdata), "tools/kicad_review.py": tool_source,
                  "tools/vendor/bom_csv.py": vendor_source,
                  "tools/image-palettes.json": json.dumps(kr.IMAGE_PALETTES),
                  "bin/gh": "#!" + sys.executable + "\nimport os, pathlib, sys\nif sys.argv[2] == 'view':\n p = pathlib.Path('view-count'); n = int(p.read_text()) if p.exists() else 0; p.write_text(str(n + 1)); print('changed notes' if n and os.environ['BODY_CHANGED'] == '1' else 'human notes')\nelif sys.argv[2] == 'edit':\n pathlib.Path('edited').write_text('yes')\n"})
        pathlib.Path("bin/gh").chmod(0o755)
        for changed in (False, True):
            pathlib.Path("view-count").unlink(missing_ok=True)
            pathlib.Path("edited").unlink(missing_ok=True)
            result = subprocess.run(["bash", "-e", "-c", script], capture_output=True, text=True, env={**os.environ, "PATH": f"{t}/bin:" + os.environ["PATH"], "BODY_CHANGED": str(int(changed)), "GITHUB_REF_NAME": "v1", "GITHUB_REPOSITORY": "o/r", "ARTIFACT_ID": "77"})
            assert result.returncode == 0, result.stderr
            assert pathlib.Path("edited").exists() is not changed
            assert int(pathlib.Path("view-count").read_text()) == 2
            if changed:
                assert "::warning::" in result.stdout
    finally:
        os.chdir(here)
print("ok release notes re-read prevents stale body edits")


# DigiKey client: only the MPN is sent; each MPN once; 429 stops the run; ambiguous MPNs show no price.
import io as _io, urllib.error
from kicad_review import mpn_for_lookup, digikey_lookup, digikey_pick
assert mpn_for_lookup(" mp3302dj-lf-z ") == "mp3302dj-lf-z" and mpn_for_lookup("TBD") is None and mpn_for_lookup("<script>") is None
calls = []
def resp(obj, status=200, headers=None):
    r = _io.BytesIO(json.dumps(obj).encode()); r.status = status; r.headers = headers or {}; return r
prod = lambda mpn, mfr, qty, price: {"ManufacturerProductNumber": mpn, "Manufacturer": {"Name": mfr}, "QuantityAvailable": qty, "UnitPrice": price,
    "ProductStatus": {"Status": "Active"}, "Discontinued": False, "EndOfLife": False, "ProductUrl": "https://www.digikey.com/x",
    "ProductVariations": [{"DigiKeyProductNumber": "DK-1", "StandardPricing": [{"BreakQuantity": 1, "UnitPrice": price}, {"BreakQuantity": 10, "UnitPrice": price * 0.8}]}]}
def fake(req, timeout=None):
    body = req.data.decode() if req.data else ""
    calls.append((req.full_url, body))
    if req.full_url.endswith("/oauth2/token"):
        return resp({"access_token": "T", "expires_in": 599})
    kw = json.loads(body)["Keywords"]
    if kw == "LIMIT":
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {"Retry-After": "60"}, _io.BytesIO(b"{}"))
    if kw == "CR2032":
        return resp({"ExactMatches": [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)], "Products": [], "ProductsCount": 2})
    if kw == "NOPE":
        return resp({"ExactMatches": [], "Products": [], "ProductsCount": 0})
    return resp({"ExactMatches": [prod(kw, "MPS", 1234, 1.5)], "Products": [], "ProductsCount": 1, "SearchLocaleUsed": {"Currency": "USD"}})
s = json.loads(json.dumps(DEFAULT_SETTINGS)); s["parts"]["enabled"] = True; s["digikey"]["enabled"] = True
wanted = {"MP3302DJ-LF-Z": {"mpn": "MP3302DJ-LF-Z", "manufacturer": None}, "CR2032": {"mpn": "CR2032", "manufacturer": None},
          "NOPE": {"mpn": "NOPE", "manufacturer": None}}
out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fake, sleep=lambda t: None, now=lambda: "2026-10-13T12:00:00Z")
assert sum(u.endswith("/oauth2/token") for u, _ in calls) == 1 and len(calls) == 4, calls
assert all(json.loads(b) == {"Keywords": json.loads(b)["Keywords"], "Limit": 10, "Offset": 0} for u, b in calls[1:]), calls
r = out["results"]
assert r["MP3302DJ-LF-Z"]["status"] == "ok" and r["MP3302DJ-LF-Z"]["quantity"] == 1234 and r["MP3302DJ-LF-Z"]["breaks"][1] == [10, 1.2]
assert r["CR2032"]["status"] == "ambiguous" and r["CR2032"].get("unit_price") is None and r["CR2032"]["matches"] == 2
assert r["NOPE"]["status"] == "not_found"
assert out["supplier"]["calls"] == 4 and out["supplier"]["fetched_at"] == "2026-10-13T12:00:00Z" and out["supplier"]["error"] is None
print("ok each MPN fetched once")
print("ok ambiguous MPN")
assert digikey_pick({"ExactMatches": [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)]}, "CR2032", "renata")["quantity"] == 7
calls.clear()
wanted = {"A": {"mpn": "A", "manufacturer": None}, "LIMIT": {"mpn": "LIMIT", "manufacturer": None}, "Z": {"mpn": "Z", "manufacturer": None}}
out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fake, sleep=lambda t: None, now=lambda: "2026-10-13T12:00:00Z")
assert out["results"]["A"]["status"] == "ok" and out["results"]["LIMIT"]["status"] == "unavailable" and out["results"]["Z"]["status"] == "unavailable"
assert len(calls) == 3 and "rate limit" in out["supplier"]["error"], (calls, out["supplier"])
print("ok rate limit stops the run")

# DigiKey settings validate even when disabled; booleans are not lookup counts.
for value in ("", "~", "TBD", "?", "X", "todo", "NA", "n/a", "-"):
    assert mpn_for_lookup(value) is None
assert mpn_for_lookup(" A   B ") == "A B"
for text in ('[digikey]\nenabled = "yes"', '[digikey]\nenabled = true', '[digikey]\nsite = "us"',
             '[digikey]\ncurrency = "US"', '[digikey]\nmax_lookups = true', '[digikey]\nmax_lookups = 0',
             '[digikey]\nmax_lookups = 901', 'digikey = false'):
    with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(text.encode()), create=True):
        try:
            load_settings()
        except SystemExit:
            pass
        else:
            raise AssertionError(text)
with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(b'[parts]\nenabled = true\n[digikey]\nenabled = true\nsite = "CA"\ncurrency = "CAD"\nmax_lookups = 900'), create=True):
    assert load_settings()["digikey"] == {"enabled": True, "site": "CA", "currency": "CAD", "max_lookups": 900}

# Error paths use only injected transports; a failed run never leaks response bodies.
for code in (403,):
    calls.clear()
    def fail(req, timeout=None):
        calls.append(req.full_url)
        if req.full_url.endswith("/oauth2/token"):
            return resp({"access_token": "T"})
        raise urllib.error.HTTPError(req.full_url, code, "secret response", {}, _io.BytesIO(b"secret"))
    out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fail, sleep=lambda t: None)
    assert len(calls) == 2 and all(v["status"] == "unavailable" for v in out["results"].values())
    assert out["supplier"]["error"] and "secret" not in json.dumps(out)
calls.clear()
s["digikey"]["max_lookups"] = 1
out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=fake, sleep=lambda t: None)
assert len(calls) == 2 and out["results"]["Z"]["status"] == "run_limit"
print("ok DigiKey validation, failure handling, and run limit")

from kicad_review import digikey_search, DigiKeyError
for data in ({}, [], "invalid"):
    out = digikey_lookup(wanted, ("id", "secret"), s, urlopen=lambda req, timeout=None: resp(data), sleep=lambda t: None)
    assert out["supplier"]["calls"] == 1 and out["supplier"]["error"].startswith("sign-in failed:")
def missing(req, timeout=None):
    raise urllib.error.HTTPError(req.full_url, 404, "missing", {}, _io.BytesIO(b"{}"))
assert digikey_pick(digikey_search("T", "id", "NOPE", {"site": "US", "currency": "USD"}, urlopen=missing), "NOPE", None)["status"] == "not_found"
assert digikey_pick({"ExactMatches": [prod("A", "MPS", 0, 1.5)]}, "A", None)["status"] == "out_of_stock"
p = prod("A", "MPS", 5, 1.5); p["EndOfLife"] = True
assert digikey_pick({"ExactMatches": [p]}, "A", None)["status"] == "discontinued"
s["digikey"]["max_lookups"] = 100
pauses = []
digikey_lookup({"A": {"mpn": "A", "manufacturer": None}, "B": {"mpn": "B", "manufacturer": None}}, ("id", "secret"), s, urlopen=fake, sleep=pauses.append)
assert pauses == [0.6]
print("ok DigiKey token errors, 404, statuses, and pacing")

# Task 2 review regressions. Each transport is local; no real HTTP requests.
import unittest
import inspect
import http.client

class DigiKeyReviewTests(unittest.TestCase):
    def run_lookup(self, events):
        calls, pauses = [], []
        queue = iter(events)
        def transport(req, timeout=None):
            calls.append(req.full_url)
            self.assertEqual(timeout, 15)
            if req.full_url.endswith("/oauth2/token"):
                return resp({"access_token": "T"})
            event = next(queue)
            if isinstance(event, int):
                raise urllib.error.HTTPError(req.full_url, event, "secret", {}, _io.BytesIO(b"secret"))
            if isinstance(event, Exception):
                raise event
            mpn = json.loads(req.data)["Keywords"]
            return resp(event if event is not None else {"ExactMatches": [prod(mpn, "MPS", 10, 1.5)]})
        wanted = {key: {"mpn": key, "manufacturer": None} for key in "ABCDE"}
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings["parts"]["enabled"] = settings["digikey"]["enabled"] = True
        return digikey_lookup(wanted, ("id", "secret"), settings, urlopen=transport, sleep=pauses.append), calls, pauses

    def test_1_product_urls(self):
        for url in ("https://www.digikey.evil.com/x", "https://www.digikey.com@evil.com/x",
                    "https://www.digikey.com:443/x", "https://user@www.digikey.com/x", "http://www.digikey.com/x"):
            p = prod("A", "MPS", 10, 1.5); p["ProductUrl"] = url
            self.assertIsNone(digikey_pick({"ExactMatches": [p]}, "A", None)["url"], url)
        p["ProductUrl"] = "https://www.digikey.ca/en/products/x"
        self.assertEqual(digikey_pick({"ExactMatches": [p]}, "A", None)["url"], p["ProductUrl"])

    def test_2_malformed_responses(self):
        out, calls, _ = self.run_lookup([http.client.IncompleteRead(b"secret"), None, None, None, None])
        self.assertEqual(out["results"]["A"]["status"], "unavailable")
        self.assertEqual(out["results"]["B"]["status"], "ok")
        p = prod("CR2032", "MPS", 10, 1.5); p["Manufacturer"]["Name"] = None
        other = prod("CR2032", "Renata", 20, 2)
        self.assertEqual(digikey_pick({"ExactMatches": [p, other]}, "CR2032", "Renata")["quantity"], 20)
        p["ManufacturerProductNumber"] = 123
        self.assertEqual(digikey_pick({"ExactMatches": [p]}, "123", None)["status"], "ok")
        out, _, _ = self.run_lookup([{"ExactMatches": [None]}, None, None, None, None])
        self.assertEqual(out["results"]["A"], {"status": "unavailable", "mpn": "A"})
        self.assertEqual(out["supplier"]["error"], "1 lookups failed (last: invalid response)")

    def test_3_transient_and_consecutive_errors(self):
        out, calls, _ = self.run_lookup([None, 500, None, None, None])
        self.assertEqual(out["results"]["C"]["status"], "ok")
        self.assertEqual(out["supplier"]["error"], "1 lookups failed (last: HTTP 500)")
        self.assertEqual(len(calls), 6)
        out, calls, _ = self.run_lookup([500, 500, 500])
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(p["status"] == "unavailable" for p in out["results"].values()))
        out, calls, _ = self.run_lookup([500, None, 500, None, 500])
        self.assertEqual(len(calls), 6)
        self.assertEqual(out["supplier"]["error"], "3 lookups failed (last: HTTP 500)")

    def test_4_token_refresh(self):
        out, calls, pauses = self.run_lookup([401, None, None, None, None, None])
        self.assertEqual(out["results"]["A"]["status"], "ok")
        self.assertEqual(sum(u.endswith("/oauth2/token") for u in calls), 2)
        self.assertEqual(out["supplier"]["calls"], 8)
        self.assertNotIn("looked_up", out["supplier"])
        self.assertIsNone(out["supplier"]["error"])
        self.assertTrue(all(t >= 0.6 for t in pauses))
        out, calls, _ = self.run_lookup([401, 401])
        self.assertEqual(len(calls), 4)
        self.assertEqual(out["supplier"]["error"], "HTTP 401")
        out, calls, _ = self.run_lookup([401, None, 401])
        self.assertEqual(len(calls), 5)
        self.assertTrue(all("error" not in p for p in out["results"].values()))

    def test_5_no_line_errors(self):
        out, _, _ = self.run_lookup([500, None, None, None, None])
        self.assertEqual(out["results"]["A"], {"status": "unavailable", "mpn": "A"})
        self.assertNotIn("secret", json.dumps(out))

    def test_6_no_redundant_urlerror(self):
        self.assertNotIn("urllib.error.URLError", inspect.getsource(kicad_review._digikey_open))

    def test_7_manufacturer_whitespace(self):
        products = [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)]
        self.assertEqual(digikey_pick({"ExactMatches": products}, "CR2032", "  RENATA  ")["quantity"], 7)

    def test_8_unmatched_manufacturer(self):
        products = [prod("CR2032", "Panasonic", 5, 0.3), prod("CR2032", "Renata", 7, 0.4)]
        result = digikey_pick({"ExactMatches": products}, "CR2032", "Unknown")
        self.assertEqual(result, {"status": "ambiguous", "mpn": "CR2032", "matches": 2})
        self.assertNotIn("unit_price", result)

review_result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DigiKeyReviewTests))
assert review_result.wasSuccessful(), "DigiKey review regressions failed"

class DigiKeyIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.here = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)
        write(self.tmp.name, {"review/detect.json": json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": [{"dir": "p", "name": "P", "status": "modified"}]})})
        self.settings = copy.deepcopy(DEFAULT_SETTINGS)
        self.settings["parts"]["enabled"] = self.settings["digikey"]["enabled"] = True
        self.objects = {"1": sym("U1", "reg", "C1"), "2": sym("R1", "10k", "C2"), "3": sym("R2", "20k", "C3")}
        self.objects["1"]["props"].update(MPN=" mp3302dj-lf-z ", Manufacturer=" MPS ")
        self.objects["3"]["props"]["MPN"] = "<invalid>"

    def tearDown(self):
        os.chdir(self.here)
        self.tmp.cleanup()

    def lookup(self, creds=("", "")):
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch.dict(os.environ, {"DIGIKEY_CLIENT_ID": creds[0], "DIGIKEY_CLIENT_SECRET": creds[1]}), patch("kicad_review.digikey_lookup") as client:
            client.return_value = {"supplier": {"name": "DigiKey", "fetched_at": "2026-10-13T12:00:00Z", "currency": "USD", "calls": 2, "error": None, "skipped": None}, "results": {"MP3302DJ-LF-Z": {"status": "ok", "mpn": "MP3302DJ-LF-Z", "quantity": 1234, "unit_price": 1.5}}}
            kicad_review.cmd_lookup(None)
            return client

    def test_no_credentials_and_off(self):
        client = self.lookup()
        self.assertFalse(client.called)
        data = json.loads(pathlib.Path("review/supplier.json").read_text())
        self.assertEqual(data["supplier"]["calls"], 0)
        self.assertEqual(data["supplier"]["skipped"], "no credentials (forked pull request or secrets not set)")
        self.assertEqual(data["results"], {})
        self.assertNotIn("projects", data)
        self.assertNotIn("looked_up", data["supplier"])
        pathlib.Path("review/supplier.json").unlink()
        self.settings["digikey"]["enabled"] = False
        self.assertFalse(self.lookup(("id", "secret")).called)
        self.assertFalse(pathlib.Path("review/supplier.json").exists())

    def test_deduplication_and_conflicting_manufacturers(self):
        self.objects["3"]["props"].update(MPN="MP3302DJ-LF-Z", Manufacturer="Renata")
        client = self.lookup(("id", "secret"))
        self.assertEqual(client.call_args.args[0], {"MP3302DJ-LF-Z": {"mpn": "MP3302DJ-LF-Z", "manufacturer": None}})
        self.assertNotIn("secret", pathlib.Path("review/supplier.json").read_text())

    def test_merge_and_opt_out_identity(self):
        self.lookup(("id", "secret"))
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
            kicad_review.cmd_report(None)
            data = json.loads(pathlib.Path("review/data.json").read_text())
            parts = data["projects"][0]["parts"]
            self.assertEqual(next(line for line in parts["lines"] if "U1" in line["refs"])["supplier"]["status"], "ok")
            self.assertEqual(parts["supplier"]["not_looked_up"], {"no_mpn": 1, "invalid_mpn": 1, "run_limit": 0})
            self.settings["digikey"]["enabled"] = False
            kicad_review.cmd_report(None)
            before = {name: pathlib.Path(f"review/{name}").read_bytes() for name in ("data.json", "kicad-review.html")}
            pathlib.Path("review/supplier.json").unlink()
            kicad_review.cmd_report(None)
            self.assertTrue(all(pathlib.Path(f"review/{name}").read_bytes() == content for name, content in before.items()))
            self.assertIsNone(json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]["supplier"])

    def test_missing_lookup_and_run_limit(self):
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
            kicad_review.cmd_report(None)
            parts = json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]
            self.assertIn("did not finish", parts["supplier"]["error"])
            self.assertEqual(next(l for l in parts["lines"] if "U1" in l["refs"])["supplier"]["status"], "unavailable")
            pathlib.Path("review/supplier.json").write_text(json.dumps({"supplier": {"name": "DigiKey", "error": None}, "results": {"MP3302DJ-LF-Z": {"status": "run_limit", "mpn": "MP3302DJ-LF-Z"}}}))
            kicad_review.cmd_report(None)
            self.assertEqual(json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]["supplier"]["not_looked_up"]["run_limit"], 1)

    def test_whitespace_placeholder_counts(self):
        self.objects["3"]["props"]["MPN"] = " TBD "
        self.lookup()
        with patch("kicad_review.load_settings", return_value=self.settings), patch("kicad_review.project_objects", return_value=self.objects), patch("kicad_review.diff_objects", return_value=[]), patch("kicad_review.project_checks", return_value=[]):
            kicad_review.cmd_report(None)
        parts = json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["parts"]
        self.assertEqual(parts["supplier"]["not_looked_up"], {"no_mpn": 2, "invalid_mpn": 0, "run_limit": 0})
        raw_parts = [{"parts": {"lines": [{"mpn": " TBD "}]}}]
        kicad_review.merge_supplier(raw_parts, {"supplier": {}, "results": {}})
        self.assertEqual(raw_parts[0]["parts"]["supplier"]["not_looked_up"], {"no_mpn": 1, "invalid_mpn": 0, "run_limit": 0})

    def test_workflow_secrets_step_scope(self):
        workflow = pathlib.Path(self.here, ".github/workflows/review.yml").read_text()
        self.assertIn("DIGIKEY_CLIENT_ID:\n        required: false", workflow)
        self.assertIn("DIGIKEY_CLIENT_SECRET:\n        required: false", workflow)
        step = workflow.split("      - name: Look up parts at DigiKey\n")[1].split("      - name:")[0]
        self.assertIn("continue-on-error: true", step)
        self.assertIn("timeout-minutes: 5", step)
        self.assertIn("if: steps.detect.outputs.changed == 'true'", step)
        self.assertIn("run: python3 tools/kicad_review.py lookup", step)
        self.assertNotIn("${{", step.split("run:")[1])
        self.assertEqual(workflow.count("${{ secrets.DIGIKEY_CLIENT_ID }}"), 1)
        self.assertEqual(workflow.count("${{ secrets.DIGIKEY_CLIENT_SECRET }}"), 1)

integration_result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DigiKeyIntegrationTests))
assert integration_result.wasSuccessful(), "DigiKey integration regressions failed"


supplier_lines = [{"refs": ["U1"], "problems": [], "supplier": {"status": "ok", "quantity": 1234, "unit_price": 1.5}},
                  {"refs": ["U2"], "problems": [], "supplier": {"status": "out_of_stock", "quantity": 0, "unit_price": 7.25}},
                  {"refs": ["U3"], "problems": [], "supplier": {"status": "not_found"}}]
supplier_parts = {"lines": supplier_lines, "changes": [], "supplier": {"name": "DigiKey", "fetched_at": "2026-10-13T12:00:00Z", "looked_up": 2, "not_looked_up": {"no_mpn": 54, "invalid_mpn": 1, "run_limit": 2}, "error": None, "skipped": None}}
supplier_data = {"projects": [{"name": "P", "parts": supplier_parts}]}
text = parts_markdown(supplier_data)
assert "DigiKey data as of 2026-10-13 12:00 UTC (stock and price from DigiKey)." in text
assert "2 looked up: 1 in stock, 1 out of stock, 1 not found at DigiKey." in text
assert "54 parts not looked up: no MPN." in text
assert "1 part not looked up: invalid MPN." in text and "2 parts not looked up: run limit." in text
assert "1234" not in text and "1.5" not in text and "7.25" not in text and "$" not in text
supplier_parts["supplier"]["skipped"] = "no credentials (forked pull request or secrets not set)"
assert "DigiKey lookup skipped: no credentials (forked pull request or secrets not set)." in parts_markdown(supplier_data)
supplier_parts["supplier"]["skipped"] = None
supplier_parts["supplier"]["error"] = "HTTP 500\n<script>"
assert "DigiKey lookup unavailable: HTTP 500 &lt;script&gt;." in parts_markdown(supplier_data)
print("ok DigiKey comment counts, skipped lookup, and not looked up counts")

assert '"LCSC", "DigiKey", "PCBWay"' in inline_page('window.REVIEW_DATA = {"version":1};')
assert 'https://www.digikey.evil.com/x' not in text
# No lookup leaves comment and job-summary content unchanged.
assert parts_markdown({"projects": [{"name": "P", "parts": {"lines": [], "changes": [], "supplier": None}}]}) == "#### Parts: P\n\nSupplier lookup not run (not available). 0 lines, 0 with a problem.\n"
print("ok DigiKey disabled comment and enabled asset selection")

project_counts = [{"parts": {"lines": [{"mpn": "A"}, {"mpn": "a"}, {"mpn": "B"}]}}, {"parts": {"lines": [{"mpn": "C"}]}}]
kicad_review.merge_supplier(project_counts, {"supplier": {"looked_up": 3}, "results": {"A": {"status": "ok"}, "B": {"status": "unavailable"}, "C": {"status": "not_found"}}})
assert [p["parts"]["supplier"]["looked_up"] for p in project_counts] == [1, 1], "Supplier lookup count must belong to the project"

# Setup docs cover opt-in, credentials, terms and the conservative manufacturer rule.
readme = pathlib.Path(kicad_review.__file__).with_name("README.md").read_text()
for wording in ("### DigiKey stock and price (optional)", "DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET", "secrets: inherit", "MPNs only",
                "120 per minute", "1000 per day", "case-insensitive prefix", "Keep it off in public repositories", "only in the run's report",
                "digikey.enabled", "digikey.site", "digikey.currency", "digikey.max_lookups"):
    assert wording in readme, wording
assert "JLCPCB Components API lookup" not in readme
example = pathlib.Path(kicad_review.__file__).parent.joinpath("examples/kicad-review.toml").read_text()
for wording in ('# [digikey]', '# enabled = false', '# site = "US"', '# currency = "USD"', '# max_lookups = 100'):
    assert wording in example, wording
print("ok DigiKey setup, limits, terms and manufacturer docs")
# PDF: a static print page.
from kicad_review import print_html
pdata = {**d2, "repo": "o/r", "base": "a" * 40, "head": "b" * 40, "projects": [{"name": "A&B", "dir": "", "status": "modified", "checks": [
    {"name": "drc", "title": "DRC", "level": "required", "status": "fail", "errors": 1, "new_errors": 1, "warnings": 0, "new_warnings": 0, "fixed": 0,
     "violations": [{"new": True, "severity": "error", "description": "Clearance <1mm>", "items": ["J1"], "where": {"board": True}}]}],
    "changes": [{"action": "modified", "kind": "footprint", "ref": f"R{i}", "changes": [["Value", "1k", "2k"]]} for i in range(250)], "sheets": [], "board": {"changed": False}}]}
with tempfile.TemporaryDirectory() as d:
    png = f"{d}/p0-board.png"; open(png, "wb").write(b"\x89PNG\r\n\x1a\nfake")
    html = print_html(pdata, [{"project": 0, "title": "A&B: board", "path": png}], "<script>x</script> & y", "ann", "2026-10-12 10:00 UTC")
assert "<script" not in html.replace("&lt;script&gt;", "") and "&lt;script&gt;x&lt;/script&gt; &amp; y" in html and "A&amp;B" in html
assert "data:image/png;base64," in html and "Clearance &lt;1mm&gt;" in html and "aaaaaaa → bbbbbbb" in html
assert "http-equiv='Content-Security-Policy'" in html
assert "default-src 'none'; img-src data:; style-src 'unsafe-inline'" in html
assert html.count("pictures unavailable") == 0
missing = print_html(pdata, [], "", "", "now")
assert missing.count("pictures unavailable") == 1
print("ok print page escapes everything")
assert html.count("<tr class=\"change\">") == 200 and "50 more changes are in the interactive report" in html
print("ok long change lists are capped")
assert "pictures unavailable" in print_html(pdata, [], "", "", "now")
print("ok missing screenshots are explained")

from kicad_review import cmd_pdf
import contextlib, io, types as _types, kicad_review as kr
import contextlib as _contextlib, io as _io
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d); os.makedirs("review/images")
    json.dump({**pdata, "settings": {"pdf": {"enabled": True}}, "links": d2["links"], "reason": "x"}, open("review/data.json", "w"))
    seen = []
    saved = kr.subprocess.run
    kr.subprocess.run = lambda cmd, **k: seen.append(cmd) or _types.SimpleNamespace(returncode=1, stderr="chrome crashed", stdout="")
    try:
        os.environ.update(PDF_NAME="kicad-review-aaaaaaa-bbbbbbb-fail.pdf")
        with patch("sys.stdout", new_callable=io.StringIO) as stdout, patch("sys.stderr", new_callable=io.StringIO) as stderr:
            cmd_pdf(_types.SimpleNamespace(chrome="chrome"))
        assert stdout.getvalue() == "::warning::PDF report failed: Chrome unavailable, failed or timed out\n", stdout.getvalue()
        assert stderr.getvalue() == "", stderr.getvalue()
    finally:
        kr.subprocess.run = saved; os.environ.pop("PDF_NAME")
    assert os.path.exists("review/print.html") and seen and "--print-to-pdf=" + os.path.abspath("review/kicad-review-aaaaaaa-bbbbbbb-fail.pdf") in seen[0]
    os.chdir(_cwd)
print("ok chrome failure does not fail the review")

# Disabled PDF is byte-identical to settings predating PDF, including summaries.
with tempfile.TemporaryDirectory() as d:
    old_cwd = os.getcwd()
    try:
        os.chdir(d)
        os.makedirs("review")
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "a" * 40, "head": "b" * 40, "reason": "test", "projects": []}))
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        before = copy.deepcopy(settings)
        before.pop("pdf")
        outputs = []
        for current in (before, settings):
            with patch("kicad_review.load_settings", return_value=current):
                kr.cmd_report(None)
            outputs.append(tuple(pathlib.Path("review/" + name).read_bytes() for name in ("kicad-review.html", "data.json")))
        assert outputs[0] == outputs[1]
        assert not os.path.exists("review/print.html")
        with patch("kicad_review.subprocess.run", side_effect=AssertionError("Chrome must not run")):
            cmd_pdf(_types.SimpleNamespace(chrome="chrome"))
        assert not os.path.exists("review/print.html")
    finally:
        os.chdir(old_cwd)
print("ok PDF disabled report byte identity and no files")

for invalid in ("enabled = 1", "enabled = 'yes'"):
    with tempfile.TemporaryDirectory() as d:
        pathlib.Path(d, "kicad-review.toml").write_text("[pdf]\n" + invalid)
        try:
            load_settings((d,))
            raise AssertionError("invalid PDF setting accepted")
        except SystemExit as error:
            assert "pdf.enabled must be true or false" in str(error)
print("ok PDF settings validate booleans")

with tempfile.TemporaryDirectory() as d:
    old_cwd = os.getcwd()
    try:
        os.chdir(d)
        os.makedirs("review")
        pathlib.Path("review/data.json").write_text(json.dumps({**pdata, "settings": {"pdf": {"enabled": True}}}))
        with patch.dict(os.environ, {"PDF_NAME": "kicad-review-aaaaaaa-bbbbbbb-fail.pdf"}):
            expected_warning = "::warning::PDF report failed: Chrome unavailable, failed or timed out\n"
            for failure in (kr.subprocess.TimeoutExpired("chrome", 120), FileNotFoundError("chrome")):
                with patch("kicad_review.subprocess.run", side_effect=failure), patch("sys.stdout", new_callable=io.StringIO) as stdout, patch("sys.stderr", new_callable=io.StringIO) as stderr:
                    cmd_pdf(_types.SimpleNamespace(chrome="chrome"))
                assert stdout.getvalue() == "::warning::PDF report failed: Chrome unavailable, failed or timed out\n", stdout.getvalue()
                assert stderr.getvalue() == "", stderr.getvalue()
                assert not pathlib.Path("review/kicad-review-aaaaaaa-bbbbbbb-fail.pdf").exists()
    finally:
        os.chdir(old_cwd)
print("ok PDF timeout and launch failure are nonfatal")



# Interface checks: netlist parsing and helpers.
from kicad_review import parse_netlist, ohms, short, is_ground, is_power, matches
def netlist(comps, nets):
    c = "".join(f'(comp (ref "{r}") (value "{v}") (footprint "{fp}") (libsource (lib "{lib.split(":")[0]}") (part "{lib.split(":")[1]}") (description "")))'
                for r, (v, fp, lib) in comps.items())
    n = "".join(f'(net (code "{i}") (name "{name}") ' + "".join(f'(node (ref "{r}") (pin "{p}") (pinfunction "{f}") (pintype "{t}"))' for r, p, f, t in nodes) + ")"
                for i, (name, nodes) in enumerate(nets.items(), 1))
    return f'(export (version "E") (components {c}) (nets {n}))'
comps, nets = parse_netlist(netlist({"R1": ("4k7", "R_0402", "Device:R")}, {"/MCU/SDA": [("R1", "1", "", "passive"), ("U1", "5", "PB7/I2C1_SDA", "bidirectional")]}))
assert comps["R1"] == {"value": "4k7", "footprint": "R_0402", "lib": "Device:R", "description": ""}
assert nets["/MCU/SDA"][1] == {"ref": "U1", "pin": "5", "function": "PB7/I2C1_SDA", "type": "bidirectional"}
for v, want in (("4k7", 4700), ("4.7k", 4700), ("4K7 1%", 4700), ("120R", 120), ("120", 120), ("5k1", 5100), ("1M", 1e6), ("10k Ω", 10000)):
    assert ohms(v) == want, (v, ohms(v))
assert ohms("DNP") is None and ohms("100n") is None
print("ok resistor values parse")
assert short("/MCU/SDA") == "SDA" and short("Net-(U1-SDA)") == "U1-SDA"
assert matches("SDA", ["SDA"]) and matches("I2C1_SDA", ["SDA"]) and not matches("SDAX", ["SDA"]) and matches("PB7/I2C1_SDA", ["SDA"])
assert all(is_power(n, []) for n in ("+3V3", "VDD_3V3", "3.3V", "VBUS", "+5V", "GND")) and is_ground("AGND") and not is_power("/SDA", [])
assert is_power("/RAIL", [{"type": "power_out"}])
print("ok power nets are recognised")

from kicad_review import interface_findings, INTERFACE_PATTERNS
W = lambda ref: ({"sheet": "/"}, [1.0, 2.0])
types = lambda vs: sorted((v["type"], v["severity"]) for v in vs)
# UART TX to TX
c, n = parse_netlist(netlist({"U1": ("MCU", "", "MCU:M"), "U2": ("GPS", "", "GPS:G")},
    {"/TX": [("U1", "1", "USART1_TX", "output"), ("U2", "3", "TXD", "output")]}))
vs, cov = interface_findings(c, n, INTERFACE_PATTERNS, W)
assert types(vs) == [("uart_tx_to_tx", "error")] and "U1 pin 1 (USART1_TX)" in vs[0]["items"] and vs[0]["where"] == {"sheet": "/"}, vs
# I2C: none, then two pull-ups
i2c = lambda pullups: netlist({"U1": ("MCU", "", "MCU:M"), **{f"R{i}": ("4k7", "", "Device:R") for i in range(1, pullups + 1)}},
    {"/MCU/SDA": [("U1", "5", "SDA", "bidirectional")] + [(f"R{i}", "1", "", "passive") for i in range(1, pullups + 1)],
     "/MCU/SCL": [("U1", "6", "SCL", "bidirectional")], "+3V3": [(f"R{i}", "2", "", "passive") for i in range(1, pullups + 1)]})
assert types(interface_findings(*parse_netlist(i2c(0)), INTERFACE_PATTERNS, W)[0]) == [("i2c_no_pullup", "error"), ("i2c_no_pullup", "error")]
vs = interface_findings(*parse_netlist(i2c(2)), INTERFACE_PATTERNS, W)[0]
assert ("i2c_multiple_pullups", "warning") in types(vs) and any("2350" in v["description"] for v in vs), vs
print("ok hierarchical net names match")
# CAN termination
can = lambda r: netlist({"U3": ("TCAN", "", "If:T"), **({"R9": (r, "", "Device:R")} if r else {})},
    {"/CANH": [("U3", "7", "CANH", "bidirectional")] + ([("R9", "1", "", "passive")] if r else []), "/CANL": [("U3", "6", "CANL", "bidirectional")] + ([("R9", "2", "", "passive")] if r else [])})
assert types(interface_findings(*parse_netlist(can(None)), INTERFACE_PATTERNS, W)[0]) == [("can_no_termination", "warning")]
assert interface_findings(*parse_netlist(can("120R")), INTERFACE_PATTERNS, W)[0] == []
# USB-C CC: floating, resistor, controller
usb = lambda cc_nodes: netlist({"J1": ("USB_C_Receptacle", "USB_C", "Connector:USB_C_Receptacle"), "R1": ("5.1k", "", "Device:R"), "U9": ("TPS65987", "", "PD:T")},
    {"/CC1": [("J1", "A5", "CC1", "bidirectional")] + cc_nodes, "GND": [("R1", "2", "", "passive"), ("J1", "A1", "GND", "power_in")]})
assert types(interface_findings(*parse_netlist(usb([])), INTERFACE_PATTERNS, W)[0]) == [("usb_cc_floating", "error")]
cc_errors = lambda nodes: [v for v in interface_findings(*parse_netlist(usb(nodes)), INTERFACE_PATTERNS, W)[0] if v["type"] == "usb_cc_floating"]
assert cc_errors([("R1", "1", "", "passive")]) == [] and cc_errors([("U9", "4", "CC1", "bidirectional")]) == []
print("ok CC to a controller is fine")
# Connector ESD: J2 pin 2 unprotected, pin 3 protected by a TVS on the same net
c, n = parse_netlist(netlist({"J2": ("Conn_01x03", "", "Connector:Conn"), "D1": ("PESD5V0", "", "Diode:ESD"), "U1": ("MCU", "", "MCU:M")},
    {"GND": [("J2", "1", "", "passive")], "/SIG_A": [("J2", "2", "", "passive"), ("U1", "8", "PA0", "input")],
     "/SIG_B": [("J2", "3", "", "passive"), ("U1", "9", "PA1", "input"), ("D1", "1", "", "passive")]}))
vs, cov = interface_findings(c, n, INTERFACE_PATTERNS, W)
assert types(vs) == [("connector_no_esd", "warning")] and vs[0]["items"] == ["J2 pin 2 on /SIG_A"] and cov["protected"] == [1, 2], (vs, cov)
# Voltage domains
c, n = parse_netlist(netlist({"U1": ("MCU", "", "MCU:M"), "U2": ("SENSOR", "", "S:S")},
    {"+3V3": [("U1", "1", "VDD", "power_in")], "+5V": [("U2", "1", "VCC", "power_in")], "/INT": [("U1", "2", "PA2", "input"), ("U2", "4", "INT", "output")]}))
vs = interface_findings(c, n, INTERFACE_PATTERNS, W)[0]
assert types(vs) == [("voltage_domain", "warning")] and "+3V3" in vs[0]["description"] and "+5V" in vs[0]["description"], vs

from kicad_review import interface_check
settings = json.loads(json.dumps(DEFAULT_SETTINGS)); settings["checks"]["interfaces"] = "required"
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    for s in ("base", "head"):
        os.makedirs(f"review/p/{s}")
        write(s, {"p/b.kicad_sch": "(kicad_sch)"})
        open(f"review/p/{s}/netlist.net", "w").write(netlist({"R1": ("10k", "", "Device:R")}, {"GND": [("R1", "1", "", "passive")]}))
    c = interface_check({"dir": "p", "name": "b"}, settings, {"base": {}, "head": {}}, "review/p")
    os.chdir(_cwd)
assert c["name"] == "interfaces" and c["status"] == "pass" and c["coverage"]["detected"] == {} and c["coverage"]["protected"] == [0, 0], c
print("ok no interfaces is reported, not hidden")
assert DEFAULT_SETTINGS["checks"]["interfaces"] == "off" and interface_check({"dir": "p", "name": "b"}, json.loads(json.dumps(DEFAULT_SETTINGS)), {}, "x") is None
_src = open("kicad_review.py", encoding="utf-8").read()
assert 'report_settings["checks"] = {k: v for k, v in settings["checks"].items() if k != "interfaces"}' in _src and 'report_settings.pop("interfaces", None)' in _src
print("ok interfaces settings stay out of opted-out reports")

# Final-review regressions run together so every pre-fix failure is visible.
import unittest
class FinalReviewTests(unittest.TestCase):
    def findings(self, c, n):
        return interface_findings(*parse_netlist(netlist(c, n)), INTERFACE_PATTERNS, W)

    def test_uart_transceivers_and_pin_types(self):
        for value in ("TJA1050 CAN", "RS485", "RS-485", "LIN", "transceiver"):
            with self.subTest(value=value):
                vs, _ = self.findings({"U1": ("MCU", "", "MCU:M"), "U2": (value, "", "If:T")},
                    {"TX": [("U1", "1", "CAN1_TX", "output"), ("U2", "1", "TXD", "output")]})
                self.assertEqual(vs, [])
        for pin_type in ("input", "passive"):
            with self.subTest(pin_type=pin_type):
                vs, _ = self.findings({}, {"TX": [("U1", "1", "TX", "output"), ("U2", "1", "TXD", pin_type)]})
                self.assertEqual(vs, [])
        vs, _ = self.findings({}, {"TX": [("U1", "1", "TX", "output"), ("U2", "1", "TXD", "output"), ("U3", "1", "CAN_H", "input")]})
        self.assertEqual(vs, [])

    def test_i2c_series(self):
        for resistance, pullup, errors in (("33R", True, 0), ("4.7k", False, 2), ("1k", True, 1)):
            with self.subTest(resistance=resistance, pullup=pullup):
                c = {"R1": (resistance, "", "Device:R"), "R2": ("4k7", "", "Device:R")}
                n = {"SDA": [("R1", "1", "", "passive")], "IC_SDA": [("R1", "2", "", "passive"), ("U1", "1", "SDA", "bidirectional")]}
                if pullup:
                    n["SDA"].append(("R2", "1", "", "passive"))
                    n["+3V3"] = [("R2", "2", "", "passive")]
                vs, _ = self.findings(c, n)
                self.assertEqual(sum(v["type"] == "i2c_no_pullup" for v in vs), errors)

    def test_jumper(self):
        vs, cov = self.findings({"JP1": ("USB_C", "USB_C", "Connector:USB_C")},
            {"CC1": [("JP1", "1", "CC1", "passive"), ("U1", "1", "", "input")]})
        self.assertEqual(vs, [])
        self.assertEqual(cov["protected"], [0, 0])
        self.assertNotIn("USB-C", cov["detected"])

    def test_patterns_extend(self):
        settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        settings["checks"]["interfaces"] = "required"
        settings["interfaces"] = {"uart_tx": ["SEND"]}
        with tempfile.TemporaryDirectory() as d:
            old=os.getcwd(); os.chdir(d)
            try:
                write('head',{'p/b.kicad_sch':'(kicad_sch)'})
                write('review/p',{'head/netlist.net':netlist({}, {'TX': [
                    ('U1','1','TX','output'),('U2','1','SEND','output')]})})
                result=interface_check({'dir':'p','name':'b'},settings,{},'review/p')
            finally: os.chdir(old)
        self.assertIn(("uart_tx_to_tx", "error"), types(result["violations"]))

    def test_ohms(self):
        for value, expected in (("1m", .001), ("1M", 1e6), ("2.2k 0402", 2200), ("1" * 33, None), ("100n", None)):
            with self.subTest(value=value):
                self.assertEqual(ohms(value), expected)

    def test_arrays_ignored(self):
        vs, _ = self.findings({"RN1": ("4k7", "", "Device:R")}, {"SDA": [("U1", "1", "SDA", "bidirectional"), ("RN1", "1", "", "passive")], "+3V3": [("RN1", "2", "", "passive")]})
        self.assertIn(("i2c_no_pullup", "error"), types(vs))

    def test_cc_tvs(self):
        vs, _ = self.findings({"J1": ("USB_C", "USB_C", "Connector:USB_C"), "D1": ("TVS", "", "Diode:ESD")},
            {"CC1": [("J1", "1", "CC1", "passive"), ("D1", "1", "", "passive")]})
        self.assertIn(("usb_cc_floating", "error"), types(vs))

    def test_rails(self):
        for name in ("P3V3", "P5V", "3V3A_SENSOR", "3V3_A"):
            with self.subTest(name=name):
                self.assertTrue(is_power(name, []))

    def test_unused_rx_removed(self):
        self.assertNotIn("uart_rx", INTERFACE_PATTERNS)

    def test_coverage_units(self):
        _, cov = self.findings({}, {"SDA": [("U1", "1", "SDA", "bidirectional")], "SCK": []})
        self.assertEqual(cov["detected"], {"I2C nets": 1})
        self.assertEqual(cov["protected"], [0, 0])

_result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(FinalReviewTests))
assert _result.wasSuccessful(), "final-review regressions failed"
# Release readiness: setting and export in render.
from kicad_review import CHECK_NAMES, cmd_render
import kicad_review as kr
assert CHECK_NAMES["release"] == "Release package" and DEFAULT_SETTINGS["checks"]["release"] == "off"
calls = []
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    os.makedirs("review"); os.makedirs("base/p"); os.makedirs("head/p")
    for s in ("base", "head"): open(f"{s}/p/b.kicad_pro", "w").write("{}")
    json.dump({"projects": [{"dir": "p", "name": "b", "status": "modified"}]}, open("review/detect.json", "w"))
    saved = (kr.render_side, kr.release_project)
    kr.render_side = lambda *a, **kw: None
    kr.release_project = lambda pro, tag, s, out, label: calls.append((pro, tag, out, label)) or []
    try:
        cmd_render(None); assert calls == []            # off by default
        open("base/kicad-review.toml", "w").write('[checks]\nrelease = "informational"\n')
        cmd_render(None)
    finally:
        kr.render_side, kr.release_project = saved
    os.chdir(_cwd)
assert calls == [("base/p/b.kicad_pro", "review", "review/p/base/fab", "b"), ("head/p/b.kicad_pro", "review", "review/p/head/fab", "b")], calls
print("ok release export in render")
assert 'report_settings["checks"] = {k: v for k, v in report_settings["checks"].items() if k != "release"}' in open("kicad_review.py", encoding="utf-8").read()
print("ok release setting stays out of opted-out reports")

from kicad_review import release_findings, package_summary
import zipfile as zf
def fab(d, files, pos_rows, bom_rows, preset="jlcpcb"):
    os.makedirs(d, exist_ok=True)
    with zf.ZipFile(f"{d}/b-review-{preset}-gerbers.zip", "w") as z:
        for name, body in files.items(): z.writestr(name, body)
    with open(f"{d}/b-review-{preset}-positions.csv", "w") as fh:
        fh.write("Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\n" + "".join(f"{r},x,y,0,0,0,Top\n" for r in pos_rows))
    part = "LCSC Part #" if preset == "jlcpcb" else "Mfg Part #"
    with open(f"{d}/b-review-{preset}-bom.csv", "w") as fh:
        fh.write(f"Comment,Designator,Footprint,{part}\n" + "".join(f'x,"{refs}",y,{pn}\n' for refs, pn in bom_rows))
def pcb(d, layers, extra=""):
    open(f"{d}/b.kicad_pcb", "w").write("(kicad_pcb\n  (layers\n" + "".join(f'    (0 "{l}" signal)\n' for l in layers) + "  )\n" + extra + ")\n")
    return f"{d}/b.kicad_pcb"
fpd = lambda ref, side, attrs, pads="smd": {"kind": "footprint", "ref": ref, "props": {"layer": side, "attributes": attrs, "pads_kind": pads}}
G = "%FSLAX46Y46*%\nD10*\nX0Y0D03*\nM02*\n"
with tempfile.TemporaryDirectory() as d:
    full = {"b-F_Cu.gtl": G, "b-B_Cu.gbl": G, "b-F_Mask.gts": G, "b-F_Paste.gtp": G, "b-B_Mask.gbs": G, "b-F_Silkscreen.gto": G, "b-Edge_Cuts.gm1": G, "b-PTH.drl": "M48\n"}
    objs = {"1": fpd("R1", "F.Cu", "smd"), "2": {"kind": "via", "ref": "GND", "props": {}}}
    fab(d, full, ["R1"], [("R1", "C1")])
    assert release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "F.Mask", "Edge.Cuts"]), objs) == []
    s = package_summary(d)
    assert s["sha256"] and len(s["files"]) == 3 and all(f["bytes"] > 0 for f in s["files"]), s
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if k != "b-PTH.drl"}, ["R1"], [("R1", "C1")])
    v = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    assert [x["type"] for x in v] == ["missing_drill"] and v[0]["severity"] == "error" and v[0]["where"] == {"board": True}, v
print("ok vias require a drill file")
with tempfile.TemporaryDirectory() as d:
    fab(d, full, ["R1"], [("R1", "C1")])
    v = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "Edge.Cuts"]), objs)
    assert sorted(x["description"] for x in v) == ["No Gerber for copper layer In1.Cu", "No Gerber for copper layer In2.Cu"], v
print("ok inner copper layers are required")
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if "Paste" not in k}, [], [("J1", "C9")])
    tht = {"1": fpd("J1", "F.Cu", "through_hole", "thru_hole")}
    assert release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), tht) == []
print("ok THT-only board needs no paste or position")
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if not k.endswith(".drl")}, ["R1", "R2"], [("R1", "")], preset="pcbway")
    v = release_findings(d, "b", "pcbway", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    types = sorted(x["type"] for x in v)
    assert types == ["bom_missing_part_number", "missing_drill", "position_not_in_bom"], types
print("ok pcbway drill detected")
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if not k.endswith(".drl")}, [], [("J1", "C9")])
    p = pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"], '(footprint "J" (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.6)))\n')
    v = release_findings(d, "b", "jlcpcb", p, {"1": {"kind": "footprint", "ref": "J1", "props": {"layer": "F.Cu", "attributes": "through_hole"}}})
    assert [x["type"] for x in v] == ["missing_drill"], v
print("ok plated pads in the board file require a drill file")

_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    settings = json.loads(json.dumps(DEFAULT_SETTINGS)); settings["checks"].update(erc="off", drc="off", parity="off", bom="off", release="informational")
    os.makedirs("head/p")   # a project folder with no board (and no schematic, so the other checks read nothing)
    c = project_checks({"dir": "p", "name": "b"}, settings, {"base": {}, "head": {}})
    os.chdir(_cwd)
assert [(x["name"], x["status"], x.get("reason")) for x in c] == [("release", "not_run", "no board")], c
print("ok no board is not run")

# Tagged releases also publish SHA256SUMS for every release asset.
import hashlib
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    os.makedirs("repo/B"); open("repo/B/B.kicad_pro", "w").write("{}")
    def fake(pro, tag, s, out, label):
        os.makedirs(out, exist_ok=True); open(f"{out}/{label}-{tag}-gerbers.zip", "wb").write(b"zip"); return [f"{out}/{label}-{tag}-gerbers.zip"]
    saved = kr.release_project; kr.release_project = fake
    try:
        with patch("sys.stdout", new_callable=io.StringIO):
            kr.cmd_release(type("A", (), {"tag": "v1"}))
        sums = open("release/SHA256SUMS").read()
    finally:
        kr.release_project = saved; os.chdir(_cwd)
assert sums == f"{hashlib.sha256(b'zip').hexdigest()}  B-v1-gerbers.zip\n", sums
print("ok release SHA256SUMS")

# Live-test fixes: paste needs real SMD pads; BOM designator ranges expand; release findings keep a stable identity.
from kicad_review import bom_refs_expand
assert bom_refs_expand("C1,C3-C5, R10") == {"C1", "C3", "C4", "C5", "R10"}
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if "Paste" not in k and "B_Mask" not in k}, ["A1"], [("A1", "C5")])
    p = pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"], '(footprint "Sensor:TO39" (layer "B.Cu") (attr smd) (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.6) (layers "*.Cu" "*.Mask")))\n')
    v = release_findings(d, "b", "jlcpcb", p, {"1": {"kind": "footprint", "ref": "A1", "props": {"layer": "B.Cu", "attributes": "smd"}}})
    assert not any("Paste" in x["description"] for x in v), v
with tempfile.TemporaryDirectory() as d:
    fab(d, full, ["C3", "C4"], [("C1,C3-C5", "C1")])
    assert [x["type"] for x in release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)] == []
    fab(d, full, ["R1"], [("R1", ""), ("R2", "")])
    a = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    fab(d, full, ["R1"], [("R1,R2", "")])
    b = release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)
    assert [x["key"] for x in a] == [x["key"] for x in b], (a, b)
print("ok release findings: smd pads, ranges, stable keys")

# Final-review fixes: NPTH-only drill, locked footprints, renamed inner layers, missing Designator, empty SHA256SUMS.
from kicad_review import smd_pad_sides
assert smd_pad_sides('(footprint "R" locked (layer "B.Cu") (pad "1" smd rect))') == {"B"}
with tempfile.TemporaryDirectory() as d:
    fab(d, {k: v for k, v in full.items() if not k.endswith(".drl")}, [], [("J1", "C9")])
    p = pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"], '(footprint "H" (pad "" np_thru_hole circle (at 0 0) (size 3 3) (drill 3)))\n')
    assert [x["type"] for x in release_findings(d, "b", "jlcpcb", p, {})] == ["missing_drill"]
with tempfile.TemporaryDirectory() as d:
    fab(d, {**full, "b-GND_PLANE.g2": G}, ["R1"], [("R1", "C1")])
    p = f"{d}/b.kicad_pcb"
    open(p, "w").write('(kicad_pcb\n  (layers\n    (0 "F.Cu" signal)\n    (1 "In1.Cu" signal "GND_PLANE")\n    (2 "B.Cu" signal)\n    (25 "Edge.Cuts" user)\n  )\n)\n')
    assert not any("In1.Cu" in x["description"] for x in release_findings(d, "b", "jlcpcb", p, objs))
with tempfile.TemporaryDirectory() as d:
    fab(d, full, ["R1"], [("R1", "C1")])
    with open(f"{d}/b-review-jlcpcb-bom.csv", "w") as fh: fh.write("Comment,Footprint,LCSC Part #\nx,y,\n")
    release_findings(d, "b", "jlcpcb", pcb(d, ["F.Cu", "B.Cu", "Edge.Cuts"]), objs)   # no Designator column: no KeyError
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d); os.makedirs("repo")
    try:
        with patch("sys.stdout", new_callable=io.StringIO):
            kr.cmd_release(type("A", (), {"tag": "v1"}))
        assert not os.path.exists("release/SHA256SUMS")
    finally:
        os.chdir(_cwd)
print("ok release final-review fixes")
# BOM readiness: per-field coverage over BOM parts; placeholders count as missing; multi-unit parts count once.
from kicad_review import bom_coverage, bom_parts, present
symp = lambda ref, **p: {"kind": "symbol", "ref": ref, "where": {"sheet": "/"}, "pos": [0, 0], "props": {"in_bom": "yes", **p}}
objs = {"a": symp("U1", Value="STM32", Footprint="QFN", LCSC="C123", MPN="STM32G0", Manufacturer="ST", Datasheet="https://x/ds.pdf"),
        "b": symp("U1 unit 2", Value="STM32", Footprint="QFN"),
        "c": symp("R1", Value="10k", Footprint="0402", LCSC="C25744", MPN="TBD"),
        "d": symp("J1", Value="USB-C", Footprint="USB", Datasheet="~"),
        "e": symp("R2", Value="1k", Footprint="0402", dnp="yes"),
        "f": symp("TP1", Value="TP", Footprint="TP", in_bom="no")}
assert set(bom_parts(objs)) == {"U1", "R1", "J1"}
assert not present("TBD") and not present("~") and not present("  ") and present("10k")
s = json.loads(json.dumps(DEFAULT_SETTINGS))
cov = bom_coverage(objs, s)
assert cov["Value"] == [3, 3] and cov["MPN"] == [1, 3] and cov["LCSC"] == [2, 3] and cov["Manufacturer"] == [1, 3]
assert cov["Datasheet (critical)"] == [1, 2]   # U1 has one, J1 has "~"
assert cov["Order ready"] == [2, 3]            # jlcpcb preset: Value, Footprint, LCSC
s["fabrication"]["preset"] = "pcbway"
assert bom_coverage(objs, s)["Order ready"] == [1, 3]   # pcbway: MPN; R1's "TBD" is a placeholder
s["bom"]["order_ready_fields"] = ["Value"]
assert bom_coverage(objs, s)["Order ready"] == [3, 3]
print("ok placeholders count as missing")
print("ok multi-unit symbol counts once")

# BOM readiness settings stay out of opted-out reports.
src = open("kicad_review.py", encoding="utf-8").read()
assert 'report_settings["bom"] = {"required_fields": settings["bom"]["required_fields"]}' in src
s = json.loads(json.dumps(DEFAULT_SETTINGS))
assert s["parts"]["enabled"] is False and set(s["bom"]) == {"required_fields", "critical_prefixes", "order_ready_fields"}
print("ok bom readiness settings opt-in")

from kicad_review import field_changes
b = {"1": symp("R1", Value="10k", Footprint="0402", MPN="RC0402-10K"), "2": symp("R2", Value="10k", Footprint="0402", MPN="RC0402-10K"),
     "3": symp("U1", Value="LDO", Footprint="SOT23", Datasheet="https://a")}
h = {"1": symp("R1", Value="10k", Footprint="0402", MPN="ERJ-2RKF1002"), "2": symp("R2", Value="10k", Footprint="0402", MPN="RC0402-10K"),
     "3": symp("U1", Value="LDO", Footprint="SOT23", Datasheet="https://b", Manufacturer="TI"), "4": symp("C1", Value="1u", Footprint="0402")}
assert field_changes(b, h) == [
    {"refs": ["R1"], "field": "MPN", "before": "RC0402-10K", "after": "ERJ-2RKF1002"},
    {"refs": ["U1"], "field": "Manufacturer", "before": None, "after": "TI"},
    {"refs": ["U1"], "field": "Datasheet", "before": "https://a", "after": "https://b"}], field_changes(b, h)
h["2"] = symp("R2", Value="10k", Footprint="0402", MPN="ERJ-2RKF1002")
assert field_changes(b, h)[0]["refs"] == ["R1", "R2"]
print("ok MPN-only edit shows per reference")

from kicad_review import dnp_mismatches
L = parts_lines({"1": symp("R1", Value="TBD", Footprint="0402", LCSC="C1"), "2": symp("U2", Value="LDO", Footprint="SOT23", LCSC="C9", MPN="AP2112"),
                 "3": symp("U3", Value="LDO", Footprint="SOT89", LCSC="C10", MPN="AP2112")})
probs = {l["refs"][0]: l["problems"] for l in L}
assert "placeholder" in probs["R1"] and "mpn_footprint_conflict" in probs["U2"] and "mpn_footprint_conflict" in probs["U3"], probs
base_lines = parts_lines({"1": symp("R5", Value="1k", Footprint="0402", LCSC="C7"), "2": symp("R6", Value="2k", Footprint="0402", LCSC="C8")})
head_lines = parts_lines({"1": symp("R5", Value="1k", Footprint="0402", LCSC="C7"), "2": symp("R6", Value="2k", Footprint="0402", LCSC="C7")})
mark_new_problems(base_lines, head_lines)
r5 = next(l for l in head_lines if "R5" in l["refs"])
assert r5["new_problems"] == ["lcsc_conflict"], r5   # R5's line did not change, but its LCSC number now conflicts
print("ok problem on unchanged line is new")
fp = lambda ref, attrs: {"kind": "footprint", "ref": ref, "where": {"board": True}, "pos": [0, 0], "props": {"attributes": attrs, **({"dnp": "yes"} if "dnp" in (attrs or "") else {})}}
mis = dnp_mismatches({"s1": symp("R1", dnp="no"), "s2": symp("R2", dnp="yes"), "s3": symp("R3"), "f1": fp("R1", "smd dnp"), "f2": fp("R2", "smd dnp"), "f3": fp("R3", "smd")})
assert mis == ["R1"], mis
print("ok DNP mismatch symbol vs footprint")
pm = parts_markdown({"projects": [{"name": "X", "parts": {"lines": head_lines, "changes": [], "supplier": None, "dnp_mismatch": ["R1"],
      "coverage": {"base": {"MPN": [1, 4], "Order ready": [2, 4], "LCSC": [4, 4], "Datasheet (critical)": [0, 0]},
                   "head": {"MPN": [3, 4], "Order ready": [2, 4], "LCSC": [4, 4], "Datasheet (critical)": [0, 0]}}}}]})
assert "R5 one LCSC number on several values" in pm and "BOM coverage: order ready 2/4, MPN 3/4 (+2), LCSC 4/4" in pm and "DNP differs between schematic and board: R1" in pm, pm
print("ok bom readiness comment")

# Grouped lines: every reference's MPN and values are checked, and the comment names only the offending references.
L = parts_lines({"1": symp("R1", Value="10k", Footprint="0805", MPN="TBD"), "2": symp("R2", Value="10k", Footprint="0805", MPN="AP2112"),
                 "3": symp("R3", Value="10k", Footprint="0805"), "4": symp("U1", Value="LDO", Footprint="SOT23", MPN="AP2112")})
# Different MPNs are different BOM lines, so R1 (TBD), R2 (AP2112) and R3 (none) each own a line.
r, r2 = next(l for l in L if "R1" in l["refs"]), next(l for l in L if "R2" in l["refs"])
assert r["problems"] == ["missing_lcsc", "placeholder"] and r["problem_refs"] == {"placeholder": ["R1"]}, r
assert "mpn_footprint_conflict" in r2["problems"] and r2["problem_refs"] == {"mpn_footprint_conflict": ["R2"]}, r2
u = next(l for l in L if "U1" in l["refs"])
assert u["problem_refs"] == {"mpn_footprint_conflict": ["U1"]}, u
mark_new_problems([], L)
pm = parts_markdown({"projects": [{"name": "X", "parts": {"lines": L, "changes": [], "supplier": None}}]})
assert "- R1 placeholder value" in pm and "- R2 one MPN on several footprints" in pm and "R3 placeholder" not in pm and "R1, R2, R3 placeholder" not in pm, pm
print("ok grouped line problems name their references")

# A problem the named references already had in base is not new, even when another reference joins the line.
bl = parts_lines({"1": symp("R1", Value="TBD", Footprint="0402", LCSC="C1")})
hl = parts_lines({"1": symp("R1", Value="TBD", Footprint="0402", LCSC="C1"), "2": symp("R2", Value="TBD", Footprint="0402", LCSC="C1")})
mark_new_problems(bl, hl)
assert "placeholder" in hl[0]["new_problems"] and hl[0]["problem_refs"]["placeholder"] == ["R1", "R2"], hl
bl = parts_lines({"1": symp("R1", Value="10k", Footprint="0402", LCSC="C1", MPN="TBD")})
hl = parts_lines({"1": symp("R1", Value="10k", Footprint="0402", LCSC="C1", MPN="TBD"), "2": symp("R2", Value="10k", Footprint="0402", LCSC="C1")})
mark_new_problems(bl, hl)
assert "placeholder" not in hl[0]["new_problems"], hl
print("ok old problem not new when a reference joins")
# Threads: object index for anchoring. Head objects first; base-only objects keep their base position.
from kicad_review import object_index
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
assert t1_by["head", "symbol", "R1"] == {"uuid": "s1", "kind": "symbol", "ref": "R1", "value": "10k", "footprint": None, "side": "head",
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
        assert load_settings()["threads"] == {"enabled": True, "block_merge": False}
    finally:
        os.chdir(_cwd)
assert DEFAULT_SETTINGS["threads"] == {"enabled": False, "block_merge": False}
print("ok threads settings")

# Threads: anchors in comment bodies and the summary line.
import base64 as _b64, json as _json
from kicad_review import thread_anchor, thread_counts
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

# History: strict rows, newest last, and damaged blocks start fresh.
from kicad_review import log_row, merge_log, extract_log, LOG_START, LOG_END, CHECK_NAMES, MARKER
ck2 = lambda name, title, e, ne: {"name": name, "title": title, "level": "required", "status": "fail" if ne else "pass", "errors": e,
                               "new_errors": ne, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}
ld = {**d2, "head": "abc1234def", "settings": {}, "links": {**d2["links"], "run": "https://github.com/o/r/actions/runs/123"},
      "projects": [{"name": "A", "dir": "", "status": "modified", "changes": [], "checks": [ck2("erc", "ERC", 0, 0), ck2("drc", "DRC", 2, 1)]}]}
row = log_row(ld, "2026-10-12 10:04")
assert row == "| [2026-10-12 10:04](https://github.com/o/r/actions/runs/123) | `abc1234` | ❌ fail | ERC 0 (0) · DRC 2 (1) |", row
block = merge_log([], row)
assert block.startswith(LOG_START) and block.rstrip().endswith(LOG_END) and extract_log(block) == [row]
rows = [row.replace("runs/123", f"runs/{i}") for i in range(60)]
merged = extract_log(merge_log(rows, row))
assert len(merged) == 50 and merged[-1] == row and merged[0] == rows[11]
assert extract_log(merge_log(rows, row, keep=0)) == []
print("ok log keeps the newest 50")
assert extract_log("no markers") == [] and extract_log(LOG_START + "\n| broken") == []
assert extract_log(LOG_END + "\n" + LOG_START + "\n" + row) == []
assert extract_log(merge_log(["| junk | | | |", row.replace("`abc1234`", "`bad`")], row)) == [row]
assert log_row({**ld, "links": {}}, "2026-10-12 10:04") == ""
assert log_row(ld, "bad timestamp") == ""
pipe_data = {**ld, "projects": [ld["projects"][0], {**ld["projects"][0], "name": "B|C\nD"}]}
pipe_row = log_row(pipe_data, "2026-10-12 10:04")
assert "B\\|C D" in pipe_row and extract_log(merge_log([], pipe_row)) == [pipe_row]
print("ok broken log starts fresh and strict row contract")

# A real four-project/four-check log survives body truncation within GitHub's limit.
large = {**ld, "projects": [{**ld["projects"][0], "name": f"Project {i}",
         "checks": [ck2(n, title, 2, 1) for n, title in list(CHECK_NAMES.items())[:4]]} for i in range(4)], "reason": "x" * 60000}
large_row = log_row(large, "2026-10-12 10:04")
large_log = "\n" + merge_log([large_row] * 49, large_row)
large_body = comment_markdown(large, [], "", log=large_log)
assert len(large_body) <= 65536 and extract_log(large_body) == [large_row] * 50
assert large_body.index("### Checks") < large_body.index(LOG_START)
capped_checks = {**large, "projects": [{**p, "name": "x" * 20000} for p in large["projects"]]}
capped_body = comment_markdown(capped_checks, [], "", log=large_log)
assert len(capped_body) <= 65536 and extract_log(capped_body) == [large_row] * 50
print("ok history counts inside comment size budget")
huge_row = row[:-2] + "x" * 70000 + " |"
huge_log = "\n" + merge_log([huge_row] * 49, row)
assert len(huge_log) <= 30000 and extract_log(huge_log) == [row]
assert len(comment_markdown(large, [], "", log=huge_log)) < 65536
raw_huge_log = block.replace(row, huge_row)
assert len(comment_markdown(large, [], "", log=raw_huge_log)) < 65536
print("ok oversized history drops oldest rows within comment budget")

# Off means identical comment, job summary, and stdout, even with an old log on disk.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        os.makedirs("review")
        pathlib.Path("review/data.json").write_text(_json.dumps(ld), encoding="utf-8")
        pathlib.Path("review/previous-log.md").write_text(block, encoding="utf-8")
        expected = comment_markdown(ld, [], "")
        assert "#### Ready to merge?" in expected
        with patch.dict(os.environ, {"SITE": "", "GITHUB_STEP_SUMMARY": "summary.md"}):
            for gate in (None, "false", "TRUE", "true"):
                os.environ.pop("HISTORY", None)
                if gate is not None:
                    os.environ["HISTORY"] = gate
                pathlib.Path("summary.md").write_bytes(b"")
                with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                    cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
                comment = pathlib.Path("review/comment.md").read_bytes()
                if gate == "true":
                    assert len(extract_log(comment.decode())) == 2
                else:
                    assert comment == expected.encode()
                    assert pathlib.Path("summary.md").read_bytes() == expected.replace(MARKER, "").encode()
                    assert stdout.getvalue() == expected + "\n"
    finally:
        os.chdir(_cwd)
print("ok history opt-out byte identity and opt-in summary")



# Inventory: footprint in the object index; emitted for inventory as well as threads.
s1 = {"kind": "symbol", "ref": "R1", "match": ("symbol", "R1", "1"), "where": {"sheet": "/"}, "pos": [1, 1, 0], "props": {"Value": "10k", "Footprint": "Resistor_SMD:R_0402"}}
f1 = {"kind": "footprint", "ref": "R1", "match": ("footprint", "R1"), "where": {"board": True}, "pos": [5, 5, 0], "box": [4, 4, 6, 6],
      "props": {"Value": "10k", "footprint": "Resistor_SMD:R_0402", "layer": "F.Cu"}}
idx = object_index({}, {"/s1": s1, "f1": f1})
assert [e["footprint"] for e in idx] == ["Resistor_SMD:R_0402", "Resistor_SMD:R_0402"], idx
assert DEFAULT_SETTINGS["inventory"] == {"enabled": False}
print("ok inventory footprint field")

# Libraries: changed symbols and footprints with pin/pad diffs.
from kicad_review import library_items, library_changes
SYM = lambda pins, extra="": ('(kicad_symbol_lib (version 20231120) (symbol "LDO" (property "Reference" "U") ' + extra
    + '(symbol "LDO_1_1" ' + "".join(f'(pin {t} line (at 0 {i} 0) (length 2.54) (name "{n}" (effects)) (number "{num}" (effects)))' for i, (num, n, t) in enumerate(pins) if num != "4")
    + ') (symbol "LDO_2_1" ' + "".join(f'(pin {t} line (at 5 {i} 0) (length 2.54) (name "{n}" (effects)) (number "{num}" (effects)))' for i, (num, n, t) in enumerate(pins) if num == "4") + ')))')
FP = lambda pads, model="a.step": ('(footprint "SOT23" (layer "F.Cu") (uuid "11111111-0000-0000-0000-000000000000") '
    + "".join(f'(pad "{n}" smd rect (at {x} 0) (size 0.6 1) (layers "F.Cu") (uuid "{n}{n}"))' for n, x in pads) + f'(model "{model}"))')
def lib_tree(root, sym, fp, extra_fp=None):
    os.makedirs(f"{root}/Parts.pretty", exist_ok=True)
    open(f"{root}/Parts.kicad_sym", "w").write(sym)
    open(f"{root}/Parts.pretty/SOT23.kicad_mod", "w").write(fp)
    if extra_fp: open(f"{root}/Parts.pretty/{extra_fp[0]}.kicad_mod", "w").write(extra_fp[1].replace('"SOT23"', f'"{extra_fp[0]}"'))
with tempfile.TemporaryDirectory() as d:
    lib_tree(f"{d}/b", SYM([("1", "IN", "power_in"), ("2", "GND", "power_in"), ("3", "OUT", "power_out"), ("4", "EN", "input")]), FP([("1", 0), ("2", 1), ("3", 2)]))
    lib_tree(f"{d}/h", SYM([("1", "IN", "power_in"), ("2", "GND", "power_in"), ("3", "OUT", "power_out"), ("4", "EN", "passive")]), FP([("1", 0), ("2", 1)], model="b.step"),
             extra_fp=("SOT23-5", FP([("1", 0)])))
    items = library_items(f"{d}/b")
    assert set(items) == {("Parts", "LDO", "symbol"), ("Parts", "SOT23", "footprint")} and set(items["Parts", "LDO", "symbol"]["pins"]) == {"1", "2", "3", "4"}
    ch = {(c["kind"], c["item"]): c for c in library_changes(library_items(f"{d}/b"), library_items(f"{d}/h"))}
    assert ch["symbol", "LDO"]["status"] == "modified" and ch["symbol", "LDO"]["pins_diff"] == [{"pin": "4", "change": "type", "before": "input", "after": "passive"}], ch["symbol", "LDO"]
    print("ok multi-unit symbol pins are compared together")
    assert ch["footprint", "SOT23"]["pins_diff"] == [{"pin": "3", "change": "removed", "before": "smd rect (2, 0) 0.6×1", "after": None}]
    assert ch["footprint", "SOT23-5"]["status"] == "added"
    print("ok renamed item is removed plus added")
with tempfile.TemporaryDirectory() as d:
    lib_tree(f"{d}/b", SYM([("1", "A", "passive")]), FP([("1", 0)], model="a.step")); lib_tree(f"{d}/h", SYM([("1", "A", "passive")]), FP([("1", 0)], model="b.step"))
    ch = library_changes(library_items(f"{d}/b"), library_items(f"{d}/h"))
    assert [(c["item"], c["status"], c["pins_diff"]) for c in ch] == [("SOT23", "modified", [])], ch
print("ok non-pad edits are modified without warnings")

with tempfile.TemporaryDirectory() as d:
    lib_tree(f"{d}/b", SYM([("1", "A", "passive")]), FP([("1", 0), ("1", 1)]))
    lib_tree(f"{d}/h", SYM([("1", "A", "passive")]).replace('(length 2.54)', '(length 3)'), FP([("1", 0), ("1", 2)]))
    changed = library_changes(library_items(f"{d}/b"), library_items(f"{d}/h"))
    assert all(c["pins_diff"][0]["change"] == "geometry" for c in changed)
    os.remove(f"{d}/h/Parts.pretty/SOT23.kicad_mod")
    pathlib.Path(f"{d}/h/Parts.pretty/Renamed.kicad_mod").write_text(FP([("1", 0)]).replace('"SOT23"', '"Renamed"'))
    renamed = [c for c in library_changes(library_items(f"{d}/b"), library_items(f"{d}/h")) if c["kind"] == "footprint"]
    assert {(c["item"], c["status"]) for c in renamed} == {("SOT23", "removed"), ("Renamed", "added")}
    assert next(c for c in renamed if c["status"] == "removed")["pins_diff"][0]["change"] == "removed"
print("ok library geometry and true rename")

from kicad_review import library_report, lib_slug
objs_idx = [{"uuid": "a", "kind": "footprint", "ref": "U1", "side": "head", "lib": "Parts:SOT23"}, {"uuid": "b", "kind": "footprint", "ref": "U3", "side": "head", "lib": "Parts:SOT23"},
            {"uuid": "c", "kind": "symbol", "ref": "U1", "side": "head", "lib": "Parts:LDO"}]
changes = [{"lib": "Parts", "item": "SOT23", "kind": "footprint", "status": "modified", "file": "Parts.pretty/SOT23.kicad_mod",
            "pins_diff": [{"pin": "3", "change": "removed", "before": "smd rect (2, 0) 0.6×1", "after": None}]},
           {"lib": "Parts", "item": "LDO", "kind": "symbol", "status": "modified", "file": "Parts.kicad_sym",
            "pins_diff": [{"pin": "4", "change": "type", "before": "input", "after": "passive"}]}]
with tempfile.TemporaryDirectory() as d:
    os.makedirs(f"{d}/head/lib"); os.makedirs(f"{d}/base/lib")
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 5"><path d="M0 0L1 1"/></svg>'
    for s in ("base", "head"): open(f"{d}/{s}/lib/{lib_slug(changes[0])}.svg", "w").write(svg)
    blobs = {}
    rep = library_report(changes, objs_idx, d, blobs)
assert rep[0]["used_by"] == ["U1", "U3"] and rep[0]["warnings"] == ["⚠ pad 3 removed while U1, U3 use SOT23"] and rep[0]["svg"]["head"] in blobs and rep[0]["size"] == [10.0, 5.0], rep[0]
print("ok removed pad in use warns")
assert rep[1]["warnings"] == ["⚠ pin 4 type input → passive on LDO, used by U1"] and rep[1]["svg"] == {"base": None, "head": None} and rep[1]["note"] == "no drawing", rep[1]
print("ok missing library drawing is listed")

assert lib_slug({"kind": "symbol", "lib": "a/b", "item": "X"}) != lib_slug({"kind": "symbol", "lib": "a_b", "item": "X"})
assert "lib" not in object_index(t1_base, t1_head)[0]
with tempfile.TemporaryDirectory() as d:
    pathlib.Path(d, "kicad-review.toml").write_text('[libraries]\nenabled = true\n')
    assert load_settings((d,))["libraries"] == {"enabled": True}
    pathlib.Path(d, "kicad-review.toml").write_text('[libraries]\nenabled = "yes"\n')
    try:
        load_settings((d,))
        assert False
    except SystemExit as e:
        assert "libraries.enabled" in str(e)
print("ok library settings and safe slugs")

here = os.getcwd()
try:
    with tempfile.TemporaryDirectory() as d:
        os.chdir(d)
        lib_tree("base", SYM([("1", "IN", "input")]).replace('"LDO"', '"--output"'), FP([("1", 0), ("2", 1)]))
        lib_tree("head", SYM([("1", "IN", "passive")]).replace('"LDO"', '"--output"'), FP([("1", 0)]))
        os.makedirs("review")
        project = {"name": "X", "dir": "", "status": "modified"}
        pathlib.Path("review/detect.json").write_text(json.dumps({"projects": [project], "base": "b", "head": "h", "reason": "changed"}))
        settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.render_side"), patch("kicad_review.library_changes", side_effect=AssertionError("off parsed libraries")), patch("kicad_review.subprocess.run", side_effect=AssertionError("off exported libraries")):
            kicad_review.cmd_render(None)
        settings["libraries"]["enabled"] = True
        calls = []
        def library_export(args, **kwargs):
            calls.append(args)
            pathlib.Path(args[args.index("-o")+1], "item.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 5"><path d="M0 0L1 1"/></svg>')
            return SimpleNamespace(returncode=0)
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.render_side"), patch("kicad_review.subprocess.run", side_effect=library_export), patch("kicad_review.library_items", wraps=library_items) as parsed:
            kicad_review.cmd_render(None)
            assert parsed.call_count == 2
        assert len(calls) == 4 and all(a[:3] in (["kicad-cli", "sym", "export"], ["kicad-cli", "fp", "export"]) for a in calls)
        assert any("--symbol=--output" in a for a in calls) and any("--footprint=SOT23" in a for a in calls)
        objects = {"f1": {**t1_fpo("U1", 1), "props": {"footprint": "Parts:SOT23"}}}
        with patch("kicad_review.project_objects", return_value=objects):
            blobs = {}
            with patch("kicad_review.object_index", wraps=object_index) as indexed:
                report = build_project(project, blobs, settings)
                assert indexed.call_count == 1
            assert len(report["libraries"]) == 2 and report["objects"][0]["lib"] == "Parts:SOT23"
            assert report["libraries"][0]["used_by"] == ["U1"] and report["libraries"][0]["warnings"]
            settings["libraries"]["enabled"] = False
            settings["inventory"]["enabled"] = True
            with patch("kicad_review.library_changes", side_effect=AssertionError("off parsed libraries")):
                off = build_project(project, {}, settings)
                assert "libraries" not in off and "lib" not in off["objects"][0]
                with patch("kicad_review.object_index", return_value=object_index(objects, objects)):
                    legacy = build_project(project, {}, settings)
                assert json.dumps(off, sort_keys=True) == json.dumps(legacy, sort_keys=True)
                # Golden JSON bytes from the pre-libraries parent, with inventory enabled.
                import hashlib
                def legacy_projection(project):
                    projected = {k: v for k, v in project.items() if k != "summary"}
                    projected["changes"] = [{k: v for k, v in r.items() if k not in
                        {"channel", "weight", "document", "detail", "anchors"}} for r in project["changes"]
                        if r["kind"] not in {"net-added", "net-removed", "net-joined", "net-split", "net-renamed",
                                             "net-members", "board-pad-net", "wires", "copper", "rule", "stackup"}]
                    return projected
                legacy_shape = copy.deepcopy(legacy_projection(off))
                legacy_shape['board'].pop('inspect', None)
                for row in legacy_shape['sheets'] + legacy_shape['board']['layers']:
                    for key in ('hotspots', 'svgThemes', 'sourceRGBThemes'): row.pop(key, None)
                assert hashlib.sha256(json.dumps(legacy_shape, sort_keys=True).encode()).hexdigest() == "b937e0cb731bbe1beced3891a85e9cfd37a8353c23eae0c84c24fc2e35809c0c"
                assert "summary" in off and isinstance(off["summary"]["channels"], list)
                assert comment_markdown({**d2, "projects": [off]}, [], "") == comment_markdown({**d2, "projects": [legacy]}, [], "")
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.build_project", return_value=off):
            kicad_review.cmd_report(None)
            assert "libraries" not in json.loads(pathlib.Path("review/data.json").read_text())["settings"]
finally:
    os.chdir(here)
print("ok library exports, objects emission and off byte identity")

# Final review: precomputed item maps avoid parsing; absent/invalid SVGs cannot produce drawable views.
from kicad_review import svg_size
with patch("kicad_review.library_items", side_effect=AssertionError("parsed precomputed items")):
    assert library_changes({}, {}) == []
assert svg_size('<svg viewBox="-2e1 -3.5 1e2 5E+1"/>') == [100.0, 50.0]
with tempfile.TemporaryDirectory() as d:
    os.makedirs(f"{d}/head/lib"); os.makedirs(f"{d}/base/lib")
    path = pathlib.Path(f"{d}/head/lib/{lib_slug(changes[0])}.svg")
    for svg in ('<svg viewBox="0 0 10 5"/>', '<svg><path d="M0 0L1 1"/></svg>', '<svg viewBox="0 0 nan 5"><path d="M0 0L1 1"/></svg>'):
        path.write_text(svg)
        report = library_report(changes[:1], objs_idx, d, {})[0]
        assert report["note"] == "no drawing" and report["svg"] == {"base": None, "head": None} and "size" not in report
    path.write_text('<svg viewBox="-2e1 -3.5 1e2 5E+1"><path d="M0 0L1 1"/></svg>')
    assert library_report(changes[:1], objs_idx, d, {})[0]["size"] == [100.0, 50.0]
print("ok library final-review parsing, argv and drawing validation")

# Live PR regression fixtures: legacy module names, exported stems, and nickname fallback.
import json, os, pathlib, tempfile

_LIVE_ITEM = 'ESOP-8_L4.9-W3.9-P1.27-LS6.0-BL-EP'
def _live_tree(root, removed=False):
    folder = pathlib.Path(root, 'Libraries/footprints.pretty'); folder.mkdir(parents=True)
    pads = '(pad 1 smd rect (at -1.91 2.91 0) (size 0.60 1.20) (layers F.Cu F.Paste F.Mask))'
    if not removed:
        pads += '(pad 9 smd rect (at 0 0) (size 2.4 3.1) (layers F.Cu F.Paste F.Mask))'
    (folder / (_LIVE_ITEM + '.kicad_mod')).write_text('(module easyeda2kicad:' + _LIVE_ITEM + ' (layer F.Cu) (tedit 5DC5F6A4)' + pads + ')')
    pathlib.Path(root, 'Parts.kicad_sym').write_text('(kicad_symbol_lib (version 20231120) (symbol "Imported:LDO" (symbol "LDO_1_1" (pin input line (at 0 0 0) (length 2.54) (name "IN") (number "1")))))')

def _live_names():
    with tempfile.TemporaryDirectory() as d:
        _live_tree(d)
        items = kicad_review.library_items(d)
        assert set(items) == {('footprints', _LIVE_ITEM, 'footprint'), ('Parts', 'LDO', 'symbol')}, set(items)
        assert set(items['footprints', _LIVE_ITEM, 'footprint']['pins']) == {'1', '9'}

def _live_export():
    here = os.getcwd()
    try:
        with tempfile.TemporaryDirectory() as d:
            os.chdir(d); _live_tree('base'); _live_tree('head', removed=True)
            pathlib.Path('review').mkdir()
            pathlib.Path('review/detect.json').write_text(json.dumps({'projects': [{'dir': '', 'name': 'Thermal_Camera', 'status': 'modified'}]}))
            settings = json.loads(json.dumps(kicad_review.DEFAULT_SETTINGS)); settings['libraries']['enabled'] = True
            calls = []
            def export(args, **kwargs):
                calls.append(args)
                pathlib.Path(args[args.index('-o') + 1], 'item.svg').write_text('<svg viewBox="0 0 10 5"><path d="M0 0L1 1"/></svg>')
                return SimpleNamespace(returncode=0)
            with patch('kicad_review.load_settings', return_value=settings), patch('kicad_review.render_side'), patch('kicad_review.subprocess.run', side_effect=export):
                kicad_review.cmd_render(None)
            assert len(calls) == 2 and all('--footprint=' + _LIVE_ITEM in args for args in calls), calls
    finally:
        os.chdir(here)

def _live_usage():
    with tempfile.TemporaryDirectory() as d:
        _live_tree(d + '/base'); _live_tree(d + '/head', removed=True)
        items = {side: kicad_review.library_items(d + '/' + side) for side in ('base', 'head')}
        changes = kicad_review.library_changes(items['base'], items['head'])
        # Use the correct item identity independently of parser assertions.
        change = next(c for c in changes if c['kind'] == 'footprint'); change['item'] = _LIVE_ITEM
        objects = [{'kind': 'footprint', 'lib': 'Thermal Footprints:' + _LIVE_ITEM, 'ref': 'U1', 'side': 'head'}]
        report = kicad_review.library_report([change], objects, d, {}, local_items=set(items['base']) | set(items['head']))[0]
        assert report['used_by'] == ['U1'] and report['warnings'] == ['⚠ pad 9 removed while U1 uses ' + _LIVE_ITEM], report
        keys = set(items['head']) | {('Other', _LIVE_ITEM, 'footprint')}
        assert kicad_review.library_report([change], objects, d, {}, local_items=keys)[0]['used_by'] == []
        # A known local nickname must not fall back to a different library's same-named item.
        keys = set(items['head']) | {('Thermal Footprints', 'Different', 'footprint')}
        assert kicad_review.library_report([change], objects, d, {}, local_items=keys)[0]['used_by'] == []
        # Exact matches remain valid even when another library has a duplicate item name.
        objects[0]['lib'] = 'footprints:' + _LIVE_ITEM
        assert kicad_review.library_report([change], objects, d, {}, local_items=set(items['head']) | {('Other', _LIVE_ITEM, 'footprint')})[0]['used_by'] == ['U1']


_live_names(); _live_export(); _live_usage()
print("ok live library identity, legacy export and placed-part usage")
# Readiness: one check run per check across projects, worst result wins; comment block.
from kicad_review import check_runs, readiness_markdown
ck = lambda name, title, status, e=0, ne=0: {"name": name, "title": title, "level": "required", "status": status,
                                             "errors": e, "new_errors": ne, "warnings": 0, "new_warnings": 0, "fixed": 0, "violations": []}
rd = {**d2, "projects": [
    {"name": "A", "dir": "a", "status": "modified", "changes": [], "checks": [ck("erc", "ERC", "pass"), ck("drc", "DRC", "fail", 2, 1)]},
    {"name": "B", "dir": "b", "status": "modified", "changes": [], "checks": [ck("erc", "ERC", "warn", 1, 0),
        {**ck("parity", "Schematic/board parity", "not_run"), "reason": "no schematic"}]}]}
runs = {r["name"]: r for r in check_runs(rd)}
assert set(runs) == {"kicad-review / ERC", "kicad-review / DRC", "kicad-review / Schematic/board parity"}, runs.keys()
assert runs["kicad-review / ERC"]["conclusion"] == "neutral" and runs["kicad-review / DRC"]["conclusion"] == "failure"
assert runs["kicad-review / Schematic/board parity"]["conclusion"] == "skipped"
assert "| B | ⚠️ warn | 1 (0) |" in runs["kicad-review / ERC"]["output"]["summary"], runs["kicad-review / ERC"]["output"]["summary"]
assert runs["kicad-review / DRC"]["output"]["title"] == "1 new error"
block = "\n".join(readiness_markdown(rd, threads={"open": 3, "blocking": 2, "resolved": 0}))
assert "#### Ready to merge?" in block and "✕ **Required checks:** failing (A DRC)" in block, block
assert "✕ **Blocking threads:** 2 open" in block and "**Approvals:** see the pull request's reviewers" in block
ok = {**d2, "projects": [{"name": "A", "dir": "", "status": "modified", "changes": [], "checks": [ck("erc", "ERC", "pass")]}]}
assert "✓ **Required checks:** passing" in "\n".join(readiness_markdown(ok)) and "Blocking threads" not in "\n".join(readiness_markdown(ok))
assert "✓ **Blocking threads:** none open" in "\n".join(readiness_markdown(ok, threads={"open": 1, "blocking": 0, "resolved": 0}))
assert DEFAULT_SETTINGS["github"] == {"check_runs": False} and DEFAULT_SETTINGS["threads"] == {"enabled": False, "block_merge": False}
assert "#### Ready to merge?" in comment_markdown(ok, [], "")
print("ok readiness payloads")

_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d); os.makedirs("base")
        for text, error in (('[threads]\nblock_merge = true\n', "threads.block_merge needs threads.enabled = true"),
                            ('[github]\ncheck_runs = 1\n', "github.check_runs must be true or false")):
            with open("base/kicad-review.toml", "w") as fh: fh.write(text)
            try:
                load_settings(); raise AssertionError(error)
            except SystemExit as e:
                assert error in str(e), str(e)
    finally:
        os.chdir(_cwd)
print("ok readiness settings")

# Readiness stays visible after the project body is truncated.
large = {**ok, "projects": [{**ok["projects"][0], "name": "A" * 300} for _ in range(300)]}
body = comment_markdown(large, [], "")
assert "… truncated" in body and "#### Ready to merge?" in body and len(body) < 65536
assert "↗ **Approvals:**" in body
print("ok readiness comment truncation")

# The opted-in gate fails closed without readable thread counts.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d); os.makedirs("review")
        for check_runs, gate, contents, failed in (
            (True, True, None, "blocking threads could not be read"),
            (True, True, "not json", "blocking threads could not be read"),
            (True, True, _json.dumps({"errors": [{"type": "FORBIDDEN"}]}), "blocking threads could not be read"),
            (True, True, _json.dumps({"data": {"repository": {"pullRequest": {}}}}), "blocking threads could not be read"),
            (True, True, _json.dumps([]), "blocking threads could not be read"),
            (True, True, _json.dumps({"data": {"repository": {"pullRequest": {"reviewThreads": {"totalCount": 101, "nodes": []}}}}}), "blocking threads could not be read"),
            (True, True, _json.dumps(gql), "1 blocking thread open"),
            (True, True, _json.dumps({"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}}), ""),
            (False, True, None, "blocking threads could not be read"),
            (True, False, None, ""),
        ):
            if os.path.exists("review/threads.json"):
                os.remove("review/threads.json")
            if os.path.exists("review/check-runs.json"):
                os.remove("review/check-runs.json")
            if contents is not None:
                with open("review/threads.json", "w") as fh: fh.write(contents)
            with open("review/data.json", "w") as fh:
                _json.dump({**ok, "settings": {"threads": {"enabled": True, "block_merge": gate}, "github": {"check_runs": check_runs}}}, fh)
            with open("outputs", "w") as fh: pass
            with patch.dict(os.environ, {"GITHUB_OUTPUT": "outputs", "GITHUB_STEP_SUMMARY": os.devnull}), patch("sys.stdout", new_callable=io.StringIO):
                cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
            with open("review/comment.md") as fh: comment = fh.read()
            assert ("- ✕ **Blocking threads:** could not be read" in comment) == (failed == "blocking threads could not be read"), comment
            with open("outputs") as fh: outputs = fh.read()
            assert outputs == f"check_runs={'true' if check_runs else 'false'}\nthreads_failed={failed}\n", outputs
            assert os.path.exists("review/check-runs.json") == check_runs
            if check_runs:
                with open("review/check-runs.json") as fh: runs = _json.load(fh)
                thread_runs = [r for r in runs if r["name"] == "kicad-review / Threads"]
                assert len(thread_runs) == int(gate)
                if gate:
                    assert thread_runs[0]["conclusion"] == ("failure" if failed else "success")
                    assert thread_runs[0]["output"]["title"] == (failed or "no blocking threads open")
    finally:
        os.chdir(_cwd)
print("ok readiness summary gate")

# Cap raw names before Markdown escaping, including an escape at the boundary.
escaped = {**ok, "projects": [{**ok["projects"][0], "name": "a" * 999 + "*", "checks": [ck("erc", "ERC", "fail")]}]}
assert md("a" * 999 + "*… (full list in Checks)") in "\n".join(readiness_markdown(escaped))
assert "- ✕ **Blocking threads:** could not be read" in readiness_markdown(ok, threads_required=True)
print("ok readiness unreadable threads and escape boundary")

# Readiness: the gate passes with threads enabled but none blocking.
assert "✓ **Blocking threads:** none open" in "\n".join(readiness_markdown(ok, threads={"open": 0, "blocking": 0, "resolved": 0}))
print("ok gate passes with no blocking threads")

# Waivers: a stable key per violation, from the same identity used to call a violation "new".
from kicad_review import waiver_key, load_violations
v1 = {"type": "clearance", "severity": "error", "description": "Clearance violation (0.15 mm < 0.2 mm)", "items": ["Pad 1 of J1", "Track"],
      "uuids": ["u-b", "u-a"], "pos": [10.0, 5.0], "box": None, "where": {"board": True}}
k = waiver_key(v1)
assert re.fullmatch(r"w-[0-9a-f]{12}", k), k
assert k == "w-9ca330438b76"
assert waiver_key({**v1, "uuids": []}) == "w-6a0c64898488"
assert waiver_key({**v1, "key": ("custom", "id")}) == "w-07981c798d2b"
assert waiver_key({**v1, "severity": "warning"}) == "w-46e733a72221"
assert waiver_key({**v1, "uuids": ["u-a", "u-b"]}) == k
assert waiver_key({**v1, "description": "Clearance violation (0.11 mm < 0.2 mm)", "pos": [11, 6]}) == k  # same UUIDs: same finding
assert waiver_key({**v1, "uuids": ["u-c"]}) != k
assert waiver_key({**v1, "severity": "warning"}) != k
no_uuid = {**v1, "uuids": []}
assert waiver_key(no_uuid) == waiver_key({**no_uuid, "description": "Clearance violation (0.1 mm < 0.2 mm)"})  # numbers normalised
assert waiver_key(no_uuid) != waiver_key({**no_uuid, "pos": [30.0, 5.0]})
print("ok waiver keys")

import json as _j, tempfile as _t, os as _o
with _t.TemporaryDirectory() as d:
    unc = lambda: {"type": "unconnected_items", "severity": "error", "description": "Missing connection",
                   "items": [{"description": "Pad 1 [GND] of R1", "pos": {"x": 1, "y": 1}}, {"description": "Pad 2 [GND] of R2", "pos": {"x": 2, "y": 2}}]}
    with open(f"{d}/drc.json", "w") as fh:
        _j.dump({"violations": [], "unconnected_items": [unc(), unc()]}, fh)
    vs = load_violations(f"{d}/drc.json", "drc")
    assert len({waiver_key(v) for v in vs}) == 2, [waiver_key(v) for v in vs]
    assert [waiver_key(v) for v in vs] == [waiver_key(v) for v in load_violations(f"{d}/drc.json", "drc")]
print("ok unconnected duplicates get distinct keys")

# ERC scale comes from referenced schematic geometry, never the KiCad version.
with _t.TemporaryDirectory() as d:
    old_cwd = os.getcwd()
    try:
        os.chdir(d)
        objects = {"/symbol": {"kind": "symbol", "ref": "U1", "pos": [127, 88.9, 0], "props": {}, "where": {"sheet": "/"}},
                   "/child/symbol": {"kind": "symbol", "ref": "U1", "pos": [254, 177.8, 0], "props": {}, "where": {"sheet": "/child/"}}}
        settings = {**DEFAULT_SETTINGS, "checks": {"erc": "required"}}
        for divisor in (1, 100):
            for pins_only in (False, True):
                sheets = []
                for page, x, y in (("/", 127, 88.9), ("/child/", 254, 177.8)):
                    items = [{"uuid": "pin" if pins_only else "symbol", "description": "Symbol U1 Pin 1 [Input]" if pins_only else "Symbol U1 [Test]",
                              "pos": {"x": x / divisor, "y": (y + (2.54 if pins_only else 0)) / divisor}},
                             {"uuid": "unknown", "description": "Unmapped item", "pos": {"x": (x + 5) / divisor, "y": y / divisor}}]
                    sheets.append({"uuid_path": "/root" + page.rstrip("/"), "violations": [
                        {"type": "pin_not_connected", "severity": "error", "description": "Test", "items": items},
                        {"type": "test", "severity": "warning", "description": "No position", "items": []}]})
                report = {"coordinate_units": "mm", "kicad_version": "10.0.6", "sheets": sheets}
                write(d, {"head/G/G.kicad_sch": "", "review/G/head/erc.json": _j.dumps(report)})
                check = project_checks({"dir": "G", "name": "G"}, settings, {"head": objects, "base": {}})[0]
                located = [v for v in check["violations"] if v["pos"]]
                assert [v["pos"] for v in located] == [[127, 91.44 if pins_only else 88.9], [254, 180.34 if pins_only else 177.8]], "ERC must detect bad scale without rescaling correct mm"
                assert located[0]["box"] == [125.5, 87.4, 133.5, 92.94 if pins_only else 90.4], located[0]
                assert all(v["pos"] is None and v["box"] is None for v in check["violations"] if not v["pos"])
        # An exact UUID match wins over pin-anchor proximity; small coordinates alone prove nothing.
        from kicad_review import erc_position_scale
        evidence = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "symbol", "pos": {"x": 127, "y": 88.9}},
            {"uuid": "pin", "description": "Symbol U1 Pin 1 [Input]", "pos": {"x": 1.27, "y": 0.889}}]}]}]
        assert erc_position_scale(evidence, objects) == 1
        assert erc_position_scale([], objects) == 1
        # Inconclusive geometry falls back to the report version; evidence still wins.
        report["sheets"] = [{"uuid_path": "/root", "violations": [{"type": "test", "severity": "error", "description": "Test", "items": [
            {"uuid": "unknown", "pos": {"x": 0.5, "y": 0.8}}]}]}]
        for version, scale in (("10.0.6", 100), ("10.0.6-1", 100), ("(10.0.6)", 100),
                               ("10.0.0", 100), ("10.0.7", 1), ("10.0.60", 1), ("11.0.0", 1),
                               (None, 1), ("unknown", 1), ({}, 1)):
            report["kicad_version"] = version
            write(d, {"review/G/head/erc.json": _j.dumps(report)})
            assert load_violations("review/G/head/erc.json", "erc")[0]["pos"] == [0.5 * scale, 0.8 * scale], version
        assert erc_position_scale(evidence, objects, "10.0.6") == 1
        # A tied vote is also inconclusive, not evidence that the writer is fixed.
        tied = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "symbol", "pos": {"x": 127, "y": 88.9}},
            {"uuid": "symbol", "pos": {"x": 1.27, "y": 0.889}}]}]}]
        assert erc_position_scale(tied, objects, "10.0.6") == 100
        assert erc_position_scale(tied, objects, "10.0.7") == 1
        # Ambiguous pin anchors must not outvote the version for a multi-unit symbol.
        multi = {"/unit1": {"kind": "symbol", "ref": "U1", "pos": [30, 30], "where": {"sheet": "/"}},
                 "/unit2": {"kind": "symbol", "ref": "U1 unit 2", "pos": [200, 150], "where": {"sheet": "/"}}}
        ambiguous = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "pin5", "description": "Symbol U1 Pin 5", "pos": {"x": 2.0, "y": 1.5254}}]}]}]
        assert erc_position_scale(ambiguous, multi, "10.0.6") == 100, "ambiguous pin must defer to version"
        # A far UUID match is not exact evidence and must not override a decisive pin vote.
        far_objects = {**multi, "/other": {"kind": "symbol", "ref": "U2", "pos": [200, 150], "where": {"sheet": "/"}}}
        far = [{"uuid_path": "/root", "violations": [{"items": [
            {"uuid": "unit1", "pos": {"x": 2.0, "y": 0.3}},
            {"uuid": "pin", "description": "Symbol U2 Pin 1", "pos": {"x": 2.0, "y": 1.5254}}]}]}]
        assert erc_position_scale(far, far_objects, "10.0.7") == 100, "far exact match must not override pins"
    finally:
        os.chdir(old_cwd)
print("ok ERC scale detection for fixed and buggy reports, pins and reused sheets")

# Waivers: read from the target ref with git, head copy only proposes; invalid entries skipped; expiry by date.
import datetime
from kicad_review import load_waivers

def load_waivers_on(ref, today):
    with patch("kicad_review.datetime.datetime") as clock:
        clock.now.return_value.date.return_value = today
        return load_waivers(ref)

WFILE = '''[[waiver]]
check = "drc"
match = "%s"
reason = "intended"
by = "ann"
date = 2026-10-01
until = 2026-12-31

[[waiver]]
check = "drc"
match = "w-000000000000"
reason = "old"
by = "ann"
date = 2026-01-01
until = 2026-02-01

[[waiver]]
check = "bom"
match = "w-111111111111"
reason = "nope"
by = "ann"
date = 2026-10-01
permanent = true

[[waiver]]
check = "drc"
match = "w-222222222222"
reason = ""
by = "ann"
date = 2026-10-01
permanent = true
''' % k
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d, patch("sys.stdout", new_callable=io.StringIO):
    try:
        os.chdir(d)
        subprocess.run(["git", "init", "-q", "repo"], check=True)
        open("repo/kicad-review-waivers.toml", "w").write(WFILE)
        subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "add", "."], check=True)
        subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "w"], check=True)
        ref = subprocess.run(["git", "-C", "repo", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        os.makedirs("head")
        open("head/kicad-review-waivers.toml", "w").write(WFILE + '\n[[waiver]]\ncheck = "erc"\nmatch = "w-333333333333"\nreason = "new"\nby = "bo"\ndate = 2026-10-12\npermanent = true\n')
        w = load_waivers_on(ref, datetime.date(2026, 10, 12))
        assert set(w["active"]) == {("drc", k)}, w["active"]
        assert [e["match"] for e in w["expired"]] == ["w-000000000000"]
        assert [e["match"] for e in w["proposed"]] == ["w-000000000000", "w-333333333333"]
        assert len(w["invalid"]) == 4, w["invalid"]  # changed head retains all invalid entries
        head_file = pathlib.Path("head/kicad-review-waivers.toml")
        head_file.write_text(WFILE)
        assert len(load_waivers_on(ref, datetime.date(2026, 10, 12))["invalid"]) == 2  # identical files report once
        head_file.write_text(WFILE + "\n")
        assert len(load_waivers_on(ref, datetime.date(2026, 10, 12))["invalid"]) == 4  # even whitespace makes the text distinct
        head_file.write_text(WFILE.replace("until = 2026-02-01", "until = 2026-12-31"))
        renewed = load_waivers_on(ref, datetime.date(2026, 10, 12))
        assert [e["match"] for e in renewed["proposed"]] == ["w-000000000000"], renewed
        assert renewed["proposed"][0]["until"] == "2026-12-31"
        head_file.write_text(WFILE.replace("w-222222222222", "w-444444444444"))
        invalid = load_waivers_on(ref, datetime.date(2026, 10, 12))["invalid"]
        assert len([m for m in invalid if "reason must not be empty" in m]) == 2, invalid
        assert load_waivers_on(ref, datetime.date(2027, 1, 1))["active"] == {}  # the day after until
        assert load_waivers(None)["active"] == {}  # no target ref: nothing applies
    finally:
        os.chdir(_cwd)
print("ok waivers come from the target ref, not the merge base")
print("ok expired waivers do not apply")
print("ok invalid waiver entries are skipped, not fatal")

# Applying: the waived error stops failing the check but stays listed.
settings = json.loads(json.dumps(DEFAULT_SETTINGS)); settings["waivers"] = {"enabled": True}
active = {"active": {("drc", k): {"check": "drc", "match": k, "reason": "intended", "by": "ann", "until": "2026-12-31", "permanent": False, "ref": None}},
          "expired": [], "proposed": [], "invalid": []}
c = run_check("drc", settings, [dict(v1)], [], waivers=active)
assert c["status"] == "pass" and c["errors"] == 0 and c["new_errors"] == 0 and c["waived"] == 1, c
assert c["violations"][0]["waived"] == {"reason": "intended", "by": "ann", "until": "2026-12-31", "ref": None}
assert c["violations"][0]["waiver_key"] == k
assert run_check("drc", settings, [dict(v1)], [], waivers=None)["status"] == "fail"
assert "waiver_key" not in run_check("drc", settings, [dict(v1)], [])["violations"][0]
print("ok waived findings stop failing")

# Invalid TOML shapes and field types must warn, never crash or apply.
from kicad_review import parse_waivers
valid = WFILE.split("\n[[waiver]]", 1)[0]
for bad_text in ("waiver = [1]", "[waiver]\ncheck = 'drc'", "waiver = 'wrong'", "[[waiver]",
                 valid.replace("until = 2026-12-31", "until = 2026-12-31T00:00:00"),
                 valid.replace("date = 2026-10-01", "date = 2026-10-01T00:00:00"),
                 valid.replace('check = "drc"', 'check = ["drc"]'),
                 valid.replace('match = "' + k + '"', "match = 1"),
                 valid.replace('reason = "intended"', "reason = false"),
                 valid.replace('by = "ann"', "by = 1"),
                 valid + "\npermanent = 'true'", valid + "\nref = 1",
                 valid.replace("until = 2026-12-31", "until = '2026-12-31'\npermanent = true")):
    entries, invalid = parse_waivers(bad_text, "fixture")
    assert entries == [] and invalid, (bad_text, entries, invalid)
print("ok invalid waiver shapes and types are rejected")

_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        subprocess.run(["git", "init", "-q", "repo"], check=True)
        path = pathlib.Path("repo/kicad-review-waivers.toml")
        path.write_text(valid)
        subprocess.run(["git", "-C", "repo", "add", "."], check=True)
        subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "valid"], check=True)
        sha = subprocess.check_output(["git", "-C", "repo", "rev-parse", "HEAD"], text=True).strip()
        subprocess.run(["git", "-C", "repo", "update-ref", "refs/remotes/origin/main", sha], check=True)
        assert set(load_waivers_on("origin/main", datetime.date(2026, 12, 31))["active"]) == {("drc", k)}
        for bad_text in ("waiver = [1]", "[waiver]\ncheck = 'drc'",
                         valid.replace("until = 2026-12-31", "until = 2026-12-31T00:00:00")):
            path.write_text(bad_text)
            subprocess.run(["git", "-C", "repo", "add", "."], check=True)
            subprocess.run(["git", "-C", "repo", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "invalid"], check=True)
            sha = subprocess.check_output(["git", "-C", "repo", "rev-parse", "HEAD"], text=True).strip()
            subprocess.run(["git", "-C", "repo", "update-ref", "refs/remotes/origin/main", sha], check=True)
            with patch("sys.stdout", new_callable=io.StringIO) as warnings:
                result = load_waivers("origin/main")
            assert not result["active"] and result["invalid"]
            assert "::warning::" in warnings.getvalue() and sha[:7] in warnings.getvalue()
    finally:
        os.chdir(_cwd)
print("ok live target ref and invalid target files")

warning = {**v1, "severity": "warning"}
warning_key = waiver_key(warning)
all_active = copy.deepcopy(active)
all_active["active"][("drc", warning_key)] = {**active["active"][("drc", k)], "match": warning_key}
settings["fail_on"] = "all"
c = run_check("drc", settings, [dict(v1), warning], [dict(v1)], all_active)
assert c["status"] == "pass" and c["waived"] == 2 and c["warnings"] == c["new_warnings"] == c["errors"] == c["new_errors"] == c["fixed"] == 0
plain = run_check("drc", settings, [dict(v1)], [])
assert "waived" not in plain and "waiver_key" not in plain["violations"][0]
print("ok waiver counters and opted-out violation fields")

# Report wiring reads no waiver file when off; live target ref wins over local fallback.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        pathlib.Path("review").mkdir()
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "local-base", "head": "h", "reason": "fixture", "projects": [project]}))
        for enabled, target in ((False, "origin/main"), (True, "origin/release"), (True, "")):
            settings = copy.deepcopy(DEFAULT_SETTINGS)
            settings["waivers"]["enabled"] = enabled
            with patch.dict(os.environ, {"WAIVERS_REF": target}), patch("kicad_review.load_settings", return_value=settings), \
                 patch("kicad_review.load_waivers", return_value=active) as loader, \
                 patch("kicad_review.build_project", return_value={"checks": [], "changes": []}) as builder, \
                 patch("sys.stdout", new_callable=io.StringIO):
                kicad_review.cmd_report(None)
            if enabled:
                loader.assert_called_once_with(target or "local-base")
            else:
                loader.assert_not_called()
                assert "waivers" not in json.loads(pathlib.Path("review/data.json").read_text())
            assert builder.call_args.args[3] == (active if enabled else None)
    finally:
        os.chdir(_cwd)
print("ok waiver report opt-in and target-ref wiring")

# Untrusted refs cannot become git options; unsafe or huge head files are never parsed.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        subprocess.run(["git", "init", "-q", "repo"], check=True)
        for ref in ("--output=x", "missing-target"):
            with patch("sys.stdout", new_callable=io.StringIO) as warnings:
                result = load_waivers(ref)
            assert not result["active"] and result["invalid"] == [f"kicad-review-waivers.toml: cannot resolve {ref}"]
            assert "::warning::" in warnings.getvalue()
            assert not pathlib.Path("x").exists() and not pathlib.Path("repo/x").exists()
        pathlib.Path("head").mkdir()
        head_file = pathlib.Path("head/kicad-review-waivers.toml")
        head_file.symlink_to("/dev/zero")
        with patch("sys.stdout", new_callable=io.StringIO), patch("builtins.open", side_effect=AssertionError("symlink must not be opened")):
            result = load_waivers(None)
        assert not result["proposed"] and any("symlink" in m for m in result["invalid"])
        head_file.unlink()
        head_file.write_bytes(b" " * (1024 * 1024 + 1))
        with patch("sys.stdout", new_callable=io.StringIO):
            result = load_waivers(None)
        assert not result["proposed"] and any("exceeds 1 MiB" in m for m in result["invalid"])
    finally:
        os.chdir(_cwd)
print("ok waiver ref options, missing refs, symlinks and size limit")

# Comment summaries distinguish waived findings from new errors and escape waiver text.
from kicad_review import waiver_lines, checks_markdown
entry = {"check": "erc", "match": "w-444444444444", "reason": "gone", "by": "bo"}
wd = {"projects": [{"name": "A", "checks": [{**c, "violations": [{**v1, "new": True, "waived": {"reason": "intended"}}], "waived": 1}]}],
      "waivers": {"stale": [entry], "expired": [{**entry, "until": "2026-02-01"}],
                  "proposed": [entry], "invalid": ["waiver 3: reason must not be empty"]}}
text = "\n".join(waiver_lines(wd))
assert "1 finding waived" in text
assert "Waiver not matched in this review: erc w-444444444444 (gone, by bo) (if its finding is gone, remove it)." in text
assert "Expired waiver: erc w-444444444444 (gone, by bo) ended 2026-02-01." in text
assert "Proposed in this change (applies after it merges): erc w-444444444444 (gone, by bo)." in text
assert "waiver 3: reason must not be empty" in text
assert "New errors" not in checks_markdown(wd) and "1 finding waived" in checks_markdown(wd)
unwaived = copy.deepcopy(wd)
unwaived["projects"][0]["checks"][0]["violations"].append({**v1, "new": True, "description": "real new error"})
assert "real new error" in checks_markdown(unwaived)
assert waiver_lines(d2) == [] and "waived" not in checks_markdown(d2)
unsafe = "[link](x) *bold* <img> @ann | `code`"
for field in ("check", "match", "reason", "by", "until"):
    escaped = copy.deepcopy(wd)
    escaped["waivers"]["expired"][0][field] = unsafe
    rendered = "\n".join(waiver_lines(escaped))
    assert md(unsafe) in rendered and unsafe not in rendered, (field, rendered)
empty = {"projects": [], "waivers": {"stale": [], "expired": [], "proposed": [], "invalid": []}}
assert waiver_lines(empty) == [] and "waived" not in checks_markdown(empty)
for field in ("check", "match", "reason", "by", "until"):
    multiline = copy.deepcopy(wd)
    multiline["waivers"]["expired"][0][field] = "a\nb\r\n\t c"
    lines = waiver_lines(multiline)
    assert any("a b c" in line for line in lines)
    assert all("\n" not in line and "\r" not in line and "\t" not in line for line in lines)
multiline["waivers"]["invalid"] = ["a\nb"]
assert "- Ignored: a b" in waiver_lines(multiline)
print("ok stale waivers are listed and waived errors stay out of new errors")
print("ok waiver text stays on one line and empty waiver summaries are omitted")

# Exercise stale classification in cmd_report, including repeated keys across projects.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    try:
        os.chdir(d)
        pathlib.Path("review").mkdir()
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "b", "head": "h", "reason": "fixture", "projects": [project, project]}))
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings["waivers"]["enabled"] = True
        loaded = {"active": {("drc", k): {**entry, "check": "drc", "match": k}, ("erc", entry["match"]): entry},
                  "expired": wd["waivers"]["expired"], "proposed": [entry], "invalid": ["bad entry"]}
        with patch("kicad_review.load_settings", return_value=settings), patch("kicad_review.load_waivers", return_value=loaded), \
             patch("kicad_review.build_project", side_effect=lambda *args: {"checks": [{"name": "drc", "violations": [{"waiver_key": k, "waived": {"reason": "intended"}}], "status": "pass"}], "changes": []}), \
             patch("sys.stdout", new_callable=io.StringIO):
            kicad_review.cmd_report(None)
        data = json.loads(pathlib.Path("review/data.json").read_text())
        assert data["waivers"] == {"stale": [entry], "expired": loaded["expired"], "proposed": [entry], "invalid": ["bad entry"]}
        payload = pathlib.Path("review/kicad-review.html").read_text().split("window.REVIEW_DATA = ", 1)[1].split(";</script>", 1)[0]
        assert json.loads(payload)["waivers"] == data["waivers"]
    finally:
        os.chdir(_cwd)
print("ok report stale classification and embedded waiver data")

# Checkout's full-history fetch populates all remote branches even for detached PR heads.
wf = pathlib.Path(".github/workflows/review.yml").read_text()
checkout = wf.split("- name: Check out project history", 1)[1].split("- name: Check out review tools", 1)[0]
assert "fetch-depth: 0" in checkout and "path: repo" in checkout
assert "ref: ${{ github.event.pull_request.head.sha || github.sha }}" in checkout, "SHA checkout must not reset a live origin branch to the event's old commit"
assert "WAIVERS_REF: origin/${{ github.event.pull_request.base.ref || github.event.repository.default_branch }}" in wf
print("ok workflow live waiver target and full-history project checkout")

# Readiness keeps waived findings visible without treating them as blockers.
assert "- ↷ **Waived findings:** 1 (not blocking)" in readiness_markdown(wd)
assert not any("Waived" in line for line in readiness_markdown(d2))
assert "- ↷ **Waived findings:** 0 (not blocking)" in readiness_markdown(empty)
assert readiness_markdown(wd)[-2].startswith("- ↷ **Waived findings:**")
print("ok waived row in readiness")

# Issues: match only open anchored issues, keep the disabled summary identical.
from kicad_review import touched_issues
enc_issue = lambda n, ref, project="": {"number": n, "body": enc({"v": 1, "project": project, "ref": ref, "severity": "comment"})}
idata = {**d2, "projects": [{"name": "A", "dir": "", "status": "modified", "checks": [], "changes": [{"ref": "R16", "kind": "footprint", "action": "modified", "changes": [], "props": {}}]}]}
issues = [enc_issue(12, "R16"), enc_issue(15, "C3"), {"number": 20, "body": "plain issue"}, enc_issue(21, "R16", "other"), {**enc_issue(22, "R16"), "pull_request": {}}, {**enc_issue(23, "R16"), "state": "closed"}, enc_issue(12, "R16"), {**enc_issue(24, "R16"), "body": 5}, enc_issue("unsafe", "R16")]
assert touched_issues(issues, idata) == [12]
assert touched_issues({"message": "denied"}, idata) == []
assert "Touches parts named in #12, #15." in comment_markdown(idata, [], "", issues=[12, 15])
assert comment_markdown(idata, [], "") == comment_markdown(idata, [], "", issues=None) == comment_markdown(idata, [], "", issues=[])
assert DEFAULT_SETTINGS["issues"] == {"enabled": False}
print("ok touched issues and disabled summary byte identity")

# Issues: opt-out data and summary bytes keep the legacy shape, including an existing issues file.
from kicad_review import cmd_report, review_links
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t)
        os.makedirs("review")
        det = {"base": "a" * 40, "head": "b" * 40, "reason": "test", "projects": []}
        with open("review/detect.json", "w") as fh: _json.dump(det, fh)
        with patch.dict(os.environ, {"GITHUB_OUTPUT": os.devnull, "GITHUB_STEP_SUMMARY": os.devnull}, clear=True):
            with patch("kicad_review.inline_page", side_effect=lambda payload: payload), patch("sys.stdout", new_callable=io.StringIO):
                cmd_report(SimpleNamespace())
            legacy = {"version": 1, "repo": "", "links": review_links(os.environ, det), "base": det["base"], "head": det["head"], "reason": "test",
                      "settings": {k: ({name: value for name, value in v.items() if name not in ("interfaces", "release", "fab_limits")} if k == "checks" else {name: value for name, value in v.items() if name != "check_limits"} if k == "fabrication" else {"required_fields": v["required_fields"]} if k == "bom" else v) for k, v in DEFAULT_SETTINGS.items() if k not in ("3d", "parts", "digikey", "pdf", "threads", "issues", "waivers", "inventory", "libraries", "github", "interfaces", "release", "downloads")}, "run_id": "", "projects": []}
            legacy["assets"] = {}  # additive image capability does not enable issues
            assert open("review/data.json").read() == _json.dumps(legacy)
            assert open("review/kicad-review.html").read() == "window.REVIEW_DATA = " + _json.dumps({**{k: v for k, v in legacy.items() if k != "assets"}, "blobs": {}, "assets": {}}, separators=(",", ":")) + ";"
            with open("review/issues.json", "w") as fh: _json.dump(issues, fh)
            with patch("sys.stdout", new_callable=io.StringIO): cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
            assert open("review/comment.md").read() == comment_markdown(legacy, [], "")
            assert "issues" not in _json.load(open("review/data.json"))["settings"]
        os.makedirs("base")
        for value in ['"yes"', '3', '[]']:
            with open("base/kicad-review.toml", "w") as fh: fh.write('[issues]\nenabled = ' + value + '\n')
            try: load_settings(); raise AssertionError("bad issue enabled accepted")
            except SystemExit as error: assert "issues.enabled must be true or false" in str(error)
    finally: os.chdir(_cwd)
print("ok issues disabled report payload, data and comment byte identity")

# Issues: cmd_summary opts in and degrades on invalid JSON.
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as t:
    try:
        os.chdir(t); os.makedirs("review")
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": os.devnull}):
            for contents, expected in [(_json.dumps(issues), True), ('not json', False), (_json.dumps({"message": "denied"}), False)]:
                with open("review/data.json", "w") as fh: _json.dump({**idata, "settings": {"issues": {"enabled": True}}}, fh)
                with open("review/issues.json", "w") as fh: fh.write(contents)
                with patch("sys.stdout", new_callable=io.StringIO) as stdout: cmd_summary(SimpleNamespace(image_base="", artifact_url="", artifact_id=""))
                assert ("Touches parts named in #12." in open("review/comment.md").read()) == expected
                if contents == 'not json': assert "::warning::review/issues.json is not JSON" in stdout.getvalue()
    finally: os.chdir(_cwd)
print("ok issues cmd_summary opt-in and malformed data")


# Normalized board scenes: stable identity and exact micrometre geometry.
from pathlib import Path
from tempfile import TemporaryDirectory
from kicad_review import board_geometry, geometry_um
GEOMETRY_FIXTURE = '''(kicad_pcb (version 20260206)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
 (net 0 "") (net 1 "GND")
 (segment (start 1 2) (end 3 2) (width .25) (layer "F.Cu") (net 1) (uuid tr))
 (via (at 4 5) (size .8) (drill .4) (layers "F.Cu" "B.Cu") (net 1) (uuid vi))
 (footprint "Test:X" (layer "B.Cu") (at 10 20 90) (uuid fp)
  (property "Reference" "J1")
  (pad "1" thru_hole oval (at 2 0 90) (size 2 1) (drill oval .8 .4)
   (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid pa))
  (pad "1" smd roundrect (at 0 2 90) (size 1 1) (roundrect_rratio .25)
   (layers "B.Cu") (net 1 "GND") (uuid pb))))'''
def scene_from_text(text):
    with TemporaryDirectory() as d:
        p = Path(d) / "test.kicad_pcb"
        p.write_text(text)
        return board_geometry(p)
s = scene_from_text(GEOMETRY_FIXTURE)
assert (s["version"], s["units"]) == (1, "um")
assert geometry_um("-0.0005") == -1
assert geometry_um("1.2345") == 1235
assert s["nets"] == [{"id": 0, "name": ""}, {"id": 1, "name": "GND"}]
assert [l["id"] for l in s["layers"]] == [0, 2, 44]  # never assume old KiCad IDs
by_id = {o["uuid"]: o for o in s["objects"]}
assert by_id["tr"]["geometry"]["segments"] == [[1000,2000,3000,2000,250]]
assert by_id["pa"]["geometry"]["primitive"]["center"] == [10000,18000]
assert by_id["pb"]["geometry"]["primitive"]["center"] == [12000,20000]
assert by_id["pa"]["changeUuid"] == by_id["pb"]["changeUuid"] == "fp"
assert by_id["pa"]["ref"] == "J1" and by_id["pa"]["net"] == 1
assert by_id["pa"]["geometry"]["primitive"]["angle"] == 90000
assert by_id["pa"]["geometry"]["drill"]["size"] == [800,400]
assert by_id["pb"]["geometry"]["primitive"]["radius"] == 250
assert all(l in {x["name"] for x in s["layers"]} for o in s["objects"] for l in o["layers"])
assert len({o["uuid"] for o in s["objects"]}) == len(s["objects"])
from kicad_review import geometry_arc
arc = geometry_arc((1,0),(0,1),(-1,0),".2")
assert arc[0][:2] == [1000,0] and arc[-1][2:4] == [-1000,0]
assert max(max(x[1],x[3]) for x in arc) == 1000
without_ids = GEOMETRY_FIXTURE.replace('(uuid pa)','').replace('(uuid pb)','')
a = scene_from_text(without_ids)
ids = [o["uuid"] for o in a["objects"] if o["kind"] == "pad"]
assert ids == ["fp/pad:1:1", "fp/pad:1:2"]
modern = GEOMETRY_FIXTURE.replace('(net 1 "GND")','(net "GND")').replace('(net 1)', '(net "GND")')
assert len([n for n in scene_from_text(modern)["nets"] if n["name"] == "GND"]) == 1
# KiCad 10 has no net table: a quoted numeric name is not a numbered reference.
numeric_name_board = '''(kicad_pcb (version 20260206)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (segment (start 0 0) (end 1 0) (width .25) (layer "F.Cu") (net "12") (uuid digits))
 (via (at 1 0) (size .8) (drill .4) (layers "F.Cu" "B.Cu") (net "GND") (uuid ground))
 (footprint "Test:X" (layer "F.Cu") (at 0 0) (uuid fp)
  (property "Reference" "J1")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "12") (uuid pad))))'''
numeric_scene = scene_from_text(numeric_name_board)
assert {n['name'] for n in numeric_scene['nets']} == {'', '12', 'GND'}, numeric_scene['nets']
assert numeric_scene['warnings'] == [], numeric_scene['warnings']
numeric_ids = {n['name']: n['id'] for n in numeric_scene['nets']}
numeric_objects = {o['uuid']: o for o in numeric_scene['objects']}
assert numeric_objects['digits']['net'] == numeric_objects['pad']['net'] == numeric_ids['12']
assert numeric_objects['ground']['net'] == numeric_ids['GND'] != numeric_ids['12']
with TemporaryDirectory() as d:
    p = Path(d) / 'nets.kicad_pcb'
    p.write_text(numeric_name_board)
    objects = pcb_objects(p)
    assert objects['digits']['props']['net'] == objects['fp']['props']['pad 1 net'] == '12'
    assert objects['ground']['props']['net'] == 'GND'
    # Old net tables resolve both bare and inline numbered references.
    old_board = numeric_name_board.replace('20260206', '20221018').replace(
        '(layers', '(net 12 "GND") (net 13 "12") (layers', 1).replace(
        '(net "12")', '(net 13)').replace('(net "GND")', '(net 12 "GND")')
    old_scene = scene_from_text(old_board)
    assert old_scene['nets'] == [{'id': 0, 'name': ''}, {'id': 12, 'name': 'GND'}, {'id': 13, 'name': '12'}]
    assert old_scene['warnings'] == []
    assert {o['uuid']: o['net'] for o in old_scene['objects'] if o['kind'] != 'footprint'} == {
        'digits': 13, 'ground': 12, 'pad': 13}
    p.write_text(old_board)
    assert pcb_objects(p) == objects
    # A modern name must not resolve through an unrelated old numeric table key.
    p.write_text(old_board.replace('(net 13)', '(net "12")'))
    assert pcb_objects(p) == objects
print('ok quoted numeric net names and older numbered references')
for bad in ("NaN", "Infinity", "3000000"):
    try:
        geometry_um(bad)
        raise AssertionError(bad)
    except ValueError:
        pass
print("ok board scene identity, units, pad transforms, nets and arcs")

# Empty and metadata-only boards stay complete; unsupported visible drawables fall back.
empty_scene = scene_from_text('(kicad_pcb (version 20260206) (general (thickness 1.6)))')
assert empty_scene['complete'] and empty_scene['bounds'] == [0, 0, 0, 0]
assert empty_scene['objects'] == [] and empty_scene['nets'] == [{'id': 0, 'name': ''}]
assert s['complete'] and s['warnings'] == []
assert by_id['tr']['box'] == [875, 1875, 3125, 2125]
assert by_id['vi']['box'] == [3600, 4600, 4400, 5400]
assert by_id['fp']['geometry'] == {} and by_id['fp']['box'] == [9500, 17000, 12500, 20500]
assert by_id['pa']['side'] == by_id['pb']['side'] == 'back'
unknown = scene_from_text(GEOMETRY_FIXTURE[:-1] + '(gr_curve (uuid curve) (layer "F.Cu")))')
assert not unknown['complete']
assert unknown['warnings'] == [{'uuid': 'curve', 'kind': 'gr_curve', 'reason': 'cubic requires four control points'}]
assert scene_from_text(GEOMETRY_FIXTURE[:-1] + '(gr_curve (uuid curve) hide))')['complete']

# Copper ordering comes from canonical names, not numeric enums or layer declaration order.
span_fixture = '''(kicad_pcb
 (layers (0 "F.Cu" signal hide) (2 "B.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal)
 (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user))
 (via (at 0 0) (size 1) (drill .4) (layers "F.Cu" "B.Cu") (uuid through))
 (via blind (at 2 0) (size 1) (drill .4) (layers "In1.Cu" "B.Cu") (uuid blind))
 (footprint "Test" (uuid parent) (layer "F.Cu") (at 0 0)
  (fp_text reference "R9" (hide yes))
  (pad "1" smd rect (uuid margin) (at 0 0) (size 2 1)
   (layers "F.Cu" "F.Mask" "F.Paste") (solder_mask_margin .1)
   (solder_paste_margin -.05) (solder_paste_margin_ratio -.1))
  (pad "2" np_thru_hole circle (uuid hole) (at 4 0) (size 1 1) (drill .8) (layers "*.Cu" "*.Mask"))))'''
span = scene_from_text(span_fixture)
span_ids = {o['uuid']: o for o in span['objects']}
assert span_ids['through']['layers'] == ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
assert span_ids['blind']['layers'] == ['In1.Cu', 'In2.Cu', 'B.Cu']
assert all(layer['enabled'] for layer in span['layers'])
assert span_ids['hole']['layers'] == ['F.Mask', 'B.Mask']
assert not span_ids['hole']['geometry']['drill']['plated']
assert span_ids['margin']['ref'] == 'R9'
assert span_ids['margin']['geometry']['layerPrimitives']['F.Mask']['size'] == [2200, 1200]
assert span_ids['margin']['geometry']['layerPrimitives']['F.Paste']['size'] == [1500, 700]

# Numeric unknown nets stay numeric; mixed modern names receive deterministic IDs.
mixed = scene_from_text(GEOMETRY_FIXTURE.replace('(net 1 "GND")', '(net 1 "GND") (net "Z") (net "A")', 1).replace('(net 1) (uuid tr)', '(net 8) (uuid tr)'))
assert mixed['nets'] == [{'id': 0, 'name': ''}, {'id': 1, 'name': 'GND'}, {'id': 8, 'name': 'Net 8'}, {'id': 9, 'name': 'A'}, {'id': 10, 'name': 'Z'}]
assert next(o for o in mixed['objects'] if o['uuid'] == 'tr')['net'] == 8
assert mixed['complete'] and mixed['warnings'][0]['kind'] == 'net'
zone_named = scene_from_text('(kicad_pcb (zone (uuid z) (net 7) (net_name "Earth")))')
assert zone_named['nets'] == [{'id': 0, 'name': ''}, {'id': 7, 'name': 'Earth'}]

# Drill offsets rotate once with the world pad angle. Board setup is the last margin fallback.
offset = scene_from_text(GEOMETRY_FIXTURE.replace('(drill oval .8 .4)', '(drill oval .8 .4 (offset .2 .1))'))
assert next(o for o in offset['objects'] if o['uuid'] == 'pa')['geometry']['drill']['center'] == [10100, 17800]
setup_margin = scene_from_text(span_fixture.replace('(via (at 0 0)', '(setup (pad_to_mask_clearance .3)) (via (at 0 0)').replace('(solder_mask_margin .1)', ''))
assert next(o for o in setup_margin['objects'] if o['uuid'] == 'margin')['geometry']['layerPrimitives']['F.Mask']['size'] == [2600, 1600]
print('ok board scene bounds, copper spans, NPTH, margins and mixed net syntax')

# Custom pads retain their anchor and transformed primitives, never a replacement rectangle.
custom_fixture = '''(kicad_pcb (layers (0 "F.Cu" signal))
 (footprint "Custom" (layer "F.Cu") (uuid custom-fp) (at 10 20 90)
  (property "Reference" "J2")
  (pad "1" smd custom (uuid custom) (at 2 0 90) (size .2 .2) (layers "F.Cu")
   (options (anchor circle))
   (primitives
    (gr_line (start 0 0) (end 1 0) (width .2))
    (gr_poly (pts (xy 0 0) (xy 1 0) (xy 0 1)) (width .1) (fill yes))))))'''
custom_scene = scene_from_text(custom_fixture)
custom_pad = next(o for o in custom_scene['objects'] if o['uuid'] == 'custom')
assert custom_scene['complete']
assert custom_pad['geometry']['primitive']['shape'] == 'circle'
assert custom_pad['geometry']['segments'][0] == [10000, 18000, 10000, 17000, 200]
assert custom_pad['geometry']['rings'] == [[[10000, 18000], [10000, 17000], [11000, 18000]]]
assert custom_pad['box'] == [9900, 16900, 11050, 18100]
unsupported_custom = scene_from_text(custom_fixture.replace('(gr_line (start 0 0) (end 1 0) (width .2))', '(gr_curve (width .2))'))
assert not unsupported_custom['complete']
assert unsupported_custom['warnings'][0] == {'uuid': 'custom', 'kind': 'pad', 'reason': 'unsupported custom primitive gr_curve'}

# Ordinary pad shapes, tented masks, footprint overrides and hidden parent inheritance.
for shape in ('circle', 'rect', 'oval', 'roundrect', 'trapezoid'):
    pad_scene = scene_from_text(span_fixture.replace('smd rect', 'smd ' + shape))
    assert next(o for o in pad_scene['objects'] if o['uuid'] == 'margin')['geometry']['primitive']['shape'] == shape
trapezoid = scene_from_text(span_fixture.replace('smd rect', 'smd trapezoid').replace('(uuid margin)', '(uuid margin) (rect_delta .2 .4)'))
assert next(o for o in trapezoid['objects'] if o['uuid'] == 'margin')['geometry']['primitive']['delta'] == [200, 400]
tented = scene_from_text(span_fixture.replace('(uuid hole)', '(uuid hole) (tenting (front yes) (back no))'))
assert next(o for o in tented['objects'] if o['uuid'] == 'hole')['layers'] == ['B.Mask']
fp_margin = scene_from_text(span_fixture.replace('(uuid parent)', '(uuid parent) (solder_mask_margin .4)').replace('(solder_mask_margin .1)', ''))
assert next(o for o in fp_margin['objects'] if o['uuid'] == 'margin')['geometry']['layerPrimitives']['F.Mask']['size'] == [2800, 1800]
hidden_parent = scene_from_text(GEOMETRY_FIXTURE.replace('(uuid fp)', '(uuid fp) (hide yes)'))
assert all(o['hidden'] for o in hidden_parent['objects'] if o['changeUuid'] == 'fp')
assert hidden_parent['bounds'] == [875, 1875, 4400, 5400]
conditional = scene_from_text(span_fixture.replace('(uuid margin)', '(uuid margin) (remove_unused_layers) (keep_end_layers)'))
assert not conditional['complete'] and 'requires connectivity' in conditional['warnings'][0]['reason']

# Numerical guards apply to parsed geometry too, including reflected and rotated pad positions.
from kicad_review import geometry_point, pcb_objects
assert geometry_point(('-0.0005', '0.0005')) == [-1, 1]
assert geometry_point(('0.0005', '0.0005'), ('0', '0', '90')) == [1, -1]
assert geometry_arc((0, 0), (1, 0), (2, 0), '.1') == [[0, 0, 2000, 0, 100]]
assert geometry_arc((1, 0), (0, -1), (-1, 0), '.2')[0][3] < 0
for bad in ('NaN', 'Infinity', '3000000', '-.25'):
    try:
        scene_from_text(GEOMETRY_FIXTURE.replace('(width .25)', '(width ' + bad + ')'))
        raise AssertionError('invalid track width accepted: ' + bad)
    except ValueError:
        pass
try:
    geometry_arc((2000000, 0), (-2000000, 0), (0, -2000000), '.1')
    raise AssertionError('arc budget not enforced')
except ValueError as error:
    assert 'budget' in str(error)
with TemporaryDirectory() as d:
    board = Path(d) / 'identity.kicad_pcb'
    board.write_text(GEOMETRY_FIXTURE)
    semantic_before = pcb_objects(board)
    identity_scene = board_geometry(board)
    assert pcb_objects(board) == semantic_before
    assert all(o['changeUuid'] in semantic_before for o in identity_scene['objects'])
print('ok board custom pads, shape variants, visibility, margins, numeric guards and semantic identity')

# Unsupported conditional/offset geometry is explicit SVG fallback, never guessed copper.
hidden_text = scene_from_text(GEOMETRY_FIXTURE.replace('(property "Reference" "J1")', '(property "Reference" "J1" (effects (hide yes)))'))
assert hidden_text['complete']
hidden_custom = scene_from_text(custom_fixture.replace('(uuid custom-fp)', '(uuid custom-fp) (hide yes)').replace('(gr_line (start 0 0) (end 1 0) (width .2))', '(gr_curve (width .2))'))
assert hidden_custom['complete'] and hidden_custom['bounds'] == [0, 0, 0, 0]
custom_mask = scene_from_text(custom_fixture.replace('(0 "F.Cu" signal)', '(0 "F.Cu" signal) (1 "F.Mask" user)').replace('(layers "F.Cu")', '(layers "F.Cu" "F.Mask") (solder_mask_margin .1)'))
assert not custom_mask['complete'] and 'offset not yet supported' in custom_mask['warnings'][0]['reason']
try:
    scene_from_text(GEOMETRY_FIXTURE.replace('(start 1 2)', '(start 2000000 2)'))
    raise AssertionError('out-of-range stroked bbox accepted')
except ValueError:
    pass
print('ok board fallback warnings, hidden effects and stroked extent limits')

assert scene_from_text(GEOMETRY_FIXTURE.replace('(uuid fp)', '(uuid fp) (fp_metadata "opaque")'))["complete"]

# Stored zone paths retain slit bridges, holes and independent islands verbatim.
DRAW_FIXTURE = GEOMETRY_FIXTURE.replace('(44 "Edge.Cuts" user)', '(44 "Edge.Cuts" user) (37 "F.SilkS" user) (36 "B.SilkS" user) (40 "Dwgs.User" user)')
EXTRA = '''
(zone (net 1) (layer "F.Cu") (uuid zone)
 (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
 (filled_polygon (layer "F.Cu")
  (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10) (xy 0 0)
       (xy 2 2) (xy 2 8) (xy 8 8) (xy 8 2) (xy 2 2) (xy 0 0)))
 (filled_polygon (layer "F.Cu") (pts (xy 20 0) (xy 21 0) (xy 21 1)))
 (filled_polygon (layer "B.Cu") (pts (xy 30 0) (xy 31 0) (xy 31 1))))
(gr_line (start -1 -1) (end 11 -1) (stroke (width .05) (type default))
 (layer "Edge.Cuts") (uuid edge))
(gr_text "<& Board" (at 5 6 30) (layer "F.SilkS") (uuid text) unlocked
 (effects (font (size 1 2) (thickness .15) bold italic) (justify left top mirror)))
'''
ss = scene_from_text(DRAW_FIXTURE[:-1] + EXTRA + ')')
u = {o['uuid']: o for o in ss['objects']}
zones = [o for o in ss['objects'] if o['changeUuid'] == 'zone']
assert ss['complete'], ss['warnings']
assert len(zones) == 3 and len({o['uuid'] for o in zones}) == 3
assert [o['layers'] for o in zones] == [['F.Cu'], ['F.Cu'], ['B.Cu']]
assert zones[0]['geometry']['rings'][0] == [[0,0],[10000,0],[10000,10000],[0,10000],[0,0],[2000,2000],[2000,8000],[8000,8000],[8000,2000],[2000,2000],[0,0]]
assert zones[1]['geometry']['rings'] == [[[20000,0],[21000,0],[21000,1000]]]
assert u['edge']['geometry']['segments'] == [[-1000,-1000,11000,-1000,50]]
t = u['text']['geometry']['text']
assert t == {'value': '<& Board', 'at': [5000,6000], 'size': [2000,1000], 'angle': 30000,
             'thickness': 150, 'justify': ['left','top'], 'mirror': True, 'italic': True, 'bold': True, 'unlocked': True}
assert u['text']['box'] is not None
unfilled = EXTRA[:EXTRA.index('(gr_line')].replace('filled_polygon', 'not_a_fill')
zz = scene_from_text(DRAW_FIXTURE[:-1] + unfilled + ')')
zo = next(o for o in zz['objects'] if o['changeUuid'] == 'zone')
assert zz['complete'] and zo['geometry']['rings'] == [] and len(zo['geometry']['segments']) == 4
assert any('no stored fill; showing outline' in w['reason'] for w in zz['warnings'])
keepout = scene_from_text(DRAW_FIXTURE[:-1] + EXTRA[:EXTRA.index('(gr_line')].replace('(uuid zone)', '(uuid zone) (keepout (tracks not_allowed))') + ')')
assert keepout['complete'] and all(o['geometry']['rings'] == [] for o in keepout['objects'] if o['changeUuid'] == 'zone')
print('ok board stored zone topology, islands, layers, keepouts and unfilled outlines')

SHAPES = '''
(gr_rect (start 0 0) (end 2 1) (stroke (width .1)) (fill none) (layer "F.SilkS") (uuid rect))
(gr_rect (start 3 0) (end 5 1) (width .2) (fill solid) (layer "F.SilkS") (uuid solid))
(gr_circle (center 0 0) (end 1 0) (stroke (width .1)) (fill solid) (layer "F.SilkS") (uuid circle))
(gr_arc (start 1 0) (mid 0 1) (end -1 0) (width .1) (layer "F.SilkS") (uuid arc-shape))
(gr_poly (pts (xy 0 0) (xy 2 0) (xy 1 1)) (width .1) (fill none) (layer "F.SilkS") (uuid poly))
(gr_curve (pts (xy 0 0) (xy 0 2) (xy 2 2) (xy 2 0)) (stroke (width .1)) (layer "F.SilkS") (uuid curve-ok))
'''
shape_scene = scene_from_text(DRAW_FIXTURE[:-1] + SHAPES + ')')
assert shape_scene['complete'], shape_scene['warnings']
shapes = {o['uuid']: o for o in shape_scene['objects']}
assert len(shapes['rect']['geometry']['segments']) == 4 and shapes['rect']['geometry']['rings'] == []
assert shapes['solid']['geometry']['rings'] == [[[3000,0],[5000,0],[5000,1000],[3000,1000]]]
assert len(shapes['circle']['geometry']['segments']) > 32 and len(shapes['circle']['geometry']['rings']) == 1
assert shapes['arc-shape']['geometry']['segments'][0][:2] == [1000,0]
assert len(shapes['poly']['geometry']['segments']) == 3 and shapes['poly']['geometry']['rings'] == []
curve = shapes['curve-ok']['geometry']['segments']
assert len(curve) > 16 and curve[0][:2] == [0,0] and curve[-1][2:4] == [2000,0]
assert all(a[2:4] == b[:2] for a,b in zip(curve,curve[1:]))
# Collinear controls beyond the chord must subdivide, not collapse a retracing curve.
retraced = scene_from_text(DRAW_FIXTURE[:-1] + SHAPES[SHAPES.index('(gr_curve'):].replace('(xy 0 2) (xy 2 2)', '(xy 5 0) (xy -3 0)') + ')')
assert len(next(o for o in retraced['objects'] if o['uuid'] == 'curve-ok')['geometry']['segments']) > 1
print('ok board graphics shapes, fills, circle/arc and bounded cubic flattening')

FP_DRAW = '''
 (fp_line (start 1 0) (end 2 0) (stroke (width .1)) (layer "B.SilkS") (uuid fp-line))
 (fp_text user "${REFERENCE}/${VALUE}" (at 1 0 90) (layer "B.SilkS") (uuid fp-label)
  (effects (font (size 1 1)) (justify right bottom mirror)))
 (property "Value" "Connector" (at 0 1 90) (layer "B.SilkS") (uuid value-label) (effects (font (size 1 1))))
 (property "Reference" "J1" (at 0 0 90) (layer "B.SilkS") hide (uuid hidden-property) (effects (font (size 1 1))))
'''
fp_scene = scene_from_text(DRAW_FIXTURE.replace('(uuid fp)', '(uuid fp)' + FP_DRAW))
fpo = {o['uuid']: o for o in fp_scene['objects']}
assert fp_scene['complete'], fp_scene['warnings']
assert fpo['fp-line']['geometry']['segments'] == [[10000,19000,10000,18000,100]]
assert fpo['fp-label']['geometry']['text']['at'] == [10000,19000]
assert fpo['fp-label']['geometry']['text']['angle'] == 90000  # already board-frame, not doubled
assert fpo['fp-label']['geometry']['text']['value'] == 'J1/Connector'
assert fpo['fp-label']['changeUuid'] == 'fp' and fpo['fp-label']['side'] == 'back'
assert fpo['hidden-property']['hidden']
for hide in ('hide', '(hide yes)', '(effects (hide yes))'):
    hidden_scene = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "SECRET" (at 0 0) (layer "F.SilkS") ' + hide + ' (uuid hidden) (effects (font (size 1 1))))' + ')')
    assert hidden_scene['complete'] and next(o for o in hidden_scene['objects'] if o['uuid'] == 'hidden')['hidden']
for unsupported in ('dimension', 'table', 'gr_text_box', 'image'):
    ss = scene_from_text(DRAW_FIXTURE[:-1] + '(' + unsupported + ' (layer "Dwgs.User") (uuid unsupported))' + ')')
    assert not ss['complete'] and any(w['kind'] == unsupported for w in ss['warnings'])
for label in ('${UNKNOWN}', '~{rich}', '^{rich}'):
    ss = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "' + label + '" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1))))' + ')')
    assert not ss['complete'], label
font_scene = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "Label" (at 0 0) (layer "F.SilkS") (effects (font (face "Embedded") (size 1 1))))' + ')')
assert not font_scene['complete'] and any('font' in w['reason'] for w in font_scene['warnings'])
print('ok board text metadata, hidden properties, footprint transforms and explicit SVG fallbacks')

# Guard pathological flattening and new/legacy text flags without silent geometry loss.
for huge_shape in (
    '(gr_circle (center 0 0) (end 2000000 0) (width .1) (layer "F.Cu") (uuid huge))',
    '(gr_curve (pts (xy -2000000 -2000000) (xy -2000000 2000000) (xy 2000000 -2000000) (xy 2000000 2000000)) (layer "F.Cu") (uuid huge))',
):
    huge_scene = scene_from_text(DRAW_FIXTURE[:-1] + huge_shape + ')')
    assert not huge_scene['complete'] and any('budget' in w['reason'] for w in huge_scene['warnings'])
    assert next(o for o in huge_scene['objects'] if o['uuid'] == 'huge')['geometry'] == {}
# Numeric error bound against a sampled cubic before integer rounding.
from kicad_review import geometry_cubic
import math
flattened = geometry_cubic([[0,0], [0,2], [2,2], [2,0]])
for i in range(1001):
    t = i / 1000
    p = [6*t*t - 4*t*t*t, 6*t*(1-t)]
    def chord_distance(a, b):
        dx, dy = b[0]-a[0], b[1]-a[1]
        u = max(0, min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)))
        return math.hypot(p[0]-a[0]-u*dx, p[1]-a[1]-u*dy)
    assert min(chord_distance(a,b) for a,b in zip(flattened,flattened[1:])) <= .001
flags = scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "Flags" (at 1 2 45 unlocked) (layer "F.SilkS") (uuid flags) (effects (font (size 1 2) (bold yes) (italic no))))' + ')')
flag_text = next(o for o in flags['objects'] if o['uuid'] == 'flags')['geometry']['text']
assert flag_text['size'] == [2000,1000] and flag_text['unlocked'] and flag_text['bold'] and not flag_text['italic']
for unsupported_text in ('(layer "F.SilkS" knockout) (effects (font (size 1 1)))', '(layer "F.SilkS") (effects (font (size 1 1) (line_spacing 2)))'):
    assert not scene_from_text(DRAW_FIXTURE[:-1] + '(gr_text "Special" (at 0 0) ' + unsupported_text + '))')['complete']
for shape in ('gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly', 'gr_curve'):
    # Board and footprint use exactly the same shape kernel and transform once.
    from kicad_review import geometry_shape, parse_sexpr, geometry_point
    node = next(n for n in parse_sexpr('(kicad_pcb ' + SHAPES + ')')[1:] if n[0] == shape) if shape != 'gr_line' else parse_sexpr('(gr_line (start 1 0) (end 2 0) (width .1))')
    local_shape = geometry_shape(node)
    node[0] = shape.replace('gr_', 'fp_')
    world_shape = geometry_shape(node, [10,20,90])
    for a,b in zip(local_shape['segments'], world_shape['segments']):
        expected = [*geometry_point([a[0]/1000,a[1]/1000], [10,20,90]), *geometry_point([a[2]/1000,a[3]/1000], [10,20,90]), a[4]]
        # Cubics transform unrounded points, so a half-um tie can differ from
        # transforming an already rounded local coordinate by one um.
        assert all(abs(x-y) <= (1 if shape == 'gr_curve' else 0) for x,y in zip(b,expected))
print('ok board flattening budgets, cubic error bound, graphic transforms and text flag variants')

# Force the depth guard deterministically; it must choose SVG, not a truncated path.
from unittest.mock import patch
with patch('kicad_review.math.hypot', return_value=1):
    limited = scene_from_text(DRAW_FIXTURE[:-1] + SHAPES[SHAPES.index('(gr_curve'):] + ')')
assert not limited['complete'] and any('depth limit' in w['reason'] for w in limited['warnings'])
assert next(o for o in limited['objects'] if o['uuid'] == 'curve-ok')['geometry'] == {}
concave = scene_from_text(DRAW_FIXTURE[:-1] + '(zone (uuid concave) (layer "F.Cu") (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 4 0) (xy 4 1) (xy 1 1) (xy 1 4) (xy 0 4))))' + ')')
assert concave['complete'] and next(o for o in concave['objects'] if o['changeUuid'] == 'concave')['geometry']['rings'] == [[[0,0],[4000,0],[4000,1000],[1000,1000],[1000,4000],[0,4000]]]
# New child IDs without file UUIDs are deterministic and never alias another child.
no_ids = scene_from_text(DRAW_FIXTURE.replace('(uuid fp)', '(uuid fp)' + FP_DRAW.replace('(uuid fp-line)', '').replace('(uuid fp-label)', '').replace('(uuid value-label)', '').replace('(uuid hidden-property)', '')))
assert len({o['uuid'] for o in no_ids['objects']}) == len(no_ids['objects'])
assert {o['uuid'] for o in no_ids['objects']} >= {'fp/fp_line:1', 'fp/fp_text:1', 'fp/property:1', 'fp/property:2'}
print('ok board cubic depth fallback, concave fill paths and stable drawable child IDs')

# Board scenes are embedded as deduplicated gzip blobs; absence or corruption never breaks the report.
import gzip, base64, contextlib
from kicad_review import add_blob
gblobs = {}
graw = json.dumps(s, separators=(',', ':'), sort_keys=True)
gkey = add_blob(gblobs, graw)
assert add_blob(gblobs, graw) == gkey and len(gblobs) == 1
assert json.loads(gzip.decompress(base64.b64decode(gblobs[gkey]))) == s
gpage = inline_page('window.REVIEW_DATA = {"projects":[],"blobs":{}};')
for asset in ('kicad-colors.js', 'board-gl.js', 'board-diff.js'):
    assert f'src="{asset}"' not in gpage
assert 'KicadColors' in gpage and 'BoardGL' in gpage
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        for side in ("base", "head"):
            write(t, {f"review/G/{side}/erc.json": '{"sheets": []}'})
        pr = {"dir": "G", "name": "G", "status": "modified"}
        patch("kicad_review.project_checks", return_value=[]).start()
        gb = {}
        assert "geometry" not in kr.build_project(pr, gb, kr.DEFAULT_SETTINGS)["board"] and not gb
        write(t, {"base/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        gb = {}
        geo = kr.build_project(pr, gb, kr.DEFAULT_SETTINGS)["board"]["geometry"]
        assert geo["head"] is None and json.loads(gzip.decompress(base64.b64decode(gb[geo["base"]])))["version"] == 1
        write(t, {"head/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        os.remove("base/G/G.kicad_pcb")
        geo = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]["geometry"]
        assert geo["base"] is None and geo["head"]
        write(t, {"head/G/G.kicad_pcb": "(kicad_pcb (layers (x y z)))"})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            bad = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]
        assert "geometry" not in bad and "geometry unavailable" in err.getvalue()
        assert bad["inspect"] == {"base": None, "head": None}
        # Unchanged boards retain both revisions, parsing identical geometry once.
        write(t, {"base/G/G.kicad_pcb": GEOMETRY_FIXTURE, "head/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        same = {}
        with patch("kicad_review.board_geometry", wraps=kr.board_geometry) as parse:
            board = kr.build_project(pr, same, kr.DEFAULT_SETTINGS)["board"]
        assert board["geometry"]["base"] == board["geometry"]["head"] and board["geometry"]["base"]
        assert parse.call_count == 1
        assert board["inspect"]["base"] == board["inspect"]["head"] and board["inspect"]["base"]
        assert pathlib.Path("review/G/base/board-inspect.json").read_bytes() == pathlib.Path("review/G/head/board-inspect.json").read_bytes()
        assert board["status"] == "unchanged"
        # Inspection is optional: its failure must not discard a working GL scene.
        retained = {}
        err = io.StringIO()
        with patch.object(kr, 'board_inspect', side_effect=ValueError('bad inspection')), contextlib.redirect_stderr(err):
            partial = kr.build_project(pr, retained, kr.DEFAULT_SETTINGS)['board']
        assert partial['geometry']['base'] == partial['geometry']['head']
        assert partial['geometry']['base'] in retained
        assert partial['inspect'] == {'base': None, 'head': None}
        assert 'inspection unavailable' in err.getvalue() and 'geometry unavailable' not in err.getvalue()
        os.remove("base/G/G.kicad_pcb")
        err = io.StringIO()
        with patch("kicad_review.board_geometry", side_effect=KeyError("unexpected")), contextlib.redirect_stderr(err):
            odd = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]
        assert "geometry" not in odd and "geometry unavailable" in err.getvalue()
        assert odd["inspect"] == {"base": None, "head": None}
    finally:
        patch.stopall()
        os.chdir(old_cwd)
print('ok board scene blobs, added/removed/no/corrupt geometry')

# Production geometry carries typed, revision-aware change identity, not reference guesses.
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        base = GEOMETRY_FIXTURE.replace('(via ', '(footprint "Test:X" (layer "F.Cu") (at 30 30) (uuid other) (property "Reference" "J1")) (via ')
        head = base.replace('(at 10 20 90)', '(at 11 20 90)').replace('(width .25)', '(width .5)')
        head = head.replace('(kicad_pcb ', '(kicad_pcb (setup (pad_to_mask_clearance .1)) ')
        write(t, {"base/G/G.kicad_pcb": base, "head/G/G.kicad_pcb": head})
        blobs = {}
        with patch("kicad_review.project_checks", return_value=[]):
            report = kr.build_project({"dir": "G", "name": "G", "status": "modified"}, blobs, kr.DEFAULT_SETTINGS)
        changes = {r["uuid"]: r for r in report["changes"]}
        assert set(changes) == {"fp", "tr", "meta:setup"}
        for side in ("base", "head"):
            scene = json.loads(gzip.decompress(base64.b64decode(blobs[report["board"]["geometry"][side]])))
            for o in scene["objects"]:
                expected = [changes[o["changeUuid"]]["id"]] if o["changeUuid"] in changes else []
                assert o["changeIds"] == expected, (side, o)
        # Reference-paired regenerated footprint UUIDs must link both revisions explicitly.
        write(t, {"head/G/G.kicad_pcb": head.replace('(uuid fp)', '(uuid new-fp)')})
        with patch("kicad_review.project_checks", return_value=[]):
            second = kr.build_project({"dir": "G", "name": "G", "status": "modified"}, blobs, kr.DEFAULT_SETTINGS, change_offset=len(report["changes"]))
        moved = next(r for r in second["changes"] if r["kind"] == "footprint")
        assert moved["uuid"] == "new-fp" and moved["uuid_before"] == "fp"
        kr.assign_ids([report, second])
        for side in ("base", "head"):
            scene = json.loads(gzip.decompress(base64.b64decode(blobs[second["board"]["geometry"][side]])))
            assert all(o["changeIds"] == [moved["id"]] for o in scene["objects"] if o["changeUuid"] in ("fp", "new-fp"))
            assert all(o["changeIds"] == [] for o in scene["objects"] if o["changeUuid"] in ("vi", "other"))
    finally:
        os.chdir(old_cwd)
print("ok production geometry typed change IDs, unchanged isolation and multi-project IDs")

# SCH6: schematic rendering and styles ship inside the offline report.
page = kr.inline_page('window.REVIEW_DATA={"version":1};')
assert '--sch-paper:#f5f4ef' in page
assert 'function schematicPaints(' in page
assert 'function schematicGridPlan(' in page
assert not re.search(r'<script[^>]+src=["\'](?!data:)', page)
assert not re.search(r'<link[^>]+href=["\'](?:https?:|tokens\.css|review\.css)', page)
print('ok SCH6 offline schematic assets')

# vf-order: physical stack survives scrambled KiCad 10 file IDs and dielectrics.
for count in (4, 6):
    fixture = Path(__file__).parent / "ui" / "fixtures" / f"vf-order-{count}.kicad_pcb"
    text = fixture.read_text()
    expected = ["F.Cu", *[f"In{i}.Cu" for i in range(1, count - 1)], "B.Cu"]
    scene = kr.board_geometry(fixture)
    assert scene["complete"] and scene["copperStack"] == expected, scene
    assert [l["name"] for l in scene["layers"]] == expected[::-1]
    assert len(scene["objects"]) == count
    # Explicit stackup, not file order or enum values, is authoritative.
    swapped = text.replace('(layer "In1.Cu" (type', '(layer "TEMP" (type').replace(
        '(layer "In2.Cu" (type', '(layer "In1.Cu" (type').replace('(layer "TEMP" (type', '(layer "In2.Cu" (type')
    explicit = expected.copy()
    explicit[1], explicit[2] = explicit[2], explicit[1]
    assert scene_from_text(swapped)["copperStack"] == explicit
    # Older boards omit setup; canonical layer names still define the stack.
    legacy = re.sub(r' \(setup \(stackup.*?\)\)\)\n', '', text, flags=re.S)
    assert "(setup" not in legacy
    assert scene_from_text(legacy)["copperStack"] == expected
print("ok vf-order 4/6-layer explicit stackup and legacy physical order")

# A schematic-only review still exports 3D once and retains every board layer.
with TemporaryDirectory() as t:
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        pr = {"dir": "G", "name": "G", "status": "modified"}
        svg = '<svg width="20mm" height="10mm" viewBox="0 0 20 10"><g/></svg>'
        for side in ("base", "head"):
            write(t, {f"{side}/G/G.kicad_pcb": GEOMETRY_FIXTURE,
                      f"review/G/{side}/pcb/G-F_Cu.svg": svg,
                      f"review/G/{side}/pcb/G-B_Cu.svg": svg})
        write(t, {"review/detect.json": json.dumps({"projects": [pr]}),
                  "base/kicad-review.toml": "[3d]\nenabled = true\n"})
        def fake_export(p, side, out, *, model=True):
            assert model
            write(t, {f"{out}/board.raw.glb": "timestamped model", f"{out}/board.glb": "timestamped model",
                      f"{out}/poster.png": "poster", f"{out}/glb.log": "", f"{out}/poster.log": "render log"})
        with patch("kicad_review.render_side"), patch("kicad_review.export_glb", side_effect=fake_export) as export:
            kr.cmd_render(None)
        assert export.call_count == 1, "identical 3D inputs export once even when board unchanged"
        assert pathlib.Path("review/G/base/board.glb").read_bytes() == pathlib.Path("review/G/head/board.glb").read_bytes()
        with patch("kicad_review.project_checks", return_value=[]):
            board = kr.build_project(pr, {}, kr.load_settings())["board"]
        assert not board["changed"] and board["status"] == "unchanged"
        assert len(board["layers"]) == 2 and board["size"] == [20.0, 10.0]
        assert all(l["svg"]["base"] == l["svg"]["head"] and l["svg"]["base"] for l in board["layers"])
        assert board["model3d"]["base"] == board["model3d"]["head"] and board["model3d"]["enabled"]
        # A local model edit with identical PCB bytes needs separate exports.
        write(t, {"base/G/body.step": "old model", "head/G/body.step": "new model"})
        with patch("kicad_review.render_side"), patch("kicad_review.export_glb", side_effect=fake_export) as export:
            kr.cmd_render(None)
        assert export.call_count == 2, "model-only edits must not share an export"
        for side in ("base", "head"):
            os.remove(f"review/G/{side}/board.glb")
            os.remove(f"review/G/{side}/glb.log")
        with patch("kicad_review.project_checks", return_value=[]):
            failed = kr.build_project(pr, {}, kr.load_settings())["board"]["model3d"]
            disabled = kr.build_project(pr, {}, kr.DEFAULT_SETTINGS)["board"]
        assert failed["enabled"] and failed["base"] is None and failed["head"] is None
        assert set(failed["errors"]) == {"base", "head"}
        assert "model3d" not in disabled
    finally:
        os.chdir(old_cwd)
print("ok unchanged board full SVG inventory, shared geometry and shared 3D")

# Revision render caches avoid all KiCad exports on a warm run and track settings/tool identity.
import shutil
with TemporaryDirectory() as t, patch.object(kr, 'IMAGE_RENDERER', 'verified-10.0.6'):
    old_cwd = os.getcwd()
    try:
        os.chdir(t)
        pr = {"dir": "G", "name": "G", "status": "unchanged"}
        write(t, {"review/detect.json": json.dumps({"base": "1"*40, "head": "2"*40, "projects": [pr]}),
                  "base/G/G.kicad_pcb": GEOMETRY_FIXTURE, "head/G/G.kicad_pcb": GEOMETRY_FIXTURE})
        def fake_render(src, name, out, **kw):
            write(t, {f"{out}/drc.json": '{"violations": []}'})
        with patch("kicad_review.render_side", side_effect=fake_render) as render:
            kr.cmd_render(None)
            assert render.call_count == 2
            shutil.rmtree("review/G")
            kr.restore_renders(None)
            assert pathlib.Path("review/G/base/drc.json").exists()
            kr.cmd_render(None)
            assert render.call_count == 2, "warm revision caches must skip all exports"
            det = json.loads(pathlib.Path('review/detect.json').read_text())
            cache = kr.render_cache(pr, 'head', det, kr.DEFAULT_SETTINGS)
            marker = cache / '.complete'
            assert json.loads(marker.read_text()) == kr.image_export_identity(pr, 'head')
            marker.write_text('{}')
            try:
                kr.restore_renders(None)
                raise AssertionError('restore accepted mismatched image metadata')
            except SystemExit as exc:
                assert exc.code == 1
            kr.cmd_render(None)
            assert render.call_count == 3, 'cmd_render reused mismatched image metadata'
            with patch.object(kr, 'IMAGE_RENDERER', 'local-unverified'):
                kr.cmd_render(None)
            assert render.call_count == 5, 'cmd_render reused an unverified local renderer'
        assert pathlib.Path("review/G/base/drc.json").exists() and pathlib.Path("review/G/head/drc.json").exists()
        # Library exports compare a pair of commits, unlike standalone board/sheet exports.
        lib_settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
        lib_settings["libraries"]["enabled"] = True
        with patch("kicad_review.load_settings", return_value=lib_settings):
            kr.cache_renders()
            try:
                kr.restore_renders(None)
                raise AssertionError("pair-dependent library exports must not be skipped")
            except SystemExit as exc:
                assert exc.code == 1
    finally:
        os.chdir(old_cwd)
print("ok per-commit project render cache hits retain both revisions")

assert '-e KICAD_IMAGE' in pathlib.Path('.github/workflows/review.yml').read_text(), "host and container cache identity must match"
assert 'restore-renders' in pathlib.Path('.github/workflows/review.yml').read_text(), "warm caches must not pull the KiCad image"

# BR02 Task 2: raw copper exports, shared posters and revision-scoped metadata.
def br02_export_contract():
    import pathlib, subprocess, tempfile
    from unittest.mock import patch
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as t:
        calls = []
        def cli(args, **kw):
            calls.append(args)
            flag = '-o' if '-o' in args else '--output'
            dest = pathlib.Path(args[args.index(flag) + 1])
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b'glTF' if 'glb' in args else br02_png(1568, 984))
            return subprocess.CompletedProcess(args, 0, 'export stdout\n', 'stderr\n')
        out = pathlib.Path(t, 'new/output')
        with patch.object(kr, 'board_path', return_value=__file__), patch.object(kr.subprocess, 'run', cli):
            kr.export_glb({'dir': 'P', 'name': 'P'}, 'base', str(out))
        assert '--include-tracks' in calls[0], 'BR02 copper export flags'
        assert calls[0] == ['kicad-cli', 'pcb', 'export', 'glb', '--include-tracks', '--include-pads',
                            '--include-zones', '--include-silkscreen', '--include-soldermask',
                            '--subst-models', '-f', '-o', str(out/'board.raw.glb'), __file__]
        assert (out/'board.raw.glb').read_bytes() == (out/'board.glb').read_bytes() == b'glTF'
        assert calls[1] == ['kicad-cli', 'pcb', 'render', '--quality', 'basic', '--perspective',
                            '--rotate', '-45,0,45', '-w', '1600', '-h', '1000', '-o', str(out/'poster.png'), __file__]
        import struct
        assert struct.unpack('>II', (out/'poster.png').read_bytes()[16:24]) == (1600, 1000), 'BR02 actual poster dimensions'
        assert (out/'glb.log').read_text() == (out/'poster.log').read_text() == 'export stdout\nstderr\n'
    print('ok BR02 raw copper export and exact poster argv')


def br02_poster_only_contract():
    import pathlib, subprocess, tempfile
    from unittest.mock import patch
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as t:
        calls = []
        def cli(args, **kw):
            calls.append(args)
            pathlib.Path(args[args.index('-o')+1]).write_bytes(br02_png(1568, 984))
            return subprocess.CompletedProcess(args, 0, '', '')
        with patch.object(kr.subprocess, 'run', cli):
            kr.export_glb({'dir': 'P', 'name': 'P'}, 'head', t, model=False)
        assert len(calls) == 1 and calls[0][1:3] == ['pcb', 'render'], 'BR02 design-only still'
        assert calls[0][calls[0].index('-w')+1] == '1600'
        assert calls[0][calls[0].index('-h')+1] == '1000'
        assert kr.poster_size(pathlib.Path(t, 'poster.png')) == (1600, 1000)
        assert not pathlib.Path(t, 'board.raw.glb').exists() and not pathlib.Path(t, 'board.glb').exists()
    print('ok BR02 design-only still')


def br02_metadata_contract():
    import os, pathlib, tempfile
    from unittest.mock import patch
    import kicad_review as kr
    def footprint(uid, ref, layer='F.Cu', x=10, model='body.step'):
        return (f'(footprint "Package:R" (uuid "{uid}") (layer "{layer}") (at {x} 20 90) '
                f'(property "Reference" "{ref}") (pad "1" smd rect (at 1 0) (size 2 1)) '
                + (f'(model "{model}")' if model else '') + ')')
    old = os.getcwd()
    with tempfile.TemporaryDirectory() as t:
        try:
            os.chdir(t)
            for side in ('base', 'head'):
                pathlib.Path(side, 'P').mkdir(parents=True)
                pathlib.Path('review/P', side).mkdir(parents=True)
            base = [footprint('rename', 'R1'), footprint('deleted', 'J1', 'B.Cu'),
                    footprint('stable', 'U3'), footprint('old-id', 'R2'), footprint('no-model', 'U4', model=None)]
            head = [footprint('rename', 'R12', x=11), footprint('stable', 'U3'),
                    footprint('new-id', 'R2', x=12), footprint('no-model', 'U4', model=None), footprint('added', 'J2')]
            for side, parts in (('base', base), ('head', head)):
                pathlib.Path(side, 'P/P.kicad_pcb').write_text(
                    '(kicad_pcb (setup (stackup (copper_finish "' + ('ENIG' if side == 'base' else 'ENEPIG') + '")))'
                    + ''.join(parts) + ')')
            pathlib.Path('review/P/head/glb.log').write_text('Could not add 3D model for U3.\n')
            # Render warnings must not turn a valid GLB part into a placeholder.
            pathlib.Path('review/P/base/poster.log').write_text('Could not add 3D model for R1.\n')
            kr.prepare3d({'dir': 'P', 'name': 'P'})
            import json
            data = {s: json.loads(pathlib.Path('review/P', s, 'board-3d-input.json').read_text()) for s in ('base', 'head')}
            # One kept set per comparison, shared by both revisions (kept_refs over base and head).
            assert data['base']['keep'] == ['J1', 'J2', 'R1', 'R12', 'R2'], data['base']
            assert data['head']['keep'] == ['J1', 'J2', 'R1', 'R12', 'R2'], data['head']
            assert data['base']['finish'] == 'ENIG' and data['head']['finish'] == 'ENEPIG'
            for side, d in data.items():
                assert set(d) == {'version', 'side', 'keep', 'finish', 'footprints', 'warnings', 'skippedRefs'}
                assert d['version'] == 1 and d['side'] == side and len(d['footprints']) == 5
                objs = kr.pcb_objects(f'{side}/P/P.kicad_pcb')
                for f in d['footprints']:
                    assert set(f) == {'uuid', 'ref', 'side', 'pos', 'box', 'hasModel', 'reason'}
                    assert f['pos'] == objs[f['uuid']]['pos'] and f['box'] == objs[f['uuid']]['box']
                    assert f['side'] == ('bottom' if f['ref'] == 'J1' else 'top')
                    assert f['hasModel'] == (f['reason'] is None)
            b = {f['ref']: f for f in data['base']['footprints']}
            h = {f['ref']: f for f in data['head']['footprints']}
            assert b['R1']['uuid'] == h['R12']['uuid'] == 'rename'
            assert h['U3']['reason'] == 'file not found' and b['U3']['hasModel']
            assert h['U4']['reason'] == b['U4']['reason'] == 'no model in footprint'
            before = pathlib.Path('review/P/head/board-3d-input.json').read_bytes()
            kr.prepare3d({'dir': 'P', 'name': 'P'})
            assert pathlib.Path('review/P/head/board-3d-input.json').read_bytes() == before
            # Added/removed boards and absent stackups still produce side-specific input.
            pathlib.Path('base/P/P.kicad_pcb').unlink()
            pathlib.Path('review/P/base/board-3d-input.json').unlink()
            pathlib.Path('head/P/P.kicad_pcb').write_text('(kicad_pcb' + footprint('added', 'J2') + ')')
            kr.prepare3d({'dir': 'P', 'name': 'P'})
            added = json.loads(pathlib.Path('review/P/head/board-3d-input.json').read_text())
            assert added['keep'] == ['J2'] and added['finish'] == ''
            assert not pathlib.Path('review/P/base/board-3d-input.json').exists()
        finally:
            os.chdir(old)
    print('ok BR02 revision metadata rename, deleted bottom, UUID fallback and model coverage')


br02_export_contract()
br02_poster_only_contract()
br02_metadata_contract()


def br02_export_failures():
    import pathlib, subprocess, tempfile
    from unittest.mock import patch
    import kicad_review as kr
    for failure in ('nonzero', 'empty', 'missing', 'oserror'):
        with tempfile.TemporaryDirectory() as t:
            out = pathlib.Path(t, 'nested/output')
            # Pre-existing successful artifacts must not mask a later failed attempt.
            out.mkdir(parents=True)
            for name in ('board.raw.glb', 'board.glb', 'poster.png'):
                (out/name).write_bytes(b'stale')
            calls = []
            def cli(args, **kw):
                calls.append(args)
                dest = pathlib.Path(args[args.index('-o')+1])
                assert dest.parent.is_dir() and not dest.exists()
                if failure == 'oserror':
                    raise FileNotFoundError('CLI unavailable')
                if failure != 'missing':
                    dest.write_bytes(b'partial' if failure == 'nonzero' else b'')
                return subprocess.CompletedProcess(args, 1 if failure == 'nonzero' else 0, None, 'diagnostic')
            with patch.object(kr.subprocess, 'run', cli):
                kr.export_glb({'dir': 'P', 'name': 'P'}, 'head', str(out))
            assert len(calls) == 2, 'BR02 failed GLB must not suppress poster attempt'
            assert all(not (out/n).exists() for n in ('board.raw.glb', 'board.glb', 'poster.png'))
            for name in ('glb.log', 'poster.log'):
                assert (out/name).read_text() == ('CLI unavailable' if failure == 'oserror' else 'diagnostic')
    # A failed still must not discard a valid raw/fallback model, and logs stay isolated.
    with tempfile.TemporaryDirectory() as t:
        out = pathlib.Path(t, 'created/by/exporter')
        def cli(args, **kw):
            assert out.is_dir(), 'BR02 exporter creates output directory'
            if 'glb' in args:
                pathlib.Path(args[args.index('-o')+1]).write_bytes(b'glTF')
                return subprocess.CompletedProcess(args, 0, 'Could not add 3D model for U3.\n', '')
            return subprocess.CompletedProcess(args, 1, '', 'Could not add 3D model for R1.\n')
        with patch.object(kr.subprocess, 'run', cli):
            kr.export_glb({'dir': 'P', 'name': 'P'}, 'base', str(out))
        assert (out/'board.raw.glb').read_bytes() == (out/'board.glb').read_bytes() == b'glTF'
        assert not (out/'poster.png').exists()
        assert 'U3' in (out/'glb.log').read_text() and 'R1' not in (out/'glb.log').read_text()
    print('ok BR02 failed, missing, empty and unavailable exports clean stale artifacts')


def br02_render_cache_contract():
    import copy, json, os, pathlib, subprocess, tempfile
    from unittest.mock import patch
    import kicad_review as kr
    old = os.getcwd()
    with tempfile.TemporaryDirectory() as t:
        try:
            os.chdir(t)
            pr = {'dir': 'P', 'name': 'P', 'status': 'modified'}
            det = {'base': 'a'*40, 'head': 'b'*40, 'projects': [pr]}
            pathlib.Path('review').mkdir()
            pathlib.Path('review/detect.json').write_text(json.dumps(det))
            for side in ('base', 'head'):
                pathlib.Path(side, 'P').mkdir(parents=True)
                pathlib.Path(side, 'P/P.kicad_pcb').write_text('(kicad_pcb)')
            settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
            settings['3d']['enabled'] = True
            calls = []
            def cli(args, **kw):
                calls.append(args)
                pathlib.Path(args[args.index('-o')+1]).write_bytes(b'glTF' if 'glb' in args else br02_png())
                return subprocess.CompletedProcess(args, 0, 'GLB log' if 'glb' in args else 'poster log', '')
            with patch.object(kr, 'load_settings', return_value=settings), patch.object(kr, 'render_side'), \
                 patch.object(kr, 'IMAGE_RENDERER', 'verified-10.0.6'), \
                 patch.object(kr, 'render_tool_identity', return_value='KiCad 10.0.0'), patch.object(kr.subprocess, 'run', cli):
                kr.cmd_render(None)
                assert len(calls) == 2, 'BR02 identical boards export GLB and poster once'
                for name in ('board.raw.glb', 'board.glb', 'poster.png', 'glb.log', 'poster.log'):
                    assert pathlib.Path('review/P/base', name).read_bytes() == pathlib.Path('review/P/head', name).read_bytes()
                base_cache = kr.render_cache(pr, 'base', det, settings)
                head_cache = kr.render_cache(pr, 'head', det, settings)
                kr.cmd_render(None)
                assert len(calls) == 2, 'BR02 complete caches need no exports'
                (head_cache/'poster.png').unlink()
                try:
                    kr.restore_renders()
                    raise AssertionError('BR02 requested missing poster must invalidate restore')
                except SystemExit as e:
                    assert e.code == 1
                kr.cmd_render(None)
                assert len(calls) == 2 and (head_cache/'poster.png').is_file(), 'BR02 repair poster by copying identical Base'
                (base_cache/'poster.png').write_bytes(br02_png(1568, 984))
                assert not kr.render_cache_complete(base_cache, pr, 'base', settings), 'undersized posters cannot be cache hits'
                (base_cache/'poster.png').write_bytes(b'')
                kr.cmd_render(None)
                assert len(calls) == 4, 'BR02 empty poster invalidates render cache'
                # A legacy processed-only cache must never be treated as a raw export.
                (base_cache/'board.raw.glb').unlink()
                assert not kr.render_cache_complete(base_cache, pr, 'base', settings), 'BR02 raw export required on cache hits'
                try:
                    kr.restore_renders()
                    raise AssertionError('BR02 legacy processed-only cache must invalidate restore')
                except SystemExit as e:
                    assert e.code == 1
                kr.cmd_render(None)
                assert len(calls) == 6 and (base_cache/'board.raw.glb').read_bytes() == b'glTF'
                (base_cache/'board.raw.glb').write_bytes(b'')
                assert not kr.render_cache_complete(base_cache, pr, 'base', settings), 'BR02 empty raw export is not a hit'
                (base_cache/'board.raw.glb').write_bytes(b'glTF')
                cache = kr.render_cache(pr, 'base', det, settings)
                same_revision = {**det, 'head': det['base']}
                assert cache == kr.render_cache(pr, 'head', same_revision, settings), 'BR02 revision caches are side independent'
                with patch.object(kr, 'render_tool_identity', return_value='KiCad 10.0.6'):
                    assert kr.render_cache(pr, 'base', det, settings) != cache
                with patch.object(kr, 'poster_argv', return_value=['changed render argv']):
                    assert kr.render_cache(pr, 'base', det, settings) != cache
                pathlib.Path('base/P/body.step').write_bytes(b'new model')
                assert kr.render_cache(pr, 'base', det, settings) != cache
                pathlib.Path('base/P/body.step').unlink()
                pathlib.Path('base/P/P.kicad_pcb').write_text('(kicad_pcb (version 20260101))')
                assert kr.render_cache(pr, 'base', det, settings) != cache
                pathlib.Path('base/P/P.kicad_pcb').write_text('(kicad_pcb)')
                settings['3d']['enabled'] = False
                assert kr.render_cache(pr, 'base', det, settings) != cache
                settings['design'] = {'enabled': True}
                calls.clear()
                kr.cmd_render(None)
                assert len(calls) == 1 and calls[0][1:3] == ['pcb', 'render'], 'BR02 cmd_render design-only shared still'
                # Different model inputs must prevent sharing even in design-only mode.
                pathlib.Path('head/P/body.step').write_bytes(b'model edit')
                calls.clear()
                kr.cmd_render(None)
                assert len(calls) == 1 and calls[0][1:3] == ['pcb', 'render'] and calls[0][-1].startswith('head/')
                # Gate changes invalidate identity, while disabled runs invoke neither producer.
                calls.clear()
                settings['design']['enabled'] = False
                kr.cmd_render(None)
                assert calls == []
            # Image pin identifies KiCad on host and container without running a CLI on the host.
            with patch.dict(kr.os.environ, {'KICAD_IMAGE': 'kicad/kicad:10.0.6-full@sha256:synthetic'}), \
                 patch.object(kr.subprocess, 'run') as run:
                assert kr.render_tool_identity() == 'kicad/kicad:10.0.6-full@sha256:synthetic'
                run.assert_not_called()
            with patch.dict(kr.os.environ, {'KICAD_IMAGE': ''}), \
                 patch.object(kr.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '10.0.0\n', '')) as run:
                assert kr.render_tool_identity() == '10.0.0'
                assert run.call_args.args[0] == ['kicad-cli', '--version']
        finally:
            os.chdir(old)
    print('ok BR02 shared five-file exports, design gate, poster cache validity and input/tool/argv identity')


br02_export_failures()
br02_render_cache_contract()


def br02_poster_dimensions():
    import pathlib, struct, subprocess, tempfile, zlib
    from unittest.mock import patch
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as t:
        dest = pathlib.Path(t, 'poster.png')
        # Every PNG filter must preserve RGB(A) pixels exactly, not just change IHDR.
        for channels in (3, 4):
            for filter_type in range(5):
                dest.write_bytes(br02_png(4, 2, channels=channels, filter_type=filter_type))
                kr.normalize_poster(dest)
                png = dest.read_bytes()
                assert struct.unpack('>II', png[16:24]) == (1600, 1000)
                data = bytearray()
                offset = 8
                while offset < len(png):
                    size = struct.unpack('>I', png[offset:offset+4])[0]
                    kind = png[offset+4:offset+8]
                    payload = png[offset+8:offset+8+size]
                    assert zlib.crc32(kind+payload) == struct.unpack('>I', png[offset+8+size:offset+12+size])[0]
                    if kind == b'IDAT':
                        data.extend(payload)
                    offset += 12+size
                raw = zlib.decompress(data)
                stride = 1+1600*4
                assert len(raw) == stride*1000
                pixel = bytes((31, 73, 119, 255))
                for y in range(1000):
                    row = raw[y*stride:(y+1)*stride]
                    expected = bytes(798*4)+pixel*4+bytes(798*4) if y in (499, 500) else bytes(1600*4)
                    assert row == b'\0'+expected, (channels, filter_type, y)
        # Already conforming stills are left byte-identical.
        exact = br02_png()
        dest.write_bytes(exact)
        with patch.object(kr.zlib, 'decompressobj', wraps=kr.zlib.decompressobj) as inflate:
            kr.normalize_poster(dest)
            assert inflate.call_count == 1, 'normal PNG validates IDAT without unfiltering'
        assert dest.read_bytes() == exact
        idat = exact.index(b'IDAT')
        size = struct.unpack('>I', exact[idat-4:idat])[0]
        payload = bytearray(exact[idat+4:idat+4+size]); payload[-1] ^= 1
        def idat_png(data):
            chunk = b'IDAT' + data
            return exact[:idat-4] + struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk)) + exact[idat+8+size:]
        for bad in (b'not PNG', br02_png()[:-10], br02_png(1601, 1),
                    idat_png(bytes(payload)), idat_png(zlib.compress(b'\0'))):
            def cli(args, **kw):
                pathlib.Path(args[args.index('-o')+1]).write_bytes(bad)
                return subprocess.CompletedProcess(args, 0, 'render stdout\n', '')
            with patch.object(kr.subprocess, 'run', cli):
                kr.export_glb({'dir': 'P', 'name': 'P'}, 'head', t, model=False)
            assert not dest.exists(), 'invalid or oversized still is not a successful product'
            assert 'Poster normalization failed' in pathlib.Path(t, 'poster.log').read_text()
    print('ok BR02 1600x1000 poster dimensions, all PNG filters, pixel preservation and invalid cleanup')


br02_poster_dimensions()


def br02_task2a_metadata_contract():
    base = {'stable': {'kind':'footprint','ref':'R1','has_model':True,
        'props':{'layer':'F.Cu','reference':'R1'},'pos':[5,5,0],'box':[4,4,6,6],'where':'board',
        'match':('footprint','R1')},
        'bottom': {'kind':'footprint','ref':'J1','has_model':True,
        'props':{'layer':'B.Cu'},'pos':[10,15,90],'box':[8,14,12,16],'where':'board',
        'match':('footprint','J1')}}
    head = {'stable': {**base['stable'],'ref':'R12','match':('footprint','R12'),
        'props':{'layer':'F.Cu','reference':'R12'}}}
    assert kicad_review.kept_refs(base,head) == ['J1','R1','R12'], 'BR02 renamed/deleted refs'
    m = kicad_review.metadata3d('base',base,['R1','R12','J1'],'ENIG',
        [{'ref':'J1','side':'base','reason':'file not found'}])
    bottom = next(f for f in m['footprints'] if f['ref']=='J1')
    assert bottom['uuid']=='bottom' and bottom['side']=='bottom'
    assert bottom['box']==[8,14,12,16] and not bottom['hasModel']
    assert bottom['reason']=='file not found', 'BR02 declared model is not coverage'
    assert m['version'] == 1 and m['side'] == 'base' and m['finish'] == 'ENIG'
    assert m['keep'] == ['J1', 'R1', 'R12']
    assert bottom['pos'] == [10,15,90]
    padless = {'logo': {'kind':'footprint','ref':'LOGO1','has_model':False,
        'props':{'layer':'F.Cu'},'pos':[7,8,0],'box':None}}
    logo = kicad_review.metadata3d('head',padless,[], '', [])['footprints'][0]
    assert logo['box']==[6,7,8,9] and not logo['hasModel'], 'BR02 padless estimate'
    duplicate = kicad_review.metadata3d('base',{**base,'duplicate':base['stable']},[], '', [])
    assert all(f['ref'] != 'R1' for f in duplicate['footprints'])
    assert len(duplicate['warnings']) == 2 and all('R1' in w for w in duplicate['warnings'])
    unannotated = kicad_review.metadata3d('head', {
        'logo1':{**padless['logo'], 'ref':'REF**'},
        'logo2':{**padless['logo'], 'ref':'REF**'},
        'valid':padless['logo']}, [], '', [])
    assert [f['ref'] for f in unannotated['footprints']] == ['LOGO1']
    assert len(unannotated['warnings']) == 2
    # Reference fallback with a changed UUID must keep the old and new identity.
    replaced = {'new-id': {**base['stable'], 'props': {'layer':'B.Cu'}}}
    assert kicad_review.kept_refs({'old-id':base['stable']}, replaced) == ['R1']
    assert kicad_review.kept_refs(base, base) == []
    for bad_box in (None, [1,2], [0,0,float('inf'),1], [0,0,float('nan'),1]):
        obj = {**padless['logo'], 'box':bad_box}
        with contextlib.redirect_stdout(io.StringIO()):
            assert kicad_review.metadata3d('head',{'logo':obj},[], '', [])['footprints'][0]['box'] == [6,7,8,9]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                kicad_review.metadata3d('head',{'logo':{**obj,'pos':[float('nan'),8]}},[], '', [])
            assert False, 'BR02 missing finite fallback position must fail metadata'
        except ValueError as error:
            assert 'finite position' in str(error)
    valid_box = [4, 4, 6, 6]
    for bad_pos in (None, [], [5], [float('nan'), 5], [5, float('nan')], [float('inf'), 5],
                    ['str', 5], [5, 'str'], [None, 5], [5, None], [True, 5], [5, False],
                    'not_a_seq', 123, [5, 5, 'str'], [5, 5, None], [5, 5, float('nan')]):
        try:
            kicad_review.metadata3d('head', {'r1': {'kind':'footprint', 'ref':'R1', 'has_model':True,
                                                    'props':{'layer':'F.Cu'}, 'box':valid_box, 'pos':bad_pos}},
                                    [], '', [])
            assert False, f'BR02 finite box with invalid pos {bad_pos} must fail metadata'
        except ValueError as error:
            assert 'finite position' in str(error)
    # Padless footprint (box is None) falls back to 2 mm estimate without emitting any warning
    with contextlib.redirect_stdout(io.StringIO()) as out:
        f = kicad_review.metadata3d('head', {'logo': padless['logo']}, [], '', [])['footprints'][0]
    assert f['box'] == [6, 7, 8, 9] and out.getvalue() == '', 'BR02 padless footprint produces no warning'
    # Malformed or non-numeric box falls back to finite pos estimate and emits warning
    for bad_box in (['a', 1, 2, 3], [1, 'b', 3, 4], [None, 1, 2, 3], 'bad_box', 42,
                    [1, 2], [0, 0, float('inf'), 1], [0, 0, float('nan'), 1]):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            f = kicad_review.metadata3d('head', {'r1': {'kind':'footprint', 'ref':'R1', 'has_model':True,
                                                        'props':{'layer':'F.Cu'}, 'box':bad_box, 'pos':[5, 5, 0]}},
                                        [], '', [])['footprints'][0]
        assert f['box'] == [4, 4, 6, 6], f'BR02 non-numeric box fallback: {f["box"]}'
        assert '::warning::R1: malformed bounding box' in out.getvalue(), f'BR02 warning emitted for bad box {bad_box}'
    both = [{'ref':'R1','side':'both','reason':'file not found'}]
    assert not kicad_review.metadata3d('head',base,[], '', both)['footprints'][1]['hasModel']
    print('ok BR02 metadata rename/delete, UUID fallback, bottom models, finite estimates and per-footprint skip warnings')


br02_task2a_metadata_contract()


def br02_task2a_prepare_contract():
    import contextlib, pathlib
    with tempfile.TemporaryDirectory() as t:
        old = os.getcwd()
        os.chdir(t)
        try:
            pathlib.Path('base/P').mkdir(parents=True)
            pcb = pathlib.Path('base/P/P.kicad_pcb')
            pcb.write_text('(kicad_pcb (setup (stackup (copper_finish "ENIG"))))')
            with patch.object(kicad_review.subprocess,'run',side_effect=OSError('missing binary')):
                kicad_review.export_glb({'dir':'P','name':'P'},'base','review/P/base')
            assert not pathlib.Path('review/P/base/poster.png').exists()
            assert 'missing binary' in pathlib.Path('review/P/base/poster.log').read_text()
            head_meta=pathlib.Path('review/P/head/board-3d-input.json')
            head_meta.parent.mkdir(parents=True,exist_ok=True)
            head_meta.write_text('{"stale":true}')
            kicad_review.prepare3d({'dir':'P','name':'P'})
            base_meta = pathlib.Path('review/P/base/board-3d-input.json')
            assert json.loads(base_meta.read_text())['finish']=='ENIG'
            assert not head_meta.exists(), 'BR02 stale absent-side metadata removed'
            # Duplicate references disable only processing and remove any old input.
            pcb.write_text('''(kicad_pcb
                (footprint "Test" (layer "F.Cu") (uuid "one") (at 7 8)
                    (property "Reference" "R1"))
                (footprint "Test" (layer "B.Cu") (uuid "two") (at 9 10)
                    (property "Reference" "R1")))''')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                kicad_review.prepare3d({'dir':'P','name':'P'})
            assert base_meta.exists() and len(json.loads(base_meta.read_text())['warnings']) == 2
            assert 'R1 (one): duplicate reference skipped' in output.getvalue()
            # Exercise the actual CLI and the same sanitized directory used by render.
            project = {'dir':'nested/P', 'name':'P'}
            source = pathlib.Path('head/nested/P/P.kicad_pcb')
            source.parent.mkdir(parents=True)
            source.write_text('(kicad_pcb (setup (stackup (copper_finish "ENEPIG"))))')
            pathlib.Path('review/detect.json').write_text(json.dumps({'projects':[project]}))
            proc = subprocess.run([sys.executable, str(pathlib.Path(kicad_review.__file__).resolve()),
                                   'prepare-3d'], capture_output=True, text=True)
            assert proc.returncode == 0, proc.stderr
            # An absent revision gets no folder: build_project reads folder presence as revision presence.
            assert not pathlib.Path('review', kicad_review.project_id(project['dir']), 'base').exists()
            target = pathlib.Path('review', kicad_review.project_id(project['dir']), 'head', 'board-3d-input.json')
            assert json.loads(target.read_text()) == {
                'version':1, 'side':'head', 'keep':[], 'finish':'ENEPIG', 'footprints':[], 'warnings':[], 'skippedRefs':[]}
            # Malformed board leaves no stale input and later projects still run.
            p_bad = {'dir': 'bad/P1', 'name': 'P1'}
            p_good = {'dir': 'good/P2', 'name': 'P2'}
            pathlib.Path('review/detect.json').write_text(json.dumps({'projects': [p_bad, p_good]}))
            bad_pcb = pathlib.Path('head/bad/P1/P1.kicad_pcb')
            bad_pcb.parent.mkdir(parents=True)
            bad_pcb.write_text('(kicad_pcb (unbalanced')
            stale_bad_meta = pathlib.Path('review', kicad_review.project_id(p_bad['dir']), 'head', 'board-3d-input.json')
            stale_bad_meta.parent.mkdir(parents=True, exist_ok=True)
            stale_bad_meta.write_text('{"stale": true}')
            good_pcb = pathlib.Path('head/good/P2/P2.kicad_pcb')
            good_pcb.parent.mkdir(parents=True)
            good_pcb.write_text('(kicad_pcb (setup (stackup (copper_finish "ENIG"))))')
            proc = subprocess.run([sys.executable, str(pathlib.Path(kicad_review.__file__).resolve()),
                                   'prepare-3d'], capture_output=True, text=True)
            assert proc.returncode == 0, proc.stderr
            assert not stale_bad_meta.exists(), 'BR02 malformed board leaves no stale input'
            assert 'P1: 3D processing unavailable:' in proc.stdout
            good_meta = pathlib.Path('review', kicad_review.project_id(p_good['dir']), 'head', 'board-3d-input.json')
            assert json.loads(good_meta.read_text())['finish'] == 'ENIG', 'BR02 later projects still run after malformed board'
            # Malformed base board unlinks both sides' inputs; comparison keep set cannot be computed.
            p_base_bad = {'dir': 'badbase/P3', 'name': 'P3'}
            pathlib.Path('base/badbase/P3').mkdir(parents=True)
            pathlib.Path('base/badbase/P3/P3.kicad_pcb').write_text('(kicad_pcb (unbalanced')
            stale_base_meta = pathlib.Path('review', kicad_review.project_id(p_base_bad['dir']), 'base', 'board-3d-input.json')
            stale_base_meta.parent.mkdir(parents=True, exist_ok=True)
            stale_base_meta.write_text('{"stale": true}')
            stale_head_meta = pathlib.Path('review', kicad_review.project_id(p_base_bad['dir']), 'head', 'board-3d-input.json')
            stale_head_meta.parent.mkdir(parents=True, exist_ok=True)
            stale_head_meta.write_text('{"stale": true}')
            pathlib.Path('head/badbase/P3').mkdir(parents=True)
            pathlib.Path('head/badbase/P3/P3.kicad_pcb').write_text('(kicad_pcb (setup (stackup (copper_finish "ENIG"))))')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                kicad_review.prepare3d(p_base_bad)
            assert not stale_base_meta.exists(), 'BR02 malformed base unlinks base input'
            assert not stale_head_meta.exists(), 'BR02 malformed base unlinks head input when comparison cannot be computed'
            assert 'P3: 3D processing unavailable:' in output.getvalue()
            # Duplicate references are skipped individually; both revision inputs remain available with warnings.
            p_side_bad = {'dir': 'badside/P4', 'name': 'P4'}
            pathlib.Path('base/badside/P4').mkdir(parents=True)
            pathlib.Path('base/badside/P4/P4.kicad_pcb').write_text('(kicad_pcb (setup (stackup (copper_finish "ENIG"))))')
            pathlib.Path('head/badside/P4').mkdir(parents=True)
            pathlib.Path('head/badside/P4/P4.kicad_pcb').write_text('''(kicad_pcb
                (footprint "Test" (layer "F.Cu") (uuid "u1") (at 7 8) (property "Reference" "R1"))
                (footprint "Test" (layer "B.Cu") (uuid "u2") (at 9 10) (property "Reference" "R1")))''')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                kicad_review.prepare3d(p_side_bad)
            base_p4_meta = pathlib.Path('review', kicad_review.project_id(p_side_bad['dir']), 'base', 'board-3d-input.json')
            head_p4_meta = pathlib.Path('review', kicad_review.project_id(p_side_bad['dir']), 'head', 'board-3d-input.json')
            assert base_p4_meta.exists() and json.loads(base_p4_meta.read_text())['finish'] == 'ENIG', 'BR02 valid base preserved'
            assert head_p4_meta.exists() and len(json.loads(head_p4_meta.read_text())['warnings']) == 2
            assert 'R1 (u1): duplicate reference skipped' in output.getvalue()
            # Malformed head board unlinks both sides' inputs; comparison keep set cannot be computed.
            p_head_bad = {'dir': 'badhead/P5', 'name': 'P5'}
            pathlib.Path('base/badhead/P5').mkdir(parents=True)
            pathlib.Path('base/badhead/P5/P5.kicad_pcb').write_text('(kicad_pcb (setup (stackup (copper_finish "ENIG"))))')
            stale_base_meta5 = pathlib.Path('review', kicad_review.project_id(p_head_bad['dir']), 'base', 'board-3d-input.json')
            stale_base_meta5.parent.mkdir(parents=True, exist_ok=True)
            stale_base_meta5.write_text('{"stale": true}')
            stale_head_meta5 = pathlib.Path('review', kicad_review.project_id(p_head_bad['dir']), 'head', 'board-3d-input.json')
            stale_head_meta5.parent.mkdir(parents=True, exist_ok=True)
            stale_head_meta5.write_text('{"stale": true}')
            pathlib.Path('head/badhead/P5').mkdir(parents=True)
            pathlib.Path('head/badhead/P5/P5.kicad_pcb').write_text('(kicad_pcb (unbalanced')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                kicad_review.prepare3d(p_head_bad)
            assert not stale_base_meta5.exists(), 'BR02 malformed head unlinks base input'
            assert not stale_head_meta5.exists(), 'BR02 malformed head unlinks head input'
            assert 'P5: 3D processing unavailable:' in output.getvalue()
            # Absent base revision (new project): head metadata is written with all added footprints in keep.
            p_new = {'dir': 'newproj/P6', 'name': 'P6'}
            pathlib.Path('head/newproj/P6').mkdir(parents=True)
            pathlib.Path('head/newproj/P6/P6.kicad_pcb').write_text('''(kicad_pcb
                (setup (stackup (copper_finish "ENIG")))
                (footprint "Test" (layer "F.Cu") (uuid "u1") (at 7 8) (property "Reference" "R1")))''')
            kicad_review.prepare3d(p_new)
            new_head_meta = json.loads(pathlib.Path('review', kicad_review.project_id(p_new['dir']), 'head', 'board-3d-input.json').read_text())
            assert new_head_meta['keep'] == ['R1'], 'BR02 new project marks added footprints in keep'
        finally:
            os.chdir(old)
    print('ok BR02 prepare-3d failed export, stale absent/invalid sides and sanitized CLI output')


br02_task2a_prepare_contract()


# BR02 Task 4A: verified additive coverage and digest artifacts.
import gzip, hashlib, json, os, pathlib, tempfile
with tempfile.TemporaryDirectory() as t:
    old=os.getcwd();os.chdir(t)
    try:
        root=pathlib.Path(t);side=root/'head';side.mkdir()
        raw=b'glTF-model';parts=json.dumps([{'uuid':'u','ref':'R1','side':'top',
            'box':[0,0,0,1,1,1],'hasModel':True,'reason':None}]).encode()
        counts={'footprints':1,'withModel':1,'placeholders':0,'triangles':1,'primitives':1,'warnings':[]}
        values={'board.glb':raw,'parts.json':parts,'stats.json':json.dumps(counts).encode()}
        for name,value in values.items():
            target={'parts.json':'board-parts.json','stats.json':'board-stats.json'}.get(name,name)
            (side/target).write_bytes(value)
        (side/'poster.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        (side/'board-processed.json').write_text(json.dumps({'key':'pair','hashes':{
            name:hashlib.sha256(value).hexdigest() for name,value in values.items()}}))
        blobs={};board={'model3d':{'head':'existing-model-id','base':None}}
        kicad_review.attach3d(board,str(root),blobs)
        assert board['coverage3d']==counts and board['coverage3dBySide']['base'] is None
        assert board['model3d']['head']=='existing-model-id'
        assert board['parts3d']['head'] in blobs and board['poster3d']['head'] in blobs
        # Test the asset function in a scratch directory; attach3d's artifact path is redirected by cwd below.
        asset=kicad_review.artifact3d(raw,'board.glb',root/'assets')
        assert gzip.decompress((root/'assets'/asset['artifactName']).read_bytes())==raw
        assert asset['digest']==hashlib.sha256(raw).hexdigest()
        assert asset==kicad_review.artifact3d(raw,'board.glb',root/'assets')
        (side/'board-stats.json').write_text('{}')
        legacy={'model3d':board['model3d']};kicad_review.attach3d(legacy,str(root),{})
        assert legacy['coverage3dBySide']['head'] is None and 'coverage3d' not in legacy
    finally:
        os.chdir(old)

# BR02 comparison attachments include both revisions and keep revision-local coverage.
from unittest.mock import patch
with tempfile.TemporaryDirectory() as t:
    old=os.getcwd();os.chdir(t)
    try:
        root=pathlib.Path(t)/'P'
        payloads={}
        for side,count in (('base',2),('head',1)):
            folder=root/side;folder.mkdir(parents=True)
            parts=[{'uuid':side+str(i),'ref':'R'+str(i),'side':'top',
                    'box':[0,0,0,1,1,1],'hasModel':True,'reason':None} for i in range(count)]
            stats={'footprints':count,'withModel':count,'placeholders':0,
                   'triangles':count,'primitives':count,'warnings':[]}
            values={'board.glb':b'glTF-'+side.encode(),'parts.json':json.dumps(parts).encode(),
                    'stats.json':json.dumps(stats).encode()}
            for name,value in values.items():
                target={'parts.json':'board-parts.json','stats.json':'board-stats.json'}.get(name,name)
                (folder/target).write_bytes(value)
            poster=b'\x89PNG\r\n\x1a\n'+side.encode();(folder/'poster.png').write_bytes(poster)
            (folder/'board-processed.json').write_text(json.dumps({'hashes':{
                name:hashlib.sha256(value).hexdigest() for name,value in values.items()}}))
            payloads[side]=(values,poster)
        blobs={};board={'model3d':{'base':'base-model','head':'head-model'}}
        kicad_review.attach3d(board,str(root),blobs)
        assert board['coverage3d']['footprints']==1
        assert board['coverage3dBySide']['base']['footprints']==2
        assert len(list(pathlib.Path('review/3d').iterdir()))==4
    finally:
        os.chdir(old)

# BR02 design-only stills require no model or processed files.
with tempfile.TemporaryDirectory() as t:
    folder=pathlib.Path(t,'head');folder.mkdir()
    png=b'\x89PNG\r\n\x1a\nhead-only-still';(folder/'poster.png').write_bytes(png)
    board={};blobs={}
    kicad_review.attach3d(board,t,blobs)
    expected={};poster_id=kicad_review.add_blob(expected,png)
    assert blobs==expected and board['poster3d']=={'base':None,'head':poster_id}
    assert board['parts3d']=={'base':None,'head':None} and 'coverage3d' not in board


def br02_task4a_attachment_contract():
    import base64, contextlib, copy, gzip, hashlib, io, json, os, pathlib, tempfile
    from unittest.mock import patch
    import kicad_review as kr

    def processed(folder, count=1, triangles=1, missing=False):
        folder.mkdir(parents=True, exist_ok=True)
        parts = [{'uuid': 'u'+str(i), 'ref': 'R'+str(i), 'side': 'top',
                  'box': [0,0,0,1,1,1], 'hasModel': not (missing and i == 0),
                  'reason': 'processor missing model' if missing and i == 0 else None} for i in range(count)]
        stats = {'footprints': count, 'withModel': count-int(missing), 'placeholders': int(missing),
                 'triangles': triangles, 'primitives': count, 'warnings': []}
        values = {'board.glb': b'glTF-model', 'parts.json': json.dumps(parts).encode(),
                  'stats.json': json.dumps(stats).encode()}
        for name, value in values.items():
            target = {'parts.json': 'board-parts.json', 'stats.json': 'board-stats.json'}.get(name, name)
            (folder/target).write_bytes(value)
        (folder/'board-processed.json').write_text(json.dumps({'hashes': {
            name: hashlib.sha256(value).hexdigest() for name, value in values.items()}}))
        return values, stats

    with tempfile.TemporaryDirectory() as t:
        old = os.getcwd()
        os.chdir(t)
        try:
            root = pathlib.Path('review/P')
            _, base_stats = processed(root/'base', count=2, triangles=5)
            _, head_stats = processed(root/'head')
            board = {'no_model':[{'ref':'R0','side':'both','reason':'stale log'}]}; blobs = {}
            kr.attach3d(board, str(root), blobs)
            assert board['no_model'] == [], 'verified modeled parts override stale missing-model log rows'
            assert board['coverage3d'] == head_stats
            assert board['coverage3dBySide'] == {'base': base_stats, 'head': head_stats}
            assert board['parts3d']['base'] != board['parts3d']['head']
            values, _ = processed(root/'base', triangles=9)
            kr.attach3d(board, str(root), blobs)
            assert board['parts3d']['base'] == board['parts3d']['head'], 'identical indexes deduplicate'
            assert board['coverage3dBySide']['base']['triangles'] == 9
            assert board['coverage3d']['triangles'] == 1
            asset = board['assets3d']['head']['parts']
            packed = (pathlib.Path('review/3d')/asset['artifactName']).read_bytes()
            assert asset['bytes'] == len(packed) and gzip.decompress(packed) == values['parts.json']
            assert asset['artifactName'] == 'kicad-3d-'+asset['digest']+'-board-parts.json.gz'
            assert packed == gzip.compress(values['parts.json'], mtime=0)

            # A stale/corrupt optimized set never advertises an index or coverage; base remains valid.
            (root/'head/board-parts.json').write_bytes(b'corrupt')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                kr.attach3d(board, str(root), {})
            assert 'processed output hash mismatch' in output.getvalue()
            assert board['coverage3d'] == board['coverage3dBySide']['base']
            assert all(board[key]['head'] is None for key in ('parts3d','coverage3dBySide','assets3d'))
            # Hash-valid but malformed coverage fails closed too.
            for invalid in ([], {}, {'footprints': True}, {**head_stats, 'placeholders': 2}):
                processed(root/'head')
                raw = json.dumps(invalid).encode()
                (root/'head/board-stats.json').write_bytes(raw)
                manifest = json.loads((root/'head/board-processed.json').read_text())
                manifest['hashes']['stats.json'] = hashlib.sha256(raw).hexdigest()
                (root/'head/board-processed.json').write_text(json.dumps(manifest))
                with contextlib.redirect_stdout(io.StringIO()):
                    kr.attach3d(board, str(root), {})
                assert board['coverage3dBySide']['head'] is None
            processed(root/'head', missing=True)
            board = {'no_model':[{'ref':'STALE','side':'both','reason':'stale log'}]}
            kr.attach3d(board, str(root), {})
            assert board['no_model'] == [{'ref':'R0', 'side':'head',
                'reason':'processor missing model', 'uuid':'u0'}], 'missing rows derive from verified parts only'
            # Actual build/report integration: design-only attaches PNG without model/index files.
            import shutil
            shutil.rmtree(root)
            (root/'head').mkdir(parents=True)
            png = b'\x89PNG\r\n\x1a\ndesign-only'
            (root/'head/poster.png').write_bytes(png)
            settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
            settings['design'] = {'enabled': True}
            project = {'name': 'P', 'dir': 'P', 'status': 'added'}
            pathlib.Path('review/detect.json').write_text(json.dumps({
                'projects': [project], 'base': '', 'head': 'abc123', 'reason': 'test'}))
            with patch.object(kr, 'load_settings', return_value=settings), \
                 patch.object(kr, 'project_checks', return_value=[]), \
                 contextlib.redirect_stdout(io.StringIO()):
                kr.cmd_report(None)
            html = pathlib.Path('review/kicad-review.html').read_text()
            embedded = json.JSONDecoder().raw_decode(html.split('window.REVIEW_DATA = ', 1)[1])[0]
            disk = json.loads(pathlib.Path('review/data.json').read_text())
            assert embedded['version'] == disk['version'] == 1
            assert {k:v for k,v in embedded.items() if k != 'blobs'} == disk
            still_board = disk['projects'][0]['board']
            assert 'model3d' not in still_board and 'coverage3d' not in still_board
            poster_id = still_board['poster3d']['head']
            assert gzip.decompress(base64.b64decode(embedded['blobs'][poster_id])) == png
            assert len(embedded['blobs']) == 1, 'design-only report embeds only its poster'
            # 3D-enabled build keeps the established model blob IDs and attaches processed data.
            processed(root/'head')
            settings['3d']['enabled'] = True
            with patch.object(kr, 'project_checks', return_value=[]):
                blobs = {}; model_board = kr.build_project(project, blobs, settings)['board']
            model_id = kr.add_blob({}, b'glTF-model')
            assert model_board['model3d']['head'] == model_id and model_id in blobs
            assert model_board['parts3d']['head'] in blobs and model_board['coverage3d'] == head_stats
        finally:
            os.chdir(old)

    # Legacy fixture remains version 1 with the same embedded model IDs, no new fields required.
    source = pathlib.Path(kr.UI_DIR, 'sample/review-data-3d.js').read_text()
    legacy = json.JSONDecoder().raw_decode(source.split('window.REVIEW_DATA = ', 1)[1])[0]
    page = kr.inline_page(source)
    restored = json.JSONDecoder().raw_decode(page.split('window.REVIEW_DATA = ', 1)[1])[0]
    assert restored == legacy and restored['version'] == 1
    for project in restored['projects']:
        for side in ('base', 'head'):
            model_id = project['board'].get('model3d', {}).get(side)
            if model_id:
                assert gzip.decompress(base64.b64decode(restored['blobs'][model_id])).startswith(b'glTF')
    # Hardening: strict coverage shape and fail-closed poster reads.
    # attach3d writes digest assets under the relative review/3d; keep them out of the checkout.
    with tempfile.TemporaryDirectory() as t, contextlib.chdir(t):
        root = pathlib.Path(t)
        (root/'head').mkdir()
        for invalid in ({'footprints': 0, 'withModel': 0, 'placeholders': 0, 'triangles': 0,
                         'primitives': 0, 'warnings': 'not-a-list'},):
            folder = root/'head'
            parts = b'[]'; glb = b'glTF-model'; stats_raw = json.dumps(invalid).encode()
            values = {'board.glb': glb, 'parts.json': parts, 'stats.json': stats_raw}
            (folder/'board.glb').write_bytes(glb); (folder/'board-parts.json').write_bytes(parts)
            (folder/'board-stats.json').write_bytes(stats_raw)
            (folder/'board-processed.json').write_text(json.dumps({'hashes': {
                name: hashlib.sha256(value).hexdigest() for name, value in values.items()}}))
            result = {}; kr.attach3d(result, str(root), {})
            assert result['coverage3dBySide']['head'] is None
        # Older valid producer stats may omit warnings; preserve coverage with an empty list.
        folder = root/'head'
        stats = {'footprints': 0, 'withModel': 0, 'placeholders': 0, 'triangles': 0, 'primitives': 0}
        parts = b'[]'; glb = b'glTF-model'; stats_raw = json.dumps(stats).encode()
        values = {'board.glb': glb, 'parts.json': parts, 'stats.json': stats_raw}
        (folder/'board.glb').write_bytes(glb); (folder/'board-parts.json').write_bytes(parts)
        (folder/'board-stats.json').write_bytes(stats_raw)
        (folder/'board-processed.json').write_text(json.dumps({'hashes': {
            name: hashlib.sha256(value).hexdigest() for name, value in values.items()}}))
        result = {}; kr.attach3d(result, str(root), {})
        assert result['coverage3dBySide']['head']['warnings'] == []
        original = pathlib.Path.read_bytes
        def unreadable(path, *args, **kwargs):
            if path.name == 'poster.png':
                raise PermissionError('test')
            return original(path, *args, **kwargs)
        with patch.object(pathlib.Path, 'read_bytes', unreadable):
            result = {}; kr.attach3d(result, str(root), {})
            assert result['poster3d']['head'] is None
    print('ok BR02 verified coverage, digest assets, head-only/poster-only attachments and legacy offline v1')


br02_task4a_attachment_contract()

# BR02: processing is pair-specific, its integration gate is required, assets are individual files.
wf = pathlib.Path('.github/workflows/review.yml').read_text()
assert 'prepare-3d' in wf and '--cache .processed-3d-cache' in wf, 'BR02 pair-specific processing workflow'
ci = pathlib.Path('.github/workflows/test.yml').read_text()
assert 'name: Run 3D processor integration tests' not in wf, 'consumer reviews must not run tool integration tests'
step = ci.split('name: Run 3D processor integration tests', 1)[1].split('\n      - name:', 1)[0]
assert 'PROCESS3D_INTEGRATION=1' in step and 'node --test ui/compress3d.test.mjs' in step
assert 'continue-on-error: true' not in step, 'self-test integration gate must block failures'
assert 'INPUT_ARCHIVE=false' in wf and 'INPUT_RETENTION-DAYS=90' in wf
assert '_actions/actions/upload-artifact/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/dist/upload/index.js' in wf
for name in ('Install 3D compression dependencies', 'Compress 3D board models', 'Upload digest-keyed 3D assets'):
    block = wf.split('name: ' + name, 1)[1].split('\n      - name:', 1)[0]
    assert 'continue-on-error: true' in block, 'optional 3D must not fail consumer reviews'
    assert 'hashFiles(' in block.split('run:', 1)[0], '3D steps need actual assets'
assert wf.count("'tools/ui/compress3d.cjs', 'base/kicad-review.toml'") == 2
cache = wf.split('name: Cache 3D compression dependencies', 1)[1].split('\n      - name:', 1)[0]
assert '.processed-3d-cache' in cache and 'hashFiles(' in cache
assert 'github.run_id' not in cache and 'github.run_attempt' not in cache
assert 'restore-keys:' in cache
assert 'uses: ./tools/.github/actions/upload-3d-assets' in wf
assert 'using: node24' in pathlib.Path('.github/actions/upload-3d-assets/action.yml').read_text()
assert wf.index('name: Upload report\n') < wf.index('name: Upload digest-keyed 3D assets') < wf.index('name: Screenshots of changed drawings')
assert 'INPUT_OVERWRITE=true INPUT_INCLUDE-HIDDEN-FILES=false' in wf
print('ok BR02 pair-specific processing workflow, required integration gate and immutable assets')


def br02_processed_sample_contract():
    import base64, gzip, hashlib, json, math, struct, zlib
    source = pathlib.Path('ui/sample/review-data-3d-processed.js').read_text()
    assert '<' not in source, 'BR02 sample uses the report producer escaped script'
    data = json.JSONDecoder().raw_decode(source.split('window.REVIEW_DATA = ', 1)[1])[0]
    assert data['version'] == 1 and len(data['projects']) == 1
    project = data['projects'][0]; board = project['board']
    blob = lambda field, side: gzip.decompress(base64.b64decode(data['blobs'][board[field][side]], validate=True))
    indexes = {}
    for side, resistor in (('base', 'R1'), ('head', 'R12')):
        coverage = board['coverage3dBySide'][side]
        assert [coverage[k] for k in ('footprints', 'withModel', 'placeholders')] == [6, 3, 3]
        raw = blob('model3d', side)
        assert struct.unpack('<4sII', raw[:12]) == (b'glTF', 2, len(raw))
        length, kind = struct.unpack('<I4s', raw[12:20]); assert kind == b'JSON'
        gltf = json.loads(raw[20:20+length])
        assert 'EXT_meshopt_compression' in gltf['extensionsRequired']
        assert any(n.get('extras', {}).get('batch') == 'ref:' + resistor for n in gltf['nodes'])
        assert any(n.get('name') == 'parts:merged:top' for n in gltf['nodes'])
        assert any(n.get('name') == 'parts:merged:bottom' for n in gltf['nodes'])
        image = blob('poster3d', side)
        assert image[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', image[16:24]) == (1600, 1000)
        offset = 8; pixels = bytearray()
        while offset < len(image):
            size = struct.unpack('>I', image[offset:offset+4])[0]
            chunk = image[offset+4:offset+8+size]
            assert zlib.crc32(chunk) == struct.unpack('>I', image[offset+8+size:offset+12+size])[0]
            if chunk[:4] == b'IDAT': pixels.extend(chunk[4:])
            offset += size + 12
        assert len(zlib.decompress(pixels)) == 1000 * (1 + 1600 * 4), 'BR02 real PNG pixels'
        parts = json.loads(blob('parts3d', side)); indexes[side] = {p['ref']: p for p in parts}
        assert set(indexes[side]) == {resistor, 'R2', 'J1', 'U3', 'U4', 'LOGO1'}
        for part in parts:
            assert len(part['box']) == 6 and all(math.isfinite(v) for v in part['box'])
        for ref, surface in (('U3', 'top'), ('U4', 'bottom'), ('LOGO1', 'top')):
            missing = indexes[side][ref]
            assert not missing['hasModel'] and missing['side'] == surface and missing['reason']
        # Missing selectable targets must not overlap a model body, even in an overhead ray.
        for ref in ('U3', 'U4'):
            a = indexes[side][ref]['box']
            for body in (p for p in parts if p['hasModel']):
                b = body['box']
                assert any(a[i+3] < b[i] or b[i+3] < a[i] for i in (0, 2)), (side, ref, body['ref'])
        for field, key, suffix in (('model3d', 'model', 'board.glb'), ('parts3d', 'parts', 'board-parts.json')):
            raw = blob(field, side); asset = board['assets3d'][side][key]
            digest = hashlib.sha256(raw).hexdigest()
            assert asset == {'digest': digest, 'artifactName': 'kicad-3d-' + digest + '-' + suffix + '.gz',
                             'bytes': len(gzip.compress(raw, mtime=0))}
    for before, after in (('R1', 'R12'), ('U3', 'U3')):
        a, b = indexes['base'][before], indexes['head'][after]
        assert a['uuid'] == b['uuid']
        assert abs(b['box'][0] - a['box'][0] - .001) < 1e-9
    for ref in ('R2', 'J1', 'U4', 'LOGO1'):
        assert indexes['base'][ref] == indexes['head'][ref]
    assert {c['ref'] for c in project['changes']} == {'R12', 'U3'}
    for side in ('base', 'head'):
        geometry = json.loads(blob('geometry', side))
        assert geometry['copperStack'] == ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
    print('ok BR02 real processed sample: renamed/moved UUIDs, isolated missing targets, Meshopt, PNG, indexes and four layers')


br02_processed_sample_contract()

# BR02: workers are inert, byte-identical offline assets, not external scripts.
worker = base64.b64encode(pathlib.Path('ui/three-decode.js').read_bytes()).decode()
worker_tag = '<script type="application/octet-stream" id="three-decode-worker">' + worker + '</script>'
assert '</script>' not in worker
html = kicad_review.inline_page(pathlib.Path('ui/sample/review-data-3d.js').read_text())
assert worker_tag in html, 'BR02 inline decode worker source'
assert pathlib.Path('ui/three-studio.js').read_text() in html and html.index('window.ThreeStudio') < html.index('window.Review3D'), 'BR02 studio script precedes the viewer'
print('ok BR02 inline decode worker source')


# Best-effort failures are complete attempts, not an invitation to export forever.
def br02_failed_export_cache_contract():
    import copy, os, subprocess, tempfile
    from unittest.mock import patch
    import kicad_review as kr
    old = os.getcwd()
    with tempfile.TemporaryDirectory() as t, patch.object(kr, 'IMAGE_RENDERER', 'verified-10.0.6'):
        try:
            os.chdir(t)
            pathlib.Path('base/P').mkdir(parents=True)
            pathlib.Path('base/P/P.kicad_pcb').write_text('(kicad_pcb)')
            out = pathlib.Path('review/P/base')
            settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
            settings['3d']['enabled'] = True
            p = {'dir':'P','name':'P'}
            with patch.object(kr.subprocess, 'run', side_effect=OSError('no CLI')):
                kr.export_glb(p, 'base', str(out))
            (out/'.complete').write_text(json.dumps(kr.image_export_identity(p, 'base'), sort_keys=True))
            assert kr.render_cache_complete(out, p, 'base', settings), 'failed exports must be cacheable'
            assert (out/'board.raw.glb.failed').exists() and (out/'poster.png.failed').exists()
            with patch.object(kr.subprocess, 'run') as run:
                def success(args, **kw):
                    pathlib.Path(args[args.index('-o')+1]).write_bytes(b'glTF' if 'glb' in args else br02_png())
                    return subprocess.CompletedProcess(args, 0, '', '')
                run.side_effect = success
                kr.export_glb(p, 'base', str(out))
            assert not (out/'board.raw.glb.failed').exists() and not (out/'poster.png.failed').exists()
            pathlib.Path('review/detect.json').write_text(json.dumps({
                'base':'a'*40, 'head':'b'*40, 'projects':[{**p, 'status':'removed'}]}))
            with patch.object(kr, 'load_settings', return_value=settings), patch.object(kr, 'render_side'), \
                 patch.object(kr, 'render_tool_identity', return_value='test'), \
                 patch.object(kr.subprocess, 'run', side_effect=OSError('no CLI')) as run:
                kr.cmd_render(None)
                assert run.call_count == 2
                kr.cmd_render(None)
                assert run.call_count == 2, 'failed best-effort exports must not rerender next run'
            with patch.object(kr, 'glb_inputs', return_value=(b'board', [('body.step', b'asset')])):
                expected = hashlib.sha256()
                for value in (b'board', b'body.step', b'asset'):
                    expected.update(len(value).to_bytes(8, 'big')); expected.update(value)
                assert kr.glb_input_digest(p, 'base') == expected.hexdigest()
        finally:
            os.chdir(old)
    print('ok BR02 failed export attempts cache and successful retries clear markers')

br02_failed_export_cache_contract()

docs = pathlib.Path('README.md').read_text()
assert '3D coverage' in docs and 'parts3d' in docs, 'BR02 document 3D coverage and part index'
assert 'world metres' in docs and '600,000' in docs, 'BR02 document bounds units and simplification ceiling'
print('ok BR02 documentation')

# BR03: Electrical membership extraction and identity limits.
from kicad_review import net_members
nettext = '''(export (components (comp (ref U1)))
(nets (net (name GND) (node (ref U1) (pin 1))
(node (ref U1) (pin 1)))))'''
obj = lambda ref, unit, sheet: {"kind":"symbol", "ref":ref,
    "props":{"reference":ref,"unit":unit},"where":{"sheet":sheet},"pos":[1,2,0]}
units = {"/a":obj("U1","1","/"), "/b":obj("U1","2","/")}
nets, anchors, issues = net_members(nettext, units, "a"*40)
assert nets == {"GND":{"U1.1"}}
assert len(anchors["U1.1"]) == 2 and not issues
bad = {"/a":obj("U1","1","/"), "/b":obj("U1","1","/")}
nets, anchors, issues = net_members(nettext, bad, "a"*40)
assert not nets["GND"] and issues and not anchors
missing = nettext.replace("U1", "R?")
nets, anchors, issues = net_members(missing, {"/a":obj("R?","1","/")}, "a"*40)
assert nets["GND"] == {"/a:1"} and issues
assert anchors["/a:1"][0]["commit"] == "a"*40
inst = {"/s1/a":obj("R1","1","/s1/"), "/s2/a":obj("R2","1","/s2/")}
text = '(export (nets (net (name A) (node (ref R1) (pin 1)) (node (ref R2) (pin 1)))))'
nets, anchors, issues = net_members(text, inst, "b"*40)
assert nets["A"] == {"R1.1","R2.1"} and not issues
assert anchors["R1.1"][0]["sheet"] != anchors["R2.1"][0]["sheet"]
# Power symbols (#PWR) are not component pins: skipped without suppressing the rest of the net.
pwr = '(export (nets (net (name GND) (node (ref U1) (pin 1)) (node (ref "#PWR01") (pin 1)))))'
nets, anchors, issues = net_members(pwr, {"/a": obj("U1","1","/")}, "c"*40)
assert nets == {"GND": {"U1.1"}} and not issues
# A missing reference shared by several symbols has no recoverable UUID: suppressed, never guessed.
two = {"/a": obj("U?","1","/"), "/b": obj("U?","2","/")}
nets, anchors, issues = net_members('(export (nets (net (name GND) (node (ref "U?") (pin 2)))))', two, "c"*40)
assert not nets["GND"] and issues and not anchors
print("ok BR03 electrical membership")

# BR03 review regressions: independently runnable identity-policy tests.
def br03_object(ref, unit="1", sheet="/"):
    return {"kind": "symbol", "ref": ref, "props": {"reference": ref, "unit": unit},
            "where": {"sheet": sheet}, "pos": [1, 2, 0]}


def test_br03_unknown_net():
    objects = {"/r": br03_object("R1"), "/a": br03_object("U1"), "/b": br03_object("U1")}
    # An ambiguous node poisons its entire net, regardless of node order; other nets stay usable.
    for nodes in ('(node (ref R1) (pin 1)) (node (ref U1) (pin 1))',
                  '(node (ref U1) (pin 1)) (node (ref R1) (pin 1))'):
        text = '(export (nets (net (name BAD) ' + nodes + ''')
          (net (name GOOD) (node (ref R1) (pin 2))) (net (name EMPTY))))'''
        nets, anchors, issues = net_members(text, objects, "a" * 40)
        assert nets == {"BAD": None, "GOOD": {"R1.2"}, "EMPTY": set()}, nets
        assert set(anchors) == {"R1.2"}, anchors  # no anchors leaked from partial evidence
        assert len(issues) == 1 and issues[0]["unknown"] is True, issues
        assert issues[0]["channel"] == "wiring" and issues[0]["net"] == "BAD", issues
    # The same shared member remains anchored if independently observed on a trustworthy net.
    text = '''(export (nets (net (name GOOD) (node (ref R1) (pin 1)))
      (net (name BAD) (node (ref R1) (pin 1)) (node (ref U1) (pin 1)))))'''
    nets, anchors, issues = net_members(text, objects, "a" * 40)
    assert nets == {"GOOD": {"R1.1"}, "BAD": None} and set(anchors) == {"R1.1"}
    # Every affected net has its own marker, not a deduplicated global reason.
    text = '''(export (nets (net (name B) (node (ref U1) (pin 1)))
      (net (name A) (node (ref U1) (pin 2)))))'''
    nets, anchors, issues = net_members(text, objects, "a" * 40)
    assert nets == {"A": None, "B": None} and not anchors
    assert [i["net"] for i in issues if i["unknown"]] == ["A", "B"], issues


def test_br03_missing_pin():
    for pin in ("", '(pin "")'):
        text = '(export (nets (net (name N) (node (ref U1) ' + pin + '))))'
        nets, anchors, issues = net_members(text, {"/a": br03_object("U1")}, "a" * 40)
        assert nets["N"] is None and not anchors, (nets, anchors)
        assert len(issues) == 1 and issues[0]["unknown"] and issues[0]["net"] == "N", issues
    # An absent reference with no matching symbol cannot become a fabricated member either.
    nets, anchors, issues = net_members('(export (nets (net (name N) (node (pin 1)))))',
                                        {"/a": br03_object("U1")}, "a" * 40)
    assert nets["N"] is None and not anchors and issues[0]["unknown"]


def test_br03_power_policy():
    # Power refs are ignored even if a symbol candidate exists or its pin is absent.
    text = '''(export (nets (net (name GND) (node (ref R1) (pin 1))
      (node (ref "#PWR01") (pin 1)) (node (ref "#FLG01")))
      (net (name POWER_ONLY) (node (ref "#PWR01") (pin 1)))))'''
    nets, anchors, issues = net_members(text, {"/r": br03_object("R1"),
                                              "/p": br03_object("#PWR01")}, "a" * 40)
    assert nets == {"GND": {"R1.1"}, "POWER_ONLY": set()} and not issues, (nets, issues)
    assert set(anchors) == {"R1.1"}


def test_br03_missing_multi_policy():
    # Standalone assertion: must fail on 41559c2 independently of the power-symbol regression.
    objects = {"/a": br03_object("U?"), "/b": br03_object("U?", "2")}
    text = '(export (nets (net (name N) (node (ref "U?") (pin 2)))))'
    nets, anchors, issues = net_members(text, objects, "a" * 40)
    assert not nets["N"] and not anchors and any(i["unknown"] for i in issues), (nets, anchors, issues)
    # One symbol instance is recoverable, including a genuinely empty reference.
    for ref in ("U?", ""):
        text = '(export (nets (net (name N) (node (ref "' + ref + '") (pin 2)))))'
        nets, anchors, issues = net_members(text, {"/s/a": br03_object(ref, sheet="/s/")}, "a" * 40)
        assert nets == {"N": {"/s/a:2"}} and set(anchors) == {"/s/a:2"}
        assert issues and not any(i["unknown"] for i in issues)
    # Multiple genuinely empty references cannot be disambiguated either.
    objects_empty = {"/a": br03_object("", sheet="/s/"), "/b": br03_object("", "2", sheet="/s/")}
    text_empty = '(export (nets (net (name N) (node (pin 2)))))'
    nets_em, anchors_em, issues_em = net_members(text_empty, objects_empty, "a" * 40)
    assert not nets_em["N"] and not anchors_em and any(i["unknown"] for i in issues_em)


def test_br03_unit_anchor_candidates():
    # Membership is REF.PIN, not unit-specific. These are candidate anchors, not proven pin positions.
    # Only the UI hotspot manifest can resolve these candidates to owning units.
    objects = {"/s/a": br03_object("U1", "1", "/s/"), "/s/b": br03_object("U1", "2", "/s/")}
    text = '''(export (nets (net (name N) (node (ref U1) (pin 1))
      (node (ref U1) (pin 1)) (node (ref U1) (pin 2)))))'''
    nets, anchors, issues = net_members(text, objects, "b" * 40)
    assert nets == {"N": {"U1.1", "U1.2"}} and not issues
    for pin in ("1", "2"):
        assert anchors["U1." + pin] == [
            {"uuid": "a", "ref": "U1", "pin": pin, "unit": "1", "sheet": "/s/", "pos": [1, 2, 0], "commit": "b" * 40},
            {"uuid": "b", "ref": "U1", "pin": pin, "unit": "2", "sheet": "/s/", "pos": [1, 2, 0], "commit": "b" * 40}], anchors


def test_br03_where_sheet_contract():
    # Missing where or missing sheet attribute is safely handled without KeyError/TypeError.
    bad_obj = {"kind": "symbol", "ref": "U1", "props": {"reference": "U1", "unit": "1"}, "where": None, "pos": [1, 2, 0]}
    text = '(export (nets (net (name N) (node (ref U1) (pin 1)))))'
    nets, anchors, issues = net_members(text, {"/a": bad_obj}, "a" * 40)
    assert nets["N"] is None and not anchors
    assert any(i["unknown"] for i in issues)

    # Empty where dictionary without sheet key.
    bad_obj2 = {"kind": "symbol", "ref": "U1", "props": {"reference": "U1", "unit": "1"}, "where": {}, "pos": [1, 2, 0]}
    nets2, anchors2, issues2 = net_members(text, {"/a": bad_obj2}, "a" * 40)
    assert nets2["N"] is None and not anchors2
    assert any(i["unknown"] for i in issues2)

    # Object with where key omitted entirely.
    bad_obj3 = {"kind": "symbol", "ref": "U1", "props": {"reference": "U1", "unit": "1"}, "pos": [1, 2, 0]}
    nets3, anchors3, issues3 = net_members(text, {"/a": bad_obj3}, "a" * 40)
    assert nets3["N"] is None and not anchors3
    assert any(i["unknown"] for i in issues3)


def test_br03_manifest_owns_pin_resolution():
    # Backend membership and candidate anchors must not depend on optional pin metadata.
    objects = {"/a": br03_object("U1", "1", "/"), "/b": br03_object("U1", "2", "/")}
    text = ('(export (nets (net (name A) (node (ref U1) (pin 1))) '
            '(net (name P) (node (ref U1) (pin VCC))) '
            '(net (name Z) (node (ref U1) (pin 99)))))')
    expected = net_members(text, objects, "c" * 40)
    objects["/a"]["pins"] = {"1", "VCC"}
    objects["/b"]["pins"] = {"3", "VCC"}
    assert net_members(text, objects, "c" * 40) == expected
    objects["/b"]["pins"] = frozenset()
    assert net_members(text, objects, "c" * 40) == expected
    nets, anchors, issues = expected
    assert nets == {"A": {"U1.1"}, "P": {"U1.VCC"}, "Z": {"U1.99"}} and not issues
    for pin in ("1", "VCC", "99"):
        assert [a["uuid"] for a in anchors["U1." + pin]] == ["a", "b"]
        assert all("shared" not in a for a in anchors["U1." + pin])


def test_br03_parser_preserves_unit_candidates():
    # Embedded definitions (including lib_name overrides) are not a second pin manifest.
    pin = lambda n: '(pin passive line (number "' + n + '"))'
    with tempfile.TemporaryDirectory() as td:
        (pathlib.Path(td) / "t.kicad_sch").write_text(
            '(kicad_sch (uuid root) (lib_symbols (symbol "L:Dual" '
            '(symbol "Dual_1_1" ' + pin("1") + ')) (symbol "Modified" '
            '(symbol "Modified_2_1" ' + pin("3") + ')))'
            '(symbol (lib_id "L:Dual") (uuid ua) (unit 1) (at 1 2 0) (property "Reference" "U1"))'
            '(symbol (lib_id "L:Dual") (lib_name "Modified") (uuid ub) (unit 2) '
            '(at 5 2 0) (property "Reference" "U1")))')
        objects = kr.sch_objects(td, "t")
        assert all("pins" not in o for o in objects.values())
        text = '(export (nets (net (name N) (node (ref U1) (pin 1)) (node (ref U1) (pin 99)))))'
        nets, anchors, issues = net_members(text, objects, "d" * 40)
        assert nets == {"N": {"U1.1", "U1.99"}} and not issues
        for member in nets["N"]:
            assert [a["uuid"] for a in anchors[member]] == ["ua", "ub"]
            assert all("shared" not in a for a in anchors[member])


# Run the BR03 review regressions in the full plain-assertion suite as well.
for test in (test_br03_unknown_net, test_br03_missing_pin, test_br03_power_policy,
             test_br03_missing_multi_policy, test_br03_unit_anchor_candidates,
             test_br03_where_sheet_contract, test_br03_manifest_owns_pin_resolution,
             test_br03_parser_preserves_unit_candidates):
    test()
print("ok BR03 review identity regressions (8 tests)")

# BR03: graph-based membership comparisons (also runnable without the full suite).
def test_br03_net_graph():
    from kicad_review import diff_nets
    kinds = lambda b, h: [r["kind"] for r in diff_nets(b, h)]
    assert kinds({"old":{"U1.1","R1.1"}}, {"new":{"U1.1","R1.1"}}) == ["net-renamed"]
    assert kinds({"A":{"U1.1"}}, {"A":{"J1.1"}}) == ["net-members"]
    assert kinds({"A":{"U1.1"},"B":{"R1.1"}}, {"C":{"U1.1","R1.1"}}) == ["net-joined"]
    assert kinds({"C":{"U1.1","R1.1"}}, {"A":{"U1.1"},"B":{"R1.1"}}) == ["net-split"]
    many = diff_nets({"A":{"a","b"},"B":{"c","d"}}, {"C":{"a","c"},"D":{"b","d"}})
    assert [r["kind"] for r in many] == ["net-joined","net-split"]
    expected = [{"pin":p,"before":[b],"after":[h]} for p,b,h in
                [("a","A","C"),("b","A","D"),("c","B","C"),("d","B","D")]]
    assert all(r["detail"]["transitions"] == expected for r in many)
    assert all(r["detail"]["added"] == r["detail"]["removed"] == [] for r in many)
    assert all(r["detail"]["beforeNets"] == ["A","B"] and
               r["detail"]["afterNets"] == ["C","D"] for r in many)
    cross = diff_nets({"A":{"a","b"},"B":{"c","d"}}, {"A":{"c","e"},"C":{"a","f"}})
    assert [(r["kind"],r["detail"]["beforeNets"],r["detail"]["afterNets"]) for r in cross] == [
        ("net-members",["A"],["C"]),("net-members",["B"],["A"])]
    assert cross[0]["detail"]["transitions"] == [
        {"pin":"a","before":["A"],"after":["C"]},
        {"pin":"b","before":["A"],"after":[]},
        {"pin":"f","before":[],"after":["C"]}]
    assert cross[1]["detail"]["transitions"] == [
        {"pin":"c","before":["B"],"after":["A"]},
        {"pin":"d","before":["B"],"after":[]},
        {"pin":"e","before":[],"after":["A"]}]
    assert diff_nets({"A":{"a"}}, {"A":{"a"}}) == []
    assert sorted(kinds({"A":{"a"}}, {"B":{"b"}})) == ["net-added","net-removed"]
    assert kinds({"empty":set()}, {"different":set()}) == ["net-removed","net-added"]
    assert diff_nets({"empty":set()}, {"empty":set()}) == []
    r = diff_nets({"A":{"U1.1","R1.1"}}, {"A":{"U1.1","J1.1"}})[0]
    assert r["detail"]["added"] == ["J1.1"] and r["detail"]["removed"] == ["R1.1"]
    assert r["weight"] == "heavy" and r["action"] == "modified"


def test_br03_net_rows():
    from kicad_review import diff_nets, electrical_row
    r = electrical_row("net-members", "A")
    assert r == {"kind":"net-members", "ref":"A", "action":"modified", "channel":"wiring",
                 "weight":"heavy", "detail":{}, "where":None, "pos":None, "box":None,
                 "props":{}, "anchors":{"base":[], "head":[]}, "document":"schematic"}
    other = electrical_row("wires", "sheet", channel="visual", weight="medium", where={"sheet":"/"})
    assert other["channel"] == "visual" and other["weight"] == "medium" and other["where"] == {"sheet":"/"}
    r["anchors"]["base"].append({"uuid":"a"})
    r["detail"]["x"] = 1
    assert not other["anchors"]["base"] and not other["detail"]
    for base, head, action, kind, added, removed in [
        ({}, {"12":{"U1.1"}}, "added", "net-added", ["U1.1"], []),
        ({"12":{"U1.1"}}, {}, "removed", "net-removed", [], ["U1.1"])]:
        r, = diff_nets(base, head)
        assert (r["ref"], r["action"], r["kind"]) == ("12", action, kind)
        assert r["detail"]["kind"] == "members"
        assert r["detail"]["added"] == added and r["detail"]["removed"] == removed
        assert r["detail"]["transitions"] == [{"pin":"U1.1", "before":list(base), "after":list(head)}]
        assert r["anchors"] == {"base":[], "head":[]} and r["document"] == "schematic"
    for name in ("Net-(U1-A)", "unconnected-(U1-A-Pad1)", "MANUAL"):
        r, = diff_nets({name:{"U1.1"}}, {"new":{"U1.1"}})
        assert r["detail"]["autoNamed"] is (name != "MANUAL")
        r, = diff_nets({"old":{"U1.1"}}, {name:{"U1.1"}})
        assert r["detail"]["autoNamed"] is (name != "MANUAL")


def test_br03_net_unknown_pair():
    from kicad_review import diff_nets
    # The Task 1 marker is unknown evidence, never an observed empty/disconnected net.
    for base, head in [({"BAD":None}, {"BAD":{"U1.1"}}),
                       ({"BAD":{"U1.1"}}, {"BAD":None}),
                       ({"BAD":None}, {}), ({}, {"BAD":None}),
                       ({"BAD":None}, {"BAD":None})]:
        assert diff_nets(base, head) == []
        rows = diff_nets({**base, "GOOD":{"R1.1"}}, {**head, "GOOD":{"R1.2"}})
        assert len(rows) == 1 and rows[0]["ref"] == "GOOD", rows
    # Integration: reject partial known members on an ambiguous net, keep independent changes.
    text = '''(export (nets (net (name BAD) (node (ref U1) (pin 1)) (node (ref R1) (pin 1)))
      (net (name GOOD) (node (ref R1) (pin 2)))))'''
    objects = {"/a":br03_object("U1"), "/b":br03_object("U1"), "/r":br03_object("R1")}
    base, _, issues = net_members(text, objects, "a" * 40)
    assert base["BAD"] is None and issues[0]["net"] == "BAD" and issues[0]["unknown"]
    rows = diff_nets(base, {"BAD":{"R1.1"}, "GOOD":{"R1.3"}})
    assert len(rows) == 1 and rows[0]["ref"] == "GOOD", rows


def test_br03_net_determinism():
    from kicad_review import diff_nets
    import copy
    base = {"Z":{"z"}, "B":{"c","d"}, "A":{"a","b"}, "EMPTY":set()}
    head = {"D":{"b","d"}, "C":{"a","c"}, "12":{"z"}, "NEW":set()}
    original = copy.deepcopy((base, head))
    expected = diff_nets(base, head)
    assert diff_nets(dict(reversed(list(base.items()))), dict(reversed(list(head.items())))) == expected
    assert (base, head) == original
    assert [r["kind"] for r in expected] == ["net-renamed", "net-joined", "net-split", "net-removed", "net-added"]
    assert expected[1]["ref"] == expected[2]["ref"] == "C + D"
    # Equal members must win over a same-name edge, even if the names exchanged.
    swapped = diff_nets({"A":{"a"}, "B":{"b"}}, {"A":{"b"}, "B":{"a"}})
    assert [r["kind"] for r in swapped] == ["net-renamed", "net-renamed"]
    assert [(r["detail"]["beforeNets"], r["detail"]["afterNets"]) for r in swapped] == [(["A"],["B"]), (["B"],["A"])]


for test in (test_br03_net_graph, test_br03_net_rows, test_br03_net_unknown_pair, test_br03_net_determinism):
    test()
print("ok BR03 net graph regressions (4 tests)")

# BR03: wire multisets and physical board-pad connectivity, through the real parsers.
def br03_pcb(fp, pads):
    return ('(kicad_pcb (footprint "x" (uuid '+fp+') (property "Reference" "D1") '
            '(at 0 0) '+''.join('(pad "'+n+'" smd rect (uuid '+u+') (at '+str(x)+' 0) '
            '(size 1 1) (layers "F.Cu")'+ (' (net "'+net+'")' if net else '')+')'
            for u,n,x,net in pads)+'))')


def test_br03_wires():
    from kicad_review import diff_wires, wire_counts
    wire = lambda *pts, sheet="/": {"kind":"wire", "where":{"sheet":sheet}, "points_mm":list(pts)}
    assert diff_wires({"a":wire((0,0),(1,0)), "b":wire((1,0),(0,0))},
                      {"c":wire((1.0004,0),(0,0))}) == []
    r, = diff_wires({}, {"c":wire((0,0),(1,0))})
    assert (r["kind"], r["ref"], r["weight"], r["channel"]) == (
        "wires", "Wires drawn / erased", "medium", "wiring")
    assert diff_wires({}, {}) == []
    assert diff_wires({"a":wire((-0.0004,-0.0002),(1.0,2.0))},
                      {"b":wire((1,2),(0,0))}) == []
    assert wire_counts({"a":wire((0,0),(1,0),(2,0))}) == wire_counts(
        {"b":wire((1,0),(0,0)), "c":wire((2,0),(1,0))})
    assert diff_wires({"a":wire((0,0),(2,0))},
                      {"b":wire((0,0),(1,0)), "c":wire((1,0),(2,0))}) == []
    assert diff_wires({"a":wire((0,0),(2,2))},
                      {"b":wire((2,2),(1,1)), "c":wire((0,0),(1,1))}) == []
    for start, joint, end in (((0,0),(0,1),(0,2)), ((0,2),(1,1),(2,0))):
        assert diff_wires({"a":wire(start,end)}, {"b":wire(start,joint), "c":wire(end,joint)}) == []
    assert len(wire_counts({"a":wire((0,0),(1,0)), "b":wire((2,0),(3,0))})) == 2
    assert len(wire_counts({"a":wire((0,0),(1,0)), "b":wire((1,0),(1,1))})) == 2
    assert diff_wires({"a":wire((0,0),(3,0))},
                      {"b":wire((0,0),(2,0)), "c":wire((1,0),(3,0))}) == []
    r, = diff_wires({"a":wire((0,0),(1,0),sheet="/a/")},
                   {"b":wire((0,0),(1,0),sheet="/b/")})
    assert r["detail"] == {"kind":"wires", "drawn":1, "erased":1}
    assert wire_counts({"ignored":{"kind":"bus"}}) == {}
    # Synthetic wires without points_mm using props.points string
    syn_wire = lambda pts: {"kind": "wire", "where": {"sheet": "/"}, "props": {"points": pts}}
    assert diff_wires({"a": syn_wire("(0, 0) (1, 0)"), "b": syn_wire("(1, 0) (0, 0)")},
                      {"c": syn_wire("(1.0004, 0) (0, 0)")}) == []


def test_br03_wire_parser():
    import pathlib
    import tempfile
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as td:
        sch = pathlib.Path(td) / "test.kicad_sch"
        sch.write_text('''(kicad_sch (uuid root)
          (wire (pts (xy 0 0) (xy 2 0)) (uuid original)))''')
        base = kr.sch_objects(td, "test")
        sch.write_text('''(kicad_sch (uuid root)
          (wire (pts (xy 0 0) (xy 1 0)) (uuid first))
          (wire (pts (xy 2 0) (xy 1 0)) (uuid second))
          (junction (at 1 0) (uuid joint))
          (bus (pts (xy 0 0) (xy 3 0)) (uuid ignored)))''')
        assert kr.diff_wires(base, kr.sch_objects(td, "test")) == []


def test_br03_board_pins():
    import pathlib
    import tempfile
    import kicad_review as kr
    from kicad_review import diff_board_pins, board_pads
    with tempfile.TemporaryDirectory() as td:
        b, h = pathlib.Path(td)/"b.kicad_pcb", pathlib.Path(td)/"h.kicad_pcb"
        def compare(bp, hp, bfp="fp", hfp="fp"):
            b.write_text(br03_pcb(bfp, bp)); h.write_text(br03_pcb(hfp, hp))
            return diff_board_pins(kr.pcb_objects(b), kr.pcb_objects(h), board_pads(b), board_pads(h),
                                   {"base":"b"*40, "head":"h"*40})
        rows = compare([("c","C",0,"12")], [("c","C",0,"GND")], "old-fp", "new-fp")
        assert [(r["detail"]["before"],r["detail"]["after"]) for r in rows] == [("12","GND")]
        r, = rows
        assert r["anchors"]["base"][0]["uuid"] == "old-fp"
        assert r["anchors"]["head"][0]["uuid"] == "new-fp"
        assert (r["kind"],r["ref"],r["weight"],r["channel"],r["document"]) == (
            "board-pad-net","D1.C","heavy","wiring","board")
        assert r["detail"] == {"kind":"pad-net","pin":"C","before":"12","after":"GND","boardOnly":True}
        assert r["where"] == {"board":True} and r["pos"] == [0,0] and r["box"] is not None
        assert "uuid" not in r and "uuid_before" not in r  # derived rows do not own scene changeIds
        for side, uid, commit in (("base","old-fp","b"*40), ("head","new-fp","h"*40)):
            assert r["anchors"][side] == [{"uuid":uid,"padUuid":"c","ref":"D1","pin":"C",
                                           "pos":[0,0],"commit":commit,"board":True}]
            assert "sheet" not in r["anchors"][side][0]
        assert compare([("c","C",0,"GND")],[("c","C",0,"")],"old","new")[0]["detail"]["after"] == ""
        assert compare([("c","C",0,"")],[("c","C",0,"12")])[0]["detail"]["before"] == ""
        assert compare([("old-pad","C",0,"GND")],[("new-pad","C",0,"12")],"old","new")[0]["detail"]["after"] == "12"
        # Renewed pad identity on the same footprint is replacement geometry, not proven rewiring.
        assert compare([("old-pad","C",0,"GND")],[("new-pad","C",0,"12")]) == []
        two = [("p1","1",0,"GND"),("p2","1",2,"A")]
        one = [("p1","1",0,"GND")]
        assert compare(two,one) == [] and compare(one,two) == []
        changed = [("p1","1",0,"B")]
        assert len(compare(two,changed)) == 1
        # The repeated pad's occurrence index may change; its UUID must win.
        assert compare(two,list(reversed(two))) == []
        assert len(compare(two,[("p2","1",2,"B"),("p1","1",0,"GND")])) == 1
        # Explicit fallback: absent UUIDs, unique same-number/local-geometry match; no net-based pairing.
        b.write_text(br03_pcb("fp",two).replace('(uuid p1)','').replace('(uuid p2)',''))
        h.write_text(br03_pcb("fp",one).replace('(uuid p1)',''))
        assert diff_board_pins(kr.pcb_objects(b),kr.pcb_objects(h),board_pads(b),board_pads(h),{}) == []
        # The same fallback must pair the unique match: a changed net on it is exactly one row.
        b.write_text(br03_pcb("fp",[("p1","1",0,"GND")]).replace('(uuid p1)',''))
        h.write_text(br03_pcb("fp",[("p1","1",0,"B")]).replace('(uuid p1)',''))
        r, = diff_board_pins(kr.pcb_objects(b),kr.pcb_objects(h),board_pads(b),board_pads(h),{})
        assert (r["detail"]["before"],r["detail"]["after"]) == ("GND","B")
        # Removing/adding a physical footprint never invents disconnections/connections.
        assert diff_board_pins(kr.pcb_objects(b),{},board_pads(b),{},{}) == []
        assert diff_board_pins({},kr.pcb_objects(h),{},board_pads(h),{}) == []
        assert board_pads(pathlib.Path(td)/"missing.kicad_pcb") == {}


def test_br03_pad_pair_identity():
    import copy
    from kicad_review import pad_pairs
    pad = lambda uid, number, geom, net: {"uuid":uid,"number":number,"geom":geom,"net":net}
    a, b = pad("a","1","x","A"), pad("b","1","y","B")
    # UUID survives geometry edits; even identical nets cannot identify a lost duplicate-number pad.
    h = [pad("b","1","changed","A"),pad("a","1","changed","B")]
    original = copy.deepcopy(([a,b],h))
    assert pad_pairs([a,b],h) == [(a,h[1]),(b,h[0])]
    assert ([a,b],h) == original
    assert pad_pairs([a,b],[pad("c","1","z","A")],replaced=True) == []
    assert pad_pairs([a,b],[pad("c","1","y","A")],replaced=True) == [(b,pad("c","1","y","A"))]
    # No pairing when either side has indistinguishable physical candidates.
    repeated = [pad("","1","x","A"),pad("","1","x","B")]
    assert pad_pairs(repeated,[pad("","1","x","A")]) == []
    assert pad_pairs([pad("","1","x","A")],repeated) == []
    assert pad_pairs([a],[pad("c","1","x","B")]) == []
    assert pad_pairs([a],[pad("c","1","changed","B")],replaced=True) == [(a,pad("c","1","changed","B"))]


def test_br03_pad_net_parser():
    import pathlib
    import tempfile
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td)/"board.kicad_pcb"
        modern = br03_pcb("fp",[("c","C",0,"12"),("g","1",2,"GND"),("u","1",4,"")])
        old = modern.replace('(kicad_pcb ', '(kicad_pcb (net 12 "GND") (net 13 "12") ', 1).replace(
            '(net "12")','(net 13)').replace('(net "GND")','(net 12 "GND")')
        expected = None
        for text in (modern,old):
            p.write_text(text)
            pads = kr.board_pads(p)["fp"]
            assert [(v["uuid"],v["number"],v["net"]) for v in pads] == [
                ("c","C","12"),("g","1","GND"),("u","1","")]
            if expected is None: expected = pads
            else: assert pads == expected
            props = kr.pcb_objects(p)["fp"]["props"]
            assert props["pad C net"] == "12" and props["pad 1#1 net"] == "GND"
            assert "pad 1#2 net" not in props
            scene = kr.board_geometry(p)
            nets = {v["id"]:v["name"] for v in scene["nets"]}
            assert {o["uuid"]:nets[o["net"]] for o in scene["objects"] if o["kind"] == "pad"} == {
                "c":"12","g":"GND","u":""}
        # Legacy tstamp identity remains available for both footprints and physical pads.
        p.write_text(modern.replace("(uuid ","(tstamp "))
        assert kr.board_pads(p)["fp"] == expected

        # Pin function/type metadata is descriptive, not physical pad geometry.
        annotated = modern.replace('(pad "C" smd rect (uuid c)',
                                  '(pad "C" smd rect (uuid c) (pinfunction "OLD") (pintype "passive")')
        p.write_text(annotated)
        assert kr.board_pads(p)["fp"][0]["geom"] == expected[0]["geom"]


def test_br03_pad_metadata_fallback():
    # Repeated-number pads without UUIDs need physical geometry to prove rewiring.
    # Test each descriptive field independently: excluding only one is insufficient.
    import pathlib
    import tempfile
    import kicad_review as kr
    base = br03_pcb("fp", [("p1", "1", 0, "GND"), ("p2", "1", 2, "A")])
    base = base.replace('(uuid p1)', '').replace('(uuid p2)', '')
    with tempfile.TemporaryDirectory() as td:
        b, h = pathlib.Path(td) / "b.kicad_pcb", pathlib.Path(td) / "h.kicad_pcb"
        b.write_text(base)
        base_objects, base_pads = kr.pcb_objects(b), kr.board_pads(b)
        for metadata in ('(pinfunction "NEW")', '(pintype "output")',
                         '(pinfunction "NEW") (pintype "output")'):
            head = base.replace('(at 0 0) (size 1 1)', '(at 0 0) ' + metadata + ' (size 1 1)')
            head = head.replace('(net "GND")', '(net "B")')
            h.write_text(head)
            head_pads = kr.board_pads(h)
            assert head_pads["fp"][0]["geom"] == base_pads["fp"][0]["geom"], metadata
            row, = kr.diff_board_pins(base_objects, kr.pcb_objects(h), base_pads, head_pads, {})
            assert (row["detail"]["pin"], row["detail"]["before"], row["detail"]["after"]) == ("1", "GND", "B")
            # Do not weaken the geometry requirement to make metadata-only changes pair.
            h.write_text(head.replace('(size 1 1)', '(size 3 1)', 1))
            assert kr.diff_board_pins(base_objects, kr.pcb_objects(h), base_pads, kr.board_pads(h), {}) == []


def test_br03_object_pairs():
    import copy
    from kicad_review import object_pairs, diff_objects
    obj = lambda ref: {"kind":"footprint","ref":ref,"match":("footprint",ref),"props":{},"where":{"board":True}}
    base = {"same":obj("D1"),"old":obj("D2"),"gone":obj("D3")}
    head = {"same":obj("D9"),"new":obj("D2"),"added":obj("D4")}
    original = copy.deepcopy((base,head))
    pairs,b_left,h_left = object_pairs(base,head)
    assert pairs == [("same","same"),("old","new")]
    assert b_left == {"gone":base["gone"]} and h_left == {"added":head["added"]}
    assert [(r["action"],r["ref"]) for r in diff_objects(base,head)] == [("removed","D3"),("added","D4")]
    assert (base,head) == original


def test_br03_wire_rounding():
    # Endpoints round once, from source values, to 0.001 mm. The 4 dp display text must not round again.
    import pathlib
    import tempfile
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as td:
        sch = pathlib.Path(td) / "test.kicad_sch"
        sch.write_text('(kicad_sch (uuid root) (wire (pts (xy 0.00049 0) (xy 1 0)) (uuid a)))')
        base = kr.sch_objects(td, "test")
        sch.write_text('(kicad_sch (uuid root) (wire (pts (xy 0 0) (xy 1 0)) (uuid a)))')
        assert kr.diff_wires(base, kr.sch_objects(td, "test")) == []


def test_br03_pad_geometry_format():
    # Re-saved numeric spellings of the same repeated-number pads still pair by geometry, without UUIDs.
    import pathlib
    import tempfile
    import kicad_review as kr
    from kicad_review import board_pads, diff_board_pins
    pad = ('(pad "1" smd rect {at} (size {size}) (layers "F.Cu") (net "{net}"))')
    def pcb(pads):
        return ('(kicad_pcb (footprint "x" (uuid fp) (property "Reference" "D1") (at 0 0) '
                + " ".join(pads) + "))")
    base = pcb([pad.format(at="(at 0 0)", size="1 1", net="GND"), pad.format(at="(at 2 0)", size="1 1", net="A")])
    head = pcb([pad.format(at="(at 0.0 0.0)", size="1.0 1.0", net="B"),
                pad.format(at="(at 2.0 0.0)", size="1.00 1.0", net="A")])
    with tempfile.TemporaryDirectory() as td:
        b, h = pathlib.Path(td) / "b.kicad_pcb", pathlib.Path(td) / "h.kicad_pcb"
        b.write_text(base)
        h.write_text(head)
        r, = diff_board_pins(kr.pcb_objects(b), kr.pcb_objects(h), board_pads(b), board_pads(h), {})
        assert (r["detail"]["before"], r["detail"]["after"]) == ("GND", "B")


def test_br03_pad_rotation_fallback():
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as td:
        b, h = pathlib.Path(td) / 'b.kicad_pcb', pathlib.Path(td) / 'h.kicad_pcb'
        base = br03_pcb('fp', [('p1', '1', 0, 'GND'), ('p2', '1', 2, 'A')])
        base = base.replace('(uuid p1)', '').replace('(uuid p2)', '')
        b.write_text(base)
        bp = kr.board_pads(b)
        for angle in (90, 180, 360, -90):
            head = base.replace('(at 0 0)', f'(at 0 0 {angle})', 1)
            head = head.replace('(at 0 0) (size', f'(at 0 0 {angle}) (size')
            head = head.replace('(at 2 0) (size', f'(at 2 0 {angle}) (size')
            h.write_text(head.replace('(net "GND")', '(net "B")'))
            hp = kr.board_pads(h)
            assert [p['geom'] for p in bp['fp']] == [p['geom'] for p in hp['fp']]
            row, = kr.diff_board_pins(kr.pcb_objects(b), kr.pcb_objects(h), bp, hp, {})
            assert (row['detail']['before'], row['detail']['after']) == ('GND', 'B')


def test_br03_board_parse_once():
    # board_pads reads the PCB through one parse, shared with the footprint and pad net lookup.
    import pathlib
    import tempfile
    import kicad_review as kr
    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td) / "b.kicad_pcb"
        p.write_text(br03_pcb("fp", [("p1", "1", 0, "GND")]))
        calls, real = [], kr.parse_sexpr
        def counting(text):
            calls.append(text)
            return real(text)
        kr.parse_sexpr = counting
        try:
            assert kr.board_pads(p)["fp"][0]["net"] == "GND"
        finally:
            kr.parse_sexpr = real
        assert len(calls) == 1, len(calls)


for test in (test_br03_wires, test_br03_wire_parser, test_br03_board_pins, test_br03_pad_pair_identity,
             test_br03_pad_net_parser, test_br03_object_pairs, test_br03_wire_rounding,
             test_br03_pad_geometry_format, test_br03_board_parse_once, test_br03_pad_metadata_fallback,
             test_br03_pad_rotation_fallback):
    test()
print("ok BR03 physical pads and wires (11 tests)")


def test_br03_typed_rules():
    import pathlib
    import tempfile
    from kicad_review import diff_rules, rule_values
    with tempfile.TemporaryDirectory() as td:
        b, h = pathlib.Path(td)/"base", pathlib.Path(td)/"head"
        b.mkdir(); h.mkdir()
        assert rule_values(b, "p") == {} and diff_rules(b, h, "p") == []
        for data in ({"board": None, "net_settings": None},
                     {"board": {"design_settings": None}, "net_settings": None}):
            (b/"p.kicad_pro").write_text(json.dumps(data), encoding="utf-8")
            assert rule_values(b, "p") == {}

        def pair(before, after):
            for root, data in ((b, before), (h, after)):
                (root/"p.kicad_pro").write_text(json.dumps(data), encoding="utf-8")
            return diff_rules(str(b), str(h), "p")

        def rulepro(values):
            return {"board": {"design_settings": {"rules": values}}}

        pro = {**rulepro({"min_clearance": .2}), "net_settings": {
            "classes": [{"name": "Default", "clearance": .2}],
            "netclass_patterns": [{"pattern": "USB*", "netclass": "Default"}]}}
        assert pair(pro, pro) == []
        pro["board"]["design_settings"]["rules"]["min_clearance"] = .25
        pro["net_settings"]["netclass_patterns"][0]["netclass"] = "Fast"
        (h/"p.kicad_pro").write_text(json.dumps(pro), encoding="utf-8")
        (b/"p.kicad_dru").write_bytes(b'(version 1)\r\n')
        custom = '(version 1)\n(rule "custom" (constraint clearance (min 0.3mm)))\n'
        (h/"p.kicad_dru").write_text(custom, encoding="utf-8")
        rows = diff_rules(str(b), str(h), "p")
        n = next(r for r in rows if r["ref"].endswith("min_clearance"))
        assert n["detail"] == {"kind": "number", "unit": "mm", "before": .2, "after": .25}
        assert n["weight"] == "heavy"
        assert any("netclass_patterns" in r["ref"] for r in rows)
        dru = next(r for r in rows if r["ref"] == "custom rules")
        assert dru["detail"] == {"kind": "text", "before": '(version 1)\n', "after": custom}
        assert all(r["channel"] == "rules" and r["document"] == "board" for r in rows)
        assert [r['ref'] for r in rows] == sorted(r['ref'] for r in rows)
        reverse = diff_rules(str(h), str(b), "p")
        assert all(r['weight'] == 'heavy' for r in reverse)
        assert next(r for r in reverse if r['ref'] == 'rules.min_clearance')['detail'] == {
            'kind': 'number', 'unit': 'mm', 'before': .25, 'after': .2}
        (h/"p.kicad_dru").write_text('(version 1)\n', encoding='utf-8')
        assert not any(r['ref'] == 'custom rules' for r in diff_rules(b, h, 'p'))
        (b/"p.kicad_dru").unlink(); (h/"p.kicad_dru").unlink()

        keys = ('min_via_annular_width', 'min_connection', 'min_groove_width', 'min_silk_clearance',
                'min_text_height', 'min_text_thickness', 'solder_mask_to_copper_clearance')
        for key in ('min_clearance', *keys):
            row, = pair(rulepro({key: .1}), rulepro({key: .2}))
            assert row['detail'] == {"kind": "number", "unit": "mm", "before": .1, "after": .2}, 'BR03 missing dimensional rule'
            assert pair(rulepro({}), rulepro({key: .2}))[0]['detail']['before'] is None
            assert pair(rulepro({key: .1}), rulepro({}))[0]['detail']['after'] is None
        for key, values in {'min_resolved_spokes': (2, 3), 'use_height_for_length_calcs': (False, True),
                            'unknown_count': (1, 2), 'min_clearance': (.2, "0.2")}.items():
            detail = pair(rulepro({key: values[0]}), rulepro({key: values[1]}))[0]['detail']
            assert detail == {'kind': 'text', 'before': values[0], 'after': values[1]}
        assert pair(rulepro({'min_clearance': False}), rulepro({'min_clearance': True}))[0]['detail']['kind'] == 'text'
        classes = [{"name": "A", "clearance": .1}, {"name": "B", "clearance": .2}]
        patterns = [{"pattern": "USB*", "netclass": "A"}, {"pattern": "*", "netclass": "B"}]
        assert pair({"net_settings": {"classes": classes}}, {"net_settings": {"classes": classes[::-1]}}) == []
        rows = pair({"net_settings": {"netclass_patterns": patterns}},
                    {"net_settings": {"netclass_patterns": patterns[::-1]}})
        assert len(rows) == 1 and rows[0]['ref'] == 'net_settings.netclass_patterns'
        assert rows[0]['detail'] == {'kind': 'text', 'before': patterns, 'after': patterns[::-1]}
        row, = pair({"net_settings": {"classes": [{"name": "A", "clearance": .1}]}},
                    {"net_settings": {"classes": [{"name": "A", "clearance": .2}]}})
        assert row['ref'] == 'net_settings.classes.A.clearance' and row['detail']['unit'] == 'mm'
        pair({}, {})
        for root, thickness in ((b, '.2'), (h, '.3')):
            (root/'p.kicad_pcb').write_text('(kicad_pcb (setup (stackup (layer "dielectric 1" (thickness '+thickness+')))))')
        row, = diff_rules(str(b), str(h), 'p')
        assert (row['channel'], row['weight'], row['ref'], row['kind']) == ('visual', 'light', 'stackup', 'stackup')
        assert row['detail'] == {'kind': 'text',
                                 'before': ['stackup', ['layer', 'dielectric 1', ['thickness', '.2']]],
                                 'after': ['stackup', ['layer', 'dielectric 1', ['thickness', '.3']]]}
        # Malformed project data is unknown, not an empty source or removed rules.
        (b/'p.kicad_pro').write_text(json.dumps(pro), encoding='utf-8')
        (h/'p.kicad_pro').write_text('{invalid', encoding='utf-8')
        assert rule_values(h, 'p')['_unavailable']
        rows = diff_rules(b, h, 'p')
        unavailable, = [r for r in rows if r['detail']['kind'] == 'unavailable']
        assert unavailable['channel'] == 'rules' and unavailable['document'] == 'board'
        assert unavailable['detail']['before'] is None
        assert unavailable['detail']['after']
        assert not any(r['ref'].startswith(('rules.', 'net_settings.')) for r in rows)
        assert any(r['kind'] == 'stackup' for r in rows)
        reverse = diff_rules(h, b, 'p')
        assert not any(r['ref'].startswith(('rules.', 'net_settings.')) for r in reverse)
        (b/'p.kicad_pro').write_text('{invalid', encoding='utf-8')
        assert any(r['detail']['kind'] == 'unavailable' for r in diff_rules(b, h, 'p'))


test_br03_typed_rules()
print("ok BR03 typed rules, assignments and stackup")


def test_br03_cmd_copper():
    from kicad_review import cmd_copper
    from unittest.mock import patch
    import subprocess
    with tempfile.TemporaryDirectory() as td:
        old = os.getcwd(); os.chdir(td)
        try:
            projects = [{"dir": "p", "name": "p"}, {"dir": "q", "name": "q"}]
            write('review', {'detect.json': json.dumps({'projects': projects})})
            write('base', {'p/p.kicad_pcb': 'board', 'q/q.kicad_pcb': 'board'})
            write('head', {'q/q.kicad_pcb': 'board'})
            ok = subprocess.CompletedProcess([], 0, json.dumps({'rows': [], 'incomplete': []}), '')
            outcomes = [ok, subprocess.TimeoutExpired('python', 240),
                        subprocess.CalledProcessError(2, ['python'], stderr='failed'),
                        OSError('missing interpreter'), subprocess.CompletedProcess([], 0, 'not json', '')]
            for outcome in outcomes:
                with patch('kicad_review.subprocess.run', side_effect=[outcome, ok]) as run, _contextlib.redirect_stderr(io.StringIO()) as stderr:
                    cmd_copper(None)
                if outcome is ok:
                    assert stderr.getvalue() == ''
                else:
                    assert 'p: copper unavailable:' in stderr.getvalue()
                    if isinstance(outcome, subprocess.CalledProcessError):
                        assert 'returned non-zero exit status 2' in stderr.getvalue()
                    elif isinstance(outcome, OSError):
                        assert 'missing interpreter' in stderr.getvalue()
                    elif isinstance(outcome, subprocess.TimeoutExpired):
                        assert 'timed out after 240 seconds' in stderr.getvalue()
                    else:
                        assert 'Expecting value' in stderr.getvalue()
                assert run.call_count == 2, 'BR03 copper failure stopped subsequent project'
                first, second = run.call_args_list
                assert first.kwargs == {'capture_output': True, 'text': True, 'timeout': 240, 'check': True}
                assert second.kwargs['timeout'] == 420
                assert first.args[0][-2:] == ['base/p/p.kicad_pcb', '-']
                assert second.args[0][-2:] == ['base/q/q.kicad_pcb', 'head/q/q.kicad_pcb']
                result = json.loads(pathlib.Path('review/p/copper-diff.json').read_text())
                assert result['rows'] == []
                assert bool(result['incomplete']) == (outcome is not ok)
                if outcome is not ok: assert result['incomplete'][0]['channel'] == 'routing'
                assert json.loads(pathlib.Path('review/q/copper-diff.json').read_text()) == {'rows': [], 'incomplete': []}
            pathlib.Path('base/p/p.kicad_pcb').unlink(); write('head', {'p/p.kicad_pcb': 'board'})
            with patch('kicad_review.subprocess.run', return_value=ok) as run: cmd_copper(None)
            assert run.call_args_list[0].args[0][-2:] == ['-', 'head/p/p.kicad_pcb']
        finally: os.chdir(old)
    w = pathlib.Path('.github/workflows/review.yml').read_text()
    render = w.index('python3 tools/kicad_review.py render')
    assert render < w.index('fi', render) < w.index('python3 tools/kicad_review.py copper')


import pathlib
test_br03_cmd_copper()
print("ok BR03 cmd_copper bounded orchestration")

# BR03 Task 6.1: one bounded, validated netlist export shared by electrical and interfaces consumers.
BR03_EMPTY_NETLIST = '(export (components) (nets))'


BR03_BAD_PROJECTION = '(export (components (comp (ref (bad)))) (nets))'
bad_netlists = ['(export)','(export (components))','(other (nets))',
    '(export (nets) (nets))','junk (export (nets))','(export (nets))(garbage)',
    '(export (nets)','(export (nets) trailing)',
    '(export (nets (net (name A) (node (ref U1)))))',
    '(export (nets (net (name A) (node (ref U1) (pin (bad))))))',
    '(export (nets (net (node (ref U1) (pin 1)))))',
    '(export-other (nets))',BR03_BAD_PROJECTION]


def test_br03_netlist_export():
    import subprocess
    from unittest.mock import patch
    from kicad_review import export_netlist, validate_netlist, read_netlist, validated_net_members
    with tempfile.TemporaryDirectory() as td:
        target, pending, marker = (pathlib.Path(td)/n for n in
                                  ('netlist.net','netlist.pending.net','netlist.net.error'))
        cases = [(7,BR03_EMPTY_NETLIST,'failed after partial output'),
                 (0,None,''),(0,'(export)',''),(0,'(export (nets))(garbage)',''),
                 (0,'(export (nets)',''),(0,'(export-other (nets))',''),(0,BR03_BAD_PROJECTION,''),
                 (None,None,'timeout'),(None,None,'oserror')]
        def export_result(cmd, **kwargs):
            assert not target.exists() and not marker.exists() and not pending.exists(), 'stale export not cleared'
            assert pathlib.Path(cmd[cmd.index('-o')+1]) == pending, 'non-atomic output path'
            if body is not None: pending.write_text(body,encoding='utf-8')
            if error == 'timeout': raise subprocess.TimeoutExpired(cmd,60)
            if error == 'oserror': raise OSError('executable unavailable')
            return subprocess.CompletedProcess(cmd,rc,stdout='',stderr=error)
        for rc,body,error in cases:
            for f in (target,pending,marker): f.write_text('stale evidence')
            with patch('kicad_review.subprocess.run',side_effect=export_result) as run, \
                 _contextlib.redirect_stderr(io.StringIO()) as stderr:
                export_netlist('p.kicad_sch',td)
            assert run.call_count == 1 and run.call_args.kwargs['timeout'] == 60
            assert not target.exists() and not pending.exists(), 'BR03 failed export reused stale evidence'
            reason=marker.read_text(encoding='utf-8')
            assert reason and len(reason)<=500 and '\n' not in reason
            assert reason in stderr.getvalue()
            if error == 'failed after partial output': assert error in reason
            target.write_text(BR03_EMPTY_NETLIST)  # marker takes precedence over stale-but-valid output
            try: read_netlist(td)
            except ValueError as exc: assert reason in str(exc)
            else: raise AssertionError('BR03 marker ignored')
        rc,body,error = 0,BR03_EMPTY_NETLIST,''
        pending.write_text('stale pending')
        with patch('kicad_review.subprocess.run',side_effect=export_result), \
             patch('kicad_review.os.replace',wraps=os.replace) as replace:
            export_netlist('p.kicad_sch',td)
        replace.assert_called_once_with(pending,target)
        assert read_netlist(td)==BR03_EMPTY_NETLIST and not marker.exists() and not pending.exists()
        # A long multi-line diagnostic stays one capped line.
        rc,body,error = 3,None,'line one\nline two ' + 'x'*900
        with patch('kicad_review.subprocess.run',side_effect=export_result), \
             _contextlib.redirect_stderr(io.StringIO()):
            export_netlist('p.kicad_sch',td)
        reason = marker.read_text(encoding='utf-8')
        assert len(reason) == 500 and '\n' not in reason and 'line one line two' in reason
        # Empty nets are valid evidence, and numeric pin names plus escaped quotes stay strings.
        validate_netlist(r'(export (nets (net (name "A\\\"B") (node (ref U1) (pin "12")))))')
        # Since spec 01, render_side also walks sheet pages; stub it so only the netlist branch is observed.
        with patch('kicad_review.os.path.exists',side_effect=lambda f:str(f).endswith('.kicad_sch')), \
             patch('kicad_review.kicad_cli'), patch('kicad_review.sheet_pages',return_value=[]), \
             patch('kicad_review.export_netlist') as export:
            kr.render_side('src','p',td,netlist=True)
            export.assert_called_once_with('src/p.kicad_sch',td)
    for text in bad_netlists:
        try:
            validated_net_members(text,{},"b"*40)
            raise AssertionError("BR03 malformed netlist accepted: "+text)
        except ValueError:
            pass
    assert validated_net_members('(export (nets))',{},'b'*40) == ({},{},[])
    for text in ('(export (nets))(garbage)', '(export (nets)'):
        try: validated_net_members(text,{},'b'*40)
        except ValueError: pass
        else: raise AssertionError('trailing or truncated netlist accepted')
    # Interfaces-off still schedules one schematic export per present revision.
    with tempfile.TemporaryDirectory() as td:
        old=os.getcwd(); os.chdir(td)
        try:
            settings=kr.load_settings()
            settings["checks"]["interfaces"]="off"
            settings["checks"]["release"]="off"
            settings["3d"]["enabled"]=False
            settings["libraries"]["enabled"]=False
            write("review",{"detect.json":json.dumps({"projects":[{"dir":"p","name":"p","status":"modified"}]})})
            with patch("kicad_review.load_settings",return_value=settings), \
                 patch("kicad_review.render_side") as render, patch("kicad_review.cache_renders"), \
                 _contextlib.redirect_stdout(io.StringIO()):
                kr.cmd_render(None)
            assert len(render.call_args_list)==2
            assert all(c.kwargs["netlist"] is True for c in render.call_args_list)
        finally: os.chdir(old)


def test_br03_interfaces_unavailable():
    from unittest.mock import patch
    with tempfile.TemporaryDirectory() as td:
        old=os.getcwd(); os.chdir(td)
        try:
            p={'dir':'p','name':'p'}; out=pathlib.Path('review/p')
            for side in ('base','head'):
                write(side,{'p/p.kicad_sch':'(kicad_sch)'})
                write(str(out/side),{'netlist.net':BR03_EMPTY_NETLIST})
            for level in ('required','informational'):
                settings=kr.load_settings(); settings['checks']['interfaces']=level
                for side in ('base','head'):
                    target=out/side/'netlist.net'; marker=out/side/'netlist.net.error'
                    for failure in ('missing','malformed','marker'):
                        target.write_text(BR03_EMPTY_NETLIST)
                        if failure=='missing': target.unlink()
                        elif failure=='malformed': target.write_text('(export)')
                        else: marker.write_text('boom: library table')
                        with patch('kicad_review.export_netlist') as export:
                            result=kr.interface_check(p,settings,{'base':{},'head':{}},str(out))
                        export.assert_not_called()
                        assert result['status']=='not_run' and result['incomplete'] is True
                        assert side in result['reason'] and 'unavailable' in result['reason']
                        if failure=='marker': assert 'boom: library table' in result['reason']
                        assert result['level']==level
                        assert result['violations']==[] and not any(result[k] for k in
                            ('errors','warnings','new_errors','new_warnings','fixed'))
                        marker.unlink(missing_ok=True); target.write_text(BR03_EMPTY_NETLIST)
                assert kr.interface_check(p,settings,{'base':{},'head':{}},str(out))['status']=='pass'
            pathlib.Path('base/p/p.kicad_sch').unlink()
            (out/'base/netlist.net').unlink()
            assert kr.interface_check(p,settings,{'base':{},'head':{}},str(out))['status']=='pass'
            pathlib.Path('head/p/p.kicad_sch').unlink()
            missing = kr.interface_check(p,settings,{'base':{},'head':{}},str(out))
            assert missing['reason']=='no schematic' and 'incomplete' not in missing
        finally: os.chdir(old)


test_br03_netlist_export()
test_br03_interfaces_unavailable()
print("ok BR03 shared bounded netlist evidence and interfaces unavailable result")


# BR03 Task 6.3: pairwise electrical assembly never turns unknown schematic evidence into removals.
def test_br03_electrical_pair():
    from kicad_review import electrical_changes, read_copper
    with tempfile.TemporaryDirectory() as td:
        old=os.getcwd(); os.chdir(td)
        try:
            p={"dir":"p","name":"p"}; out=pathlib.Path("review/p")
            text='(export (nets (net (name A) (node (ref U1) (pin 1)))))'
            good={"/a":obj("U1","1","/")}
            ambiguous={**good,"/b":obj("U1","1","/")}
            for side in ("base","head"):
                write(side,{"p/p.kicad_sch":"(kicad_sch)"})
                write(str(out/side),{"netlist.net":text})
            for objects in ({"base":good,"head":ambiguous},{"base":ambiguous,"head":good}):
                rows,issues=electrical_changes(p,str(out),objects,{"base":"b"*40,"head":"h"*40})
                assert any(i["channel"]=="wiring" and i.get("unknown") for i in issues)
                assert not any(r["kind"].startswith("net-") for r in rows), "BR03 fabricated ambiguous removal"
            for side in ("base","head"):
                for bad in bad_netlists:
                    (out/side/"netlist.net").write_text(bad)
                    rows,issues=electrical_changes(p,str(out),{"base":good,"head":good},{})
                    assert any(i["channel"]=="wiring" for i in issues)
                    assert not any(r["kind"].startswith("net-") for r in rows)
                (out/side/"netlist.net").write_text(text)
            for side in ("base","head"):
                file=out/side/"netlist.net"; file.unlink()
                rows,issues=electrical_changes(p,str(out),{"base":good,"head":good},{})
                assert any(i["channel"]=="wiring" for i in issues)
                assert not any(r["kind"].startswith("net-") for r in rows)
                file.write_text(text)
                marker=out/side/'netlist.net.error'; marker.write_text('boom: timed out after 60 seconds')
                with patch('kicad_review.export_netlist') as export:
                    rows,issues=electrical_changes(p,str(out),{'base':good,'head':good},{})
                export.assert_not_called()
                assert any(i['channel']=='wiring' for i in issues)
                assert not any(r['kind'].startswith('net-') for r in rows), 'BR03 ignored netlist error marker'
                marker.unlink()
            file=out/"copper-diff.json"
            artifact={"rows":[{"net":"GND","layer":"F.Cu","addedMm2":1,"removedMm2":0,
                        "addedContours":[[[0,0],[1,0],[1,1]]],"removedContours":[]}],"incomplete":[]}
            for field in ("area","point"):
                bad=json.loads(json.dumps(artifact))
                if field=="area": bad["rows"][0]["addedMm2"]=10**399
                else: bad["rows"][0]["addedContours"][0][0][0]=10**399
                file.write_text(json.dumps(bad)); assert read_copper(file)[0]==[] and read_copper(file)[1]
        finally: os.chdir(old)


def test_br03_pad_evidence():
    from kicad_review import electrical_changes
    with tempfile.TemporaryDirectory() as td:
        old=os.getcwd(); os.chdir(td)
        try:
            p={"dir":"p","name":"p"}; out=pathlib.Path("review/p")
            def schematic(net):
                node='(net (name '+net+') (node (ref D1) (pin C)))' if net else ''
                return ('(export (components (comp (ref D1) (libsource (lib Device) (part D))))'
                        '(libparts (libpart (lib Device) (part D) (pins (pin (num C)))))'
                        '(nets '+node+'))')
            def assembled(board_before,board_after,sch_before,sch_after,fail=False):
                objects={}
                for side,net,sch in (("base",board_before,sch_before),("head",board_after,sch_after)):
                    write(side,{"p/p.kicad_sch":"(kicad_sch)","p/p.kicad_pcb":br03_pcb("fp",[("pad","C",0,net)])})
                    write(str(out/side),{"netlist.net":"broken" if fail else schematic(sch)})
                    objects[side]={**kr.pcb_objects(pathlib.Path(side,"p/p.kicad_pcb")),
                                   "/d":obj("D1","1","/")}
                write(str(out),{"copper-diff.json":json.dumps({"rows":[],"incomplete":[]})})
                rows,issues=electrical_changes(p,str(out),objects,{})
                return next(r for r in rows if r["detail"]["kind"]=="pad-net")["detail"]
            assert assembled("A","","A","")["boardOnly"] is False, "BR03 synchronized disconnection misclassified"
            assert assembled("","A","","A")["boardOnly"] is False
            assert assembled("A","B","A","A")["boardOnly"] is True
            unknown=assembled("A","B","A","B",fail=True)
            assert unknown["boardOnly"] is None and "unknown" in unknown["evidenceNote"]
        finally: os.chdir(old)
    from kicad_review import schematic_pin_ids
    d={"/d":obj("D1","1","/")}
    pins='(pins (pin (num C)))'
    assert schematic_pin_ids('(export (components (comp (ref D1) (libsource (lib Device) (part D))))'
                             '(libparts (libpart (lib Device) (part D) '+pins+')) (nets))',d)=={"D1.C"}
    for comp,lib in (('(comp (ref D1))','(libpart '+pins+')'),
                     ('(comp (ref D1) (libsource (lib Device) (part D)))','(libpart (lib Device) '+pins+')'),
                     ('(comp (ref D1) (libsource (lib Device)))','(libpart (lib Device) '+pins+')'),
                     ('(comp (ref D1) (libsource (lib "") (part "")))','(libpart (lib "") (part "") '+pins+')'),
                     ('(comp (ref D1) (libsource (lib (x)) (part D)))','(libpart (lib (x)) (part D) '+pins+')')):
        text='(export (components '+comp+') (libparts '+lib+') (nets))'
        assert schematic_pin_ids(text,d)==set(), "BR03 missing library identity proved a disconnected pin: "+text


test_br03_electrical_pair()
test_br03_pad_evidence()
print("ok BR03 pairwise electrical assembly and pad evidence")
# Board inspection adapter: derive mm-units inspection graph and facts from retained scene
scene = {'copperStack':['F.Cu','In1.Cu','In2.Cu','B.Cu'],
         'nets':[{'id':1,'name':'12'}], 'warnings':[], 'complete':True,
         'objects':[{'kind':'track','uuid':'t','changeUuid':'t','ref':'12',
                     'layers':['In1.Cu'],'net':1,'side':None,
                     'geometry':{'segments':[[0,0,3000,4000,200]]},'box':[0,0,3000,4000]}]}
g = kr.board_inspect(scene)
assert g['tracks'][0]['net'] == '12'
assert g['tracks'][0]['width'] == .2
assert g['stats']['routedLengthMm'] == 5
assert g['stats']['copperLayers'] == 4
assert g['stats']['boardSizeMm'] is None
assert not any(g['truncated'].values())


# Board inspection parser consumer: exact names, physical spans, duplicate pads, custom polygons, arcs, no outline.
inspection_text = '''(kicad_pcb (version 20260206)
 (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal))
 (segment (start 0 0) (end 3 4) (width .2) (layer "In1.Cu") (net "12") (uuid digits))
 (arc (start 0 0) (mid 1 1) (end 2 0) (width .2) (layer "F.Cu") (net "12") (uuid arc1))
 (via blind (at 1 1) (size .8) (drill .4) (layers "F.Cu" "In1.Cu") (net "12") (uuid blind))
 (footprint "Test:D" (layer "F.Cu") (at 10 10) (uuid fp)
  (property "Reference" "U1")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "12") (uuid p1))
  (pad "1" smd custom (at 2 0) (size 1 1) (layers "F.Cu") (net "12")
   (options (clearance outline) (anchor rect))
   (primitives (gr_poly (pts (xy 0 0) (xy 2 0) (xy 1 2)) (width .1) (fill yes))) (uuid p2))
  (pad "9" smd star (at 4 0) (size 1 1) (layers "F.Cu") (uuid p3))))'''
inspection = kr.board_inspect(scene_from_text(inspection_text))
assert [n['name'] for n in inspection['nets']] == ['12'], inspection['nets']
assert inspection['tracks'] and all(t['net'] == '12' for t in inspection['tracks'])
assert {t['layer'] for t in inspection['tracks']} == {'F.Cu', 'In1.Cu'}
assert all('hidden' in r for r in inspection['tracks'] + inspection['pads'] + inspection['vias'])
# Inspection preserves hidden copper (including inherited footprint visibility),
# rather than silently dropping it and changing diagnostic/count provenance.
hidden_inspection = kr.board_inspect(scene_from_text(inspection_text
    .replace('(uuid digits)', '(uuid digits) (hide yes)')
    .replace('(uuid blind)', '(uuid blind) (hide yes)')
    .replace('(uuid fp)', '(uuid fp) (hide yes)')))
assert all(p['hidden'] for p in hidden_inspection['pads'])
assert all(v['hidden'] for v in hidden_inspection['vias'])
assert all(t['hidden'] == (t['uuid'] == 'digits') for t in hidden_inspection['tracks'])
assert not any(r['hidden'] for r in inspection['tracks'] + inspection['pads'] + inspection['vias'])
assert hidden_inspection['stats'] == inspection['stats']
assert hidden_inspection['unsupported'] == inspection['unsupported']
print('ok board inspection preserves hidden copper and count provenance')
straight = [t for t in inspection['tracks'] if t['kind'] == 'track']
assert len(straight) == 1 and (straight[0]['layer'], straight[0]['x2'], straight[0]['y2']) == ('In1.Cu', 3.0, 4.0), straight
arc_parts = [t for t in inspection['tracks'] if t['kind'] == 'arc']
assert len(arc_parts) > 2, 'arc keeps its tessellation, not one chord'
arc_length = sum(((t['x2'] - t['x1']) ** 2 + (t['y2'] - t['y1']) ** 2) ** .5 for t in arc_parts)
assert 3.0 < arc_length < 3.2, arc_length  # semicircle of radius 1 mm
assert abs(inspection['stats']['routedLengthMm'] - (5 + arc_length)) < 1e-3, inspection['stats']
via, = inspection['vias']
assert via['net'] == '12' and via['layers'] == ['F.Cu', 'In1.Cu']
assert (via['fromLayer'], via['toLayer'], via['diameter'], via['drill']) == ('F.Cu', 'In1.Cu', .8, .4), via
pads = inspection['pads']
assert [p['pin'] for p in pads] == ['1', '1'], pads  # duplicate numbers stay distinct records
assert len({p['uuid'] for p in pads}) == 2 and pads[0]['ref'] == 'U1' and pads[0]['net'] == '12'
assert pads[1]['shape'] == 'rect' and len(pads[1]['custom']) == 1 and len(pads[1]['custom'][0]) == 3, pads[1]
assert inspection['unsupported'] == {'pads': 1, 'vias': 0, 'tracks': 0, 'footprintGraphics': 0}, inspection['unsupported']
assert any('unsupported pad shape star' in w['reason'] for w in inspection['warnings'])
assert inspection['stats']['boardSizeMm'] is None
assert inspection['truncated'] == {k: False for k in ('nets', 'pads', 'tracks', 'vias', 'footprintGraphics')}

# Stats: CLI facts decide outline and counts only when present; graph counts and absent sizes are labelled.
cli = {'board': {'has_outline': True, 'width': '100.0000 mm', 'height': '80 mm'},
       'pads': {'through_hole': 2, 'smd': 3, 'npth': 1}, 'vias': {'through': 4, 'blind': 1}}
sized = kr.board_inspect(scene_from_text(inspection_text), cli)
assert sized['stats']['boardSizeMm'] == [100.0, 80.0]
assert (sized['stats']['padCount'], sized['stats']['viaCount'], sized['stats']['countsSource']) == (6, 5, 'kicad-cli')
no_outline = kr.board_inspect(scene_from_text(inspection_text), dict(cli, board={'has_outline': False, 'width': '100 mm', 'height': '80 mm'}))
assert no_outline['stats']['boardSizeMm'] is None
graph_only = kr.board_inspect(scene_from_text(inspection_text), {'board': {'has_outline': True, 'width': 'nan', 'height': None}})
assert graph_only['stats']['boardSizeMm'] is None and graph_only['stats']['countsSource'] == 'inspection-graph'
assert graph_only['stats']['padCount'] == len(graph_only['pads'])
assert kr.stats_number('12.5 mm') == 12.5 and kr.stats_number('nan') is None
print('ok board inspection parser consumer and stats provenance')

# Producer-backed picker records: generated by this checked-in test, never handcrafted.
fixture_dir = Path(__file__).parent / 'ui' / 'fixtures'
board = (fixture_dir / 'vf-order-4.kicad_pcb').read_text()
# Declare mask only in this writable synthetic source; the order fixture has copper only.
board = board.replace('(layers ', '(layers (1 "F.Mask" user) ', 1)
pick_pads = [
 '(pad "1" smd rect (at 10 10) (size 2 2) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.2))',
 '(pad "2" thru_hole circle (at 20 10) (size 2 2) (drill 0.5) (layers "*.Cu" "*.Mask"))',
 '(pad "3" thru_hole oval (at 30 10) (size 2 3) (drill oval 0.5 1.0) (layers "*.Cu" "*.Mask"))',
 '(pad "4" smd custom (at 40 10) (size 1 1) (layers "F.Cu") (options (clearance outline) (anchor rect)) (primitives (gr_line (start 0 0) (end 5 0) (width 0.4))))',
 '(pad "5" smd custom (at 50 10) (size 1 1) (layers "F.Cu") (options (clearance outline) (anchor rect)) (primitives (gr_arc (start 3 0) (mid 4 1) (end 3 2) (width 0.4))))',
 '(pad "6" smd custom (at 60 10) (size 1 1) (layers "F.Cu") (options (clearance outline) (anchor rect)) (primitives (gr_poly (pts (xy 3 0) (xy 5 0) (xy 4 2)) (width 0.4) (fill no))))']
pick_footprint = '(footprint "picker" (layer "F.Cu") (at 0 0) (uuid "picker") (property "Reference" "J1") ' + ''.join(pick_pads) + ')'
with TemporaryDirectory() as d:
    source = Path(d, 'picker.kicad_pcb')
    source.write_text(board.rstrip()[:-1] + pick_footprint + ')')
    records = kr.board_inspect(kr.board_geometry(source))
by_pin = {r['pin']: r for r in records['pads']}
assert by_pin['1']['geometry']['primitive'] and by_pin['1']['geometry']['layerPrimitives']['F.Mask']
for pin in ('2', '3'):
    drill = by_pin[pin]['geometry']['drill']
    assert 'shape' not in drill and set(('center', 'size', 'angle', 'plated')) <= drill.keys()
for pin in ('4', '5', '6'): assert by_pin[pin]['geometry']['segments']
(fixture_dir / 'image-pick-records.json').write_text(json.dumps(records, sort_keys=True) + '\n')
print('ok producer-backed image pick records')

# Task 4: write_image_assets and image_pair
blobs = {}
key = kr.add_blob(blobs, '{"version":1,"units":"mm","views":[]}')
raw = gzip.decompress(base64.b64decode(blobs[key]))
assert json.loads(raw)['version'] == 1
with tempfile.TemporaryDirectory() as d:
    kr.write_image_assets(blobs, {key:{'kind':'json','name':'sheet-hotspots.json'}}, d)
    assert pathlib.Path(d, key+'.json.gz').read_bytes() == base64.b64decode(blobs[key])
assert kr.image_pair(None, 'head-id') == {'base':None, 'head':'head-id'}


blobs={}
svg_id=kr.add_blob(blobs,'<svg viewBox="0 0 10 10"></svg>')
json_id=kr.add_blob(blobs,'{"version":1,"views":[]}')
for head_only in (False,True):
    pair=lambda key: {'base':None if head_only else key,'head':key}
    data={'version':1,'base':None if head_only else 'a'*40,'head':'b'*40,
          'projects':[{'sheets':[{'svg':pair(svg_id),'svgThemes':{'light':pair(svg_id)},
                                  'hotspots':pair(json_id)}],
                       'board':{'layers':[{'svg':pair(svg_id),'svgThemes':{'light':pair(svg_id)}}],
                                'inspect':pair(json_id)}}], 'blobs':copy.deepcopy(blobs)}
    if head_only: data['mode']='single'
    with TemporaryDirectory() as d, patch.object(kr,'inline_page',side_effect=lambda script:script):
        html=kr.finalize_report(data,d)
        embedded=json.loads(html.removeprefix('window.REVIEW_DATA = ').removesuffix(';'))
        assert embedded['assets']=={svg_id:{'kind':'svg','name':'layer.svg'},
                                    json_id:{'kind':'json','name':'board-inspect.json'}}
        assert embedded['blobs']==blobs and embedded['base']==data['base']
        assert pathlib.Path(d,svg_id+'.svg.gz').read_bytes()==base64.b64decode(blobs[svg_id])
        assert pathlib.Path(d,json_id+'.json.gz').read_bytes()==base64.b64decode(blobs[json_id])
        assert set(p.name for p in pathlib.Path(d).iterdir())=={svg_id+'.svg.gz',json_id+'.json.gz'}
with TemporaryDirectory() as d, patch.object(kr,'inline_page',side_effect=lambda script:script):
    legacy={'version':1,'projects':[{'sheets':[],'board':{'layers':[]}}],'blobs':{}}
    kr.finalize_report(legacy,d)
    assert legacy['assets']=={} and legacy['blobs']=={}


def missing_side_projects(change_offset=0):
    # Cumulative change_offset mirrors production, so scene changeIds resolve to unique rows.
    order_board = pathlib.Path(__file__).resolve().parent.joinpath('ui/fixtures/vf-order-4.kicad_pcb').read_text()
    old = os.getcwd()
    blobs, projects = {}, []
    offset = change_offset
    with TemporaryDirectory() as directory:
        try:
            os.chdir(directory)
            settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
            for name in ('parts','threads','issues','inventory','libraries','3d'):
                settings[name]['enabled'] = False
            settings['checks'] = {k:'off' for k in settings['checks']}
            for kind in ('sheet','board'):
                for present, status in (('head','added'),('base','removed')):
                    name = f'{status}-{kind}'
                    desc = {'dir':name,'name':'H','status':status}
                    out = f'review/{kr.project_id(name)}/{present}'
                    source = f'{present}/{name}'
                    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><path stroke="#009600" fill="none" d="M 5 5 L 95 75"/></svg>'
                    files = {f'{out}/sch/H.svg':svg,
                             f'{source}/H.kicad_sch':'(kicad_sch (uuid root) (paper A4) (symbol (uuid moved) (at 50 40 0) (property "Reference" "U1") (property "Value" "test")))'} if kind == 'sheet' else {
                        f'{source}/H.kicad_pcb':order_board, f'{out}/pcb/H-F_Cu.svg':svg}
                    files[f'{out}/erc.json'] = json.dumps({'violations':[]})
                    files[f'{out}/drc.json'] = json.dumps({'violations':[], 'unconnected_items':[]})
                    write('.', files)
                    project = kr.build_project(desc, blobs, settings, change_offset=offset)
                    offset += len(project['changes'])
                    absent = 'base' if present == 'head' else 'head'
                    rows = project['sheets'] if kind == 'sheet' else project['board']['layers']
                    assert rows, (kind, present)
                    assert project['board']['status'] == status if kind == 'board' else rows[0]['status'] == status
                    for row in rows:
                        assert row['svg'][absent] is None
                        key = row['svg'][present]
                        assert key in blobs and '<svg' in gzip.decompress(base64.b64decode(blobs[key])).decode()
                        assert row['svgThemes']['light'][absent] is None
                        assert row['svgThemes']['dark'][absent] is None
                    if kind == 'sheet':
                        assert rows[0]['hotspots'][absent] is None
                        assert rows[0]['hotspots'][present] in blobs
                    else:
                        assert project['board']['inspect'][absent] is None
                        assert project['board']['inspect'][present] in blobs
                    assert project['changes'], 'present-side legacy picking needs real changes'
                    projects.append(project)
        finally:
            os.chdir(old)
    return projects, blobs


# Runnable image fixture generator: real KiCad 10.0.0 exports, no CLI needed to regenerate.
IMAGE_LAYER_EXPORTS = {'In2_Cu': '<?xml version="1.0" standalone="no"?>\n <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" \n "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"> \n<svg\n  xmlns:svg="http://www.w3.org/2000/svg"\n  xmlns="http://www.w3.org/2000/svg"\n  xmlns:xlink="http://www.w3.org/1999/xlink"\n  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n  version="1.1"\n  width="297.0022mm" height="210.0072mm" viewBox="0.0000 0.0000 297.0022 210.0072">\n<title>KiCad 10 synthetic four-layer export</title>\n  <desc>Image generated by PCBNEW </desc>\n<g style="fill:#000000; fill-opacity:1.0000;stroke:#000000; stroke-opacity:1.0000;\nstroke-linecap:round; stroke-linejoin:round;"\n transform="translate(0 0) scale(1 1)">\n</g>\n<g style="fill:none; \nstroke:#CE7D2C; stroke-width:2.0000; stroke-opacity:1; \nstroke-linecap:round; stroke-linejoin:round;">\n<path d="M2.0000 5.0000\nL18.0000 5.0000\n" />\n</g> \n</svg>\n', 'F_Cu': '<?xml version="1.0" standalone="no"?>\n <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" \n "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"> \n<svg\n  xmlns:svg="http://www.w3.org/2000/svg"\n  xmlns="http://www.w3.org/2000/svg"\n  xmlns:xlink="http://www.w3.org/1999/xlink"\n  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n  version="1.1"\n  width="297.0022mm" height="210.0072mm" viewBox="0.0000 0.0000 297.0022 210.0072">\n<title>KiCad 10 synthetic four-layer export</title>\n  <desc>Image generated by PCBNEW </desc>\n<g style="fill:#000000; fill-opacity:1.0000;stroke:#000000; stroke-opacity:1.0000;\nstroke-linecap:round; stroke-linejoin:round;"\n transform="translate(0 0) scale(1 1)">\n</g>\n<g style="fill:none; \nstroke:#C83434; stroke-width:2.0000; stroke-opacity:1; \nstroke-linecap:round; stroke-linejoin:round;">\n<path d="M2.0000 5.0000\nL18.0000 5.0000\n" />\n</g> \n</svg>\n', 'B_Cu': '<?xml version="1.0" standalone="no"?>\n <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" \n "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"> \n<svg\n  xmlns:svg="http://www.w3.org/2000/svg"\n  xmlns="http://www.w3.org/2000/svg"\n  xmlns:xlink="http://www.w3.org/1999/xlink"\n  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n  version="1.1"\n  width="297.0022mm" height="210.0072mm" viewBox="0.0000 0.0000 297.0022 210.0072">\n<title>KiCad 10 synthetic four-layer export</title>\n  <desc>Image generated by PCBNEW </desc>\n<g style="fill:#000000; fill-opacity:1.0000;stroke:#000000; stroke-opacity:1.0000;\nstroke-linecap:round; stroke-linejoin:round;"\n transform="translate(0 0) scale(1 1)">\n</g>\n<g style="fill:none; \nstroke:#4D7FC4; stroke-width:2.0000; stroke-opacity:1; \nstroke-linecap:round; stroke-linejoin:round;">\n<path d="M2.0000 5.0000\nL18.0000 5.0000\n" />\n</g> \n</svg>\n', 'In1_Cu': '<?xml version="1.0" standalone="no"?>\n <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" \n "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"> \n<svg\n  xmlns:svg="http://www.w3.org/2000/svg"\n  xmlns="http://www.w3.org/2000/svg"\n  xmlns:xlink="http://www.w3.org/1999/xlink"\n  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n  version="1.1"\n  width="297.0022mm" height="210.0072mm" viewBox="0.0000 0.0000 297.0022 210.0072">\n<title>KiCad 10 synthetic four-layer export</title>\n  <desc>Image generated by PCBNEW </desc>\n<g style="fill:#000000; fill-opacity:1.0000;stroke:#000000; stroke-opacity:1.0000;\nstroke-linecap:round; stroke-linejoin:round;"\n transform="translate(0 0) scale(1 1)">\n</g>\n<g style="fill:none; \nstroke:#7FC87F; stroke-width:2.0000; stroke-opacity:1; \nstroke-linecap:round; stroke-linejoin:round;">\n<path d="M2.0000 5.0000\nL18.0000 5.0000\n" />\n</g> \n</svg>\n'}

# KiCad 10.0.0 export of synthetic 0.4 mm "R16 10k" text; paths, not browser fonts.
IMAGE_TINY_TEXT = '<g class="stroked-text" style="fill:none;stroke:#009600;stroke-width:0.1;stroke-linecap:round;stroke-linejoin:round"><desc>R16 10k</desc>\n<path d="M149.0475 129.9298 L148.9141 129.7393 " />\n<path d="M148.8189 129.9298 L148.8189 129.5298 " />\n<path d="M148.8189 129.5298 L148.9713 129.5298 " />\n<path d="M148.9713 129.5298 L149.0094 129.5488 " />\n<path d="M149.0094 129.5488 L149.0284 129.5679 " />\n<path d="M149.0284 129.5679 L149.0475 129.6060 " />\n<path d="M149.0475 129.6060 L149.0475 129.6631 " />\n<path d="M149.0475 129.6631 L149.0284 129.7012 " />\n<path d="M149.0284 129.7012 L149.0094 129.7203 " />\n<path d="M149.0094 129.7203 L148.9713 129.7393 " />\n<path d="M148.9713 129.7393 L148.8189 129.7393 " />\n<path d="M149.4284 129.9298 L149.1998 129.9298 " />\n<path d="M149.3141 129.9298 L149.3141 129.5298 " />\n<path d="M149.3141 129.5298 L149.2760 129.5869 " />\n<path d="M149.2760 129.5869 L149.2379 129.6250 " />\n<path d="M149.2379 129.6250 L149.1998 129.6441 " />\n<path d="M149.7713 129.5298 L149.6951 129.5298 " />\n<path d="M149.6951 129.5298 L149.6570 129.5488 " />\n<path d="M149.6570 129.5488 L149.6380 129.5679 " />\n<path d="M149.6380 129.5679 L149.5999 129.6250 " />\n<path d="M149.5999 129.6250 L149.5808 129.7012 " />\n<path d="M149.5808 129.7012 L149.5808 129.8536 " />\n<path d="M149.5808 129.8536 L149.5999 129.8917 " />\n<path d="M149.5999 129.8917 L149.6189 129.9108 " />\n<path d="M149.6189 129.9108 L149.6570 129.9298 " />\n<path d="M149.6570 129.9298 L149.7332 129.9298 " />\n<path d="M149.7332 129.9298 L149.7713 129.9108 " />\n<path d="M149.7713 129.9108 L149.7904 129.8917 " />\n<path d="M149.7904 129.8917 L149.8094 129.8536 " />\n<path d="M149.8094 129.8536 L149.8094 129.7584 " />\n<path d="M149.8094 129.7584 L149.7904 129.7203 " />\n<path d="M149.7904 129.7203 L149.7713 129.7012 " />\n<path d="M149.7713 129.7012 L149.7332 129.6822 " />\n<path d="M149.7332 129.6822 L149.6570 129.6822 " />\n<path d="M149.6570 129.6822 L149.6189 129.7012 " />\n<path d="M149.6189 129.7012 L149.5999 129.7203 " />\n<path d="M149.5999 129.7203 L149.5808 129.7584 " />\n<path d="M150.4952 129.9298 L150.2666 129.9298 " />\n<path d="M150.3809 129.9298 L150.3809 129.5298 " />\n<path d="M150.3809 129.5298 L150.3428 129.5869 " />\n<path d="M150.3428 129.5869 L150.3047 129.6250 " />\n<path d="M150.3047 129.6250 L150.2666 129.6441 " />\n<path d="M150.7429 129.5298 L150.7810 129.5298 " />\n<path d="M150.7810 129.5298 L150.8191 129.5488 " />\n<path d="M150.8191 129.5488 L150.8381 129.5679 " />\n<path d="M150.8381 129.5679 L150.8572 129.6060 " />\n<path d="M150.8572 129.6060 L150.8762 129.6822 " />\n<path d="M150.8762 129.6822 L150.8762 129.7774 " />\n<path d="M150.8762 129.7774 L150.8572 129.8536 " />\n<path d="M150.8572 129.8536 L150.8381 129.8917 " />\n<path d="M150.8381 129.8917 L150.8191 129.9108 " />\n<path d="M150.8191 129.9108 L150.7810 129.9298 " />\n<path d="M150.7810 129.9298 L150.7429 129.9298 " />\n<path d="M150.7429 129.9298 L150.7048 129.9108 " />\n<path d="M150.7048 129.9108 L150.6857 129.8917 " />\n<path d="M150.6857 129.8917 L150.6667 129.8536 " />\n<path d="M150.6667 129.8536 L150.6476 129.7774 " />\n<path d="M150.6476 129.7774 L150.6476 129.6822 " />\n<path d="M150.6476 129.6822 L150.6667 129.6060 " />\n<path d="M150.6667 129.6060 L150.6857 129.5679 " />\n<path d="M150.6857 129.5679 L150.7048 129.5488 " />\n<path d="M150.7048 129.5488 L150.7429 129.5298 " />\n<path d="M151.0477 129.9298 L151.0477 129.5298 " />\n<path d="M151.0858 129.7774 L151.2001 129.9298 " />\n<path d="M151.2001 129.6631 L151.0477 129.8155 " />\n</g>'


def augment_front_svg(text, original):
    root = ET.fromstring(text)
    x,y,w,h = map(float, root.get('viewBox').split())
    color = '#%02x%02x%02x' % tuple(original)
    for left, width, paint in ((.1,.3,color),(.25,.3,color),(.7,.1,'#abcdef')):
        ET.SubElement(root, '{http://www.w3.org/2000/svg}rect', {
            'x':str(x+left*w),'y':str(y+.3*h),'width':str(width*w),'height':str(.4*h),
            'fill':paint,'stroke':'none'})
    for attribute in list(root.attrib):
        if attribute == 'xmlns' or attribute.startswith('{http://www.w3.org/2000/xmlns/}'):
            del root.attrib[attribute]
    ns = '{http://www.w3.org/2000/svg}'
    for node in root.iter():
        if isinstance(node.tag, str) and node.tag.startswith(ns):
            node.tag = node.tag[len(ns):]
    root.attrib = {'xmlns': ns[1:-1], **root.attrib}
    serialized = ET.tostring(root, encoding='unicode')
    return '\n'.join(line.rstrip() for line in serialized.split('\n'))


def augment_front_svg_regressions():
    result = augment_front_svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>', [1, 2, 3])
    assert result.startswith('<svg xmlns='), result
    assert len(ET.fromstring(result)) == 3
    source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text data-note="keep ns0:attribute">keep ns0:text</text></svg>'
    label = ET.fromstring(augment_front_svg(source, [1, 2, 3])).find('{http://www.w3.org/2000/svg}text')
    assert label.text == 'keep ns0:text' and label.get('data-note') == 'keep ns0:attribute'
    print('ok standalone augmented SVG namespace and retained content')

augment_front_svg_regressions()


def build_augmented_image_project(desc, blobs, settings, committed_svg):
    out=pathlib.Path('review',kr.project_id(desc['dir']))
    for side in ('base','head'):
        for theme,folder in (('light','pcb'),('dark','pcb-dark')):
            front_path=out/side/folder/(desc['name']+'-F_Cu.svg')
            if not front_path.is_file(): continue
            original=kr.IMAGE_PALETTES[theme]['sourceRGB']['F.Cu']
            front_path.write_text(augment_front_svg(front_path.read_text(),original))
            if side == 'head' and theme == 'light':
                committed_svg.write_text(front_path.read_text())
    return kr.build_project(desc,blobs,settings)


def generate_image_fixture(destination, committed_svg):
    """Generate browser data into caller-owned paths through the real producer."""
    order_board = pathlib.Path('ui/fixtures/vf-order-4.kicad_pcb').read_text()
    settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
    for name in ('parts', 'threads', 'issues', 'inventory', 'libraries', '3d'):
        settings[name]['enabled'] = False
    settings['checks'] = {k: 'off' for k in settings['checks']}
    old = os.getcwd()
    image_blobs = {}
    try:
        with TemporaryDirectory() as directory:
            os.chdir(directory)
            desc = {'dir': 'images', 'name': 'Images', 'status': 'modified'}
            out = pathlib.Path('review', kr.project_id(desc['dir']))
            root = ('(kicad_sch (uuid root) (paper A4) ' +
                    sheet('Left', 'shared.kicad_sch', 'left') +
                    sheet('Right', 'shared.kicad_sch', 'right') + ')')
            for side in ('base', 'head'):
                x = 105 if side == 'base' else 107.54
                shared = f'''(kicad_sch (uuid child) (paper A4)
                  (lib_symbols (symbol "Test:Base"
                    (symbol "Base_0_1" (rectangle (start -1 -1) (end 1 1)))
                    (symbol "Base_2_1" (pin input line (at -5 0 0) (length 2)
                      (name "B") (number "3"))))
                    (symbol "Test:Op" (extends "Base")))
                  (symbol (uuid placed) (lib_id "Test:Op") (unit 2) (at {x} 55 0)
                    (property "Reference" "U?") (property "Value" "Op")
                    (instances (project "Images"
                      (path "/root/left" (reference "U1") (unit 2))
                      (path "/root/right" (reference "U2") (unit 2))))))'''
                write('.', {f'{side}/images/Images.kicad_sch': root,
                            f'{side}/images/shared.kicad_sch': shared,
                            f'{side}/images/Images.kicad_pcb': order_board,
                            f'{out}/{side}/erc.json': '{"violations":[]}',
                            f'{out}/{side}/drc.json': '{"violations":[],"unconnected_items":[]}'})
                mapping = {}
                for page in kr.sheet_pages(f'{side}/images', 'Images'):
                    mapping[page['path']] = {}
                    for theme, folder in (('light', 'sch'), ('dark', 'sch-dark')):
                        color = '#009600'  # real exports share inks; data-theme keeps blobs distinct
                        text = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 297 210" data-theme="{theme}">'
                                f'<rect x="{x-1}" y="54" width="2" height="2" fill="none" stroke="{color}"/>'
                                f'<path d="M{x-5} 55h2" stroke="{color}"/>'
                                # Broad revision ink on both Wipe sides, with a common stroke.
                                f'<path d="M30 120H280 M{65 if side == "base" else 240} 80V180" '
                                f'fill="none" stroke="{color}" stroke-width="8"/>'
                                + IMAGE_TINY_TEXT + '</svg>')
                        rel = f'{folder}/{page["stem"]}.svg'
                        write('.', {f'{out}/{side}/{rel}': text})
                        mapping[page['path']][theme] = rel
                write('.', {f'{out}/{side}/sheet-images.json': json.dumps(mapping)})
                for layer, text in IMAGE_LAYER_EXPORTS.items():
                    # Replace only the exported layer ink, keeping every real track.
                    canonical = layer.replace('_', '.')
                    colors = re.findall(r'stroke:(#[0-9A-Fa-f]{6}); stroke-width:2', text)
                    assert colors
                    for theme, folder in (('light', 'pcb'), ('dark', 'pcb-dark')):
                        ink = '#%02x%02x%02x' % tuple(kr.IMAGE_PALETTES[theme]['sourceRGB'][canonical])
                        themed = text.replace(colors[0], ink)
                        write('.', {f'{out}/{side}/{folder}/Images-{layer}.svg': themed})
                # An exported, empty technical layer remains a real selectable image.
                for folder in ('pcb', 'pcb-dark'):
                    write('.', {f'{out}/{side}/{folder}/Images-Dwgs_User.svg':
                                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 297.0022 210.0072"><g/></svg>'})
            with patch.object(kr, 'sheet_pages', wraps=kr.sheet_pages) as parsed_pages:
                image_project = build_augmented_image_project(desc, image_blobs, settings, committed_svg)
            # Side-only projects continue the image project's change IDs, as production does.
            missing_projects, missing_blobs = missing_side_projects(len(image_project['changes']))
            assert len(missing_projects) == 4
            image_blobs.update(missing_blobs)
            # Per revision: producer page cache, hotspot parser, and object parser.
            # The three manifest views must not each trigger another hierarchy parse.
            assert parsed_pages.call_count == 6, parsed_pages.call_args_list
            for side in ('base', 'head'):
                manifest = json.loads(gzip.decompress(base64.b64decode(image_blobs[image_project['sheets'][0]['hotspots'][side]])))
                assert all(view['viewBox'] == [10, 20, 297, 210] for view in manifest['views'])
                for path, ref in (('/left/', 'U1'), ('/right/', 'U2')):
                    view = next(v for v in manifest['views'] if v['sheet'] == path)
                    symbol = next(e for e in view['elements'] if e['ref'] == ref)
                    assert symbol['unit'] == '2' and symbol['uuid'] == 'placed'
                    pin = next(p for p in symbol['pins'] if p['number'] == '3')
                    assert pin['name'] == 'B' and pin['y'] == 55
                    assert abs(pin['x'] - (100 if side == 'base' else 102.54)) < .0001
                assert json.loads((out / side / 'sheet-hotspots.json').read_text()) == manifest
                assert (out / side / 'board-inspect.json').is_file()
            # Sample points are source-viewBox fractions: single, overlap, custom paint.
            augmented = ET.fromstring(committed_svg.read_text())
            rects = list(augmented)[-3:]
            vx, vy, vw, vh = map(float, augmented.get('viewBox').split())
            for fx, expected in ((.15, 1), (.3, 2), (.75, 1)):
                covering = [r for r in rects if float(r.get('x')) <= vx+fx*vw <= float(r.get('x'))+float(r.get('width'))
                            and float(r.get('y')) <= vy+.5*vh <= float(r.get('y'))+float(r.get('height'))]
                assert len(covering) == expected
                assert all(r.get('opacity', '1') == '1' and r.get('fill') != 'none' for r in covering)
                assert covering[-1].get('fill') == ('#abcdef' if fx == .75 else '#%02x%02x%02x' % tuple(kr.IMAGE_PALETTES['light']['sourceRGB']['F.Cu']))
    finally:
        os.chdir(old)
    copper = {r['name'].replace('_', '.'): r for r in image_project['board']['layers'] if r['name'].endswith('_Cu')}
    assert set(copper) == {'F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'}
    for layer in copper.values():
        for side in ('base', 'head'):
            assert '<svg' in gzip.decompress(base64.b64decode(image_blobs[layer['svg'][side]])).decode()
    for project in [image_project, *missing_projects]:
        for rows, schematic in ((project['sheets'], True), (project['board']['layers'], False)):
            for row in rows:
                for side in ('base', 'head'):
                    key = row['svgCompare'][side]
                    assert bool(key) == bool(row['svg'][side])
                    if key:
                        text = gzip.decompress(base64.b64decode(image_blobs[key])).decode()
                        assert text == kr.comparison_svg(gzip.decompress(base64.b64decode(image_blobs[row['svg'][side]])).decode(), side, schematic)
                        assert '0 0 0 0 ' + ('0.85' if side == 'base' else '0.1') in text
    data = {'version': 1, 'repo': 'fixture/images', 'base': 'a'*40, 'head': 'b'*40,
            'links': {}, 'run_url': '', 'reason': 'synthetic image regression', 'settings': settings,
            'projects': [image_project, *missing_projects], 'blobs': image_blobs}
    kr.assign_ids(data['projects'])
    # Every scene object's changeIds must resolve to a row owned by its UUID on that side.
    by_id = {r['id']: r for project in data['projects'] for r in project['changes']}
    assert len(by_id) == sum(len(project['changes']) for project in data['projects']), 'duplicate change IDs'
    resolved = 0
    for project in data['projects']:
        for side in ('base', 'head'):
            key = (project['board'].get('geometry') or {}).get(side)
            if not key:
                continue
            for obj in json.loads(gzip.decompress(base64.b64decode(image_blobs[key])))['objects']:
                for change_id in obj['changeIds']:
                    row = by_id[change_id]
                    owner = row.get('uuid_before', row.get('uuid')) if side == 'base' else row.get('uuid')
                    assert obj['changeUuid'] == owner, (side, change_id, obj['changeUuid'], owner)
                    resolved += 1
    assert resolved, 'fixture geometry carries no resolvable change IDs'
    with TemporaryDirectory() as directory:
        html = kr.finalize_report(data, directory)
        assert not re.search(r'<(?:script[^>]+src|link[^>]+href)=', html)
        for project in data['projects']:
            for row in project['sheets'] + project['board']['layers']:
                for key in filter(None, row['svgCompare'].values()):
                    assert data['assets'][key] == {'kind': 'svg', 'name': 'comparison.svg'}
                    assert pathlib.Path(directory, key + '.svg.gz').read_bytes() == base64.b64decode(image_blobs[key])
    destination.write_text('window.REVIEW_DATA = ' + json.dumps(data, separators=(',', ':')).replace('<', '\\u003c') + ';\n')
    return image_project, image_blobs

def image_fixture_content(raw):
    """Compare report structure and exact decoded assets, not platform gzip bytes."""
    prefix, suffix = b'window.REVIEW_DATA = ', b';\n'
    assert raw.startswith(prefix) and raw.endswith(suffix), 'invalid image fixture wrapper'
    data = json.loads(raw[len(prefix):-len(suffix)])
    # Python 3.12 delegates mtime=0 headers to zlib (OS=3 on Linux), while
    # Python 3.13 uses OS=255. Deflate output can also vary by zlib version.
    data['blobs'] = {key: gzip.decompress(base64.b64decode(value, validate=True))
                     for key, value in data['blobs'].items()}
    return data


def image_fixture_comparison_regressions():
    payload = b'<svg><path d="M0 0h100"/></svg>' * 20
    encode = lambda data: ('window.REVIEW_DATA = ' + json.dumps(data) + ';\n').encode()
    blob = lambda level: base64.b64encode(gzip.compress(payload, compresslevel=level, mtime=0)).decode()
    original = {'version': 1, 'projects': [{'svg': 'asset'}], 'blobs': {'asset': blob(9)}}
    expected = image_fixture_content(encode(original))
    recompressed = copy.deepcopy(original)
    recompressed['blobs']['asset'] = blob(1)
    assert recompressed['blobs'] != original['blobs']
    assert image_fixture_content(encode(recompressed)) == expected
    header = bytearray(base64.b64decode(original['blobs']['asset']))
    header[9] = 3 if header[9] != 3 else 255
    recompressed['blobs']['asset'] = base64.b64encode(header).decode()
    assert image_fixture_content(encode(recompressed)) == expected
    for change in ('metadata', 'reference', 'content', 'key', 'missing', 'extra'):
        changed = copy.deepcopy(original)
        if change == 'metadata':
            changed['version'] = 2
        elif change == 'reference':
            changed['projects'][0]['svg'] = 'other'
        elif change == 'content':
            changed['blobs']['asset'] = base64.b64encode(gzip.compress(payload + b' ', mtime=0)).decode()
        elif change == 'key':
            changed['blobs']['other'] = changed['blobs'].pop('asset')
        elif change == 'missing':
            changed['blobs'].clear()
        else:
            changed['blobs']['extra'] = blob(9)
        assert image_fixture_content(encode(changed)) != expected, change
    print('ok image fixture comparison ignores gzip encoding but detects structure and decoded-byte drift')


image_fixture_comparison_regressions()

with TemporaryDirectory() as directory:
    generated_data = pathlib.Path(directory, 'review-data-images.js')
    generated_svg = pathlib.Path(directory, 'image-layer-overlap.svg')
    image_project, image_blobs = generate_image_fixture(generated_data, generated_svg)
    for generated, committed in ((generated_data, pathlib.Path('ui/sample/review-data-images.js')),
                                 (generated_svg, pathlib.Path('ui/fixtures/image-layer-overlap.svg'))):
        # Updating fixtures is explicit; ordinary test runs only compare bytes
        # after decoding report blobs, or directly for the standalone SVG.
        if os.environ.get('REGENERATE_IMAGE_FIXTURES') == '1':
            committed.write_bytes(generated.read_bytes())
        committed_content, generated_content = committed.read_bytes(), generated.read_bytes()
        if generated == generated_data:
            committed_content = image_fixture_content(committed_content)
            generated_content = image_fixture_content(generated_content)
        assert committed_content == generated_content, f'{committed} drift; run REGENERATE_IMAGE_FIXTURES=1 python3 test_kicad_review.py'
print('ok additive image finalization, missing sides, repeated-instance and four-layer fixtures')

# Asset filenames and MIME kinds are never inferred from user-controlled names.
for key, kind in (('../escape', 'svg'), ('a'*12, 'html'), ('A'*12, 'json')):
    with TemporaryDirectory() as directory:
        try:
            kr.write_image_assets({}, {key: {'kind': kind, 'name': 'x'}}, directory)
            raise AssertionError('invalid asset accepted')
        except ValueError:
            assert not list(pathlib.Path(directory).iterdir())
print('ok image asset validation')

# The command delegates finalization exactly once, before metadata drops offline blobs.
old = os.getcwd()
try:
    with TemporaryDirectory() as directory:
        os.chdir(directory)
        write('.', {'review/detect.json': json.dumps({'base': 'a'*40, 'head': 'b'*40, 'reason': 'fixture', 'projects': []})})
        with patch.object(kr, 'finalize_report', wraps=kr.finalize_report) as finalized:
            kr.cmd_report(None)
        assert finalized.call_count == 1
        assert finalized.call_args.args[1] == 'review/assets'
        assert json.loads(pathlib.Path('review/data.json').read_text())['assets'] == {}
        assert pathlib.Path('review/assets').is_dir()
finally:
    os.chdir(old)
print('ok report command shares image finalization')

def image_asset_contract_regressions():
    blobs = {}
    key = kr.add_blob(blobs, '<svg viewBox="0 0 1 1"/>')
    valid = {key: {'kind': 'svg', 'name': 'sheet.svg'}}
    # A later malformed declaration must not publish an earlier valid entry.
    invalid_declarations = [
        {**valid, '../escape': {'kind': 'svg'}},
        {**valid, 'a'*12: {'kind': 'html'}},
        {**valid, 'b'*12: {'kind': 'svg'}},
        {**valid, 'c'*12: {}},
    ]
    for declarations in invalid_declarations:
        with TemporaryDirectory() as directory:
            try:
                kr.write_image_assets(blobs, declarations, directory)
            except ValueError:
                assert not list(Path(directory).iterdir()), 'partial assets published'
            else:
                raise AssertionError('invalid asset accepted')
    # Shared artwork gets one explicit role-priority name, regardless of traversal.
    sheet_project = {'sheets': [{'svgThemes': {'light': {'head': key}}}], 'board': {'layers': []}}
    layer_project = {'sheets': [], 'board': {'layers': [{'svgThemes': {'light': {'head': key}}}]}}
    expected = {key: {'kind': 'svg', 'name': 'layer.svg'}}
    assert kr.image_asset_declarations([sheet_project, layer_project]) == expected
    assert kr.image_asset_declarations([layer_project, sheet_project]) == expected
    # Old reports have real artwork but none of the optional new fields.
    legacy = {'version': 1, 'projects': [{'sheets': [{'svg': {'base': None, 'head': key}}],
              'board': {'layers': [{'name': 'F_Cu', 'svg': {'base': None, 'head': key}}]}}],
              'blobs': blobs.copy()}
    assert kr.image_asset_declarations(legacy['projects']) == {}
    with TemporaryDirectory() as directory, patch.object(kr, 'inline_page', side_effect=lambda script: script):
        html = kr.finalize_report(legacy, directory)
        embedded = json.loads(html.removeprefix('window.REVIEW_DATA = ').removesuffix(';'))
        assert embedded['assets'] == {} and embedded['blobs'] == blobs
        assert not list(Path(directory).iterdir())
    print('ok atomic asset validation, deterministic names, legacy artwork finalization')

image_asset_contract_regressions()

# Hosted size limits use decoded UTF-8 bytes, not compressed or character counts.
for kind, cap in [('svg', 8 * 1024 * 1024), ('json', 4 * 1024 * 1024)]:
    blobs = {}
    boundary = kr.add_blob(blobs, 'x' * cap)
    oversized = kr.add_blob(blobs, 'é' * (cap // 2) + 'x')
    project = {'sheets': [{'svgThemes': {'light': {'base': boundary, 'head': oversized}}}
                           if kind == 'svg' else {'hotspots': {'base': boundary, 'head': oversized}}]}
    data = {'projects': [project], 'blobs': blobs}
    with TemporaryDirectory() as directory, patch.object(kr, 'inline_page', side_effect=lambda script: script), patch('sys.stderr') as log:
        html = kr.finalize_report(data, directory)
        embedded = json.loads(html.removeprefix('window.REVIEW_DATA = ').removesuffix(';'))
        assert boundary in embedded['assets'], 'exact cap must remain lazy'
        assert oversized not in embedded['assets'], 'oversized asset must stay inline'
        assert embedded['blobs'][oversized] == blobs[oversized], 'inline fallback lost'
        assert sorted(p.name for p in pathlib.Path(directory).iterdir()) == [boundary + '.' + kind + '.gz']
        warning = ''.join(str(call.args[0]) for call in log.write.call_args_list)
        assert oversized in warning and kind in warning and str(cap) in warning and 'inline' in warning
print('ok oversized SVG and JSON stay inline with decoded-byte warning; exact caps remain lazy')

# BR02: KiCad stamps export time into the GLB; identical boards must keep identical raw bytes and cache keys.
import json, os, pathlib, struct, tempfile, kicad_review
def _glb(stamp):
    doc = json.dumps({"asset": {"version": "2.0", "extras": {"pcb_name": "board.raw", "generated_at": stamp}}}).encode()
    doc += b" " * (-len(doc) % 4)
    binary = struct.pack("<I", 4) + b"BIN\0" + b"\1\2\3\4"
    return b"glTF" + struct.pack("<II", 2, 20 + len(doc) + len(binary)) + struct.pack("<I", len(doc)) + b"JSON" + doc + binary
with tempfile.TemporaryDirectory() as tmp:
    a, b, other = (pathlib.Path(tmp, n) for n in ("a.glb", "b.glb", "other.bin"))
    a.write_bytes(_glb("2026-11-02T23:47:26")); b.write_bytes(_glb("2026-11-02T23:47:33")); other.write_bytes(b"not a glb")
    for f in (a, b, other): kicad_review.normalize_glb(f)
    out = a.read_bytes()
    assert out == b.read_bytes() and b"generated_at" not in out and b"pcb_name" in out
    assert struct.unpack("<I", out[8:12])[0] == len(out) and out.endswith(b"BIN\0\1\2\3\4")
    size = struct.unpack("<I", out[12:16])[0]
    assert size % 4 == 0 and json.loads(out[20:20 + size])["asset"]["extras"] == {"pcb_name": "board.raw"}
    assert other.read_bytes() == b"not a glb"
    for broken in (b"glTF" + struct.pack("<III", 2, 28, 8) + b"JSON" + b"{bad json", _glb("x")[:20] + b"[]      "):
        other.write_bytes(broken); kicad_review.normalize_glb(other)
        assert other.read_bytes() == broken
    assert not list(pathlib.Path(tmp).glob("*.tmp"))
    stamped = _glb("2026-11-02T23:47:26"); a.write_bytes(stamped)
    real_replace = os.replace
    def failing_replace(*_): raise OSError("disk full")
    os.replace = failing_replace
    try: kicad_review.normalize_glb(a)
    finally: os.replace = real_replace
    assert a.read_bytes() == stamped and not list(pathlib.Path(tmp).glob("*.tmp"))
print('ok BR02 GLB export timestamp normalized; bad input left as written')

# FAB-01 integration: actual fixture + parsed settings, separately opt-in and no KiCad required.
if os.environ.get("KICAD_REVIEW_FAB_INTEGRATION") == "1":
    with tempfile.TemporaryDirectory() as td:
        root = pathlib.Path(td)
        pcb = root / "four.kicad_pcb"
        pcb.write_text(pathlib.Path("ui/fixtures/vf-order-4.kicad_pcb").read_text())
        for preset in ("jlcpcb", "pcbway"):
            (root / kr.SETTINGS_FILE).write_text(
                f'[fabrication]\npreset = "{preset}"\ncheck_limits = true\n'
                '[checks]\nfab_limits = "required"\n')
            settings = kr.load_settings((str(root),))
            assert settings["fabrication"]["check_limits"] is True
            assert settings["checks"]["fab_limits"] == "required"
            sections = kr.fab_context(pcb)
            assert [s["vendor"] for s in sections] == ["jlcpcb", "pcbway"]
            assert [s["profile"] for s in sections] == ["jlcpcb-multilayer", "pcbway-std"]
            for section in sections:
                assert section == {
                    "vendor": section["vendor"], "profile": section["profile"], "layers": 4,
                    "checkedOn": profiles[section["profile"]]["checkedOn"], "assumedCopperOz": 1,
                    "unsupported": None, "coverageWarnings": [], "unchecked": [],
                    "values": profiles[section["profile"]]["values"],
                }, "FAB-01 full supported context contract"
    print("ok FAB-01 integration: both vendors independent of parsed fabrication preset")

import uuid


def fab_uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'kicad-review/fab-probe/' + name))


def fab_probe_board(objects, outline=True):
    source = pathlib.Path('ui/fixtures/vf-order-4.kicad_pcb').read_text()
    # Preserve the four explicit 0.035 mm copper thicknesses, discard wide fixture tracks.
    prefix = source.split(' (segment', 1)[0]
    # The fixture lists its copper layers in reverse; probes use canonical physical order.
    prefix = prefix.replace(
        '(layers (2 "B.Cu" signal) (6 "In2.Cu" signal) (4 "In1.Cu" signal) (0 "F.Cu" signal))',
        '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) '
        '(2 "B.Cu" signal) (25 "Edge.Cuts" user))')
    edge = ('(gr_rect (start 0 0) (end 60 60) (stroke (width .05) (type default)) '
            f'(fill none) (layer "Edge.Cuts") (uuid "{fab_uid("outline")}"))') if outline else ''
    return prefix + '\n' + edge + '\n' + objects + '\n)\n'


def fab_segment(name, layer='F.Cu', width=.2, x=5, y=5, net='FAB_A'):
    return (f'(segment (start {x} {y}) (end {x+4} {y}) (width {width}) '
            f'(layer "{layer}") (net "{net}") (uuid "{fab_uid(name)}"))')


def fab_via(name, x=20, y=20, size=.8, drill=.3):
    return (f'(via (at {x} {y}) (size {size}) (drill {drill}) '
            f'(layers "F.Cu" "B.Cu") (net "FAB_A") (uuid "{fab_uid(name)}"))')


def fab_pad(name, x=30, y=30, size=2, drill=.8, npth=False):
    kind = 'np_thru_hole' if npth else 'thru_hole'
    return (f'(footprint "FAB:Probe" (layer "F.Cu") (at {x} {y}) (uuid "{fab_uid(name+"-fp")}") '
            f'(pad "1" {kind} circle (at 0 0) (size {size} {size}) (drill {drill}) '
            f'(layers "*.Cu" "*.Mask") (uuid "{fab_uid(name)}")))')


FAB_PROBE_SEVERITIES = dict.fromkeys((
    'track_width', 'clearance', 'drill_out_of_range', 'annular_width',
    'copper_edge_clearance', 'hole_to_hole', 'via_diameter', 'invalid_outline'), 'error')


def fab_probe_drc(root, label, text, rules, severity=None, refill=False, all_severities=False, exclusions=None):
    target = root / label
    target.mkdir(parents=True, exist_ok=False)  # Fresh output: stale JSON cannot satisfy this gate.
    pcb = target / 'four.kicad_pcb'
    pcb.write_text(text)
    pcb.with_suffix('.kicad_dru').write_text('(version 1)\n' + rules + '\n')
    project = {'board': {'design_settings': {'rule_severities':
               dict(FAB_PROBE_SEVERITIES if severity is None else severity),
               'drc_exclusions': list(exclusions or [])}}}
    pcb.with_suffix('.kicad_pro').write_text(json.dumps(project))
    args = ['kicad-cli', 'pcb', 'drc', '--format', 'json',
            '--severity-all' if all_severities else '--severity-error', '--exit-code-violations']
    if refill:
        args.append('--refill-zones')
    args += ['-o', str(target / 'drc.json'), str(pcb)]
    result = subprocess.run(args, capture_output=True, text=True)
    (target / 'command.json').write_text(json.dumps({'args': args, 'rc': result.returncode}))
    (target / 'stdout.txt').write_text(result.stdout)
    (target / 'stderr.txt').write_text(result.stderr)
    assert result.returncode in (0, 5), (label, result.returncode, result.stderr)
    data = json.loads((target / 'drc.json').read_text())
    assert data['coordinate_units'] == 'mm' and isinstance(data['violations'], list)
    return data['violations']


def fab_target(rows, kind, names):
    ids = {fab_uid(n) for n in names}
    return [v for v in rows if v['type'] == kind and
            ids <= {i.get('uuid') for i in v.get('items', [])}]


def fab_assert_via_position(rows):
    # Deliberately located via centre (20,20); 0.01 mm tolerance for DRC JSON serialization.
    positions = [i['pos'] for v in rows for i in v['items'] if i.get('uuid') == fab_uid('via')]
    assert positions and all(abs(p['x']-20) <= .01 and abs(p['y']-20) <= .01
                             for p in positions), 'FAB real-mm via centre'


def fab_four_fixture(root):
    """Generate the synthetic four-layer report input, including its house rules."""
    board = root / 'four.kicad_pcb'
    board.write_text(fab_probe_board(''.join(
        fab_segment('four-'+layer, layer, .08, y=10+10*i)
        for i, layer in enumerate(('F.Cu', 'In1.Cu', 'B.Cu')))))
    # KiCad's project-less 0.2 mm minimum would classify every narrow track as
    # a house violation and subtract it from the vendor ledger. This generated
    # fixture deliberately uses a weaker house minimum; report production never
    # rewrites the input board, project or authored rules.
    board.with_suffix('.kicad_pro').write_text(json.dumps(
        {'board': {'design_settings': {'rules': {'min_track_width': .05}}}}))
    return board


def fab_capability_probe(root):
    summaries = []
    for profile, layers in (('jlcpcb-multilayer', 4), ('pcbway-std', 4),
                            ('jlcpcb-2l', 2), ('pcbway-std', 2)):
        target = root / f'{profile}-{layers}l'
        target.mkdir(parents=True, exist_ok=False)
        summaries.append(fab_profile_probe(target, profile, layers))
    (root / 'manifest.json').write_text(json.dumps(summaries, indent=2))
    fab_four_fixture(root)
    print('ok FAB-03 geometry, precedence, exclusions and stale fills (both vendors, 2/4 layers)')


def fab_profile_probe(root, profile, layers):
    def probe_board(objects, outline=True):
        text = fab_probe_board(objects, outline)
        if layers == 2:
            text = text.replace(' (6 "In2.Cu" signal)', '').replace(' (4 "In1.Cu" signal)', '')
            for layer in ('In1.Cu', 'In2.Cu'):
                text = text.replace(f'  (layer "{layer}" (type "copper") (thickness 0.035))\n', '')
        return text

    context = {'layers': layers, 'values': kr.fab_profiles()[profile]['values']}
    _, unchecked = kr.fab_rule_section(context)
    _, covered = kr.fab_vendor_rules(context)
    # ponytail: fixed synthetic geometry, not a general PCB generator.
    cases = []
    for layer in (('F.Cu', 'In1.Cu', 'B.Cu') if layers == 4 else ('F.Cu', 'B.Cu')):
        key = 'trackWidthInnerMm' if layer.startswith('In') else 'trackWidthOuterMm'
        cases.append((key + '-' + layer, key, .09, 'track_width', ['track'],
                      .08, .12, lambda d, layer=layer: fab_segment('track', layer, d)))
        key = 'clearanceInnerMm' if layer.startswith('In') else 'clearanceOuterMm'
        # Two distinct nets; gap = centre spacing minus .2 mm track width.
        cases.append((key + '-' + layer, key, .09, 'clearance', ['track-a', 'track-b'],
                      .04, .2, lambda d, layer=layer: fab_segment('track-a', layer, y=10) +
                      fab_segment('track-b', layer, y=10+.2+d, net='FAB_B')))
    # Distinct synthetic limits make layer-predicate swaps observable: 0.09 mm passes outer 0.08 and fails inner 0.12.
    cases += [
        ('distinct-outer-width','trackWidthOuterMm',.08,'track_width',['outer-track'],.07,.09,
         lambda d: fab_segment('outer-track','F.Cu',d)),
        ('distinct-inner-width','trackWidthInnerMm',.12,'track_width',['inner-track'],.09,.13,
         lambda d: fab_segment('inner-track','In1.Cu',d)),
        ('plated-min','drillPlatedMinMm',.2,'drill_out_of_range',['via'],.15,.3,
         lambda d: fab_via('via', drill=d)),
        ('plated-max','drillPlatedMaxMm',6.3,'drill_out_of_range',['pad'],6.5,6.0,
         lambda d: fab_pad('pad', size=8, drill=d)),
        ('npth-min','drillNpthMinMm',.5,'drill_out_of_range',['npth'],.4,.6,
         lambda d: fab_pad('npth', size=1, drill=d, npth=True)),
        ('annular','annularMinMm',.15,'annular_width',['via'],.1,.2,
         lambda d: fab_via('via', drill=.3, size=.3+2*d)),
        ('edge','edgeClearanceMm',.2,'copper_edge_clearance',['edge-track'],.1,.3,
         lambda d: fab_segment('edge-track', width=.2, y=.1+d)),
        ('pad-pair','holeToHoleMm',.45,'hole_to_hole',['pad-a','pad-b'],.2,.6,
         lambda d: fab_pad('pad-a',x=30,size=1,drill=.8) + fab_pad('pad-b',x=30+.8+d,size=1,drill=.8)),
        ('via-pair','holeToHoleViaMm',.2,'hole_to_hole',['via-a','via-b'],.1,.3,
         lambda d: fab_via('via-a',x=20,size=.4,drill=.3) + fab_via('via-b',x=20+.3+d,size=.4,drill=.3)),
]
    manifest = []
    for label, key, threshold, kind, names, bad, good, geometry in cases:
        if layers == 2 and 'Inner' in key:
            continue
        synthetic = label.startswith('distinct-')
        if not synthetic and key not in context['values']:
            assert key in unchecked
            manifest.append({'case': label, 'key': key, 'unchecked': True})
            continue
        values = dict(context['values'])
        if synthetic:
            values[key] = threshold
        else:
            actual = values[key]
            bad, good = bad * actual / threshold, good * actual / threshold
            threshold = actual
        assert bad > threshold > good if key == 'drillPlatedMaxMm' else bad < threshold < good
        rules, _ = kr.fab_vendor_rules({'layers': layers, 'values': values})
        for state, dimension in (('fail', bad), ('pass', good)):
            text = probe_board(geometry(dimension))
            rows = fab_probe_drc(root, label+'-'+state, text, rules)
            hits = fab_target(rows, kind, names)
            assert bool(hits) == (state == 'fail'), (label, state, kind, names, rows)
            if hits and label == 'plated-min':
                fab_assert_via_position(hits)
                scaled = copy.deepcopy(hits)
                for row in scaled:
                    for item in row['items']:
                        if 'pos' in item:
                            item['pos'] = {k:v/100 for k,v in item['pos'].items()}
                try:
                    fab_assert_via_position(scaled)
                    raise AssertionError('coordinate-scale mutation escaped')
                except AssertionError as exc:
                    assert str(exc) == 'FAB real-mm via centre'
            manifest.append({'case':label, 'key':key, 'type':kind, 'uuids':[fab_uid(n) for n in names],
                             'dimensionMm':dimension, 'thresholdMm':threshold, 'state':state,
                             'synthetic':synthetic, 'hits':len(hits), 'findings':hits})
    # Probe above the built-in 0.4 mm minimum: it must not masquerade
    # as a working vendor rule. The published active profiles omit this bound.
    diameter_context = {'layers': layers, 'values': {'viaDiameterMinMm': .8}}
    diameter_rules, omitted = kr.fab_rule_section(diameter_context)
    _, diameter_covered = kr.fab_vendor_rules(diameter_context)
    assert 'viaDiameterMinMm' not in omitted and 'via_diameter' in diameter_covered
    for state, diameter in (('fail', .6), ('pass', .9)):
        rows = fab_probe_drc(root, 'synthetic-via-diameter-'+state,
                             probe_board(fab_via('via', size=diameter)), diameter_rules)
        hits = fab_target(rows, 'via_diameter', ['via'])
        assert bool(hits) == (state == 'fail'), ('via-diameter', state, rows)
        manifest.append({'case': 'via-diameter', 'key': 'viaDiameterMinMm',
                         'synthetic': True, 'type': 'via_diameter', 'uuids': [fab_uid('via')],
                         'dimensionMm': diameter, 'thresholdMm': .8, 'state': state,
                         'hits': len(hits), 'findings': hits})
    # Ordinary house findings must remain visible even when vendor rules win last-match precedence.
    text = probe_board(fab_segment('track', width=.08))
    vendor, _ = kr.fab_vendor_rules({'layers':4,'values':{'trackWidthOuterMm':.1}})
    for bound in (.30, .05):
        house = f'(rule "house" (constraint track_width (min {bound}mm)))'
        before = fab_probe_drc(root, f'house-{bound}-ordinary', text, house, all_severities=True)
        board = fab_probe_drc(root, f'house-{bound}-baseline', text, house)
        after = fab_probe_drc(root, f'house-{bound}-vendor', text, house+'\n'+vendor)
        additions = kr.fab_subtract(after, board)
        assert fab_target(before + additions, 'track_width', ['track']), 'stricter union lost finding'
        assert bool(fab_target(before, 'track_width', ['track'])) == (bound == .30)
        assert bool(fab_target(additions, 'track_width', ['track'])) == (bound == .05)
    ignored = {**FAB_PROBE_SEVERITIES,'track_width':'ignore'}
    before = fab_probe_drc(root,'ignored-ordinary',text,'',ignored)
    after = fab_probe_drc(root,'ignored-vendor',text,vendor,FAB_PROBE_SEVERITIES)
    assert not fab_target(before,'track_width',['track']) and fab_target(after,'track_width',['track'])
    # Ignored house constraints must not become vendor findings outside published bounds.
    for label, objects, house, kind, names in (
        ('unpublished-via',fab_via('via',size=.6,drill=.3),
         '(rule "house via" (constraint via_diameter (min 0.8mm)))','via_diameter',['via']),
        ('stricter-width',fab_segment('track',width=.12),
         '(rule "house width" (constraint track_width (min 0.3mm)))','track_width',['track']),
        ('outside-predicate',fab_via('via',size=.8,drill=.3)+fab_pad('pad',x=21,y=20,size=1,drill=.3),
         '(rule "house mixed" (constraint hole_to_hole (min 2mm)))','hole_to_hole',['via','pad']),
        ('omitted-max',fab_segment('track',width=.4),
         '(rule "house maximum" (constraint track_width (max 0.3mm)))','track_width',['track'])):
        geometry = probe_board(objects)
        ignored_house = {**FAB_PROBE_SEVERITIES,kind:'ignore'}
        baseline = fab_probe_drc(root,label+'-ignored',geometry,house,ignored_house)
        visible = fab_probe_drc(root,label+'-house-error',geometry,house,FAB_PROBE_SEVERITIES)
        assert fab_target(visible,kind,names), 'negative fixture must really violate house rule'
        isolated, covered = kr.fab_vendor_rules(context)
        vendor_rows = fab_probe_drc(root,label+'-vendor',geometry,house+'\n'+isolated,FAB_PROBE_SEVERITIES)
        additions = [v for v in kr.fab_subtract(vendor_rows,baseline) if v['type'] in covered]
        assert not fab_target(additions,kind,names), label
        assert not fab_target(vendor_rows,kind,names), 'neutral override must work, not merely filtering'
    # A valid exclusion must first demonstrably suppress the exact row, then be removed.
    # An open edge has a persistent UUID; no-edge diagnostics instead reference
    # KiCad's transient in-memory PCB UUID, which changes between CLI loads.
    open_edge = (f'(gr_line (start 0 0) (end 60 0) (stroke (width .05) (type default)) '
                 f'(layer "Edge.Cuts") (uuid "{fab_uid("open-edge")}"))')
    for label, geometry, kind, names, rules in (
        ('excluded-width',text,'track_width',['track'],vendor),
        ('excluded-outline',probe_board(fab_segment('track')+open_edge,outline=False),
         'invalid_outline',['open-edge'],'')):
        visible = fab_probe_drc(root,label+'-visible',geometry,rules)
        row = fab_target(visible,kind,names)[0]
        item_ids = [i['uuid'] for i in row['items']]
        # Exclusions use the marker position, not items[].pos: a track-width
        # marker is the segment midpoint while its JSON item is the start.
        pos = {'x':7,'y':5} if kind == 'track_width' else {'x':30,'y':0}
        # KiCad .kicad_pro exclusion encoding is unverified until hidden assertion passes.
        ids = (item_ids + ['00000000-0000-0000-0000-000000000000']*2)[:2]
        exclusion = '|'.join([kind,str(round(pos['x']*1e6)),str(round(pos['y']*1e6)),*ids])
        hidden = fab_probe_drc(root,label+'-hidden',geometry,rules,exclusions=[exclusion])
        assert not fab_target(hidden,kind,names), 'exclusion encoding/position not verified'
        restored = fab_probe_drc(root,label+'-cleared',geometry,rules,exclusions=[])
        assert fab_target(restored,kind,names), 'clearing exclusions must restore covered finding'
        manifest.append({'case':label,'exclusion':exclusion,'visible':len(visible),'hidden':len(hidden)})
    for severity in ('warning','ignore'):
        missing = probe_board(fab_segment('track'), outline=False)
        ordinary = fab_probe_drc(root,'outline-'+severity+'-ordinary',missing,'',
                                 {**FAB_PROBE_SEVERITIES,'invalid_outline':severity})
        promoted = fab_probe_drc(root,'outline-'+severity+'-promoted',missing,'',FAB_PROBE_SEVERITIES)
        assert not any(v['type']=='invalid_outline' for v in ordinary)
        assert any(v['type']=='invalid_outline' for v in promoted), severity
    # Deliberately stale copper fill crosses a newly added foreign-net track.
    # Keep the fill inside the authored zone bounds so KiCad tests its geometry.
    zone = (f'(zone (net "FAB_B") (layer "F.Cu") (uuid "{fab_uid("stale-zone")}") '
            '(hatch edge .5) (connect_pads (clearance .3)) (min_thickness .1) '
            '(fill yes (thermal_gap .3) (thermal_bridge_width .3)) '
            '(polygon (pts (xy 4 4) (xy 40 4) (xy 40 40) (xy 4 40))) '
            '(filled_polygon (layer "F.Cu") (pts (xy 4 4) (xy 10 4) (xy 10 5.3) (xy 4 5.3))))')
    stale = probe_board(fab_segment('track',width=.2) + zone)
    house = '(rule "house clearance" (constraint clearance (min 0.3mm)))'
    old = fab_probe_drc(root,'stale-ordinary',stale,house,all_severities=True)
    saved = fab_probe_drc(root,'stale-baseline',stale,house)
    filled = fab_probe_drc(root,'stale-refilled-probe-only',stale,house,refill=True)
    target_types = {'clearance','shorting_items','zone_intersect'}
    old_ids = {kr.fab_identity(v) for v in saved if v['type'] in target_types}
    filled_ids = {kr.fab_identity(v) for v in filled if v['type'] in target_types}
    assert old_ids != filled_ids, 'FAB stale fixture must change a copper/clearance finding when refilled'
    vendor, _ = kr.fab_vendor_rules({'layers':4,'values':{'clearanceOuterMm':.1,'clearanceInnerMm':.1}})
    after = fab_probe_drc(root,'stale-vendor',stale,house+'\n'+vendor)
    suppressed = {kr.fab_identity(v) for v in after} - {kr.fab_identity(v) for v in kr.fab_subtract(after,saved)}
    assert suppressed <= {kr.fab_identity(v) for v in old}, 'suppressed findings must remain in ordinary report'
    manifest.append({'case':'stale-zone','saved':len(old_ids),'refilled':len(filled_ids)})
    (root / 'manifest.json').write_text(json.dumps(manifest,indent=2))
    checked = sorted({entry['key'] for entry in manifest
                      if entry.get('state') == 'fail' and not entry.get('synthetic') and not entry.get('unchecked')})
    assert checked == sorted(key for key in context['values'] if not (layers == 2 and 'Inner' in key))
    return {'profile': profile, 'layers': layers, 'covered': sorted(covered),
            'checked': checked, 'unchecked': unchecked, 'cases': len(manifest)}

# FAB-03: isolated execution, coverage and revision-only cache identity.
from unittest.mock import patch
from types import SimpleNamespace
# Reject malformed project containers before invoking the vendor CLI.
with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td).resolve()
    for index, project in enumerate(([], None, "project", 1, {"board": []},
            {"board": None}, {"board": {"design_settings": []}},
            {"board": {"design_settings": None}},
            {"board": {"design_settings": {"rule_severities": []}}},
            {"board": {"design_settings": {"rule_severities": None}}})):
        with patch.object(kr, "fab_drc") as drc:
            try:
                kr.fab_run_drc(root / "b.kicad_pcb", root / str(index), b"(kicad_pcb)",
                               json.dumps(project).encode(), b"", ("", set()))
                raise AssertionError("FAB-03 malformed project accepted")
            except RuntimeError as exc:
                assert "project" in str(exc)
            drc.assert_not_called()

# KiCad can silently discard a bad authored rule and every appended vendor rule.
with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td).resolve()
    for index, rules in enumerate((
            '(version 1)\n(rule "house" (constraint track_width (min .3mm)))',
            '(version 1)\n(rule "house" (constraint track_width (min -.3mm)))',
            '(version 1)\n(rule "house" (constraint track_width (min 0.3mm))',
            '(version 1)\n(rule "unterminated)',
            '(version 1))',
            '(version 1)\n# comment\n(rule "house" (constraint track_width (min 0.3mm))))')):
        with patch.object(kr, "fab_drc") as drc:
            try:
                kr.fab_run_drc(root / "b.kicad_pcb", root / str(index), b"(kicad_pcb)",
                               b"", rules.encode(), ("", set()))
                raise AssertionError("FAB-03 malformed authored rules accepted")
            except RuntimeError as exc:
                assert "rules" in str(exc)
            drc.assert_not_called()
    # Quotes/comments may contain parentheses and leading-dot prose, not numeric tokens.
    valid = ('(version 1)\n# .3mm (comment)\n'
             '(rule "house .3mm (name)" (condition "A.NetName == \\\".3mm\\\"") '
             '(constraint track_width (min 0.3mm)))')
    with patch.object(kr, "fab_drc", return_value={"violations": []}) as drc:
        assert kr.fab_run_drc(root / "b.kicad_pcb", root / "valid", b"(kicad_pcb)",
                              b"", valid.encode(), ("", set())) == []
        drc.assert_called_once()

with tempfile.TemporaryDirectory() as td:
    pcb, out = pathlib.Path(td, 'b.kicad_pcb'), pathlib.Path(td, 'drc.json')
    pcb.write_text('(kicad_pcb)')
    def cli_ok(args, **kwargs):
        out.write_text(json.dumps({'coordinate_units':'mm','violations':[]}))
        return SimpleNamespace(returncode=5, stdout='', stderr='')
    with patch.object(kr.subprocess, 'run', side_effect=cli_ok) as runner:
        assert kr.fab_drc(pcb, out)['violations'] == []
        assert '--exit-code-violations' in runner.call_args.args[0]
        assert '--refill-zones' not in runner.call_args.args[0]
    for rc in (1, 2, 137):
        with patch.object(kr.subprocess, 'run', return_value=SimpleNamespace(returncode=rc,stdout='',stderr='broken')):
            try:
                kr.fab_drc(pcb, out)
                raise AssertionError('FAB-03 crash accepted')
            except RuntimeError:
                pass
    def cli_clean(args, **kwargs):
        result = cli_ok(args, **kwargs)
        result.returncode = 0
        return result
    with patch.object(kr.subprocess, 'run', side_effect=cli_clean):
        assert kr.fab_drc(pcb, out)['violations'] == [], 'FAB-03 clean exit accepted'
    with patch.object(kr.subprocess, 'run', return_value=SimpleNamespace(returncode=0,stdout='',stderr='')):
        out.write_text(json.dumps({'coordinate_units':'mm','violations':[]}))
        try:
            kr.fab_drc(pcb, out)
            raise AssertionError('FAB-03 absent output reused stale JSON')
        except (RuntimeError, OSError):
            pass

def fab_test_raw(uid, kind='track_width'):
    return {'type':kind,'severity':'error','description':'too narrow',
            'items':[{'uuid':uid,'description':uid,'pos':{'x':42.5,'y':20}}]}


def fab_assert_multiset():
    a = fab_test_raw('a'); b = fab_test_raw('b')
    assert kr.fab_subtract([a,a,b],[a]) == [a,b], 'FAB mutation: multiset regression escaped'


def fab_assert_exit_one():
    with tempfile.TemporaryDirectory() as td:
        pcb=pathlib.Path(td,'b.kicad_pcb'); pcb.write_text('(kicad_pcb)')
        with patch.object(kr.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='',stderr='broken')):
            try:
                kr.fab_drc(pcb,pathlib.Path(td,'out.json'))
            except RuntimeError:
                return
        raise AssertionError('FAB mutation: exit 1 accepted')


fab_assert_multiset(); fab_assert_exit_one()
for name, mutation, assertion, diagnostic in (
    ('fab_subtract',lambda after,before:before,fab_assert_multiset,'FAB mutation: multiset regression escaped'),
    ('fab_drc',lambda pcb,out:{'violations':[]},fab_assert_exit_one,'FAB mutation: exit 1 accepted')):
    with patch.object(kr,name,side_effect=mutation):
        try:
            assertion()
            raise AssertionError('mutation did not trigger its regression')
        except AssertionError as exc:
            assert str(exc)==diagnostic


def fab_test_render(root, outline_severity='error', missing_outline=False,
                    rules_text='(version 1)\n# house bytes\n'):
    root = root.resolve()
    source = root / 'four.kicad_pcb'
    source.write_text(pathlib.Path('ui/fixtures/vf-order-4.kicad_pcb').read_text().replace('(thickness 0.035)', '', 1))
    project = source.with_suffix('.kicad_pro')
    project.write_text(json.dumps({'board':{'design_settings':{'drc_exclusions':['unrelated-house-exclusion'],
        'rule_severities':{'invalid_outline':outline_severity,'via_diameter':'ignore'}}}}))
    rule = source.with_suffix('.kicad_dru')
    rule.write_text(rules_text)
    originals = {f:f.read_bytes() for f in (source,project,rule)}
    settings = copy.deepcopy(kr.DEFAULT_SETTINGS)
    settings['fabrication']['check_limits'] = True
    settings['checks']['fab_limits'] = 'required'
    ordinary, extra = fab_test_raw('house'), fab_test_raw('track')
    calls = []
    def fake_drc(pcb, out):
        mode = pcb.parent.name
        calls.append(mode)
        severities = json.loads(pcb.with_suffix('.kicad_pro').read_text())['board']['design_settings']['rule_severities']
        assert severities['invalid_outline'] == ('error' if mode != 'board' else outline_severity)
        design = json.loads(pcb.with_suffix('.kicad_pro').read_text())['board']['design_settings']
        assert design['drc_exclusions'] == ([] if mode != 'board' else ['unrelated-house-exclusion'])
        assert severities['via_diameter'] == 'ignore', 'unpublished dimension promoted'
        if mode != 'board':
            text = pcb.with_suffix('.kicad_dru').read_text()
            assert text.index('fab neutral track_width') < text.index('fab track_width')
        rows = [ordinary, extra] if mode != 'board' else [ordinary]
        if missing_outline and mode != 'board':
            rows += [{'type':'invalid_outline','severity':'error','description':'no outline','items':[]}]
        return {'coordinate_units':'mm','violations':rows}
    p = {'name':'Four','dir':'','status':'modified'}
    output = root / 'report' / 'head'
    with patch.object(kr,'board_path',return_value=str(source)), patch.object(kr,'fab_drc',side_effect=fake_drc):
        kr.render_fab(p,'head',str(output),settings)
    assert calls == ['board','jlcpcb','pcbway'], 'FAB-03 both vendor passes and one board pass'
    assert all(f.read_bytes() == text for f,text in originals.items()), 'FAB-03 source mutated'
    sections = {s['vendor']: s for s in json.loads((output / 'fab-limits.json').read_text())['sections']}
    assert set(sections) == {'jlcpcb','pcbway'}
    for meta in sections.values():
        assert meta['violations'] == [extra] and meta['coverageWarnings']
        assert ('edgeClearanceMm' in meta['unchecked']) == missing_outline
        assert ('edgeClearanceMm' in meta['checked']) != missing_outline
        assert not any(v['type']=='invalid_outline' for v in meta['violations'])
    return p, source, root / 'report', settings, sections


# Lexically valid authored files are not proof that KiCad loaded appended rules.
# Track that residual risk even when the fake CLI returns valid geometry results.
with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td).resolve()
    for index, rules in enumerate(('', '(version 1)\n',
            '(version 1)\n(rule "house" (constraint unknown_constraint (min 0.3mm)))',
            '(version 1)\n(rule "house" (constraint track_width (min 0.3 mm)))',
            '(version 1)\n(rule "house" (condition "not a condition") (constraint track_width (min 0.3mm)))')):
        case = root / str(index); case.mkdir()
        _, _, _, _, sections = fab_test_render(case, rules_text=rules)
        for meta in sections.values():
            notices = [w for w in meta['coverageWarnings'] if 'rule loading' in w]
            assert bool(notices) == bool(rules.strip()), 'FAB-03 authored-rule loading risk hidden'
            if notices:
                assert 'not independently verified' in notices[0]
            assert len(meta['violations']) == 1, 'FAB-03 uncertainty changed violation counts'

with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td).resolve()
    pcb, out = root / 'b.kicad_pcb', root / 'drc.json'
    pcb.write_text('(kicad_pcb)')
    for text in ('', '{', '{}', '{"coordinate_units":"in","violations":[]}',
                 '{"coordinate_units":"mm"}', '{"coordinate_units":"mm","violations":{}}'):
        def bad_json(args, **kwargs):
            out.write_text(text)
            return SimpleNamespace(returncode=0,stdout='',stderr='')
        with patch.object(kr.subprocess,'run',side_effect=bad_json):
            try:
                kr.fab_drc(pcb,out)
                raise AssertionError('FAB-03 malformed output accepted: '+text)
            except (ValueError, RuntimeError):
                pass
    invalid_rows = [None, {}, {**fab_test_raw('x'),'type':''},
                    {**fab_test_raw('x'),'severity':'banana'},
                    {**fab_test_raw('x'),'description':None},
                    {**fab_test_raw('x'),'items':'not an array'},
                    {**fab_test_raw('x'),'items':[None]},
                    {**fab_test_raw('x'),'items':[{'description':'x','uuid':3}]},
                    {**fab_test_raw('x'),'items':[{'description':None}]},
                    {**fab_test_raw('x'),'items':[{'description':'x','pos':{'x':1}}]},
                    {**fab_test_raw('x'),'items':[{'description':'x','pos':{'x':1,'y':float('inf')}}]},
                    {**fab_test_raw('x'),'items':[{'description':'x','pos':None}]},
                    {**fab_test_raw('x'),'items':[{'description':'x','pos':{'x':'1','y':2}}]},
                    {**fab_test_raw('x'),'items':[{'description':'x','pos':{'x':float('nan'),'y':2}}]},
                    {**fab_test_raw('x'),'items':[{'description':'x','pos':{'x':True,'y':2}}]}]
    for row in invalid_rows:
        def malformed_row(args, **kwargs):
            out.write_text(json.dumps({'coordinate_units':'mm','violations':[row]}))
            return SimpleNamespace(returncode=5,stdout='',stderr='')
        with patch.object(kr.subprocess,'run',side_effect=malformed_row):
            try:
                kr.fab_drc(pcb,out)
                raise AssertionError('FAB-03 malformed row became clean check')
            except RuntimeError:
                pass
    # Unit attribution negatives: inspect the actual disposable project/rules.
    for label, objects, house, kind in (
        ('ignored-unpublished-via',fab_via('via',size=.6,drill=.3),
         '(rule "house" (constraint via_diameter (min 0.8mm)))','via_diameter'),
        ('ignored-stricter-house',fab_segment('track',width=.12),
         '(rule "house" (constraint track_width (min 0.3mm)))','track_width')):
        case=root/label; case.mkdir()
        source=case/'four.kicad_pcb'; source.write_text(fab_probe_board(objects))
        source.with_suffix('.kicad_dru').write_text('(version 1)\n'+house)
        source.with_suffix('.kicad_pro').write_text(json.dumps({'board':{'design_settings':{
            'rule_severities':{kind:'ignore'},'drc_exclusions':['excluded-unrelated-house']}}}))
        cfg=copy.deepcopy(kr.DEFAULT_SETTINGS)
        cfg['fabrication']['check_limits']=True; cfg['checks']['fab_limits']='required'
        def attribution_drc(pcb,out):
            design=json.loads(pcb.with_suffix('.kicad_pro').read_text())['board']['design_settings']
            if pcb.parent.name=='board':
                assert design['rule_severities'][kind]=='ignore'
                return {'coordinate_units':'mm','violations':[]}
            assert design['drc_exclusions']==[]
            generated=pcb.with_suffix('.kicad_dru').read_text()
            constraint='via_diameter' if kind=='via_diameter' else 'track_width'
            assert house in generated
            assert generated.index('fab neutral '+constraint) > generated.index('rule "house"')
            if kind=='via_diameter':
                assert design['rule_severities'][kind]=='ignore'
                # Even an unrelated diagnostic emitted by the tool must not be attributed.
                rows=[fab_test_raw('via',kind)]
            else:
                assert design['rule_severities'][kind]=='error'
                assert generated.index('fab neutral track_width') < generated.index('fab track_width')
                rows=[]  # .12 mm passes .09 mm vendor; real gate independently proves this.
            return {'coordinate_units':'mm','violations':rows}
        with patch.object(kr,'board_path',return_value=str(source)), patch.object(kr,'fab_drc',side_effect=attribution_drc):
            kr.render_fab({'name':'Four'},'head',str(case/'out'),cfg)
        sections=json.loads((case/'out'/'fab-limits.json').read_text())['sections']
        for meta in sections:
            assert meta['violations']==[], (label, meta['vendor'])
        if kind=='via_diameter':
            assert 'viaDiameterMinMm' in next(m for m in sections if m['vendor']=='jlcpcb')['unchecked']
    for severity in ('error','warning','ignore'):
        case = root / severity; case.mkdir()
        fab_test_render(case,severity,missing_outline=True)
    duplicate = root / 'duplicate-outline'; duplicate.mkdir()
    original_context = kr.fab_context
    warning = 'Edge clearance not checked: no valid closed board outline'
    def preunchecked_context(pcb):
        sections = original_context(pcb)
        for section in sections:
            section['values'].pop('edgeClearanceMm', None)
            section['coverageWarnings'].append(warning)
        return sections
    with patch.object(kr, 'fab_context', side_effect=preunchecked_context):
        _, _, _, _, sections = fab_test_render(duplicate, missing_outline=True)
    for section in sections.values():
        assert section['unchecked'].count('edgeClearanceMm') == 1, 'FAB-03 duplicate unchecked edge clearance'
        assert section['coverageWarnings'].count(warning) == 1, 'FAB-03 duplicate outline coverage warning'
    complete = root / 'complete'; complete.mkdir()
    _, _, _, settings, _ = fab_test_render(complete)
    for suffix, dangling in ((s,d) for s in ('.kicad_pcb','.kicad_pro','.kicad_dru') for d in (False,True)):
        case = root / ('link'+suffix+str(dangling)); case.mkdir()
        source = case / 'b.kicad_pcb'; source.write_text('(kicad_pcb)')
        target = case / 'secret'
        if not dangling:
            target.write_text('must not read target')
        link = source.with_suffix(suffix); link.unlink(missing_ok=True); link.symlink_to(target)
        with patch.object(kr,'board_path',return_value=str(source)), patch.object(kr,'fab_context') as context, patch.object(kr,'fab_drc') as drc, patch.object(pathlib.Path,'read_text') as read_text, patch.object(pathlib.Path,'read_bytes') as read_bytes:
            try:
                kr.render_fab({'name':'B'},'head',str(case/'out'),settings)
                raise AssertionError('FAB-03 symlink accepted: '+suffix)
            except RuntimeError as exc:
                assert 'symlink' in str(exc)
            context.assert_not_called(); drc.assert_not_called()
            read_text.assert_not_called(); read_bytes.assert_not_called()
        if not dangling:
            assert target.read_text() == 'must not read target'
        else:
            assert not target.exists()
    actual = root / 'actual'; actual.mkdir()
    (actual/'b.kicad_pcb').write_text('(kicad_pcb)')
    parent = root/'linked-parent'; parent.symlink_to(actual, target_is_directory=True)
    try:
        kr.fab_regular_input(parent/'b.kicad_pcb')
        raise AssertionError('FAB-03 symlinked parent accepted')
    except RuntimeError as exc:
        assert str(parent) in str(exc) and 'physical checkout path' in str(exc)
        assert '/private/tmp' in str(exc), 'FAB-03 symlink recovery guidance missing'
    kr.fab_regular_input((parent/'b.kicad_pcb').resolve())
    table = root/'profiles.json'; table.write_bytes(kr.FAB_TABLE.read_bytes())
    det = {'base':'a'*40,'head':'a'*40}
    with patch.object(kr,'FAB_TABLE',table):
        before = kr.render_cache({'dir':'','name':'P'},'head',det,settings)
        values = json.loads(table.read_text()); values['jlcpcb-2l']['checkedOn']='2026-10-25'
        table.write_text(json.dumps(values))
        assert kr.render_cache({'dir':'','name':'P'},'head',det,settings) != before
        assert kr.render_cache({'dir':'','name':'P'},'base',det,settings) != kr.render_cache({'dir':'','name':'P'},'head',det,settings)
    disabled = copy.deepcopy(settings)
    disabled['fabrication']['check_limits'] = False
    with patch.object(kr,'FAB_TABLE',root / 'absent-table.json'):
        assert kr.render_cache({'dir':'','name':'P'},'head',det,disabled) == kr.render_cache({'dir':'','name':'P'},'base',det,disabled)
# Subtracting a shared house/vendor error is invalid without the ordinary DRC check.
with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td).resolve()
    source = root/'four.kicad_pcb'; source.write_text(fab_probe_board(fab_segment('track',width=.08)))
    source.with_suffix('.kicad_dru').write_text('(version 1)\n(rule "house" (constraint track_width (min 0.3mm)))')
    cfg = copy.deepcopy(kr.DEFAULT_SETTINGS)
    cfg['fabrication']['check_limits']=True; cfg['checks'].update(drc='off',fab_limits='required')
    with patch.object(kr,'board_path',return_value=str(source)):
        try:
            if kr.fab_enabled(cfg):
                kr.render_fab({'name':'Four'},'head',str(root/'out'),cfg)
            raise AssertionError('FAB-03 DRC off accepted')
        except ValueError as exc:
            assert 'requires checks.drc != "off"' in str(exc)
    cfg['fabrication']['check_limits']=False
    assert kr.fab_enabled(cfg) is False
workflow = pathlib.Path('.github/workflows/review.yml').read_text()
outer = "hashFiles('tools/kicad_review.py', 'tools/fab_limits.json', 'tools/ui/compress3d.cjs', 'base/kicad-review.toml', 'head/kicad-review.toml')"
assert workflow.count(outer) == 2, 'FAB-03 outer cache omits profile bytes'

# Exercise the actual cmd_render boundary, not merely fab_enabled.
with tempfile.TemporaryDirectory() as td:
    cwd = os.getcwd()
    try:
        os.chdir(td); pathlib.Path('review').mkdir()
        pathlib.Path('review/detect.json').write_text(json.dumps({'projects':[{'dir':'','name':'B','status':'modified'}]}))
        for enabled, level, expected in ((False,'required',0),(True,'off',0),(True,'informational',2),(True,'required',2)):
            cfg = copy.deepcopy(kr.DEFAULT_SETTINGS)
            cfg['fabrication']['check_limits'] = enabled; cfg['checks']['fab_limits'] = level
            with patch.object(kr,'load_settings',return_value=cfg), patch.object(kr,'render_cache',return_value=None), patch.object(kr,'render_side'), patch.object(kr,'render_fab') as fab:
                kr.cmd_render(SimpleNamespace())
                assert fab.call_count == expected
                if expected:
                    assert sorted(c.args[1] for c in fab.call_args_list) == ['base', 'head'], 'FAB-03 both revisions render'
        for error in (OSError('missing output'), ValueError('malformed JSON'), RuntimeError('tool crash')):
            with patch.object(kr,'load_settings',return_value=cfg), patch.object(kr,'render_cache',return_value=None), patch.object(kr,'render_side'), patch.object(kr,'render_fab',side_effect=error), patch.object(kr,'cache_renders') as cache:
                try:
                    kr.cmd_render(SimpleNamespace())
                    raise AssertionError('FAB-03 failed audit completed render cache')
                except SystemExit as exc:
                    assert str(exc) == f'Fab limits could not run for B: {error}'
                cache.assert_not_called()
    finally:
        os.chdir(cwd)
# Missing/unsupported revisions have no fabricated pass or comparison metadata.
with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td).resolve()
    source = root / 'absent.kicad_pcb'
    cfg = copy.deepcopy(kr.DEFAULT_SETTINGS)
    cfg['fabrication']['check_limits'] = True
    with patch.object(kr, 'board_path', return_value=str(source)), patch.object(kr, 'fab_drc') as drc:
        for side in ('base', 'head'):
            kr.render_fab({'name':'Absent'}, side, str(root / side), cfg)
            assert json.loads((root / side / 'fab-limits.json').read_text()) == {
                'sections': [], 'reason': f'no {side} board'}
        source.write_text('(kicad_pcb (layers (0 "F.Cu" signal)))')
        kr.render_fab({'name':'Unsupported'}, 'head', str(root / 'unsupported'), cfg)
        sections = json.loads((root / 'unsupported' / 'fab-limits.json').read_text())['sections']
        assert [s['vendor'] for s in sections] == ['jlcpcb', 'pcbway']
        assert all(s['unsupported'] and s['checked'] == [] and s['violations'] == [] for s in sections)
        assert all('baselineAvailable' not in s and 'fixed' not in s for s in sections)
        drc.assert_not_called()
    # Each adjacent input and the profile bytes are in the deterministic input hash.
    for suffix in ('.kicad_pcb', '.kicad_pro', '.kicad_dru'):
        path = source.with_suffix(suffix)
        if not path.exists():
            path.write_text('')
    table = root / 'profiles.json'; table.write_bytes(kr.FAB_TABLE.read_bytes())
    def audit_hash():
        with patch.object(kr, 'board_path', return_value=str(source)), patch.object(kr, 'FAB_TABLE', table):
            kr.render_fab({'name':'Unsupported'}, 'head', str(root / 'hash'), cfg)
        return json.loads((root / 'hash' / 'fab-limits.json').read_text())['sections'][0]['inputHash']
    before = audit_hash()
    assert before == audit_hash()
    for path in (source, source.with_suffix('.kicad_pro'), source.with_suffix('.kicad_dru'), table):
        original = path.read_bytes()
        path.write_bytes(original + b'\n')
        assert audit_hash() != before, path.suffix
        path.write_bytes(original)
        assert audit_hash() == before

# Both disabled modes permit DRC off at the real settings/report boundary.
with tempfile.TemporaryDirectory() as td:
    root = pathlib.Path(td).resolve()
    for enabled, level in ((False, 'required'), (True, 'off')):
        (root / kr.SETTINGS_FILE).write_text(
            f'[fabrication]\ncheck_limits = {str(enabled).lower()}\n'
            f'[checks]\ndrc = "off"\nfab_limits = "{level}"\n')
        assert kr.fab_enabled(kr.load_settings((str(root),))) is False
print('ok FAB-03 isolated execution, coverage, cache identity and cmd_render')

def fab_head_only(source):
    """board_path side effect: the head board exists and the base board does not (so no base audit is compared)."""
    return lambda p, side: str(source) if side == 'head' else str(source.with_name('no-base.kicad_pcb'))


def fab_produced_checks():
    with tempfile.TemporaryDirectory() as td:
        p, source, out, cfg, sections = fab_test_render(pathlib.Path(td))
        with patch.object(kr,'board_path',side_effect=fab_head_only(source)):
            checks = {c['vendor']: c for c in kr.fab_checks(p,cfg,str(out),{'active':{}})}
        jl = checks['jlcpcb']
        assert type(jl['warnings']) is int and jl['warnings'] == 0
        assert jl['errors'] == 1 and jl['coverageWarnings'] == sections['jlcpcb']['coverageWarnings']
        assert jl['errors'] + jl['warnings'] == 1, 'FAB-04 numeric v1 contract'
        assert checks['pcbway']['errors'] == 1 and checks['pcbway']['baselineAvailable'] is False
        return checks


# FAB-06: summarize actual produced audits, including every vendor and project.
produced = fab_produced_checks()
jl, pw = produced['jlcpcb'], produced['pcbway']
assert type(jl['warnings']) is int and isinstance(jl['coverageWarnings'],list)
assert jl['warnings'] == 0 and jl['coverageWarnings']
project = lambda name,checks: {'name':name,'dir':'','status':'modified','changes':[],
                              'sheets':[],'board':{'changed':False},'checks':checks}
jl_other = copy.deepcopy(jl)
jl_other.update(errors=2,new_errors=2,status='fail')
data = {'base':'a'*40,'head':'b'*40,'reason':'fab regression','links':{},
        'settings':copy.deepcopy(kr.DEFAULT_SETTINGS),
        'projects':[project('First',[jl,pw]),project('Second',[jl_other])]}
block = kr.checks_markdown(data)
assert block.startswith('\n### Checks\n')
assert '| First | Fab limits · JLCPCB (required) |' in block, 'FAB-06 vendor-qualified JLCPCB table row'
assert '| First | Fab limits · PCBWay (required) |' in block, 'FAB-06 vendor-qualified PCBWay table row'
expected = ('**First**: Fab limits (JLCPCB): 1 violations',
            '**First**: Fab limits (PCBWay): 1 violations',
            '**Second**: Fab limits (JLCPCB): 2 violations')
assert all(text in block for text in expected), 'FAB-06 every vendor section of every project is summarized'
body = kr.comment_markdown(data,[], '')
start = body.index('### Checks')
assert all(body.index(text)>start for text in expected)
assert not any(text in body[:start] for text in expected)
runs = [r for r in kr.check_runs(data) if r['name']=='kicad-review / Fab limits']
assert len(runs)==1 and runs[0]['conclusion']=='failure'
summary = runs[0]['output']['summary']
assert '| First (JLCPCB) |' in summary and '| First (PCBWay) |' in summary, 'FAB-06 vendor-qualified check-run rows'
assert '| 0 (0) |' in summary, 'warning count is numeric in check-run output'
assert all(w not in block for w in jl['coverageWarnings']), 'coverage belongs to ledger, not numeric counts'
with tempfile.TemporaryDirectory() as td:
    p, source, out, cfg, _ = fab_test_render(pathlib.Path(td))
    source.unlink()
    with patch.object(kr,'board_path',side_effect=fab_head_only(source)):
        removed = kr.fab_checks(p,cfg,str(out),{'active':{}})
line = kr.checks_markdown({**data,'projects':[project('Removed board',removed)]})
assert 'Fab limits (JLCPCB): not checked' in line and 'Fab limits (PCBWay): not checked' in line
no_vendor = {k:v for k,v in removed[0].items() if k != 'vendor'}
assert 'Fab limits: not checked' in kr.checks_markdown({**data,'projects':[project('Legacy',[no_vendor])]}), 'FAB-06 vendor-neutral only without vendor'
legacy = {**data,'projects':[project('Old',[kr.run_check('drc',kr.DEFAULT_SETTINGS,[],[])])]}
assert 'Fab limits' not in kr.comment_markdown(legacy,[], '')
print('ok FAB-06 produced vendor summaries, placement, check run and removed board')

readme = pathlib.Path('README.md').read_text()
example = pathlib.Path('examples/kicad-review.toml').read_text()
config = kr.tomllib.loads(example)
assert config['checks']['fab_limits']=='informational' and config['fabrication']['check_limits'] is False
assert 'checks.fab_limits' in readme and 'fabrication.check_limits' in readme
assert 'coverageWarnings' in readme and 'integer' in readme
assert 'server Run button' not in readme
assert len(kr.fab_profiles())==12
print('ok FAB-06 documentation defaults and coverage contract')

off_cfg=copy.deepcopy(kr.DEFAULT_SETTINGS)
off_cfg['fabrication']['check_limits']=True
off_cfg['checks'].update(drc='off',fab_limits='required')
try:
    kr.fab_checks({'name':'Four'},off_cfg,'absent-output')
    raise AssertionError('FAB-04 report accepted DRC off')
except ValueError as exc:
    assert 'requires checks.drc != "off"' in str(exc)

produced_fabs = fab_produced_checks()
with tempfile.TemporaryDirectory() as td:
    p, source, out, cfg, sections = fab_test_render(pathlib.Path(td))
    audit = out/'head'/'fab-limits.json'
    def write_head(**changes):
        audit.write_text(json.dumps({'sections':[{**s,**changes} for s in sections.values()]}))
    with patch.object(kr,'board_path',side_effect=fab_head_only(source)):
        for level,status in (('informational','warn'),('required','fail')):
            cfg['checks']['fab_limits']=level
            write_head(layers=8,unsupported='not checked: profile covers 4, 6 layers; board has 8',violations=[])
            assert all(kr.fab_check(p,cfg,str(out),None,v)['status']==status for v in kr.FAB_VENDORS)
        cfg['fabrication']['check_limits']=False
        assert kr.fab_checks(p,cfg,str(out))==[]
        cfg['fabrication']['check_limits']=True; cfg['checks']['fab_limits']='off'
        assert kr.fab_checks(p,cfg,str(out))==[]
        cfg['checks']['fab_limits']='required'
        audit.unlink()
        try:
            kr.fab_checks(p,cfg,str(out))
            raise AssertionError('FAB-04 missing artifact accepted')
        except SystemExit as exc:
            assert 'Fab limits output missing for Four (head)' in str(exc)
        source.unlink()
        removed = kr.fab_checks(p,cfg,str(out))
        assert [c['vendor'] for c in removed] == ['jlcpcb','pcbway']
        assert all(c['status']=='not_run' and type(c['warnings']) is int for c in removed)

# Contract cases come from the actual producer, including an unsupported present board.
def fab_contract_cases():
    with tempfile.TemporaryDirectory() as td:
        p, source, out, cfg, sections = fab_test_render(pathlib.Path(td))
        cfg['fail_on'] = 'new'
        with patch.object(kr, 'board_path', side_effect=fab_head_only(source)):
            failed = kr.fab_check(p, cfg, str(out), {'active':{}}, 'jlcpcb')
            unsupported_sections = [{**s, 'layers':8, 'checked':[], 'violations':[],
                                     'unsupported':'not checked: profile covers 4, 6 layers; board has 8'}
                                    for s in sections.values()]
            (out/'head'/'fab-limits.json').write_text(json.dumps({'sections': unsupported_sections}))
            unsupported = kr.fab_check(p, cfg, str(out), {'active':{}}, 'jlcpcb')
            source.unlink()
            absent = kr.fab_check(p, cfg, str(out), {'active':{}}, 'jlcpcb')
        return failed, unsupported, absent


fab_failed, fab_unsupported, fab_absent = fab_contract_cases()
assert kr.FAB_TABLE.name == 'fab_limits.json', 'FAB contract: immutable table name'
assert [c['status'] for c in (fab_failed, fab_unsupported, fab_absent)] == ['fail','fail','not_run']
assert fab_failed['baselineAvailable'] is False and fab_failed['fixed'] == 0, 'FAB contract: this fixture has no base board'
assert fab_unsupported['baselineAvailable'] is False and fab_unsupported['fixed'] == 0, 'FAB contract: no base board'
assert 'baselineAvailable' not in fab_absent and 'fixed' not in fab_absent, 'FAB contract: not_run has no base comparison'
with tempfile.TemporaryDirectory() as td:
    p, source, out, cfg, sections = fab_test_render(pathlib.Path(td))
    source.unlink()
    with patch.object(kr, 'board_path', side_effect=fab_head_only(source)):
        not_run_waived = kr.fab_check(p, cfg, str(out), {'active': {}}, 'jlcpcb')
    assert not_run_waived['status'] == 'not_run' and not_run_waived['waived'] == 0
for c in (fab_failed, fab_unsupported, fab_absent):
    assert c['name'] == 'fab_limits'
    assert c['confidence'] == 'deterministic' and c['evidence_source'] == kr.FAB_EVIDENCE_SOURCE
    assert all(v['confidence'] == c['confidence'] and v['evidence_source'] == c['evidence_source']
               for v in c['violations']), 'FAB contract: explicit finding provenance'
assert fab_failed['new_errors'] == fab_failed['errors'] == 1
assert fab_absent['checked'] == [] and fab_absent['reason'] == 'no head board'

# Base/head pairing (Owner decision 2026-10-26): multiset identity, so one base occurrence matches one head occurrence.
with tempfile.TemporaryDirectory() as td:
    p, source, out, cfg, sections = fab_test_render(pathlib.Path(td))
    cfg['fail_on'] = 'new'
    same, gone, added = fab_test_raw('same'), fab_test_raw('gone'), fab_test_raw('added')
    def write_audit(side, rows):
        pathlib.Path(out, side).mkdir(parents=True, exist_ok=True)
        pathlib.Path(out, side, 'fab-limits.json').write_text(json.dumps(
            {'sections': [{**s, 'violations': rows} for s in sections.values()]}))
    write_audit('head', [copy.deepcopy(same), copy.deepcopy(same), copy.deepcopy(added)])
    write_audit('base', [copy.deepcopy(same), copy.deepcopy(gone)])
    with patch.object(kr, 'board_path', return_value=str(source)):
        c = kr.fab_check(p, cfg, str(out), {'active': {}}, 'jlcpcb')
    assert c['baselineAvailable'] is True
    assert (c['errors'], c['new_errors'], c['fixed']) == (3, 2, 1), 'FAB pairing: multiset, not set'
    assert c['status'] == 'fail'
    assert sorted(v['new'] for v in c['violations']) == [False, True, True]
    assert [v['new'] for v in c['violations']] == [True, True, False], 'FAB pairing: new findings first'

# Supported base findings are existing; unsupported bases cannot mask new findings.
with tempfile.TemporaryDirectory() as td:
    p, source, out, cfg, sections = fab_test_render(pathlib.Path(td))
    (out/'base').mkdir()
    base_audit = out/'base'/'fab-limits.json'
    base_audit.write_bytes((out/'head'/'fab-limits.json').read_bytes())
    with patch.object(kr, 'board_path', return_value=str(source)):
        cfg['fail_on'] = 'new'
        checks = kr.fab_checks(p, cfg, str(out), {'active':{}})
        assert all(c['status']=='pass' and c['errors']==1 and c['new_errors']==0
                   and c['baselineAvailable'] and c['fixed']==0 for c in checks)
        cfg['fail_on'] = 'all'
        assert all(c['status']=='fail' for c in kr.fab_checks(p, cfg, str(out)))
        # One fab waiver applies across vendors, but never to ordinary DRC.
        key = kr.waiver_key(checks[0]['violations'][0])
        waivers = {'active':{('fab_limits',key):{'reason':'prototype','by':'reviewer',
                    'until':'2026-12-31','ref':None}}}
        waived = kr.fab_checks(p, cfg, str(out), waivers)
        assert all(c['status']=='pass' and c['waived']==1 and c['errors']==0 for c in waived)
        assert kr.run_check('drc',cfg,[kr.violation(fab_test_raw('track'),1,{'board':True})],
                            None,waivers)['waived']==0
        base_audit.write_text(json.dumps({'sections':[{**s,'unsupported':'unsupported base layers'}
                                                     for s in sections.values()]}))
        cfg['fail_on'] = 'new'
        assert all(not c['baselineAvailable'] and c['new_errors']==1 and c['fixed']==0
                   for c in kr.fab_checks(p, cfg, str(out)))
        base_audit.unlink()
        try:
            kr.fab_checks(p, cfg, str(out))
            raise AssertionError('FAB missing base audit accepted')
        except SystemExit as exc:
            assert 'Fab limits output missing for Four (base)' in str(exc)

# These helpers are owned by 06/09 and do not exist on main 335db72.
# Standalone 04 runs the producer assertions above; the combined gate must not silently skip.
if os.environ.get('FAB_CROSS_SPEC') == '1':
    assert hasattr(kr, 'absolute_checks'), 'FAB integration requires merged spec 06'
    assert hasattr(kr, 'complete_context_checks'), 'FAB integration requires merged spec 09'

if hasattr(kr, 'absolute_checks'):
    for original in (fab_failed, fab_unsupported, fab_absent):
        current = copy.deepcopy(original)
        kr.absolute_checks([current])
        expected = copy.deepcopy(original)
        expected.update(new_errors=0, new_warnings=0)
        if 'fixed' in expected:
            expected['fixed'] = 0
        for v in expected['violations']:
            v['new'] = False
        assert json.loads(json.dumps(current)) == expected, 'FAB snapshot: only comparison fields may change'
    assert fab_failed['new_errors'] == 1 and fab_failed['violations'][0]['new'] is True

if hasattr(kr, 'complete_context_checks'):
    cfg = copy.deepcopy(kr.DEFAULT_SETTINGS)
    cfg['fabrication']['check_limits'] = True
    cfg['checks']['fab_limits'] = 'required'
    ledger_keys = ('vendor','profile','checkedOn','assumedCopperOz','checked','unchecked','unsupported',
                   'coverageWarnings','baselineAvailable','fixed')
    for original in (fab_failed, fab_unsupported, fab_absent):
        contexts = kr.complete_context_checks([copy.deepcopy(original)], cfg, True,
                                               original['status'] != 'not_run')
        matches = [c for c in contexts if c['name'] == 'fab_limits']
        assert len(matches) == 1, 'FAB context: supplied check lost or duplicated'
        current = matches[0]
        assert current['status'] == original['status'] and current['reason'] == original.get('reason')
        assert (current['errors'], current['warnings']) == (original['errors'], original['warnings'])
        assert current['confidence'] == 'deterministic' and current['evidence_source'] == kr.FAB_EVIDENCE_SOURCE
        assert {k:current[k] for k in ledger_keys if k in original} == {k:original[k] for k in ledger_keys if k in original}, 'FAB context: coverage ledger lost'
        assert len(current['findings']) == len(original['violations'])
        assert all(v['confidence'] == 'deterministic' and v['evidence_source'] == kr.FAB_EVIDENCE_SOURCE
                   for v in current['findings'])
    contexts = kr.complete_context_checks(list(copy.deepcopy(produced_fabs).values()), cfg, True, True)
    assert sorted(c['vendor'] for c in contexts if c['name']=='fab_limits') == ['jlcpcb','pcbway'], 'FAB context: retain both vendors'
    for opt_in, level in ((False,'required'), (True,'off')):
        cfg['fabrication']['check_limits'] = opt_in
        cfg['checks']['fab_limits'] = level
        assert kr.fab_checks({'name':'Disabled'}, cfg, 'unused') == []
        contexts = kr.complete_context_checks([], cfg, True, True)
        assert not any(c['name'] == 'fab_limits' for c in contexts), 'FAB context: disabled check synthesized'

entries,bad = kr.parse_waivers('''
[[waiver]]
check = "fab_limits"
match = "w-0123456789ab"
reason = "Prototype only"
by = "reviewer"
date = 2026-10-25
until = 2026-12-31
''', 'fab fixture')
assert len(entries)==1 and not bad
raw_v = kr.violation(fab_test_raw('track'),1,{'board':True})
key = kr.waiver_key(raw_v)
wrong = {'active':{('drc',key):{'reason':'house only','by':'reviewer','until':'2026-12-31','ref':None}}}
assert kr.run_check('fab_limits',cfg,[copy.deepcopy(raw_v)],None,wrong)['waived']==0
right = {'active':{('fab_limits',key):wrong['active'][('drc',key)]}}
assert kr.run_check('fab_limits',cfg,[copy.deepcopy(raw_v)],None,right)['waived']==1

# Optional integration fixture is built by CI after its PAGES directory exists.
if os.environ.get('FAB_REPORT_FIXTURE'):
    sample = pathlib.Path('ui/sample/review-data.js').read_text()
    data = json.loads(sample.split('=',1)[1].strip().rstrip(';'))
    project = next(p for p in data['projects'] if p.get('board',{}).get('layers'))
    data['fabProducerFixture'] = True
    project['checks'] = [*project['checks'],*(copy.deepcopy(c) for c in produced_fabs.values())]
    data.setdefault('settings',{}).setdefault('checks',{})['fab_limits']='required'
    kr.assign_ids(data['projects'])
    payload = 'window.REVIEW_DATA = '+json.dumps(data).replace('<','\\u003c')+';'
    pathlib.Path(os.environ['FAB_REPORT_FIXTURE']).write_text(kr.inline_page(payload),encoding='utf-8')

with tempfile.TemporaryDirectory() as td:
    cwd=os.getcwd()
    try:
        os.chdir(td); pathlib.Path('review').mkdir()
        pathlib.Path('review/detect.json').write_text(json.dumps({'base':'a'*40,'head':'b'*40,'reason':'fab opt-out','projects':[]}))
        cfg=copy.deepcopy(kr.DEFAULT_SETTINGS)
        with patch.object(kr,'load_settings',return_value=cfg), patch.dict(os.environ,{'GITHUB_OUTPUT':str(pathlib.Path(td,'outputs'))}):
            kr.cmd_report(None)
        data=json.loads(pathlib.Path('review/data.json').read_text())
        assert data['version']==1 and data['projects']==[]
        assert 'fab_limits' not in data['settings']['checks']
        assert 'check_limits' not in data['settings']['fabrication']
        assert cfg['checks']['fab_limits']=='informational' and cfg['fabrication']['check_limits'] is False
        legacy=copy.deepcopy(cfg)
        del legacy['checks']['fab_limits']; del legacy['fabrication']['check_limits']
        with patch.object(kr,'load_settings',return_value=legacy), patch.dict(os.environ,{'GITHUB_OUTPUT':str(pathlib.Path(td,'outputs'))}):
            kr.cmd_report(None)
        assert json.loads(pathlib.Path('review/data.json').read_text())==data
    finally:
        os.chdir(cwd)

print('ok FAB-04 report producer, multiset baseline, provenance, waivers and legacy opt-out')


def fab_four_report(root, board):
    root.mkdir(parents=True,exist_ok=False)
    cfg=copy.deepcopy(kr.DEFAULT_SETTINGS)
    cfg['fabrication']['check_limits']=True
    cfg['checks'].update(drc='required',fab_limits='required')
    p={'name':'Four','dir':'','status':'modified'}
    # Read the Task 3 fixture and its generated project in place, unmodified.
    source=board.resolve()
    with patch.object(kr,'board_path',side_effect=fab_head_only(source)):
        kr.render_fab(p,'head',str(root/'head'),cfg)
        checks=kr.fab_checks(p,cfg,str(root),{'active':{}})
    sections={s['vendor']:s for s in json.loads((root/'head'/'fab-limits.json').read_text())['sections']}
    jl=sections['jlcpcb']
    assert jl['profile']=='jlcpcb-multilayer' and jl['layers']==4
    assert sections['pcbway']['profile']=='pcbway-std' and sections['pcbway']['unsupported'] is None
    assert jl['values']['trackWidthOuterMm']==jl['values']['trackWidthInnerMm']==.09
    for check in checks:
        vendor=check['vendor']
        assert {'trackWidthOuterMm','trackWidthInnerMm'} <= set(check['checked']), vendor
        assert 'edgeClearanceMm' in check['checked'] and not check['unsupported'], vendor
        for layer in ('F.Cu','In1.Cu','B.Cu'):
            assert fab_target(sections[vendor]['violations'],'track_width',['four-'+layer]), (vendor,layer)
            assert any(v['type']=='track_width' and fab_uid('four-'+layer) in v['uuids']
                       for v in check['violations']), ('report track missing',vendor,layer)
    sample=pathlib.Path('ui/sample/review-data.js').read_text()
    data=json.loads(sample.split('=',1)[1].strip().rstrip(';'))
    project=next(p for p in data['projects'] if p.get('board',{}).get('layers'))
    data['projects']=[project]
    project['name']='Four'; project['checks']=checks
    data['fabFourLayerFixture']=True
    kr.assign_ids(data['projects'])
    payload='window.REVIEW_DATA = '+json.dumps(data).replace('<','\\u003c')+';'
    (root/'four-layer.html').write_text(kr.inline_page(payload),encoding='utf-8')
    print('ok FAB-04 real four-layer report: both vendors, outer/inner tracks and closed outline')


if os.environ.get('KICAD_FAB_FOUR_REPORT'):
    fab_four_report(pathlib.Path(os.environ['KICAD_FAB_FOUR_REPORT']),
                    pathlib.Path(os.environ['KICAD_FAB_BOARD']))

if os.environ.get('KICAD_FAB_VERIFY') == '1':
    fab_capability_probe(pathlib.Path(os.environ['KICAD_FAB_OUT']))

# BR03 Task 6.2: unreadable optional rules keep symbols, drop unknown metadata on both sides, and warn.
import contextlib, hashlib
from kicad_review import project_pair
DRU = b'(rule "wide" (constraint clearance (min 0.2mm)))\xff'  # non-UTF-8 bytes: the .dru hash is byte-based
def pair_with_warnings():
    with contextlib.redirect_stderr(io.StringIO()) as log:
        objs, issues = project_pair({"dir": "p", "name": "p"})
    return objs, issues, log.getvalue()
def assert_symbols_kept(objs):
    assert all(any(o["kind"] == "symbol" for o in x.values()) for x in objs.values())
with tempfile.TemporaryDirectory() as td:
    old = os.getcwd(); os.chdir(td)
    try:
        for side in ("base", "head"):
            write(side, {"p/p.kicad_sch": '(kicad_sch (symbol (uuid s) (at 1 2 0) (property "Reference" "R1")))',
                         "p/p.kicad_pro": '{"board":{"design_settings":{"rules":{"min_clearance":0.2}}}}'})
            pathlib.Path(side, "p/p.kicad_dru").write_bytes(DRU)
        objs, issues, warnings = pair_with_warnings()
        assert not issues and not warnings and all("meta:pro" in x and "meta:dru" in x for x in objs.values())
        assert all(x["meta:dru"]["props"]["custom rules"] == hashlib.sha1(DRU).hexdigest()[:10] for x in objs.values())
        # Malformed .pro on each side in turn.
        for side in ("base", "head"):
            file = pathlib.Path(side) / "p/p.kicad_pro"; valid = file.read_text(); file.write_text('{broken')
            objs, issues, warnings = pair_with_warnings()
            assert issues and issues[0]["channel"] == "rules" and issues[0]["unknownMeta"] == "meta:pro"
            assert_symbols_kept(objs)
            assert all("meta:pro" not in x for x in objs.values()), "BR03 unknown metadata became removal"
            assert all("meta:dru" in x for x in objs.values()), "valid .dru must survive a bad .pro"
            assert f"{side}/p/p.kicad_pro: optional rules unavailable" in warnings
            file.write_text(valid)
        # Unreadable .dru on head only (a directory makes read_bytes raise IsADirectoryError).
        dru = pathlib.Path("head/p/p.kicad_dru"); dru.unlink(); dru.mkdir()
        objs, issues, warnings = pair_with_warnings()
        assert issues and issues[0]["channel"] == "rules" and issues[0]["unknownMeta"] == "meta:dru"
        assert_symbols_kept(objs)
        assert all("meta:dru" not in x for x in objs.values()), "one-sided unreadable .dru must not show as removal"
        assert all("meta:pro" in x for x in objs.values()), "valid .pro must survive a bad .dru"
        assert "head/p/p.kicad_dru: optional rules unavailable" in warnings
        # Unreadable .dru on both sides: still symmetric suppression.
        pathlib.Path("base/p/p.kicad_dru").unlink(); pathlib.Path("base/p/p.kicad_dru").mkdir()
        objs, issues, warnings = pair_with_warnings()
        assert issues and all("meta:dru" not in x for x in objs.values()) and all("meta:pro" in x for x in objs.values())
        dru.rmdir(); pathlib.Path("base/p/p.kicad_dru").rmdir()
        # Recovery: both files readable again, no issues, nothing suppressed.
        for side in ("base", "head"): pathlib.Path(side, "p/p.kicad_dru").write_bytes(DRU)
        objs, issues, warnings = pair_with_warnings()
        assert not issues and not warnings and all("meta:pro" in x and "meta:dru" in x for x in objs.values())
    finally: os.chdir(old)
print('ok BR03 project_pair guards optional rules')


def test_br03_summary():
    from kicad_review import electrical_summary, classify_change
    rows=[kr.electrical_row("net-added","X","added"),kr.electrical_row("net-joined","Y")]
    s=electrical_summary(rows,[{"channel":"routing","reason":"pcbnew unavailable"}])
    assert s["headline"]=="1 nets added · 1 net joins"
    assert next(c for c in s["channels"] if c["channel"]=="routing")["status"]=="incomplete"
    metadata=[classify_change({"kind":"design rules","ref":key,"uuid":key,"where":None,
        "action":"modified","changes":[["unrelated","a","b"]]}) for key in ("meta:setup","meta:pro","meta:dru","meta:title_block:board")]
    assert all(r["document"]=="board" for r in metadata)
    s=electrical_summary(metadata,[],{"board"})
    assert len(s["documents"])==1 and s["documents"][0]["document"]=="board"
    assert sum(c["total"] for c in s["documents"][0]["channels"])==4
    assert next(c for c in s["channels"] if c["channel"]=="wiring")["status"]=="complete"
    assert next(c for c in electrical_summary([],[],set())["channels"] if c["channel"]=="wiring")["status"]=="not_applicable"
    assert next(c for c in electrical_summary([],[{"document":"schematic","channel":"wiring","reason":"head netlist unavailable"}],{"schematic"})["channels"] if c["channel"]=="wiring")["status"]=="incomplete"
    assert classify_change({"kind":"footprint","action":"modified","changes":[["footprint","a","b"]]})["weight"]=="heavy"
    assert classify_change({"kind":"symbol","action":"modified","changes":[["position","a","b"]]})["weight"]=="light"
    pad={**kr.electrical_row("board-pad-net","D1.C",channel="wiring",weight="heavy"),"document":"board"}
    def status(summary,channel):
        return next(c for c in summary["channels"] if c["channel"]==channel)
    s=electrical_summary([pad],[],{"board"})
    assert status(s,"wiring")=={"channel":"wiring","total":1,"heavy":1,"status":"complete"}
    zero=electrical_summary([],[],{"board"})
    assert status(zero,"wiring")=={"channel":"wiring","total":0,"heavy":0,"status":"complete"}
    assert status(s["documents"][0],"wiring")["status"]=="complete"
    sch={**kr.electrical_row("net-added","A",channel="wiring"),"document":"schematic"}
    s=electrical_summary([sch,pad],[{"document":"board","channel":"routing","reason":"pcbnew unavailable"}],{"board","schematic"})
    docs={d["document"]:d for d in s["documents"]}
    assert status(s,"routing")["status"]=="incomplete"
    assert status(docs["schematic"],"wiring")["status"]=="complete"
    assert status(docs["schematic"],"routing")["status"]=="not_applicable"
    assert docs["schematic"]["incomplete"]==[]
    assert status(docs["board"],"wiring")["total"]==1
    assert status(docs["board"],"routing")["status"]=="incomplete"
    # tracks never count as components in the headline
    t=classify_change({"kind":"track","action":"added","changes":[]})
    assert electrical_summary([t],[],{"board"})["headline"]=="No headline changes"
    # position detail computation and case-insensitive headline check
    moved=classify_change({"kind":"symbol","action":"modified","changes":[["Position","a","b"]],
                           "pos":[10,20],"pos_before":[7,16]})
    assert moved["detail"]=={"kind":"position","before":[7,16],"after":[10,20],"distanceMm":5.0}
    assert electrical_summary([moved],[])["headline"]=="1 moved"
    # caller-supplied document overrides row key
    assert classify_change({"kind":"symbol","action":"modified","document":"schematic"},document="board")["document"]=="board"
test_br03_summary()
print('ok BR03 classification and summary')


def test_br03_build_integration():
    from kicad_review import dedupe_electrical
    import base64, gzip
    assert kr.flatten({"net_settings":{"netclass_patterns":[{"pattern":"X","netclass":"D"}]}}).keys() == {
        "net_settings.netclass_patterns.0.pattern","net_settings.netclass_patterns.0.netclass"}
    typed=[{"kind":"rule","ref":"rules.min_clearance"},{"kind":"rule","ref":"net_settings.classes.Default.clearance"},
           {"kind":"rule","ref":"net_settings.netclass_patterns"},{"kind":"rule","ref":"custom rules"},
           {"kind":"stackup","ref":"stackup"}]
    generic=[{"uuid":"meta:pro","kind":"design rules","changes":[[k,"a","b"] for k in (
                "board.rules.min_clearance","board.rules.min_clearance_extra","net_settings.classes.Default.clearance",
                "net_settings.classes.Default.track_width","net_settings.netclass_patterns.0.pattern",
                "net_settings.netclass_patterns.0.netclass","erc.pin_not_connected")]},
             {"uuid":"meta:setup","kind":"design rules","changes":[["stackup.layer[F.Cu].thickness","a","b"],["pad_to_mask_clearance","a","b"]]},
             {"uuid":"meta:dru","kind":"design rules","changes":[["custom rules","a","b"]]},
             {"uuid":"meta:pro","kind":"design rules","action":"added","props":{"board.rules.min_clearance":"0.2"}},
             {"uuid":"fp","kind":"footprint","changes":[["board.rules.min_clearance","a","b"]]}]
    kept=dedupe_electrical(generic,typed)
    assert [x[0] for x in kept[0]["changes"]]==["board.rules.min_clearance_extra","net_settings.classes.Default.track_width",
                                                 "erc.pin_not_connected"], kept
    assert [x[0] for x in kept[1]["changes"]]==["pad_to_mask_clearance"] and len(kept)==3 and kept[2]["uuid"]=="fp"
    assert len(generic[0]["changes"])==7, "dedupe_electrical must not mutate its input rows"
    assert dedupe_electrical(generic,[])==generic
    with tempfile.TemporaryDirectory() as td:
        old=os.getcwd(); os.chdir(td)
        try:
            p={"dir":"p","name":"p","status":"modified"}
            settings=kr.load_settings()
            for side,clearance in (("base",0.2),("head",0.25)):
                write(side,{"p/p.kicad_sch":'(kicad_sch (uuid root) (symbol (uuid r) (at 1 2 0) (property "Reference" "R1")))',
                    "p/p.kicad_pro":json.dumps({"board":{"design_settings":{"rules":{"min_clearance":clearance},"unrelated":side}},
                      "net_settings":{"netclass_patterns":[{"pattern":"X*","netclass":side}]}})})
                write('review/p/'+side,{"sch/p.svg":'<svg width="10mm" height="10mm" viewBox="0 0 10 10"/>',
                    "netlist.net":'(export (nets))',"erc.json":'{"sheets":[]}'})
            write('review',{"detect.json":json.dumps({"base":"b"*40,"head":"h"*40})})
            project=kr.build_project(p,{},settings)
            assert 'summary' in project and 'electrical_summary' not in project, 'BR03 summary wire field renamed'
            wiring=next(c for c in project['summary']['channels'] if c['channel']=='wiring')
            assert wiring=={'channel':'wiring','total':0,'heavy':0,'status':'complete'}, 'BR03 zero-row wiring unavailable'
            assert sum(r["kind"]=="rule" and r["ref"]=="rules.min_clearance" for r in project["changes"])==1
            generic=[x[0] for r in project["changes"] if r.get("uuid")=="meta:pro" for x in r.get("changes",[])]
            assert "board.unrelated" in generic
            assert not any(k.startswith("board.rules.") or k.startswith("net_settings.netclass_patterns") for k in generic)
            for side in ("base","head"):
                f=pathlib.Path(side)/"p/p.kicad_pro"; saved=f.read_text(); f.write_text('{broken')
                with contextlib.redirect_stderr(io.StringIO()):
                    incomplete=kr.build_project(p,{},settings)
                assert incomplete["sheets"] and any(i["channel"]=="rules" for i in incomplete["summary"]["incomplete"])
                assert not any(r["kind"]=="rule" or r.get("uuid")=="meta:pro" for r in incomplete["changes"])
                f.write_text(saved)
            other=kr.build_project(p,{},settings,change_offset=len(project["changes"]))
            kr.assign_ids([project,other])
            ids=[r["id"] for proj in (project,other) for r in proj["changes"]]
            assert len(ids)==len(set(ids))
            for side,net in (("base","GND"),("head","VCC")):
                pcb=br03_pcb("fp",[("physical-pad","1",0,net)]).replace('(kicad_pcb ',
                    '(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ')
                write(side,{"p/p.kicad_pcb":pcb})
                write("review/p/"+side,{"pcb/p-F_Cu.svg":'<svg width="10mm" height="10mm" viewBox="0 0 10 10"/>',"drc.json":'{"violations":[],"unconnected_items":[],"schematic_parity":[]}'})
            blobs={}; board_project=kr.build_project(p,blobs,settings)
            owner=next(r for r in board_project["changes"] if r["kind"]=="footprint")
            derived=next(r for r in board_project["changes"] if r["kind"]=="board-pad-net")
            assert derived["id"]!=owner["id"] and "uuid" not in derived
            for side in ("base","head"):
                blob=board_project["board"]["geometry"][side]
                scene=json.loads(gzip.decompress(base64.b64decode(blobs[blob])))
                physical=[o for o in scene["objects"] if o["changeUuid"]=="fp"]
                assert physical and all(o["changeIds"]==[owner["id"]] for o in physical)
        finally: os.chdir(old)
test_br03_build_integration()
print('ok BR03 build integration, rule dedup and stable IDs')

def test_br03_hotspot_contract():
    """01's real sheet_hotspots + add_blob output is the literal fixture 03's browser checks consume."""
    with tempfile.TemporaryDirectory() as td:
        manifests={}
        for side in ('base','head'):
            root=pathlib.Path(td)/side
            pins='(pin input line (at -5 0 0) (length 2) (name "123") (number "1"))'
            if side=='base':
                pins+='(pin input line (at 5 0 180) (length 2) (name "456") (number "12"))'
            shared=('(kicad_sch (uuid child) (paper A4) '
                '(lib_symbols (symbol "Test:Pair" (symbol "Pair_0_1" '
                '(rectangle (start -1 -1) (end 1 1))) (symbol "Pair_1_1" '+pins+'))) '
                '(symbol (uuid placed) (lib_id "Test:Pair") (unit 1) (at 100 50 0) '
                '(property "Reference" "U?") (property "Value" "Pair") '
                '(instances (project "P" (path "/root/left" (reference "U1") (unit 1)) '
                '(path "/root/right" (reference "U2") (unit 1))))))')
            write(str(root),{'P.kicad_sch':'(kicad_sch (uuid root) (paper A4) '+
                  sheet('Left','shared.kicad_sch','left')+sheet('Right','shared.kicad_sch','right')+')',
                  'shared.kicad_sch':shared})
            manifests[side]=kr.sheet_hotspots(str(root),'P')
            views={v['sheet']:v for v in manifests[side]['views']}
            left,right=(views[s]['elements'][0] for s in ('/left/','/right/'))
            assert left['uuid']==right['uuid']=='placed' and (left['ref'],right['ref'])==('U1','U2')
            assert [(p['number'],p['name']) for p in left['pins']]==(
                [('1','123'),('12','456')] if side=='base' else [('1','123')])
        blobs={}
        ids={s:kr.add_blob(blobs,json.dumps(m,sort_keys=True)) for s,m in manifests.items()}
        contract={'sheets':[{'path':path,'hotspots':dict(ids)} for path in ('/left/','/right/')],
                  'blobs':blobs}
        fixture=pathlib.Path('ui/fixtures/br03-hotspot-contract.json')
        if os.environ.get('BR03_WRITE_FIXTURES')=='1':
            fixture.write_text(json.dumps(contract,sort_keys=True,indent=2)+'\n',encoding='utf-8')
        # gzip headers record the host OS (macOS ff, Linux 03), so compare decoded blob content.
        decoded=lambda c:{**c,'blobs':{k:gzip.decompress(base64.b64decode(v)) for k,v in c['blobs'].items()}}
        assert decoded(json.loads(fixture.read_text(encoding='utf-8')))==decoded(contract), 'BR03 hotspot producer contract drift'
test_br03_hotspot_contract()
print('ok BR03 hotspot producer contract')


def test_br03_connectivity_markdown():
    from kicad_review import connectivity_markdown
    p = {"changes":[kr.electrical_row("net-added",f"N{i}","added",detail={"kind":"members","added":["U1.1"],"removed":[],"beforeNets":[],"afterNets":[f"N{i}"]}) for i in range(21)]}
    table = '\n'.join(connectivity_markdown(p))
    assert 'Connectivity' in table and 'N19' in table and 'N20' not in table
    assert 'and 1 more in the report' in table
    p["changes"][0]["ref"] = 'pipe|line\n<script>'
    assert '<script>' not in '\n'.join(connectivity_markdown(p))
    p['changes'] = kr.diff_nets({'A':{'a','b'},'B':{'c','d'}},{'C':{'a','c'},'D':{'b','d'}})
    table = '\n'.join(connectivity_markdown(p))
    assert all(t in table for t in ('a: A → C','b: A → D','c: B → C','d: B → D'))

    for count in (0,20,21):
        project={"changes":[kr.electrical_row("net-added",f"N{i}","added",detail={"kind":"members","added":["U1.1"]}) for i in range(count)]}
        table='\n'.join(connectivity_markdown(project))
        assert bool(table)==bool(count)
        if count: assert table.count('| net-added |')==min(count,20)
        assert ('and 1 more in the report' in table)==(count==21)
    joined=kr.electrical_row("net-joined","C",detail={"kind":"members","added":[],"removed":[],"beforeNets":["A","B"],"afterNets":["C"]})
    assert 'A + B → C' in '\n'.join(connectivity_markdown({"changes":[joined]}))
    assert connectivity_markdown({"changes":[]})==[]
    # Malformed or missing detail does not raise KeyError
    malformed = [
        {"kind": "net-members", "ref": "N1", "detail": {"transitions": [{"pin": "P1"}]}},
        {"kind": "net-members", "ref": "N2", "detail": {"transitions": [{"before": ["A"], "after": ["B"]}]}},
        {"kind": "net-members", "ref": "N3", "detail": {"transitions": ["not-a-dict"]}},
        {"kind": "net-members", "ref": "N4", "detail": {}},
        {"kind": "net-members", "ref": "N5"},
    ]
    malformed_table = '\n'.join(connectivity_markdown({"changes": malformed}))
    assert 'P1: \\(unconnected\\) → \\(unconnected\\)' in malformed_table
    assert ': A → B' in malformed_table

    project={**ld['projects'][0],"summary":{"headline":"rule|changed\n<script>","incomplete":[{"channel":"routing","reason":"<script>"}]}}
    data={**ld,"projects":[project]}
    row=log_row(data,"2026-10-12 10:04")
    assert 'rule\\|changed' in row, 'BR03 log headline absent'
    assert '<script>' not in row and extract_log(merge_log([],row))==[row]
    body=comment_markdown(data,[],"")
    assert 'routing' in body and '<script>' not in body
    assert '\n\nrule\\|changed\n&lt;script&gt;\n\nrouting: &lt;script&gt;' in body, 'Headline and incomplete notes must be separate paragraphs'
    assert comment_markdown({**ld,"projects":[ld['projects'][0]]},[],"")
    large_project={**project,"summary":{"headline":"x"*70000,"incomplete":[]}}
    body=comment_markdown({**ld,"projects":[large_project]},[],"")
    assert len(body)<=65536, 'BR03 electrical headline bypassed body budget'
    assert 'x'*201 not in body, 'Comment headline must be capped'
    long_incomplete_proj = {**project, "summary": {"headline": "rule", "incomplete": [{"channel": "routing", "reason": "z" * 300}]}}
    long_incomplete_body = comment_markdown({**ld, "projects": [long_incomplete_proj]}, [], "")
    assert "routing: " + "z" * 190 + "…" in long_incomplete_body, "Incomplete reason over 200 chars must be truncated with ellipsis"
    assert "z" * 192 not in long_incomplete_body
    readme=pathlib.Path('README.md').read_text()
    assert all(token in readme for token in ('0.05','0.005','120'))
    assert 'no new setting' in readme.lower()

test_br03_connectivity_markdown()
print('ok BR03 connectivity markdown and documentation')


# ---- Spec 07: revision downloads ----
import copy, csv, hashlib, io, json, os, pathlib, tempfile, types, zipfile
from unittest.mock import patch
import kicad_review as kr
from kicad_review import DEFAULT_SETTINGS, load_settings

assert DEFAULT_SETTINGS["downloads"] == {"enabled": False, "step": True}
for text, error in (("downloads = true", "downloads must be a table"),
                    ("[downloads]\nenabled = 1", "downloads.enabled must be true or false"),
                    ('[downloads]\nstep = "no"', "downloads.step must be true or false")):
    with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(text.encode()), create=True):
        try:
            load_settings()
            raise AssertionError("invalid downloads settings accepted")
        except SystemExit as e:
            assert str(e) == "kicad-review.toml: " + error, e
with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(b"[downloads]\nenabled = true\nstep = false\n"), create=True):
    assert load_settings()["downloads"] == {"enabled": True, "step": False}
print("ok downloads settings")

# Partial tables retain defaults, and callers cannot mutate later loads or defaults.
for text, expected in (("", {"enabled": False, "step": True}),
                       ("[downloads]", {"enabled": False, "step": True}),
                       ("[downloads]\nenabled = true", {"enabled": True, "step": True}),
                       ("[downloads]\nstep = false", {"enabled": False, "step": False})):
    with patch("kicad_review.os.path.exists", return_value=True), patch("kicad_review.open", return_value=io.BytesIO(text.encode()), create=True):
        loaded = load_settings()["downloads"]
        assert loaded == expected, (text, loaded)
        loaded["enabled"] = not loaded["enabled"]
        loaded["step"] = not loaded["step"]
    assert DEFAULT_SETTINGS["downloads"] == {"enabled": False, "step": True}
with patch("kicad_review.os.path.exists", return_value=False):
    assert load_settings()["downloads"] == {"enabled": False, "step": True}
print("ok downloads defaults and load isolation")

# Downloads: one export is recorded, never raised; partial files are removed.
from kicad_review import export_one, safe_name
assert safe_name("a b/c") == "a-b-c" and safe_name("...") == "project" and safe_name("Thermal_Camera") == "Thermal_Camera"
POS = "Ref,Val,Package,PosX,PosY,Rot,Side\nR1,10k,R_0603,10,20,90,top\n"
BOM = "Comment,Designator,Footprint,LCSC Part #\n10k,R1,R_0603,C123\n"
dl_real, dl_calls, dl_mode = kr.subprocess.run, [], {}
def dl_fake(args, **kw):
    if not args[0].endswith("kicad-cli"):
        return dl_real(args, **kw)
    dl_calls.append((args, kw.get("timeout")))
    kind = args[3]
    out = pathlib.Path(args[args.index("-o") + 1])
    mode = dl_mode.get(kind)
    if mode == "rc":
        return types.SimpleNamespace(returncode=7, stdout="", stderr="boom")
    if mode != "nofile":
        if kind in ("gerbers", "drill"):
            out = out / ("P.drl" if kind == "drill" else "P-F_Cu.gbr")
        out.parent.mkdir(parents=True, exist_ok=True)
        if kind == "bom":
            labels = args[args.index("--labels") + 1]
            out.write_text("" if mode == "empty" else labels + "\n")
        else:
            out.write_text("" if mode == "empty" else {"pos": "Ref,Val\nR1,10k\n" if mode == "badheader" else POS}.get(kind, "data"))
        if kind == "gerbers" and mode != "empty":
            (out.parent / "P-B_Cu.gbr").write_text("data")
    if mode == "timeout":
        raise kr.subprocess.TimeoutExpired(args, kw.get("timeout"))
    return types.SimpleNamespace(returncode=0, stdout="", stderr="")
kr.subprocess.run = dl_fake
try:
    t = tempfile.mkdtemp()
    ok = export_one("pdf", ["sch", "export", "pdf", "-o", f"{t}/a.pdf"], f"{t}/a.pdf")
    assert ok == {"kind": "pdf", "label": "Schematic PDF", "file": "a.pdf", "error": None}, ok
    dl_mode["pdf"] = "rc"
    bad = export_one("pdf", ["sch", "export", "pdf", "-o", f"{t}/b.pdf"], f"{t}/b.pdf")
    assert bad["file"] is None and bad["error"] == "kicad-cli exited 7", bad
    dl_mode["pdf"] = "nofile"
    stale = f"{t}/stale.pdf"; pathlib.Path(stale).write_bytes(b"previous success")
    empty = export_one("pdf", ["sch", "export", "pdf", "-o", stale], stale)
    assert empty["file"] is None and empty["error"] == "kicad-cli wrote no file" and not pathlib.Path(stale).exists(), empty
    dl_mode["pdf"] = "empty"
    zero = export_one("pdf", ["sch", "export", "pdf", "-o", f"{t}/zero.pdf"], f"{t}/zero.pdf")
    assert zero["file"] is None and zero["error"] == "kicad-cli wrote no file" and not os.path.exists(f"{t}/zero.pdf")
    dl_mode.pop("pdf")
    dl_mode["step"] = "timeout"
    slow = export_one("step", ["pcb", "export", "step", "-o", f"{t}/d.step"], f"{t}/d.step", 120)
    assert slow["file"] is None and slow["error"] == "skipped: export took longer than 120 s", slow
    assert dl_calls[-1][1] == 120 and not os.path.exists(f"{t}/d.step"), "partial STEP must be deleted"
finally:
    kr.subprocess.run = dl_real
print("ok export_one records failures instead of raising")

# Operational errors and failed-output cleanup must not abort report generation.
assert kr.DOWNLOAD_STEP_TIMEOUT == 120
assert kr.DOWNLOAD_LABELS == {"fab": "For fabrication", "pdf": "Schematic PDF", "step": "3D model (STEP)", "glb": "3D model (GLB)"}
with tempfile.TemporaryDirectory() as dl_dir:
    dest = pathlib.Path(dl_dir) / "board.step"
    args = ["pcb", "export", "step", "-o", str(dest)]
    with patch("kicad_review.subprocess.run", side_effect=FileNotFoundError("missing kicad-cli")):
        unavailable = export_one("step", args, str(dest))
    assert unavailable["file"] is None and unavailable["error"].startswith("kicad-cli unavailable:"), unavailable

    def dl_partial_failure(command, **kw):
        dest.write_bytes(b"partial STEP")
        return types.SimpleNamespace(returncode=7)

    with patch("kicad_review.subprocess.run", side_effect=dl_partial_failure):
        failed = export_one("step", args, str(dest))
    assert failed["file"] is None and failed["error"] == "kicad-cli exited 7" and not dest.exists(), failed
    with patch("kicad_review.subprocess.run", side_effect=dl_partial_failure), patch("kicad_review.os.remove", side_effect=PermissionError("output locked")):
        locked = export_one("step", args, str(dest))
    assert locked["file"] is None and "cannot remove output:" in locked["error"], locked
    dest.unlink()
    # A broken stale symlink must also be removed before exporting.
    dest.symlink_to(pathlib.Path(dl_dir) / "missing.step")
    with patch("kicad_review.subprocess.run", return_value=types.SimpleNamespace(returncode=0)):
        missing = export_one("step", args, str(dest))
    assert missing["file"] is None and missing["error"] == "kicad-cli wrote no file" and not dest.is_symlink(), missing
print("ok export_one isolates operational and cleanup errors")

from kicad_review import export_downloads
import contextlib

def dl_export(*args, **kwargs):
    """Capture expected synthetic KiBot notices so fixture diagnostics stay quiet."""
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = export_downloads(*args, **kwargs)
    lines = output.getvalue().splitlines()
    notices = [line for line in lines if line.startswith("::notice::")]
    assert all("fabrication differs from KiBot v1.9.1 template:" in line or
               re.fullmatch(r"::notice::.+: JLCPCB CPL rotation rules matched \d+ rows \(JLCKicadTools table, pinned\)", line)
               for line in notices), lines
    assert all(line.startswith(("::notice::", "::warning::")) for line in lines), lines
    for line in lines:
        if line.startswith("::warning::"):
            print(line)
    return result
PCB = '(kicad_pcb\n(layers\n(0 "F.Cu" signal)\n(31 "B.Cu" signal)\n(44 "Edge.Cuts" user)\n)\n)'
def dl_project(root, name, sch=True, pcb=True):
    src = pathlib.Path(root, "src"); src.mkdir(parents=True, exist_ok=True)
    (src / f"{name}.kicad_pro").write_text("{}")
    if sch: (src / f"{name}.kicad_sch").write_text("(kicad_sch)")
    if pcb: (src / f"{name}.kicad_pcb").write_text(PCB)
    # 02's raw head export, as its render step would leave it beside the project source.
    pathlib.Path(root, "out").mkdir(parents=True, exist_ok=True)
    pathlib.Path(root, "out", "board.raw.glb").write_bytes(b"glTF-raw")
    return str(src)
dl_settings = copy.deepcopy(DEFAULT_SETTINGS); dl_settings["downloads"]["enabled"] = True
kr.subprocess.run = dl_fake
try:
    t = tempfile.mkdtemp(); src = dl_project(t, "P"); dl_calls.clear(); dl_mode.clear()
    entries = dl_export({"name": "P", "dir": ""}, src, f"{t}/out", dl_settings, "b" * 40)
    stem, dl = "P-bbbbbbb", f"{t}/out/downloads"
    assert [e["kind"] for e in entries] == ["fab", "pdf", "step", "glb"] and all(e["error"] is None for e in entries), entries
    assert [c[0][3] for c in dl_calls] == ["gerbers", "drill", "pos", "bom", "pdf", "step"], "the GLB is copied from 02's raw product, never exported here"
    assert [e["file"] for e in entries] == [f"fab-{stem}.zip", f"{stem}-schematic.pdf", f"{stem}-board.step", f"{stem}-board.glb"]
    assert next(c for c in dl_calls if c[0][3] == "step") == (["kicad-cli", "pcb", "export", "step", "--subst-models", "-f", "-o", f"{dl}/{stem}-board.step", f"{src}/P.kicad_pcb"], 120)
    assert pathlib.Path(dl, f"{stem}-board.glb").read_bytes() == b"glTF-raw", "download GLB must be 02's raw bytes, unchanged"
    assert next(c[0] for c in dl_calls if c[0][3] == "pdf") == ["kicad-cli", "sch", "export", "pdf", "-o", f"{dl}/{stem}-schematic.pdf", f"{src}/P.kicad_sch"]
    with zipfile.ZipFile(f"{dl}/fab-{stem}.zip") as z:
        assert sorted(z.namelist()) == ["P-review-jlcpcb-bom.csv", "P-review-jlcpcb-gerbers.zip", "P-review-jlcpcb-positions.csv"]
    manifest = json.loads(pathlib.Path(f"{dl}/downloads.json").read_text())
    assert set(manifest) == {"files", "purpose", "policy"} and manifest["purpose"] == "comparison", manifest.keys()
    for internal, item in zip(entries, manifest["files"]):
        data = pathlib.Path(dl, internal["file"]).read_bytes()
        assert item == {"kind": internal["kind"], "label": internal["label"], "path": internal["file"], "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    # Downloads alone never create shared release evidence. Seed a real release-check
    # package explicitly, then prove a valid existing package is reused, not rebuilt.
    assert not pathlib.Path(t, "out/fab").exists()
    pathlib.Path(t, "out/fab").mkdir()
    kr.release_project(f"{src}/P.kicad_pro", "review", dl_settings, f"{t}/out/fab", "P")
    dl_calls.clear()
    dl_export({"name": "P", "dir": ""}, src, f"{t}/out", dl_settings, "b" * 40)
    assert [c[0][3] for c in dl_calls] == ["pdf", "step"], dl_calls
    # downloads.step = false drops STEP entirely.
    no_step = copy.deepcopy(dl_settings); no_step["downloads"]["step"] = False
    dl_calls.clear()
    assert [e["kind"] for e in dl_export({"name": "P", "dir": ""}, src, f"{t}/out", no_step, "b" * 40)] == ["fab", "pdf", "glb"]
    assert not pathlib.Path(f"{t}/out/downloads/{stem}-board.step").exists(), "disabled STEP must not remain staged"
    (pathlib.Path(src) / "P.kicad_sch").unlink()
    dl_export({"name": "P", "dir": ""}, src, f"{t}/out", no_step, "b" * 40)
    assert not pathlib.Path(f"{t}/out/downloads/{stem}-schematic.pdf").exists(), "removed schematic must not leave stale PDF"
    # Failure isolation: fab fails, STEP times out; PDF and GLB still arrive and nothing is left half-written.
    t2 = tempfile.mkdtemp(); src2 = dl_project(t2, "P"); dl_mode.update({"gerbers": "rc", "step": "timeout"})
    with patch("sys.stdout", new_callable=io.StringIO) as warnings:
        bad = dl_export({"name": "P", "dir": ""}, src2, f"{t2}/out", dl_settings, "b" * 40)
    assert "::warning::P: fabrication export failed" in warnings.getvalue() and "::warning::P: 3D model (STEP): skipped: export took longer than 120 s" in warnings.getvalue(), warnings.getvalue()
    assert [(e["kind"], e["file"] is None) for e in bad] == [("fab", True), ("pdf", False), ("step", True), ("glb", False)], bad
    assert bad[0]["error"] == "fabrication export failed" and bad[2]["error"] == "skipped: export took longer than 120 s"
    assert not os.path.exists(f"{t2}/out/downloads/fab-{stem}.zip") and not os.path.exists(f"{t2}/out/downloads/{stem}-board.step")
    # A missing 02 raw GLB is recorded as an error and never re-exported; a snapshot call without its trusted policy is refused.
    os.remove(f"{t2}/out/board.raw.glb")
    with patch("sys.stdout", new_callable=io.StringIO) as warnings:
        no_raw = dl_export({"name": "P", "dir": ""}, src2, f"{t2}/out", dl_settings, "b" * 40)
    assert "::warning::3D model (GLB): board.raw.glb was not produced" in warnings.getvalue() and "::warning::P: 3D model (GLB): GLB export missing" in warnings.getvalue(), warnings.getvalue()
    assert [e["error"] for e in no_raw if e["kind"] == "glb"] == ["GLB export missing"], no_raw
    assert not os.path.exists(f"{t2}/out/downloads/P-bbbbbbb-board.glb") and not any(c[0][3] == "glb" for c in dl_calls)
    try:
        dl_export({"name": "P", "dir": ""}, src2, f"{t2}/out", dl_settings, "b" * 40, purpose="snapshot")
        raise AssertionError("snapshot downloads accepted comparison settings")
    except ValueError:
        pass
    # No schematic: no PDF. No board: PDF only. A name with spaces is made file-safe.
    dl_mode.clear(); t3 = tempfile.mkdtemp()
    only_board = dl_export({"name": "My Board", "dir": ""}, dl_project(t3, "My Board", sch=False), f"{t3}/out", dl_settings, "b" * 40)
    assert [e["kind"] for e in only_board] == ["fab", "step", "glb"] and only_board[0]["file"] == "fab-My-Board-bbbbbbb.zip", only_board
    t4 = tempfile.mkdtemp()
    only_sch = dl_export({"name": "S", "dir": ""}, dl_project(t4, "S", pcb=False), f"{t4}/out", dl_settings, "b" * 40)
    assert [e["kind"] for e in only_sch] == ["pdf"], only_sch
    # Preset-specific output and header assertions. The KiBot template checks are in the Task 3A block.
    for preset in ("jlcpcb", "pcbway"):
        case = tempfile.mkdtemp(); source = dl_project(case, "P")
        cfg = copy.deepcopy(dl_settings); cfg["fabrication"]["preset"] = preset
        dl_calls.clear()
        made = dl_export({"name": "P", "dir": ""}, source, f"{case}/out", cfg, "b"*40)
        assert not made[0]["error"], made
        with zipfile.ZipFile(f"{case}/out/downloads/fab-P-bbbbbbb.zip") as z:
            assert set(z.namelist()) == {f"P-review-{preset}-{suffix}" for suffix in ("gerbers.zip", "positions.csv", "bom.csv")}
            assert next(csv.reader(io.StringIO(z.read(f"P-review-{preset}-bom.csv").decode()))) == [label for _, label in kr.PRESETS[preset]["bom"]]
        gerber_call = next(c[0] for c in dl_calls if c[0][3] == "gerbers")
        assert ("--subtract-soldermask" in gerber_call) == (preset == "jlcpcb")
    # Incomplete cached Gerber-only package is rebuilt, not published as-is.
    dl_mode.clear(); case = tempfile.mkdtemp(); source = dl_project(case, "P")
    cached = pathlib.Path(case, "out/fab"); cached.mkdir(parents=True)
    with zipfile.ZipFile(cached / "P-review-jlcpcb-gerbers.zip", "w") as z: z.writestr("old.gbr", "old")
    dl_calls.clear()
    assert dl_export({"name":"P","dir":""}, source, f"{case}/out", dl_settings, "b"*40)[0]["error"] is None
    assert "gerbers" in [c[0][3] for c in dl_calls]
    # Every empty cached output independently invalidates reuse. Rebuilds must not repair
    # or replace the release-check evidence: only the download zip gets the new outputs.
    for filename in ("P-review-jlcpcb-positions.csv", "P-review-jlcpcb-bom.csv", "P-review-jlcpcb-gerbers.zip"):
        kr.release_project(f"{source}/P.kicad_pro", "review", dl_settings, str(cached), "P")
        (cached / filename).write_bytes(b"")
        original = {p.name: p.read_bytes() for p in cached.iterdir()}
        dl_calls.clear()
        rebuilt = dl_export({"name":"P","dir":""}, source, f"{case}/out", dl_settings, "b"*40)
        assert rebuilt[0]["error"] is None and any(c[0][3] == "gerbers" for c in dl_calls), (filename, rebuilt)
        assert {p.name: p.read_bytes() for p in cached.iterdir()} == original, "download rebuild changed release evidence"
    # checks.release-enabled runs preserve malformed/incomplete evidence, summary hashes,
    # and specific release findings whether optional download rebuilding succeeds or fails.
    release_enabled = copy.deepcopy(dl_settings); release_enabled["checks"]["release"] = "informational"
    for damage in ("incomplete_gerbers", "malformed_positions"):
        for rebuild_mode in (None, "rc"):
            case = tempfile.mkdtemp(); source = dl_project(case, "P"); dl_mode.clear()
            cached = pathlib.Path(case, "out/fab"); cached.mkdir(parents=True)
            kr.release_project(f"{source}/P.kicad_pro", "review", release_enabled, str(cached), "P")
            if damage == "incomplete_gerbers":
                with zipfile.ZipFile(cached / "P-review-jlcpcb-gerbers.zip", "w") as z:
                    z.writestr("P-F_Cu.gbr", "data"); z.writestr("P.drl", "data")
            else:
                (cached / "P-review-jlcpcb-positions.csv").write_text("Designator,Wrong\nR1,10k\n")
            original = {p.name: p.read_bytes() for p in cached.iterdir()}
            before_summary = kr.package_summary(str(cached))
            before_findings = kr.release_findings(str(cached), "P", "jlcpcb", f"{source}/P.kicad_pcb", {})
            assert "missing_layer" in {v["type"] for v in before_findings}, before_findings
            assert "missing_package" not in {v["type"] for v in before_findings}, before_findings
            if rebuild_mode: dl_mode["gerbers"] = rebuild_mode
            with patch("sys.stdout", new_callable=io.StringIO) as warnings:
                rebuilt = dl_export({"name":"P","dir":""}, source, f"{case}/out", release_enabled, "b"*40)
            assert ("::warning::P: fabrication export failed" in warnings.getvalue()) == (rebuild_mode == "rc"), warnings.getvalue()
            assert bool(rebuilt[0]["error"]) == (rebuild_mode == "rc"), rebuilt
            assert {p.name: p.read_bytes() for p in cached.iterdir()} == original, "download rebuild changed release evidence"
            assert kr.package_summary(str(cached)) == before_summary
            assert kr.release_findings(str(cached), "P", "jlcpcb", f"{source}/P.kicad_pcb", {}) == before_findings
            assert not list(pathlib.Path(case, "out/downloads").glob(".fab-*")), "download staging leaked"
    # rc=0/no Gerbers, no drills, empty BOM, empty positions and missing Side header are nonfatal.
    for kind, mode in (("gerbers", "nofile"), ("gerbers", "empty"), ("drill", "nofile"), ("bom", "empty"), ("pos", "empty"), ("pos", "badheader")):
        case = tempfile.mkdtemp(); source = dl_project(case, "P"); dl_mode.clear(); dl_mode[kind] = mode
        with patch("sys.stdout", new_callable=io.StringIO) as warnings:
            failed = dl_export({"name":"P","dir":""}, source, f"{case}/out", dl_settings, "b"*40)
        assert "::warning::P: fabrication export failed" in warnings.getvalue(), warnings.getvalue()
        assert failed[0]["file"] is None and failed[0]["error"] == "fabrication export failed", (kind, failed)
        assert all(e["file"] for e in failed if e["kind"] in ("pdf", "glb")), failed
        assert not pathlib.Path(case, "out/downloads/fab-P-bbbbbbb.zip").exists()
    dl_mode.clear()
    with patch("kicad_review.release_project", side_effect=ValueError("'Side' is not in list")):
        case = tempfile.mkdtemp(); source = dl_project(case, "P")
        with patch("sys.stdout", new_callable=io.StringIO) as warnings:
            failed = dl_export({"name":"P","dir":""}, source, f"{case}/out", dl_settings, "b"*40)
        assert "::warning::P: fabrication export failed" in warnings.getvalue(), warnings.getvalue()
        assert failed[0]["error"] and all(e["file"] for e in failed if e["kind"] in ("pdf", "glb"))
    # Snapshot policy isolation, 4-layer Protel Gerber checks, and zero-byte raw GLB handling.
    case = tempfile.mkdtemp(); source = dl_project(case, "P")
    (pathlib.Path(source) / "P.kicad_pcb").write_text('(kicad_pcb\n(layers\n(0 "F.Cu" signal)\n(1 "In1.Cu" signal)\n(2 "In2.Cu" signal)\n(31 "B.Cu" signal)\n(44 "Edge.Cuts" user)\n)\n)')
    snap_policy = copy.deepcopy(dl_settings); snap_policy["fabrication"]["preset"] = "pcbway"
    snap_fab = pathlib.Path(case, "out/fab-snapshot"); snap_fab.mkdir(parents=True)
    with zipfile.ZipFile(snap_fab / "P-review-pcbway-gerbers.zip", "w") as z:
        for member in ("P-F_Cu.gtl", "P-In1_Cu.g1", "P-In2_Cu.g2", "P-B_Cu.gbl", "P.drl"):
            z.writestr(member, "G04*\n")
    (snap_fab / "P-review-pcbway-positions.csv").write_text("Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\n")
    (snap_fab / "P-review-pcbway-bom.csv").write_text(",".join(label for _, label in kr.PRESETS["pcbway"]["bom"]) + "\n")
    dl_calls.clear()
    pathlib.Path(case, "out/board.raw.glb.revision").write_text("b" * 40 + "\n")
    snap_entries = dl_export({"name": "P", "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40, policy=snap_policy, purpose="snapshot")
    assert all(e["error"] is None for e in snap_entries) and [c[0][3] for c in dl_calls] == ["pdf", "step"], (snap_entries, dl_calls)
    snap_manifest = json.loads(pathlib.Path(case, "out/downloads-snapshot/downloads.json").read_text())
    assert snap_manifest["purpose"] == "snapshot" and snap_manifest["policy"] == kr.download_policy_key(snap_policy) != kr.download_policy_key(dl_settings)
    # Missing inner copper layer In2.Cu in cached Gerbers invalidates fab_parts.
    with zipfile.ZipFile(snap_fab / "P-review-pcbway-gerbers.zip", "w") as z:
        for member in ("P-F_Cu.gtl", "P-In1_Cu.g1", "P-B_Cu.gbl", "P.drl"):
            z.writestr(member, "G04*\n")
    try:
        kr.fab_parts(f"{source}/P.kicad_pro", "P", snap_policy, str(snap_fab))
        raise AssertionError("missing In2.Cu Gerber accepted")
    except ValueError as e:
        assert "In2.Cu" in str(e), e
    # Zero-byte board.raw.glb is rejected by glb_entry without invoking kicad-cli.
    zero_raw = pathlib.Path(case, "out/board.raw.glb"); zero_raw.write_bytes(b"")
    stale_glb = pathlib.Path(case, "out/downloads-snapshot/P-bbbbbbb-board.glb")
    assert stale_glb.exists()
    with patch("sys.stdout", new_callable=io.StringIO) as warnings:
        glb_bad = kr.glb_entry(str(zero_raw), str(stale_glb))
    assert glb_bad["file"] is None and glb_bad["error"] == "GLB export missing" and not stale_glb.exists(), glb_bad
    assert "::warning::3D model (GLB): board.raw.glb was not produced" in warnings.getvalue()
finally:
    kr.subprocess.run = dl_real
print("ok export_downloads commands, reuse, isolation and awkward projects")

# ---- Task 3A: pinned KiBot v1.9.1 templates ----
TEMPLATES = pathlib.Path(kr.__file__).with_name("kibot_templates") / "v1.9.1"
PINS = {"JLCPCB.kibot.yaml": "9dcc65bf1fa6e8a7e54e708088e37a9a312b06eb01dbfacdf3d19a4a433f8ca6",
        "PCBWay.kibot.yaml": "6b908fe676409b032004e4d31b421a1772788a310b5365125442bbd505e6b12c"}
for name, digest in PINS.items():
    assert hashlib.sha256((TEMPLATES / name).read_bytes()).hexdigest() == digest, name
assert (TEMPLATES / "SOURCE.md").exists()
CITED = {"JLCPCB.kibot.yaml": {1: "# Gerber and drill files for JLCPCB, without stencil", 55: "      use_gerber_x2_attributes: false",
                               58: "      subtract_mask_from_silk: true", 71: "      pth_and_npth_single_file: false", 75: "      map: gerber",
                               92: "      only_smd: @_KIBOT_POS_ONLY_SMD@", 115: "      exclude_filter: '_only_jlc_parts'",
                               146: "  _KIBOT_POS_ONLY_SMD: true", 147: "  _KIBOT_F_PASTE: ''", 148: "  _KIBOT_B_PASTE: ''"},
         "PCBWay.kibot.yaml": {1: "# Gerber and drill files for PCBWay, with stencil (solder paste)", 30: "      use_gerber_x2_attributes: false",
                               34: "      subtract_mask_from_silk: false", 56: "      pth_and_npth_single_file: false",
                               77: "  _KIBOT_F_PASTE: ''", 78: "  _KIBOT_B_PASTE: ''"}}
for name, cited in CITED.items():
    lines = (TEMPLATES / name).read_text(encoding="utf-8").splitlines()
    for number, text in cited.items():
        assert lines[number - 1] == text, (name, number, lines[number - 1])
P = kr.PRESETS
assert "--no-x2" in P["jlcpcb"]["gerbers"] and "--no-x2" in P["pcbway"]["gerbers"]
assert "--subtract-soldermask" in P["jlcpcb"]["gerbers"] and "--subtract-soldermask" not in P["pcbway"]["gerbers"]
assert "--excellon-separate-th" in P["jlcpcb"]["drill"] and "--excellon-separate-th" not in P["pcbway"]["drill"]
assert kr.KIBOT_POSITION_HEADER == ["Designator", "Val", "Package", "Mid X", "Mid Y", "Rotation", "Layer"]
assert kr.KIBOT_POSITION_HEADER == list(kr.POS_COLUMNS.values()), kr.KIBOT_POSITION_HEADER
GERBERS = ["p-f_cu.gtl", "p-b_cu.gbl", "p-f_silks.gto", "p-b_silks.gbo", "p-f_mask.gts", "p-b_mask.gbs", "p-edge_cuts.gko"]
BOM_HEAD = ["Comment", "Designator", "Footprint", "LCSC Part #"]
assert kr.kibot_differences("jlcpcb", GERBERS, [BOM_HEAD, ["10k", "R1", "R_0603", "C123"]]) == []
assert kr.kibot_differences("jlcpcb", GERBERS + ["p-f_paste.gtp"], [BOM_HEAD, ["10k", "R1", "R_0603", ""]]) == [
    "stencil layers exported; JLCPCB template excludes them (lines 147-148)",
    "BOM rows without LCSC number; JLCPCB template filters them (line 115)"]
assert kr.kibot_differences("jlcpcb", GERBERS, None) == []
assert kr.kibot_differences("pcbway", GERBERS + ["p-f_paste.gtp"], None) == []   # PCBWay stencil is not checked
missing = kr.kibot_differences("pcbway", ["p-f_cu.gtl"], None)
assert len(missing) == 6 and all(d.startswith("missing ") for d in missing), missing
import contextlib
from unittest.mock import patch as _patch
dl_mode.clear(); case = tempfile.mkdtemp(); source = dl_project(case, "P")
kr.subprocess.run = dl_fake
try:
    notes = io.StringIO()
    with _patch("kicad_review.kibot_differences", return_value=["probe difference"]), contextlib.redirect_stdout(notes):
        made = export_downloads({"name": "P", "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40)
    assert not made[0]["error"], made
    assert "::notice::P: jlcpcb fabrication differs from KiBot v1.9.1 template: probe difference" in notes.getvalue(), notes.getvalue()
    # Unpatched fab_notices: schematic-only parts emit nothing; complete Protel Gerbers + LCSC BOM emit nothing.
    notes = io.StringIO()
    with contextlib.redirect_stdout(notes):
        kr.fab_notices("P", dl_settings, [f"{case}/P-review-jlcpcb-bom.csv"])
    assert notes.getvalue() == "", notes.getvalue()
    complete_fab = pathlib.Path(case, "complete")
    complete_fab.mkdir()
    with zipfile.ZipFile(complete_fab / "P-review-jlcpcb-gerbers.zip", "w") as z:
        for member in GERBERS + ["P.drl"]:
            z.writestr(member.upper(), "G04*\n")
    (complete_fab / "P-review-jlcpcb-positions.csv").write_text(
        "Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\nR1,10k,R_0603,10,20,90,Top\n", encoding="utf-8")
    (complete_fab / "P-review-jlcpcb-bom.csv").write_text(BOM, encoding="utf-8")
    notes = io.StringIO()
    with contextlib.redirect_stdout(notes):
        kr.fab_notices("P", dl_settings, [str(complete_fab / f"P-review-jlcpcb-{s}") for s in ("gerbers.zip", "positions.csv", "bom.csv")])
    assert notes.getvalue() == "", notes.getvalue()
    assert kr.kibot_differences("jlcpcb", [m.upper() for m in GERBERS] + ["P-B_Paste.GBP"], [BOM_HEAD, ["10k", "R1", "R_0603", "C123"]]) == [
        "stencil layers exported; JLCPCB template excludes them (lines 147-148)"]
    assert kr.kibot_differences("jlcpcb", GERBERS, [BOM_HEAD]) == []  # no placed parts
    assert kr.kibot_differences("jlcpcb", GERBERS, [BOM_HEAD, ["10k", "R1", "R_0603", "  "]]) == [
        "BOM rows without LCSC number; JLCPCB template filters them (line 115)"]
    # Real differences remain notices, never fabrication errors or edits to release evidence.
    with zipfile.ZipFile(complete_fab / "P-review-jlcpcb-gerbers.zip", "w") as z:
        for member in [m for m in GERBERS if not m.endswith(".gko")] + ["P.drl", "P-F_Paste.gtp"]:
            z.writestr(member, "G04*\n")
    (complete_fab / "P-review-jlcpcb-bom.csv").write_text(
        chr(0xfeff) + BOM.replace("C123", ""), encoding="utf-8")
    original = {p.name: p.read_bytes() for p in complete_fab.iterdir()}
    dl_calls.clear()
    notes = io.StringIO()
    dest = pathlib.Path(case, "fab-notices.zip")
    with contextlib.redirect_stdout(notes):
        made = kr.fab_entry(f"{source}/P.kicad_pro", "P", dl_settings, str(complete_fab), str(dest))
    assert made["file"] == dest.name and made["error"] is None, made
    prefix = "::notice::P: jlcpcb fabrication differs from KiBot v1.9.1 template: "
    assert notes.getvalue().splitlines() == ["::notice::P: JLCPCB CPL rotation rules matched 0 rows (JLCKicadTools table, pinned)"] + [prefix + d for d in (
        "missing Edge.Cuts (.gko)",
        "stencil layers exported; JLCPCB template excludes them (lines 147-148)",
        "BOM rows without LCSC number; JLCPCB template filters them (line 115)")], notes.getvalue()
    assert not dl_calls, "template differences must not trigger a fabrication rebuild"
    assert {p.name: p.read_bytes() for p in complete_fab.iterdir()} == original
    with zipfile.ZipFile(dest) as z:
        assert set(z.namelist()) == set(original)
        for member, raw in original.items():
            if member.endswith("-positions.csv"):
                assert z.read(member).decode() == (
                    "Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\r\n"
                    "R1,10k,R_0603,10.000000,20.000000,90.000000,Top\r\n")
            else:
                assert z.read(member) == raw
    pcbway = copy.deepcopy(dl_settings); pcbway["fabrication"]["preset"] = "pcbway"
    notes = io.StringIO()
    with contextlib.redirect_stdout(notes):
        kr.fab_notices("P", pcbway, [str(p) for p in complete_fab.iterdir()])
    assert notes.getvalue().splitlines() == [
        "::notice::P: pcbway fabrication differs from KiBot v1.9.1 template: missing Edge.Cuts (.gko)"], notes.getvalue()
finally:
    kr.subprocess.run = dl_real
print("ok KiBot v1.9.1 pins and fabrication checks")

# ---- Task 3B: JLCPCB CPL rotation correction ----
import math
CPL = kr.load_cpl_table()
assert hashlib.sha256(kr.CPL_TABLE.read_bytes()).hexdigest() == kr.CPL_TABLE_SHA256
assert len(CPL) == 59 and CPL[0][0].pattern == "^R_Array_Convex_" and CPL[-1][0].pattern == "^^WSON-8-1EP_6x5mm_P1.27mm"
def rule(package):
    return kr.cpl_rule(CPL, package)
# Known parts, each row's expected value worked out from the pinned arithmetic.
assert kr.jlc_position("Top", 0, 1.0, 2.0, rule("SOT-23-5")) == (270, 1.0, 2.0)               # ^SOT-23 is -90
assert kr.jlc_position("Bottom", 0, 1.0, 2.0, rule("SOT-23-5")) == (90, 1.0, 2.0)            # bottom subtracts -90, then mirrors
assert kr.jlc_position("Top", 350, 0.0, 0.0, rule("SOT-23-5")) == (260, 0.0, 0.0)            # modulo 360
assert kr.jlc_position("Top", 0, 1.0, 1.0, rule("SOT-223-3_TabPin2")) == (180, 1.0, 1.0)     # ^SOT-223 is not ^SOT-23
assert kr.jlc_position("Top", 0, 0.0, 0.0, rule("SOP-8_3.9x4.9mm_P1.27mm")) == (270, 0.0, 0.0)
assert kr.jlc_position("Top", 0, 0.0, 0.0, rule("SOP-18_3.9x4.9mm_P1.27mm")) == (0, 0.0, 0.0)  # ^SOP-18_ is 0 degrees
assert kr.jlc_position("Top", 0, 0.0, 0.0, rule("SOP-4_3.9x4.9mm_P1.27mm")) == (270, 0.0, 0.0) # ^SOP-4_ and ^SOP-(?!18_) both match; last wins
assert kr.jlc_position("Top", 0, 0.0, 0.0, rule("QFN-16-1EP_4x4mm")) == (270, 0.0, 0.0)
rot, x, y = kr.jlc_position("Top", 0, 10.0, 20.0, rule("PinHeader_2x05_P1.27mm_Vertical"))  # row with offsets 2.54, 0.635
assert rot == 90 and math.isclose(x, 12.54) and math.isclose(y, 20.635), (rot, x, y)
assert kr.jlc_position("Bottom", 0, -3.0, 4.0, rule("R_0805_2012Metric")) == (180, 3.0, 4.0)  # unmatched bottom: flip X, mirror
assert kr.jlc_position("Top", 45, 1.0, 1.0, rule("R_0805_2012Metric")) == (45, 1.0, 1.0)      # unmatched top: unchanged
# Overrides: a valid file parses; each bad file is refused.
ov = pathlib.Path(tempfile.mkdtemp(), "P.cpl-overrides.csv")
ov.write_text("Designator,Rotation,Offset X,Offset Y\nU1,90,0.5,0\n", encoding="utf-8")
assert kr.load_cpl_overrides(str(ov)) == {"U1": (90, 0.5, 0.0)}
assert kr.load_cpl_overrides(str(ov.with_name("missing.cpl-overrides.csv"))) == {}
for text in ("Ref,Rotation,Offset X,Offset Y\nU1,90,0,0\n",
             "Designator,Rotation,Offset X,Offset Y\nU1,90.5,0,0\n",
             "Designator,Rotation,Offset X,Offset Y\nU1,90,nan,0\n",
             "Designator,Rotation,Offset X,Offset Y\nU1,90,0,0\nU1,0,0,0\n",
             "Designator,Rotation,Offset X,Offset Y\nU1,90,0\n",
             "Designator,Rotation,Offset X,Offset Y\nU1,90,,0\n"):
    ov.write_text(text, encoding="utf-8")
    try:
        kr.load_cpl_overrides(str(ov))
    except ValueError:
        continue
    raise AssertionError("accepted bad overrides: " + repr(text))
# Download zip: corrected positions, overrides, PCBWay exemption, and untouched release evidence.
kr.subprocess.run = dl_fake
try:
    dl_mode.clear(); case = tempfile.mkdtemp(); source = dl_project(case, "P")
    cached = pathlib.Path(case, "out/fab"); cached.mkdir(parents=True)
    kr.release_project(f"{source}/P.kicad_pro", "review", dl_settings, str(cached), "P")
    RAW = ("Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\n"
           "Q1,BSS138,SOT-23-5,10.000000,20.000000,0.000000,Top\n"
           "Q2,BSS138,SOT-23-5,5.000000,6.000000,0.000000,Bottom\n"
           "R1,10k,R_0603,10.000000,20.000000,90.000000,Top\n")
    (cached / "P-review-jlcpcb-positions.csv").write_text(RAW, encoding="utf-8")
    original = {p.name: p.read_bytes() for p in cached.iterdir()}
    os.makedirs(f"{case}/out/downloads", exist_ok=True)
    HEADER = ["Designator", "Val", "Package", "Mid X", "Mid Y", "Rotation", "Layer"]
    def zipped_cpl(entry):
        with zipfile.ZipFile(f"{case}/out/downloads/{entry['file']}") as z:
            return list(csv.reader(io.StringIO(z.read("P-review-jlcpcb-positions.csv").decode("utf-8"))))
    def cpl_fab(settings, cache, filename, matched=None, failed=False):
        notes = io.StringIO()
        with contextlib.redirect_stdout(notes):
            entry = kr.fab_entry(f"{source}/P.kicad_pro", "P", settings, str(cache), f"{case}/out/downloads/{filename}")
        lines = notes.getvalue().splitlines()
        if matched is not None:
            assert f"::notice::P: JLCPCB CPL rotation rules matched {matched} rows (JLCKicadTools table, pinned)" in lines, lines
        assert any(line.startswith("::warning::P: fabrication export failed") for line in lines) == failed, lines
        assert all(line.startswith(("::notice::", "::warning::")) for line in lines), lines
        return entry
    first = cpl_fab(dl_settings, cached, "fab-P-bbbbbbb.zip", matched=2)
    assert first["error"] is None, first
    assert zipped_cpl(first) == [HEADER,
        ["Q1", "BSS138", "SOT-23-5", "10.000000", "20.000000", "270.000000", "Top"],
        ["Q2", "BSS138", "SOT-23-5", "5.000000", "6.000000", "90.000000", "Bottom"],
        ["R1", "10k", "R_0603", "10.000000", "20.000000", "90.000000", "Top"]], zipped_cpl(first)
    assert {p.name: p.read_bytes() for p in cached.iterdir()} == original, "CPL correction changed release evidence"
    # A per-project override replaces the table rule for its Designator (Q1 loses its -90), and adds to R1.
    pathlib.Path(source, "P.cpl-overrides.csv").write_text("Designator,Rotation,Offset X,Offset Y\nR1,180,0,0\nQ1,0,0,0\n", encoding="utf-8")
    second = cpl_fab(dl_settings, cached, "fab-P-ccccccc.zip", matched=3)
    assert zipped_cpl(second) == [HEADER,
        ["Q1", "BSS138", "SOT-23-5", "10.000000", "20.000000", "0.000000", "Top"],
        ["Q2", "BSS138", "SOT-23-5", "5.000000", "6.000000", "90.000000", "Bottom"],
        ["R1", "10k", "R_0603", "10.000000", "20.000000", "270.000000", "Top"]], zipped_cpl(second)
    # PCBWay: positions are copied unchanged; overrides there are refused for that fabrication entry only.
    pcb_settings = copy.deepcopy(dl_settings); pcb_settings["fabrication"]["preset"] = "pcbway"
    pcb_cache = pathlib.Path(case, "out/fab-pcbway"); pcb_cache.mkdir(parents=True)
    kr.release_project(f"{source}/P.kicad_pro", "review", pcb_settings, str(pcb_cache), "P")
    pcb_pos = (pcb_cache / "P-review-pcbway-positions.csv").read_bytes()
    os.remove(f"{source}/P.cpl-overrides.csv")
    third = cpl_fab(pcb_settings, pcb_cache, "fab-P-ddddddd.zip")
    assert third["error"] is None, third
    with zipfile.ZipFile(f"{case}/out/downloads/{third['file']}") as z:
        assert z.read("P-review-pcbway-positions.csv") == pcb_pos, "PCBWay positions must not be corrected"
    pathlib.Path(source, "P.cpl-overrides.csv").write_text("Designator,Rotation,Offset X,Offset Y\nR1,180,0,0\n", encoding="utf-8")
    refused = cpl_fab(pcb_settings, pcb_cache, "fab-P-eeeeeee.zip", failed=True)
    assert refused["error"] == "fabrication export failed" and not os.path.exists(f"{case}/out/downloads/fab-P-eeeeeee.zip"), refused
    # A malformed overrides file fails only the fabrication entry: PDF and GLB still arrive.
    pathlib.Path(source, "P.cpl-overrides.csv").write_text("Designator,Rotation,Offset X,Offset Y\nR1,90.5,0,0\n", encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()) as warnings:
        made = dl_export({"name": "P", "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40)
    assert "::warning::P: fabrication export failed" in warnings.getvalue(), warnings.getvalue()
    assert made[0]["error"] == "fabrication export failed" and all(e["file"] for e in made if e["kind"] in ("pdf", "glb")), made
    assert {p.name: p.read_bytes() for p in cached.iterdir()} == original, "CPL overrides changed release evidence"
    assert not list(pathlib.Path(case, "out/downloads").glob(".fab-*")), "CPL staging leaked"
finally:
    kr.subprocess.run = dl_real
print("ok CPL rotation rules, overrides and download zip")

# Synthetic CSV regression: coordinates, offsets, overrides, bottom mirroring and row count.
with tempfile.TemporaryDirectory() as cpl_dir:
    raw = pathlib.Path(cpl_dir, "raw.csv")
    corrected = pathlib.Path(cpl_dir, "corrected.csv")
    raw.write_text("Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\n"
                   "J1,Header,PinHeader_2x05_P1.27mm_Vertical,10,20,90,Top\n"
                   "J2,Header,PinHeader_2x05_P1.27mm_Vertical,-10,20,90,Bottom\n"
                   "R1,10k,R_0805_2012Metric,-3,4,0,Bottom\n"
                   "R2,10k,R_0805_2012Metric,1,2,45,Top\n"
                   "Q1,BSS138,SOT-23-5,-5,6,30,Bottom\n", encoding="utf-8")
    original = raw.read_bytes()
    assert kr.correct_positions(raw, corrected, CPL, {"Q1": (90, 0.5, -1.5)}) == 3
    assert list(csv.reader(io.StringIO(corrected.read_text()))) == [
        ["Designator", "Val", "Package", "Mid X", "Mid Y", "Rotation", "Layer"],
        ["J1", "Header", "PinHeader_2x05_P1.27mm_Vertical", "12.540000", "20.635000", "180.000000", "Top"],
        ["J2", "Header", "PinHeader_2x05_P1.27mm_Vertical", "12.540000", "20.635000", "180.000000", "Bottom"],
        ["R1", "10k", "R_0805_2012Metric", "3.000000", "4.000000", "180.000000", "Bottom"],
        ["R2", "10k", "R_0805_2012Metric", "1.000000", "2.000000", "45.000000", "Top"],
        ["Q1", "BSS138", "SOT-23-5", "5.500000", "4.500000", "240.000000", "Bottom"]]
    assert raw.read_bytes() == original
    # Even a valid CSV is refused when it is not the pinned table.
    wrong = pathlib.Path(cpl_dir, "table.csv")
    wrong.write_bytes(kr.CPL_TABLE.read_bytes() + b"\n")
    try:
        kr.load_cpl_table(wrong)
        raise AssertionError("accepted unpinned CPL table")
    except SystemExit as error:
        assert "not the pinned CPL rotation table" in str(error), error
    override = pathlib.Path(cpl_dir, "P.cpl-overrides.csv")
    for row in ("U1,90,inf,0", "U1,90,0,-inf", ",90,0,0", "U1,90,0,0,extra", "U1,90,0,0\n\n"):
        override.write_text("Designator,Rotation,Offset X,Offset Y\n" + row + "\n", encoding="utf-8")
        try:
            kr.load_cpl_overrides(override)
            raise AssertionError("accepted malformed CPL override: " + row)
        except ValueError:
            pass
print("ok synthetic CPL CSV regression and pin validation")

# Task 3B fix: unterminated override fields must not be silently repaired.
with tempfile.TemporaryDirectory() as cpl_dir:
    override = pathlib.Path(cpl_dir, "P.cpl-overrides.csv")
    override.write_text('Designator,Rotation,Offset X,Offset Y\nU1,90,0,"0\n', encoding="utf-8")
    try:
        kr.load_cpl_overrides(override)
    except csv.Error:
        pass
    else:
        raise AssertionError("accepted an unterminated CPL override quote")
print("ok CPL overrides reject unterminated quotes")

# Task 3B fix: whole-degree overrides are periodic even beyond float range.
with tempfile.TemporaryDirectory() as cpl_dir:
    override = pathlib.Path(cpl_dir, "P.cpl-overrides.csv")
    huge_degrees = 360 * 10**397 + 90  # 400 digits, exactly equivalent to +90 degrees.
    for degrees, top, bottom in ((huge_degrees, 120, 240), (-huge_degrees, 300, 60)):
        override.write_text(f"Designator,Rotation,Offset X,Offset Y\nU1,{degrees},0.5,-1\n", encoding="utf-8")
        huge_rule = kr.load_cpl_overrides(override)["U1"]
        assert kr.jlc_position("Top", 30.0, 1.0, 2.0, huge_rule) == (top, 1.5, 1.0)
        assert kr.jlc_position("Bottom", 30.0, -1.0, 2.0, huge_rule) == (bottom, 1.5, 1.0)
print("ok CPL oversized positive and negative rotations")

# Task 3B fix: arithmetic/CSV failures stay inside fabrication; other exports survive.
with tempfile.TemporaryDirectory() as case, patch("kicad_review.subprocess.run", side_effect=dl_fake):
    dl_mode.clear()
    source = dl_project(case, "P")
    cached = pathlib.Path(case, "out/fab"); cached.mkdir()
    kr.release_project(f"{source}/P.kicad_pro", "review", dl_settings, str(cached), "P")
    (cached / "P-review-jlcpcb-positions.csv").write_text(
        "Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\n"
        "Q1,BSS138,SOT-23-5,1,2,30,Top\n"
        "Q2,BSS138,SOT-23-5,-1,2,30,Bottom\n", encoding="utf-8")
    original = {p.name: p.read_bytes() for p in cached.iterdir()}
    override = pathlib.Path(source, "P.cpl-overrides.csv")
    huge_degrees = 360 * 10**397 + 90
    override.write_text(f"Designator,Rotation,Offset X,Offset Y\nQ1,{huge_degrees},0,0\nQ2,{-huge_degrees},0,0\n", encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()) as warnings:
        made = dl_export({"name": "P", "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40)
    assert not warnings.getvalue() and all(e["file"] and e["error"] is None for e in made), (made, warnings.getvalue())
    zip_path = pathlib.Path(case, "out/downloads", made[0]["file"])
    with zipfile.ZipFile(zip_path) as z:
        rows = list(csv.reader(io.StringIO(z.read("P-review-jlcpcb-positions.csv").decode("utf-8"))))
    assert [row[5] for row in rows[1:]] == ["120.000000", "60.000000"], rows

    # Force arithmetic overflow independently of normalization to pin the nonfatal boundary.
    with patch("kicad_review.jlc_position", side_effect=OverflowError("synthetic arithmetic overflow")), contextlib.redirect_stdout(io.StringIO()) as warnings:
        made = dl_export({"name": "P", "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40)
    assert made[0]["file"] is None and made[0]["error"] == "fabrication export failed", made
    assert all(e["file"] and e["error"] is None for e in made[1:]), made
    assert "::warning::P: fabrication export failed" in warnings.getvalue(), warnings.getvalue()
    assert not zip_path.exists() and not list(zip_path.parent.glob(".fab-*")), "failed CPL left archive or staging"

    # A malformed quote must have the same fabrication-only failure semantics.
    override.write_text('Designator,Rotation,Offset X,Offset Y\nQ1,90,0,"0\n', encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()) as warnings:
        made = dl_export({"name": "P", "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40)
    assert made[0]["file"] is None and made[0]["error"] == "fabrication export failed", made
    assert all(e["file"] and e["error"] is None for e in made[1:]), made
    assert "::warning::P: fabrication export failed" in warnings.getvalue(), warnings.getvalue()
    assert not zip_path.exists() and not list(zip_path.parent.glob(".fab-*")), "malformed CPL left archive or staging"
    assert {p.name: p.read_bytes() for p in cached.iterdir()} == original, "CPL failure changed release evidence"
print("ok CPL overflow and malformed CSV fabrication isolation")

# Synthetic board CPL regression: raw KiCad export and committed corrected output (Task 3B, Step 6;
# amended per Owner decision 2026-10-27 and AGENTS.md private-design rule: generic names only).
FIXTURES = pathlib.Path(kr.__file__).with_name("cpl_rotations") / "fixtures"
with open(FIXTURES / "cpl-rotation-pos-raw.csv", newline="", encoding="utf-8") as f:
    raw_rows = list(csv.reader(f))
out = pathlib.Path(tempfile.mkdtemp(), "corrected.csv")
matched = kr.correct_positions(str(FIXTURES / "cpl-rotation-pos-raw.csv"), str(out), CPL, {})
assert matched == sum(1 for r in raw_rows[1:] if rule(r[2]) is not None), matched
assert out.read_bytes() == (FIXTURES / "cpl-rotation-pos-corrected.csv").read_bytes(), "cpl-rotation CPL regression"
with open(out, newline="", encoding="utf-8") as f:
    got = list(csv.reader(f))
assert got[0] == raw_rows[0] == ["Designator", "Val", "Package", "Mid X", "Mid Y", "Rotation", "Layer"], got[0]
for before, after in zip(raw_rows[1:], got[1:]):
    assert (after[0], after[2], after[6]) == (before[0], before[2], before[6]), before
    if before[6] == "Top" and rule(before[2]) is None:
        assert after[5] == f"{float(before[5]):.6f}", before  # unmatched top parts keep their angle
print("ok cpl-rotation CPL regression")

# ---- Whole-branch review: workflow command injection and snapshot provenance ----
injected = "project%\r\n::error::forged,:"
escaped = "project%25%0D%0A::error::forged,:"
assert kr.workflow_command_escape(injected) == escaped
assert kr.workflow_command_escape(injected, property=True) == "project%25%0D%0A%3A%3Aerror%3A%3Aforged%2C%3A"
with patch("kicad_review.correct_positions", return_value=2), patch("kicad_review.load_cpl_table"), patch("kicad_review.load_cpl_overrides"), contextlib.redirect_stdout(io.StringIO()) as output:
    kr.cpl_for_download("P.kicad_pro", injected, dl_settings, "raw", "dest")
assert output.getvalue() == f"::notice::{escaped}: JLCPCB CPL rotation rules matched 2 rows (JLCKicadTools table, pinned)\n"
with tempfile.TemporaryDirectory() as case:
    raw, dest = pathlib.Path(case, "board.raw.glb"), pathlib.Path(case, "dest.glb")
    raw.write_bytes(b"glTF")
    with patch("kicad_review.shutil.copyfile", side_effect=OSError(injected)), contextlib.redirect_stdout(io.StringIO()) as output:
        kr.glb_entry(str(raw), str(dest))
    assert output.getvalue() == f"::warning::3D model (GLB): {escaped}\n"
    source = dl_project(case, "P")
    marker = pathlib.Path(case, "out/board.raw.glb.revision")
    for revision in (None, "a" * 40, "b" * 7):
        if revision is not None: marker.write_text(revision)
        try:
            export_downloads({"name": "P", "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40, policy=dl_settings, purpose="snapshot")
            raise AssertionError("unverified snapshot GLB accepted")
        except ValueError as error:
            assert "snapshot GLB revision" in str(error), error
    assert not pathlib.Path(case, "out/downloads-snapshot").exists()
with tempfile.TemporaryDirectory() as case:
    source = dl_project(case, injected)
    with patch("kicad_review.fab_parts", side_effect=ValueError), patch("kicad_review.release_project", side_effect=ValueError), contextlib.redirect_stdout(io.StringIO()) as output:
        kr.fab_entry(f"{source}/{injected}.kicad_pro", injected, dl_settings, case, f"{case}/fab.zip")
    assert output.getvalue().startswith(f"::warning::{escaped}: fabrication export failed")
    assert len(output.getvalue().splitlines()) == 1
    archive = pathlib.Path(case, "P-gerbers.zip")
    with zipfile.ZipFile(archive, "w") as z: z.writestr("P.gtl", "data")
    with patch("kicad_review.kibot_differences", return_value=[injected]), contextlib.redirect_stdout(io.StringIO()) as output:
        kr.fab_notices(injected, dl_settings, [str(archive)])
    assert output.getvalue() == f"::notice::{escaped}: jlcpcb fabrication differs from KiBot v1.9.1 template: {escaped}\n"
    failure = {"kind": "pdf", "label": injected, "file": None, "error": injected}
    with patch("kicad_review.fab_entry", return_value={**failure, "kind": "fab"}), patch("kicad_review.export_one", return_value=failure), patch("kicad_review.glb_entry", return_value={**failure, "kind": "glb"}), contextlib.redirect_stdout(io.StringIO()) as output:
        export_downloads({"name": injected, "dir": ""}, source, f"{case}/out", dl_settings, "b" * 40)
    assert output.getvalue().splitlines() == [f"::warning::{escaped}: {escaped}: {escaped}"] * 3

# Keep older workflow-command print sites covered by the same escaping contract.
import ast
commands = []
for node in ast.walk(ast.parse(pathlib.Path(kr.__file__).read_text())):
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.func.id != "print" or not node.args:
        continue
    arg = node.args[0]
    if any(isinstance(part, ast.Constant) and isinstance(part.value, str) and part.value.startswith("::") for part in ast.walk(arg)):
        commands.append(node)
        assert isinstance(arg, ast.BinOp) and isinstance(arg.right, ast.Call) and isinstance(arg.right.func, ast.Name) and arg.right.func.id == "workflow_command_escape", node.lineno
assert len(commands) >= 16
print("ok workflow command injection and snapshot GLB revision gate")

with tempfile.TemporaryDirectory() as case:
    table = pathlib.Path(case, "table.csv")
    for header in ('"Footprint pattern","Wrong","Offset X","Offset Y"',
                   '"Footprint pattern","Rotation","Wrong","Offset Y"',
                   '"Footprint pattern","Rotation","Offset X","Wrong"',
                   '"Footprint pattern","Rotation","Offset X"',
                   '"Footprint pattern","Rotation","Offset X","Offset Y","Extra"', ''):
        data = (header + "\n").encode()
        table.write_bytes(data)
        with patch("kicad_review.CPL_TABLE_SHA256", hashlib.sha256(data).hexdigest()):
            try:
                kr.load_cpl_table(table)
                raise AssertionError("invalid CPL header accepted")
            except SystemExit as error:
                assert "unexpected CPL rotation table header" in str(error), error
print("ok complete CPL table header validation")

cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    try:
        os.makedirs("review"); os.makedirs("base/p"); os.makedirs("head/p")
        json.dump({"base": "a" * 40, "head": "b" * 40, "reason": "t", "projects": [{"dir": "p", "name": "b", "status": "modified"}]}, open("review/detect.json", "w"))
        seen = []
        with patch("kicad_review.render_side"), patch("kicad_review.export_downloads", side_effect=lambda *a: seen.append(a)):
            kr.cmd_render(None)
            assert seen == [], "off by default"
            pathlib.Path("base/kicad-review.toml").write_text("[downloads]\nenabled = true\n")
            kr.cmd_render(None)
        assert [(a[0]["name"], a[1], a[2], a[4]) for a in seen] == [("b", "head/p", "review/p/head", "b" * 40)], seen  # head only
    finally:
        os.chdir(cwd)
# Same revision first cached as base must never satisfy a download-producing head.
p = {"dir":"p", "name":"P", "status":"modified"}
det = {"base":"a"*40, "head":"a"*40, "reason":"t", "projects":[p]}
enabled = copy.deepcopy(DEFAULT_SETTINGS); enabled["downloads"]["enabled"] = True
assert kr.render_cache(p, "base", det, enabled) != kr.render_cache(p, "head", det, enabled), "base/head cache collision"
assert kr.render_cache(p, "head", det, DEFAULT_SETTINGS) != kr.render_cache(p, "head", det, enabled), "opt-in cache collision"
for initial in (DEFAULT_SETTINGS, enabled):
    with tempfile.TemporaryDirectory() as d:
        os.chdir(d)
        try:
            pathlib.Path("review").mkdir(); pathlib.Path("base/p").mkdir(parents=True); pathlib.Path("head/p").mkdir(parents=True)
            pathlib.Path("review/detect.json").write_text(json.dumps(det))
            # Cache only the base role, including a complete marker, as an earlier comparison would.
            cache = kr.render_cache(p, "base", det, initial); cache.mkdir(parents=True)
            (cache / ".complete").write_text("complete")
            with patch("kicad_review.load_settings", return_value=enabled):
                try:
                    kr.restore_renders(); raise AssertionError("head restored a downloads-less base cache")
                except SystemExit as e: assert e.code == 1
                with patch("kicad_review.render_side"), patch("kicad_review.export_downloads") as export:
                    kr.cmd_render(None)
                    assert any(c.args[2] == "review/p/head" for c in export.call_args_list), "head skipped after base/disabled cache"
        finally: os.chdir(cwd)
# Release-only runs stage/upload their already-built fabrication package; no PDF/STEP/GLB.
release_only = copy.deepcopy(DEFAULT_SETTINGS); release_only["checks"]["release"] = "informational"
assert kr.render_cache(p, "head", det, release_only) != kr.render_cache(p, "base", det, release_only), "release-only base/head cache collision"
assert kr.render_cache(p, "head", det, release_only) != kr.render_cache(p, "head", det, DEFAULT_SETTINGS), "release-only off/on cache collision"
with tempfile.TemporaryDirectory() as d:
    source = dl_project(d, "P"); dl_calls.clear(); dl_mode.clear()
    with patch("kicad_review.subprocess.run", side_effect=dl_fake):
        entries = kr.export_downloads({"name":"P","dir":""}, source, f"{d}/out", release_only, "b"*40)
    assert [e["kind"] for e in entries] == ["fab"] and not entries[0]["error"], entries
    assert [c[0][3] for c in dl_calls] == ["gerbers", "drill", "pos", "bom"], dl_calls
# release_project exception boundary: warning logged and export_downloads continues
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    try:
        os.makedirs("review"); os.makedirs("base/p"); os.makedirs("head/p")
        pathlib.Path("head/p/b.kicad_pro").write_text("")
        json.dump({"base": "a" * 40, "head": "b" * 40, "reason": "t", "projects": [{"dir": "p", "name": "b", "status": "modified"}]}, open("review/detect.json", "w"))
        pathlib.Path("base/kicad-review.toml").write_text("[checks]\nrelease = 'informational'\n")
        download_calls = []
        warning_printed = []
        real_print = print
        def capture_print(*args, **kw):
            msg = " ".join(str(a) for a in args)
            if "release outputs incomplete; continuing other exports" in msg:
                warning_printed.append(msg)
            real_print(*args, **kw)
        with patch("kicad_review.render_side"), \
             patch("kicad_review.release_project", side_effect=ValueError("corrupt release")), \
             patch("kicad_review.export_downloads", side_effect=lambda *a: download_calls.append(a)), \
             patch("builtins.print", side_effect=capture_print):
            kr.cmd_render(None)
        assert len(warning_printed) == 1, f"warning not printed: {warning_printed}"
        assert "::warning::b: release outputs incomplete; continuing other exports" in warning_printed[0]
        assert len(download_calls) == 1 and download_calls[0][0]["name"] == "b" and download_calls[0][2] == "review/p/head", download_calls
    finally:
        os.chdir(cwd)
# The head requests 02's raw GLB even with the 3D viewer off; the base never does so for downloads (needs 02's cmd_render gate).
# Head download GLB export gates poster and viewer copies: only raw GLB is requested when 3D is off.
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    try:
        os.makedirs("review"); os.makedirs("base/p"); os.makedirs("head/p")
        pathlib.Path("head/p/b.kicad_pcb").write_text("(kicad_pcb (version 20240108))", encoding="utf-8")
        json.dump({"base": "a" * 40, "head": "b" * 40, "reason": "t", "projects": [{"dir": "p", "name": "b", "status": "modified"}]}, open("review/detect.json", "w"))
        pathlib.Path("base/kicad-review.toml").write_text("[downloads]\nenabled = true\n[3d]\nenabled = false\n")
        glb_calls = []
        with patch("kicad_review.render_side"), patch("kicad_review.export_downloads"), \
             patch("kicad_review.export_glb", side_effect=lambda p, side, out, **kw: glb_calls.append((side, kw.get("model"), kw.get("poster"), kw.get("viewer")))):
            kr.cmd_render(None)
        assert ("head", True, False, False) in glb_calls, glb_calls
        assert not any(side == "base" and model for side, model, *rest in glb_calls), glb_calls
    finally:
        os.chdir(cwd)
# Calling export_glb with poster=False and viewer=False creates only raw GLB, neither board.glb nor poster.png
with tempfile.TemporaryDirectory() as d:
    folder = pathlib.Path(d) / "out"
    def fake_glb_subproc(argv, **kw):
        dest = pathlib.Path(argv[argv.index("-o") + 1])
        dest.write_bytes(b"glTF raw")
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
    with patch("kicad_review.subprocess.run", side_effect=fake_glb_subproc):
        kr.export_glb({"dir": "p", "name": "p"}, "head", str(folder), model=True, poster=False, viewer=False)
    assert (folder / "board.raw.glb").is_file(), "board.raw.glb missing"
    assert not (folder / "board.glb").exists(), "board.glb should not exist when viewer is off"
    assert not (folder / "poster.png").exists(), "poster.png should not exist when poster is off"
# The workflow's 3D compression steps key on the viewer's board.glb, so downloads with [3d] enabled = false skip them (07 Open question 9).
for name in ('Cache 3D compression dependencies and processed models', 'Install 3D compression dependencies', 'Compress 3D board models'):
    gate = pathlib.Path('.github/workflows/review.yml').read_text().split('name: ' + name + '\n', 1)[1].split('\n', 1)[0]
    assert gate == "        if: steps.detect.outputs.changed == 'true' && hashFiles('review/**/board.raw.glb') != '' && hashFiles('review/**/board.glb') != ''", (name, gate)
# render_cache_complete: raw GLB required on head only for downloads.enabled, not release-only (spec lines 27-28)
with tempfile.TemporaryDirectory() as d, patch.object(kr, "IMAGE_RENDERER", "verified-10.0.6"):
    c = pathlib.Path(d) / "cache"
    c.mkdir()
    prj = {"dir": "p", "name": "P"}
    pcb_path = pathlib.Path(d) / "head/p/P.kicad_pcb"
    pcb_path.parent.mkdir(parents=True)
    pcb_path.write_text("(kicad_pcb)")
    old_cwd = os.getcwd()
    os.chdir(d)
    try:
        (c / ".complete").write_text(json.dumps(kr.image_export_identity(prj, "head")))
        dl_set = copy.deepcopy(DEFAULT_SETTINGS)
        dl_set["downloads"]["enabled"] = True
        rel_set = copy.deepcopy(DEFAULT_SETTINGS)
        rel_set["checks"]["release"] = "informational"
        # downloads.enabled requires board.raw.glb on head
        assert not kr.render_cache_complete(c, prj, "head", dl_set), "head downloads requires board.raw.glb"
        (c / "board.raw.glb").write_bytes(b"")
        assert not kr.render_cache_complete(c, prj, "head", dl_set), "empty board.raw.glb rejected"
        (c / "board.raw.glb").write_bytes(b"glTF")
        assert kr.render_cache_complete(c, prj, "head", dl_set), "valid board.raw.glb accepted"
        (c / "board.raw.glb").unlink()
        (c / "board.raw.glb.failed").write_text("failed")
        assert kr.render_cache_complete(c, prj, "head", dl_set), "board.raw.glb.failed accepted"
        (c / "board.raw.glb.failed").unlink()
        # release-only does not export raw GLB, so it must not require board.raw.glb
        assert kr.render_cache_complete(c, prj, "head", rel_set), "release-only must not require board.raw.glb"
        # base side does not require board.raw.glb for downloads
        pathlib.Path("base/p/P.kicad_pcb").parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path("base/p/P.kicad_pcb").write_text("(kicad_pcb)")
        (c / ".complete").write_text(json.dumps(kr.image_export_identity(prj, "base")))
        assert kr.render_cache_complete(c, prj, "base", dl_set), "base downloads must not require board.raw.glb"
    finally:
        os.chdir(old_cwd)
print("ok render head gating, release-only staging and role/opt-in cache isolation")

from kicad_review import collect_downloads
cwd = os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    try:
        src = "review/p/head/downloads"; os.makedirs(src); os.makedirs("review/q/head/downloads")
        pathlib.Path(f"{src}/fab-b-bbbbbbb.zip").write_bytes(b"zipdata")
        kr.write_download_manifest(src, [{"kind": "fab", "label": "For fabrication", "file": "fab-b-bbbbbbb.zip", "error": None},
                   {"kind": "step", "label": "3D model (STEP)", "file": None, "error": "skipped: export took longer than 120 s"}])
        pathlib.Path("review/q/head/downloads/q-bbbbbbb-schematic.pdf").write_bytes(b"%PDF")
        kr.write_download_manifest("review/q/head/downloads", [{"kind": "pdf", "label": "Schematic PDF", "file": "q-bbbbbbb-schematic.pdf", "error": None}])
        got = collect_downloads({"dir": "p", "name": "b"}, 0, "b" * 40)
        assert got == [{"kind": "fab", "label": "For fabrication", "bytes": 7, "sha256": hashlib.sha256(b"zipdata").hexdigest(),
                        "path": "0/fab-b-bbbbbbb.zip", "artifact": "kicad-review-downloads-bbbbbbb"},
                       {"kind": "step", "label": "3D model (STEP)", "error": "skipped: export took longer than 120 s"}], got
        assert pathlib.Path("review/downloads/0/fab-b-bbbbbbb.zip").read_bytes() == b"zipdata"
        second = collect_downloads({"dir": "q", "name": "q"}, 1, "b" * 40)  # index is the project's position, not its folder
        assert second[0]["path"] == "1/q-bbbbbbb-schematic.pdf" and pathlib.Path("review/downloads/1/q-bbbbbbb-schematic.pdf").is_file()
        assert collect_downloads({"dir": "missing", "name": "m"}, 2, "b" * 40) is None

        staged = json.loads(pathlib.Path("review/downloads/0/downloads.json").read_text())
        assert staged == {"files": got, "head": "b" * 40}, staged
        # Report: compare the actual pre-feature module and assets, not two post-feature templates.
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "a" * 40, "head": "b" * 40, "reason": "t", "projects": []}))
        assert "fetch-depth: 0" in pathlib.Path(kr.__file__).with_name(".github").joinpath("workflows/test.yml").read_text(), "pinned baseline must be available in CI"
        import tarfile
        def downloads_baseline_root():
            root = pathlib.Path(os.environ.get("DOWNLOADS_BASELINE") or tempfile.mkdtemp(prefix="downloads-baseline-"))
            if not (root / "kicad_review.py").is_file():
                archive = kr.subprocess.run(["git", "-C", str(pathlib.Path(kr.__file__).resolve().parent), "archive", "335db72", "kicad_review.py", "ui"], check=True, capture_output=True).stdout
                with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                    tar.extractall(root)  # trusted, pinned git archive contains only kicad_review.py and ui/
            return root
        baseline_root = downloads_baseline_root()
        # A pre-extracted override must not invoke git or overwrite the original assets.
        with patch.dict(os.environ, {"DOWNLOADS_BASELINE": str(baseline_root)}), patch("kicad_review.subprocess.run", side_effect=AssertionError("pre-extracted baseline must not invoke git archive")):
            assert downloads_baseline_root() == baseline_root
        # Separately exercise the no-override CI fallback into a fresh, empty directory,
        # while cwd remains outside every Git checkout.
        with tempfile.TemporaryDirectory(prefix="downloads-fallback-") as fallback:
            with patch.dict(os.environ, {"DOWNLOADS_BASELINE": ""}), patch("tempfile.mkdtemp", return_value=fallback), patch("kicad_review.subprocess.run", wraps=dl_real) as archive_run:
                fallback_root = downloads_baseline_root()
            archive_run.assert_called_once_with(["git", "-C", str(pathlib.Path(kr.__file__).resolve().parent), "archive", "335db72", "kicad_review.py", "ui"], check=True, capture_output=True)
            assert fallback_root == pathlib.Path(fallback)
            for relative in ("kicad_review.py", "ui/review.html", "ui/review.js", "ui/review.css"):
                assert (fallback_root / relative).read_bytes() == (baseline_root / relative).read_bytes(), relative
        import importlib.util
        spec = importlib.util.spec_from_file_location("downloads_baseline", baseline_root / "kicad_review.py")
        baseline = importlib.util.module_from_spec(spec); spec.loader.exec_module(baseline)
        with patch.object(baseline, "load_settings", return_value=copy.deepcopy(baseline.DEFAULT_SETTINGS)):
            baseline.cmd_report(None)
        before_data = pathlib.Path("review/data.json").read_bytes()
        before_html = pathlib.Path("review/kicad-review.html").read_bytes()
        with patch("kicad_review.load_settings", return_value=copy.deepcopy(DEFAULT_SETTINGS)):
            kr.cmd_report(None)
        legacy, integrated = json.loads(before_data), json.loads(pathlib.Path("review/data.json").read_bytes())
        def legacy_subset(old, new):
            """Every value the 335db72 report holds is present unchanged; additive v1 fields from 01, 03 and 08 may appear."""
            if isinstance(old, dict):
                return isinstance(new, dict) and all(k in new and legacy_subset(v, new[k]) for k, v in old.items())
            if isinstance(old, list):
                return isinstance(new, list) and len(old) == len(new) and all(legacy_subset(a, b) for a, b in zip(old, new))
            return old == new
        assert legacy_subset(legacy, integrated), "opted-out report lost or changed a 335db72 field"
        assert "downloads" not in integrated["settings"] and all("downloads" not in p for p in integrated["projects"]), "opted-out report carries download data"
        after_html = pathlib.Path("review/kicad-review.html").read_bytes()
        assert b'id="downloads-open"' not in before_html, "335db72 must not contain the Download button"
        assert b'id="downloads-open"' in after_html, "Download button missing from new report"

        # fe2206c (origin/main last merged into this branch) grew review.js and added 3D viewer and image-view assets
        # after 335db72. Compare against a pinned-main report built without the Download UI to bound the
        # always-on Download UI overhead under 12 KB uncompressed without relying on origin/main ref.
        repo_dir = pathlib.Path(kr.__file__).resolve().parent
        main_commit = "fe2206c"
        archive_cmd = ["git", "-C", str(repo_dir), "archive", main_commit, "kicad_review.py", "ui", "vendor", "image-palettes.json", "fab_limits.json"]
        probe_cmd = ["git", "-C", str(repo_dir), "cat-file", "-e", f"{main_commit}^{{commit}}"]
        @contextlib.contextmanager
        def downloads_main_root():
            """Yield the extracted fe2206c tree, or None only when that commit is absent (shallow checkout).
            Any other failure (git missing, git archive or extraction error) raises."""
            override = os.environ.get("DOWNLOADS_MAIN_BASELINE")
            with contextlib.ExitStack() as stack:
                root = pathlib.Path(override or stack.enter_context(tempfile.TemporaryDirectory(prefix="downloads-main-")))
                root.mkdir(parents=True, exist_ok=True)
                if not (root / "kicad_review.py").is_file():
                    if subprocess.run(probe_cmd, capture_output=True).returncode != 0:
                        yield None
                        return
                    archive = subprocess.run(archive_cmd, check=True, capture_output=True).stdout
                    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                        if hasattr(tarfile, "data_filter"):
                            tar.extractall(root, filter="data")
                        else:
                            tar.extractall(root)
                yield root

        # Verify the DOWNLOADS_MAIN_BASELINE override path:
        # A pre-extracted override must not invoke git archive.
        with tempfile.TemporaryDirectory(prefix="downloads-main-pre-") as pre_dir:
            pre_root = pathlib.Path(pre_dir)
            (pre_root / "kicad_review.py").write_text("# baseline stub")
            with patch.dict(os.environ, {"DOWNLOADS_MAIN_BASELINE": str(pre_root)}), patch("subprocess.run", side_effect=AssertionError("pre-extracted main baseline must not invoke git archive")):
                with downloads_main_root() as override_root:
                    assert override_root == pre_root

        # In a shallow clone fe2206c is absent: the commit probe fails, downloads_main_root yields None
        # and never runs git archive.
        absent = subprocess.CompletedProcess(probe_cmd, 128, b"", b"fatal: Not a valid object name fe2206c^{commit}")
        with patch.dict(os.environ, {"DOWNLOADS_MAIN_BASELINE": ""}), patch("subprocess.run", return_value=absent) as probe_run:
            with downloads_main_root() as shallow_root:
                assert shallow_root is None
            probe_run.assert_called_once_with(probe_cmd, capture_output=True)

        # Any other failure is real and must raise, never be reported as a shallow checkout:
        # git not installed, and git archive failing although the commit is present.
        present = subprocess.CompletedProcess(probe_cmd, 0, b"", b"")
        for side_effect, error in ((FileNotFoundError("git"), FileNotFoundError),
                                   ([present, subprocess.CalledProcessError(128, archive_cmd, stderr=b"fatal: disk error")], subprocess.CalledProcessError)):
            with patch.dict(os.environ, {"DOWNLOADS_MAIN_BASELINE": ""}), patch("subprocess.run", side_effect=side_effect):
                try:
                    with downloads_main_root():
                        raise AssertionError(f"{error.__name__} was reported as a shallow checkout")
                except error:
                    pass

        saved_main_path = None
        with downloads_main_root() as main_root:
            if main_root is None:
                print("skip always-on Download UI overhead check: commit fe2206c not present in this checkout (shallow clone; set DOWNLOADS_MAIN_BASELINE to enable)")
            else:
                saved_main_path = main_root
                baseline_files = ("kicad_review.py", "image-palettes.json", "ui/review.html", "ui/review.js", "ui/review.css")
                for relative in baseline_files:
                    assert (main_root / relative).is_file(), f"missing extracted baseline file: {relative}"
                # An unextracted override directory is populated via git archive, byte-identical to the default extraction.
                with tempfile.TemporaryDirectory(prefix="downloads-main-unextracted-") as unextracted_dir:
                    target = os.path.join(unextracted_dir, "baseline")
                    with patch.dict(os.environ, {"DOWNLOADS_MAIN_BASELINE": target}), patch("subprocess.run", wraps=subprocess.run) as archive_run:
                        with downloads_main_root() as extracted_root:
                            assert archive_run.call_args == ((archive_cmd,), {"check": True, "capture_output": True}), archive_run.call_args_list
                            assert extracted_root == pathlib.Path(target)
                            for relative in baseline_files:
                                assert (extracted_root / relative).read_bytes() == (main_root / relative).read_bytes(), relative
                main_spec = importlib.util.spec_from_file_location("downloads_main", main_root / "kicad_review.py")
                main_mod = importlib.util.module_from_spec(main_spec)
                main_spec.loader.exec_module(main_mod)
                with patch.object(main_mod, "load_settings", return_value=copy.deepcopy(main_mod.DEFAULT_SETTINGS)):
                    main_mod.cmd_report(None)
                main_html = pathlib.Path("review/kicad-review.html").read_bytes()
                assert b'id="downloads-open"' not in main_html, "pinned-main report must not contain the Download button"
                # Rebuild after_html to restore current report state after main_mod.cmd_report
                with patch("kicad_review.load_settings", return_value=copy.deepcopy(DEFAULT_SETTINGS)):
                    kr.cmd_report(None)
                after_html = pathlib.Path("review/kicad-review.html").read_bytes()
                ui_overhead = len(after_html) - len(main_html)
                assert 0 < ui_overhead < 12000, f"always-on Download UI must add less than 12 KB uncompressed (overhead: {ui_overhead})"

        if saved_main_path is not None and not os.environ.get("DOWNLOADS_MAIN_BASELINE"):
            assert not saved_main_path.exists(), "temporary main_root directory must be cleaned up after use"

        shown = {"name": "b", "dir": "p", "status": "modified", "sheets": [], "board": {}, "changes": [], "checks": []}
        on = copy.deepcopy(DEFAULT_SETTINGS); on["downloads"]["enabled"] = True
        pathlib.Path("review/detect.json").write_text(json.dumps({"base": "a" * 40, "head": "b" * 40, "reason": "t", "projects": [{"dir": "p", "name": "b", "status": "modified"}]}))
        with patch("kicad_review.load_settings", return_value=on), patch("kicad_review.build_project", return_value=dict(shown)), patch.dict(os.environ, {"GITHUB_OUTPUT": "gh-out.txt"}):
            kr.cmd_report(None)
        data = json.loads(pathlib.Path("review/data.json").read_text())
        assert data["projects"][0]["downloads"] == got and data["settings"]["downloads"] == {"enabled": True, "step": True}
        gh_out = pathlib.Path("gh-out.txt").read_text()
        assert "downloads=true\n" in gh_out and "downloads_name=kicad-review-downloads-bbbbbbb\n" in gh_out, gh_out
        off = copy.deepcopy(DEFAULT_SETTINGS); pathlib.Path("gh-out.txt").unlink()
        with patch("kicad_review.load_settings", return_value=off), patch("kicad_review.build_project", return_value=dict(shown)), patch.dict(os.environ, {"GITHUB_OUTPUT": "gh-out.txt"}):
            kr.cmd_report(None)
        assert "downloads" not in json.loads(pathlib.Path("review/data.json").read_text())["projects"][0] and "downloads=false\n" in pathlib.Path("gh-out.txt").read_text()
        assert not os.path.exists("review/downloads"), "stale download folder removed when disabled"
        # Release-only outputs reach report and workflow upload even with downloads.enabled false.
        release_only = copy.deepcopy(DEFAULT_SETTINGS); release_only["checks"]["release"] = "informational"
        pathlib.Path("gh-out.txt").unlink()
        with patch("kicad_review.load_settings", return_value=release_only), patch("kicad_review.build_project", return_value=dict(shown)), patch.dict(os.environ, {"GITHUB_OUTPUT":"gh-out.txt"}):
            kr.cmd_report(None)
        assert "downloads=true\n" in pathlib.Path("gh-out.txt").read_text(), "checks.release package was discarded"
        assert pathlib.Path("review/downloads/0/fab-b-bbbbbbb.zip").is_file()

        # Malformed downloads.json: list-shaped manifest, non-list files, and missing kind/label must not raise or fail review.
        # 1. List-shaped manifest
        pathlib.Path(f"{src}/downloads.json").write_text("[]", encoding="utf-8")
        assert collect_downloads({"dir": "p", "name": "b"}, 0, "b" * 40) is None
        with patch("kicad_review.load_settings", return_value=on), patch("kicad_review.build_project", return_value=dict(shown)), patch.dict(os.environ, {"GITHUB_OUTPUT": "gh-out.txt"}):
            kr.cmd_report(None)
        assert "downloads" not in json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]

        # 2. Non-list files
        pathlib.Path(f"{src}/downloads.json").write_text(json.dumps({"files": 123}), encoding="utf-8")
        assert collect_downloads({"dir": "p", "name": "b"}, 0, "b" * 40) is None
        with patch("kicad_review.load_settings", return_value=on), patch("kicad_review.build_project", return_value=dict(shown)), patch.dict(os.environ, {"GITHUB_OUTPUT": "gh-out.txt"}):
            kr.cmd_report(None)
        assert "downloads" not in json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]

        # 3. Entry missing kind or label is skipped rather than emitting null kind/label
        pathlib.Path(f"{src}/downloads.json").write_text(json.dumps({"files": [{"path": "fab-b-bbbbbbb.zip"}]}), encoding="utf-8")
        assert collect_downloads({"dir": "p", "name": "b"}, 0, "b" * 40) == []
        with patch("kicad_review.load_settings", return_value=on), patch("kicad_review.build_project", return_value=dict(shown)), patch.dict(os.environ, {"GITHUB_OUTPUT": "gh-out.txt"}):
            kr.cmd_report(None)
        assert "downloads" not in json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]

        # 4. Mixed entries: invalid/missing kind/label skipped, valid entries preserved
        pathlib.Path(f"{src}/downloads.json").write_text(json.dumps({"files": [
            {"path": "fab-b-bbbbbbb.zip"},
            {"kind": "fab", "path": "fab-b-bbbbbbb.zip"},
            {"label": "For fabrication", "path": "fab-b-bbbbbbb.zip"},
            {"kind": None, "label": "For fabrication", "path": "fab-b-bbbbbbb.zip"},
            {"kind": "fab", "label": None, "path": "fab-b-bbbbbbb.zip"},
            {"kind": "   ", "label": "For fabrication", "path": "fab-b-bbbbbbb.zip"},
            {"kind": "fab", "label": "", "path": "fab-b-bbbbbbb.zip"},
            {"kind": "fab", "label": "For fabrication", "path": "fab-b-bbbbbbb.zip"},
        ]}), encoding="utf-8")
        mixed_entries = collect_downloads({"dir": "p", "name": "b"}, 0, "b" * 40)
        assert mixed_entries == [{"kind": "fab", "label": "For fabrication", "bytes": 7, "sha256": hashlib.sha256(b"zipdata").hexdigest(),
                                  "path": "0/fab-b-bbbbbbb.zip", "artifact": "kicad-review-downloads-bbbbbbb"}]
        with patch("kicad_review.load_settings", return_value=on), patch("kicad_review.build_project", return_value=dict(shown)), patch.dict(os.environ, {"GITHUB_OUTPUT": "gh-out.txt"}):
            kr.cmd_report(None)
        assert json.loads(pathlib.Path("review/data.json").read_text())["projects"][0]["downloads"] == mixed_entries
    finally:
        os.chdir(cwd)
print("ok report manifest, artifact folder, outputs and opt-out byte identity")

wf = pathlib.Path(".github/workflows/review.yml").read_text(encoding="utf-8")
upload = wf[wf.index("- name: Upload downloads"):]
upload = upload[:upload.index("\n      - name:", 10)]
for needle in ("if: steps.report.outputs.downloads == 'true'", "continue-on-error: true",
               "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
               "name: ${{ steps.report.outputs.downloads_name }}", "path: review/downloads", "compression-level: 0", "retention-days: 90"):
    assert needle in upload, needle
assert "archive: false" not in upload, "several files need an archived artifact"
assert wf.index("- name: Upload report") < wf.index("- name: Upload downloads") < wf.index("- name: Screenshots of changed drawings")
print("ok review.yml uploads the downloads artifact")

readme = pathlib.Path("README.md").read_text(encoding="utf-8"); example = pathlib.Path("examples/kicad-review.toml").read_text(encoding="utf-8")
for needle in ("| `downloads.enabled` | `false` |", "| `downloads.step` | `true` |", "## Downloads (optional)", "projects[].downloads[]", "kicad-review-downloads-", "<name>.cpl-overrides.csv", "kibot_templates/v1.9.1", "cpl_rotations"):
    assert needle in readme, needle
assert "[downloads]\nenabled = false" in example and "step = true" in example
assert "docs/superpowers" not in readme, "plan paths stay out of shipped assets"
assert "02's" not in readme, "plan numbers stay out of shipped assets"
print("ok downloads documented")

# F2: Multi-unit symbols split across sheets preserve net membership, proven pins, and project net diff.
def test_f2_cross_sheet_multi_unit():
    from kicad_review import candidate_identity_valid, electrical_changes, net_members, schematic_pin_ids
    base_net = (
        "(export"
        " (components (comp (ref U1) (libsource (lib Device) (part Dual)))"
        "  (comp (ref R1) (libsource (lib Device) (part R))))"
        " (libparts (libpart (lib Device) (part Dual) (pins (pin (num 1)) (pin (num 2)) (pin (num 3))))"
        "  (libpart (lib Device) (part R) (pins (pin (num 1)) (pin (num 2)))))"
        " (nets (net (name SIG) (node (ref U1) (pin 1)) (node (ref R1) (pin 1)))"
        "  (net (name VCC) (node (ref U1) (pin 2)))))"
    )
    head_net = base_net.replace("(node (ref R1) (pin 1))", "(node (ref R1) (pin 2))")
    root_sch = (
        '(kicad_sch (uuid root-uuid)'
        ' (symbol (lib_id "Device:Dual") (uuid ua) (unit 1) (at 10 20 0) (property "Reference" "U1"))'
        ' (symbol (lib_id "Device:R") (uuid r1) (unit 1) (at 30 20 0) (property "Reference" "R1"))'
        ' (sheet (at 50 50) (size 10 10) (uuid power-sheet)'
        '  (property "Sheetname" "power") (property "Sheetfile" "power.kicad_sch")))'
    )
    power_sch = (
        '(kicad_sch (uuid power-uuid)'
        ' (symbol (lib_id "Device:Dual") (uuid ub) (unit 2) (at 15 25 0) (property "Reference" "U1")))'
    )

    with tempfile.TemporaryDirectory() as td:
        old = os.getcwd()
        os.chdir(td)
        try:
            p = {"dir": "p", "name": "p"}
            out = pathlib.Path("review/p")
            for side, net_text, pad_net in (("base", base_net, ""), ("head", head_net, "VCC")):
                write(side, {
                    "p/p.kicad_sch": root_sch,
                    "p/power.kicad_sch": power_sch,
                    "p/p.kicad_pcb": br03_pcb("fp", [("pad", "3", 0, pad_net)]).replace('"D1"', '"U1"'),
                })
                write(str(out / side), {"netlist.net": net_text})
            write(str(out), {"copper-diff.json": json.dumps({"rows": [], "incomplete": []})})
            sch_objs = kr.sch_objects("base/p", "p")
            nets, anchors, issues = net_members(base_net, sch_objs, "a" * 40)
            assert nets == {"SIG": {"U1.1", "R1.1"}, "VCC": {"U1.2"}} and not issues, (nets, issues)
            assert [(a["unit"], a["sheet"], a["uuid"]) for a in anchors["U1.1"]] == [
                ("1", "/", "ua"),
                ("2", "/power-sheet/", "ub"),
            ], anchors["U1.1"]
            assert schematic_pin_ids(base_net, sch_objs) == {"U1.1", "U1.2", "U1.3", "R1.1", "R1.2"}

            objs = {
                side: {**kr.pcb_objects(pathlib.Path(side, "p/p.kicad_pcb")), **kr.sch_objects(f"{side}/p", "p")}
                for side in ("base", "head")
            }
            rows, issues = electrical_changes(p, str(out), objs, {"base": "b" * 40, "head": "h" * 40})
            assert not issues, issues
            net_rows = [r for r in rows if r["kind"] == "net-members"]
            assert len(net_rows) == 1 and net_rows[0]["ref"] == "SIG", net_rows
            assert net_rows[0]["detail"]["added"] == ["R1.2"] and net_rows[0]["detail"]["removed"] == ["R1.1"]
            pad_rows = [r for r in rows if r["kind"] == "board-pad-net"]
            assert len(pad_rows) == 1 and pad_rows[0]["detail"]["boardOnly"] is True, pad_rows
        finally:
            os.chdir(old)

    # Duplicate unit numbers across different sheets remain ambiguous.
    dup_cross_sheet = {"/logic/ua": obj("U1", "1", "/logic/"), "/power/ub": obj("U1", "1", "/power/")}
    dup_nets, dup_anchors, dup_issues = net_members(base_net, dup_cross_sheet, "a" * 40)
    assert dup_nets == {"SIG": None, "VCC": None} and not dup_anchors, (dup_nets, dup_anchors)
    assert all(i["unknown"] for i in dup_issues) and len(dup_issues) == 2, dup_issues
    assert schematic_pin_ids(base_net, dup_cross_sheet) == set()

    # Shared candidate_identity_valid predicate handles both symbol objects and (uid, obj) tuples.
    assert candidate_identity_valid([]) is False
    assert candidate_identity_valid([obj("U1", "1", "/")]) is True
    assert candidate_identity_valid([("ua", obj("U1", "1", "/"))]) is True
    assert candidate_identity_valid([obj("U1", "1", None)]) is False
    assert candidate_identity_valid([("ua", obj("U1", "1", None))]) is False
    assert candidate_identity_valid([obj("U1", "1", "/"), obj("U1", "2", "/power/")]) is True
    assert candidate_identity_valid([("ua", obj("U1", "1", "/")), ("ub", obj("U1", "2", "/power/"))]) is True
    assert candidate_identity_valid([obj("U1", "1", "/"), obj("U1", "1", "/power/")]) is False
    assert candidate_identity_valid([("ua", obj("U1", "1", "/")), ("ub", obj("U1", "1", "/power/"))]) is False


test_f2_cross_sheet_multi_unit()
print("ok F2 cross-sheet multi-unit net comparison")


# F3: Malformed S-expressions raise ValueError, and validate_netlist delegates balance/root checking to parse_sexpr.
def test_f3_malformed_sexpr():
    import inspect
    from kicad_review import parse_sexpr, validate_netlist, export_netlist, electrical_changes

    bad_sexprs = [
        "",
        "   \n\t  ",
        "atom",
        '"quoted"',
        ")",
        "(()",
        "(kicad_pcb",
        "(kicad_pcb))",
        "(kicad_pcb) (extra)",
        "(kicad_pcb) trailing",
        "leading (kicad_pcb)",
        '(kicad_pcb "unterminated)',
        '(kicad_pcb "unterminated\\")',
        '(kicad_pcb (setup (stackup "unclosed)',
    ]
    for text in bad_sexprs:
        try:
            parse_sexpr(text)
            raise AssertionError(f"F3 malformed S-expression accepted: {text!r}")
        except ValueError:
            pass

    assert parse_sexpr(' \n (kicad_pcb (layers (0 "F.Cu" signal)) (paper "A4 \\"x\\"\\n")) \t ') == [
        "kicad_pcb",
        ["layers", ["0", "F.Cu", "signal"]],
        ["paper", 'A4 "x"\n'],
    ]

    # validate_netlist uses parse_sexpr for S-expression balance/root checking without a duplicated character scanner.
    src = inspect.getsource(validate_netlist)
    assert "for index, char in enumerate" not in src, "duplicated balance scanner still in validate_netlist"

    for text in bad_sexprs:
        try:
            validate_netlist(text)
            raise AssertionError(f"F3 malformed netlist accepted: {text!r}")
        except ValueError:
            pass

    # Callers that handle parse failures record incomplete evidence instead of crashing on malformed S-expressions.
    with tempfile.TemporaryDirectory() as td:
        old = os.getcwd()
        os.chdir(td)
        try:
            def truncated_netlist(cmd, **kw):
                pathlib.Path(cmd[cmd.index("-o") + 1]).write_text("(export (nets", encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

            with patch("kicad_review.subprocess.run", side_effect=truncated_netlist), \
                 _contextlib.redirect_stderr(io.StringIO()):
                export_netlist("p.kicad_sch", "review/p/base")
            assert pathlib.Path("review/p/base/netlist.net.error").is_file()
            assert not pathlib.Path("review/p/base/netlist.net").exists()

            p = {"dir": "p", "name": "p"}
            write("base", {"p/p.kicad_sch": "(kicad_sch", "p/p.kicad_pcb": "(kicad_pcb"})
            write("head", {"p/p.kicad_sch": "(kicad_sch)", "p/p.kicad_pcb": '(kicad_pcb (setup (stackup (layer "F.Cu"))))'})
            write("review/p/base", {"netlist.net": "(export (nets"})
            write("review/p/head", {"netlist.net": "(export (nets))"})
            write("review/p", {"copper-diff.json": json.dumps({"rows": [], "incomplete": []})})
            rows, issues = electrical_changes(p, "review/p", {"base": {}, "head": {}}, {"base": "b" * 40, "head": "h" * 40})
            assert not [r for r in rows if r["kind"] in ("rule", "stackup", "board-pad-net")], rows
            assert any(i["channel"] == "wiring" and i["document"] == "schematic" and "base netlist unavailable" in i["reason"] for i in issues), issues
            assert any(i["channel"] == "wiring" and i["document"] == "board" and i["reason"] == "Board pad evidence missing or malformed: malformed S-expression" for i in issues), issues
            assert any(i["channel"] == "rules" and i["document"] == "board" and i["reason"] == "Rules evidence missing or malformed: malformed S-expression" for i in issues), issues

            # Logic bugs in diff_board_pins and diff_rules are not swallowed as malformed evidence
            write("base", {"p/p.kicad_pcb": '(kicad_pcb (layers (0 "F.Cu" signal)))'})
            try:
                with patch("kicad_review.diff_board_pins", side_effect=TypeError("diff_board_pins logic bug")):
                    electrical_changes(p, "review/p", {"base": {}, "head": {}}, {"base": "b" * 40, "head": "h" * 40})
                raise AssertionError("diff_board_pins logic bug was swallowed")
            except TypeError as exc:
                assert str(exc) == "diff_board_pins logic bug"

            try:
                with patch("kicad_review.diff_rules", side_effect=TypeError("diff_rules logic bug")):
                    electrical_changes(p, "review/p", {"base": {}, "head": {}}, {"base": "b" * 40, "head": "h" * 40})
                raise AssertionError("diff_rules logic bug was swallowed")
            except TypeError as exc:
                assert str(exc) == "diff_rules logic bug"

            settings = kr.load_settings()
            settings["checks"]["interfaces"] = "required"
            ic = kr.interface_check(p, settings, {"base": {}, "head": {}}, "review/p")
            assert ic["status"] == "not_run" and ic["incomplete"] is True and "base netlist unavailable" in ic["reason"], ic

            cache = pathlib.Path(td, "cache")
            cache.mkdir(parents=True, exist_ok=True)
            (cache / ".complete").write_text("{}", encoding="utf-8")
            with patch.object(kr, "IMAGE_RENDERER", "kicad-cli-10.0.6"):
                assert kr.image_cache_complete(cache, p, "base") is False

            # Direct board_layers call on malformed PCB surfaces ValueError (finding 3) instead of IndexError
            bad_pcb = pathlib.Path(td, "bad.kicad_pcb")
            bad_pcb.write_text("(kicad_pcb\n  (layers\n", encoding="utf-8")
            try:
                kr.board_layers(str(bad_pcb))
                raise AssertionError("malformed PCB accepted by board_layers")
            except ValueError as exc:
                assert "malformed S-expression" in str(exc)

            # Malformed PCB records incomplete evidence and warning; refused as cacheable
            p_bad = {"dir": "p_bad", "name": "bad"}
            write("base", {"p_bad/bad.kicad_pcb": "(kicad_pcb\n  (layers\n"})
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                bad_ident = kr.image_export_identity(p_bad, "base")
            assert bad_ident.get("incomplete") is not None
            assert "Board layers unavailable: malformed S-expression" in bad_ident["incomplete"]
            assert bad_ident["layers"] is None
            assert "bad: malformed board file in base; layer evidence unavailable" in err.getvalue()

            # Warning deduplication on subsequent calls
            err2 = io.StringIO()
            with contextlib.redirect_stderr(err2):
                kr.image_export_identity(p_bad, "base")
            assert err2.getvalue() == ""

            det_bad = {"base": "a" * 40, "head": "b" * 40, "projects": [p_bad]}
            assert kr.render_cache(p_bad, "base", det_bad, settings) is None
            assert kr.image_cache_complete(cache, p_bad, "base") is False
            assert kr.render_cache_complete(cache, p_bad, "base", settings) is False

            # render_side on a malformed PCB warns with the file name and skips only the board drawing.
            write("head", {"p_bad/bad.kicad_pcb": "(kicad_pcb (layers (0 \"F.Cu\" signal))"})
            err = io.StringIO()
            with patch.object(kr, "kicad_cli") as cli, patch.object(kr, "export_board_stats", return_value=None), \
                 contextlib.redirect_stderr(err):
                kr.render_side("head/p_bad", "bad", str(pathlib.Path(td, "render_bad")))
            calls = [c.args for c in cli.call_args_list]
            assert not any(c[0] == "pcb" for c in calls), calls
            assert "::warning::head/p_bad/bad.kicad_pcb: malformed board file; board drawing not rendered" in err.getvalue(), err.getvalue()
            assert all(line.startswith("::warning::") for line in err.getvalue().splitlines()), err.getvalue()
            assert "malformed board file" in pathlib.Path(td, "render_bad", "drc.json.error").read_text(encoding="utf-8")
            assert not pathlib.Path(td, "render_bad", "drc.json").exists()

            # A failing kicad-cli (real kicad_cli exit path) must not end rendering for a malformed board.
            pcb_runs = []
            def failing_run(cmd, *a, **kw):
                if cmd[:2] == ["kicad-cli", "pcb"]:
                    pcb_runs.append(cmd)
                return subprocess.CompletedProcess(cmd, 1, "", "parse error")
            err = io.StringIO()
            with patch.object(kr.subprocess, "run", side_effect=failing_run), contextlib.redirect_stderr(err):
                try:
                    kr.render_side("head/p_bad", "bad", str(pathlib.Path(td, "render_bad_cli")))
                except SystemExit as exc:
                    raise AssertionError(f"malformed board ended rendering: {exc}")
            assert pcb_runs == [], pcb_runs
            assert pathlib.Path(td, "render_bad_cli", "drc.json.error").is_file()

            # cache_renders does not persist incomplete identity for malformed PCB
            write("review", {"detect.json": json.dumps(det_bad)})
            out_bad = pathlib.Path("review/p_bad/base")
            out_bad.mkdir(parents=True, exist_ok=True)
            # Force a real cache path so the incomplete-identity guard inside cache_renders is what decides.
            bad_cache = pathlib.Path(".render-cache", "a" * 40, kr.project_id(p_bad["dir"]), "forced")
            with patch.object(kr, "load_settings", return_value=settings), \
                 patch.object(kr, "render_cache", return_value=bad_cache):
                kr.cache_renders()
            assert not bad_cache.exists() and not list(pathlib.Path(".render-cache").rglob(".complete")), \
                list(pathlib.Path(".render-cache").rglob("*"))
        finally:
            os.chdir(old)


test_f3_malformed_sexpr()
print("ok F3 malformed S-expressions raise ValueError")


# F4: Cache correctness for render and release products (findings 4, 7, 10).
def test_f4_render_and_release_cache():
    import copy, json, os, pathlib, tempfile, zipfile
    from unittest.mock import patch
    import kicad_review as kr

    old = os.getcwd()
    with tempfile.TemporaryDirectory() as td, patch.object(kr, "IMAGE_RENDERER", "verified-10.0.6"):
        os.chdir(td)
        try:
            prj = {"dir": "p", "name": "P", "status": "modified"}
            det = {"base": "a" * 40, "head": "b" * 40, "projects": [prj]}
            for side in ("base", "head"):
                src = pathlib.Path(side, "p")
                src.mkdir(parents=True)
                (src / "P.kicad_pro").write_text("{}", encoding="utf-8")
                (src / "P.kicad_sch").write_text("(kicad_sch)", encoding="utf-8")
                (src / "P.kicad_pcb").write_text('(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user)))', encoding="utf-8")

            def seed_cache(side="head"):
                c = pathlib.Path(td, f"cache-{side}")
                if c.exists():
                    shutil.rmtree(c)
                c.mkdir(parents=True)
                (c / ".complete").write_text(json.dumps(kr.image_export_identity(prj, side), sort_keys=True), encoding="utf-8")
                return c

            def seed_fab_package(fab_dir, preset="jlcpcb"):
                fab_dir = pathlib.Path(fab_dir)
                fab_dir.mkdir(parents=True, exist_ok=True)
                stem = fab_dir / f"P-review-{preset}"
                with zipfile.ZipFile(f"{stem}-gerbers.zip", "w") as z:
                    z.writestr("P-F_Cu.gtl", "G04*\n")
                    z.writestr("P-B_Cu.gbl", "G04*\n")
                    z.writestr("P.drl", "M48\n")
                pathlib.Path(f"{stem}-positions.csv").write_text(
                    "Designator,Val,Package,Mid X,Mid Y,Rotation,Layer\nR1,10k,R_0603,10,20,90,Top\n", encoding="utf-8")
                pathlib.Path(f"{stem}-bom.csv").write_text(
                    ",".join(label for _, label in kr.PRESETS[preset]["bom"]) + "\n", encoding="utf-8")

            # Finding 4a: 3D viewer enabled requires nonempty board.glb as well as board.raw.glb when no .failed marker exists.
            s3d = copy.deepcopy(kr.DEFAULT_SETTINGS)
            s3d["3d"]["enabled"] = True
            c3d = seed_cache("head")
            (c3d / "board.raw.glb").write_bytes(b"glTF-raw")
            (c3d / "poster.png").write_bytes(br02_png())
            assert not kr.render_cache_complete(c3d, prj, "head", s3d), "missing board.glb must invalidate 3D cache"
            (c3d / "board.glb").write_bytes(b"")
            assert not kr.render_cache_complete(c3d, prj, "head", s3d), "empty board.glb must invalidate 3D cache"
            (c3d / "board.glb").write_bytes(b"glTF-viewer")
            assert kr.render_cache_complete(c3d, prj, "head", s3d), "nonempty board.raw.glb + board.glb + poster accepted"
            (c3d / "board.raw.glb").unlink()
            (c3d / "board.glb").unlink()
            (c3d / "board.raw.glb.failed").write_text("failed", encoding="utf-8")
            assert kr.render_cache_complete(c3d, prj, "head", s3d), "raw export failure marker accepted without board.glb"

            # Finding 4b: Fabrication-limit checks enabled requires parseable fab-limits.json with vendor sections.
            sfab = copy.deepcopy(kr.DEFAULT_SETTINGS)
            sfab["fabrication"]["check_limits"] = True
            sfab["checks"]["fab_limits"] = "required"
            cfab = seed_cache("head")
            assert not kr.render_cache_complete(cfab, prj, "head", sfab), "missing fab-limits.json must invalidate cache"
            (cfab / "fab-limits.json").write_text("{malformed", encoding="utf-8")
            assert not kr.render_cache_complete(cfab, prj, "head", sfab), "malformed fab-limits.json must invalidate cache"
            (cfab / "fab-limits.json").write_text(json.dumps({"sections": [{"vendor": "jlcpcb"}]}), encoding="utf-8")
            assert not kr.render_cache_complete(cfab, prj, "head", sfab), "incomplete vendor sections must invalidate cache"
            (cfab / "fab-limits.json").write_text(json.dumps({"sections": [{"vendor": "jlcpcb"}, {"vendor": "pcbway"}]}), encoding="utf-8")
            assert kr.render_cache_complete(cfab, prj, "head", sfab), "valid fab-limits.json with both vendors accepted"
            # Absent board revision accepts empty sections list
            pathlib.Path("base/p/P.kicad_pcb").unlink()
            cbase = seed_cache("base")
            (cbase / "fab-limits.json").write_text(json.dumps({"sections": [], "reason": "no base board"}), encoding="utf-8")
            assert kr.render_cache_complete(cbase, prj, "base", sfab), "absent board fab-limits.json accepted"
            pathlib.Path("base/p/P.kicad_pcb").write_text('(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user)))', encoding="utf-8")
            assert not kr.render_cache_complete(cbase, prj, "base", sfab), "present board rejects empty sections"

            # Finding 7: Transient release-export failures are not cached as complete and retry only missing release products.
            srel = copy.deepcopy(kr.DEFAULT_SETTINGS)
            srel["checks"]["release"] = "informational"
            crel = seed_cache("head")
            assert not kr.render_cache_complete(crel, prj, "head", srel), "missing fab/ package must invalidate release cache"
            seed_fab_package(crel / "fab", "jlcpcb")
            assert kr.render_cache_complete(crel, prj, "head", srel), "valid fab/ package accepted in release cache"

            pathlib.Path("review").mkdir(exist_ok=True)
            pathlib.Path("review/detect.json").write_text(json.dumps(det), encoding="utf-8")
            render_side_calls = []
            release_calls = []
            download_calls = []
            fail_head_once = {"failed": False}

            def fake_release(pro_path, tag, settings, out_dir, label):
                release_calls.append((pro_path, out_dir, settings["fabrication"]["preset"]))
                if pro_path.startswith("head/") and not fail_head_once["failed"]:
                    fail_head_once["failed"] = True
                    raise OSError("transient release failure")
                seed_fab_package(out_dir, settings["fabrication"]["preset"])
                return []

            with patch.object(kr, "load_settings", return_value=srel), \
                 patch.object(kr, "render_tool_identity", return_value="KiCad 10.0.6"), \
                 patch.object(kr, "render_side", side_effect=lambda src, name, out, **kw: render_side_calls.append((src, out))), \
                 patch.object(kr, "release_project", side_effect=fake_release), \
                 patch.object(kr, "export_downloads", side_effect=lambda *a: download_calls.append(a[2])):
                kr.cmd_render(None)
                base_cache = kr.render_cache(prj, "base", det, srel)
                head_cache = kr.render_cache(prj, "head", det, srel)
                assert kr.render_cache_complete(base_cache, prj, "base", srel), "base release succeeded and is complete"
                assert not kr.render_cache_complete(head_cache, prj, "head", srel), "transient head release failure must not be cached as complete"
                assert len(render_side_calls) == 2

                # Next identical run: base is a full cache hit; head reuses cached non-release outputs and retries only release + downloads.
                kr.cmd_render(None)
                assert len(render_side_calls) == 2, f"render_side should not re-run when only release is missing: {render_side_calls}"
                assert [c[0] for c in release_calls] == [
                    "base/p/P.kicad_pro", "head/p/P.kicad_pro", "head/p/P.kicad_pro"
                ], release_calls
                assert len(download_calls) == 2
                assert kr.render_cache_complete(head_cache, prj, "head", srel), "retried head release is now cached as complete"

                # Third identical run: full cache hit on both sides, nothing runs.
                kr.cmd_render(None)
                assert len(render_side_calls) == 2 and len(release_calls) == 3 and len(download_calls) == 2

                # Direct unit test: restore_renders clears stale review/<p>/<side>/fab before copying cache
                stale_restore_fab = pathlib.Path("review/p/head/fab/stale-restore.txt")
                stale_restore_fab.parent.mkdir(parents=True, exist_ok=True)
                stale_restore_fab.write_text("stale-restore", encoding="utf-8")
                assert stale_restore_fab.is_file()
                kr.restore_renders(None)
                assert not stale_restore_fab.exists(), "restore_renders must remove stale review/<p>/<side>/fab"
                assert (pathlib.Path("review/p/head/fab/P-review-jlcpcb-positions.csv")).is_file(), "restore_renders copies cached fab"

                # Direct unit test: cache_renders rmtree removes stale files from an existing cache directory
                stale_cache_file = head_cache / "stale-cache-leftover.txt"
                stale_cache_file.write_text("stale-cache", encoding="utf-8")
                assert stale_cache_file.is_file()
                assert not (pathlib.Path("review/p/head") / "stale-cache-leftover.txt").exists()
                kr.cache_renders(None)
                assert not stale_cache_file.exists(), "cache_renders must rmtree existing cache directory so stale files are removed"
                assert (head_cache / ".complete").is_file()

                # Direct unit test: cmd_render partial-hit path clears stale fab and skips render_side
                shutil.rmtree(head_cache / "fab")
                assert not kr.render_cache_complete(head_cache, prj, "head", srel), "missing fab invalidates full cache"
                assert kr.render_cache_complete(head_cache, prj, "head", srel, check_release=False), "non-release cache is complete"
                stale_partial_fab = pathlib.Path("review/p/head/fab/stale-partial.txt")
                stale_partial_fab.parent.mkdir(parents=True, exist_ok=True)
                stale_partial_fab.write_text("stale-partial", encoding="utf-8")
                render_side_calls.clear()
                release_calls.clear()
                download_calls.clear()
                kr.cmd_render(None)
                assert len(render_side_calls) == 0, f"partial-hit path must not call render_side: {render_side_calls}"
                assert [c[0] for c in release_calls] == ["head/p/P.kicad_pro"], f"only head release was retried: {release_calls}"
                assert not stale_partial_fab.exists(), "cmd_render partial-hit must clear stale fab directory before release rebuild"
                assert kr.render_cache_complete(head_cache, prj, "head", srel), "head cache is complete after partial-hit release rebuild"

            # Finding 10: Re-running with another fabrication preset clears stale package files in fab/.
            spcbway = copy.deepcopy(srel)
            spcbway["fabrication"]["preset"] = "pcbway"
            pcbway_cached_files = {}
            with patch.object(kr, "load_settings", return_value=spcbway), \
                 patch.object(kr, "render_tool_identity", return_value="KiCad 10.0.6"), \
                 patch.object(kr, "render_side"), \
                 patch.object(kr, "release_project", side_effect=fake_release), \
                 patch.object(kr, "export_downloads"):
                kr.cmd_render(None)
                for side in ("base", "head"):
                    summary = kr.package_summary(f"review/p/{side}/fab")
                    paths = [f["path"] for f in summary["files"]]
                    assert paths and all("pcbway" in name and "jlcpcb" not in name for name in paths), (side, paths)
                    cached_fab = kr.render_cache(prj, side, det, spcbway) / "fab"
                    cached_names = sorted(f.name for f in cached_fab.iterdir())
                    assert cached_names and all("pcbway" in name and "jlcpcb" not in name for name in cached_names), (side, cached_names)
                    pcbway_cached_files[side] = cached_names

            # Re-running with checks.release off clears stale package files from review.
            sreloff = copy.deepcopy(spcbway)
            sreloff["checks"]["release"] = "off"
            with patch.object(kr, "load_settings", return_value=sreloff), \
                 patch.object(kr, "render_tool_identity", return_value="KiCad 10.0.6"), \
                 patch.object(kr, "render_side"), \
                 patch.object(kr, "export_downloads"):
                kr.cmd_render(None)
                for side in ("base", "head"):
                    assert not pathlib.Path(f"review/p/{side}/fab").exists(), f"stale fab/ must be removed when release check is off on {side}"
                    # Assert on the pcbway-keyed cache dir: prior pcbway cache fab directory exists and file names match earlier run.
                    cached_pcbway_fab = kr.render_cache(prj, side, det, spcbway) / "fab"
                    assert cached_pcbway_fab.is_dir(), f"pcbway-keyed cache fab directory should exist on {side}"
                    assert sorted(f.name for f in cached_pcbway_fab.iterdir()) == pcbway_cached_files[side], (
                        f"pcbway-keyed cache fab file names on {side} should match earlier pcbway run"
                    )

            # Missing-project .kicad_pro branch: with release on and no .kicad_pro, stale fab/ is removed.
            snopro = copy.deepcopy(srel)
            shutil.rmtree(".render-cache", ignore_errors=True)
            for side in ("base", "head"):
                stale_fab = pathlib.Path(f"review/p/{side}/fab")
                stale_fab.mkdir(parents=True, exist_ok=True)
                (stale_fab / "stale.txt").write_text("stale", encoding="utf-8")
                assert (stale_fab / "stale.txt").is_file()
                pathlib.Path(f"{side}/p/P.kicad_pro").unlink(missing_ok=True)

            with patch.object(kr, "load_settings", return_value=snopro), \
                 patch.object(kr, "render_tool_identity", return_value="KiCad 10.0.6"), \
                 patch.object(kr, "render_side"), \
                 patch.object(kr, "export_downloads"):
                kr.cmd_render(None)
                for side in ("base", "head"):
                    assert not pathlib.Path(f"review/p/{side}/fab").exists(), f"stale fab/ must be removed when project file is missing on {side}"
        finally:
            os.chdir(old)


test_f4_render_and_release_cache()
print("ok F4 render and release cache completeness and preset cleanup")


def test_f5_optional_evidence_survives_bad_project_json_and_hotspot_errors():
    import contextlib
    import io
    import os
    import pathlib
    import tempfile

    def put(root, files):
        for rel, text in files.items():
            path = pathlib.Path(root, rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    bad_projects = ["[]", "null", '{"board": []}', '{"board": {"design_settings": []}}', '{"net_settings": []}',
                    '{"board": {"design_settings": 5}}']
    with tempfile.TemporaryDirectory() as td:
        old = os.getcwd()
        os.chdir(td)
        try:
            # Finding 5: valid JSON of the wrong shape marks only project rules unavailable.
            for bad in bad_projects:
                put("bad", {"p/p.kicad_pro": bad})
                try:
                    values = kr.rule_values("bad/p", "p")
                except Exception as exc:
                    raise AssertionError(f"rule_values crashed on {bad}: {exc!r}")
                assert values.get("_unavailable", "").startswith("Project rules unavailable"), (bad, values)
                try:
                    kr.pro_objects("bad/p/p.kicad_pro")
                except ValueError:
                    pass  # project_objects records unreadable evidence for ValueError
                else:
                    raise AssertionError(f"expected ValueError from pro_objects for bad shape {bad}")
            put("bad", {"p/p.kicad_pro": '{"board": {"design_settings": {"rules": {"min_clearance": 0.2}}}}'})
            assert kr.rule_values("bad/p", "p") == {"rules.min_clearance": 0.2}
            put("bad", {"p/p.kicad_pro": '{"board": null, "net_settings": null}'})
            assert kr.rule_values("bad/p", "p") == {}

            # A non-object project file never poisons project_objects either.
            issues = []
            put("bad", {"p/p.kicad_pro": "[]", "p/p.kicad_sch": "(kicad_sch (uuid root))"})
            with contextlib.redirect_stderr(io.StringIO()):
                kr.project_objects("bad/p", "p", issues)
            assert any(i.get("unknownMeta") == "meta:pro" for i in issues), issues

            # electrical_changes keeps the independent .kicad_dru and stackup diffs.
            p = {"dir": "p", "name": "p"}
            for side, thickness, dru in (("base", ".2", "(version 1)\n"),
                                         ("head", ".3", '(version 1)\n(rule "r" (constraint clearance (min 0.3mm)))\n')):
                put(side, {"p/p.kicad_pro": "[]", "p/p.kicad_dru": dru,
                           "p/p.kicad_pcb": f'(kicad_pcb (setup (stackup (layer "d" (thickness {thickness})))))'})
            put("review/p", {"copper-diff.json": json.dumps({"rows": [], "incomplete": []})})
            rows, issues = kr.electrical_changes(p, "review/p", {"base": {}, "head": {}},
                                                 {"base": "b" * 40, "head": "h" * 40})
            refs = {r["ref"] for r in rows}
            assert {"custom rules", "stackup"} <= refs, refs
            assert any(r["detail"].get("kind") == "unavailable" for r in rows), rows
            assert not [i for i in issues if i["channel"] == "rules"], issues

            # Finding 6: a symbol-geometry error keeps the symbol, with a warning.
            cycle_sch = ('(kicad_sch (uuid root) (lib_symbols (symbol "L:A" (extends "B")) (symbol "L:B" (extends "A")))'
                         ' (symbol (uuid s1) (lib_id "L:A") (at 10 10 0) (property "Reference" "U1")))')
            put("hot", {"Board.kicad_sch": cycle_sch})
            m = kr.sheet_hotspots("hot", "Board")
            assert [w["reason"] for w in m["warnings"]] == ["symbol geometry unavailable"], m["warnings"]
            assert m["views"][0]["elements"][0]["confidence"] == "approximate"

            # ... and a hotspot failure in build_project keeps the schematic SVGs.
            for side in ("base", "head"):
                put(side, {"H/H.kicad_sch": "(kicad_sch (uuid root))"})
                put(f"review/H/{side}", {"erc.json": '{"sheets": []}',
                                         "sch/H.svg": '<svg viewBox="0 0 320 213"><path d="M10 10H310"/></svg>'})
            err = io.StringIO()
            with contextlib.redirect_stderr(err), \
                 patch.object(kr, "sheet_hotspots", side_effect=ValueError("recursive schematic hierarchy")):
                report = kr.build_project({"dir": "H", "name": "H", "status": "modified"}, {}, kr.DEFAULT_SETTINGS)
            root_page = next(pg for pg in report["sheets"] if pg["path"] == "/")
            assert root_page["svg"]["base"] and root_page["svg"]["head"], root_page
            assert root_page["hotspots"] == {"base": None, "head": None}, root_page["hotspots"]
            assert "::warning::" in err.getvalue() and "hotspots unavailable" in err.getvalue(), err.getvalue()
        finally:
            os.chdir(old)


test_f5_optional_evidence_survives_bad_project_json_and_hotspot_errors()
print("ok F5 optional evidence survives bad project JSON and hotspot errors")


def test_f6_downloads_guards_and_fab_tempdir_leak():
    old = os.getcwd()
    with tempfile.TemporaryDirectory() as root:
        os.chdir(root)
        try:
            # 1. Finding 8: Schematic-only project with downloads enabled must NOT call export_glb or write glb failure markers.
            det_sch = {
                "base": "a" * 40, "head": "b" * 40, "reason": "t",
                "projects": [{"dir": "sch_prj", "name": "S", "status": "modified"}]
            }
            pathlib.Path("review").mkdir(parents=True, exist_ok=True)
            pathlib.Path("review/detect.json").write_text(json.dumps(det_sch), encoding="utf-8")
            pathlib.Path("base/sch_prj").mkdir(parents=True, exist_ok=True)
            pathlib.Path("head/sch_prj").mkdir(parents=True, exist_ok=True)
            pathlib.Path("base/sch_prj/S.kicad_sch").write_text("(kicad_sch (uuid s-base))", encoding="utf-8")
            pathlib.Path("head/sch_prj/S.kicad_sch").write_text("(kicad_sch (uuid s-head))", encoding="utf-8")

            s_dl = copy.deepcopy(kr.DEFAULT_SETTINGS)
            s_dl["downloads"]["enabled"] = True
            s_dl["3d"]["enabled"] = False

            glb_calls = []
            with patch.object(kr, "load_settings", return_value=s_dl), \
                 patch.object(kr, "render_tool_identity", return_value="KiCad 10.0.6"), \
                 patch.object(kr, "render_side"), \
                 patch.object(kr, "export_downloads"), \
                 patch.object(kr, "export_glb", side_effect=lambda p, side, out, **kw: glb_calls.append((side, kw))):
                kr.cmd_render(None)

            assert len(glb_calls) == 0, f"schematic-only project must not invoke export_glb: {glb_calls}"
            assert not pathlib.Path("review/sch_prj/head/board.raw.glb.failed").exists()
            assert not pathlib.Path("review/sch_prj/head/glb.log").exists()

            # 2. Finding 8: Board project with downloads and 3D enabled on byte-identical revisions reuses base 3D artifacts without a second export_glb.
            det_3d = {
                "base": "a" * 40, "head": "b" * 40, "reason": "t",
                "projects": [{"dir": "pcb_prj", "name": "B", "status": "modified"}]
            }
            pathlib.Path("review/detect.json").write_text(json.dumps(det_3d), encoding="utf-8")
            pathlib.Path("base/pcb_prj").mkdir(parents=True, exist_ok=True)
            pathlib.Path("head/pcb_prj").mkdir(parents=True, exist_ok=True)
            pcb_content = '(kicad_pcb (version 20240108) (generator kicad-review))'
            pathlib.Path("base/pcb_prj/B.kicad_pcb").write_text(pcb_content, encoding="utf-8")
            pathlib.Path("head/pcb_prj/B.kicad_pcb").write_text(pcb_content, encoding="utf-8")

            s_3d_dl = copy.deepcopy(kr.DEFAULT_SETTINGS)
            s_3d_dl["downloads"]["enabled"] = True
            s_3d_dl["3d"]["enabled"] = True

            glb_calls_3d = []
            def fake_export_glb(p, side, out, **kw):
                glb_calls_3d.append((side, kw))
                folder = pathlib.Path(out)
                folder.mkdir(parents=True, exist_ok=True)
                (folder / "board.raw.glb").write_bytes(b"glTF-raw-content")
                (folder / "board.glb").write_bytes(b"glTF-viewer-content")
                (folder / "poster.png").write_bytes(b"poster-png-content")

            with patch.object(kr, "load_settings", return_value=s_3d_dl), \
                 patch.object(kr, "render_tool_identity", return_value="KiCad 10.0.6"), \
                 patch.object(kr, "render_side"), \
                 patch.object(kr, "export_downloads"), \
                 patch.object(kr, "export_glb", side_effect=fake_export_glb):
                kr.cmd_render(None)

            assert [side for side, kw in glb_calls_3d] == ["base"], f"head must reuse base 3D artifacts, not export twice: {glb_calls_3d}"
            head_out = pathlib.Path("review/pcb_prj/head")
            assert (head_out / "board.raw.glb").read_bytes() == b"glTF-raw-content"
            assert (head_out / "board.glb").read_bytes() == b"glTF-viewer-content"
            assert (head_out / "poster.png").read_bytes() == b"poster-png-content"

            # Finding 8: Board project with downloads enabled, 3D viewer off, and shared revisions (e.g. design/still enabled).
            # The "shared_3d and downloads enabled and not export_3d" branch must cause head to do its own raw-GLB export instead of copying base.
            shutil.rmtree("review/pcb_prj", ignore_errors=True)
            s_dl_no3d = copy.deepcopy(kr.DEFAULT_SETTINGS)
            s_dl_no3d["downloads"]["enabled"] = True
            s_dl_no3d["3d"]["enabled"] = False
            s_dl_no3d.setdefault("design", {})["enabled"] = True

            glb_calls_dl_no3d = []
            with patch.object(kr, "load_settings", return_value=s_dl_no3d), \
                 patch.object(kr, "render_tool_identity", return_value="KiCad 10.0.6"), \
                 patch.object(kr, "render_side"), \
                 patch.object(kr, "export_downloads"), \
                 patch.object(kr, "export_glb", side_effect=lambda p, side, out, **kw: glb_calls_dl_no3d.append((side, kw))):
                kr.cmd_render(None)

            assert glb_calls_dl_no3d == [
                ("base", {"model": False}),
                ("head", {"model": True, "poster": True, "viewer": False}),
            ], f"head must do its own raw-GLB export when shared_3d and downloads enabled and not export_3d: {glb_calls_dl_no3d}"

            # 3. Finding 9: release_project cleans up temporary fabrication directory on success and on error.
            pro_dir = pathlib.Path("fab_test")
            pro_dir.mkdir(parents=True, exist_ok=True)
            pro_path = pro_dir / "T.kicad_pro"
            pro_path.write_text("{}", encoding="utf-8")
            (pro_dir / "T.kicad_pcb").write_text('(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user)))', encoding="utf-8")
            fab_out = pathlib.Path("fab_out")
            fab_out.mkdir(parents=True, exist_ok=True)

            created_dirs = []
            orig_tempdir = tempfile.TemporaryDirectory

            class TrackingTempDir(orig_tempdir):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    created_dirs.append(self.name)

            def fake_kicad_cli(*args):
                kind = args[2] if args[1] == "export" else args[1]
                out_idx = args.index("-o") + 1
                out_path = pathlib.Path(args[out_idx])
                if kind == "gerbers":
                    (out_path / "T-F_Cu.gbr").write_bytes(b"gerber")
                elif kind == "drill":
                    (out_path / "T.drl").write_bytes(b"drill")
                elif kind == "pos":
                    out_path.write_text("Designator,Val,Package,Mid X,Mid Y,Rotation,Side\nR1,10k,0603,0,0,0,top\n", encoding="utf-8")

            with patch("tempfile.TemporaryDirectory", TrackingTempDir), \
                 patch.object(kr, "kicad_cli", side_effect=fake_kicad_cli):
                made = kr.release_project(str(pro_path), "v1", kr.DEFAULT_SETTINGS, str(fab_out), "T")
                assert len(created_dirs) == 1, "release_project must use tempfile.TemporaryDirectory"
                assert not os.path.exists(created_dirs[0]), f"temp dir {created_dirs[0]} leaked after success"
                expected_made = [f"{fab_out}/T-v1-jlcpcb-gerbers.zip", f"{fab_out}/T-v1-jlcpcb-positions.csv"]
                assert made == expected_made, f"unexpected release artifacts: {made} != {expected_made}"
                for path in made:
                    assert os.path.isfile(path), f"release artifact missing: {path}"
                    assert os.path.getsize(path) > 0, f"release artifact empty: {path}"
                with zipfile.ZipFile(made[0]) as z:
                    assert sorted(z.namelist()) == ["T-F_Cu.gbr", "T.drl"]
                with open(made[1], encoding="utf-8") as fh:
                    assert "Designator" in fh.read()

            # Failure during fabrication also cleans up the temp dir
            created_dirs_err = []
            class TrackingTempDirErr(orig_tempdir):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    created_dirs_err.append(self.name)

            def failing_kicad_cli(*args):
                raise RuntimeError("simulated fabrication failure")

            with patch("tempfile.TemporaryDirectory", TrackingTempDirErr), \
                 patch.object(kr, "kicad_cli", side_effect=failing_kicad_cli):
                try:
                    kr.release_project(str(pro_path), "v1", kr.DEFAULT_SETTINGS, str(fab_out), "T")
                except RuntimeError:
                    pass
                assert len(created_dirs_err) == 1
                assert not os.path.exists(created_dirs_err[0]), f"temp dir {created_dirs_err[0]} leaked after error"

        finally:
            os.chdir(old)


test_f6_downloads_guards_and_fab_tempdir_leak()
print("ok F6 downloads guards and temp-dir leak")


# F1: Sheetfile paths stay inside the revision; bad sheets warn instead of crashing.
def test_f1_sheetfile_containment_and_hierarchy():
    import contextlib, io
    old = os.getcwd()
    with TemporaryDirectory() as t:
        os.chdir(t)
        kr._sheet_warnings.clear()
        try:
            secret = '(kicad_sch (symbol (uuid "leak") (property "Reference" "SECRET")))'
            write(t, {'base/P/private.kicad_sch': secret, 'outside.kicad_sch': secret,
                      'head/Shared/common.kicad_sch': '(kicad_sch (symbol (uuid "c1") (property "Reference" "C1")))',
                      'head/P/dir/keep.txt': ''})
            os.symlink(f'{t}/outside.kicad_sch', 'head/P/link.kicad_sch')
            write(t, {'head/P/H.kicad_sch': '(kicad_sch (uuid "root") '
                      + sheet('Shared', '../Shared/common.kicad_sch', 'shared')
                      + sheet('Up', '../../base/P/private.kicad_sch', 'up')
                      + sheet('Abs', f'{t}/outside.kicad_sch', 'abs')
                      + sheet('Link', 'link.kicad_sch', 'link')
                      + sheet('Dir', 'dir', 'dir')
                      + '(sheet (uuid "nofile") (property "Sheetname" "NoFile"))'
                      + '(sheet (property "Sheetname" "NoUuid") (property "Sheetfile" "../Shared/common.kicad_sch"))'
                      + sheet('Again', 'H.kicad_sch', 'again') + ')'})
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                pages = kr.sheet_pages('head/P', 'H')
                objs = kr.sch_objects('head/P', 'H')
                hot = kr.sheet_hotspots('head/P', 'H')
            assert [(p['path'], p['file']) for p in pages] == [
                ('/', 'H.kicad_sch'), ('/shared/', '../Shared/common.kicad_sch'), ('/dir/', 'dir')], pages
            assert objs['/shared/c1']['ref'] == 'C1' and not any(o.get('ref') == 'SECRET' for o in objs.values()), objs
            assert [v['sheet'] for v in hot['views']] == ['/', '/shared/', '/dir/'], hot['views']
            text = err.getvalue()
            for needle in ("'Up'", "'Abs'", "'Link'", "'NoFile'", "'NoUuid'", "'Again'", 'head/P/dir'):
                assert needle in text, (needle, text)
            assert all(line.startswith('::warning::') for line in text.splitlines()), text
            # Sibling names that sanitize to one SVG stem: kicad-cli writes one SVG for both, so
            # neither drawing is trustworthy. Both are dropped and the schematic review is incomplete.
            write(t, {'head/P/H.kicad_sch': '(kicad_sch ' + sheet('A/B', 'a.kicad_sch', 'u1') + sheet('A_B', 'b.kicad_sch', 'u2') + ')',
                      'head/P/a.kicad_sch': '(kicad_sch (symbol (uuid "ra") (property "Reference" "RA") (property "Value" "1k")))',
                      'head/P/b.kicad_sch': '(kicad_sch (symbol (uuid "rb") (property "Reference" "RB") (property "Value" "2k")))'})
            kr._sheet_warnings.clear()
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                collide_pages = kr.sheet_pages('head/P', 'H')
                issues = []
                kr.project_objects('head/P', 'H', issues)
            assert [p['name'] for p in collide_pages] == ['H'], collide_pages
            assert "sheet 'A_B' collides with another sheet using sanitized name 'A_B'; all colliding sibling sheets skipped" in err.getvalue(), err.getvalue()
            assert all(line.startswith('::warning::') for line in err.getvalue().splitlines()), err.getvalue()
            reasons = {(i['document'], i['channel']) for i in issues}
            assert {('schematic', 'components'), ('schematic', 'visual')} <= reasons, issues
            # A malformed sibling (no uuid) does not claim the name, so a valid sibling named A still renders.
            write(t, {'head/P/H.kicad_sch': '(kicad_sch (sheet (property "Sheetname" "A") (property "Sheetfile" "a.kicad_sch"))'
                      + sheet('A', 'b.kicad_sch', 'u2') + ')'})
            kr._sheet_warnings.clear()
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                lone_pages = kr.sheet_pages('head/P', 'H')
                issues = []
                kr.project_objects('head/P', 'H', issues)
            assert [(p['name'], p['file']) for p in lone_pages] == [('H', 'H.kicad_sch'), ('A', 'b.kicad_sch')], lone_pages
            assert 'collides' not in err.getvalue() and not issues, (err.getvalue(), issues)

            # Relative proj_dir with leading './' still bounds containment to the revision root.
            write(t, {'head/P/H.kicad_sch': '(kicad_sch (uuid "root") '
                      + sheet('Escape', '../../base/P/private.kicad_sch', 'esc') + ')'})
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                dot_pages = kr.sheet_pages('./head/P', 'H')
            assert [p['name'] for p in dot_pages] == ['H'], dot_pages
            assert "sheet 'Escape' file '../../base/P/private.kicad_sch' is outside the revision; skipped" in err.getvalue()

            # NUL byte in Sheetfile warns and skips instead of crashing realpath.
            write(t, {'head/P/H.kicad_sch': '(kicad_sch (uuid "root") '
                      + sheet('NullByte', 'sub\x00file.kicad_sch', 'null1') + ')'})
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                null_pages = kr.sheet_pages('head/P', 'H')
            assert [p['name'] for p in null_pages] == ['H'], null_pages
            assert "sheet 'NullByte' file 'sub\\x00file.kicad_sch' contains a null byte; skipped" in err.getvalue()

            # Warning deduplication does not suppress warnings across distinct revisions/projects.
            write(t, {'base/P/B.kicad_sch': '(kicad_sch (uuid "broot") '
                      + sheet('Outside', '../../outside.kicad_sch', 'out1') + ')'})
            write(t, {'head/P/H2.kicad_sch': '(kicad_sch (uuid "hroot") '
                      + sheet('Outside', '../../outside.kicad_sch', 'out2') + ')'})
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                kr.sheet_pages('base/P', 'B')
                kr.sheet_pages('head/P', 'H2')
            assert err.getvalue().count("is outside the revision; skipped") == 2, err.getvalue()

            # Nested 'base' or 'head' segment in proj_dir uses the revision prefix, not the last segment.
            assert kr.revision_root('head/hw/head/P') == os.path.realpath('head')
            assert kr.revision_root('./head/hw/head/P') == os.path.realpath('head')
            assert kr.revision_root('base/hw/base/P') == os.path.realpath('base')
            write(t, {
                'head/hw/Shared/common.kicad_sch': '(kicad_sch (symbol (uuid "s1") (property "Reference" "S1")))',
                'head/hw/head/P/H.kicad_sch': '(kicad_sch (uuid "root") '
                    + sheet('Shared', '../../Shared/common.kicad_sch', 'shared') + ')'
            })
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                nested_pages = kr.sheet_pages('head/hw/head/P', 'H')
            assert [p['name'] for p in nested_pages] == ['H', 'Shared'], nested_pages
            assert 'outside the revision' not in err.getvalue()

            # Escaping out of the revision root from a nested project directory is still blocked.
            write(t, {
                'head/hw/head/P/H2.kicad_sch': '(kicad_sch (uuid "root") '
                    + sheet('Escape', '../../../../base/P/private.kicad_sch', 'esc') + ')'
            })
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                esc_pages = kr.sheet_pages('head/hw/head/P', 'H2')
            assert [p['name'] for p in esc_pages] == ['H2'], esc_pages
            assert "sheet 'Escape' file '../../../../base/P/private.kicad_sch' is outside the revision; skipped" in err.getvalue()
        finally:
            os.chdir(old)


test_f1_sheetfile_containment_and_hierarchy()
print("ok F1 sheetfile containment and hierarchy")


# F7: a malformed head board still produces a report with incomplete board evidence.
def test_f7_malformed_board_report():
    with tempfile.TemporaryDirectory() as td:
        old = os.getcwd(); os.chdir(td)
        try:
            p = {"dir": "p", "name": "p", "status": "modified"}
            good = br03_pcb("fp", [("pad1", "1", 0, "GND")]).replace('(kicad_pcb ', '(kicad_pcb (layers (0 "F.Cu" signal)) ')
            drc = json.dumps({"violations": [{"type": "clearance", "severity": "error", "description": "x", "items": []}],
                              "unconnected_items": [], "schematic_parity": []})
            for side in ("base", "head"):
                write(side, {"p/p.kicad_sch": '(kicad_sch (uuid root) (symbol (uuid r) (at 1 2 0) (property "Reference" "D1")))',
                             "p/p.kicad_pcb": good})
                write("review/p/" + side, {"sch/p.svg": '<svg width="10mm" height="10mm" viewBox="0 0 10 10"/>',
                                           "netlist.net": "(export (nets))", "erc.json": '{"sheets":[]}', "drc.json": drc})
            write("review", {"detect.json": json.dumps({"base": "a" * 40, "head": "b" * 40, "reason": "fixture", "projects": [p]}),
                             "p/copper-diff.json": json.dumps({"rows": [], "incomplete": []})})

            def report():
                err = io.StringIO()
                with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                    try:
                        kr.cmd_report(None)
                    except SystemExit as exc:
                        raise AssertionError(f"report ended: {exc}")
                return json.loads(pathlib.Path("review/data.json").read_text())["projects"][0], err.getvalue()

            # A fully valid project: DRC runs, board objects compared, no board incompleteness.
            valid, _ = report()
            checks = {c["name"]: c for c in valid["checks"]}
            assert checks["drc"]["status"] == "pass" and checks["drc"]["errors"] == 1 and checks["drc"]["new_errors"] == 0, checks["drc"]
            assert checks["parity"]["status"] == "pass", checks["parity"]
            assert not any("malformed" in i["reason"] for i in valid["summary"]["incomplete"]), valid["summary"]
            assert not any(r["kind"] == "footprint" for r in valid["changes"]), valid["changes"]

            # Head board malformed: render_side left only the marker.
            write("head", {"p/p.kicad_pcb": '(kicad_pcb (layers (0 "F.Cu" signal))'})
            pathlib.Path("review/p/head/drc.json").unlink()
            write("review/p/head", {"drc.json.error": "board DRC not run: malformed board file: malformed S-expression"})
            project, err = report()
            assert "::warning::head/p/p.kicad_pcb: malformed board file; board objects left out" in err, err
            board = next(d for d in project["summary"]["documents"] if d["document"] == "board")
            marked = {i["channel"] for i in board["incomplete"] if "malformed" in i["reason"]}
            assert {"components", "routing", "rules", "board", "visual"} <= marked, board["incomplete"]
            assert all(c["status"] == "incomplete" for c in board["channels"] if c["channel"] in marked), board["channels"]
            # The readable base board is not reported as removed against a missing head board.
            assert not any(r.get("document") == "board" and r["action"] == "removed" for r in project["changes"]), project["changes"]
            checks = {c["name"]: c for c in project["checks"]}
            for name in ("drc", "parity"):
                c = checks[name]
                assert c["status"] == "not_run" and c.get("incomplete") is True, c
                assert c["reason"] == "head board DRC not run: malformed board file: malformed S-expression", c
                assert c["errors"] == c["new_errors"] == c["fixed"] == 0 and c["violations"] == [], c
            assert checks["erc"]["status"] == "pass", checks["erc"]

            # Without the marker, a missing drc.json still stops the review.
            pathlib.Path("review/p/head/drc.json.error").unlink()
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    kr.project_checks(p, kr.load_settings(), {"base": {}, "head": {}})
                raise AssertionError("missing drc.json without a marker must stop the review")
            except SystemExit as exc:
                assert "kicad-cli wrote no drc.json" in str(exc), exc
        finally:
            os.chdir(old)


test_f7_malformed_board_report()
print("ok F7 malformed board gives a report with incomplete board evidence")
