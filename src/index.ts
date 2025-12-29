export interface Env {
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_JWKS_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  ORIGIN_MCP_URL: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route handling
    switch (url.pathname) {
      case '/':
        return new Response('Not Found', { status: 404 });

      case '/mcp':
        return handleMcpProxy(request, env);

      case '/authorize':
        return handleAuthorize(request, env);

      case '/callback':
        return handleCallback(request, env);

      case '/token':
        return handleToken(request, env);

      case '/register':
        return handleRegister(request, env);

      case '/.well-known/oauth-authorization-server':
        return handleDiscovery(request, env);

      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

async function handleMcpProxy(_request: Request, _env: Env): Promise<Response> {
  // TODO: Implement OAuth session validation
  // TODO: Proxy to ORIGIN_MCP_URL with service token headers
  return new Response('MCP proxy not yet implemented', { status: 501 });
}

async function handleAuthorize(_request: Request, _env: Env): Promise<Response> {
  // TODO: Implement OAuth authorization flow
  return new Response('OAuth authorize not yet implemented', { status: 501 });
}

async function handleCallback(_request: Request, _env: Env): Promise<Response> {
  // TODO: Implement OAuth callback handler
  return new Response('OAuth callback not yet implemented', { status: 501 });
}

async function handleToken(_request: Request, _env: Env): Promise<Response> {
  // TODO: Implement OAuth token endpoint
  return new Response('OAuth token not yet implemented', { status: 501 });
}

async function handleRegister(_request: Request, _env: Env): Promise<Response> {
  // TODO: Implement OAuth dynamic client registration
  return new Response('OAuth register not yet implemented', { status: 501 });
}

async function handleDiscovery(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  return new Response(JSON.stringify({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
