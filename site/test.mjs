import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import worker, { open, seal } from './worker.js';
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
    env: { ...process.env, CHECK_PORT: '9395', CHECK_TIMEOUT: '2000', CHROME: chrome } });
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /FAIL loads sample -> Runtime.evaluate timed out/);
});

test('3D runner reports and bounds one whole check', { skip: spawnSync(chrome, ['--version']).status !== 0 && 'no Chrome' }, () => {
  const page = join(mkdtempSync(join(tmpdir(), 'check-')), 'never-ready.html');
  writeFileSync(page, '<!doctype html><title>Never ready</title>');
  const r = spawnSync(process.execPath, ['ui/check.mjs', 'loads sample', '--page', page], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHECK_PORT: '9396', CHECK_TIMEOUT: '2000', CHECK_WALL_TIMEOUT: '500', CHROME: chrome } });
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

const reportCsp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-ancestors 'self'";
const frameCsp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

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

import { encodeAnchor, parseAnchor, validAnchor, threadBody, threadText, parseThreads } from './threads.js';

const anchor = { v: 1, project: 'Thermal_Camera', file: 'Thermal_Camera/Thermal_Camera.kicad_pcb', sheet: null, layer: 'F.Cu',
  target: 'object', uuid: '0a1b2c3d-0000-4000-8000-000000000001', kind: 'footprint', ref: 'R16', x: 12.3, y: 45.6,
  side: 'head', commit: 'a'.repeat(40), severity: 'blocking' };

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
  assert.equal(threadText(body), text);
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
const repoOk = () => new Response(JSON.stringify({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true }, default_branch: 'main' }));

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

test('thread routes explain a missing Pull requests permission', async () => {
  const sealed = await signedIn({ t: 'access-secret' });
  const restore = mockFetch(async (url) => url === 'https://api.github.com/repos/Cameronrlewis/repo' ? repoOk()
    : new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 }));
  try {
    const response = await threadsJson('/r/Cameronrlewis/repo/pull/7/threads/11/reply', { text: 'x' }, undefined, sealed);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Pull requests permission/);
  } finally { restore(); }
});


test('artifact PR discovery passes only pull-request run numbers to the wrapper', async () => {
  const source = readFileSync('site/worker.js', 'utf8');
  const fn = source.slice(source.indexOf('async function artifactReport('), source.indexOf('const artifactName ='));
  for (const [runData, expected] of [
    [{ event: 'pull_request', pull_requests: [{ number: 7 }] }, 7],
    [{ event: 'push', pull_requests: [{ number: 7 }] }, null],
    [{ event: 'pull_request', pull_requests: [] }, null],
    [{ event: 'pull_request', pull_requests: [{ number: '7' }] }, null],
    [null, null],
  ]) {
    const seen = [];
    const result = await runInNewContext(`(async()=>{${fn}; return artifactReport({}, {}, 'owner', 'repo', 42, { token: 'user-token', login: 'octocat' }, false);})()`, {
      frameCsp, reviewPage: value => value, sessionResponse: value => value,
      gh: async (path, token) => {
        seen.push([path, token]);
        return path.endsWith('/artifacts/42')
          ? new Response(JSON.stringify({ name: 'kicad-review.html', workflow_run: { id: 123 } }))
          : new Response(JSON.stringify(runData), { status: runData ? 200 : 403 });
      },
    });
    assert.equal(result.pull, expected);
    assert.equal(result.workflowRunId, 123);
    assert.deepEqual(seen, [['/repos/owner/repo/actions/artifacts/42', 'user-token'], ['/repos/owner/repo/actions/runs/123', 'user-token']]);
  }
});
