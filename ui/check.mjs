// Development-only checks for the review page: headless Chrome over the DevTools protocol, no npm.
// Usage: node ui/check.mjs [name-filter] [--shot out.png] [--page path/to/kicad-review.html] [--dark|--theme dark|light] [--width N] [--dpr N] [--offline]
// --gpu uses Metal; --mode side|overlay|wipe|blend|semantic selects board proof mode.
// Theme proof: --persist-check --vision none|deuteranopia|protanopia|tritanopia --appearance-fixture theme.json --mark-style outline|recolour
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, extname } from "node:path";
import { createServer } from "node:http";
import { CHECKS } from "./checks.mjs";

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); if (i < 0) return null; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing value for ' + k); return args.splice(i, 2)[1]; };
const legacyDark = args.includes("--dark"); if (legacyDark) args.splice(args.indexOf("--dark"), 1);
const theme = opt("--theme") || (legacyDark ? "dark" : "light");
if (!["dark", "light"].includes(theme)) throw new Error("Invalid theme");
const dark = theme === "dark";
const vision = opt("--vision") || "none";
if (!["none", "deuteranopia", "protanopia", "tritanopia"].includes(vision)) throw new Error("Invalid vision type");
const persistCheck = args.includes("--persist-check"); if (persistCheck) args.splice(args.indexOf("--persist-check"), 1);
const fixturePath = opt("--appearance-fixture"), markStyle = opt("--mark-style") || "outline";
if (!["outline", "recolour"].includes(markStyle)) throw new Error("Invalid mark style");
const fixtureText = fixturePath ? readFileSync(resolve(fixturePath), "utf8") : null;
if (fixtureText !== null && Buffer.byteLength(fixtureText, "utf8") > 1048576) throw new Error("Theme exceeds 1 MiB");
const mode = opt("--mode");
if (mode && !["side", "overlay", "wipe", "blend", "semantic"].includes(mode)) throw Error("Invalid mode");
const gpu = args.includes("--gpu"); if (gpu) args.splice(args.indexOf("--gpu"), 1);
const width = Number(opt("--width") || 1920);
const height = Number(opt("--height") || 1080); // bench-t7: exact viewport proofs
const dpr = Number(opt("--dpr") || 1);
const offline = args.includes("--offline"); if (offline) args.splice(args.indexOf("--offline"), 1);
const perf = process.env.CHECK_PERF === "1";
const noSkip = args.includes("--no-skip"); if (noSkip) args.splice(args.indexOf("--no-skip"), 1);
const shot = opt("--shot"), page = resolve(opt("--page") || "ui/review.html"), filter = args[0] || "";
if (args.length > 1 || args.some(a => a.startsWith("--"))) throw Error("Unknown arguments: " + args.join(" "));
if (!CHECKS.some(c => c[0].includes(filter))) { console.error(`no check matches "${filter}"`); process.exit(1); }
const port = Number(process.env.CHECK_PORT || 9334);
// Serve the page over local http, as reviewers load it. file:// localStorage on CI's Linux Chrome
// intermittently read stale settings after a reload, which failed persistence checks at random.
const types = {".html":"text/html; charset=utf-8",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".json":"application/json"};
const root = dirname(page), server = createServer((req, res) => {
  const path = resolve(root, "." + decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!path.startsWith(root + "/")) { res.writeHead(403).end(); return; }
  try { const body = readFileSync(path); res.writeHead(200, {"Content-Type": types[extname(path)] || "application/octet-stream", "Cache-Control": "no-store"}).end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r)); server.unref();
const origin = `http://127.0.0.1:${server.address().port}`, pageUrl = `${origin}/${encodeURIComponent(basename(page))}`;
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(chrome, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "rv-"))}`,
  ...(gpu ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]), `--window-size=${width},1080`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => proc.kill());
process.on("uncaughtException", e => { console.error("FAIL startup -> " + e.message); process.exit(1); });
const timeout = Number(process.env.CHECK_TIMEOUT || 15000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tab;
for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page"); } catch {} }
if (!tab) { console.error(`FAIL startup -> Chrome did not start on port ${port}`); process.exit(1); }
let ws;
async function openTab(target) {
ws = new WebSocket(target.webSocketDebuggerUrl); await Promise.race([new Promise(r => ws.onopen = r), new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket open timed out")), timeout).unref())]);
ws.onmessage = onMessage;
}
let id = 0, navigations = 0; const pend = {}, errors = [];
const onMessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) navigations++;
  if (m.method === "Runtime.bindingCalled" && m.params.name === "__flipTheme") { send("Emulation.setEmulatedMedia", { features: [{ name:"prefers-color-scheme", value:m.params.payload }] }).then(() => evaluate(`window.KRTheme.set(${JSON.stringify(m.params.payload)}); window.__themeFlipped()`)); }
  if (m.method === "Runtime.consoleAPICalled") {
    const text = m.params.args.map(a => a.value ?? "").join(" ");
    if (/^BOARD_(FPS|PROOF) /.test(text)) console.log(text);
  }
  if (m.method === "Network.requestWillBeSent" && /^https?:/.test(m.params.request.url) && !m.params.request.url.startsWith(origin + "/")) errors.push("external request: " + m.params.request.url);
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
const send = (method, params = {}) => Promise.race([new Promise(r => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); }), new Promise((_, reject) => setTimeout(() => reject(new Error(method + " timed out")), timeout).unref())]);
const evaluate = async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result;
async function setupTab() {
await send("Runtime.enable");
await send("Runtime.addBinding", { name:"__flipTheme" });
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });  // explicit: headless follows the OS otherwise
await send("Page.enable"); await send("DOMStorage.enable");
const visionResult = await send("Emulation.setEmulatedVisionDeficiency", { type: vision });
if (visionResult.error) throw new Error(visionResult.error.message);
await send("Page.addScriptToEvaluateOnNewDocument", { source:
  `window.__appearanceFixtureText=${JSON.stringify(fixtureText)};window.__appearanceMarkStyle=${JSON.stringify(markStyle)};` });
}
await openTab(tab); await setupTab();
// A check that blocks storage before startup leaves its renderer unable to persist on some Chrome builds
// (CI): later pages in that tab silently lose localStorage writes. Give the next check a fresh tab.
async function freshTab() {
  const old = ws, next = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:"PUT"})).json();
  await openTab(next); await setupTab(); old.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`).catch(() => {}); tab = next;
}
// A reload destroys the old execution context. Retry only that navigation race,
// never report exceptions or other protocol errors.
// localStorage writes reach the browser process asynchronously; a reload that wins the race reads stale
// settings (seen on CI runners). Wait until the browser-side copy matches the page before reloading.
const storageFlushed = async () => {
  const page = (await send("Runtime.evaluate", {expression:"JSON.stringify(Object.entries(localStorage).sort())", returnByValue:true})).result?.result?.value;
  const origin = (await send("Runtime.evaluate", {expression:"location.origin", returnByValue:true})).result?.result?.value;
  let last;
  for (const end = Date.now() + 3000; Date.now() < end; await sleep(25)) {
    last = await send("DOMStorage.getDOMStorageItems", {storageId:{securityOrigin:origin, isLocalStorage:true}});
    const items = last.result?.entries;
    if (!items) { console.log(`storage: DOMStorage unavailable (${origin}) ${JSON.stringify(last.error || last).slice(0, 200)}`); await sleep(300); return; }
    if (JSON.stringify(items.map(([k, v]) => [k, v]).sort()) === page) return;
  }
  console.log(`storage: browser copy never matched page (${origin}) page ${page?.length} browser ${JSON.stringify(last?.result?.entries || []).length}`);
};
const reloadReady = async () => {
  const previous = navigations, deadline = Date.now() + timeout;
  await storageFlushed();
  await send("Page.reload");
  while (Date.now() < deadline) {
    if (navigations > previous) {
      const response = await send("Runtime.evaluate", {expression:"window.reviewReady === true", returnByValue:true});
      if (response.error && !/Cannot find context|Execution context was destroyed/.test(response.error.message)) throw new Error(response.error.message);
      const r = response.result;
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      if (r?.result?.value === true) return;
    }
    await sleep(50);
  }
  throw new Error("reload readiness timed out: " + JSON.stringify((await evaluate("({url:location.href,ready:window.reviewReady,state:document.readyState})")).result?.value) + " " + errors.join(' | '));
};
if (offline) {
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls:["http://*", "https://*"] });
  await send("Network.emulateNetworkConditions", { offline:true, latency:0, downloadThroughput:0, uploadThroughput:0 });
}
await send("Page.addScriptToEvaluateOnNewDocument", {source:`window.__CHECK_PERF=${perf};`});
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem('kr.theme',${JSON.stringify(dark ? 'dark' : 'light')})}catch{}` });
const iconSprite = readFileSync(new URL("./icons/sprite.svg", import.meta.url), "utf8");
let failed = 0;
const readyTimeout = Math.max(1000, Number(process.env.CHECK_TIMEOUT || 15000) - 1000);
for (const [name, hash, expr, lifecycle = {}] of CHECKS.filter(c => c[0].includes(filter))) {
  console.log(`RUN ${name}`);
  let timer, body, startupScript, initialAppearance;
  try {
    body = (async () => {
  if (name === "board geometry pin flipped Wipe Thermal") await send("Emulation.setDeviceMetricsOverride", {width,height:1080,deviceScaleFactor:2,mobile:false});
  // The framing check tests final geometry, not the two-pane camera animation.
  await send("Emulation.setEmulatedMedia", { features:[{ name:"prefers-color-scheme", value:dark ? "dark" : "light" }, { name:"prefers-reduced-motion", value:name === "3D change card keeps 3D and frames J2" ? "reduce" : "no-preference" }] });
  errors.length = 0;
  if (lifecycle.beforeStartup) startupScript = (await send("Page.addScriptToEvaluateOnNewDocument", {source:lifecycle.beforeStartup})).result.identifier;
  await send("Page.navigate", { url: "about:blank" }); await sleep(100);
  await send("Page.navigate", { url: `${pageUrl}#${hash}` });
  const ready = await evaluate(`new Promise((r, reject) => { const deadline = performance.now() + ${readyTimeout}, t = () => window.reviewReady ? r(true) : performance.now() > deadline ? reject(new Error('reviewReady timed out')) : setTimeout(t, 50); t(); })`);
  if (ready.exceptionDetails || errors.length) return [`FAIL startup ${name} -> ${ready.exceptionDetails?.exception?.description || errors.join(' | ')}`, true];
  // The raw dev template has no inlined sprite (inline_page adds it); inject it so icons resolve.
  if (typeof iconSprite === "string") await evaluate(`document.getElementById("kr-icons") || document.body.insertAdjacentHTML("afterbegin", ${JSON.stringify(iconSprite)})`);
  if (name === "3D camera movement is linked and leaving disposes" && await evaluate("!!window.Review3D?.state?.cameras?.length").then(r => r.result?.value)) {
    const r = (await evaluate(`(()=>{const r=document.querySelector('#stage canvas').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,before:window.Review3D.state.cameras.map(c=>c.position.toArray())}})()`)).result.value;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    for (let n = 1; n <= 4; n++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + n * 20, y: r.y + n * 8, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 80, y: r.y + 32, button: "left", buttons: 0 });
    await sleep(100);
    await evaluate(`window.__3dInputResult = ${JSON.stringify({ before: r.before })}; window.__3dInputResult.after = window.Review3D.state.cameras.map(c => c.position.toArray())`);
  }
  if (name === "3D canvas click via mouse input selects J2 row") {
    const q = (await evaluate(`(async()=>{ if(!REVIEW_DATA.projects[0].board.model3d) return null; while (!window.Review3D?.state?.firstFrame) await new Promise(r => setTimeout(r, 50)); const {THREE}=window.THREE3D, st=window.Review3D.state; let n; st.roots[1].traverse(o=>{ if(!n&&o.name==="J2") n=o; }); const p=new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()).project(st.cameras[1]), r=document.querySelectorAll('#stage canvas')[1].getBoundingClientRect(); return {x:r.left+(p.x*.5+.5)*r.width,y:r.top+(-p.y*.5+.5)*r.height}; })()`)).result.value;
    if (q) for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: q.x, y: q.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(300);
  }
  if (name === "board geometry mouse input selects and pin Thermal") {
    const prepare=await evaluate(`(async () => { ${expr} })()`);
    const q=(await evaluate('window.__boardInput')).result?.value;
    if(q) {
      for (const button of ["left","right"]) {
        await send("Input.dispatchMouseEvent",{type:"mousePressed",x:q.x,y:q.y,button,buttons:button==="right"?2:1,clickCount:1});
        await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:q.x+12,y:q.y+8,button,buttons:button==="right"?2:1});
        await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:q.x+12,y:q.y+8,button,buttons:0,clickCount:1});
        await sleep(100);
      }
      const drag=await evaluate('S.s===null && window.__boardPins.length===0');
      if(!drag.result?.value) throw Error("drag selected or proposed a pin");
      await evaluate('setT(window.__boardInput.camera)');
      for (const button of ["left","right","left"]) {
        if(button==="left" && (await evaluate('window.__boardPins.length')).result.value) {
          await send("Input.dispatchKeyEvent",{type:"keyDown",key:"c",code:"KeyC"});
          await send("Input.dispatchKeyEvent",{type:"keyUp",key:"c",code:"KeyC"});
        }
        await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:q.x,y:q.y});
        await send("Input.dispatchMouseEvent",{type:"mousePressed",x:q.x,y:q.y,button,buttons:button==="right"?2:1,clickCount:1});
        await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:q.x,y:q.y,button,buttons:0,clickCount:1});
        await sleep(150);
      }
      await evaluate('window.__boardInputDone=true');
    } else if(prepare.exceptionDetails) throw Error(prepare.exceptionDetails.exception?.description);
  }
  if (name === "Themes reload seed" && persistCheck) initialAppearance = (await evaluate("localStorage.getItem('kr.appearance.v1')")).result.value;
  let r = await evaluate(`(async () => { ${expr} })()`);
  if (r.result?.value === true && name === "Themes reload seed" && persistCheck) {
    const expected = (await evaluate("JSON.stringify(appearanceStore().get())")).result.value;
    for (const view of ["board", "schematic"]) {
      if (view === "schematic") {
        const prepared = await evaluate("(async()=>{const sheet=proj().sheets.find(s=>s.svg);if(!sheet)throw Error('fixture needs schematic');await applyState({...S,v:'sheet:'+sheet.path,m:'side'});history.replaceState(null,'','#'+encodeState());return true})()");
        if (prepared.exceptionDetails) throw new Error(prepared.exceptionDetails.exception?.description);
      }
      await reloadReady();
      const restored = (await evaluate("JSON.stringify(appearanceStore().get())")).result?.value;
      if (restored !== expected) {
        const a=JSON.parse(expected), b=JSON.parse(restored);
        throw new Error("Appearance did not survive " + view + " reload: " + Object.keys(a).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k])).join(', '));
      }
      const rendered = await evaluate(`(()=>{
        if (${JSON.stringify(view)} === 'board' ? S.v !== 'board' : !S.v.startsWith('sheet:')) return false;
        if(S.v==='board')return appearanceBoards.size===2&&[...appearanceBoards].every(b=>b.appearance.colors['board.copper.f'][0]===.12);
        return appearanceSchematics.size===2&&[...appearanceSchematics].every(s=>s.style.getPropertyValue('--sch-ink-009600').includes('18,52,86'));
      })()`);
      if (rendered.result?.value !== true) throw new Error("Both revisions did not restore " + view + " palette");
    }
  }
  if (r.result?.value === true && lifecycle.afterReload) {
    await reloadReady();
    r = await evaluate(`(async () => { ${lifecycle.afterReload} })()`);
  }
  if (r.result?.value === true && ["board Thermal proof", "board Thermal vision proof"].includes(name)) {
    r = await evaluate(`(async()=>{
      await applyState({...S,m:${JSON.stringify(mode)}||S.m});
      Appearance.patch({markStyle:${JSON.stringify(markStyle)}}); boardDiff.render();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      if (${JSON.stringify(name)} === 'board Thermal vision proof') {
        for (const [action, style] of Object.entries(BoardMarks.styles)) {
          const labels = [...document.querySelectorAll('#stage .board-mark-label.' + action)];
          if (!labels.some(e => e.dataset.glyph === style.glyph && e.dataset.dash === style.dash && e.textContent === style.glyph + ' ' + style.word && getComputedStyle(e).borderTopStyle === style.dash)) return 'missing final action encoding ' + action;
        }
      }
      return Appearance.get().markStyle===${JSON.stringify(markStyle)} && (!${JSON.stringify(mode)} || S.m===${JSON.stringify(mode)});
    })()`);
  }
  if (r.result?.value === "skip" && !errors.length) return ["SKIP " + name, noSkip];
  const ok = r.result?.value === true && !errors.length;
  return [`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? r.result?.value)} ${errors.join(" | ")}`}`, !ok];
    })();
    const [line, bad] = await Promise.race([body, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), Number(process.env.CHECK_WALL_TIMEOUT || 60000)); })]);
    console.log(line); if (bad) failed++;
  } catch (e) { console.log(`FAIL ${name} -> ${e.message}`); failed++; await body.catch(() => {}); }
  finally {
    clearTimeout(timer);
    if (initialAppearance !== undefined) await evaluate(`localStorage.${initialAppearance === null ? "removeItem('kr.appearance.v1')" : `setItem('kr.appearance.v1',${JSON.stringify(initialAppearance)})`}`);
    if (startupScript) { await send("Page.removeScriptToEvaluateOnNewDocument", {identifier:startupScript}); await freshTab(); }
  }
}
if (shot && !failed) { await sleep(500); writeFileSync(shot, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64")); console.log("saved", shot); }
ws.close();
const exited = new Promise(resolve => proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.once('exit', resolve));
proc.kill();
await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
process.exit(failed ? 1 : 0);
