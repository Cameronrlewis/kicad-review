// MCP trust boundaries: live GitHub authorization per call and byte-bounded input/output.
export class McpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Counts UTF-8 bytes as they stream in, so a chunked body cannot exceed `limit` in memory.
// A declared oversize Content-Length is refused before any read.
export async function readBounded(source, limit) {
  if (Number(source.headers?.get('Content-Length')) > limit) {
    await source.body?.cancel().catch(() => {});
    throw new McpError('TOO_LARGE', 'Input too large');
  }
  const reader = source.body?.getReader();
  if (!reader) return '';
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new McpError('TOO_LARGE', 'Input too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const json = (response) => response.json().catch(() => null);

// Mirrors worker.js access(): owner allow-list, then the user's own token must still read the repository.
// Runs on every tool call; nothing is cached, so revoked access fails before any artifact request.
export async function mcpAccess(env, props, repo, { gh, open, allowedOwners }) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo))
    throw new McpError('UNAVAILABLE', 'Repository unavailable');
  const [owner, name] = repo.split('/');
  if (!allowedOwners(env).includes(owner.toLowerCase())) throw new McpError('UNAVAILABLE', 'Repository unavailable');
  const value = await open(props?.credential || '', env);
  if (!value?.t || !value.u || !(value.e > Date.now())) throw new McpError('AUTH_REQUIRED', 'Sign in again');
  const user = await gh('/user', value.t);
  if (!user.ok || String((await json(user))?.login).toLowerCase() !== String(value.u).toLowerCase())
    throw new McpError('AUTH_REQUIRED', 'Sign in again');
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const result = await gh(root, value.t);
  if (result.status === 429 || result.headers.get('x-ratelimit-remaining') === '0')
    throw new McpError('RATE_LIMIT', 'GitHub rate limit; retry later');
  const repository = result.ok ? await json(result) : null;
  if (!repository?.permissions?.pull || !allowedOwners(env).includes(String(repository.owner?.login).toLowerCase()))
    throw new McpError('UNAVAILABLE', 'Repository unavailable');
  return { login: value.u, token: value.t, repository, root };
}

// List envelope; total null means unknown, which is never reported as complete.
export const page = (items, limit = 15, total = items.length, incomplete = false) => ({
  items: items.slice(0, limit), limit, returned: Math.min(items.length, limit), total,
  truncated: incomplete || total === null || total > limit || items.length > limit,
});

export function bounded(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length <= 32768 ? value
    : { error: { code: 'RESULT_TOO_LARGE', message: 'Narrow the query or reduce limit; no oversized result was sent.' } };
}

const SHA40 = /^[0-9a-f]{40}$/;
const REPORT = /^kicad-review-(?:[0-9a-f]{7}|none)-[0-9a-f]{7}-(?:pass|fail)\.html$/;

// A git ref, full SHA, or pr:<n> (the PR source head, never its synthetic merge commit) resolved to one full commit.
// The whole ref is one encoded path segment, slashes included.
export async function resolveRevision(access, ref, gh) {
  const requested = ref ?? access.repository.default_branch;
  if (typeof requested !== 'string' || !requested || requested.length > 255 || /[\x00-\x1f\x7f]/.test(requested))
    throw new McpError('INVALID_REF', 'Invalid revision');
  const match = /^pr:([1-9]\d{0,9})$/.exec(requested);
  const response = await gh(`${access.root}/${match ? 'pulls/' + match[1] : 'commits/' + encodeURIComponent(requested)}`, access.token);
  if (!response.ok) throw new McpError('REF_UNAVAILABLE', 'Revision unavailable');
  const body = await json(response), sha = match ? body?.head?.sha : body?.sha;
  if (!SHA40.test(sha || '')) throw new McpError('REF_UNAVAILABLE', 'Revision unavailable');
  return { sha, requested, kind: match ? 'pull_head' : ref ? 'ref' : 'default_branch', ...(match ? { pr: Number(match[1]) } : {}) };
}

// Newest context whose full head equals `sha`. The 7-character name only narrows candidates; nothing is cached,
// and an outage or a missing match is an error, never an older revision presented as current.
export async function selectContext(access, sha, { gh, loadContext }, accept = async () => true) {
  const [owner, repo] = access.repository.full_name.split('/');
  let examined = 0, exhausted = false;
  // ponytail: scan at most 10 pages/1,000 metadata rows and 30 matching contexts per call; no stale fallback.
  for (let number = 1; number <= 10; number++) {
    const response = await gh(`${access.root}/actions/artifacts?per_page=100&page=${number}`, access.token);
    if (!response.ok) throw new McpError('ARTIFACTS_UNAVAILABLE', 'Review artifacts unavailable');
    const body = await json(response), rows = Array.isArray(body?.artifacts) ? body.artifacts : [];
    const candidates = rows.filter((a) => !a.expired && REPORT.test(a.name || '') && /^\d{1,20}$/.test(String(a.id)))
      .filter((a) => !sha || a.name.split('-').at(-2) === sha.slice(0, 7))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
    for (const artifact of candidates) {
      if (++examined > 30) throw new McpError('HISTORY_LIMIT', 'Search exceeded 30 matching contexts; narrow the requested ref or request a new review');
      const loaded = await loadContext(owner, repo, String(artifact.id), access.token, gh);
      if (loaded.status === 429 || loaded.status === 502) throw new McpError('ARTIFACTS_UNAVAILABLE', loaded.error);
      if (loaded.status === 413) throw new McpError('CONTEXT_UNAVAILABLE', loaded.error);
      const doc = loaded.doc;
      if (doc?.version !== 1 || doc.kind !== 'kicad-review-design-context' || doc.repo?.toLowerCase() !== access.repository.full_name.toLowerCase() || !SHA40.test(doc.head || '')) continue;
      if (sha && doc.head !== sha) continue;
      if (!Array.isArray(doc.projects) || doc.projects.some((p) => typeof p?.dir !== 'string' || !p.revisions || !Object.hasOwn(p.revisions, 'head')
        || !(p.revisions.head === null || (typeof p.revisions.head === 'object' && !Array.isArray(p.revisions.head)))
        || (p.revisions.head === null && p.status !== 'removed'))) continue;
      if (new TextEncoder().encode(JSON.stringify(doc)).length > 200000)
        throw new McpError('CONTEXT_TOO_LARGE', 'MCP context exceeds 200,000 bytes; Ask still accepts legacy contexts up to 400,000 bytes');
      if (!await accept(doc, artifact)) continue;
      return { doc, artifact, reportId: String(artifact.id) };
    }
    if (rows.length < 100 || number * 100 >= Number(body?.total_count)) { exhausted = true; break; }
  }
  if (!exhausted) throw new McpError('HISTORY_LIMIT', 'No match within 1,000 metadata rows; request a fresh review for the exact ref');
  const error = new McpError('MISSING_DATA', 'No reviewed data for the requested commit; artifacts may be absent, expired, or generated before context support');
  error.canRender = !!access.repository.permissions?.push;
  if (error.canRender) error.renderPath = '/r/' + access.repository.full_name.split('/').map(encodeURIComponent).join('/') + '/commits';
  throw error;
}

// Head-only selection for design-fact tools. Omitted project is valid only for a one-project context unless allProjects.
export async function loadDesign(access, args, deps) {
  const resolution = await resolveRevision(access, args.ref, deps.gh);
  const loaded = await selectContext(access, resolution.sha, deps);
  let project, projectIndex, revision;
  if (!args.allProjects) {
    if (args.project === undefined && loaded.doc.projects.length !== 1) throw new McpError('PROJECT_REQUIRED', 'Choose a project from list_projects');
    projectIndex = args.project === undefined ? 0 : loaded.doc.projects.findIndex((p) => p.dir === args.project);
    project = loaded.doc.projects[projectIndex];
    if (!project) throw new McpError('PROJECT_UNAVAILABLE', 'Project unavailable in this revision');
    revision = project.revisions.head;
    if (revision === null) throw new McpError('PROJECT_UNAVAILABLE', 'Project was removed; only base provenance and review changes are available');
  }
  return { ...loaded, resolution, project, projectIndex, revision, provenance: { repo: access.repository.full_name, requested: resolution.requested,
    revisionKind: resolution.kind, commit: resolution.sha, base: loaded.doc.base, artifactId: loaded.reportId, createdAt: loaded.artifact.created_at,
    ...(project ? { project: project.dir } : {}), upstreamTruncated: !!loaded.doc.truncated } };
}

// A PR review context must match the source head, the merge base as its base, and a pull_request run for this PR
// whose recorded base is the current target tip. Target tip and merge base are different Git identities.
export async function selectPrContext(access, pr, { sha, targetTip, base }, deps) {
  try {
    return await selectContext(access, sha, deps, async (doc, artifact) => {
      if (doc.base !== base) return false;
      const runId = String(artifact.workflow_run?.id || '');
      if (!/^\d{1,20}$/.test(runId)) return false;
      const response = await deps.gh(`${access.root}/actions/runs/${runId}`, access.token);
      if (response.status === 404) return false;
      if (!response.ok) throw new McpError('ARTIFACTS_UNAVAILABLE', 'Workflow run metadata unavailable');
      const run = await json(response);
      return String(run?.id) === runId && run.event === 'pull_request' && run.head_sha === sha
        && (Array.isArray(run.pull_requests) ? run.pull_requests : []).some((p) => p?.number === pr && p.head?.sha === sha && p.base?.sha === targetTip);
    });
  } catch (error) {
    if (error.code === 'MISSING_DATA') throw new McpError('PR_CONTEXT_UNAVAILABLE', 'PR comparison context unavailable');
    throw error;
  }
}

export async function loadPrReview(access, pr, deps) {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new McpError('INVALID_REF', 'Invalid pull request number');
  const response = await deps.gh(`${access.root}/pulls/${pr}`, access.token);
  if (!response.ok) throw new McpError('REF_UNAVAILABLE', 'Pull request unavailable');
  const pull = await json(response), sha = pull?.head?.sha, targetTip = pull?.base?.sha;
  if (!SHA40.test(sha || '') || !SHA40.test(targetTip || '')) throw new McpError('REF_UNAVAILABLE', 'Pull request unavailable');
  const compared = await deps.gh(`${access.root}/compare/${targetTip}...${sha}`, access.token);
  if (!compared.ok) throw new McpError('PR_CONTEXT_UNAVAILABLE', 'PR merge base unavailable');
  const base = (await json(compared))?.merge_base_commit?.sha;
  if (!SHA40.test(base || '')) throw new McpError('PR_CONTEXT_UNAVAILABLE', 'PR merge base unavailable');
  const loaded = await selectPrContext(access, pr, { sha, targetTip, base }, deps);
  const resolution = { sha, requested: `pr:${pr}`, kind: 'pull_head', pr };
  return { ...loaded, resolution, provenance: { repo: access.repository.full_name, requested: resolution.requested,
    revisionKind: resolution.kind, commit: sha, base, targetTip, pr, artifactId: loaded.reportId,
    createdAt: loaded.artifact.created_at, upstreamTruncated: !!loaded.doc.truncated } };
}

// Semantic lists are bounded recursively. Coordinate tuples are fixed-size values, not list results.
export function projectLists(value, limit = 15, key = '', unknown = false) {
  const tupleKeys = new Set(['pos', 'pos_before', 'box', 'size_mm', 'before', 'after']);
  if (Array.isArray(value)) {
    if (tupleKeys.has(key) && [2, 4].includes(value.length) && value.every(n => typeof n === 'number' && Number.isFinite(n))) return value;
    const rows = value.map(v => projectLists(v, limit, '', unknown));
    return page(rows, limit, unknown || key === 'items' ? null : rows.length, unknown || key === 'items');
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value.items) && ['limit', 'returned', 'total', 'truncated'].every(k => Object.hasOwn(value, k))) {
    const count = value.total, rows = value.items.map(v => projectLists(v, limit, '', unknown));
    return { ...value, ...page(rows, Math.min(limit, value.limit), count, !!value.truncated || unknown) };
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const more = value[k + '_more'];
    if (Array.isArray(v) && !(tupleKeys.has(k) && [2, 4].includes(v.length) && v.every(n => typeof n === 'number' && Number.isFinite(n))) && Number.isInteger(more))
      return [k, page(v.map(x => projectLists(x, limit, '', unknown)), limit, unknown ? null : v.length + more, more > 0 || unknown)];
    return [k, projectLists(v, limit, k, unknown || !!value.truncated)];
  }));
}

export const objectLink = (origin, loaded, key, value) => {
  const hash = new URLSearchParams({ p: String(loaded.projectIndex), [key]: value });
  return `${origin}/r/${loaded.provenance.repo.split('/').map(encodeURIComponent).join('/')}/a/${loaded.reportId}#${hash}`;
};

const displayText = (value, path, clipped) => {
  const text = String(value ?? '');
  if ([...text].length <= 2000) return text;
  clipped.push(path);
  return [...text].slice(0, 2000).join('');
};

const safeDatasheet = value => {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};

export function designParts(name, args, loaded, origin) {
  const clipped = [];
  const displayPart = p => ({
    ...p,
    ...Object.fromEntries(['value', 'footprint', 'mpn', 'lcsc'].filter(k => p[k] != null).map(k => [k, displayText(p[k], `parts.${p.ref}.${k}`, clipped)])),
    datasheet: safeDatasheet(p.datasheet),
  });
  const { revision: r, project: p, doc } = loaded, limit = args.limit ?? 15;
  const incomplete = !!doc.truncated, unknown = incomplete ? null : undefined;
  const parts = r.parts || [], nets = r.nets || [];
  const summaries = (p.checks || []).map(({ findings, more, ...summary }) => ({
    ...summary,
    findings: page((findings || []).map(f => projectLists(f, limit)), limit, (findings || []).length + (more || 0), !!more),
  }));
  const out = { provenance: loaded.provenance };
  const part = p => ({
    ...projectLists(displayPart(p), limit, '', incomplete),
    id: p.uuid || null,
    link: p.uuid ? objectLink(origin, loaded, 'part', p.uuid) : null,
    pins: page((p.pins || []).map(v => projectLists(v, limit)), limit, p.pin_count ?? (p.pins || []).length, !!p.pins_more),
  });
  if (name === 'get_design') {
    let sheets, sheetsIncomplete = false;
    if (Array.isArray(r.sheets)) sheets = r.sheets;
    else if (Array.isArray(p.sheets)) {
      sheets = p.sheets.filter(s => s.status !== 'removed');
      sheetsIncomplete = p.sheets.some(s => !['added', 'modified', 'unchanged', 'removed'].includes(s.status));
    } else {
      sheets = [];
      sheetsIncomplete = true;
    }
    return {
      ...out,
      board: projectLists(r.board, limit, '', incomplete),
      partCount: incomplete ? null : parts.length,
      storedPartCount: parts.length,
      sheets: page(sheets, limit, incomplete || sheetsIncomplete ? null : sheets.length, incomplete || sheetsIncomplete),
      sheetsIncomplete,
      checks: page(summaries, limit),
      incompleteFields: page(clipped, limit),
      netlist_available: r.netlist_available,
      netlist_reason: r.netlist_reason || null,
      incomplete,
    };
  }
  if (name === 'find_parts') {
    const q = args.query.toLowerCase();
    const rows = parts.filter(p => [p.ref, p.value, p.mpn, ...Object.entries(p.properties || {}).flat()].some(x => String(x ?? '').toLowerCase().includes(q)));
    return {
      ...out,
      parts: page(rows.map(part), limit, incomplete ? null : rows.length, incomplete),
      incompleteFields: page(clipped, limit),
      searchFieldsComplete: !incomplete && parts.every(p => p.properties && !p.properties_truncated && !(p.incomplete_fields || []).length),
      ...(incomplete ? { reason: 'Source context is truncated; an empty match is not proof of absence.' } : {}),
    };
  }
  throw new McpError('UNKNOWN_TOOL', 'Unknown design projection');
}
