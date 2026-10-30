import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CHECKS } from './checks.mjs';

const source = readFileSync(new URL('./review.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderChecks()');
const end = source.indexOf('S.partsFilter =', start);
function render(check = '', status = 'fail') {
  const checks = ['jlcpcb', 'pcbway'].map(vendor => ({
    name: 'fab_limits', title: 'Fab limits', vendor, status, level: 'required',
    errors: 1, warnings: 0, new_errors: 1, new_warnings: 0,
    violations: [{ id: vendor, severity: 'error', type: 'track_width', new: true,
      description: 'Track too narrow', items: [], where: { board: true } }],
  }));
  const context = {
    S: { checks: { check, scope: 'all', error: true, warning: true, group: 'check' } },
    D: { settings: {} }, proj: () => ({ checks }),
    esc: value => String(value ?? ''), dockListTools: () => '', fabLedger: () => '',
    ISSUES_ON: false,
  };
  // Include shared check identity/display helpers when present.
  const helpers = source.slice(source.indexOf('function checkKey(') < 0 ? start : source.indexOf('function checkKey('), start);
  return runInNewContext(helpers + source.slice(start, end) + '\nrenderChecks()', context);
}

test('fab summaries and check group headings identify each vendor, including not-run summaries', () => {
  for (const status of ['fail', 'not_run']) {
    const html = render('', status);
    for (const vendor of ['JLCPCB', 'PCBWay']) {
      assert.ok(html.includes(`Fab limits · ${vendor}`), `${status}: ${vendor} label missing`);
      if (status === 'fail') assert.ok(html.includes(`<span class="rule">Fab limits · ${vendor}</span>`));
    }
  }
});

test('fab summary keys isolate vendors and preserve pressed state without raw HTML NULs', () => {
  for (const vendor of ['jlcpcb', 'pcbway']) {
    const html = render(`fab_limits\u0000${vendor}`);
    const other = vendor === 'jlcpcb' ? 'pcbway' : 'jlcpcb';
    assert.ok(html.includes(`data-check-summary="fab_limits%00${vendor}" aria-pressed="true"`));
    assert.ok(html.includes(`data-check-summary="fab_limits%00${other}" aria-pressed="false"`));
    assert.ok(html.includes(`data-id="${vendor}"`));
    assert.ok(!html.includes(`data-id="${other}"`));
    assert.ok(!html.includes('\u0000'));
  }
});

test('fab vendor coverage check describes desktop scope without phone-only setup', () => {
  const check = CHECKS.find(([name]) => name === 'Fab limits vendor isolation and desktop coverage');
  assert.ok(check, 'desktop coverage check missing');
  assert.equal(check[3]?.viewport, undefined);
  assert.doesNotMatch(check[2], /phone|innerWidth!==412|innerHeight!==915/);
});
