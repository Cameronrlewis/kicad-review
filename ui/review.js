"use strict";
// KiCad review page. Data contract: window.REVIEW_DATA, format v1 (see README, "Data format").
const D = window.REVIEW_DATA;
const $ = s => document.querySelector(s);
const S = { p: 0, v: null, m: "side", x: null, y: null, z: null, s: null, t: "changes", layers: null, checks: { check: "", scope: null, error: true, warning: true } };
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
  if (S.v !== "board" || !proj().board.changed) { box.innerHTML = ""; return; }
  const on = new Set(layersOn()), groups = {};
  for (const l of proj().board.layers) (groups[layerGroup(l.name)] ||= []).push(l);
  box.innerHTML = `<h3>Layers <span class="muted">${on.size}/${proj().board.layers.length}</span></h3>` +
    ["Top", "Inner", "Bottom", "Board", "User"].filter(g => groups[g]).map(g => `<h4>${g}</h4>` + groups[g].map(l =>
      `<label data-changed="${l.changed}"><input type="checkbox" data-layer="${esc(l.name)}" ${on.has(l.name) ? "checked" : ""}>
       ${esc(l.name.replace(/_/g, "."))}${l.changed ? ' <span class="mark" title="changed">≡ changed</span>' : ""}</label>`).join("")).join("");
  for (const cb of box.querySelectorAll("input")) cb.onchange = () => {
    S.layers = [...box.querySelectorAll("input:checked")].map(i => i.dataset.layer);
    saveHash();
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
    return `<li><button data-view="${esc(view)}" data-status="${esc(s.status)}" style="--depth:${depth}"
      aria-current="${S.v === view}"><span class="name" title="${esc(s.name)}">${s.status === "unchanged" ? "" : "● "}${esc(s.name)}</span>${chips(counts(p, view))}</button>
      ${kids(s.path).length ? `<ul>${sheetItems(s.path, depth + 1)}</ul>` : ""}</li>`;
  }).join("");
  $("#nav").innerHTML = `
    <label class="projsel">Project <select id="proj">${D.projects.map((q, i) =>
      `<option value="${i}" ${i === S.p ? "selected" : ""}>${esc(q.name)} (${esc(q.status)})</option>`).join("")}</select></label>
    <h3>Schematic</h3><ul class="tree">${sheetItems(null, 0) || '<li class="muted">No schematic</li>'}</ul>
    <h3>Board</h3><ul class="tree">${p.board.layers.length || p.board.changed
      ? `<li><button data-view="board" data-status="${p.board.changed ? p.board.status : "unchanged"}" aria-current="${S.v === "board"}">
          <span class="name" title="${esc(p.name)}.kicad_pcb">${p.board.changed ? "● " : ""}${esc(p.name)}.kicad_pcb</span>${chips(counts(p, "board"))}</button></li>`
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
function openProject(i) { S.p = i; S.s = null; S.layers = null; select(firstChangedView(proj())); renderPanel(); }
function select(view) { S.v = view; S.x = S.y = S.z = null; renderNav(); draw(); }

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
  if ((st.v === "board" && p.board.changed) || p.sheets.some(s => `sheet:${s.path}` === st.v)) out.v = st.v;
  if (Object.hasOwn(MODES, st.m ?? "")) out.m = st.m;
  for (const k of ["x", "y", "z"]) if (Number.isFinite(st[k]) && (k !== "z" || st[k] > 0)) out[k] = st[k];
  if (p.changes.some(r => r.id === st.s) || p.checks.some(c => c.violations.some(v => v.id === st.s))) out.s = st.s;
  if (st.t === "checks" || st.t === "changes") out.t = st.t;
  if (st.layers) {   // [] = the reviewer turned every layer off; unknown names only = default layers, not an empty board
    const ls = st.layers.filter(n => p.board.layers.some(l => l.name === n));
    if (!st.layers.length || ls.length) out.layers = ls;
  }
  return out;
}
function applyState(st) {
  const v = valid(st);
  Object.assign(S, { p: v.p, v: v.v ?? firstChangedView(D.projects[v.p]), m: v.m ?? S.m, s: v.s ?? null, t: v.t ?? S.t,
                     layers: v.layers ?? null, x: v.x ?? null, y: v.y ?? null, z: v.z ?? null });
  if (S.x == null || S.y == null || S.z == null) S.x = S.y = S.z = null;
  renderModes();
  renderNav();
  renderPanel();
  return draw();
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
function currentView(v = S.v) {   // null when the view has no render (unchanged board or sheet)
  const p = proj();
  if (v === "board") {
    if (!p.board.changed) return null;
    const on = new Set(layersOn());
    return { kind: "board", size: p.board.size, layers: p.board.layers.filter(l => on.has(l.name)) };
  }
  const pg = p.sheets.find(s => `sheet:${s.path}` === v);
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
  else await MODES[S.m](stage, view);
  if (my !== gen) return;
  $("#stage").replaceWith(stage);
  if (view && !placed()) fit(); else apply();
  afterDraw(view);
}
async function drawSide(stage, view) {
  viewport(stage, "Base", view.kind).appendChild(await stack("base", view));
  viewport(stage, "Head", view.kind).appendChild(await stack("head", view));
}
var MODES = { side: drawSide };

// Transform: S.x, S.y = the drawing point (mm) at the viewport centre; S.z = CSS px per mm.
const placed = () => S.z > 0 && Number.isFinite(S.x) && Number.isFinite(S.y);   // else unset: draw() fits
function apply() {
  const vp = document.querySelector("#stage .vp");
  if (!vp || !placed()) return;
  const W = vp.clientWidth, H = vp.clientHeight, k = S.z / PX;
  for (const w of document.querySelectorAll("#stage .world")) {
    w.style.transform = `translate(${W / 2 - S.x * S.z}px, ${H / 2 - S.y * S.z}px) scale(${k})`;
    if (!gesturing) w.style.setProperty("--k", k);   // a custom-property write restyles every SVG descendant: only when still
  }
  onApply();
  const pct = $("#zoombar .pct"); if (pct) pct.textContent = Math.round(S.z / PX * 100) + "%";
}
let settle, gesturing = false;
function gesture() {           // composite as a bitmap while moving, re-rasterise sharp when still
  for (const w of document.querySelectorAll("#stage .world")) w.style.willChange = "transform";
  gesturing = true; clearTimeout(settle);
  settle = setTimeout(() => { gesturing = false; for (const w of document.querySelectorAll("#stage .world")) w.style.willChange = "auto"; apply(); }, 150);
}
function setT(t) { Object.assign(S, t); apply(); saveHash(); }
function attachPanZoom(vp) {
  vp.addEventListener("wheel", e => {
    e.preventDefault(); if (!placed()) return;   // not fitted yet (a redraw is pending)
    gesture();
    const r = vp.getBoundingClientRect(), f = Math.exp(-e.deltaY * 0.0015);
    const mx = (e.clientX - r.left - r.width / 2) / S.z, my = (e.clientY - r.top - r.height / 2) / S.z;
    setT({ z: S.z * f, x: S.x + mx - mx / f, y: S.y + my - my / f });
  }, { passive: false });
  vp.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !placed()) return;
    vp.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY, moved = 0;
    const mv = ev => { gesture(); moved += Math.abs(ev.clientX - lx) + Math.abs(ev.clientY - ly);
      setT({ x: S.x - (ev.clientX - lx) / S.z, y: S.y - (ev.clientY - ly) / S.z }); lx = ev.clientX; ly = ev.clientY; };
    vp.addEventListener("pointermove", mv);
    vp.addEventListener("pointerup", ev => { vp.removeEventListener("pointermove", mv);
      if (moved < 4) pickAt(vp, ev); }, { once: true });
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
MODES.overlay = async (stage, view) => {
  await oneWorld(stage, view, '<i class="sw del"></i>Base (red) · <i class="sw add"></i>Head (green) · <i class="sw both"></i>both (black)');
};
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
    const end = () => d.removeEventListener("pointermove", mv);
    d.addEventListener("pointerup", end, { once: true });
    d.addEventListener("pointercancel", end, { once: true });
  });
  d.addEventListener("keydown", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    S.wipe = Math.min(1, Math.max(0, S.wipe + (e.key === "ArrowLeft" ? -0.05 : 0.05))); apply(); } });
};
MODES.semantic = (stage, view) => oneWorld(stage, view, "Changes only");
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
  for (const b of document.querySelectorAll("#modes [data-mode]")) b.onclick = () => { S.m = b.dataset.mode; renderModes(); draw(); saveHash(); };
  const r = document.querySelector("#modes input[type=range]");
  if (r) r.oninput = () => { S.blend = r.value / 100; const h = document.querySelector("#stage .stack.head"); if (h) h.style.opacity = S.blend; };
}

const MARKED = new Set(["symbol", "footprint", "sheet", "zone", "label", "global label", "hierarchical label", "via", "track", "board outline"]);
function rowBox(r, side) {
  const p = side === "base" && r.pos_before ? r.pos_before : r.pos;
  if (r.box && !(side === "base" && r.pos_before)) return r.box;
  return p ? [p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3] : null;
}
function hitTest(rows, x, y, after = null, side = "head") {
  const TOL = 0.5, area = b => (b[2] - b[0]) * (b[3] - b[1]);
  const hits = rows.map(r => [r, rowBox(r, side)]).filter(([, b]) => b && x >= b[0] - TOL && x <= b[2] + TOL && y >= b[1] - TOL && y <= b[3] + TOL)
    .sort((a, b) => area(a[1]) - area(b[1])).map(([r]) => r);
  if (!hits.length) return null;
  const i = after ? hits.indexOf(after) : -1;
  return hits[(i + 1) % hits.length];
}
function markersFor(view) {
  return proj().changes.filter(r => onView(r, S.v) && (S.m === "semantic" || r.action === "modified" && MARKED.has(r.kind)));
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
  const side = vp.querySelector(".stack.head") ? "head" : "base";
  const hit = hitTest(rows, x, y, rows.find(c => c.id === S.s) || null, side);
  if (hit) { S.s = hit.id; markSelected(); saveHash(); draw(); document.querySelector(`#panel [data-id="${hit.id}"]`)?.scrollIntoView({ block: "nearest" }); }
}
function markSelected() { for (const e of document.querySelectorAll("#panel [data-id]")) e.setAttribute("aria-selected", e.dataset.id === S.s); }
const viewOf = r => r.where?.board ? "board" : r.where?.sheet != null ? `sheet:${r.where.sheet}` : null;
function goTo(id) {
  const r = proj().changes.find(c => c.id === id) || allViolations().find(v => v.id === id);
  if (!r) return Promise.resolve();
  S.s = id;
  const view = viewOf(r) ?? S.v;
  const box = rowBox(r, r.action === "removed" ? "base" : "head");
  const zoom = () => { if (box) zoomTo(box); markSelected(); };
  if (view !== S.v) { S.v = view; S.x = S.y = S.z = null; renderNav(); }
  return draw().then(zoom);
}
S.filter = { added: true, removed: true, modified: true, kind: "", q: "" };
const allViolations = () => proj().checks.flatMap(c => c.violations.map(v => ({ ...v, check: c.title })));
const PROP_ORDER = ["Value", "Footprint", "footprint", "layer", "position", "net", "layers", "text", "file", "width"];
const rank = k => { const i = PROP_ORDER.indexOf(k); return i < 0 ? PROP_ORDER.length : i; };
function card(r) {
  const props = Object.entries(r.props || {}).filter(([, v]) => v != null && v !== "" && v !== "~").sort(([a], [b]) => rank(a) - rank(b));
  const body = r.changes
    ? r.changes.map(([k, a, b]) => `<div class="prop"><span>${esc(k)}</span><span class="old">${esc(a ?? "—")}</span><span class="arrow">→</span><span class="new">${esc(b ?? "—")}</span></div>`).join("")
    : props.slice(0, 5).map(([k, v]) => `<div class="prop"><span>${esc(k)}</span><span class="new wide">${esc(v)}</span></div>`).join("")
      + (props.length > 5 ? `<div class="more muted">+${props.length - 5} more</div>` : "");
  return `<button class="card" data-id="${esc(r.id)}" data-action="${esc(r.action)}" data-kind="${esc(r.kind)}" aria-selected="${S.s === r.id}">
    <span class="ref">${esc(r.ref || r.kind)}</span> <span class="kind">${esc(r.kind)}</span>
    <span class="badge ${esc(r.action)}">${GLYPH[r.action] ?? ""} ${esc(r.action)}</span>${body}</button>`;
}
function cardsHtml() {
  const f = S.filter, q = f.q.toLowerCase();
  const rows = proj().changes.filter(r => f[r.action] && (!f.kind || r.kind === f.kind)
    && (!q || JSON.stringify([r.ref, r.kind, r.changes, r.props]).toLowerCase().includes(q)));
  return (rows.slice(0, 1500).map(card).join("") || '<p class="muted">No changes match.</p>')
    + (rows.length > 1500 ? `<p class="muted">showing 1500 of ${rows.length}; narrow the filter to see the rest</p>` : "");
}
function bindCards() { for (const b of document.querySelectorAll("#panel .card[data-id]")) b.onclick = () => goTo(b.dataset.id); }
function renderChecks() {
  const p = proj(), state = S.checks;
  if (!p.checks.length) return '<p class="muted">No checks ran for this project.</p>';
  const order = ["erc", "drc", "parity", "bom"];
  const titles = { erc: "ERC", drc: "DRC", parity: "Schematic/board parity", bom: "BOM fields" };
  const byName = new Map(p.checks.map(c => [c.name, c]));
  const names = [...order, ...p.checks.map(c => c.name).filter(n => !order.includes(n))];
  const configured = names.map(name => ({ name, check: byName.get(name), setting: D.settings?.checks?.[name] }));
  const ran = configured.filter(r => r.check && r.setting !== "off").map(r => r.check);
  const all = ran.flatMap(c => c.violations.map(v => ({ ...v, check: c })));
  const totalNew = all.filter(v => v.new).length;
  const scope = state.scope ?? (totalNew ? "new" : "all");
  const checked = state.check && byName.has(state.check) ? state.check : "";
  const summary = configured.map(({ name, check, setting }) => {
    if (!check || setting === "off") return `<button class="check check-not-run" data-check-summary="${esc(name)}" aria-pressed="false">
      <span class="check-heading"><span class="check-status">— not run</span><span class="check-title">${esc(titles[name] || name)}</span></span>
      <span class="check-reason">turned off in kicad-review.toml</span></button>`;
    const baselineOnly = D.settings?.fail_on === "new" && check.errors > 0 && check.new_errors === 0;
    const status = check.status === "fail" ? "✕ failing" : check.status === "warn" ? "! warnings" : "✓ passing";
    const newer = check.new_errors + check.new_warnings;
    return `<button class="check check-${esc(check.status)}" data-check-summary="${esc(name)}" aria-pressed="${checked === name}">
      <span class="check-heading"><span class="check-status">${status}</span><span class="check-title">${esc(check.title)} <small>${esc(check.level === "informational" ? "info" : "required")}</small></span>${baselineOnly ? '<span class="check-status-detail">· no new errors</span>' : ""}</span>
      <span class="check-counts">${check.errors} errors · ${check.warnings} warnings${newer ? ` <b class="check-new">+${newer} new</b>` : ""}${check.fixed ? ` <b class="check-fixed">${check.fixed} fixed</b>` : ""}</span></button>`;
  }).join("");
  let shown = all.filter(v => (!checked || v.check.name === checked) && (scope === "all" || v.new) && state[v.severity]);
  const totalShown = shown.length;
  const groups = new Map();
  for (const v of shown) {
    const key = `${v.check.name}\u0000${v.type}`;
    if (!groups.has(key)) groups.set(key, { check: v.check, type: v.type, violations: [] });
    groups.get(key).violations.push(v);
  }
  const groupHtml = [...groups.values()].sort((a, b) => {
    const an = a.violations.some(v => v.new), bn = b.violations.some(v => v.new);
    const ae = a.violations.some(v => v.severity === "error"), be = b.violations.some(v => v.severity === "error");
    return (bn - an) || (be - ae) || a.type.localeCompare(b.type);
  }).map(g => {
    const vs = g.violations.sort((a, b) => (b.new - a.new) || ((a.severity === "error") ? -1 : 1) - ((b.severity === "error") ? -1 : 1));
    const newCount = vs.filter(v => v.new).length, errors = vs.some(v => v.severity === "error");
    return `<details class="check-group" ${newCount ? "open" : ""}><summary><span class="rule">${esc(g.type)}</span><span class="group-description">${esc(vs[0].description)}</span><span class="group-count">${vs.length}</span>${newCount ? `<b class="new-tag">NEW ${newCount}</b>` : ""}<span class="sev">${errors ? "✕ error" : "! warning"}</span></summary>${vs.slice(0, 200).map(v => {
      const at = v.pos && currentView(viewOf(v));
      return `<button class="viol ${esc(v.severity)}" data-id="${esc(v.id)}" data-new="${!!v.new}" ${at ? "" : 'aria-disabled="true"'} aria-selected="${S.s === v.id}">
        ${v.new ? '<span class="new-tag">NEW</span>' : ""}<span class="viol-location">${esc(v.items.join(" · ") || v.description)}</span><span class="show-hint">${at ? "Show ›" : "no location"}</span></button>`;
    }).join("")}${vs.length > 200 ? `<p class="muted check-more">+${vs.length - 200} more</p>` : ""}</details>`;
  }).join("");
  return `<div class="checks-summary">${summary}</div><div class="filters checks-filters">
    <button class="check-chip" data-check-scope="new" aria-pressed="${scope === "new"}">New in this change ${totalNew}</button>
    <button class="check-chip" data-check-scope="all" aria-pressed="${scope === "all"}">All ${all.length}</button>
    <button class="check-chip" data-check-severity="error" aria-pressed="${state.error}">Errors ${all.filter(v => v.severity === "error").length}</button>
    <button class="check-chip" data-check-severity="warning" aria-pressed="${state.warning}">Warnings ${all.filter(v => v.severity === "warning").length}</button>
  </div><div class="checks-list">${totalShown ? groupHtml : '<p class="muted">No violations match these filters. <button class="show-all">Show all</button></p>'}</div>`;
}
function renderPanel() {
  const p = proj(), f = S.filter;
  const kinds = [...new Set(p.changes.map(r => r.kind))];
  const c = { added: 0, removed: 0, modified: 0 }; p.changes.forEach(r => c[r.action]++);
  $("#panel").innerHTML = `<div role="tablist">
      <button role="tab" data-tab="changes" aria-selected="${S.t === "changes"}">Changes ${p.changes.length}</button>
      <button role="tab" data-tab="checks" aria-selected="${S.t === "checks"}">Checks</button></div>` +
    (S.t === "checks" ? renderChecks() : `
    <input class="q" type="search" placeholder="Search reference, value, net, layer…" value="${esc(f.q)}">
    <div class="filters">${["added", "removed", "modified"].map(a =>
      `<button class="chip-filter ${a}" data-action="${a}" aria-pressed="${f[a]}">${GLYPH[a]} ${a} ${c[a]}</button>`).join("")}
      <select class="kind"><option value="">All kinds</option>${kinds.map(k => `<option ${k === f.kind ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></div>
    <div class="cards">${cardsHtml()}</div>`);
  for (const t of document.querySelectorAll("#panel [role=tab]")) t.onclick = () => { S.t = t.dataset.tab; renderPanel(); saveHash(); };
  for (const b of document.querySelectorAll("#panel .chip-filter[data-action]")) b.onclick = () => { f[b.dataset.action] = !f[b.dataset.action]; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-check-summary]")) b.onclick = () => { const n = b.dataset.checkSummary; if (!proj().checks.some(c => c.name === n)) return; S.checks.check = S.checks.check === n ? "" : n; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-check-scope]")) b.onclick = () => { S.checks.scope = b.dataset.checkScope; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-check-severity]")) b.onclick = () => { S.checks[b.dataset.checkSeverity] = !S.checks[b.dataset.checkSeverity]; renderPanel(); };
  $("#panel .show-all")?.addEventListener("click", () => { Object.assign(S.checks, { check: "", scope: "all", error: true, warning: true }); renderPanel(); });
  const k = $("#panel select.kind"); if (k) k.onchange = () => { f.kind = k.value; renderPanel(); };
  const q = $("#panel .q"); if (q) q.oninput = () => { f.q = q.value; $("#panel .cards").innerHTML = cardsHtml(); bindCards(); };
  bindCards();
  for (const b of document.querySelectorAll("#panel .viol[data-id]")) b.onclick = () => { if (b.getAttribute("aria-disabled") !== "true") goTo(b.dataset.id); };
}

function encodeState(s = S) {
  const q = new URLSearchParams();
  q.set("p", s.p); q.set("v", s.v); q.set("m", s.m);
  for (const k of ["x", "y", "z"]) if (Number.isFinite(s[k])) q.set(k, +s[k].toFixed(3));
  if (s.s) q.set("s", s.s);
  if (s.t && s.t !== "changes") q.set("t", s.t);
  if (s.layers) q.set("l", s.layers.join(","));
  return q.toString().replace(/%2F/g, "/").replace(/%3A/g, ":").replace(/%2C/g, ",");
}
let hashTimer;
function saveHash() { clearTimeout(hashTimer); hashTimer = setTimeout(() => { history.replaceState(null, "", "#" + encodeState()); if (parent !== window) parent.postMessage({ kicadReviewHash: "#" + encodeState() }, "*"); }, 200); }
function step(dir) {
  const ids = [...document.querySelectorAll(S.t === "checks" ? "#panel .viol[data-id]:not([aria-disabled])" : "#panel .card[data-id]")].map(e => e.dataset.id);
  if (!ids.length) return;
  const i = ids.indexOf(S.s), next = ids[i < 0 ? (dir > 0 ? 0 : ids.length - 1) : (i + dir + ids.length) % ids.length];
  goTo(next); document.querySelector(`#panel [data-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
}
document.addEventListener("keydown", e => {
  if (e.target.closest?.("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
  if (arrow && e.target.closest?.("#panel, button, [role=slider]")) return;   // leave arrows to scrolling and widgets
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (e.key === "f") fit();
  else if (e.key === "Escape") { S.s = null; markSelected(); draw(); saveHash(); }
});
function positionLink() {
  const where = S.v === "board" ? `${proj().name} board` : `${proj().name} sheet ${proj().sheets.find(s => `sheet:${s.path}` === S.v)?.name ?? ""}`;
  return `${D.links.review || D.repo} · ${where} #${encodeState()}`;
}
function applyGoTo(text) { const i = text.indexOf("#"); if (i >= 0) applyState(decodeState(text.slice(i))); }
function renderZoombar() {
  $("#zoombar").innerHTML = `<button data-z="0.8" aria-label="Zoom out">−</button><span class="pct"></span><button data-z="1.25" aria-label="Zoom in">+</button>
    <button data-act="fit">Fit</button><span class="sep"></span><span class="muted">j / k: next / previous</span>
    <button data-act="copy">Copy link</button><input class="goto" placeholder="Go to… paste a link">`;
  for (const b of document.querySelectorAll("#zoombar [data-z]")) b.onclick = () => { if (placed()) setT({ z: S.z * +b.dataset.z }); };
  $("#zoombar [data-act=fit]").onclick = fit;
  $("#zoombar [data-act=copy]").onclick = async e => {
    const b = e.currentTarget, link = positionLink();
    try {
      await navigator.clipboard.writeText(link);
      b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy link"; }, 1500);
    } catch {   // no clipboard API (file://) or write refused: show the text selected so the user can press Cmd/Ctrl+C
      let f = $("#zoombar input[readonly]");
      if (!f) { f = document.createElement("input"); f.readOnly = true; f.className = "copyfield"; f.setAttribute("aria-label", "Link to copy"); b.after(f); }
      f.value = link; f.focus(); f.select();
    }
  };
  $("#zoombar .goto").onchange = e => { applyGoTo(e.target.value); e.target.value = ""; };
}
renderZoombar();

// Changed regions: rasterise both sides, compare pixels on a grid, merge touching cells into boxes.
async function raster(side, view, W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  for (const l of view.layers) {
    const t = await svgText(l.svg[side]);
    if (!t) continue;
    const url = URL.createObjectURL(new Blob([t], { type: "image/svg+xml" }));
    const img = new Image();
    img.src = url;
    try { await img.decode(); ctx.drawImage(img, 0, 0, W, H); } catch (_) {}
    URL.revokeObjectURL(url);
  }
  return ctx.getImageData(0, 0, W, H).data;
}
async function computeRegions(view) {
  const W = 2400, H = Math.round(W * view.size[1] / view.size[0]), CELL = 8;
  const a = await raster("base", view, W, H), b = await raster("head", view, W, H);
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL), grid = new Uint8Array(gw * gh);
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) > 96) {
      const p = i / 4;
      grid[Math.floor(Math.floor(p / W) / CELL) * gw + Math.floor((p % W) / CELL)] = 1;
    }
  }
  const seen = new Uint8Array(gw * gh), boxes = [], mm = view.size[0] / gw;
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s] || seen[s]) continue;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    const q = [s]; seen[s] = 1;
    while (q.length) {
      const c = q.pop(), cx = c % gw, cy = (c - cx) / gw;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {   // join cells up to 2 apart
        const nx = cx + dx, ny = cy + dy, n = ny * gw + nx;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && grid[n] && !seen[n]) { seen[n] = 1; q.push(n); }
      }
    }
    boxes.push({ x0: x0 * mm - 2, y0: y0 * mm - 2, x1: (x1 + 1) * mm + 2, y1: (y1 + 1) * mm + 2 });
  }
  return boxes.sort((p, q) => (q.x1 - q.x0) * (q.y1 - q.y0) - (p.x1 - p.x0) * (p.y1 - p.y0));
}

renderHeader();
const shotMode = !!new URLSearchParams(location.hash.slice(1)).get("shot");
if (shotMode) document.body.classList.add("shot");
function start() {
  const drawn = applyState(decodeState(location.hash)), hasPos = S.z != null;   // read before draw() fits
  return drawn.then(async () => {
    if (S.s && !hasPos) await goTo(S.s);   // an address with a position keeps it; the selection is only marked
    if (shotMode) {
      const v = currentView(); if (v) { const boxes = await computeRegions(v); if (boxes.length) zoomTo([boxes[0].x0, boxes[0].y0, boxes[0].x1, boxes[0].y1], 4); }
      document.title = "ready";
    }
  }).catch(e => console.error(e)).finally(() => { window.reviewReady = true; if (parent !== window) parent.postMessage({ kicadReviewReady: true }, "*"); });   // cmd_shots must never wait out its budget
}
start();
window.addEventListener("hashchange", () => applyState(decodeState(location.hash)));
