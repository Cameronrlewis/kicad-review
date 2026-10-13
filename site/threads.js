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

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const permissionHint = "Threads need the app's Pull requests permission. Ask the repository owner to accept it.";

function refused(response) {
  if (response.status === 403) return json({ error: permissionHint }, 403);
  if (response.status === 422) return json({ error: 'GitHub refused this thread. The file may not be part of this pull request.' }, 422);
  return null;
}

export async function threadsRoute(request, env, { owner, repo, number, rest }, { access, gh }) {
  const url = new URL(request.url);
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
    if (!String(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'Send JSON' }, 415);
  }
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const token = allowed.s.token, root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const graphql = (query, variables) => gh('/graphql', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch { return json({ error: 'Send JSON' }, 400); } }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (request.method === 'GET') {
    if (rest !== '') return json({ error: 'Not found' }, 404);
    const response = await graphql(LIST_QUERY, { owner, name: repo, number });
    const denied = refused(response); if (denied) return denied;
    if (!response.ok) return json({ error: 'GitHub did not answer. Try again.' }, 502);
    const data = await response.json();
    return json({ threads: parseThreads(data), head: data?.data?.repository?.pullRequest?.headRefOid || null });
  }
  if (rest === '') {
    const prefix = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/a/`;
    if (!validAnchor(body.anchor) || !text || text.length > 10000 || typeof body.link !== 'string' || !body.link.startsWith(prefix) || body.link.length > 2000) return json({ error: 'That thread is not valid.' }, 400);
    const pull = await gh(`${root}/pulls/${number}`, token);
    const denied = refused(pull); if (denied) return denied;
    if (!pull.ok) return json({ error: 'Pull request not found.' }, 404);
    const head = (await pull.json()).head?.sha;
    const created = await gh(`${root}/pulls/${number}/comments`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: threadBody({ anchor: body.anchor, text, link: url.origin + body.link }), commit_id: head, path: body.anchor.file, subject_type: 'file' }) });
    return refused(created) || (created.ok ? json({ ok: true }, 201) : json({ error: 'GitHub did not create the thread.' }, 502));
  }
  const reply = /^\/(\d{1,20})\/reply$/.exec(rest);
  if (reply) {
    if (!text || text.length > 10000) return json({ error: 'Write a reply first.' }, 400);
    const created = await gh(`${root}/pulls/${number}/comments/${reply[1]}/replies`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) });
    return refused(created) || (created.ok ? json({ ok: true }, 201) : json({ error: 'GitHub did not add the reply.' }, 502));
  }
  const resolve = /^\/([A-Za-z0-9_=-]{1,100})\/(resolve|unresolve)$/.exec(rest);
  if (resolve) {
    const response = await graphql(resolve[2] === 'resolve' ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { id: resolve[1] });
    return refused(response) || (response.ok ? json({ ok: true }) : json({ error: 'GitHub did not change the thread.' }, 502));
  }
  return json({ error: 'Not found' }, 404);
}
