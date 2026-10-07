"""Self-checks for kicad_review.py. Run: python3 test_kicad_review.py"""
from kicad_review import is_kicad_file, owner_project

dirs = {"", "boards/a", "boards/a/sub", "b"}
assert owner_project("boards/a/x.kicad_sch", dirs) == "boards/a"
assert owner_project("boards/a/sub/Libraries/y.kicad_mod", dirs) == "boards/a/sub"
assert owner_project("boards/ab/x.kicad_sch", dirs) == ""  # not a prefix match on 'boards/a'
assert owner_project("x.kicad_pcb", {"b"}) is None
assert is_kicad_file("p/fp-lib-table") and is_kicad_file("p/L.pretty/R.kicad_mod")
assert not is_kicad_file("p/p.kicad_prl") and not is_kicad_file("p/m.step")
print("ok")
