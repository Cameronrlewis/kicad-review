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

async function compress(input, output) {
  const { NodeIO } = require('@gltf-transform/core');
  const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
  const { meshopt } = require('@gltf-transform/functions');
  const { MeshoptEncoder, MeshoptDecoder } = require('meshoptimizer');

  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
  });
  const document = await io.read(input);
  // Quantization changes mesh-node transforms. Keep component names and original
  // pivots on parents, so top/bottom classification and old-position ghosts agree.
  for (const node of document.getRoot().listNodes()) {
    if (/^[A-Z]+\d+$/.test(node.getName()) && node.getMesh()) {
      const geometry = document.createNode().setMesh(node.getMesh());
      node.setMesh(null).addChild(geometry);
    }
  }
  // No flatten/join/instance: those operations would lose reference/layer names.
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  await io.write(output, document);
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

module.exports={maskRGB,padStyle,processorKey,snapshotParts};

if(require.main===module) compress(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1});
