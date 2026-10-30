// Ask runs in the trusted wrapper: the sandboxed report may not connect anywhere, so it relays through postMessage.
// This function is stringified into the page (like threadsClient), so it must use nothing outside its own body.
export function askClient(config) {
  const iframe = document.getElementById('review-report');
  const send = (data) => iframe.contentWindow?.postMessage(data, '*');
  const emit = (id, event, data) => send({ kicadReviewAskEvent: { id, event, data } });
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const failure = async (id, response) => {
    const body = await response.json().catch(() => ({}));
    emit(id, 'error', { message: String(body.error || 'Ask is not available.').slice(0, 300), code: String(response.status) });
    emit(id, 'done', {});
  };
  async function question(q) {
    try {
      const response = await post(config.ask, { project: q.project, messages: q.messages });
      if (!response.ok || !response.body) return failure(q.id, response);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', terminal = false;
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          let name = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          try { const parsed = JSON.parse(data); emit(q.id, name, parsed); if (name === 'done' || name === 'error') terminal = true; } catch { /* skip a damaged frame */ }
        }
        if (done) break;
      }
      if (!terminal) { emit(q.id, 'error', { message: 'The answer ended before completion.', code: 'network' }); emit(q.id, 'done', {}); }
    } catch {
      emit(q.id, 'error', { message: 'The connection dropped.', code: 'network' });
      emit(q.id, 'done', {});
    }
  }
  async function insight(q) {
    const { id, project } = q;
    try {
      const response = await post(config.insight, { project });
      if (!response.ok) return failure(id, response);
      emit(id, 'insight', await response.json());
    } catch { emit(id, 'error', { message: 'The summary could not be loaded.', code: 'network' }); }
  }
  addEventListener('message', (event) => {
    if (event.source !== iframe.contentWindow || !event.data || typeof event.data !== 'object') return;
    const d = event.data;
    if (d.kicadReviewReady === true && d.ask === true) send({ kicadReviewAskReady: true });
    const q = d.kicadReviewAskQuestion;
    if (q && typeof q === 'object' && typeof q.id === 'string' && typeof q.project === 'string' && Array.isArray(q.messages)) question(q);
    if (typeof d.kicadReviewAskInsight?.project === 'string' && typeof d.kicadReviewAskInsight?.id === 'string') insight(d.kicadReviewAskInsight);
  });
}
