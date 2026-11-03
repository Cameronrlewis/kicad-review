// Re-dress a stored review report in the interface this site was deployed with.
// A report artifact is one HTML file: the interface code of the run that built it plus
// `window.REVIEW_DATA = {...};`. The site keeps the stored data and swaps in the current
// interface, so every review gets today's interface. Mirrors kicad_review.py inline_page().
import page from '../ui/review.html';
import tokens from '../ui/tokens.css';
import review from '../ui/review.css';
import theme from '../ui/theme.js';
import sprite from '../ui/icons/sprite.svg';
import kicadColors from '../ui/kicad-colors.js';
import appearanceState from '../ui/appearance-state.js';
import boardGl from '../ui/board-gl.js';
import appearance from '../ui/appearance.js';
import boardMarks from '../ui/board-marks.js';
import boardDiff from '../ui/board-diff.js';
import imageView from '../ui/image-view.js';
import reviewJs from '../ui/review.js';
import review3d from '../ui/review3d.js';
import threeParts from '../ui/three-parts.js';
import threeStudio from '../ui/three-studio.js';
import workerSource from '../ui/three-decode.js';

const workerTag = '<script type="application/octet-stream" id="three-decode-worker">'
  + btoa(String.fromCharCode(...new TextEncoder().encode(workerSource))) + '</script>';

const DATA = '<script>window.REVIEW_DATA = ';
const BUNDLE = /<script type="application\/octet-stream" id="three-bundle">[^<]*<\/script>/;
const assets = {
  'kicad-colors.js': kicadColors, 'appearance-state.js': appearanceState, 'board-gl.js': boardGl,
  'appearance.js': appearance, 'board-marks.js': boardMarks, 'board-diff.js': boardDiff, 'three-studio.js': threeStudio, 'image-view.js': imageView,
};
// String.replace with a function: `$` sequences in the inserted code stay literal.
const put = (html, tag, text) => html.replace(tag, () => text);

// Parse only the producer's JSON envelope, never execute stored report code.
export function readStoredData(html) {
  const start = html.indexOf(DATA), end = start < 0 ? -1 : html.indexOf('</script>', start);
  if (end < 0) return null;
  try {
    const value = JSON.parse(html.slice(start + DATA.length, end).trim().replace(/;$/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function declaredAssets(data) {
  const result = Object.create(null);
  for (const [id, meta] of Object.entries(data?.assets || {})) {
    if (/^[0-9a-f]{12}$/.test(id) && ['svg', 'json'].includes(meta?.kind)
      && typeof data?.blobs?.[id] === 'string') result[id] = { kind: meta.kind };
  }
  return result;
}

// Authenticated lazy shell: drop model/index payloads that have a valid same-run asset
// descriptor and no other consumer. Blob IDs in model3d/parts3d stay unchanged; 01's
// image/hotspot and poster blobs are kept because something other than those slots names them.
export function lazy3dData(input) {
  // Deliberate deviation from structuredClone(input): deep clone everything but the blob payloads,
  // which are strings (a shallow copy is independent), so multi-MB base64 is never copied.
  const data = structuredClone({ ...input, blobs: undefined }); data.blobs = { ...input.blobs };
  const valid = (a, kind) => a && /^[0-9a-f]{64}$/.test(a.digest)
    && a.artifactName === `kicad-3d-${a.digest}-${kind}.gz` && Number.isFinite(a.bytes) && a.bytes > 0;
  const candidates = new Set(), removable = [];
  for (const p of Array.isArray(data.projects) ? data.projects : []) for (const side of ['base', 'head']) {
    const b = p?.board; if (!b) continue;
    for (const [field, key, kind] of [['model3d', 'model', 'board.glb'], ['parts3d', 'parts', 'board-parts.json']]) {
      const id = b[field]?.[side];
      if (typeof id === 'string' && valid(b.assets3d?.[side]?.[key], kind)) {
        candidates.add(id); removable.push([b[field], side, id]); b[field][side] = null;
      }
    }
  }
  const used = new Set();
  const walk = o => {
    if (typeof o === 'string') used.add(o);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  for (const [key, value] of Object.entries(data)) if (key !== 'blobs') walk(value);
  for (const [object, key, id] of removable) object[key] = id;
  for (const id of candidates) if (!used.has(id)) delete data.blobs[id];
  return data;
}

// Returns the stored report rebuilt with the current interface, or null to serve it unchanged
// (no recognisable data script: a foreign or hand-edited file). Offline, guest and share
// callers keep every embedded blob; only the authenticated wrapper opts in to lazy stripping.
export function currentReport(stored, { lazyAssets = false, lazy3d = false, storedData } = {}) {
  const start = stored.indexOf(DATA);
  const end = start < 0 ? -1 : stored.indexOf('</script>', start);
  if (end < 0) return null;
  let data = stored.slice(start + '<script>'.length, end);   // payload escapes every "<", so no early </script>
  if (lazyAssets || lazy3d) {
    const original = storedData === undefined ? readStoredData(stored) : storedData;
    if (!original) return null;
    // Keep cached blobs intact for subsequent authenticated asset requests.
    const payload = lazy3d ? lazy3dData(original) : { ...original, blobs: { ...original.blobs } };
    if (lazyAssets) for (const id of Object.keys(declaredAssets(payload))) delete payload.blobs[id];
    if (Object.keys(payload.blobs).length !== Object.keys(original.blobs || {}).length)
      data = `window.REVIEW_DATA = ${JSON.stringify(payload).replace(/</g, '\\u003c')};`;
  }
  // 3D: reuse the stored three.js bundle (vendored library, same for every report).
  const bundle = data.includes('"model3d"') ? stored.match(BUNDLE)?.[0] : null;
  let html = put(page, '<link rel="stylesheet" href="tokens.css">\n<link rel="stylesheet" href="review.css">', `<style>\n${tokens}</style>\n<style>\n${review}</style>`);
  html = put(html, '<script src="sample/review-data.js"></script>', `<script>${data}</script>`);
  html = put(html, '<!-- KR_ICONS -->', sprite);
  html = put(html, '<script src="theme.js"></script>', `<script>\n${theme}</script>`);
  html = put(html, '<script src="review.js"></script>', `${bundle ? `${bundle}${workerTag}<script>\n${threeParts}</script><script>\n${review3d}</script>` : ''}<script>\n${reviewJs}</script>`);
  for (const [name, text] of Object.entries(assets)) html = put(html, `<script src="${name}"></script>`, `<script>\n${text}</script>`);
  return html;
}

// Body for a fetched stored report: the current interface when the data is recognisable, else the file as stored.
export async function currentBody(response, options) {
  const stored = await response.text();
  return currentReport(stored, options) ?? stored;
}
