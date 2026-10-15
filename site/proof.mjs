// site/proof.mjs — local-only visual fixtures, no runtime dependency.
import * as pages from './pages.js';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function fixturePages() {
  const common = { user: 'reviewer', owner: 'demo', repo: 'Thermal_Camera' };
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const item = { id: 123, branch: 'move-R16', base: a.slice(0, 7), head: b.slice(0, 7), result: 'pass', createdAt: '2026-10-14T10:00:00Z', date: '2026-10-14', pdf: true };
  const review = pages.reviewPage({ ...common, id: 123, name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflowRunId: 99, pull: 7, share: true, pdf: true });
  const run = { ...common, base: a, head: b, startedAt: '2026-10-14T10:00:00Z', githubUrl: 'https://github.com/demo/Thermal_Camera/actions/runs/99' };
  return {
    signin: pages.signedOutPage(),
    'signin-ended': pages.signedOutPage({ sessionEnded: true }),
    repositories: pages.homePage({ user: common.user, repositories: [{ owner: { login: 'demo' }, name: 'Thermal_Camera', private: true, default_branch: 'main', pushed_at: '2026-10-14T10:00:00Z' }] }),
    'repositories-empty': pages.homePage({ user: common.user, repositories: [] }),
    reviews: pages.reviewsPage({ ...common, items: [item, { ...item, id: 124, result: 'fail', legacy: true }], counts: { all: 2, passing: 1, failing: 1 } }),
    'reviews-empty': pages.reviewsPage({ ...common, items: [], started: true }),
    milestones: pages.reviewsPage({ ...common, items: [item], view: 'milestones', groups: [{ title: 'Prototype', open: 2, merged: 1, items: [item], url: 'https://github.com/demo/Thermal_Camera/milestone/1' }] }),
    'milestones-permission': pages.reviewsPage({ ...common, items: [], view: 'milestones', groups: null }),
    compare: pages.commitsPage({ ...common, branch: 'main', branches: ['main'], tags: [], base: a, head: b, commits: [{ sha: b, message: 'Move R16', author: 'Ada', date: 'today' }, { sha: a, message: 'Initial board', author: 'Ada', date: 'yesterday' }] }),
    'compare-identical': pages.commitsPage({ ...common, branch: 'main', branches: ['main'], commits: [{ sha: a, message: 'Initial board', author: 'Ada', date: 'today' }], base: a, head: a }),
    progress: pages.runPage({ ...run, running: true, status: 'in_progress', jobs: [{ steps: [{ name: 'Check out files', status: 'completed', conclusion: 'success' }, { name: 'Render board', status: 'in_progress' }] }] }),
    'run-failed': pages.runPage({ ...run, state: 'failed', failedStage: 'Rendering and checking', failedStep: 'Render board' }),
    'run-expired': pages.runPage({ ...run, state: 'expired' }),
    'run-nothing': pages.runPage({ ...run, state: 'nothing' }),
    wrapper: review,
    readiness: review,
    'thread-composer': review,
    'thread-view': review,
    history: pages.historyPage({ ...common, pull: 7, title: 'Move R16', filter: 'all', events: ['commit', 'thread', 'review', 'checks'].map(kind => ({ kind, text: `${kind} on R16`, who: 'Ada', time: '2026-10-14T10:00:00Z', href: '/r/demo/Thermal_Camera/a/123' })) }),
    share: review,
    shared: pages.sharedPage({ token: 'body.signature', name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html' }),
    'shared-invalid': pages.sharedNotFoundPage ? pages.sharedNotFoundPage() : pages.messagePage({ title: 'Not found', message: 'This shared review is unavailable.' }),
    error: pages.messagePage({ title: 'Could not load reviews', message: 'Try again later.', details: ['Request ID: local-proof'], links: [{ href: '/', label: 'Retry' }, { href: '/', label: 'Back to reviews' }], code: 502 }),
  };
}

async function main() {
  if (!process.env.PROOF_DIR || !process.env.REPORT) throw new Error('Set PROOF_DIR and REPORT to session-scratchpad paths.');
  const out = resolve(process.env.PROOF_DIR); mkdirSync(out, { recursive: true });
  const report = readFileSync(resolve(process.env.REPORT), 'utf8');
  if (!report.includes('Thermal_Camera')) throw new Error('Proof requires Thermal_Camera report.');
  const fixtures = fixturePages();
  const filter = process.argv[2] || '';
  const names = Object.keys(fixtures).filter(name => name.includes(filter));
  if (!names.length) throw new Error('No fixture matches.');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname.endsWith('/raw')) { res.setHeader('Content-Type', 'text/html'); res.end(report); return; }
    if (url.pathname.endsWith('/readiness')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ head: 'b'.repeat(40), decisions: [{ login: 'Ada', state: 'APPROVED', stale: false }], requested: [], blocking: 0, open: 1 })); return; }
    if (url.pathname.endsWith('/threads') || url.pathname.endsWith('/issues')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ threads: [], issues: [] })); return; }
    const name = url.pathname.slice(1); const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
    const html = fixtures[name];
    if (!html) { res.writeHead(404); res.end('Unknown fixture'); return; }
    const setup = `<script>try{localStorage.setItem('kr.theme',${JSON.stringify(theme)})}catch(e){}document.documentElement.dataset.theme=${JSON.stringify(theme)};</script>`;
    const end = `<script>document.querySelectorAll('meta[http-equiv=refresh]').forEach(n=>n.remove());const n=${JSON.stringify(name)};if(n==='thread-composer')document.getElementById(n).showModal();if(n==='thread-view'){document.querySelector('#thread-view h2').textContent='Comment on R16';const li=document.createElement('li');li.textContent='Ada · Verify placement before fabrication.';document.querySelector('#thread-view ol').append(li);document.getElementById(n).showModal()}if(n==='share')document.getElementById('share-dialog').showModal();</script>`;
    res.setHeader('Content-Type', 'text/html'); res.end(html.replace('<head>', '<head>' + setup).replace('</body>', end + '</body>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try {
    for (const name of names) for (const theme of ['dark', 'light']) {
      const profile = mkdtempSync(join(out, 'profile-'));
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1600,1000', '--force-device-scale-factor=1', '--hide-scrollbars', '--virtual-time-budget=3500', `--screenshot=${join(out, `${name}-${theme}.png`)}`, `${origin}/${name}?theme=${theme}`], { stdio: 'ignore' });
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Chrome timed out: ${name}`)); }, 30000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Chrome exited ${code}: ${name}`)); });
        });
        console.log(join(out, `${name}-${theme}.png`));
      } finally { rmSync(profile, { recursive: true, force: true }); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
