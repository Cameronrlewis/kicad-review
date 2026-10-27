#!/bin/bash
set -euo pipefail
python3 -c 'import pcbnew; print(pcbnew.GetBuildVersion())'
python3 /w/probe/collect_probe.py /w/probe/tools/copper_area.py /w/out/collect /w/probe/vf-order-4.kicad_pcb
python3 /w/probe/oracle_gate.py /w/probe/tools/copper_area.py /w/out/oracle /w/probe/vf-order-4.kicad_pcb
