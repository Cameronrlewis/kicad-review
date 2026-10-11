// Development-only checks for the review page: headless Chrome over the DevTools protocol, no npm.
// Usage: node ui/check.mjs [name-filter] [--shot out.png] [--page path/to/kicad-review.html] [--dark]
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHECKS } from "./checks.mjs";

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const dark = args.includes("--dark"); if (dark) args.splice(args.indexOf("--dark"), 1);
const noSkip = args.includes("--no-skip"); if (noSkip) args.splice(args.indexOf("--no-skip"), 1);
const shot = opt("--shot"), page = resolve(opt("--page") || "ui/review.html"), filter = args[0] || "";
if (!CHECKS.some(c => c[0].includes(filter))) { console.error(`no check matches "${filter}"`); process.exit(1); }
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${mkdtempSync(join(tmpdir(), "rv-"))}`,
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
process.on("exit", () => proc.kill());
process.on("uncaughtException", e => { console.error("FAIL startup -> " + e.message); process.exit(1); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tab;
for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch("http://127.0.0.1:9334/json")).json()).find(t => t.type === "page"); } catch {} }
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}, errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === "Runtime.bindingCalled" && m.params.name === "__flipTheme") { send("Emulation.setEmulatedMedia", { features: [{ name:"prefers-color-scheme", value:m.params.payload }] }).then(() => evaluate("window.__themeFlipped()")); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
const send = (method, params = {}) => Promise.race([new Promise(r => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); }), new Promise((_, reject) => setTimeout(() => reject(new Error(method + " timed out")), Number(process.env.CHECK_TIMEOUT || 15000)).unref())]);
await send("Runtime.enable");
await send("Runtime.addBinding", { name:"__flipTheme" });
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const evaluate = async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result;
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });  // explicit: headless follows the OS otherwise
let failed = 0;
for (const [name, hash, expr] of CHECKS.filter(c => c[0].includes(filter))) {
  // The framing check tests final geometry, not the two-pane camera animation.
  await send("Emulation.setEmulatedMedia", { features:[{ name:"prefers-color-scheme", value:dark ? "dark" : "light" }, { name:"prefers-reduced-motion", value:name === "3D change card keeps 3D and frames J2" ? "reduce" : "no-preference" }] });
  errors.length = 0;
  await send("Page.navigate", { url: "about:blank" }); await sleep(100);
  await send("Page.navigate", { url: `file://${page}#${hash}` });
  const ready = await evaluate("new Promise((r, reject) => { const deadline = performance.now() + 10000, t = () => window.reviewReady ? r(true) : performance.now() > deadline ? reject(new Error('reviewReady timed out')) : setTimeout(t, 50); t(); })");
  if (ready.exceptionDetails || errors.length) { console.log(`FAIL startup ${name} -> ${ready.exceptionDetails?.exception?.description || errors.join(' | ')}`); failed++; continue; }
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
  const r = await evaluate(`(async () => { ${expr} })()`);
  if (r.result?.value === "skip" && !errors.length) { console.log("SKIP " + name); if (noSkip) failed++; continue; }
  const ok = r.result?.value === true && !errors.length;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description)} ${errors.join(" | ")}`}`);
}
if (shot) { await sleep(500); writeFileSync(shot, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64")); console.log("saved", shot); }
ws.close(); proc.kill();
process.exit(failed ? 1 : 0);
