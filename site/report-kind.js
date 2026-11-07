// Shared report-family verifier for comparison reports and design snapshots.
// Comparison names are accepted exactly as before; design names must bind their
// 7-hex suffix to the full 40-character head SHA from data.report.head.
export const reviewName = /^kicad-review-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail)\.html$/;
export const reviewListName = /^kicad-review(?:-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail))?\.html$/;
const design = /^kicad-design-(?:([0-9a-f]{7})(?:\.html|\.context\.json)|downloads-([0-9a-f]{7}))$/;

export function verifyReportFamily(kind, name, headSha) {
  if (kind === 'comparison') return reviewName.test(String(name));
  const match = kind === 'design' && design.exec(String(name));
  return Boolean(match) && typeof headSha === 'string' && /^[0-9a-f]{40}$/.test(headSha)
    && headSha.slice(0, 7) === (match[1] || match[2]);
}
