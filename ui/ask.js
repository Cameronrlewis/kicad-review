"use strict";
// Ask answers: a small Markdown subset rendered as escaped HTML. Model text is data, never markup.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // Code spans and bracketed citations are matched left to right on the raw text, so names are never rewritten.
  const TOKEN = /`([^`\n]+)`|\[([^\[\]\n]+)\]/g;
  const MARK = {};
  // Returns {html} for a live or missing citation, or null when the brackets are plain text.
  function citation(body, known) {
    const net = body.startsWith("net:"), name = net ? body.slice(4) : body;
    if (!name) return null;
    const exists = net ? known.net(name) : known.ref(name);
    if (!net && !exists && !/^[A-Za-z]+\d+\w*$/.test(name)) return null;
    return { html: exists
      ? `<button type="button" class="ask-link" data-ask-${net ? "net" : "ref"}="${esc(name)}">${esc(name)}</button>`
      : `<span class="ask-link missing" title="Not found in this design">${esc(name)}</span>` };
  }
  // Raw text strings and {html} pieces, in order. Only raw text can hold bold markers.
  function tokens(text, known) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
      out.push(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] !== undefined) out.push({ html: `<code>${esc(m[1])}</code>` });
      else out.push(citation(m[2], known) ?? m[0]);
    }
    out.push(text.slice(last));
    return out;
  }
  // "**" pairs become MARK tokens. A pair closes only on non-empty text with no raw "*" between.
  function spans(seq) {
    let html = "";
    for (let i = 0; i < seq.length; i++) {
      const t = seq[i];
      if (t === MARK) {
        let k = i + 1;
        while (k < seq.length && seq[k] !== MARK && !(typeof seq[k] === "string" && seq[k].includes("*"))) k++;
        if (k < seq.length && seq[k] === MARK && k > i + 1) { html += `<strong>${spans(seq.slice(i + 1, k))}</strong>`; i = k; continue; }
        html += "**";
      } else html += typeof t === "string" ? esc(t) : t.html;
    }
    return html;
  }
  function inline(text, known) {
    const seq = [];
    for (const t of tokens(text, known)) {
      if (typeof t !== "string") { seq.push(t); continue; }
      t.split("**").forEach((s, i) => { if (i) seq.push(MARK); if (s) seq.push(s); });
    }
    return spans(seq);
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
