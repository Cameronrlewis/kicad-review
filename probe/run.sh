#!/bin/bash
# Pinned KiCad 10.0.6 container: runs the extracted fabrication geometry gate (checkout root is /w, probe files under /w/probe).
set -euo pipefail
cd /w/probe
mkdir -p /w/out/fab
kicad-cli version > /w/out/kicad-version.txt 2>&1 || true
KICAD_FAB_VERIFY=1 KICAD_FAB_OUT=/w/out/fab python3 fab_gate_probe.py
echo "gate exit $?"
