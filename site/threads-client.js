// Live discussions run in the trusted wrapper, never in the sandboxed report.
export function acceptFromReport(event, iframe) {
  return event.source === iframe.contentWindow && !!event.data && typeof event.data === 'object';
}

export function threadsClient(config) {
  const iframe = document.getElementById('review-report');
  const composer = document.getElementById('thread-composer'), view = document.getElementById('thread-view');
  let threads = [], pending = null, current = null, issueMode = null, threadsOn = false, issuesOn = false;
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
    const issue = view.querySelector('[data-act=issue]'); if (issue) issue.hidden = !issuesOn;
    status(view, ''); if (!view.open) view.showModal();
  };
  const notice = document.getElementById('thread-notice');
  const load = async () => {
    const errors = [];
    if (threadsOn) {
      try {
        const response = await fetch(config.threads);
        if (!response.ok) errors.push((await response.json().catch(() => ({}))).error || 'Threads could not be loaded.');
        else {
          threads = (await response.json()).threads; send({ kicadReviewThreads: threads });
          if (current && view.open) show(current);
        }
      } catch { errors.push('Threads could not be loaded.'); }
    }
    if (issuesOn) {
      try {
        const response = await fetch(config.issues);
        if (!response.ok) { errors.push((await response.json().catch(() => ({}))).error || 'Issues could not be loaded.'); send({ kicadReviewIssues: [] }); }
        else send({ kicadReviewIssues: (await response.json()).issues });
      } catch { errors.push('Issues could not be loaded.'); send({ kicadReviewIssues: [] }); }
    }
    notice.textContent = errors.join(' ');
  };
  const compose = (anchor, mode) => {
    pending = anchor; issueMode = mode;
    composer.querySelector('h2').textContent = mode ? 'New issue' : 'New thread';
    const title = composer.querySelector('[name=title]'); title.value = mode?.title || ''; title.closest('label').hidden = !mode;
    title.required = !!mode;
    composer.querySelector('fieldset').hidden = !!mode;
    composer.querySelector('button:not([type=button])').textContent = mode ? 'Create issue' : 'Create thread';
    composer.querySelector('.thread-target').textContent = `${anchor.ref || 'Point'} · ${anchor.file} · (${Number(anchor.x).toFixed(2)}, ${Number(anchor.y).toFixed(2)}) mm`;
    composer.querySelector('[name=severity]').value = 'comment';
    composer.querySelector('textarea').value = ''; composer.querySelector('textarea').required = !mode;
    status(composer, ''); composer.showModal();
  };
  addEventListener('message', (event) => {
    if (!accept(event)) return;
    if (event.data.kicadReviewReady === true) {
      threadsOn = event.data.threads === true;
      issuesOn = event.data.issues === true && !!config.issues;
      if (threadsOn || issuesOn) load();
    }
    if (threadsOn && event.data.kicadReviewPin && typeof event.data.kicadReviewPin === 'object') compose(event.data.kicadReviewPin, null);
    if (issuesOn && event.data.kicadReviewIssueFor && typeof event.data.kicadReviewIssueFor === 'object') {
      const { title, ...anchor } = event.data.kicadReviewIssueFor;
      compose(anchor, { title: String(title || '').slice(0, 256), threadCommentId: null });
    }
    if (threadsOn && typeof event.data.kicadReviewOpenThread === 'string') show(event.data.kicadReviewOpenThread);
  });
  composer.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target), submit = event.target.querySelector?.('button:not([type=button])');
    if (submit?.disabled) return;
    if (submit) submit.disabled = true;
    try {
      if (issueMode && !issuesOn) throw new Error('Issues are turned off for this review.');
      if (issueMode) {
        const response = await fetch(config.issues, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anchor: { ...pending, severity: 'comment' },
          title: String(form.get('title') || issueMode.title), text: String(form.get('text') || ''), link: config.link + location.hash, pull: config.pull, threadCommentId: issueMode.threadCommentId }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'GitHub did not create the issue.');
        composer.close(); issueMode = null; await load();
        if (result.warning) notice.textContent = result.warning;
        return;
      }
      if (!threadsOn) throw new Error('Threads are turned off for this review.');
      await post('', { anchor: { ...pending, severity: form.get('severity') === 'blocking' ? 'blocking' : 'comment' }, text: String(form.get('text') || ''), link: config.link + location.hash });
      composer.close(); await load();
    } catch (error) { status(composer, error.message); }
    finally { if (submit) submit.disabled = false; }
  });
  view.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const t = threads.find((x) => x.id === current);
    if (!t) return status(view, 'This thread no longer exists.');
    if (event.submitter?.dataset.act === 'issue') {
      if (!issuesOn) return;
      view.close(); compose(t.anchor, { title: `${t.anchor.ref || 'Point'}: ${t.comments[0]?.body || ''}`.slice(0, 120), threadCommentId: t.comments[0]?.id ?? null }); return;
    }
    const text = String(new FormData(event.target).get('text') || '');
    try {
      if (event.submitter?.dataset.act === 'resolve') await post(`/${encodeURIComponent(t.id)}/${t.resolved ? 'unresolve' : 'resolve'}`, {});
      else await post(`/${encodeURIComponent(t.comments[0].id)}/reply`, { text });
      event.target.reset(); await load();
    } catch (error) { status(view, error.message); }
  });
  for (const dialog of [composer, view]) dialog.querySelector('[data-act=close]').addEventListener('click', () => dialog.close());
}
