import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register(import.meta.url);

// Silence @cloudflare/workers-oauth-provider CIMD warning in Node test environment.
globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };

// Node has no workerd built-ins; the OAuth provider only needs WorkerEntrypoint for an instanceof check.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css') || /\/ui\/[^/]+\.js$/.test(url) || url.endsWith('/ui/review.html') || url.endsWith('/ui/icons/sprite.svg')) {
    const source = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
