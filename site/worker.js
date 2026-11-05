import { createShare, serveShare, revokeShares, shareEnabled, downloadUrl } from './share.js';
import { reportCsp, frameCsp } from './csp.js';
import { currentReport, readStoredData, readReportText, MAX_REPORT_BYTES, IMAGE_ASSET_LIMITS, ASSET_3D_LIMITS } from './report-shell.js';
import { reportCache } from './report-cache.js';
import { encode, decode } from './b64.js';
import { verifyReportFamily, reviewListName } from './report-kind.js';
export { readStoredData } from './report-shell.js';
import { deploymentPage, escapeHtml, sharedPage, sharedNotFoundPage, homePage, messagePage, reviewsPage, commitsPage, reviewPage, runPage, signedOutPage, historyPage, stages, stageForStep } from './pages.js';

import { threadsRoute, ghPages } from './threads.js';
import { issuesRoute } from './issues.js';
import { historyRoute } from './history.js';

import { readinessRoute, rerunRoute } from './readiness.js';
import { zipEntries, zipEntryStream } from './zip.js';

const text = new TextEncoder();
const untext = new TextDecoder();
const securityHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
const workflowFile = 'kicad-review.yml';

function unbase64(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function key(env) {
  const raw = decode(env.SESSION_KEY);
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
  return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}

export async function open(value, env) {
  try {
    const [ivText, ciphertextText, extra] = value.split('.');
    if (!ivText || !ciphertextText || extra) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(ivText) },
      await key(env),
      decode(ciphertextText),
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
      redirect: 'manual',  // a 3xx is not ok and fails closed; workerd rejects 'error'
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        ...fields,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.error) return { error: String(data.error) };  // e.g. bad_refresh_token: the token was already used
    return !data?.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)
      || !Number.isFinite(data.refresh_token_expires_in) ? null : data;
  } catch {
    return null;
  }
}

// One object per rotation, named by the SHA-256 of the old refresh token, so racing requests from any
// isolate share one exchange. In memory only: tokens are never stored at rest.
export class RefreshCoordinator {
  constructor(ctx, env) { this.env = env; this.pending = null; this.done = null; }
  async fetch(request) {
    const { r } = await request.json();
    if (this.done?.until > Date.now()) return Response.json(this.done.value);
    if (!this.pending) {
      this.pending = tokenRequest(this.env, { grant_type: 'refresh_token', refresh_token: r }).then((value) => {
        if (value && !value.error) this.done = { value, until: Date.now() + ROTATION_GRACE_MS };
        return value;
      }).finally(() => { this.pending = null; });
    }
    return Response.json(await this.pending);
  }
}

// Exchange directly only without the coordinator (tests, local dev). With it, a lost answer may mean the object
// already spent the one-use token: ask the object once more (it keeps a completed result) and never replay it here.
async function coordinatedRefresh(env, r) {
  if (!env.REFRESH) return tokenRequest(env, { grant_type: 'refresh_token', refresh_token: r });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const name = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(r))));
      const result = await env.REFRESH.get(env.REFRESH.idFromName(name)).fetch('https://refresh/', { method: 'POST', body: JSON.stringify({ r }) });
      if (result.ok) return await result.json();
    } catch {}
  }
  return { error: 'refresh_unavailable' };
}

const refreshing = new Map();
// Late requests still carrying the old cookie reuse a SUCCESSFUL rotation for a short grace window.
// Errors are never kept. ponytail: isolate-local, like `refreshing`.
const rotated = new Map(), ROTATION_GRACE_MS = 30_000;
export async function session(request, env) {
  const active = await currentSession(request, env);
  return active?.error ? null : active;
}

// Like session(), but a failed refresh returns { error } with GitHub's error code instead of null.
async function currentSession(request, env) {
  const stored = cookies(request).s;
  if (!stored) return null;
  const value = await open(stored, env);
  if (!value || !value.t || !value.r || !value.e || !value.re || !value.u) return null;
  if (value.e > Date.now() + 5 * 60_000) return { login: value.u, token: value.t };
  if (value.re <= Date.now()) return null;
  // GitHub refresh tokens are one-use: concurrent requests in this isolate share one rotation.
  // Isolate-local first; across isolates, coordinatedRefresh() shares the rotation through RefreshCoordinator.
  for (const [token, entry] of rotated) if (entry.until <= Date.now()) rotated.delete(token);
  let pending = rotated.get(value.r)?.renewed ?? refreshing.get(value.r);
  if (!pending) {
    pending = coordinatedRefresh(env, value.r).then((refreshed) => {
      if (!refreshed?.access_token) {
        const error = refreshed?.error ?? 'no_response';
        console.warn('session refresh failed:', error);
        return { error };
      }
      const renewed = {
        t: refreshed.access_token,
        r: refreshed.refresh_token,
        e: Date.now() + refreshed.expires_in * 1000,
        re: Date.now() + refreshed.refresh_token_expires_in * 1000,
        u: value.u,
      };
      rotated.set(value.r, { renewed, until: Date.now() + ROTATION_GRACE_MS });
      return renewed;
    }).finally(() => refreshing.delete(value.r));
    refreshing.set(value.r, pending);
  }
  const renewed = await pending;
  if (renewed.error) return renewed;
  if (renewed.u !== value.u) return null;
  return {
    login: renewed.u,
    token: renewed.t,
    setCookie: await sessionCookie(renewed, env, new URL(request.url).protocol === 'https:'),
  };
}

export function response(body, init = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (name !== 'Cache-Control' || !headers.has(name)) headers.set(name, value);
  }
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "frame-ancestors 'none'");
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

export function sessionResponse(body, init, active) {
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
  return sessionResponse(messagePage({ title, message, code: status, details: pageDetails, links: allLinks, user: active?.login }), { ...init, status, headers }, active);
}

function notFound(active) {
  return errorPage(404, "Can't open this page", "Either it doesn't exist, or your GitHub account can't see it.", [], active);
}

export function gh(path, token, init = {}) {
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

export function allowedOwners(env) {
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
    return notFound(active);
  }
  try {
    const repoResponse = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, active.token);
    const data = repoResponse.status === 200 ? await repoResponse.json() : null;
    if (!data?.permissions?.pull || !allowedOwners(env).includes(data.owner.login.toLowerCase())) return notFound(active);
    return { s: active, repo: data };
  } catch {
    return notFound(active);
  }
}

function jsonError(active, message) {
  return sessionResponse(JSON.stringify({ error: message }), { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }, active);
}

function matchingPdf(artifacts, metadata) {
  const name = String(metadata.name || '').replace(/\.html$/, '.pdf');
  return artifacts.find((a) => !a.expired && a.name === name && /^\d{1,20}$/.test(String(a.id))
    && a.workflow_run?.id === metadata.workflow_run?.id);
}

async function pdfArtifact(owner, repo, id, token) {
  try {
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
    const result = await gh(`${root}/artifacts/${id}`, token);
    if (!result.ok) return null;
    const metadata = await result.json();
    if (metadata.expired || !verifyReportFamily('comparison', metadata.name)) return null;
    const runId = metadata.workflow_run?.id;
    if (!/^\d{1,20}$/.test(String(runId))) return null;
    const paged = await ghPages(gh, `${root}/runs/${runId}/artifacts`, token, d => d?.artifacts);
    if (!paged.ok) return null;
    const name = metadata.name.slice(0, -5) + '.pdf';
    return paged.items.find((a) => !a.expired && a.name === name && /^\d{1,20}$/.test(String(a.id))) || null;
  } catch { return null; }
}

async function pdfDownload(owner, repo, id, active) {
  try {
    const artifact = await pdfArtifact(owner, repo, id, active.token);
    if (!artifact) return jsonError(active, 'PDF unavailable');
    const download = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${artifact.id}/zip`, active.token, { redirect: 'manual' });
    if (download.status !== 302) return jsonError(active, 'PDF unavailable');
    const location = new URL(download.headers.get('Location'));
    if (location.protocol !== 'https:' || location.username || location.password) return jsonError(active, 'PDF unavailable');
    const blob = await fetch(location.href, { redirect: 'manual' });
    if (!blob.ok || !blob.body) return jsonError(active, 'PDF unavailable');
    return sessionResponse(blob.body, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${artifact.name}"` } }, active);
  } catch { return jsonError(active, 'PDF unavailable'); }
}

const downloadKinds = { fab: ['application/zip', /\.zip$/], pdf: ['application/pdf', /\.pdf$/], step: ['model/step', /\.step$/], glb: ['model/gltf-binary', /\.glb$/] };
const MAX_ENVELOPE_BYTES = 64 * 1024;

// The run's downloads artifact is one archived zip; read the one entry asked for by byte range, never the whole file.
async function downloadFile(owner, repo, id, index, kind, active) {
  try {
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
    const meta = await gh(`${root}/artifacts/${id}`, active.token);
    if (!meta.ok) return jsonError(active, 'Download unavailable');
    const report = await meta.json(), runId = report.workflow_run?.id, name = String(report.name || '');
    // The report name carries the reviewed head's first 7 characters. The run's head_sha is the reviewed head except
    // for a manual (workflow_dispatch) run, which reviews the head given by hand, not its dispatch ref's tip.
    const runHead = String(report.workflow_run?.head_sha || '');
    const head7 = verifyReportFamily('comparison', name) ? /-([0-9a-f]{7})-(?:pass|fail)\.html$/.exec(name)[1] : /^kicad-design-([0-9a-f]{7})\.html$/.exec(name)?.[1];
    const family = !head7 || !/^[0-9a-f]{40}$/.test(runHead) ? null : verifyReportFamily('comparison', name) ? 'review' : 'design';
    if (report.expired || !family || !/^\d{1,20}$/.test(String(runId))) return jsonError(active, 'Download unavailable');
    const bundleName = `kicad-${family}-downloads-${head7}`;
    // Every page of the run's artifacts is read: 02 adds digest assets, so the bundle can sit past the first 100.
    const paged = await ghPages(gh, `${root}/runs/${runId}/artifacts`, active.token, d => d?.artifacts);
    if (!paged.ok) return jsonError(active, 'Download unavailable');
    const found = paged.items.filter((a) => !a?.expired && a?.name === bundleName && a.workflow_run?.id === runId && /^\d{1,20}$/.test(String(a.id)));
    if (found.length !== 1) return jsonError(active, 'Download unavailable');  // zero, several or unpaged matches are refused
    const bundle = found[0];
    const zip = await gh(`${root}/artifacts/${bundle.id}/zip`, active.token, { redirect: 'manual' });
    if (zip.status !== 302) return jsonError(active, 'Download unavailable');
    const location = new URL(zip.headers.get('Location'));
    if (location.protocol !== 'https:' || location.username || location.password) return jsonError(active, 'Download unavailable');
    // The signed blob URL gets no GitHub token; 'manual' (workerd rejects 'error') plus the 206 checks refuse further redirects.
    const range = (start, end) => fetch(location.href, { redirect: 'manual', headers: { Range: `bytes=${start}-${end}` } });
    const probe = await range(0, 0);
    const total = Number(/^bytes 0-0\/(\d+)$/.exec(probe.headers.get('Content-Range') || '')?.[1]);
    if (probe.status !== 206 || !Number.isSafeInteger(total) || total < 22) { await probe.body?.cancel(); return jsonError(active, 'Download unavailable'); }
    if ((await probe.arrayBuffer()).byteLength !== 1) return jsonError(active, 'Download unavailable');
    const [type, suffix] = downloadKinds[kind];
    const entries = await zipEntries(range, total);  // exactRange inside checks every 206 and Content-Range
    // Full-head provenance: the staged envelope carries the run's reviewed full head (collect_downloads writes it).
    const envelope = entries.find((e) => e.name === `${index}/downloads.json` && e.size <= MAX_ENVELOPE_BYTES && e.bytes <= MAX_ENVELOPE_BYTES);
    if (!envelope) return jsonError(active, 'Download unavailable');
    const manifest = await new Response(await zipEntryStream(range, envelope)).json();
    const head = manifest?.head;
    if (!/^[0-9a-f]{40}$/.test(head) || !head.startsWith(head7) || bundle.workflow_run?.head_sha !== runHead
      || (family === 'design' && !verifyReportFamily('design', name, head))) return jsonError(active, 'Download unavailable');
    if (head !== runHead) {  // only a manual run may review a head other than its run's head_sha
      const run = await gh(`${root}/runs/${runId}`, active.token);
      if (!run.ok || (await run.json()).event !== 'workflow_dispatch') return jsonError(active, 'Download unavailable');
    }
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    const records = files.filter((f) => f && f.kind === kind && !f.error);
    if (records.length !== 1) return jsonError(active, 'Download unavailable');
    const record = records[0];
    const prefix = `${index}/`;
    const recordPath = String(record.path || '');
    if (!recordPath.startsWith(prefix)) return jsonError(active, 'Download unavailable');
    const filename = recordPath.slice(prefix.length);
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(filename) || !suffix.test(filename)) return jsonError(active, 'Download unavailable');
    if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) return jsonError(active, 'Download unavailable');
    const entry = entries.find((e) => e.name === recordPath);
    if (!entry || entry.bytes !== record.bytes) return jsonError(active, 'Download unavailable');
    // Errors after this point (truncation, CRC, length) error the stream; they cannot become a 404.
    return sessionResponse(await zipEntryStream(range, entry), { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"` } }, active);
  } catch { return jsonError(active, 'Download unavailable'); }
}

export function assetFromReport(html, id, kind) {
  return assetFromData(readStoredData(html), id, kind);
}

// Same language as /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/ without its
// per-group backtracking, which overflows the regexp stack on multi-megabyte blobs.
function validBase64(value) {
  const text = value.replace(/\s+/g, '');
  if (/[^A-Za-z0-9+/=]/.test(text)) return false;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  if (text.slice(0, text.length - pad).includes('=')) return false;
  return pad ? text.length % 4 === 0 : text.length % 4 !== 1;
}

function assetFromData(data, id, kind, matched = false) {
  if (!/^[0-9a-f]{12}$/.test(id) || !['svg', 'json'].includes(kind)) return null;
  const meta = data?.assets?.[id], encoded = data?.blobs?.[id], max = IMAGE_ASSET_LIMITS[kind];
  if (meta?.kind !== kind || typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(max / 3) * 4) return null;
  try {
    if (matched) return validBase64(encoded) ? new Uint8Array(0) : null;
    const bytes = unbase64(encoded);
    return bytes.length <= max ? bytes : null;
  } catch { return null; }
}

// Shared report validation for the wrapper, raw body, image and 3D routes. Only report-family
// names from this repository's kicad-review.yml run are served; a name's head must be the run's
// head_sha, except a manual (workflow_dispatch) run, which reviews a head given by hand. The legacy
// kicad-review.html name carries no head, so only its run provenance is checked. Verified runs are
// memoized per artifact in the isolate cache to avoid repeated GitHub run lookups on asset requests.
async function reportArtifact(owner, repo, id, active, repository) {
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
  const base = `${root}/artifacts/${id}`;
  const result = await gh(base, active.token);
  if (result.status !== 200) return null;
  const metadata = await result.json();
  const name = String(metadata.name || '');
  const head7 = reviewListName.exec(name)?.[2] ?? /^kicad-design-([0-9a-f]{7})\.html$/.exec(name)?.[1];
  if (!head7 && name !== 'kicad-review.html') return null;
  if (metadata.size_in_bytes != null && (!Number.isSafeInteger(metadata.size_in_bytes) || metadata.size_in_bytes < 0 || metadata.size_in_bytes > MAX_REPORT_BYTES)) return null;
  const runId = metadata.workflow_run?.id;
  if (!/^\d{1,20}$/.test(String(runId)) || !Number.isSafeInteger(repository?.id) || metadata.workflow_run.repository_id !== repository.id) return null;
  if (metadata.expires_at != null && !Number.isFinite(Date.parse(metadata.expires_at))) return null;
  const expired = metadata.expired || (metadata.expires_at && Date.parse(metadata.expires_at) <= Date.now());
  if (expired) return { base, metadata, expired: true };
  const key = metadata.size_in_bytes != null && metadata.updated_at != null
    ? JSON.stringify([base, metadata.workflow_run?.repository_id, metadata.size_in_bytes, metadata.updated_at]) : null;
  const cachedRun = key ? reportCache.entries.get(key)?.run : null;
  let run = cachedRun;
  if (!run) {
    const runResponse = await gh(`${root}/runs/${runId}`, active.token);
    run = runResponse.ok ? await runResponse.json() : null;
  }
  if (run?.path !== `.github/workflows/${workflowFile}` || run.repository?.id !== repository.id
    || (head7 && run.event !== 'workflow_dispatch' && !(/^[0-9a-f]{40}$/.test(run.head_sha) && run.head_sha.startsWith(head7)))) return null;
  return { base, metadata, run, expired: false };
}

async function storedReport(artifact, active) {
  const download = await gh(`${artifact.base}/zip`, active.token, { redirect: 'manual' });
  if (download.status !== 302) throw new Error('Report unavailable');
  const location = new URL(download.headers.get('Location'));
  if (location.protocol !== 'https:' || location.username || location.password) throw new Error('Report unavailable');
  // Signed storage URLs may redirect; never forward the GitHub authorization header.
  const blob = await fetch(location.href);
  if (!blob.ok || !blob.body) throw new Error('Report unavailable');
  return blob;
}

// Reports whose 3D assets artifact3d serves from their own run: comparison reports, and
// design snapshots whose name binds to the stored (unstripped) data.report.head.
const served3d = (metadata, data) => /^\d{1,20}$/.test(String(metadata.workflow_run?.id))
  && (data?.report?.kind == null ? verifyReportFamily('comparison', metadata.name)
    : data.report.kind === 'design' && verifyReportFamily('design', metadata.name, data.report.head));

const reportBuilds = new Map();
// ponytail: one cold build at a time per isolate (peak ~ one report's transient copies); raise only if queued cold loads time out.
let buildTail = Promise.resolve();

// Only call after access() and reportArtifact() have validated this request.
async function cachedReport(artifact, active) {
  const { metadata, base } = artifact;
  // Legacy metadata without an immutable upload identity is shared in flight but never cached.
  const key = metadata.size_in_bytes != null && metadata.updated_at != null
    ? JSON.stringify([base, metadata.workflow_run?.repository_id, metadata.size_in_bytes, metadata.updated_at]) : null;
  const flight = key ?? JSON.stringify(['legacy', base]);
  const hit = reportCache.get(flight);
  if (hit) return hit;
  // Authorization and artifact liveness were checked independently by every waiter.
  // Share cold work too: a page's parallel raw/asset requests must not multiply peak memory.
  if (reportBuilds.has(flight)) return reportBuilds.get(flight);
  const build = buildTail.then(async () => {
    const stored = await readReportText(await storedReport(artifact, active));
    const data = readStoredData(stored);
    // Only the authenticated wrapper's raw report is built here; guest/share keep embedded blobs.
    // Models are stripped only when artifact3d would serve them, so no report loses its 3D view.
    const raw = currentReport(stored, { lazyAssets: true, lazy3d: served3d(metadata, data), storedData: data }) ?? stored;
    // UTF-16 strings plus a conservative parsed-envelope allowance (including object overhead).
    // Count shared/fallback strings twice rather than under-account retained report bytes.
    // Stored HTML is temporary: only parsed data (4x envelope allowance) and raw body remain.
    const entry = { data, raw, run: artifact.run, bytes: 4 * stored.length + 2 * raw.length };
    if (key) reportCache.set(key, entry);
    return entry;
  });
  buildTail = build.catch(() => {});
  reportBuilds.set(flight, build);
  try { return await build; }
  finally { reportBuilds.delete(flight); }
}

function assetError() {
  return new Response('Asset unavailable. Try again.', { status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private,no-store' } });
}

// 01 owns private image and 3D transport: `load` runs access and artifact validation on
// every call, before any ETag response, and returns bytes or a failure Response.
export async function privateAsset(request, digest, kind, load) {
  const headers = { 'Content-Type': kind === 'svg' ? 'image/svg+xml' : kind === 'board.glb' ? 'model/gltf-binary' : 'application/json',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Encoding': 'gzip', 'Cache-Control': 'private,no-cache', ETag: `"${digest}"`, Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
  const matched = (request.headers.get('If-None-Match') || '').split(',').some(tag =>
    tag.trim().replace(/^W\//, '') === headers.ETag || tag.trim() === '*');
  const result = await load(matched);
  if (result instanceof Response) {
    if (result.status >= 300 && result.status < 400 || result.headers.get('Location'))
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
    const failureHeaders = new Headers(result.headers);
    failureHeaders.set('Cache-Control', 'no-store');
    return new Response(result.body, { status: result.status, headers: failureHeaders });
  }
  return new Response(matched ? null : result, { status: matched ? 304 : 200, headers, encodeBody: 'manual' });
}

// Stored metadata/expiry/name/zip/download sequence; returns the stored HTML or a failure Response.
// The validated result now includes parsed data and the raw body for isolate-local reuse.
async function readArtifactHtml(owner, repo, id, active, repository) {
  try {
    const artifact = await reportArtifact(owner, repo, id, active, repository);
    if (!artifact || artifact.expired) return assetError();
    // ponytail: read the existing HTML envelope per asset; add range/indexed companion delivery only if Worker CPU or GitHub download traces require it.
    // Measured Worker CPU now requires caching that envelope and its processed forms.
    return { ...await cachedReport(artifact, active), metadata: artifact.metadata };
  } catch { /* Legacy/temporarily unavailable report: fail asset requests closed. */ return assetError(); }
}

async function digestAsset(request, env, owner, repo, id, digest, kind) {
  let active;
  const asset = await privateAsset(request, digest, kind, async (matched) => {
    const allowed = await access(request, env, owner, repo);
    if (allowed instanceof Response) return allowed;
    active = allowed.s;
    const stored = await readArtifactHtml(owner, repo, id, active, allowed.repo);
    if (stored instanceof Response) return stored;
    return assetFromData(stored.data, digest, kind, matched) || assetError();
  });
  return sessionResponse(asset.body, { status: asset.status, headers: asset.headers,
    encodeBody: asset.headers.get('Content-Encoding') === 'gzip' ? 'manual' : 'automatic' }, active);
}

// Exactly `size` bytes or null; a wrong declared length or a longer body is never buffered whole.
export async function readExactly(response, size, maxBytes = ASSET_3D_LIMITS['board.glb']) {
  const declared = response.headers.get('Content-Length');
  if (!response.body || !Number.isSafeInteger(size) || size <= 0 || size > maxBytes) return null;
  // A real Content-Encoding (not identity) reply's length counts encoded bytes; the read bound below still caps it.
  // ponytail: Task 12's deployed gate decides whether Workers decoding of such a reply needs handling; until then it fails closed on the gzip check.
  if (declared != null && (response.headers.get('Content-Encoding') || 'identity').trim().toLowerCase() === 'identity' && Number(declared) !== size) { await response.body.cancel(); return null; }
  // Chunks, not a size-length buffer: the descriptor's claimed size is never allocated up front.
  const chunks = [], reader = response.body.getReader();
  for (let n = 0; ;) {
    const { done, value } = await reader.read();
    if (done) {
      if (n !== size) return null;
      const out = new Uint8Array(size);
      for (let offset = 0, i = 0; i < chunks.length; offset += chunks[i++].byteLength) out.set(chunks[i], offset);
      return out;
    }
    if ((n += value.length) > size) { await reader.cancel(); return null; }
    chunks.push(value);
  }
}

// 3D assets come only from the validated report's own run, named by a descriptor in its stored data.
async function artifact3d(request, env, owner, repo, id, digest, kind) {
  let active;
  const asset = await privateAsset(request, digest, kind, async (matched) => {
    const allowed = await access(request, env, owner, repo);
    if (allowed instanceof Response) return allowed;
    active = allowed.s;
    if (!/^[0-9a-f]{64}$/.test(digest) || !['board.glb', 'board-parts.json'].includes(kind)) return assetError();
    try {
      const stored = await readArtifactHtml(owner, repo, id, active, allowed.repo);
      if (stored instanceof Response) return stored;
      const { metadata, data } = stored, run = String(metadata.workflow_run?.id);
      if (!served3d(metadata, data)) return assetError();
      const key = kind === 'board.glb' ? 'model' : 'parts', name = `kicad-3d-${digest}-${kind}.gz`, maxBytes = ASSET_3D_LIMITS[kind];
      const descriptor = (Array.isArray(data.projects) ? data.projects : []).flatMap((p) => ['base', 'head'].map((side) => p?.board?.assets3d?.[side]?.[key]))
        .find((a) => a?.digest === digest && a.artifactName === name && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.bytes <= maxBytes);
      if (!descriptor) return assetError();
      const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
      const paged = await ghPages(gh, `${root}/runs/${run}/artifacts`, active.token, d => d?.artifacts);
      if (!paged.ok) return assetError();
      const matches = paged.items.filter((a) => a?.name === name);
      const [match] = matches;
      if (matches.length !== 1 || match.expired || String(match.workflow_run?.id) !== run || !/^\d{1,20}$/.test(String(match.id))
        || (match.size_in_bytes != null && (!Number.isSafeInteger(match.size_in_bytes) || match.size_in_bytes <= 0 || match.size_in_bytes > maxBytes))) return assetError();
      if (matched) return new Uint8Array(0);
      const archive = await gh(`${root}/artifacts/${match.id}/zip`, active.token, { redirect: 'manual' });
      const location = archive.status === 302 ? downloadUrl(archive.headers.get('Location')) : null;
      if (!location) return assetError();
      // Share downloader's host policy; never forward GitHub authorization or follow further redirects.
      const body = await fetch(location, { redirect: 'manual' });
      if (!body.ok) return assetError();
      const bytes = await readExactly(body, descriptor.bytes, maxBytes);
      return bytes && bytes[0] === 31 && bytes[1] === 139 ? bytes : assetError();
    } catch { return assetError(); }
  });
  return sessionResponse(asset.body, { status: asset.status, headers: asset.headers,
    encodeBody: asset.headers.get('Content-Encoding') === 'gzip' ? 'manual' : 'automatic' }, active);
}

async function artifactReport(request, env, owner, repo, id, active, raw, canShare = false, repository = null) {
  try {
    const artifact = await reportArtifact(owner, repo, id, active, repository);
    if (!artifact) return errorPage(404, "Can't open this page", "This artifact may have been replaced by a re-run. Open the review from the pull request comment, or check that your GitHub account can see it.", [], active);
    const { metadata } = artifact;
    if (artifact.expired) {
      const match = String(metadata.name || '').match(/^kicad-review-([0-9a-f]{7})-([0-9a-f]{7})-(?:pass|fail)\.html$/);
      return sessionResponse(runPage({
        user: active.login, owner, repo, state: 'expired', base: match?.[1], head: match?.[2],
      }), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }, active);
    }
    if (!raw) {
      const { run } = artifact, runId = metadata.workflow_run.id;
      const runStatus = run.status || null, runConclusion = run.conclusion || null;
      const pull = run.event === 'pull_request' && Number.isInteger(run.pull_requests?.[0]?.number) ? run.pull_requests[0].number : null;
      // The browser parent downloads the authenticated raw envelope for its allowlist,
      // never trusting child declarations. digestAsset revalidates authorization and
      // declarations per request; the parent checks the returned MIME type and digest.
      const sharing = shareEnabled(env) && canShare;
      return sessionResponse(reviewPage({
        user: active.login, owner, repo, id, name: metadata.name, workflowRunId: runId, pdf: new URL(request.url).searchParams.get('pdf') === '1', pull, runStatus, runConclusion, share: sharing,
      }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': frameCsp } }, active);
    }
    if (request.headers.get('Sec-Fetch-Dest') === 'document') return sessionRedirect(`${repoPath(owner, repo)}/a/${encodeURIComponent(id)}`, 302, active);
    return sessionResponse((await cachedReport(artifact, active)).raw, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': reportCsp,
        'X-Frame-Options': 'SAMEORIGIN',
      },
    }, active);
  } catch {
    return notFound(active);
  }
}

function reviews(artifacts) {
  return (artifacts || []).filter((artifact) => !artifact.expired && reviewListName.test(artifact.name || ''))
    .map((artifact) => {
      const match = artifact.name.match(reviewListName);
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

// Listing pages (here and branches, tags, pulls) show what the 10-page bound read; detection paths use ghPages directly and fail closed.
async function artifactList(owner, repo, token, maxPages = 10) {
  const paged = await ghPages(gh, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts`, token, d => d?.artifacts, maxPages);
  return paged.overflow ? { ok: true, items: paged.items } : paged;
}

async function home(request, env) {
  const stored = cookies(request).s;
  const active = await currentSession(request, env);
  if (!active?.token) {
    // bad_refresh_token: another request probably rotated this token and set a fresh cookie; keep it.
    // refresh_unavailable: the refresh may have succeeded out of reach; keep the cookie for a later try.
    return response(signedOutPage({ sessionEnded: Boolean(stored) }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...(stored && !['bad_refresh_token', 'refresh_unavailable'].includes(active?.error) ? { 'Set-Cookie': clear('s', new URL(request.url).protocol === 'https:') } : {}),
      },
    });
  }
  let repositories = [], recent = [], activity = [], limited = false;
  const errors = [];
  // bench-t8: request-local promise cache; at most 31 GitHub calls (1 + 5 + 5×(3 artifact pages + runs + pulls)),
  // inside the free plan's 50 subrequests with a token refresh. Artifacts list newest first, so 3 pages
  // cover recent reviews. No per-report requests, deeper pagination, or cross-user cached responses.
  const cache = new Map();
  const json = path => {
    if (!cache.has(path)) cache.set(path, (async () => {
      const result = await gh(path, active.token);
      if (!result.ok) throw new Error('GitHub request failed');
      return result.json();
    })());
    return cache.get(path);
  };
  try {
    const installations = (await json('/user/installations')).installations || [];
    limited = installations.length > 5;
    const results = await Promise.all(installations.slice(0, 5).map(async ({ id }) => {
      try { return (await json(`/user/installations/${encodeURIComponent(id)}/repositories?per_page=100`)).repositories || []; }
      catch { errors.push('An installation repository list could not be loaded.'); return []; }
    }));
    const unique = new Map();
    for (const repo of results.flat()) if (allowedOwners(env).includes(String(repo.owner?.login).toLowerCase())) {
      unique.set(`${repo.owner.login}/${repo.name}`.toLowerCase(), repo);
    }
    repositories = [...unique.values()].sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')));
    await Promise.all(repositories.slice(0, 5).map(async repo => {
      const owner = repo.owner.login;
      const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}`;
      const [artifactsPaged, runs, pulls] = await Promise.all([
        artifactList(owner, repo.name, active.token, 3).catch(() => null),
        json(`${root}/actions/runs?per_page=20`).catch(() => null),
        json(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=20`).catch(() => null),
      ]);
      if (!artifactsPaged?.ok || !runs || !pulls) errors.push(`Some recent data for ${owner}/${repo.name} could not be loaded.`);
      repo.runs = runs?.workflow_runs || [];
      activity.push(...repo.runs.map(run => ({ ...run, owner, repo: repo.name })));
      const items = reviews(artifactsPaged?.items).slice(0, 20).map(item => {
        const run = repo.runs.find(run => run.id === item.workflow_run?.id);
        const pullNumber = run?.pull_requests?.[0]?.number;
        const pull = Array.isArray(pulls) ? pulls.find(pr => pr.number === pullNumber || (!pullNumber && pr.head?.sha === item.workflow_run?.head_sha)) : null;
        return { id: item.id, owner, repo: repo.name, base: item.base, head: item.head, result: item.result,
          createdAt: item.created_at, branch: item.workflow_run?.head_branch, pull,
          freshness: pull?.head?.sha && item.revisionsRecorded ? (pull.head?.sha?.slice(0, 7) === item.head ? 'Latest commit' : 'Older commit') : 'Not checked' };
      });
      repo.latest = items[0]; recent.push(...items);
    }));
    recent.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    recent = recent.slice(0, 20);
    activity.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch { errors.push('Repositories could not be loaded. Check GitHub access and retry.'); }

  return sessionResponse(homePage({ user: active.login, repositories, recent, activity, errors, limited }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }, active);
}

export function milestoneGroups(items, pulls) {
  // ponytail: artifacts identify branches, not PR numbers; newest PR wins on branch reuse.
  const byBranch = new Map([...pulls].sort((a, b) => a.number - b.number).map(p => [p.head?.ref, p]));
  const groups = new Map();
  for (const item of items) {
    const pr = item.manual ? null : byBranch.get(item.branch);
    const milestone = pr?.milestone;
    const key = milestone ? (milestone.id ?? milestone.html_url ?? milestone.title) : null;
    if (!groups.has(key)) groups.set(key, { title: milestone?.title || 'No milestone', url: milestone?.html_url || null, open: 0, merged: 0, items: [], prs: new Set(), noMilestone: !milestone });
    const group = groups.get(key);
    group.items.push({ ...item, pull: pr ? { number: pr.number, state: pr.state, merged: Boolean(pr.merged_at) } : null });
    if (pr && !group.prs.has(pr.number)) {
      group.prs.add(pr.number);
      if (pr.merged_at) group.merged += 1;
      else if (pr.state === 'open') group.open += 1;
    }
  }
  return [...groups.values()].sort((a, b) => a.noMilestone - b.noMilestone || a.title.localeCompare(b.title))
    .map(({ prs, noMilestone, ...group }) => group);
}

async function reviewList(request, env, owner, repo, url) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  try {
    const pagedArtifacts = await artifactList(owner, repo, allowed.s.token);
    const artifacts = pagedArtifacts.ok ? pagedArtifacts.items : [];
    const list = reviews(artifacts);
    const items = list.map((item) => {
      const event = item.workflow_run?.event;
      const branchTip = String(item.workflow_run?.head_sha || '').slice(0, 7);
      const manual = item.revisionsRecorded && item.base !== 'none' && branchTip && item.head !== branchTip;
      return {
        id: item.id, pdf: Boolean(matchingPdf(artifacts, item)), createdAt: item.created_at, date: date(item.created_at),
        branch: item.workflow_run?.head_branch || 'Unknown branch',
        label: manual ? 'manual' : ({ push: 'branch push', pull_request: 'pull request' }[event] || ''),
        manual, base: item.base, head: item.head,
        result: item.revisionsRecorded ? item.result : 'unknown', legacy: !item.revisionsRecorded,
      };
    });
    const counts = {
      all: items.length,
      passing: items.filter((item) => item.result === 'pass').length,
      failing: items.filter((item) => item.result === 'fail').length,
      older: items.filter((item) => item.legacy).length,
    };
    const requestedFilter = url?.searchParams.get('filter');
    const filter = ['passing', 'failing', 'older'].includes(requestedFilter) ? requestedFilter : 'all';
    const filtered = filter === 'passing' ? items.filter((item) => item.result === 'pass')
      : filter === 'failing' ? items.filter((item) => item.result === 'fail')
        : filter === 'older' ? items.filter((item) => item.legacy) : items;
    const view = url?.searchParams.get('view') === 'milestones' ? 'milestones' : 'list';
    let groups = null;
    if (view === 'milestones') {
      try {
        const pulls = await ghPages(gh, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&sort=created&direction=desc`, allowed.s.token);
        if (pulls.ok || pulls.overflow) groups = milestoneGroups(filtered, pulls.items);
      } catch { /* Keep the page available with permission guidance. */ }
    }
    return sessionResponse(reviewsPage({
      user: allowed.s.login, owner, repo, started: url?.searchParams.get('started') === '1',
      items: filtered, counts, filter, view, groups,
    }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  } catch {
    return notFound(allowed.s);
  }
}

async function commitsData(owner, repo, token, branch, tag = '') {
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const [branchesPaged, tagsPaged, artifactsPaged] = await Promise.all([
    ghPages(gh, `${root}/branches`, token),
    ghPages(gh, `${root}/tags`, token),
    artifactList(owner, repo, token),
  ]);
  const branches = (branchesPaged.ok || branchesPaged.overflow) ? branchesPaged.items : [];
  const tags = (tagsPaged.ok || tagsPaged.overflow) ? tagsPaged.items : [];
  const selectedTag = tag ? tags.find((item) => item.name === tag) : null;
  const sha = selectedTag?.commit?.sha;
  if (tag && !sha) return null;
  const commitsResponse = await gh(`${root}/commits?sha=${encodeURIComponent(sha || branch)}&per_page=50`, token);
  if (!commitsResponse.ok) return null;
  const commitList = await commitsResponse.json();
  const artifacts = artifactsPaged.ok ? artifactsPaged.items : [];
  const reviewList = reviews(artifacts);
  const byHead = new Map();
  for (const item of reviewList) {
    if (item.head !== '?') {
      const key = String(item.head).slice(0, 7);
      if (!byHead.has(key)) byHead.set(key, item);
    }
  }
  return {
    branch, tags: tags.map((item) => ({ name: String(item.name || '') })).filter((item) => item.name),
    branches: branches.map((item) => item.name), tag,
    commits: commitList.map((commit) => {
      const sha = String(commit.sha || ''); const fullMessage = String(commit.commit?.message || '');
      const exactDate = date(commit.commit?.author?.date);
      const review = byHead.get(sha.slice(0, 7));
      return { sha, fullMessage, message: fullMessage.split('\n', 1)[0], author: commit.author?.login || commit.commit?.author?.name || '?', date: relativeDate(commit.commit?.author?.date), exactDate, review: review?.id, pdf: review ? Boolean(matchingPdf(artifacts, review)) : false };
    }),
  };
}

function relativeDate(value) {
  const then = new Date(value).getTime(); const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (!Number.isFinite(then)) return '?';
  if (seconds < 60) return 'just now';
  const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  const [size, label] = units.find(([size]) => seconds >= size);
  const count = Math.floor(seconds / size); return `${count} ${label}${count === 1 ? '' : 's'} ago`;
}

async function commits(request, env, owner, repo, url) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const branch = url.searchParams.get('branch') ?? allowed.repo.default_branch;
  const tag = url.searchParams.get('tag') || '';
  if (!branch || branch.length > 255 || /[\x00-\x1f\x7f]/.test(branch)) return errorPage(404, 'Not found', 'The requested branch is unavailable.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
  try {
    const data = await commitsData(owner, repo, allowed.s.token, branch, tag);
    if (!data) return errorPage(404, 'Not found', 'The requested branch is unavailable.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
    return sessionResponse(commitsPage({ user: allowed.s.login, owner, repo, ...data }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  } catch {
    return notFound(allowed.s);
  }
}

const commitSha = /^[0-9a-f]{7,40}$/;

async function compare(request, env, owner, repo) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return errorPage(403, 'Forbidden', 'This request cannot be completed.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }]);
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, 'Choose two different commits', 'Select two different commit SHAs to compare.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
  }
  const base = String(form.get('base') || ''); const head = String(form.get('head') || '');
  if (!commitSha.test(base) || !commitSha.test(head) || base === head) return errorPage(400, 'Choose two different commits', 'Select two different commit SHAs to compare.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let comparison;
  try {
    const result = await gh(`${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, allowed.s.token);
    if (result.status === 404) return errorPage(400, 'Choose two different commits', 'Select two different commit SHAs to compare.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
    if (!result.ok) throw new Error('compare failed');
    comparison = await result.json();
  } catch { return errorPage(502, 'Could not start the review', 'The review could not be started. Try again later.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s); }
  const changed = (comparison.files || []).map((file) => String(file.filename || ''));
  const kicad = /\.kicad_(sch|pcb|pro)$|(^|\/)(sym|fp)-lib-table$|(^|\/)kicad-review\.toml$/;
  const rerender = async (notice, files = [], swap = false) => {
    try {
      const data = await commitsData(owner, repo, allowed.s.token, allowed.repo.default_branch);
      if (!data) throw new Error('commits unavailable');
      return sessionResponse(commitsPage({ user: allowed.s.login, owner, repo, ...data, base, head, notice, files, swap }), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
    } catch { return errorPage(400, 'Choose two different commits', 'Select two different commit SHAs to compare.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s); }
  };
  if (comparison.status === 'behind') return rerender({ kind: 'error', message: 'Head is older than Base.' }, [], true);
  if (!changed.some((filename) => kicad.test(filename))) {
    const files = changed.slice(0, 10); if (changed.length > 10) files.push(`and ${changed.length - 10} more`);
    return rerender({ kind: 'warn', message: `No KiCad files changed between ${base.slice(0, 7)} and ${head.slice(0, 7)}, so there is nothing to review.` }, files);
  }
  try {
    const dispatch = await gh(`${root}/actions/workflows/${workflowFile}/dispatches`, allowed.s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: allowed.repo.default_branch, inputs: { base, head }, return_run_details: true }) });
    if (dispatch.status === 204) return sessionRedirect(`${repoPath(owner, repo)}?started=1`, 303, allowed.s);
    if (dispatch.status === 200) { const details = await dispatch.json(); if (details.workflow_run_id) return sessionRedirect(`${repoPath(owner, repo)}/run/${encodeURIComponent(details.workflow_run_id)}?${new URLSearchParams({ base, head })}`, 303, allowed.s); }
    if (dispatch.status === 403 || dispatch.status === 404) return errorPage(403, 'Cannot start review', 'You need write access and the KiCad review workflow.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
  } catch { /* Return the generic upstream error below. */ }
  return errorPage(502, 'Could not start the review', 'The review could not be started. Try again later.', [{ href: `${repoPath(owner, repo)}/commits`, label: 'Back to commits' }], allowed.s);
}

function githubRunUrl(run) {
  const url = String(run.html_url || '');
  return url.startsWith('https://github.com/') ? url : '';
}

function failedStep(jobs) {
  for (const job of jobs || []) {
    for (const step of job.steps || []) {
      if (step.conclusion === 'failure') return { stage: stages[stageForStep(step.name)], step: String(step.name || '') };
    }
  }
  return null;
}

async function run(request, env, owner, repo, id, url) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const base = url.searchParams.get('base');
  const head = url.searchParams.get('head');
  let runData;
  try {
    const runResponse = await gh(`${root}/actions/runs/${id}`, allowed.s.token);
    if (runResponse.status !== 200) return notFound(allowed.s);
    runData = await runResponse.json();
  } catch {
    return notFound(allowed.s);
  }
  const githubUrl = githubRunUrl(runData);
  if (runData.status !== 'completed') {
    let jobs = [];
    try {
      const jobsResponse = await gh(`${root}/actions/runs/${id}/jobs`, allowed.s.token);
      if (jobsResponse.ok) jobs = (await jobsResponse.json()).jobs || [];
    } catch {
      // The run remains useful even when GitHub has not exposed its jobs yet.
    }
    return sessionResponse(runPage({
      user: allowed.s.login, owner, repo, running: true, status: runData.status, githubUrl,
      base, head, startedAt: runData.run_started_at, jobs,
    }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  }
  try {
    const paged = await ghPages(gh, `${root}/actions/runs/${id}/artifacts`, allowed.s.token, d => d?.artifacts);
    if (!paged.ok) return notFound(allowed.s);
    const artifacts = paged.items;
    const matched = reviews(artifacts);
    if (new Set(matched.map(a => a.name)).size > 1) return notFound(allowed.s);
    const artifact = matched[0];
    if (artifact) return sessionRedirect(`${repoPath(owner, repo)}/a/${encodeURIComponent(artifact.id)}${matchingPdf(artifacts, artifact) ? '?pdf=1' : ''}`, 302, allowed.s);
  } catch {
    return notFound(allowed.s);
  }
  if (runData.conclusion === 'success') {
    return sessionResponse(runPage({ user: allowed.s.login, owner, repo, state: 'nothing', base, head }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
  }
  let stopped = null;
  if (['failure', 'cancelled', 'timed_out'].includes(runData.conclusion)) {
    try {
      const jobsResponse = await gh(`${root}/actions/runs/${id}/jobs`, allowed.s.token);
      if (jobsResponse.ok) stopped = failedStep((await jobsResponse.json()).jobs || []);
    } catch {
      // Fall back to the generic failed-run explanation.
    }
  }
  return sessionResponse(runPage({
    user: allowed.s.login, owner, repo, state: 'failed', githubUrl, base, head,
    failedStage: stopped?.stage, failedStep: stopped?.step,
  }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }, allowed.s);
}

function nextPath(value) {
  return value?.startsWith('/') && !/^\/[\/\\\s]/.test(value) ? value : '/';
}

function stateCookie(next) {
  const random = crypto.getRandomValues(new Uint8Array(24));
  return encode(text.encode(JSON.stringify({ s: encode(random), n: next })));
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
    stateData = JSON.parse(untext.decode(decode(savedState)));
  } catch {
    return errorPage(400, "Sign-in didn't complete", 'The sign-in link expired or was opened in a different browser.', [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  }
  const code = url.searchParams.get('code');
  if (!code) return errorPage(400, "Sign-in didn't complete", "GitHub didn't send a sign-in code. You may have cancelled.", [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  const token = await tokenRequest(env, { code });
  const signinError = () => errorPage(502, "Sign-in didn't complete", "GitHub didn't accept the sign-in. Try again.", [{ href: '/login', label: 'Try again' }, { href: '/', label: 'Back to the start' }], null, { headers: { 'Set-Cookie': clear('st', secure) } }, [], false);
  if (!token || token.error) return signinError();
  let user;
  try {
    const userResponse = await gh('/user', token.access_token);
    if (!userResponse.ok) throw new Error();
    user = await userResponse.json();
    if (!user?.login) throw new Error();
  } catch {
    return signinError();
  }
  const value = {
    t: token.access_token,
    r: token.refresh_token,
    e: Date.now() + token.expires_in * 1000,
    re: Date.now() + token.refresh_token_expires_in * 1000,
    u: user.login,
  };
  return redirect(nextPath(stateData.n), [await sessionCookie(value, env, secure), clear('st', secure)]);
}

const routes = {
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
      const shareView = url.pathname.match(/^\/s\/([^/]+)(\/raw)?$/);
      if (request.method === 'GET' && shareView) return await serveShare(request, env, shareView[1], Boolean(shareView[2]), { gh, response, reportCsp, frameCsp, sharedPage, sharedNotFoundPage, allowedOwners });
      const revoke = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/share\/revoke$/);
      if (request.method === 'POST' && revoke) return await revokeShares(request, env, { owner: revoke[1], repo: revoke[2] }, { access, gh, response, sessionResponse });
      const shareCreate = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/a\/(\d{1,20})\/share$/);
      if (request.method === 'POST' && shareCreate) return await createShare(request, env, { owner: shareCreate[1], repo: shareCreate[2], id: shareCreate[3] }, { access, gh, response, sessionResponse });
      const assetRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/a\/(\d{1,20})\/assets\/([0-9a-f]{12})\.(svg|json)$/);
      if (request.method === 'GET' && assetRoute) {
        const [, owner, repo, id, digest, kind] = assetRoute;
        return await digestAsset(request, env, owner, repo, id, digest, kind);
      }
      const modelRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/a\/(\d{1,20})\/3d\/([^/]+)\/([^/]+)$/);
      if (request.method === 'GET' && modelRoute) {
        const [, owner, repo, id, digest, kind] = modelRoute;
        return await artifact3d(request, env, owner, repo, id, digest, kind);
      }
      const downloadRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/a\/(\d{1,20})\/download\/(\d{1,3})\/(fab|pdf|step|glb)$/);
      if (request.method === 'GET' && downloadRoute) {
        const [, owner, repo, id, index, kind] = downloadRoute;
        const allowed = await access(request, env, owner, repo);
        return allowed instanceof Response ? allowed : downloadFile(owner, repo, id, index, kind, allowed.s);
      }
      const artifactRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/a\/([^/]+)(\/raw|\/pdf)?$/);
      if (request.method === 'GET' && artifactRoute) {
        const [, owner, repo, id, raw] = artifactRoute;
        if (!/^\d{1,20}$/.test(id)) {
          if (raw === '/pdf') return jsonError(await session(request, env), 'PDF unavailable');
          return notFound();
        }
        const allowed = await access(request, env, owner, repo);
        if (raw === '/pdf') {
          if (allowed instanceof Response) {
            const headers = new Headers(allowed.headers);
            headers.set('Content-Type', 'application/json; charset=utf-8');
            return response(JSON.stringify({ error: 'PDF unavailable' }), { status: allowed.status >= 400 ? allowed.status : 401, headers });
          }
          return pdfDownload(owner, repo, id, allowed.s);
        }
        return allowed instanceof Response ? allowed : artifactReport(request, env, owner, repo, id, allowed.s, raw === '/raw', Boolean(allowed.repo.permissions?.push), allowed.repo);
      }
      const compareRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/compare$/);
      if (request.method === 'POST' && compareRoute) {
        return compare(request, env, compareRoute[1], compareRoute[2]);
      }
      const runRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/run\/([^/]+)$/);
      if (request.method === 'GET' && runRoute) {
        const [, owner, repo, id] = runRoute;
        if (!/^\d{1,20}$/.test(id)) return notFound();
        return run(request, env, owner, repo, id, url);
      }
      const historyMatch = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/history$/);
      if (request.method === 'GET' && historyMatch) return await historyRoute(request, env, { owner: historyMatch[1], repo: historyMatch[2], number: Number(historyMatch[3]) }, { access, gh, historyPage, sessionResponse, errorPage, artifactName: reviewListName });

      const readyRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/readiness$/);
      if (request.method === 'GET' && readyRoute) {
        const result = await readinessRoute(request, env, { owner: readyRoute[1], repo: readyRoute[2], number: Number(readyRoute[3]) }, { access, gh });
        return response(result.body, { status: result.status, headers: result.headers });
      }
      const rerunMatch = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/rerun$/);
      if (request.method === 'POST' && rerunMatch) {
        const result = await rerunRoute(request, env, { owner: rerunMatch[1], repo: rerunMatch[2], number: Number(rerunMatch[3]) }, { access, gh });
        return response(result.body, { status: result.status, headers: result.headers });
      }
      const threadRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/threads(\/.*)?$/);
      if (threadRoute && ['GET', 'POST'].includes(request.method)) {
        const [, owner, repo, number, rest = ''] = threadRoute;
        const result = await threadsRoute(request, env, { owner, repo, number: Number(number), rest }, { access, gh });
        return response(result.body, { status: result.status, headers: result.headers });
      }
      const issueRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/issues(\/.*)?$/);
      if (issueRoute && ['GET', 'POST'].includes(request.method)) {
        const [, owner, repo, rest = ''] = issueRoute;
        const result = await issuesRoute(request, env, { owner, repo, rest }, { access, gh });
        return response(result.body, { status: result.status, headers: result.headers });
      }
      const commitsRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/commits$/);
      if (request.method === 'GET' && commitsRoute) {
        return commits(request, env, commitsRoute[1], commitsRoute[2], url);
      }
      const reviewRoute = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)$/);
      if (request.method === 'GET' && reviewRoute) {
        return reviewList(request, env, reviewRoute[1], reviewRoute[2], url);
      }
      return notFound(await session(request, env));
    } catch {
      return errorPage(500, 'Internal server error', 'Try again later.');
    }
  },
};

export default {
  async fetch(request, env) {
    const result = await routes.fetch(request, env);
    const sha = typeof env.DEPLOY_SHA === 'string' && /^[0-9a-f]{40}$/.test(env.DEPLOY_SHA) ? env.DEPLOY_SHA : 'unknown';
    const headers = new Headers(result.headers);
    headers.set('X-Deploy-Sha', sha);
    // Never buffer or modify sandboxed reports, assets, redirects or downloads.
    const shell = headers.get('Content-Type')?.startsWith('text/html')
      && !headers.get('Content-Security-Policy')?.includes('sandbox');
    const body = shell ? deploymentPage(await result.text(), sha) : result.body;
    if (shell) headers.delete('Content-Length');
    return new Response(body, { status: result.status, statusText: result.statusText, headers,
      ...(headers.has('Content-Encoding') ? { encodeBody: 'manual' } : {}) });
  },
};
