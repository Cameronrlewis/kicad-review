# JLCPCB CPL rotation table (vendored)

Table: jlc_kicad_tools/cpl_rotations_db.csv in https://github.com/matthewlai/JLCKicadTools
- Commit 50ab53794357e2217bf56cae1381be5ff23dbb37 (2024-09-11), sha256 fce26b890863fa56c6fc8d91a44241d9f3b420c78da28a10bc13204903542698, 59 rules, byte copy.
- Licence: GNU GPL v3 (the LICENSE file at the pinned commit). Copied unmodified.
- Format: "Footprint pattern","Rotation","Offset X","Offset Y". Each pattern is a Python regular expression matched from the start of the Package column. The last matching row wins. Rotation is whole degrees. Offsets are millimetres. A missing trailing offset cell means 0; an empty cell is an error in this repository.
- Rows kept as shipped: the header has a space before "Offset Y"; the last pattern has a doubled leading anchor (`^^WSON-8-1EP_6x5mm_P1.27mm`), which is harmless for re.match.
- Angles: KiBot's rot_footprint filter documentation (v1.9.1, docs/source/configuration/filters/rot_footprint.rst) states that its angles match matthewlai/JLCKicadTools.
- Arithmetic: ported from jlc_kicad_tools/jlc_lib/cpl_fix_rotations.py at commit cdd504e30adf77fbd6a4d33189e12f95df61a2d3 (sha256 d836b4f8e242695ed3130f2af8ca41feba463a5045cc6c316e877487fa8ae39d), lines 121-173. Algorithm only; no code copied.
- Bottom side: the mirror (-rotation + 180) % 360 follows the pinned code's July 2022 rule. It is unverified against JLCPCB's current behaviour.
- PCBWay: no rotation source is pinned, so PCBWay positions are not corrected.
- Not JLCPCB's published data. It is the community table the pinned code uses.
