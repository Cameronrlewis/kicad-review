// One gentle, measured page load over CDP. Node 22+, no npm. Exit 3 on HTTP 429/503.
// Frame-aware copy of the study tools/measure.mjs: probes, readiness, clicks and Review3D reads run in the
// selected report context (the hosted wrapper's sandboxed iframe with --report-frame); screenshots and Input.* stay top-session.
// Desktop profile only: --phone, its Pixel 7 profile, touch input and throttling were dropped with phone support
// Phone measurement is unsupported; the summary keeps phone:false for schema compatibility.
// node ui/measure3d.mjs <url> <outdir> [--report-frame SEL] [--interaction-target SEL] [--cold] [--click-text T]... [--ready-expr E]
//   [--rotate] [--zoom] [--zoom-steps N] [--settle MS] [--port P]
// Env MEASURE_PROJECT/MEASURE_LAYERS/MEASURE_REVISION: reject a wrong project, view, mode, layer count or revision before sampling.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { selectContext, viewportPoint, assertRotation, normalizeReadyTiming } from './measure-frame.mjs';

const argv = process.argv.slice(2), flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const all = n => argv.flatMap((a, i) => a === n ? [argv[i + 1]] : []);
const [url, out] = argv;
if (!url || !out || url.startsWith('--')) { console.error('usage: measure3d.mjs <url> <outdir> [options]'); process.exit(2); }
if (flag('--phone')) { console.error('--phone is not supported: phone support was dropped 2026-10-29 (spec 02-3d-viewer); measure desktop only'); process.exit(2); }
const port = opt('--port', '9222'), settle = +opt('--settle', '8000'), zoomSteps = +opt('--zoom-steps', '10');
const reportFrame = opt('--report-frame'), selector = opt('--interaction-target'), readyExpr = opt('--ready-expr'), clicks = all('--click-text');
for (const d of ['bodies', 'shaders']) mkdirSync(join(out, d), { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0, lastNet = Date.now(), saved = 0, selected = null;
const pending = new Map(), handlers = [], contexts = new Map(), navigated = new Map(), detached = new Set(), reqs = new Map(), bodyJobs = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); }
  else handlers.forEach(h => h(m)); };
const send = (method, params = {}, sessionId = '') => new Promise((r, j) => {
  const n = ++id; pending.set(n, { r, j, sessionId });
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluateAt = async (expr, c) => {
  if (c?.sessionId && detached.has(c.sessionId)) throw Error('BR02 report session detached');
  const reply = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, ...(c ? { contextId: c.id } : {}) }, c?.sessionId || '');
  if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};
const evaluate = expr => evaluateAt(expr, selected);

handlers.push(m => {   // execution contexts per CDP session; origin 'null' is not an identity (several worlds share it)
  const sid = m.sessionId || '', p = m.params;
  if (m.method === 'Runtime.executionContextCreated') contexts.set(`${sid}:${p.context.id}`, { ...p.context, sessionId: sid });
  if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(`${sid}:${p.executionContextId}`);
  if (m.method === 'Runtime.executionContextsCleared') for (const [k, c] of contexts) if (c.sessionId === sid) contexts.delete(k);
  if (m.method === 'Page.frameNavigated') navigated.set(p.frame.id, p.frame.url + (p.frame.urlFragment || ''));
  if (m.method === 'Target.detachedFromTarget') {
    detached.add(p.sessionId);
    for (const [k, c] of contexts) if (c.sessionId === p.sessionId) contexts.delete(k);
    for (const [n, q] of pending) if (q.sessionId === p.sessionId) { pending.delete(n); q.j(Error('BR02 report session detached')); }
  }
});
const keep = r => r.type === 'Script' || /\.(glb|gltf|bin|ktx2|basis|drc|wasm|svg|json|wrl|step|kicad_\w+)(\?|$)/i.test(r.url) || /^model\/|octet-stream|wasm|json|x-component|svg/.test(r.mime || '');
handlers.push(m => {   // root session only: the wrapper's broker makes the /3d/ fetches, so its traffic is the wire record
  if (m.sessionId) return;
  const p = m.params; if (m.method?.startsWith('Network.')) lastNet = Date.now();
  if (m.method === 'Network.requestWillBeSent') reqs.set(p.requestId, { url: p.request.url, type: p.type, start: p.timestamp, bytes: 0, decoded: 0, frameId: p.frameId || null, sessionId: '' });
  const r = reqs.get(p?.requestId); if (!r) return;
  if (m.method === 'Network.responseReceived') { const h = Object.fromEntries(Object.entries(p.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    Object.assign(r, { status: p.response.status, mime: p.response.mimeType, encoding: h['content-encoding'] || '', cacheControl: h['cache-control'] || '',
      cached: !!(p.response.fromDiskCache || p.response.fromServiceWorker || p.response.fromPrefetchCache) }); }
  else if (m.method === 'Network.dataReceived') r.decoded += p.dataLength;
  else if (m.method === 'Network.loadingFinished') { r.bytes = p.encodedDataLength; r.end = p.timestamp;
    if (keep(r) && r.decoded < 100e6) bodyJobs.push(send('Network.getResponseBody', { requestId: p.requestId }).then(b => {
      const name = `${String(++saved).padStart(3, '0')}-${(new URL(r.url).pathname.split('/').pop() || 'index').slice(0, 80)}`;
      writeFileSync(join(out, 'bodies', name), b.base64Encoded ? Buffer.from(b.body, 'base64') : b.body); r.saved = name;
    }).catch(() => { r.saved = 'unavailable'; })); }
  else if (m.method === 'Network.loadingFailed') r.failed = p.errorText;
});
// Out-of-process report frames start paused, so the probe is installed before any report script runs.
// Workers are attached only to resume them: Chrome 155 still pauses a filtered-out worker under waitForDebuggerOnStart,
// which stalls the 3D decode worker. Every other target type is excluded.
const probe = readFileSync(new URL('./probe3d.js', import.meta.url), 'utf8');
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
  filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }] };
const setupJobs = [];
handlers.push(m => {
  if (m.method !== 'Target.attachedToTarget') return;
  const sid = m.params.sessionId, job = m.params.targetInfo.type !== 'iframe' ? send('Runtime.runIfWaitingForDebugger', {}, sid) : (async () => {
    await send('Runtime.enable', {}, sid);
    await send('Page.enable', {}, sid);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: probe }, sid);
    await send('Target.setAutoAttach', autoAttach, sid);
    await send('Runtime.runIfWaitingForDebugger', {}, sid);
  })();
  job.catch(() => {}); setupJobs.push(job);   // surfaced by Promise.all below
});

try {
  await send('Page.enable'); await send('Performance.enable'); await send('Runtime.enable'); await send('DOM.enable');
  await send('Network.enable', { maxTotalBufferSize: 400e6, maxResourceBufferSize: 100e6 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: probe });   // same-process frames
  await send('Target.setAutoAttach', autoAttach);
  if (flag('--cold')) await send('Network.setCacheDisabled', { cacheDisabled: true });
  const W = 1440, H = 900;
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  const quiet = async () => { const t = Date.now(); await sleep(settle); while (Date.now() - lastNet < 2000 && Date.now() - t < 90000) await sleep(250); };
  const loaded = new Promise(r => handlers.push(m => !m.sessionId && m.method === 'Page.loadEventFired' && r()));
  await send('Page.navigate', { url });
  await Promise.race([loaded, new Promise(r => setTimeout(r, 60000).unref())]);
  await Promise.all(setupJobs);

  const topFrameId = (await send('Page.getFrameTree')).frameTree.frame.id;
  let frameId = topFrameId, frameNode = null;
  if (reportFrame) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const root = await send('DOM.getDocument');
      const hits = (await send('DOM.querySelectorAll', { nodeId: root.root.nodeId, selector: reportFrame })).nodeIds;
      if (hits.length > 1) throw Error('BR02 expected exactly one report iframe');
      if (hits.length) {
        frameNode = hits[0];
        frameId = (await send('DOM.describeNode', { nodeId: frameNode })).node.frameId;
        if (frameId && [...contexts.values()].some(c => c.auxData?.frameId === frameId && c.auxData.isDefault)) break;
      }
      await sleep(20);
    }
    if (!frameId || frameId === topFrameId) throw Error('BR02 report iframe not found');
    await Promise.all(setupJobs);
  }
  selected = selectContext(contexts, frameId);
  const top = selectContext(contexts, topFrameId);
  if (reportFrame) {
    // The report canonicalizes its hash after load, so compare the frame's committed navigation, not location.hash.
    const expected = new URL(url).hash, actual = navigated.has(frameId) ? new URL(navigated.get(frameId)).hash : null;
    if (expected && actual !== expected) throw Error(`BR02 wrapper deep link not forwarded: ${actual}`);
    if (await evaluateAt('!!window.Review3D', top)) throw Error('BR02 measurement fixture unexpectedly exposes viewer at top level');
  }
  const topTimeOrigin = await evaluateAt('performance.timeOrigin', top), childTimeOrigin = await evaluate('performance.timeOrigin');
  let timing = null, clicked = clicks.length ? false : null;
  // Raw child performance.now() at readiness; normalizeReadyTiming makes it top-navigation or click relative.
  const waitReady = t0 => evaluate(`(async () => { const t0 = ${t0}; while (!(${readyExpr})) { await new Promise(r => setTimeout(r, 20)); if (performance.now() - t0 > 90000) return null; } return performance.now(); })()`);
  const ready = (raw, clickAt = null) => { const t = normalizeReadyTiming({ readyMs: raw, topTimeOrigin, childTimeOrigin, clickAt });
    if (!t) throw Error('BR02 report readiness timed out'); return { ...t, readyMs: Math.round(t.readyMs), navOffsetMs: Math.round(t.navOffsetMs) }; };
  if (readyExpr && !clicks.length) timing = ready(await waitReady(0));
  await quiet();
  for (const text of clicks) {
    const ok = await evaluate(`(() => { const t = ${JSON.stringify(text)};
      const el = ['button,a,[role=tab],[role=button]', 'summary,label', 'li,span'].map(s => [...document.querySelectorAll(s)].find(e => e.textContent.trim() === t && e.getClientRects().length)).find(Boolean);
      if (el) { __probe.clickAt = performance.now(); el.click(); } return !!el; })()`);
    console.log(`click-text "${text}": ${ok ? 'clicked' : 'NOT FOUND'}`);
    if (ok !== true) throw Error(`BR02 click target not found: ${text}`);
    clicked = true;
    if (readyExpr) { const clickAt = await evaluate('__probe.clickAt'); timing = ready(await waitReady(clickAt), clickAt); }
    await quiet();
  }

  // Explicit visible host for 3D (shared canvas spans both scissor viewports); legacy largest canvas/SVG otherwise.
  const rect = await evaluate(selector ? `(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => { const r = e.getBoundingClientRect();
      return r.width > 100 && r.height > 100 && getComputedStyle(e).visibility !== 'hidden'; });
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`
    : `(() => { const r = [...document.querySelectorAll('canvas,svg')].map(e => e.getBoundingClientRect())
      .filter(r => r.width > 100 && r.height > 100).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : { x: 0, y: 0, width: innerWidth, height: innerHeight }; })()`);
  if (!rect) throw Error('BR02 visible interaction target missing');
  let targetIdentity = null;
  const expectedProject = process.env.MEASURE_PROJECT;
  if (expectedProject) {   // asserted in the report context, never inferred from the URL
    const expectedView = flag('--rotate') ? '3d' : new URL(url).hash.match(/(?:#|&)v=([^&]+)/)?.[1];
    if (!expectedView) throw Error('measurement requires an explicit intended view');
    // Report layer names come from KiCad SVG file names (F_Cu); accept KiCad's dotted spelling too.
    const actual = await evaluate(`({dir:proj().dir,view:S.v,mode:S.m,revision:S.revision,
      layers:proj().board.layers.filter(l=>/^(F|B|In\\d+)[._]Cu$/.test(l.name)).length})`);
    if (actual.dir !== expectedProject || actual.view !== expectedView || actual.mode !== 'side' ||
        actual.layers !== Number(process.env.MEASURE_LAYERS) ||
        (expectedView === '3d' && actual.revision !== process.env.MEASURE_REVISION))
      throw Error('measurement target mismatch: ' + JSON.stringify(actual));
    targetIdentity = actual;
  }
  const viewport = await evaluate('({width:innerWidth,height:innerHeight})');
  const quad = frameNode ? (await send('DOM.getBoxModel', { nodeId: frameNode })).model.content : [0, 0, W, 0, W, H, 0, H];
  const c = viewportPoint(rect, quad, viewport);   // child CSS point in top viewport coordinates

  const frame2 = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))';
  const drag = async dx => { const steps = 60;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + dx * i / steps, y: c.y, button: 'left', buttons: 1 }); await sleep(33); }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + dx, y: c.y, button: 'left', buttons: 0, clickCount: 1 }); };
  const zoomStep = async dir => { const t = Date.now();
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: 120 * dir });
    await evaluate(frame2); return Date.now() - t; };   // wall time until two frames have painted after the step
  const phase = async (label, fn) => { await evaluate('__probe.mark()'); await fn(); await sleep(1000); return { label, ...(await evaluate('__probe.stats()')) }; };
  const snapshot = async () => { const s = await evaluate('({camera:Review3D.cameraState(),drawCount:Review3D.state.drawCount})');
    if (!s.camera) throw Error('BR02 3D camera unavailable'); return s; };
  const phases = [await phase('idle', () => sleep(3000))], zoomMs = [];
  let interaction = null;
  if (flag('--rotate')) {   // the reverse drag can restore the start camera, so each drag is asserted on its own
    const before = await snapshot(); let moved = false;
    const p = await phase('rotate', async () => {
      await drag(300);
      const middle = await snapshot(); assertRotation(before, middle); moved = true;
      await drag(-300);
      assertRotation(middle, await snapshot());
    });
    if (!(p.drawFps > 0)) throw Error('BR02 rotation drew no frames');
    phases.push(p);
    const after = await snapshot();
    interaction = { selector, moved, drawDelta: after.drawCount - before.drawCount, before, after };
  }
  if (flag('--zoom')) phases.push(await phase('zoom', async () => {
    for (const dir of [-1, 1]) for (let i = 0; i < zoomSteps; i++) { const ms = await zoomStep(dir); zoomMs.push(ms); if (ms > 10000 && zoomMs.length >= 3) return; } }));
  const summary = await evaluate('__probe.summary()');
  const reportState = await evaluate(`window.Review3D?.state?({firstFrame:Review3D.state.firstFrame,
    renderers:Review3D.state.renderers.length,calls:Review3D.state.drawCallsByViewport,changedParts:Review3D.state.changedParts}):null`);
  const metrics = Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  writeFileSync(join(out, 'shot.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  for (const s of await evaluate('__probe.shaders.map(s => (s.type || "unknown") + "\\n" + s.src)')) {
    const h = createHash('sha1').update(s).digest('hex').slice(0, 12); writeFileSync(join(out, 'shaders', `${s.split('\n')[0]}-${h}.glsl`), s); }
  await Promise.allSettled(bodyJobs);
  const t0 = Math.min(...[...reqs.values()].map(r => r.start));
  const network = [...reqs.values()].map(r => ({ ...r, start: +(r.start - t0).toFixed(3), end: r.end && +(r.end - t0).toFixed(3) }));
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ url, phone: false, cold: flag('--cold'), when: new Date().toISOString(), viewport: [W, H], network, summary,
    metrics, metricsScope: 'top target session (Performance.getMetrics), not report-only', phases, zoomMs, readyMs: timing?.readyMs ?? null,
    navOffsetMs: timing?.navOffsetMs ?? null, timingOrigin: timing?.timingOrigin ?? null, clicked,
    measurementContext: { ...selected, topFrameId }, targetIdentity, reportState, interaction }, null, 1));
  const mb = n => (n / 1e6).toFixed(2);
  console.log(`requests ${network.length}, wrapper-session wire ${mb(network.reduce((s, r) => s + r.bytes, 0))} MB, decoded ${mb(network.reduce((s, r) => s + r.decoded, 0))} MB`);
  console.log(`gpu ${summary.gpu}; engine ${JSON.stringify(summary.engine)}; contexts ${summary.contexts.length}; offscreen ${summary.offscreen}; usable ${summary.usableMs} ms; target heap ${mb(metrics.JSHeapUsedSize)} MB`);
  for (const p of phases) console.log(`${p.label}: fps ${p.fps}, drawFps ${p.drawFps}, median ${p.medianMs} ms, p95 ${p.p95Ms} ms, max ${p.maxMs} ms, long tasks ${p.longTasks.length}`);
  if (timing) console.log(`ready ${timing.readyMs} ms (${timing.timingOrigin}, child offset ${timing.navOffsetMs} ms)`);
  if (reportState) console.log(`report: renderers ${reportState.renderers}, calls ${JSON.stringify(reportState.calls)}, changed parts ${reportState.changedParts}; frame ${selected.frameId} session ${selected.sessionId || 'root'}`);
  if (zoomMs.length) console.log(`zoom step ms: ${zoomMs.join(' ')}`);
  if (/swiftshader|llvmpipe|software/i.test(summary.gpu || '')) console.warn('WARNING: software WebGL; frame rates are not valid');
  if (!summary.contexts.length && summary.dom.canvases.length) console.warn('WARNING: canvas on screen but no context seen: viewer may be in a worker or cross-origin frame');
} finally {
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}); ws.close();
  if ([...reqs.values()].some(r => r.status === 429 || r.status === 503)) { console.error('RATE LIMITED: stop all requests to this site and ask the user'); process.exitCode = 3; }
}
