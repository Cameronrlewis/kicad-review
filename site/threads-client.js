// The review page's thread client. It runs in the trusted wrapper, never in the sandboxed report.
// The report only proposes anchors and asks to open threads; text and requests stay here.
export function acceptFromReport(event, iframe) {
  return event.source === iframe.contentWindow && !!event.data && typeof event.data === 'object';
}

export function threadsClient(config) {
  const iframe = document.getElementById('review-report');
  const composer = document.getElementById('thread-composer'), view = document.getElementById('thread-view');
  let threads = [], pending = null, current = null;
  const accept = (event) => event.source === iframe.contentWindow && !!event.data && typeof event.data === 'object';
  const send = (data) => iframe.contentWindow?.postMessage(data, '*');
  const status = (el, text) => { el.querySelector('[role=status]').textContent = text; };
  const post = async (path, body) => {
    const response = await fetch(config.threads + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'GitHub did not accept that.');
  };
  const show = (id) => {
    const t = threads.find((x) => x.id === id); if (!t) return;
    current = id;
    view.querySelector('h2').textContent = `${t.anchor.severity === 'blocking' ? 'Blocking' : 'Comment'} on ${t.anchor.ref || 'a point'}${t.resolved ? ' (resolved)' : ''}`;
    const list = view.querySelector('ol'); list.replaceChildren();
    for (const c of t.comments) {
      const li = document.createElement('li'), who = document.createElement('b'), body = document.createElement('p');
      who.textContent = `${c.author} · ${String(c.createdAt).replace('T', ' ').slice(0, 16)}`; body.textContent = c.body;
      li.append(who, body); list.append(li);
    }
    view.querySelector('[data-act=resolve]').textContent = t.resolved ? 'Reopen' : 'Resolve';
    status(view, ''); if (!view.open) view.showModal();
  };
  const notice = document.getElementById('thread-notice');
  const load = () => (async () => {
    const response = await fetch(config.threads);
    if (!response.ok) { notice.textContent = (await response.json().catch(() => ({}))).error || 'Threads could not be loaded.'; return; }
    threads = (await response.json()).threads; send({ kicadReviewThreads: threads });
    notice.textContent = '';
    if (current && view.open) show(current);
  })().catch(() => { notice.textContent = 'Threads could not be loaded.'; });
  addEventListener('message', (event) => {
    if (!accept(event)) return;
    if (event.data.kicadReviewReady === true && event.data.threads === true) load();
    if (event.data.kicadReviewPin && typeof event.data.kicadReviewPin === 'object') {
      pending = event.data.kicadReviewPin;
      composer.querySelector('.thread-target').textContent = `${pending.ref || 'Point'} · ${pending.file} · (${Number(pending.x).toFixed(2)}, ${Number(pending.y).toFixed(2)}) mm`;
      composer.querySelector('textarea').value = ''; status(composer, ''); composer.showModal();
    }
    if (typeof event.data.kicadReviewOpenThread === 'string') show(event.data.kicadReviewOpenThread);
  });
  composer.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await post('', { anchor: { ...pending, severity: form.get('severity') === 'blocking' ? 'blocking' : 'comment' }, text: String(form.get('text') || ''), link: config.link + location.hash });
      composer.close(); await load();
    } catch (error) { status(composer, error.message); }
  });
  view.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const t = threads.find((x) => x.id === current);
    if (!t) return status(view, 'This thread no longer exists.');
    const text = String(new FormData(event.target).get('text') || '');
    try {
      if (event.submitter?.dataset.act === 'resolve') await post(`/${encodeURIComponent(t.id)}/${t.resolved ? 'unresolve' : 'resolve'}`, {});
      else await post(`/${encodeURIComponent(t.comments[0].id)}/reply`, { text });
      event.target.reset(); await load();
    } catch (error) { status(view, error.message); }
  });
  for (const dialog of [composer, view]) dialog.querySelector('[data-act=close]').addEventListener('click', () => dialog.close());
}
