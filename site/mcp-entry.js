import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import legacy, { session, open, seal, gh, allowedOwners, verifyReport } from './worker.js';
import { loadContext } from './ask.js';
import { consentRoute, oauthFetch } from './mcp-auth.js';
import { mcpResponse, TOOLS, validateTool } from './mcp.js';
import { runTool } from './mcp-data.js';
// Wrangler finds Durable Object classes only on the entry module.
export { RefreshCoordinator } from './worker.js';

// Wrangler entry point: OAuth provider around POST /mcp; every other route falls through to the existing site.
// Overrides are test-only code injection, never request parameters.
export function makeMcpWorker(overrides = {}) {
  const { onProvider, onError = () => {}, ...dataOverrides } = overrides;
  const deps = { gh, open, allowedOwners, loadContext, verifyReport, ...dataOverrides };
  const options = {
    apiRoute: '/mcp',
    apiHandler: { fetch: (request, env, ctx) => {
      // Test-only observer injected by the module caller, reached only after provider bearer validation.
      onProvider?.(env.OAUTH_PROVIDER);
      return mcpResponse(request, TOOLS, (name, args) => runTool(name, validateTool(name, args), { env, props: ctx.props, origin: new URL(request.url).origin }, deps));
    } },
    defaultHandler: { fetch: async (request, env, ctx) => (await consentRoute(request, env, { session, open: deps.open, seal })) || legacy.fetch(request, env, ctx) },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register',
    accessTokenTTL: 3600, refreshTokenTTL: 0, scopesSupported: ['read:design'],
    onError,
  };
  // The provider binds tokens to one absolute resource URL, so it is built for the request's own origin.
  // A per-request env copy keeps env.OAUTH_PROVIDER helpers from leaking across origins or requests.
  const provider = { fetch: (request, env, ctx) => {
    const origin = new URL(request.url).origin;
    return new OAuthProvider({ ...options, resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin] } }).fetch(request, { ...env }, ctx);
  } };
  return { fetch: (request, env, ctx) => oauthFetch(request, env, ctx, provider, legacy) };
}
export default makeMcpWorker();
