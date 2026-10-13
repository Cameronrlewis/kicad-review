// Anchored GitHub issues share the review-thread marker; GitHub remains the store.
import { parseAnchor, threadBody, validAnchor } from './threads.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const positive = n => Number.isSafeInteger(n) && n > 0;
const issueURL = (url, number, owner, repo) => {
  try {
    const u = new URL(url);
    return u.origin === 'https://github.com' && !u.username && !u.password && !u.search && !u.hash && u.pathname.endsWith(`/issues/${number}`)
      && (owner ? u.pathname.toLowerCase() === `/${owner}/${repo}/issues/${number}`.toLowerCase() : /^\/[^/]+\/[^/]+\/issues\/\d+$/.test(u.pathname));
  } catch { return false; }
};

export function parseIssues(list, owner, repo) {
  return (Array.isArray(list) ? list : []).flatMap(i => {
    if (!i || 'pull_request' in Object(i) || i.state && i.state !== 'open' || !positive(i.number) || !issueURL(i.html_url, i.number, owner, repo)) return [];
    const anchor = parseAnchor(i.body);
    return anchor ? [{ number: i.number, title: String(i.title || ''), url: i.html_url, anchor, state: 'open' }] : [];
  }).slice(0, 100);
}

const permissionHint = "Issues need the app's Issues permission (read and write). Ask the repository owner to add it and accept it on this installation.";
function refused(response) {
  if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) return json({ error: 'GitHub rate limit reached. Try again later.' }, 429);
  if (response.status === 403) return json({ error: permissionHint }, 403);
  if (response.status === 410) return json({ error: 'Issues are turned off for this repository.' }, 410);
  return null;
}

export async function issuesRoute(request, env, { owner, repo, rest }, { access, gh }) {
  const url = new URL(request.url);
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'Send JSON' }, 415);
  }
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) {
    const result = json({ error: allowed.status === 302 ? 'Sign in again.' : "Can't open this repository." }, allowed.status === 302 ? 401 : allowed.status);
    if (allowed.headers.has('Set-Cookie')) result.headers.set('Set-Cookie', allowed.headers.get('Set-Cookie'));
    return result;
  }
  const result = await (async () => {
    if (rest !== '') return json({ error: 'Not found' }, 404);
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token = allowed.s.token;
    if (request.method === 'GET') {
      // ponytail: first 100 open issues; paginate if a repository ever anchors more.
      const response = await gh(`${root}/issues?state=open&per_page=100`, token);
      const denied = refused(response); if (denied) return denied;
      if (!response.ok) return json({ error: 'GitHub did not load issues. Try again.' }, 502);
      const list = await response.json();
      if (!Array.isArray(list)) return json({ error: 'GitHub did not load issues. Try again.' }, 502);
      return json({ issues: parseIssues(list, owner, repo) });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Send JSON' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Send a JSON object.' }, 400);
    const title = typeof body.title === 'string' ? body.title.trim() : '', text = typeof body.text === 'string' ? body.text.trim() : '';
    const prefix = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/a/`;
    let link;
    try { link = new URL(body.link, url.origin); } catch { /* invalid link below */ }
    if (!validAnchor(body.anchor) || !title || title.length > 256 || typeof body.text !== 'string' || text.length > 10000
      || typeof body.link !== 'string' || !body.link.startsWith(prefix) || body.link.length > 2000
      || !link || link.origin !== url.origin || !link.pathname.startsWith(prefix) || !/^\d{1,20}(?:#.*)?$/.test(body.link.slice(prefix.length))
      || body.pull != null && !positive(body.pull) || body.threadCommentId != null && (!positive(body.threadCommentId) || !positive(body.pull))) return json({ error: 'That issue is not valid.' }, 400);
    const pr = positive(body.pull) ? `\n\nPull request: https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${body.pull}` : '';
    const created = await gh(`${root}/issues`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: threadBody({ anchor: body.anchor, text: (text || title) + pr, link: url.origin + body.link }) }) });
    const denied = refused(created); if (denied) return denied;
    if (!created.ok) return json({ error: 'GitHub did not create the issue.' }, created.status === 422 ? 422 : 502);
    const issue = await created.json();
    if (!positive(issue.number) || !issueURL(issue.html_url, issue.number, owner, repo)) return json({ error: 'GitHub returned an invalid issue.' }, 502);
    let warning;
    if (positive(body.threadCommentId)) {
      try {
        const reply = await gh(`${root}/pulls/${body.pull}/comments/${body.threadCommentId}/replies`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `Tracked in #${issue.number}.` }) });
        if (!reply.ok) warning = `Issue #${issue.number} was created, but GitHub did not add the thread reply. Open the issue; do not create it again.`;
      } catch { warning = `Issue #${issue.number} was created, but GitHub did not add the thread reply. Open the issue; do not create it again.`; }
    }
    return json({ number: issue.number, url: issue.html_url, ...(warning ? { warning } : {}) }, 201);
  })().catch(() => json({ error: 'GitHub did not answer. Try again.' }, 502));
  if (allowed.s.setCookie) result.headers.set('Set-Cookie', allowed.s.setCookie);
  return result;
}
