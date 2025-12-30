import type { Env } from "./index";
import {
  type OAuthFlowState,
  type AuthCodeData,
  createAuthCode,
  validateAuthCode,
  createAccessToken,
  verifyPKCE,
  createFlowStateCookie,
  getFlowStateFromCookie,
  clearFlowStateCookie,
} from "./token-store";

interface CloudflareTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

// OAuth Authorization Endpoint - Claude starts here
export async function handleAuthorizeRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  // Extract Claude's OAuth parameters
  const claudeRedirectUri = url.searchParams.get("redirect_uri");
  const claudeCodeChallenge = url.searchParams.get("code_challenge");
  const claudeState = url.searchParams.get("state");
  const responseType = url.searchParams.get("response_type");

  if (!claudeRedirectUri || !claudeCodeChallenge || !claudeState) {
    return new Response("Missing required OAuth parameters", { status: 400 });
  }

  if (responseType !== "code") {
    return new Response("Only authorization_code flow is supported", {
      status: 400,
    });
  }

  // Generate state for Cloudflare Access flow
  const cloudflareState = crypto.randomUUID();

  // Store Claude's OAuth params in a cookie
  const flowState: OAuthFlowState = {
    claudeRedirectUri,
    claudeCodeChallenge,
    claudeState,
    cloudflareState,
  };

  // Build Cloudflare Access authorization URL
  const authUrl = new URL(env.ACCESS_AUTHORIZATION_URL);
  authUrl.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  authUrl.searchParams.set(
    "redirect_uri",
    `${url.protocol}//${url.host}/callback`
  );
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", cloudflareState);
  authUrl.searchParams.set("nonce", crypto.randomUUID());

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": createFlowStateCookie(flowState, url),
    },
  });
}

// OAuth Callback - Cloudflare Access redirects here after authentication
export async function handleCallbackRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const cloudflareCode = url.searchParams.get("code");
  const cloudflareState = url.searchParams.get("state");

  if (!cloudflareCode || !cloudflareState) {
    return new Response("Missing code or state from Cloudflare", {
      status: 400,
    });
  }

  // Get stored OAuth flow state
  const flowState = getFlowStateFromCookie(request);
  if (!flowState) {
    return new Response("OAuth flow state not found or expired", {
      status: 400,
    });
  }

  // Verify state matches
  if (flowState.cloudflareState !== cloudflareState) {
    return new Response("Invalid state parameter", { status: 400 });
  }

  // Exchange Cloudflare's authorization code for tokens
  const tokenResponse = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: cloudflareCode,
      redirect_uri: `${url.protocol}//${url.host}/callback`,
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
    }),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    console.error("Cloudflare token exchange failed:", error);
    return new Response("Failed to authenticate with Cloudflare Access", {
      status: 500,
    });
  }

  const tokens: CloudflareTokenResponse = await tokenResponse.json();

  // Create our authorization code for Claude
  const authCodeData: AuthCodeData = {
    cloudflareTokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 24 * 60 * 60 * 1000, // Default to 24 hours
    },
    codeChallenge: flowState.claudeCodeChallenge,
  };

  const ourCode = await createAuthCode(authCodeData, env);

  // Build redirect URL back to Claude
  const claudeRedirect = new URL(flowState.claudeRedirectUri);
  claudeRedirect.searchParams.set("code", ourCode);
  claudeRedirect.searchParams.set("state", flowState.claudeState);

  // Clear the flow state cookie
  return new Response(null, {
    status: 302,
    headers: {
      Location: claudeRedirect.toString(),
      "Set-Cookie": clearFlowStateCookie(),
    },
  });
}

// OAuth Token Endpoint - Claude exchanges authorization code for access token
export async function handleTokenRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description:
          "Content-Type must be application/x-www-form-urlencoded",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await request.text();
  const params = new URLSearchParams(body);
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");

    if (!code || !codeVerifier) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate and decode our authorization code
    const authCodeData = await validateAuthCode(code, env);
    if (!authCodeData) {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Authorization code is invalid or expired",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify PKCE
    const pkceValid = await verifyPKCE(
      codeVerifier,
      authCodeData.codeChallenge
    );
    if (!pkceValid) {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Code verifier does not match code challenge",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create our access token (encodes Cloudflare tokens)
    const accessToken = await createAccessToken(
      authCodeData.cloudflareTokens,
      env
    );

    // Return OAuth token response
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(
          (authCodeData.cloudflareTokens.expiresAt - Date.now()) / 1000
        ),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      }
    );
  }

  return new Response(
    JSON.stringify({ error: "unsupported_grant_type" }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

// OAuth Dynamic Client Registration
export async function handleRegisterRequest(
  request: Request,
  _env: Env
): Promise<Response> {
  // Parse client registration request (if provided)
  let redirectUris: string[] = [];
  if (request.method === "POST") {
    try {
      const body: { redirect_uris?: string[] } = await request.json();
      if (body.redirect_uris && Array.isArray(body.redirect_uris)) {
        redirectUris = body.redirect_uris;
      }
    } catch {
      // If no body or invalid JSON, use empty array
    }
  }

  // Return client registration response per RFC 7591
  return new Response(
    JSON.stringify(
      {
        client_id: "mcp-gateway", // Static client ID for our gateway
        client_id_issued_at: Math.floor(Date.now() / 1000),
        grant_types: ["authorization_code"],
        response_types: ["code"],
        redirect_uris: redirectUris.length > 0 ? redirectUris : undefined,
        token_endpoint_auth_method: "none", // PKCE handles security
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
