import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import worker, { open, seal, milestoneGroups } from './worker.js';
import { reportCsp, frameCsp } from './csp.js';
import { commitsPage, homePage, messagePage, reviewPage, reviewsPage, runPage, signedOutPage } from './pages.js';

import { historyEvents, HISTORY_QUERY } from './history.js';
import { historyPage, frame, siteBadge, siteTable, sharedPage, sharedNotFoundPage } from './pages.js';

const historyArtifactName = /^kicad-review(?:-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail))?\.html$/;
const anchor = { v: 1, project: 'Thermal_Camera', file: 'Thermal_Camera/Thermal_Camera.kicad_pcb', sheet: null, layer: 'F.Cu',
  target: 'object', uuid: '0a1b2c3d-0000-4000-8000-000000000001', kind: 'footprint', ref: 'R16', x: 12.3, y: 45.6,
  side: 'head', commit: 'a'.repeat(40), severity: 'blocking' };

const repoOk = () => new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: true }, default_branch: 'main' }));

test('history ignores unrelated artifacts from the same run', () => {
  const artifacts = [{ id: 900, name: 'kicad-review.html', workflow_run: { id: 77 } }, { id: 901, name: 'build.zip', workflow_run: { id: 77 } }];
  const checks = historyEvents(historyFixture(),artifacts, '/r/o/r', historyArtifactName).filter(e => e.kind === 'checks');
  assert.equal(checks[0].href, '/r/o/r/a/900');
  assert.equal(historyEvents(historyFixture(),artifacts.slice(1), '/r/o/r', historyArtifactName).find(e => e.kind === 'checks').href, null);
});

const historyFixture = () => ({ data: { repository: { pullRequest: { title: 'Move R16',
  commits: { nodes: [{ commit: { oid: 'a'.repeat(40), messageHeadline: 'Move R16', committedDate: '2026-10-12T09:00:00Z', author: { name: 'Cam' } } }] },
  reviews: { nodes: [{ author: null, state: 'APPROVED', submittedAt: '2026-10-12T11:00:00Z', commit: { oid: 'a'.repeat(40) } }] },
  reviewThreads: { nodes: [{ isResolved: true, resolvedBy: { login: 'bo' }, comments: { nodes: [{ author: { login: 'ann' }, createdAt: '2026-10-12T10:00:00Z', body: threadBody({ anchor, text: 'check', link: 'https://s/r' }) }] } }] },
  comments: { nodes: [{ author: { login: 'github-actions' }, body: '<!-- kicad-review -->\n<!-- kicad-review-log -->\n| [2026-10-12 10:04](https://github.com/o/r/actions/runs/77) | `aaaaaaa` | ✅ pass | A\\|B: ERC 0 (0) |\n| [2026-09-01 08:00](https://github.com/o/r/actions/runs/5) | `bbbbbbb` | ❌ fail | ERC 1 (1) |\n<!-- /kicad-review-log -->' }] }
} } } });

test('history joins sources newest first, parses escaped pipes and links active reports', () => {
  const events = historyEvents(historyFixture(),[{ id: 900, name: 'kicad-review.html', workflow_run: { id: 77 }, expired: false }], '/r/o/r', historyArtifactName);
  assert.deepEqual(events.map(e => e.kind), ['review', 'checks', 'thread', 'commit', 'checks']);
  assert.equal(events[0].who, 'ghost');
  assert.equal(events[1].href, '/r/o/r/a/900');
  assert.match(events[1].text, /A\|B/);
  assert.equal(events[2].text, 'Blocking thread on R16 (resolved by bo)');
  assert.equal(events[4].href, null);
  assert.match(HISTORY_QUERY, /comments\(first:100\)/);
});

test('history trusts only bot-authored marked logs and drops expired links', () => {
  const gq = historyFixture();
  const bot = gq.data.repository.pullRequest.comments.nodes[0];
  gq.data.repository.pullRequest.comments.nodes.unshift({ ...bot, author: { login: 'attacker' } });
  const events = historyEvents(gq,[{ id: 900, name: 'kicad-review.html', workflow_run: { id: 77 }, expired: true }], '/r/o/r', historyArtifactName);
  assert.equal(events.filter(e => e.kind === 'checks').length, 2);
  assert.ok(events.filter(e => e.kind === 'checks').every(e => e.href === null));
  bot.author.login = 'attacker';
  assert.equal(historyEvents(gq).filter(e => e.kind === 'checks').length, 0);
});

test('history page escapes text, validates links and defaults unknown filters to all', () => {
  const html = historyPage({ user: 'u', owner: 'o', repo: 'r', pull: 7, title: '<b>t</b>', filter: 'unknown',
    events: [{ time: '2026-10-12T11:00:00Z', kind: 'review', text: 'Approved <script>', who: 'ghost', href: 'javascript:alert(1)' }] });
  assert.match(html, /&lt;b&gt;t&lt;\/b&gt;/); assert.match(html, /Approved &lt;script&gt;/);
  assert.match(html, /class="filter-chip" href="\?f=all" aria-current="page"/);
  assert.doesNotMatch(html, /javascript:|Waivers/);
});

test('history route preserves refreshed cookies and security headers on every outcome', async () => {
  const sealed = await signedIn({ e: Date.now() - 1 });
  for (const [outcome, status] of [['ok', 200], ['throw', 502], ['forbidden', 403], ['rate', 429], ['graphql', 502], ['http', 502]]) {
    const seen = [];
    const restore = mockFetch(async url => {
      seen.push(url);
      if (url.includes('access_token')) return tokenResponse();
      if (url.endsWith('/repo')) return repoOk();
      if (url.includes('/actions/artifacts')) throw new Error('artifact failure degrades');
      if (outcome === 'throw') throw new Error('network failure');
      if (outcome === 'rate') return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      if (outcome === 'http') return new Response('{}', { status: 500 });
      if (outcome === 'forbidden' || outcome === 'graphql') return new Response(JSON.stringify({ errors: [{ type: outcome === 'forbidden' ? 'FORBIDDEN' : 'NOT_FOUND' }] }));
      return new Response(JSON.stringify(historyFixture()));
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/pull/7/history', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, status, outcome);
      assert.ok(cookieValue(response, 's'), outcome);
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      const body = await response.text();
      if (status === 403) assert.match(body, /Pull requests and Contents permissions/);
      if (status === 429) assert.match(body, /rate limit/);
      if (status === 200) assert.match(body, /Move R16/);
      assert.ok(!seen.some(url => url.includes('waivers')));
    } finally { restore(); }
  }
});

test('history checks access before timeline calls', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls++; return new Response('{}', { status: 404 }); });
  try {
    const response = await call('/r/Cameronrlewis/repo/pull/7/history');
    assert.equal(response.status, 302); assert.equal(calls, 0);
  } finally { restore(); }
});

import { CHECKS } from '../ui/checks.mjs';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('TS-S3 absent fixture data is SKIP, never PASS', async () => {
  const absent = { REVIEW_DATA: { projects: [{ name: 'sample', board: {}, sheets: [], changes: [] }, { checks: [] }] },
    D: { projects: [{ board: { changed: true }, sheets: [] }] }, proj: () => ({ changes: [], sheets: [] }) };
  const checks = CHECKS.filter(c => /if \([^\n]+\) return (?:true|"skip");/.test(c[2]));
  assert.ok(checks.length >= 20);
  for (const [name, , body] of checks) assert.equal(await runInNewContext(`(async()=>{${body}})()`, absent), 'skip', name);
  const r = spawnSync(process.execPath, ['ui/check.mjs', 'TS-S6-no-such-check'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /no check matches/);
});

const chrome = process.env.CHROME || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
test('TS-S5 a page that never becomes ready fails instead of hanging', { skip: spawnSync(chrome, ['--version']).status !== 0 && 'no Chrome' }, () => {
  const page = join(mkdtempSync(join(tmpdir(), 'check-')), 'never-ready.html');
  writeFileSync(page, '<!doctype html><title>Never ready</title>');
  const r = spawnSync(process.execPath, ['ui/check.mjs', 'loads sample', '--page', page], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHECK_PORT: process.env.CHECK_PORT || '9395', CHECK_TIMEOUT: '2000', CHROME: chrome } });
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /FAIL loads sample -> Runtime.evaluate timed out/);
});

test('3D runner reports and bounds one whole check', { skip: spawnSync(chrome, ['--version']).status !== 0 && 'no Chrome' }, () => {
  const page = join(mkdtempSync(join(tmpdir(), 'check-')), 'never-ready.html');
  writeFileSync(page, '<!doctype html><title>Never ready</title>');
  const r = spawnSync(process.execPath, ['ui/check.mjs', 'loads sample', '--page', page], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHECK_PORT: process.env.CHECK_PORT || '9396', CHECK_TIMEOUT: '2000', CHECK_WALL_TIMEOUT: '500', CHROME: chrome } });
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.trim().split('\n'), ['RUN loads sample', 'FAIL loads sample -> timed out']);
});

test('timed-out runner body settles before the next check starts', async () => {
  const source = readFileSync('ui/check.mjs', 'utf8'), loop = source.slice(source.indexOf('let failed = 0;'), source.indexOf('if (shot)'));
  let settled = false, overlap = false;
  const log = line => { if (line === 'RUN second' && !settled) overlap = true; };
  await runInNewContext(`(async()=>{${loop}})()`, {
    CHECKS: [['first', '', 'first()'], ['second', '', 'second()']], filter:'', dark:false, page:'', noSkip:false, errors:[],
    setTimeout, clearTimeout, process:{env:{CHECK_WALL_TIMEOUT:'1'}}, console:{log},
    send:async () => ({}), sleep:() => new Promise(r => setTimeout(r, 10)),
    evaluate:async expr => { if (expr.includes('first()')) settled = true; return {result:{value:true}}; },
  });
  assert.equal(overlap, false, 'next check starts while timed-out body is still running');
});

test('TS-S4 named UI assertions reject missing content and no-op gestures', async () => {
  const run = (name, globals) => runInNewContext(`(async()=>{${CHECKS.find(c => c[0] === name)[2]}})()`, {
    setTimeout: f => setTimeout(f, 0), requestAnimationFrame: f => setTimeout(f, 0), ...globals });
  assert.notEqual(await run('modified card shows every changed property old and new', {
    REVIEW_DATA: { projects: [{}, { changes: [{ id: 'c1', action: 'modified', changes: [['Value', '10k', '20k']] }] }] },
    document: { querySelector: () => ({ textContent: 'Value 20k' }) } }), true);
  assert.notEqual(await run('wheel zoom keeps both panes in step', { S: { z: 1 }, WheelEvent: class {},
    document: { querySelector: () => ({ dispatchEvent() {} }), querySelectorAll: () => [{ style: { transform: 'scale(1)' } }, { style: { transform: 'scale(1)' } }] } }), true);
  for (const m of ['side', 'overlay', 'wipe', 'blend', 'semantic']) assert.notEqual(await run(`mode ${m} draws`, {
    S: { m }, document: { querySelector: s => s === '#stage' ? { classList: { contains: () => true } } : { dataset: { mode: m } }, querySelectorAll: () => [] } }), true);
  assert.notEqual(await run('unchanged sheet still reachable', {
    proj: () => ({ sheets: [{ status: 'unchanged', path: '/same/' }] }), document: { querySelector: () => null } }), true);
});

const env = {
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
  ALLOWED_OWNERS: 'Cameronrlewis',
};
const security = ['cache-control', 'x-content-type-options', 'referrer-policy'];
const request = (path, options = {}) => new Request(`https://site.example${path}`, options);
const cookies = (response) => response.headers.getSetCookie();
const cookieValue = (response, name) => {
  const match = cookies(response).find((value) => value.startsWith(`${name}=`));
  return match?.split(';', 1)[0].slice(name.length + 1);
};
function checkSecurity(response) {
  for (const header of security) assert.ok(response.headers.get(header), `${header} missing`);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
}
async function call(path, options) {
  const response = await worker.fetch(request(path, options), env);
  checkSecurity(response);
  return response;
}
async function callUrl(url, options) {
  const response = await worker.fetch(new Request(url, options), env);
  checkSecurity(response);
  return response;
}
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}
function tokenResponse(overrides = {}) {
  return new Response(JSON.stringify({
    access_token: 'access-secret', expires_in: 28_800,
    refresh_token: 'refresh-secret', refresh_token_expires_in: 1_209_600, ...overrides,
  }), { headers: { 'Content-Type': 'application/json' } });
}

// All checked responses also assert the security headers required on every route.
test('ordinary routes deny framing without overriding report CSPs', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => url.endsWith('/repo') ? accessibleRepo() : compareCommitData(url) || new Response(JSON.stringify({ installations: [] })));
  try {
    for (const [path, options] of [['/', {}], ['/missing', {}], ['/login', {}], ['/callback?state=bad', {}], ['/logout', { method: 'POST' }], ['/r/Cameronrlewis/repo/commits', { headers: { Cookie: `s=${sealed}` } }]]) {
      assert.equal((await call(path, options)).headers.get('Content-Security-Policy'), "frame-ancestors 'none'", path);
    }
  } finally { restore(); }
});

test('home without a cookie offers GitHub sign-in', async () => {
  const response = await call('/');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /href="\/login"/);
  assert.doesNotMatch(body, /Signed in as/);
});

test('login sends state in its cookie and GitHub authorize redirect', async () => {
  const response = await call('/login?next=/reports');
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.origin, 'https://github.com');
  assert.equal(location.pathname, '/login/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), env.GITHUB_CLIENT_ID);
  assert.equal(location.searchParams.get('redirect_uri'), 'https://site.example/callback');
  assert.equal(location.searchParams.get('state'), cookieValue(response, 'st'));
});

test('authentication cookies use Secure only over HTTPS', async () => {
  const restore = mockFetch(async (url) => url.includes('access_token')
    ? tokenResponse()
    : new Response(JSON.stringify({ login: 'octocat' }), { headers: { 'Content-Type': 'application/json' } }));
  try {
    for (const [origin, secure] of [['https://site.example', true], ['http://localhost:8788', false]]) {
      const login = await callUrl(`${origin}/login`);
      const stateCookie = cookies(login).find((value) => value.startsWith('st='));
      assert.equal(stateCookie.includes('; Secure;'), secure);
      const state = cookieValue(login, 'st');
      const callback = await callUrl(`${origin}/callback?code=code&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `st=${state}` },
      });
      const session = cookies(callback).find((value) => value.startsWith('s='));
      assert.equal(session.includes('; Secure;'), secure);
    }
  } finally { restore(); }
});

test('callback rejects wrong or missing state before any token exchange', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; return tokenResponse(); });
  try {
    const login = await call('/login');
    const savedState = cookieValue(login, 'st');
    for (const path of ['/callback?code=code&state=wrong', '/callback?code=code']) {
      const response = await call(path, { headers: { Cookie: `st=${savedState}` } });
      assert.equal(response.status, 400);
      assert.match(cookies(response).join('\n'), /st=;.*Max-Age=0/);
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('callback seals session and home displays the signed-in login', async () => {
  const login = await call('/login?next=/reports');
  const state = cookieValue(login, 'st');
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.match(options.body.toString(), /code=code-value/);
      return tokenResponse();
    }
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(options.headers.Authorization, 'Bearer access-secret');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    return new Response(JSON.stringify({ login: 'octocat' }), { headers: { 'Content-Type': 'application/json' } });
  });
  try {
    const callback = await call(`/callback?code=code-value&state=${encodeURIComponent(state)}`, { headers: { Cookie: `st=${state}` } });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('Location'), '/reports');
    const sealed = cookieValue(callback, 's');
    assert.ok(sealed);
    for (const secret of ['access-secret', 'refresh-secret', 'octocat']) assert.doesNotMatch(sealed, new RegExp(secret));
    assert.deepEqual(await open(sealed, env), { t: 'access-secret', r: 'refresh-secret', e: (await open(sealed, env)).e, re: (await open(sealed, env)).re, u: 'octocat' });
    const home = await call('/', { headers: { Cookie: `s=${sealed}` } });
    assert.match(await home.text(), /Signed in as octocat/);
  } finally { restore(); }
});

test('a tampered session is cleared and treated as signed out', async () => {
  const sealed = await seal({ t: 'a', r: 'r', e: Date.now() + 3_600_000, re: Date.now() + 7_200_000, u: 'octocat' }, env);
  const tampered = `${sealed.slice(0, -1)}${sealed.endsWith('A') ? 'B' : 'A'}`;
  const response = await call('/', { headers: { Cookie: `s=${tampered}` } });
  assert.match(await response.text(), /Sign in with GitHub/);
  assert.match(cookies(response).join('\n'), /s=;.*Max-Age=0/);
});

test('home shows the session-ended notice only when a stale cookie was sent', async () => {
  const signedOut = await call('/');
  assert.doesNotMatch(await signedOut.text(), /You were signed out\. Sign in again to continue\./);
  const response = await call('/', { headers: { Cookie: 's=stale' } });
  const body = await response.text();
  assert.match(body, /class="notice notice-info">You were signed out\. Sign in again to continue\./);
  assert.match(cookies(response).join('\n'), /s=;.*Max-Age=0/);
});

test('callback errors show the sign-in failure page with their status and reason', async () => {
  const login = await call('/login');
  const savedState = cookieValue(login, 'st');
  const cases = [
    ['/callback?code=code&state=wrong', 400, "The sign-in link expired or was opened in a different browser."],
    [`/callback?state=${encodeURIComponent(savedState)}`, 400, "GitHub didn't send a sign-in code. You may have cancelled."],
  ];
  const restore = mockFetch(async () => new Response('no', { status: 401 }));
  try {
    cases.push([`/callback?code=code&state=${encodeURIComponent(savedState)}`, 502, "GitHub didn't accept the sign-in. Try again."]);
    for (const [path, status, reason] of cases) {
      const response = await call(path, { headers: { Cookie: `st=${savedState}` } });
      assert.equal(response.status, status);
      const body = await response.text();
      assert.match(body, /<h1[^>]*>.*Sign-in didn&#39;t complete/);
      assert.match(body, new RegExp(reason.replaceAll("'", '&#39;').replace(/[.?]/g, '\\$&')));
      assert.match(body, /href="\/login">Try again/);
      assert.match(body, /href="\/">Back to the start/);
    }
  } finally { restore(); }
});

test('message pages escape all displayed values and prioritize their first action', () => {
  const page = messagePage({
    title: '<title>', message: '<message>', details: ['<detail>'],
    links: [{ href: '/one', label: '<first>' }, { href: '/two', label: '<second>' }],
  });
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.match(page, /&lt;title&gt;/);
  assert.match(page, /&lt;message&gt;/);
  assert.match(page, /&lt;detail&gt;/);
  assert.match(page, /class="btn btn-primary" href="\/one">&lt;first&gt;<\/a>/);
  assert.match(page, /class="btn" href="\/two">&lt;second&gt;<\/a>/);
});

test('expired access tokens refresh once, while refresh errors clear the session', async () => {
  const expired = await seal({ t: 'old-token', r: 'old-refresh', e: Date.now() - 1, re: Date.now() + 7_200_000, u: 'octocat' }, env);
  let calls = 0;
  let restore = mockFetch(async (url, options = {}) => {
    calls += 1;
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    assert.match(options.body.toString(), /grant_type=refresh_token/);
    return tokenResponse({ access_token: 'new-token', refresh_token: 'new-refresh' });
  });
  try {
    const response = await call('/', { headers: { Cookie: `s=${expired}` } });
    assert.equal(calls, 2);
    assert.match(await response.text(), /Signed in as octocat/);
    assert.ok(cookieValue(response, 's'));
  } finally { restore(); }
  restore = mockFetch(async () => tokenResponse({ error: 'bad_refresh' }));
  try {
    const response = await call('/', { headers: { Cookie: `s=${expired}` } });
    assert.match(await response.text(), /Sign in with GitHub/);
    assert.match(cookies(response).join('\n'), /s=;.*Max-Age=0/);
  } finally { restore(); }
});

test('unsafe next is ignored and login text is HTML escaped', async () => {
  const login = await call('/login?next=//evil.com');
  const state = cookieValue(login, 'st');
  const restore = mockFetch(async (url) => url.includes('access_token')
    ? tokenResponse()
    : new Response(JSON.stringify({ login: '<script>alert(1)</script>' }), { headers: { 'Content-Type': 'application/json' } }));
  try {
    const callback = await call(`/callback?code=x&state=${encodeURIComponent(state)}`, { headers: { Cookie: `st=${state}` } });
    assert.equal(callback.headers.get('Location'), '/');
    const home = await call('/', { headers: { Cookie: `s=${cookieValue(callback, 's')}` } });
    const body = await home.text();
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(body, /<script>alert/);
  } finally { restore(); }
});

test('OAuth next rejects slash, backslash, and whitespace prefixes', async () => {
  const restore = mockFetch(async (url) => url.includes('access_token') ? tokenResponse() : new Response(JSON.stringify({ login: 'octocat' })));
  try {
    for (const next of ['/\\evil.example/phish', '//evil.example', '/\t/evil.example', '/\n\\evil.example', '/\r/evil.example', '/ evil.example', '/\\[', '/', '/ok?x=1#h', '/%zz']) {
      const expected = ['/', '/ok?x=1#h', '/%zz'].includes(next) ? next : '/';
      const login = await call(`/login?next=${encodeURIComponent(next)}`);
      const state = cookieValue(login, 'st');
      assert.equal(JSON.parse(Buffer.from(state, 'base64url')).n, expected, JSON.stringify(next));
      for (const saved of [state, Buffer.from(JSON.stringify({ s: 'state', n: next })).toString('base64url')]) {
        const callback = await call(`/callback?code=x&state=${encodeURIComponent(saved)}`, { headers: { Cookie: `st=${saved}` } });
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.get('Location'), expected, JSON.stringify(next));
      }
    }
  } finally { restore(); }
});

test('logout and unknown routes carry security headers', async () => {
  assert.equal((await call('/logout', { method: 'POST' })).status, 302);
  assert.equal((await call('/missing')).status, 404);
});

async function signedIn(overrides = {}) {
  return seal({ t: 'user-token', r: 'refresh-token', e: Date.now() + 3_600_000, re: Date.now() + 7_200_000, u: 'octocat', ...overrides }, env);
}

test('site link buttons are inline blocks without underlines', () => {
  const page = signedOutPage();
  assert.match(page, /a\.btn \{ text-decoration: none; display: inline-block; \}/);
});

test('review page keeps its loading overlay until the framed report is ready and forwards later hashes', () => {
  const page = reviewPage({ user: 'octocat', owner: 'owner', repo: 'repo', id: 42, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' });
  assert.match(page, /event\.source === iframe\.contentWindow && event\.data\?\.kicadReviewReady === true/);
  assert.match(page, /setTimeout[\s\S]*20000/);
  assert.match(page, /pointer-events: none/);
  assert.match(page, /const load = \(showLoading\) => \{ if \(showLoading\) \{ loading\.hidden = false; clearTimeout\(fallback\); \} iframe\.src = raw \+ location\.hash; \}; load\(true\);/);
  const hashchange = page.match(/addEventListener\('hashchange', \(\) => \{ if \(location\.hash !== reportedHash\) load\(false\); \}\);/);
  assert.ok(hashchange, 'hash changes forward without requesting the loading overlay');
  assert.doesNotMatch(hashchange[0], /loading\.hidden = false|clearTimeout/);
});

test('HTML pages inline tokens and render the shared frame safely', async () => {
  const signedOut = signedOutPage();
  assert.match(signedOut, /--accent/);
  assert.match(signedOut, /<header class="top">/);
  assert.doesNotMatch(signedOut, /class="account"/);
  const base = { user: '<b>octocat</b>', owner: 'owner', repo: 'repo' };
  const pages = [
    homePage({ user: base.user, repositories: [] }),
    reviewsPage({ ...base, items: [], started: false }),
    commitsPage({ ...base, branch: 'main', branches: ['main'], commits: [] }),
    runPage({ ...base, running: false, conclusion: 'Done', githubUrl: '' }),
    messagePage({ title: 'Not found', message: 'Missing', user: base.user }),
  ];
  for (const page of pages) {
    assert.match(page, /--accent/);
    assert.match(page, /<header class="top">/);
    assert.match(page, /Signed in as &lt;b&gt;octocat&lt;\/b&gt;/);
    assert.doesNotMatch(page, /Signed in as <b>/);
  }
});

test('review routes redirect unsigned users without fetching GitHub', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    const response = await call('/r/Cameronrlewis/review-repo?tab=all');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/login?next=%2Fr%2FCameronrlewis%2Freview-repo%3Ftab%3Dall');
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('review routes reject disallowed owners and invalid repository names before GitHub', async () => {
  const sealed = await signedIn();
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    for (const path of ['/r/other/repo', '/r/Cameronrlewis/bad%20repo']) {
      const response = await call(path, { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
      assert.match(await response.text(), /href="\/"/);
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('repository access checks the canonical owner after redirects', async () => {
  const sealed = await signedIn();
  for (const owner of ['DisallowedOwner', 'cAmErOnRlEwIs']) {
    for (const suffix of ['', '/commits', '/a/42', '/a/42/raw', '/run/42', '/compare']) {
      let calls = 0;
      const restore = mockFetch(async () => { calls += 1; return new Response(JSON.stringify({ owner: { login: owner }, permissions: { pull: true }, default_branch: 'main' })); });
      try {
        const response = suffix === '/compare'
          ? await compareRequest(`/r/Cameronrlewis/repo${suffix}`, { base: 'invalid', head: 'invalid' }, sealed)
          : await call(`/r/Cameronrlewis/repo${suffix}`, { headers: { Cookie: `s=${sealed}` } });
        if (owner === 'DisallowedOwner') { assert.equal(response.status, 404, suffix); assert.equal(calls, 1, suffix); }
        else assert.ok(calls > 1 || response.status === 400, suffix);
      } finally { restore(); }
    }
  }
});

test('review route hides inaccessible repositories behind the same HTML 404', async () => {
  const sealed = await signedIn();
  const missing = await call('/not-found', { headers: { Cookie: `s=${sealed}` } });
  const missingBody = await missing.text();
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(missingBody, /<h1[^>]*>.*Can&#39;t open this page/);
  assert.match(missingBody, /Either it doesn&#39;t exist, or your GitHub account can&#39;t see it\./);
  assert.match(missingBody, /You&#39;re signed in as the right GitHub account/);
  assert.match(missingBody, /The repository owner has installed the KiCad review GitHub App on it/);
  assert.match(missingBody, /Someone has given you access on GitHub/);
  assert.match(missingBody, /href="\/">Back to repositories/);
  for (const repoResponse of [new Response('missing', { status: 404 }), new Response('denied', { status: 403 }), new Response(JSON.stringify({ permissions: { pull: false } }))]) {
    const restore = mockFetch(async () => repoResponse);
    try {
      const response = await call('/r/Cameronrlewis/repo', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
      assert.equal(await response.text(), missingBody);
    } finally { restore(); }
  }
});

test('review route shows the repository after a pull-access check and refreshes the session', async () => {
  const sealed = await signedIn({ e: Date.now() - 1 });
  let calls = 0;
  const restore = mockFetch(async (url, options = {}) => {
    calls += 1;
    if (url === 'https://github.com/login/oauth/access_token') return tokenResponse();
    assert.equal(options.headers.Authorization, 'Bearer access-secret');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true } }));
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts?per_page=100');
    return new Response(JSON.stringify({ artifacts: [] }));
  });
  try {
    const response = await call('/r/Cameronrlewis/repo', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(calls, 3);
    assert.match(await response.text(), /<h1>Reviews<\/h1>/);
    assert.ok(cookieValue(response, 's'));
  } finally { restore(); }
});

test('shared CSP module preserves the original report sandbox and wrapper policies', () => {
  assert.equal(reportCsp, "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-ancestors 'self'");
  assert.equal(frameCsp, "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
});

test('artifact frame and raw route redirect unsigned users without GitHub calls', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    for (const path of ['/r/Cameronrlewis/repo/a/42', '/r/Cameronrlewis/repo/a/42/raw']) {
      const response = await call(path);
      assert.equal(response.status, 302);
      assert.match(response.headers.get('Location'), /^\/login\?next=/);
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('raw artifact route streams the signed blob with its frame-only sandbox CSP', async () => {
  const sealed = await signedIn();
  const blobUrl = 'https://signed.example/secret-report';
  const seen = [];
  const restore = mockFetch(async (url, options = {}) => {
    seen.push([url, options]);
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true } }));
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/42') return new Response(JSON.stringify({ name: 'kicad-review.html', expired: false }));
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/42/zip') {
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: blobUrl } });
    }
    assert.equal(url, blobUrl);
    assert.equal(options.headers?.Authorization, undefined);
    return new Response('<!doctype html><svg></svg>');
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/a/42/raw', { headers: { Cookie: `s=${sealed}`, 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Security-Policy'), reportCsp);
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('Location'), null);
    assert.equal(await response.text(), '<!doctype html><svg></svg>');
    assert.equal(cookies(response).length, 0);
    assert.equal(seen.length, 4);
  } finally { restore(); }
});

test('raw document navigation redirects to its framed review without downloading', async () => {
  const sealed = await signedIn(); const seen = [];
  const restore = mockFetch(async (url) => {
    seen.push(url);
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/artifacts/43')) return new Response(JSON.stringify({ name: 'kicad-review-deadbee-cafebad-pass.html', expired: false }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/a/43/raw', { headers: { Cookie: `s=${sealed}`, 'Sec-Fetch-Dest': 'document' } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/r/Cameronrlewis/repo/a/43');
    assert.deepEqual(seen, [
      'https://api.github.com/repos/Cameronrlewis/repo',
      'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/43',
    ]);
  } finally { restore(); }
});

test('framed artifact page keeps the report sandboxed and escapes metadata', async () => {
  const sealed = await signedIn(); const seen = [];
  const restore = mockFetch(async (url) => {
    seen.push(url);
    if (url.includes('/actions/runs/')) return new Response(JSON.stringify({ event: 'push', pull_requests: [] }));
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/artifacts/44')) return new Response(JSON.stringify({
      name: 'kicad-review-deadbee-cafebad-fail.html', expired: false,
      workflow_run: { id: 123 },
    }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/a/44', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Security-Policy'), frameCsp);
    const body = await response.text();
    assert.match(body, /Review deadbee → cafebad/);
    assert.match(body, /✕ checks failing/);
    assert.match(body, /https:\/\/github\.com\/Cameronrlewis\/repo\/actions\/runs\/123/);
    assert.match(body, /<iframe[^>]+src="\/r\/Cameronrlewis\/repo\/a\/44\/raw"/);
    assert.match(body, /sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"/);
    assert.doesNotMatch(body, /allow-same-origin/);
    assert.match(body, /event\.source === iframe\.contentWindow/);
    assert.match(body, /kicadReviewHash/);
    assert.deepEqual(seen, [
      'https://api.github.com/repos/Cameronrlewis/repo',
      'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/44',
      'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/123',
    ]);
  } finally { restore(); }
});

test('framed artifact page uses legacy review crumbs', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => {
    if (url.includes('/actions/runs/')) return new Response(JSON.stringify({ event: 'push', pull_requests: [] }));
    return url.endsWith('/repo') ? accessibleRepo() : new Response(JSON.stringify({ name: 'kicad-review.html', expired: false }));
  });
  try {
    const body = await (await call('/r/Cameronrlewis/repo/a/45', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.match(body, /<span>Review<\/span>/);
    assert.doesNotMatch(body, /Review \? → \?/);
  } finally { restore(); }
});

test('artifact redirect URL remains server-side', async () => {
  const sealed = await signedIn();
  const blobUrl = 'https://signed.example/very-secret';
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true } }));
    if (url.endsWith('/artifacts/7')) return new Response(JSON.stringify({ name: 'report.html' }));
    if (url.endsWith('/artifacts/7/zip')) return new Response(null, { status: 302, headers: { Location: blobUrl } });
    return new Response('<p>review</p>');
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/a/7', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Location'), null);
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(blobUrl));
    for (const [, value] of response.headers) assert.doesNotMatch(value, new RegExp(blobUrl));
  } finally { restore(); }
});

test('expired artifacts explain how to get a new review', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => url.endsWith('/repo')
    ? new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true } }))
    : new Response(JSON.stringify({ name: 'report.html', expired: true })));
  try {
    const response = await call('/r/Cameronrlewis/repo/a/8', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Reviews are kept for 90 days by GitHub\. Generate it again to see it\./);
  } finally { restore(); }
});

test('artifact route stops before artifact APIs when repository access fails', async () => {
  const sealed = await signedIn();
  let calls = 0;
  const restore = mockFetch(async (url) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo');
    return new Response('denied', { status: 403 });
  });
  try {
    for (const path of ['/r/Cameronrlewis/repo/a/9', '/r/Cameronrlewis/repo/a/9/raw']) {
      const response = await call(path, { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 404);
    }
    assert.equal(calls, 2);
  } finally { restore(); }
});

test('artifact route rejects non-numeric IDs without fetching', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    const response = await call('/r/Cameronrlewis/repo/a/not-a-number');
    assert.equal(response.status, 404);
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('home lists only allowed repositories, sorted and escaped', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => {
    if (url === 'https://api.github.com/user/installations') return new Response(JSON.stringify({ installations: [{ id: 1 }, { id: 2 }] }));
    if (url.endsWith('/1/repositories?per_page=100')) return new Response(JSON.stringify({ repositories: [
      { name: '<old>', owner: { login: 'Cameronrlewis' }, pushed_at: '2024-01-01T00:00:00Z' },
      { name: 'other', owner: { login: 'Elsewhere' }, pushed_at: '2025-01-01T00:00:00Z' },
    ] }));
    return new Response(JSON.stringify({ repositories: [{ name: 'new', owner: { login: 'cAmErOnRlEwIs' }, pushed_at: '2025-01-01T00:00:00Z' }] }));
  });
  try {
    const body = await (await call('/', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.match(body, /cAmErOnRlEwIs\/new/);
    assert.match(body, /&lt;old&gt;/);
    assert.doesNotMatch(body, /Elsewhere\/other/);
    assert.ok(body.indexOf('new') < body.indexOf('&lt;old&gt;'));
  } finally { restore(); }
});

test('home explains installation when none are reachable', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => {
    assert.equal(url, 'https://api.github.com/user/installations');
    return new Response(JSON.stringify({ installations: [] }));
  });
  try {
    const body = await (await call('/', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.match(body, /No repositories yet/);
    assert.match(body, /owner or admin installs the KiCad review GitHub App/);
    assert.match(body, /Signed in as octocat/);
  } finally { restore(); }
});

test('repository cards show escaped details, visibility, update time, and two actions', () => {
  const body = homePage({
    user: 'octocat',
    repositories: [{
      name: '<board>', owner: { login: '<owner>' }, private: true,
      pushed_at: '2025-02-03T04:05:00Z',
    }],
  });
  assert.match(body, /class="card"/);
  assert.match(body, /&lt;owner&gt;/);
  assert.match(body, /&lt;board&gt;/);
  assert.match(body, /private/);
  assert.match(body, /updated .* ago/);
  assert.match(body, /title="2025-02-03T04:05:00Z"/);
  assert.match(body, /href="\/r\/%3Cowner%3E\/%3Cboard%3E"[^>]*>Reviews<\/a>/);
  assert.match(body, /href="\/r\/%3Cowner%3E\/%3Cboard%3E\/commits"[^>]*>Compare commits<\/a>/);
});

test('review cards parse, escape, and list artifacts once', async () => {
  const sealed = await signedIn(); let artifactCalls = 0;
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true } }));
    if (url.endsWith('/actions/artifacts?per_page=100')) {
      artifactCalls += 1;
      return new Response(JSON.stringify({ artifacts: [
        { id: 1, name: 'kicad-review-deadbee-cafebad-pass.html', created_at: '2025-02-03T04:05:00Z', workflow_run: { head_branch: '<b>x', event: 'push' } },
        { id: 2, name: 'kicad-review.html', created_at: '2024-01-01T00:00:00Z', workflow_run: { head_branch: 'legacy' } },
        { id: 3, name: 'kicad-review-bad.html', created_at: '2026-01-01T00:00:00Z' },
        { id: 4, name: 'kicad-review-aaaaaaa-bbbbbbb-fail.html', expired: true, created_at: '2026-01-01T00:00:00Z' },
      ] }));
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const body = await (await call('/r/Cameronrlewis/repo', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.equal(artifactCalls, 1);
    assert.match(body, /class="review-card"/); assert.match(body, /deadbee/); assert.match(body, /cafebad/);
    assert.match(body, /✓ passing/); assert.match(body, /branch push/);
    assert.match(body, /Revisions not recorded \(older report\)/); assert.match(body, /— not recorded/);
    assert.doesNotMatch(body, /Not run/); assert.doesNotMatch(body, /1234567/); assert.doesNotMatch(body, />\?<\//); assert.match(body, /&lt;b&gt;x/);
    assert.doesNotMatch(body, /kicad-review-bad/); assert.doesNotMatch(body, /bbbbbbb/);
  } finally { restore(); }
});

test('review filter chips count and filter from one artifact list', async () => {
  const sealed = await signedIn(); let artifactCalls = 0;
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true } }));
    if (url.endsWith('/actions/artifacts?per_page=100')) {
      artifactCalls += 1;
      return new Response(JSON.stringify({ artifacts: [
        { id: 1, name: 'kicad-review-deadbee-cafebad-pass.html' },
        { id: 2, name: 'kicad-review-aaaaaaa-bbbbbbb-fail.html' },
        { id: 3, name: 'kicad-review.html' },
      ] }));
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const body = await (await call('/r/Cameronrlewis/repo?filter=failing', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.equal(artifactCalls, 1);
    assert.match(body, /All 3/); assert.match(body, /Passing 1/); assert.match(body, /Failing 1/); assert.match(body, /Older 1/);
    assert.match(body, /href="\/r\/Cameronrlewis\/repo\?filter=failing" aria-current="page"/);
    assert.match(body, /bbbbbbb/); assert.doesNotMatch(body, /cafebad/); assert.doesNotMatch(body, /Revisions not recorded/);
  } finally { restore(); }
});

test('reviews page gives started and empty states clear guidance', () => {
  const page = reviewsPage({ user: 'octocat', owner: 'owner', repo: 'repo', items: [], counts: { all: 0, passing: 0, failing: 0, older: 0 }, filter: 'all', started: true });
  assert.match(page, /Your review has started\. It appears here in about two minutes\. You can leave this page\./);
  assert.match(page, /No reviews yet/);
  assert.match(page, /push or pull request that changes KiCad files/);
  assert.match(page, />Compare commits<\/a>/);
});

test('commit history uses the access repository default and links reviews', async () => {
  const sealed = await signedIn(); const urls = [];
  const restore = mockFetch(async (url) => {
    urls.push(url);
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true }, default_branch: 'main' }));
    if (url.endsWith('/branches?per_page=100')) return new Response(JSON.stringify([{ name: 'main' }]));
    if (url.endsWith('/tags?per_page=100')) return new Response(JSON.stringify([]));
    if (url.includes('/commits?')) return new Response(JSON.stringify([{ sha: 'deadbeef000', commit: { message: '<script>bad</script>\nmore', author: { name: 'Ada', date: '2025-02-03T04:05:00Z' } } }]));
    if (url.endsWith('/actions/artifacts?per_page=100')) return new Response(JSON.stringify({ artifacts: [{ id: 9, name: 'kicad-review.html', workflow_run: { head_sha: 'deadbeef000' } }] }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    const body = await (await call('/r/Cameronrlewis/repo/commits', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.equal(urls.filter((url) => url.endsWith('/repo')).length, 1);
    assert.ok(urls.some((url) => url.includes('/commits?sha=main&per_page=50')));
    assert.doesNotMatch(body, /a\/9/); assert.match(body, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(body, /<script>bad/);
  } finally { restore(); }
});

test('unknown commit branch is a 404 and access refusal makes no further calls', async () => {
  const sealed = await signedIn();
  let restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true }, default_branch: 'main' }));
    if (url.includes('/commits?')) return new Response('missing', { status: 404 });
    if (url.endsWith('/branches?per_page=100') || url.endsWith('/actions/artifacts?per_page=100')) return new Response(JSON.stringify({ artifacts: [] }));
    throw new Error(`unexpected ${url}`);
  });
  try { assert.equal((await call('/r/Cameronrlewis/repo/commits?branch=gone', { headers: { Cookie: `s=${sealed}` } })).status, 404); } finally { restore(); }
  let calls = 0;
  restore = mockFetch(async () => { calls += 1; return new Response('denied', { status: 403 }); });
  try {
    for (const path of ['/r/Cameronrlewis/repo', '/r/Cameronrlewis/repo/commits']) assert.equal((await call(path, { headers: { Cookie: `s=${sealed}` } })).status, 404);
    assert.equal(calls, 2);
  } finally { restore(); }
});


function compareRequest(path, body, sealed, origin = 'https://site.example') {
  return call(path, {
    method: 'POST',
    headers: {
      ...(sealed ? { Cookie: `s=${sealed}` } : {}),
      ...(origin === null ? {} : { Origin: origin }),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
}

function accessibleRepo() {
  return new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true }, default_branch: 'main' }));
}

const base = 'deadbeef00000000000000000000000000000000';
const head = 'cafebabe00000000000000000000000000000000';

test('compare rejects missing or foreign Origin before GitHub', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    for (const origin of [null, 'https://evil.example']) {
      const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, null, origin);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
      assert.match(await response.text(), /href="\/"/);
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('compare rejects Origin null before GitHub', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, null, 'null');
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.match(await response.text(), /href="\/"/);
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('compare requires a session and accepted repository access', async () => {
  let calls = 0;
  let restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('Location'), /^\/login\?/);
    assert.equal(calls, 0);
  } finally { restore(); }
  const sealed = await signedIn();
  restore = mockFetch(async () => {
    calls += 1;
    return new Response('denied', { status: 403 });
  });
  try {
    const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, sealed);
    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('compare rejects malformed or identical commit SHAs without dispatching', async () => {
  const sealed = await signedIn();
  let calls = 0;
  const restore = mockFetch(async (url) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo');
    return accessibleRepo();
  });
  try {
    for (const body of [{ base: 'not-a-sha', head }, { base, head: base }]) {
      const response = await compareRequest('/r/Cameronrlewis/repo/compare', body, sealed);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /Back to commits/);
    }
    assert.equal(calls, 2);
  } finally { restore(); }
});

test('compare dispatches the selected commits and follows returned run ID', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return accessibleRepo();
    if (url.includes('/compare/')) return new Response(JSON.stringify({ status: 'ahead', files: [{ filename: 'board.kicad_pcb' }] }));
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo/actions/workflows/kicad-review.yml/dispatches');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      ref: 'main', inputs: { base, head }, return_run_details: true,
    });
    return new Response(JSON.stringify({ workflow_run_id: 123, run_url: 'ignored', html_url: 'ignored' }));
  });
  try {
    const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, sealed);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), `/r/Cameronrlewis/repo/run/123?base=${base}&head=${head}`);
  } finally { restore(); }
});

test('compare accepts a 204 dispatch response without a run ID', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => url.endsWith('/repo') ? accessibleRepo() : url.includes('/compare/') ? new Response(JSON.stringify({ status: 'ahead', files: [{ filename: 'board.kicad_pcb' }] })) : new Response(null, { status: 204 }));
  try {
    const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, sealed);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/r/Cameronrlewis/repo?started=1');
  } finally { restore(); }
});

test('compare explains GitHub dispatch authorization failures', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => url.endsWith('/repo') ? accessibleRepo() : url.includes('/compare/') ? new Response(JSON.stringify({ status: 'ahead', files: [{ filename: 'board.kicad_pcb' }] })) : new Response('denied', { status: 403 }));
  try {
    const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, sealed);
    assert.equal(response.status, 403);
    assert.match(await response.text(), /You need write access and the KiCad review workflow/);
  } finally { restore(); }
});

test('running review refreshes safely and shows a GitHub run link only', async () => {
  const sealed = await signedIn({ e: Date.now() - 1 });
  const restore = mockFetch(async (url) => {
    if (url === 'https://github.com/login/oauth/access_token') return tokenResponse();
    if (url.endsWith('/repo')) return accessibleRepo();
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/12');
    return new Response(JSON.stringify({ status: 'in_progress', html_url: 'https://github.com/Cameronrlewis/repo/actions/runs/12' }));
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } });
    const body = await response.text();
    assert.match(body, /http-equiv="refresh" content="5"/);
    assert.match(body, /Generating review/);
    assert.match(body, /https:\/\/github\.com\/Cameronrlewis\/repo\/actions\/runs\/12/);
    assert.ok(cookieValue(response, 's'));
  } finally { restore(); }
  const restoreUnsafe = mockFetch(async (url) => url.endsWith('/repo')
    ? accessibleRepo()
    : new Response(JSON.stringify({ status: 'queued', html_url: 'https://evil.example/run' })));
  try {
    const body = await (await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.doesNotMatch(body, /evil\.example/);
  } finally { restoreUnsafe(); }
});

test('completed rerun redirects to newest non-expired review artifact even after a failed gate', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'completed', conclusion: 'failure' }));
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/12/artifacts');
    return new Response(JSON.stringify({ artifacts: [{ id: 55, name: 'kicad-review-deadbee-cafebad-pass.html', created_at: '2026-10-11' }, { id: 57, name: 'kicad-review-deadbee-cafebad-pass.html', created_at: '2026-10-13', expired: true }, { id: 56, name: 'kicad-review-deadbee-cafebad-pass.html', created_at: '2026-10-12' }] }));
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/r/Cameronrlewis/repo/a/56');
  } finally { restore(); }
});

test('successful completed review without artifact reports no KiCad changes', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({
      status: 'completed', conclusion: 'success', html_url: 'https://github.com/Cameronrlewis/repo/actions/runs/12',
    }));
    return new Response(JSON.stringify({ artifacts: [] }));
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } });
    assert.match(await response.text(), /No KiCad files changed between these revisions\./);
  } finally { restore(); }
});

test('run route rejects non-numeric IDs before fetching', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    const response = await call('/r/Cameronrlewis/repo/run/nope');
    assert.equal(response.status, 404);
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('commits lists tags and resolves tag selection to its commit SHA', async () => {
  const sealed = await signedIn(); const urls = [];
  const restore = mockFetch(async (url) => {
    urls.push(url);
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/branches?per_page=100')) return new Response(JSON.stringify([{ name: 'main' }]));
    if (url.endsWith('/tags?per_page=100')) return new Response(JSON.stringify([{ name: 'v1.0', commit: { sha: head } }]));
    if (url.includes('/commits?')) return new Response(JSON.stringify([]));
    if (url.endsWith('/actions/artifacts?per_page=100')) return new Response(JSON.stringify({ artifacts: [] }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    const body = await (await call('/r/Cameronrlewis/repo/commits?tag=v1.0', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.match(body, /<option value="v1\.0" selected>v1\.0<\/option>/);
    assert.ok(urls.some((url) => url.includes(`/commits?sha=${head}&per_page=50`)));
  } finally { restore(); }
});


function compareCommitData(url) {
  if (url.endsWith('/branches?per_page=100')) return new Response(JSON.stringify([{ name: 'main' }]));
  if (url.endsWith('/tags?per_page=100')) return new Response(JSON.stringify([]));
  if (url.endsWith('/actions/artifacts?per_page=100')) return new Response(JSON.stringify({ artifacts: [] }));
  if (url.includes('/commits?')) return new Response(JSON.stringify([{ sha: head, commit: { message: 'New board', author: { name: 'Ada', date: '2025-02-03T04:05:00Z' } } }, { sha: base, commit: { message: 'Old board', author: { name: 'Ada', date: '2025-02-02T04:05:00Z' } } }]));
}
test('compare rerenders selected pair with swap form when Head is behind', async () => {
  const sealed = await signedIn(); let dispatched = false;
  const restore = mockFetch(async (url) => { if (url.endsWith('/repo')) return accessibleRepo(); if (url.includes('/compare/')) return new Response(JSON.stringify({ status: 'behind', files: [] })); if (url.includes('/dispatches')) { dispatched = true; throw new Error('must not dispatch'); } const page = compareCommitData(url); if (page) return page; throw new Error(`unexpected ${url}`); });
  try { const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, sealed); const body = await response.text(); assert.equal(response.status, 400); assert.equal(dispatched, false); assert.match(body, /Head is older than Base\./); assert.match(body, /Swap and start/); assert.match(body, new RegExp(`name="base" value="${base}"[^>]*checked`)); assert.match(body, /class="compare-bar"/); } finally { restore(); }
});
test('compare refuses KiCad-free file changes and lists changed files', async () => {
  const sealed = await signedIn(); let dispatched = false; const files = Array.from({ length: 11 }, (_, i) => `docs/file-${i}.md`);
  const restore = mockFetch(async (url) => { if (url.endsWith('/repo')) return accessibleRepo(); if (url.includes('/compare/')) return new Response(JSON.stringify({ status: 'ahead', files: files.map((filename) => ({ filename })) })); if (url.includes('/dispatches')) { dispatched = true; throw new Error('must not dispatch'); } const page = compareCommitData(url); if (page) return page; throw new Error(`unexpected ${url}`); });
  try { const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, sealed); const body = await response.text(); assert.equal(response.status, 400); assert.equal(dispatched, false); assert.match(body, /No KiCad files changed between deadbee and cafebab, so there is nothing to review\./); assert.match(body, /class=\"changed-files mono\"/); assert.match(body, /docs\/file-0\.md/); assert.match(body, /and 1 more/); } finally { restore(); }
});
function commitsScript() {
  const node = () => ({ append() {}, replaceChildren() {} });
  const branch = { value: 'main' }; const tag = { value: 'v1' }; const row = {}; const button = {}; const status = node();
  const form = { querySelector: (selector) => selector === '[type="submit"]' ? button : null, querySelectorAll: (selector) => selector === 'tr' ? [row] : [] };
  const bar = { querySelector: () => status, querySelectorAll: () => [node(), node()] };
  const document = { createElement: node, querySelector: (selector) => ({ '.compare-form': form, '.compare-bar': bar, '[name=branch]': branch, '[name=tag]': tag, '#tag': tag })[selector] };
  const page = commitsPage({ owner: 'owner', repo: 'repo', branch: 'main', branches: ['main', 'dev'], tag: 'v1', tags: [{ name: 'v1' }], commits: [] });
  runInNewContext([...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1], { document });
  return { branch, tag, row };
}

test('changing branch clears the selected tag before Show', () => {
  const { branch, tag } = commitsScript();
  branch.value = 'dev'; branch.onchange?.();
  assert.equal(tag.value, '');
  assert.equal(branch.value, 'dev');
});

test('row Enter guard blocks radios but preserves Reviewed links', () => {
  const { row } = commitsScript();
  for (const [radio, key, expected] of [[false, 'Enter', false], [true, 'Enter', true], [true, ' ', false]]) {
    let prevented = false;
    row.onkeydown({ key, target: { matches: (selector) => { assert.equal(selector, 'input[type=radio]'); return radio; } }, preventDefault() { prevented = true; } });
    assert.equal(prevented, expected, `${radio ? 'radio' : 'Reviewed link'} ${key}`);
  }
});

test('compare page renders every inline-script target and keeps Show in its picker row', () => {
  const page = commitsPage({ user: 'octocat', owner: 'owner', repo: 'repo', branch: 'main', branches: ['main'], tags: [], commits: [{ sha: base, message: 'Board', fullMessage: 'Board\nDetails', author: 'Ada', date: 'today', exactDate: '2025-01-01', review: null }] });
  for (const selector of ['compare-form', 'compare-bar', 'compare-slot']) assert.match(page, new RegExp(`class="[^"]*${selector}[^"]*"`));
  assert.match(page, /<form[^>]*class="compare-form"[^>]*>[\s\S]*?<button[^>]*type="submit"[^>]*>Start review<\/button>/);
  assert.match(page, /<div[^>]*class="[^"]*compare-bar[^"]*"[^>]*>[\s\S]*?<[^>]+role="status"/);
  assert.match(page, /<button class="btn" form="source-picker">Show<\/button>/);
  assert.doesNotMatch(page, /<button[^>]*type="submit"[^>]*disabled[^>]*>Start review<\/button>/);
  assert.match(page, /\.compare-slot \{[^}]*min-height:/);
  assert.match(page, /Head is older than Base\. The review would show the change backwards\./);

});

test('generating review maps queued, rendering, and completed job steps', () => {
  const common = { user: 'octocat', owner: 'Cameronrlewis', repo: 'repo', base: 'deadbeef', head: 'cafebabe', startedAt: '2026-10-07T10:00:00Z' };
  const queued = runPage({ ...common, running: true, status: 'queued', jobs: [] });
  assert.match(queued, /● <span class="spinner"[^>]*><\/span> Waiting to start <span class="step-state">· in progress<\/span>/);
  const rendering = runPage({ ...common, running: true, status: 'in_progress', jobs: [{ steps: [
    { name: 'Check out repository', status: 'completed', conclusion: 'success' },
    { name: 'Render board', status: 'in_progress', conclusion: null },
  ] }] });
  assert.match(rendering, /✓ Getting the files <span class="step-state">· done<\/span>/);
  assert.match(rendering, /● <span class="spinner"/);
  const done = runPage({ ...common, running: true, status: 'in_progress', jobs: [{ steps: [
    { name: 'Check out', status: 'completed', conclusion: 'success' },
    { name: 'Render schematic', status: 'completed', conclusion: 'success' },
    { name: 'Build comparison report', status: 'completed', conclusion: 'success' },
    { name: 'Publish report', status: 'completed', conclusion: 'success' },
    { name: 'Cleanup', status: 'completed', conclusion: 'success' },
  ] }] });
  assert.match(done, /✓ Finishing <span class="step-state">· done<\/span>/);
});

test('generating review follows the workflow step order through files, rendering, and publishing', () => {
  const common = { user: 'octocat', owner: 'Cameronrlewis', repo: 'repo', base: 'deadbeef', head: 'cafebabe', startedAt: '2026-10-07T10:00:00Z', running: true, status: 'in_progress' };
  const workflow = [
    'Set up job', 'Skip push that an open pull request already covers', 'Check out project history', 'Check out review tools',
    'Find changed KiCad projects', 'Check out both revisions side by side', 'Render both revisions and run ERC/DRC',
    'Build comparison report and checks', 'Copy named report', 'Upload report', 'Screenshots of changed drawings', 'Publish screenshots',
    'Job summary', 'Pull request comment', 'Fail on required checks', 'Post cleanup', 'Complete job',
  ];
  const at = (index) => runPage({ ...common, jobs: [{ steps: workflow.map((name, i) => ({ name, status: i < index ? 'completed' : i === index ? 'in_progress' : 'queued', conclusion: i < index ? 'success' : null })) }] });
  const states = (page) => [...page.matchAll(/<li class="(done|active|todo|failed)">[^<]*?(?:<span[^>]*><\/span> )?([^<]+) <span class="step-state">· ([^<]+)<\/span><\/li>/g)].map(([, state, name]) => [name.replace(/^[○✓✕]\s+/, '').trim(), state]);
  assert.deepEqual(states(at(4)).slice(1), [['Getting the files', 'active'], ['Rendering and checking', 'todo'], ['Building the report', 'todo'], ['Finishing', 'todo']]);
  assert.deepEqual(states(at(6)).slice(1), [['Getting the files', 'done'], ['Rendering and checking', 'active'], ['Building the report', 'todo'], ['Finishing', 'todo']]);
  assert.deepEqual(states(at(11)).slice(1), [['Getting the files', 'done'], ['Rendering and checking', 'done'], ['Building the report', 'active'], ['Finishing', 'todo']]);
});

test('PG-S3 compression keeps Rendering active and Building waiting', () => {
  const page = runPage({ owner: 'Cameronrlewis', repo: 'repo', running: true, status: 'in_progress', jobs: [{ steps: [
    { name: 'Render board', status: 'completed', conclusion: 'success' },
    { name: 'Compress 3D board models', status: 'in_progress' },
    { name: 'Build comparison report', status: 'queued' },
  ] }] });
  assert.match(page, /<li class="active">[^<]*<span[^>]*><\/span> Rendering and checking /);
  assert.match(page, /<li class="todo">○ Building the report /);
  assert.match(page, /<li class="todo">○ Finishing /);
});

test('PG-O1 failed runs name the same stage as progress', async () => {
  const sealed = await signedIn();
  for (const name of ['Find changed KiCad projects', 'Set up job', 'Skip push that an open pull request already covers', 'Copy named report']) {
    const jobs = [{ steps: [{ name, status: 'completed', conclusion: 'failure' }] }];
    const progress = runPage({ owner: 'Cameronrlewis', repo: 'repo', status: 'in_progress', jobs });
    const stage = progress.match(/<li class="failed">✕ ([^<]+) <span/)[1];
    const restore = mockFetch(async (url) => {
      if (url.endsWith('/repo')) return accessibleRepo();
      if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'completed', conclusion: 'failure' }));
      if (url.endsWith('/jobs')) return new Response(JSON.stringify({ jobs }));
      if (url.endsWith('/artifacts')) return new Response(JSON.stringify({ artifacts: [] }));
      throw new Error(`unexpected ${url}`);
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(`The run stopped at ${stage} (${name}).`), name);
    } finally { restore(); }
  }
});

test('run page validates revisions and only refreshes while running', () => {
  const common = { user: 'octocat', owner: 'Cameronrlewis', repo: 'repo', status: 'in_progress', jobs: [] };
  const running = runPage({ ...common, running: true, base: base, head, startedAt: '2026-10-07T10:00:00Z' });
  assert.match(running, /http-equiv="refresh" content="5"/);
  assert.match(running, /deadbee → cafebab/);
  assert.match(running, /Revisions: <span class="mono">deadbee/);
  const invalid = runPage({ ...common, running: true, base: '<bad>', head });
  assert.match(invalid, /Revisions: not recorded/);
  const finished = runPage({ ...common, running: false, status: 'completed', base, head });
  assert.doesNotMatch(finished, /http-equiv="refresh"/);
});

test('run page distinguishes nothing to review, failed runs, and failures with reports', async () => {
  const sealed = await signedIn();
  const failedJobs = { jobs: [{ steps: [{ name: 'Render board', status: 'completed', conclusion: 'failure' }] }] };
  let restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'completed', conclusion: 'failure' }));
    if (url.endsWith('/jobs')) return new Response(JSON.stringify(failedJobs));
    if (url.endsWith('/artifacts')) return new Response(JSON.stringify({ artifacts: [] }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    const body = await (await call(`/r/Cameronrlewis/repo/run/12?base=${base}&head=${head}`, { headers: { Cookie: `s=${sealed}` } })).text();
    assert.match(body, /The run stopped at Rendering and checking \(Render board\)\./);
    assert.match(body, /method="post" action="\/r\/Cameronrlewis\/repo\/compare"/);
    assert.match(body, new RegExp(`name="base" value="${base}"`));
    assert.match(body, new RegExp(`name="head" value="${head}"`));
  } finally { restore(); }
  restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'completed', conclusion: 'success' }));
    if (url.endsWith('/artifacts')) return new Response(JSON.stringify({ artifacts: [] }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    const body = await (await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } })).text();
    assert.match(body, /Nothing to review/);
    assert.match(body, /No KiCad files changed between these revisions\./);
  } finally { restore(); }
  restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'completed', conclusion: 'failure' }));
    if (url.endsWith('/jobs')) return new Response(JSON.stringify(failedJobs));
    if (url.endsWith('/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 56, name: 'kicad-review-deadbee-cafebad-fail.html' }] }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.headers.get('Location'), '/r/Cameronrlewis/repo/a/56');
  } finally { restore(); }
});

test('run jobs are fetched as the user only for progress or a failed run without an artifact', async () => {
  const sealed = await signedIn();
  const urls = [];
  const restore = mockFetch(async (url, options = {}) => {
    urls.push(url);
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'in_progress', run_started_at: '2026-10-07T10:00:00Z' }));
    if (url.endsWith('/jobs')) {
      assert.equal(options.headers.Authorization, 'Bearer user-token');
      return new Response(JSON.stringify({ jobs: [] }));
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(urls.filter((url) => url.endsWith('/jobs')).length, 1);
  } finally { restore(); }
  const completedUrls = [];
  const restoreCompleted = mockFetch(async (url) => {
    completedUrls.push(url);
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'completed', conclusion: 'success' }));
    if (url.endsWith('/artifacts')) return new Response(JSON.stringify({ artifacts: [] }));
    throw new Error(`unexpected ${url}`);
  });
  try {
    await call('/r/Cameronrlewis/repo/run/12', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(completedUrls.filter((url) => url.endsWith('/jobs')).length, 0);
  } finally { restoreCompleted(); }
});

test('expired artifacts offer regeneration only when their name records revisions', async () => {
  const sealed = await signedIn();
  for (const [name, expected] of [
    ['kicad-review-deadbee-cafebad-pass.html', /Generate it again/],
    ['kicad-review.html', /Back to reviews/],
  ]) {
    const restore = mockFetch(async (url) => url.endsWith('/repo')
      ? new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true } }))
      : new Response(JSON.stringify({ name, expired: true })));
    try {
      const body = await (await call('/r/Cameronrlewis/repo/a/8', { headers: { Cookie: `s=${sealed}` } })).text();
      assert.match(body, /Reviews are kept for 90 days by GitHub\. Generate it again to see it\./);
      assert.match(body, expected);
      if (name === 'kicad-review-deadbee-cafebad-pass.html') {
        assert.match(body, /name="base" value="deadbee"/);
        assert.match(body, /name="head" value="cafebad"/);
      }
    } finally { restore(); }
  }
});


test('reviews group by milestone, deduplicate PR counts, and retain reviews without a milestone', () => {
  const items = [{ id: 1, branch: 'power' }, { id: 2, branch: 'usb' }, { id: 3, branch: 'main' }, { id: 4, branch: 'power' }];
  const milestone = { id: 1, title: 'Rev B', html_url: 'https://github.com/o/r/milestone/1' };
  const pulls = [{ number: 5, head: { ref: 'power' }, state: 'open', merged_at: null, milestone },
    { number: 6, head: { ref: 'usb' }, state: 'closed', merged_at: '2026-10-01', milestone }];
  const groups = milestoneGroups(items, pulls);
  assert.deepEqual(groups.map(g => [g.title, g.open, g.merged, g.items.map(i => i.id)]), [['Rev B', 1, 1, [1, 2, 4]], ['No milestone', 0, 0, [3]]]);
  assert.equal(groups[0].url, milestone.html_url);
  assert.deepEqual(groups[0].items[1].pull, { number: 6, state: 'closed', merged: true });
  assert.equal(groups[1].items[0].pull, null);
  assert.equal(items[0].pull, undefined);
  assert.deepEqual(milestoneGroups([], []), []);
  const reused = milestoneGroups([{ branch: 'power' }], [pulls[0], { ...pulls[0], number: 9, milestone: null }]);
  assert.equal(reused[0].items[0].pull.number, 9);
  assert.equal(reused[0].title, 'No milestone');
  assert.equal(milestoneGroups([{ branch: 'power', manual: true }], pulls)[0].items[0].pull, null);
  const sameTitles = milestoneGroups(items, [pulls[0], { ...pulls[1], milestone: { ...milestone, id: 2 } }]);
  assert.equal(sameTitles.length, 3, 'distinct milestones may share a title');
  const closed = milestoneGroups([{ branch: 'usb' }], [{ ...pulls[1], merged_at: null, milestone: null }]);
  assert.equal(closed[0].open + closed[0].merged, 0, 'closed but unmerged PRs are not counted');
});

test('milestone page escapes text, rejects unsafe links, and distinguishes empty from permission failure', () => {
  const base = { user: 'octocat', owner: 'o', repo: 'r', items: [], view: 'milestones' };
  const page = reviewsPage({ ...base, groups: [{ title: '<script>', url: 'javascript:alert(1)', open: 1, merged: 2, items: [] }] });
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /javascript:/);
  assert.match(page, /1 open · 2 merged/);
  assert.doesNotMatch(reviewsPage({ ...base, groups: [] }), /Milestones need/);
  assert.match(reviewsPage({ ...base, groups: null }), /Milestones need the app&#39;s Pull requests permission/);
});

test('milestone route reads PRs only on opt-in, after access, preserving refreshed cookies', async () => {
  const sealed = await signedIn({ e: Date.now() - 1000 });
  let pullsCalls = 0;
  let denied = false;
  const artifact = { id: 77, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', created_at: '2026-10-01T00:00:00Z', workflow_run: { head_branch: 'power', event: 'pull_request', head_sha: 'bbbbbbb' } };
  const restore = mockFetch(async (url, options) => {
    if (url.includes('access_token')) return tokenResponse();
    assert.equal(options.headers.Authorization, 'Bearer access-secret');
    if (url.endsWith('/repo')) return denied ? new Response('denied', { status: 403 }) : accessibleRepo();
    if (url.includes('/actions/artifacts')) return new Response(JSON.stringify({ artifacts: [artifact] }));
    if (url.includes('/pulls?')) {
      pullsCalls++;
      return new Response(JSON.stringify([{ number: 5, head: { ref: 'power' }, state: 'open', milestone: { id: 1, title: 'Rev B', html_url: 'https://github.com/Cameronrlewis/repo/milestone/1' } }]));
    }
    throw new Error('unexpected fetch');
  });
  try {
    let response = await call('/r/Cameronrlewis/repo', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 200);
    assert.ok(cookieValue(response, 's'));
    assert.equal(pullsCalls, 0);
    response = await call('/r/Cameronrlewis/repo?view=milestones', { headers: { Cookie: `s=${sealed}` } });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(cookieValue(response, 's'));
    assert.equal(pullsCalls, 1);
    assert.match(body, /Rev B/);
    assert.match(body, /PR #5 \(open\)/);
    assert.match(body, /\/a\/77/);
    denied = true;
    response = await call('/r/Cameronrlewis/repo?view=milestones', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 404);
    assert.ok(cookieValue(response, 's'));
    assert.equal(pullsCalls, 1);
  } finally { restore(); }
});

test('both view chip hrefs escape the filter at interpolation', () => {
  const source = readFileSync('site/pages.js', 'utf8');
  assert.equal(source.split('${e(filter)}').length - 1, 2);
  const page = reviewsPage({ user: 'octocat', owner: 'o', repo: 'r', items: [], view: 'milestones', groups: [], filter: '\" onclick=\"evil&' });
  assert.doesNotMatch(page, /href="[^"]*" onclick=/);
  assert.doesNotMatch(page, /&amp;quot;/, 'do not double escape the helper output');
  assert.match(page, /filter=&quot; onclick=&quot;evil&amp;/);
});

test('milestone permission or network failure keeps the review list accessible', async () => {
  const sealed = await signedIn();
  for (const fail of [() => new Response('denied', { status: 403 }), () => { throw new Error('network'); }]) {
    const restore = mockFetch(async url => url.endsWith('/repo') ? accessibleRepo() : url.includes('/pulls?') ? fail() : new Response(JSON.stringify({ artifacts: [] })));
    try {
      const response = await call('/r/Cameronrlewis/repo?view=milestones', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Milestones need the app&#39;s Pull requests permission/);
    } finally { restore(); }
  }
});
// Guest credentials are signed capabilities, never GitHub credentials.
const shareEnv = { ...env, SHARE_KEY: Buffer.alloc(32, 9).toString('base64') };
test('share tokens are unguessable, strictly validated, expiring and bound to one review', async () => {
  const { signShare, verifyShare } = await import('./share.js');
  const claims = { o: 'Cameronrlewis', r: 'repo', a: 123, exp: Date.now() + 3600_000, g: 2 };
  const token = await signShare(claims, shareEnv);
  assert.deepEqual(await verifyShare(token, shareEnv), claims);
  const [body, sig] = token.split('.');
  assert.equal(Buffer.from(sig, 'base64url').length, 32);
  for (const patch of [{ a: 124 }, { o: 'Other' }, { r: 'elsewhere' }, { exp: claims.exp + 1 }, { g: 3 }]) {
    const forged = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url');
    assert.equal(await verifyShare(`${forged}.${sig}`, shareEnv), null);
  }
  assert.equal(await verifyShare(`${body}.${Buffer.alloc(32).toString('base64url')}`, shareEnv), null);
  for (const patch of [{ exp: Date.now() - 1 }, { exp: Date.now() + 31 * 86400_000 }, { o: '../x' }, { a: 0 }, { a: 1.5 }, { g: -1 }, { g: 1.5 }, { r: null }]) {
    assert.equal(await verifyShare(await signShare({ ...claims, ...patch }, shareEnv), shareEnv), null);
  }
  for (const invalid of ['garbage', token + '.', token + '.extra', 'x'.repeat(3000)]) assert.equal(await verifyShare(invalid, shareEnv), null);
  assert.equal(await verifyShare(token, { SHARE_KEY: Buffer.alloc(32, 8).toString('base64') }), null);
  assert.equal(await verifyShare(token, { SHARE_KEY: 'tiny' }), null);
  assert.equal(await verifyShare(token, shareEnv, claims.exp), null);
});

const { privateKey, publicKey: sharePublicKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const appEnv = { ...shareEnv, GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64')}\n-----END PRIVATE KEY-----` };
const sharePost = async (path, body = {}, headers = {}, cookie) => request(path, { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/json', Cookie: `s=${cookie ?? await signedIn()}`, ...headers }, body: JSON.stringify(body) });
const shareMeta = (expires = new Date(Date.now() + 2 * 86400_000).toISOString()) => ({ name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', expired: false, expires_at: expires });
const shareJson = (data, status = 200) => new Response(JSON.stringify(data), { status });
function shareCreationFetch({ push = true, metadata = shareMeta(), generation = '3', genStatus = 200, refreshed = false } = {}) {
  return mockFetch(async (url, options = {}) => {
    if (url === 'https://github.com/login/oauth/access_token' && refreshed) return tokenResponse();
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return shareJson({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push } });
    if (url.endsWith('/actions/artifacts/123')) return shareJson(metadata);
    if (url.endsWith('/installation')) return shareJson({ id: 7 });
    if (url.endsWith('/access_tokens')) {
      assert.deepEqual(JSON.parse(options.body), { repositories: ['repo'], permissions: { actions: 'read', actions_variables: 'read' } });
      return shareJson({ token: 'installation-secret' }, 201);
    }
    if (url.endsWith('/KICAD_REVIEW_SHARE_GEN')) return shareJson({ value: generation }, genStatus);
    throw new Error(`Unexpected share API path: ${url}`);
  });
}
test('app JWT is RS256 with verified signature and short lifetime; feature needs all secrets', async () => {
  const { appJwt, shareEnabled } = await import('./share.js');
  const token = await appJwt(appEnv, 1_700_000_000_000);
  const [h, p, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: '42', iat: 1_699_999_940, exp: 1_700_000_540 });
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', sharePublicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${h}.${p}`)), true);
  assert.equal(shareEnabled(appEnv), true);
  for (const key of ['SHARE_KEY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']) assert.equal(shareEnabled({ ...appEnv, [key]: '' }), false);
});
test('writers create one-review links scoped read-only and expiry never outlives artifact', async () => {
  const restore = shareCreationFetch();
  try {
    const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share', { days: 30 }), appEnv);
    assert.equal(response.status, 201); checkSecurity(response);
    const { url, expires } = await response.json();
    const { verifyShare } = await import('./share.js');
    const claims = await verifyShare(url.split('/s/')[1], appEnv);
    assert.equal(expires, claims.exp); assert.ok(expires <= Date.now() + 2 * 86400_000);
    assert.deepEqual({ ...claims, exp: 0 }, { o: 'Cameronrlewis', r: 'repo', a: 123, exp: 0, g: 3 });
    assert.doesNotMatch(url, /installation-secret|user-token|PRIVATE KEY/);
  } finally { restore(); }
});
test('share POST auth, owner, origin, JSON and writer checks deny without privileged calls', async () => {
  let calls = 0;
  const restore = mockFetch(async url => { calls++; assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo'); return shareJson({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: false } }); });
  try {
    const denied = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share'), appEnv);
    assert.equal(denied.status, 403); assert.ok((await denied.json()).error);
    const before = calls;
    for (const [path, cookie] of [['/r/Other/repo/a/123/share', await signedIn()], ['/r/Cameronrlewis/repo/a/123/share', '']]) {
      const response = await worker.fetch(await sharePost(path, {}, {}, cookie), appEnv);
      assert.ok([401, 404].includes(response.status)); assert.ok((await response.json()).error);
    }
    assert.equal(calls, before);
  } finally { restore(); }
  const restoreWriter = shareCreationFetch();
  try {
    for (const [headers, status] of [[{ Origin: 'https://evil.example' }, 403], [{ 'Content-Type': 'text/plain' }, 415], [{ 'Content-Type': 'application/jsonp' }, 415]]) {
      const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share', {}, headers), appEnv);
      assert.equal(response.status, status); assert.ok((await response.json()).error); checkSecurity(response);
    }
    for (const days of [0, 31, 1.5, '7', null]) {
      const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share', { days }), appEnv);
      assert.equal(response.status, 400);
    }
  } finally { restoreWriter(); }
});
test('create fails closed on invalid artifact expiry, unrelated report and generation errors', async () => {
  for (const settings of [{ metadata: shareMeta('bad') }, { metadata: shareMeta(new Date(Date.now() - 1).toISOString()) }, { metadata: { ...shareMeta(), name: 'unrelated.html' } }, { generation: '3junk' }, { generation: '-1' }, { genStatus: 403 }, { genStatus: 500 }]) {
    const restore = shareCreationFetch(settings);
    try { const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share'), appEnv); assert.ok(response.status >= 400); assert.ok((await response.json()).error); }
    finally { restore(); }
  }
});
test('new authenticated share exits retain refreshed cookie including upstream failure', async () => {
  for (const settings of [{}, { push: false }, { genStatus: 500 }, { metadata: shareMeta('bad') }]) {
    const restore = shareCreationFetch({ ...settings, refreshed: true });
    try {
      const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share', {}, {}, await signedIn({ e: Date.now() - 1 })), appEnv);
      const cookie = cookieValue(response, 's'); assert.ok(cookie);
      assert.equal((await open(cookie, env)).t, 'access-secret');
    } finally { restore(); }
  }
});

test('pdf route streams the run\'s PDF as a download', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return accessibleRepo();
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/123') return new Response(JSON.stringify({ name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflow_run: { id: 9 } }));
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/9/artifacts?per_page=100') return new Response(JSON.stringify({ artifacts: [{ id: 124, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.pdf', expired: false }] }));
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/124/zip') return new Response(null, { status: 302, headers: { Location: 'https://blob.example/p' } });
    assert.equal(url, 'https://blob.example/p'); return new Response('%PDF-1.7');
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/a/123/pdf', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'application/pdf');
    assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="kicad-review-aaaaaaa-bbbbbbb-pass.pdf"');
    assert.equal(await response.text(), '%PDF-1.7');
  } finally { restore(); }
});

test('no pdf artifact is a 404', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => url === 'https://api.github.com/repos/Cameronrlewis/repo' ? accessibleRepo()
    : url.endsWith('/artifacts/123') ? new Response(JSON.stringify({ name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflow_run: { id: 9 } }))
      : new Response(JSON.stringify({ artifacts: [{ id: 123, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' }] })));
  try { assert.equal((await call('/r/Cameronrlewis/repo/a/123/pdf', { headers: { Cookie: `s=${sealed}` } })).status, 404); } finally { restore(); }
});

test('PDF link is absent by default and present only for a matching PDF', () => {
  const input = { user: 'octocat', owner: 'owner', repo: 'repo', id: 42, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' };
  assert.equal(reviewPage(input), reviewPage({ ...input, pdf: false }));
  assert.doesNotMatch(reviewPage(input), /Download PDF/);
  assert.match(reviewPage({ ...input, pdf: true }), /href="\/r\/owner\/repo\/a\/42\/pdf"[^>]*>Download PDF/);
});

test('PDF route checks access before artifact calls and returns JSON', async () => {
  const sealed = await signedIn(); let artifactCalls = 0;
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return new Response('denied', { status: 403 });
    artifactCalls++; throw new Error('must not fetch artifacts');
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/a/123/pdf', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('Content-Type'), /application\/json/);
    assert.deepEqual(await response.json(), { error: 'PDF unavailable' });
    assert.equal(artifactCalls, 0);
    assert.ok(response.headers.get('X-Content-Type-Options'));
  } finally { restore(); }
});

test('PDF route rejects wrong siblings, expired PDFs and unsafe download URLs', async () => {
  const sealed = await signedIn();
  for (const variant of ['wrong', 'expired', 'unsafe', 'missing', 'error']) {
    let blobs = 0;
    const restore = mockFetch(async (url) => {
      if (url.endsWith('/repo')) return accessibleRepo();
      if (url.endsWith('/artifacts/123')) return new Response(JSON.stringify({ name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflow_run: { id: 9 } }));
      if (url.includes('/runs/9/artifacts')) {
        if (variant === 'error') throw new Error('network error');
        return new Response(JSON.stringify({ artifacts: variant === 'missing' ? [] : [{ id: 124, name: variant === 'wrong' ? 'other.pdf' : 'kicad-review-aaaaaaa-bbbbbbb-pass.pdf', expired: variant === 'expired' }] }));
      }
      if (url.endsWith('/artifacts/124/zip')) return new Response(null, { status: 302, headers: { Location: 'http://blob.example/pdf' } });
      blobs++; throw new Error('unsafe blob fetch');
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/a/123/pdf', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 404, variant);
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      assert.equal(blobs, 0);
    } finally { restore(); }
  }
});

test('PDF errors retain refreshed cookies, including malformed IDs', async () => {
  for (const id of ['123', 'bad']) {
    const sealed = await signedIn({ e: Date.now() - 1 });
    const restore = mockFetch(async (url) => {
      if (url.includes('access_token')) return tokenResponse();
      if (url.endsWith('/repo')) return accessibleRepo();
      return new Response(JSON.stringify({ name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflow_run: { id: 9 }, artifacts: [] }));
    });
    try {
      const response = await call(`/r/Cameronrlewis/repo/a/${id}/pdf`, { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 404);
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      assert.match(response.headers.get('Set-Cookie'), /^s=/);
    } finally { restore(); }
  }
});


test('review page avoids PDF discovery calls and uses listing hint when present', async () => {
  const sealed = await signedIn();
  for (const suffix of ['', '?pdf=1']) {
    const seen = [];
    const restore = mockFetch(async (url) => {
      seen.push(url);
      if (url.endsWith('/repo')) return accessibleRepo();
      if (url.endsWith('/actions/runs/9')) return new Response(JSON.stringify({ event: 'push', pull_requests: [] }));
      assert.ok(url.endsWith('/artifacts/123'));
      return new Response(JSON.stringify({ name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflow_run: { id: 9 } }));
    });
    try {
      const response = await call(`/r/Cameronrlewis/repo/a/123${suffix}`, { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.text()).includes('Download PDF'), Boolean(suffix));
      assert.deepEqual(seen, ['https://api.github.com/repos/Cameronrlewis/repo', 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/123', 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/9']);
    } finally { restore(); }
  }
});

import { encodeAnchor, parseAnchor, validAnchor, threadBody, threadText, parseThreads } from './threads.js';



test('threads: anchor survives --> and markdown in text, and is validated', () => {
  const tricky = { ...anchor, ref: 'R1-->*[x](y)' };
  const body = threadBody({ anchor: tricky, text: 'Too close --> to the edge', link: 'https://site.example/r/o/r/a/1#p=0' });
  assert.deepEqual(parseAnchor(body), tricky);
  assert.match(body, /^\*\*Blocking\*\* · 📍 R1--\\>\\\*\\\[x\\\]\\\(y\\\) · `Thermal_Camera\/Thermal_Camera\.kicad_pcb` · F\.Cu · \(12\.30, 45\.60\) mm · \[open in review\]\(https:\/\/site\.example\/r\/o\/r\/a\/1#p=0\)/);
  assert.equal(threadText(body), 'Too close --> to the edge');
  assert.equal(parseAnchor('plain comment'), null);
  assert.equal(parseAnchor('<!-- kicad-review-anchor %%% -->'), null);
  assert.equal(encodeAnchor({ a: 1 }), 'eyJhIjoxfQ');
  assert.ok(validAnchor(anchor));
  for (const bad of [null, { ...anchor, v: 2 }, { ...anchor, file: '../x.kicad_pcb' }, { ...anchor, file: 'x.txt' },
    { ...anchor, x: Infinity }, { ...anchor, severity: 'urgent' }, { ...anchor, target: 'area' }, { ...anchor, ref: 'x'.repeat(201) },
    { ...anchor, commit: 'nothex' }, { ...anchor, extra: 1 }]) assert.equal(validAnchor(bad), false, JSON.stringify(bad));
});

test('threads: GraphQL threads keep only anchored ones, with plain text', () => {
  const graphql = { data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: 'PRRT_1', isResolved: true, resolvedBy: { login: 'bob' }, comments: { nodes: [
      { databaseId: 11, body: threadBody({ anchor, text: 'first', link: 'https://s/r' }), author: { login: 'alice' }, createdAt: '2026-10-12T10:00:00Z', url: 'https://github.com/x#1' },
      { databaseId: 12, body: 'agreed', author: null, createdAt: '2026-10-12T11:00:00Z', url: 'https://github.com/x#2' }] } },
    { id: 'PRRT_2', isResolved: false, resolvedBy: null, comments: { nodes: [{ databaseId: 13, body: 'code review comment', author: { login: 'c' } }] } }] } } } } };
  assert.deepEqual(parseThreads(graphql), [{ id: 'PRRT_1', resolved: true, resolvedBy: 'bob', anchor, comments: [
    { id: 11, author: 'alice', body: 'first', createdAt: '2026-10-12T10:00:00Z', url: 'https://github.com/x#1' },
    { id: 12, author: 'ghost', body: 'agreed', createdAt: '2026-10-12T11:00:00Z', url: 'https://github.com/x#2' }] }]);
  assert.deepEqual(parseThreads({ errors: [{}] }), []);
});

test('threads: only the trailing anchor marker counts', () => {
  const other = { ...anchor, ref: 'R99' };
  const spoof = `<!-- kicad-review-anchor ${encodeAnchor(other)} -->`;
  const text = `mine ${spoof}\n\nstill mine`;
  const body = threadBody({ anchor, text, link: 'https://s/r' });
  assert.deepEqual(parseAnchor(body), anchor);
  assert.equal(threadText(body), text.replaceAll('<!-- kicad-review-anchor', '<!-- kicad-review\u200b-anchor'));
  assert.equal(parseAnchor(`${spoof}\ntext after marker`), null);
  assert.equal(threadText(`${spoof}\ntext after marker`), `${spoof}\ntext after marker`);
  assert.deepEqual(parseAnchor(`${body}\n \t`), anchor);
});

test('threads: anchor strings reject newlines and file markup', () => {
  for (const key of ['project', 'file', 'sheet', 'layer', 'uuid', 'kind', 'ref', 'commit']) {
    for (const newline of ['\r', '\n']) {
      const value = key === 'file' ? `a${newline}b.kicad_pcb` : `${anchor[key] || 'x'}${newline}`;
      assert.equal(validAnchor({ ...anchor, [key]: value }), false, `${key} ${JSON.stringify(value)}`);
    }
  }
  for (const bad of [{ ref: 'R1\n\n# hi' }, { layer: 'F.Cu\r' }, { file: 'a/<!-- x -->.kicad_pcb' },
    { file: 'a`b.kicad_pcb' }]) assert.equal(validAnchor({ ...anchor, ...bad }), false, JSON.stringify(bad));
  assert.equal(threadText(threadBody({ anchor, text: 'mine', link: 'https://s/r' })), 'mine');
});

test('threads: readable anchor fields replace newlines defensively', () => {
  const body = threadBody({ anchor: { ...anchor, ref: 'R1\n\n# hi', layer: 'F.Cu\r' }, text: 'mine', link: 'https://s/r' });
  assert.equal(body.split('\n\n')[1], 'mine');
  assert.match(body.split('\n\n')[0], /R1  \\# hi/);
});

test('threads: review links encode spaces and parentheses', () => {
  const body = threadBody({ anchor, text: 'mine', link: 'https://s/r(a) b' });
  assert.ok(body.includes('[open in review](https://s/r%28a%29%20b)'));
});

test('threads: marker-only text has no missing-header slice bug', () => {
  assert.equal(threadText('x <!-- kicad-review-anchor eyJhIjoxfQ -->'), 'x');
});

test('threads: anchor suffix whitespace agrees with Python', () => {
  const body = threadBody({ anchor, text: 'mine', link: 'https://s/r' });
  assert.deepEqual(parseAnchor(`${body}\n  \t`), anchor);
  assert.equal(threadText(`${body}\n  \t`), 'mine');
  for (const suffix of ['﻿', '\x85', '\x1c', '\x1d', '\x1e', '\x1f']) {
    assert.equal(parseAnchor(body + suffix), null, JSON.stringify(suffix));
    assert.equal(threadText(body + suffix), body + suffix);
  }
});

test('threads: review links preserve existing percent escapes', () => {
  const body = threadBody({ anchor, text: 'mine', link: 'https://s/r#a%20b' });
  assert.ok(body.includes('[open in review](https://s/r#a%20b)'));
  const unsafe = threadBody({ anchor, text: 'mine', link: 'https://s/r<`>' });
  assert.ok(unsafe.includes('[open in review](https://s/r%3C%60%3E)'));
});

test('threads: review links encode backslash and line breaks', () => {
  const body = threadBody({ anchor, text: 'mine', link: 'https://s/a\\b\r\nc' });
  assert.ok(body.includes('[open in review](https://s/a%5Cb%0D%0Ac)'));
});

const threadsJson = (path, body, origin = 'https://site.example', cookie) => call(path, { method: 'POST', headers: {
  ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', ...(cookie ? { Cookie: `s=${cookie}` } : {}) }, body: JSON.stringify(body) });

test('thread POSTs reject foreign Origin and non-JSON before GitHub', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; throw new Error('unexpected fetch'); });
  try {
    for (const origin of [null, 'null', 'https://evil.example']) {
      const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads', { anchor, text: 'x', link: '/r/Cameronrlewis/repo/a/1' }, origin);
      assert.equal(response.status, 403);
    }
    const plain = await call('/r/Cameronrlewis/repo/pull/7/threads', { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 415);
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('thread list reads GraphQL as the user after the access check', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  const seen = [];
  const restore = mockFetch(async (url, options = {}) => {
    seen.push(url);
    assert.equal(options.headers.Authorization, 'Bearer access-secret');
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return repoOk();
    assert.equal(url, 'https://api.github.com/graphql');
    assert.deepEqual(JSON.parse(options.body).variables, { owner: 'Cameronrlewis', name: 'repo', number: 7 });
    return new Response(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'b'.repeat(40), reviewThreads: { nodes: [] } } } } }));
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/pull/7/threads', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { threads: [], head: 'b'.repeat(40) });
    assert.equal(seen.length, 2);
  } finally { restore(); }
});

test('creating a thread posts a file-level review comment on the PR head', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  let posted;
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return repoOk();
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/pulls/7') return new Response(JSON.stringify({ head: { sha: 'c'.repeat(40) } }));
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo/pulls/7/comments');
    posted = JSON.parse(options.body);
    return new Response('{}', { status: 201 });
  });
  try {
    const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads', { anchor, text: 'Move it', link: '/r/Cameronrlewis/repo/a/123#p=0&v=board' }, undefined, sealed);
    assert.equal(response.status, 201);
    assert.equal(posted.commit_id, 'c'.repeat(40));
    assert.equal(posted.path, anchor.file);
    assert.equal(posted.subject_type, 'file');
    assert.match(posted.body, /\[open in review\]\(https:\/\/site\.example\/r\/Cameronrlewis\/repo\/a\/123#p=0&v=board\)/);
    assert.deepEqual(parseAnchor(posted.body), anchor);
  } finally { restore(); }
});

test('creating a thread rejects bad anchors, empty text and foreign links without posting', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  let posts = 0;
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return repoOk();
    if (options.method === 'POST') posts += 1;
    return new Response(JSON.stringify({ head: { sha: 'c'.repeat(40) } }));
  });
  try {
    for (const body of [{ anchor: { ...anchor, file: '../x' }, text: 'a', link: '/r/Cameronrlewis/repo/a/1' },
      { anchor, text: '   ', link: '/r/Cameronrlewis/repo/a/1' }, { anchor, text: 'x'.repeat(10001), link: '/r/Cameronrlewis/repo/a/1' },
      { anchor, text: 'a', link: 'https://evil.example/' }]) {
      const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads', body, undefined, sealed);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(posts, 0);
  } finally { restore(); }
});

test('reply and resolve call the right GitHub endpoints', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  const calls = [];
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return repoOk();
    calls.push([url, JSON.parse(options.body || '{}')]);
    return new Response(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }), { status: url.endsWith('/replies') ? 201 : 200 });
  });
  try {
    assert.equal((await threadsJson('/r/Cameronrlewis/repo/pull/7/threads/11/reply', { text: 'done' }, undefined, sealed)).status, 201);
    assert.equal((await threadsJson('/r/Cameronrlewis/repo/pull/7/threads/PRRT_kwDO1/resolve', {}, undefined, sealed)).status, 200);
    assert.equal((await threadsJson('/r/Cameronrlewis/repo/pull/7/threads/bad%20id/resolve', {}, undefined, sealed)).status, 404);
    assert.deepEqual(calls[0], ['https://api.github.com/repos/Cameronrlewis/repo/pulls/7/comments/11/replies', { body: 'done' }]);
    assert.equal(calls[1][0], 'https://api.github.com/graphql');
    assert.match(calls[1][1].query, /resolveReviewThread/);
    assert.deepEqual(calls[1][1].variables, { id: 'PRRT_kwDO1' });
    assert.equal(calls.length, 2);
  } finally { restore(); }
});

test('thread routes explain a missing Pull requests and Contents permissions', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  const restore = mockFetch(async (url) => url === 'https://api.github.com/repos/Cameronrlewis/repo' ? repoOk()
    : new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 }));
  try {
    const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads/11/reply', { text: 'x' }, undefined, sealed);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Pull requests and Contents permissions \(read and write\)/);
  } finally { restore(); }
});

test('artifact PR discovery is best-effort on the framed artifact route', async () => {
  const sealed = await signedIn();
  for (const runData of [{ event: 'pull_request', pull_requests: [{ number: 7 }] }, { event: 'push', pull_requests: [] }, null, 'throw']) {
    const seen = [];
    const restore = mockFetch(async (url) => {
      seen.push(url);
      if (url.endsWith('/repo')) return repoOk();
      if (url.endsWith('/artifacts/44')) return new Response(JSON.stringify({ name: 'kicad-review.html', workflow_run: { id: 123 } }));
      if (runData === 'throw') throw new Error('run unavailable');
      return new Response(JSON.stringify(runData), { status: runData ? 200 : 403 });
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/a/44', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<iframe/);
      assert.equal(seen[2], 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/123');
    } finally { restore(); }
  }
});

test('review list discovers matching PDFs without any additional GitHub call', async () => {
  const sealed = await signedIn();
  for (const enabled of [false, true]) {
    let calls = 0;
    const restore = mockFetch(async (url) => {
      calls++;
      if (url.endsWith('/repo')) return accessibleRepo();
      assert.ok(url.endsWith('/actions/artifacts?per_page=100'));
      return new Response(JSON.stringify({ artifacts: [
        { id: 123, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflow_run: { id: 9 } },
        ...(enabled ? [{ id: 124, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.pdf', workflow_run: { id: 9 } }] : []),
        { id: 125, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.pdf', workflow_run: { id: 10 } },
      ] }));
    });
    try {
      const response = await call('/r/Cameronrlewis/repo', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes('/a/123?pdf=1'), enabled);
      assert.equal(calls, 2);
    } finally { restore(); }
  }
});

test('thread routes retain refreshed session cookies on success and error', async () => {
  const sealed = await signedIn({ e: Date.now() - 1 });
  const restore = mockFetch(async url => {
    if (url.includes('access_token')) return tokenResponse();
    if (url.endsWith('/repo')) return repoOk();
    return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
  });
  try {
    for (const suffix of ['', '/invalid']) {
      const response = await call(`/r/Cameronrlewis/repo/pull/7/threads${suffix}`, { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, suffix ? 404 : 200);
      assert.ok(cookieValue(response, 's'));
    }
  } finally { restore(); }
});

test('thread GraphQL errors never become successful lists or mutations', async () => {
  const sealed = await signedIn();
  for (const type of ['FORBIDDEN', 'NOT_FOUND']) {
    const restore = mockFetch(async url => url.endsWith('/repo') ? repoOk() : new Response(JSON.stringify({ errors: [{ type }] })));
    try {
      for (const action of ['', '/PRRT_1/resolve', '/PRRT_1/unresolve']) {
        const path = '/r/Cameronrlewis/repo/pull/7/threads' + action;
        const response = action ? await threadsJson(path, {}, undefined, sealed) : await call(path, { headers: { Cookie: `s=${sealed}` } });
        assert.equal(response.status, type === 'FORBIDDEN' ? 403 : 502);
        const body = await response.json();
        assert.equal(body.ok, undefined);
        assert.ok(body.error);
        if (type === 'FORBIDDEN') assert.match(body.error, /Pull requests and Contents permissions \(read and write\)/);
      }
    } finally { restore(); }
  }
});

test('thread authentication failures are JSON', async () => {
  const response = await call('/r/Cameronrlewis/repo/pull/7/threads');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Sign in again.' });
  const sealed = await signedIn();
  const restore = mockFetch(async () => new Response('{}', { status: 404 }));
  try {
    const denied = await call('/r/Cameronrlewis/repo/pull/7/threads', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "Can't open this repository." });
  } finally { restore(); }
});

test('thread routes reject non-object JSON and distinguish rate limiting', async () => {
  const sealed = await signedIn(); let posts = 0;
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return repoOk();
    posts++;
    return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  });
  try {
    for (const body of [null, false, 1, 'text', []]) {
      const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads', body, undefined, sealed);
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
    assert.equal(posts, 0);
    const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads/11/reply', { text: 'x' }, undefined, sealed);
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /rate limit/);
  } finally { restore(); }
});


test('thread routes distinguish GitHub secondary rate limits from permission failures', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async url => url.endsWith('/repo') ? repoOk()
    : new Response('{}', { status: 403, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '100' } }));
  try {
    const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads/11/reply', { text: 'x' }, undefined, sealed);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'GitHub rate limit reached. Try again later.' });
  } finally { restore(); }
});

import { threadsClient } from './threads-client.js';

test('review page for a pull request carries the thread composer and config', () => {
  const html = reviewPage({ user: 'u', owner: 'Cameronrlewis', repo: 'repo', id: '123', name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflowRunId: 9, pull: 7 });
  assert.match(html, /href="\/r\/Cameronrlewis\/repo\/pull\/7\/history">History<\/a>/);
  assert.match(html, /<dialog id="thread-composer"/);
  assert.match(html, /<dialog id="thread-view"/);
  assert.match(html, /"threads":"\/r\/Cameronrlewis\/repo\/pull\/7\/threads"/);
  assert.match(html, /"link":"\/r\/Cameronrlewis\/repo\/a\/123"/);
});

test('review page without a pull request offers issues but no thread route', () => {
  const html = reviewPage({ user: 'u', owner: 'Cameronrlewis', repo: 'repo', id: '123', name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflowRunId: 9, pull: null });
  assert.match(html, /"threads":null/);
  assert.match(html, /"issues":"\/r\/Cameronrlewis\/repo\/issues"/);
  assert.doesNotMatch(html, /\/pull\/null\/threads/);
  assert.doesNotMatch(html, />History<\/a>/);
});

test('wrapper accepts report messages only from its own iframe', () => {
  assert.match(threadsClient.toString(), /event\.source === iframe\.contentWindow && !!event\.data && typeof event\.data === 'object'/);
});


test('artifact wrapper discovers PR number and disables thread requests for push runs', async () => {
  const sealed = await signedIn();
  for (const event of ['pull_request', 'push']) {
    const restore = mockFetch(async (url) => {
      if (url.endsWith('/repo')) return accessibleRepo();
      if (url.endsWith('/artifacts/44')) return new Response(JSON.stringify({
        name: 'kicad-review-deadbee-cafebad-pass.html', expired: false, workflow_run: { id: 123 },
      }));
      if (url.endsWith('/actions/runs/123')) return new Response(JSON.stringify({ event, status: 'completed', conclusion: 'failure', pull_requests: [{ number: 7 }] }));
      throw new Error(`unexpected ${url}`);
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/a/44', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Security-Policy'), frameCsp);
      const html = await response.text();
      assert.match(html, /✕ run failure/);
      assert.doesNotMatch(html, /✓ checks passing/);
      if (event === 'pull_request') {
        assert.match(html, /<dialog id="thread-composer"/);
        assert.match(html, /"threads":"\/r\/Cameronrlewis\/repo\/pull\/7\/threads"/);
      } else { assert.match(html, /"threads":null/); assert.match(html, /"issues":"\/r\/Cameronrlewis\/repo\/issues"/); }
    } finally { restore(); }
  }
});


const shareBlob = 'https://productionresultssa0.blob.core.windows.net/review';
function guestFetch({ generation = '2', genStatus = 200, metadata = shareMeta(), location = shareBlob, unexpected } = {}) {
  return mockFetch(async (url, options = {}) => {
    assert.doesNotMatch(url, /\/s\//, 'share capability must not be forwarded upstream');
    if (url.endsWith('/installation')) return shareJson({ id: 7 });
    if (url.endsWith('/access_tokens')) {
      assert.deepEqual(JSON.parse(options.body), { repositories: ['repo'], permissions: { actions: 'read', actions_variables: 'read' } });
      return shareJson({ token: 'installation-secret' }, 201);
    }
    if (url.endsWith('/KICAD_REVIEW_SHARE_GEN')) return shareJson({ value: generation }, genStatus);
    if (url.endsWith('/actions/artifacts/123')) return shareJson(metadata);
    if (url.endsWith('/actions/artifacts/123/zip')) return new Response(null, { status: 302, headers: { Location: location } });
    if (url === shareBlob) { assert.equal(options.headers, undefined); assert.equal(options.redirect, 'manual'); return new Response('<html>report</html>'); }
    if (unexpected) { unexpected(url); return new Response('<html>unsafe report</html>'); }
    throw new Error(`Unexpected guest URL: ${url}`);
  });
}
async function guestToken(patch = {}) {
  const { signShare } = await import('./share.js');
  return signShare({ o: 'Cameronrlewis', r: 'repo', a: 123, exp: Date.now() + 3600_000, g: 2, ...patch }, appEnv);
}
function guestSecurity(response) {
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Set-Cookie'), null);
}
test('guest report streams only signed artifact sandboxed without exposing GitHub credentials or navigation', async () => {
  const token = await guestToken(); const restore = guestFetch();
  try {
    const raw = await worker.fetch(request(`/s/${token}/raw`, { headers: { 'Sec-Fetch-Dest': 'iframe' } }), appEnv);
    assert.equal(raw.status, 200); assert.equal(await raw.text(), '<html>report</html>'); guestSecurity(raw);
    assert.equal(raw.headers.get('Content-Security-Policy'), reportCsp);
    const response = await worker.fetch(request(`/s/${token}`), appEnv); const html = await response.text();
    assert.equal(response.status, 200); guestSecurity(response);
    assert.match(html, /Read-only shared review/); assert.ok(html.includes(`src="/s/${token}/raw"`));
    assert.match(html, /sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"/);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.doesNotMatch(html, /Sign out|All reviews|href="\/"|thread-composer|installation-secret|user-token|PRIVATE KEY/);
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  } finally { restore(); }
});
test('revoked, expired, non-allowlisted and changed-owner guest links refuse access', async () => {
  const token = await guestToken();
  for (const settings of [{ generation: '3' }, { generation: 'garbage' }, { genStatus: 403 }, { genStatus: 500 }, { metadata: { ...shareMeta(), expired: true } }, { metadata: shareMeta('bad') }, { metadata: { ...shareMeta(), name: 'other.html' } }]) {
    const restore = guestFetch(settings);
    try { const response = await worker.fetch(request(`/s/${token}/raw`, { headers: { 'Sec-Fetch-Dest': 'iframe' } }), appEnv); assert.equal(response.status, 404); guestSecurity(response); }
    finally { restore(); }
  }
  let calls = 0; const restore = mockFetch(async () => { calls++; throw new Error('must not fetch'); });
  try {
    for (const [t, config] of [[await guestToken({ exp: Date.now() - 1 }), appEnv], [await guestToken({ o: 'Other' }), appEnv], [token, { ...appEnv, ALLOWED_OWNERS: 'Other' }], [token + 'x', appEnv]]) {
      assert.equal((await worker.fetch(request(`/s/${t}`), config)).status, 404);
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});
test('guest raw document or unspecified navigation redirects to wrapper; token grants no other routes', async () => {
  const token = await guestToken(); let calls = 0; const restore = mockFetch(async () => { calls++; throw new Error('must not fetch'); });
  try {
    for (const headers of [{ 'Sec-Fetch-Dest': 'document' }, {}]) {
      const response = await worker.fetch(request(`/s/${token}/raw`, { headers }), appEnv);
      assert.equal(response.status, 302); assert.equal(response.headers.get('Location'), `/s/${token}`); guestSecurity(response);
    }
    assert.equal((await worker.fetch(request(`/s/${token}/a/124`), appEnv)).status, 404);
    const existing = await worker.fetch(request(`/r/Cameronrlewis/repo/a/124?share=${token}`), appEnv);
    assert.equal(existing.status, 302); assert.match(existing.headers.get('Location'), /^\/login/);
    assert.equal(calls, 0);
  } finally { restore(); }
});
test('guest refuses insecure or unrelated artifact download URLs and fails closed on network errors', async () => {
  const token = await guestToken();
  for (const location of ['http://productionresultssa0.blob.core.windows.net/review', 'https://evil.example/x', 'https://user:secret@productionresultssa0.blob.core.windows.net/x', 'https://productionresultssa0.blob.core.windows.net.evil.example/x', 'https://productionresultssa0.blob.core.windows.net:444/x']) {
    let followed = 0;
    const restore = guestFetch({ location, unexpected: () => { followed++; } });
    try {
      assert.equal((await worker.fetch(request(`/s/${token}/raw`, { headers: { 'Sec-Fetch-Dest': 'iframe' } }), appEnv)).status, 404);
      assert.equal(followed, 0, 'unsafe storage URL must not be fetched, even if it would serve HTML');
    }
    finally { restore(); }
  }
  const restore = mockFetch(async () => { throw new Error('upstream unavailable'); });
  try { const response = await worker.fetch(request(`/s/${token}`), appEnv); assert.equal(response.status, 404); guestSecurity(response); }
  finally { restore(); }
});
test('revoke is writer-only, validates POST and persists a fresh repository-scoped generation', async () => {
  let generation = '2'; let patches = 0; const minted = [];
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://github.com/login/oauth/access_token') return tokenResponse();
    if (url.endsWith('/repo')) return shareJson({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: true } });
    if (url.endsWith('/installation')) return shareJson({ id: 7 });
    if (url.endsWith('/access_tokens')) { minted.push(JSON.parse(options.body)); return shareJson({ token: 'installation-secret' }, 201); }
    assert.ok(url.endsWith('/actions/variables/KICAD_REVIEW_SHARE_GEN'));
    if (options.method === 'PATCH') { patches++; generation = JSON.parse(options.body).value; return new Response(null, { status: 204 }); }
    return shareJson({ value: generation });
  });
  try {
    for (const [headers, status] of [[{ Origin: 'https://evil.example' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) {
      const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/share/revoke', {}, headers, await signedIn({ e: Date.now() - 1 })), appEnv);
      assert.equal(response.status, status); assert.ok((await response.json()).error); assert.equal(cookieValue(response, 's'), undefined);
    }
    assert.equal(patches, 0);
    const old = generation;
    for (let i = 0; i < 2; i++) {
      const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/share/revoke', {}, {}, await signedIn({ e: Date.now() - 1 })), appEnv);
      assert.equal(response.status, 200); checkSecurity(response); assert.ok(cookieValue(response, 's'));
      const result = await response.json(); assert.equal(String(result.generation), generation); assert.notEqual(generation, old);
    }
    assert.equal(patches, 2);
    for (const body of minted) assert.deepEqual(body, { repositories: ['repo'], permissions: { actions_variables: 'write' } });
  } finally { restore(); }
  const restoreReader = shareCreationFetch({ push: false });
  try { const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/share/revoke'), appEnv); assert.equal(response.status, 403); assert.ok((await response.json()).error); }
  finally { restoreReader(); }
});
test('missing share secrets keep existing review HTML byte-identical and guest routes inactive', async () => {
  const props = { user: 'octocat', owner: 'Cameronrlewis', repo: 'repo', id: '123', name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' };
  const current = reviewPage({ ...props, share: false }).replace(/<style>[\s\S]*?<\/style>/, '<style>\n</style>')
    // Shared theme script and toggle (Stage 1) are normalized out of the pinned digest.
    .replace(/<script>\(\(\) => \{\n  const root[\s\S]*?<\/script>/, '').replace(/<button type="button" class="btn theme-toggle"[\s\S]*?<\/button>/, '').replace(/<svg width="0"[\s\S]*?<\/svg>\s*(?=<header)/, '');
  // Fixed digest of merged issue-links HTML with styles normalized, not a moving HEAD fixture.
  assert.equal(createHash('sha256').update(current).digest('hex'), '82be67bc0030511bc6cca251252770b78a742053b98f7e08d74ba0e027824daa');
  const restore = shareCreationFetch();
  try {
    const cookie = await signedIn();
    for (const key of ['SHARE_KEY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']) {
      const config = { ...appEnv, [key]: '' };
      const response = await worker.fetch(request('/r/Cameronrlewis/repo/a/123', { headers: { Cookie: `s=${cookie}` } }), config);
      assert.equal(await response.text(), reviewPage(props));
      assert.equal((await worker.fetch(request(`/s/${await guestToken()}`), config)).status, 404);
      assert.equal((await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share'), config)).status, 404);
      assert.equal((await worker.fetch(await sharePost('/r/Cameronrlewis/repo/share/revoke'), config)).status, 404);
    }
  } finally { restore(); }
});


test('share dialog executes create and revoke JSON POSTs, rejects unsafe URLs and renders errors as text', async () => {
  const props = { user: 'octocat', owner: 'Cameronrlewis', repo: 'repo', id: 123, name: 'kicad-review.html', share: true };
  const html = reviewPage(props);
  assert.match(html, /aria-labelledby="share-title"/);
  assert.match(html, /min="1" max="30" step="1" value="7"/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const elements = Object.fromEntries(['share-dialog', 'share-status', 'share-result', 'share-open', 'share-form', 'share-days', 'share-revoke'].map(id => [id, { textContent: '', value: id === 'share-days' ? '7' : '' }]));
  let opened = false; elements['share-dialog'].showModal = () => { opened = true; };
  let link = 'https://site.example/s/body.signature'; const posts = [];
  runInNewContext(scripts.find(script => script.includes("getElementById('share-dialog')")), { document: { getElementById: id => elements[id] }, location: { origin: 'https://site.example' }, URL, confirm: () => true,
    fetch: async (url, options) => { posts.push([url, options]); return shareJson(url.endsWith('/revoke') ? { generation: 9 } : { url: link, expires: Date.now() + 1000 }); } });
  elements['share-open'].onclick(); assert.equal(opened, true);
  await elements['share-form'].onsubmit({ preventDefault() {} });
  assert.equal(elements['share-result'].value, link);
  assert.equal(posts[0][0], '/r/Cameronrlewis/repo/a/123/share');
  assert.equal(posts[0][1].headers['Content-Type'], 'application/json'); assert.equal(posts[0][1].body, '{"days":7}');
  await elements['share-revoke'].onclick(); assert.equal(posts[1][0], '/r/Cameronrlewis/repo/share/revoke'); assert.equal(posts[1][1].body, '{}');
  assert.equal(elements['share-result'].value, ''); assert.match(elements['share-status'].textContent, /revoked/);
  for (const bad of ['javascript:alert(1)', 'https://evil.example/s/body.signature', 'https://site.example/s/body.signature?leak=1']) {
    link = bad; await elements['share-form'].onsubmit({ preventDefault() {} }); assert.equal(elements['share-result'].value, ''); assert.equal(elements['share-status'].textContent, 'Invalid share link.');
  }
  assert.doesNotMatch(scripts[1], /innerHTML|__name/);
});
test('revoke initializes missing state, old generation-zero links stay revoked and failed writes retain cookie', async () => {
  let generation = null;
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://github.com/login/oauth/access_token') return tokenResponse();
    if (url.endsWith('/repo')) return shareJson({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: true } });
    if (url.endsWith('/installation')) return shareJson({ id: 7 });
    if (url.endsWith('/access_tokens')) return shareJson({ token: 'installation-secret' }, 201);
    if (url.endsWith('/actions/variables') && options.method === 'POST') { const body = JSON.parse(options.body); assert.equal(body.name, 'KICAD_REVIEW_SHARE_GEN'); generation = body.value; return new Response(null, { status: 201 }); }
    assert.ok(url.endsWith('/KICAD_REVIEW_SHARE_GEN'));
    if (options.method === 'PATCH') return new Response(null, { status: generation === null ? 404 : 500 });
    return generation === null ? new Response(null, { status: 404 }) : shareJson({ value: generation });
  });
  try {
    const old = await guestToken({ g: 0 });
    const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/share/revoke'), appEnv); assert.equal(response.status, 200); assert.ok(Number(generation) > 0);
    assert.equal((await worker.fetch(request(`/s/${old}`), appEnv)).status, 404);
    const failed = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/share/revoke', {}, {}, await signedIn({ e: Date.now() - 1 })), appEnv);
    assert.equal(failed.status, 502); assert.ok((await failed.json()).error); assert.ok(cookieValue(failed, 's'));
  } finally { restore(); }
});


test('share default and maximum lifetime are seven and thirty days; only writers see controls', async () => {
  const long = new Date(Date.now() + 90 * 86400_000).toISOString();
  const restore = shareCreationFetch({ metadata: shareMeta(long) });
  try {
    for (const [body, days] of [[{}, 7], [{ days: 30 }, 30]]) {
      const before = Date.now();
      const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/a/123/share', body), appEnv);
      assert.equal(response.status, 201); const { expires } = await response.json();
      assert.ok(expires >= before + days * 86400_000 && expires <= Date.now() + days * 86400_000);
    }
    const page = await worker.fetch(request('/r/Cameronrlewis/repo/a/123', { headers: { Cookie: `s=${await signedIn()}` } }), appEnv);
    assert.match(await page.text(), /id="share-open"/);
    assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  } finally { restore(); }
  const reader = shareCreationFetch({ push: false });
  try { const page = await worker.fetch(request('/r/Cameronrlewis/repo/a/123', { headers: { Cookie: `s=${await signedIn()}` } }), appEnv); assert.doesNotMatch(await page.text(), /id="share-open"|id="share-dialog"/); }
  finally { reader(); }
});
test('missing App permissions cannot mint a capability or serve a guest, and exceptions retain refreshed cookies', async () => {
  const token = await guestToken();
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://github.com/login/oauth/access_token') return tokenResponse();
    if (url.endsWith('/repo')) return shareJson({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: true } });
    if (url.endsWith('/actions/artifacts/123')) return shareJson(shareMeta());
    if (url.endsWith('/installation')) return shareJson({ id: 7 });
    if (url.endsWith('/access_tokens')) return shareJson({ message: 'No permissions' }, 422);
    throw new Error('must not read artifacts with failed installation token');
  });
  try {
    for (const path of ['/r/Cameronrlewis/repo/a/123/share', '/r/Cameronrlewis/repo/share/revoke']) {
      for (const config of [appEnv, { ...appEnv, GITHUB_APP_PRIVATE_KEY: 'bad pem' }]) {
        const response = await worker.fetch(await sharePost(path, {}, {}, await signedIn({ e: Date.now() - 1 })), config);
        assert.equal(response.status, 502); assert.ok((await response.json()).error); assert.ok(cookieValue(response, 's'));
      }
    }
    assert.equal((await worker.fetch(request(`/s/${token}`), appEnv)).status, 404);
  } finally { restore(); }
});


test('malformed guest capabilities fail privately without touching a signed-in session', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls++; throw new Error('guest must not refresh OAuth or contact GitHub'); });
  try {
    const cookie = await signedIn({ e: Date.now() - 1 });
    for (const config of [env, appEnv]) {
      const response = await worker.fetch(request('/s/garbage/raw', { headers: { Cookie: `s=${cookie}`, 'Sec-Fetch-Dest': 'iframe' } }), config);
      assert.equal(response.status, 404); guestSecurity(response); assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8'); assert.equal(await response.text(), sharedNotFoundPage());
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});


test('invalid share POST Origin or JSON type makes no GitHub or OAuth call', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls++; throw new Error('invalid POST must not contact GitHub'); });
  try {
    for (const path of ['/r/Cameronrlewis/repo/a/123/share', '/r/Cameronrlewis/repo/share/revoke']) {
      for (const [headers, expected] of [[{ Origin: 'https://evil.example' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) {
        const response = await worker.fetch(await sharePost(path, {}, headers, await signedIn({ e: Date.now() - 1 })), appEnv);
        assert.equal(response.status, expected); assert.ok((await response.json()).error); checkSecurity(response);
        assert.equal(cookieValue(response, 's'), undefined);
      }
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});
test('two guest views reuse one scoped installation token but always reread revocation state', async () => {
  const config = { ...appEnv, GITHUB_APP_ID: '43' }; const token = await guestToken();
  let minted = 0, generations = 0, generation = '2';
  const restore = mockFetch(async (url, options = {}) => {
    if (url.endsWith('/installation')) return shareJson({ id: 7 });
    if (url.endsWith('/access_tokens')) {
      minted++; assert.deepEqual(JSON.parse(options.body), { repositories: ['repo'], permissions: { actions: 'read', actions_variables: 'read' } });
      return shareJson({ token: 'cached-installation-secret', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if (url.endsWith('/KICAD_REVIEW_SHARE_GEN')) { generations++; return shareJson({ value: generation }); }
    assert.ok(url.endsWith('/actions/artifacts/123')); return shareJson(shareMeta());
  });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(request(`/s/${token}`), config)).status, 200);
    assert.equal(minted, 1); assert.equal(generations, 2);
    generation = '3'; assert.equal((await worker.fetch(request(`/s/${token}`), config)).status, 404);
    assert.equal(minted, 1); assert.equal(generations, 3);
  } finally { restore(); }
});
test('installation token cache isolates installation, repository, App and permission scope and refreshes five minutes early', async () => {
  const { installationToken } = await import('./share.js'); const config = { ...appEnv, GITHUB_APP_ID: '44' };
  const read = { actions: 'read', actions_variables: 'read' }; let installation = 8, minted = 0;
  const originalNow = Date.now; let now = originalNow();
  const restore = mockFetch(async (url, options = {}) => {
    if (url.endsWith('/installation')) return shareJson({ id: installation });
    assert.ok(url.endsWith('/access_tokens')); minted++;
    return shareJson({ token: `cached-${minted}`, expires_at: new Date(now + 3600_000).toISOString() }, 201);
  });
  Date.now = () => now;
  try {
    assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', read), 'cached-1');
    assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', { actions_variables: 'read', actions: 'read' }), 'cached-1');
    assert.equal(await installationToken(config, 'Cameronrlewis', 'other', read), 'cached-2');
    assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', { actions_variables: 'write' }), 'cached-3');
    installation = 9; assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', read), 'cached-4');
    assert.equal(await installationToken({ ...config, GITHUB_APP_ID: '45' }, 'Cameronrlewis', 'repo', read), 'cached-5');
    now += 55 * 60_000;
    assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', read), 'cached-6');
    assert.equal(minted, 6);
  } finally { Date.now = originalNow; restore(); }
});


test('worker main named exports are functions or handlers, never CSP strings', async () => {
  const exports = await import('./worker.js');
  assert.equal(typeof exports.default.fetch, 'function');
  for (const [name, value] of Object.entries(exports)) {
    if (name === 'default') continue;
    assert.ok(typeof value === 'function' || typeof value?.fetch === 'function', `${name} is not a workerd-compatible entrypoint`);
  }
});

test('serialized thread client has no bundler name helpers and notice is in review bar', () => {
  assert.doesNotMatch(threadsClient.toString(), /__name/);
  assert.match(readFileSync('site/wrangler.toml', 'utf8'), /^keep_names = false$/m);
  const html = reviewPage({ owner: 'Cameronrlewis', repo: 'repo', id: '123', pull: 7 });
  assert.match(html, /class="review-bar">[^]*?id="thread-notice"[^]*?<\/div><div class="review-stage">/);
});

test('thread client contains load failures, clears notice, and guards vanished threads', async () => {
  const listeners = {}, notice = { textContent: '' }, sent = [];
  const node = () => ({ textContent: '', value: '', closest() { return this; }, replaceChildren() {}, append() {}, querySelectorAll() { return []; }, addEventListener(type, fn) { this[type] = fn; } });
  const dialog = () => {
    const nodes = {};
    return { open: false, querySelector(s) { return nodes[s] ||= node(); }, showModal() { this.open = true; }, close() { this.open = false; } };
  };
  const composer = dialog(), view = dialog(), iframe = { contentWindow: { postMessage(data) { sent.push(data); } } };
  let response = () => Promise.reject(new Error('offline')), posts = 0;
  runInNewContext(`(${threadsClient.toString()})({ threads: '/threads', link: '/review' })`, {
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: { dispatchEvent(event) { assert.equal(event.type, 'kicad-review-threads-changed'); }, getElementById(id) { return { 'review-report': iframe, 'thread-composer': composer, 'thread-view': view, 'thread-notice': notice }[id]; }, createElement: node },
    addEventListener(type, fn) { listeners[type] = fn; },
    fetch: async (url, options) => { if (options) {
      posts++; assert.equal(JSON.parse(options.body).link, '/review#v=board&x=1&y=2'); return { ok: true };
    } return response(); },
    URLSearchParams, FormData: class { get() { return 'text'; } }, location: { hash: '' },
  });
  const message = data => listeners.message({ source: iframe.contentWindow, data });
  message({ kicadReviewReady: true, threads: true });
  const pin = { kicadReviewPin: { file: 'board.kicad_pcb', x: 1, y: 2 } };
  listeners.message({ source: {}, data: pin }); assert.equal(composer.open, false);
  for (let i = 0; i < 2; i++) {
    composer.querySelector('[name=severity]').value = 'blocking';
    composer.querySelector('[name=severity]').checked = false;
    composer.querySelector('textarea').value = 'old draft';
    composer.querySelector('[role=status]').textContent = 'old error';
    message(pin);
    assert.equal(composer.open, true);
    assert.equal(composer.querySelector('[name=severity]').value, 'comment');
    assert.equal(composer.querySelector('[name=severity]').checked, true);
    assert.equal(composer.querySelector('textarea').value, '');
    assert.equal(composer.querySelector('[role=status]').textContent, '');
    composer.close();
  }
  const ready = () => message({ kicadReviewReady: true, threads: true });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  ready(); await settle(); assert.equal(notice.textContent, 'Threads could not be loaded.');
  const thread = { id: 'thread', anchor: { ref: 'R1' }, comments: [{ id: 1, body: 'body' }] };
  response = async () => ({ ok: true, json: async () => ({ threads: [thread] }) });
  ready(); await settle(); assert.equal(notice.textContent, ''); assert.equal(sent.length, 1);
  message({ kicadReviewOpenThread: 'thread' }); assert.equal(view.open, true);
  response = async () => ({ ok: true, json: async () => ({ threads: [] }) });
  ready(); await settle();
  await view.querySelector('form').submit({ preventDefault() {}, target: {} });
  assert.equal(view.querySelector('[role=status]').textContent, 'This thread no longer exists.'); assert.equal(posts, 0);
  response = () => Promise.reject(new Error('offline'));
  composer.showModal();
  await composer.querySelector('form').submit({ preventDefault() {}, target: {} });
  assert.equal(composer.open, false); assert.equal(notice.textContent, 'Threads could not be loaded.');
  assert.equal(composer.querySelector('[role=status]').textContent, ''); assert.equal(posts, 1);
});

import { parseIssues } from './issues.js';

test('issues: only anchored, non-PR issues are listed', () => {
  const body = threadBody({ anchor, text: 'move it', link: 'https://s/r' });
  assert.deepEqual(parseIssues([{ number: 3, title: 'J1 placement', html_url: 'https://github.com/o/r/issues/3', body },
    { number: 4, title: 'x', html_url: 'u', body: 'plain' }, { number: 5, title: 'pr', html_url: 'u', body, pull_request: {} }]),
    [{ number: 3, title: 'J1 placement', url: 'https://github.com/o/r/issues/3', anchor, state: 'open' }]);
});

test('creating an issue posts the anchored body and replies in its thread', async () => {
  const sealed = await signedIn();
  const calls = [];
  const restore = mockFetch(async (url, options = {}) => {
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return repoOk();
    if (url.endsWith('/issues?state=open&per_page=100')) return new Response('[]');
    calls.push([url, JSON.parse(options.body || '{}')]);
    if (url.endsWith('/issues')) return new Response(JSON.stringify({ number: 41, html_url: 'https://github.com/Cameronrlewis/repo/issues/41' }), { status: 201 });
    return new Response('{}', { status: 201 });
  });
  try {
    const response = await threadsJson('/r/Cameronrlewis/repo/issues', { anchor, title: 'Move R16 on rev C', text: 'Not this PR', link: '/r/Cameronrlewis/repo/a/1#v=board', pull: 7, threadCommentId: 11 }, undefined, sealed);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { number: 41, url: 'https://github.com/Cameronrlewis/repo/issues/41' });
    assert.equal(calls[0][0], 'https://api.github.com/repos/Cameronrlewis/repo/issues');
    assert.equal(calls[0][1].title, 'Move R16 on rev C');
    assert.deepEqual(parseAnchor(calls[0][1].body), anchor);
    assert.deepEqual(calls[1], ['https://api.github.com/repos/Cameronrlewis/repo/pulls/7/comments/11/replies', { body: 'Tracked in #41.' }]);
  } finally { restore(); }
});

test('issues disabled is explained', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => url === 'https://api.github.com/repos/Cameronrlewis/repo' ? repoOk()
    : new Response(JSON.stringify({ message: 'Issues are disabled for this repo' }), { status: 410 }));
  try {
    const response = await threadsJson('/r/Cameronrlewis/repo/issues', { anchor, title: 't', text: 'x', link: '/r/Cameronrlewis/repo/a/1' }, undefined, sealed);
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /Issues are turned off/);
  } finally { restore(); }
});

import { issuesRoute } from './issues.js';
const issueRequest = body => new Request('https://site.example/r/o/r/issues', { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const issueInput = { anchor, title: 'Move it', text: 'later', link: '/r/o/r/a/1', pull: 7, threadCommentId: 11 };
const issueAccess = async () => ({ s: { token: 'user-token', setCookie: 's=refreshed; Secure' }, repo: { permissions: { push: true } } });

test('issue routes reject unsafe input before posting and retain refreshed cookies', async () => {
  let calls = 0;
  for (const body of [null, [], 5, { ...issueInput, title: [] }, { ...issueInput, text: {} }, { ...issueInput, link: '/r/o/r/a/1/../../evil' }, { ...issueInput, link: 'https://evil.example' }, { ...issueInput, pull: -1 }, { ...issueInput, threadCommentId: 1.5 }, { ...issueInput, anchor: { ...anchor, x: null } }]) {
    const response = await issuesRoute(issueRequest(body), {}, { owner: 'o', repo: 'r', rest: '' }, { access: issueAccess, gh: async () => { calls++; throw Error('unexpected'); } });
    assert.equal(response.status, 400);
    assert.match(response.headers.get('Set-Cookie'), /refreshed/);
    assert.ok((await response.json()).error);
  }
  assert.equal(calls, 0);
});

test('issue route exits explain permissions, rate limits and upstream failures with cookies', async () => {
  for (const [status, headers, expected, message] of [[403, {}, 403, /Issues permission.*read and write/], [403, { 'x-ratelimit-remaining': '0' }, 429, /rate limit/], [403, { 'retry-after': '60' }, 429, /rate limit/], [410, {}, 410, /turned off/], [500, {}, 502, /GitHub/]]) {
    for (const request of [new Request('https://site.example/r/o/r/issues'), issueRequest(issueInput)]) {
      const response = await issuesRoute(request, {}, { owner: 'o', repo: 'r', rest: '' }, { access: issueAccess, gh: async () => new Response('{}', { status, headers }) });
      assert.equal(response.status, expected);
      assert.match(response.headers.get('Set-Cookie'), /refreshed/);
      assert.match((await response.json()).error, message);
    }
  }
  const network = await issuesRoute(issueRequest(issueInput), {}, { owner: 'o', repo: 'r', rest: '' }, { access: issueAccess, gh: async () => { throw Error('secret'); } });
  assert.equal(network.status, 502);
  assert.match(network.headers.get('Set-Cookie'), /refreshed/);
  assert.doesNotMatch(await network.text(), /secret/);
});

test('issue reply failure reports successful creation rather than inviting duplicate issues', async () => {
  let calls = 0;
  const response = await issuesRoute(issueRequest(issueInput), {}, { owner: 'o', repo: 'r', rest: '' }, { access: issueAccess, gh: async path => path.includes('?state=open') ? new Response('[]') : ++calls === 1
    ? new Response(JSON.stringify({ number: 41, html_url: 'https://github.com/o/r/issues/41' }), { status: 201 }) : new Response('{}', { status: 403 }) });
  assert.equal(response.status, 201);
  assert.match((await response.json()).warning, /was created.*do not create it again/);
  assert.match(response.headers.get('Set-Cookie'), /refreshed/);
});

test('issue parser ignores closed, malformed and unsafe issue URLs', () => {
  const body = threadBody({ anchor, text: 'x', link: 'https://site.example/r' });
  assert.deepEqual(parseIssues([null, { number: 1, html_url: 'javascript:alert(1)', body }, { number: 2, html_url: 'https://github.com/o/r/issues/2', body, state: 'closed' }, { number: -1, html_url: 'https://github.com/o/r/issues/1', body }]), []);
  assert.deepEqual(parseIssues({ message: 'no' }), []);
});

test('issue routes authenticate before issue API calls and use worker security headers', async () => {
  const unauthenticated = await call('/r/Cameronrlewis/repo/issues');
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error, 'Sign in again.');
  assert.ok(unauthenticated.headers.get('Content-Security-Policy'));
  let calls = 0;
  const restore = mockFetch(async () => { calls++; throw Error('unexpected'); });
  try {
    const response = await threadsJson('/r/Cameronrlewis/repo/issues', issueInput, 'https://evil.example');
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
    const badType = await call('/r/Cameronrlewis/repo/issues', { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/jsonp' }, body: '{}' });
    assert.equal(badType.status, 415);
  } finally { restore(); }
});


test('threads client loads issues and sends them to the report', () => {
  const source = threadsClient.toString();
  assert.match(source, /send\(\{ kicadReviewIssues: /);
  assert.match(source, /kicadReviewIssueFor/);
});


test('issue client is gated, loads independently, resets composer and strips finding title', async () => {
  const listeners = {}, sent = [], calls = [], notice = { textContent: '' };
  const node = () => ({ textContent: '', value: '', hidden: false, disabled: false, required: false, closest() { return this; }, querySelectorAll() { return []; }, replaceChildren() {}, append() {}, addEventListener(type, fn) { this[type] = fn; } });
  const dialog = () => { const nodes = {}; return { open: false, querySelector(s) { return nodes[s] ||= node(); }, showModal() { this.open = true; }, close() { this.open = false; } }; };
  const composer = dialog(), view = dialog(), iframe = { contentWindow: { postMessage(data) { sent.push(data); } } };
  let denied = false, duplicate = false, threadsAllowed = false, values = { title: 'Fix R16', text: 'later' };
  runInNewContext(`(${threadsClient.toString()})({ threads: '/threads', issues: '/issues', pull: 7, link: '/r/o/r/a/1' })`, {
    document: { getElementById(id) { return { 'review-report': iframe, 'thread-composer': composer, 'thread-view': view, 'thread-notice': notice }[id]; }, createElement: node },
    addEventListener(type, fn) { listeners[type] = fn; },
    fetch: async (url, options) => {
      calls.push([url, options]);
      if (options) return duplicate ? { ok: false, status: 409, json: async () => ({ error: 'Already tracked.', url: 'https://github.com/o/r/issues/41' }) }
        : { ok: true, json: async () => ({ number: 41, warning: 'Issue created; reply failed.' }) };
      if (url === '/threads') return threadsAllowed ? { ok: true, json: async () => ({ threads: [{ id: 'T41', anchor, comments: [{ id: 11, author: 'alice', body: 'Move on rev C @alice' }] }] }) } : { ok: false, json: async () => ({ error: 'Threads denied' }) };
      return denied ? { ok: false, json: async () => ({ error: "Issues need the app's Issues permission." }) } : { ok: true, json: async () => ({ issues: [{ number: 1 }] }) };
    },
    URLSearchParams, FormData: class { get(name) { return values[name]; } }, location: { hash: '#p=1&v=sheet%3A%2F&t=checks&x=999&y=888&s=old&l=F_Cu,B_Cu' },
  });
  const message = (data, source = iframe.contentWindow) => listeners.message({ source, data });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  message({ kicadReviewReady: true, threads: false, issues: false }); await settle(); assert.equal(calls.length, 0);
  message({ kicadReviewIssueFor: { ...anchor, title: 'forged' } }, {}); assert.equal(composer.open, false);
  message({ kicadReviewReady: true, threads: true, issues: false }); await settle(); assert.equal(calls.length, 1); assert.equal(calls[0][0], '/threads');
  calls.length = 0;
  message({ kicadReviewReady: true, threads: true, issues: true }); await settle();
  assert.deepEqual(calls.map(c => c[0]), ['/threads', '/issues']);
  assert.equal(sent.at(-1).kicadReviewIssues[0].number, 1); assert.equal(notice.textContent, 'Threads denied');
  composer.querySelector('textarea').value = 'stale thread draft';
  message({ kicadReviewIssueFor: { ...anchor, title: 'Fix R16' } });
  assert.equal(composer.open, true); assert.equal(composer.querySelector('h2').textContent, 'New issue');
  assert.equal(composer.querySelector('textarea').value, ''); assert.equal(composer.querySelector('textarea').required, false);
  const form = composer.querySelector('form'); form.querySelector = () => node();
  await form.submit({ preventDefault() {}, target: form });
  const posted = JSON.parse(calls.find(c => c[1])[1].body);
  assert.equal(posted.anchor.title, undefined); assert.equal(posted.anchor.severity, 'comment'); assert.equal(posted.title, 'Fix R16');
  const linkState = link => Object.fromEntries(new URLSearchParams(link.split('#')[1]));
  assert.deepEqual(linkState(posted.link), { p: '1', t: 'checks', v: 'board', x: String(anchor.x), y: String(anchor.y) });
  assert.equal(posted.pull, 7);
  assert.equal(composer.open, false); assert.equal(notice.textContent, 'Issue created; reply failed.');
  message({ kicadReviewPin: anchor });
  assert.equal(composer.querySelector('h2').textContent, 'New thread'); assert.equal(composer.querySelector('[name=title]').hidden, true);
  assert.equal(composer.querySelector('textarea').value, ''); assert.equal(composer.querySelector('textarea').required, true);
  denied = true;
  message({ kicadReviewReady: true, threads: false, issues: true }); await settle();
  assert.match(notice.textContent, /Issues permission/); assert.equal(sent.at(-1).kicadReviewIssues.length, 0);
  denied = false; threadsAllowed = true;
  message({ kicadReviewReady: true, threads: true, issues: true }); await settle();
  message({ kicadReviewOpenThread: 'T41' }); assert.equal(view.open, true);
  composer.querySelector('textarea').value = 'old finding draft';
  await view.querySelector('form').submit({ preventDefault() {}, target: {}, submitter: { dataset: { act: 'issue' } } });
  assert.equal(view.open, false); assert.equal(composer.open, true);
  assert.equal(composer.querySelector('[name=title]').value, 'R16: Move on rev C @\u200balice');
  assert.equal(composer.querySelector('textarea').value, '');
  await form.submit({ preventDefault() {}, target: form });
  const threadIssue = JSON.parse(calls.filter(c => c[1]).at(-1)[1].body);
  assert.equal(threadIssue.threadCommentId, 11); assert.equal(threadIssue.pull, 7);
  assert.deepEqual(linkState(threadIssue.link), { p: '1', t: 'checks', v: 'board', x: String(anchor.x), y: String(anchor.y) });
  const schematic = { ...anchor, file: 'Thermal_Camera/sub.kicad_sch', sheet: '/sub/', x: 12.5, y: 42 };
  message({ kicadReviewIssueFor: { ...schematic, title: 'Fix sub-sheet' } });
  await form.submit({ preventDefault() {}, target: form });
  assert.deepEqual(linkState(JSON.parse(calls.filter(c => c[1]).at(-1)[1].body).link), { p: '1', t: 'checks', v: 'sheet:/sub/', x: '12.5', y: '42' });
  assert.equal(threadIssue.anchor.uuid, anchor.uuid); assert.equal(threadIssue.anchor.severity, 'comment');
  duplicate = true; calls.length = 0;
  message({ kicadReviewIssueFor: { ...anchor, title: 'Fix R16' } });
  await form.submit({ preventDefault() {}, target: form });
  assert.equal(composer.open, false); assert.equal(notice.textContent, 'Already tracked. https://github.com/o/r/issues/41');
  assert.deepEqual(calls.map(c => [c[0], !!c[1]]), [['/issues', true], ['/threads', false], ['/issues', false]]);
});


test('issue access failures and malformed requests remain JSON with session cookies', async () => {
  const denied = await issuesRoute(new Request('https://site.example/r/o/r/issues'), {}, { owner: 'o', repo: 'r', rest: '' }, {
    access: async () => new Response(null, { status: 302, headers: { 'Set-Cookie': 's=refreshed; Secure' } }), gh: async () => { throw Error('must not call GitHub'); } });
  assert.equal(denied.status, 401); assert.match(denied.headers.get('Set-Cookie'), /refreshed/); assert.equal((await denied.json()).error, 'Sign in again.');
  const request = new Request('https://site.example/r/o/r/issues', { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/json' }, body: '{' });
  const bad = await issuesRoute(request, {}, { owner: 'o', repo: 'r', rest: '' }, { access: issueAccess, gh: async () => { throw Error('must not call GitHub'); } });
  assert.equal(bad.status, 400); assert.match(bad.headers.get('Set-Cookie'), /refreshed/); assert.equal((await bad.json()).error, 'Send JSON');
  const missing = await issuesRoute(new Request('https://site.example/r/o/r/issues/unknown'), {}, { owner: 'o', repo: 'r', rest: '/unknown' }, { access: issueAccess, gh: async () => { throw Error('must not call GitHub'); } });
  assert.equal(missing.status, 404); assert.match(missing.headers.get('Set-Cookie'), /refreshed/);
});


test('issue client for a non-PR review never loads threads even when the report enables them', async () => {
  const listeners = {}, calls = [], sent = [];
  const form = { addEventListener() {} }, button = { addEventListener() {} }, notice = {};
  const dialog = { querySelector(s) { return s === 'form' ? form : button; } };
  const iframe = { contentWindow: { postMessage(data) { sent.push(data); } } };
  runInNewContext(`(${threadsClient.toString()})({ threads: null, issues: '/issues', pull: null, link: '/r/o/r/a/1' })`, {
    document: { getElementById(id) { return { 'review-report': iframe, 'thread-composer': dialog, 'thread-view': dialog, 'thread-notice': notice }[id]; } },
    addEventListener(type, fn) { listeners[type] = fn; }, fetch: async url => { calls.push(url); return { ok: true, json: async () => ({ issues: [] }) }; },
  });
  listeners.message({ source: iframe.contentWindow, data: { kicadReviewReady: true, threads: true, issues: false } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 0);
  listeners.message({ source: iframe.contentWindow, data: { kicadReviewReady: true, threads: true, issues: true } });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['/issues']); assert.equal(sent[0].kicadReviewIssues.length, 0); assert.equal(notice.hidden, true);
});


test('final fixes: issue creation requires repository write access before issue API calls', async () => {
  let calls = 0;
  const response = await issuesRoute(issueRequest(issueInput), {}, { owner: 'o', repo: 'r', rest: '' }, {
    access: async () => ({ s: { token: 'read-token', setCookie: 's=refreshed' }, repo: { permissions: { pull: true, push: false } } }),
    gh: async () => { calls++; return new Response('{}', { status: 201 }); },
  });
  assert.equal(response.status, 403); assert.equal((await response.json()).error, 'You need write access to create issues.');
  assert.equal(calls, 0); assert.match(response.headers.get('Set-Cookie'), /refreshed/);
});

test('final fixes: existing open anchored issue rejects duplicate creation with its URL', async () => {
  const calls = [], existing = { number: 41, title: 'Tracked', html_url: 'https://github.com/o/r/issues/41', state: 'open', body: threadBody({ anchor, text: 'existing', link: 'https://site.example/r/o/r/a/1' }) };
  const response = await issuesRoute(issueRequest(issueInput), {}, { owner: 'o', repo: 'r', rest: '' }, {
    access: async () => ({ s: { token: 'user-token', setCookie: 's=refreshed' }, repo: { permissions: { push: true } } }),
    gh: async (path, token, options) => { calls.push([path, options?.method || 'GET']); return options ? new Response('{}', { status: 201 }) : new Response(JSON.stringify([existing])); },
  });
  assert.equal(response.status, 409); const result = await response.json();
  assert.match(result.error, /already/); assert.equal(result.url, existing.html_url);
  assert.deepEqual(calls, [['/repos/o/r/issues?state=open&per_page=100', 'GET']]); assert.match(response.headers.get('Set-Cookie'), /refreshed/);
});

test('final fixes: user text cannot introduce additional anchor markers', () => {
  const fake = { ...anchor, ref: 'FAKE' }, text = `quoted <!-- kicad-review-anchor ${encodeAnchor(fake)} -->`;
  const body = threadBody({ anchor, text, link: 'https://site.example/r/o/r/a/1' });
  assert.equal((body.match(/<!-- kicad-review-anchor/g) || []).length, 1);
  assert.deepEqual(parseAnchor(body), anchor); assert.equal(parseAnchor(body + '\nnot a trailing marker'), null);
});

test('final fixes: issue links reject unsafe fragment characters', async () => {
  for (const fragment of ['#x=<script>', '#x=a,b', '#x=?', '#x= ', '#x=(a)', '#x=\"']) {
    let calls = 0;
    const response = await issuesRoute(issueRequest({ ...issueInput, link: '/r/o/r/a/1' + fragment }), {}, { owner: 'o', repo: 'r', rest: '' }, {
      access: async () => ({ s: { token: 'user-token' }, repo: { permissions: { push: true } } }),
      gh: async () => { calls++; return new Response('[]'); },
    });
    assert.equal(response.status, 400, fragment); assert.equal(calls, 0);
  }
});

test('final fixes: summary documentation limits touches line to pull-request runs', () => {
  assert.match(readFileSync('README.md', 'utf8'), /On pull-request runs only/);
});


test('final fixes: thread with a tracked reply hides and refuses Create issue', async () => {
  const listeners = {}, node = () => ({ textContent: '', value: '', closest() { return this; }, querySelectorAll() { return []; }, replaceChildren() {}, append() {}, addEventListener(type, fn) { this[type] = fn; } });
  const dialog = () => { const nodes = {}; return { open: false, querySelector(s) { return nodes[s] ||= node(); }, showModal() { this.open = true; }, close() { this.open = false; } }; };
  const composer = dialog(), view = dialog(), iframe = { contentWindow: { postMessage() {} } };
  runInNewContext(`(${threadsClient.toString()})({ threads: '/threads', issues: '/issues' })`, {
    document: { getElementById(id) { return { 'review-report': iframe, 'thread-composer': composer, 'thread-view': view, 'thread-notice': node() }[id]; }, createElement: node },
    addEventListener(type, fn) { listeners[type] = fn; }, fetch: async url => ({ ok: true, json: async () => url === '/threads'
      ? { threads: [{ id: 'T', anchor, comments: [{ id: 11, body: 'original' }, { id: 12, body: 'Tracked in #41.' }] }] } : { issues: [] } }),
  });
  const message = data => listeners.message({ source: iframe.contentWindow, data });
  message({ kicadReviewReady: true, threads: true, issues: true }); await new Promise(resolve => setImmediate(resolve));
  message({ kicadReviewOpenThread: 'T' }); assert.equal(view.querySelector('[data-act=issue]').hidden, true);
  await view.querySelector('form').submit({ preventDefault() {}, target: {}, submitter: { dataset: { act: 'issue' } } });
  assert.equal(composer.open, false);
});

test('report readiness announces the gate only with framed enabled threads', () => {
  const source = readFileSync('ui/review.js', 'utf8');
  const declarations = source.slice(source.indexOf('let THREADS_ON'), source.indexOf('const validThread'));
  for (const framed of [false, true]) for (const enabled of [false, true]) for (const block_merge of [false, true]) {
    const window = {}, parent = framed ? {} : window;
    const message = runInNewContext(`${declarations}\nreadyMessage()`, { window, parent, S: {}, D: { settings: { threads: { enabled, block_merge } } } });
    assert.equal(message.kicadReviewReady, true);
    assert.equal(message.threads, framed && enabled);
    assert.equal(message.blockMerge, framed && enabled && block_merge);
  }
  const html = reviewPage({ owner: 'owner', repo: 'repo', id: '123', pull: 7 });
  assert.match(html, /"rerun":"\/r\/owner\/repo\/pull\/7\/rerun"/);
});

test('thread changes rerun only an announced blocking gate and expose rerun failures', async () => {
  for (const gate of [undefined, false, true]) for (const severity of ['comment', 'blocking']) {
    const listeners = {}, calls = [], notice = { textContent: '', append(link) { this.link = link; } };
    let changes = 0;
    const node = () => ({ textContent: '', closest() { return this; }, buttons: [{ disabled: false }, { disabled: false }], querySelectorAll() { return this.buttons; }, replaceChildren() {}, append() {}, reset() {}, addEventListener(type, fn) { this[type] = fn; } });
    const dialog = () => { const nodes = {}; return { open: false, querySelector(s) { return nodes[s] ||= node(); }, showModal() { this.open = true; }, close() { this.open = false; } }; };
    const composer = dialog(), view = dialog(), iframe = { contentWindow: { postMessage() {} } };
    const thread = { id: 'thread', resolved: false, anchor: { severity }, comments: [{ id: 'comment' }] };
    let failure = null, mutationFails = false;
    runInNewContext(`(${threadsClient.toString()})({ threads: '/threads', rerun: '/rerun', run: '/run/', link: '/review' })`, {
      URLSearchParams,
      CustomEvent: class { constructor(type) { this.type = type; } },
    document: { dispatchEvent(event) { changes++; assert.equal(event.type, 'kicad-review-threads-changed'); }, getElementById(id) { return { 'review-report': iframe, 'thread-composer': composer, 'thread-view': view, 'thread-notice': notice }[id]; }, createElement: node },
      addEventListener(type, fn) { listeners[type] = fn; },
      fetch: async (url, options) => {
        if (options) calls.push({ url, options });
        if (url === '/rerun' && failure === 'offline') throw new Error('offline');
        if (url === '/rerun' && failure) return { ok: false, json: async () => ({ error: failure }) };
        if (options && url !== '/rerun' && mutationFails) return { ok: false, json: async () => ({ error: 'mutation refused' }) };
        return { ok: true, json: async () => ({ threads: [thread], run: 555 }) };
      },
      FormData: class { get(key) { return key === 'severity' ? severity : 'text'; } }, location: { hash: '' },
    });
    const message = data => listeners.message({ source: iframe.contentWindow, data });
    listeners.message({ source: {}, data: { kicadReviewReady: true, threads: true, blockMerge: true } });
    message({ kicadReviewReady: true, threads: true, blockMerge: gate });
    await new Promise(resolve => setImmediate(resolve));
    message({ kicadReviewOpenThread: 'thread' });
    const submit = async (dialog, act) => {
      const form = dialog.querySelector('form');
      const event = { preventDefault() {}, target: { reset() {} }, submitter: { dataset: { act } } };
      const first = form.submit(event);
      if (!mutationFails) assert.ok(form.buttons.every(button => button.disabled));
      await Promise.all([first, form.submit(event)]);
      assert.ok(form.buttons.every(button => !button.disabled));
    };
    const expected = gate === true && severity === 'blocking' ? 1 : 0;
    for (const resolved of [false, true]) {
      thread.resolved = resolved; calls.length = 0;
      await submit(view, 'resolve');
      assert.equal(calls.length, 1 + expected);
      assert.equal(calls[0].url, `/threads/thread/${resolved ? 'unresolve' : 'resolve'}`);
      assert.equal(calls.filter(c => c.url === '/rerun').length, expected);
    }
    calls.length = 0; await submit(view, 'reply');
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/threads/comment/reply');
    message({ kicadReviewPin: { file: 'board.kicad_pcb', x: 1, y: 2 } });
    calls.length = 0; await submit(composer);
    assert.equal(calls.length, 1 + expected);
    assert.equal(calls.filter(c => c.url === '/rerun').length, expected);
    assert.equal(changes, 4);
    if (expected) { assert.match(notice.textContent, /The review is re-running/); assert.equal(notice.link.href, '/run/555'); }
    for (const call of calls.filter(c => c.url === '/rerun')) {
      assert.equal(call.options.method, 'POST'); assert.equal(call.options.headers['Content-Type'], 'application/json'); assert.equal(call.options.body, '{}');
    }
    if (expected) {
      thread.resolved = false;
      for (failure of ['write access required', 'offline']) {
        await submit(view, 'resolve');
        assert.match(view.querySelector('[role=status]').textContent, /Resolved\. The review was not re-run:/);
        assert.match(view.querySelector('[role=status]').textContent, new RegExp(failure));
        message({ kicadReviewPin: { file: 'board.kicad_pcb', x: 1, y: 2 } });
        await submit(composer);
        assert.match(notice.textContent, /Created\. The review was not re-run:/);
        assert.equal(composer.open, false);
      }
    }
    mutationFails = true; calls.length = 0; await submit(view, 'resolve');
    assert.equal(calls.filter(c => c.url === '/rerun').length, 0);
    assert.equal(view.querySelector('[role=status]').textContent, 'mutation refused');
  }
});

import { latestDecisions } from './readiness.js';

test('readiness keeps each reviewer\'s latest decision', () => {
  const head = 'h'.repeat(40);
  const reviews = [
    { user: { login: 'ann' }, state: 'APPROVED', commit_id: head, submitted_at: '2026-10-12T10:00:00Z' },
    { user: { login: 'ann' }, state: 'CHANGES_REQUESTED', commit_id: head, submitted_at: '2026-10-12T11:00:00Z' },
    { user: { login: 'ann' }, state: 'COMMENTED', commit_id: head, submitted_at: '2026-10-12T12:00:00Z' },
    { user: { login: 'bo' }, state: 'APPROVED', commit_id: head, submitted_at: '2026-10-12T09:00:00Z' }];
  assert.deepEqual(latestDecisions(reviews, head), [{ login: 'ann', state: 'CHANGES_REQUESTED', stale: false }, { login: 'bo', state: 'APPROVED', stale: false }]);
});

test('readiness marks approvals on older commits stale', () => {
  assert.deepEqual(latestDecisions([{ user: { login: 'cy' }, state: 'APPROVED', commit_id: 'o'.repeat(40), submitted_at: '2026-10-12T10:00:00Z' }], 'n'.repeat(40)),
    [{ login: 'cy', state: 'APPROVED', stale: true }]);
});

test('readiness route joins the PR, reviews and threads as the user', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  const restore = mockFetch(async (url, options = {}) => {
    assert.equal(options.headers.Authorization, 'Bearer access-secret');
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return repoOk();
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/pulls/7') return new Response(JSON.stringify({ head: { sha: 'n'.repeat(40) }, requested_reviewers: [{ login: 'dee' }] }));
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo/pulls/7/reviews?per_page=100') return new Response(JSON.stringify([{ user: { login: 'cy' }, state: 'APPROVED', commit_id: 'o'.repeat(40), submitted_at: '2026-10-12T10:00:00Z' }]));
    assert.equal(url, 'https://api.github.com/graphql');
    return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { id: 'T', isResolved: false, comments: { nodes: [{ databaseId: 1, body: threadBody({ anchor, text: 'x', link: 'https://s/r' }) }] } }] } } } } }));
  });
  try {
    const response = await call('/r/Cameronrlewis/repo/pull/7/readiness', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { head: 'n'.repeat(40), decisions: [{ login: 'cy', state: 'APPROVED', stale: true }], requested: ['dee'], blocking: 1, open: 1 });
  } finally { restore(); }
});

test('readiness ignores pending reviews and dismissed decisions, independent of input order', () => {
  const review = (login, state, hour) => ({ user: { login }, state, commit_id: 'head', submitted_at: `2026-10-12T${hour}:00:00Z` });
  assert.deepEqual(latestDecisions([review('ann', 'DISMISSED', '12'), review('bo', 'PENDING', '13'),
    review('ann', 'APPROVED', '10'), review('bo', 'APPROVED', '11')], 'head'),
    [{ login: 'bo', state: 'APPROVED', stale: false }]);
});

test('readiness treats GraphQL errors, missing data and unreadable threads as unknown', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  for (const payload of [{ errors: [{ type: 'FORBIDDEN' }] }, { data: { repository: null } }, {},
    { data: { repository: { pullRequest: { reviewThreads: { totalCount: 101, nodes: [] } } } } },
    { data: { repository: { pullRequest: { reviewThreads: { nodes: [null] } } } } }, 'bad JSON', 'http error', 'network error']) {
    const restore = mockFetch(async (url, options = {}) => {
      assert.equal(options.headers.Authorization, 'Bearer access-secret');
      if (url.endsWith('/repo')) return repoOk();
      if (url.endsWith('/pulls/7')) return new Response(JSON.stringify({ head: { sha: 'head' } }));
      if (url.includes('/reviews?')) return new Response('[]');
      if (payload === 'network error') throw new Error('offline');
      return new Response(payload === 'bad JSON' ? '{' : JSON.stringify(payload), { status: payload === 'http error' ? 403 : 200 });
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/pull/7/readiness', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.blocking, null);
      assert.equal(body.open, null);
    } finally { restore(); }
  }
});

test('readiness access failures are JSON and retain access cookies', async () => {
  const response = await call('/r/Cameronrlewis/repo/pull/7/readiness');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Sign in again.' });
  const sealed = await signedIn({ e: Date.now() - 1 });
  const restore = mockFetch(async url => url.includes('access_token') ? tokenResponse() : new Response('{}', { status: 404 }));
  try {
    const denied = await call('/r/Cameronrlewis/repo/pull/7/readiness', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "Can't open this repository." });
    assert.ok(cookieValue(denied, 's'));
  } finally { restore(); }
});

test('readiness retains refreshed cookies on success and GitHub failures', async () => {
  const sealed = await signedIn({ e: Date.now() - 1 });
  for (const status of [200, 403, 429, 502]) {
    const restore = mockFetch(async url => {
      if (url.includes('access_token')) return tokenResponse();
      if (url.endsWith('/repo')) return repoOk();
      if (url.endsWith('/pulls/7')) return new Response(JSON.stringify({ head: { sha: 'head' } }),
        { status: status === 429 ? 403 : status, headers: status === 429 ? { 'retry-after': '60' } : {} });
      if (url.includes('/reviews?')) return new Response('[]');
      return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/pull/7/readiness', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, status);
      assert.ok(cookieValue(response, 's'));
      const body = await response.json();
      if (status === 200) { assert.equal(body.blocking, 0); assert.equal(body.open, 0); }
      else assert.ok(body.error);
    } finally { restore(); }
  }
});

test('readiness rejects missing heads and preserves pull and review error semantics', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  for (const [failure, status, expected] of [['head', 200, 502], ['pull', 404, 404], ['reviews', 404, 404],
    ['pull', 422, 502], ['reviews', 422, 502]]) {
    const restore = mockFetch(async url => {
      if (url.endsWith('/repo')) return repoOk();
      if (url.endsWith('/pulls/7')) return new Response(JSON.stringify(failure === 'head' ? {} : { head: { sha: 'head' } }), { status: failure === 'pull' ? status : 200 });
      if (url.includes('/reviews?')) return new Response('[]', { status: failure === 'reviews' ? status : 200 });
      return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } }));
    });
    try {
      const response = await call('/r/Cameronrlewis/repo/pull/7/readiness', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, expected);
      assert.deepEqual(await response.json(), { error: expected === 404 ? 'Pull request not found.' : 'GitHub did not answer. Try again.' });
    } finally { restore(); }
  }
});

import { readinessClient } from './readiness-client.js';
import { rerunRoute } from './readiness.js';

test('rerun validates callers before access, and selects only this PR head run', async () => {
  const sealed = await signedIn();
  const calls = [];
  const head = 'b'.repeat(40);
  const valid = { id: 555, head_sha: head, event: 'pull_request', repository: { full_name: 'Cameronrlewis/repo' }, pull_requests: [{ number: 7 }] };
  const restore = mockFetch(async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    if (url.endsWith('/repo')) return repoOk();
    if (url.endsWith('/pulls/7')) return new Response(JSON.stringify({ head: { sha: head } }));
    if (url.includes('/workflows/kicad-review.yml/runs?')) {
      assert.match(url, /head_sha=bbbb/); assert.match(url, /event=pull_request/);
      return new Response(JSON.stringify({ total_count: 3, workflow_runs: [{ ...valid, id: 999, pull_requests: [{ number: 8 }] }, { ...valid, id: 888, repository: { full_name: 'other/repo' } }, valid] }));
    }
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/555/rerun');
    return new Response(null, { status: 201 });
  });
  try {
    const path = '/r/Cameronrlewis/repo/pull/7/rerun';
    assert.equal((await threadsJson(path, {}, 'https://evil.example', sealed)).status, 403);
    assert.equal((await call(path, { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'text/plain', Cookie: `s=${sealed}` } })).status, 415);
    assert.equal(calls.length, 0);
    const response = await threadsJson(path, { run: 999 }, undefined, sealed);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, run: 555 });
    assert.equal(calls.at(-1)[1], 'POST');
  } finally { restore(); }
});

test('rerun retains refreshed cookie across errors and success', async () => {
  for (const kind of ['success', 'fork', 'same-repo-empty', 'missing', 'forbidden', 'forbidden-access', 'forbidden-old', 'network', 'wrong-pr', 'no-head']) {
    let posts = 0;
    const response = await rerunRoute(new Request('https://site.example/r/o/r/pull/7/rerun', { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/json' } }), {}, { owner: 'o', repo: 'r', number: 7 }, {
      access: async () => ({ s: { token: 't', setCookie: 's=refreshed' } }),
      gh: async (path, token, options) => {
        if (kind === 'network') throw new Error('offline');
        if (path.includes('/pulls/')) return new Response(JSON.stringify(kind === 'no-head' ? {} : { head: { sha: 'head' } }));
        if (path.includes('/workflows/')) return new Response(JSON.stringify({ workflow_runs: kind === 'missing' ? [] : [{ id: 9, head_sha: 'head', event: 'pull_request', repository: { full_name: 'o/r' }, head_repository: { full_name: kind === 'fork' ? 'fork/r' : 'o/r' }, pull_requests: ['fork', 'same-repo-empty'].includes(kind) ? [] : [{ number: kind === 'wrong-pr' ? 8 : 7 }] }] }));
        posts++; assert.equal(options.method, 'POST');
        return kind.startsWith('forbidden') ? new Response(JSON.stringify({ message: kind === 'forbidden-access' ? 'Resource not accessible by integration' : kind === 'forbidden-old' ? 'Run is older than 30 days' : 'Run is not completed' }), { status: 403 }) : new Response(null, { status: 201 });
      },
    });
    assert.equal(response.headers.get('Set-Cookie'), 's=refreshed');
    const body = await response.json();
    if (['success', 'fork'].includes(kind)) assert.equal(response.status, 201);
    else assert.ok(body.error);
    if (kind === 'forbidden') assert.equal(body.error, 'Run is not completed');
    if (kind === 'forbidden-access') assert.equal(body.error, 'Re-running needs write access to this repository.');
    if (kind === 'forbidden-old') assert.equal(body.error, 'Run is older than 30 days');
    if (['missing', 'wrong-pr', 'same-repo-empty', 'no-head'].includes(kind)) assert.equal(posts, 0);
  }
});

test('PR review page includes serialized readiness before thread notice', () => {
  const args = { user: 'u', owner: 'o', repo: 'r', id: '1', name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflowRunId: 9, pull: 7 };
  const html = reviewPage(args);
  assert.match(html, /<section id="readiness" class="readiness" aria-live="polite">/);
  assert.match(html, /"readiness":"\/r\/o\/r\/pull\/7\/readiness"/);
  assert.match(html, /"reviewHead":"bbbbbbb"/);
  assert.match(reviewPage({ ...args, name: 'unknown' }), /"reviewHead":null/);
  assert.doesNotMatch(reviewPage({ ...args, pull: null }), /id="readiness"/);
  assert.doesNotMatch(readinessClient.toString(), /__name/);
});

test('readiness client handles fresh, stale, unreadable, requested and failed responses', async () => {
  const node = () => ({ children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
  const render = async (body, reviewHead = 'bbbbbbb', status = 200, reject = false) => {
    const panel = node();
    await runInNewContext(`(${readinessClient.toString()})(config)`, { config: { readiness: '/ready', reviewHead }, document: { addEventListener() {}, getElementById: () => panel, createElement: node }, fetch: async () => { if (reject) throw new Error('offline'); return new Response(JSON.stringify(body), { status }); } });
    return panel.children[0].children.map(n => n.textContent).join('\n');
  };
  const data = { head: 'b'.repeat(40), decisions: [], requested: [], blocking: 0, open: 0 };
  assert.match(await render(data), /latest commit/);
  assert.match(await render(data), /none open/);
  const stale = await render({ ...data, head: 'c'.repeat(40), decisions: [{ login: 'u', state: 'APPROVED', stale: true }] });
  assert.match(stale, /✕ stale — This review/); assert.doesNotMatch(stale, /blocking — This review/); assert.match(stale, /out of date/); assert.match(stale, /older commit, stale/);
  const unreadable = await render({ ...data, blocking: null, open: null });
  assert.match(unreadable, /could not be read/); assert.doesNotMatch(unreadable, /none open/);
  assert.match(await render(data, null), /freshness unknown/);
  assert.match(await render({ ...data, requested: ['reviewer'] }), /waiting for reviewer/);
  assert.match(await render({ error: 'denied' }, null, 401), /Sign in again/);
  assert.match(await render({}, null, 200, true), /could not be loaded/);
});

test('review badge uses workflow conclusion, not artifact checks', () => {
  const args = { owner: 'o', repo: 'r', id: 1, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' };
  assert.match(reviewPage({ ...args, runStatus: 'completed', runConclusion: 'failure' }), /✕ run failure/);
  assert.doesNotMatch(reviewPage({ ...args, runStatus: 'completed', runConclusion: 'failure' }), /✓ (?:checks )?passing/);
  assert.match(reviewPage({ ...args, runStatus: 'completed', runConclusion: 'success' }), /✓ run passing/);
  assert.match(reviewPage({ ...args, runStatus: 'in_progress' }), /… run in progress/);
  assert.match(reviewPage(args), /✓ checks passing/);
});

test('readiness reloads on thread mutations and ignores older responses', async () => {
  const panel = { replaceChildren(list) { this.list = list; } }, listeners = {}, pending = [];
  const node = () => ({ children: [], append(...items) { this.children.push(...items); } });
  const initial = runInNewContext(`(${readinessClient.toString()})({ readiness: '/ready', reviewHead: 'bbbbbbb' })`, {
    document: { getElementById: () => panel, createElement: node, addEventListener(type, fn) { listeners[type] = fn; } },
    fetch: () => new Promise(resolve => pending.push(resolve)),
  });
  const data = { head: 'b'.repeat(40), decisions: [], requested: [], blocking: 0, open: 0 };
  pending.shift()(new Response(JSON.stringify(data))); await initial;
  assert.match(panel.list.children[2].textContent, /none open/);
  const older = listeners['kicad-review-threads-changed']();
  const newer = listeners['kicad-review-threads-changed']();
  pending.pop()(new Response(JSON.stringify({ ...data, blocking: 1, open: 1 }))); await newer;
  pending.pop()(new Response(JSON.stringify(data))); await older;
  assert.match(panel.list.children[2].textContent, /1 open/);
  const resolved = listeners['kicad-review-threads-changed']();
  pending.pop()(new Response(JSON.stringify(data))); await resolved;
  assert.match(panel.list.children[2].textContent, /none open/);
});

test('missing artifact points readers to the updated PR comment', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async url => url.endsWith('/repo') ? accessibleRepo() : new Response('{}', { status: 404 }));
  try {
    const response = await call('/r/Cameronrlewis/repo/a/42', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Open the review from the pull request comment/);
  } finally { restore(); }
});

test('every frame carries early shared theme script and a labeled toggle',()=>{
  for(const html of [signedOutPage(),homePage({user:'cam',repositories:[]}),
    messagePage({title:'Error',message:'Unavailable'})]) {
    assert.match(html,/data-theme-toggle/);
    assert.match(html,/kr\.theme/);
    assert.ok(html.indexOf('kr.theme') < html.indexOf('<style>'));
    assert.match(html,/aria-label="Switch to light theme"/);
  }
});

test('site embeds sprite and theme icon without external asset URLs',()=>{
  const html=signedOutPage();
  assert.match(html,/id="kr-theme"/); assert.match(html,/href="#kr-theme"/);
  assert.ok(!html.includes('href="icons/'));
});

test('S2 shell and primitives have dense accessible contracts', () => {
  const html = frame({ title: '<x>', body: '<main>Body</main>' });
  assert.match(html, /data-theme-toggle/);
  assert.match(html, /<header class="top">/);
  assert.match(html, /--toolbar-h/);
  assert.match(html, /--input-border/);
  assert.match(siteBadge('removed', '<bad>'), /−[^<]*&lt;bad&gt;/);
  assert.match(siteBadge('modified'), /status-modified/);
  assert.match(siteTable(['Name'], '<tr><td>R16</td></tr>', 'Parts'), /aria-label="Parts"/);
  assert.match(siteTable(['<b>'], '', 'Empty'), /&lt;b&gt;/);
});

test('S2 share presents read-only access and copy control', () => {
  const html = reviewPage({ owner: 'o', repo: 'r', id: 9, name: 'kicad-review.html', share: true });
  assert.match(html, /id="share-copy" type="button"/);
  assert.match(html, /Read-only access/);
  assert.match(html, /min="1" max="30" step="1" value="7"/);
  assert.match(sharedPage({ token: 'body.signature', name: 'kicad-review.html' }), /Read-only shared review/);
});
test('S2 invalid share page is neutral accessible HTML without identity', async () => {
  const html = sharedNotFoundPage();
  assert.match(html, /Shared review unavailable/);
  assert.match(html, /404/);
  assert.doesNotMatch(html, /Signed in as|class="account"|\/logout|\/login/);
  const restore = mockFetch(async () => { throw new Error('must not call upstream'); });
  try {
    const response = await worker.fetch(request('/s/not-a-capability'), env);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(await response.text(), html);
  } finally { restore(); }
});
test('S2 share copy and duplicate-submit handlers', async () => {
  const html = reviewPage({ owner: 'o', repo: 'r', id: 9, name: 'kicad-review.html', share: true });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(x => x.includes("getElementById('share-dialog')"));
  const mk = () => Object.fromEntries(['share-dialog', 'share-status', 'share-result', 'share-open', 'share-form', 'share-days', 'share-revoke', 'share-copy'].map(id => [id, { textContent: '', value: id === 'share-days' ? '7' : '' }]));
  const run = (clipboard, fetchFn) => {
    const el = mk(), timers = [], calls = [];
    el['share-result'].focus = () => calls.push('focus'); el['share-result'].select = () => calls.push('select');
    runInNewContext(script, { document: { getElementById: id => el[id] }, location: { origin: 'https://site.example' }, URL, confirm: () => true, navigator: { clipboard }, setTimeout: fn => { timers.push(fn); }, fetch: fetchFn });
    return { el, timers, calls };
  };
  const copied = [];
  const ok = run({ writeText: async v => { copied.push(v); } }, async () => shareJson({ url: 'https://site.example/s/body.signature', expires: Date.now() + 1000 }));
  await ok.el['share-form'].onsubmit({ preventDefault() {} });
  await ok.el['share-copy'].onclick();
  assert.deepEqual(copied, ['https://site.example/s/body.signature']);
  assert.equal(ok.el['share-status'].textContent, 'Copied ✓'); assert.notEqual(ok.el['share-copy'].disabled, true);
  ok.timers.forEach(t => t()); assert.equal(ok.el['share-status'].textContent, '');
  const bad = run({ writeText: async () => { throw new Error('denied'); } }, async () => shareJson({ url: 'https://site.example/s/body.signature', expires: Date.now() + 1000 }));
  await bad.el['share-form'].onsubmit({ preventDefault() {} }); await bad.el['share-copy'].onclick();
  assert.match(bad.el['share-status'].textContent, /Copy was blocked/); assert.deepEqual(bad.calls, ['focus', 'select']);
  let posts = 0, release, fail = true;
  const dup = run({}, () => { posts++; return new Promise((res, rej) => { release = () => fail ? rej(new Error('nope')) : res(shareJson({ url: 'https://site.example/s/a.b', expires: 1 })); }); });
  const first = dup.el['share-form'].onsubmit({ preventDefault() {} });
  await dup.el['share-form'].onsubmit({ preventDefault() {} });
  assert.equal(posts, 1); release(); await first;
  const third = dup.el['share-form'].onsubmit({ preventDefault() {} }); assert.equal(posts, 2); fail = false; release(); await third;
});
