// Runner-only: dependencies are installed at exact versions by review.yml.
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { meshopt } = require('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder } = require('meshoptimizer');

async function compress(input, output) {
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
compress(process.argv[2], process.argv[3]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
