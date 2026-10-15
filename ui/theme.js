(() => {
  const root = document.documentElement;
  const valid = t => t === 'dark' || t === 'light';
  const get = () => root.dataset.theme === 'light' ? 'light' : 'dark';
  const frame = () => document.getElementById('review-report');
  const sync = () => {
    for (const b of document.querySelectorAll('[data-theme-toggle]')) {
      const label = `Switch to ${get() === 'dark' ? 'light' : 'dark'} theme`;
      b.setAttribute('aria-label', label); b.setAttribute('title', label);
      b.setAttribute('aria-pressed', String(get() === 'dark'));
    }
  };
  const send = () => {
    const message = {kicadReviewTheme:get()};
    if (parent !== window) parent.postMessage(message, '*');
    else frame()?.contentWindow?.postMessage(message, '*');
  };
  const set = (theme, {persist=true, broadcast=true}={}) => {
    if (!valid(theme)) return;
    root.dataset.theme = theme;
    if (persist) { try { localStorage.setItem('kr.theme', theme); } catch {} }
    sync(); document.dispatchEvent(new CustomEvent('kr-theme-change',{detail:theme}));
    if (broadcast) send();
  };
  let stored;
  try { stored = localStorage.getItem('kr.theme'); } catch {}
  root.dataset.theme = valid(stored) ? stored : 'dark';
  window.KRTheme = {get,set};
  document.addEventListener('click', event => {
    if (event.target.closest('[data-theme-toggle]')) set(get() === 'dark' ? 'light' : 'dark');
  });
  addEventListener('storage', event => {
    if (event.key === 'kr.theme' || event.key === null)
      set(valid(event.newValue) ? event.newValue : 'dark', {persist:false});
  });
  addEventListener('message', event => {
    const peer = parent !== window ? parent : frame()?.contentWindow;
    if (!peer || event.source !== peer) return;
    if (valid(event.data?.kicadReviewTheme))
      set(event.data.kicadReviewTheme, {persist:parent === window, broadcast:false});
    if (parent === window && event.data?.kicadReviewReady === true) send();
  });
  // Capture the non-bubbling iframe load event, also covering legacy reports.
  document.addEventListener('load', event => { if(event.target === frame()) send(); }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, {once:true});
  else sync();
})();
