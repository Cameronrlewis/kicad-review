// Single public store facade; project stores share the validated Stage 7 model.
(() => {
  "use strict";
  const stores = new Map(), listeners = new Set();
  let current, unsubscribe = () => {};
  function configure(boardLayers = [], viewerId = 'default') {
    if (!stores.has(viewerId)) stores.set(viewerId, KrAppearance.createStore({viewerId}));
    if (current !== stores.get(viewerId)) {
      unsubscribe(); current = stores.get(viewerId);
      unsubscribe = current.subscribe(state => { for (const fn of [...listeners]) fn(state); });
    }
    return current.get();
  }
  configure();
  globalThis.Appearance = {
    OBJECT_ROWS: KrAppearance.OBJECT_ROWS, defaults: KrAppearance.boardDefaults,
    normalize: KrAppearance.normalizeBoard, configure,
    get: () => current.get(), set: state => current.set(state), patch: partial => current.patch(partial),
    import: text => current.import(text), reset: () => current.reset(),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
