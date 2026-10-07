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
    if (!REVIEW_DATA.projects[0].name.startsWith("vme")) return true;   // only meaningful on the dense page
    await new Promise(r => setTimeout(r, 3000));
    const t = []; let last = performance.now();
    for (let f = 0; f < 120; f++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); t.push(n - last); last = n;
      gesture(); setT({ x: S.x + 0.3, z: S.z * (f < 60 ? 1.02 : 1 / 1.02) }); }
    t.sort((a, b) => a - b); console.log("p95", t[114]); return t[114] <= 20;`],
];
