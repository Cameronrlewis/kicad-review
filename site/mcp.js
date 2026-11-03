import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Stateless Streamable HTTP: one Server and transport per POST, JSON responses only, no session id or GET stream.
export async function mcpResponse(request, tools, call) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  // ponytail: buffers the whole body before the size check; Task 2 swaps in readBounded for chunked requests.
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > 16384) return new Response('Request too large', { status: 413 });
  const server = new Server({ name: 'kicad-review', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const payload = await call(params.name, params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(payload.error ? { isError: true } : {}) };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const result = await transport.handleRequest(new Request(request, { body: bytes }));
    // Read the body before close() so an async handler is not cut off.
    const body = await result.arrayBuffer();
    return new Response(body, { status: result.status, headers: result.headers });
  } finally { await server.close(); }
}
