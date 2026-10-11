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

When 3D exports exist, the workflow compresses them on the runner with
`npx --yes @gltf-transform/cli@4.2.1 meshopt input.glb output.glb --level high`
before building the report. This is the standalone `meshopt` command, not
`optimize`: it does not flatten, join, or instance named component/layer nodes.
It reorders and quantizes geometry and writes `EXT_meshopt_compression`.
The original is replaced only on success; compression failure leaves 3D usable.
The loader's decoder supports both compressed and uncompressed GLBs, offline.
