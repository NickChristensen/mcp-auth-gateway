import type { Env } from "./index";
import { createSessionCookie, type SessionData } from "./session";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

export async function handleAuthorizeRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // Build authorization URL
  const authUrl = new URL(env.ACCESS_AUTHORIZATION_URL);
  authUrl.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  authUrl.searchParams.set(
    "redirect_uri",
    `${url.protocol}//${url.host}/callback`
  );
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);

  // Store state in a cookie for CSRF protection
  const stateCookie = [
    `oauth_state=${state}`,
    "Max-Age=600", // 10 minutes
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Path=/`,
  ].join("; ");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": stateCookie,
    },
  });
}

export async function handleCallbackRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  // Verify state cookie matches
  const cookies = request.headers.get("Cookie") || "";
  const stateCookie = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("oauth_state="));

  const expectedState = stateCookie?.split("=")[1];
  if (!expectedState || expectedState !== state) {
    return new Response("Invalid state parameter", { status: 400 });
  }

  // Exchange code for token
  const tokenResponse = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.protocol}//${url.host}/callback`,
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
    }),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    console.error("Token exchange failed:", error);
    return new Response("OAuth token exchange failed", { status: 500 });
  }

  const tokens: TokenResponse = await tokenResponse.json();

  // Create session
  const sessionData: SessionData = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days default
  };

  const sessionCookie = await createSessionCookie(sessionData, env, url);

  // Clear state cookie
  const clearStateCookie = "oauth_state=; Max-Age=0; Path=/";

  // Redirect to root or continue to MCP
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/mcp",
      "Set-Cookie": [sessionCookie, clearStateCookie].join(", "),
    },
  });
}

export async function handleTokenRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new Response("Invalid content type", { status: 400 });
  }

  const body = await request.text();
  const params = new URLSearchParams(body);
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    // Forward to Cloudflare Access
    const tokenResponse = await fetch(env.ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    return new Response(tokenResponse.body, {
      status: tokenResponse.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } else if (grantType === "refresh_token") {
    // Handle refresh token
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

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

    return new Response(tokenResponse.body, {
      status: tokenResponse.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return new Response(JSON.stringify({ error: "unsupported_grant_type" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleRegisterRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  // Return client registration information
  return new Response(
    JSON.stringify(
      {
        client_id: env.ACCESS_CLIENT_ID,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        redirect_uris: [`${baseUrl}/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      },
      null,
      2
    ),
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
