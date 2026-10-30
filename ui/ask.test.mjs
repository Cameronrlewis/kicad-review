import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const window = {};
runInNewContext(readFileSync(new URL('./ask.js', import.meta.url), 'utf8'), { window });
const { render } = window.KrAsk;
const known = { ref: (n) => ['R16', 'U1'].includes(n), net: (n) => ['/VBUS_5V', '12', 'Net-(D1-K)'].includes(n) };

test('unknown references are greyed out and HTML is escaped', () => {
  const html = render('[R99] [net:VBUS] <img src=x onerror=alert(1)> [R16] [net:/VBUS_5V]', known);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<span class="ask-link missing" title="Not found in this design">R99<\/span>/);
  assert.match(html, /<span class="ask-link missing" title="Not found in this design">VBUS<\/span>/);
  assert.match(html, /<button type="button" class="ask-link" data-ask-ref="R16">R16<\/button>/);
  assert.match(html, /<button type="button" class="ask-link" data-ask-net="\/VBUS_5V">\/VBUS_5V<\/button>/);
});

test('a net named with digits only links by exact string', () => {
  assert.match(render('The bus is [net:12].', known), /data-ask-net="12">12<\/button>/);
  assert.match(render('The bus is [net:13].', known), /missing[^>]*>13<\/span>/);
});

test('existing names have no prefix or name-length ceiling and net whitespace is identity', () => {
  const longNet = '/power/' + 'segment_'.repeat(25), customRef = 'CUSTOMPREFIX123';
  const exact = { ref: n => [customRef, 'custom-part'].includes(n), net: n => [longNet, ' VBUS ', 'VBUS'].includes(n) };
  const html = render(`[${customRef}] [custom-part] [net:${longNet}] [net: VBUS ] [net:VBUS] [net: VBUS]`, exact);
  assert.ok(html.includes(`data-ask-ref="${customRef}">${customRef}</button>`));
  assert.ok(html.includes('data-ask-ref="custom-part">custom-part</button>'));
  assert.ok(html.includes(`data-ask-net="${longNet}">${longNet}</button>`));
  assert.ok(html.includes('data-ask-net=" VBUS "> VBUS </button>'));
  assert.ok(html.includes('data-ask-net="VBUS">VBUS</button>'));
  assert.ok(html.includes('title="Not found in this design"> VBUS</span>'));
  assert.equal((html.match(/data-ask-net=/g) || []).length, 3, 'one-sided whitespace must not alias the other known names');
});

test('attribute and tag injection through a name cannot break out', () => {
  const html = render('[net:"><script>alert(1)</script>]', { ref: () => true, net: () => true });
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /data-ask-net="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

test('Markdown subset: paragraphs, lists, bold and code; other brackets stay text', () => {
  const html = render('**Power** comes from `J1`.\n\n- first [1]\n- second\n\nDone', known);
  assert.equal(html, '<p><strong>Power</strong> comes from <code>J1</code>.</p><ul><li>first [1]</li><li>second</li></ul><p>Done</p>');
  assert.equal(render('', known), '');
  assert.equal(render(null, known), '');
});

test('emphasis, code and citations combine without breaking each other', () => {
  assert.equal(
    render('**Check [R16] now** and `[R16]` plus `**literal**` and `<b>`', known),
    '<p><strong>Check <button type="button" class="ask-link" data-ask-ref="R16">R16</button> now</strong> and <code>[R16]</code> plus <code>**literal**</code> and <code>&lt;b&gt;</code></p>'
  );
  assert.match(render('**Rail [net:/VBUS_5V]**', known), /<strong>Rail <button type="button" class="ask-link" data-ask-net="\/VBUS_5V">\/VBUS_5V<\/button><\/strong>/);
});

test('citation names are looked up exactly, without rewriting backticks, asterisks or private-use characters', () => {
  const seen = [];
  const names = ['a`b`c', 'AB', 'AB', 'x**y', 'x*y'];
  const exact = { ref: () => false, net: n => { seen.push(n); return names.includes(n); } };
  const html = render('[net:a`b`c] [net:AB] [net:AB] [net:x**y] [net:x*y]', exact);
  assert.deepEqual(seen, names);
  assert.ok(html.includes('data-ask-net="a`b`c">a`b`c</button>'));
  assert.ok(html.includes('data-ask-net="AB">AB</button>'));
  assert.ok(html.includes('data-ask-net="AB">AB</button>'));
  assert.ok(html.includes('data-ask-net="x**y">x**y</button>'));
  assert.ok(html.includes('data-ask-net="x*y">x*y</button>'));
  assert.doesNotMatch(html, /missing|<strong>/);
});
