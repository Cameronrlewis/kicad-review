// Shared policy values stay outside the Worker entrypoint module.
// The meshopt GLB decoder needs WebAssembly compilation, while JavaScript eval stays blocked.
export const reportCsp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; "
  + "script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-ancestors 'self'";
export const frameCsp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
