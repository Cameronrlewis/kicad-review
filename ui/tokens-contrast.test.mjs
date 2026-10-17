// AA check: parses ui/tokens.css theme blocks, composites rgb() alpha over the surface, asserts WCAG contrast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const dark = block(/:root, :root\[data-theme="dark"\] \{([^}]*)\}/);
const light = { ...dark, ...block(/:root\[data-theme="light"\] \{([^}]*)\}/) };
const rgb = (v) => { const h = v.match(/^#(\w{6})$/); if (h) return [0, 2, 4].map(i => parseInt(h[1].substr(i, 2), 16));
  return v.match(/[\d.]+/g).slice(0, 3).map(Number); };
const lum = (c) => { const [r, g, b] = c.map(x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
for (const [name, t] of [['dark', dark], ['light', light]]) test(`AA contrast ${name}`, () => {
  for (const fg of ['tx', 'tx2', 'acc-tx', 'add', 'rem', 'mod', 'wav'])
    for (const bg of ['panel', 'module', 'inset', 'chassis']) {
      const r = ratio(rgb(t[fg]), rgb(t[bg]));
      assert.ok(r >= 4.5, `${name} ${fg} on ${bg} = ${r.toFixed(2)}`);
    }
  const over = (fg, tint) => { const [r, g, b, a = 1] = tint.match(/[\d.]+/g).map(Number); const p = rgb(t.panel);
    return [r, g, b].map((x, i) => x * a + p[i] * (1 - a)); };
  for (const k of ['add', 'rem', 'mod', 'wav']) assert.ok(ratio(rgb(t[k]), over(k, t[k + '-bg'])) >= 4.5, `${name} ${k} on its tint`);
  assert.ok(ratio(rgb(t['acc-tx']), over('acc', t['acc-bg'])) >= 4.5, `${name} acc-tx on acc-bg`);
  assert.ok(ratio(rgb(t['on-acc']), rgb(t.acc)) >= 4.5, `${name} on-acc on acc`);
});
