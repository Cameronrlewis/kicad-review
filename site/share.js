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
  return fetch(`https://api.github.com${path}`, { ...init, redirect: 'error', headers: { ...init.headers,
    Authorization: `Bearer ${await appJwt(env)}`, 'User-Agent': 'kicad-review-site', 'X-GitHub-Api-Version': '2022-11-28' } });
}
export async function installationToken(env, owner, repo, permissions) {
  const inst = await asApp(env, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
  if (!inst.ok) return null;
  const { id } = await inst.json();
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const minted = await asApp(env, `/app/installations/${id}/access_tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: [repo], permissions }) });
  const value = minted.ok ? (await minted.json()).token : null;
  return typeof value === 'string' && value ? value : null;
}
export async function shareGeneration(gh, token, owner, repo) {
  const result = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/variables/KICAD_REVIEW_SHARE_GEN`, token, { redirect: 'error' });
  if (result.status === 404) return 0;
  if (!result.ok) throw new Error('Share state unavailable');
  const { value } = await result.json();
  if (!/^(0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid share state');
  return Number(value);
}
const reportName = /^kicad-review(?:-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail))?\.html$/;
function validArtifact(artifact, now = Date.now()) {
  return artifact && !artifact.expired && reportName.test(artifact.name || '') && Number.isFinite(Date.parse(artifact.expires_at)) && Date.parse(artifact.expires_at) > now;
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
  const allowed = await shareAccess(request, env, owner, repo, deps);
  if (allowed instanceof Response) return allowed;
  const fail = (error, status) => json(deps, { error }, status, allowed.s);
  try {
    const invalid = postError(request);
    if (invalid) return fail(...invalid);
    if (!allowed.repo.permissions?.push) return fail('Only writers can share reviews.', 403);
    const body = await request.json().catch(() => null);
    if (!body || Array.isArray(body) || typeof body !== 'object') return fail('Send a JSON object.', 400);
    const days = body.days === undefined ? 7 : body.days;
    if (!Number.isInteger(days) || days < 1 || days > 30) return fail('Days must be an integer from 1 to 30.', 400);
    const artifactId = Number(id);
    if (!Number.isSafeInteger(artifactId) || artifactId <= 0) return fail('Review not found.', 404);
    const meta = await deps.gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${artifactId}`, allowed.s.token, { redirect: 'error' });
    if (!meta.ok) return fail('Review not found.', 404);
    const artifact = await meta.json();
    if (!validArtifact(artifact)) return fail('Review unavailable or expired.', 410);
    const inst = await installationToken(env, owner, repo, { actions: 'read', variables: 'read' });
    if (!inst) return fail('App permissions unavailable.', 502);
    const g = await shareGeneration(deps.gh, inst, owner, repo);
    const exp = Math.min(Date.now() + days * 86400_000, Date.parse(artifact.expires_at));
    if (exp <= Date.now()) return fail('Review expired.', 410);
    const link = await signShare({ o: owner, r: repo, a: artifactId, exp, g }, env);
    return json(deps, { url: `${new URL(request.url).origin}/s/${link}`, expires: exp }, 201, allowed.s);
  } catch { return fail('Share links unavailable. Try again later.', 502); }
}
