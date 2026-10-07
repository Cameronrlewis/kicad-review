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
function layerGroup(n) {
  if (/^F_/.test(n)) return "Top";
  if (/^B_/.test(n)) return "Bottom";
  if (/^In\d+_Cu$/.test(n)) return "Inner";
  if (/^(Edge_Cuts|Margin)$/.test(n)) return "Board";
  return "User";
}
function renderLayers() {
  const box = $("#layers");
  if (S.v !== "board") { box.innerHTML = ""; return; }
  const on = new Set(layersOn()), groups = {};
  for (const l of proj().board.layers) (groups[layerGroup(l.name)] ||= []).push(l);
  box.innerHTML = `<h3>Layers <span class="muted">${on.size}/${proj().board.layers.length}</span></h3>` +
    ["Top", "Inner", "Bottom", "Board", "User"].filter(g => groups[g]).map(g => `<h4>${g}</h4>` + groups[g].map(l =>
      `<label data-changed="${l.changed}"><input type="checkbox" data-layer="${esc(l.name)}" ${on.has(l.name) ? "checked" : ""}>
       ${esc(l.name.replace(/_/g, "."))}${l.changed ? ' <span class="mark" title="changed">≡ changed</span>' : ""}</label>`).join("")).join("");
  for (const cb of box.querySelectorAll("input")) cb.onchange = () => {
    S.layers = [...box.querySelectorAll("input:checked")].map(i => i.dataset.layer);
    if (typeof saveHash === "function") saveHash();
    draw();
  };
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
  renderLayers();
}
function firstChangedView(p) {
  const s = p.sheets.find(s => s.status !== "unchanged");
  return s ? `sheet:${s.path}` : p.board.changed ? "board" : p.sheets[0] ? `sheet:${p.sheets[0].path}` : "board";
}
function openProject(i) { S.p = i; S.s = null; S.layers = null; select(firstChangedView(proj())); if (typeof renderPanel === "function") renderPanel(); }
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

const MODE_NAMES = { side: "Side by side", overlay: "Overlay", wipe: "Wipe", blend: "Blend", semantic: "Semantic" };
S.blend = 0.5; S.wipe = 0.5;
async function oneWorld(stage, view, label) {
  const w = viewport(stage, label, view.kind);
  w.appendChild(await stack("base", view)); w.appendChild(await stack("head", view));
  return w;
}
MODES.overlay = async (stage, view) => { await oneWorld(stage, view, "Base ■  Head ■"); };
MODES.blend = async (stage, view) => {
  const w = await oneWorld(stage, view, "Base under Head");
  w.querySelector(".stack.head").style.opacity = S.blend;
};
MODES.wipe = async (stage, view) => {
  const w = await oneWorld(stage, view, null), vp = w.parentElement;
  vp.insertAdjacentHTML("beforeend", `<span class="tag">Base</span><span class="tag right">Head</span>
    <div class="divider" role="slider" aria-label="Wipe position" tabindex="0"></div>`);
  const d = vp.querySelector(".divider");
  d.addEventListener("pointerdown", e => {
    e.stopPropagation(); try { d.setPointerCapture(e.pointerId); } catch {}
    const mv = ev => { const r = vp.getBoundingClientRect(); S.wipe = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)); apply(); };
    d.addEventListener("pointermove", mv);
    d.addEventListener("pointerup", () => d.removeEventListener("pointermove", mv), { once: true });
  });
  d.addEventListener("keydown", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    S.wipe = Math.min(1, Math.max(0, S.wipe + (e.key === "ArrowLeft" ? -0.05 : 0.05))); apply(); } });
};
MODES.semantic = async (stage, view) => { markersFor(view); await oneWorld(stage, view, "Changes only"); };
function onApply() {
  const vp = document.querySelector("#stage.mode-wipe .vp");
  if (!vp) return;
  const W = vp.clientWidth, x = S.wipe * W, k = S.z / PX, tx = W / 2 - S.x * S.z;
  vp.querySelector(".divider").style.left = `${x}px`;
  vp.querySelector(".stack.head").style.clipPath = `inset(0 0 0 ${Math.max(0, (x - tx) / k)}px)`;
}
function renderModes() {
  $("#modes").innerHTML = Object.entries(MODE_NAMES).map(([m, n]) =>
    `<button data-mode="${m}" aria-pressed="${S.m === m}">${n}</button>`).join("")
    + (S.m === "blend" ? `<label class="blend">Head opacity <input type="range" min="0" max="100" value="${Math.round(S.blend * 100)}"></label>` : "");
  for (const b of document.querySelectorAll("#modes [data-mode]")) b.onclick = () => { S.m = b.dataset.mode; renderModes(); draw(); };
  const r = document.querySelector("#modes input[type=range]");
  if (r) r.oninput = () => { S.blend = r.value / 100; const h = document.querySelector("#stage .stack.head"); if (h) h.style.opacity = S.blend; };
}

const MARKED = new Set(["symbol", "footprint", "sheet", "zone", "label", "global label", "hierarchical label", "via", "track", "board outline"]);
function rowBox(r, side) {
  const p = side === "base" && r.pos_before ? r.pos_before : r.pos;
  if (r.box && !(side === "base" && r.pos_before)) return r.box;
  return p ? [p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3] : null;
}
function hitTest(rows, x, y, after = null) {
  const TOL = 0.5, area = b => (b[2] - b[0]) * (b[3] - b[1]);
  const hits = rows.map(r => [r, rowBox(r, "head")]).filter(([, b]) => b && x >= b[0] - TOL && x <= b[2] + TOL && y >= b[1] - TOL && y <= b[3] + TOL)
    .sort((a, b) => area(a[1]) - area(b[1])).map(([r]) => r);
  if (!hits.length) return null;
  const i = after ? hits.indexOf(after) : -1;
  return hits[(i + 1) % hits.length];
}
function markersFor(view) {
  return proj().changes.filter(r => onView(r, S.v) && (S.m === "semantic" ? MARKED.has(r.kind) : r.action === "modified" && MARKED.has(r.kind)));
}
function afterDraw(view) {
  if (!view) return;
  const sel = proj().changes.find(r => r.id === S.s) || allViolations().find(v => v.id === S.s);
  for (const w of document.querySelectorAll("#stage .world")) {
    const side = w.querySelector(".stack.head") ? "head" : "base";
    const rows = markersFor(view).concat(sel && onView(sel, S.v) ? [{ ...sel, sel: true }] : []);
    for (const r of rows) {
      const b = rowBox(r, side); if (!b) continue;
      const m = document.createElement("div");
      m.className = `marker ${r.action || "violation"}${r.sel ? " sel" : ""}`;
      m.dataset.action = r.action || "violation"; m.dataset.glyph = r.sel ? "◎" : (GLYPH[r.action] || "!");
      Object.assign(m.style, { left: `${b[0] * PX}px`, top: `${b[1] * PX}px`, width: `${(b[2] - b[0]) * PX}px`, height: `${(b[3] - b[1]) * PX}px` });
      w.appendChild(m);
    }
  }
}
function pickAt(vp, e) {
  const r = vp.getBoundingClientRect();
  const x = S.x + (e.clientX - r.left - r.width / 2) / S.z, y = S.y + (e.clientY - r.top - r.height / 2) / S.z;
  const rows = proj().changes.filter(c => onView(c, S.v));
  const hit = hitTest(rows, x, y, rows.find(c => c.id === S.s) || null);
  if (hit) { S.s = hit.id; renderPanel(); draw(); document.querySelector(`#panel [data-id="${hit.id}"]`)?.scrollIntoView({ block: "nearest" }); }
}
function goTo(id) {
  const r = proj().changes.find(c => c.id === id) || allViolations().find(v => v.id === id);
  if (!r) return;
  S.s = id;
  const view = r.where?.board ? "board" : r.where?.sheet != null ? `sheet:${r.where.sheet}` : S.v;
  const box = rowBox(r, r.action === "removed" ? "base" : "head");
  const zoom = () => { if (box) zoomTo(box); renderPanel(); };
  if (view !== S.v) { S.v = view; S.x = S.y = S.z = null; renderNav(); draw().then(zoom); } else { draw().then(zoom); }
}
S.filter = { added: true, removed: true, modified: true, kind: "", q: "" };
const allViolations = () => proj().checks.flatMap(c => c.violations.map(v => ({ ...v, check: c.title })));
function card(r) {
  const body = r.changes
    ? r.changes.map(([k, a, b]) => `<div class="prop"><span>${esc(k)}</span><span class="old">${esc(a ?? "—")}</span><span class="arrow">→</span><span class="new">${esc(b ?? "—")}</span></div>`).join("")
    : Object.entries(r.props || {}).slice(0, 4).map(([k, v]) => `<div class="prop"><span>${esc(k)}</span><span class="new">${esc(v)}</span></div>`).join("");
  return `<button class="card" data-id="${r.id}" data-action="${r.action}" data-kind="${esc(r.kind)}" aria-selected="${S.s === r.id}">
    <span class="ref">${esc(r.ref || r.kind)}</span> <span class="kind">${esc(r.kind)}</span>
    <span class="badge ${r.action}">${GLYPH[r.action]} ${r.action}</span>${body}</button>`;
}
function renderPanel() {
  const p = proj(), f = S.filter;
  const rows = p.changes.filter(r => f[r.action] && (!f.kind || r.kind === f.kind)
    && (!f.q || JSON.stringify([r.ref, r.kind, r.changes, r.props]).toLowerCase().includes(f.q)));
  const kinds = [...new Set(p.changes.map(r => r.kind))];
  const c = { added: 0, removed: 0, modified: 0 }; p.changes.forEach(r => c[r.action]++);
  $("#panel").innerHTML = `<div role="tablist">
      <button role="tab" data-tab="changes" aria-selected="${S.t === "changes"}">Changes ${p.changes.length}</button>
      <button role="tab" data-tab="checks" aria-selected="${S.t === "checks"}">Checks</button></div>` +
    (S.t === "checks" ? (typeof renderChecks === "function" ? renderChecks() : "") : `
    <input class="q" type="search" placeholder="Search reference, value, net, layer…" value="${esc(f.q)}">
    <div class="filters">${["added", "removed", "modified"].map(a =>
      `<button class="chip-filter ${a}" data-action="${a}" aria-pressed="${f[a]}">${GLYPH[a]} ${a} ${c[a]}</button>`).join("")}
      <select class="kind"><option value="">All kinds</option>${kinds.map(k => `<option ${k === f.kind ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></div>
    <div class="cards">${rows.slice(0, 1500).map(card).join("") || '<p class="muted">No changes match.</p>'}</div>`);
  for (const t of document.querySelectorAll("#panel [role=tab]")) t.onclick = () => { S.t = t.dataset.tab; renderPanel(); if (typeof saveHash === "function") saveHash(); };
  for (const b of document.querySelectorAll("#panel .chip-filter")) b.onclick = () => { f[b.dataset.action] = !f[b.dataset.action]; renderPanel(); };
  const k = $("#panel select.kind"); if (k) k.onchange = () => { f.kind = k.value; renderPanel(); };
  const q = $("#panel .q"); if (q) q.oninput = () => { f.q = q.value.toLowerCase(); renderPanel(); $("#panel .q").focus(); };
  for (const b of document.querySelectorAll("#panel .card[data-id]")) b.onclick = () => goTo(b.dataset.id);
}

renderHeader();
applyState(decodeState(location.hash));
window.reviewReady = true;
