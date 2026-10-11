# three-viewer bundle

Source entry: `three-viewer.entry.js`

Build with:

```sh
# Run from the repository root. Use an isolated build directory; no project dependencies.
build=$(mktemp -d)
npm install --prefix "$build" --no-save --package-lock=false three@0.186.1 esbuild@0.25.10
NODE_PATH="$build/node_modules" "$build/node_modules/.bin/esbuild" ui/vendor/three-viewer.entry.js --bundle --format=iife --minify --outfile=ui/vendor/three-viewer.min.js
rm -rf "$build"
```

This prebuilt IIFE bundles [three.js 0.186.1](https://threejs.org/), including `GLTFLoader`, `OrbitControls`, and `MeshoptDecoder`, under the MIT License. Its full license text is in `LICENSE`.

When 3D exports exist, the workflow installs exact runner-only dependencies and
compresses them before building the report:

```sh
npm install --prefix "$deps" --no-save --package-lock=false @gltf-transform/core@4.2.1 @gltf-transform/extensions@4.2.1 @gltf-transform/functions@4.2.1 meshoptimizer@0.22.0
NODE_PATH="$deps/node_modules" node ui/compress3d.cjs input.glb output.glb
```

`compress3d.cjs` uses the standalone `meshopt` transform at `level: 'high'`, not
`optimize`: it does not flatten, join, or instance named component/layer nodes.
It reorders and quantizes geometry and writes `EXT_meshopt_compression`.
Before quantization, component mesh nodes get anonymous geometry children, keeping
the named parent pivots unchanged. The viewer classifies component side from that
reference parent, not the geometry pivot (quantization can move a pivot across the
board plane). Layer mesh names remain intact.
The original is replaced only on success; compression failure leaves 3D usable.
The loader's decoder supports both compressed and uncompressed GLBs, offline.
