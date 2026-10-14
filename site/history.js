// A PR timeline built on demand from GitHub; no event store.
import { parseAnchor } from './threads.js';

// ponytail: last 100 commits/reviews, first 100 threads and first 100 comments; paginate if needed.
export const HISTORY_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){title '
  + 'commits(last:100){nodes{commit{oid messageHeadline committedDate author{user{login} name}}}} '
  + 'reviews(last:100){nodes{author{login} state submittedAt commit{oid}}} '
  + 'reviewThreads(first:100){nodes{isResolved resolvedBy{login} comments(first:1){nodes{author{login} createdAt body}}}} '
  + 'comments(first:100){nodes{author{login} body}}}}}';

const LOG_ROW = /^\| \[(\d{4}-\d\d-\d\d \d\d:\d\d)\]\(https:\/\/[^)]*\/actions\/runs\/(\d+)\) \| `([0-9a-f]{7})` \| (✅ pass|❌ fail) \| (.*) \|$/;

export function historyEvents(graphql, artifacts = [], path = '', artifactName = /^$/) {
  const pr = graphql?.data?.repository?.pullRequest || {};
  const byRun = new Map(artifacts.filter(a => !a.expired && artifactName.test(a.name || '') && /^\d+$/.test(String(a.id))).map(a => [String(a.workflow_run?.id), a.id]));
  const events = [];
  for (const { commit } of pr.commits?.nodes || []) {
    events.push({ time: commit.committedDate, kind: 'commit', text: `Pushed ${commit.oid.slice(0, 7)}: ${commit.messageHeadline}`, who: commit.author?.user?.login || commit.author?.name || 'ghost', href: null });
  }
  for (const r of pr.reviews?.nodes || []) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    events.push({ time: r.submittedAt, kind: 'review', text: `${{ APPROVED: 'Approved', CHANGES_REQUESTED: 'Requested changes', DISMISSED: 'Review dismissed' }[r.state]} at ${String(r.commit?.oid || '').slice(0, 7)}`, who: r.author?.login || 'ghost', href: null });
  }
  for (const t of pr.reviewThreads?.nodes || []) {
    const first = t.comments?.nodes?.[0], anchor = parseAnchor(first?.body);
    if (!anchor) continue;
    events.push({ time: first.createdAt, kind: 'thread', who: first.author?.login || 'ghost', href: null,
      text: `${anchor.severity === 'blocking' ? 'Blocking thread' : 'Thread'} on ${anchor.ref || 'a point'}${t.isResolved ? ` (resolved by ${t.resolvedBy?.login || 'ghost'})` : ''}` });
  }
  const bot = (pr.comments?.nodes || []).find(c => c.author?.login === 'github-actions' && String(c.body).startsWith('<!-- kicad-review -->'));
  const body = String(bot?.body || ''), start = body.indexOf('<!-- kicad-review-log -->'), end = body.indexOf('<!-- /kicad-review-log -->');
  for (const line of (start >= 0 && end > start ? body.slice(start, end) : '').split('\n')) {
    const m = LOG_ROW.exec(line.trim());
    if (m) events.push({ time: `${m[1].replace(' ', 'T')}:00Z`, kind: 'checks', who: 'kicad-review', text: `${m[4]} at ${m[3]}: ${m[5].trim().replace(/\\\|/g, '|')}`,
      href: path && byRun.has(m[2]) ? `${path}/a/${byRun.get(m[2])}` : null });
  }
  return events.filter(e => e.time).sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

export async function historyRoute(request, env, { owner, repo, number }, { access, gh, historyPage, sessionResponse, errorPage, artifactName }) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const fail = (status, message) => errorPage(status, 'Could not load history', message, [], allowed.s);
  const hint = "History needs the app's Pull requests and Contents permissions. Ask the repository owner to accept them.";
  try {
    const token = allowed.s.token, path = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const timeline = await gh('/graphql', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: HISTORY_QUERY, variables: { owner, name: repo, number } }) });
    if (timeline.status === 429 || (timeline.status === 403 && (timeline.headers.get('x-ratelimit-remaining') === '0' || timeline.headers.has('retry-after')))) return fail(429, 'GitHub rate limit reached. Try again later.');
    if (timeline.status === 403) return fail(403, hint);
    if (!timeline.ok) return fail(502, 'GitHub did not answer. Try again.');
    const data = await timeline.json();
    if (data.errors?.length) {
      if (data.errors.some(e => e.type === 'RATE_LIMITED')) return fail(429, 'GitHub rate limit reached. Try again later.');
      const forbidden = data.errors.some(e => e.type === 'FORBIDDEN');
      return fail(forbidden ? 403 : 502, forbidden ? hint : 'GitHub did not answer. Try again.');
    }
    let artifacts = [];
    try {
      const response = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts?per_page=100`, token);
      if (response.ok) artifacts = (await response.json()).artifacts || [];
    } catch { /* Artifacts only add links; keep the durable timeline when unavailable. */ }
    const events = historyEvents(data, artifacts, path, artifactName);
    return sessionResponse(historyPage({ user: allowed.s.login, owner, repo, pull: number, title: data?.data?.repository?.pullRequest?.title || `#${number}`, events, filter: new URL(request.url).searchParams.get('f') || 'all' }),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  } catch { return fail(502, 'GitHub did not answer. Try again.'); }
}
