import type { Env } from "./index";
import { validateAccessToken, type CloudflareTokens } from "./token-store";

const PROXY_TIMEOUT = 60000; // 60 seconds

async function refreshCloudflareToken(
  refreshToken: string,
  env: Env
): Promise<CloudflareTokens | null> {
  try {
    const tokenResponse = await fetch(env.ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: env.ACCESS_CLIENT_ID,
        client_secret: env.ACCESS_CLIENT_SECRET,
      }),
    });

    if (!tokenResponse.ok) {
      return null;
    }

    const tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    } = await tokenResponse.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 24 * 60 * 60 * 1000, // Default to 24 hours
    };
  } catch (error) {
    console.error("Cloudflare token refresh failed:", error);
    return null;
  }
}

export async function handleMcpProxyRequest(
  request: Request,
  env: Env
): Promise<Response> {
  // Extract Bearer token from Authorization header
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="MCP Gateway"',
      },
    });
  }

  const accessToken = authHeader.substring(7); // Remove "Bearer "

  // Validate and decode our access token to get Cloudflare tokens
  let cloudflareTokens = await validateAccessToken(accessToken, env);
  if (!cloudflareTokens) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer error="invalid_token"',
      },
    });
  }

  // Save original access token expiry (embedded in the access token)
  const accessTokenExpiresAt = cloudflareTokens.expiresAt;

  // Check if Cloudflare token is about to expire and refresh if needed
  if (
    cloudflareTokens.expiresAt &&
    Date.now() > cloudflareTokens.expiresAt - 3600000
  ) {
    if (cloudflareTokens.refreshToken) {
      const refreshed = await refreshCloudflareToken(
        cloudflareTokens.refreshToken,
        env
      );
      if (refreshed) {
        cloudflareTokens = refreshed;
        // Note: Client will continue using same access token, but we use refreshed Cloudflare tokens
      } else {
        // Refresh failed - require re-authentication
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          },
        });
      }
    }
  }

  // Build proxy request to origin
  const originUrl = new URL(env.ORIGIN_MCP_URL);

  // Copy request headers
  const proxyHeaders = new Headers(request.headers);

  // Debug logging (commented out - uncomment for troubleshooting)
  // console.log("Incoming headers:", {
  //   method: request.method,
  //   accept: request.headers.get("accept"),
  //   contentType: request.headers.get("content-type"),
  //   mcpSessionId: request.headers.get("mcp-session-id"),
  // });

  // Remove headers that should not be forwarded
  proxyHeaders.delete("host");
  proxyHeaders.delete("authorization"); // Remove Claude's auth, we'll use service tokens

  // Add Cloudflare Access service token headers for origin authentication
  proxyHeaders.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
  proxyHeaders.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

  // Debug logging (commented out - uncomment for troubleshooting)
  // console.log("Forwarding to origin:", {
  //   url: originUrl.toString(),
  //   mcpSessionId: proxyHeaders.get("mcp-session-id"),
  // });

  try {
    // Proxy the request to origin with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT);

    const proxyResponse = await fetch(originUrl.toString(), {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
      signal: controller.signal,
      redirect: "manual", // Don't follow redirects
    });

    clearTimeout(timeoutId);

    // Debug logging (commented out - uncomment for troubleshooting)
    // console.log("Origin response:", {
    //   status: proxyResponse.status,
    //   contentType: proxyResponse.headers.get("content-type"),
    //   mcpSessionId: proxyResponse.headers.get("mcp-session-id"),
    // });

    // Stream response back to client
    const responseHeaders = new Headers(proxyResponse.headers);

    // Add proactive refresh hint
    if (accessTokenExpiresAt) {
      const timeUntilExpiry = accessTokenExpiresAt - Date.now();
      responseHeaders.set(
        "X-Token-Expires-In",
        Math.floor(timeUntilExpiry / 1000).toString()
      );
    }

    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Gateway timeout",
          },
          id: null,
        }),
        {
          status: 504,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    console.error("Proxy request failed:", error);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Gateway",
        },
        id: null,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
