import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,readdirSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {join as pathJoin} from 'node:path';
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

// Suppress transform progress only; warnings and errors must remain visible.
function quietDocument(document) {
  const {Logger}=require('@gltf-transform/core');
  return document.setLogger(new Logger(Logger.Verbosity.WARN));
}

function fixturePaths() {
  const fs=require('node:fs'), path=require('node:path');
  const out=process.env.OUT || '/Users/cameron/Code/kicad-review-study/tmp/02-3d-viewer';
  const paths=['task1-executor/board.glb','ci-probe-task1-kicad1006/board.glb']
    .map(p=>path.join(out,p));
  for(const p of paths) assert.ok(fs.existsSync(p),'Required KiCad integration fixture missing: '+p);
  return paths;
}

function makeDocument(names,copies=1) {
  const {Document}=require('@gltf-transform/core');
  const d=quietDocument(new Document()), scene=d.createScene(), buffer=d.createBuffer();
  const material=d.createMaterial('body').setBaseColorFactor([.1,.1,.1,1]);
  const footprints=[];
  names.forEach((ref,i)=>{
    const parent=d.createNode(ref).setTranslation([i*.004,.002,i*.003]);scene.addChild(parent);
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
function assertBounds(node, box, label) {
  const {getBounds}=require('@gltf-transform/functions');
  const bounds=getBounds(node), actual=[...bounds.min,...bounds.max];
  for(let i=0;i<6;i++) assert.ok(Math.abs(actual[i]-box[i])<=.00005, `${label} bounds error at ${i}: ${actual[i]} vs ${box[i]}`);
}
function assertMerged(emitted) {
  for(const side of ['top','bottom']) {
    const nodes=emitted.getRoot().listNodes().filter(n=>n.getMesh()&&n.getName()==='parts:merged:'+side);
    assert.ok(nodes.length, 'BR02 emitted merged '+side);
    for(const n of nodes) assert.deepEqual({role:n.getExtras().role,side:n.getExtras().side,ref:n.getExtras().ref},{role:'body',side,ref:null});
  }
}
// Policy tests stay dependency-free. Full verification must explicitly opt in.
const integration={skip:process.env.PROCESS3D_INTEGRATION!=='1'
  ? 'Opt in with NODE_PATH="$DEPS/node_modules" PROCESS3D_INTEGRATION=1 node --test ui/compress3d.test.mjs (requires both KiCad fixtures under OUT)'
  : false};
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

test('BR02 snapshotParts handles both KiCad 10.0.0 and 10.0.6 actual fixture exports', integration, async () => {
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

  const available = fixturePaths();

  let verified = 0;
  for (const p of available) {
    verified++;
    const doc = quietDocument(await io.read(p));
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
  assert.equal(verified, 2, 'both KiCad 10.0.0 and 10.0.6 fixture exports verified');
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
  d.getRoot().listNodes().find(n => n.getName() === 'R12').setTranslation([.017, .002, -.013]);
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
  assertBounds(kept[0], before.find(p => p.ref === 'R12').box, 'R12');
  const {NodeIO} = require('@gltf-transform/core'), {ALL_EXTENSIONS} = require('@gltf-transform/extensions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const emitted = await io.readBinary(await io.writeBinary(d));
  assertMerged(emitted);
  const changed = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getExtras().batch === 'ref:R12');
  assert.ok(changed.length);
  assert.ok(changed.every(n => n.getExtras().ref === 'R12'));
});

test('BR02 batchDocument rejects unstamped mesh nodes', integration, async () => {
  const {d}=makeDocument(['R1']);
  d.getRoot().listNodes().find(n=>n.getMesh()).setExtras({});
  await assert.rejects(P.batchDocument(d), /unstamped mesh node: model-body/);
});

test('BR02 distinct appearance materials remain separate primitives', integration, async () => {
  const {d}=makeDocument(['R1'],2);
  const node=d.getRoot().listNodes().find(n=>n.getMesh());
  node.setExtras({role:'body',batch:'ref:R1',ref:'R1',side:'top'});
  node.getMesh().listPrimitives()[1].setMaterial(d.createMaterial('distinct').setBaseColorFactor([.9,.1,.2,1]));
  P.applyMaterials(d,'ENIG'); await P.batchDocument(d);
  const retained=d.getRoot().listNodes().find(n=>n.getName()==='R1');
  const count=retained.listChildren().reduce((sum,n)=>sum+(n.getMesh()?.listPrimitives().length||0),0);
  assert.equal(count,2);
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

test('BR02 applyMaterials and batchDocument on actual fixture exports', integration, async () => {
  const {NodeIO} = require('@gltf-transform/core');
  const {ALL_EXTENSIONS} = require('@gltf-transform/extensions');
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

  const available = fixturePaths();

  for (const p of available) {
    const doc = quietDocument(await io.read(p));
    const parts = P.snapshotParts(doc, metadata);
    const r1Before = parts.find(part => part.ref === 'R1').box;

    P.applyMaterials(doc, 'ENIG');
    await P.batchDocument(doc);

    // Exercise the actual encoded delivery pipeline on both KiCad hierarchies.
    const {MeshoptDecoder}=require('meshoptimizer');await MeshoptDecoder.ready;
    const deliveryIO=new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({'meshopt.decoder':MeshoptDecoder});
    const dir=mkdtempSync(pathJoin(process.env.OUT,'fixture-processed-'));
    try {
      await P.compress(p,pathJoin(dir,'out.glb'),metadata,pathJoin(dir,'parts.json'),pathJoin(dir,'stats.json'));
      const stats=JSON.parse(readFileSync(pathJoin(dir,'stats.json')));
      const shipped=await deliveryIO.read(pathJoin(dir,'out.glb'));
      assert.deepEqual({triangles:stats.triangles,primitives:stats.primitives},P.geometryCounts(shipped));
      assert.deepEqual(JSON.parse(readFileSync(pathJoin(dir,'parts.json'))),parts,'raw world boxes survive encoding');
      assert.deepEqual([stats.footprints,stats.withModel,stats.placeholders],[6,3,3]);
    } finally {rmSync(dir,{recursive:true,force:true});}

    // Kept reference R1 has exactly one parent node named R1
    const kept = doc.getRoot().listNodes().filter(n => n.getName() === 'R1');
    assert.equal(kept.length, 1, `R1 retained parent node present in ${p}`);
    assert.ok(kept[0].listChildren().length >= 1, 'R1 has children');

    // Bounds of kept R1 reread with getBounds error <= 0.00005 m
    assertBounds(kept[0], r1Before, `R1 in ${p}`);

    // Unchanged components R2 and J1 must NOT have retained identity parents
    assert.ok(!doc.getRoot().listNodes().some(n => ['R2', 'J1'].includes(n.getName())));

    // Emitted binary roundtrip validation
    const emitted = await io.readBinary(await io.writeBinary(doc));

    assertMerged(emitted);

    // Retained R1 changed part in emitted output
    const changed = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getExtras().batch === 'ref:R1');
    assert.ok(changed.length >= 1, `ref:R1 mesh nodes present in ${p}`);
    assert.ok(changed.every(n => n.getExtras().ref === 'R1'));

    // Verify role materials applied on board nodes
    const boardNodes = emitted.getRoot().listNodes().filter(n => n.getMesh() && n.getExtras().batch?.startsWith('board:'));
    const boardBatches = new Set();
    for (const n of boardNodes) {
      const {role, side, batch} = n.getExtras();
      assert.match(batch, /^board:[^:]+:[^:]+$/, `board kind and side batch in ${p}`);
      assert.equal(batch, `board:${role}:${side}`);
      assert.equal(n.getName(), batch);
      assert.ok(!boardBatches.has(batch), `one board node per batch: ${batch} in ${p}`);
      boardBatches.add(batch);
    }
    const copperNodes = boardNodes.filter(n => n.getExtras().role === 'copper');
    assert.ok(copperNodes.length >= 1, 'copper nodes present');
    for (const n of copperNodes) for (const primitive of n.getMesh().listPrimitives()) {
      const mat = primitive.getMaterial();
      assert.deepEqual(mat.getBaseColorFactor(), [.78, .63, .39, 1]);
      assert.equal(mat.getExtension('KHR_materials_anisotropy').getAnisotropyStrength(), .3);
    }

    const padNodes = boardNodes.filter(n => n.getExtras().role === 'pads');
    assert.ok(padNodes.length >= 1, 'pad nodes present');
    for (const n of padNodes) for (const primitive of n.getMesh().listPrimitives()) {
      const mat = primitive.getMaterial();
      assert.deepEqual(mat.getBaseColorFactor(), [1, .78, .34, 1]);
      assert.equal(mat.getMetallicFactor(), 1);
      assert.equal(mat.getRoughnessFactor(), .3);
    }

    const fr4Nodes = boardNodes.filter(n => n.getExtras().role === 'fr4');
    assert.ok(fr4Nodes.length >= 1, 'fr4 nodes present');
    for (const n of fr4Nodes) for (const primitive of n.getMesh().listPrimitives()) {
      const mat = primitive.getMaterial();
      assert.deepEqual(mat.getBaseColorFactor(), [.2, .205, .125, 1]);
      assert.equal(mat.getMetallicFactor(), 0);
      assert.equal(mat.getRoughnessFactor(), .85);
    }

    const maskNodes = boardNodes.filter(n => n.getExtras().role === 'mask');
    assert.ok(maskNodes.length >= 1, 'mask nodes present');
    for (const n of maskNodes) for (const primitive of n.getMesh().listPrimitives()) {
      const mat = primitive.getMaterial();
      assert.equal(mat.getAlphaMode(), 'BLEND');
      assert.deepEqual(mat.getBaseColorFactor(), [.011, .1, .036, .72]);
      assert.equal(mat.getRoughnessFactor(), .6);
      assert.equal(mat.getExtension('KHR_materials_clearcoat').getClearcoatFactor(), .6);
      assert.equal(mat.getExtension('KHR_materials_clearcoat').getClearcoatRoughnessFactor(), .18);
    }
  }
});

test('BR02 shipped coverage equals reread processed GLB counts',integration,async()=>{
  const {NodeIO}=require('@gltf-transform/core');
  const {ALL_EXTENSIONS}=require('@gltf-transform/extensions');
  const {MeshoptDecoder}=require('meshoptimizer');await MeshoptDecoder.ready;
  const dir=mkdtempSync(pathJoin(process.env.OUT,'processor-'));
  try {
    const {d,metadata}=makeDocument(['R1','R2','R12'],20);metadata.keep=['R12'];
    const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
    await io.write(pathJoin(dir,'in.glb'),d);
    await P.compress(pathJoin(dir,'in.glb'),pathJoin(dir,'out.glb'),metadata,
      pathJoin(dir,'parts.json'),pathJoin(dir,'stats.json'));
    const stats=JSON.parse(readFileSync(pathJoin(dir,'stats.json')));
    const final=await io.read(pathJoin(dir,'out.glb'));
    assert.deepEqual({triangles:stats.triangles,primitives:stats.primitives},P.geometryCounts(final));
    assert.ok(stats.primitives<60,'BR02 coverage must be post-batching');
    assert.equal(JSON.parse(readFileSync(pathJoin(dir,'parts.json'))).length,3);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
function gridDocument(n,nonindexed=false) {
  const {d}=makeDocument(['R1']),body=d.getRoot().listNodes().find(n=>n.getMesh());
  body.setExtras({role:'body'});const primitive=body.getMesh().listPrimitives()[0];
  const positions=[],indices=[];
  for(let z=0;z<=n;z++)for(let x=0;x<=n;x++)positions.push(x/n,0,z/n);
  for(let z=0;z<n;z++)for(let x=0;x<n;x++) {
    const a=z*(n+1)+x,b=a+1,c=a+n+1,e=c+1;indices.push(a,c,b,b,c,e);
  }
  primitive.getAttribute('POSITION').setArray(new Float32Array(nonindexed?
    indices.flatMap(i=>positions.slice(i*3,i*3+3)):positions));
  if(nonindexed)primitive.setIndices(null);
  else primitive.getIndices().setArray(new Uint32Array(indices));
  return {d,body,primitive};
}
const arrays=p=>[...p.listSemantics().map(k=>[k,p.getAttribute(k).getArray()]),
  ['indices',p.getIndices()?.getArray()]].map(([k,a])=>[k,a?Buffer.from(a.buffer,a.byteOffset,a.byteLength).toString('hex'):null]);
for(const nonindexed of [false,true])test('BR02 reducible body shrinks and board bytes stay exact '+nonindexed,integration,async()=>{
  const {d,body,primitive}=gridDocument(550,nonindexed);
  const board=['copper','pads','fr4','mask','silk'].map(role=> {
    const n=d.createNode('x_'+role).setMesh(body.getMesh()).setExtras({role});
    d.getRoot().listScenes()[0].addChild(n);return n;
  });
  const before=arrays(primitive), triangles=nonindexed?primitive.getAttribute('POSITION').getCount()/3:primitive.getIndices().getCount()/3;
  await P.simplifyBodies(d);
  const reduced=body.getMesh().listPrimitives()[0];
  assert.ok(reduced.getIndices().getCount()/3<triangles,'BR02 component triangles must decrease');
  for(const n of board)assert.deepEqual(arrays(n.getMesh().listPrimitives()[0]),before);
});
test('BR02 over-budget body delivery prunes replaced geometry and reduces encoded size',integration,async()=>{
  const {NodeIO}=require('@gltf-transform/core'),{ALL_EXTENSIONS}=require('@gltf-transform/extensions');
  const {MeshoptDecoder}=require('meshoptimizer');await MeshoptDecoder.ready;
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  const dir=mkdtempSync(pathJoin(process.env.OUT,'body-delivery-'));
  try {
    const {d}=gridDocument(550),{metadata}=makeDocument(['R1']);
    const before=P.geometryCounts(d).triangles;
    assert.ok(before>600000);
    const input=pathJoin(dir,'in.glb'),baseline=pathJoin(dir,'baseline.glb');
    // Separate destination directories exercise destination-local staging.
    const destinations=['model','parts','stats'].map(name=>pathJoin(dir,name));
    for(const destination of destinations)mkdirSync(destination);
    const output=pathJoin(destinations[0],'out.glb'),parts=pathJoin(destinations[1],'parts.json');
    const stats=pathJoin(destinations[2],'stats.json');
    await io.write(input,d);
    await P.compress(input,baseline);
    await P.compress(input,output,metadata,parts,stats);
    const final=await io.read(output),counts=P.geometryCounts(final);
    assert.ok(counts.triangles<before,'batching must preserve body role for simplification');
    const coverage=JSON.parse(readFileSync(stats));
    assert.deepEqual({triangles:coverage.triangles,primitives:coverage.primitives},counts);
    assert.equal(JSON.parse(readFileSync(parts))[0].hasModel,true);
    const used=new Set();
    for(const scene of final.getRoot().listScenes())scene.traverse(n=>{if(n.getMesh())used.add(n.getMesh());});
    assert.equal(final.getRoot().listMeshes().length,used.size,'no orphaned original body meshes ship');
    assert.ok(statSync(output).size<statSync(baseline).size,'simplification must shrink encoded GLB');
    for(const destination of destinations)assert.ok(!readdirSync(destination).some(p=>p.startsWith('.3d-')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('BR02 below budget stays unchanged',integration,async()=>{
  const {d,body,primitive}=gridDocument(8),before=arrays(primitive),mesh=body.getMesh();
  await P.simplifyBodies(d);assert.equal(body.getMesh(),mesh);assert.deepEqual(arrays(primitive),before);
});
test('BR02 copper dominated workload warns truthfully',integration,async()=>{
  const {d}=gridDocument(550);const node=d.getRoot().listNodes().find(n=>n.getMesh());
  node.setName('large_copper');node.getParentNode().removeChild(node);
  d.getRoot().listScenes()[0].addChild(node);
  const {metadata}=makeDocument(['R1']);metadata.footprints=[];
  const {stats}=await P.processDocument(d,metadata);
  assert.ok(stats.triangles>600000);assert.ok(stats.warnings.includes('triangle budget exceeded after one body-only pass'));
  assert.equal(stats.triangles,550*550*2,'copper triangles remain above budget');
});

test('BR02 padless footprint does not discard processed board',integration,async()=>{
  const {d,metadata}=makeDocument(['R1','R2']);
  metadata.footprints.push({ref:'LOGO1',uuid:'id-LOGO1',side:'top',pos:[7,8,0],box:null,hasModel:false});
  const {parts,stats}=await P.processDocument(d,metadata);
  assert.equal(stats.footprints,3);assert.equal(stats.withModel,2);
  assert.deepEqual(parts.find(p=>p.ref==='LOGO1').box.filter((_,i)=>i!==1&&i!==4),[.006,.007,.008,.009]);
  assert.ok(d.getRoot().listNodes().some(n=>n.getName().startsWith('parts:merged:')));
});
for(const rgb of [[.7,.02,.01],[.01,.02,.8],[0,0,0],[1,1,1],[.08,.2,.14],[.0627,.16,.1129]])
 test('BR02 processed emitted mask '+rgb,integration,async()=>{
  const {d,metadata}=makeDocument(['R1']);
  const source=d.getRoot().listNodes().find(n=>n.getMesh()).getMesh().listPrimitives()[0];
  const material=d.createMaterial('custom-mask').setBaseColorFactor([...rgb,1]);
  const mesh=d.createMesh().addPrimitive(source.clone().setMaterial(material));
  d.getRoot().listScenes()[0].addChild(d.createNode('sample_soldermask').setMesh(mesh));
  await P.processDocument(d,metadata);
  const {NodeIO}=require('@gltf-transform/core'),{ALL_EXTENSIONS}=require('@gltf-transform/extensions');
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS),emitted=await io.readBinary(await io.writeBinary(d));
  const masks=emitted.getRoot().listNodes().filter(n=>n.getMesh()&&n.getExtras().role==='mask');
  assert.ok(masks.length);
  const expected=[.08,.0627].includes(rgb[0])?[.011,.1,.036]:rgb;
  for(const n of masks)for(const p of n.getMesh().listPrimitives()) {
    const m=p.getMaterial(),rgba=m.getBaseColorFactor(),coat=m.getExtension('KHR_materials_clearcoat');
    assert.ok(expected.every((v,i)=>Math.abs(v-rgba[i])<1e-6),'custom RGB or mapped green');
    assert.equal(rgba[3],.72);assert.equal(m.getAlphaMode(),'BLEND');assert.equal(m.getRoughnessFactor(),.6);
    assert.equal(coat.getClearcoatFactor(),.6);assert.equal(coat.getClearcoatRoughnessFactor(),.18);
  }
 });

test('BR02 incompatible changed appearances diagnose but never waive the hard gate',integration,async()=>{
  const {d,metadata}=makeDocument(['R12'],240);metadata.keep=['R12'];
  const mesh=d.getRoot().listNodes().find(n=>n.getMesh()).getMesh();
  mesh.listPrimitives().forEach((p,i)=>p.setMaterial(d.createMaterial('appearance-'+i)
    .setBaseColorFactor([i/240,.2,.4,1])));
  const {stats,parts}=await P.processDocument(d,metadata);
  assert.equal(parts[0].ref,'R12');assert.equal(stats.primitives,240);
  assert.ok(stats.warnings.some(w=>w.includes('hard draw-call budget exceeded')));
  assert.equal(stats.primitives<100+1,false,'workload must remain an acceptance failure');
});

test('BR02 counts scene instances, indexed and nonindexed triangles, but not lines',integration,()=>{
  const {d}=makeDocument(['R1']);
  const body=d.getRoot().listNodes().find(n=>n.getMesh());
  const mesh=body.getMesh(), source=mesh.listPrimitives()[0];
  mesh.addPrimitive(source.clone().setIndices(null));
  mesh.addPrimitive(source.clone().setMode(1));
  d.getRoot().listScenes()[0].addChild(d.createNode('instance').setMesh(mesh));
  // Unattached geometry is not submitted to the renderer.
  d.createNode('unused').setMesh(mesh);
  assert.deepEqual(P.geometryCounts(d),{triangles:4,primitives:6});
});

test('BR02 rejects corrupt input and missing sidecar paths without touching outputs',integration,async()=>{
  const dir=mkdtempSync(pathJoin(process.env.OUT,'invalid-processor-'));
  try {
    const input=pathJoin(dir,'bad.glb'),output=pathJoin(dir,'out.glb');
    const parts=pathJoin(dir,'parts.json'),stats=pathJoin(dir,'stats.json');
    for(const p of [output,parts,stats])writeFileSync(p,'sentinel');
    writeFileSync(input,'not a glb');
    const {metadata}=makeDocument(['R1']);
    await assert.rejects(P.compress(input,output,metadata,null,stats),/requires --parts and --stats/);
    await assert.rejects(P.compress(input,output,metadata,parts,null),/requires --parts and --stats/);
    await assert.rejects(P.compress(input,output,metadata,parts,stats));
    for(const p of [output,parts,stats])assert.equal(readFileSync(p,'utf8'),'sentinel');
    const {NodeIO}=require('@gltf-transform/core');
    const {d}=makeDocument(['R1']);
    await new NodeIO().write(input,d);
    const invalid={...metadata,footprints:[...metadata.footprints,{ref:'U9',uuid:'bad',side:'top',box:null,pos:[null,0]}]};
    await assert.rejects(P.compress(input,output,invalid,parts,stats),/finite position/);
    for(const p of [output,parts,stats])assert.equal(readFileSync(p,'utf8'),'sentinel');
    assert.ok(existsSync(input));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('BR02 staging failure cleans already-created temp directories before replacing outputs',integration,async()=>{
  const {NodeIO}=require('@gltf-transform/core');
  const dir=mkdtempSync(pathJoin(process.env.OUT,'staging-failure-'));
  try {
    const {d,metadata}=makeDocument(['R1']);
    const input=pathJoin(dir,'in.glb'),output=pathJoin(dir,'out.glb'),stats=pathJoin(dir,'stats.json');
    const parts=pathJoin(dir,'missing','parts.json');
    await new NodeIO().write(input,d);
    for(const p of [output,stats])writeFileSync(p,'sentinel');
    await assert.rejects(P.compress(input,output,metadata,parts,stats),{code:'ENOENT'});
    // Model staging succeeds before the absent parts directory causes failure.
    assert.ok(!readdirSync(dir).some(p=>p.startsWith('.3d-')),'staging finally removes created directories');
    for(const p of [output,stats])assert.equal(readFileSync(p,'utf8'),'sentinel');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('BR02 CLI preserves legacy compression and supports metadata keep override',integration,async()=>{
  const {spawnSync}=require('node:child_process');
  const {NodeIO}=require('@gltf-transform/core'),{ALL_EXTENSIONS}=require('@gltf-transform/extensions');
  const {MeshoptDecoder}=require('meshoptimizer');await MeshoptDecoder.ready;
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  const dir=mkdtempSync(pathJoin(process.env.OUT,'cli-processor-'));
  try {
    const {d,metadata}=makeDocument(['R1','R2']);
    // Legacy direct footprint geometry must retain its named parent pivot.
    const r1=d.getRoot().listNodes().find(n=>n.getName()==='R1');
    const child=r1.listChildren()[0];r1.setMesh(child.getMesh());child.dispose();
    const input=pathJoin(dir,'in.glb'),output=pathJoin(dir,'out.glb'),meta=pathJoin(dir,'meta.json');
    const parts=pathJoin(dir,'parts.json'),stats=pathJoin(dir,'stats.json');
    await io.write(input,d);writeFileSync(meta,JSON.stringify(metadata));
    const run=args=>spawnSync(process.execPath,[new URL('./compress3d.cjs',import.meta.url).pathname,...args],{encoding:'utf8'});
    const legacy=run([input,output]);assert.equal(legacy.status,0,legacy.stderr);
    const emitted=await io.read(output),kept=emitted.getRoot().listNodes().find(n=>n.getName()==='R1');
    assert.ok(kept&&!kept.getMesh()&&kept.listChildren().some(n=>n.getMesh()));
    assert.deepEqual(kept.getTranslation(),r1.getTranslation());
    const processed=run([input,output,'--metadata',meta,'--keep','R1','--parts',parts,'--stats',stats]);
    assert.equal(processed.status,0,processed.stderr);
    const final=await io.read(output);
    assert.ok(final.getRoot().listNodes().some(n=>n.getExtras().batch==='ref:R1'));
    const coverage=JSON.parse(readFileSync(stats));
    assert.deepEqual({triangles:coverage.triangles,primitives:coverage.primitives},P.geometryCounts(final));
    const before=readFileSync(output);
    const missing=run([input,output,'--metadata',meta]);assert.notEqual(missing.status,0);
    assert.match(missing.stderr,/requires --parts and --stats/);
    assert.deepEqual(readFileSync(output),before);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
