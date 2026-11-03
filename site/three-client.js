// parked for Task 9A: wrapper installs the broker; route serves stored .gz with Content-Encoding: gzip.
// Model requests cross the sandbox only through the authenticated report wrapper.
export function threeClient({ endpoint }) {
  if (typeof endpoint !== 'string' || !/^\/r\/[^/]+\/[^/]+\/a\/\d+\/3d\/$/.test(endpoint)) throw Error('invalid model endpoint');
  const inflight = new Map();
  const waiters = new Map();
  const maxWaitersPerAsset = 16;
  window.addEventListener('message', async event => {
    const child = document.querySelector('#review-report')?.contentWindow, d = event.data;
    if (event.source !== child || !child || !d || d.kicad3d !== 1
      || typeof d.nonce !== 'string' || !/^[-0-9a-f]{36}$/.test(d.nonce)
      || !Number.isSafeInteger(d.id) || d.id <= 0
      || typeof d.digest !== 'string' || !/^[0-9a-f]{64}$/.test(d.digest)
      || !['board.glb', 'board-parts.json'].includes(d.kind)) return;
    const key = d.digest + '/' + d.kind;
    const waiterCount = waiters.get(key) || 0;
    if (waiterCount >= maxWaitersPerAsset) {
      child.postMessage({ kicad3d: 1, nonce: d.nonce, id: d.id, error: 'Too many requests for this model. Retry.' }, '*');
      return;
    }
    waiters.set(key, waiterCount + 1);
    try {
      if (!inflight.has(key)) {
        if (inflight.size >= 4) throw Error('Too many model requests. Retry.');
        const pending = (async () => {
          const response = await fetch(endpoint + key, { credentials: 'same-origin', redirect: 'error' });
          if (response.status === 401 || response.status === 403) throw Error('Model access denied. Refresh the review link or sign in, then retry.');
          if (!response.ok) throw Error('Model unavailable. Retry.');
          // fetch auto-decodes Content-Encoding: gzip; digest and gzip:false describe uncompressed bytes.
          const bytes = await response.arrayBuffer();
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
          if (digest !== d.digest) throw Error('Model digest mismatch. Retry.');
          return bytes;
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
    } finally {
      const remaining = (waiters.get(key) || 1) - 1;
      if (remaining) waiters.set(key, remaining);
      else waiters.delete(key);
    }
  });
}
