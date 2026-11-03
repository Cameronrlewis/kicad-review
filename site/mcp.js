import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readBounded, bounded } from './mcp-data.js';

// Stateless Streamable HTTP: one Server and transport per POST, JSON responses only, no session id or GET stream.
export async function mcpResponse(request, tools, call) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  let text;
  try { text = await readBounded(request, 16384); } catch { return new Response('Request too large or invalid UTF-8', { status: 413 }); }
  const server = new Server({ name: 'kicad-review', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const payload = bounded(await call(params.name, params.arguments || {}));
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
