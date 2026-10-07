import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { open, seal } from './worker.js';
import { commitsPage, homePage, messagePage, reviewsPage, runPage, signedOutPage } from './pages.js';

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

test('logout and unknown routes carry security headers', async () => {
  assert.equal((await call('/logout', { method: 'POST' })).status, 302);
  assert.equal((await call('/missing')).status, 404);
});

async function signedIn(overrides = {}) {
  return seal({ t: 'user-token', r: 'refresh-token', e: Date.now() + 3_600_000, re: Date.now() + 7_200_000, u: 'octocat', ...overrides }, env);
}

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
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return new Response(JSON.stringify({ permissions: { pull: true } }));
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

const reportCsp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'";

test('artifact route streams the signed blob with the sandbox CSP', async () => {
  const sealed = await signedIn();
  const blobUrl = 'https://signed.example/secret-report';
  const seen = [];
  const restore = mockFetch(async (url, options = {}) => {
    seen.push([url, options]);
    if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return new Response(JSON.stringify({ permissions: { pull: true } }));
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
    const response = await call('/r/Cameronrlewis/repo/a/42', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Security-Policy'), reportCsp);
    assert.equal(response.headers.get('Location'), null);
    assert.equal(await response.text(), '<!doctype html><svg></svg>');
    assert.equal(cookies(response).length, 0);
    assert.equal(seen.length, 4);
  } finally { restore(); }
});

test('artifact redirect URL remains server-side', async () => {
  const sealed = await signedIn();
  const blobUrl = 'https://signed.example/very-secret';
  const restore = mockFetch(async (url) => {
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ permissions: { pull: true } }));
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
    ? new Response(JSON.stringify({ permissions: { pull: true } }))
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
    const response = await call('/r/Cameronrlewis/repo/a/9', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(response.status, 404);
    assert.equal(calls, 1);
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
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ permissions: { pull: true } }));
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
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ permissions: { pull: true } }));
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
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ permissions: { pull: true }, default_branch: 'main' }));
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
    if (url.endsWith('/repo')) return new Response(JSON.stringify({ permissions: { pull: true }, default_branch: 'main' }));
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
  return new Response(JSON.stringify({ permissions: { pull: true }, default_branch: 'main' }));
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
  try { const response = await compareRequest('/r/Cameronrlewis/repo/compare', { base, head }, sealed); const body = await response.text(); assert.equal(response.status, 400); assert.equal(dispatched, false); assert.match(body, /No KiCad files changed between deadbee and cafebab, so there is nothing to review\./); assert.match(body, /docs\/file-0\.md/); assert.match(body, /and 1 more/); } finally { restore(); }
});
test('compare page keeps radios in its server-submitted form and includes in-page checks', () => {
  const page = commitsPage({ user: 'octocat', owner: 'owner', repo: 'repo', branch: 'main', branches: ['main'], tags: [], commits: [{ sha: base, message: 'Board', fullMessage: 'Board\nDetails', author: 'Ada', date: 'today', exactDate: '2025-01-01', review: null }] });
  assert.match(page, /<form method="post" action="\/r\/owner\/repo\/compare" class="compare-form">[\s\S]*name="base"/); assert.match(page, /<script>\(\(\)=>/); assert.match(page, /Head is older than Base\. The review would show the change backwards\./);

});

test('generating review maps queued, rendering, and completed job steps', () => {
  const common = { user: 'octocat', owner: 'Cameronrlewis', repo: 'repo', base: 'deadbeef', head: 'cafebabe', startedAt: '2026-10-07T10:00:00Z' };
  const queued = runPage({ ...common, running: true, status: 'queued', jobs: [] });
  assert.match(queued, /● in progress <span class="spinner"[^>]*><\/span> Waiting to start/);
  const rendering = runPage({ ...common, running: true, status: 'in_progress', jobs: [{ steps: [
    { name: 'Check out repository', status: 'completed', conclusion: 'success' },
    { name: 'Render board', status: 'in_progress', conclusion: null },
  ] }] });
  assert.match(rendering, /✓ done Getting the files/);
  assert.match(rendering, /● in progress <span class="spinner"/);
  const done = runPage({ ...common, running: true, status: 'in_progress', jobs: [{ steps: [
    { name: 'Check out', status: 'completed', conclusion: 'success' },
    { name: 'Render schematic', status: 'completed', conclusion: 'success' },
    { name: 'Build comparison report', status: 'completed', conclusion: 'success' },
    { name: 'Publish report', status: 'completed', conclusion: 'success' },
    { name: 'Cleanup', status: 'completed', conclusion: 'success' },
  ] }] });
  assert.match(done, /✓ done Finishing/);
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
      ? new Response(JSON.stringify({ permissions: { pull: true } }))
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
