// Read-only, artifact-bound capabilities. No GitHub credential enters a URL or page.
const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64url = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const name = /^[A-Za-z0-9_.-]{1,100}$/;
const maxLife = 30 * 86400_000;
async function hmacKey(env) {
  const bytes = unb64url(env.SHARE_KEY.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''));
  if (bytes.length !== 32) throw new Error('Invalid share key');
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signShare(claims, env) {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  return `${body}.${b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)))}`;
}
export async function verifyShare(token, env, now = Date.now()) {
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 2048) return null;
    const [body, sig] = token.split('.');
    const signature = unb64url(sig);
    if (signature.length !== 32 || b64url(signature) !== sig) return null;
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), signature, enc.encode(body))) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return c && typeof c.o === 'string' && typeof c.r === 'string' && name.test(c.o) && name.test(c.r) && c.o !== '.' && c.o !== '..' && c.r !== '.' && c.r !== '..'
      && Number.isSafeInteger(c.a) && c.a > 0 && Number.isSafeInteger(c.g) && c.g >= 0
      && Number.isSafeInteger(c.exp) && c.exp > now && c.exp <= now + maxLife ? c : null;
  } catch { return null; }
}


export const shareEnabled = env => Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.SHARE_KEY);
export async function appJwt(env, now = Date.now()) {
  const der = Uint8Array.from(atob(env.GITHUB_APP_PRIVATE_KEY.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(now / 1000) - 60;
  const part = value => b64url(enc.encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: String(env.GITHUB_APP_ID), iat, exp: iat + 600 })}`;
  return `${unsigned}.${b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned)))}`;
}
async function asApp(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, { ...init, redirect: 'manual', headers: { ...init.headers,
    Authorization: `Bearer ${await appJwt(env)}`, 'User-Agent': 'kicad-review-site', 'X-GitHub-Api-Version': '2022-11-28' } });
}
// Isolate-local only: no revocation state or share capabilities are cached.
const installationTokens = new Map();
export async function installationToken(env, owner, repo, permissions) {
  const inst = await asApp(env, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
  if (!inst.ok) return null;
  const { id } = await inst.json();
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const now = Date.now();
  for (const [key, entry] of installationTokens) if (entry.until <= now) installationTokens.delete(key);
  const scope = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b));
  const cacheKey = JSON.stringify([String(env.GITHUB_APP_ID), id, owner.toLowerCase(), repo.toLowerCase(), scope]);
  const cached = installationTokens.get(cacheKey);
  if (cached) return cached.token;
  const minted = await asApp(env, `/app/installations/${id}/access_tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: [repo], permissions }) });
  const data = minted.ok ? await minted.json() : null;
  if (typeof data?.token !== 'string' || !data.token) return null;
  const until = Date.parse(data.expires_at) - 5 * 60_000;
  if (Number.isFinite(until) && until > Date.now()) {
    // ponytail: bounded FIFO cache; a full cache only costs another token mint.
    if (installationTokens.size >= 256) installationTokens.delete(installationTokens.keys().next().value);
    installationTokens.set(cacheKey, { token: data.token, until });
  }
  return data.token;
}
export async function shareGeneration(gh, token, owner, repo) {
  const result = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/variables/KICAD_REVIEW_SHARE_GEN`, token, { redirect: 'manual' });
  if (result.status === 404) return 0;
  if (!result.ok) throw new Error('Share state unavailable');
  const { value } = await result.json();
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid share state');
  return Number(value);
}
const reportName = /^kicad-review(?:-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail))?\.html$/;
function validArtifact(artifact, now = Date.now()) {
  return artifact && artifact.expired === false && typeof artifact.name === 'string' && reportName.test(artifact.name)
    && typeof artifact.expires_at === 'string' && Number.isFinite(Date.parse(artifact.expires_at)) && Date.parse(artifact.expires_at) > now;
}
function json(deps, body, status = 200, active) {
  return deps.sessionResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }, active);
}
async function shareAccess(request, env, owner, repo, deps) {
  const allowed = await deps.access(request, env, owner, repo);
  if (allowed instanceof Response) {
    const denied = json(deps, { error: allowed.status === 302 ? 'Sign in required.' : 'Repository unavailable.' }, allowed.status === 302 ? 401 : allowed.status);
    const renewed = allowed.headers.get('Set-Cookie');
    if (renewed) denied.headers.set('Set-Cookie', renewed);
    return denied;
  }
  return allowed;
}
function postError(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return ['Forbidden', 403];
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || '')) return ['Send JSON', 415];
  return null;
}
export async function createShare(request, env, { owner, repo, id }, deps) {
  if (!shareEnabled(env)) return json(deps, { error: 'Share links are not set up.' }, 404);
  const invalid = postError(request);
  if (invalid) return json(deps, { error: invalid[0] }, invalid[1]);
  const allowed = await shareAccess(request, env, owner, repo, deps);
  if (allowed instanceof Response) return allowed;
  const fail = (error, status) => json(deps, { error }, status, allowed.s);
  try {
    if (!allowed.repo.permissions?.push) return fail('Only writers can share reviews.', 403);
    const body = await request.json().catch(() => null);
    if (!body || Array.isArray(body) || typeof body !== 'object') return fail('Send a JSON object.', 400);
    const days = body.days === undefined ? 7 : body.days;
    if (!Number.isInteger(days) || days < 1 || days > 30) return fail('Days must be an integer from 1 to 30.', 400);
    const artifactId = Number(id);
    if (!Number.isSafeInteger(artifactId) || artifactId <= 0) return fail('Review not found.', 404);
    const meta = await deps.gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${artifactId}`, allowed.s.token, { redirect: 'manual' });
    if (!meta.ok) return fail('Review not found.', 404);
    const artifact = await meta.json();
    if (!validArtifact(artifact)) return fail('Review unavailable or expired.', 410);
    const inst = await installationToken(env, owner, repo, { actions: 'read', actions_variables: 'read' });
    if (!inst) return fail('App permissions unavailable.', 502);
    const g = await shareGeneration(deps.gh, inst, owner, repo);
    const exp = Math.min(Date.now() + days * 86400_000, Date.parse(artifact.expires_at));
    if (exp <= Date.now()) return fail('Review expired.', 410);
    const link = await signShare({ o: owner, r: repo, a: artifactId, exp, g }, env);
    return json(deps, { url: `${new URL(request.url).origin}/s/${link}`, expires: exp }, 201, allowed.s);
  } catch { return fail('Share links unavailable. Try again later.', 502); }
}


function guestResponse(deps, body, init = {}) {
  const result = deps.response(body, init);
  result.headers.set('X-Robots-Tag', 'noindex, nofollow');
  result.headers.set('Referrer-Policy', 'no-referrer');
  return result;
}
function downloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com')) ? url.href : null;
  } catch { return null; }
}
export async function serveShare(request, env, token, raw, deps) {
  const missing = () => guestResponse(deps, deps.sharedNotFoundPage(), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': deps.frameCsp } });
  if (!shareEnabled(env)) return missing();
  try {
    const c = await verifyShare(token, env);
    if (!c || !deps.allowedOwners(env).includes(c.o.toLowerCase())) return missing();
    if (raw && request.headers.get('Sec-Fetch-Dest') !== 'iframe') return guestResponse(deps, null, { status: 302, headers: { Location: `/s/${token}` } });
    const inst = await installationToken(env, c.o, c.r, { actions: 'read', actions_variables: 'read' });
    if (!inst || await shareGeneration(deps.gh, inst, c.o, c.r) !== c.g) return missing();
    const base = `/repos/${encodeURIComponent(c.o)}/${encodeURIComponent(c.r)}/actions/artifacts/${c.a}`;
    const meta = await deps.gh(base, inst, { redirect: 'manual' });
    const artifact = meta.ok ? await meta.json() : null;
    if (!validArtifact(artifact)) return missing();
    if (!raw) return guestResponse(deps, deps.sharedPage({ token, name: artifact.name }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': deps.frameCsp } });
    const zip = await deps.gh(`${base}/zip`, inst, { redirect: 'manual' });
    const location = zip.status === 302 ? downloadUrl(zip.headers.get('Location')) : null;
    const blob = location ? await fetch(location, { redirect: 'manual', referrerPolicy: 'no-referrer' }) : null;
    if (!blob?.ok || !blob.body) return missing();
    return guestResponse(deps, blob.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': deps.reportCsp, 'X-Frame-Options': 'SAMEORIGIN' } });
  } catch { return missing(); }
}
export async function revokeShares(request, env, { owner, repo }, deps) {
  if (!shareEnabled(env)) return json(deps, { error: 'Share links are not set up.' }, 404);
  const invalid = postError(request);
  if (invalid) return json(deps, { error: invalid[0] }, invalid[1]);
  const allowed = await shareAccess(request, env, owner, repo, deps);
  if (allowed instanceof Response) return allowed;
  const fail = (error, status) => json(deps, { error }, status, allowed.s);
  try {
    if (!allowed.repo.permissions?.push) return fail('Only writers can revoke share links.', 403);
    const body = await request.json().catch(() => null);
    if (!body || Array.isArray(body) || typeof body !== 'object') return fail('Send a JSON object.', 400);
    const inst = await installationToken(env, owner, repo, { actions_variables: 'write' });
    if (!inst) return fail('App permissions unavailable.', 502);
    const previous = await shareGeneration(deps.gh, inst, owner, repo);
    // ponytail: one opaque generation per repo; a deny-list is needed for single-link revocation.
    let next;
    do { const bytes = crypto.getRandomValues(new Uint32Array(2)); next = (bytes[0] & 0x1fffff) * 4294967296 + bytes[1]; } while (!next || next === previous);
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/variables`;
    const init = { method: 'PATCH', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: String(next) }) };
    let saved = await deps.gh(`${root}/KICAD_REVIEW_SHARE_GEN`, inst, init);
    if (saved.status === 404) saved = await deps.gh(root, inst, { ...init, method: 'POST', body: JSON.stringify({ name: 'KICAD_REVIEW_SHARE_GEN', value: String(next) }) });
    return saved.ok ? json(deps, { generation: next }, 200, allowed.s) : fail('GitHub did not revoke the links.', 502);
  } catch { return fail('Share links unavailable. Try again later.', 502); }
}
