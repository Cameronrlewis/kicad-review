# CPL regression fixtures (synthetic)

Board: `ui/fixtures/cpl-rotation.kicad_pcb`, a synthetic KiCad 10 board with parts on top and bottom, rotations 0/90/180/270 and 45, and one package not in the table (R_0805_2012Metric).

- `cpl-rotation-pos-raw.csv`: the production `kicad-cli pcb export pos` output after the release header rename. Exported with kicad-cli 10.0.0 (local) and re-exported on the pinned image `kicad/kicad:10.0.6-full`: byte-identical.
- `cpl-rotation-pos-corrected.csv`: `correct_positions` with the vendored table and no overrides. Hand-checked row by row against `../jlcpcb_cpl_rotations.csv`: 8 of 8 rows agree; 6 rows matched a rule (J1, J2 by `^PinHeader_2x05_P1\.27mm_Vertical`; Q1 by `^SOT-223`; U1, U2 by `^SOT-23`; U3 by `^SOIC-`), and R1 (top) and R2 (bottom) matched none.

`test_kicad_review.py` (`cpl-rotation CPL regression`) asserts the corrected bytes and the matched-row count.
