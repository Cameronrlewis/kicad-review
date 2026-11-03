// MCP trust boundaries: live GitHub authorization per call and byte-bounded input/output.
export class McpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Counts UTF-8 bytes as they stream in, so a chunked body cannot exceed `limit` in memory.
export async function readBounded(source, limit) {
  const reader = source.body?.getReader();
  if (!reader) return '';
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new McpError('TOO_LARGE', 'Input too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const json = (response) => response.json().catch(() => null);

// Mirrors worker.js access(): owner allow-list, then the user's own token must still read the repository.
// Runs on every tool call; nothing is cached, so revoked access fails before any artifact request.
export async function mcpAccess(env, props, repo, { gh, open, allowedOwners }) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo))
    throw new McpError('UNAVAILABLE', 'Repository unavailable');
  const [owner, name] = repo.split('/');
  if (!allowedOwners(env).includes(owner.toLowerCase())) throw new McpError('UNAVAILABLE', 'Repository unavailable');
  const value = await open(props?.credential || '', env);
  if (!value?.t || !value.u || !(value.e > Date.now())) throw new McpError('AUTH_REQUIRED', 'Sign in again');
  const user = await gh('/user', value.t);
  if (!user.ok || String((await json(user))?.login).toLowerCase() !== String(value.u).toLowerCase())
    throw new McpError('AUTH_REQUIRED', 'Sign in again');
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const result = await gh(root, value.t);
  if (result.status === 429 || result.headers.get('x-ratelimit-remaining') === '0')
    throw new McpError('RATE_LIMIT', 'GitHub rate limit; retry later');
  const repository = result.ok ? await json(result) : null;
  if (!repository?.permissions?.pull || !allowedOwners(env).includes(String(repository.owner?.login).toLowerCase()))
    throw new McpError('UNAVAILABLE', 'Repository unavailable');
  return { login: value.u, token: value.t, repository, root };
}

// List envelope; total null means unknown, which is never reported as complete.
export const page = (items, limit = 15, total = items.length, incomplete = false) => ({
  items: items.slice(0, limit), limit, returned: Math.min(items.length, limit), total,
  truncated: incomplete || total === null || total > limit || items.length > limit,
});

export function bounded(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length <= 32768 ? value
    : { error: { code: 'RESULT_TOO_LARGE', message: 'Narrow the query or reduce limit; no oversized result was sent.' } };
}
