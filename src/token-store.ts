import type { Env } from "./index";

// Token storage using encrypted tokens (no KV needed - tokens are self-contained)
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CloudflareTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface AuthCodeData {
  cloudflareTokens: CloudflareTokens;
  codeChallenge: string;
}

export interface OAuthFlowState {
  claudeRedirectUri: string;
  claudeCodeChallenge: string;
  claudeState: string;
  cloudflareState: string;
}

// Encrypt data into a token string
async function encryptData(data: any, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key.slice(0, 32).padEnd(32, "0")),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoder.encode(JSON.stringify(data))
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// Decrypt token string back to data
async function decryptData(token: string, key: string): Promise<any> {
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key.slice(0, 32).padEnd(32, "0")),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padding);

    const combined = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      encrypted
    );

    return JSON.parse(decoder.decode(decrypted));
  } catch (error) {
    return null;
  }
}

// Create an authorization code that encodes the Cloudflare tokens + code challenge
export async function createAuthCode(
  data: AuthCodeData,
  env: Env
): Promise<string> {
  return await encryptData(
    {
      ...data,
      type: "auth_code",
      createdAt: Date.now(),
    },
    env.COOKIE_ENCRYPTION_KEY
  );
}

// Decode and validate an authorization code
export async function validateAuthCode(
  code: string,
  env: Env
): Promise<AuthCodeData | null> {
  const data = await decryptData(code, env.COOKIE_ENCRYPTION_KEY);
  if (!data || data.type !== "auth_code") {
    return null;
  }

  // Auth codes expire after 10 minutes
  if (Date.now() - data.createdAt > 10 * 60 * 1000) {
    return null;
  }

  return {
    cloudflareTokens: data.cloudflareTokens,
    codeChallenge: data.codeChallenge,
  };
}

// Create an access token that encodes the Cloudflare tokens
export async function createAccessToken(
  cloudflareTokens: CloudflareTokens,
  env: Env
): Promise<string> {
  return await encryptData(
    {
      cloudflareTokens,
      type: "access_token",
      createdAt: Date.now(),
    },
    env.COOKIE_ENCRYPTION_KEY
  );
}

// Decode and validate an access token
export async function validateAccessToken(
  token: string,
  env: Env
): Promise<CloudflareTokens | null> {
  const data = await decryptData(token, env.COOKIE_ENCRYPTION_KEY);
  if (!data || data.type !== "access_token") {
    return null;
  }

  // Check if Cloudflare token is expired
  if (
    data.cloudflareTokens.expiresAt &&
    Date.now() > data.cloudflareTokens.expiresAt
  ) {
    return null;
  }

  return data.cloudflareTokens;
}

// Verify PKCE challenge
export async function verifyPKCE(
  codeVerifier: string,
  codeChallenge: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const computed = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return computed === codeChallenge;
}

// OAuth flow state cookie management
export function createFlowStateCookie(
  state: OAuthFlowState,
  baseUrl: URL
): string {
  const encoded = btoa(JSON.stringify(state));
  return [
    `oauth_flow=${encoded}`,
    "Max-Age=600", // 10 minutes
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Path=/`,
    `Domain=${baseUrl.hostname}`,
  ].join("; ");
}

export function getFlowStateFromCookie(
  request: Request
): OAuthFlowState | null {
  const cookies = request.headers.get("Cookie") || "";
  const flowCookie = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("oauth_flow="));

  if (!flowCookie) {
    return null;
  }

  try {
    const encoded = flowCookie.split("=")[1];
    return JSON.parse(atob(encoded));
  } catch {
    return null;
  }
}

export function clearFlowStateCookie(): string {
  return "oauth_flow=; Max-Age=0; Path=/";
}
