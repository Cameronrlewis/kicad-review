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
import reviewJs from '../ui/review.js';
import review3d from '../ui/review3d.js';

const DATA = '<script>window.REVIEW_DATA = ';
const BUNDLE = /<script type="application\/octet-stream" id="three-bundle">[^<]*<\/script>/;
const assets = {
  'kicad-colors.js': kicadColors, 'appearance-state.js': appearanceState, 'board-gl.js': boardGl,
  'appearance.js': appearance, 'board-marks.js': boardMarks, 'board-diff.js': boardDiff,
};
// String.replace with a function: `$` sequences in the inserted code stay literal.
const put = (html, tag, text) => html.replace(tag, () => text);

// Returns the stored report rebuilt with the current interface, or null to serve it unchanged
// (no recognisable data script: a foreign or hand-edited file).
export function currentReport(stored) {
  const start = stored.indexOf(DATA);
  const end = start < 0 ? -1 : stored.indexOf('</script>', start);
  if (end < 0) return null;
  const data = stored.slice(start + '<script>'.length, end);   // payload escapes every "<", so no early </script>
  // 3D: reuse the stored three.js bundle (vendored library, same for every report).
  const bundle = data.includes('"model3d"') ? stored.match(BUNDLE)?.[0] : null;
  let html = put(page, '<link rel="stylesheet" href="tokens.css">\n<link rel="stylesheet" href="review.css">', `<style>\n${tokens}</style>\n<style>\n${review}</style>`);
  html = put(html, '<script src="sample/review-data.js"></script>', `<script>${data}</script>`);
  html = put(html, '<!-- KR_ICONS -->', sprite);
  html = put(html, '<script src="theme.js"></script>', `<script>\n${theme}</script>`);
  html = put(html, '<script src="review.js"></script>', `${bundle ? `${bundle}<script>\n${review3d}</script>` : ''}<script>\n${reviewJs}</script>`);
  for (const [name, text] of Object.entries(assets)) html = put(html, `<script src="${name}"></script>`, `<script>\n${text}</script>`);
  return html;
}

// Body for a fetched stored report: the current interface when the data is recognisable, else the file as stored.
export async function currentBody(response) {
  const stored = await response.text();
  return currentReport(stored) ?? stored;
}
