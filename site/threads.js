// Review-site threads: GitHub pull-request review comments that carry a KiCad anchor.
const MARKER = /<!-- kicad-review-anchor ([A-Za-z0-9_-]+) -->[ \t\r\n]*$/;
const KEYS = ['v', 'project', 'file', 'sheet', 'layer', 'target', 'uuid', 'kind', 'ref', 'x', 'y', 'side', 'commit', 'severity'];

const toB64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const fromB64 = (value) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)));

export function encodeAnchor(anchor) { return toB64(JSON.stringify(anchor)); }

export function parseAnchor(body) {
  const match = MARKER.exec(String(body || ''));
  if (!match) return null;
  try {
    const anchor = JSON.parse(fromB64(match[1]));
    return validAnchor(anchor) ? anchor : null;
  } catch { return null; }
}

const str = (value, max) => value === null || (typeof value === 'string' && value.length <= max);
export function validAnchor(a) {
  return !!a && typeof a === 'object' && Object.keys(a).every((k) => KEYS.includes(k))
    && Object.values(a).every((value) => typeof value !== 'string' || !/[\r\n]/.test(value)) && a.v === 1
    && typeof a.project === 'string' && a.project.length <= 500
    && typeof a.file === 'string' && /^[^\0\r\n<>`]{1,500}\.kicad_(sch|pcb)$/.test(a.file) && !a.file.split('/').includes('..') && !a.file.startsWith('/')
    && str(a.sheet, 2000) && str(a.layer, 100) && ['object', 'point'].includes(a.target)
    && str(a.uuid, 100) && str(a.kind, 50) && str(a.ref, 200)
    && Number.isFinite(a.x) && Number.isFinite(a.y) && ['head', 'base'].includes(a.side)
    && typeof a.commit === 'string' && /^[0-9a-f]{40}$/.test(a.commit) && ['comment', 'blocking'].includes(a.severity)
    && (a.target === 'point' || typeof a.uuid === 'string');
}

const mdText = (value) => String(value).replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]()<>#|!~]/g, '\\$&').replace(/@/g, '@\u200b');

export function threadBody({ anchor, text, link }) {
  const where = [`📍 ${mdText(anchor.ref || 'point')}`, `\`${anchor.file.replaceAll('`', "'")}\``, anchor.layer && mdText(anchor.layer),
    `(${anchor.x.toFixed(2)}, ${anchor.y.toFixed(2)}) mm`, `[open in review](${link.replace(/[ ()<>`\\\r\n]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))})`].filter(Boolean).join(' · ');
  return `${anchor.severity === 'blocking' ? '**Blocking** · ' : ''}${where}\n\n${text}\n\n<!-- kicad-review-anchor ${encodeAnchor(anchor)} -->`;
}

export function threadText(body) {
  const text = String(body || '');
  const match = MARKER.exec(text);
  if (!match) return text;
  const content = text.slice(0, match.index);
  const separator = content.indexOf('\n\n');
  return separator === -1 ? content.trimEnd() : content.slice(separator + 2).replace(/\n\n$/, '');
}

export function parseThreads(graphql) {
  const nodes = graphql?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  return nodes.flatMap((node) => {
    const comments = node.comments?.nodes || [];
    const anchor = parseAnchor(comments[0]?.body);
    if (!anchor) return [];
    return [{ id: String(node.id), resolved: !!node.isResolved, resolvedBy: node.resolvedBy?.login || null, anchor,
      comments: comments.map((c) => ({ id: c.databaseId, author: c.author?.login || 'ghost', body: threadText(c.body), createdAt: c.createdAt || '', url: c.url || '' })) }];
  });
}

// ponytail: first 100 threads and 50 comments each; paginate if a review ever needs more.
export const LIST_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100){nodes{id isResolved resolvedBy{login} comments(first:50){nodes{databaseId body author{login} createdAt url}}}}}}}';
export const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
export const UNRESOLVE_MUTATION = 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
