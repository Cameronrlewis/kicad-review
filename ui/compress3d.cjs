// Runner-only: dependencies are installed at exact versions by review.yml.
const {createHash}=require('node:crypto');
const GREEN=[[.08,.2,.14],[.0627,.16,.1129]];
const maskRGB=rgb=>GREEN.some(g=>g.every((v,i)=>Math.abs(v-rgb[i])<.0001))
  ? [.011,.1,.036]:rgb.slice(0,3);
const padStyle=finish=>/^(ENIG|ENEPIG)$/i.test((finish||'').trim())
  ? {color:[1,.78,.34,1],metal:1,rough:.3}
  : {color:[.5,.5,.5,1],metal:1,rough:.4};
function processorKey(raw,metadata,source) {
  return createHash('sha256').update(raw).update(source).update(JSON.stringify({
    gltf:'4.2.1',meshopt:'0.22.0',budget:600000,ratio:.5,error:.0005,
    ...metadata,keep:[...new Set(metadata.keep)].sort()})).digest('hex');
}

function snapshotParts(document,metadata) {
  const {getBounds}=require('@gltf-transform/functions');
  const refs=new Map(metadata.footprints.map(f=>[f.ref,f]));
  if(refs.size!==metadata.footprints.length) throw Error('duplicate reference');
  const nodes=document.getRoot().listNodes().filter(n=>n.getMesh());
  const bounds=n=>{const b=getBounds(n);return [...b.min,...b.max]};
  const boardNodes=nodes.filter(n=>/_PCB$/i.test(n.getName())||/_PCB$/i.test(n.getMesh()?.getName()));
  const boardBoxes=boardNodes.map(bounds);
  const bottom=boardBoxes.length?Math.min(...boardBoxes.map(b=>b[1])):0;
  const top=boardBoxes.length?Math.max(...boardBoxes.map(b=>b[4])):.0016;
  const boxes=new Map();
  function owner(n,seen=new Set()) {
    if(seen.has(n)) return null;seen.add(n);
    if(refs.has(n.getName())) return refs.get(n.getName());
    for(const p of n.listParents()) {
      if(p.propertyType==='Node') {const found=owner(p,seen);if(found)return found;}
    }
    return null;
  }
  for(const n of nodes) {
    const f=owner(n), b=bounds(n);
    const mName=n.getMesh()?.getName()||'';
    const nName=n.getName()||'';
    const name=[nName,mName].find(s=>/_((?:PCB)|copper|pad|silkscreen|soldermask)$/i.test(s))||nName||mName;
    const suffix=/_((?:PCB)|copper|pad|silkscreen|soldermask)$/i.exec(name)?.[1].toLowerCase();
    const role=f?'body':({pcb:'fr4',soldermask:'mask',silkscreen:'silk',pad:'pads',copper:'copper'}[suffix]);
    if(!role) throw Error('unclassified KiCad mesh: '+name);
    const side=f?f.side:b[1]<(top+bottom)/2&&b[4]>(top+bottom)/2?'both':
      (b[1]+b[4])/2>=(top+bottom)/2?'top':'bottom';
    const batch=f?(metadata.keep?.includes(f.ref)?'ref:'+f.ref:'parts:merged:'+side):'board:'+role+':'+side;
    n.setExtras({...n.getExtras(),role,ref:f?.ref||null,side,batch});
    if(f) {
      const old=boxes.get(f.ref);
      boxes.set(f.ref,old?b.map((x,i)=>i<3?Math.min(x,old[i]):Math.max(x,old[i])):b);
    }
  }
  return metadata.footprints.map(f=>{
    const actual=boxes.get(f.ref);let b=f.box;
    if(!actual&&(!b||b.length!==4||!b.every(Number.isFinite))) {
      if(!f.pos||!f.pos.slice(0,2).every(Number.isFinite)||f.pos.length<2)
        throw Error('footprint has no finite position: '+f.ref);
      // ponytail: padless graphics get a 2 mm estimate, not courtyard/clearance geometry.
      const [x,z]=f.pos;b=[x-1,z-1,x+1,z+1];
    }
    const y=f.side==='bottom'?bottom-.001:top;
    const box=actual||[b[0]/1000,y,b[1]/1000,b[2]/1000,y+.001,b[3]/1000];
    if(!box.every(Number.isFinite)) throw Error('nonfinite world box: '+f.ref);
    return {ref:f.ref,uuid:f.uuid,side:f.side,box,hasModel:!!actual,
      reason:actual?null:(f.reason||'model absent from export')};
  });
}

function applyMaterials(document,finish) {
  const {KHRMaterialsAnisotropy,KHRMaterialsClearcoat}=require('@gltf-transform/extensions');
  const anisotropy=document.createExtension(KHRMaterialsAnisotropy);
  const clearcoat=document.createExtension(KHRMaterialsClearcoat);
  const cache=new Map();
  for(const n of document.getRoot().listNodes()) {
    if(!n.getMesh())continue;
    const role=n.getExtras().role, original=n.getMesh(), mesh=original.clone();
    for(const p of mesh.listPrimitives()) mesh.removePrimitive(p);
    for(const originalPrimitive of original.listPrimitives()) {
      const p=originalPrimitive.clone(), source=p.getMaterial();mesh.addPrimitive(p);
      if(!source||role==='body')continue;
      let roles=cache.get(source);if(!roles)cache.set(source,roles=new Map());
      if(!roles.has(role)) {
        const m=source.clone();roles.set(role,m);
        if(role==='copper')m.setBaseColorFactor([.78,.63,.39,1]).setMetallicFactor(.5).setRoughnessFactor(.42)
          .setExtension('KHR_materials_anisotropy',anisotropy.createAnisotropy().setAnisotropyStrength(.3));
        if(role==='mask')m.setBaseColorFactor([...maskRGB(m.getBaseColorFactor()),.72])
          .setAlphaMode('BLEND').setRoughnessFactor(.6).setExtension('KHR_materials_clearcoat',
            clearcoat.createClearcoat().setClearcoatFactor(.6).setClearcoatRoughnessFactor(.18));
        if(role==='fr4')m.setBaseColorFactor([.2,.205,.125,1]).setMetallicFactor(0).setRoughnessFactor(.85);
        if(role==='pads') {const s=padStyle(finish);m.setBaseColorFactor(s.color).setMetallicFactor(s.metal).setRoughnessFactor(s.rough);}
      }
      p.setMaterial(roles.get(role));
    }
    n.setMesh(mesh);
  }
}

async function batchDocument(document) {
  const {PropertyType}=require('@gltf-transform/core');
  const {flatten,join,weld,dedup,prune}=require('@gltf-transform/functions');
  // Every mesh descendant already carries reference and role extras.
  await document.transform(dedup({propertyTypes:[PropertyType.MATERIAL]}),flatten({cleanup:false}));
  const meshNodes=document.getRoot().listNodes().filter(n=>n.getMesh());
  for(const n of meshNodes) if(!n.getExtras().batch) throw Error('unstamped mesh node: '+n.getName());
  const groups=new Set(meshNodes.map(n=>n.getExtras().batch));
  for(const batch of groups) {
    await document.transform(join({cleanup:false,keepNamed:false,filter:n=>n.getExtras().batch===batch}));
    // join preserves the chosen node's extras; fail instead of losing identity.
    const nodes=document.getRoot().listNodes().filter(n=>n.getMesh()&&n.getExtras().batch===batch);
    if(!nodes.length)throw Error('batch lost role: '+batch);
    for(const n of nodes) {
      const extras=n.getExtras();
      n.setName(batch).setExtras({...extras,
        ...(batch.startsWith('parts:merged:')?{role:'body',side:batch.slice(13),ref:null}:{}),
        ...(batch.startsWith('ref:')?{role:'body',ref:batch.slice(4)}:{})});
    }
  }
  for(const scene of document.getRoot().listScenes()) {
    for(const batch of [...groups].filter(x=>x.startsWith('ref:'))) {
      const nodes=scene.listChildren().filter(n=>n.getMesh()&&n.getExtras().batch===batch);
      if(!nodes.length)continue;
      const parent=document.createNode(batch.slice(4));scene.addChild(parent);
      for(const n of nodes){scene.removeChild(n);parent.addChild(n);}
    }
  }
  await document.transform(weld(),dedup(),prune({keepExtras:true}));
}

module.exports={maskRGB,padStyle,processorKey,snapshotParts,applyMaterials,batchDocument};

function budgetWarnings(counts,metadata) {
  const warnings=[];
  if(counts.triangles>600000)warnings.push('triangle budget exceeded after one body-only pass');
  const changed=new Set(metadata.footprints.filter(f=>metadata.keep?.includes(f.ref)).map(f=>f.uuid)).size;
  if(counts.primitives>=100+changed)warnings.push('hard draw-call budget exceeded: owner decision required');
  return warnings;
}

function geometryCounts(document) {
  let triangles=0,primitives=0;
  for(const scene of document.getRoot().listScenes())scene.traverse(n=>{
    for(const p of n.getMesh()?.listPrimitives()||[]) {
      primitives++;
      if(p.getMode()===4)triangles+=(p.getIndices()||p.getAttribute('POSITION')).getCount()/3;
    }
  });
  return {triangles,primitives};
}
async function simplifyBodies(document) {
  if(geometryCounts(document).triangles<=600000)return;
  const {simplifyPrimitive,weldPrimitive,prune}=require('@gltf-transform/functions');
  const {MeshoptSimplifier}=require('meshoptimizer');await MeshoptSimplifier.ready;
  for(const n of document.getRoot().listNodes()) {
    if(n.getExtras().role!=='body'||!n.getMesh())continue;
    const mesh=n.getMesh().clone();
    for(const p of mesh.listPrimitives())mesh.removePrimitive(p);
    for(const original of n.getMesh().listPrimitives()) {
      const p=original.clone();mesh.addPrimitive(p);
      for(const semantic of p.listSemantics())p.setAttribute(semantic,p.getAttribute(semantic).clone());
      if(p.getIndices())p.setIndices(p.getIndices().clone());
      if(p.getMode()===4) {
        if(!p.getIndices())weldPrimitive(p); // index only this isolated body primitive
        simplifyPrimitive(p,{simplifier:MeshoptSimplifier,ratio:.5,error:.0005});
      }
    }
    n.setMesh(mesh);
  }
  // Replaced meshes and isolated accessors otherwise remain in the emitted GLB.
  await document.transform(prune({keepExtras:true}));
}
async function processDocument(document,metadata) {
  const parts=snapshotParts(document,metadata); // identities only; not final stats
  applyMaterials(document,metadata.finish);
  await batchDocument(document);await simplifyBodies(document);
  const withModel=parts.filter(p=>p.hasModel).length,counts=geometryCounts(document),warnings=[];
  warnings.push(...budgetWarnings(counts,metadata));
  return {parts,stats:{footprints:parts.length,withModel,placeholders:parts.length-withModel,
    ...counts,warnings}};
}
async function compress(input,output,metadata,partsPath,statsPath) {
  if(metadata&&(!partsPath||!statsPath))throw Error('metadata requires --parts and --stats paths');
  const fs=require('node:fs/promises'),path=require('node:path');
  const {NodeIO}=require('@gltf-transform/core'),{ALL_EXTENSIONS}=require('@gltf-transform/extensions');
  const {meshopt}=require('@gltf-transform/functions');
  const {MeshoptEncoder,MeshoptDecoder}=require('meshoptimizer');
  await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
  const document=await io.read(input);
  if(!metadata) {
    // Quantization changes mesh-node transforms. Keep component names and original
    // pivots on parents, so top/bottom classification and old-position ghosts agree.
    for (const node of document.getRoot().listNodes()) {
      if (/^[A-Z]+\d+$/.test(node.getName()) && node.getMesh()) {
        const geometry = document.createNode().setMesh(node.getMesh());
        node.setMesh(null).addChild(geometry);
      }
    }
    await document.transform(meshopt({encoder:MeshoptEncoder,level:'high'}));
    await io.write(output,document);return;
  }
  const result=await processDocument(document,metadata);
  await document.transform(meshopt({encoder:MeshoptEncoder,level:'high'}));
  const temps=[];
  try {
    // Stage beside each destination so every rename stays on its filesystem.
    const staged=[];
    for(const destination of [output,partsPath,statsPath]) {
      const temp=await fs.mkdtemp(path.join(path.dirname(destination),'.3d-'));
      temps.push(temp);staged.push(path.join(temp,path.basename(destination)));
    }
    const [model,parts,stats]=staged;await io.write(model,document);
    Object.assign(result.stats,geometryCounts(await io.read(model)));
    result.stats.warnings=budgetWarnings(result.stats,metadata);
    await fs.writeFile(parts,JSON.stringify(result.parts));
    await fs.writeFile(stats,JSON.stringify(result.stats));
    // Each replacement is atomic, not the set. Caller installs/validates its
    // cache manifest last; a partial set must never be treated as a cache hit.
    await fs.rename(model,output);
    await fs.rename(parts,partsPath);
    await fs.rename(stats,statsPath);
  } finally {await Promise.all(temps.map(temp=>fs.rm(temp,{recursive:true,force:true})));}
}
Object.assign(module.exports,{geometryCounts,simplifyBodies,processDocument,compress});

// ponytail: one sequential processor per Actions workspace; use a cache-entry lock only if concurrent writers are introduced.
async function cachedCompress(input,output,metadata,partsPath,statsPath,cacheRoot) {
  const fs=require('node:fs/promises'),path=require('node:path');
  if(!metadata||!Array.isArray(metadata.keep)||!Array.isArray(metadata.footprints))
    throw Error('cache requires metadata with keep and footprints arrays');
  if(!partsPath||!statsPath)throw Error('metadata requires --parts and --stats paths');
  const manifestPath=path.join(path.dirname(output),'board-processed.json');
  const files=['board.glb','parts.json','stats.json'],destinations=[output,partsPath,statsPath];
  const paths=[input,...destinations,manifestPath].map(file=>path.resolve(file));
  if(new Set(paths).size!==paths.length)throw Error('raw input and processed destinations must be distinct');
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const raw=await fs.readFile(input),key=processorKey(raw,metadata,await fs.readFile(__filename));
  const entry=path.join(cacheRoot,key);
  const valid=async()=>{
    try {
      const m=JSON.parse(await fs.readFile(path.join(entry,'manifest.json'),'utf8'));
      if(m.key!==key)return false;
      for(const file of files)if(m.hashes[file]!==sha(await fs.readFile(path.join(entry,file))))return false;
      return true;
    } catch{return false;}
  };
  try {
    await fs.rm(manifestPath,{force:true});
    if(!await valid()) {
      await fs.mkdir(cacheRoot,{recursive:true});
      const temp=await fs.mkdtemp(path.join(cacheRoot,'.build-'));
      try {
        await compress(input,path.join(temp,files[0]),metadata,path.join(temp,files[1]),path.join(temp,files[2]));
        const hashes={};for(const file of files)hashes[file]=sha(await fs.readFile(path.join(temp,file)));
        await fs.writeFile(path.join(temp,'manifest.json'),JSON.stringify({key,hashes}));
        await fs.rm(entry,{recursive:true,force:true});await fs.rename(temp,entry);
      } finally {await fs.rm(temp,{recursive:true,force:true});}
    }
    for(let i=0;i<files.length;i++)await fs.copyFile(path.join(entry,files[i]),destinations[i]);
    await fs.copyFile(path.join(entry,'manifest.json'),manifestPath);return true;
  } catch(error) {
    await fs.writeFile(output,raw);
    await Promise.all([partsPath,statsPath,manifestPath].map(file=>fs.rm(file,{force:true})));
    console.error('3D optimization unavailable: '+error.message);return false;
  }
}
module.exports.cachedCompress=cachedCompress;

if(require.main===module)(async()=>{
  const [input,output,...args]=process.argv.slice(2);
  const option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1]};
  const meta=option('--metadata')?JSON.parse(require('node:fs').readFileSync(option('--metadata'),'utf8')):null;
  if(meta&&option('--keep'))meta.keep=option('--keep').split(',').filter(Boolean);
  if(meta&&(!option('--parts')||!option('--stats')))
    throw Error('metadata requires --parts and --stats paths');
  if(option('--cache'))await cachedCompress(input,output,meta,option('--parts'),option('--stats'),option('--cache'));
  else await compress(input,output,meta,option('--parts'),option('--stats'));
})().catch(error=>{console.error(error);process.exitCode=1});
