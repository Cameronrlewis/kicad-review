import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import worker, { open, seal } from './worker.js';
import { reportCsp, frameCsp } from './csp.js';
import { commitsPage, homePage, messagePage, reviewPage, reviewsPage, runPage, signedOutPage } from './pages.js';

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
    assert.doesNotMatch(body, /<script>/);
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
  assert.equal(frameCsp, "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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
    assert.match(body, /✕ failing/);
    assert.match(body, /https:\/\/github\.com\/Cameronrlewis\/repo\/actions\/runs\/123/);
    assert.match(body, /<iframe[^>]+src="\/r\/Cameronrlewis\/repo\/a\/44\/raw"/);
    assert.match(body, /sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"/);
    assert.doesNotMatch(body, /allow-same-origin/);
    assert.match(body, /event\.source === iframe\.contentWindow/);
    assert.match(body, /kicadReviewHash/);
    assert.deepEqual(seen, [
      'https://api.github.com/repos/Cameronrlewis/repo',
      'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/44',
    ]);
  } finally { restore(); }
});

test('framed artifact page uses legacy review crumbs', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => url.endsWith('/repo') ? accessibleRepo() : new Response(JSON.stringify({ name: 'kicad-review.html', expired: false })));
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

test('completed review redirects to its review artifact', async () => {
  const sealed = await signedIn();
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return accessibleRepo();
    if (url.endsWith('/runs/12')) return new Response(JSON.stringify({ status: 'completed', conclusion: 'success' }));
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/12/artifacts');
    return new Response(JSON.stringify({ artifacts: [{ id: 56, name: 'kicad-review-deadbee-cafebad-pass.html' }] }));
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
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], { document });
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
      assert.deepEqual(JSON.parse(options.body), { repositories: ['repo'], permissions: { actions: 'read', variables: 'read' } });
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


const shareBlob = 'https://productionresultssa0.blob.core.windows.net/review';
function guestFetch({ generation = '2', genStatus = 200, metadata = shareMeta(), location = shareBlob, unexpected } = {}) {
  return mockFetch(async (url, options = {}) => {
    assert.doesNotMatch(url, /\/s\//, 'share capability must not be forwarded upstream');
    if (url.endsWith('/installation')) return shareJson({ id: 7 });
    if (url.endsWith('/access_tokens')) {
      assert.deepEqual(JSON.parse(options.body), { repositories: ['repo'], permissions: { actions: 'read', variables: 'read' } });
      return shareJson({ token: 'installation-secret' }, 201);
    }
    if (url.endsWith('/KICAD_REVIEW_SHARE_GEN')) return shareJson({ value: generation }, genStatus);
    if (url.endsWith('/actions/artifacts/123')) return shareJson(metadata);
    if (url.endsWith('/actions/artifacts/123/zip')) return new Response(null, { status: 302, headers: { Location: location } });
    if (url === shareBlob) { assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error'); return new Response('<html>report</html>'); }
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
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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
    for (const body of minted) assert.deepEqual(body, { repositories: ['repo'], permissions: { variables: 'write' } });
  } finally { restore(); }
  const restoreReader = shareCreationFetch({ push: false });
  try { const response = await worker.fetch(await sharePost('/r/Cameronrlewis/repo/share/revoke'), appEnv); assert.equal(response.status, 403); assert.ok((await response.json()).error); }
  finally { restoreReader(); }
});
test('missing share secrets keep existing review HTML byte-identical and guest routes inactive', async () => {
  const props = { user: 'octocat', owner: 'Cameronrlewis', repo: 'repo', id: '123', name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' };
  const current = reviewPage({ ...props, share: false }).replace(/<style>[\s\S]*?<\/style>/, '<style>\n</style>');
  // Fixed digest of pre-feature HTML with styles normalized, not a moving HEAD fixture.
  assert.equal(createHash('sha256').update(current).digest('hex'), 'c8520051cef46a0258ea3ec7700808e04b3b85fcd98b3a8185f103cac18da306');
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
  runInNewContext(scripts[1], { document: { getElementById: id => elements[id] }, location: { origin: 'https://site.example' }, URL, confirm: () => true,
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
  try { const page = await worker.fetch(request('/r/Cameronrlewis/repo/a/123', { headers: { Cookie: `s=${await signedIn()}` } }), appEnv); assert.doesNotMatch(await page.text(), /share-open|share-dialog/); }
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
      assert.equal(response.status, 404); guestSecurity(response); assert.equal(await response.text(), 'Not found');
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
      minted++; assert.deepEqual(JSON.parse(options.body), { repositories: ['repo'], permissions: { actions: 'read', variables: 'read' } });
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
  const read = { actions: 'read', variables: 'read' }; let installation = 8, minted = 0;
  const originalNow = Date.now; let now = originalNow();
  const restore = mockFetch(async (url, options = {}) => {
    if (url.endsWith('/installation')) return shareJson({ id: installation });
    assert.ok(url.endsWith('/access_tokens')); minted++;
    return shareJson({ token: `cached-${minted}`, expires_at: new Date(now + 3600_000).toISOString() }, 201);
  });
  Date.now = () => now;
  try {
    assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', read), 'cached-1');
    assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', { variables: 'read', actions: 'read' }), 'cached-1');
    assert.equal(await installationToken(config, 'Cameronrlewis', 'other', read), 'cached-2');
    assert.equal(await installationToken(config, 'Cameronrlewis', 'repo', { variables: 'write' }), 'cached-3');
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
