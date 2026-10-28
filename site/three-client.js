// Model requests cross the sandbox only through the authenticated report wrapper.
export function threeClient({ endpoint }) {
  if (typeof endpoint !== 'string' || !/^\/r\/[^/]+\/[^/]+\/a\/\d+\/3d\/$/.test(endpoint)) throw Error('invalid model endpoint');
  const inflight = new Map();
  window.addEventListener('message', async event => {
    const child = document.querySelector('#review-report')?.contentWindow, d = event.data;
    if (event.source !== child || !child || !d || d.kicad3d !== 1
      || typeof d.nonce !== 'string' || !/^[-0-9a-f]{36}$/.test(d.nonce)
      || !Number.isSafeInteger(d.id) || d.id <= 0
      || typeof d.digest !== 'string' || !/^[0-9a-f]{64}$/.test(d.digest)
      || !['board.glb', 'board-parts.json'].includes(d.kind)) return;
    const key = d.digest + '/' + d.kind;
    try {
      if (!inflight.has(key)) {
        if (inflight.size >= 4) throw Error('Too many model requests. Retry.');
        const pending = (async () => {
          const response = await fetch(endpoint + key, { credentials: 'same-origin', redirect: 'error' });
          if (!response.ok) throw Error('Model unavailable. Retry.');
          return response.arrayBuffer();
        })();
        inflight.set(key, pending);
        pending.finally(() => inflight.delete(key)).catch(() => {});
      }
      const bytes = (await inflight.get(key)).slice(0);
      if (child !== document.querySelector('#review-report')?.contentWindow) return;
      child.postMessage({ kicad3d: 1, nonce: d.nonce, id: d.id, bytes, gzip: false }, '*', [bytes]);
    } catch (error) {
      if (child !== document.querySelector('#review-report')?.contentWindow) return;
      child.postMessage({ kicad3d: 1, nonce: d.nonce, id: d.id, error: String(error.message || error) }, '*');
    }
  });
}
