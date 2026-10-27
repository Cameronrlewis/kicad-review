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

module.exports={maskRGB,padStyle,processorKey};

if(require.main===module) compress(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1});
