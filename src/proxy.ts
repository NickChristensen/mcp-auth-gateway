import type { Env } from "./index";
import { getSession } from "./session";

const PROXY_TIMEOUT = 60000; // 60 seconds

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<{ accessToken: string; expiresAt: number } | null> {
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

    const tokens: TokenResponse = await tokenResponse.json();
    return {
      accessToken: tokens.access_token,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 90 * 24 * 60 * 60 * 1000,
    };
  } catch (error) {
    console.error("Token refresh failed:", error);
    return null;
  }
}

export async function handleMcpProxyRequest(
  request: Request,
  env: Env
): Promise<Response> {
  // Get session
  let session = await getSession(request, env);

  if (!session) {
    // No session - redirect to OAuth
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/authorize",
      },
    });
  }

  // Check if token expired and attempt refresh
  if (session.expiresAt && Date.now() > session.expiresAt - 60000) {
    // 1 min buffer
    if (session.refreshToken) {
      const refreshed = await refreshAccessToken(session.refreshToken, env);
      if (refreshed) {
        session = {
          ...session,
          accessToken: refreshed.accessToken,
          expiresAt: refreshed.expiresAt,
        };
        // TODO: Update session cookie in response if token was refreshed
      } else {
        // Refresh failed - require re-authentication
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer error="invalid_token"',
            Location: "/authorize",
          },
        });
      }
    } else {
      // No refresh token and expired - require re-authentication
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
          Location: "/authorize",
        },
      });
    }
  }

  // Build proxy request
  const originUrl = new URL(env.ORIGIN_MCP_URL);

  // Copy request headers
  const proxyHeaders = new Headers(request.headers);

  // Remove host header to avoid conflicts
  proxyHeaders.delete("host");

  // Add Cloudflare Access service token headers
  proxyHeaders.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
  proxyHeaders.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

  try {
    // Proxy the request to origin with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT);

    const proxyResponse = await fetch(originUrl.toString(), {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
      signal: controller.signal,
      // Don't follow redirects
      redirect: "manual",
    });

    clearTimeout(timeoutId);

    // Stream response back to client
    const responseHeaders = new Headers(proxyResponse.headers);

    // Add CORS headers if needed (though spec says no CORS)
    // responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return new Response("Gateway timeout", { status: 504 });
    }

    console.error("Proxy request failed:", error);
    return new Response("Bad Gateway", { status: 502 });
  }
}
