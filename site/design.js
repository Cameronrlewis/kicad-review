// The design page: the newest design snapshot for a branch, tag or commit, found through GitHub. No store.
import { reportCsp, frameCsp } from './csp.js';
import { currentReport } from './report-shell.js';

export const designName = /^kicad-design-([0-9a-f]{7})\.html$/;
const hex40 = /^[0-9a-f]{40}$/;
const shaRef = /^[0-9a-f]{7,40}$/i;
const enc = encodeURIComponent;
const repoPath = (owner, repo) => `/r/${enc(owner)}/${enc(repo)}`;
// Git ref rules: no control characters, spaces, ~ ^ : ? * [ \ or "..", and the 255 limit the commits page uses.
export const refOk = (ref) => typeof ref === 'string' && ref.length > 0 && ref.length <= 255 && !/[\x00-\x20\x7f~^:?*[\\]|\.\.|\/\/|^\/|\/$|\.lock$|@\{/.test(ref);
const live = (a) => a && !a.expired && /^\d{1,20}$/.test(String(a.id)) && designName.test(a.name || '');
const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

// The signed storage URL GitHub redirects to. The token is never sent to it.
async function signedBody(response, what) {
  const location = new URL(response.headers.get('Location'));
  if (location.protocol !== 'https:' || location.username || location.password) throw new Error('invalid artifact URL');
  const body = await fetch(location.href, { redirect: 'manual' });
  if (!body.ok) throw new Error(`${what} body unavailable`);
  return body.text();
}
// The report's payload: a single-revision report that names its own commit. Anything else is refused.
export function snapshotPayload(text) {
  // ponytail: the existing non-archived HTML artifact format only; no arbitrary script execution.
  const match = /window\.REVIEW_DATA = (.*?);<\/script>/s.exec(text);
  if (!match) throw new Error('snapshot payload unavailable');
  const data = JSON.parse(match[1]);
  if (data.mode !== 'single' || !hex40.test(data.head || '') || data.head !== data.snapshot?.sha) throw new Error('invalid snapshot provenance');
  return data;
}
// Download only through the authenticated GitHub artifact endpoint. Never expose its signed URL.
export async function readSnapshot(gh, token, root, artifact) {
  const response = await gh(`${root}/actions/artifacts/${artifact.id}/zip`, token, { redirect: 'manual' });
  if (response.status === 410) return null;
  if (response.status !== 302) throw new Error('snapshot download unavailable');
  return snapshotPayload(await signedBody(response, 'snapshot'));
}
// The release asset's body as text.
export async function releaseText(gh, token, root, asset) {
  const response = await gh(`${root}/releases/assets/${enc(String(asset.id))}`, token, { headers: { Accept: 'application/octet-stream' }, redirect: 'manual' });
  if (response.status !== 302) throw new Error('release asset unavailable');
  return signedBody(response, 'release');
}
export async function readReleaseSnapshot(gh, token, root, asset) {
  return snapshotPayload(await releaseText(gh, token, root, asset));
}

// Files whose change alters a design snapshot. Settings files that every folder reads are global.
const designInput = (path) => /\.kicad_(?:pro|sch|pcb|sym|mod|dru|wks)$|\.(?:step|stp|wrl|glb|gz)$/i.test(path);
const globalInput = (path) => /(?:^|\/)(?:kicad-review\.toml|sym-lib-table|fp-lib-table)$/i.test(path); // ponytail: a new global settings file must be added here
export const affects = (path, dir) => globalInput(path) || (designInput(path) && (dir === '' || path === dir || path.startsWith(`${dir}/`)));
// Renames count for both names: a file moved into or out of the folder changes its design.
export const changesProject = (files, dir) => (files || []).some((f) => affects(f.filename || '', dir) || affects(f.previous_filename || '', dir));
// The folders with a .kicad_pro on the default branch: the unit one design page belongs to. The root folder is ''.
export const projectsFromTree = (nodes) => [...new Set((nodes || []).filter((n) => n.type === 'blob' && /\.kicad_pro$/.test(n.path))
  .map((n) => (n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '')))].sort();
// The root folder's key is an encoded slash: '.' is a dot segment that URL parsing drops, and no folder is named '/'.
export const projectKey = (dir) => enc(dir || '/');
export const dirFromKey = (key) => { const dir = decodeURIComponent(key); return dir === '/' ? '' : dir; };

// Canonicalize a project folder path: relative to repository root, no . or .. traversal segments,
// and safe from query/fragment injection. Root is ''. Invalid or traversal folders return null.
export function canonicalFolder(folder) {
  if (typeof folder !== 'string') return null;
  let dir;
  try { dir = dirFromKey(folder); } catch { return null; }
  if (dir === '') return '';
  if (/[\x00-\x1f\x7f\\]/.test(dir)) return null;
  const segments = dir.split('/');
  for (const s of segments) {
    if (!s || s === '.' || s === '..') return null;
    let decoded = s;
    try {
      while (decoded.includes('%')) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch { return null; }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return null;
  }
  return segments.join('/');
}

async function commitDetails(gh, token, root, sha, budget) {
  const files = []; let commit, incomplete = false;
  for (let page = 1; ; page++) {
    if (budget) {
      if (budget.used >= budget.max) { incomplete = true; break; }
      budget.used += 1;
    }
    const response = await gh(`${root}/commits/${enc(sha)}?per_page=100&page=${page}`, token);
    if (!response.ok) throw new Error('commit inputs unavailable');
    const data = await response.json(); commit ||= data;
    files.push(...(data.files || []));
    if (!response.headers.get('Link')?.includes('rel="next"')) break;
  }
  return { ...commit, files, incomplete };
}
// Newest live artifact named for this sha7 whose payload names this exact sha. An expired artifact is never read.
async function artifactAt(gh, token, root, sha, read) {
  for (let page = 1; ; page += 1) {
    const response = await gh(`${root}/actions/artifacts?name=${enc(`kicad-design-${sha.slice(0, 7)}.html`)}&per_page=100&page=${page}`, token);
    if (!response.ok) throw new Error('artifacts unavailable');
    for (const artifact of ((await response.json()).artifacts || []).filter(live).sort(byNewest)) {
      const snapshot = await read(gh, token, root, artifact);
      if (snapshot?.head === sha && snapshot.snapshot?.sha === sha) return { source: 'artifact', artifact, snapshot };
    }
    if (!response.headers.get('Link')?.includes('rel="next"')) return null;
  }
}
// The tag's release asset design-snapshot.html, or null. Only a tag name can match.
async function releaseAsset(gh, token, root, tag) {
  const response = await gh(`${root}/releases/tags/${enc(tag)}`, token);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('release unavailable');
  return ((await response.json()).assets || []).find((a) => a.name === 'design-snapshot.html') || null;
}
// After the artifact expired: the tag's release asset, when its payload names the tip.
async function releaseAt(gh, token, root, ref, tip, readRelease) {
  if (shaRef.test(ref)) return null;
  const asset = await releaseAsset(gh, token, root, ref);
  if (!asset) return null;
  const snapshot = await readRelease(gh, token, root, asset);
  return snapshot.head === tip && snapshot.snapshot?.sha === tip ? { source: 'release', asset, snapshot } : null;
}
// state: found {source, artifact|asset, snapshot, tip, exact, index} | missing {tip, reason?} | unknown | error.
// reason 'project' means the snapshot exists but has no such folder. A ref that is a full or short sha is never walked.
// Otherwise walk first-parent history (a merge's files describe its difference from its first parent) and stop at the
// nearest commit that changes this folder, even when its render is missing: older geometry never stands in for a change.
export async function findDesign(gh, token, owner, repo, ref, dir, read = readSnapshot, readRelease = readReleaseSnapshot) {
  const root = `/repos/${enc(owner)}/${enc(repo)}`;
  try {
    const response = await gh(`${root}/commits?sha=${enc(ref)}&per_page=1`, token);
    if (response.status === 404 || response.status === 422) return { state: 'unknown' };
    if (!response.ok) return { state: 'error' };
    const tip = (await response.json())[0]?.sha;
    if (!hex40.test(tip || '')) return { state: 'unknown' };
    const place = (hit) => {
      const index = hit.snapshot.projects?.findIndex((p) => p.dir === dir) ?? -1;
      return index < 0 ? { state: 'missing', tip, reason: 'project' } : { state: 'found', ...hit, tip, exact: hit.exact ?? true, index };
    };
    const exact = (await artifactAt(gh, token, root, tip, read)) ?? (await releaseAt(gh, token, root, ref, tip, readRelease));
    if (exact) return place(exact);
    if (shaRef.test(ref)) return { state: 'missing', tip };
    let sha = tip;
    for (let steps = 0; steps < 500; steps += 1) { // ponytail: at most 500 first-parent commits; the nearest change is nearly always within a few
      const commit = await commitDetails(gh, token, root, sha);
      if (changesProject(commit.files, dir)) {
        const hit = sha === tip ? null : await artifactAt(gh, token, root, sha, read);
        return hit ? place({ ...hit, exact: false }) : { state: 'missing', tip };
      }
      sha = commit.parents?.[0]?.sha;
      if (!sha) break;
      if (!hex40.test(sha)) throw new Error('invalid parent');
    }
    return { state: 'missing', tip };
  } catch { return { state: 'error' }; }
}

const generic = ['Not found', 'The requested branch, tag or commit is unavailable.'];
const html = { 'Content-Type': 'text/html; charset=utf-8' };
const unavailable = (errorPage, active) => errorPage(502, 'Could not load the design', 'GitHub did not answer. Try again.', [], active);
const defaultTree = (gh, owner, repo, allowed) => gh(`/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(allowed.repo.default_branch)}?recursive=1`, allowed.s.token);

// GET /r/:owner/:repo/projects: the project folders of the default branch, each with Latest design and Revisions.
export async function projectsRoute(request, env, { owner, repo }, { access, gh, errorPage, sessionResponse, projectsPage }) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const tree = await defaultTree(gh, owner, repo, allowed);
  if (!tree.ok) return errorPage(502, 'Could not load the projects', 'GitHub did not answer. Try again.', [], allowed.s);
  return sessionResponse(projectsPage({ user: allowed.s.login, owner, repo, projects: projectsFromTree((await tree.json()).tree) }), { headers: html }, allowed.s);
}

// GET /r/:owner/:repo/design[/<ref>] (repository-wide link) and GET /r/:owner/:repo/p/<key>/design[/<ref>] (one folder).
// Without a key: one folder goes to its page, several go to the picker, none says so.
export async function designRoute(request, env, { owner, repo, key, rest }, { access, gh, errorPage, sessionResponse, sessionRedirect, designMissingPage }) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const path = repoPath(owner, repo);
  const projects = { href: `${path}/projects`, label: 'Projects' };
  if (key === undefined) {
    const tree = await defaultTree(gh, owner, repo, allowed);
    if (!tree.ok) return unavailable(errorPage, allowed.s);
    const dirs = projectsFromTree((await tree.json()).tree);
    if (dirs.length === 0) return errorPage(404, 'No KiCad project', 'This repository has no KiCad project folder on its default branch.', [], allowed.s);
    return sessionRedirect(dirs.length === 1 ? `${path}/p/${projectKey(dirs[0])}/design${rest || ''}` : `${path}/projects`, 302, allowed.s);
  }
  let ref, dir;
  try {
    ref = rest ? decodeURIComponent(rest.slice(1)) : allowed.repo.default_branch;
    const canonical = canonicalFolder(key);
    if (canonical === null) return errorPage(404, ...generic, [projects], allowed.s);
    dir = canonical;
    key = projectKey(dir);
  } catch {
    return errorPage(404, ...generic, [projects], allowed.s);
  }
  if (!refOk(ref)) return errorPage(404, ...generic, [projects], allowed.s);
  const found = await findDesign(gh, allowed.s.token, owner, repo, ref, dir);
  if (found.state === 'unknown') return errorPage(404, ...generic, [projects], allowed.s);
  if (found.state === 'error') return unavailable(errorPage, allowed.s);
  if (found.state === 'found') {
    const query = new URLSearchParams({ design: ref, tip: found.tip.slice(0, 7), p: String(found.index), folder: key });
    const target = found.source === 'release' ? `${path}/design-release/${enc(ref)}` : `${path}/a/${enc(found.artifact.id)}`;
    return sessionRedirect(`${target}?${query}`, 302, allowed.s);
  }
  if (found.reason === 'project') return errorPage(404, 'No design for this folder', 'This project folder is not in that design.', [projects], allowed.s);
  return sessionResponse(designMissingPage({ user: allowed.s.login, owner, repo, key, ref, sha: found.tip, canRender: Boolean(allowed.repo.permissions?.push) }),
    { status: 404, headers: html }, allowed.s);
}

// The wrapper's optional design context from its query: requested ref, requested tip, report index and folder key.
export function designQuery(params) {
  const value = (name, pattern) => (pattern.test(params.get(name) || '') ? params.get(name) : '');
  const folder = params.get('folder');
  let folderKey = '';
  if (folder !== null) {
    const canonical = canonicalFolder(folder);
    if (canonical !== null) folderKey = projectKey(canonical);
  }
  return { designRef: refOk(params.get('design') || '') ? params.get('design') : '', tip: value('tip', /^[0-9a-f]{7}$/),
    projectIndex: value('p', /^\d{1,4}$/), folderKey };
}

// GET /r/:owner/:repo/design-release/:tag and .../:tag/raw: a tag's release snapshot, once its artifact has expired.
// The wrapper is the report wrapper; the raw file is served like the artifact raw route (sandboxed reportCsp, re-dressed).
export async function designReleaseRoute(request, env, { owner, repo, tag, raw }, { access, gh, errorPage, sessionResponse, sessionRedirect, reviewPage }) {
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  if (!refOk(tag) || shaRef.test(tag)) return errorPage(404, ...generic, [], allowed.s);
  const root = `/repos/${enc(owner)}/${enc(repo)}`, wrapper = `${repoPath(owner, repo)}/design-release/${enc(tag)}`;
  if (raw && request.headers.get('Sec-Fetch-Dest') === 'document') return sessionRedirect(wrapper, 302, allowed.s);
  try {
    const first = await gh(`${root}/commits?sha=${enc(tag)}&per_page=1`, allowed.s.token);
    if (!first.ok) return first.status === 404 || first.status === 422 ? errorPage(404, ...generic, [], allowed.s) : unavailable(errorPage, allowed.s);
    const tip = (await first.json())[0]?.sha;
    const asset = hex40.test(tip || '') ? await releaseAsset(gh, allowed.s.token, root, tag) : null;
    if (!asset) return errorPage(404, ...generic, [], allowed.s);
    const text = await releaseText(gh, allowed.s.token, root, asset);
    if (snapshotPayload(text).head !== tip) return errorPage(404, ...generic, [], allowed.s);
    if (raw) return sessionResponse(currentReport(text) ?? text, { headers: { ...html, 'Content-Security-Policy': reportCsp, 'X-Frame-Options': 'SAMEORIGIN' } }, allowed.s);
    return sessionResponse(reviewPage({ user: allowed.s.login, owner, repo, name: `kicad-design-${tip.slice(0, 7)}.html`, rawPath: `${wrapper}/raw`,
      ...designQuery(new URL(request.url).searchParams) }), { headers: { ...html, 'Content-Security-Policy': frameCsp } }, allowed.s);
  } catch {
    return unavailable(errorPage, allowed.s);
  }
}

export class CursorNotFoundError extends Error {
  constructor(message = 'cursor not found') {
    super(message);
    this.name = 'CursorNotFoundError';
  }
}

// The KiCad-change history of one project folder (owner decision 2026-10-26, decision 4): default-branch commits whose files
// include a KiCad input of the folder, renames and deletions included. 25 rows a page. A filtered page cannot be found by
// page number, so each page resumes from the last commit examined (the cursor). At most MAX_SCAN commit-detail requests are
// examined per view, and at most MAX_LIST_PAGES list pages are fetched.
const MAX_SCAN = 60; // ponytail: 60 detail requests per view; the Older link resumes the scan, so no commit is skipped
const PAGE_ROWS = 25;
const MAX_LIST_PAGES = 50; // ponytail: at most 50 commit-list requests (up to 5000 path-matching commits) per view
export async function scanHistory(gh, token, root, ref, dir, cursor) {
  const rows = [], pathQuery = dir ? `&path=${enc(dir)}` : '', budget = { used: 0, max: MAX_SCAN };
  let skipping = Boolean(cursor), last = cursor || '', progressed = false, listPages = 0;
  for (let page = 1; ; page += 1) {
    if (listPages >= MAX_LIST_PAGES) {
      if (skipping) throw new Error('history unavailable');
      return { rows, next: last, truncated: true };
    }
    listPages += 1;
    const response = await gh(`${root}/commits?sha=${enc(ref)}&per_page=100${page > 1 ? `&page=${page}` : ''}${pathQuery}`, token);
    if (!response.ok) throw new Error('history unavailable');
    const items = await response.json();
    const hasNextPage = Boolean(response.headers.get('Link')?.includes('rel="next"'));
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (skipping) {
        if (item.sha === cursor) { skipping = false; last = item.sha; }
        continue;
      }
      if (budget.used >= budget.max) return { rows, next: last, truncated: true };
      const commit = await commitDetails(gh, token, root, item.sha, budget);
      if (commit.incomplete) {
        if (progressed) return { rows, next: last, truncated: true };
        if (changesProject(commit.files, dir)) {
          rows.push({ sha: item.sha, message: String(item.commit?.message || '').split('\n', 1)[0], author: item.author?.login || item.commit?.author?.name || '?', date: item.commit?.author?.date || '' });
        }
        // ponytail: a commit with >6000 files that exhausts MAX_SCAN on its first examination is judged on its first 6000 files and advanced (next: item.sha) to prevent an infinite cursor loop; if KiCad files were only beyond file 6000, it is omitted.
        return { rows, next: item.sha, truncated: true };
      }
      last = item.sha; progressed = true;
      if (changesProject(commit.files, dir)) {
        rows.push({ sha: item.sha, message: String(item.commit?.message || '').split('\n', 1)[0], author: item.author?.login || item.commit?.author?.name || '?', date: item.commit?.author?.date || '' });
      }
      if (rows.length === PAGE_ROWS) {
        const hasMore = i + 1 < items.length || hasNextPage;
        return { rows, next: hasMore ? item.sha : null, truncated: false };
      }
    }
    if (!hasNextPage || !items.length) {
      if (skipping) throw new CursorNotFoundError();
      return { rows, next: null, truncated: false };
    }
    if (!skipping && budget.used >= budget.max) return { rows, next: last, truncated: true };
  }
}

// The list's thumbnails: one release asset.
// Task 8 stub: checks the release tag; Task 8A implements asset download and index parsing.
export async function thumbnailsFor(gh, token, root, dir, shas) {
  try {
    const release = await gh(`${root}/releases/tags/design-thumbs`, token);
    if (!release.ok) return new Map();
  } catch {}
  return new Map();
}

// GET /r/:owner/:repo/p/<key>/designs?ref=&cursor=: the KiCad-change history of one folder.
export async function designsRoute(request, env, { owner, repo, key }, deps) {
  const { access, gh, errorPage, sessionResponse, designsPage, thumbnailsFor } = deps;
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const url = new URL(request.url), path = repoPath(owner, repo);
  const back = [{ href: `${path}/projects`, label: 'Projects' }];
  const canonical = canonicalFolder(key);
  if (canonical === null) return errorPage(404, ...generic, back, allowed.s);
  const dir = canonical;
  key = projectKey(dir);
  const ref = url.searchParams.get('ref') || allowed.repo.default_branch;
  const cursor = url.searchParams.get('cursor') || '';
  if (!refOk(ref) || (cursor && !hex40.test(cursor))) return errorPage(404, ...generic, back, allowed.s);
  const root = `/repos/${enc(owner)}/${enc(repo)}`;
  try {
    const first = await gh(`${root}/commits?sha=${enc(ref)}&per_page=1`, allowed.s.token);
    if (first.status === 404 || first.status === 422) return errorPage(404, ...generic, back, allowed.s);
    if (!first.ok) return errorPage(502, 'Could not load the history', 'GitHub did not answer. Try again.', back, allowed.s);
    const tip = (await first.json())[0]?.sha || '';   // every Compare button compares with this commit
    const { rows, next, truncated } = await scanHistory(gh, allowed.s.token, root, ref, dir, cursor);
    const thumbs = await thumbnailsFor(gh, allowed.s.token, root, dir, rows.map((r) => r.sha)); // Task 8A: never fails the page
    return sessionResponse(designsPage({ user: allowed.s.login, owner, repo, key, ref, rows, tip, next, truncated, thumbs,
      first: !cursor, started: url.searchParams.get('started') === '1' }), { headers: html }, allowed.s);
  } catch (err) {
    if (err instanceof CursorNotFoundError) return errorPage(404, ...generic, back, allowed.s);
    return errorPage(502, 'Could not load the history', 'GitHub did not answer. Try again.', back, allowed.s);
  }
}

// POST /r/:owner/:repo/design/render: a design snapshot of one commit that has none. Needs write access, like Compare.
export async function renderRoute(request, env, { owner, repo }, { access, gh, errorPage, sessionRedirect, workflowFile }) {
  const path = `/r/${enc(owner)}/${enc(repo)}`;
  if (request.headers.get('Origin') !== new URL(request.url).origin) return errorPage(403, 'Forbidden', 'This request cannot be completed.', [{ href: `${path}/projects`, label: 'Projects' }]);
  const allowed = await access(request, env, owner, repo);
  if (allowed instanceof Response) return allowed;
  const form = await request.formData();
  const sha = String(form.get('sha') || ''), key = String(form.get('key') || '');
  // The folder's history when the form names a valid folder key (letters, digits and the encodeURIComponent set); the picker otherwise.
  const canonical = key && /^[A-Za-z0-9._~%!*'()-]{1,400}$/.test(key) ? canonicalFolder(key) : null;
  const back = [{ href: canonical !== null ? `${path}/p/${projectKey(canonical)}/designs` : `${path}/projects`, label: 'Back to revisions' }];
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return errorPage(400, 'Choose a commit', 'Pick a commit from the revision list.', back, allowed.s);
  try {
    const dispatch = await gh(`/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${workflowFile}/dispatches`, allowed.s.token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: allowed.repo.default_branch, inputs: { head: sha, snapshot_only: 'true' }, return_run_details: true }) });
    if (dispatch.status === 204) return sessionRedirect(`${back[0].href}?started=1`, 303, allowed.s);
    if (dispatch.status === 200) { const details = await dispatch.json(); if (details.workflow_run_id) return sessionRedirect(`${path}/run/${enc(details.workflow_run_id)}?${new URLSearchParams({ head: sha })}`, 303, allowed.s); }
    if (dispatch.status === 403 || dispatch.status === 404 || dispatch.status === 422) return errorPage(403, 'Cannot render this revision', 'You need write access, and the caller workflow must accept the snapshot_only input (see the README).', back, allowed.s);
  } catch { /* the generic upstream error below */ }
  return errorPage(502, 'Could not start the render', 'The render could not be started. Try again later.', back, allowed.s);
}
