import type { Env } from "./index";

const SESSION_COOKIE_NAME = "mcp_session";
const SESSION_MAX_AGE = 90 * 24 * 60 * 60; // 90 days in seconds

export interface SessionData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
}

export async function encryptSession(
  data: SessionData,
  key: string
): Promise<string> {
  const encoder = new TextEncoder();
  const dataString = JSON.stringify(data);

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
    encoder.encode(dataString)
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decryptSession(
  encrypted: string,
  key: string
): Promise<SessionData | null> {
  try {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key.slice(0, 32).padEnd(32, "0")),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      data
    );

    return JSON.parse(decoder.decode(decrypted));
  } catch {
    return null;
  }
}

export function getSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const sessionCookie = cookies.find((c) =>
    c.startsWith(`${SESSION_COOKIE_NAME}=`)
  );

  return sessionCookie ? sessionCookie.split("=")[1] : null;
}

export async function getSession(
  request: Request,
  env: Env
): Promise<SessionData | null> {
  const encryptedSession = getSessionCookie(request);
  if (!encryptedSession) return null;

  const session = await decryptSession(
    encryptedSession,
    env.COOKIE_ENCRYPTION_KEY
  );
  if (!session) return null;

  // Check if token expired
  if (session.expiresAt && Date.now() > session.expiresAt) {
    return null;
  }

  return session;
}

export async function createSessionCookie(
  data: SessionData,
  env: Env,
  url: URL
): Promise<string> {
  const encrypted = await encryptSession(data, env.COOKIE_ENCRYPTION_KEY);

  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encrypted}`,
    `Max-Age=${SESSION_MAX_AGE}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Path=/`,
    `Domain=${url.hostname}`,
  ];

  return cookieParts.join("; ");
}

export function clearSessionCookie(url: URL): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Path=/`,
    `Domain=${url.hostname}`,
  ].join("; ");
}
