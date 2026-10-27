import copy, json, os, pathlib, subprocess, sys, tempfile
import kicad_review as kr

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


def fab_capability_probe(root):
    summaries = []
    for profile, layers in (('jlcpcb-multilayer', 4), ('pcbway-std', 4),
                            ('jlcpcb-2l', 2), ('pcbway-std', 2)):
        target = root / f'{profile}-{layers}l'
        target.mkdir(parents=True, exist_ok=False)
        summaries.append(fab_profile_probe(target, profile, layers))
    (root / 'manifest.json').write_text(json.dumps(summaries, indent=2))
    (root / 'four.kicad_pcb').write_text(fab_probe_board(''.join(
        fab_segment('four-'+layer, layer, .08, y=10+10*i)
        for i, layer in enumerate(('F.Cu', 'In1.Cu', 'B.Cu')))))
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

if os.environ.get('KICAD_FAB_VERIFY') == '1':
    fab_capability_probe(pathlib.Path(os.environ['KICAD_FAB_OUT']))
