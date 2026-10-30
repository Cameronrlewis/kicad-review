"use strict";
// Ask answers: a small Markdown subset rendered as escaped HTML. Model text is data, never markup.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const REF = /\[([^\[\]\n]+)\]/g;
  const CODE = /`([^`\n]+)`/g;
  const SLOT = /(\d+)/g;
  // Code spans and citations become placeholders before bold runs, so emphasis can wrap them and never sees their text.
  function inline(text, known) {
    const slots = [];
    const hold = html => `${slots.push(html) - 1}`;
    const s = text.replace(/[]/g, "")
      .replace(CODE, (_, code) => hold(`<code>${esc(code)}</code>`))
      .replace(REF, (whole, body) => {
        const net = body.startsWith("net:"), name = net ? body.slice(4) : body;
        if (!name) return whole;
        const exists = net ? known.net(name) : known.ref(name);
        if (!net && !exists && !/^[A-Za-z]+\d+\w*$/.test(name)) return whole;
        return hold(exists
          ? `<button type="button" class="ask-link" data-ask-${net ? "net" : "ref"}="${esc(name)}">${esc(name)}</button>`
          : `<span class="ask-link missing" title="Not found in this design">${esc(name)}</span>`);
      });
    return esc(s).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(SLOT, (_, i) => slots[i]);
  }
  function render(text, known) {
    const html = [];
    let list = null;
    const flush = () => { if (list) { html.push(`<ul>${list.join("")}</ul>`); list = null; } };
    for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (item) { (list ||= []).push(`<li>${inline(item[1], known)}</li>`); continue; }
      flush();
      if (line.trim()) html.push(`<p>${inline(line.trim(), known)}</p>`);
    }
    flush();
    return html.join("");
  }
  window.KrAsk = { render, esc };
})();
