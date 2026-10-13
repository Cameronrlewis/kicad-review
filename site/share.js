// Read-only, artifact-bound capabilities. No GitHub credential enters a URL or page.
const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64url = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const name = /^[A-Za-z0-9_.-]{1,100}$/;
const maxLife = 30 * 86400_000;
async function hmacKey(env) {
  const bytes = unb64url(env.SHARE_KEY.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''));
  if (bytes.length !== 32) throw new Error('Invalid share key');
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signShare(claims, env) {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  return `${body}.${b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)))}`;
}
export async function verifyShare(token, env, now = Date.now()) {
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 2048) return null;
    const [body, sig] = token.split('.');
    const signature = unb64url(sig);
    if (signature.length !== 32 || b64url(signature) !== sig) return null;
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), signature, enc.encode(body))) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return c && typeof c.o === 'string' && typeof c.r === 'string' && name.test(c.o) && name.test(c.r) && c.o !== '.' && c.o !== '..' && c.r !== '.' && c.r !== '..'
      && Number.isSafeInteger(c.a) && c.a > 0 && Number.isSafeInteger(c.g) && c.g >= 0
      && Number.isSafeInteger(c.exp) && c.exp > now && c.exp <= now + maxLife ? c : null;
  } catch { return null; }
}
