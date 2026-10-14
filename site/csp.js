// Shared policy values stay outside the Worker entrypoint module.
export const reportCsp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; "
  + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-ancestors 'self'";
export const frameCsp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
