import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register(import.meta.url);

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    const source = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
