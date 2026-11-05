import { parseThreads, ghPages, loadReviewThreads, validComments } from './threads.js';
import { latestDecisions } from './readiness.js';

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
export async function selectContext(access, sha, deps, accept = async () => true) {
  const { gh, loadContext } = deps;
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
      // The report routes' provenance check (kicad-review.yml run of this repository) runs through this call's GitHub budget.
      const verify = deps.verifyReport && ((ghFn) => deps.verifyReport(owner, repo, String(artifact.id), access.token, access.repository, ghFn));
      const loaded = await loadContext(owner, repo, String(artifact.id), access.token, gh, verify);
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

export const objectLink = (origin, loaded, key, value, sheet, side) => {
  const params = { p: String(loaded.projectIndex) };
  if (side === 'base') params.revision = 'base';
  params[key] = value;
  if (key === 'part' && sheet != null) params.v = `sheet:${sheet}`;
  const hash = new URLSearchParams(params);
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
  const incomplete = !!doc.truncated;
  const parts = r.parts || [];
  const out = { provenance: loaded.provenance };
  const part = p => ({
    ...projectLists(displayPart(p), limit, '', incomplete),
    id: p.uuid || null,
    link: p.uuid ? objectLink(origin, loaded, 'part', p.uuid, p.sheet, p.side === 'base' || loaded.side === 'base' ? 'base' : undefined) : null,
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
    const checkRows = (p.checks || []).slice(0, limit);
    const summaries = checkRows.map(({ findings, more, ...summary }) => {
      const checkName = summary.name || '';
      const clippedSummary = { ...summary };
      for (const field of ['reason', 'message', 'summary']) {
        if (typeof clippedSummary[field] === 'string') {
          clippedSummary[field] = displayText(clippedSummary[field], `checks.${checkName}.${field}`, clipped);
        }
      }
      return {
        ...clippedSummary,
        findings: page((findings || []).map(f => projectLists(f, limit)), limit, (findings || []).length + (more || 0), !!more),
      };
    });
    return {
      ...out,
      board: projectLists(r.board, limit, '', incomplete),
      partCount: incomplete ? null : parts.length,
      storedPartCount: parts.length,
      sheets: page(sheets, limit, incomplete || sheetsIncomplete ? null : sheets.length, incomplete || sheetsIncomplete),
      sheetsIncomplete,
      checks: page(summaries, limit, (p.checks || []).length),
      incompleteFields: page(clipped, limit),
      netlist_available: r.netlist_available,
      netlist_reason: r.netlist_reason || null,
      incomplete,
    };
  }
  if (name === 'find_parts') {
    const q = args.query.toLowerCase();
    const rows = parts.filter(p => [p.ref, p.value, p.mpn, ...Object.entries(p.properties || {}).flat()].some(x => String(x ?? '').toLowerCase().includes(q)));
    const pagedRows = rows.slice(0, limit);
    return {
      ...out,
      parts: page(pagedRows.map(part), limit, incomplete ? null : rows.length, incomplete),
      incompleteFields: page(clipped, limit),
      searchFieldsComplete: !incomplete && parts.every(p => p.properties && !p.properties_truncated && !(p.incomplete_fields || []).length),
      ...(incomplete ? { reason: 'Source context is truncated; an empty match is not proof of absence.' } : {}),
    };
  }
  throw new McpError('UNKNOWN_TOOL', 'Unknown design projection');
}

export function netProjection(name, args, loaded, origin) {
  const { revision: r, doc } = loaded, limit = args.limit ?? 15;
  const incomplete = !!doc.truncated, parts = r.parts || [], nets = r.nets || [], out = { provenance: loaded.provenance };
  if (name === 'get_net') {
    if (!r.netlist_available) return { ...out, error: { code: 'INCOMPLETE', message: r.netlist_reason || 'No exported netlist' } };
    let net = nets.find(n => n.id === args.net);
    let netSide = loaded.side === 'base' ? 'base' : 'head';
    let netParts = parts;
    if (!net && loaded.project?.revisions?.base?.nets) {
      const baseNet = loaded.project.revisions.base.nets.find(n => n.id === args.net);
      if (baseNet) {
        net = baseNet;
        netSide = 'base';
        netParts = loaded.project.revisions.base.parts || [];
      }
    }
    if (!net) {
      const near = nets.filter(n => n.id.toLowerCase().includes(args.net.toLowerCase())).map(n => ({ id: n.id, link: objectLink(origin, loaded, 'net', n.id, undefined, netSide) }));
      return { ...out, found: false, nearby: page(near, limit, incomplete ? null : near.length, incomplete), incomplete };
    }
    const ids = net.pins || [], total = net.pin_count ?? ids.length;
    const structured = new Map(); // keyed by ref.pin, never by position, so pin_records order or length cannot misattribute
    for (const rec of net.pin_records || []) if (!structured.has(`${rec.ref}.${rec.pin}`)) structured.set(`${rec.ref}.${rec.pin}`, rec);
    let reverse = null; // ref.pin -> matching parts' pins, built once per call and only if a row needs it
    const reverseMatches = id => {
      if (!reverse) {
        reverse = new Map();
        for (const p of netParts)
          for (const entry of p.pins || []) {
            const key = `${p.ref}.${entry.pin}`, match = { ref: p.ref, pin: entry.pin };
            if (reverse.has(key)) reverse.get(key).push(match); else reverse.set(key, [match]);
          }
      }
      return reverse.get(id) || [];
    };
    // Only the requested page is projected.
    const rows = ids.slice(0, limit).map(id => {
      let member = structured.get(id);
      if (!member) {
        const matches = reverseMatches(id);
        if (matches.length === 1) member = matches[0];
      }
      if (!member) return { memberAvailable: false };
      const p = netParts.find(p => p.ref === member.ref && (!p.pins?.length || p.pins.some(entry => entry.pin === member.pin)));
      return { ref: member.ref, pin: member.pin, value: p?.value ?? null, partId: p?.uuid || null, memberAvailable: !!p };
    });
    return { ...out, found: true, id: net.id, link: objectLink(origin, loaded, 'net', net.id, undefined, netSide), pins: page(rows, limit, total, !!net.more || incomplete) };
  }
  throw new McpError('UNKNOWN_TOOL', 'Unknown net projection');
}

// Legacy fallback only for contexts without parts[].bom: DNP-only, no canonical key; the result is marked bom.complete:false.
const legacyBom = p => ({ included: !p.dnp, excludedReason: p.dnp ? 'dnp' : null, ref: p.ref, value: p.value || '', footprint: p.footprint || '', lcsc: p.lcsc || '', mpn: p.mpn || '', category: '', key: null, groupKey: JSON.stringify([p.value || '', p.footprint || '', p.lcsc || '', p.mpn || '']) });
export function bomLines(parts) {
  const groups = new Map();
  for (const p of parts) {
    const bom = p.bom ?? legacyBom(p);
    if (!bom.included) continue;
    const groupKey = bom.groupKey ?? bom.key;
    if (!groups.has(groupKey)) groups.set(groupKey, { key: bom.key, value: bom.value, footprint: bom.footprint, mpn: bom.mpn, lcsc: bom.lcsc, category: bom.category, refs: [] });
    groups.get(groupKey).refs.push(bom.ref ?? p.ref);
  }
  return [...groups.values()].map(g => ({ ...g, quantity: g.refs.length, refs: g.refs.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) }));
}
// Verbatim quoting per Task 7 plan; spreadsheet formula prefix neutralization is intentionally omitted for vendor compatibility.
const csvCell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
export function bomProjection(name, args, loaded, origin) {
  const { revision: r, doc } = loaded, limit = args.limit ?? 15;
  const parts = r.parts || [], legacy = parts.some(p => !p.bom);
  const incomplete = !!doc.truncated || legacy, out = { provenance: loaded.provenance, bom: { complete: !legacy } };
  if (name === 'get_bom') {
    const groups = bomLines(parts), rows = groups.map(g => ({ ...g, refs: page(g.refs, limit) }));
    const lines = page(rows, limit, incomplete ? null : rows.length, incomplete);
    if (args.format === 'csv') {
      const header = ['References', 'Value', 'Footprint', 'MPN', 'LCSC', 'Quantity'];
      const csv = [header, ...groups.slice(0, limit).map(g => [g.refs.join(' '), g.value, g.footprint, g.mpn, g.lcsc, g.quantity])].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
      return { ...out, format: 'csv', csv, incomplete, lines: { limit, returned: lines.returned, total: lines.total, truncated: lines.truncated } };
    }
    return { ...out, lines, incomplete };
  }
  throw new McpError('UNKNOWN_TOOL', 'Unknown BOM projection');
}

export function reviewProjects(doc, limit = 15) {
  return doc.projects.map(p => ({
    id: p.dir,
    status: p.status || (p.revisions?.head ? 'present' : 'removed'),
    revision: p.revisions?.head ? doc.head : null,
    baseRevision: p.revisions?.base ? doc.base : null,
    headline: typeof p.headline === 'string' ? p.headline : null,
    changes: page((p.changes?.rows || []).map(r => ({ ...projectLists(r, limit, '', !!p.changes?.more || !!doc.truncated || r.detail_truncated === true), detailTruncated: r.detail_truncated === true })), limit, p.changes?.total, !!p.changes?.more || (p.changes?.detail_truncated ?? 0) > 0),
    changesDetailTruncated: p.changes?.detail_truncated ?? 0,
    partsIncomplete: [p.revisions?.base, p.revisions?.head].flatMap(rev => rev?.parts || []).filter(x => !x.properties || x.properties_truncated === true || !Array.isArray(x.incomplete_fields) || x.incomplete_fields.length > 0).length,
    netChangesAvailable: p.net_changes?.available === true,
    netChangesComplete: p.net_changes?.available === true && p.net_changes.complete === true && !p.changes?.more && !doc.truncated && (p.changes?.detail_truncated ?? 0) === 0 && !(p.changes?.rows || []).some(r => r.detail_truncated === true),
    checks: page((p.checks || []).map(({ findings, more, ...check }) => ({ ...check, findings: page((findings || []).map(f => projectLists(f, limit)), limit, (findings || []).length + (more || 0), !!more) })), limit),
  }));
}

export async function reviewLive(access, pr, sha, limit = 15, gh) {
  const owner = access.repository.owner.login, name = access.repository.name;
  // Same paged reads as the readiness route: every review page, every thread page; a partial read is unknown, never complete.
  const [reviews, threads] = await Promise.all([
    ghPages(gh, `${access.root}/pulls/${pr}/reviews`, access.token).catch(() => null),
    loadReviewThreads(gh, access.token, { owner, repo: name, name, number: pr }).catch(() => null),
  ]);
  let open = null;
  const complete = !!threads && !(threads instanceof Response) && threads.present && Array.isArray(threads.nodes)
    && threads.head === sha && threads.nodes.every((node) => validComments(node?.comments));
  if (complete) {
    try { open = parseThreads({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads.nodes } } } } }).filter(t => !t.resolved); } catch { /* malformed */ }
  }
  const isComplete = complete && open !== null;
  const decisions = reviews?.ok ? latestDecisions(reviews.items, sha) : null;
  return {
    head: sha,
    openThreads: page((open || []).map(t => ({ id: t.id, anchor: projectLists(t.anchor, limit), comments: page(t.comments.map(c => ({ ...projectLists(c, limit), body: String(c.body).slice(0, 1000) })), limit, null, true) })), limit, open ? open.length : null, !isComplete),
    readiness: {
      head: sha,
      decisions: page((decisions || []).map(d => projectLists(d, limit)), limit, decisions ? decisions.length : null, !decisions),
      blocking: open ? open.filter(t => t.anchor?.severity === 'blocking').length : null,
      open: open ? open.length : null,
      state: !isComplete || !decisions ? 'unknown' : decisions.some(d => !d.stale && d.state === 'CHANGES_REQUESTED') || open.some(t => t.anchor?.severity === 'blocking') ? 'needs_work' : 'review_evidence_only',
    },
  };
}

export function projectTool(name, args, loaded, origin) {
  if (name === 'get_design' || name === 'find_parts') return designParts(name, args, loaded, origin);
  if (name === 'get_net') return netProjection(name, args, loaded, origin);
  if (name === 'get_bom') return bomProjection(name, args, loaded, origin);
  throw new McpError('UNKNOWN_TOOL', 'Unknown projection');
}

// Workers allow 50 subrequests per invocation. Every GitHub call of one tool call shares this cap, and an
// artifact download counts twice (GitHub's redirect, then the storage fetch), leaving room for the sign-in refresh.
export const SUBREQUEST_BUDGET = 45;
export function budgeted(gh, limit = SUBREQUEST_BUDGET) {
  let used = 0;
  return (path, ...rest) => {
    used += /\/artifacts\/\d+\/zip$/.test(String(path)) ? 2 : 1;
    if (used > limit) return Promise.reject(new McpError('REQUEST_BUDGET', 'This call reached its GitHub request budget; narrow the requested ref or request a new review'));
    return gh(path, ...rest);
  };
}

export async function runTool(name, args, request, deps) {
  deps = { ...deps, gh: budgeted(deps.gh) };
  try {
    const access = await mcpAccess(request.env, request.props, args.repo, deps);
    if (name === 'list_projects') {
      const tip = await resolveRevision(access, undefined, deps.gh), loaded = await selectContext(access, null, deps);
      return bounded({
        repo: access.repository.full_name,
        currentTip: tip.sha,
        latestReviewedCommit: loaded.doc.head,
        stale: tip.sha !== loaded.doc.head,
        projects: page(loaded.doc.projects.map(p => ({
          id: p.dir,
          name: p.name,
          status: p.status || (p.revisions.head ? 'present' : 'removed'),
          revision: p.revisions.head ? loaded.doc.head : null,
          baseRevision: p.revisions.base ? loaded.doc.base : null,
        })), args.limit),
      });
    }
    const loaded = name === 'get_review'
      ? await loadPrReview(access, args.pr, deps)
      : await loadDesign(access, args, deps);
    if (name === 'get_review') {
      const projects = reviewProjects(loaded.doc, args.limit);
      return bounded({ provenance: loaded.provenance, projects: page(projects, args.limit), live: await reviewLive(access, args.pr, loaded.resolution.sha, args.limit, deps.gh) });
    }
    return bounded(projectTool(name, args, loaded, request.origin));
  } catch (error) {
    return {
      error: {
        code: error instanceof McpError ? error.code : 'UNAVAILABLE',
        message: error instanceof McpError ? error.message : 'Data unavailable; retry later',
        ...(error?.canRender ? { canRender: true, renderPath: error.renderPath } : {}),
      },
    };
  }
}
