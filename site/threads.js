// Review-site threads: GitHub pull-request review comments that carry a KiCad anchor.
import { encode, decode } from './b64.js';
const MARKER = /<!-- kicad-review-anchor ([A-Za-z0-9_-]+) -->[ \t\r\n]*$/;
const KEYS = ['v', 'project', 'file', 'sheet', 'layer', 'target', 'uuid', 'kind', 'ref', 'x', 'y', 'side', 'commit', 'severity'];

const toB64 = (text) => encode(new TextEncoder().encode(text));
const fromB64 = (value) => new TextDecoder('utf-8', { fatal: true }).decode(decode(value));

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
  return `${anchor.severity === 'blocking' ? '**Blocking** · ' : ''}${where}\n\n${String(text).replaceAll('<!-- kicad-review-anchor', '<!-- kicad-review\u200b-anchor')}\n\n<!-- kicad-review-anchor ${encodeAnchor(anchor)} -->`;
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

// ponytail: cursor-paginate threads and comments up to 10 pages each; fail closed if truncated.
export const LIST_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id isResolved resolvedBy{login} comments(first:50){totalCount pageInfo{hasNextPage endCursor} nodes{databaseId body author{login} createdAt url}}}}}}}';
// One request per paging round: alias tN asks for the next comment page of thread $iN after cursor $aN.
export const commentsQuery = (count) => {
  const ids = Array.from({ length: count }, (_, i) => i);
  return `query(${ids.map(i => `$i${i}:ID!,$a${i}:String!`).join(',')}){${ids.map(i => `t${i}:node(id:$i${i}){... on PullRequestReviewThread{comments(first:100,after:$a${i}){totalCount pageInfo{hasNextPage endCursor} nodes{databaseId body author{login} createdAt url}}}}`).join(' ')}}`;
};
// Node IDs are global: check the thread's repository and pull request before mutating it.
export const SCOPE_QUERY = 'query($id:ID!){node(id:$id){... on PullRequestReviewThread{repository{name owner{login}} pullRequest{number}}}}';
export const threadMutation = (op) => `mutation($id:ID!){${op}ReviewThread(input:{threadId:$id}){thread{isResolved}}}`;

// Shared bounded pagination helper for GitHub REST list endpoints (100 items/page, default max 10 pages).
// Bound hit: ok is false (callers that need a complete scan fail closed); items holds the pages read.
export async function ghPages(ghFn, path, token, extract = x => x, maxPages = 10) {
  const sep = path.includes('?') ? '&' : '?';
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const suffix = page === 1 ? 'per_page=100' : `per_page=100&page=${page}`;
    const response = await ghFn(`${path}${sep}${suffix}`, token);
    if (!response.ok) return { ok: false, response };
    const rows = extract(await response.json());
    if (!Array.isArray(rows)) return { ok: false, response };
    items.push(...rows);
    if (rows.length < 100) return { ok: true, items };
  }
  return { ok: false, overflow: true, items };
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const permissionHint = "Threads need the app's Pull requests and Contents permissions (read and write). Ask the repository owner to accept them.";

export function refused(response) {
  if (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) return json({ error: 'GitHub rate limit reached. Try again later.' }, 429);
  if (response.status === 403) return json({ error: permissionHint }, 403);
  if (response.status === 422) return json({ error: 'GitHub refused this thread. The file may not be part of this pull request.' }, 422);
  return null;
}

export function accessFailure(allowed) {
  const result = json({ error: allowed.status === 302 ? 'Sign in again.' : "Can't open this repository." }, allowed.status === 302 ? 401 : allowed.status);
  if (allowed.headers.has('Set-Cookie')) result.headers.set('Set-Cookie', allowed.headers.get('Set-Cookie'));
  return result;
}

export function sessionResponse(result, allowed) {
  if (allowed.s.setCookie) result.headers.set('Set-Cookie', allowed.s.setCookie);
  return result;
}

export async function graphqlQuery(gh, token, query, variables) {
  const response = await gh('/graphql', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }).catch(() => null);
  if (!response) return json({ error: 'GitHub did not answer. Try again.' }, 502);
  const denied = refused(response); if (denied) return denied;
  if (!response.ok) return json({ error: 'GitHub did not answer. Try again.' }, 502);
  const data = await response.json().catch(() => null);
  if (!data) return json({ error: 'GitHub did not answer. Try again.' }, 502);
  const forbidden = data.errors?.some(error => error?.type === 'FORBIDDEN');
  if (data.errors?.length) return json({ error: forbidden ? permissionHint : 'GitHub did not answer. Try again.' }, forbidden ? 403 : 502);
  return data;
}

export async function loadReviewThreads(gh, token, { owner, repo, name = repo, number }, initial = null) {
  const nodes = [];
  let head = null, after, present = false;
  for (let page = 1; ; page++) {
    let data;
    if (page === 1 && initial !== null) {
      if (initial instanceof Response) {
        const denied = refused(initial); if (denied) return denied;
        if (!initial.ok) return json({ error: 'GitHub did not answer. Try again.' }, 502);
        data = await initial.json().catch(() => null);
        if (!data) return json({ error: 'GitHub did not answer. Try again.' }, 502);
      } else {
        data = initial;
      }
      const forbidden = data?.errors?.some(error => error?.type === 'FORBIDDEN');
      if (data?.errors?.length) return json({ error: forbidden ? permissionHint : 'GitHub did not answer. Try again.' }, forbidden ? 403 : 502);
    } else {
      data = await graphqlQuery(gh, token, LIST_QUERY, { owner, name, number, ...(after ? { after } : {}) });
      if (data instanceof Response) return data;
    }
    const pr = data?.data?.repository?.pullRequest;
    if (page === 1) head = pr?.headRefOid || null;
    const rt = pr?.reviewThreads;
    if (!Array.isArray(rt?.nodes)) {
      if (page === 1) break;
      return json({ error: 'GitHub did not answer. Try again.' }, 502);
    }
    present = true;
    nodes.push(...rt.nodes);
    const more = rt.pageInfo?.hasNextPage || (rt.totalCount > nodes.length && Boolean(rt.pageInfo?.endCursor));
    if (!more) {
      if (rt.totalCount > nodes.length) return json({ error: 'GitHub did not answer. Try again.' }, 502);
      break;
    }
    if (page >= 10 || !rt.pageInfo?.endCursor) return json({ error: 'GitHub did not answer. Try again.' }, 502);
    after = rt.pageInfo.endCursor;
  }
  return { ok: true, nodes, head, present };
}

export const validComments = c => Array.isArray(c?.nodes) && Number.isInteger(c.totalCount) && c.totalCount >= 0
  && typeof c.pageInfo?.hasNextPage === 'boolean' && (!c.pageInfo.hasNextPage || typeof c.pageInfo.endCursor === 'string');

// Reads every anchored thread's later comment pages into node.comments, one aliased request per round.
// Returns null when complete, or the error Response (GitHub failure or the 10-round bound).
export async function loadThreadComments(gh, token, nodes) {
  let pending = [];
  for (const node of nodes) {
    const c = node?.comments;
    if (!validComments(c)) return json({ error: 'GitHub did not answer. Try again.' }, 502);
    if (!parseAnchor(c.nodes[0]?.body)) continue;
    if (c.pageInfo?.hasNextPage || c.totalCount > c.nodes.length) pending.push({ c, id: String(node.id), after: c.pageInfo?.endCursor });
  }
  for (let page = 1; pending.length; page++) {
    if (page >= 10 || pending.some(p => !p.after)) return json({ error: 'GitHub did not answer. Try again.' }, 502);
    const variables = Object.fromEntries(pending.flatMap((p, i) => [[`i${i}`, p.id], [`a${i}`, p.after]]));
    const extra = await graphqlQuery(gh, token, commentsQuery(pending.length), variables);
    if (extra instanceof Response) return extra;
    const more = [];
    for (const [i, p] of pending.entries()) {
      const next = extra?.data?.[`t${i}`]?.comments;
      if (!validComments(next)) return json({ error: 'GitHub did not answer. Try again.' }, 502);
      p.c.nodes.push(...next.nodes);
      if (next.pageInfo?.hasNextPage || next.totalCount > p.c.nodes.length) more.push({ ...p, after: next.pageInfo?.endCursor });
    }
    pending = more;
  }
  return null;
}

export async function threadsRoute(request, env, { owner, repo, number, rest }, { access, gh }) {
  const url = new URL(request.url);
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
    if (!String(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'Send JSON' }, 415);
  }
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return accessFailure(allowed);
  const result = await (async () => {
    const token = allowed.s.token, root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch { return json({ error: 'Send JSON' }, 400); } }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Send a JSON object.' }, 400);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (request.method === 'GET') {
      if (rest !== '') return json({ error: 'Not found' }, 404);
      const threadsResult = await loadReviewThreads(gh, token, { owner, repo, number });
      if (threadsResult instanceof Response) return threadsResult;
      const { nodes, head } = threadsResult;
      const failed = await loadThreadComments(gh, token, nodes);
      if (failed) return failed;
      return json({ threads: parseThreads({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }), head });
    }
    if (rest === '') {
      const prefix = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/a/`;
      if (!validAnchor(body.anchor) || !text || text.length > 10000 || typeof body.link !== 'string' || !body.link.startsWith(prefix) || body.link.length > 2000 || !/^\d{1,20}(?:#[\w\-.:/%=&]*)?$/.test(body.link.slice(prefix.length))) return json({ error: 'That thread is not valid.' }, 400);
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
      const scope = await graphqlQuery(gh, token, SCOPE_QUERY, { id: resolve[1] });
      if (scope instanceof Response) return scope;
      const node = scope?.data?.node, same = (a, b) => String(a || '').toLowerCase() === String(b).toLowerCase();
      const nodeOwner = node?.repository?.owner?.login, nodeRepo = node?.repository?.name;
      const matchPair = (same(nodeOwner, owner) && same(nodeRepo, repo))
        || (same(nodeOwner, allowed.repo?.owner?.login) && same(nodeRepo, allowed.repo?.name));
      if (!matchPair || node?.pullRequest?.number !== number) return json({ error: 'Thread not found.' }, 404);
      const response = await graphqlQuery(gh, token, threadMutation(resolve[2]), { id: resolve[1] });
      return response instanceof Response ? response : json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  })().catch(() => json({ error: 'GitHub did not answer. Try again.' }, 502));
  return sessionResponse(result, allowed);
}
