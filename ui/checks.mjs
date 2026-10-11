// [name, url hash, body of an async function that returns true when the check passes]
export const CHECKS = [
  ["loads sample", "", `return REVIEW_DATA.version === 1 && document.querySelector("#nav") !== null;`],
  ["header shows repo, revisions, review link and verdict", "", `
    const h = document.querySelector("#hdr").textContent;
    return h.includes("kicad-review-test") && h.includes(REVIEW_DATA.head.slice(0, 7))
      && document.querySelector('#hdr a[href$="/pull/2"]') !== null && /failing|passing/.test(h);`],
  ["navigator lists every project, sheet and board with counts", "", `
    let boards = 0, ok = true;
    for (let i = 0; i < REVIEW_DATA.projects.length; i++) {
      openProject(i);
      const items = [...document.querySelectorAll("#nav [data-view]")];
      boards += items.filter(e => e.dataset.view === "board").length;
      ok = ok && items.length === REVIEW_DATA.projects[i].sheets.length + 1 && items.every(e => e.querySelector(".counts"));
    }
    return REVIEW_DATA.projects.length === 2 && boards === 2 && ok;`],
  ["unchanged sheet still reachable", "", `
    const u = document.querySelector('#nav [data-status="unchanged"]');
    return u === null || !u.hasAttribute("aria-disabled");`],
  ["added project with no base renders without errors", "p=0", `return S.p === 0 && document.querySelector("#nav").textContent.includes("added");`],
  ["address picks project and view; bad values fall back", "p=9&v=sheet:/nope/&x=abc", `
    return S.p === 0 && S.v !== "sheet:/nope/" && Number.isFinite(S.x);`],
  ["sheet draws base and head, side by side", "p=1", `
    await new Promise(r => setTimeout(r, 800));
    return document.querySelectorAll("#stage .vp").length === 2 && document.querySelectorAll("#stage svg").length >= 2;`],
  ["wheel zoom keeps both panes in step", "", `
    await new Promise(r => setTimeout(r, 800));
    const vp = document.querySelector("#stage .vp");
    vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    await new Promise(r => requestAnimationFrame(r));
    const t = [...document.querySelectorAll("#stage .world")].map(w => w.style.transform);
    return t.length === 2 && t[0] === t[1] && S.z > 0;`],
  ["will-change only during a gesture", "", `
    await new Promise(r => setTimeout(r, 800));
    const w = document.querySelector("#stage .world");
    document.querySelector("#stage .vp").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    const during = getComputedStyle(w).willChange; await new Promise(r => setTimeout(r, 300));
    return during === "transform" && getComputedStyle(w).willChange === "auto";`],
  ["dense board pans at 60 fps", "v=board", `
    if (!REVIEW_DATA.projects[0].name.startsWith("vme")) return true;   // only meaningful on the dense page (default layers)
    await new Promise(r => setTimeout(r, 3000));
    const t = []; let last = performance.now();
    for (let f = 0; f < 120; f++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); t.push(n - last); last = n;
      gesture(); setT({ x: S.x + 0.3, z: S.z * (f < 60 ? 1.02 : 1 / 1.02) }); }
    t.sort((a, b) => a - b); console.log("p95", t[114]); return t[114] <= 20;`],
  ["hash without p keeps its other params", "v=board", `return S.p === 0 && S.v === "board";`],
  ["fit frames all drawn content in every pane", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 2500));
    const bad = [];
    for (const vp of document.querySelectorAll("#stage .vp")) {
      const R = vp.getBoundingClientRect();
      for (const l of vp.querySelectorAll(".layer")) {
        let u = null;
        for (const g of l.querySelectorAll("svg > g")) { const r = g.getBoundingClientRect(); if (!r.width && !r.height) continue;
          u = u ? [Math.min(u[0], r.left), Math.min(u[1], r.top), Math.max(u[2], r.right), Math.max(u[3], r.bottom)] : [r.left, r.top, r.right, r.bottom]; }
        if (u && (u[0] < R.left - 1 || u[1] < R.top - 1 || u[2] > R.right + 1 || u[3] > R.bottom + 1)) bad.push(l.dataset.layer + " " + u.map(Math.round) + " in " + [R.left, R.top, R.right, R.bottom].map(Math.round));
      }
    }
    return bad.length ? bad.slice(0, 3).join(" ; ") : document.querySelectorAll("#stage .layer").length > 0;`],
  ...["side", "overlay", "wipe", "blend", "semantic"].map(m => [`mode ${m} draws`, `m=${m}`, `
    await new Promise(r => setTimeout(r, 800));
    return S.m === "${m}" && document.querySelector("#stage").classList.contains("mode-${m}")
      && document.querySelector('#modes [aria-pressed="true"]').dataset.mode === "${m}";`]),
  ["wipe divider follows drag", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector("#stage .divider"), r = d.parentElement.getBoundingClientRect();
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: r.left + r.width / 2 }));
    d.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.25 }));
    d.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    return Math.abs(S.wipe - 0.25) < 0.02;`],
  ["blend slider sets head opacity", "m=blend", `
    await new Promise(r => setTimeout(r, 800));
    const s = document.querySelector("#modes input[type=range]"); s.value = 20; s.dispatchEvent(new Event("input"));
    return getComputedStyle(document.querySelector("#stage .stack.head")).opacity === "0.2";`],
  ["added project draws its one side in every mode", "p=0&m=overlay", `
    await new Promise(r => setTimeout(r, 800)); return document.querySelectorAll("#stage .stack.head svg").length > 0;`],
  ["layer list grouped, changed layers marked", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    const L = document.querySelector("#layers");
    return ["Top", "Bottom"].every(g => L.textContent.includes(g))
      && L.querySelectorAll('[data-changed="true"] .mark').length === REVIEW_DATA.projects[1].board.layers.filter(l => l.changed).length;`],
  ["toggling a layer removes it from the drawing", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    const cb = document.querySelector('#layers input[data-layer="F_Cu"]'); cb.click();
    await new Promise(r => setTimeout(r, 800));
    return !document.querySelector('#stage .layer[data-layer="F_Cu"]') && !S.layers.includes("F_Cu");`],
  ["layer list hidden for sheets", "", `return document.querySelector("#layers").children.length === 0;`],
  ["hitTest picks the smallest containing box, cycles on repeat", "", `
    const rows = [{ id: "a", box: [0, 0, 10, 10] }, { id: "b", box: [4, 4, 6, 6] }, { id: "c", box: [20, 20, 30, 30] }];
    return hitTest(rows, 5, 5)?.id === "b" && hitTest(rows, 5, 5, rows[1])?.id === "a" && hitTest(rows, 50, 50) === null
      && hitTest(rows, 10.4, 5)?.id === "a";`],
  ["filters by kind and by action", "", `
    const total = document.querySelectorAll("#panel .card").length;
    document.querySelector('#panel .chip-filter[data-action="added"]').click();
    const noAdded = [...document.querySelectorAll("#panel .card")].every(c => c.dataset.action !== "added");
    const kinds = document.querySelector("#panel select.kind"); kinds.value = "symbol"; kinds.dispatchEvent(new Event("change"));
    return total > 0 && noAdded && [...document.querySelectorAll("#panel .card")].every(c => c.dataset.kind === "symbol");`],
  ["modified card shows every changed property old and new", "p=1", `
    const r = REVIEW_DATA.projects[1].changes.find(r => r.action === "modified");
    const card = document.querySelector('#panel .card[data-id="' + r.id + '"]');
    return r.changes.every(([k, a, b]) => card.textContent.includes(k) && card.textContent.includes(String(b ?? "—")));`],
  ["selecting a row zooms to it and highlights it", "p=1", `
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    document.querySelector('#panel .card[data-id="' + r.id + '"]').click();
    await new Promise(res => setTimeout(res, 1200));
    return S.s === r.id && S.v === "board" && Math.abs(S.x - (r.box[0] + r.box[2]) / 2) < 0.01
      && document.querySelector("#stage .marker.sel") !== null
      && document.querySelector('#panel .card[data-id="' + r.id + '"]').getAttribute("aria-selected") === "true";`],
  ["clicking the drawing selects the row", "p=1&v=board", `
    await new Promise(res => setTimeout(res, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    zoomTo(r.box); await new Promise(res => requestAnimationFrame(res));
    const vp = document.querySelector("#stage .vp"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    return S.s === r.id && document.querySelector('#panel .card[aria-selected="true"]')?.dataset.id === r.id;`],
  ["markers differ by more than colour", "p=1&v=board&m=semantic", `
    await new Promise(res => setTimeout(res, 1200));
    const m = [...document.querySelectorAll("#stage .marker")];
    const styles = new Set(m.map(e => getComputedStyle(e).borderStyle + "|" + e.dataset.glyph));
    return m.length > 0 && m.every(e => e.dataset.glyph) && styles.size === new Set(m.map(e => e.dataset.action)).size;`],
  ["reused sheet: two navigator entries, separate counts", "p=1", `
    const P = REVIEW_DATA.projects[1], s0 = P.sheets[0];
    P.sheets.push({ ...s0, path: "/copy/", name: "Copy of " + s0.name, parent: s0.path });
    P.changes.push({ action: "added", kind: "symbol", ref: "R99", where: { sheet: "/copy/" }, pos: [10, 10, 0], box: null, props: { Value: "1k" }, id: "cx1" });
    renderNav();
    const a = document.querySelector('#nav [data-view="sheet:/"]'), b = document.querySelector('#nav [data-view="sheet:/copy/"]');
    const n = e => e.querySelector(".chip.added").textContent;
    return a && b && n(b) === "＋1" && n(a) !== n(b) && document.querySelectorAll('#nav [data-view^="sheet:"]').length === 2;`],
  ["panel scrolls instead of stretching the page", "p=1", `
    await new Promise(res => setTimeout(res, 1200));
    const cards = document.querySelector("#panel .cards"), one = cards.innerHTML;
    cards.innerHTML = one.repeat(150);
    const p = document.querySelector("#panel"), vp = document.querySelector("#stage .vp");
    return document.documentElement.scrollHeight <= innerHeight + 1 && p.scrollHeight > p.clientHeight && vp.clientHeight <= innerHeight;`],
  ["search keeps caret and raw text while typing", "p=1", `
    const q = document.querySelector("#panel .q"); q.focus();
    for (const t of ["R", "R1", "R12"]) { q.value = t; q.dispatchEvent(new Event("input")); }
    const cs = [...document.querySelectorAll("#panel .card")];
    return document.querySelector("#panel .q") === q && q.value === "R12" && cs.length > 0 && cs.every(c => c.textContent.includes("R12"));`],
  ["filter chips and tabs show their state", "p=1", `
    const chip = document.querySelector('#panel .chip-filter[data-action="added"]'), on = getComputedStyle(chip);
    const onBg = on.backgroundColor, onDeco = on.textDecorationLine;
    chip.click();
    const off = getComputedStyle(document.querySelector('#panel .chip-filter[data-action="added"]'));
    const tab = getComputedStyle(document.querySelector('#panel [role=tab][aria-selected="true"]')), t2 = getComputedStyle(document.querySelector('#panel [role=tab][aria-selected="false"]'));
    return off.backgroundColor !== onBg && off.textDecorationLine !== onDeco && tab.backgroundColor !== t2.backgroundColor;`],
  ["clicking the Base pane selects the moved row at its old place", "p=1&v=board", `
    await new Promise(res => setTimeout(res, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    const o = r.pos_before; zoomTo([o[0] - 3, o[1] - 1, o[0] - 0, o[1] + 1], 1);   // centre = 1.5 mm left of the old centre: inside the Base box, outside the Head box
     await new Promise(res => requestAnimationFrame(res));
    const vp = document.querySelector("#stage .vp.board"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    return S.s === r.id;`],
  ["checks summary rows show every count", "p=1&t=checks", `
    const P = REVIEW_DATA.projects[1], rows = [...document.querySelectorAll("#panel .checks-summary .check")];
    return rows.length === 4 && P.checks.every(c => { const t = rows.find(r => r.dataset.checkSummary === c.name)?.textContent || "";
      return t.includes(c.title) && t.includes(c.errors + " errors") && t.includes(c.warnings + " warnings") && t.includes(c.new_errors + c.new_warnings ? "+" + (c.new_errors + c.new_warnings) + " new" : ""); });`],
  ["checks summary status and title do not intersect in a 300px panel", "p=1&t=checks", `
    const app = document.querySelector("#app"), prior = app.style.gridTemplateColumns;
    app.style.gridTemplateColumns = "220px minmax(0, 1fr) 300px";
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const rows = [...document.querySelectorAll("#panel .checks-summary .check")];
    const ok = document.querySelector("#panel").getBoundingClientRect().width === 300 && rows.length > 0 && rows.every(row => {
      const status = row.querySelector(".check-status"), title = row.querySelector(".check-title");
      return !overlaps(status.getBoundingClientRect(), title.getBoundingClientRect());
    });
    app.style.gridTemplateColumns = prior; return ok;`],
  ["checks summary marks turned-off checks not run", "p=1&t=checks", `
    const keep = REVIEW_DATA.settings.checks.drc; REVIEW_DATA.settings.checks.drc = "off"; renderPanel();
    const row = document.querySelector('#panel .check-not-run[data-check-summary="drc"]'), ok = row && row.textContent.includes("— not run") && row.textContent.includes("turned off in kicad-review.toml");
    REVIEW_DATA.settings.checks.drc = keep; renderPanel(); return !!ok;`],
  ["checks scope and severity chips use non-struck segmented controls", "p=1&t=checks", `
    const scope = document.querySelector('[data-check-scope="new"]'), all = document.querySelector('[data-check-scope="all"]'), severity = document.querySelector('[data-check-severity="error"]');
    const plain = getComputedStyle(all), toggle = getComputedStyle(severity);
    return scope.classList.contains("check-chip") && all.classList.contains("check-chip") && severity.classList.contains("check-chip")
      && plain.textDecorationLine === "none" && toggle.textDecorationLine === "none" && plain.borderStyle === "solid";`],
  ["passing checks with baseline findings say no new errors", "p=1&t=checks", `
    const c = REVIEW_DATA.projects[1].checks.find(c => c.errors > 0); if (!c) return true;
    const old = [REVIEW_DATA.settings.fail_on, c.status, c.new_errors];
    REVIEW_DATA.settings.fail_on = "new"; c.status = "pass"; c.new_errors = 0; renderPanel();
    const row = document.querySelector('[data-check-summary="' + c.name + '"]');
    const ok = row.querySelector(".check-status").textContent.includes("passing") && row.querySelector(".check-status-detail").textContent.includes("no new errors");
    [REVIEW_DATA.settings.fail_on, c.status, c.new_errors] = old; renderPanel(); return ok;`],
  ["checks scope chips default to new and switch to all", "p=1&t=checks", `
    const newChip = document.querySelector('[data-check-scope="new"]'), allChip = document.querySelector('[data-check-scope="all"]');
    const onlyNew = newChip.getAttribute("aria-pressed") === "true" && [...document.querySelectorAll("#panel .viol")].every(v => v.dataset.new === "true");
    allChip.click(); return onlyNew && document.querySelector('[data-check-scope="all"]').getAttribute("aria-pressed") === "true" && document.querySelectorAll('#panel .viol[data-new="false"]').length > 0;`],
  ["checks violations group by rule with new groups open first", "p=1&t=checks", `
    document.querySelector('[data-check-scope="all"]').click();
    const groups = [...document.querySelectorAll("#panel .check-group")], keys = new Set(groups.map(g => g.querySelector(".rule").textContent));
    const expected = new Set(REVIEW_DATA.projects[1].checks.flatMap(c => c.violations.map(v => c.name + "\\0" + v.type)));
    const newGroups = groups.filter(g => g.querySelector('.viol[data-new="true"]'));
    return groups.length >= keys.size && groups.length === expected.size && newGroups.every(g => g.open) && groups.slice(0, newGroups.length).every(g => g.querySelector('.viol[data-new="true"]'));`],
  ["clicking a located violation selects it and moves the drawing", "p=1&t=checks", `
    S.v = "board"; await draw(); S.checks.scope = "all"; renderPanel();
    const v = REVIEW_DATA.projects[1].checks.flatMap(c => c.violations).find(v => v.where?.board && v.pos), el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'); el.click();
    await new Promise(r => setTimeout(r, 1200));
    return S.s === v.id && Math.abs(S.x - (v.box ? (v.box[0] + v.box[2]) / 2 : v.pos[0])) < .01 && document.querySelector('#panel .viol[data-id="' + v.id + '"]').getAttribute("aria-selected") === "true";`],
  ["j steps through rendered checks violations", "p=1&t=checks", `
    S.v = "board"; await draw(); S.checks.scope = "all"; renderPanel(); S.s = null;
    const ids = [...document.querySelectorAll('#panel .viol[data-id]:not([aria-disabled])')].map(v => v.dataset.id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    return ids.length > 1 && S.s === ids[0];`],
  ["violation without position is listed and does not move", "p=1&t=checks", `
    S.checks.scope = "all"; const v = REVIEW_DATA.projects[1].checks[0].violations[0], old = [v.pos, v.box]; v.pos = null; v.box = null; renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'), before = [S.v, S.x, S.y]; el.click(); await new Promise(r => setTimeout(r, 300));
    const ok = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true" && S.v === before[0] && S.x === before[1] && S.s !== v.id;
    [v.pos, v.box] = old; renderPanel(); return ok;`],
  ["violation on an unrendered sheet has no location", "p=1&t=checks", `
    S.checks.scope = "all"; const P = REVIEW_DATA.projects[1], sh = P.sheets[0], old = [sh.status, sh.svg]; sh.status = "unchanged"; sh.svg = null;
    const v = P.checks.flatMap(c => c.violations).find(v => v.pos && v.where?.sheet === sh.path); renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'), ok = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true";
    [sh.status, sh.svg] = old; renderPanel(); return ok;`],
  ["state round-trips through the address", "", `
    const s = { p: 1, v: "board", m: "wipe", x: 158.8, y: 78.2, z: 12, s: "c5", t: "checks", layers: ["F_Cu", "Edge_Cuts"] };
    const back = decodeState(encodeState(s));
    return Object.keys(s).every(k => JSON.stringify(back[k]) === JSON.stringify(s[k]));`],
  ["address opens the exact spot", "p=1&v=board&m=overlay&x=158.8&y=78.2&z=12", `
    await new Promise(r => setTimeout(r, 1200));
    return S.p === 1 && S.v === "board" && S.m === "overlay" && S.x === 158.8 && S.z === 12;`],
  ["stale or malformed address falls back to first change", "p=9&v=sheet:/nope/&x=abc&s=c99999", `
    await new Promise(r => setTimeout(r, 1200));
    return S.p === 0 && S.v !== "sheet:/nope/" && Number.isFinite(S.x) && document.querySelectorAll("#stage svg").length > 0;`],
  ["j and k step through changes in list order", "p=1", `
    const ids = [...document.querySelectorAll("#panel .card")].map(c => c.dataset.id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    const a = S.s; document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    const b = S.s; document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" })); await new Promise(r => setTimeout(r, 900));
    return a === ids[0] && b === ids[1] && S.s === ids[0];`],
  ["keys ignored while typing in search", "p=1", `
    const q = document.querySelector("#panel .q"); q.focus();
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    return S.s === null;`],
  ["copy link carries review link and fragment; go-to applies a pasted line", "p=1&v=board&x=10&y=20&z=5", `
    await new Promise(r => setTimeout(r, 800));
    const l = positionLink();
    applyGoTo("see " + REVIEW_DATA.links.review + " #p=1&v=board&x=158.8&y=78.2&z=12");
    await new Promise(r => setTimeout(r, 800));
    return l.includes(REVIEW_DATA.links.review) && l.includes("#p=1&v=board") && S.x === 158.8;`],
  ["copy link falls back to a selected readonly field when clipboard fails", "p=1&v=board", `
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ok = [undefined, { writeText: () => Promise.reject(new Error("denied")) }];
    for (const stub of ok) {
      Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
      document.querySelector("#zoombar [data-act=copy]").click(); await sleep(100);
      const f = document.querySelector("#zoombar input[readonly]");
      if (!f || f.value !== positionLink() || document.activeElement !== f || f.selectionStart !== 0 || f.selectionEnd !== f.value.length) return "bad " + (f && f.value);
      f.remove();
    }
    return true;`],
  ["copy link shows Copied when clipboard works", "p=1&v=board", `
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    const b = document.querySelector("#zoombar [data-act=copy]"); b.click();
    await new Promise(r => setTimeout(r, 100));
    const during = b.textContent;
    await new Promise(r => setTimeout(r, 1700));
    return during.includes("Copied") && b.textContent === "Copy link";`],
  ["theme follows the system and keeps text contrast", "", `
    const lum = c => { const [r, g, b] = c.match(/\\d+/g).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    const cs = getComputedStyle(document.body), a = lum(cs.color), b = lum(cs.backgroundColor);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    return ratio >= 4.5 && (dark ? b < 0.05 : b > 0.8) || JSON.stringify({ratio, dark, b});`],
  ["drawing background is KiCad's in both themes", "", `
    await new Promise(r => setTimeout(r, 800));
    return getComputedStyle(document.querySelector("#stage .vp.sheet")).backgroundColor === "rgb(245, 244, 239)";`],
  ["unchanged board: address, violation click and start-up do not throw", "p=1", `
    const P = REVIEW_DATA.projects[1]; P.board = { changed: false, layers: [], status: "modified" };
    const bv = P.checks.flatMap(c => c.violations).find(v => v.where?.board && v.pos);
    await applyState(decodeState("#p=1&v=board"));
    const addr = S.v !== "board";
    S.t = "checks"; renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + bv.id + '"]');
    const noLoc = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true";
    el.click(); await new Promise(r => setTimeout(r, 300));
    S.v = "board"; await draw(); const empty = !!document.querySelector("#stage .empty");
    window.reviewReady = false; history.replaceState(null, "", "#p=1&v=board&s=" + bv.id);
    await start();
    return (addr && noLoc && empty && window.reviewReady === true) || JSON.stringify({ addr, noLoc, empty, ready: window.reviewReady });`],
  ["change cards: long keys and values stay inside their cells", "p=0", `
    const P = REVIEW_DATA.projects[0], long = "Footprint_Library_With_A_Long_Name:SOME_VERY_LONG_FOOTPRINT_NAME_WITHOUT_ANY_BREAKS_0123456789";
    P.changes.unshift({ action: "modified", kind: "footprint", ref: "U1", where: { board: true }, pos: null, box: null, id: "cx2",
                        changes: [["net_settings.classes.Default.diff_pair_via_gap", long, long + "_B"]] },
                      { action: "added", kind: "design rules", ref: "x.kicad_pro", where: null, pos: null, box: null, id: "cx3",
                        props: { "net_settings.classes.Default.diff_pair_via_gap": "0.25", footprint: long } });
    renderPanel();
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const bad = [];
    for (const id of ["cx2", "cx3"]) {
      const c = document.querySelector('#panel .card[data-id="' + id + '"]');
      if (c.scrollWidth > c.clientWidth) bad.push(id + " scroll " + c.scrollWidth + ">" + c.clientWidth);
      for (const p of c.querySelectorAll(".prop")) { const r = [...p.children].map(e => e.getBoundingClientRect());
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (hit(r[i], r[j])) bad.push(id + " overlap " + i + "/" + j); }
    }
    return bad.length ? bad.join("; ") : true;`],
  ["added footprint card shows its footprint and layer", "p=0", `
    const r = REVIEW_DATA.projects[0].changes.find(r => r.kind === "footprint" && r.action === "added" && r.props.layer);
    const t = document.querySelector('#panel .card[data-id="' + r.id + '"]').textContent;
    return t.includes(r.props.footprint) && t.includes(r.props.layer) && /\\+\\d+ more/.test(t) && !t.includes("Datasheet");`],
  ["address with selection and position keeps the position", "p=1&v=board&x=150&y=100&z=8&s=c600", `
    await new Promise(r => setTimeout(r, 1200));
    return (S.x === 150 && S.y === 100 && S.z === 8 && S.s === "c600" && document.querySelector("#stage .marker.sel") !== null) || JSON.stringify([S.x, S.z, S.s]);`],
  ["address with only a selection zooms to it", "p=1&s=c600", `
    await new Promise(r => setTimeout(r, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.id === "c600");
    return (S.v === "board" && Math.abs(S.x - (r.box[0] + r.box[2]) / 2) < 0.01) || JSON.stringify([S.v, S.x]);`],
  ["overlay legend names its colours in words", "p=1&v=board&m=overlay", `
    await new Promise(r => setTimeout(r, 800));
    const t = document.querySelector("#stage .tag"), sw = [...t.querySelectorAll(".sw")].map(e => getComputedStyle(e).backgroundColor);
    return t.textContent.includes("red") && t.textContent.includes("green") && sw.length === 3 && new Set(sw).size === 3;`],
  ["wheel before the first fit does not blank the drawing", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    S.z = null;
    document.querySelector("#stage .vp").dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    await draw();
    return (Number.isFinite(S.z) && S.z > 0 && Number.isFinite(S.x)) || JSON.stringify([S.x, S.z]);`],
  ["unknown layer in the address draws the default layers", "p=1&v=board&l=Nope", `
    await new Promise(r => setTimeout(r, 800));
    return S.layers === null && document.querySelectorAll("#stage .layer").length > 0;`],
  ["removed project draws its Base in every mode", "p=0", `
    const P = REVIEW_DATA.projects[0]; P.status = "removed"; P.board.status = "removed";
    for (const s of P.sheets) { s.status = "removed"; s.svg = { base: s.svg.head, head: null }; }
    for (const l of P.board.layers) l.svg = { base: l.svg.head, head: null };
    const bad = [];
    for (const v of [P.sheets[0] && "sheet:" + P.sheets[0].path, "board"]) for (const m of Object.keys(MODE_NAMES)) {
      S.m = m; S.v = v; S.x = S.y = S.z = null; await draw();
      const vis = [...document.querySelectorAll("#stage .stack.base svg")].some(e => e.getBoundingClientRect().width > 0);
      if (!vis) bad.push(v + " " + m);
    }
    return bad.length ? bad.join(", ") : true;`],
  ["truncated navigator names carry the full name as a tooltip", "p=1", `
    REVIEW_DATA.projects[1].sheets[0].name = 'A "quoted" <very> long sheet name that will not fit the navigator width at all'; renderNav();
    const ns = [...document.querySelectorAll("#nav .tree .name")];
    return ns.length === 2 && ns[0].title === REVIEW_DATA.projects[1].sheets[0].name && ns.every(n => n.title && n.textContent.endsWith(n.title));`],
  ["mode switch updates the address", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    document.querySelector('#modes [data-mode="overlay"]').click();
    await new Promise(r => setTimeout(r, 1200));
    return location.hash.includes("m=overlay") || location.hash;`],
  ["clicking the drawing records the selection in the address", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    zoomTo(r.box); await new Promise(res => setTimeout(res, 300));
    const vp = document.querySelector("#stage .vp"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    await new Promise(res => setTimeout(res, 1200));
    return location.hash.includes("s=" + r.id) || location.hash;`],
  ["inherited object keys are not modes", "p=1&v=board&m=toString", `
    await new Promise(r => setTimeout(r, 800));
    return (S.m === "side" && document.querySelectorAll("#stage .vp").length === 2) || S.m;`],
  ["all layers off survives the address round trip", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    const back = valid(decodeState(encodeState({ ...S, layers: [] })));
    return Array.isArray(back.layers) && back.layers.length === 0 || JSON.stringify(back.layers);`],
  ["arrow keys on a focused card do not step or block scrolling", "p=1", `
    const c = document.querySelector("#panel .card"); c.focus();
    const e = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    c.dispatchEvent(e); await new Promise(r => setTimeout(r, 300));
    return (S.s === null && !e.defaultPrevented) || JSON.stringify([S.s, e.defaultPrevented]);`],
  ["selecting a row does not rebuild the panel", "p=1", `
    const list = document.querySelector("#panel .cards"), id = document.querySelector("#panel .card").dataset.id;
    goTo(id); await new Promise(r => setTimeout(r, 1500));
    return (list.isConnected && document.querySelector('#panel .card[data-id="' + id + '"]').getAttribute("aria-selected") === "true") || "rebuilt";`],
  ["a cancelled wipe drag stops tracking", "p=1&v=board&m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector("#stage .divider"), r = d.parentElement.getBoundingClientRect();
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: r.left + r.width / 2 }));
    d.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    d.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.1 }));
    return Math.abs(S.wipe - 0.5) < 0.02 || S.wipe;`],
  ["a capped change list says so", "p=1", `
    const p = REVIEW_DATA.projects[1], keep = p.changes;
    p.changes = Array.from({ length: 1600 }, (_, i) => ({ ...keep[0], id: "x" + i }));
    renderPanel(); const t = document.querySelector("#panel .cards").textContent; p.changes = keep; renderPanel();
    return t.includes("showing 1500 of 1600") || t.slice(-80);`],
  ["generated ids and enums are escaped in markup", "p=1", `
    const p = REVIEW_DATA.projects[1], r = p.changes[0], old = r.id; r.id = 'c"><b id=inj>';
    renderPanel(); const bad = !!document.querySelector("#inj"); r.id = old; renderPanel();
    return !bad || "injected";`],
  ["changes-only mode marks every located change, wires included", "p=0&v=sheet:/&m=semantic", `
    await new Promise(res => setTimeout(res, 1200));
    const want = proj().changes.filter(r => onView(r, S.v) && rowBox(r, "head")), w = document.querySelector("#stage .world");
    const n = w.querySelectorAll(".marker").length;
    return (want.some(r => r.kind === "wire") && n === want.length) || \`\${n} markers for \${want.length} changes\`;`],
  ["arrow keys step after a click on the drawing", "p=1", `
    document.activeElement?.blur(); S.s = null;  // a click on the drawing (a plain div) leaves focus on the body
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await new Promise(res => setTimeout(res, 300));
    return S.s !== null || "no step; focus on " + document.activeElement.tagName;`],
];
