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
    for (const b of document.querySelectorAll('[data-theme-set]'))
      if (b.dataset && b.dataset.themeSet) b.setAttribute('aria-pressed', String(b.dataset.themeSet === (mode === 'system' ? 'system' : get())));
  };
  let mode;   // 'system' follows the OS; anything else is the explicit theme
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  const sys = () => mq && mq.matches ? 'light' : 'dark';
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
  try { stored = localStorage.getItem('kr.theme'); mode = localStorage.getItem('kr.theme-mode') === 'system' ? 'system' : undefined; } catch {}
  root.dataset.theme = mode === 'system' ? sys() : valid(stored) ? stored : 'dark';
  const setMode = m => {
    if (m !== 'system' && !valid(m)) return;
    mode = m === 'system' ? 'system' : undefined;
    try { localStorage.setItem('kr.theme-mode', m === 'system' ? 'system' : 'explicit'); } catch {}
    set(m === 'system' ? sys() : m, {persist: m !== 'system'});
  };
  window.KRTheme = {get,set,setMode,mode:() => mode === 'system' ? 'system' : get()};
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (mode === 'system') set(sys(), {persist:false}); });
  document.addEventListener('click', event => {
    const pick = event.target.closest('[data-theme-set]');
    if (pick) setMode(pick.dataset.themeSet);
    else if (event.target.closest('[data-theme-toggle]')) setMode(get() === 'dark' ? 'light' : 'dark');
    for (const menu of document.querySelectorAll('.bench-menu[open]'))
      if (!menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menus = document.querySelectorAll('.bench-menu[open]');
    if (!menus.length) return;
    for (const menu of menus) { menu.open = false; menu.querySelector('summary')?.focus(); }
    event.preventDefault(); event.stopImmediatePropagation();
  });
  addEventListener('storage', event => {
    if (event.key === 'kr.theme-mode') {
      mode = event.newValue === 'system' ? 'system' : undefined;
      let stored; try { stored = localStorage.getItem('kr.theme'); } catch {}
      set(mode === 'system' ? sys() : valid(stored) ? stored : 'dark', {persist:false});
    } else if (event.key === 'kr.theme' || event.key === null) {
      if (event.key === null) mode = undefined;
      set(mode === 'system' ? sys() : valid(event.newValue) ? event.newValue : 'dark', {persist:false});
    }
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
