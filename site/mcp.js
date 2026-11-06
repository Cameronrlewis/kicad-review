import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readBounded, bounded } from './mcp-data.js';

const str = maxLength => ({ type: 'string', minLength: 1, maxLength });
const repo = { ...str(201), pattern: '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$' };
const common = { repo, ref: str(255), project: { ...str(500), minLength: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } };
const annotation = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tool = (name, description, properties, required = ['repo']) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: annotation });
export const TOOLS = [
  tool('list_projects', 'List reviewed projects and latest reviewed commits; report current tip separately.', { repo, limit: common.limit }),
  tool('get_design', 'Board facts, sheets, part count and check summaries at an exact reviewed revision.', common),
  tool('find_parts', 'Find references, values, MPNs and stored property text; literal case-insensitive substring, not regex.', { ...common, query: str(200) }, ['repo', 'query']),
  tool('get_net', 'Exact net pins and part values; if missing, return partial-name suggestions without guessing.', { ...common, net: str(2000) }, ['repo', 'net']),
  tool('get_review', 'Changes, checks, open anchored threads and current readiness for a pull-request head.', { repo, pr: { type: 'integer', minimum: 1, maximum: 2147483647 }, limit: common.limit }, ['repo', 'pr']),
  tool('get_bom', 'Grouped non-DNP BOM at a reviewed revision, JSON or bounded CSV; no supplier requests.', { ...common, format: { type: 'string', enum: ['json', 'csv'] } }),
];
export function validateTool(name, args) {
  const schema = TOOLS.find(t => t.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments');
  if (schema.required.some(k => !Object.hasOwn(args, k))) throw new Error('Invalid tool arguments: required field');
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error('Invalid tool arguments: unknown field');
    const rule = schema.properties[key];
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) throw new Error('Invalid integer');
    if (rule.type === 'string' && (typeof value !== 'string' || (rule.minLength && value.length < rule.minLength) || (rule.maxLength && value.length > rule.maxLength) || (rule.pattern && !new RegExp(rule.pattern).test(value)) || (rule.enum && !rule.enum.includes(value)))) throw new Error('Invalid string');
  }
  return { ...args, limit: args.limit ?? 15 };
}

// Stateless Streamable HTTP: one Server and transport per POST, JSON responses only, no session id or GET stream.
export async function mcpResponse(request, tools, call) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  let text, raw;
  try { text = await readBounded(request, 16384); } catch { return new Response('Request too large or invalid UTF-8', { status: 413 }); }
  try { raw = JSON.parse(text); } catch {}
  const server = new Server({ name: 'kicad-review', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  // Re-parse raw JSON body to preserve '__proto__' and other prototype keys that the SDK's schema parser drops.
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const rawMsg = Array.isArray(raw) ? raw.find(r => r?.id === extra?.requestId) : raw;
    let args = rawMsg?.params?.arguments ?? params.arguments ?? {};
    try {
      args = validateTool(params.name, args);
    } catch {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'Invalid tool arguments' } }) }] };
    }
    const payload = bounded(await call(params.name, args));
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(payload.error ? { isError: true } : {}) };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const result = await transport.handleRequest(new Request(request, { body: text }));
    // Read the body before close() so an async handler is not cut off.
    const body = await result.arrayBuffer();
    return new Response(body, { status: result.status, headers: result.headers });
  } finally { await server.close(); }
}
