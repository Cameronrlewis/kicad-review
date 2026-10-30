"use strict";
// KiCad review page. Data contract: window.REVIEW_DATA, format v1 (see README, "Data format").
const D = window.REVIEW_DATA;
// bench-t2: never repeat the site frame inside its sandboxed report.
document.body.classList.toggle("report-framed", parent !== window);
const $ = s => document.querySelector(s);
const S = { p: 0, v: null, m: "side", x: null, y: null, z: null, s: null, t: "changes", layers: null, hidden3d: [], checks: { check: "", scope: null, error: true, warning: true, waived: false } };
S.threads = null; S.threadFilter = { status: "open", severity: "" }; S.placing = false;
let THREADS_ON = parent !== window && !!D.settings?.threads?.enabled;
let ISSUES_ON = parent !== window && !!D.settings?.issues?.enabled;
S.issues = null;
S.units = "mm"; S.grid = true;
const readyMessage = () => ({ kicadReviewReady: true, threads: THREADS_ON, issues: ISSUES_ON, blockMerge: THREADS_ON && !!D.settings?.threads?.block_merge });
const validThread = t => t && t.id !== Object(t.id) && Object(t.id) instanceof String && (t.resolved === true || t.resolved === false) && t.anchor && t.anchor === Object(t.anchor)
  && t.anchor.v === 1 && Number.isFinite(t.anchor.x) && Number.isFinite(t.anchor.y) && Array.isArray(t.comments);
function acceptThreads(list) {
  S.threads = list.filter(t => { try { return validThread(t); } catch { return false; } }).slice(0, 500);   // ponytail: 500 threads drawn at most
  if (S.wantThreads) S.t = "threads";
  S.wantThreads = false;
  if (S.v) { renderPanel(); drawPins(); }
  // Geometry-only leaf anchors must also resolve when a reload opens a sheet.
  const keys=[...new Set(S.threads.filter(t=>t.anchor.target==='object' && t.anchor.sheet==null)
    .flatMap(t=>['base','head'].map(side=>D.projects.find(p=>p.dir===t.anchor.project)?.board?.geometry?.[side])).filter(Boolean))];
  if (keys.length) Promise.all(keys.map(loadBoardScene)).then(()=>{if(S.v){renderPanel();drawPins();}}).catch(()=>{});
}
function validIssue(i) {
  if (!i || !Number.isSafeInteger(i.number) || i.number <= 0 || i.state !== "open"
    || i.title === Object(i.title) || !(Object(i.title) instanceof String)
    || i.url === Object(i.url) || !(Object(i.url) instanceof String)
    || !i.anchor || i.anchor.v !== 1 || !Number.isFinite(i.anchor.x) || !Number.isFinite(i.anchor.y)
    || !["point", "object"].includes(i.anchor.target)) return false;
  try {
    const u = new URL(i.url);
    return u.origin === "https://github.com" && !u.username && !u.password && !u.search && !u.hash
      && new RegExp("^/[^/]+/[^/]+/issues/" + i.number + "$").test(u.pathname);
  } catch { return false; }
}
function acceptIssues(list) {
  S.issues = list.filter(i => { try { return validIssue(i); } catch { return false; } }).slice(0, 100);
  if (S.wantThreads) S.t = "threads";
  S.wantThreads = false;
  if (S.v) { renderPanel(); drawPins(); }
}
const issueForAnchor = a => (S.issues || []).find(i => ["project", "file", "ref", "x", "y"].every(key => i.anchor[key] === a[key]));
function findingAnchor(v) {
  const view = viewOf(v), P = proj(), file = view && viewFile(P, view);
  if (!file || !Array.isArray(v.pos) || !Number.isFinite(v.pos[0]) || !Number.isFinite(v.pos[1])) return null;
  return { v: 1, project: P.dir, file, sheet: view === "board" ? null : view.slice(6), layer: null, target: "point",
    uuid: null, kind: null, ref: null, x: round3(v.pos[0]), y: round3(v.pos[1]), side: "head", commit: D.head, severity: "comment" };
}
function handleParentMessage(e, on = THREADS_ON, issuesOn = ISSUES_ON) {
  if (e.source !== parent) return false;
  let accepted = false;
  if (on && Array.isArray(e.data?.kicadReviewThreads)) { acceptThreads(e.data.kicadReviewThreads); accepted = true; }
  if (issuesOn && Array.isArray(e.data?.kicadReviewIssues)) { acceptIssues(e.data.kicadReviewIssues); accepted = true; }
  return accepted;
}
addEventListener("message", e => handleParentMessage(e));
function proposePin(vp, e) {
  const p = boardDiff?.point(vp,e), hit = boardDiff?.hits(vp,e)[0];
  const [x, y] = p?.point || toWorld(vp, e);
  const anchor = boardDiff ? (hit ? geometryAnchor(hit) : p?.side && pointAnchor(x,y,p.side)) : anchorAt(x, y, sideOf(vp));
  if (anchor && anchor.file) parent.postMessage({ kicadReviewPin: anchor }, "*");
}
const shownThreads = () => (S.threads || []).filter(t => (S.threadFilter.status === "all" || (S.threadFilter.status === "resolved") === t.resolved)
  && (!S.threadFilter.severity || t.anchor.severity === S.threadFilter.severity) && t.anchor.project === proj().dir);
function openThread(id) {
  const t = (S.threads || []).find(x => x.id === id); if (!t) return;
  const r = resolveAnchor(t.anchor), drawable = !r.detached && currentView(r.view);
  S.thread = id;
  const show = () => { if (drawable) zoomTo([r.pos[0] - 6, r.pos[1] - 6, r.pos[0] + 6, r.pos[1] + 6]); renderPanel(); parent.postMessage({ kicadReviewOpenThread: id }, "*"); };
  if (drawable && r.view !== S.v) { stopPlacing(); const tabs = tabsChange(r.view); S.v = r.view; S.x = S.y = S.z = null; renderNav(); if (tabs) renderPanel(); return draw().then(() => { show(); saveHash(); }); }
  show();
}
const proj = () => D.projects[S.p];
const sideOf = node => { const vp = node.closest(".vp") || node; return vp.dataset.side || (vp.querySelector(".stack.head") ? "head" : "base"); };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const GLYPH = { added: "＋", removed: "−", modified: "≡" };
const GROUPS3D = [["bodies", "Component bodies"], ["top", "Top side"], ["bottom", "Bottom side"], ["silk", "Silkscreen"], ["mask", "Soldermask"], ["board", "Board"]];

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
function renderLayers() {
  const box = $("#layers");
  if (S.v === "3d") {
    const hidden = new Set(S.hidden3d || []);
    box.innerHTML = `<h3>3D view</h3>${GROUPS3D.map(([id, label]) => `<label><input type="checkbox" data-3d-group="${id}" ${hidden.has(id) ? "" : "checked"}> ${label}</label>`).join("")}`;
    box.querySelectorAll("[data-3d-group]").forEach(cb => cb.onchange = () => { const h = new Set(S.hidden3d || []); cb.checked ? h.delete(cb.dataset["3dGroup"]) : h.add(cb.dataset["3dGroup"]); S.hidden3d = [...h]; window.Review3D?.setHidden(S.hidden3d); saveHash(); });
    return;
  }
  box.innerHTML = "";   // board layers live in the Appearance dock
}
function renderHeader() {
  const v = checksVerdict(), short = s => (s || "nothing").slice(0, 7), L = D.links;
  const link = (href, text) => href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);
  const pr = /\/pull\/(\d+)/.exec(L.review || '');
  $("#hdr").innerHTML = `<span>${esc(D.repo || 'Repository')}</span><span aria-hidden="true">›</span><span>${pr ? `PR #${pr[1]}` : 'Review'}</span>`;
  $("#report-state").textContent = v.failing ? `✕ NEEDS WORK · ${v.failing} CHK · ${v.newErrors} NEW ERR` : '✓ CHECKS PASSING';
  $("#report-review-bar").innerHTML = `<span class="bench-revision"><span class="bench-label">BASE</span> ${link(L.base, short(D.base))}</span><span aria-hidden="true">→</span><span class="bench-revision"><span class="bench-label">HEAD</span> ${link(L.head, short(D.head))}</span>${L.review ? link(L.review, pr ? `PR #${pr[1]} ↗` : 'Compare ↗') : ''}<span class="muted">Run result not recorded</span><details class="bench-menu bench-merge"><summary>MERGE · Unavailable</summary><div class="bench-popover"><ul>${['This review', 'GitHub approval', 'Blocking threads'].map(label => `<li>… ${label}: live data unavailable offline</li>`).join('')}</ul></div></details><details class="bench-menu bench-overflow"><summary aria-label="Review actions">•••</summary><div class="bench-popover">${pr ? link(L.review + '/commits', 'History ↗') : '<button disabled title="No pull request recorded">History</button>'}<button disabled title="Open the online review to create a share link">Share…</button>${L.run ? link(L.run, 'Open run ↗') : '<button disabled title="Run not recorded">Open run</button>'}<button data-act="copy">Copy link</button><label>Go to<input class="goto" aria-label="Go to saved review position" placeholder="Paste a review link"></label><input class="copyfield" aria-label="Link to copy" readonly hidden></div></details>`;
  $("#report-review-bar [data-act=copy]").onclick = async event => {
    const button = event.currentTarget, value = positionLink();
    button.closest('details').open = true;
    try { await navigator.clipboard.writeText(value); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy link'; }, 1500); }
    catch {
      let input = $("#report-review-bar .copyfield");
      if (!input) { input = document.createElement('input'); input.className = 'copyfield'; input.readOnly = true; input.setAttribute('aria-label', 'Link to copy'); button.after(input); }
      input.hidden = false; input.value = value; input.focus(); input.select();
    }
  };
  $("#report-review-bar .goto").onchange = event => { applyGoTo(event.target.value); event.target.value = ''; };
}
function sheetNumber(sheet) {
  return sheet.page == null || !String(sheet.page).trim()
    ? String(proj().sheets.indexOf(sheet) + 1) : String(sheet.page);
}
function compareSheetPages(a, b) {
  const x = sheetNumber(a), y = sheetNumber(b), integer = s => /^[+-]?\d+$/.test(s);
  let order;
  if (integer(x) && integer(y)) order = x === y ? 0 : (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0);
  else if (integer(x) !== integer(y)) order = integer(x) ? -1 : 1;
  else order = x.localeCompare(y, "en", { numeric: true, sensitivity: "variant" });
  return order || proj().sheets.indexOf(a) - proj().sheets.indexOf(b);
}
function orderedSheets() { return [...proj().sheets].sort(compareSheetPages); }
function navigateSheet(direction) {
  if (!String(S.v).startsWith("sheet:")) return;
  const pages = orderedSheets(), i = pages.findIndex(s => `sheet:${s.path}` === S.v);
  if (i < 0) return;
  const page = direction === "parent" ? pages.find(s => s.path === pages[i].parent) : pages[i + direction];
  if (page) select(`sheet:${page.path}`);
}
// bench-t4: the left dock owns navigation and Appearance; t=appearance remains shareable.
let leftTab = "project", rightTab = "changes";
const projectTools = {q:"", sort:"page", filter:"all"};
let leftWidth = 262, leftCollapsed = false;
try {
  const saved = JSON.parse(localStorage.getItem("kr.bench.left") || "null");
  if (Number.isFinite(saved?.width)) leftWidth = Math.max(220, Math.min(520, saved.width));
  leftCollapsed = saved?.collapsed === true;
} catch {} // file reports and blocked storage must remain usable
function persistLeftDock() {
  try { localStorage.setItem("kr.bench.left", JSON.stringify({width:leftWidth, collapsed:leftCollapsed})); } catch {}
}
function syncLeftDock() {
  document.documentElement.style.setProperty("--nav-w", leftCollapsed ? "0px" : `${leftWidth}px`);
  $("#nav").classList.toggle("left-collapsed", leftCollapsed);
  const toggle = $('[data-dock="nav"]');
  toggle?.setAttribute("aria-expanded", String(!leftCollapsed && (!matchMedia("(max-width:899px)").matches || $("#nav").classList.contains("dock-open"))));
}
function projectChips(c) {
  return `<span class="counts">${["added", "removed", "modified"].map((a, i) => `<span class="chip ${a}" title="${c[a]} ${a}" aria-label="${c[a]} ${a}">${["+", "−", "~"][i]} ${c[a]}</span>`).join("")}</span>`;
}
const projectBoardSummaries = new WeakMap();
function projectBoardSummary(loadedScene) {
  const p = proj(), scene = loadedScene || (boardView.project === S.p ? boardView.scenes?.[1] || boardView.scenes?.[0] : null);
  if (!scene && projectBoardSummaries.has(p)) return projectBoardSummaries.get(p);
  const layers = scene?.layers || p.board.layers;
  const copper = layers.filter(l => /(?:[._]Cu)$/.test(l.name) && l.enabled !== false).length;
  const inventory = p.objects?.filter(o => o.kind === "footprint" && o.side === "head");
  const footprints = scene ? scene.objects.filter(o => o.kind === "footprint").length : inventory?.length;
  const summary = `${copper} copper layers · ${footprints == null ? "footprints unavailable" : `${footprints} footprints`}`;
  if (scene) projectBoardSummaries.set(p,summary);
  return summary;
}
function boardAvailable(p = proj()) { return !!(p.board.layers.length || p.board.geometry?.base || p.board.geometry?.head); }
function modelAvailable(p = proj()) { return !!(p.board.model3d?.enabled || p.board.model3d?.base || p.board.model3d?.head); }
function renderNav() {
  const p = proj();
  if (S.t === "appearance") leftTab = "appearance";
  appearanceUI?.dispose(); appearanceUI = null;
  const kids = parent => p.sheets.filter(s => s.parent === parent).sort(projectTools.sort === "name" ? (a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}) : compareSheetPages);
  const matches = (name, status) => name.toLowerCase().includes(projectTools.q.toLowerCase()) && (projectTools.filter === "all" || (projectTools.filter === "changed" ? status !== "unchanged" : status === projectTools.filter));
  const sheetItems = (parent, depth) => kids(parent).map(s => {
    const view = `sheet:${s.path}`, children = sheetItems(s.path, depth + 1);
    if (!matches(s.name, s.status) && !children) return "";
    return `<li><button data-view="${esc(view)}" data-status="${esc(s.status)}" style="--depth:${depth}" aria-current="${S.v === view}"><span class="name" title="${esc(s.name)} (page ${esc(sheetNumber(s))})">${esc(s.name)} (page ${esc(sheetNumber(s))})</span>${projectChips(counts(p, view))}</button>${children ? `<ul>${children}</ul>` : ""}</li>`;
  }).join("");
  $("#nav").innerHTML = `<div class="left-tabs" role="tablist" aria-label="Left dock">${[["project","Project"],["appearance","Appearance"]].map(([id,label]) => `<button type="button" role="tab" id="left-tab-${id}" data-left-tab="${id}" ${id === "appearance" ? 'data-tab="appearance"' : ''} aria-controls="left-body" aria-selected="${leftTab === id}" tabindex="${leftTab === id ? 0 : -1}">${label}</button>`).join("")}<button type="button" class="left-collapse" aria-label="Collapse left dock" title="Collapse left dock">‹</button></div>
    <div id="left-body" role="tabpanel" aria-labelledby="left-tab-${leftTab}">${leftTab === "appearance" ? '<div id="appearance-root"></div><div id="layers" hidden></div>' : `
    <div class="project-tools"><input type="search" id="project-search" aria-label="Search project tree" placeholder="Search project…" value="${esc(projectTools.q)}"><div><select id="project-sort" aria-label="Sort project tree"><option value="page" ${projectTools.sort === "page" ? "selected" : ""}>Page order</option><option value="name" ${projectTools.sort === "name" ? "selected" : ""}>Name A–Z</option></select><select id="project-filter" aria-label="Filter project tree">${[["all","All items"],["changed","Changed"],["added","Added"],["removed","Removed"],["modified","Modified"]].map(([v,label]) => `<option value="${v}" ${projectTools.filter === v ? "selected" : ""}>${label}</option>`).join("")}</select></div></div>
    <h3>Project</h3><label class="projsel"><span class="sr-only">Project</span><select id="proj" aria-label="Project" title="${esc(p.name)}">${D.projects.map((q,i) => `<option value="${i}" ${i === S.p ? "selected" : ""}>${esc(q.name)} (${esc(q.status)})</option>`).join("")}</select></label><div class="project-name" title="${esc(p.name)}">${esc(p.name)}</div>
    <h3>Schematic sheets</h3><ul class="tree" aria-label="Schematic hierarchy">${sheetItems(null,0) || '<li class="muted">No matching sheets</li>'}</ul>
    <h3>Board</h3><ul class="tree">${boardAvailable(p) && matches(p.name + ".kicad_pcb", p.board.status || "unchanged") ? `<li><button data-view="board" data-status="${esc(p.board.status || "unchanged")}" aria-current="${S.v === "board"}"><span class="name" title="${esc(p.name)}.kicad_pcb">${esc(p.name)}.kicad_pcb</span>${projectChips(counts(p,"board"))}</button><div class="project-meta" data-board-summary>${projectBoardSummary()}</div></li>` : '<li class="muted">No matching board</li>'}
    ${modelAvailable(p) && matches("3D model",p.board.status || "unchanged") ? `<li><button data-view="3d" aria-current="${S.v === "3d"}"><span class="name" title="${esc(p.name)} — 3D model">3D model</span></button></li>` : ""}</ul>
    <h3>Libraries</h3><ul class="tree">${p.libraries?.map((c,i) => matches(c.item + " " + c.file,c.status) ? `<li><button data-view="lib:${i}" data-status="${esc(c.status)}" aria-current="${S.v === `lib:${i}`}"><span class="name" title="${esc(c.file)}">${esc(c.kind === "symbol" ? "Symbol" : "Footprint")} ${esc(c.item)}</span></button></li>` : "").join("") || '<li class="muted">No library changes</li>'}</ul><div id="layers"></div>`}</div>
    <div class="left-splitter" role="separator" tabindex="0" aria-label="Resize left dock" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="520" aria-valuenow="${leftWidth}"></div>`;
  for (const tab of $("#nav").querySelectorAll("[data-left-tab]")) {
    tab.onclick = () => { leftTab = tab.dataset.leftTab; S.t = leftTab === "appearance" ? "appearance" : rightTab; renderNav(); renderPanel(); saveHash(); $(`#left-tab-${leftTab}`).focus(); };
    tab.onkeydown = e => { if (["ArrowLeft","ArrowRight","Home","End"].includes(e.key)) { e.preventDefault(); $(`[data-left-tab="${e.key === "Home" ? "project" : e.key === "End" ? "appearance" : leftTab === "project" ? "appearance" : "project"}"]`).click(); } };
  }
  $("#nav .left-collapse").onclick = () => { setDock("nav",false); $('[data-dock="nav"]').focus(); };
  if (leftTab === "appearance") mountAppearance();
  else {
    $("#proj").onchange = e => openProject(+e.target.value);
    $("#project-search").oninput = e => { const pos=e.target.selectionStart; projectTools.q=e.target.value; renderNav(); $("#project-search").focus(); $("#project-search").setSelectionRange(pos,pos); };
    for (const key of ["sort","filter"]) $(`#project-${key}`).onchange = e => { projectTools[key]=e.target.value; renderNav(); $(`#project-${key}`).focus(); };
    for (const b of $("#nav").querySelectorAll("[data-view]")) b.onclick = () => select(b.dataset.view);
    renderLayers();
    const summary = $("[data-board-summary]"), geometry = p.board.geometry?.head || p.board.geometry?.base;
    if (summary && geometry) loadBoardScene(geometry).then(scene => { if (scene && summary.isConnected && proj() === p) summary.textContent = projectBoardSummary(scene); }).catch(() => {});
  }
  const grip = $("#nav .left-splitter");
  const resize = width => { leftWidth=Math.max(220,Math.min(520,width)); syncLeftDock(); grip.setAttribute("aria-valuenow",leftWidth); persistLeftDock(); };
  grip.onkeydown = e => { if (["ArrowLeft","ArrowRight","Home","End"].includes(e.key)) { e.preventDefault(); resize(e.key === "Home" ? 220 : e.key === "End" ? 520 : leftWidth + (e.key === "ArrowLeft" ? -10 : 10)); } };
  grip.onpointerdown = e => { if (e.button !== 0) return; e.preventDefault(); grip.setPointerCapture(e.pointerId); const startWidth=leftWidth; grip.onpointermove = ev => resize(startWidth + ev.clientX - e.clientX); const end=()=> { grip.onpointermove=null; grip.onpointerup=null; grip.onpointercancel=null; }; grip.onpointerup=end; grip.onpointercancel=end; };
  syncLeftDock();
}
function firstChangedView(p) {
  const s = p.sheets.find(s => s.status !== "unchanged");
  return s ? `sheet:${s.path}` : boardAvailable(p) ? "board" : p.libraries?.length ? "lib:0" : p.sheets[0] ? `sheet:${p.sheets[0].path}` : "board";
}
function openProject(i) { S.p = i; S.s = null; S.io = null; S.ig = null; S.layers = null; select(firstChangedView(proj())); renderPanel(); }
function stopPlacing() { S.placing = false; document.body.classList.remove("placing"); }
function select(view) { const library = String(S.v).startsWith("lib:") || String(view).startsWith("lib:") || tabsChange(view); stopPlacing(); S.v = view; if (String(view).startsWith("lib:")) S.t = "changes"; S.x = S.y = S.z = null; renderModes(); renderNav(); if (library) renderPanel(); renderZoombar(); draw(); saveHash(); }

function decodeState(hash) {
  const q = new URLSearchParams(hash.replace(/^#/, "").replace(/^.*?#/, "")), out = {};
  if (q.has("p")) out.p = +q.get("p");
  for (const k of ["v", "m", "s", "t"]) if (q.has(k)) out[k] = q.get(k);
  for (const k of ["x", "y", "z"]) if (q.has(k)) out[k] = +q.get(k);
  if (q.has("l")) out.layers = q.get("l").split(",").filter(Boolean);
  if (q.has("c")) out.camera3d = q.get("c").split(",").map(Number);
  if (q.has("h")) out.hidden3d = q.get("h").split(",").filter(Boolean);
  return out;
}
function valid(st) {   // drop anything that does not exist in this report
  const pi = Number.isInteger(st.p) && D.projects[st.p] ? st.p : 0, out = { p: pi }, p = D.projects[pi];
  if ((st.v === "board" && boardAvailable(p)) || (st.v === '3d' && modelAvailable(p)) || p.sheets.some(s => `sheet:${s.path}` === st.v) || (/^lib:\d+$/.test(st.v) && !!p.libraries?.[+st.v.slice(4)])) out.v = st.v;
  if (Object.hasOwn(MODES, st.m ?? "")) out.m = st.m;
  for (const k of ["x", "y", "z"]) if (Number.isFinite(st[k]) && (k !== "z" || st[k] > 0)) out[k] = st[k];
  if (p.changes.some(r => r.id === st.s) || p.checks.some(c => c.violations.some(v => v.id === st.s))) out.s = st.s;
  if (st.t === "checks" || st.t === "changes" || st.t === "threads" || st.t === "parts" && p.parts || st.t === "appearance") out.t = st.t;
  if (st.layers) {   // [] = the reviewer turned every layer off; unknown names only = default layers, not an empty board
    const ls = st.layers.filter(n => p.board.layers.some(l => l.name === n));
    if (!st.layers.length || ls.length) out.layers = ls;
  }
  if (Array.isArray(st.camera3d) && st.camera3d.length === 6 && st.camera3d.every(Number.isFinite)) out.camera3d = st.camera3d;
  if (Array.isArray(st.hidden3d)) out.hidden3d = st.hidden3d.filter(x => GROUPS3D.some(([id]) => id === x));
  return out;
}
function applyState(st) {
  const v = valid(st);
  if (v.t === "appearance") { leftTab = "appearance"; leftCollapsed = false; $("#nav").classList.add("dock-open"); }
  Object.assign(S, { p: v.p, v: v.v ?? firstChangedView(D.projects[v.p]), m: v.m ?? S.m, s: v.s ?? null, io: null, ig: null, t: v.t ?? S.t,
                     layers: v.layers ?? null, hidden3d: v.hidden3d ?? [], camera3d: v.camera3d ?? null, x: v.x ?? null, y: v.y ?? null, z: v.z ?? null });
  if (S.layers && S.v === "board") Appearance.patch({layers: Object.fromEntries(proj().board.layers.map(l => [canon(l.name), {visible: S.layers.includes(l.name)}]))});   // the link's l= wins over stored eyes
  if (S.x == null || S.y == null || S.z == null) S.x = S.y = S.z = null;
  const hasPos = S.z != null;
  renderModes();
  renderNav();
  renderPanel();
  renderZoombar();
  return draw().then(() => S.s && !hasPos && !v.v && goTo(S.s));
}

const PX = 4;                       // CSS px per mm at z = PX
const cache = {};
// Cache the decode promise so concurrent draws of the same blob share one gzip stream.
function svgText(id) {
  if (!id) return Promise.resolve(null);
  if (!(id in cache)) {
    const bin = Uint8Array.from(atob(D.blobs[id]), c => c.charCodeAt(0));
    cache[id] = new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    cache[id].catch(() => delete cache[id]);
  }
  return cache[id];
}
let boardDiff = null;
const boardView = {scenes: null, renderers: [], panes: [], generation: 0, failed: null, note: null, useGL: false};
const appearanceBoards = new Set(), appearanceSchematics = new Set();
const appearanceStore = () => Appearance;
function applyAppearance(snapshot) {
  const resolved = KrAppearance.resolve(snapshot);
  for (const board of appearanceBoards) board.setAppearance(glAppearance(resolved));
  for (const root of appearanceSchematics) setSchematicAppearance(root, resolved);
  for (const vp of document.querySelectorAll('#stage .vp.board')) vp.style.background = cssAppearance(resolved.boardBackground);
  for (const vp of document.querySelectorAll('#stage .vp.sheet')) vp.style.background = cssAppearance(resolved.schematicBackground);
  for (const vp of document.querySelectorAll('#stage .vp')) {
    const sheet=vp.classList.contains('sheet');
    const palette=sheet?resolved.marks.schematic:KrAppearance.markPalette(S.m==='overlay'?[1,1,1,1]:resolved.boardBackground);
    vp.style.setProperty('--sch-background',cssAppearance(resolved.schematicBackground));
    for(const [action,mark] of Object.entries(palette)) {
      vp.style.setProperty('--mark-'+action,cssAppearance(mark.color));
      vp.style.setProperty('--halo-'+action,cssAppearance(mark.halo));
    }
  }
}
const boardAppearance = () => Appearance.get();
// A layer eye keeps the l= hash list in step, so links and the Appearance dock agree.
function changeBoardAppearance(patch) {
  for (const [name, l] of Object.entries(patch.layers || {})) if (l?.visible === true || l?.visible === false) {
    const svg = proj().board.layers.find(x => canon(x.name) === name)?.name;
    if (svg) { const on = new Set(layersOn()); l.visible ? on.add(svg) : on.delete(svg); S.layers = [...on]; }
  }
  const state = Appearance.patch(patch);
  saveHash();
  return state;
}
const tabsChange = view => S.t === "appearance" || (S.v === "board") !== (view === "board");
// SVG layer file names (F_Silkscreen) -> KiCad technical names (F.SilkS), and back for display.
const USER_LAYERS = {"User.Drawings": "Dwgs.User", "User.Comments": "Cmts.User", "User.Eco1": "Eco1.User", "User.Eco2": "Eco2.User"};
const SUFFIX_LAYERS = {Silkscreen: "SilkS", Courtyard: "CrtYd", Adhesive: "Adhes"};
const canon = name => { const n = name.replace("_", ".").replace(/\.(Silkscreen|Courtyard|Adhesive)$/, (_, x) => "." + SUFFIX_LAYERS[x]); return USER_LAYERS[n] || n; };
const layerLabel = name => { const u = Object.entries(USER_LAYERS).find(([, v]) => v === name); return u ? u[0] : name.replace(/\.(SilkS|CrtYd|Adhes)$/, (_, x) => "." + Object.entries(SUFFIX_LAYERS).find(([, v]) => v === x)[0]); };
const flipOn = () => S.v === "board" && !!Appearance.get().flip;
function boardCamera(vp) {
  return {x: S.x, y: S.y, z: S.z, width: vp.clientWidth, height: vp.clientHeight, dpr: devicePixelRatio || 1, flip: flipOn()};
}
function disposeBoardRenderers() {
  boardDiff?.dispose(); boardDiff = null;
  for (const r of new Set([...boardView.renderers, ...boardView.panes.filter(Boolean).map(p => p.renderer)])) r.dispose();
  boardView.renderers = []; boardView.panes = [];
}
// Appearance plus the report's own layer eyes (the l= hash): a layer shows only when both allow it.
function glAppearance(snapshot = KrAppearance.resolve(Appearance.get())) {
  const a = structuredClone(snapshot);
  a.objects.text = a.objects.footprintText;   // the scene's one text category follows Footprint Text
  for (const [name, l] of Object.entries(a.layers)) l.visible = l.visible && (S.layers ? S.layers.map(canon).includes(name) : !HIDE_LAYERS.test(name));
  return a;
}
function boardFallback(note) {   // one route to SVG per project; a later project navigation may try WebGL again
  if (boardView.failed === S.p) return;
  boardView.failed = S.p; boardView.note = note;
  disposeBoardRenderers();
  if (S.v === "board") draw();
}
// Appearance dock: Layers / Objects / Nets in the left Appearance tab.
let appearanceUI = null;
const UNAVAILABLE = Object.fromEntries(["images", "ratsnest", "drcMarkers", "drawingSheet", "values", "references"].map(k => [k, "Not present in this report"]));
function appearanceCtx() {
  const scenes = (boardView.scenes || []).filter(Boolean), sides = (boardView.scenes || []).map(sc => new Set((sc?.layers || []).filter(l => l.enabled).map(l => l.name)));
  const present = new Set([...scenes.flatMap(sc => sc.layers.filter(l => l.enabled).map(l => l.name)), ...proj().board.layers.map(l => canon(l.name))]);
  const family = n => /\.Cu$/.test(n) ? 0 : /\.(CrtYd|Fab)$/.test(n) ? 2 : /^(User\.|Dwgs\.|Cmts\.|Eco)/.test(n) ? 3 : 1;
  const layers = Object.keys(Appearance.get().layers).filter(n => present.has(n)).sort((a,b) => family(a) - family(b)).map(name => ({ name, label: layerLabel(name), changed: !!proj().board.layers.find(x => canon(x.name) === name)?.changed,
    title: sides.length === 2 && sides[0].has(name) !== sides[1].has(name) ? `${layerLabel(name)} (${sides[0].has(name) ? "base" : "head"} only)` : layerLabel(name) }));
  const shown = name => { const svg = proj().board.layers.find(x => canon(x.name) === name)?.name; return S.layers ? !svg || S.layers.includes(svg) : !svg || !HIDE_LAYERS.test(svg); };
  const fallback = !boardView.useGL;
  return { layers, fallback, nets: fallback ? [] : [...new Set(scenes.flatMap(sc => sc.nets.map(n => n.name)).filter(Boolean))].sort(),
    visible: name => Appearance.get().layers[name]?.visible !== false && shown(name),
    note: S.m !== "side" ? "Colour, alpha and visibility apply here. Other controls apply in Side mode." : boardView.note || "WebGL unavailable. Colour, alpha and visibility apply." };
}
function mountAppearance() {
  const root = $("#appearance-root"); if (!root) return;
  appearanceUI = Appearance.mount(root, { ...appearanceCtx(), getState: Appearance.get, onChange: changeBoardAppearance, unavailable: UNAVAILABLE });
}
function refreshAppearance() { const summary = $("[data-board-summary]"); if (summary) summary.textContent = projectBoardSummary(); if (appearanceUI && leftTab === "appearance" && $("#appearance-root")?.isConnected) appearanceUI.update(appearanceCtx()); }
function syncMarkStyles() {
  const sheet = currentView()?.kind === "sheet";
  const available = sheet || S.v === "board" && !!boardDiff && boardView.useGL;
  for (const b of document.querySelectorAll('button[data-mark-style]')) {
    const selected = b.dataset.markStyle === Appearance.get().markStyle;
    b.disabled = !available;
    b.setAttribute('aria-checked', String(selected));
    b.tabIndex = selected ? 0 : -1;
    b.title = sheet ? 'Schematic recolour uses changed regions; exported paths have no object IDs'
      : available ? 'Change geometry mark style' : 'Geometry mark styles require WebGL board data';
  }
  const msg = $('#statusbar .status-message');
  if (msg && S.v === 'board') msg.textContent = available ? 'Ready' : [boardView.note, 'Geometry mark styles require WebGL board data'].filter(Boolean).join(' — ');
}
for (const b of document.querySelectorAll('button[data-mark-style]')) {
  b.onclick = () => Appearance.patch({markStyle:b.dataset.markStyle});
  b.onkeydown = e => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 'outline' : e.key === 'End' ? 'recolour' : b.dataset.markStyle === 'outline' ? 'recolour' : 'outline';
    Appearance.patch({markStyle:next});
    document.querySelector(`[data-mark-style="${next}"]`).focus();
  };
}
Appearance.subscribe(snapshot => {
  syncMarkStyles();
  applyAppearance(snapshot);
  refreshAppearance();
  updateStatus();
  if (currentView()?.kind === "sheet") {
    for (const m of document.querySelectorAll("#stage .vp.sheet .marker")) m.remove();
    afterDraw(currentView());
  }
  if (S.v === "board") {
    if (boardView.renderers.length) apply();
    else {
      // Redraw from cached original SVG, never recolour a recolour.
      const cursor = boardCursor;
      draw().then(() => { const vp = $("#stage .vp"); if (cursor && vp) updateCoordinates(vp,cursor); });
    }
  }
});
const boardSceneCache = new Map(), decodedBoardScenes = new Map();
// Scene blobs reuse svgText's gzip decode; the text is JSON, never given to the SVG loader.
async function loadBoardScene(key) {
  if (!key) return null;
  if (!boardSceneCache.has(key)) boardSceneCache.set(key, (async () => {
    const scene = JSON.parse(await svgText(key));
    BoardGL.validateScene(scene);
    decodedBoardScenes.set(key,scene);
    return scene;
  })().catch(error => { boardSceneCache.delete(key); throw error; }));
  return boardSceneCache.get(key);
}
const HIDE_LAYERS = /Fab|Courtyard|CrtYd|Paste|Adhes|Mask|Margin|User|Drawings|Dwgs|Comments|Cmts|Eco/i;
function layersOn() {
  const p = proj();
  return S.layers || p.board.layers.filter(l => !HIDE_LAYERS.test(l.name)).map(l => l.name);
}
function currentView(v = S.v) {   // Availability is independent of change status.
  const p = proj();
  if (v === "board") {
    if (!boardAvailable(p)) return null;
    const on = new Set(layersOn());
    return { kind: "board", size: p.board.size, layers: p.board.layers.filter(l => on.has(l.name)) };
  }
  if (String(v).startsWith("lib:")) {
    const c = p.libraries?.[+v.slice(4)];
    return c && (c.svg.base || c.svg.head) ? { kind: "lib", size: c.size, layers: [{ name: "item", changed: true, svg: c.svg }] } : null;
  }
  const pg = p.sheets.find(s => `sheet:${s.path}` === v);
  return pg && pg.svg ? { kind: "sheet", size: pg.size, layers: [{ name: "sheet", changed: true, svg: pg.svg }] } : null;
}
// KiCad 10, builtin_color_themes.h:31–81; data provenance in NOTICE.
const SCH_PAINTS = new Set([
  '000000','000084','ffffc2','840000','840084','b5b5b5','c2c2c2',
  '009600','725600','0f0f0f','484848','ff0000','0000c2','4848ff',
  '006464','a90000','840032','e0000c'
]);
function schematicPaint(value) {
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) && SCH_PAINTS.has(hex.slice(1))
    ? `var(--sch-ink-${hex.slice(1)}, ${hex})` : value;
}
const cssAppearance = rgba => `rgba(${rgba.slice(0,3).map(v=>Math.round(v*255)).join(',')},${rgba[3]})`;
// Exported paths sharing a source RGB cannot be distinguished semantically.
// Deterministic Stage 6 mapping: outline includes pins/worksheet; bus includes no-connect;
// pin names include references/value; junction shares wire. Never classify rendered paint.
const SCH_THEME_KEYS = {
  '000000':'schematic.background','000084':'schematic.bus',
  'ffffc2':'schematic.component_body','840000':'schematic.component_outline',
  '840084':'schematic.fields','b5b5b5':'schematic.grid','c2c2c2':'schematic.hidden',
  '009600':'schematic.wire','725600':'schematic.label_hier','0f0f0f':'schematic.label_local',
  '484848':'schematic.netclass_flag','ff0000':'schematic.rule_area','0000c2':'schematic.note',
  '4848ff':'schematic.private_note','006464':'schematic.pin_name','a90000':'schematic.pin_number',
  '840032':'schematic.op_voltages','e0000c':'schematic.op_currents'
};
function setSchematicAppearance(svg, appearance) {
  for (const [hex,key] of Object.entries(SCH_THEME_KEYS))
    svg.style.setProperty('--sch-ink-'+hex, cssAppearance(appearance.colors[key]));
  svg.style.setProperty('--sch-background', cssAppearance(appearance.schematicBackground));
}
function themeSchematic(svg) {
  for (const el of [svg, ...svg.querySelectorAll('[style],[fill],[stroke]')]) {
    if (el.hasAttribute('style')) {
      el.setAttribute('style', el.getAttribute('style').replace(
        /(^|;)\s*(fill|stroke)\s*:\s*(#[0-9a-f]{6})(\s*(?:!important)?\s*)(?=;|$)/gi,
        (all, separator, property, value, suffix) =>
          `${separator}${property}:${schematicPaint(value)}${suffix}`));
    }
    for (const property of ['fill', 'stroke']) {
      if (el.hasAttribute(property)) {
        el.setAttribute(property, schematicPaint(el.getAttribute(property)));
      }
    }
  }
}

// kicad-cli strokes each glyph segment as its own <path d> (~25k on a dense sheet), and Chrome repaints
// them all when a zoom settles. Join runs of sibling attribute-less paths under an unfilled group into one
// path: same inherited style, near-identical pixels (overlapping strokes no longer double their edge), ~10x fewer elements. Nothing addresses these paths individually.
function simplifySchematic(svg) {
  const walk = (g, unfilled) => {
    const m = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(g.getAttribute('style') || '') || (g.hasAttribute('fill') && [, g.getAttribute('fill')]);
    if (m) unfilled = m[1].trim() === 'none';
    let run = null, d = [];
    const flush = () => { if (run && d.length > 1) run.setAttribute('d', d.join(' ')); run = null; d = []; };
    for (const el of [...g.children]) {
      if (unfilled && el.localName === 'path' && el.attributes.length === 1 && /^\s*M/.test(el.getAttribute('d') || '')) {   // absolute start: joining cannot shift it
        d.push(el.getAttribute('d')); if (run) el.remove(); else run = el;
      } else if (el.localName === 'desc') continue;
      else { flush(); if (el.localName === 'g') walk(el, unfilled); }
    }
    flush();
  };
  walk(svg, false);
}
const simpleSheets = new Map();   // raw sheet SVG text -> simplified markup; only sheets actually shown get here
function simpleSheet(t) {
  if (!simpleSheets.has(t)) { const d = document.createElement('div'); d.innerHTML = t.slice(t.indexOf('<svg')); simplifySchematic(d.firstElementChild); simpleSheets.set(t, d.innerHTML); }
  return simpleSheets.get(t);
}

// SVG fallback: replace only the original layer RGB; retain custom object/diff paint and none;
// existing inline opacity stays, the colour's alpha and the layer opacity become the layer's own opacity.
function recolorLayer(div, look, original) {
  const [r, g, b, a] = look.color, hex = "#" + [r, g, b].map(n => n.toString(16).padStart(2, "0")).join("");
  const same = original && look.color.every((v, i) => v === original[i]);
  if (!same) {
    const source = original && "#" + original.slice(0, 3).map(n => n.toString(16).padStart(2, "0")).join("");
    const paint = v => {
      let rgb = v.trim().toLowerCase().replace(/\s/g, "");
      if (/^#[0-9a-f]{3}$/.test(rgb)) rgb = "#" + [...rgb.slice(1)].map(c => c + c).join("");
      return rgb === source || original && rgb === `rgb(${original.slice(0, 3).join(",")})` ? hex : v;
    };
    for (const el of [div.querySelector("svg"), ...div.querySelectorAll("[style],[fill],[stroke]")]) {
      for (const prop of ["fill", "stroke"]) if (el.hasAttribute(prop)) el.setAttribute(prop, paint(el.getAttribute(prop)));
      if (el.hasAttribute("style")) el.setAttribute("style", el.getAttribute("style").replace(/(^|;)\s*(fill|stroke)\s*:\s*([^;]+)/gi, (all, sep, prop, value) => `${sep}${prop}:${paint(value)}`));
    }
  }
  if (a * look.opacity !== 1) div.style.opacity = a * look.opacity;
}
async function stack(side, view) {
  const st = document.createElement("div");
  st.className = `stack ${side}`;
  st.style.width = `${view.size[0] * PX}px`; st.style.height = `${view.size[1] * PX}px`;
  const look = view.kind === "board" ? Appearance.get().layers : {};
  for (const l of view.layers) {
    const t = await svgText(l.svg[side]);
    if (!t || look[canon(l.name)]?.visible === false) continue;
    const d = document.createElement("div");
    d.className = "layer"; d.dataset.layer = l.name;
    d.innerHTML = view.kind === 'sheet' ? simpleSheet(t) : t.slice(t.indexOf("<svg"));
    if (view.kind === 'sheet') {
      const svg = d.querySelector('svg'); themeSchematic(svg); svg.dataset.appearanceSchematic = '';
      setSchematicAppearance(svg, KrAppearance.resolve(Appearance.get()));
    }
    if (look[canon(l.name)]) recolorLayer(d, look[canon(l.name)], KicadColors.layers[canon(l.name)]);
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
  const world = vp.querySelector(".world");
  if (kind === "sheet") {
    const canvas = document.createElement("canvas");
    canvas.className = "sch-grid"; canvas.setAttribute("aria-hidden", "true");
    vp.prepend(canvas);
  }
  return world;
}
let gen = 0;
async function draw() {
  // Bind before any lazy mount; the facade remains window.Appearance for every project.
  Appearance.configure([], JSON.stringify([D.repo || location.pathname, proj().dir]));
  schematicResize.disconnect();
  resetCoordinates();
  const my = ++gen, view = currentView(), stage = document.createElement("main");
  stage.id = "stage"; stage.className = `mode-${S.m}`;
  if (S.v === '3d') {
    disposeBoardRenderers();
    appearanceSchematics.clear();
    $("#stage").replaceWith(stage); // WebGL needs connected canvas dimensions.
    await window.Review3D.show(stage, proj(), S);
    return;
  }
  window.Review3D?.dispose();
  let scenes = null;
  const geo = S.v === "board" && view && proj().board.geometry;
  if (boardView.failed !== null && boardView.failed !== S.p) boardView.failed = boardView.note = null;
  if (boardView.failed !== S.p) boardView.note = null;
  if (geo) try { scenes = [await loadBoardScene(geo.base), await loadBoardScene(geo.head)]; }
    catch (error) { if (my === gen) { console.warn("Board scene unavailable; showing SVG:", error); boardView.note = "Geometry unsupported — showing SVG"; } }
  if (my !== gen) return;   // a newer draw owns the stage
  boardView.scenes = scenes; boardView.generation = my;
  if (boardView.project !== S.p) {
    boardView.project = S.p;
    Appearance.configure([...new Set([...(scenes || []).filter(Boolean).flatMap(sc => sc.layers.filter(l => l.enabled).map(l => l.name)), ...(proj().board?.layers || []).map(l => canon(l.name))])], JSON.stringify([D.repo || location.pathname, proj().dir]));
  }
  if (scenes && scenes.some(sc => sc && !sc.complete)) { boardView.note = "Geometry unsupported — showing SVG"; boardView.useGL = false; }
  else boardView.useGL = !!scenes && boardView.failed !== S.p;
  if (boardView.useGL) {
    appearanceSchematics.clear();
    if (boardDiff && boardDiff.project === S.p && boardDiff.mode === S.m && boardDiff.scenes.base === scenes[0] && boardDiff.scenes.head === scenes[1]) { noChangeNotice($("#stage")); if (!placed()) fit(); else apply(); afterDraw(view); return; }
    disposeBoardRenderers();
    $("#stage").replaceWith(stage);
    try {
      const project = S.p;
      let mounted;
      mounted = BoardDiff.mount({stage,scenes:{base:scenes[0],head:scenes[1]},changes:proj().changes,state:S,appearance:glAppearance,onLost:()=>{
        if (boardDiff === mounted && S.p === project) boardFallback("WebGL unavailable — showing SVG");
      },attachPanZoom});
      boardDiff = mounted;
      boardDiff.project = project; boardDiff.mode = S.m; boardDiff.scenes = {base:scenes[0],head:scenes[1]};
      boardView.panes = boardDiff.panes; boardView.renderers = boardDiff.panes.map(p=>p.renderer);
      for (const {renderer, canvas} of boardDiff.panes) trackAppearanceBoard(renderer, canvas);
      if (S.m === "wipe") addDivider(stage.querySelector(".vp"));
      boardDiagnostics(stage);
      noChangeNotice(stage);
      if (!placed()) fit(); else apply();
      afterDraw(view);
      return;
    } catch (error) {
      disposeBoardRenderers(); boardView.failed = S.p; boardView.useGL = false;
      boardView.note = "WebGL unavailable — showing SVG"; stage.replaceChildren();
    }
  }
  if (!boardView.useGL) disposeBoardRenderers();
  if (!view) stage.innerHTML = `<p class="empty">This drawing is unavailable in both revisions.</p>`;
  else await MODES[S.m](stage, view);
  if (S.v === "board" && !boardView.useGL) boardDiagnostics(stage);
  noChangeNotice(stage);
  if (my !== gen) return;
  $("#stage").replaceWith(stage);
  appearanceSchematics.clear();
  for (const svg of stage.querySelectorAll('svg[data-appearance-schematic]')) appearanceSchematics.add(svg);
  applyAppearance(Appearance.get());
  const msg = $("#statusbar .status-message");
  if (msg) msg.textContent = S.v === "board" && boardView.note ? boardView.note : "Ready";
  if (view && !placed()) fit(); else apply(); afterDraw(view);
  for (const vp of document.querySelectorAll("#stage .vp.sheet")) schematicResize.observe(vp);
  refreshAppearance();
}
function noChangeNotice(stage) {
  const text = S.v === "board" ? (!proj().board.changed && "No layout changes") :
    proj().sheets.find(s => `sheet:${s.path}` === S.v)?.status === "unchanged" && "No schematic changes on this sheet";
  if (!text || stage.querySelector('.no-change-notice')) return;
  const notice = document.createElement("p"); notice.className = "no-change-notice"; notice.textContent = text;
  notice.style.cssText = "position:absolute;bottom:8px;left:50%;transform:translateX(-50%);z-index:5;background:var(--surface);color:var(--text);padding:6px 12px;border:1px solid var(--line);pointer-events:none";
  stage.appendChild(notice);
}
function boardDiagnostics(stage) {   // text only: warning objects are never parsed as HTML
  const warnings = (boardView.scenes || []).flatMap((sc, i) => sc ? sc.warnings.map(w => `${i ? "Head" : "Base"}: ${w?.kind ? [w.kind, w.uuid, w.reason].join(" ") : String(w)}`) : []);
  if (!warnings.length) return;
  const d = document.createElement("details"), sum = document.createElement("summary"), pre = document.createElement("pre");
  d.className = "board-diag"; sum.textContent = `Geometry warnings (${warnings.length})`; pre.textContent = warnings.join("\n");
  d.append(sum, pre); stage.appendChild(d);
}
function trackAppearanceBoard(renderer, canvas) {
  appearanceBoards.add(renderer);
  const project = S.p;
  // Stage 4 disposes a lost renderer and shows SVG. Restore by mounting fresh
  // geometry through the existing path, which reads the latest store snapshot.
  canvas.addEventListener('webglcontextrestored', () => {
    if (S.p === project && S.v === 'board' && boardView.failed === project) {
      boardView.failed = null; draw();
    }
  }, {once:true});
  const dispose = renderer.dispose;
  renderer.dispose = () => { appearanceBoards.delete(renderer); dispose(); };
}
function glPane(stage, view, i) {
  const scene = boardView.scenes[i], side = i ? "head" : "base";
  const vp = viewport(stage, i ? "Head" : "Base", view.kind).parentElement;
  vp.dataset.side = side;
  if (!scene) { boardView.panes[i]?.renderer.dispose(); boardView.panes[i] = null; vp.querySelector(".tag").textContent += " — not present"; return true; }
  let pane = boardView.panes[i];
  if (!(pane && pane.scene === scene && !pane.renderer.stats.disposed)) {
    pane?.renderer.dispose();
    const canvas = document.createElement("canvas");
    canvas.className = "board-gl"; canvas.setAttribute("aria-label", `${side} board`);
    const renderer = BoardGL.create(canvas, {scene, revision: side, onFailure: () => boardFallback("WebGL unavailable — showing SVG")});
    if (!renderer) return false;
    trackAppearanceBoard(renderer, canvas);
    pane = boardView.panes[i] = {canvas, renderer, scene};
  }
  vp.insertBefore(pane.canvas, vp.firstChild);
  pane.renderer.setAppearance(glAppearance());
  return true;
}
async function drawSideGL(stage, view) {
  const ok = [0, 1].every(i => glPane(stage, view, i));
  if (!ok) {
    boardView.failed = S.p; boardView.note = "WebGL unavailable — showing SVG";
    disposeBoardRenderers(); stage.replaceChildren(); boardView.useGL = false;
    return false;
  }
  boardView.renderers = boardView.panes.filter(Boolean).map(p => p.renderer);
  boardDiagnostics(stage);
  return true;
}
async function drawSide(stage, view) {
  if (boardView.useGL && await drawSideGL(stage, view)) return;
  viewport(stage, "Base", view.kind).appendChild(await stack("base", view));
  viewport(stage, "Head", view.kind).appendChild(await stack("head", view));
}
var MODES = { side: drawSide };

// Transform: S.x, S.y = the drawing point (mm) at the viewport centre; S.z = CSS px per mm.
const placed = () => S.z > 0 && Number.isFinite(S.x) && Number.isFinite(S.y);   // else unset: draw() fits
function apply() {
  const vp = document.querySelector("#stage .vp");
  if (!vp || !placed()) return;
  const W = vp.clientWidth, H = vp.clientHeight, k = S.z / PX, f = flipOn() ? -1 : 1;
  for (const w of document.querySelectorAll("#stage .world")) {
    const width = w.parentElement.classList.contains("sheet") ? w.parentElement.clientWidth : W;
    const height = w.parentElement.classList.contains("sheet") ? w.parentElement.clientHeight : H;
    w.style.transform = `translate(${width / 2 - f * S.x * S.z}px, ${height / 2 - S.y * S.z}px) scale(${f * k}, ${k})`;
    w.parentElement.classList.toggle("flip", f < 0);
    if (!gesturing) w.style.setProperty("--k", k);   // a custom-property write restyles every SVG descendant: only when still
  }
  onApply();
  if (boardDiff) { boardDiff.render(); drawPins(); }
  else for (const pane of boardView.panes) if (pane?.canvas.isConnected) { pane.renderer.setCamera(boardCamera(pane.canvas.parentElement)); pane.renderer.draw(); }
  setText($("#zoombar .pct"), Math.round(S.z / PX * 100) + "%");
  if (!gesturing) drawSchematicGrids();
  updateSchematicStatus();
}
// KiCad 10: eeschema/eeschema_settings.cpp:705-706 defaults to 50 mil (index 1);
// common/settings/app_settings.cpp:603-609 defines that lattice: 50 mil = 1.27 mm.
const SCHEMATIC_GRID_MM = 1.27;
let schematicCursor = null;
function schematicPoint(vp, event) {
  const r = vp.getBoundingClientRect();
  return {x:S.x+(event.clientX-r.left-r.width/2)/S.z,
    y:S.y+(event.clientY-r.top-r.height/2)/S.z};
}
function schematicGridPlan(width, height) {
  const physical = SCHEMATIC_GRID_MM*S.z;
  let stride = Math.max(1, Math.ceil(4/physical));
  // Omit dots only on the physical lattice; bound work even on very large displays.
  while (Math.ceil(width/(physical*stride))*Math.ceil(height/(physical*stride)) > 140000) stride++;
  const step = physical*stride, mod = v => ((v%step)+step)%step;
  return {step, x:mod(width/2-S.x*S.z), y:mod(height/2-S.y*S.z)};
}
// Dots are painted once per (size, dpr, step) into a canvas the size of the viewport; a pan only
// moves that canvas by the lattice phase (an integer-px transform), so it costs no repaint.
function drawSchematicGrids() {
  if (!placed()) return;
  for (const canvas of document.querySelectorAll("#stage .sch-grid")) {
    const vp = canvas.parentElement, w = vp.clientWidth, h = vp.clientHeight, dpr = devicePixelRatio || 1;
    if (S.grid === false || !w || !h) { if (canvas.dataset.key) { canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height); canvas.dataset.key = ""; } continue; }
    const {step,x,y} = schematicGridPlan(w,h), key = [w,h,dpr,step].join();
    if (canvas.dataset.key !== key) {
      canvas.dataset.key = key; canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.fillStyle = getComputedStyle(vp).getPropertyValue("--sch-ink-b5b5b5").trim() || "#b5b5b5";
      ctx.beginPath();
      for (let px=0; px<w; px+=step) for (let py=0; py<h; py+=step) ctx.rect(Math.round(px),Math.round(py),1,1);
      ctx.fill();
    }
    canvas.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }
}
function updateSchematicStatus() { updateStatus(); }
const schematicResize = new ResizeObserver(() => apply());
window.addEventListener("kr-theme-change", () => { for (const c of document.querySelectorAll("#stage .sch-grid")) c.dataset.key = ""; drawSchematicGrids(); });
let settle, gesturing = false;
function gesture() {           // composite as a bitmap while moving, re-rasterise sharp when still
  for (const w of document.querySelectorAll("#stage .world")) w.style.willChange = "transform";
  gesturing = true; clearTimeout(settle);
  settle = setTimeout(() => { gesturing = false; for (const w of document.querySelectorAll("#stage .world")) w.style.willChange = "auto"; apply(); }, 150);
}
let autoFit = false;   // see fit()
let frameApply = 0;
function setT(t, {frame = false} = {}) {
  autoFit = false; if (S.v === "board" && Number.isFinite(t.z)) t.z = clampBoardZoom(t.z); Object.assign(S, t); saveHash();
  if (!frame) { cancelAnimationFrame(frameApply); frameApply = 0; apply(); updateStatus(); return; }
  if (!frameApply) frameApply = requestAnimationFrame(() => { frameApply = 0; apply(); updateStatus(); });   // a trackpad fires several wheel events per frame
}
// KiCad source 3e051f88: common/view/view.cpp:241 (50000 maximum; .1 minimum is
// the review px/mm contract, not KiCad's .2 internal scale). common/tool/common_tools.cpp:256-260 (1.3 step).
const clampBoardZoom = z => Math.max(.1, Math.min(50000, z));
// common/settings/app_settings.cpp:649-671. Review adds metric 2 and .02 per the navigation spec.
const BOARD_GRID_MM = [5,2.5,2,1,.5,.25,.2,.1,.05,.025,.02,.01];
const BOARD_GRID_MIL = [1000,500,250,200,100,50,25,20,10,5,2,1].map(n => n*.0254);
// Deliberately configurable for measured device calibration (Task 10), not a platform sniff.
const BOARD_WHEEL_PIXEL_RATE = .0015, BOARD_WHEEL_MAC_ROTATION_RATE = .01;
let boardCursor = null, deltaAnchor = null, anchorKey = "", lastPosition = null, lastPositionKey = "";
// bench-t7: pointer updates must not churn unchanged readout text.
function statusText(selector, value) { const node = $("#statusbar " + selector); if (node && node.textContent !== String(value)) node.textContent = value; }
function resetCoordinates() {
  boardCursor = null; schematicCursor = null;
  updateStatus();
}
const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };   // an unchanged HUD value must not dirty layout
function updateStatus() {
  const sheet = String(S.v).startsWith("sheet:");
  const a = Appearance.get(), units = S.v === "board" ? a.units : sheet ? S.units : "mm", divisor = units === "mil" ? .0254 : units === "in" ? 25.4 : 1;
  const fmt = n => Number.isFinite(n) ? (Math.abs(n/divisor) < .0005 ? 0 : n/divisor).toFixed(3) : "off canvas";
  const key = JSON.stringify([S.p,S.v]);
  if (anchorKey !== key) { anchorKey = key; deltaAnchor = null; }
  const current = sheet ? schematicCursor && [schematicCursor.x,schematicCursor.y] : boardCursor?.world;
  if (current) { lastPosition = current; lastPositionKey = key; }
  const p = current || (lastPositionKey === key ? lastPosition : null);
  const dx = p && deltaAnchor ? p[0]-deltaAnchor[0] : 0, dy = p && deltaAnchor ? p[1]-deltaAnchor[1] : 0;
  for (const [name,value] of Object.entries({x:p?.[0],y:p?.[1],dx,dy,dist:Math.hypot(dx,dy)})) statusText(`[data-coordinate=${name}]`,fmt(value));
  const coords = $("#statusbar .status-coordinates");
  coords?.classList.toggle("off-canvas",!current); coords?.toggleAttribute("data-sch-coordinates",sheet);
  const rows = [...document.querySelectorAll("#panel .card[data-id]")], at = rows.findIndex(e => e.dataset.id === S.s);
  statusText("[data-change]",`${at < 0 ? 0 : at+1}/${rows.length}`);
  statusText("[data-zoom]",placed() ? `${(S.z / PX * 100).toFixed(0)}%` : "off canvas");
  statusText("[data-units]",units);
  if ($("#status-units").value !== units) $("#status-units").value = units;
  const grid = $("#statusbar [data-grid]"); grid.parentElement.toggleAttribute("data-sch-grid",sheet);
  statusText("[data-grid]",S.v === "board" ? `${fmt(a.grid.size)}${a.grid.visible ? "" : " off"}` : sheet && S.grid !== false ? fmt(SCHEMATIC_GRID_MM) : "off");
  statusText("[data-active-layer]",S.v === "board" ? a.activeLayer || "no layer" : sheet ? "Schematic" : "no layer");
  const color = a.layers[a.activeLayer]?.color;
  const swatch = $("[data-layer-swatch]"), swatchColor = S.v === "board" && color ? `rgb(${color.slice(0,3).join(",")})` : "transparent";
  if (swatch.dataset.color !== swatchColor) { swatch.style.background = swatchColor; swatch.dataset.color = swatchColor; }
  const selected = proj()?.changes.find(c=>c.id===S.s) || allViolations().find(c=>c.id===S.s);
  statusText("[data-selection]",selected ? selected.ref || selected.reference || selected.kind || selected.id : "Nothing selected");
  statusText("[data-view-mode]",({side:"Side",overlay:"Overlay",wipe:"Wipe",blend:"Blend",semantic:"Delta"})[S.m] || S.m);

}
function updateCoordinates(vp, event) {
  if (!placed() || !vp.isConnected || S.v === "3d" || !vp.clientWidth || !vp.clientHeight) { resetCoordinates(); return; }
  boardCursor = {vp, clientX:event.clientX, clientY:event.clientY, world:toWorld(vp,event)};
  if (String(S.v).startsWith("sheet:")) schematicCursor = schematicPoint(vp,event);
  const r = vp.getBoundingClientRect(), board = S.v === "board";
  for (const pane of document.querySelectorAll("#stage .vp")) {
    pane.classList.toggle("board-cursor", board);
    if (!board) continue;
    // One small element moved by transform: a CSS variable on the pane would restyle every descendant.
    const cross = pane.querySelector(":scope > .board-cross") || pane.appendChild(Object.assign(document.createElement("div"), {className:"board-cross"}));
    cross.style.transform = `translate(${event.clientX-r.left-9}px,${event.clientY-r.top-9}px)`;
  }
  updateStatus();
}
function toWorld(vp, e) {   // the one inverse camera adapter: pointer -> drawing mm (flip-aware)
  const r = vp.getBoundingClientRect();
  return BoardGL.screenToWorld([e.clientX - r.left, e.clientY - r.top], {x: S.x, y: S.y, z: S.z, width: r.width, height: r.height, flip: flipOn()});
}
function zoomBoardAt(vp, clientX, clientY, factor, opts) {
  const r = vp.getBoundingClientRect(); if (!r.width || !r.height || !placed()) return;
  const e = {clientX,clientY}, before = toWorld(vp,e), z = clampBoardZoom(S.z*factor), f = z/S.z;
  setT({z, x:before[0]-(before[0]-S.x)/f, y:before[1]-(before[1]-S.y)/f}, opts);
  updateCoordinates(vp,e);
}
function attachPanZoom(vp) {
  vp.tabIndex = 0;
  vp.setAttribute("aria-label", "Drawing canvas; Shift+F10 for actions");
  vp.addEventListener("wheel", e => {
    const r = vp.getBoundingClientRect(); if (!placed() || !r.width || !r.height) return;
    e.preventDefault(); gesture();
    const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1);
    const rate = window.KRBoardWheelProfile === "mac-rotation" ? BOARD_WHEEL_MAC_ROTATION_RATE/100 : BOARD_WHEEL_PIXEL_RATE;
    zoomBoardAt(vp,e.clientX,e.clientY,Math.exp(Math.max(-20,Math.min(20,-pixels*rate))),{frame:true});
  }, { passive:false });
  let active = null, suppressContext = false, pendingContext = null, cursorFrame = 0, cursorEvent;
  vp.addEventListener("pointerdown", e => {
    if (![0,1,2].includes(e.button) || !placed() || active) return;
    suppressContext = false; pendingContext = null;
    active = {id:e.pointerId,button:e.button,x:e.clientX,y:e.clientY,lx:e.clientX,ly:e.clientY,moved:0};
    // Synthetic browser checks have no active native pointer; real input gets capture.
    try { vp.setPointerCapture(e.pointerId); } catch {}
    if (e.button === 1) e.preventDefault();
  });
  vp.addEventListener("pointermove", e => {
    if (active && active.id === e.pointerId) {
      const a = active; a.moved = Math.max(a.moved, Math.hypot(e.clientX-a.x,e.clientY-a.y));
      if (a.moved >= 4) { gesture(); setT({x:S.x-(flipOn()?-1:1)*(e.clientX-a.lx)/S.z,y:S.y-(e.clientY-a.ly)/S.z},{frame:true}); }
      a.lx=e.clientX; a.ly=e.clientY;
    }
    cursorEvent=e;
    if (!cursorFrame) cursorFrame=requestAnimationFrame(() => { cursorFrame=0; updateCoordinates(vp,cursorEvent); });
  });
  const end = e => {
    if (!active || active.id !== e.pointerId) return;
    const a=active; active=null; suppressContext = a.moved >= 4;
    if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
    if (e.type === "pointerup" && a.moved < 4 && [0,2].includes(a.button)) {   // a click, not a pan, sets the measurement origin
      anchorKey = JSON.stringify([S.p,S.v]);
      deltaAnchor = String(S.v).startsWith("sheet:") ? (p => [p.x,p.y])(schematicPoint(vp,e)) : toWorld(vp,e); updateStatus();
    }
    if (e.type === "pointerup" && a.moved < 4 && a.button === 0) pickAt(vp,e);
    if (e.type === "pointerup" && a.moved < 4 && a.button === 2 && pendingContext) canvasMenu(vp,pendingContext);
    pendingContext = null;
    if (e.type !== "pointerup") { suppressContext=false; if(cursorFrame) cancelAnimationFrame(cursorFrame); cursorFrame=0; resetCoordinates(); }
  };
  for (const type of ["pointerup","pointercancel","lostpointercapture"]) vp.addEventListener(type,end);
  vp.addEventListener("pointerleave", () => { resetCoordinates(); for(const pane of document.querySelectorAll("#stage .vp")) pane.classList.remove("board-cursor"); });
  vp.addEventListener("auxclick", e => { if (suppressContext || e.button===1) e.preventDefault(); });
  vp.addEventListener("contextmenu", e => {
    if (suppressContext || active?.moved >= 4) { e.preventDefault(); return; }
    if (!placed()) return; e.preventDefault();
    if (active) pendingContext=e; else canvasMenu(vp,e);
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
function sceneBox() {   // retained scene bounds (um -> mm); null when the view is SVG
  if (!boardView.renderers.length) return null;
  const live = boardView.scenes.filter(sc => sc && sc.objects.length), b = (live.length ? live : boardView.scenes.filter(Boolean)).map(sc => sc.bounds.map(n => n / 1000));
  return [Math.min(...b.map(x => x[0])), Math.min(...b.map(x => x[1])), Math.max(...b.map(x => x[2])), Math.max(...b.map(x => x[3]))];
}
// Fit stays live until the user pans or zooms: dock/inspector/window resizes re-centre the whole design in each pane.
const vpKey = () => { const vp = document.querySelector("#stage .vp"); return vp ? vp.clientWidth + "x" + vp.clientHeight : ""; };
let fitKey = "";
function fit() { const v = currentView(); zoomTo(v?.kind === "sheet" ? [0, 0, ...v.size] : sceneBox() || contentBox() || (v && [0, 0, ...v.size]), 2); autoFit = true; fitKey = vpKey(); }
{ let af = 0;   // #stage is replaced on redraw, so watch the surrounding boxes (centre column and inspector)
  const ro = new ResizeObserver(() => { if (!autoFit) return; cancelAnimationFrame(af); af = requestAnimationFrame(() => { if (autoFit && placed() && vpKey() !== fitKey) fit(); }); });
  for (const sel of ["#center", "#inspector"]) { const el = document.querySelector(sel); if (el) ro.observe(el); } }

const MODE_NAMES = { side: "Side", overlay: "Overlay", wipe: "Wipe", blend: "Blend", semantic: "Changes only" };
const MODE_ICONS = { side: "side", overlay: "overlay", wipe: "wipe", blend: "blend", semantic: "delta" };
const MODE_TIPS = { side: "Side by side: base left, head right", overlay: "Overlay: head over base, changes tinted", wipe: "Wipe: drag a divider between revisions", blend: "Blend: cross-fade base and head", semantic: "Changes only: dim everything unchanged" };
const tbIcon = n => `<svg class="i" aria-hidden="true" focusable="false"><use href="#kr-i-${n}"></use></svg>`;
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
  addDivider(vp);
};
function addDivider(vp) {
  vp.insertAdjacentHTML("beforeend", `<span class="tag">Base</span><span class="tag right">Head</span>
    <div class="divider" role="slider" aria-label="Wipe position" tabindex="0" aria-valuemin="0" aria-valuemax="100"></div>`);
  const d = vp.querySelector(".divider");
  d.addEventListener("pointerdown", e => {
    e.stopPropagation(); try { d.setPointerCapture(e.pointerId); } catch {}
    const mv = ev => { const r = vp.getBoundingClientRect(); S.wipe = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)); apply(); };
    d.addEventListener("pointermove", mv);
    const end = () => d.removeEventListener("pointermove", mv);
    d.addEventListener("pointerup", end, { once: true });
    d.addEventListener("pointercancel", end, { once: true });
  });
  d.addEventListener("keydown", e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    e.preventDefault(); e.stopPropagation();
    S.wipe = e.key === "Home" ? 0 : e.key === "End" ? 1 : Math.min(1, Math.max(0, S.wipe + (e.key === "ArrowLeft" ? -0.05 : 0.05))); apply(); } });
}
MODES.semantic = (stage, view) => oneWorld(stage, view, "Changes only");
function onApply() {
  const vp = document.querySelector("#stage.mode-wipe .vp");
  if (!vp) return;
  const W = vp.clientWidth, x = S.wipe * W, k = S.z / PX, head = vp.querySelector(".stack.head"), base = vp.querySelector(".stack.base");
  vp.querySelector(".divider").style.left = `${x}px`;
  vp.querySelector(".divider").setAttribute("aria-valuenow", Math.round(S.wipe * 100));
  if (!head || !base) return;
  // Divider in stack pixels. Each stack is clipped to its own side: kicad-cli SVGs have no background, so an unclipped base shows through head.
  const width = parseFloat(head.style.width);
  const u = flipOn() ? (W / 2 + S.x * S.z - x) / k : (x - (W / 2 - S.x * S.z)) / k;
  const split = Math.max(0, Math.min(width, Math.round(u)));   // shared whole-pixel edge avoids a fractional clip hairline
  if (flipOn()) { head.style.clipPath = `inset(0 ${width - split}px 0 0)`; base.style.clipPath = `inset(0 0 0 ${split}px)`; }   // mirrored: Head is the right of the divider = lower x
  else { head.style.clipPath = `inset(0 0 0 ${split}px)`; base.style.clipPath = `inset(0 ${width - split}px 0 0)`; }
}
function toggleBlend3D() {
  window.Review3D?.toggleBlend(); S.blend = window.Review3D.state.blend;
  const r = $("#modes input[type=range]"); if (r) r.value = Math.round(S.blend * 100);
  const b = $("#modes [data-3d-blend-toggle]"); if (b) b.textContent = S.blend < .5 ? "Show head" : "Show base";
}
function renderModes() {
  const focus = document.activeElement?.dataset.mode;
  const is3d = S.v === '3d';
  $("#modes").innerHTML = Object.entries(MODE_NAMES).map(([m, n]) =>
    `<button data-mode="${m}" role="radio" aria-checked="${S.m === m}" tabindex="${S.m === m ? 0 : -1}" aria-pressed="${S.m === m}" title="${is3d && m === "wipe" ? "Not available in 3D" : MODE_TIPS[m]}" ${is3d && m === "wipe" ? 'aria-disabled="true"' : ""}>${tbIcon(MODE_ICONS[m])}<span>${is3d && m === "semantic" ? "Changes only" : n}</span></button>`).join("")
    + (S.m === "blend" ? (is3d ? `<label class="blend"><span>Base</span><input type="range" aria-label="Base to Head blend" min="0" max="100" value="${Math.round(S.blend * 100)}"><span>Head</span></label><button data-3d-blend-toggle title="Switch visible revision">${S.blend < .5 ? "Show head" : "Show base"}</button>` : `<label class="blend">Head opacity <input type="range" aria-label="Head opacity" min="0" max="100" value="${Math.round(S.blend * 100)}"></label>`) : "");
  for (const b of document.querySelectorAll("#modes [data-mode]")) b.onclick = () => { if (b.getAttribute("aria-disabled") === "true") return; S.m = b.dataset.mode; renderModes(); draw(); saveHash(); };
  for (const b of document.querySelectorAll("#modes [data-mode]")) b.onkeydown = e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const bs = [...document.querySelectorAll('#modes [data-mode]:not([aria-disabled=true])')], i = bs.indexOf(b);
    const n = e.key === "Home" ? 0 : e.key === "End" ? bs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + bs.length) % bs.length;
    bs[n].focus(); bs[n].click();
  };
  const r = document.querySelector("#modes input[type=range]");
  const blendButton = $("#modes [data-3d-blend-toggle]"), buttonText = () => { if (blendButton) blendButton.textContent = S.blend < .5 ? "Show head" : "Show base"; };
  if (r) r.oninput = () => { S.blend = r.value / 100; if (is3d) window.Review3D?.setBlend(S.blend); else if (boardDiff) apply(); else { const h = document.querySelector("#stage .stack.head"); if (h) h.style.opacity = S.blend; } buttonText(); };
  blendButton?.addEventListener("click", toggleBlend3D);
  if (focus) $(`#modes [data-mode="${CSS.escape(focus)}"]`)?.focus();
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
  if (view.kind === "sheet") return proj().changes.filter(r => onView(r, S.v));
  return proj().changes.filter(r => onView(r, S.v) && (S.m === "semantic" || r.action === "modified" && MARKED.has(r.kind)));
}
function afterDraw(view) {
  renderInspector();
  syncMarkStyles();
  if (!view) return;
  refreshAppearance();
  const sel = proj().changes.find(r => r.id === S.s) || allViolations().find(v => v.id === S.s);
  for (const w of document.querySelectorAll("#stage .world")) {
    const side = sideOf(w);
    const marked = [...markersFor(view)];
    const rows = view.kind === "sheet"
      ? [...new Map(marked.concat(sel && onView(sel, S.v) ? [sel] : []).map(r => [r.id, {...r, sel:r.id === S.s}])).values()]
      : marked.concat(sel && onView(sel, S.v) ? [{ ...sel, sel: true }] : []);
    for (const r of rows) {
      const b = rowBox(r, side); if (!b) continue;
      const m = document.createElement("div");
      m.className = `marker ${r.action || "violation"}${r.sel ? " sel" : ""}`;
      m.dataset.action = r.action || "violation";
      const semantic=BoardMarks.styles[r.action];
      m.dataset.glyph = r.sel ? "◎" : (semantic?.glyph || "!");
      m.dataset.dash = r.sel ? "solid" : (semantic?.dash || "dotted");
      m.dataset.label = r.sel ? "◎" : semantic ? `${semantic.glyph} ${semantic.word}` : "!";
      m.setAttribute('role','img');
      m.setAttribute('aria-label',r.sel ? 'Selected '+(r.ref||r.id) : (semantic?.word||'Violation')+' '+(r.ref||r.id));
      if (view.kind === "sheet") {
        m.dataset.glyph = semantic?.glyph || "!";
        m.dataset.dash = semantic?.dash || "dotted";
        m.dataset.label = semantic ? `${semantic.glyph} ${semantic.word}` : "!";
        m.dataset.markStyle = Appearance.get().markStyle;
        const word = `${semantic?.word || r.action || "finding"} ${r.ref || r.kind || ""}`.trim();
        m.setAttribute("aria-label", word);
        const label = document.createElement("span"); label.className = "sch-mark-label"; label.textContent = word;
        m.append(label);
        const schMark = KrAppearance.resolve(Appearance.get()).marks.schematic[r.action];
        if (schMark) m.style.setProperty("--sch-mark", cssAppearance(schMark.color));
      }
      Object.assign(m.style, { left: `${b[0] * PX}px`, top: `${b[1] * PX}px`, width: `${(b[2] - b[0]) * PX}px`, height: `${(b[3] - b[1]) * PX}px` });
      w.appendChild(m);
    }
  }
  // Legends live outside the transformed/tinted revision stacks, like the marks.
  for(const vp of document.querySelectorAll('#stage .vp')) {
    vp.querySelector(':scope > .diff-mark-legend')?.remove();
    if(vp.querySelector('.board-marks')) continue;
    const legend=document.createElement('div'); legend.className='diff-mark-legend';
    for(const [action,style] of Object.entries(BoardMarks.styles)) {
      const key=document.createElement('span'); key.dataset.action=action;
      key.dataset.glyph=style.glyph; key.dataset.dash=style.dash;
      key.textContent=style.glyph+' '+style.word; legend.append(key);
    }
    vp.append(legend);
  }
  refreshAppearance();
  drawPins();
}
function drawPins() {
  // Refresh pins in place: replacing the drawing can swallow an in-flight right-click.
  for (const pin of document.querySelectorAll("#stage .pin")) pin.remove();
  const hosts = boardDiff ? boardDiff.panes.flatMap(pane=>pane.sides.filter(side=>pane.scenes[side]).map(side=>({w:pane.hud,side,pane})))
    : [...document.querySelectorAll("#stage .world")].map(w=>({w,side:sideOf(w)}));
  const seen = new Set();
  for (const {w,side,pane} of hosts) {
    for (const t of [...shownThreads(), ...(S.issues || []).filter(i => i.anchor.project === proj().dir).map(i => ({ ...i, id: `issue-${i.number}`, issue: true }))]) {
      const r = resolveAnchor(t.anchor);
      if (r.detached || r.view !== S.v) continue;
      if (!(r.side === side || (r.side === "head" && side === "base" && !r.added))) continue;
      const p = side === "base" && r.pos_before ? r.pos_before : r.pos;
      if (pane) {
        if (!boardDiff.sidesAt(pane.vp,p).includes(side)) continue;
        const look=glAppearance(), layer=t.anchor.layer;
        if (layer && (look.layers?.[layer]?.visible === false || look.layers?.[layer]?.opacity === 0)) continue;
        const key=boardDiff.panes.indexOf(pane)+":"+t.id+":"+p.slice(0,2).join(",");
        if (seen.has(key)) continue; seen.add(key);
      }
      const kind = t.issue ? "issue" : t.resolved ? "resolved" : t.anchor.severity === "blocking" ? "blocking" : "comment";
      const pin = document.createElement("button");
      pin.className = `pin pin-${kind}`; pin.dataset.thread = t.id;
      pin.textContent = t.issue ? `#${t.number}` : { resolved: "✓", blocking: "!", comment: "…" }[kind];
      pin.setAttribute("aria-label", t.issue ? `Issue #${t.number} on ${t.anchor.ref || "a point"}` : `${kind === "resolved" ? "Resolved" : kind === "blocking" ? "Blocking" : "Comment"} thread on ${t.anchor.ref || "a point"}`);
      const screen = pane ? pane.renderer.project(p) : p.map(n=>n*PX);
      Object.assign(pin.style, { left: `${screen[0]}px`, top: `${screen[1]}px` });
      pin.onclick = ev => { ev.stopPropagation(); if (t.issue) window.open(t.url, "_blank", "noopener"); else openThread(t.id); };
      pin.onpointerdown = ev => ev.stopPropagation();
      w.appendChild(pin);
    }
  }
}
function pickAt(vp, e) {
  if (S.placing) { stopPlacing(); proposePin(vp, e); return; }
  if (boardDiff) {
    const hit=boardDiff.pick(vp,e,S.s);
    if (hit) { S.s=hit.id; markSelected(); saveHash(); boardDiff.render(); document.querySelector(`#panel [data-id="${hit.id}"]`)?.scrollIntoView({block:"nearest"}); }
    else {
      const leaf = boardDiff.hits(vp, e)[0];
      if (leaf) { S.s = null; S.io = null; S.ig = leaf; renderInspector(); saveHash(); }
    }
    return;
  }
  const [x, y] = toWorld(vp, e);
  const rows = proj().changes.filter(c => onView(c, S.v));
  const side = sideOf(vp);
  const hit = hitTest(rows, x, y, rows.find(c => c.id === S.s) || null, side);
  if (hit) { S.s = hit.id; markSelected(); saveHash(); draw(); document.querySelector(`#panel [data-id="${hit.id}"]`)?.scrollIntoView({ block: "nearest" }); }
  else {
    const o = (proj().objects || []).find(o => objView(o) === S.v && (o.side || "head") === side &&
      (o.box ? x >= o.box[0] && y >= o.box[1] && x <= o.box[2] && y <= o.box[3] : o.pos && Math.hypot(x-o.pos[0], y-o.pos[1]) < 2));
    if (o) { S.s = null; S.ig = null; S.io = proj().objects.indexOf(o); renderInspector(); saveHash(); }
  }
}
function markSelected() { S.io = null; S.ig = null; for (const e of document.querySelectorAll("#panel [data-id]")) e.setAttribute("aria-selected", e.dataset.id === S.s); updateStatus(); renderInspector(); }
if (window.Review3D) { window.Review3D.onPick = id => { S.s = id; markSelected(); saveHash(); document.querySelector(`#panel [data-id="${id}"]`)?.scrollIntoView({ block: "nearest" }); const r = proj().changes.find(c => c.id === id); if (r) window.Review3D.focus(r); }; window.Review3D.onCameraEnd = () => { S.camera3d = window.Review3D.cameraState(); saveHash(); }; }
const viewOf = r => r.where?.board ? "board" : r.where?.sheet != null ? `sheet:${r.where.sheet}` : null;
function goTo(id) {
  const r = proj().changes.find(c => c.id === id) || allViolations().find(v => v.id === id);
  if (!r) return Promise.resolve();
  S.s = id;
  if (S.v === "3d") { markSelected(); window.Review3D?.focus(r); saveHash(); document.querySelector(`#panel [data-id="${id}"]`)?.scrollIntoView({ block: "nearest" }); return Promise.resolve(); }
  const view = viewOf(r) ?? S.v;
  const zoom = () => {
    const box = boardDiff?.bounds(id,r.action === "removed" ? "base" : "head") || rowBox(r, r.action === "removed" ? "base" : "head"); if (S.v === "3d") window.Review3D?.focus(r); else if (box) zoomTo(box); markSelected(); saveHash(); };
  if (view !== S.v) { const library = String(S.v).startsWith("lib:") || tabsChange(view); S.v = view; S.x = S.y = S.z = null; renderNav(); if (library) renderPanel(); }
  return draw().then(zoom);
}
// ---- Threads: anchors pin a discussion to a KiCad object (UUID, reference fallback) or a point, in mm. ----
const round3 = n => Math.round(n * 1000) / 1000;
const objView = o => o.sheet === undefined ? "board" : `sheet:${o.sheet}`;
function viewFile(P, view) {
  const f = view === "board" ? `${P.name}.kicad_pcb` : P.sheets.find(s => `sheet:${s.path}` === view)?.file;
  return f && (P.dir ? `${P.dir}/${f}` : f);
}
function pointAnchor(x,y,side) {
  const file=viewFile(proj(),S.v); if (!file) return null;
  return {v:1,project:proj().dir,file,sheet:S.v==='board'?null:S.v.slice(6),layer:null,
    side,commit:side==='base'?D.base:D.head,severity:'comment',target:'point',uuid:null,kind:null,ref:null,x:round3(x),y:round3(y)};
}
function geometryAnchor({object,side,point}) {
  // Aggregate children anchor to the inventory identity where available; standalone
  // leaves retain their own UUID and resolve from retained geometry after reload.
  const inventory=(proj().objects || []).find(o=>o.side===side && (o.uuid===object.uuid || o.uuid===object.changeUuid));
  const box=BoardDiff.objectBounds(object), p=inventory?.pos || object.anchor || (box ? [(box[0]+box[2])/2,(box[1]+box[3])/2] : point);
  return {...pointAnchor(p[0],p[1],side),target:'object',uuid:inventory?.uuid || object.uuid,
    kind:inventory?.kind || object.kind,ref:inventory?.ref || object.ref || null,layer:inventory?.layer || object.layer || object.layers?.[0] || null};
}
function anchorAt(x, y, side) {
  const P = proj();
  if (!S.v || S.v === "3d") return null;
  const file = viewFile(P, S.v);
  if (!file) return null;
  const objs = (P.objects || []).filter(o => objView(o) === S.v && (side === "head" ? o.side === "head" : o.side === "base" || !o.added))
    .map(o => side === "base" && o.pos_before ? { ...o, pos: o.pos_before, box: null } : o);
  const hit = hitTest(objs, x, y, null, "head");
  const a = { v: 1, project: P.dir, file, sheet: S.v === "board" ? null : S.v.slice(6), layer: null,
              side, commit: side === "base" ? D.base : D.head, severity: "comment" };
  return hit ? { ...a, target: "object", uuid: hit.uuid, kind: hit.kind, ref: hit.ref, layer: hit.layer ?? null, x: round3(hit.pos[0]), y: round3(hit.pos[1]) }
             : { ...a, target: "point", uuid: null, kind: null, ref: null, x: round3(x), y: round3(y) };
}
function resolveAnchor(a) {
  const P = D.projects.find(p => p.dir === a.project);
  if (!P) return { detached: "its project is not part of this review" };
  const short = s => String(s || "").slice(0, 7), notes = [];
  if (a.commit && a.commit !== D.head && a.commit !== D.base) notes.push(`pinned on ${short(a.commit)}, viewing ${short(D.head)}`);
  if (a.target === "point") {
    const view = a.sheet == null ? "board" : `sheet:${a.sheet}`;
    const inside = b => b && a.x >= b[0] && a.x <= b[2] && a.y >= b[1] && a.y <= b[3];
    if (a.commit !== D.head && a.commit !== D.base && P.changes.some(r => viewOf(r) === view && (inside(rowBox(r, "head")) || inside(rowBox(r, "base"))))) notes.push(`this area changed since ${short(a.commit)}`);
    return { view, side: a.side === "base" ? "base" : "head", pos: [a.x, a.y], notes };
  }
  if (a.sheet == null && !(P.objects || []).some(o=>o.uuid===a.uuid && o.sheet==null)) {
    const match=side=>(decodedBoardScenes.get(P.board?.geometry?.[side]) || (P===proj() && boardDiff?.scenes[side]))?.objects.find(o=>o.uuid===a.uuid);
    const head=match('head'), base=match('base');
    const position=o=>{const b=BoardDiff.objectBounds(o); return o.anchor || (b && [(b[0]+b[2])/2,(b[1]+b[3])/2]);};
    if (head && position(head)) return {view:'board',side:'head',pos:position(head),pos_before:base && position(base),added:!base,notes};
    if (base && position(base)) return {view:'board',side:'base',pos:position(base),notes:[...notes,`${a.ref || 'object'} was removed in this change`]};
  }
  const objs = P.objects || [];
  const sameSheet = o => (o.sheet ?? null) === (a.sheet ?? null);
  const sameUuid = o => o.uuid === a.uuid && sameSheet(o);
  const sameRef = o => !!a.ref && o.kind === a.kind && o.ref === a.ref;   // ref carries " unit N", so this matches the unit too
  const find = side => objs.find(o => o.side === side && sameUuid(o))
    || objs.find(o => o.side === side && sameRef(o) && sameSheet(o))
    || objs.find(o => o.side === side && sameRef(o));
  const head = find("head");
  if (head) {
    if (Math.hypot(head.pos[0] - a.x, head.pos[1] - a.y) > 0.01) notes.push(`moved since ${short(a.commit)}`);
    return { view: objView(head), side: "head", pos: head.pos, pos_before: head.pos_before, added: !!head.added, notes };
  }
  const base = find("base");
  if (base) return { view: objView(base), side: "base", pos: base.pos, notes: [...notes, `${a.ref} was removed in this change`] };
  return { detached: `${a.ref || "its object"} is not in either revision of this review` };
}
S.filter = { added: true, removed: true, modified: true, kind: "", q: "", all: false };
const allViolations = () => proj().checks.flatMap(c => c.violations.map(v => ({ ...v, check: c.title })));
function card(r) {
  return `<button class="card" data-id="${esc(r.id)}" data-action="${esc(r.action)}" data-kind="${esc(r.kind)}" aria-selected="${S.s === r.id}">
    <span class="ref">${esc(r.ref || r.kind)}</span> <span class="kind">${esc(r.kind)}</span>
    <span class="badge ${esc(r.action)}">${GLYPH[r.action] ?? ""} ${esc(r.action)}</span></button>`;
}
function inventoryHtml() {
  // Removed (base) rows match removed change rows, others match added/modified: a reused reference gets the right badge.
  const changes = new Map();
  for (const r of proj().changes) changes.set(`${r.kind}\0${r.ref}\0${r.action === "removed"}`, r);
  const changeFor = o => changes.get(`${o.kind}\0${o.ref}\0${o.side === "base"}`) || (o.side === "base" ? { action: "removed" } : o.added ? { action: "added" } : null);
  const place = o => o.sheet === undefined ? (o.layer || "board") : (proj().sheets.find(s => s.path === o.sheet)?.name || o.sheet);
  const q = S.filter.q.toLowerCase(), objs = (proj().objects || []).map((o, i) => ({ o, i }))
    .filter(({ o }) => !q || [o.ref, o.value, o.footprint, place(o)].some(v => String(v ?? "").toLowerCase().includes(q)));
  const f = S.filter, groupFor = o => f.group === "action" ? changeFor(o)?.action || "unchanged" : o.kind;
  if (f.sort) objs.sort((a, b) => String(f.sort === "kind" ? a.o.kind : a.o.ref).localeCompare(String(f.sort === "kind" ? b.o.kind : b.o.ref), undefined, {numeric:true}));
  if (f.group) objs.sort((a, b) => groupFor(a.o).localeCompare(groupFor(b.o)));
  let previous;
  return (objs.slice(0, 1500).map(({ o, i }) => {
    const ch = changeFor(o), view = objView(o), drawn = !!currentView(view);
    const group = groupFor(o), heading = f.group && group !== previous ? `<h3 class="dock-group">${esc(group)}</h3>` : "";
    previous = group;
    return heading + `<button class="card inv-row" data-obj="${i}" ${drawn ? "" : 'aria-disabled="true"'}><span class="ref">${esc(o.ref)}</span> <span class="kind">${esc(o.kind)}</span>
      ${ch ? `<span class="badge ${esc(ch.action)}">${GLYPH[ch.action] ?? ""} ${esc(ch.action)}</span>` : ""}
      <div class="prop"><span>value</span><span class="new wide">${esc(o.value ?? "—")}</span></div><div class="prop"><span>footprint</span><span class="new wide">${esc(o.footprint ?? "—")}</span></div>
      <div class="more muted">${esc(place(o))}${drawn ? "" : " · drawing unavailable"}</div></button>`;
  }).join("") || '<p class="muted">No parts match.</p>') + (objs.length > 1500 ? `<p class="muted">showing 1500 of ${objs.length}; narrow the search to see the rest</p>` : "");
}
function goToObject(i) {
  const o = proj().objects?.[i]; if (!o) return Promise.resolve();
  S.s = null; S.ig = null; S.io = i; renderInspector();
  const view = objView(o); if (!currentView(view)) return Promise.resolve();
  const p = o.pos, box = o.box || (p && [p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3]);
  if (view !== S.v) { const library = String(S.v).startsWith("lib:") || tabsChange(view); S.v = view; S.x = S.y = S.z = null; renderNav(); if (library) renderPanel(); }
  return draw().then(() => {
    const side=o.side==='base'?'base':'head';
    const geometry=boardDiff?.scenes[side]?.objects.filter(g=>g.uuid===o.uuid || g.changeUuid===o.uuid).map(BoardDiff.objectBounds).filter(Boolean);
    const focus=geometry?.length ? [Math.min(...geometry.map(b=>b[0])),Math.min(...geometry.map(b=>b[1])),Math.max(...geometry.map(b=>b[2])),Math.max(...geometry.map(b=>b[3]))] : box;
    if (focus) zoomTo(focus); saveHash();
  });
}
function bindInventory() {
  for (const b of document.querySelectorAll("#panel .inv-row[data-obj]")) b.onclick = () => goToObject(+b.dataset.obj);
}
function cardsHtml() {
  const f = S.filter, q = f.q.toLowerCase();
  let rows = proj().changes.filter(r => f[r.action] && (!f.kind || r.kind === f.kind)
    && (!q || JSON.stringify([r.ref, r.kind, r.changes, r.props]).toLowerCase().includes(q)));
  if (f.sort === "reference") rows.sort((a, b) => String(a.ref).localeCompare(String(b.ref), undefined, {numeric:true}));
  if (f.sort === "kind") rows.sort((a, b) => a.kind.localeCompare(b.kind));
  if (f.group) rows.sort((a, b) => String(a[f.group]).localeCompare(String(b[f.group])));
  let previous;
  return (rows.slice(0, 1500).map(r => {
    const group = f.group ? r[f.group] : null;
    const heading = f.group && group !== previous ? `<h3 class="dock-group">${esc(group)}</h3>` : "";
    previous = group;
    return heading + card(r);
  }).join("") || '<p class="muted">No changes match.</p>')
    + (rows.length > 1500 ? `<p class="muted">showing 1500 of ${rows.length}; narrow the filter to see the rest</p>` : "");
}
function bindCards() { for (const b of document.querySelectorAll("#panel .card[data-id]")) b.onclick = () => goTo(b.dataset.id); }
function waiverSnippet(v, check) {
  const today = new Date(), until = new Date(today.getTime() + 90 * 864e5).toISOString().slice(0, 10);
  const quote = x => '"' + String(x).replace(/["\\\u0000-\u001f\u007f]/g, c => c === '"' || c === "\\" ? "\\" + c : "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + '"';
  return `[[waiver]]\ncheck = ${quote(check)}\nmatch = ${quote(v.waiver_key)}\n# ${String(v.description).replace(/[\u0000-\u001f\u007f]/g, " ")}\nreason = ""          # why this is acceptable\nby = ""              # your GitHub login\ndate = ${today.toISOString().slice(0, 10)}\nuntil = ${until}    # or replace with: permanent = true`;
}
function fabLedger(c) {
  const label = c.profile === 'jlcpcb-2l' ? 'JLCPCB 2-layer'
    : c.profile === 'jlcpcb-multilayer' ? 'JLCPCB multilayer' : c.profile === 'pcbway-std' ? 'PCBWay standard' : c.profile;
  return `<section class="check-coverage" aria-label="Fabrication limit coverage">
    <strong>Fab limits (${esc(label || 'unavailable')})</strong>
    <p>Profile checked on ${esc(c.checkedOn || 'unknown')} · assumes ${esc(c.assumedCopperOz ?? 1)} oz copper.</p>
    <p>Checked: ${esc((c.checked || []).join(', ') || 'none')}.</p>
    <p>Not checked: ${esc((c.unchecked || []).join(', ') || 'none listed')}.</p>
    ${c.unsupported ? `<p>${esc(c.unsupported)}</p>` : ''}
    ${(c.coverageWarnings || []).map(w => `<p>${esc(w)}</p>`).join('')}
    ${c.status === 'not_run' ? '<p>Not run: no head board, so no fab comparison was made.</p>'
      : D.mode === 'single' ? '<p>Current-design audit: no base fab comparison was run.</p>'
      : c.baselineAvailable === false ? '<p>No base audit: findings are newly audited.</p>'
      : `<p>Compared with base: ${esc(c.new_errors ?? 0)} new, ${esc(c.fixed ?? 0)} fixed.</p>`}
  </section>`;
}
function checkKey(check) {
  return check.vendor ? `${check.name}\u0000${check.vendor}` : check.name;
}
function checkTitle(check) {
  const vendor = { jlcpcb: "JLCPCB", pcbway: "PCBWay" }[check.vendor] || check.vendor;
  return vendor ? `${check.title} · ${vendor}` : check.title;
}
function renderChecks() {
  const p = proj(), state = S.checks;
  if (!p.checks.length) return '<p class="muted">No checks ran for this project.</p>';
  const order = ["erc", "drc", "parity", "bom"];  // release is listed only when it ran: older reports never had it
  const titles = { erc: "ERC", drc: "DRC", parity: "Schematic/board parity", bom: "BOM fields", interfaces: "Interfaces", release: "Release package", fab_limits: "Fab limits" };
  const byKey = new Map(p.checks.map(c => [checkKey(c), c]));
  const names = [...new Set([...order, ...p.checks.map(c => c.name)])];
  // Both fab vendors share one check name; retain each section instead of Map's last value.
  const configured = names.flatMap(name => {
    const checks = p.checks.filter(c => c.name === name);
    return (checks.length ? checks : [undefined]).map(check => ({ name, check, setting: D.settings?.checks?.[name] }));
  });
  const ran = configured.filter(r => r.check && r.setting !== "off").map(r => r.check);
  const all = ran.flatMap(c => c.violations.map(v => ({ ...v, check: c })));
  const totalNew = all.filter(v => v.new && !v.waived).length;
  const scope = state.scope ?? (totalNew ? "new" : "all");
  const checked = state.check && byKey.has(state.check) ? state.check : "";
  const summary = configured.map(({ name, check, setting }) => {
    const key = check ? checkKey(check) : name;
    if (!check || setting === "off" || check.status === "not_run") return `<button class="check check-not-run" data-check-summary="${esc(encodeURIComponent(key))}" aria-pressed="false">
      <span class="check-heading"><span class="check-status">— not run</span><span class="check-title">${esc(check ? checkTitle(check) : titles[name] || name)}</span></span>
      <span class="check-reason">${esc(check?.reason || "turned off in kicad-review.toml")}</span></button>`;
    const baselineOnly = D.settings?.fail_on === "new" && check.errors > 0 && check.new_errors === 0;
    const status = check.status === "fail" ? "✕ failing" : check.status === "warn" ? "! warnings" : "✓ passing";
    const newer = check.new_errors + check.new_warnings;
    return `<button class="check check-${esc(check.status)}" data-check-summary="${esc(encodeURIComponent(key))}" aria-pressed="${checked === key}">
      <span class="check-heading"><span class="check-status">${status}</span><span class="check-title">${esc(checkTitle(check))} <small>${esc(check.level === "informational" ? "info" : "required")}</small></span>${baselineOnly ? '<span class="check-status-detail">· no new errors</span>' : ""}</span>
      <span class="check-counts">${check.errors} errors · ${check.warnings} warnings${check.waived ? ` · ${check.waived} waived` : ""}${newer ? ` <b class="check-new">+${newer} new</b>` : ""}${check.fixed ? ` <b class="check-fixed">${check.fixed} fixed</b>` : ""}</span></button>`;
  }).join("");
  let shown = all.filter(v => (!checked || checkKey(v.check) === checked) && (scope === "all" || v.new) && state[v.severity] && (!v.waived || state.waived) && (!state.q || JSON.stringify([v.type, v.description, v.items]).toLowerCase().includes(state.q.toLowerCase())));
  const totalShown = shown.length;
  const groups = new Map();
  for (const v of shown) {
    const identity = checkKey(v.check);
    const key = state.group === "severity" ? v.severity : state.group === "check" ? identity : `${identity}\u0000${v.type}`;
    if (!groups.has(key)) groups.set(key, { check: v.check, type: state.group === "severity" ? v.severity : state.group === "check" ? checkTitle(v.check) : v.type, violations: [] });
    groups.get(key).violations.push(v);
  }
  const groupHtml = [...groups.values()].sort((a, b) => {
    const an = a.violations.some(v => v.new), bn = b.violations.some(v => v.new);
    const ae = a.violations.some(v => v.severity === "error"), be = b.violations.some(v => v.severity === "error");
    return (state.sort === "rule" ? a.type.localeCompare(b.type) : (bn - an) || (be - ae) || a.type.localeCompare(b.type));
  }).map(g => {
    const vs = g.violations.sort((a, b) => (b.new - a.new) || ((a.severity === "error") ? -1 : 1) - ((b.severity === "error") ? -1 : 1));
    const newCount = vs.filter(v => v.new).length, errors = vs.some(v => v.severity === "error");
    return `<details class="check-group" ${newCount || vs.some(v => v.id === S.waiveOpen) ? "open" : ""}><summary><span class="rule">${esc(g.type)}</span><span class="group-description">${esc(vs[0].description)}</span><span class="group-count">${vs.length}</span>${newCount ? `<b class="new-tag">NEW ${newCount}</b>` : ""}<span class="sev">${errors ? "✕ error" : "! warning"}</span></summary>${vs.slice(0, 200).map(v => {
      const at = v.pos && currentView(viewOf(v)), issueAnchor = ISSUES_ON && findingAnchor(v);
      return `<button class="viol ${esc(v.severity)}" data-id="${esc(v.id)}" data-new="${!!v.new}" ${at ? "" : 'aria-disabled="true"'} aria-selected="${S.s === v.id}">
        ${v.new ? '<span class="new-tag">NEW</span>' : ""}${v.waived ? '<span class="waived-tag">WAIVED</span><span class="waived-reason"></span>' : ""}<span class="viol-location">${esc(v.items.join(" · ") || v.description)}</span><span class="show-hint">${at ? "Show ›" : "no location"}</span></button>${v.waiver_key && !v.waived && ["erc", "drc", "parity", "fab_limits"].includes(v.check.name) ? `<button class="waive" data-waive="${esc(v.id)}" aria-label="Waive ${esc(v.items.join(" · ") || v.description)}" aria-controls="waiver-${esc(v.id)}" aria-expanded="${S.waiveOpen === v.id}">Waive…</button>${S.waiveOpen === v.id ? `<pre class="waiver-snippet" id="waiver-${esc(v.id)}" data-waiver-snippet="${esc(v.id)}"></pre><p class="muted waiver-help">Add this to kicad-review-waivers.toml on the pull request's target branch through a pull request, fill in reason and by, then re-run this review.</p>` : ""}` : ""}${issueAnchor && !issueForAnchor(issueAnchor) ? `<button class="track-issue" data-issue-for="${esc(v.id)}">Track as issue</button>` : ""}`;
    }).join("")}${vs.length > 200 ? `<p class="muted check-more">+${vs.length - 200} more</p>` : ""}</details>`;
  }).join("");
  return `${dockListTools("checks", state)}<div class="checks-summary">${summary}</div>${ran.filter(c => c.name === 'fab_limits').map(fabLedger).join('')}<div class="filters checks-filters">
    <button class="check-chip" data-check-scope="new" aria-pressed="${scope === "new"}">New in this change ${totalNew}</button>
    <button class="check-chip" data-check-scope="all" aria-pressed="${scope === "all"}">All ${all.length}</button>
    <button class="check-chip" data-check-severity="error" aria-pressed="${state.error}">Errors ${all.filter(v => v.severity === "error").length}</button>
    <button class="check-chip" data-check-severity="warning" aria-pressed="${state.warning}">Warnings ${all.filter(v => v.severity === "warning").length}</button>
    ${all.some(v => v.waived) ? `<button class="check-chip" data-check-waived aria-pressed="${state.waived}">Waived ${all.filter(v => v.waived).length}</button>` : ""}
  </div>${ran.filter(c => c.coverage).map(c => { const cv = c.coverage, det = Object.entries(cv.detected);
  return `<p class="check-coverage">${esc(c.title)}: ${det.length ? `detected ${esc(det.map(([k, n]) => `${k} ${n}`).join(", "))}` : "nothing detected"}${cv.protected[1] ? ` · ${cv.protected[0]} of ${cv.protected[1]} connector signal pins protected` : ""}</p>`; }).join("")}${ran.filter(c => c.package).map(c => `<details class="package"><summary>Package (${c.package.files.length} files) · SHA-256 ${esc((c.package.sha256 || "").slice(0, 12))}…</summary><ul>${c.package.files.map(f => `<li>${esc(f.path)} · ${(f.bytes / 1024).toFixed(1)} kB</li>`).join("")}</ul><p class="muted mono">${esc(c.package.sha256 || "")}</p></details>`).join("")}<div class="checks-list">${totalShown ? groupHtml : '<p class="muted">No violations match these filters. <button class="show-all">Show all</button></p>'}</div>`;
}
S.partsFilter = { problems: false, changed: false };
const PARTS_BLOCKING = new Set(["missing_lcsc", "bad_lcsc", "lcsc_conflict", "placeholder", "mpn_footprint_conflict", "out_of_stock", "not_found", "discontinued"]);
// One rule for every count, filter, sort and ⚠: a problem blocks ordering the part.
const blocking = l => l.problems.some(p => PARTS_BLOCKING.has(p));
const partsProblemCount = parts => parts.lines.filter(blocking).length;
const PARTS_PROBLEMS = { missing_lcsc: "missing LCSC number", bad_lcsc: "LCSC number malformed", lcsc_conflict: "one LCSC number on several values", placeholder: "placeholder value", mpn_footprint_conflict: "one MPN on several footprints", missing_mpn: "MPN missing", out_of_stock: "out of stock", not_found: "not found at DigiKey", ambiguous: "several DigiKey matches", discontinued: "discontinued", unavailable: "lookup unavailable" };
function partsAge(s) {
  if (s?.skipped) return {text: `DigiKey lookup skipped: ${esc(s.skipped)}`, stale:true};
  if (!s || !s.fetched_at) return { text: `Supplier lookup not run${s && s.error ? `: ${esc(s.error)}` : ""}`, stale: true };
  const h = (Date.now() - Date.parse(s.fetched_at)) / 36e5;
  if (!Number.isFinite(h)) return { text: `DigiKey data age unavailable: invalid timestamp ${esc(s.fetched_at)}`, stale: true };
  return { text: `DigiKey data as of ${esc(s.fetched_at.replace("T", " ").slice(0, 16))} UTC (${h < 48 ? Math.round(h) + " h" : Math.round(h / 24) + " days"} old)`, stale: h > 24 || h < 0, warn: h > 6 };
}
function digiKeyUrl(value) {
  try {
    const u = new URL(value), host = /^www\.digikey\.(com|ca|co\.uk|de|fr|it|es|nl|be|at|ch|se|dk|fi|no|ie|pl|cz|com\.au|co\.nz|jp|cn|com\.mx|com\.br|in|sg|hk|tw|kr)$/;
    // URL normalizes an explicit default port away; reject it in the original authority too.
    if (u.protocol === "https:" && !u.username && !u.password && !u.port && host.test(u.hostname) && !String(value).split('/')[2].includes(':')) return u.href;
  } catch {}
  return null;
}
function coverageHtml(parts) {
  const c = parts.coverage; if (!c) return "";
  return `<div class="bom-coverage" role="group" tabindex="0" aria-label="BOM coverage"><b>BOM</b>${Object.keys(c.head).map(f => {
    const [n, t] = c.head[f], d = c.base?.[f] ? n - c.base[f][0] : 0, pct = t ? Math.round(100 * n / t) : 100;
    return `<span class="coverage-item${/^(lcsc|mpn|order ready)$/i.test(f) ? " primary" : ""}${n < t ? ' short' : ''}" title="${esc(f)}: ${n} / ${t} (${pct}%) · change from base ${d > 0 ? '+' : ''}${d}"><span class="sr-only">${n < t ? 'incomplete: ' : ''}</span>${esc(f)} <b>${pct}%</b><span class="sr-only"> ${n} / ${t} ${d > 0 ? '+' : ''}${d}</span></span>`;
  }).join("")}</div>`;
}
function fieldChangesHtml(parts) {
  const fc = parts.field_changes || [];
  return (fc.length ? `<table class="field-changes"><caption>Field changes</caption><thead><tr><th>Refs</th><th>Field</th><th>Base</th><th>Head</th></tr></thead><tbody>${fc.map(r =>
    `<tr><td>${esc(r.refs.join(", "))}</td><td>${esc(r.field)}</td><td>${esc(r.before ?? "—")}</td><td>${esc(r.after ?? "—")}</td></tr>`).join("")}</tbody></table>` : "")
    + (parts.dnp_mismatch?.length ? `<p class="dnp-mismatch">⚠ DNP differs between schematic and board: ${esc(parts.dnp_mismatch.join(", "))}</p>` : "");
}
function renderParts() {
  const parts = proj().parts, age = partsAge(parts.supplier), f = S.partsFilter;
  const changes = l => parts.changes.filter(r => r.action !== "removed" && r.refs.some(ref => l.refs.includes(ref)));
  const rows = parts.lines.map(l => ({ line: l, changes: changes(l) }));
  // Removed lines are not in the head BOM; keep them visible for change review.
  for (const r of parts.changes.filter(r => r.action === "removed")) rows.push({ line: { ...r.before, refs: r.refs }, changes: [r] });
  const shown = rows.filter(r => (!f.q || JSON.stringify(r.line).toLowerCase().includes(f.q.toLowerCase())) && (!f.problems || blocking(r.line)) && (!f.changed || r.changes.length))
    .sort((a, b) => f.sort === "reference" ? a.line.refs[0].localeCompare(b.line.refs[0], undefined, {numeric:true}) : Number(blocking(b.line)) - Number(blocking(a.line)));
  const counts = parts.supplier?.not_looked_up || {};
  const notLookedUp = [["no_mpn", "no MPN"], ["invalid_mpn", "invalid MPN"], ["run_limit", "run limit"]]
    .filter(([key]) => counts[key] > 0).map(([key, reason]) => `${esc(counts[key])} part${counts[key] === 1 ? "" : "s"} not looked up: ${reason}`).join(". ");
  return `${dockListTools("parts", f)}${coverageHtml(parts)}${parts.supplier ? `<p class="parts-age${age.stale ? " stale" : age.warn ? " warn" : ""}">${age.text}</p>` : ""}
    ${parts.supplier?.fetched_at ? '<p class="parts-attribution parts-age">Stock and price from DigiKey</p>' : ""}
    ${parts.supplier?.error ? `<p class="parts-lookup-error parts-age">DigiKey lookup unavailable: ${esc(parts.supplier.error)}</p>` : ""}
    ${notLookedUp ? `<p class="parts-not-looked-up parts-age">${notLookedUp}.</p>` : ""}
    <div class="filters checks-filters">${[["problems", "Only problems"], ["changed", "Only changed"]].map(([k, label]) => `<button class="check-chip" data-parts-filter="${k}" aria-pressed="${f[k]}">${label}</button>`).join("")}</div>
    <div class="parts-scroll"><table class="parts-table"><thead><tr>${["Δ", "Refs", "Value / MPN", "LCSC", "DigiKey", "PCBWay", "Datasheet"].map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${shown.map(({ line: l, changes: cs }) => {
      // A change row names only the refs it moved; the line's other refs did not change.
      const moved = [...new Set(cs.flatMap(r => r.refs))], refs = f.changed ? moved : l.refs;
      const changeText = field => {
        const old = [...new Set(cs.filter(r => r.before && r.after && r.before[field] !== r.after[field]).map(r => r.before[field] || "—"))];
        const who = moved.length && moved.length < l.refs.length ? ` (${moved.join(", ")})` : "";
        return esc(old.length ? `${old.join(", ")} → ${l[field] || "—"}${who}` : l[field] || "—");
      };
      const problems = l.problems.map(p => PARTS_PROBLEMS[p] || p), supplier = parts.supplier ? l.supplier : null;
      let stock = "—";
      if (parts.supplier?.skipped) stock = "not looked up";
      else if (supplier) {
        stock = supplier.status === "ok" ? `${age.stale ? "" : "✔ "}${supplier.quantity ?? "—"}${age.stale ? " (stale)" : " in stock"}`
          : ({out_of_stock:"out of stock", not_found:"not found", ambiguous:"several matches", discontinued:"discontinued", unavailable:"unavailable", run_limit:"not looked up: run limit", no_mpn:"not looked up: no MPN", invalid_mpn:"not looked up: invalid MPN"})[supplier.status] || "unavailable";
        const price = supplier.breaks?.find(b => b[0] === 1)?.[1] ?? supplier.unit_price;
        if (["ok", "out_of_stock", "discontinued"].includes(supplier.status) && Number.isFinite(price)) {
          try { stock += ` ${new Intl.NumberFormat("en-US", {style:"currency", currency:parts.supplier.currency || "USD"}).format(price)}`; }
          catch { stock += ` ${price.toFixed(2)} ${parts.supplier.currency || "USD"}`; }
        }
      } else if (parts.supplier) stock = "not looked up: invalid MPN";
      const product = !parts.supplier?.skipped && supplier ? digiKeyUrl(supplier.url) : null;
      const stockText = product ? `<a href="${esc(product)}" rel="noopener noreferrer" target="_blank">${esc(stock)}</a>` : esc(stock);
      const stockHtml = stockText + (!parts.supplier?.skipped && supplier?.product_status ? `<small class="parts-footprint">${esc(supplier.product_status)}</small>` : "");
      const url = l.datasheet, sheet = /^https?:\/\//i.test(url || "") ? `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">pdf</a>` : "—";
      return `<tr class="parts-row${blocking(l) ? " problem" : ""}${cs.length ? " changed" : ""}${supplier?.status === "unavailable" ? " unavailable" : ""}"><td title="${esc(cs.map(r => r.action).join(", "))}">${blocking(l) ? "⚠" : ""}${cs.map(r => ({added: "+", removed: "−", swapped: "~", value: "~", footprint: "~"})[r.action] || "").join("")}</td><td class="parts-refs" title="${esc(refs.join(", "))}">${referenceRanges(refs) === refs.join(", ") ? refs.map(r => moved.includes(r) ? `<strong>${esc(r)}</strong>` : esc(r)).join(", ") : esc(referenceRanges(refs))}</td><td>${changeText("value")}${l.mpn ? `<span class="parts-mpn"> ${esc(l.mpn)}</span>` : ""}${cs.some(r => r.before && r.after && r.before.footprint !== r.after.footprint) ? `<small class="parts-footprint">footprint ${changeText("footprint")}</small>` : ""}${problems.length ? `<small class="parts-problems">${l.problems.map((p, i) => `<span class="problem-tag" tabindex="0" title="${esc(problems[i])}">${p.includes("lcsc") ? "LCSC" : p.includes("mpn") ? "MPN" : p === "placeholder" ? "VALUE" : "STOCK"}</span>`).join(" ")}</small>` : ""}</td><td>${changeText("lcsc")}</td><td class="parts-stock${age.stale ? " stale" : ""}">${stockHtml}</td><td title="${l.mpn ? "MPN supplied for PCBWay" : "MPN missing"}">${l.mpn ? "✔" : "—"}</td><td>${sheet}</td></tr>`;
    }).join("")}</tbody></table>${shown.length ? "" : '<p class="muted">No parts match these filters.</p>'}</div>${fieldChangesHtml(parts)}`;
}
function renderThreads() {
  const f = S.threadFilter, all = (S.threads || []).filter(t => t.anchor.project === proj().dir);
  const count = st => all.filter(t => st === "all" || (st === "resolved") === t.resolved).length;
  const label = t => t.resolved ? "✓ Resolved" : t.anchor.severity === "blocking" ? "! Blocking" : "… Comment";
  const cardFor = t => {
    const r = resolveAnchor(t.anchor), first = t.comments[0];
    return `<button class="thread-card${t.anchor.severity === "blocking" && !t.resolved ? " blocking" : ""}" data-thread="${esc(t.id)}" aria-selected="${S.thread === t.id}">
      <span class="thread-kind">${label(t)}</span> <span class="ref">${esc(t.anchor.ref || "point")}</span> <span class="muted">${esc(t.anchor.file)}</span>
      ${first ? `<span class="thread-text">${esc(first.author)}: ${esc(String(first.body).slice(0, 200))}</span>` : ""}
      ${t.comments.length > 1 ? `<span class="muted">${t.comments.length - 1} repl${t.comments.length === 2 ? "y" : "ies"}</span>` : ""}
      ${!r.detached && !currentView(r.view) ? '<span class="thread-note">its drawing is unavailable in this review</span>' : ""}
      ${(r.notes || []).map(n => `<span class="thread-note">${esc(n)}</span>`).join("")}</button>`;
  };
  const issues = (S.issues || []).filter(i => i.anchor.project === proj().dir);
  const shown = shownThreads(), placed = shown.filter(t => !resolveAnchor(t.anchor).detached), detached = shown.filter(t => resolveAnchor(t.anchor).detached);
  const discussions = `<div class="filters checks-filters">${["open", "resolved", "all"].map(st => `<button class="check-chip" data-thread-status="${st}" aria-pressed="${f.status === st}">${st[0].toUpperCase() + st.slice(1)} ${count(st)}</button>`).join("")}
      <select class="thread-severity"><option value="">All kinds</option><option value="comment" ${f.severity === "comment" ? "selected" : ""}>Comment</option><option value="blocking" ${f.severity === "blocking" ? "selected" : ""}>Blocking</option></select></div>
    <p class="muted thread-hint">Right-click the drawing, or press c and click, to start a thread.</p>
    <div class="cards">${placed.map(cardFor).join("") || '<p class="muted">No threads match.</p>'}</div>
    ${detached.length ? `<details class="threads-detached" open><summary>Detached (${detached.length})</summary>${detached.map(t => cardFor(t) + `<span class="thread-note">${esc(resolveAnchor(t.anchor).detached)}</span>`).join("")}</details>` : ""}`;
  return (S.threads ? discussions : "") + (issues.length ? `<details class="issues-group" open><summary>Issues (${issues.length})</summary>${issues.map(i => `<a class="thread-card" data-issue="${i.number}" href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number} ${esc(i.title)} <span class="muted">${esc(i.anchor.ref || "point")}</span></a>`).join("")}</details>` : "");
}
function libInfoHtml(c) {
  return `<div class="lib-info"><p><b>${esc(c.lib)}:${esc(c.item)}</b> · ${esc(c.kind)} · ${esc(c.status)}${c.note ? ` · ${esc(c.note)}` : ""}</p>
    ${c.warnings.map(w => `<p class="lib-warn">${esc(w)}</p>`).join("")}
    ${c.pins_diff.length ? `<table class="field-changes"><caption>${c.kind === "symbol" ? "Pins" : "Pads"}</caption><thead><tr><th>#</th><th>Change</th><th>Base</th><th>Head</th></tr></thead><tbody>${c.pins_diff.map(d =>
      `<tr><td>${esc(d.pin)}</td><td>${esc(d.change)}</td><td>${esc(d.before ?? "—")}</td><td>${esc(d.after ?? "—")}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">No pin or pad changes.</p>'}
    <p>Used by: ${c.used_by.length ? c.used_by.map(ref => { const i = proj().objects?.findIndex(o => o.kind === c.kind && o.lib === `${c.lib}:${c.item}` && o.side === "head" && o.ref.split(" unit ")[0] === ref); return i >= 0 && currentView(objView(proj().objects[i])) ? `<button data-lib-object="${i}">${esc(ref)}</button>` : esc(ref); }).join(", ") : '<span class="muted">nothing in this project</span>'}</p></div>`;
}

// bench-t5: native dock controls, no dependencies.
function referenceRanges(refs) {
  const sorted = [...refs].sort((a, b) => a.localeCompare(b, undefined, {numeric:true})), out = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i], match = /^(.*?)(\d+)$/.exec(start);
    let end = i;
    if (match) while (end + 1 < sorted.length && sorted[end + 1] === match[1] + (+match[2] + end - i + 1)) end++;
    out.push(end - i >= 2 ? `${start}–${sorted[end]}` : sorted.slice(i, end + 1).join(", "));
    i = end;
  }
  return out.join(", ");
}
function dockListTools(name, state) {
  const options = (values, current) => values.map(([v, label]) => `<option value="${v}" ${v === (current || "") ? "selected" : ""}>${label}</option>`).join("");
  return `<div class="dock-list-tools"><input class="${name === "changes" ? "q" : ""}" type="search" data-list-search="${name}" aria-label="Search ${name}" placeholder="Search ${name}…" value="${esc(state.q || "")}"><select data-list-sort="${name}" aria-label="Sort ${name}">${options(name === "checks" ? [["", "New / severity"], ["rule", "Rule name"]] : [["", "Review order"], ["reference", "Reference"], ...(name === "changes" ? [["kind", "Kind"]] : [])], state.sort)}</select>${name === "parts" ? "" : `<select data-list-group="${name}" aria-label="Group ${name}">${options(name === "checks" ? [["", "Group: rule"], ["check", "Group: check"], ["severity", "Group: severity"]] : [["", "No groups"], ["kind", "Group: kind"], ["action", "Group: action"]], state.group)}</select>`}</div>`;
}
function renderPanel() {
  appearanceUI?.cancelPendingImports(); // preserve late-import invalidation without tearing down left controls
  const active = document.activeElement, key = ["data-tab", "data-inv", "data-action", "data-check-summary", "data-check-scope", "data-check-severity", "data-check-waived", "data-waive", "data-parts-filter", "data-thread-status", "data-thread", "data-issue-for", "data-issue"].find(k => active?.closest("#panel") && !active.matches(".card") && active.hasAttribute(k)), focus = key ? `[${key}="${CSS.escape(active.getAttribute(key))}"]` : active?.matches("#panel select.kind") ? "select.kind" : active?.matches("#panel select.thread-severity") ? "select.thread-severity" : active?.matches("#panel .show-all") ? ".show-all" : null;
  const p = proj(), f = S.filter;
  if (S.t === "parts" && !p.parts) S.t = "changes";
  if (S.t === "appearance" && leftTab !== "appearance") renderNav();
  if (S.t === "threads" && !S.threads && !S.issues) { S.wantThreads = true; S.t = "changes"; }
  if (S.t !== "appearance") rightTab = S.t;
  if (rightTab === "parts" && !p.parts || rightTab === "threads" && !S.threads && !S.issues) rightTab = "changes";
  const panelTab = rightTab;
  const kinds = [...new Set(p.changes.map(r => r.kind))];
  const c = { added: 0, removed: 0, modified: 0 }; p.changes.forEach(r => c[r.action]++);
  const tab = (name, label, enabled, extra = "") => `<button type="button" role="tab" id="tab-${name}" data-tab="${name}" aria-controls="panel-body" aria-selected="${panelTab === name}" ${enabled ? "" : `disabled title="${name === "parts" ? "Parts data was not included in this report" : "Threads require the connected review site"}"`}>${label}${extra}</button>`;
  const partsExtra = p.parts ? ` ${p.parts.lines.length}${partsProblemCount(p.parts) ? ` · ${partsProblemCount(p.parts)} ⚠` : ""}` : "";
  const threadsExtra = S.threads || S.issues ? ` ${(S.threads || []).filter(t => !t.resolved && t.anchor.project === p.dir).length}` : "";
  $("#panel").innerHTML = `<div class="dock-actions"><span>REVIEW</span><button type="button" data-panel-wide title="${S.panelWide ? "Narrow the dock to 360 px" : "Widen the dock to 700 px"}" aria-pressed="${!!S.panelWide}">${tbIcon("expand")}<span>${S.panelWide ? "Narrow" : "Widen"}</span></button>${["parts", "checks"].includes(panelTab) ? `<button type="button" data-panel-table aria-pressed="${!!S.panelTable}" title="Full-width table view">${S.panelTable ? "Close table" : "Table view"}</button>` : ""}<button type="button" data-panel-close aria-label="Collapse right dock" title="Collapse right dock">×</button></div><div id="panel-tabs" role="tablist" aria-label="Inspector">${tab("changes", "Changes", true, ` ${p.changes.length}`)}${tab("checks", "Checks", true)}${tab("parts", "Parts", !!p.parts, partsExtra)}${tab("threads", "Threads", !!(S.threads || S.issues), threadsExtra)}</div><div id="panel-body" role="tabpanel" aria-labelledby="tab-${panelTab}">` +
    (panelTab === "threads" ? renderThreads() : panelTab === "parts" ? renderParts() : panelTab === "checks" ? renderChecks() : `
    ${String(S.v).startsWith("lib:") && p.libraries?.[+S.v.slice(4)] ? libInfoHtml(p.libraries[+S.v.slice(4)]) : ""}
    ${dockListTools("changes", f)}
    ${p.objects ? `<div class="filters inv-toggle"><button class="check-chip" data-inv="0" aria-pressed="${!f.all}">Changes</button><button class="check-chip" data-inv="1" aria-pressed="${f.all}">All parts ${p.objects.length}</button></div>` : ""}
    ${f.all ? "" : `<div class="filters">${["added", "removed", "modified"].map(a =>
      `<button class="chip-filter ${a}" data-action="${a}" aria-pressed="${f[a]}">${GLYPH[a]} ${a} ${c[a]}</button>`).join("")}
      <select class="kind"><option value="">All kinds</option>${kinds.map(k => `<option ${k === f.kind ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></div>`}
    <div class="cards">${f.all ? inventoryHtml() : cardsHtml()}</div>${S.v === "3d" && p.board.no_model?.length ? `<details class="no-models" open><summary>Parts without a 3D model (${p.board.no_model.length})</summary>${p.board.no_model.map(x => `<button data-no-model="${esc(x.ref)}"><b>${esc(x.ref)}</b> <span class="muted">${esc(x.reason)}</span></button>`).join("")}</details>` : ""}</div>`);
  bindRightDock();
  for (const input of document.querySelectorAll("#panel [data-list-search], #panel [data-list-sort], #panel [data-list-group]")) {
    const attribute = input.hasAttribute("data-list-search") ? "search" : input.hasAttribute("data-list-sort") ? "sort" : "group";
    const name = input.getAttribute(`data-list-${attribute}`), state = name === "checks" ? S.checks : name === "parts" ? S.partsFilter : S.filter;
    input[attribute === "search" ? "oninput" : "onchange"] = () => {
      const start = input.selectionStart;
      state[attribute === "search" ? "q" : attribute] = input.value;
      renderPanel();
      const next = document.querySelector(`[data-list-${attribute}="${name}"]`); next?.focus();
      if (attribute === "search" && next?.type === "search") next.setSelectionRange(start, start);
    };
  }
  for (const t of document.querySelectorAll("#panel-tabs [role=tab]")) t.onclick = () => { if (t.disabled) return; S.wantThreads = false; S.t = t.dataset.tab; renderPanel(); saveHash(); };
  const tabs = [...document.querySelectorAll("#panel-tabs [role=tab]:not(:disabled)")];
  for (const tab of tabs) {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("keydown", event => {
      const i = tabs.indexOf(tab), key = event.key;
      const target = key === "Home" ? tabs[0] : key === "End" ? tabs.at(-1) : key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length] : null;
      if (!target) return;
      event.preventDefault(); const name = target.dataset.tab;
      target.click();
      const next = document.querySelector('#panel [data-tab="' + name + '"]');
      next?.focus(); next?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  for (const b of document.querySelectorAll("#panel [data-parts-filter]")) b.onclick = () => { const k = b.dataset.partsFilter; S.partsFilter[k] = !S.partsFilter[k]; renderPanel(); };
  for (const b of document.querySelectorAll("#panel .chip-filter[data-action]")) b.onclick = () => { f[b.dataset.action] = !f[b.dataset.action]; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-check-summary]")) b.onclick = () => { const n = decodeURIComponent(b.dataset.checkSummary); if (!proj().checks.some(c => checkKey(c) === n)) return; S.checks.check = S.checks.check === n ? "" : n; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-check-scope]")) b.onclick = () => { S.checks.scope = b.dataset.checkScope; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-check-severity]")) b.onclick = () => { S.checks[b.dataset.checkSeverity] = !S.checks[b.dataset.checkSeverity]; renderPanel(); };
  $("#panel .show-all")?.addEventListener("click", () => { Object.assign(S.checks, { check: "", scope: "all", error: true, warning: true, waived: true }); renderPanel(); });
  const wc = $("#panel [data-check-waived]"); if (wc) wc.onclick = () => { S.checks.waived = !S.checks.waived; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-waive]")) b.onclick = () => { S.waiveOpen = S.waiveOpen === b.dataset.waive ? null : b.dataset.waive; renderPanel(); };
  if (panelTab === "checks") for (const c of p.checks || []) for (const v of c.violations) {
    if (!v.waived && S.waiveOpen !== v.id) continue;
    const reason = $(`#panel .viol[data-id="${CSS.escape(v.id)}"] .waived-reason`);
    if (reason) reason.textContent = `${v.waived.reason} · ${v.waived.by}${v.waived.until ? ` · until ${v.waived.until}` : " · permanent"}`;
    const pre = $(`#panel [data-waiver-snippet="${CSS.escape(v.id)}"]`);
    if (pre) pre.textContent = waiverSnippet(v, c.name);
  }
  const k = $("#panel select.kind"); if (k) k.onchange = () => { f.kind = k.value; renderPanel(); };
  const q = $("#panel .q"); if (q) q.oninput = () => { f.q = q.value; $("#panel .cards").innerHTML = f.all ? inventoryHtml() : cardsHtml(); bindCards(); bindInventory(); };
  for (const b of document.querySelectorAll("#panel [data-inv]")) b.onclick = () => { f.all = b.dataset.inv === "1"; renderPanel(); };
  for (const b of document.querySelectorAll("#panel [data-lib-object]")) b.onclick = () => goToObject(+b.dataset.libObject);
  bindInventory();
  bindCards();
  for (const b of document.querySelectorAll("#panel [data-no-model]")) b.onclick = () => { const row = p.board.no_model.find(x => x.ref === b.dataset.noModel); if (row) window.Review3D?.focus({ ...row, action: row.side === "base" ? "removed" : "added" }); };
  for (const b of document.querySelectorAll("#panel [data-issue-for]")) b.onclick = () => {
    const v = allViolations().find(x => x.id === b.dataset.issueFor), a = v && findingAnchor(v);
    if (ISSUES_ON && a && !issueForAnchor(a)) parent.postMessage({ kicadReviewIssueFor: { ...a, title: `${v.check}: ${v.description}`.slice(0, 200) } }, "*");
  };
  for (const b of document.querySelectorAll("#panel .viol[data-id]")) b.onclick = () => { if (b.getAttribute("aria-disabled") !== "true") goTo(b.dataset.id); else { S.s = b.dataset.id; markSelected(); saveHash(); } };
  for (const b of document.querySelectorAll("#panel [data-thread-status]")) b.onclick = () => { S.threadFilter.status = b.dataset.threadStatus; renderPanel(); draw(); };
  const ts = $("#panel select.thread-severity"); if (ts) ts.onchange = () => { S.threadFilter.severity = ts.value; renderPanel(); draw(); };
  for (const b of document.querySelectorAll("#panel .thread-card[data-thread]")) b.onclick = () => openThread(b.dataset.thread);
  if (focus) ($(`#panel ${focus}`) || (focus === ".show-all" ? $('#panel [data-check-scope="all"]') : null))?.focus();
}

function encodeState(s = S) {
  const q = new URLSearchParams();
  q.set("p", s.p); q.set("v", s.v); q.set("m", s.m);
  for (const k of ["x", "y", "z"]) if (Number.isFinite(s[k])) q.set(k, +s[k].toFixed(3));
  if (s.s) q.set("s", s.s);
  if (s.t && s.t !== "changes") q.set("t", s.t);
  if (s.layers) q.set("l", s.layers.join(","));
  if (Array.isArray(s.camera3d)) q.set("c", s.camera3d.map(n => (+n.toFixed(1))).join(","));
  if (s.hidden3d?.length) q.set("h", s.hidden3d.join(","));
  return q.toString().replace(/%2F/g, "/").replace(/%3A/g, ":").replace(/%2C/g, ",");
}
let hashTimer;
function saveHash() { clearTimeout(hashTimer); hashTimer = setTimeout(() => { history.replaceState(null, "", "#" + encodeState()); if (parent !== window) parent.postMessage({ kicadReviewHash: "#" + encodeState() }, "*"); }, 200); }
function stepIds() {
  const sel = S.t === "checks" ? "#panel .viol[data-id]:not([aria-disabled])" : S.t === "threads" ? "#panel .thread-card[data-thread]" : "#panel .card[data-id]";
  return [...document.querySelectorAll(sel)].map(e => e.dataset.id || e.dataset.thread);
}
function renderChangeCount() {
  const ids = stepIds(), i = ids.indexOf(S.t === "threads" ? S.thread : S.s), c = $("#change-count");
  if (!c) return;
  c.textContent = `${i < 0 ? "–" : i + 1} / ${ids.length}`;
  for (const b of document.querySelectorAll("#change-nav [data-step]")) b.disabled = !ids.length;
}
new MutationObserver(renderChangeCount).observe($("#panel"), { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
renderChangeCount();
function step(dir) {
  const ids = stepIds();
  if (!ids.length) return;
  const i = ids.indexOf(S.t === "threads" ? S.thread : S.s), next = ids[i < 0 ? (dir > 0 ? 0 : ids.length - 1) : (i + dir + ids.length) % ids.length];
  if (S.t === "threads") { openThread(next); document.querySelector(`#panel [data-thread="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" }); return; }
  goTo(next); document.querySelector(`#panel [data-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
}
// Hotkeys: KiCad common/tool/actions.cpp:717-767,809-815,1043-1057,1150-1155,1212-1218;
// pcbnew/tools/pcb_actions.cpp:1869-1877,2125-2150,2160-2180. Browser Ctrl variants are explicit.
function boardKey(e) {
  if (S.v !== "board" || e.metaKey || e.altKey) return false;
  const key=e.key, a=Appearance.get();
  if (e.ctrlKey && !["0","=","+","-","u","U"].includes(key)) return false;
  if (e.ctrlKey && e.shiftKey && key!=="+" && key!=="=") return false;
  if (key==="Home" && !e.ctrlKey || key==="0" && e.ctrlKey) fit();
  else if ((!e.ctrlKey && ["F1","F2"].includes(key)) || e.ctrlKey && ["=","+","-"].includes(key)) {
    const up=key==="F1" || key==="=" || key==="+", step=Math.log(S.z)/Math.log(1.3);
    const z=Math.pow(1.3,up ? Math.ceil(step+1-1e-10) : Math.floor(step-1+1e-10));
    const vp=boardCursor?.vp.isConnected ? boardCursor.vp : $("#stage .vp"), r=vp?.getBoundingClientRect();
    if(r) zoomBoardAt(vp,boardCursor?.clientX ?? r.left+r.width/2,boardCursor?.clientY ?? r.top+r.height/2,z/S.z);
  } else if (e.ctrlKey && key.toLowerCase()==="u") Appearance.patch({units:({mm:"mil",mil:"in",in:"mm"})[a.units]});
  else if (e.ctrlKey) return false;
  else if (key==="F4") { if(boardCursor) setT({x:boardCursor.world[0],y:boardCursor.world[1]}); }
  else if (["PageUp","PageDown","+","-"].includes(key)) {
    const sceneLayers=boardView.scenes?.filter(Boolean).flatMap(s=>s.layers.filter(l=>l.enabled).map(l=>l.name));
    const layers=KicadColors.appearanceOrder.filter(n=>a.layers[n] && (!sceneLayers?.length || sceneLayers.includes(n)));
    const layer=key==="PageUp" ? "F.Cu" : key==="PageDown" ? "B.Cu" : layers[(Math.max(0,layers.indexOf(a.activeLayer))+(key==="+"?1:-1)+layers.length)%layers.length];
    if(layers.includes(layer)) Appearance.patch({activeLayer:layer});
  } else if (key.toLowerCase()==="h" && !e.shiftKey) Appearance.patch({contrast:({normal:"dim",dim:"hide",hide:"normal"})[a.contrast]});
  else if (key.toLowerCase()==="n") {
    const grids=a.units==="mm" ? BOARD_GRID_MM : BOARD_GRID_MIL;
    let i=grids.findIndex(n=>Math.abs(n-a.grid.size)<1e-9);
    if(i<0) i=grids.reduce((best,n,j)=>Math.abs(n-a.grid.size)<Math.abs(grids[best]-a.grid.size)?j:best,0);
    Appearance.patch({grid:{size:grids[(i+(e.shiftKey?-1:1)+grids.length)%grids.length],visible:true}});
  } else if (["{","}"].includes(key)) { if(a.layers[a.activeLayer]) Appearance.patch({layers:{[a.activeLayer]:{opacity:a.layers[a.activeLayer].opacity+(key==="}"?.1:-.1)}}}); }
  else return false;
  return true;
}
// bench-t7: shared delayed tooltip helper; delegated so rebuilt controls work too.
function installBenchTooltips() {
  const tip=document.createElement('div'); tip.id='bench-tooltip'; tip.role='tooltip'; tip.hidden=true; document.body.append(tip);
  let timer, target;
  const hide=()=>{clearTimeout(timer);tip.hidden=true;if(target?.getAttribute('aria-describedby')===tip.id)target.removeAttribute('aria-describedby');target=null;};
  const show=e=>{
    const node=e.target.closest?.('#toolbar button, #toolbar [title], #statusbar button, #statusbar [title], #statusbar select');
    if(!node || node===target)return;
    hide(); const owner=node.closest('[title]') || node;
    if(owner.title){owner.dataset.benchTip=owner.title;owner.removeAttribute('title');}
    let text=node.dataset.benchTip || owner.dataset.benchTip || node.getAttribute('aria-label') || node.textContent.trim();
    const hint=node.matches('[data-z]') ? (+node.dataset.z>1?'F1 / Ctrl+=':'F2 / Ctrl+−') : node.matches('[data-act=fit]') ? 'Home / Ctrl+0 / f' : node.matches('[data-step]') ? (+node.dataset.step>0?'j / ↓':'k / ↑') : '';
    if(hint && !text.includes(hint))text+=' · '+hint;
    if(!text)return;
    target=node; timer=setTimeout(()=>{if(!target?.isConnected)return;tip.textContent=text;tip.hidden=false;node.setAttribute('aria-describedby',tip.id);const r=node.getBoundingClientRect();tip.style.left=Math.max(6,Math.min(innerWidth-tip.offsetWidth-6,r.left))+'px';tip.style.top=(r.bottom+tip.offsetHeight+12<innerHeight?r.bottom+6:r.top-tip.offsetHeight-6)+'px';},450);
  };
  document.addEventListener('pointerover',show);document.addEventListener('focusin',show);
  document.addEventListener('pointerout',e=>{if(target && !target.contains(e.relatedTarget))hide();});document.addEventListener('focusout',hide);
  document.addEventListener('pointerdown',hide);document.addEventListener('keydown',hide);window.addEventListener('blur',hide);
}
installBenchTooltips();
$('#status-units').onchange=e=>{if(S.v==='board')Appearance.patch({units:e.target.value});else{S.units=e.target.value;updateStatus();}};
let benchMenu=null, benchMenuOrigin=null;
function closeBenchMenu(restore=true){if(!benchMenu)return;benchMenu.remove();benchMenu=null;if(restore && benchMenuOrigin?.isConnected)benchMenuOrigin.focus();}
function showBenchMenu(items,x,y,origin){
  closeBenchMenu(false);benchMenuOrigin=origin;const menu=document.createElement('div');menu.className='bench-context';menu.role='menu';menu.setAttribute('aria-label','Context actions');
  for(const item of items){const b=document.createElement('button');b.type='button';b.role='menuitem';b.textContent=item.label;b.disabled=!!item.disabled;b.onclick=()=>{closeBenchMenu();item.run();};menu.append(b);}
  document.body.append(menu);benchMenu=menu;menu.style.left=Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-4))+'px';menu.style.top=Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-4))+'px';menu.querySelector('button:not(:disabled)')?.focus();
  menu.onkeydown=e=>{const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}else if(e.key==='Escape'||e.key==='Tab'){if(e.key==='Escape')e.preventDefault();e.stopPropagation();closeBenchMenu();}};
}
async function benchCopy(text){
  try{await navigator.clipboard.writeText(text);statusText('.status-message','Copied');}
  catch{const dialog=document.createElement('dialog');dialog.className='bench-copy';const label=document.createElement('label');label.textContent='Copy with Ctrl/Cmd+C';const field=document.createElement('input');field.readOnly=true;field.value=text;label.append(field);const close=document.createElement('button');close.textContent='Close';close.onclick=()=>dialog.close();dialog.append(label,close);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();field.select();}
}
function canvasMenu(vp,e){
  const point=toWorld(vp,e),a=Appearance.get(),layer=a.activeLayer,board=S.v==='board',layerAvailable=board&&!!a.layers[layer];
  showBenchMenu([
    {label:'Zoom to here',run:()=>setT({x:point[0],y:point[1],z:S.z*1.3})},
    {label:'Copy coordinates',run:()=>{const units=board?a.units:S.units,div=units==='mil'?.0254:units==='in'?25.4:1;benchCopy(`X ${(point[0]/div).toFixed(3)} Y ${(point[1]/div).toFixed(3)} ${units}`);}},
    {label:'Comment here',disabled:!THREADS_ON,run:()=>proposePin(vp,e)},
    {label:'Select object under cursor',run:()=>pickAt(vp,e)},
    {label:`Hide layer${layerAvailable?' · '+layer:''}`,disabled:!layerAvailable,run:()=>Appearance.patch({layers:{[layer]:{visible:false}}})},
    {label:'Show only this layer',disabled:!layerAvailable,run:()=>Appearance.patch({layers:Object.fromEntries(Object.keys(a.layers).map(name=>[name,{visible:name===layer}]))})}
  ],e.clientX,e.clientY,vp);
}
const benchRowSelector='#panel .card[data-id], #panel .inv-row[data-obj], #panel .viol[data-id], #panel .parts-row, #panel .thread-card, #nav [data-view]';
function rowMenu(row,x,y){
  const id=row.dataset.id,change=proj().changes.find(c=>c.id===id),thread=S.threads?.find(t=>t.id===row.dataset.thread);
  const ref=change?.ref || row.querySelector('.ref')?.textContent.trim() || row.querySelector('td:nth-child(2)')?.textContent.trim() || row.querySelector('.name')?.textContent.trim() || change?.kind || id || row.textContent.trim().slice(0,160);
  const references=ref.split(',').map(s=>s.trim()),objectIndex=row.hasAttribute('data-obj')?+row.dataset.obj:(proj().objects || []).findIndex(o=>references.includes(o.ref)&&o.side==='head');
  const object=proj().objects?.[objectIndex],view=change?viewOf(change):object?objView(object):row.dataset.view || S.v;
  const file=thread?.anchor.file || (view?.startsWith('lib:')?proj().libraries?.[+view.slice(4)]?.file:viewFile(proj(),view));
  let github=null;
  try{const repo=new URL(D.repo);if(repo.origin==='https://github.com' && file)github=`${repo.href.replace(/\/$/,'')}/blob/${encodeURIComponent(D.head)}/${file.split('/').map(encodeURIComponent).join('/')}`;}catch{}
  const go=()=>{if(id)goTo(id);else if(row.dataset.view)select(row.dataset.view);else if(objectIndex>=0)goToObject(objectIndex);else row.click();};
  const canGo=row.getAttribute('aria-disabled')!=='true' && (id || row.dataset.view || row.dataset.thread || (object && currentView(objView(object))));
  showBenchMenu([{label:'Go to',disabled:!canGo,run:go}, {label:'Copy reference',run:()=>benchCopy(ref)},...(github?[{label:'Open in GitHub',run:()=>window.open(github,'_blank','noopener,noreferrer')}]:[])],x,y,row);

}
document.addEventListener('contextmenu',e=>{const row=e.target.closest?.(benchRowSelector);if(row){e.preventDefault();rowMenu(row,e.clientX,e.clientY);}});
document.addEventListener('keydown',e=>{
  if(e.key!=='ContextMenu' && !(e.shiftKey&&e.key==='F10'))return;
  const row=e.target.closest?.(benchRowSelector),vp=e.target.closest?.('#stage .vp');if(!row&&!vp)return;e.preventDefault();e.stopImmediatePropagation();const r=(row||vp).getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(row)rowMenu(row,x,y);else if(placed())canvasMenu(vp,{clientX:x,clientY:y});
},true);
document.addEventListener('pointerdown',e=>{if(benchMenu&&!benchMenu.contains(e.target))closeBenchMenu(false);});
window.addEventListener('resize',()=>closeBenchMenu(false));
// Parts table rows are otherwise non-interactive; give their context actions a focus target.
new MutationObserver(()=>{for(const row of document.querySelectorAll('#panel .parts-row'))if(!row.hasAttribute('tabindex'))row.tabIndex=0;}).observe($('#panel'),{childList:true,subtree:true});

function showShortcuts() { const dialog=$("#shortcuts"); if(!dialog.open) dialog.showModal(); }
new MutationObserver(updateStatus).observe($("#panel"), {childList:true, subtree:true});   // change n/N follows any list rebuild or filter
$("#shortcuts-open").onclick=showShortcuts;
$("#shortcuts [data-close]").onclick=()=>$("#shortcuts").close();
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("#shortcuts").open) { e.preventDefault(); $("#shortcuts").close(); return; }
  if (e.target.closest?.('input,select,textarea,[contenteditable]:not([contenteditable="false"]),dialog[open]')) return;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === "?") { e.preventDefault(); showShortcuts(); return; }
  if (String(S.v).startsWith("sheet:") && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "u") {
    e.preventDefault(); S.units = S.units === "mm" ? "mil" : "mm"; updateSchematicStatus(); return;
  }
  if (boardKey(e)) { e.preventDefault(); return; }
  if (String(S.v).startsWith("sheet:") && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const parent = e.altKey && e.key === "ArrowUp", next = !e.altKey && e.key === "PageDown", previous = !e.altKey && e.key === "PageUp";
    if (parent || next || previous) { e.preventDefault(); navigateSheet(parent ? "parent" : next ? 1 : -1); return; }
  }
  if (e.target.closest?.("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
  if (arrow && e.target.closest?.("#panel, button, [role=slider]")) return;   // leave arrows to scrolling and widgets
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (e.key === "b" && S.v === '3d' && S.m === "blend") toggleBlend3D();
  else if (e.key === "c" && THREADS_ON && S.v && S.v !== "3d") { S.placing = !S.placing; document.body.classList.toggle("placing", S.placing); }
  else if (e.key === "f") fit();
  else if (e.key === "Escape") { stopPlacing(); S.s = null; markSelected(); draw(); saveHash(); }
});
function positionLink() {
  const where = S.v === "board" ? `${proj().name} board` : `${proj().name} sheet ${proj().sheets.find(s => `sheet:${s.path}` === S.v)?.name ?? ""}`;
  return `${D.links.review || D.repo} · ${where} #${encodeState()}`;
}
function applyGoTo(text) { const i = text.indexOf("#"); if (i >= 0) applyState(decodeState(text.slice(i))); }
function renderZoombar() {
  if (S.v === '3d' && window.Review3D) { window.Review3D.cameraBar(); return; }
  $("#zoombar").innerHTML = `<button data-z="0.8" aria-label="Zoom out" title="Zoom out (F2)">${tbIcon('zout')}</button><span class="pct" title="Zoom"></span><button data-z="1.25" aria-label="Zoom in" title="Zoom in (F1)">${tbIcon('zin')}</button><button data-act="fit" aria-label="Fit drawing (f)" title="Fit drawing to window (f)">${tbIcon('fit')}<span>Fit</span></button>`;
  for (const b of document.querySelectorAll("#zoombar [data-z]")) b.onclick = () => { if (placed()) setT({ z: S.z * +b.dataset.z }); };
  $("#zoombar [data-act=fit]").onclick = fit;
}
// Copy link and Go to left the toolbar; the header menu / review-bar overflow call these.
async function copyLink() {
  const link = positionLink(), msg = $("#statusbar .status-message");
  try {
    await navigator.clipboard.writeText(link);
    if (msg) { const was = msg.textContent; msg.textContent = "Copied link"; setTimeout(() => { msg.textContent = was; }, 1500); }
  } catch {   // no clipboard API (file://) or write refused: show the text selected so the user can press Cmd/Ctrl+C
    let f = $("input.copyfield[readonly]");
    if (!f) { f = document.createElement("input"); f.readOnly = true; f.className = "copyfield"; f.setAttribute("aria-label", "Link to copy"); document.body.append(f); }
    f.value = link; f.focus(); f.select();
  }
  return link;
}
window.krReview = Object.assign(window.krReview || {}, { copyLink, goTo: applyGoTo, positionLink });
renderZoombar();
function setDock(name, open) {
  if (name === "panel") {
    document.getElementById("app").classList.toggle("right-collapsed", !open);
    if (!open) { S.panelTable = false; document.getElementById("app").classList.remove("right-table"); }
  }
  if (name === "nav") { leftCollapsed = !open; syncLeftDock(); persistLeftDock(); }
  document.getElementById(name).classList.toggle("dock-open", open);
  document.querySelector(`[data-dock="${name}"]`).setAttribute("aria-expanded", String(open));
}
const wide = matchMedia("(min-width:900px)");
function syncDockButtons() {   // wide: toggles collapse a docked column; narrow: toggles the overlay
  for (const b of document.querySelectorAll("[data-dock]")) b.setAttribute("aria-expanded", String(wide.matches ? !(b.dataset.dock === "panel" ? $("#app").classList.contains("right-collapsed") : leftCollapsed) : $("#" + b.dataset.dock).classList.contains("dock-open")));
}
for (const b of document.querySelectorAll("[data-dock]")) b.onclick = () => {
  // Each dock owns its collapse state (splitter, persisted width).
  if (wide.matches) { setDock(b.dataset.dock, b.dataset.dock === "panel" ? $("#app").classList.contains("right-collapsed") : leftCollapsed); syncDockButtons(); return; }
  const open = b.getAttribute("aria-expanded") !== "true";
  if (matchMedia("(max-width:899px)").matches) setDock(b.dataset.dock === "nav" ? "panel" : "nav", false);
  setDock(b.dataset.dock, open);
};
wide.addEventListener("change", syncDockButtons); syncDockButtons();
for (const b of document.querySelectorAll("#change-nav [data-step]")) b.onclick = () => step(+b.dataset.step);

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

// bench-t6: one readout for change rows, inventory, geometry and check findings.
function inspectorProperties() {
  const p = proj(), row = p.changes.find(r => r.id === S.s) || allViolations().find(r => r.id === S.s);
  const selected = S.ig?.object || (S.io != null ? p.objects?.[S.io] : row);
  if (!selected) return null;
  const inventory = (p.objects || []).find(o => selected.uuid ? o.uuid === selected.uuid || o.uuid === selected.changeUuid : o.ref === selected.ref && o.kind === selected.kind && objView(o) === viewOf(selected));
  const base = Object.create(null), head = Object.create(null);
  const flatten = (target, object, prefix = "") => {
    for (const [key, value] of Object.entries(object || {})) {
      const name = prefix + key;
      if (value && !Array.isArray(value) && value === Object(value)) flatten(target, value, name + ".");
      else target[name] = value;
    }
  };
  const common = {...inventory, ...selected};
  for (const k of ["changes", "props", "before", "after", "pos_before"]) delete common[k];
  flatten(base, common); flatten(head, common);
  flatten(base, selected.props); flatten(head, selected.props);
  if (selected.pos_before) base.pos = selected.pos_before;
  const identity = selected.uuid || selected.changeUuid;
  const geometry = side => (decodedBoardScenes.get(p.board?.geometry?.[side]) || (boardDiff?.project === S.p ? boardDiff.scenes[side] : null))?.objects.filter(o => identity && (o.uuid === identity || o.changeUuid === identity)) || [];
  for (const [side, target] of [["base", base], ["head", head]]) {
    const objects = geometry(side), root = objects.find(o => o.uuid === identity);
    if (root?.layers?.length && target.layers == null) target.layers = root.layers;
    const pads = objects.filter(o => o.kind === "pad");
    if (pads.length) target.Pads = pads.length;
    const scene = decodedBoardScenes.get(p.board?.geometry?.[side]) || boardDiff?.scenes[side];
    const nets = [...new Set(objects.map(o => scene?.nets?.find(n => n.id === o.net)?.name).filter(Boolean))];
    if (nets.length) target.Nets = nets;
    objects.forEach((o, i) => flatten(target, o, objects.length > 1 ? `geometry ${i+1}.` : "geometry."));
  }
  const ref = selected.ref || inventory?.ref;
  const part = p.parts?.lines?.find(l => l.refs?.includes(ref));
  if (part) { flatten(base, part, "part."); flatten(head, part, "part."); }
  for (const change of p.parts?.changes || []) if (change.refs?.includes(ref)) {
    flatten(base, change.before, "part."); flatten(head, change.after, "part.");
  }
  flatten(base, selected.before); flatten(head, selected.after);
  for (const [key, a, b] of selected.changes || []) { base[key] = a; head[key] = b; }
  if (selected.action === "added" || selected.added) for (const k of Object.keys(base)) delete base[k];
  if (selected.action === "removed" || selected.side === "base") for (const k of Object.keys(head)) delete head[k];
  // Position components get their own measured readouts; retain all other source fields.
  for (const target of [base, head]) if (Array.isArray(target.pos)) {
    target["X (mm)"] = target.pos[0]; target["Y (mm)"] = target.pos[1];
    if (target.pos.length > 2) target["Rotation (°)"] = target.pos[2];
    delete target.pos;
  }
  return {selected, base, head};
}
function renderInspector() {
  const dock = $("#inspector"); if (!dock) return;
  const data = inspectorProperties(), title = data?.selected.ref || data?.selected.type || data?.selected.kind || "";
  const flat = v => Array.isArray(v) && v.every(x => x == null || x !== Object(x));
  const value = v => v == null ? "—" : flat(v) ? v.join(", ") : v === Object(v) ? JSON.stringify(v) : String(v);
  // Arrays of plain values (Nets, layers) read as a list, not raw JSON.
  const html = (v, text) => flat(v) && v.length > 1 && v.every(x => x === String(x)) ? `<ul class="insp-list">${v.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : esc(text);
  const groups = Array.from({length:4}, () => ({main:[], geometry:[]}));
  const order = ["ref", "value", "Value", "kind", "footprint", "Footprint", "uuid", "X (mm)", "Y (mm)", "Rotation (°)", "position", "layer", "layers"];
  const keys = data ? [...new Set([...Object.keys(data.base), ...Object.keys(data.head)])] : [];
  keys.sort((a,b) => (order.includes(a) ? order.indexOf(a) : 100) - (order.includes(b) ? order.indexOf(b) : 100));
  if (data) for (const key of keys) {
    const k = key.toLowerCase(), leaf = k.split(".").at(-1);
    const group = /^(x \(mm\)|y \(mm\)|rotation|position|pos|box|layer|layers|angle|where|sheet|board|locked)/.test(leaf) ? 1
      : /net|pad|pin|clearance|drill|width|size|electrical|items|severity|description|check/.test(leaf) ? 2
      : /^(ref|refs|value|kind|type|uuid|id|footprint|changeuuid|changeids)$/.test(leaf) ? 0 : 3;
    const a = value(data.base[key]), b = value(data.head[key]), changed = a !== b;
    const label = ({ref:"Reference", value:"Value", kind:"Type", footprint:"Footprint", uuid:"UUID"})[key] || key;
    groups[group][key.startsWith("geometry") ? "geometry" : "main"].push(`<dt>${esc(label).replace(/\./g, ".<wbr>")}</dt><dd>${changed ? `<del>${html(data.base[key], a)}</del> <span class="insp-arrow" aria-label="to">→</span> <ins>${html(data.head[key], b)}</ins>` : html(data.head[key], b)}</dd>`);
  }
  dock.innerHTML = `<header class="insp-head"><span class="insp-label">Inspector</span><strong>${esc(title)}</strong>${data?.selected.action ? `<span class="badge ${esc(data.selected.action)}">${esc(data.selected.action)}</span>` : ""}<span class="insp-ticks"></span><button type="button" id="insp-toggle" aria-label="${inspectorClosed ? "Expand" : "Collapse"} inspector" aria-controls="insp-body" aria-expanded="${!inspectorClosed}" title="${inspectorClosed ? "Expand" : "Collapse"} inspector">${inspectorClosed ? "▴" : "▾"}</button></header><div id="insp-body" ${inspectorClosed ? "hidden" : ""}>${data ? groups.map((rows, i) => `<section class="insp-module"><h4>${["Identity", "Placement · base → head", "Electrical", "Fields & flags"][i]}</h4><dl>${rows.main.join("") || `<dt class="muted">${rows.geometry.length ? "See geometry" : "Not in report"}</dt>`}</dl>${rows.geometry.length ? `<details class="insp-geometry"><summary>Geometry · ${rows.geometry.length} properties</summary><dl>${rows.geometry.join("")}</dl></details>` : ""}</section>`).join("") : '<p class="insp-empty">Select an object, change or check finding to inspect its properties.<br><span class="muted">Base → head · only data present in this report is shown.</span></p>'}</div>`;
  $("#insp-toggle").onclick = () => { inspectorClosed = !inspectorClosed; inspectorLayout(); persistInspector(); renderInspector(); };
}
let inspectorHeight = 176, inspectorClosed = false;
try { const saved = JSON.parse(localStorage.getItem("kr.inspector") || "null"); if (saved) { inspectorHeight = Number(saved.height) || 176; inspectorClosed = saved.closed === true; } } catch {}
function persistInspector() { try { localStorage.setItem("kr.inspector", JSON.stringify({height:inspectorHeight, closed:inspectorClosed})); } catch {} }
function inspectorLayout() {
  const max = Math.max(96, $("#center").clientHeight - 120);
  inspectorHeight = Math.min(Math.max(96, inspectorHeight), max);
  $("#center").style.setProperty("--inspector-size", (inspectorClosed ? 28 : inspectorHeight) + "px");
  const split = $("#insp-split");
  split.setAttribute("aria-valuemin", "96"); split.setAttribute("aria-valuemax", String(max)); split.setAttribute("aria-valuenow", String(Math.round(inspectorHeight)));
}
const inspectorSplitter = $("#insp-split");
inspectorSplitter.onpointerdown = e => {
  if (e.button !== 0) return;
  e.preventDefault(); inspectorSplitter.setPointerCapture(e.pointerId);
  const y = e.clientY, height = inspectorHeight;
  inspectorClosed = false; renderInspector();
  inspectorSplitter.onpointermove = ev => { inspectorHeight = height + y - ev.clientY; inspectorLayout(); };
  inspectorSplitter.onpointerup = inspectorSplitter.onpointercancel = () => { inspectorSplitter.onpointermove = null; persistInspector(); };
};
inspectorSplitter.onkeydown = e => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
  e.preventDefault(); inspectorClosed = false;
  inspectorHeight = e.key === "Home" ? 96 : e.key === "End" ? $("#center").clientHeight - 120 : inspectorHeight + (e.key === "ArrowUp" ? 16 : -16);
  inspectorLayout(); persistInspector(); renderInspector();
};
new ResizeObserver(inspectorLayout).observe($("#center"));
inspectorLayout();
function bindRightDock() {
  const app = document.getElementById("app"), panel = document.getElementById("panel");
  if (!["parts", "checks"].includes(rightTab)) S.panelTable = false;
  app.classList.toggle("right-table", !!S.panelTable);
  panel.classList.toggle("dock-wide", !!S.panelWide);
  for (const cell of panel.querySelectorAll(".parts-table td")) if (!cell.title) cell.title = cell.textContent;
  if (S.panelTable && S.t === "checks" && panel.querySelector(".checks-list")) {
    const list = panel.querySelector(".checks-list"), findings = new Map(proj().checks.flatMap(c => c.violations.map(v => [v.id, {...v, check:c.title}])));
    const table = document.createElement("table"); table.className = "checks-table";
    table.innerHTML = '<thead><tr><th>State</th><th>Check / rule</th><th>Location / actions</th><th>Description</th></tr></thead>';
    const body = table.createTBody();
    for (const button of list.querySelectorAll(".viol")) {
      const v = findings.get(button.dataset.id); if (!v) continue;
      const row = body.insertRow();
      row.insertCell().textContent = `${v.severity}${v.new ? " · NEW" : ""}${v.waived ? " · WAIVED" : ""}`;
      row.insertCell().textContent = `${v.check} / ${v.type}`;
      const cell = row.insertCell();
      const actions = []; let next = button.nextElementSibling;
      while (next && !next.matches(".viol")) { actions.push(next); next = next.nextElementSibling; }
      cell.append(button, ...actions);
      row.insertCell().textContent = v.description;
    }
    if (body.rows.length) list.replaceChildren(table);
  }
  panel.querySelector("[data-panel-close]").onclick = () => { setDock("panel", false); document.querySelector('[data-dock="panel"]')?.focus(); };
  panel.querySelector("[data-panel-wide]").onclick = () => {
    const wide = !S.panelWide;
    resizeRightDock(wide ? 700 : 360);
    renderPanel(); panel.querySelector("[data-panel-wide]")?.focus();
  };
  const coverage = panel.querySelector(".bom-coverage");
  if (coverage) {
    coverage.title = [...coverage.querySelectorAll(".coverage-item")].map(item => item.title).join("\n");
    coverage.setAttribute("aria-label", "BOM coverage: " + coverage.title);
  }
  const table = panel.querySelector("[data-panel-table]");
  if (table) table.onclick = () => { S.panelTable = !S.panelTable; renderPanel(); panel.querySelector("[data-panel-table]")?.focus(); };
}
let rightDockWidth = 360;
try { rightDockWidth = Math.max(300, Math.min(700, +localStorage.getItem("kr.rightDockWidth") || 360)); } catch {}
document.documentElement.style.setProperty("--panel-w", rightDockWidth + "px");
const rightSplitter = document.createElement("div");
rightSplitter.id = "right-splitter"; rightSplitter.tabIndex = 0;
rightSplitter.setAttribute("role", "separator"); rightSplitter.setAttribute("aria-label", "Resize right dock");
rightSplitter.setAttribute("aria-orientation", "vertical");
document.getElementById("app").append(rightSplitter);
function resizeRightDock(width, persist = true) {
  rightDockWidth = Math.round(Math.max(300, Math.min(700, width)));
  S.panelWide = rightDockWidth === 700;
  document.documentElement.style.setProperty("--panel-w", rightDockWidth + "px");
  rightSplitter.setAttribute("aria-valuenow", rightDockWidth);
  rightSplitter.setAttribute("aria-valuemin", "300"); rightSplitter.setAttribute("aria-valuemax", "700");
  document.getElementById("panel").classList.toggle("dock-wide", S.panelWide);
  if (persist) try { localStorage.setItem("kr.rightDockWidth", rightDockWidth); } catch {}
}
resizeRightDock(rightDockWidth, false);
rightSplitter.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault(); rightSplitter.setPointerCapture(event.pointerId);
  rightSplitter.onpointermove = e => resizeRightDock(document.getElementById("app").getBoundingClientRect().right - e.clientX);
  rightSplitter.onpointerup = () => { rightSplitter.onpointermove = null; renderPanel(); };
  rightSplitter.onpointercancel = () => { rightSplitter.onpointermove = null; };
};
rightSplitter.onkeydown = event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault(); resizeRightDock(event.key === "Home" ? 300 : event.key === "End" ? 700 : rightDockWidth + (event.key === "ArrowLeft" ? 20 : -20)); renderPanel();
};
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && S.panelTable) {
    event.preventDefault(); event.stopImmediatePropagation(); S.panelTable = false; renderPanel();
    document.querySelector("[data-panel-table]")?.focus();
  }
}, true);
if (!matchMedia("(max-width:899px)").matches) document.querySelector('[data-dock="panel"]').setAttribute("aria-expanded", "true");

renderHeader();
const shotMode = !!new URLSearchParams(location.hash.slice(1)).get("shot");
if (shotMode) document.body.classList.add("shot");
function start() {
  const drawn = applyState(decodeState(location.hash));
  return drawn.then(async () => {
    if (shotMode) {
      const v = currentView(); if (v) { const boxes = await computeRegions(v); if (boxes.length) zoomTo([boxes[0].x0, boxes[0].y0, boxes[0].x1, boxes[0].y1], 4); }
      document.title = "ready";
    }
  }).catch(e => console.error(e)).finally(() => { window.reviewReady = true; if (parent !== window) parent.postMessage(readyMessage(), "*"); });   // cmd_shots must never wait out its budget
}
start();
window.addEventListener("hashchange", () => applyState(decodeState(location.hash)));
