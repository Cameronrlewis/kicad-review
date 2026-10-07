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
  ["reused sheet: two navigator entries, separate counts", "", `
    const files = REVIEW_DATA.projects.flatMap(p => p.sheets.map(s => s.file)); const dup = files.find((f, i) => files.indexOf(f) !== i);
    if (!dup) return true;   // the committed sample has no reused sheet; covered by the vme/video local samples
    return document.querySelectorAll('#nav [data-view^="sheet:"]').length === REVIEW_DATA.projects[S.p].sheets.length;`],
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
];
