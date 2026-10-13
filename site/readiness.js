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
    const denied = refused(pull) || refused(reviews);
    if (denied) return denied;
    if (!pull.ok || !reviews.ok) return json({ error: 'GitHub did not answer. Try again.' }, 502);
    const pr = await pull.json(), head = pr.head?.sha || null;
    const body = threads?.ok ? await threads.json().catch(() => null) : null;
    const nodes = body?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    // Missing data and GraphQL errors are unreadable, never an empty successful list.
    let list = null;
    if (body && !body.errors?.length && Array.isArray(nodes)) {
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
