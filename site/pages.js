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

export function signedOutPage() {
  return frame({ title: 'Repositories', body: `<main class="page"><section class="card empty"><h1>KiCad review</h1><p>See what changed on the schematic and board in each commit or pull request, with ERC and DRC results.</p><p>${link('/login', 'Sign in with GitHub', 'btn btn-primary')}</p><p>GitHub will ask you to let this app verify your identity, see which repositories you can access, and act on your behalf. It only reads what you can already read.</p></section></main>` });
}

export function homePage({ user, repositories }) {
  const body = repositories.length ? `<section class="cards">${repositories.map((repo) => `<a class="card" href="${repoPath(repo.owner.login, repo.name)}"><h2>${e(repo.owner.login)}/${e(repo.name)}</h2><p class="muted">Open review reports and compare commits.</p></a>`).join('')}</section>` : `<section class="card empty"><h2>No repositories yet</h2><p>The GitHub App must be installed on the repository.</p></section>`;
  return frame({ title: 'Repositories', user, crumbs: [{ label: 'Repositories' }], body: `<main class="page"><div class="page-head"><div><h1>Repositories</h1><p class="lead">Repositories available through the KiCad review GitHub App.</p></div></div>${body}</main>` });
}

export function reviewsPage({ user, owner, repo, items, started }) {
  const path = repoPath(owner, repo);
  const rows = items.map((item) => `<tr><td>${e(item.date)}</td><td>${e(item.branch)}</td><td><span class="revpath"><span>${e(item.base)}</span><span>${e(item.head)}</span></span></td><td>${status(item.result)}</td><td>${link(`${path}/a/${encodeURIComponent(item.id)}`, 'Open', 'btn')}${item.legacy ? '<br><small class="muted">older report: revisions not recorded</small>' : ''}</td></tr>`).join('');
  const content = rows ? `<table class="table"><thead><tr><th>Date</th><th>Branch</th><th>Revisions</th><th>Result</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<section class="card empty"><h2>No reviews yet</h2><p>Start a comparison from commit history.</p>${link(`${path}/commits`, 'View commit history', 'btn btn-primary')}</section>`;
  return frame({ title: 'Reviews', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Reviews' }], body: `<main class="page"><div class="page-head"><div><h1>Reviews</h1><p class="lead">${e(owner)}/${e(repo)}</p></div><div class="page-actions">${link(`${path}/commits`, 'Commit history', 'btn')}</div></div>${started ? '<div class="notice notice-info">Review started.</div>' : ''}${content}</main>` });
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

export function messagePage({ title, message, links = [], user, owner, repo, kind = 'error' }) {
  const crumbs = owner && repo ? [{ href: '/', label: 'Repositories' }, { href: repoPath(owner, repo), label: `${owner}/${repo}` }, { label: title }] : [{ label: title }];
  return frame({ title, user, crumbs, body: `<main class="page"><section class="card empty"><h1>${e(title)}</h1><p class="notice notice-${e(kind)}">${e(message)}</p><p>${links.map((item) => link(item.href, item.label, 'btn')).join(' ')}</p></section></main>` });
}

function status(value) {
  if (value === 'pass') return '<span class="status status-pass">✓ Pass</span>';
  if (value === 'fail') return '<span class="status status-fail">✕ Fail</span>';
  if (value === 'new') return '<span class="status status-new">New</span>';
  if (value === 'error') return '<span class="status status-error">⚠ Error</span>';
  return '<span class="status status-notrun">— Not run</span>';
}
