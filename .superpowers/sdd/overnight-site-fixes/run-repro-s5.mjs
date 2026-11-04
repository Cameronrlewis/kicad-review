import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const useBaseline = process.argv.includes('--baseline');
let prefix = path.resolve('site');
let cleanupDir = null;

if (useBaseline) {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-baseline-'));
  execFileSync('git', ['archive', '7a02f45', 'site'], {
    stdio: ['ignore', fs.openSync(path.join(cleanupDir, 'site.tar'), 'w'), 'inherit'],
  });
  execFileSync('tar', ['-xf', path.join(cleanupDir, 'site.tar'), '-C', cleanupDir]);
  // Symlink ui for report-shell
  fs.symlinkSync(path.resolve('ui'), path.join(cleanupDir, 'ui'));
  prefix = path.join(cleanupDir, 'site');
}

try {
  console.log(`Running against: ${useBaseline ? 'BASELINE 7a02f45 (pre-fix)' : 'CURRENT HEAD (post-fix)'}`);

  const env = { ALLOWED_OWNERS: 'Cameronrlewis', SESSION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const workerMod = await import(`${prefix}/worker.js`);
  const worker = workerMod.default;
  const seal = workerMod.seal;
  const readinessMod = await import(`${prefix}/readiness.js`);
  const threadsMod = await import(`${prefix}/threads.js`);
  const issuesMod = await import(`${prefix}/issues.js`);

  async function signedIn(overrides = {}) {
    return seal({ t: 'user-token', r: 'refresh-token', e: Date.now() + 3_600_000, re: Date.now() + 7_200_000, u: 'octocat', ...overrides }, env);
  }

  const anchor = { v: 1, project: 'Thermal_Camera', file: 'Thermal_Camera/Thermal_Camera.kicad_pcb', sheet: null, layer: 'F.Cu',
    target: 'object', uuid: '0a1b2c3d-0000-4000-8000-000000000001', kind: 'footprint', ref: 'R16', x: 12.3, y: 45.6,
    side: 'head', commit: 'a'.repeat(40), severity: 'blocking' };

  const threadBody = threadsMod.threadBody;

  const accessibleRepo = () => new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: true }, default_branch: 'main' }));
  const repoOk = accessibleRepo;

  const results = {};

  // Test 6: Finding 6 (completed run paginates artifacts past page 1 and rejects ambiguous reports)
  try {
    const sealed = await signedIn();
    const filler = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `kicad-3d-${String(i).padStart(64, '0')}-board.glb.gz`, expired: false, workflow_run: { id: 12 } }));
    const report = { id: 56, name: 'kicad-review-deadbee-cafebad-pass.html', created_at: '2026-10-12T00:00:00Z', expired: false, workflow_run: { id: 12 } };
    const pdf = { id: 57, name: 'kicad-review-deadbee-cafebad-pass.pdf', expired: false, workflow_run: { id: 12 } };
    let rows = [...filler, report, pdf];
    globalThis.fetch = async (url) => {
      url = String(url);
      if (url.endsWith('/repo')) return accessibleRepo();
      if (url.endsWith('/runs/12')) return Response.json({ status: 'completed', conclusion: 'success' });
      const m = /\/runs\/12\/artifacts(?:\?per_page=(\d+)(?:&page=(\d+))?)?$/.exec(url);
      if (m) {
        const perPage = Number(m[1] || 30), page = Number(m[2] || 1);
        return Response.json({ artifacts: rows.slice((page - 1) * perPage, page * perPage) });
      }
      throw new Error(`unexpected ${url}`);
    };

    const response = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(response.status, 302, `Expected status 302, got ${response.status}`);
    assert.equal(response.headers.get('Location'), '/r/Cameronrlewis/repo/a/56?pdf=1');

    // Ambiguous matching reports
    rows = [report, { ...report, id: 58, name: 'kicad-review-deadbee-cafebad-fail.html' }];
    const ambiguous = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(ambiguous.status, 404, `Expected status 404 for ambiguous reports, got ${ambiguous.status}`);
    results['finding 6'] = { status: 'PASS' };
  } catch (err) {
    results['finding 6'] = { status: 'FAIL', error: err.message };
  }

  // Test 7: Finding 7 (readiness paginates reviews past 100 before computing latest decisions)
  try {
    const sealed = await signedIn({ t: 'access-secret' });
    const head = 'n'.repeat(40);
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      user: { login: i === 49 ? 'ann' : `u${i}` },
      state: 'APPROVED',
      commit_id: head,
      submitted_at: `2026-10-12T10:${String(i).padStart(2, '0')}:00Z`,
    }));
    const page2 = [{ user: { login: 'ann' }, state: 'CHANGES_REQUESTED', commit_id: head, submitted_at: '2026-10-12T12:00:00Z' }];
    globalThis.fetch = async (url) => {
      url = String(url);
      if (url.endsWith('/repo')) return repoOk();
      if (url.endsWith('/pulls/7')) return Response.json({ head: { sha: head }, requested_reviewers: [] });
      const m = /\/pulls\/7\/reviews\?per_page=100(?:&page=(\d+))?$/.exec(url);
      if (m) return Response.json(Number(m[1] || 1) === 1 ? page1 : page2);
      if (url.endsWith('/graphql')) return Response.json({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } });
      throw new Error(`unexpected ${url}`);
    };

    const response = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/pull/7/readiness', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
    const body = await response.json();
    const ann = body.decisions.find(d => d.login === 'ann');
    assert.deepEqual(ann, { login: 'ann', state: 'CHANGES_REQUESTED', stale: false });
    results['finding 7'] = { status: 'PASS' };
  } catch (err) {
    results['finding 7'] = { status: 'FAIL', error: err.message };
  }

  // Test 10: Finding 10 (commit history links newest review when commit head was reviewed multiple times)
  try {
    const sealed = await signedIn();
    globalThis.fetch = async (url) => {
      url = String(url);
      if (url.endsWith('/repo')) return accessibleRepo();
      if (url.endsWith('/branches?per_page=100')) return Response.json([{ name: 'main' }]);
      if (url.endsWith('/tags?per_page=100')) return Response.json([]);
      if (url.includes('/commits?')) return Response.json([{ sha: 'cafebad000000000000000000000000000000000', commit: { message: 'Fix board', author: { name: 'Ada', date: '2026-10-12T04:05:00Z' } } }]);
      if (url.includes('/actions/artifacts?')) return Response.json({ artifacts: [
        { id: 10, name: 'kicad-review-deadbee-cafebad-fail.html', created_at: '2026-10-12T10:00:00Z', expired: false, workflow_run: { id: 1 } },
        { id: 20, name: 'kicad-review-deadbee-cafebad-pass.html', created_at: '2026-10-12T11:00:00Z', expired: false, workflow_run: { id: 2 } },
      ] });
      throw new Error(`unexpected ${url}`);
    };

    const response = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/commits', { headers: { Cookie: `s=${sealed}` } }), env);
    const body = await response.text();
    assert.match(body, /\/r\/Cameronrlewis\/repo\/a\/20"/, 'Missing link to newest review artifact /a/20');
    assert.doesNotMatch(body, /\/r\/Cameronrlewis\/repo\/a\/10"/, 'Unexpected link to older review artifact /a/10');
    results['finding 10'] = { status: 'PASS' };
  } catch (err) {
    results['finding 10'] = { status: 'FAIL', error: err.message };
  }

  // Test 11: Finding 11 (thread listing cursor-paginates threads past 100 and comments past 50)
  try {
    const sealed = await signedIn({ t: 'access-secret' });
    const makeThread = (i, commentNodes, commentPageInfo = { hasNextPage: false, endCursor: null }) => ({
      id: `PRRT_${i}`, isResolved: false, resolvedBy: null,
      comments: { totalCount: commentNodes.length, pageInfo: commentPageInfo, nodes: commentNodes },
    });
    const firstComment = i => ({ databaseId: i * 100 + 1, body: threadBody({ anchor: { ...anchor, ref: `R${i}` }, text: `open ${i}`, link: 'https://site.example/r/Cameronrlewis/repo/a/1' }), author: { login: 'alice' }, createdAt: '2026-10-12T10:00:00Z', url: `https://github.com/x#${i}` });
    const comments50 = Array.from({ length: 50 }, (_, j) => j === 0 ? firstComment(1) : ({ databaseId: 100 + j + 1, body: `reply ${j}`, author: { login: 'bob' }, createdAt: '2026-10-12T11:00:00Z', url: `https://github.com/x#1-${j}` }));
    const comment51 = { databaseId: 151, body: 'reply 50', author: { login: 'carol' }, createdAt: '2026-10-12T12:00:00Z', url: 'https://github.com/x#1-50' };
    const threadsPage1 = [
      makeThread(1, comments50, { hasNextPage: true, endCursor: 'c50' }),
      ...Array.from({ length: 99 }, (_, idx) => makeThread(idx + 2, [firstComment(idx + 2)])),
    ];
    const threadsPage2 = [makeThread(101, [firstComment(101)])];
    let incomplete = false;
    globalThis.fetch = async (url, options = {}) => {
      url = String(url);
      if (url.endsWith('/repo')) return repoOk();
      assert.equal(url, 'https://api.github.com/graphql');
      const { variables } = JSON.parse(options.body);
      if (incomplete) {
        return Response.json({ data: { repository: { pullRequest: { headRefOid: 'b'.repeat(40), reviewThreads: { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: null }, nodes: threadsPage1 } } } } });
      }
      if (variables.threadId) {
        assert.equal(variables.threadId, 'PRRT_1');
        assert.equal(variables.after, 'c50');
        return Response.json({ data: { node: { comments: { totalCount: 51, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [comment51] } } } });
      }
      if (!variables.after) {
        return Response.json({ data: { repository: { pullRequest: { headRefOid: 'b'.repeat(40), reviewThreads: { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: 't100' }, nodes: threadsPage1 } } } } });
      }
      assert.equal(variables.after, 't100');
      return Response.json({ data: { repository: { pullRequest: { headRefOid: 'b'.repeat(40), reviewThreads: { totalCount: 101, pageInfo: { hasNextPage: false, endCursor: null }, nodes: threadsPage2 } } } } });
    };

    const response = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/pull/7/threads', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.threads.length, 101);
    assert.equal(data.threads[100].id, 'PRRT_101');
    assert.equal(data.threads[0].comments.length, 51);
    assert.equal(data.threads[0].comments[50].body, 'reply 50');

    incomplete = true;
    const failed = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/pull/7/threads', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(failed.status, 502);
    results['finding 11'] = { status: 'PASS' };
  } catch (err) {
    results['finding 11'] = { status: 'FAIL', error: err.message };
  }

  // Test 12: Finding 12 (issues route paginates open issues past 100 and fails closed when scan is incomplete)
  try {
    const issuesRoute = issuesMod.issuesRoute;
    const unanchored = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Plain ${i + 1}`, html_url: `https://github.com/Cameronrlewis/repo/issues/${i + 1}`, state: 'open', body: 'no anchor' }));
    const anchoredOnPage2 = { number: 101, title: 'Tracked on page 2', html_url: 'https://github.com/Cameronrlewis/repo/issues/101', state: 'open', body: threadBody({ anchor, text: 'existing', link: 'https://site.example/r/Cameronrlewis/repo/a/1' }) };
    let posts = 0, overflow = false;
    const gh = async (path, token, options) => {
      if (options?.method === 'POST') { posts++; return new Response(JSON.stringify({ number: 102, html_url: 'https://github.com/Cameronrlewis/repo/issues/102' }), { status: 201 }); }
      const m = /\/repos\/Cameronrlewis\/repo\/issues\?state=open&per_page=100(?:&page=(\d+))?$/.exec(path);
      assert.ok(m, `unexpected path ${path}`);
      if (overflow) return Response.json(unanchored);
      return Response.json(Number(m[1] || 1) === 1 ? unanchored : [anchoredOnPage2]);
    };
    const issueInput = { anchor, text: 'new issue', link: '/r/Cameronrlewis/repo/a/1', title: 'New Issue' };
    const issueRequest = (body) => new Request('https://site.example/r/Cameronrlewis/repo/issues', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' }, body: JSON.stringify(body) });
    const issueAccess = async () => ({ u: { login: 'author' }, token: 'token', s: { token: 'token' }, repo: { permissions: { push: true } } });

    const response = await issuesRoute(issueRequest(issueInput), env, { owner: 'Cameronrlewis', repo: 'repo', rest: '' }, { access: issueAccess, gh });
    assert.equal(response.status, 409, `Expected 409 duplicate conflict, got ${response.status}`);
    assert.equal(posts, 0);
    const body = await response.json();
    assert.equal(body.url, 'https://github.com/Cameronrlewis/repo/issues/101');

    overflow = true;
    const over = await issuesRoute(issueRequest(issueInput), env, { owner: 'Cameronrlewis', repo: 'repo', rest: '' }, { access: issueAccess, gh });
    assert.equal(over.status, 502, `Expected 502 overflow, got ${over.status}`);
    assert.equal(posts, 0);
    results['finding 12'] = { status: 'PASS' };
  } catch (err) {
    results['finding 12'] = { status: 'FAIL', error: err.message };
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  }
}
