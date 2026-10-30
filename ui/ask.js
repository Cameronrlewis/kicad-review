"use strict";
// Ask answers: a small Markdown subset rendered as escaped HTML. Model text is data, never markup.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const REF = /\[([^\[\]\n]+)\]/g;
  const emphasis = t => esc(t).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`\n]+)`/g, "<code>$1</code>");
  function inline(text, known) {
    let out = "", last = 0;
    for (const m of text.matchAll(REF)) {
      const net = m[1].startsWith("net:"), name = net ? m[1].slice(4) : m[1];
      if (!name) continue;
      const exists = net ? known.net(name) : known.ref(name);
      if (!net && !exists && !/^[A-Za-z]+\d+\w*$/.test(name)) continue;
      out += emphasis(text.slice(last, m.index));
      out += exists
        ? `<button type="button" class="ask-link" data-ask-${net ? "net" : "ref"}="${esc(name)}">${esc(name)}</button>`
        : `<span class="ask-link missing" title="Not found in this design">${esc(name)}</span>`;
      last = m.index + m[0].length;
    }
    return out + emphasis(text.slice(last));
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
