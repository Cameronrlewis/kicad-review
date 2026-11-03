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

// OAuth policy around the provider: no refresh grants, no refresh tokens, RFC 9728 discovery on both paths.
const OAUTH_PATHS = ['/mcp', '/authorize', '/token', '/register', '/revoke'];
const rejson = (response, body) => { const headers = new Headers(response.headers); headers.delete('Content-Length'); return new Response(JSON.stringify(body), { status: response.status, headers }); };
export async function oauthFetch(request, env, ctx, provider, legacy) {
  const url = new URL(request.url);
  if (!env.OAUTH_KV) return OAUTH_PATHS.includes(url.pathname) || url.pathname.startsWith('/.well-known/') ? json({ error: 'MCP is not configured' }, 503) : legacy.fetch(request, env, ctx);
  if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return json({ resource: url.origin + '/mcp', authorization_servers: [url.origin], scopes_supported: ['read:design'], bearer_methods_supported: ['header'] }, 200, { 'Access-Control-Allow-Origin': '*' });
  if (url.pathname === '/token' && request.method === 'POST') {
    let body;
    try { body = await readBounded(request, 16384); } catch (error) { return error.code === 'TOO_LARGE' ? json({ error: 'invalid_request', error_description: 'Request too large' }, 413) : json({ error: 'invalid_request' }, 400); }
    const form = new URLSearchParams(body), grant = form.get('grant_type');
    // RFC 7009 revocation (no grant_type, a token) shares this endpoint; every other grant except authorization_code is refused.
    if (grant !== 'authorization_code' && !(grant === null && form.get('token'))) return json({ error: 'unsupported_grant_type', error_description: 'Reconnect through browser sign-in; refresh grants are not supported.' }, 400);
    request = new Request(request, { body });
  }
  const response = await provider.fetch(request, env, ctx);
  if (url.pathname === '/token' && response.ok && response.headers.get('Content-Type')?.includes('json')) {
    const body = await response.json(); delete body.refresh_token; return rejson(response, body);
  }
  if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET' && response.ok) {
    const body = await response.json(); body.grant_types_supported = ['authorization_code']; return rejson(response, body);
  }
  if (url.pathname === '/mcp' && response.status === 401) {
    const headers = new Headers(response.headers);
    // Keep the provider's challenge (it carries error="invalid_token"); add discovery only when missing.
    if (!/resource_metadata=/.test(headers.get('WWW-Authenticate') || '')) headers.set('WWW-Authenticate', `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: 401, headers });
  }
  return response;
}
