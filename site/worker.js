const text = new TextEncoder();
const untext = new TextDecoder();
const securityHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

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
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), text.encode(JSON.stringify(value)));
  return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

export async function open(value, env) {
  try {
    const [ivText, ciphertextText, extra] = value.split('.');
    if (!ivText || !ciphertextText || extra) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64url(ivText) }, await key(env), unbase64url(ciphertextText),
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

function cookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function clear(name) { return cookie(name, '', 0); }

async function sessionCookie(value, env) {
  return cookie('s', await seal(value, env), (value.re - Date.now()) / 1000);
}

async function tokenRequest(env, fields) {
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...fields }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.error || !data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in) || !Number.isFinite(data.refresh_token_expires_in) ? null : data;
  } catch { return null; }
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
  return { login: renewed.u, token: renewed.t, setCookie: await sessionCookie(renewed, env) };
}

function response(body, init = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(body, { ...init, headers });
}

function redirect(location, cookiesToSet = []) {
  const headers = new Headers({ Location: location });
  for (const value of cookiesToSet) headers.append('Set-Cookie', value);
  return response(null, { status: 302, headers });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function nextPath(value) { return value?.startsWith('/') && !value.startsWith('//') ? value : '/'; }

function stateCookie(next) {
  const random = crypto.getRandomValues(new Uint8Array(24));
  return base64url(text.encode(JSON.stringify({ s: base64url(random), n: next })));
}

async function callback(request, env) {
  const url = new URL(request.url);
  const savedState = cookies(request).st;
  const state = url.searchParams.get('state');
  if (!state || !savedState || state !== savedState) return response('Invalid sign-in state', { status: 400, headers: { 'Set-Cookie': clear('st') } });
  let stateData;
  try { stateData = JSON.parse(untext.decode(unbase64url(savedState))); } catch { return response('Invalid sign-in state', { status: 400, headers: { 'Set-Cookie': clear('st') } }); }
  const code = url.searchParams.get('code');
  if (!code) return response('Missing sign-in code', { status: 400, headers: { 'Set-Cookie': clear('st') } });
  const token = await tokenRequest(env, { code });
  if (!token) return response('Sign-in failed', { status: 502, headers: { 'Set-Cookie': clear('st') } });
  const userResponse = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'kicad-review-site', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!userResponse.ok) return response('Sign-in failed', { status: 502, headers: { 'Set-Cookie': clear('st') } });
  const user = await userResponse.json();
  if (!user.login) return response('Sign-in failed', { status: 502, headers: { 'Set-Cookie': clear('st') } });
  const value = {
    t: token.access_token, r: token.refresh_token,
    e: Date.now() + token.expires_in * 1000,
    re: Date.now() + token.refresh_token_expires_in * 1000, u: user.login,
  };
  return redirect(nextPath(stateData.n), [await sessionCookie(value, env), clear('st')]);
}

export default {
  async fetch(request, env) {
    try {
      const allowedOwners = env.ALLOWED_OWNERS;
      void allowedOwners;
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/login') {
        const state = stateCookie(nextPath(url.searchParams.get('next')));
        const authorize = new URL('https://github.com/login/oauth/authorize');
        authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        authorize.searchParams.set('redirect_uri', new URL('/callback', request.url).href);
        authorize.searchParams.set('state', state);
        return redirect(authorize.href, [cookie('st', state, 10 * 60)]);
      }
      if (request.method === 'GET' && url.pathname === '/callback') return await callback(request, env);
      if (request.method === 'POST' && url.pathname === '/logout') return redirect('/', [clear('s')]);
      if (request.method === 'GET' && url.pathname === '/') {
        const stored = cookies(request).s;
        const active = await session(request, env);
        if (!active) return response('<!doctype html><a href="/login">Sign in with GitHub</a>', { headers: { 'Content-Type': 'text/html; charset=utf-8', ...(stored ? { 'Set-Cookie': clear('s') } : {}) } });
        return response(`<!doctype html><p>Signed in as ${escapeHtml(active.login)}</p><form method="post" action="/logout"><button>Sign out</button></form>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...(active.setCookie ? { 'Set-Cookie': active.setCookie } : {}) } });
      }
      return response('Not found', { status: 404 });
    } catch {
      return response('Internal server error', { status: 500 });
    }
  },
};
