import tokens from '../ui/tokens.css';
import theme from '../ui/theme.js';
import icons from '../ui/icons/sprite.svg';
import site from './site.css';
import { readinessClient } from './readiness-client.js';
import { threadsClient } from './threads-client.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const e = escapeHtml;
const repoPath = (owner, repo) => `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const link = (href, label, className = '') => `<a${className ? ` class="${className}"` : ''} href="${e(href)}">${e(label)}</a>`;
export function siteBadge(value, label) {
  const states = {
    pass: ['✓', 'passing'], fail: ['✕', 'failing'], new: ['+', 'New'],
    error: ['✕', 'Error'], removed: ['−', 'Removed'], modified: ['~', 'Modified'],
    waived: ['○', 'Waived'], notrun: ['·', 'not recorded'],
  };
  const key = Object.hasOwn(states, value) ? value : 'notrun';
  const [glyph, word] = states[key];
  return `<span class="status status-${key}">${glyph} ${e(label ?? word)}</span>`;
}
export function siteTable(headings, rows, label) {
  return `<div class="table-scroll"><table class="table" aria-label="${e(label)}"><thead><tr>${headings.map(h => `<th scope="col">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headings.length}" class="muted">No items</td></tr>`}</tbody></table></div>`;
}

const HISTORY_KINDS = [['all', 'All'], ['checks', 'Checks'], ['review', 'Reviews'], ['thread', 'Threads'], ['commit', 'Commits']];
export function historyPage({ user, owner, repo, pull, title, events, filter }) {
  if (['reviews', 'threads', 'commits'].includes(filter)) filter = filter.slice(0, -1);
  if (!HISTORY_KINDS.some(([kind]) => kind === filter)) filter = 'all';
  const path = repoPath(owner, repo);
  const shown = filter === 'all' ? events : events.filter(ev => ev.kind === filter);
  const rows = shown.map(ev => {
    const safe = String(ev.href || '').startsWith(`${path}/a/`) && /^\d+$/.test(String(ev.href).slice(`${path}/a/`.length));
    return `<li class="hist" data-kind="${e(ev.kind)}"><span class="history-node" aria-hidden="true"></span><time datetime="${e(ev.time)}">${e(String(ev.time).replace('T', ' ').slice(0, 16))} UTC</time> <span class="hist-kind">${e(ev.kind)}</span> ${safe ? link(ev.href, ev.text) : e(ev.text)} <span class="muted">${e(ev.who)}</span></li>`;
  }).join('');
  return frame({ title: `History #${pull}`, user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: `#${pull} history` }],
    body: `<main class="page"><div class="page-head"><div><h1>${e(title)}</h1><p class="lead">Everything that happened in this pull request's review, newest first.</p></div></div>
      <nav class="filter-row" aria-label="History filters">${HISTORY_KINDS.map(([kind, label]) => `<a class="filter-chip" href="?f=${kind}"${filter === kind ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <ol class="history">${rows || '<li class="muted">Nothing yet.</li>'}</ol></main>` });
}

export function frame({ title, user, crumbs = [], body, meta = '', navigation = true, reviewStatus = '' }) {
  const trail = crumbs.map((crumb, index) => `<span>${index < crumbs.length - 1 && crumb.href ? link(crumb.href, crumb.label) : e(crumb.label)}</span>`).join('');
  const account = `<details class="bench-menu account"><summary aria-label="User menu">${e(user || 'Viewer')} ▾</summary><div class="bench-popover"><span class="bench-label">Theme</span><div class="bench-themes">${['Dark', 'Light', 'System'].map(t => `<button type="button" data-theme-set="${t.toLowerCase()}" aria-pressed="false">${t}</button>`).join('')}</div>${user ? '<form method="post" action="/logout"><button>Sign out</button></form>' : '<span class="muted">Read-only viewer</span>'}</div></details>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · KiCad review</title>${meta}<script>${theme}</script><style>${tokens}\n${site}</style></head><body>${icons}<header class="top">${navigation ? '<a class="product" href="/">' : '<span class="product">'}<svg class="bench-mark" aria-hidden="true"><use href="#kr-mark"></use></svg>KiCad review${navigation ? '</a>' : '</span>'}${trail ? `<nav class="crumbs" aria-label="Breadcrumb">${trail}</nav>` : ''}${reviewStatus ? `<span class="bench-state" role="status">${e(reviewStatus)}</span>` : ''}${account}</header>${body}</body></html>`;
}

export function signedOutPage({ sessionEnded = false } = {}) {
  const notice = sessionEnded ? '<p class="notice notice-info" role="status">You were signed out. Sign in again to continue.</p>' : '';
  return frame({ title: 'Repositories', body: `<main class="page signed-out-page"><section class="card signed-out-card"><div class="bench-module-head"><span class="bench-cap">Design review instrument</span><span class="bench-ticks" aria-hidden="true"></span></div><h1>KiCad review</h1><p class="signed-out-intro">See what changed on the schematic and board in each commit or pull request, with ERC and DRC results.</p>${notice}<p>${link('/login', 'Sign in with GitHub', 'btn btn-primary')}</p><div class="signed-out-permissions"><p>When you sign in, GitHub asks you to allow this app to:</p><ul><li>Verify your GitHub identity</li><li>Know which resources you can access</li><li>Act on your behalf (only within what you can already do)</li></ul><p>It reads only repositories you already have access to.</p></div></section></main>` });
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

// bench-t8: opening modules use only recorded GitHub metadata.
const moduleTitle = (title, note = '') => `<div class="bench-module-head"><h2>${e(title)}</h2><span class="bench-ticks" aria-hidden="true"></span><span class="muted mono">${e(note)}</span></div>`;
const led = result => `<span class="bench-led ${result === 'pass' ? 'ok' : result === 'fail' ? 'bad' : ''}" aria-hidden="true"></span>`;

export function homePage({ user, repositories = [], recent = [], activity = [], errors = [], limited = false }) {
  const latest = recent.find(item => item.pull) || recent[0];
  const first = repositories[0];
  const path = first ? repoPath(first.owner.login, first.name) : '';
  const reviewUrl = item => `${repoPath(item.owner, item.repo)}/a/${encodeURIComponent(item.id)}`;
  const action = (href, title, detail, icon, primary = false) => `<a class="bench-action${primary ? ' first' : ''}" href="${e(href)}"><span class="bench-action-icon" aria-hidden="true">${icon}</span><strong>${e(title)}</strong><small>${e(detail)}</small></a>`;
  const rows = recent.map(item => `<tr data-result="${e(item.result)}"><td>${led(item.result)}${link(reviewUrl(item), item.pull ? `PR #${item.pull.number} · ${item.pull.title}` : item.branch || 'Commit comparison')}<small class="bench-sub">${e(item.owner)}/${e(item.repo)}</small></td><td>${siteBadge(item.result, item.result === 'pass' ? 'Checks pass' : item.result === 'fail' ? 'Checks fail' : 'Checks unknown')}</td><td><span class="muted" title="Approval and blocking threads are checked inside the review">${e(item.freshness || 'Not checked')} · approval unknown</span></td><td class="mono">${e(item.base)} → ${e(item.head)}</td><td class="mono" title="${e(item.createdAt)}">${e(relativeTime(item.createdAt))}</td></tr>`).join('');
  const repos = repositories.map(repo => {
    const target = repoPath(repo.owner.login, repo.name);
    const ticks = (repo.runs || []).slice(0, 12).reverse().map(run => `<i class="${run.conclusion === 'success' ? 'ok' : run.conclusion === 'failure' ? 'bad' : 'pending'}" title="${e(`${run.name || 'Workflow'}: ${run.conclusion || run.status || 'unknown'} · ${run.created_at || ''}`)}"></i>`).join('');
    return `<article class="bench-repository">${led(repo.latest?.result)}<div>${link(target, `${repo.owner.login}/${repo.name}`)}<small class="bench-sub">${e(repo.private ? 'private' : 'public')} · <code>${e(repo.default_branch || 'not recorded')}</code> · <span title="${e(repo.pushed_at)}">${e(relativeTime(repo.pushed_at))}</span></small><small class="bench-sub">${repo.latest ? `Latest checks: ${e(repo.latest.result === 'pass' ? 'passing' : repo.latest.result === 'fail' ? 'failing' : 'unknown')}` : 'No recent review recorded'} · ${link(`${target}/commits`, 'Compare commits')}</small></div><div class="bench-runs" aria-label="Recent workflow runs">${ticks || '<small class="muted">No run data</small>'}</div></article>`;
  }).join('');
  const empty = `<section class="empty bench-empty"><h3>No repositories granted</h3><p>No repositories yet. An owner or admin installs the KiCad review GitHub App on the repositories you can open.</p></section>`;
  const script = `<script>(() => { const form = document.getElementById('bench-link'); form.addEventListener('submit', event => { event.preventDefault(); const message = form.querySelector('[role=status]'); try { const url = new URL(form.elements.link.value, location.origin); if (url.origin !== location.origin || !/^\\/(?:r\\/[^/]+\\/[^/]+\\/a\\/[^/]+|s\\/[^/]+)$/.test(url.pathname)) throw new Error(); location.assign(url.pathname + url.search + url.hash); } catch { message.textContent = 'Paste a review link from this site.'; } }); })()</script>`;
  return frame({ title: 'Start', user, crumbs: [{ label: 'Start' }], body: `<main class="bench-start"><aside class="bench-column"><section class="bench-module">${moduleTitle('Quick actions')}${latest ? action(reviewUrl(latest), latest.pull ? 'Open latest PR review' : 'Open latest review', `${latest.owner}/${latest.repo}`, '↗', true) : '<div class="bench-empty muted">No recent review to open.</div>'}${action(path ? `${path}/commits` : '#repositories', 'Compare commits', 'Pick a repository, then Base → Head', '⇄')}${action('#repositories', 'Open repository', 'Browse installed repositories', '▱')}${action('#bench-link', 'Paste review link', 'Open a review or shared snapshot', '↗')}<form id="bench-link" class="bench-link"><label for="review-link">Review link</label><input id="review-link" name="link" type="text" required placeholder="Paste a link from this site"><button class="btn" type="submit">Open review link</button><small role="status"></small></form></section>${repositories.length ? `<section class="bench-module">${moduleTitle('Compare commits')}<form id="bench-compare" class="bench-link" action="${e(path)}/commits"><label for="bench-repository">Repository</label><select id="bench-repository" name="repository">${repositories.map(repo => `<option value="${e(repoPath(repo.owner.login, repo.name))}/commits">${e(repo.owner.login)}/${e(repo.name)}</option>`).join('')}</select><small class="muted">Choose Base → Head on the next screen.</small><button class="btn btn-primary">Choose revisions →</button></form></section>` : ''}<section class="bench-module">${moduleTitle('Session')}<div class="bench-empty"><p>Signed in as ${e(user)}</p><p class="muted">Only repositories granted to the GitHub App are shown. Choose Compare commits to select revisions and start a review.</p></div></section></aside><section class="bench-column bench-center">${errors.length ? `<div class="notice notice-warn" role="status"><strong>Some GitHub data is unavailable.</strong> ${e(errors.join(' '))} ${link('/', 'Retry')}</div>` : ''}<section class="bench-module">${moduleTitle('Recent reviews', `${recent.length} recorded`)}${rows ? '<div class="bench-search"><label class="sr-only" for="bench-search">Search recent reviews</label><input id="bench-search" type="search" placeholder="Search reviews, repositories, revisions…"><label class="sr-only" for="bench-filter">Check result</label><select id="bench-filter"><option value="all">All checks</option><option value="pass">Passing</option><option value="fail">Failing</option></select></div>' : ''}${rows ? siteTable(['Review / repository', 'Checks', 'Readiness', 'Revisions', 'Updated'], rows, 'Recent reviews') + '<p id="bench-search-state" class="bench-footnote" role="status"></p>' : '<div class="bench-empty"><h3>No recent reviews</h3><p>Reviews appear after the KiCad review workflow uploads a report. Compare commits in a repository to start one.</p></div>'}<p class="bench-footnote">Latest 20 reports from the 5 most recently updated repositories. Check chips reflect the report result; approval and blocking threads are verified when opening a review.</p></section></section><aside class="bench-column"><section class="bench-module" id="repositories" aria-label="Repositories">${moduleTitle('Repositories', `${repositories.length} accessible`)}${repos || (errors.length ? '<p class="bench-empty">Repository data could not be loaded. Retry to check access.</p>' : empty)}${limited ? '<p class="bench-footnote">Showing the first 5 app installations; repository lists are limited to 100 per installation.</p>' : ''}</section><section class="bench-module">${moduleTitle('Activity', 'Workflow runs')}${activity.length ? activity.slice(0, 12).map(item => `<div class="bench-activity">${led(item.conclusion === 'success' ? 'pass' : item.conclusion === 'failure' ? 'fail' : '')}<div><strong>${e(item.name || 'Workflow')}</strong><small class="bench-sub">${e(item.owner)}/${e(item.repo)} · ${e(item.conclusion || item.status || 'unknown')}</small><small class="mono muted">${e(relativeTime(item.created_at))}</small></div></div>`).join('') : '<p class="bench-empty muted">No recent workflow activity available.</p>'}</section><section class="bench-module">${moduleTitle('Reading the instrument')}<div class="bench-empty muted"><p>${siteBadge('pass')} Checks passed</p><p>${siteBadge('fail')} Checks need attention</p><p>Unknown does not mean ready. Open the review for detailed checks and merge readiness.</p></div></section></aside></main>${script}<script>(() => {
  const search = document.getElementById('bench-search');
  const filter = document.getElementById('bench-filter');
  const rows = [...document.querySelectorAll('[data-result]')];
  const apply = () => { let count = 0; for (const row of rows) { row.hidden = !(row.textContent.toLowerCase().includes(search.value.toLowerCase()) && (filter.value === 'all' || row.dataset.result === filter.value)); if (!row.hidden) count++; } document.getElementById('bench-search-state').textContent = count ? '' : 'No reviews match these filters.'; };
  search?.addEventListener('input', apply); filter?.addEventListener('change', apply);
  const compare = document.getElementById('bench-compare');
  compare?.addEventListener('submit', event => { event.preventDefault(); location.assign(compare.elements.repository.value); });
})()</script>` });
}

export function reviewsPage({ user, owner, repo, items, counts = {}, filter = 'all', started, view = 'list', groups = null }) {
  const path = repoPath(owner, repo);
  const chips = [['all', 'All'], ['passing', 'Passing'], ['failing', 'Failing'], ['older', 'Older']]
    .map(([value, label]) => `<a class="filter-chip" href="${path}?filter=${value}${view === 'milestones' ? '&amp;view=milestones' : ''}"${filter === value ? ' aria-current="page"' : ''}>${label} ${counts[value] || 0}</a>`).join('')
    + ` <a class="filter-chip" href="${path}?view=milestones&amp;filter=${e(filter)}"${view === 'milestones' ? ' aria-current="page"' : ''}>Milestones</a>`
    + (view === 'milestones' ? ` <a class="filter-chip" href="${path}?filter=${e(filter)}">List</a>` : '');
  const table = rows => siteTable(['Review', 'Revisions', 'Result', 'Updated', 'Open'], rows, 'Reviews');
  const card = (item) => {
    const branch = item.manual ? 'Manual comparison' : item.branch;
    const revision = item.legacy ? 'Revisions not recorded (older report)' : `${item.base} → ${item.head}`;
    const pr = item.pull ? `<span class="muted">PR #${e(item.pull.number)} (${e(item.pull.merged ? 'merged' : item.pull.state)})</span>` : '';
    return `<tr class="review-card"><td class="review-list-title">${e(branch)} ${item.label ? `<span class="muted">${e(item.label)}</span>` : ''} ${pr}</td><td class="mono">${e(revision)}</td><td>${status(item.result)}</td><td class="mono" title="${e(item.createdAt)}">${e(relativeTime(item.createdAt))} · ${e(item.date)}</td><td>${link(`${path}/a/${encodeURIComponent(item.id)}${item.pdf ? '?pdf=1' : ''}`, 'Open review →')}</td></tr>`;
  };
  const cards = items.map(card).join('');
  let content = cards ? table(cards) : `<section class="card empty"><h2>No reviews yet</h2><p>Reviews appear after a push or pull request that changes KiCad files, or after a comparison started here.</p>${link(`${path}/commits`, 'Compare commits', 'btn btn-primary')}</section>`;
  if (view === 'milestones') {
    if (groups === null) content = `<p class="notice notice-info">${e("Milestones need the app's Pull requests permission.")}</p>`;
    else if (groups.length) content = groups.map(group => {
      const safeUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/milestone\/\d+$/.test(group.url || '');
      const total = group.open + group.merged;
      const progress = `<p class="milestone-progress"><progress max="${Math.max(1, total)}" value="${group.merged}" aria-label="Merged pull requests"></progress><span class="mono">${group.merged}/${total}</span><span class="muted">merged of open or merged · ${e(group.open)} open · ${e(group.merged)} merged</span></p>`;
      return `<section><h2>${safeUrl ? link(group.url, group.title) : e(group.title)}</h2>${progress}${table(group.items.map(card).join(''))}</section>`;
    }).join('');
  }
  return frame({ title: 'Reviews', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Reviews' }], body: `<main class="page page-wide bench-opening"><div class="page-head"><div><h1>Reviews</h1><p class="lead">${e(owner)}/${e(repo)}</p></div><div class="page-actions">${link(`${path}/commits`, 'Compare commits', 'btn btn-primary')}</div></div>${started ? '<div class="notice notice-info">Your review has started. It appears here in about two minutes. You can leave this page.</div>' : ''}<nav class="filter-row" aria-label="Review filters">${chips}</nav>${content}</main>` });
}

export function commitsPage({ user, owner, repo, branch, branches, tag = '', tags = [], commits, base = '', head = '', notice = null, files = [], swap = false }) {
  const path = repoPath(owner, repo);
  const branchOptions = branches.map((name) => `<option value="${e(name)}"${!tag && name === branch ? ' selected' : ''}>${e(name)}</option>`).join('');
  const tagOptions = tags.map((item) => `<option value="${e(item.name)}"${item.name === tag ? ' selected' : ''}>${e(item.name)}</option>`).join('');
  const chosen = (sha) => commits.find((commit) => commit.sha === sha);
  const selection = (label, commit) => `<section class="compare-slot"><strong>${label}</strong>${commit ? `<div><code>${e(commit.sha.slice(0, 7))}</code> ${e(commit.message)}</div><small class="muted">${e(commit.author)} · ${e(commit.date)}</small>` : '<div class="muted">not chosen</div>'}</section>`;
  const baseCommit = chosen(base); const headCommit = chosen(head);
  const rows = commits.map((commit) => `<tr><td><label><input type="radio" name="base" value="${e(commit.sha)}" aria-label="Base ${e(commit.sha)}"${commit.sha === base ? ' checked' : ''}> <span class="sr-only">Base</span></label></td><td><label><input type="radio" name="head" value="${e(commit.sha)}" aria-label="Head ${e(commit.sha)}"${commit.sha === head ? ' checked' : ''}> <span class="sr-only">Head</span></label></td><td><code>${e(commit.sha.slice(0, 7))}</code></td><td title="${e(commit.fullMessage || commit.message)}">${e(commit.message)}</td><td>${e(commit.author)}</td><td title="${e(commit.exactDate || commit.date)}">${e(commit.date)}</td><td>${commit.review ? link(`${path}/a/${encodeURIComponent(commit.review)}${commit.pdf ? '?pdf=1' : ''}`, 'Reviewed') : ''}</td></tr>`).join('');
  const alert = notice ? `<div class="notice notice-${e(notice.kind)}" role="status">${e(notice.message)}${files.length ? `<ul class="changed-files mono">${files.map((file) => `<li>${e(file)}</li>`).join('')}</ul>` : ''}</div>` : '';
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
    document.querySelector('[name=branch]').onchange = () => { document.querySelector('[name=tag]').value = ''; };
    form.querySelectorAll('tr').forEach((row) => { row.onkeydown = (event) => { if (event?.key === 'Enter' && event.target.matches('input[type=radio]')) event.preventDefault(); }; });
    update();
  })()</script>`;
  return frame({ title: 'Compare commits', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Compare commits' }], body: `<main class="page bench-opening"><div class="page-head"><div><h1>Compare commits</h1><p class="lead">Pick the earlier revision as Base and the later one as Head. The review shows what changed from Base to Head.</p></div></div>${alert}${swapForm}<form method="post" action="${path}/compare" class="compare-form"><div class="source-picker"><label>Branch <select name="branch" form="source-picker">${branchOptions}</select></label><span class="muted">or a tag</span><label class="sr-only" for="tag">Tag</label><select id="tag" name="tag" form="source-picker"><option value="">Select a tag</option>${tagOptions}</select><button class="btn" form="source-picker">Show</button></div><div class="table-scroll"><table class="table" aria-label="Commit revisions"><thead><tr><th>Base <span class="compare-letter" aria-hidden="true">A</span></th><th>Head <span class="compare-letter" aria-hidden="true">B</span></th><th>SHA</th><th>Message</th><th>Author</th><th>Date</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="compare-bar">${selection('Base', baseCommit)}<span class="compare-arrow" aria-hidden="true">→</span>${selection('Head', headCommit)}<div class="compare-action"><button class="btn btn-primary" type="submit">Start review</button><div class="muted" role="status"></div></div></div></form><form id="source-picker" method="get"></form>${script}</main>` });
}

export function reviewPage({ user, owner, repo, id, name, workflowRunId, pdf = false, pull = null, runStatus = null, runConclusion = null, share = false }) {
  const path = repoPath(owner, repo);
  const match = /^kicad-review-([0-9a-f]{7}|none)-([0-9a-f]{7})-(pass|fail)\.html$/.exec(name || '');
  const revision = match ? `${match[1]} → ${match[2]}` : 'Review';
  const result = runStatus === 'completed' && runConclusion ? (runConclusion === 'success' ? '<span class="status status-pass">✓ run passing</span>' : `<span class="status status-fail">✕ run ${e(runConclusion.replace(/_/g, ' '))}</span>`)
    : runStatus ? `<span class="status">… run ${e(runStatus.replace(/_/g, ' '))}</span>`
    : '<span class="muted">Run result not recorded</span>';
  const raw = `${path}/a/${encodeURIComponent(id)}/raw`;
  const run = /^\d+$/.test(String(workflowRunId)) ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(workflowRunId)}` : '';
  const runLink = run ? link(run, 'Open run ↗') : '';
  const script = reportFrameScript(raw);
  const sharing = share ? shareControls(`${path}/a/${encodeURIComponent(id)}/share`, `${path}/share/revoke`) : '';
  const readiness = mergeBadge(Number.isInteger(pull) ? 'Checking…' : 'Not a PR', Number.isInteger(pull) ? 'Checking merge readiness…' : 'Merge readiness requires a pull request.');
  const readinessScript = Number.isInteger(pull) ? `<script>(${readinessClient.toString()})(${JSON.stringify({ readiness: `${path}/pull/${pull}/readiness`, reviewHead: match ? match[2] : null }).replace(/</g, '\\u003c')});</script>` : '';
  const notice = '<p id="thread-notice" class="muted" role="status" hidden></p>';
  const threads = `<dialog id="thread-composer" class="thread-dialog" aria-labelledby="thread-composer-title"><form method="dialog"><h2 id="thread-composer-title">New thread</h2><label hidden>Title<input name="title" maxlength="256"></label><p class="thread-target mono"></p>
      <fieldset><legend>Kind</legend><label><input type="radio" name="severity" value="comment" checked> Comment</label> <label><input type="radio" name="severity" value="blocking"> Blocking: must be resolved before merging</label></fieldset>
      <label>Text<textarea name="text" rows="5" required maxlength="10000"></textarea></label>
      <p class="muted thread-shortcut">Ctrl+Enter to submit · Esc to close</p>
      <p role="status" class="muted"></p><p class="dialog-actions"><button class="btn btn-primary">Create thread</button> <button type="button" class="btn" data-act="close">Cancel</button></p></form></dialog>
    <dialog id="thread-view" class="thread-dialog" aria-labelledby="thread-view-title"><form method="dialog"><h2 id="thread-view-title"></h2><ol class="thread-comments"></ol>
      <label>Reply<textarea name="text" rows="3" maxlength="10000"></textarea></label>
      <p class="muted thread-shortcut">Ctrl+Enter to submit · Esc to close</p>
      <p role="status" class="muted"></p><p class="dialog-actions"><button class="btn btn-primary" data-act="reply">Reply</button> <button class="btn" data-act="resolve">Resolve</button> <button class="btn" data-act="issue" hidden>Create issue</button> <button type="button" class="btn" data-act="close">Close</button></p></form></dialog>
    <script>(${threadsClient.toString()})(${JSON.stringify({ threads: Number.isInteger(pull) ? `${path}/pull/${pull}/threads` : null, issues: `${path}/issues`, pull, rerun: Number.isInteger(pull) ? `${path}/pull/${pull}/rerun` : null, run: `${path}/run/`, link: `${path}/a/${encodeURIComponent(id)}` }).replace(/</g, '\\u003c')});</script>`;
  return frame({ title: revision, user, reviewStatus: match?.[3] === 'fail' || (runStatus === 'completed' && runConclusion && runConclusion !== 'success') ? '✕ NEEDS WORK' : match ? '✓ CHECKS PASSING' : 'REVIEW', crumbs: [{ href: path, label: `${owner}/${repo}` }, { label: Number.isInteger(pull) ? `PR #${pull}` : 'Review' }], body: `<main class="review-page"><nav class="review-bar" aria-label="Review navigation">${revisionChips(match)}${Number.isInteger(pull) ? link(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${pull}`, `PR #${pull} ↗`) : ''}${workflowRunId && /^\d+$/.test(String(workflowRunId)) ? `<span class="mono">Run ${e(workflowRunId)}</span>` : ''}${result}${readiness}${reviewOverflow(`${Number.isInteger(pull) ? link(`${path}/pull/${pull}/history`, 'History') : '<button disabled title="History requires a pull request">History</button>'}${share ? '<button id="share-open" type="button">Share…</button>' : '<button disabled title="Sharing is not enabled for this review">Share…</button>'}${runLink || '<button disabled title="Run not recorded">Open run</button>'}${pdf ? link(`${path}/a/${encodeURIComponent(id)}/pdf`, 'Download PDF') : ''}`)}${notice}</nav><div class="review-stage"><div id="review-loading" class="review-loading"><span class="spinner" aria-hidden="true"></span><span>Loading the review…</span></div><iframe id="review-report" src="${e(raw)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" allow="clipboard-write" referrerpolicy="same-origin" title="KiCad review report"></iframe></div></main>${script}${readinessScript}${threads}${sharing}` });
}

const revisionSha = /^[0-9a-f]{7,40}$/;
export const stages = ['Waiting to start', 'Getting the files', 'Rendering and checking', 'Building the report', 'Finishing'];

export function stageForStep(name) {
  const value = String(name || '').toLowerCase();
  if (value === 'set up job' || value.startsWith('skip push') || value.includes('check out') || value.includes('find changed')) return 1;
  if (value.includes('render') || value.includes('compress')) return 2;
  if (value.includes('build comparison report') || value.includes('copy named report') || value.includes('upload report') || value.includes('screenshots') || value.includes('publish')) return 3;
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
    if (stage.steps.some((step) => step.conclusion === 'failure')) stage.state = 'failed';
    else if (stage.steps.length && stage.steps.every((step) => step.status === 'completed')) stage.state = 'done';
  }
  const startedStages = result.slice(1).filter((stage) => stage.steps.some((step) => step.status === 'in_progress' || step.status === 'completed' || step.started_at));
  const latestStarted = startedStages.length ? Math.max(...startedStages.map((stage) => stage.index)) : 0;
  for (const stage of result.slice(1)) {
    if (stage.state !== 'failed' && stage.steps.some((step) => step.status === 'in_progress')) stage.state = 'active';
  }
  if (status === 'in_progress' && !result.some((stage) => stage.state === 'active' && stage.index > 0)) {
    const firstNotDone = result.slice(1).find((stage) => stage.state !== 'done' && stage.state !== 'failed');
    if (firstNotDone && latestStarted <= firstNotDone.index) firstNotDone.state = 'active';
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
    return frame({ title: crumb, user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: crumb }], body: `<main class="page"><section class="card empty"><h1>Nothing to review</h1><p class="notice notice-info">No KiCad files changed between these revisions.</p><div class="page-actions"><a class="btn btn-primary" href="${e(`${path}/commits`)}">Compare other commits</a><a class="btn" href="${e(path)}">Back to reviews</a></div></section></main>` });
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
    const symbol = stage.state === 'done' ? '✓' : stage.state === 'active' ? `<span class="spinner" aria-hidden="true"></span>` : stage.state === 'failed' ? '✕' : '○';
    const word = stage.state === 'active' ? 'in progress' : stage.state === 'todo' ? 'waiting' : stage.state;
    return `<li class="${stage.state}">${symbol} ${e(stage.name)} <span class="step-state">· ${word}</span></li>`;
  }).join('');
  const lead = recorded ? `<span class="mono">${e(recorded.base.slice(0, 7))} → ${e(recorded.head.slice(0, 7))}</span>, started ${e(shortAgo(startedAt))}` : `Revisions: not recorded, started ${e(shortAgo(startedAt))}`;
  const revisionLine = recorded ? `Revisions: <span class="mono"><span title="${e(recorded.base)}">${e(recorded.base.slice(0, 7))}</span> → <span title="${e(recorded.head)}">${e(recorded.head.slice(0, 7))}</span></span>` : 'Revisions: not recorded';
  const github = githubUrl ? `<p><a href="${e(githubUrl)}">Follow the run on GitHub ↗</a></p>` : '';
  return frame({ title: 'Generating review', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: crumb }], meta: running ? '<meta http-equiv="refresh" content="5">' : '', body: `<main class="page"><div class="page-head"><div><h1>Generating review</h1><p class="lead">${lead}</p></div></div><section class="card"><ul class="steps" aria-label="Review stages">${progress}</ul><p class="muted" role="status" aria-live="polite">Elapsed time: ${e(elapsedTime(startedAt))}</p><p>Usually takes about 2 minutes. You can leave this page. The finished review appears under Reviews.</p><p>${revisionLine}</p>${github}</section></main>` });
}

export function messagePage({ title, message, code, details = [], links = [], user, owner, repo, kind = 'error' }) {
  const crumbs = owner && repo ? [{ href: '/', label: 'Repositories' }, { href: repoPath(owner, repo), label: `${owner}/${repo}` }, { label: title }] : [{ label: title }];
  const status = {
    error: { symbol: '✕', word: 'Error' },
    warn: { symbol: '!', word: 'Warning' },
    info: { symbol: 'i', word: 'Information' },
  }[kind] || { symbol: '✕', word: 'Error' };
  const detailList = details.length ? `<details class="message-diagnostics"><summary>Details</summary><ul class="message-details muted mono">${details.map((detail) => `<li>${e(detail)}</li>`).join('')}</ul></details>` : '';
  const codeLine = Number.isInteger(code) && code >= 400 && code <= 599 ? `<p class="message-code mono muted">${code}</p>` : '';
  const actions = links.length ? `<p class="message-actions">${links.map((item, index) => link(item.href, item.label, index === 0 ? 'btn btn-primary' : 'btn')).join(' ')}</p>` : '';
  return frame({ title, user, crumbs, body: `<main class="page message-page"><section class="card message-card">${codeLine}<h1 class="message-head"><span class="message-symbol message-symbol-${e(kind)}" aria-hidden="true">${status.symbol}</span><span>${e(title)} <span class="message-kind">${status.word}</span></span></h1><p>${e(message)}</p>${detailList}${actions}</section></main>` });
}

function status(value) { return siteBadge(value); }

// bench-t2: the frame owns both chrome rows; the report owns the drawing tools.
function revisionChips(match) {
  return `<span class="bench-revision"><span class="bench-label">BASE</span> <code>${e(match?.[1] || 'unknown')}</code></span><span aria-hidden="true">→</span><span class="bench-revision"><span class="bench-label">HEAD</span> <code>${e(match?.[2] || 'unknown')}</code></span>`;
}
function mergeBadge(state, text) {
  return `<details class="bench-menu bench-merge"><summary id="merge-badge">MERGE · ${e(state)}</summary><section id="readiness" class="readiness bench-popover" aria-live="polite"><ul>${['This review', 'GitHub approval', 'Blocking threads'].map(label => `<li class="wait">… ${label}: ${e(text)}</li>`).join('')}</ul></section></details>`;
}
function reviewOverflow(items) {
  return `<details class="bench-menu bench-overflow"><summary aria-label="Review actions">•••</summary><div class="bench-popover">${items}<button type="button" data-review-copy>Copy link</button><label>Go to<input data-review-goto aria-label="Go to saved review position" placeholder="Paste a review link"></label><input data-review-copyfield aria-label="Link to copy" readonly hidden></div></details>`;
}
// This parent owns the only network capability. The child supplies identities, not URLs.
export function assetParent(iframe,raw,scope=window,fetcher=fetch) {
  let declarations,disposed=false;const jobs=new Map();
  const manifest=()=>declarations ||= fetcher(raw,{credentials:'include',cache:'no-cache',redirect:'error',signal:AbortSignal.timeout(15000)}).then(async r=>{
    if(!r.ok||r.redirected)throw Error('Asset unavailable');
    const text=await r.text(),prefix='<script>window.REVIEW_DATA = ',start=text.indexOf(prefix);
    if(start<0)throw Error('Asset unavailable');
    const end=text.indexOf('<'+'/script>',start);
    return JSON.parse(text.slice(start+prefix.length,end).trim().replace(/;$/,'')).assets||{};
  }).catch(e=>{declarations=null;throw e;});
  const receive=async e=>{
    const a=e.data?.kicadReviewAsset;
    if(disposed||e.source!==iframe.contentWindow||!a||typeof a.requestId!=='string'||!/^[\w-]{1,64}$/.test(a.requestId)
      ||!/^[0-9a-f]{12}$/.test(a.digest)||!['svg','json'].includes(a.kind)||jobs.has(a.requestId))return;
    const reply={requestId:a.requestId,digest:a.digest};
    if(jobs.size>=8){iframe.contentWindow.postMessage({kicadReviewAssetResult:{...reply,error:'Busy; retry'}},'*');return;}
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);jobs.set(a.requestId,{abort,timer});
    try {
      const allowed=await manifest();
      if(disposed||abort.signal.aborted||allowed[a.digest]?.kind!==a.kind)throw Error('Asset unavailable');
      const response=await fetcher(raw.replace(/\/raw$/,'')+'/assets/'+a.digest+'.'+a.kind,
        {credentials:'include',cache:'no-cache',redirect:'error',signal:abort.signal});
      const mime=a.kind==='svg'?'image/svg+xml':'application/json';
      if(!response.ok||response.redirected||!response.body||response.headers.get('ETag')!==`"${a.digest}"`
        ||response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!==mime)throw Error('Asset unavailable');
      const reader=response.body.getReader(),parts=[];let size=0;
      const max=(a.kind==='svg'?8:4)*1024*1024;
      try {for(;;){const {value,done}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>max)throw Error('Asset too large');parts.push(value);}}
      finally {await reader.cancel();reader.releaseLock();}
      reply.text=new TextDecoder('utf-8',{fatal:true}).decode(await new Blob(parts).arrayBuffer());
    } catch {reply.error='Asset unavailable; retry';}
    finally {clearTimeout(timer);jobs.delete(a.requestId);}
    if(!disposed)iframe.contentWindow.postMessage({kicadReviewAssetResult:reply},'*');
  };
  scope.addEventListener('message',receive);
  return ()=>{disposed=true;scope.removeEventListener('message',receive);for(const job of jobs.values()){clearTimeout(job.timer);job.abort.abort();}jobs.clear();};
}

function reportFrameScript(raw) {
  const authenticated = /^\/r\/[^/]+\/[^/]+\/a\/\d{1,20}\/raw$/.test(raw);
  const assetSetup = authenticated ? `const assetParentFactory=(${assetParent.toString()});let disposeAssets=null;` : 'let disposeAssets=null;';
  return `<script>(() => { const iframe = document.getElementById('review-report'); const loading = document.getElementById('review-loading'); const raw = ${JSON.stringify(raw)}; ${assetSetup} let reportedHash; let fallback; document.querySelector('[data-review-copy]').onclick = async () => { try { await navigator.clipboard.writeText(location.href); } catch { const input = document.querySelector('[data-review-copyfield]'); input.hidden = false; input.value = location.href; input.focus(); input.select(); } }; document.querySelector('[data-review-goto]').onchange = event => { const text = event.target.value; const i = text.indexOf('#'); if (i >= 0) location.hash = text.slice(i); event.target.value = ''; }; const load = (showLoading) => { if (showLoading) { loading.hidden = false; clearTimeout(fallback); } disposeAssets?.(); disposeAssets=null; ${authenticated ? `disposeAssets=assetParentFactory(iframe,raw);` : ''} iframe.src = raw + location.hash; }; addEventListener('pagehide',()=>{disposeAssets?.();disposeAssets=null;}); load(true); const syncTheme = () => { const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; iframe.contentWindow?.postMessage({ kicadReviewTheme: theme }, '*'); }; new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); iframe.addEventListener('load', () => { syncTheme(); fallback = setTimeout(() => { loading.hidden = true; }, 20000); }); addEventListener('message', event => { if (event.source === iframe.contentWindow && event.data?.kicadReviewReady === true) { loading.hidden = true; syncTheme(); } if (event.source === iframe.contentWindow && typeof event.data?.kicadReviewHash === 'string' && event.data.kicadReviewHash.startsWith('#') && event.data.kicadReviewHash.length < 2000) { reportedHash = event.data.kicadReviewHash; history.replaceState(null, '', reportedHash); } }); addEventListener('hashchange', () => { if (location.hash !== reportedHash) load(false); }); })();</script>`;
}

export function sharedPage({ token, name }) {
  const raw = `/s/${encodeURIComponent(token)}/raw`;
  const match = /^kicad-review-([0-9a-f]{7}|none)-([0-9a-f]{7})-(?:pass|fail)\.html$/.exec(name || '');
  const revision = match ? `${match[1]} → ${match[2]}` : 'Review';
  return frame({ title: 'Shared review', navigation: false, reviewStatus: 'READ ONLY', crumbs: [{ label: 'Shared review' }], body: `<main class="review-page"><nav class="review-bar shared-bar" aria-label="Shared review">${revisionChips(match)}<span>Read-only shared review</span>${mergeBadge('Unavailable', 'Live merge readiness is unavailable for shared reviews.')}${reviewOverflow('<button disabled title="Unavailable in read-only shared reviews">History</button><button disabled title="Use Copy link to share this existing link">Share…</button><button disabled title="Unavailable in read-only shared reviews">Open run</button>')}</nav><div class="review-stage"><div id="review-loading" class="review-loading"><span class="spinner" aria-hidden="true"></span><span>Loading the review…</span></div><iframe id="review-report" src="${e(raw)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" allow="clipboard-write" referrerpolicy="no-referrer" title="KiCad review report"></iframe></div></main>${reportFrameScript(raw)}` });
}
export function sharedNotFoundPage() {
  return frame({ title: 'Shared review unavailable', navigation: false, body: `<main class="page shared-missing"><section class="card"><p class="mono muted">404</p><h1>Shared review unavailable</h1><p>This link is invalid or no longer available. Ask the person who shared it for a new link.</p><p class="muted">No review information is shown.</p></section></main>` });
}
function shareControls(create, revoke) {
  return `<dialog id="share-dialog" class="share-dialog" aria-labelledby="share-title"><h2 id="share-title">Share this review</h2><p>Anyone with the link can read this review until it expires.</p><p class="muted">Read-only access · Anyone with this link</p><form id="share-form"><label>Days (1–30) <input id="share-days" type="number" min="1" max="30" step="1" value="7" required></label><button class="btn btn-primary" type="submit">Create link</button></form><p><label>Read-only link <input id="share-result" class="mono" readonly></label> <button class="btn" id="share-copy" type="button">Copy</button></p><p id="share-status" role="status" aria-live="polite"></p><button class="btn" id="share-revoke" type="button">Revoke all links for this repository</button><form method="dialog"><button class="btn">Close</button></form></dialog><script>(() => {
    const dialog = document.getElementById('share-dialog');
    const status = document.getElementById('share-status');
    const result = document.getElementById('share-result');
    let creating = false;
    const copy = document.getElementById('share-copy');
    if (copy) copy.onclick = async () => {
      if (!result.value || copy.disabled) return;
      copy.disabled = true;
      try {
        await navigator.clipboard.writeText(result.value);
        status.textContent = 'Copied ✓';
        setTimeout(() => { if (status.textContent === 'Copied ✓') status.textContent = ''; }, 2000);
      } catch { status.textContent = 'Copy was blocked. Select and copy the read-only link.'; result.focus(); result.select(); }
      finally { copy.disabled = false; }
    };
    document.getElementById('share-open').onclick = () => dialog.showModal();
    async function post(url, body) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update share links.');
      return data;
    }
    document.getElementById('share-form').onsubmit = async event => {
      event.preventDefault(); if (creating) return; creating = true; result.value = ''; status.textContent = 'Creating link…';
      try {
        const data = await post(${JSON.stringify(create)}, { days: Number(document.getElementById('share-days').value) });
        const url = new URL(data.url);
        if (url.origin !== location.origin || !new RegExp('^/s/[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$').test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('Invalid share link.');
        result.value = url.href; status.textContent = 'Expires ' + new Date(data.expires).toLocaleString();
      } catch (error) { status.textContent = error.message; }
      finally { creating = false; }
    };
    document.getElementById('share-revoke').onclick = async () => {
      if (!confirm('Revoke every share link for this repository?')) return;
      status.textContent = 'Revoking links…';
      try { await post(${JSON.stringify(revoke)}, {}); result.value = ''; status.textContent = 'All share links for this repository were revoked.'; }
      catch (error) { status.textContent = error.message; }
    };
  })();</script>`;
}
