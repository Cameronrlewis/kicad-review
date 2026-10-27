import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), P=require('./compress3d.cjs');
test('BR02 mask finish and pair-safe cache policy',()=>{
  for(const rgb of [[.7,.02,.01],[.01,.02,.8],[0,0,0],[1,1,1]])
    assert.deepEqual(P.maskRGB(rgb),rgb);
  assert.deepEqual(P.maskRGB([.08,.2,.14]),[.011,.1,.036]);
  assert.deepEqual(P.maskRGB([.0627,.16,.1129]),[.011,.1,.036]);
  assert.deepEqual(P.padStyle('ENEPIG').color,[1,.78,.34,1]);
  assert.deepEqual(P.padStyle('HASL').color,[.5,.5,.5,1]);
  const m={keep:['R12','U3'],finish:'ENIG',footprints:[]};
  const key=P.processorKey(Buffer.from('raw'),m,Buffer.from('v1'));
  assert.equal(key,P.processorKey(Buffer.from('raw'),{...m,keep:['U3','R12']},Buffer.from('v1')));
  for(const changed of [{...m,keep:['R12']},{...m,finish:'HASL'}])
    assert.notEqual(key,P.processorKey(Buffer.from('raw'),changed,Buffer.from('v1')));
  assert.notEqual(key,P.processorKey(Buffer.from('raw'),m,Buffer.from('v2')));
});

function makeDocument(names,copies=1) {
  const {Document}=require('@gltf-transform/core');
  const d=new Document(), scene=d.createScene(), buffer=d.createBuffer();
  const material=d.createMaterial('body').setBaseColorFactor([.1,.1,.1,1]);
  const footprints=[];
  names.forEach((ref,i)=>{
    const parent=d.createNode(ref).setTranslation([i*.004,.002,0]);scene.addChild(parent);
    const mesh=d.createMesh();
    for(let j=0;j<copies;j++) {
      const p=d.createAccessor().setType('VEC3').setBuffer(buffer)
        .setArray(new Float32Array([0,0,0,.001,0,0,0,.001,.001]));
      const ix=d.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0,1,2]));
      mesh.addPrimitive(d.createPrimitive().setAttribute('POSITION',p).setIndices(ix).setMaterial(material));
    }
    parent.addChild(d.createNode('model-body').setMesh(mesh));
    footprints.push({ref,uuid:'id-'+ref,side:i%2?'bottom':'top',pos:[i*4,0,0],
      box:[i*4-1,-1,i*4+1,1],hasModel:true,reason:null});
  });
  return {d,metadata:{version:1,side:'head',finish:'ENIG',keep:[],footprints}};
}
const integration={skip:process.env.PROCESS3D_INTEGRATION!=='1'};
test('BR02 captures descendants bounds and missing bottom footprint without double rotation',integration,()=>{
  const {d,metadata}=makeDocument(['R1','J1']);
  const j=d.getRoot().listNodes().find(n=>n.getName()==='J1');
  j.setRotation([0,Math.SQRT1_2,0,Math.SQRT1_2]);
  metadata.footprints.push({ref:'U3',uuid:'id-U3',side:'bottom',box:[8,9,12,11],
    pos:[10,10,90],hasModel:false,reason:'file not found'});
  const parts=P.snapshotParts(d,metadata);
  assert.equal(parts.length,3);
  assert.ok(parts.every(p=>p.box.length===6&&p.box.every(Number.isFinite)));
  assert.ok(Math.abs(parts.find(p=>p.ref==='J1').box[0]-.004)<.00005);
  const u=parts.find(p=>p.ref==='U3');
  assert.deepEqual([u.box[0],u.box[2],u.box[3],u.box[5]],[.008,.009,.012,.011]);
  assert.equal(u.hasModel,false);assert.equal(u.reason,'file not found');
  assert.equal(d.getRoot().listNodes().find(n=>n.getMesh()).getExtras().ref,'R1');
});

test('BR02 snapshotParts handles direct mesh on footprint node (KiCad 10.0.0 style)', integration, () => {
  const {Document} = require('@gltf-transform/core');
  const d = new Document(), scene = d.createScene(), buffer = d.createBuffer();
  const material = d.createMaterial('body').setBaseColorFactor([.1, .1, .1, 1]);
  const p = d.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, .001, 0, 0, 0, .001, .001]));
  const ix = d.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 1, 2]));
  const mesh = d.createMesh().addPrimitive(d.createPrimitive().setAttribute('POSITION', p).setIndices(ix).setMaterial(material));
  const r1 = d.createNode('R1').setMesh(mesh).setTranslation([.005, .001, 0]);
  scene.addChild(r1);
  const metadata = {
    version: 1, side: 'head', finish: 'ENIG', keep: ['R1'],
    footprints: [{ref: 'R1', uuid: 'id-R1', side: 'top', pos: [5, 1, 0], box: [4, 0, 6, 2], hasModel: true, reason: null}]
  };
  const parts = P.snapshotParts(d, metadata);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].hasModel, true);
  assert.ok(parts[0].box.every(Number.isFinite));
  assert.equal(r1.getExtras().role, 'body');
  assert.equal(r1.getExtras().ref, 'R1');
  assert.equal(r1.getExtras().batch, 'ref:R1');
});

test('BR02 snapshotParts handles both KiCad 10.0.0 and 10.0.6 actual fixture exports', integration, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {NodeIO} = require('@gltf-transform/core');
  const io = new NodeIO();
  const metadata = {
    version: 1, side: 'head', keep: ['R1'], finish: 'ENIG',
    footprints: [
      {uuid: '1b544794-fb46-511a-977a-faed594f70e9', ref: 'J1', side: 'bottom', pos: [10, 15, 90], box: [6.46, 14, 11, 16], hasModel: true, reason: null},
      {uuid: '2acb066f-593c-59df-94fd-657772cd217e', ref: 'U4', side: 'bottom', pos: [5, 15], box: [3.175, 14, 6.825, 16], hasModel: false, reason: 'no model in footprint'},
      {uuid: '323b0184-73aa-59fc-860f-fd256736dfcd', ref: 'LOGO1', side: 'top', pos: [10, 10], box: [9, 9, 11, 11], hasModel: false, reason: 'no model in footprint'},
      {uuid: '83c2b909-2e4f-5d21-8983-07e74505caea', ref: 'U3', side: 'top', pos: [15, 15], box: [13.175, 14, 16.825, 16], hasModel: false, reason: 'no model in footprint'},
      {uuid: 'a39cf55e-cada-50ed-bb1b-c296524eaed4', ref: 'R2', side: 'top', pos: [15, 5], box: [13.175, 4, 16.825, 6], hasModel: true, reason: null},
      {uuid: 'dbe7150d-b9f2-5094-af11-eb2e8ade7d10', ref: 'R1', side: 'top', pos: [5, 5], box: [3.175, 4, 6.825, 6], hasModel: true, reason: null}
    ]
  };

  const outDir = process.env.OUT || '/Users/cameron/Code/kicad-review-study/tmp/02-3d-viewer';
  const fixturePaths = [
    path.join(outDir, 'task1-executor/board.glb'),
    path.join(outDir, 'ci-probe-task1-kicad1006/board.glb')
  ];

  const available = fixturePaths.filter(p => fs.existsSync(p));
  if (available.length === 0) {
    t.skip(`KiCad 10 fixture exports not found under ${outDir}`);
    return;
  }

  let verified = 0;
  for (const p of available) {
    verified++;
    const doc = await io.read(p);
    const parts = P.snapshotParts(doc, metadata);
    assert.equal(parts.length, 6);
    assert.ok(parts.every(part => part.box.length === 6 && part.box.every(Number.isFinite)));

    const r1 = parts.find(part => part.ref === 'R1');
    assert.equal(r1.hasModel, true);
    assert.equal(r1.side, 'top');
    assert.equal(r1.reason, null);

    const r2 = parts.find(part => part.ref === 'R2');
    assert.equal(r2.hasModel, true);
    assert.equal(r2.side, 'top');

    const j1 = parts.find(part => part.ref === 'J1');
    assert.equal(j1.hasModel, true);
    assert.equal(j1.side, 'bottom');

    const u3 = parts.find(part => part.ref === 'U3');
    assert.equal(u3.hasModel, false);
    assert.equal(u3.reason, 'no model in footprint');
    assert.equal(u3.side, 'top');

    const u4 = parts.find(part => part.ref === 'U4');
    assert.equal(u4.hasModel, false);
    assert.equal(u4.reason, 'no model in footprint');
    assert.equal(u4.side, 'bottom');

    const logo = parts.find(part => part.ref === 'LOGO1');
    assert.equal(logo.hasModel, false);
    assert.equal(logo.side, 'top');

    const nodes = doc.getRoot().listNodes().filter(n => n.getMesh());
    const r1Node = nodes.find(n => n.getExtras()?.ref === 'R1');
    assert.ok(r1Node, 'R1 mesh node found');
    assert.equal(r1Node.getExtras().role, 'body');
    assert.equal(r1Node.getExtras().batch, 'ref:R1');

    const r2Node = nodes.find(n => n.getExtras()?.ref === 'R2');
    assert.ok(r2Node, 'R2 mesh node found');
    assert.equal(r2Node.getExtras().role, 'body');
    assert.equal(r2Node.getExtras().batch, 'parts:merged:top');

    const j1Node = nodes.find(n => n.getExtras()?.ref === 'J1');
    assert.ok(j1Node, 'J1 mesh node found');
    assert.equal(j1Node.getExtras().role, 'body');
    assert.equal(j1Node.getExtras().batch, 'parts:merged:bottom');

    const roles = nodes.map(n => n.getExtras()?.role);
    assert.ok(roles.includes('fr4'), 'fr4 role present');
    assert.ok(roles.includes('copper'), 'copper role present');
    assert.ok(roles.includes('pads'), 'pads role present');
    assert.ok(roles.includes('silk'), 'silk role present');
    assert.ok(roles.includes('mask'), 'mask role present');
  }
  assert.equal(verified, available.length);
  if (available.length === fixturePaths.length) {
    assert.equal(verified, 2, 'both KiCad 10.0.0 and 10.0.6 fixture exports verified');
  }
});

test('BR02 snapshotParts handles missing or null metadata.keep', integration, () => {
  const {d, metadata} = makeDocument(['R1']);
  const metaNoKeep = {...metadata};
  delete metaNoKeep.keep;
  const partsNoKeep = P.snapshotParts(d, metaNoKeep);
  assert.equal(partsNoKeep.length, 1);
  const r1Node = d.getRoot().listNodes().find(n => n.getExtras()?.ref === 'R1');
  assert.equal(r1Node.getExtras().batch, 'parts:merged:top');

  const {d: dNull, metadata: metaNull} = makeDocument(['R1']);
  metaNull.keep = null;
  const partsNullKeep = P.snapshotParts(dNull, metaNull);
  assert.equal(partsNullKeep.length, 1);
  const r1NullNode = dNull.getRoot().listNodes().find(n => n.getExtras()?.ref === 'R1');
  assert.equal(r1NullNode.getExtras().batch, 'parts:merged:top');
});

test('BR02 snapshotParts validates duplicates, unclassified meshes and non-finite coordinates', integration, () => {
  const {d, metadata} = makeDocument(['R1']);
  assert.throws(() => {
    P.snapshotParts(d, {
      ...metadata,
      footprints: [
        {ref: 'R1', uuid: 'id1', side: 'top', pos: [0, 0], box: [0, 0, 1, 1], hasModel: true},
        {ref: 'R1', uuid: 'id2', side: 'top', pos: [1, 1], box: [0, 0, 1, 1], hasModel: true}
      ]
    });
  }, /duplicate reference/);

  const {Document} = require('@gltf-transform/core');
  const dBad = new Document(), sceneBad = dBad.createScene(), bufferBad = dBad.createBuffer();
  const p = dBad.createAccessor().setType('VEC3').setBuffer(bufferBad).setArray(new Float32Array([0, 0, 0]));
  const meshBad = dBad.createMesh().addPrimitive(dBad.createPrimitive().setAttribute('POSITION', p));
  sceneBad.addChild(dBad.createNode('unknown_layer').setMesh(meshBad));
  assert.throws(() => {
    P.snapshotParts(dBad, metadata);
  }, /unclassified KiCad mesh/);

  const dGood = makeDocument(['R1']).d;
  assert.throws(() => {
    P.snapshotParts(dGood, {
      ...metadata,
      footprints: [
        {ref: 'R1', uuid: 'id1', side: 'top', pos: [0, 0], box: [0, 0, 1, 1], hasModel: true},
        {ref: 'U9', uuid: 'id9', side: 'top', pos: [NaN, 0], box: null, hasModel: false}
      ]
    });
  }, /footprint has no finite position/);
});

test('BR02 240 compatible changed primitives fit the hard changed-part budget', integration, async () => {
  const {d, metadata} = makeDocument(['R12', 'R2', 'R3'], 240);
  metadata.keep = ['R12'];
  const before = P.snapshotParts(d, metadata);
  P.applyMaterials(d, 'ENIG');
  await P.batchDocument(d);
  const kept = d.getRoot().listNodes().filter(n => n.getName() === 'R12');
  assert.equal(kept.length, 1);
  const primitiveCalls = d.getRoot().listNodes().reduce((sum, n) => sum + (n.getMesh()?.listPrimitives().length || 0), 0);
  assert.ok(primitiveCalls < 101, 'BR02 hard draw budget: ' + primitiveCalls);
  assert.equal(kept[0].listChildren().reduce((s, n) => s + (n.getMesh()?.listPrimitives().length || 0), 0), 1);
  assert.ok(!d.getRoot().listNodes().some(n => ['R2', 'R3'].includes(n.getName())));
  assert.equal(before.length, 3);
  const {getBounds} = require('@gltf-transform/functions');
  const keptBox = getBounds(kept[0]);
  const after = [...keptBox.min, ...keptBox.max];
  const r12Before = before.find(p => p.ref === 'R12').box;
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(after[i] - r12Before[i]) <= .00005, 'bounds error <= 0.00005m at ' + i + ': ' + after[i] + ' vs ' + r12Before[i]);
  }
  const {NodeIO} = require('@gltf-transform/core'), {ALL_EXTENSIONS} = require('@gltf-transform/extensions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const emitted = await io.readBinary(await io.writeBinary(d));
  for (const side of ['top', 'bottom']) {
    const nodes = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getName() === 'parts:merged:' + side);
    assert.ok(nodes.length, 'BR02 emitted merged ' + side);
    for (const n of nodes) {
      assert.deepEqual(
        {role: n.getExtras().role, side: n.getExtras().side, ref: n.getExtras().ref},
        {role: 'body', side, ref: null}
      );
    }
  }
  const changed = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getExtras().batch === 'ref:R12');
  assert.ok(changed.length);
  assert.ok(changed.every(n => n.getExtras().ref === 'R12'));
});

test('BR02 board role materials do not mutate source body material', integration, () => {
  const {d} = makeDocument(['R1']);
  const body = d.getRoot().listNodes().find(n => n.getMesh());
  body.setExtras({role: 'body', batch: 'ref:R1', ref: 'R1', side: 'top'});
  const board = d.createNode('x_copper').setMesh(body.getMesh());
  d.getRoot().listScenes()[0].addChild(board);
  board.setExtras({role: 'copper', batch: 'board:copper:top', ref: null, side: 'top'});
  P.applyMaterials(d, 'ENIG');
  assert.deepEqual(body.getMesh().listPrimitives()[0].getMaterial().getBaseColorFactor(), [.1, .1, .1, 1]);
  const m = board.getMesh().listPrimitives()[0].getMaterial();
  assert.deepEqual(m.getBaseColorFactor(), [.78, .63, .39, 1]);
  assert.equal(m.getExtension('KHR_materials_anisotropy').getAnisotropyStrength(), .3);
});

test('BR02 applyMaterials and batchDocument on actual fixture exports', integration, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {NodeIO} = require('@gltf-transform/core');
  const {ALL_EXTENSIONS} = require('@gltf-transform/extensions');
  const {getBounds} = require('@gltf-transform/functions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const metadata = {
    version: 1, side: 'head', keep: ['R1'], finish: 'ENIG',
    footprints: [
      {uuid: '1b544794-fb46-511a-977a-faed594f70e9', ref: 'J1', side: 'bottom', pos: [10, 15, 90], box: [6.46, 14, 11, 16], hasModel: true, reason: null},
      {uuid: '2acb066f-593c-59df-94fd-657772cd217e', ref: 'U4', side: 'bottom', pos: [5, 15], box: [3.175, 14, 6.825, 16], hasModel: false, reason: 'no model in footprint'},
      {uuid: '323b0184-73aa-59fc-860f-fd256736dfcd', ref: 'LOGO1', side: 'top', pos: [10, 10], box: [9, 9, 11, 11], hasModel: false, reason: 'no model in footprint'},
      {uuid: '83c2b909-2e4f-5d21-8983-07e74505caea', ref: 'U3', side: 'top', pos: [15, 15], box: [13.175, 14, 16.825, 16], hasModel: false, reason: 'no model in footprint'},
      {uuid: 'a39cf55e-cada-50ed-bb1b-c296524eaed4', ref: 'R2', side: 'top', pos: [15, 5], box: [13.175, 4, 16.825, 6], hasModel: true, reason: null},
      {uuid: 'dbe7150d-b9f2-5094-af11-eb2e8ade7d10', ref: 'R1', side: 'top', pos: [5, 5], box: [3.175, 4, 6.825, 6], hasModel: true, reason: null}
    ]
  };

  const outDir = process.env.OUT || '/Users/cameron/Code/kicad-review-study/tmp/02-3d-viewer';
  const fixturePaths = [
    path.join(outDir, 'task1-executor/board.glb'),
    path.join(outDir, 'ci-probe-task1-kicad1006/board.glb')
  ];

  const available = fixturePaths.filter(p => fs.existsSync(p));
  if (available.length === 0) {
    t.skip(`KiCad 10 fixture exports not found under ${outDir}`);
    return;
  }

  for (const p of available) {
    const doc = await io.read(p);
    const parts = P.snapshotParts(doc, metadata);
    const r1Before = parts.find(part => part.ref === 'R1').box;

    P.applyMaterials(doc, 'ENIG');
    await P.batchDocument(doc);

    // Kept reference R1 has exactly one parent node named R1
    const kept = doc.getRoot().listNodes().filter(n => n.getName() === 'R1');
    assert.equal(kept.length, 1, `R1 retained parent node present in ${p}`);
    assert.ok(kept[0].listChildren().length >= 1, 'R1 has children');

    // Bounds of kept R1 reread with getBounds error <= 0.00005 m
    const keptBox = getBounds(kept[0]);
    const after = [...keptBox.min, ...keptBox.max];
    for (let i = 0; i < 6; i++) {
      assert.ok(
        Math.abs(after[i] - r1Before[i]) <= .00005,
        `R1 bounds error <= 0.00005m at ${i} for ${p}: ${after[i]} vs ${r1Before[i]}`
      );
    }

    // Unchanged components R2 and J1 must NOT have retained identity parents
    assert.ok(!doc.getRoot().listNodes().some(n => ['R2', 'J1'].includes(n.getName())));

    // Emitted binary roundtrip validation
    const emitted = await io.readBinary(await io.writeBinary(doc));

    // Merged top components exist and have body role and ref: null
    const mergedTop = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getName() === 'parts:merged:top');
    assert.ok(mergedTop.length >= 1, `parts:merged:top present in ${p}`);
    for (const n of mergedTop) {
      assert.deepEqual(
        {role: n.getExtras().role, side: n.getExtras().side, ref: n.getExtras().ref},
        {role: 'body', side: 'top', ref: null}
      );
    }

    // Merged bottom components exist (J1 was on bottom)
    const mergedBottom = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getName() === 'parts:merged:bottom');
    assert.ok(mergedBottom.length >= 1, `parts:merged:bottom present in ${p}`);
    for (const n of mergedBottom) {
      assert.deepEqual(
        {role: n.getExtras().role, side: n.getExtras().side, ref: n.getExtras().ref},
        {role: 'body', side: 'bottom', ref: null}
      );
    }

    // Retained R1 changed part in emitted output
    const changed = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getExtras().batch === 'ref:R1');
    assert.ok(changed.length >= 1, `ref:R1 mesh nodes present in ${p}`);
    assert.ok(changed.every(n => n.getExtras().ref === 'R1'));

    // Verify role materials applied on board nodes
    const boardNodes = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getExtras().role !== 'body');
    const copperNodes = boardNodes.filter(n => n.getExtras().role === 'copper');
    assert.ok(copperNodes.length >= 1, 'copper nodes present');
    for (const n of copperNodes) {
      const mat = n.getMesh().listPrimitives()[0].getMaterial();
      assert.deepEqual(mat.getBaseColorFactor(), [.78, .63, .39, 1]);
      assert.equal(mat.getExtension('KHR_materials_anisotropy').getAnisotropyStrength(), .3);
    }

    const padNodes = boardNodes.filter(n => n.getExtras().role === 'pads');
    assert.ok(padNodes.length >= 1, 'pad nodes present');
    for (const n of padNodes) {
      const mat = n.getMesh().listPrimitives()[0].getMaterial();
      assert.deepEqual(mat.getBaseColorFactor(), [1, .78, .34, 1]);
      assert.equal(mat.getMetallicFactor(), 1);
      assert.equal(mat.getRoughnessFactor(), .3);
    }

    const fr4Nodes = boardNodes.filter(n => n.getExtras().role === 'fr4');
    assert.ok(fr4Nodes.length >= 1, 'fr4 nodes present');
    for (const n of fr4Nodes) {
      const mat = n.getMesh().listPrimitives()[0].getMaterial();
      assert.deepEqual(mat.getBaseColorFactor(), [.2, .205, .125, 1]);
      assert.equal(mat.getMetallicFactor(), 0);
      assert.equal(mat.getRoughnessFactor(), .85);
    }

    const maskNodes = boardNodes.filter(n => n.getExtras().role === 'mask');
    assert.ok(maskNodes.length >= 1, 'mask nodes present');
    for (const n of maskNodes) {
      const mat = n.getMesh().listPrimitives()[0].getMaterial();
      assert.equal(mat.getRoughnessFactor(), .6);
      assert.equal(mat.getExtension('KHR_materials_clearcoat').getClearcoatFactor(), .6);
      assert.equal(mat.getExtension('KHR_materials_clearcoat').getClearcoatRoughnessFactor(), .18);
    }
  }
});



