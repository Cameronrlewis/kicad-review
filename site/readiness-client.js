// Each state has words and a symbol, never colour alone.
export function readinessClient(config) {
  const panel = document.getElementById('readiness');
  const row = (ok, label, text, word = 'blocking') => {
    const li = document.createElement('li');
    li.className = ok === null ? 'wait' : ok ? 'ok' : 'bad';
    li.textContent = `${ok === null ? '… waiting' : ok ? '✓ ready' : `✕ ${word}`} — ${label}: ${text}`;
    return li;
  };
  const failed = (text) => { const list = document.createElement('ul'); list.append(row(null, 'Readiness', text)); panel.replaceChildren(list); };
  let generation = 0;
  const load = () => {
    const current = ++generation;
    return fetch(config.readiness).then(async (response) => {
      const data = await response.json();
      if (current !== generation) return;
      if (!response.ok) { failed(response.status === 401 ? 'Sign in again.' : data.error || 'could not be loaded'); return; }
      const list = document.createElement('ul');
      const fresh = config.reviewHead && data.head ? data.head.startsWith(config.reviewHead) : null;
      list.append(row(fresh, 'This review', fresh === null ? 'freshness unknown' : fresh ? 'is for the latest commit' : `is out of date: the pull request is now at ${String(data.head).slice(0, 7)}`, 'stale'));
      const approved = data.decisions.filter((d) => d.state === 'APPROVED'), changes = data.decisions.filter((d) => d.state === 'CHANGES_REQUESTED');
      const describe = (d) => `${d.login}${d.stale ? ' (on an older commit, stale)' : ''}`;
      list.append(row(changes.length ? false : approved.some((d) => !d.stale) ? true : null, 'GitHub approval',
        changes.length ? `changes requested by ${changes.map(describe).join(', ')}` : approved.length ? `approved by ${approved.map(describe).join(', ')}` : data.requested.length ? `waiting for ${data.requested.join(', ')}` : 'no reviews yet'));
      list.append(row(data.blocking === null || data.open === null ? null : data.blocking === 0, 'Blocking threads',
        data.blocking === null || data.open === null ? 'could not be read' : data.blocking ? `${data.blocking} open` : `none open (${data.open} open in total)`));
      panel.replaceChildren(list);
    }).catch(() => { if (current === generation) failed('could not be loaded'); });
  };
  document.addEventListener('kicad-review-threads-changed', load);
  return load();
}
