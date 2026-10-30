import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { reportCsp, frameCsp } from '../site/csp.js';
import { reviewPage, sharedPage } from '../site/pages.js';

test('BOM downloads save through real report sandbox and CSP', { timeout: 60000 }, async () => {
  assert.ok(process.env.SCRATCH, 'SCRATCH must name a scratch directory');
  const root = mkdtempSync(join(process.env.SCRATCH, 'bom-download-'));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const html = execFileSync('python3', ['-c', 'import pathlib,kicad_review as k;print(k.inline_page(pathlib.Path("ui/sample/review-data-parts.js").read_text()))'], { cwd, encoding: 'utf8' });
  const wrapper = kind => kind === 'shared'
    ? sharedPage({ token: 'fixture', name: 'kicad-review.html' })
    : reviewPage({ user: 'fixture', owner: 'example', repo: 'parts', id: '1', name: 'kicad-review.html' });
  const server = createServer((req, res) => {
    const raw = req.url.split('?')[0].endsWith('/raw');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': raw ? reportCsp : frameCsp });
    res.end(raw ? html : wrapper(req.url.includes('shared') ? 'shared' : 'review'));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-sandbox', '--enable-automation', '--remote-debugging-port=0',
    '--user-data-dir=' + join(root, 'profile'), 'about:blank'
  ], { stdio: 'ignore' });
  const exited = new Promise(r => { chrome.once('exit', r); chrome.once('error', r); });
  let ws;
  try {
    const until = async fn => {
      for (let n = 0; n < 200; n++) {
        const value = await fn();
        if (value) return value;
        await new Promise(r => setTimeout(r, 100));
      }
      throw Error('browser/download timeout');
    };
    // A fresh profile and ephemeral port never attach to another task's Chrome.
    const [port, socketPath] = await until(() => {
      try { return readFileSync(join(root, 'profile', 'DevToolsActivePort'), 'utf8').trim().split('\n'); }
      catch { return null; }
    });
    ws = new WebSocket('ws://127.0.0.1:' + port + socketPath);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0, attachError;
    const pending = new Map(), contexts = [], started = [], completed = new Set();
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
      }
      if (m.method === 'Target.attachedToTarget') {
        send('Runtime.enable', {}, m.params.sessionId).catch(error => { attachError = error; });
      }
      if (m.method === 'Runtime.executionContextCreated') contexts.push({ ...m.params.context, sessionId: m.sessionId });
      if (m.method === 'Runtime.executionContextsCleared') {
        for (let i = contexts.length - 1; i >= 0; i--) if (contexts[i].sessionId === m.sessionId) contexts.splice(i, 1);
      }
      if (m.method === 'Browser.downloadWillBegin') started.push(m.params);
      if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') completed.add(m.params.guid);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { arguments: chromeArgs } = await send('Browser.getBrowserCommandLine');
    assert.ok(chromeArgs.includes('--user-data-dir=' + join(root, 'profile')), 'must use this test Chrome');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    // Opaque sandboxed reports can live in out-of-process iframe targets.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    for (const kind of ['review', 'shared']) {
      // Fresh per-wrapper directory: shared checks cannot reuse authenticated-wrapper files.
      const downloadDir = mkdtempSync(join(root, kind + '-downloads-'));
      await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
      contexts.length = 0;
      await send('Page.navigate', { url: origin + '/' + kind }, sessionId);
      const context = await until(async () => {
        if (attachError) throw attachError;
        for (const c of contexts.filter(c => c.auxData?.isDefault)) {
          let v;
          try {
            v = await send('Runtime.evaluate', { contextId: c.id, expression: 'window.reviewReady === true && !!window.REVIEW_DATA && !!document.querySelector("[data-tab=parts]")', returnByValue: true }, c.sessionId);
          } catch { continue; }
          assert.equal(v.exceptionDetails, undefined, 'report startup evaluation must not throw');
          if (v.result?.value) return c;
        }
        return null;
      });
      const evaluate = expression => send('Runtime.evaluate', { contextId: context.id, expression, userGesture: true, returnByValue: true }, context.sessionId);
      const ready = await evaluate(`document.querySelector('[data-tab=parts]').click(); S.partsView='bom'; renderPanel(); !!document.querySelector('[data-bom-download=fab]') && !!document.querySelector('[data-bom-download=csv]')`);
      assert.equal(ready.exceptionDetails, undefined);
      assert.equal(ready.result.value, true, 'both BOM buttons must render before testing permissions');
      for (const [field, name] of [['fab', 'Parts-bom-jlcpcb.csv'], ['csv', 'Parts-bom.csv']]) {
        const before = started.length;
        const result = await evaluate(`document.querySelector('[data-bom-download=${field}]').click(); proj().parts.exports.${field}`);
        assert.equal(result.exceptionDetails, undefined, 'download click evaluation must not throw');
        const download = await until(() => started[before]);
        assert.equal(download.suggestedFilename, name, kind + ' ' + field + ' suggested filename');
        await until(() => completed.has(download.guid));
        assert.equal(started.length, before + 1, 'one download for this click');
        assert.equal(readFileSync(join(downloadDir, name), 'utf8'), result.result.value, kind + ' ' + field + ' newly saved bytes');
      }
    }
  } finally {
    ws?.close();
    chrome.kill();
    await exited;
    await new Promise(r => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});
