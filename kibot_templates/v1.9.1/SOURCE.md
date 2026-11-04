# Vendored KiBot templates (v1.9.1)

Source: https://github.com/INTI-CMNB/KiBot
- Tag v1.9.1, tag object 3b79f610136aebc1b9c539e316d9e16af5e37732, commit 8a5106ecdbdaa0057255496fe768766df493221d.
- kibot/resources/config_templates/JLCPCB.kibot.yaml, 167 lines, sha256 9dcc65bf1fa6e8a7e54e708088e37a9a312b06eb01dbfacdf3d19a4a433f8ca6.
- kibot/resources/config_templates/PCBWay.kibot.yaml, 93 lines, sha256 6b908fe676409b032004e4d31b421a1772788a310b5365125442bbd505e6b12c.
- Licence: GNU Affero General Public License v3 (the LICENSE file at the pinned commit). The copies are unmodified.
- Fetched 2026-10-26 with curl from raw.githubusercontent.com at the pinned commit.

Checked by `kibot_differences` (see the KiBot block in test_kicad_review.py): Protel copper, silkscreen, mask and edge files present; JLCPCB stencil files absent (lines 147-148); JLCPCB BOM rows carry an LCSC number (line 115).
Pinned by flag tests: --no-x2 (JLCPCB 55, PCBWay 30); --subtract-soldermask only for JLCPCB (JLCPCB 58, PCBWay 34); --excellon-separate-th only for JLCPCB (JLCPCB 71).

Known differences, recorded and not fixed:
- PCBWay header says "with stencil" (line 1) but its paste variables default to empty (line 77); stencil is not checked for PCBWay.
- PCBWay has no position or BOM output in its template.
- PCBWay drill (line 56) expects PTH and NPTH in separate files; this export writes one file.
- JLCPCB Excellon map: template `map: gerber` (line 75); this export writes gerberx2.
- JLCPCB position `only_smd: true` (line 146, used at line 92); this export lists every placed part.
- JLCPCB BOM `quote_all: true` (line 128); this export uses KiCad's quoting.
- Plot options (JLCPCB lines 47-58) are not compared; only Gerber member names are.
