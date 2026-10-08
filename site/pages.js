import tokens from '../ui/tokens.css';
import site from './site.css';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const e = escapeHtml;
const repoPath = (owner, repo) => `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const link = (href, label, className = '') => `<a${className ? ` class="${className}"` : ''} href="${e(href)}">${e(label)}</a>`;

export function frame({ title, user, crumbs = [], body, meta = '' }) {
  const trail = crumbs.map((crumb, index) => `<span>${index < crumbs.length - 1 && crumb.href ? link(crumb.href, crumb.label) : e(crumb.label)}</span>`).join('');
  const account = user ? `<div class="account"><span>Signed in as ${e(user)}</span><form method="post" action="/logout"><button class="btn btn-ghost">Sign out</button></form></div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · KiCad review</title>${meta}<style>${tokens}\n${site}</style></head><body><header class="top"><a class="product" href="/">KiCad review</a>${trail ? `<nav class="crumbs" aria-label="Breadcrumb">${trail}</nav>` : ''}${account}</header>${body}</body></html>`;
}

export function signedOutPage({ sessionEnded = false } = {}) {
  const notice = sessionEnded ? '<p class="notice notice-info">You were signed out. Sign in again to continue.</p>' : '';
  return frame({ title: 'Repositories', body: `<main class="page signed-out-page"><section class="card signed-out-card"><h1>KiCad review</h1><p>See what changed on the schematic and board in each commit or pull request, with ERC and DRC results.</p>${notice}<p>${link('/login', 'Sign in with GitHub', 'btn btn-primary')}</p><div class="signed-out-permissions"><p>When you sign in, GitHub asks you to allow this app to:</p><ul><li>Verify your GitHub identity</li><li>Know which resources you can access</li><li>Act on your behalf (only within what you can already do)</li></ul><p>It reads only repositories you already have access to.</p></div></section></main>` });
}

function relativeTime(value) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'unknown time';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, label] of units) {
    const amount = Math.floor(seconds / size);
    if (amount) return `${amount} ${label}${amount === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

export function homePage({ user, repositories }) {
  const body = repositories.length ? `<section class="cards">${repositories.map((repo) => {
    const path = repoPath(repo.owner.login, repo.name);
    return `<article class="card"><p class="muted">${e(repo.owner.login)}</p><h2>${e(repo.name)}</h2><p><span class="badge">${repo.private ? 'private' : 'public'}</span></p><p class="muted" title="${e(repo.pushed_at)}">updated ${e(relativeTime(repo.pushed_at))}</p><p class="card-actions">${link(path, 'Reviews', 'btn btn-primary')} ${link(`${path}/commits`, 'Compare commits', 'btn')}</p></article>`;
  }).join('')}</section>` : `<section class="card empty"><h2>No repositories yet</h2><p>An owner or admin installs the KiCad review GitHub App on the repositories you can open.</p><p class="muted">Signed in as ${e(user)}</p></section>`;
  return frame({ title: 'Repositories', user, crumbs: [{ label: 'Repositories' }], body: `<main class="page"><div class="page-head"><div><h1>Repositories</h1><p class="lead">Repositories you can open. Each one needs the KiCad review GitHub App installed.</p></div></div>${body}</main>` });
}

export function reviewsPage({ user, owner, repo, items, counts = {}, filter = 'all', started }) {
  const path = repoPath(owner, repo);
  const chips = [['all', 'All'], ['passing', 'Passing'], ['failing', 'Failing'], ['older', 'Older']]
    .map(([value, label]) => `<a class="filter-chip" href="${path}?filter=${value}"${filter === value ? ' aria-current="page"' : ''}>${label} ${counts[value] || 0}</a>`).join('');
  const cards = items.map((item) => {
    const branch = item.manual ? 'Manual comparison' : item.branch;
    const label = item.label ? `<span class="muted">${e(item.label)}</span>` : '';
    const revision = item.legacy
      ? '<p class="muted">Revisions not recorded (older report)</p>'
      : `<div class="revpath"><span class="muted">BASE</span><code>${e(item.base)}</code><span class="muted">↓</span><span class="muted">HEAD</span><code>${e(item.head)}</code></div>`;
    return `<article class="review-card"><div><h2>${e(branch)}</h2>${label}<p class="muted">${e(relativeTime(item.createdAt))} · ${e(item.date)}</p></div><div><p class="revision-label muted">Revision path</p>${revision}</div><div class="review-result">${status(item.result)}${link(`${path}/a/${encodeURIComponent(item.id)}`, 'Open review →', 'btn')}</div></article>`;
  }).join('');
  const content = cards ? `<section class="review-list">${cards}</section>` : `<section class="card empty"><h2>No reviews yet</h2><p>Reviews appear after a push or pull request that changes KiCad files, or after a comparison started here.</p>${link(`${path}/commits`, 'Compare commits', 'btn btn-primary')}</section>`;
  return frame({ title: 'Reviews', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Reviews' }], body: `<main class="page"><div class="page-head"><div><h1>Reviews</h1><p class="lead">${e(owner)}/${e(repo)}</p></div><div class="page-actions">${link(`${path}/commits`, 'Compare commits', 'btn btn-primary')}</div></div>${started ? '<div class="notice notice-info">Your review has started. It appears here in about two minutes. You can leave this page.</div>' : ''}<nav class="filter-row" aria-label="Review filters">${chips}</nav>${content}</main>` });
}

export function commitsPage({ user, owner, repo, branch, branches, tag = '', tags = [], commits, base = '', head = '', notice = null, files = [], swap = false }) {
  const path = repoPath(owner, repo);
  const branchOptions = branches.map((name) => `<option value="${e(name)}"${!tag && name === branch ? ' selected' : ''}>${e(name)}</option>`).join('');
  const tagOptions = tags.map((item) => `<option value="${e(item.name)}"${item.name === tag ? ' selected' : ''}>${e(item.name)}</option>`).join('');
  const chosen = (sha) => commits.find((commit) => commit.sha === sha);
  const selection = (label, commit) => `<section class="compare-slot"><strong>${label}</strong>${commit ? `<div><code>${e(commit.sha.slice(0, 7))}</code> ${e(commit.message)}</div><small class="muted">${e(commit.author)} · ${e(commit.date)}</small>` : '<div class="muted">not chosen</div>'}</section>`;
  const baseCommit = chosen(base); const headCommit = chosen(head);
  const rows = commits.map((commit) => `<tr><td><label><input type="radio" name="base" value="${e(commit.sha)}" aria-label="Base ${e(commit.sha)}"${commit.sha === base ? ' checked' : ''}> <span class="sr-only">Base</span></label></td><td><label><input type="radio" name="head" value="${e(commit.sha)}" aria-label="Head ${e(commit.sha)}"${commit.sha === head ? ' checked' : ''}> <span class="sr-only">Head</span></label></td><td><code>${e(commit.sha.slice(0, 7))}</code></td><td title="${e(commit.fullMessage || commit.message)}">${e(commit.message)}</td><td>${e(commit.author)}</td><td title="${e(commit.exactDate || commit.date)}">${e(commit.date)}</td><td>${commit.review ? link(`${path}/a/${encodeURIComponent(commit.review)}`, 'Reviewed') : ''}</td></tr>`).join('');
  const alert = notice ? `<div class="notice notice-${e(notice.kind)}" role="status">${e(notice.message)}${files.length ? `<ul>${files.map((file) => `<li><code>${e(file)}</code></li>`).join('')}</ul>` : ''}</div>` : '';
  const swapForm = swap ? `<form method="post" action="${path}/compare" class="swap-start"><input type="hidden" name="base" value="${e(head)}"><input type="hidden" name="head" value="${e(base)}"><button class="btn btn-primary">Swap and start</button></form>` : '';
  const script = `<script>(() => {
    const form = document.querySelector('.compare-form');
    const bar = document.querySelector('.compare-bar');
    if (!form || !bar) return;
    const button = form.querySelector('[type="submit"]');
    const status = bar.querySelector('[role="status"]');
    const slots = [...bar.querySelectorAll('.compare-slot')];
    if (!button || !status || slots.length < 2) return;
    const radios = [...form.querySelectorAll('input[type="radio"]')];
    const data = Object.fromEntries([...form.querySelectorAll('tbody tr')].map((row) => {
      const input = row.querySelector('input');
      if (!input) return null;
      return [input.value, { sha: input.value, message: row.children[3]?.textContent || '', author: row.children[4]?.textContent || '', date: row.children[5]?.textContent || '' }];
    }).filter(Boolean));
    function add(node, tag, text) { const child = document.createElement(tag); child.textContent = text; node.append(child); return child; }
    function show(slot, label, commit) {
      if (!slot) return;
      slot.replaceChildren(); add(slot, 'strong', label);
      if (commit) { const line = document.createElement('div'); add(line, 'code', commit.sha.slice(0, 7)); line.append(' ' + commit.message); slot.append(line); const details = add(slot, 'small', commit.author + ' · ' + commit.date); details.className = 'muted'; }
      else { const empty = add(slot, 'div', 'not chosen'); empty.className = 'muted'; }
    }
    function update() {
      const base = form.querySelector('[name=base]:checked')?.value;
      const head = form.querySelector('[name=head]:checked')?.value;
      show(slots[0], 'Base', data[base]); show(slots[1], 'Head', data[head]);
      button.disabled = !base || !head || base === head;
      status.className = 'muted'; status.replaceChildren();
      if (base && head && base === head) { status.className = 'notice-warn'; status.textContent = 'Base and Head are the same commit. Pick two different ones.'; }
      else if (base && head) {
        const headIndex = [...form.querySelectorAll('[name=head]')].findIndex((input) => input.value === head);
        const baseIndex = [...form.querySelectorAll('[name=base]')].findIndex((input) => input.value === base);
        if (headIndex > baseIndex) {
          status.className = 'notice-warn'; status.append('Head is older than Base. The review would show the change backwards. ');
          const swap = add(status, 'button', 'Swap'); swap.type = 'button'; swap.onclick = () => {
            const nextBase = form.querySelector('[name=base][value="' + head + '"]');
            const nextHead = form.querySelector('[name=head][value="' + base + '"]');
            if (!nextBase || !nextHead) return;
            nextBase.checked = true; nextHead.checked = true; update();
          };
        } else status.textContent = 'Compares ' + base.slice(0, 7) + ' → ' + head.slice(0, 7) + '.';
      }
    }
    radios.forEach((radio) => { radio.onchange = update; });
    form.querySelectorAll('tr').forEach((row) => { row.onkeydown = (event) => { if (event?.key === 'Enter') event.preventDefault(); }; });
    update();
  })()</script>`;
  return frame({ title: 'Compare commits', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Compare commits' }], body: `<main class="page"><div class="page-head"><div><h1>Compare commits</h1><p class="lead">Pick the earlier revision as Base and the later one as Head. The review shows what changed from Base to Head.</p></div></div>${alert}${swapForm}<form method="post" action="${path}/compare" class="compare-form"><div class="compare-bar">${selection('Base', baseCommit)}<span class="compare-arrow" aria-hidden="true">→</span>${selection('Head', headCommit)}<div class="compare-action"><button class="btn btn-primary" type="submit">Start review</button><div class="muted" role="status"></div></div></div><div class="source-picker"><label>Branch <select name="branch" form="source-picker">${branchOptions}</select></label><span class="muted">or a tag</span><label class="sr-only" for="tag">Tag</label><select id="tag" name="tag" form="source-picker"><option value="">Select a tag</option>${tagOptions}</select><button class="btn" form="source-picker">Show</button></div><table class="table"><thead><tr><th>Base</th><th>Head</th><th>SHA</th><th>Message</th><th>Author</th><th>Date</th><th></th></tr></thead><tbody>${rows}</tbody></table></form><form id="source-picker" method="get"></form>${script}</main>` });
}

export function reviewPage({ user, owner, repo, id, name, workflowRunId }) {
  const path = repoPath(owner, repo);
  const match = /^kicad-review-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail)\.html$/.exec(name || '');
  const revision = match ? `${match[1]} → ${match[2]}` : 'Review';
  const result = match ? (match[3] === 'pass' ? '<span class="status status-pass">✓ passing</span>' : '<span class="status status-fail">✕ failing</span>') : '';
  const raw = `${path}/a/${encodeURIComponent(id)}/raw`;
  const run = /^\d+$/.test(String(workflowRunId)) ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(workflowRunId)}` : '';
  const runLink = run ? link(run, 'Open the run on GitHub ↗') : '';
  const script = `<script>(() => { const iframe = document.getElementById('review-report'); const raw = ${JSON.stringify(raw)}; iframe.src = raw + location.hash; iframe.addEventListener('load', () => document.getElementById('review-loading').hidden = true); addEventListener('message', event => { if (event.source === iframe.contentWindow && typeof event.data?.kicadReviewHash === 'string' && event.data.kicadReviewHash.startsWith('#') && event.data.kicadReviewHash.length < 2000) history.replaceState(null, '', event.data.kicadReviewHash); }); })();</script>`;
  return frame({ title: revision, user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: match ? `Review ${revision}` : 'Review' }], body: `<main class="review-page"><div class="review-bar">${link(path, '← All reviews')}<span class="mono">${e(revision)}</span>${result}${runLink}</div><div class="review-stage"><div id="review-loading" class="review-loading"><span class="spinner" aria-hidden="true"></span><span>Loading the review…</span></div><iframe id="review-report" src="${e(raw)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" allow="clipboard-write" referrerpolicy="same-origin" title="KiCad review report"></iframe></div></main>${script}` });
}

const revisionSha = /^[0-9a-f]{7,40}$/;
const stages = ['Waiting to start', 'Getting the files', 'Rendering and checking', 'Building the report', 'Finishing'];

function stageForStep(name) {
  const value = String(name || '').toLowerCase();
  if (value.includes('check out')) return 1;
  if (value.includes('render') || value.includes('find changed')) return 2;
  if (value.includes('build comparison report') || value.includes('upload report') || value.includes('screenshots') || value.includes('publish')) return 3;
  return 4;
}

function progressStages(status, jobs) {
  const steps = (jobs || []).flatMap((job) => Array.isArray(job.steps) ? job.steps : []);
  const started = steps.some((step) => step.status === 'in_progress' || step.status === 'completed' || step.started_at);
  const result = stages.map((name, index) => ({ name, index, steps: [], state: 'todo' }));
  if (status === 'queued' || !started) result[0].state = 'active';
  else result[0].state = 'done';
  for (const step of steps) result[stageForStep(step.name)].steps.push(step);
  for (const stage of result.slice(1)) {
    if (!stage.steps.length) continue;
    if (stage.steps.some((step) => step.conclusion === 'failure')) stage.state = 'failed';
    else if (stage.steps.some((step) => step.status === 'in_progress')) stage.state = 'active';
    else if (stage.steps.every((step) => step.status === 'completed')) stage.state = 'done';
  }
  return result;
}

function shortAgo(value) {
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return 'at an unknown time';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function elapsedTime(value) {
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function revisions(base, head) {
  return revisionSha.test(base || '') && revisionSha.test(head || '') ? { base, head } : null;
}

function runActions(path, githubUrl, revisions) {
  return `${revisions ? `<form method="post" action="${e(`${path}/compare`)}"><input type="hidden" name="base" value="${e(revisions.base)}"><input type="hidden" name="head" value="${e(revisions.head)}"><button class="btn btn-primary">Try again</button></form>` : ''}${githubUrl ? `<a class="btn" href="${e(githubUrl)}">Open the run on GitHub ↗</a>` : ''}<a class="btn" href="${e(path)}">Back to reviews</a>`;
}

export function runPage({ user, owner, repo, running, status, githubUrl, base, head, startedAt, jobs = [], state = 'generating', failedStage, failedStep }) {
  const path = repoPath(owner, repo);
  const recorded = revisions(base, head);
  const crumb = state === 'generating' ? 'Generating review' : state === 'nothing' ? 'Nothing to review' : state === 'failed' ? 'Review failed' : 'This review has expired';
  if (state === 'nothing') {
    return frame({ title: crumb, user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: crumb }], body: `<main class="page"><section class="card empty"><h1>Nothing to review</h1><p class="notice notice-info">No KiCad files changed between these revisions.</p><p><a class="btn btn-primary" href="${e(`${path}/commits`)}">Compare other commits</a> <a class="btn" href="${e(path)}">Back to reviews</a></p></section></main>` });
  }
  if (state === 'failed') {
    const message = failedStage && failedStep ? `The run stopped at ${failedStage} (${failedStep}).` : 'The run stopped before the report was ready.';
    return frame({ title: crumb, user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: crumb }], body: `<main class="page"><section class="card empty"><h1>Review failed</h1><p class="notice notice-error">${e(message)}</p><div class="page-actions">${runActions(path, githubUrl, recorded)}</div></section></main>` });
  }
  if (state === 'expired') {
    const regenerate = recorded ? `<form method="post" action="${e(`${path}/compare`)}"><input type="hidden" name="base" value="${e(recorded.base)}"><input type="hidden" name="head" value="${e(recorded.head)}"><button class="btn btn-primary">Generate it again</button></form>` : '';
    return frame({ title: crumb, user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: crumb }], body: `<main class="page"><section class="card empty"><h1>This review has expired</h1><p class="notice notice-warn">Reviews are kept for 90 days by GitHub. Generate it again to see it.</p><div class="page-actions">${regenerate}<a class="btn" href="${e(path)}">Back to reviews</a></div></section></main>` });
  }
  const progress = progressStages(status, jobs).map((stage) => {
    const symbol = stage.state === 'done' ? '✓' : stage.state === 'active' ? `● <span class="spinner" aria-hidden="true"></span>` : stage.state === 'failed' ? '✕' : '○';
    const word = stage.state === 'active' ? 'in progress' : stage.state === 'todo' ? 'waiting' : stage.state;
    return `<li class="${stage.state}">${symbol} ${e(stage.name)} <span class="step-state">· ${word}</span></li>`;
  }).join('');
  const lead = recorded ? `<span class="mono">${e(recorded.base.slice(0, 7))} → ${e(recorded.head.slice(0, 7))}</span>, started ${e(shortAgo(startedAt))}` : `Revisions: not recorded, started ${e(shortAgo(startedAt))}`;
  const revisionLine = recorded ? `Revisions: <span class="mono">${e(recorded.base)} → ${e(recorded.head)}</span>` : 'Revisions: not recorded';
  const github = githubUrl ? `<p><a href="${e(githubUrl)}">Follow the run on GitHub ↗</a></p>` : '';
  return frame({ title: 'Generating review', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: crumb }], meta: running ? '<meta http-equiv="refresh" content="5">' : '', body: `<main class="page"><div class="page-head"><div><h1>Generating review</h1><p class="lead">${lead}</p></div></div><section class="card"><ul class="steps">${progress}</ul><p class="muted">Elapsed time: ${e(elapsedTime(startedAt))}</p><p>Usually takes about 2 minutes. You can leave this page. The finished review appears under Reviews.</p><p>${revisionLine}</p>${github}</section></main>` });
}

export function messagePage({ title, message, details = [], links = [], user, owner, repo, kind = 'error' }) {
  const crumbs = owner && repo ? [{ href: '/', label: 'Repositories' }, { href: repoPath(owner, repo), label: `${owner}/${repo}` }, { label: title }] : [{ label: title }];
  const status = {
    error: { symbol: '✕', word: 'Error' },
    warn: { symbol: '!', word: 'Warning' },
    info: { symbol: 'i', word: 'Information' },
  }[kind] || { symbol: '✕', word: 'Error' };
  const detailList = details.length ? `<ul class="message-details muted">${details.map((detail) => `<li>${e(detail)}</li>`).join('')}</ul>` : '';
  const actions = links.length ? `<p class="message-actions">${links.map((item, index) => link(item.href, item.label, index === 0 ? 'btn btn-primary' : 'btn')).join(' ')}</p>` : '';
  return frame({ title, user, crumbs, body: `<main class="page message-page"><section class="card message-card"><h1 class="message-head"><span class="message-symbol message-symbol-${e(kind)}" aria-hidden="true">${status.symbol}</span><span>${e(title)} <span class="message-kind">${status.word}</span></span></h1><p>${e(message)}</p>${detailList}${actions}</section></main>` });
}

function status(value) {
  if (value === 'pass') return '<span class="status status-pass">✓ passing</span>';
  if (value === 'fail') return '<span class="status status-fail">✕ failing</span>';
  if (value === 'new') return '<span class="status status-new">New</span>';
  if (value === 'error') return '<span class="status status-error">⚠ Error</span>';
  return '<span class="status status-notrun">— not recorded</span>';
}
