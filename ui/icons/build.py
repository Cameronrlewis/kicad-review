"""Rebuild the checked-in local-fragment SVG sprite using Python's stdlib."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)
root = ET.Element(f'{{{SVG}}}svg', {
    'width': '0', 'height': '0', 'aria-hidden': 'true', 'focusable': 'false',
    'style': 'position:absolute;overflow:hidden', 'id': 'kr-icons',
})
root.append(ET.Comment(
    ' KiCad-derived symbols: CC-BY-SA-4.0. Original icons: Inigo Zuluaga, '
    'Fabrizio Tappero and contributors; 2020 redesign: Aleksandr Zyrianov. '
    'Source: https://gitlab.com/kicad/code/kicad/-/tree/3e051f88/resources/bitmaps_png/sources '
    'License: https://creativecommons.org/licenses/by-sa/4.0/ '
    'Changes: metadata removed; IDs and CSS classes namespaced; symbol wrappers. '
    'Only derived artwork is share-alike. Full terms: ui/icons/LICENSE. '
))
allowed = {'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
           'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'style'}
for name, filename in [('zoom-in', 'zoom_in'), ('zoom-out', 'zoom_out'), ('fit', 'zoom_fit_in_page')]:
    for theme in ('light', 'dark'):
        key = f'kr-{name}-{theme}'
        source = ET.parse(HERE / 'kicad' / theme / f'{filename}.svg').getroot()
        symbol = ET.SubElement(root, f'{{{SVG}}}symbol', {
            'id': key, 'viewBox': source.attrib['viewBox'],
        })
        ids = {n.attrib['id']: f'{key}-{n.attrib["id"]}' for n in source.iter() if 'id' in n.attrib}
        def clean(node):
            local = node.tag.rsplit('}', 1)[-1]
            if not node.tag.startswith('{' + SVG + '}') or local not in allowed:
                return None
            out = ET.Element(f'{{{SVG}}}{local}')
            for attr, value in node.attrib.items():
                if attr.startswith('{'):
                    if attr == '{http://www.w3.org/1999/xlink}href': attr = 'href'
                    else: continue
                if attr.lower().startswith('on'): raise ValueError('event attribute')
                if attr == 'id': value = ids[value]
                elif attr == 'class': value = ' '.join(key + '-' + item for item in value.split())
                elif attr == 'href':
                    if not value.startswith('#'): raise ValueError('external href')
                    value = '#' + ids[value[1:]]
                value = re.sub(r'url\(#([^)]*)\)', lambda m: 'url(#' + ids[m[1]] + ')', value)
                if re.search(r'url\((?!#)', value): raise ValueError('external URL')
                out.set(attr, value)
            out.text = node.text
            if local == 'style' and out.text:
                out.text = re.sub(r'\.([A-Za-z_][\w-]*)', lambda m: '.' + key + '-' + m[1], out.text)
                for old, new in sorted(ids.items(), key=lambda pair: -len(pair[0])):
                    out.text = out.text.replace('#' + old, '#' + new)
                if '@import' in out.text or re.search(r'url\((?!#)', out.text):
                    raise ValueError('external style')
            for child in node:
                result = clean(child)
                if result is not None: out.append(result)
            return out
        for child in source:
            result = clean(child)
            if result is not None: symbol.append(result)
# Original artwork, not a redraw of a KiCad icon: a split light/dark disc.
symbol = ET.SubElement(root, f'{{{SVG}}}symbol', {'id':'kr-theme', 'viewBox':'0 0 24 24'})
ET.SubElement(symbol, f'{{{SVG}}}circle', {'cx':'12','cy':'12','r':'8','fill':'none','stroke':'currentColor','stroke-width':'1.5'})
ET.SubElement(symbol, f'{{{SVG}}}path', {'d':'M12 4a8 8 0 0 1 0 16Z','fill':'currentColor'})
# Bench icon set (original artwork): stroke attributes inherit into each <use> shadow tree.
bench = ET.parse(HERE / 'bench.svg').getroot()
for node in bench:
    if node.tag != f'{{{SVG}}}symbol': continue
    node.set('fill', 'none'); node.set('stroke', 'currentColor')
    node.set('stroke-linecap', 'round'); node.set('stroke-linejoin', 'round')
    if 'stroke-width' not in node.attrib: node.set('stroke-width', '1.5')
    root.append(node)
serialized = ET.tostring(root, encoding='unicode')
serialized = serialized.replace(' xmlns="http://www.w3.org/2000/svg"', '', 1)
(HERE / 'sprite.svg').write_text(serialized + '\n', encoding='utf-8')
