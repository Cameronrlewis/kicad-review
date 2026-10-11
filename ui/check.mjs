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
const shot = opt("--shot"), page = resolve(opt("--page") || "ui/review.html"), filter = args[0] || "";
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${mkdtempSync(join(tmpdir(), "rv-"))}`,
  "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tab;
for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch("http://127.0.0.1:9334/json")).json()).find(t => t.type === "page"); } catch {} }
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}, errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
const send = (method, params = {}) => new Promise(r => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const evaluate = async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result;
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });  // explicit: headless follows the OS otherwise
let failed = 0;
for (const [name, hash, expr] of CHECKS.filter(c => c[0].includes(filter))) {
  await send("Page.navigate", { url: "about:blank" }); await sleep(100);
  await send("Page.navigate", { url: `file://${page}#${hash}` });
  await evaluate("new Promise(r => { const t = () => window.reviewReady ? r() : setTimeout(t, 50); t(); })");
  errors.length = 0;
  if (name === "3D camera movement is linked and leaving disposes" && await evaluate("!!window.Review3D?.state?.cameras?.length").then(r => r.result?.value)) {
    const r = (await evaluate(`(()=>{const r=document.querySelector('#stage canvas').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,before:window.Review3D.state.cameras.map(c=>c.position.toArray())}})()`)).result.value;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    for (let n = 1; n <= 4; n++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + n * 20, y: r.y + n * 8, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 80, y: r.y + 32, button: "left", buttons: 0 });
    await sleep(100);
    await evaluate(`window.__3dInputResult = ${JSON.stringify({ before: r.before })}; window.__3dInputResult.after = window.Review3D.state.cameras.map(c => c.position.toArray())`);
  }
  const r = await evaluate(`(async () => { ${expr} })()`);
  const ok = r.result?.value === true && !errors.length;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description)} ${errors.join(" | ")}`}`);
}
if (shot) { await sleep(500); writeFileSync(shot, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64")); console.log("saved", shot); }
ws.close(); proc.kill();
process.exit(failed ? 1 : 0);
