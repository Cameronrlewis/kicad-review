const PARTS_PROBLEMS = { missing_lcsc: "missing LCSC number", bad_lcsc: "LCSC number malformed", lcsc_conflict: "one LCSC number on several values", missing_mpn: "MPN missing", out_of_stock: "out of stock", not_found: "not found at JLCPCB", discontinued: "discontinued", unavailable: "lookup unavailable" };
function partsAge(s) {
  if (!s || !s.fetched_at) return { text: `Supplier lookup not run${s && s.error ? `: ${esc(s.error)}` : ""}`, stale: true };
  const h = (Date.now() - Date.parse(s.fetched_at)) / 36e5;
  if (!Number.isFinite(h)) return { text: `JLCPCB data age unavailable: invalid timestamp ${esc(s.fetched_at)}`, stale: true };
  return { text: `JLCPCB data as of ${esc(s.fetched_at.replace("T", " ").slice(0, 16))} UTC (${h < 48 ? Math.round(h) + " h" : Math.round(h / 24) + " days"} old)`,
           stale: h > 24, warn: h > 6 };
}
function renderParts() {
  const parts = proj().parts, age = partsAge(parts.supplier), f = S.partsFilter;
  const changes = l => parts.changes.filter(r => r.action !== "removed" && r.refs.some(ref => l.refs.includes(ref)));
  const rows = parts.lines.map(l => ({ line: l, changes: changes(l) }));
  // Removed lines are not in the head BOM; keep them visible for change review.
  for (const r of parts.changes.filter(r => r.action === "removed")) rows.push({ line: { ...r.before, refs: r.refs }, changes: [r] });
  const shown = rows.filter(r => (!f.problems || blocking(r.line)) && (!f.changed || r.changes.length))
    .sort((a, b) => Number(blocking(b.line)) - Number(blocking(a.line)));
  return `<p class="parts-age${age.stale ? " stale" : age.warn ? " warn" : ""}">${age.text}</p>
    <div class="filters checks-filters">${[["problems", "Only problems"], ["changed", "Only changed"]].map(([k, label]) => `<button class="check-chip" data-parts-filter="${k}" aria-pressed="${f[k]}">${label}</button>`).join("")}</div>
    <div class="parts-scroll"><table class="parts-table"><thead><tr>${["Δ", "Refs", "Value / MPN", "LCSC", "JLCPCB", "PCBWay", "Datasheet"].map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${shown.map(({ line: l, changes: cs }) => {
      // A change row names only the refs it moved; the line's other refs did not change.
      const moved = [...new Set(cs.flatMap(r => r.refs))], refs = f.changed ? moved : l.refs;
      const changeText = field => {
        const old = [...new Set(cs.filter(r => r.before && r.after && r.before[field] !== r.after[field]).map(r => r.before[field] || "—"))];
        const who = moved.length && moved.length < l.refs.length ? ` (${moved.join(", ")})` : "";
        return esc(old.length ? `${old.join(", ")} → ${l[field] || "—"}${who}` : l[field] || "—");
      };
      const problems = l.problems.map(p => PARTS_PROBLEMS[p] || p);
      let stock = "—";
      if (parts.supplier?.error || parts.supplier && l.status === "unavailable") {
        stock = `unavailable${l.error || parts.supplier.error ? `: ${l.error || parts.supplier.error}` : ""}`;
      } else if (parts.supplier && parts.supplier.fetched_at) {
        stock = l.status === "ok" ? `${age.stale ? "" : "✔ "}${l.stock ?? "—"}${l.price != null ? ` $${l.price}` : ""}${l.category === "basic" ? " B" : l.category === "extended" ? ` Ext${l.fee != null ? ` (fee $${l.fee})` : ""}` : ""}${age.stale ? " (stale)" : ""}`
          : `${PARTS_PROBLEMS[l.status] || l.status || "—"}${l.stock != null ? ` (${l.stock})` : ""}${l.error ? `: ${l.error}` : ""}`;
      }
      const url = l.datasheet, sheet = /^https?:\/\//i.test(url || "") ? `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">pdf</a>` : "—";
      return `<tr class="parts-row${blocking(l) ? " problem" : ""}${cs.length ? " changed" : ""}${l.status === "unavailable" ? " unavailable" : ""}"><td title="${esc(cs.map(r => r.action).join(", "))}">${blocking(l) ? "⚠" : ""}${cs.map(r => ({added: "+", removed: "−", swapped: "~", value: "~", footprint: "~"})[r.action] || "").join("")}</td><td>${refs.map(r => moved.includes(r) ? `<strong>${esc(r)}</strong>` : esc(r)).join(", ")}</td><td>${changeText("value")}${l.mpn ? `<br>${esc(l.mpn)}` : ""}${cs.some(r => r.before && r.after && r.before.footprint !== r.after.footprint) ? `<small class="parts-footprint">footprint ${changeText("footprint")}</small>` : ""}${problems.length ? `<small class="parts-problems">${esc(problems.join(" · "))}</small>` : ""}</td><td>${changeText("lcsc")}</td><td class="parts-stock${age.stale ? " stale" : ""}">${esc(stock)}</td><td>${l.mpn ? "MPN ✔" : "MPN missing"}</td><td>${sheet}</td></tr>`;
    }).join("")}</tbody></table>${shown.length ? "" : '<p class="muted">No parts match these filters.</p>'}</div>`;
}
