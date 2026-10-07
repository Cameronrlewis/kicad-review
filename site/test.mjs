import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { open, seal } from './worker.js';

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
}
async function call(path, options) {
  const response = await worker.fetch(request(path, options), env);
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
    assert.equal(calls, 1);
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
      assert.equal(await response.text(), 'Not found');
    }
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('review route hides inaccessible repositories behind the same 404', async () => {
  const sealed = await signedIn();
  for (const repoResponse of [new Response('missing', { status: 404 }), new Response('denied', { status: 403 }), new Response(JSON.stringify({ permissions: { pull: false } }))]) {
    const restore = mockFetch(async () => repoResponse);
    try {
      const response = await call('/r/Cameronrlewis/repo', { headers: { Cookie: `s=${sealed}` } });
      assert.equal(response.status, 404);
      assert.equal(await response.text(), 'Not found');
    } finally { restore(); }
  }
});

test('review route shows the repository after a pull-access check and refreshes the session', async () => {
  const sealed = await signedIn({ e: Date.now() - 1 });
  let calls = 0;
  const restore = mockFetch(async (url, options = {}) => {
    calls += 1;
    if (url === 'https://github.com/login/oauth/access_token') return tokenResponse();
    assert.equal(url, 'https://api.github.com/repos/Cameronrlewis/repo');
    assert.equal(options.headers.Authorization, 'Bearer access-secret');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    return new Response(JSON.stringify({ permissions: { pull: true } }));
  });
  try {
    const response = await call('/r/Cameronrlewis/repo', { headers: { Cookie: `s=${sealed}` } });
    assert.equal(calls, 2);
    assert.match(await response.text(), /Reviews for Cameronrlewis\/repo/);
    assert.ok(cookieValue(response, 's'));
  } finally { restore(); }
});

const reportCsp = "sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'";

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
    assert.match(await response.text(), /This review has expired — rerun the workflow/);
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
