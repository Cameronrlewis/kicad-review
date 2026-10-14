// The review page's thread client. It runs in the trusted wrapper, never in the sandboxed report.
// The report only proposes anchors and asks to open threads; text and requests stay here.

export function threadsClient(config) {
  const iframe = document.getElementById('review-report');
  const composer = document.getElementById('thread-composer'), view = document.getElementById('thread-view');
  let threads = [], pending = null, current = null, blockMerge = false;
  const accept = (event) => event.source === iframe.contentWindow && !!event.data && typeof event.data === 'object';
  const send = (data) => iframe.contentWindow?.postMessage(data, '*');
  const status = (el, text) => { el.querySelector('[role=status]').textContent = text; };
  const post = async (path, body) => {
    const response = await fetch(config.threads + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'GitHub did not accept that.');
    document.dispatchEvent(new CustomEvent('kicad-review-threads-changed'));
  };
  const rerun = async (severity, el, action) => {
    if (!blockMerge || severity !== 'blocking') return;
    try {
      const response = await fetch(config.rerun, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'GitHub did not accept that.');
      const data = await response.json().catch(() => ({}));
      if (!Number.isSafeInteger(data.run) || data.run <= 0) { notice.textContent = 'The review is re-running.'; return; }
      const link = document.createElement('a');
      link.href = config.run + data.run;
      link.textContent = 'Open the new review when it finishes.';
      notice.textContent = 'The review is re-running. ';
      notice.append(link);
    } catch (error) {
      const text = `${action}. The review was not re-run: ${error.message}`;
      if (el === composer) notice.textContent = text;
      else status(el, text);
    }
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
    if (event.data.kicadReviewReady === true) { blockMerge = event.data.blockMerge === true; if (event.data.threads === true) load(); }
    if (event.data.kicadReviewPin && typeof event.data.kicadReviewPin === 'object') {
      pending = event.data.kicadReviewPin;
      composer.querySelector('.thread-target').textContent = `${pending.ref || 'Point'} · ${pending.file} · (${Number(pending.x).toFixed(2)}, ${Number(pending.y).toFixed(2)}) mm`;
      composer.querySelector('[name=severity]').value = 'comment';
      composer.querySelector('textarea').value = ''; status(composer, ''); composer.showModal();
    }
    if (typeof event.data.kicadReviewOpenThread === 'string') show(event.data.kicadReviewOpenThread);
  });
  composer.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const buttons = composer.querySelector('form').querySelectorAll('button');
    if (buttons[0]?.disabled) return;
    for (const button of buttons) button.disabled = true;
    try {
      const form = new FormData(event.target);
      await post('', { anchor: { ...pending, severity: form.get('severity') === 'blocking' ? 'blocking' : 'comment' }, text: String(form.get('text') || ''), link: config.link + location.hash });
      composer.close(); await load();
      await rerun(form.get('severity'), composer, 'Created');
    } catch (error) { status(composer, error.message); }
    finally { for (const button of buttons) button.disabled = false; }
  });
  view.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const buttons = view.querySelector('form').querySelectorAll('button');
    if (buttons[0]?.disabled) return;
    const t = threads.find((x) => x.id === current);
    if (!t) return status(view, 'This thread no longer exists.');
    for (const button of buttons) button.disabled = true;
    try {
      const text = String(new FormData(event.target).get('text') || '');
      if (event.submitter?.dataset.act === 'resolve') await post(`/${encodeURIComponent(t.id)}/${t.resolved ? 'unresolve' : 'resolve'}`, {});
      else await post(`/${encodeURIComponent(t.comments[0].id)}/reply`, { text });
      event.target.reset(); await load();
      if (event.submitter?.dataset.act === 'resolve') await rerun(t.anchor.severity, view, t.resolved ? 'Reopened' : 'Resolved');
    } catch (error) { status(view, error.message); }
    finally { for (const button of buttons) button.disabled = false; }
  });
  for (const dialog of [composer, view]) dialog.querySelector('[data-act=close]').addEventListener('click', () => dialog.close());
}
