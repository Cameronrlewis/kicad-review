"use strict";
// KiCad review page. Data contract: window.REVIEW_DATA, format v1 (see docs/superpowers/plans/2026-10-07-review-ui.md §A5).
const D = window.REVIEW_DATA;
const $ = s => document.querySelector(s);
const S = { p: 0, v: null, m: "side", x: null, y: null, z: null, s: null, t: "changes", layers: null };
const proj = () => D.projects[S.p];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const GLYPH = { added: "＋", removed: "−", modified: "≡" };

function onView(r, view) {
  if (!r.where) return false;
  return view === "board" ? !!r.where.board : view === `sheet:${r.where.sheet}`;
}
function counts(p, view) {
  const c = { added: 0, removed: 0, modified: 0 };
  for (const r of p.changes) if (onView(r, view)) c[r.action]++;
  return c;
}
function chips(c) {
  return `<span class="counts">${["added", "removed", "modified"].map(a =>
    `<span class="chip ${a}" title="${a}">${GLYPH[a]}${c[a]}</span>`).join("")}</span>`;
}
function checksVerdict() {
  const all = D.projects.flatMap(p => p.checks);
  return { failing: all.filter(c => c.status === "fail").length, newErrors: all.reduce((n, c) => n + c.new_errors, 0) };
}
function renderHeader() {
  const v = checksVerdict(), short = s => (s || "nothing").slice(0, 7), L = D.links;
  const link = (href, text) => href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);
  $("#hdr").innerHTML = `<b>${esc(D.repo || "KiCad review")}</b>
    <span class="revs">${link(L.base, short(D.base))} → ${link(L.head, short(D.head))}</span>
    <span class="muted">${esc(D.reason)}</span>
    ${L.review ? link(L.review, /\/pull\/(\d+)/.test(L.review) ? `PR #${L.review.match(/\/pull\/(\d+)/)[1]} ↗` : "Compare ↗") : ""}
    <span class="verdict ${v.failing ? "fail" : "pass"}">${v.failing ? `✕ ${v.failing} check${v.failing > 1 ? "s" : ""} failing` : "✓ checks passing"}${v.newErrors ? ` · ${v.newErrors} new error${v.newErrors > 1 ? "s" : ""}` : ""}</span>
    ${L.run ? link(L.run, "Workflow run") : ""}`;
}
function renderNav() {
  const p = proj();
  const kids = parent => p.sheets.filter(s => s.parent === parent);
  const sheetItems = (parent, depth) => kids(parent).map(s => {
    const view = `sheet:${s.path}`;
    return `<li><button data-view="${esc(view)}" data-status="${s.status}" style="--depth:${depth}"
      aria-current="${S.v === view}"><span class="name">${s.status === "unchanged" ? "" : "● "}${esc(s.name)}</span>${chips(counts(p, view))}</button>
      ${kids(s.path).length ? `<ul>${sheetItems(s.path, depth + 1)}</ul>` : ""}</li>`;
  }).join("");
  $("#nav").innerHTML = `
    <label class="projsel">Project <select id="proj">${D.projects.map((q, i) =>
      `<option value="${i}" ${i === S.p ? "selected" : ""}>${esc(q.name)} (${q.status})</option>`).join("")}</select></label>
    <h3>Schematic</h3><ul class="tree">${sheetItems(null, 0) || '<li class="muted">No schematic</li>'}</ul>
    <h3>Board</h3><ul class="tree">${p.board.layers.length || p.board.changed
      ? `<li><button data-view="board" data-status="${p.board.changed ? p.board.status : "unchanged"}" aria-current="${S.v === "board"}">
          <span class="name">${p.board.changed ? "● " : ""}${esc(p.name)}.kicad_pcb</span>${chips(counts(p, "board"))}</button></li>`
      : '<li class="muted">No board changes</li>'}</ul>
    <div id="layers"></div>`;
  $("#proj").onchange = e => openProject(+e.target.value);
  for (const b of document.querySelectorAll("#nav [data-view]")) b.onclick = () => select(b.dataset.view);
}
function firstChangedView(p) {
  const s = p.sheets.find(s => s.status !== "unchanged");
  return s ? `sheet:${s.path}` : p.board.changed ? "board" : p.sheets[0] ? `sheet:${p.sheets[0].path}` : "board";
}
function openProject(i) { S.p = i; S.s = null; S.layers = null; select(firstChangedView(proj())); }
function select(view) { S.v = view; S.x = S.y = S.z = null; renderNav(); if (typeof draw === "function") draw(); }

function decodeState(hash) {
  const q = new URLSearchParams(hash.replace(/^#/, "").replace(/^.*?#/, "")), out = {};
  if (q.has("p")) out.p = +q.get("p");
  for (const k of ["v", "m", "s", "t"]) if (q.has(k)) out[k] = q.get(k);
  for (const k of ["x", "y", "z"]) if (q.has(k)) out[k] = +q.get(k);
  if (q.has("l")) out.layers = q.get("l").split(",").filter(Boolean);
  return out;
}
function valid(st) {   // drop anything that does not exist in this report
  const pi = Number.isInteger(st.p) && D.projects[st.p] ? st.p : 0, out = { p: pi }, p = D.projects[pi];
  if (st.v === "board" || p.sheets.some(s => `sheet:${s.path}` === st.v)) out.v = st.v;
  if (typeof MODES === "undefined" || MODES[st.m]) if (st.m) out.m = st.m;
  for (const k of ["x", "y", "z"]) if (Number.isFinite(st[k]) && (k !== "z" || st[k] > 0)) out[k] = st[k];
  if (p.changes.some(r => r.id === st.s) || p.checks.some(c => c.violations.some(v => v.id === st.s))) out.s = st.s;
  if (st.t === "checks" || st.t === "changes") out.t = st.t;
  if (st.layers) out.layers = st.layers.filter(n => p.board.layers.some(l => l.name === n));
  return out;
}
function applyState(st) {
  const v = valid(st);
  Object.assign(S, { p: v.p, v: v.v ?? firstChangedView(D.projects[v.p]), m: v.m ?? S.m, s: v.s ?? null, t: v.t ?? S.t,
                     layers: v.layers ?? null, x: v.x ?? null, y: v.y ?? null, z: v.z ?? null });
  if (S.x == null || S.y == null || S.z == null) S.x = S.y = S.z = null;
  if (typeof renderModes === "function") renderModes();
  renderNav();
  if (typeof renderPanel === "function") renderPanel();
  return typeof draw === "function" ? draw() : Promise.resolve();
}

const PX = 4;                       // CSS px per mm at z = PX
const cache = {};
async function svgText(id) {
  if (!id) return null;
  if (!(id in cache)) {
    const bin = Uint8Array.from(atob(D.blobs[id]), c => c.charCodeAt(0));
    cache[id] = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
  return cache[id];
}
const HIDE_LAYERS = /Fab|Courtyard|CrtYd|Paste|Adhes|Mask|Margin|User|Drawings|Dwgs|Comments|Cmts|Eco/i;
function layersOn() {
  const p = proj();
  return S.layers || p.board.layers.filter(l => !HIDE_LAYERS.test(l.name)).map(l => l.name);
}
function currentView() {
  const p = proj();
  if (S.v === "board") {
    const on = new Set(layersOn());
    return { kind: "board", size: p.board.size, layers: p.board.layers.filter(l => on.has(l.name)) };
  }
  const pg = p.sheets.find(s => `sheet:${s.path}` === S.v);
  return pg && pg.svg ? { kind: "sheet", size: pg.size, layers: [{ name: "sheet", changed: true, svg: pg.svg }] } : null;
}
async function stack(side, view) {
  const st = document.createElement("div");
  st.className = `stack ${side}`;
  st.style.width = `${view.size[0] * PX}px`; st.style.height = `${view.size[1] * PX}px`;
  for (const l of view.layers) {
    const t = await svgText(l.svg[side]);
    if (!t) continue;
    const d = document.createElement("div");
    d.className = "layer"; d.dataset.layer = l.name;
    d.innerHTML = t.slice(t.indexOf("<svg"));
    st.appendChild(d);
  }
  return st;
}
function viewport(stage, label, kind) {
  const vp = document.createElement("div");
  vp.className = `vp ${kind}`;
  vp.innerHTML = `<div class="world"></div>${label ? `<span class="tag">${label}</span>` : ""}`;
  attachPanZoom(vp);
  stage.appendChild(vp);
  return vp.firstChild;
}
let gen = 0;
async function draw() {
  const my = ++gen, view = currentView(), stage = document.createElement("main");
  stage.id = "stage"; stage.className = `mode-${S.m}`;
  if (!view) stage.innerHTML = `<p class="empty">This drawing did not change, so it has no render. Its object changes are in the list.</p>`;
  else await MODES[S.m](stage, view);       // defined in Task 5; until then MODES = { side: drawSide }
  if (my !== gen) return;
  $("#stage").replaceWith(stage);
  if (view && (S.z == null || S.x == null)) fit(); else apply();
  if (typeof afterDraw === "function") afterDraw(view);
}
async function drawSide(stage, view) {
  viewport(stage, "Base", view.kind).appendChild(await stack("base", view));
  viewport(stage, "Head", view.kind).appendChild(await stack("head", view));
}
var MODES = { side: drawSide };

// Transform: S.x, S.y = the drawing point (mm) at the viewport centre; S.z = CSS px per mm.
function apply() {
  const vp = document.querySelector("#stage .vp");
  if (!vp) return;
  const W = vp.clientWidth, H = vp.clientHeight, k = S.z / PX;
  for (const w of document.querySelectorAll("#stage .world")) {
    w.style.transform = `translate(${W / 2 - S.x * S.z}px, ${H / 2 - S.y * S.z}px) scale(${k})`;
    if (!gesturing) w.style.setProperty("--k", k);   // a custom-property write restyles every SVG descendant: only when still
  }
  if (typeof onApply === "function") onApply();
}
let settle, gesturing = false;
function gesture() {           // composite as a bitmap while moving, re-rasterise sharp when still
  for (const w of document.querySelectorAll("#stage .world")) w.style.willChange = "transform";
  gesturing = true; clearTimeout(settle);
  settle = setTimeout(() => { gesturing = false; for (const w of document.querySelectorAll("#stage .world")) w.style.willChange = "auto"; apply(); }, 150);
}
function setT(t) { Object.assign(S, t); apply(); if (typeof saveHash === "function") saveHash(); }
function attachPanZoom(vp) {
  vp.addEventListener("wheel", e => {
    e.preventDefault(); gesture();
    const r = vp.getBoundingClientRect(), f = Math.exp(-e.deltaY * 0.0015);
    const mx = (e.clientX - r.left - r.width / 2) / S.z, my = (e.clientY - r.top - r.height / 2) / S.z;
    setT({ z: S.z * f, x: S.x + mx - mx / f, y: S.y + my - my / f });
  }, { passive: false });
  vp.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    vp.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY, moved = 0;
    const mv = ev => { gesture(); moved += Math.abs(ev.clientX - lx) + Math.abs(ev.clientY - ly);
      setT({ x: S.x - (ev.clientX - lx) / S.z, y: S.y - (ev.clientY - ly) / S.z }); lx = ev.clientX; ly = ev.clientY; };
    vp.addEventListener("pointermove", mv);
    vp.addEventListener("pointerup", ev => { vp.removeEventListener("pointermove", mv);
      if (moved < 4 && typeof pickAt === "function") pickAt(vp, ev); }, { once: true });
  });
}
function contentBox() {   // drawn extent in mm, stroke included (getBBox ignores stroke); mapped via each svg's own rendered rect
  const v = currentView();
  let b = null;
  for (const svg of document.querySelectorAll("#stage svg")) {
    const R = svg.getBoundingClientRect();
    if (!v || !R.width) continue;
    const kx = v.size[0] / R.width, ky = v.size[1] / R.height;
    for (const g of svg.querySelectorAll(":scope > g")) {
      const r = g.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const q = [(r.left - R.left) * kx, (r.top - R.top) * ky, (r.right - R.left) * kx, (r.bottom - R.top) * ky];
      b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q;
    }
  }
  return b;
}
function zoomTo(box, pad = 8) {
  const vp = document.querySelector("#stage .vp");
  if (!vp || !box) return;
  const w = Math.max(box[2] - box[0] + 2 * pad, 20), h = Math.max(box[3] - box[1] + 2 * pad, 20);
  setT({ z: Math.min(vp.clientWidth / w, vp.clientHeight / h), x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });
}
function fit() { const v = currentView(); zoomTo(contentBox() || (v && [0, 0, v.size[0], v.size[1]]), 2); }

renderHeader();
applyState(decodeState(location.hash));
window.reviewReady = true;
