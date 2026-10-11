# three-viewer bundle

Source entry: `three-viewer.entry.js`

Build with:

```sh
npx --yes --package=three@0.186.1 --package=esbuild@0.25.10 esbuild ui/vendor/three-viewer.entry.js --bundle --format=iife --minify --outfile=ui/vendor/three-viewer.min.js
```

This prebuilt IIFE bundles [three.js 0.186.1](https://threejs.org/), including `GLTFLoader` and `OrbitControls`, under the MIT License. Its full license text is in `LICENSE`.
