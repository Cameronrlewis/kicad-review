// ui/appearance-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const ctx = vm.createContext({console});
ctx.window = ctx;
vm.runInContext(source('./kicad-colors.js'), ctx);
vm.runInContext(source('./appearance-state.js'), ctx);
const A = ctx.KrAppearance;
const plain = x => JSON.parse(JSON.stringify(x));
const theme = value => JSON.stringify({meta:{version:5}, ...value});

test('KiCad nested palette, all copper layers and alpha', () => {
  const copper = {f:'rgb(132, 0, 0)', b:'rgba(0, 132, 0, 0.4)'};
  for (let i=1;i<=30;i++) copper['in'+i] = '#1234';
  const p = A.parseTheme(theme({board:{copper}, schematic:{wire:'#009600'}}));
  assert.deepEqual(plain(p['board.copper.f']), [132/255,0,0,1]);
  assert.deepEqual(plain(p['board.copper.b']), [0,132/255,0,.4]);
  assert.deepEqual(plain(p['board.copper.in30']), [1/15,2/15,3/15,4/15]);
  assert.deepEqual(plain(p['board.background']), [0,16/255,35/255,1]);
});
test('all-or-nothing strict import', () => {
  for (const text of ['{', 'null', '[]', theme({board:null}),
    JSON.stringify({meta:{version:6},board:{background:'#fff'}}),
    theme({board:{background:'#fff',copper:{f:'url(https://invalid/)'}}}),
    theme({board:{copper:'red'}}), theme({schematic:{wire:42}}),
    theme({board:{background:'rgb(256,0,0)'}}),
    theme({board:{background:'rgba(0,0,0,-1)'}}),
    theme({board:{background:'var(--added)'}}),
    theme({board:{background:'#12345'}}), ' '.repeat(1048577)]) {
    assert.throws(() => A.parseTheme(text), undefined, text.slice(0,100));
  }
  assert.throws(() => A.parseTheme(theme({board:{not_a_color:'#fff'}})));
  const p = A.parseTheme(theme({meta:{version:5,name:'<img>'},
    schematic:{wire:'#12345678',override_item_colors:true},
    board:{future_key:'ignored'}, gerbview:{background:'not our input'}}));
  assert.deepEqual(plain(p['schematic.wire']), [18/255,52/255,86/255,120/255]);
  assert.equal(Object.hasOwn(p,'__proto__'), false);
});
test('Classic is not CSS red/green; extreme light includes translucent background', () => {
  const p = A.parseTheme(source('./fixtures/themes/classic.json'));
  assert.deepEqual(plain(p['board.copper.f']), [132/255,0,0,1]);
  assert.deepEqual(plain(p['schematic.wire']), [0,132/255,0,1]);
  assert.deepEqual(plain(p['board.background']), [0,0,0,1]);
  assert.deepEqual(plain(p['schematic.background']), [1,1,1,1]);
  assert.equal(A.parseTheme(source('./fixtures/themes/extreme-light.json'))[
    'board.background'][3], .98);
});

test('accepted colour syntax and rejected CSS cannot escape the numeric parser', () => {
  for (const [input, expected] of [
    [' #abc ', [10/15,11/15,12/15,1]], ['#abcd', [10/15,11/15,12/15,13/15]],
    ['#123456', [18/255,52/255,86/255,1]], ['#12345678', [18/255,52/255,86/255,120/255]],
    ['RGB(12, 34, 56)', [12/255,34/255,56/255,1]],
    ['rgba(12.5, 0, 255, .5)', [12.5/255,0,1,.5]],
  ]) assert.deepEqual(plain(A.parseColor(input)), expected);
  for (const input of [null, 1, {}, 'red', '#12', '#12345', '#1234567',
    'rgb(1%,0,0)', 'rgb(1e2,0,0)', 'rgb(1,2,3,4)', 'rgba(1,2,3)',
    'rgba(0,0,0,1.01)', 'rgb(-1,0,0)', 'rgb(NaN,0,0)',
    'url(x)', 'var(--color)', '#fff; color:red', 'rgb(0 0 0 / 1)']) {
    assert.throws(() => A.parseColor(input));
  }
});

test('BOM, metadata, unknown keys and inherited names do not affect the palette', () => {
  const p = A.parseTheme('﻿' + theme({schematic:{wire:'#fff',override_item_colors:true}}));
  assert.equal(Object.hasOwn(p, 'schematic.override_item_colors'), false);
  assert.deepEqual(plain(p['schematic.wire']), [1,1,1,1]);
  const malicious = '{"meta":{"version":5},"__proto__":{"polluted":true},"board":{"background":"#000"}}';
  assert.equal(Object.hasOwn(A.parseTheme(malicious), '__proto__'), false);
  assert.throws(() => A.parseTheme(theme({board:{'copper.f':'#fff'}})));
});

test('canonical palette covers every layer and schematic category without changing board byte data', () => {
  const K = ctx.KicadColors;
  for (const key of [...Object.values(K.layerThemeKeys), ...Object.values(K.schematicThemeKeys)]) {
    assert.equal(K.themeDefaults[key].length, 4, key);
    assert.ok(K.themeDefaults[key].every(v => Number.isFinite(v) && v >= 0 && v <= 1), key);
  }
  assert.equal(Object.keys(K.layerThemeKeys).length, 95);
  assert.equal(K.layerThemeKeys['F.SilkS'], 'board.f_silks');
  assert.equal(K.layerThemeKeys['User.45'], 'board.user_45');
  assert.deepEqual(plain(K.layers['F.Cu']), [200,52,52,1]);
  assert.deepEqual(plain(K.themeDefaults['schematic.component_body']), [1,1,194/255,1]);
});

test('defaults and validated snapshots are complete and detached, including special net names', () => {
  const original = A.defaults();
  const candidate = A.defaults();
  candidate.layerOpacity['In30.Cu'] = .4;
  candidate.netColors = JSON.parse('{"__proto__":[1,0,0,1],"constructor":[0,1,0,1]}');
  const validated = A.validateState(candidate);
  for(const key of ['colors','layerOpacity','objectOpacity','netColors','markStyle'])
    assert.deepEqual(plain(validated[key]), plain(candidate[key]));
  assert.equal(validated.layers['In30.Cu'].opacity,.4);
  assert.deepEqual(plain(validated.nets.__proto__.color),[255,0,0,1]);
  candidate.colors['board.background'][0] = 1;
  candidate.netColors.__proto__[0] = 0;
  assert.equal(validated.colors['board.background'][0], 0);
  assert.equal(validated.netColors.__proto__[0], 1);
  validated.colors['board.copper.f'][0] = 0;
  assert.deepEqual(plain(A.defaults()), plain(original));
});

test('state validation rejects incomplete, malformed and nonfinite data without mutating input', () => {
  const mutations = [
    s => { delete s.colors['board.background']; },
    s => { s.colors['board.background'] = [1,1,1]; },
    s => { s.colors['board.background'] = [NaN,0,0,1]; },
    s => { s.colors['board.background'] = Array(4); },
    s => { s.layerOpacity['not a layer'] = .5; },
    s => { s.layerOpacity['F.Cu'] = Infinity; },
    s => { s.objectOpacity.zones = -1; },
    s => { delete s.objectOpacity.images; },
    s => { s.netColors.bad = [0,0,0,2]; },
    s => { s.netColors['x'.repeat(513)] = [0,0,0,1]; },
    s => { s.markStyle = 'other'; },
  ];
  for (const mutate of mutations) {
    const state = A.defaults();
    mutate(state);
    const before = plain(state);
    assert.throws(() => A.validateState(state));
    assert.deepEqual(plain(state), before);
  }
  for (const value of [null, [], {}, {colors:[]}]) assert.throws(() => A.validateState(value));
});

test('theme size limit counts UTF-8 bytes, not JavaScript code units', () => {
  const text = theme({meta:{version:5,name:'é'.repeat(530000)},board:{background:'#fff'}});
  assert.ok(text.length < 1048576);
  assert.throws(() => A.parseTheme(text), /1 MiB/);
});
const memory = () => {
  const data = new Map();
  return {getItem:k=>data.get(k)??null, setItem:(k,v)=>data.set(k,v), data};
};
const storageKey = 'kr.appearance.v1';

test('persistence isolates viewers and preserves colours, opacity, net overrides and mark style', () => {
  const disk=memory(), storage=()=>disk;
  const one=A.createStore({viewerId:'repo/A',storage});
  const next=one.get();
  next.layerOpacity['F.Cu']=.2; next.objectOpacity.zones=.3;
  next.colors['board.copper.f']=[.1,.2,.3,.4]; next.markStyle='recolour';
  next.netColors=JSON.parse('{"__proto__":[1,0,0,0.5],"GND":[0,1,0,1]}');
  one.set(next);
  const two=A.createStore({viewerId:'repo/B',storage});
  two.import(theme({schematic:{wire:'#123456'}}));
  const saved=A.createStore({viewerId:'repo/A',storage});
  assert.deepEqual(plain(saved.get()),plain(one.get()));
  assert.notDeepEqual(plain(saved.get()),plain(two.get()));
  next.colors['board.copper.f'][0]=1;
  const copy=saved.get(); copy.netColors.GND[0]=1;
  assert.equal(one.get().colors['board.copper.f'][0],.1);
  assert.equal(saved.get().netColors.GND[0],0);
  one.reset();
  assert.deepEqual(plain(one.get()),plain(A.defaults()));
  assert.deepEqual(plain(A.createStore({viewerId:'repo/B',storage}).get()),plain(two.get()));
});

test('blocked storage, read errors, quota errors, junk and unknown schemas are harmless', () => {
  for(const storage of [()=>{throw new Error('SecurityError')},
    ()=>({getItem(){throw new Error('read')},setItem(){throw new Error('quota')}}),
    ()=>({getItem:()=>'{',setItem(){throw new Error('quota')}}),
    ...[null,[],{}, {version:2,viewers:{}}, {version:1,viewers:[]}].map(value=>
      ()=>({getItem:()=>JSON.stringify(value),setItem(){}})),
    ()=>({getItem:()=> ' '.repeat(4194305),setItem(){throw new Error('quota')}})]) {
    const store=A.createStore({viewerId:'A',storage});
    assert.deepEqual(plain(store.get()),plain(A.defaults()));
    store.import(theme({board:{background:'#fff'}}));
    assert.equal(store.get().colors['board.background'][0],1);
    store.reset();
  }
  // The default getter must also tolerate a missing localStorage in this VM.
  assert.doesNotThrow(()=>A.createStore({viewerId:'A'}).reset());
});

test('invalid import writes nothing and notifies nobody; corrupt viewer entries stay isolated', () => {
  const disk=memory(); let writes=0, notices=0;
  const save=disk.setItem; disk.setItem=(k,v)=>{writes++;save(k,v)};
  const store=A.createStore({viewerId:'A',storage:()=>disk});
  store.subscribe(()=>notices++);
  const before=JSON.stringify(store.get());
  assert.throws(()=>store.import(theme({board:{background:'#fff',copper:{f:'bad'}}})),
    {name:'ThemeImportError'});
  assert.equal(JSON.stringify(store.get()),before);
  assert.equal(writes,0); assert.equal(notices,0);
  store.set(store.get());
  const envelope=JSON.parse(disk.getItem(storageKey));
  envelope.viewers.B={bad:true};
  disk.setItem(storageKey,JSON.stringify(envelope));
  assert.deepEqual(plain(A.createStore({viewerId:'B',storage:()=>disk}).get()),plain(A.defaults()));
  assert.deepEqual(plain(A.createStore({viewerId:'A',storage:()=>disk}).get()),plain(store.get()));
});

test('invalid alpha and opacity cannot partially commit, persist or notify', () => {
  const disk=memory(), store=A.createStore({viewerId:'A',storage:()=>disk});
  let notices=0; store.subscribe(()=>notices++);
  const before=JSON.stringify(store.get());
  for(const bad of [NaN,Infinity,-.1,1.1,'0.2']) {
    for(const change of [s=>{s.objectOpacity.zones=bad},
      s=>{s.layerOpacity['F.Cu']=bad},s=>{s.colors['board.background'][3]=bad},
      s=>{s.netColors.GND=[0,0,0,bad]}]) {
      const next=store.get(); change(next);
      assert.throws(()=>store.set(next));
      assert.equal(JSON.stringify(store.get()),before);
    }
  }
  assert.equal(disk.data.size,0); assert.equal(notices,0);
});

test('import replaces colours only; reset replaces all scoped options; edits return detached snapshots', () => {
  const disk=memory(), store=A.createStore({viewerId:'A',storage:()=>disk});
  const state=store.get();
  state.colors['board.copper.f']=[1,1,1,1]; state.layerOpacity['F.Cu']=.2;
  state.objectOpacity.zones=.3; state.netColors.GND=[1,0,0,1]; state.markStyle='recolour';
  store.set(state);
  const imported=store.import(theme({schematic:{wire:'#fff'}}));
  assert.deepEqual(plain(imported),plain(store.get()));
  assert.deepEqual(plain(imported.colors['board.copper.f']),plain(A.defaults().colors['board.copper.f']));
  for(const key of ['layerOpacity','objectOpacity','netColors','markStyle'])
    assert.deepEqual(plain(imported[key]),plain(state[key]));
  imported.colors['board.background'][0]=1;
  assert.equal(store.get().colors['board.background'][0],0);
  assert.deepEqual(plain(store.reset()),plain(A.defaults()));
});

test('patch validates and merges partial maps, notifies once with separate snapshots and unsubscribes', () => {
  const disk=memory(), store=A.createStore({viewerId:'A',storage:()=>disk});
  let writes=0, notices=0;
  const save=disk.setItem; disk.setItem=(k,v)=>{writes++;save(k,v)};
  const stop=store.subscribe(s=>{notices++;s.colors['board.background'][0]=1});
  let observed;
  store.subscribe(s=>{observed=s});
  const result=store.patch({objectOpacity:{tracks:.2},layerOpacity:{'F.Cu':.4}});
  assert.equal(result.objectOpacity.tracks,.2); assert.equal(result.objectOpacity.zones,.6);
  assert.equal(observed.colors['board.background'][0],0);
  assert.equal(store.get().colors['board.background'][0],0);
  assert.equal(writes,1); assert.equal(notices,1);
  stop();
  store.patch({markStyle:'recolour'});
  assert.equal(notices,1); assert.equal(writes,2);
  const before=plain(store.get());
  assert.throws(()=>store.patch({objectOpacity:{zones:NaN}}));
  assert.throws(()=>store.patch({colors:null}));
  assert.deepEqual(plain(store.get()),before); assert.equal(writes,2);
});

test('special viewer names are own keys; writes preserve other viewers and exclude unrelated fields', () => {
  const disk=memory(); disk.setItem('kr.theme','light');
  for(const viewerId of ['__proto__','constructor','repo/A']) {
    const store=A.createStore({viewerId,storage:()=>disk});
    const state=store.get(); state.markStyle='recolour'; state.camera={x:10}; state.theme='dark';
    store.set(state);
  }
  const envelope=JSON.parse(disk.getItem(storageKey));
  assert.deepEqual(Object.keys(envelope).sort(),['version','viewers']);
  for(const viewerId of ['__proto__','constructor','repo/A']) {
    assert.ok(Object.hasOwn(envelope.viewers,viewerId));
    assert.equal(envelope.viewers[viewerId].markStyle,'recolour');
    assert.equal(Object.hasOwn(envelope.viewers[viewerId],'camera'),false);
    assert.equal(Object.hasOwn(envelope.viewers[viewerId],'theme'),false);
    assert.equal(A.createStore({viewerId,storage:()=>disk}).get().markStyle,'recolour');
  }
  assert.equal(disk.getItem('kr.theme'),'light');
});


test('resolved backgrounds are opaque; board compatibility edits share the canonical palette', () => {
  const store=A.createStore({viewerId:'bridge',storage:()=>({getItem:()=>null,setItem(){}})});
  store.import(theme({board:{background:'rgba(255,255,255,.5)',copper:{f:'rgba(1,2,3,.5)'}}}));
  const resolved=A.resolve(store.get());
  assert.deepEqual(plain(resolved.boardBackground), [.5,(1+16/255)/2,(1+35/255)/2,1]);
  assert.equal(store.get().colors['board.background'][3],.5);
  assert.deepEqual(plain(resolved.layers['F.Cu'].color),[1,2,3,.5]);
  store.patch({layers:{'F.Cu':{color:[12,34,56,.4],opacity:.3,visible:false}},objects:{zones:{opacity:.2}}});
  assert.deepEqual(plain(store.get().colors['board.copper.f']),[12/255,34/255,56/255,.4]);
  assert.equal(store.get().layerOpacity['F.Cu'],.3);
  assert.equal(store.get().objectOpacity.zones,.2);
  assert.equal(store.get().layers['F.Cu'].visible,false);
});
