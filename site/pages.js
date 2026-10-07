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

export function commitsPage({ user, owner, repo, branch, branches, commits }) {
  const path = repoPath(owner, repo);
  const options = branches.map((name) => `<option value="${e(name)}"${name === branch ? ' selected' : ''}>${e(name)}</option>`).join('');
  const rows = commits.map((commit) => `<tr><td><code>${e(commit.sha.slice(0, 7))}</code></td><td>${e(commit.message)}${commit.review ? ` ${link(`${path}/a/${encodeURIComponent(commit.review)}`, 'Review')}` : ''}</td><td>${e(commit.author)}</td><td>${e(commit.date)}</td><td><input type="radio" name="base" value="${e(commit.sha)}" aria-label="Base ${e(commit.sha)}"></td><td><input type="radio" name="head" value="${e(commit.sha)}" aria-label="Head ${e(commit.sha)}"></td></tr>`).join('');
  return frame({ title: 'Commit history', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Commit history' }], body: `<main class="page"><div class="page-head"><div><h1>Commit history</h1><p class="lead">Choose a base and head commit to start a review.</p></div></div><form method="get"><label>Branch <select name="branch">${options}</select></label> <button class="btn">Show</button></form><form method="post" action="${path}/compare"><table class="table"><thead><tr><th>SHA</th><th>Message</th><th>Author</th><th>Date</th><th>Base</th><th>Head</th></tr></thead><tbody>${rows}</tbody></table><p><button class="btn btn-primary">Compare</button></p></form></main>` });
}

export function runPage({ user, owner, repo, running, status: runStatus, conclusion, githubUrl }) {
  const path = repoPath(owner, repo);
  const action = githubUrl ? `<p>${link(githubUrl, 'View this run on GitHub', 'btn')}</p>` : '';
  const content = running ? `<section class="card"><h2><span class="spinner" aria-hidden="true"></span> Review running…</h2><p class="lead">Status: ${e(runStatus)}</p>${action}</section>` : `<section class="card"><h2>${e(conclusion)}</h2>${action}</section>`;
  return frame({ title: 'Review run', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Review run' }], meta: running ? '<meta http-equiv="refresh" content="10">' : '', body: `<main class="page"><div class="page-head"><div><h1>Review run</h1><p class="lead">${e(owner)}/${e(repo)}</p></div></div>${content}</main>` });
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
