import { escapeHtml, homePage, messagePage, reviewsPage, commitsPage, runPage, signedOutPage } from './pages.js';

const text = new TextEncoder();
const untext = new TextDecoder();
const securityHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
const workflowFile = 'kicad-review.yml';

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function unbase64url(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function key(env) {
  const raw = unbase64url(env.SESSION_KEY);
  if (raw.length !== 32) throw new Error('SESSION_KEY must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(env),
    text.encode(JSON.stringify(value)),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

export async function open(value, env) {
  try {
    const [ivText, ciphertextText, extra] = value.split('.');
    if (!ivText || !ciphertextText || extra) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64url(ivText) },
      await key(env),
      unbase64url(ciphertextText),
    );
    return JSON.parse(untext.decode(plaintext));
  } catch {
    return null;
  }
}

function cookies(request) {
  return Object.fromEntries((request.headers.get('Cookie') || '').split(/;\s*/).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${value}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function clear(name, secure) {
  return cookie(name, '', 0, secure);
}

async function sessionCookie(value, env, secure) {
  return cookie('s', await seal(value, env), (value.re - Date.now()) / 1000, secure);
}

async function tokenRequest(env, fields) {
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        ...fields,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.error || !data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)
      || !Number.isFinite(data.refresh_token_expires_in) ? null : data;
  } catch {
    return null;
  }
}

export async function session(request, env) {
  const stored = cookies(request).s;
  if (!stored) return null;
  const value = await open(stored, env);
  if (!value || !value.t || !value.r || !value.e || !value.re || !value.u) return null;
  if (value.e > Date.now() + 5 * 60_000) return { login: value.u, token: value.t };
  if (value.re <= Date.now()) return null;
  const refreshed = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: value.r });
  if (!refreshed) return null;
  const renewed = {
    t: refreshed.access_token,
    r: refreshed.refresh_token,
    e: Date.now() + refreshed.expires_in * 1000,
    re: Date.now() + refreshed.refresh_token_expires_in * 1000,
    u: value.u,
  };
  return {
    login: renewed.u,
    token: renewed.t,
    setCookie: await sessionCookie(renewed, env, new URL(request.url).protocol === 'https:'),
  };
}

function response(body, init = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(body, { ...init, headers });
}

function redirect(location, cookiesToSet = [], status = 302) {
  const headers = new Headers({ Location: location });
  for (const value of cookiesToSet) headers.append('Set-Cookie', value);
  return response(null, { status, headers });
}

function sessionRedirect(location, status, active) {
  return redirect(location, active?.setCookie ? [active.setCookie] : [], status);
}

function sessionResponse(body, init, active) {
  const headers = new Headers(init?.headers);
  if (active?.setCookie) headers.set('Set-Cookie', active.setCookie);
  return response(body, { ...init, headers });
}

const refusalDetails = [
  "You're signed in as the right GitHub account",
  'The repository owner has installed the KiCad review GitHub App on it',
  'Someone has given you access on GitHub',
];

function errorPage(status, title, message, links = [], active, init = {}, details = [], includeHome = true) {
  const allLinks = includeHome ? [{ href: '/', label: 'Back to repositories' }, ...links] : links;
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  const pageDetails = title === "Can't open this page" ? refusalDetails : details;
  return sessionResponse(messagePage({ title, message, details: pageDetails, links: allLinks, user: active?.login }), { ...init, status, headers }, active);
}

function gh(path, token, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'User-Agent': 'kicad-review-site',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

function allowedOwners(env) {
  return env.ALLOWED_OWNERS.split(',').map((name) => name.trim().toLowerCase());
}

const repositoryName = /^[A-Za-z0-9_.-]{1,100}$/;
export async function access(request, env, owner, repo) {
  const active = await session(request, env);
  if (!active) {
    const url = new URL(request.url);
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  if (!repositoryName.test(owner) || !repositoryName.test(repo)
    || !allowedOwners(env).includes(owner.toLowerCase())) {
    return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
  }
  try {
    const repoResponse = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, active.token);
    const data = repoResponse.status === 200 ? await repoResponse.json() : null;
    if (!data?.permissions?.pull) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
    return { s: active, repo: data };
  } catch {
    return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
  }
}

async function artifactReport(env, owner, repo, id, active) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${id}`;
  try {
    const metadataResponse = await gh(base, active.token);
    if (metadataResponse.status !== 200) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
    const metadata = await metadataResponse.json();
    if (metadata.expired) {
      return errorPage(404, 'Review expired', 'This review has expired — rerun the workflow.',
        [{ href: repoPath(owner, repo), label: 'Back to reviews' }], active);
    }
    if (!metadata.name?.endsWith('.html')) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
    const zipResponse = await gh(`${base}/zip`, active.token, { redirect: 'manual' });
    const location = zipResponse.status === 302 ? zipResponse.headers.get('Location') : null;
    if (!location) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
    const blobResponse = await fetch(location);
    if (!blobResponse.ok || !blobResponse.body) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
    return sessionResponse(blobResponse.body, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; "
          + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'",
      },
    }, active);
  } catch {
    return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
  }
}

const artifactName = /^kicad-review(?:-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail))?\.html$/;
function reviews(artifacts) {
  return (artifacts || []).filter((artifact) => !artifact.expired && artifactName.test(artifact.name || ''))
    .map((artifact) => {
      const match = artifact.name.match(artifactName);
      return {
        ...artifact,
        base: match[1] || '?',
        head: match[2] || '?',
        result: match[3] || '?',
        revisionsRecorded: Boolean(match[1]),
      };
    }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function date(value) {
  return value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '?';
}

function repoPath(owner, repo) {
  return `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function artifactList(owner, repo, token) {
  return gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts?per_page=100`, token);
}

async function home(request, env) {
  const stored = cookies(request).s;
  const active = await session(request, env);
  if (!active) {
    return response(signedOutPage({ sessionEnded: Boolean(stored) }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...(stored ? { 'Set-Cookie': clear('s', new URL(request.url).protocol === 'https:') } : {}),
      },
    });
  }
  let repositories = [];
  try {
    const installationsResponse = await gh('/user/installations', active.token);
    if (installationsResponse.ok) {
      const installations = (await installationsResponse.json()).installations || [];
      const results = await Promise.all(installations.map(async ({ id }) => {
        const list = await gh(`/user/installations/${encodeURIComponent(id)}/repositories?per_page=100`, active.token);
        return list.ok ? (await list.json()).repositories || [] : [];
      }));
      repositories = results.flat().filter((repo) => {
        return allowedOwners(env).includes(String(repo.owner?.login).toLowerCase());
      }).sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')));
    }
  } catch {
    /* Display the installation guidance below. */
  }
  return sessionResponse(homePage({ user: active.login, repositories }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }, active);
}

async function reviewList(request, env, owner, repo, url) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  try {
    const artifactResponse = await artifactList(owner, repo, allowed.s.token);
    const list = artifactResponse.ok ? reviews((await artifactResponse.json()).artifacts) : [];
    return sessionResponse(reviewsPage({
      user: allowed.s.login, owner, repo, started: url?.searchParams.get('started') === '1',
      items: list.map((item) => ({
        id: item.id, date: date(item.created_at), branch: item.workflow_run?.head_branch || '?',
        base: item.revisionsRecorded ? item.base : '—', head: item.revisionsRecorded ? String(item.head).slice(0, 7) : '—',
        result: item.revisionsRecorded ? item.result : 'notrun', legacy: !item.revisionsRecorded,
      })),
    }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  } catch {
    return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], allowed.s);
  }
}

async function commits(request, env, owner, repo, url) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const branch = url.searchParams.get('branch') ?? allowed.repo.default_branch;
  if (!branch || branch.length > 255 || /[\x00-\x1f\x7f]/.test(branch)) {
    return errorPage(404, 'Not found', 'The requested branch is unavailable.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
  }
  try {
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const [branchesResponse, commitsResponse, artifactsResponse] = await Promise.all([
      gh(`${root}/branches?per_page=100`, allowed.s.token),
      gh(`${root}/commits?sha=${encodeURIComponent(branch)}&per_page=50`, allowed.s.token),
      artifactList(owner, repo, allowed.s.token),
    ]);
    if (commitsResponse.status === 404) return errorPage(404, 'Not found', 'The requested branch is unavailable.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
    if (!commitsResponse.ok) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], allowed.s);
    const branches = branchesResponse.ok ? (await branchesResponse.json()) : [];
    const commitList = await commitsResponse.json();
    const reviewList = artifactsResponse.ok ? reviews((await artifactsResponse.json()).artifacts) : [];
    const byHead = new Map(reviewList.filter((item) => item.head !== '?')
      .map((item) => [String(item.head).slice(0, 7), item]));
    return sessionResponse(commitsPage({
      user: allowed.s.login, owner, repo, branch, branches: branches.map((item) => item.name),
      commits: commitList.map((commit) => {
        const sha = String(commit.sha || '');
        return {
          sha, message: String(commit.commit?.message || '').split('\n', 1)[0],
          author: commit.author?.login || commit.commit?.author?.name || '?',
          date: date(commit.commit?.author?.date), review: byHead.get(sha.slice(0, 7))?.id,
        };
      }),
    }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  } catch {
    return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], allowed.s);
  }
}

const commitSha = /^[0-9a-f]{7,40}$/;

async function compare(request, env, owner, repo) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    return errorPage(403, 'Forbidden', 'This request cannot be completed.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }]);
  }
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const form = await request.formData();
  const base = String(form.get('base') || '');
  const head = String(form.get('head') || '');
  if (!commitSha.test(base) || !commitSha.test(head) || base === head) {
    return errorPage(400, 'Choose two different commits', 'Select two different commit SHAs to compare.',
      [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
  }
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const dispatch = await gh(`${root}/actions/workflows/${workflowFile}/dispatches`, allowed.s.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: allowed.repo.default_branch,
        inputs: { base, head },
        return_run_details: true,
      }),
    });
    if (dispatch.status === 204) return sessionRedirect(`${repoPath(owner, repo)}?started=1`, 303, allowed.s);
    if (dispatch.status === 200) {
      const details = await dispatch.json();
      if (details.workflow_run_id) {
        return sessionRedirect(`${repoPath(owner, repo)}/run/${encodeURIComponent(details.workflow_run_id)}`, 303, allowed.s);
      }
    }
    if (dispatch.status === 403 || dispatch.status === 404) {
      return errorPage(403, 'Cannot start review', 'You need write access and the KiCad review workflow.',
        [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
    }
  } catch {
    // Return the generic upstream error below.
  }
  return errorPage(502, 'Could not start the review', 'The review could not be started. Try again later.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
}

function githubRunUrl(run) {
  const url = String(run.html_url || '');
  return url.startsWith('https://github.com/') ? url : '';
}

async function run(request, env, owner, repo, id) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let runData;
  try {
    const runResponse = await gh(`${root}/actions/runs/${id}`, allowed.s.token);
    if (runResponse.status !== 200) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], allowed.s);
    runData = await runResponse.json();
  } catch {
    return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], allowed.s);
  }
  const githubUrl = githubRunUrl(runData);
  if (runData.status !== 'completed') {
    return sessionResponse(runPage({
      user: allowed.s.login, owner, repo, running: true, status: runData.status, githubUrl,
    }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  }
  try {
    const artifactsResponse = await gh(`${root}/actions/runs/${id}/artifacts`, allowed.s.token);
    if (artifactsResponse.status !== 200) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], allowed.s);
    const artifact = reviews((await artifactsResponse.json()).artifacts)[0];
    if (artifact) return sessionRedirect(`${repoPath(owner, repo)}/a/${encodeURIComponent(artifact.id)}`, 302, allowed.s);
  } catch {
    return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], allowed.s);
  }
  const conclusion = runData.conclusion === 'success'
    ? 'No KiCad changes between these commits.'
    : `Review conclusion: ${runData.conclusion}`;
  return sessionResponse(runPage({
    user: allowed.s.login, owner, repo, running: false, conclusion, githubUrl,
  }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
}

function nextPath(value) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function stateCookie(next) {
  const random = crypto.getRandomValues(new Uint8Array(24));
  return base64url(text.encode(JSON.stringify({ s: base64url(random), n: next })));
}

async function callback(request, env) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  const savedState = cookies(request).st;
  const state = url.searchParams.get('state');
  if (!state || !savedState || state !== savedState) {
    return errorPage(400, "Sign-in didn't complete", 'The sign-in link expired or was opened in a different browser.', [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  }
  let stateData;
  try {
    stateData = JSON.parse(untext.decode(unbase64url(savedState)));
  } catch {
    return errorPage(400, "Sign-in didn't complete", 'The sign-in link expired or was opened in a different browser.', [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  }
  const code = url.searchParams.get('code');
  if (!code) return errorPage(400, "Sign-in didn't complete", "GitHub didn't send a sign-in code. You may have cancelled.", [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  const token = await tokenRequest(env, { code });
  if (!token) return errorPage(502, "Sign-in didn't complete", "GitHub didn't accept the sign-in. Try again.", [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  const userResponse = await gh('/user', token.access_token);
  if (!userResponse.ok) return errorPage(502, "Sign-in didn't complete", "GitHub didn't accept the sign-in. Try again.", [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  const user = await userResponse.json();
  if (!user.login) return errorPage(502, "Sign-in didn't complete", "GitHub didn't accept the sign-in. Try again.", [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  const value = {
    t: token.access_token,
    r: token.refresh_token,
    e: Date.now() + token.expires_in * 1000,
    re: Date.now() + token.refresh_token_expires_in * 1000,
    u: user.login,
  };
  return redirect(nextPath(stateData.n), [await sessionCookie(value, env, secure), clear('st', secure)]);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/login') {
        const state = stateCookie(nextPath(url.searchParams.get('next')));
        const authorize = new URL('https://github.com/login/oauth/authorize');
        authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        authorize.searchParams.set('redirect_uri', new URL('/callback', request.url).href);
        authorize.searchParams.set('state', state);
        return redirect(authorize.href, [cookie('st', state, 10 * 60, url.protocol === 'https:')]);
      }
      if (request.method === 'GET' && url.pathname === '/callback') return await callback(request, env);
      if (request.method === 'POST' && url.pathname === '/logout') return redirect('/', [clear('s', url.protocol === 'https:')]);
      if (request.method === 'GET' && url.pathname === '/') return await home(request, env);
      const artifactRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/a\/([^/]+)$/);
      if (request.method === 'GET' && artifactRoute) {
        const [, owner, repo, id] = artifactRoute;
        if (!/^\d{1,20}$/.test(id)) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.");
        const allowed = await access(request, env, owner, repo);
        return allowed instanceof Response ? allowed : artifactReport(env, owner, repo, id, allowed.s);
      }
      const compareRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/compare$/);
      if (request.method === 'POST' && compareRoute) {
        return compare(request, env, compareRoute[1], compareRoute[2]);
      }
      const runRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/run\/([^/]+)$/);
      if (request.method === 'GET' && runRoute) {
        const [, owner, repo, id] = runRoute;
        if (!/^\d{1,20}$/.test(id)) return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.");
        return run(request, env, owner, repo, id);
      }
      const commitsRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/commits$/);
      if (request.method === 'GET' && commitsRoute) {
        return commits(request, env, commitsRoute[1], commitsRoute[2], url);
      }
      const reviewRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)$/);
      if (request.method === 'GET' && reviewRoute) {
        return reviewList(request, env, reviewRoute[1], reviewRoute[2], url);
      }
      return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], await session(request, env));
    } catch {
      return errorPage(500, 'Internal server error', 'Try again later.');
    }
  },
};
