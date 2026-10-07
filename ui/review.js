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
function select(view) { S.v = view; renderNav(); if (typeof draw === "function") draw(); }

function decodeState(hash) {
  const q = new URLSearchParams(hash.replace(/^#/, "").replace(/^.*?#/, "")), out = {};
  if (q.has("p")) out.p = +q.get("p");
  for (const k of ["v", "m", "s", "t"]) if (q.has(k)) out[k] = q.get(k);
  for (const k of ["x", "y", "z"]) if (q.has(k)) out[k] = +q.get(k);
  if (q.has("l")) out.layers = q.get("l").split(",").filter(Boolean);
  return out;
}
function valid(st) {   // drop anything that does not exist in this report
  const out = {}, p = D.projects[st.p];
  if (!p) return { p: 0 };
  out.p = st.p;
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

renderHeader();
applyState(decodeState(location.hash));
window.reviewReady = true;
