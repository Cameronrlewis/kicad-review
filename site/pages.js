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
  const script = `<script>(()=>{const form=document.querySelector('.compare-form'),bar=document.querySelector('.compare-bar'),button=form.querySelector('[type="submit"]'),status=bar.querySelector('[role="status"]'),slots=[...bar.querySelectorAll('.compare-slot')],radios=[...form.querySelectorAll('input[type="radio"]')];const data=Object.fromEntries([...form.querySelectorAll('tbody tr')].map(r=>{const a=r.querySelectorAll('input');return [a[0].value,{sha:a[0].value,message:r.children[3].textContent,author:r.children[4].textContent,date:r.children[5].textContent}]}));function add(node,tag,text){const child=document.createElement(tag);child.textContent=text;node.append(child);return child}function show(slot,label,c){slot.replaceChildren();add(slot,'strong',label);if(c){const line=document.createElement('div'),code=add(line,'code',c.sha.slice(0,7));line.append(' '+c.message);slot.append(line);const details=add(slot,'small',c.author+' · '+c.date);details.className='muted'}else{const empty=add(slot,'div','not chosen');empty.className='muted'}}function update(){const base=form.querySelector('[name=base]:checked')?.value,head=form.querySelector('[name=head]:checked')?.value;show(slots[0],'Base',data[base]);show(slots[1],'Head',data[head]);button.disabled=!base||!head||base===head;status.className='muted';status.replaceChildren();if(base&&head&&base===head){status.className='notice-warn';status.textContent='Base and Head are the same commit. Pick two different ones.'}else if(base&&head&&[...form.querySelectorAll('[name=head]')].findIndex(x=>x.value===head)>[...form.querySelectorAll('[name=base]')].findIndex(x=>x.value===base)){status.className='notice-warn';status.append('Head is older than Base. The review would show the change backwards. ');const swap=add(status,'button','Swap');swap.type='button';swap.onclick=()=>{form.querySelector('[name=base][value="'+head+'"]').checked=true;form.querySelector('[name=head][value="'+base+'"]').checked=true;update()}}else if(base&&head){status.textContent='Compares '+base.slice(0,7)+' → '+head.slice(0,7)+'.'}}radios.forEach(r=>r.onchange=update);form.querySelectorAll('tr').forEach(r=>r.onkeydown=e=>{if(e.key==='Enter')e.preventDefault()});update()})()</script>`;
  return frame({ title: 'Compare commits', user, crumbs: [{ href: '/', label: 'Repositories' }, { href: path, label: `${owner}/${repo}` }, { label: 'Compare commits' }], body: `<main class="page"><div class="page-head"><div><h1>Compare commits</h1><p class="lead">Pick the earlier revision as Base and the later one as Head. The review shows what changed from Base to Head.</p></div></div>${alert}${swapForm}<form method="post" action="${path}/compare" class="compare-form"><div class="compare-bar">${selection('Base', baseCommit)}<span class="compare-arrow" aria-hidden="true">→</span>${selection('Head', headCommit)}<div class="compare-action"><button class="btn btn-primary" disabled>Start review</button><div class="muted" role="status"></div></div></div><div class="source-picker"><label>Branch <select name="branch" form="source-picker">${branchOptions}</select></label><span class="muted">or a tag</span><label class="sr-only" for="tag">Tag</label><select id="tag" name="tag" form="source-picker"><option value="">Select a tag</option>${tagOptions}</select></div><table class="table"><thead><tr><th>Base</th><th>Head</th><th>SHA</th><th>Message</th><th>Author</th><th>Date</th><th></th></tr></thead><tbody>${rows}</tbody></table></form><form id="source-picker" method="get"><button class="btn">Show</button></form>${script}</main>` });
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
