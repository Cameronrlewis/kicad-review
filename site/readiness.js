// Merge readiness derives from GitHub reviews and anchored review threads.
import { LIST_QUERY, parseThreads, refused, accessFailure, sessionResponse } from './threads.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export function latestDecisions(reviews, head) {
  const latest = new Map();
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state) || !r.user?.login) continue;
    latest.set(r.user.login, r);
  }
  return [...latest.values()].filter((r) => r.state !== 'DISMISSED')
    .map((r) => ({ login: r.user.login, state: r.state, stale: r.commit_id !== head }))
    .sort((a, b) => a.login.localeCompare(b.login));
}

export async function readinessRoute(request, env, { owner, repo, number }, { access, gh }) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return accessFailure(allowed);
  const result = await (async () => {
    const token = allowed.s.token, root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const [pull, reviews, threads] = await Promise.all([
      gh(`${root}/pulls/${number}`, token),
      gh(`${root}/pulls/${number}/reviews?per_page=100`, token), // ponytail: first 100 reviews; paginate if reviews exceed this ceiling.
      gh('/graphql', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: LIST_QUERY, variables: { owner, name: repo, number } }) }).catch(() => null),
    ]);
    const denied = (pull.status === 403 && refused(pull)) || (reviews.status === 403 && refused(reviews));
    if (denied) return denied;
    if (pull.status === 404 || reviews.status === 404) return json({ error: 'Pull request not found.' }, 404);
    if (!pull.ok || !reviews.ok) return json({ error: 'GitHub did not answer. Try again.' }, 502);
    const pr = await pull.json(), head = pr.head?.sha || null;
    if (!head) return json({ error: 'GitHub did not answer. Try again.' }, 502);
    const body = threads?.ok ? await threads.json().catch(() => null) : null;
    const reviewThreads = body?.data?.repository?.pullRequest?.reviewThreads;
    const nodes = reviewThreads?.nodes;
    // Missing data and GraphQL errors are unreadable, never an empty successful list.
    let list = null;
    if (body && !body.errors?.length && Array.isArray(nodes) && !(reviewThreads.totalCount > nodes.length)) {
      try { list = parseThreads(body).filter((t) => !t.resolved); } catch { /* unreadable */ }
    }
    return json({
      head, decisions: latestDecisions(await reviews.json(), head),
      requested: (pr.requested_reviewers || []).map((u) => u.login),
      blocking: list ? list.filter((t) => t.anchor.severity === 'blocking').length : null,
      open: list ? list.length : null,
    });
  })().catch(() => json({ error: 'GitHub did not answer. Try again.' }, 502));
  return sessionResponse(result, allowed);
}

export async function rerunRoute(request, env, { owner, repo, number }, { access, gh }) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'Send JSON' }, 415);
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return accessFailure(allowed);
  const result = await (async () => {
    const token = allowed.s.token, root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const pull = await gh(`${root}/pulls/${number}`, token);
    if (pull.status === 403) return refused(pull);
    if (!pull.ok) return json({ error: pull.status === 404 ? 'Pull request not found.' : 'GitHub did not answer. Try again.' }, pull.status === 404 ? 404 : 502);
    const head = (await pull.json()).head?.sha;
    if (!head) return json({ error: 'Pull request head not found.' }, 404);
    // ponytail: caller file must be kicad-review.yml (README setup); look up the workflow from the run if callers rename it.
    const runs = await gh(`${root}/actions/workflows/kicad-review.yml/runs?${new URLSearchParams({ head_sha: head, event: 'pull_request', per_page: '100' })}`, token);
    if (runs.status === 403) return refused(runs);
    if (!runs.ok) return json({ error: runs.status === 404 ? 'No review run for the current head yet.' : 'GitHub did not answer. Try again.' }, runs.status === 404 ? 404 : 502);
    const body = await runs.json();
    // Fail closed when the latest matching run might lie outside this page.
    if (body.total_count > 100) return json({ error: 'Too many review runs to identify the latest safely.' }, 502);
    const candidates = (body.workflow_runs || []).filter((r) => Number.isSafeInteger(r.id) && r.id > 0 && r.head_sha === head && r.event === 'pull_request'
      && r.repository?.full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase()
      && (r.pull_requests?.length ? r.pull_requests.some((pr) => pr.number === number) : r.head_repository?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()));
    const run = candidates.sort((a, b) => b.id - a.id)[0];
    if (!run) return json({ error: 'No review run for the current head yet.' }, 404);
    const rerun = await gh(`${root}/actions/runs/${run.id}/rerun`, token, { method: 'POST' });
    if (rerun.status === 403) {
      if (rerun.headers.get('x-ratelimit-remaining') === '0' || rerun.headers.has('retry-after')) return refused(rerun);
      const message = (await rerun.json().catch(() => ({}))).message;
      return json({ error: /not completed|older than/i.test(message || '') ? message : 'Re-running needs write access to this repository.' }, 403);
    }
    return rerun.ok ? json({ ok: true, run: run.id }, 201) : json({ error: 'GitHub did not re-run the review.' }, 502);
  })().catch(() => json({ error: 'GitHub did not answer. Try again.' }, 502));
  return sessionResponse(result, allowed);
}
