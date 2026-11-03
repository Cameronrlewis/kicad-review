import { escapeHtml } from './pages.js';
import { readBounded } from './mcp-data.js';

// Browser consent for MCP OAuth: account-bound, same-origin, nonce-sealed pending state.
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers } });
const cookieValue = (request, name) => String(request.headers.get('Cookie') || '').split(/;\s*/).find(v => v.startsWith(name + '='))?.slice(name.length + 1) || '';
const pendingCookie = (value, secure) => `mc=${value}; Path=/authorize; HttpOnly; SameSite=Lax; Max-Age=${value ? 600 : 0}${secure ? '; Secure' : ''}`;

export async function consentRoute(request, env, { session, open, seal }) {
  const url = new URL(request.url); if (url.pathname !== '/authorize') return null;
  const headers = { 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const active = await session(request, env);
  if (!active) {
    if (request.method !== 'GET') return json({ error: 'Sign in again' }, 401);
    return new Response(null, { status: 302, headers: { ...headers, Location: '/login?next=' + encodeURIComponent(url.pathname + url.search) } });
  }
  if (request.method === 'GET') {
    if (url.href.length > 8192 || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get('code_challenge') || '')) return json({ error: 'PKCE S256 authorization required' }, 400);
    // The provider throws on unregistered clients/redirects; answer 400, never redirect to an unvalidated URI.
    const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request).catch(() => null);
    const client = auth && await env.OAUTH_PROVIDER.lookupClient(auth.clientId).catch(() => null);
    if (!client || !client.redirectUris?.includes(auth.redirectUri) || auth.scope.length !== 1 || auth.scope[0] !== 'read:design' || url.searchParams.get('resource') !== url.origin + '/mcp') return json({ error: 'Invalid client, redirect, scope, or resource' }, 400);
    const pending = await seal({ auth, login: active.login, nonce: crypto.randomUUID(), exp: Date.now() + 600000 }, env);
    const head = new Headers({ ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    head.append('Set-Cookie', pendingCookie(pending, url.protocol === 'https:'));
    if (active.setCookie) head.append('Set-Cookie', active.setCookie);
    const e = escapeHtml;
    return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Connect your AI assistant</title><main><h1>Connect your AI assistant</h1><p>Signed in as ${e(active.login)}.</p><p>Client: ${e(client.clientName || auth.clientId)}</p><p>Redirect: ${e(auth.redirectUri)}</p><p>Read-only access to reviewed design artifacts in allowed GitHub repositories you can currently read, including private and organization repositories. Your assistant receives the returned design data. No writes or render triggers. Never type your GitHub password into an assistant.</p><p>This connection expires in at most one hour. GitHub access is checked on every tool call.</p><form method="post" action="/authorize"><input type="hidden" name="pending" value="${e(pending)}"><button name="decision" value="allow">Allow read-only access</button><button name="decision" value="deny">Cancel</button></form></main>`, { headers: head });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return json({ error: 'Send form data' }, 415);
  let body;
  try { body = await readBounded(request, 16384); } catch (error) { return error.code === 'TOO_LARGE' ? json({ error: 'Request too large' }, 413) : json({ error: 'Send form data' }, 400); }
  const form = new URLSearchParams(body), pending = form.get('pending'), saved = await open(pending || '', env);
  if (!pending || pending !== cookieValue(request, 'mc') || !saved?.nonce || !(saved.exp > Date.now()) || saved.login !== active.login) return json({ error: 'Consent expired or invalid' }, 403);
  const head = new Headers({ ...headers, 'Set-Cookie': pendingCookie('', url.protocol === 'https:') });
  if (active.setCookie) head.append('Set-Cookie', active.setCookie);
  if (form.get('decision') !== 'allow') {
    // redirectUri was checked against the registered client before it was sealed.
    const back = new URL(saved.auth.redirectUri); back.searchParams.set('error', 'access_denied');
    if (saved.auth.state) back.searchParams.set('state', saved.auth.state);
    if (saved.auth.issuer) back.searchParams.set('iss', saved.auth.issuer);
    head.set('Location', back.href); return new Response(null, { status: 302, headers: head });
  }
  const currentCookie = active.setCookie?.split(';', 1)[0].slice(2) || cookieValue(request, 's');
  const site = await open(currentCookie, env);
  if (!site?.t || site.u !== active.login || !(site.e > Date.now())) return json({ error: 'Sign in again' }, 401);
  const credential = await seal({ t: site.t, u: site.u, e: Math.min(site.e, Date.now() + 3600000) }, env);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: saved.auth, userId: active.login,
    metadata: { label: active.login + ' read-only design access' }, scope: ['read:design'], props: { credential } });
  head.set('Location', redirectTo); return new Response(null, { status: 302, headers: head });
}
