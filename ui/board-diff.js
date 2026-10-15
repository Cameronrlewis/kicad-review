// Board comparison identity and visible-side routing. Classic script, no state ownership.
(() => {
  'use strict';
  const actionMap = rows => new Map(rows.map(row => [row.id, row.action]));
  const actionFor = (object, actions) => object.changeIds.map(id => actions.get(id)).find(Boolean) || null;
  function sidesAt(mode, fraction, wipe, blend, scenes) {
    const order = mode === 'wipe' ? [fraction < wipe || wipe === 1 ? 'base' : 'head']
      : mode === 'blend' && blend === 0 ? ['base']
      : mode === 'blend' && blend === 1 ? ['head'] : ['head', 'base'];
    return order.filter(side => scenes[side]);
  }
  function pickFromHits(hits, afterId) {
    const choices = [], seen = new Set();
    for (const object of hits) for (const id of object.changeIds) {
      if (!seen.has(id)) { seen.add(id); choices.push({id, object}); }
    }
    if (!choices.length) return null;
    const index = choices.findIndex(choice => choice.id === afterId);
    return choices[(index + 1) % choices.length];
  }
  window.BoardDiff = {actionMap, actionFor, sidesAt, pickFromHits};
})();
