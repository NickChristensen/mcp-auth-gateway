import { handleMcpProxyRequest } from "./proxy";
import {
  handleAuthorizeRequest,
  handleCallbackRequest,
  handleTokenRequest,
  handleRegisterRequest,
} from "./oauth";

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
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Route handling
    switch (url.pathname) {
      case "/":
        return new Response("Not Found", { status: 404 });

      case "/mcp":
        return handleMcpProxyRequest(request, env);

      case "/authorize":
        return handleAuthorizeRequest(request, env);

      case "/callback":
        return handleCallbackRequest(request, env);

      case "/token":
        return handleTokenRequest(request, env);

      case "/register":
        return handleRegisterRequest(request, env);

      case "/.well-known/oauth-authorization-server":
        return handleOAuthDiscovery(request, env);

      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return handleProtectedResourceMetadata(request, env);

      default:
        return new Response("Not Found", { status: 404 });
    }
  },
};

function handleOAuthDiscovery(request: Request, _env: Env): Response {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  return new Response(
    JSON.stringify(
      {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      null,
      2
    ),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

function handleProtectedResourceMetadata(
  request: Request,
  _env: Env
): Response {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  return new Response(
    JSON.stringify(
      {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
        resource_documentation: `${baseUrl}/mcp`,
      },
      null,
      2
    ),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
