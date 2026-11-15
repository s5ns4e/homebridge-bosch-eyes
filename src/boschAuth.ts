import crypto from 'crypto';

const KEYCLOAK_BASE =
  'https://smarthome.authz.bosch.com/auth/realms/home_auth_provider/protocol/openid-connect';
const CLIENT_ID = 'oss_residential_app';
// Public client secret shared by all open-source Bosch Smart Home clients (ioBroker, Python-BSH-CLI, etc.)
// It is intentionally embedded here, identical to those implementations.
const CLIENT_SECRET = Buffer.from('RjFqWnpzRzVOdHc3eDJWVmM4SjZxZ3NuaXNNT2ZhWmc=', 'base64').toString('utf-8');
const REDIRECT_URI = 'https://www.bosch.com/boschcam';
const SCOPES = 'email offline_access profile openid';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

// Fixed PKCE verifier — makes the auth URL static so it can be embedded as a clickable link
// in the Homebridge config UI. Security is equivalent to plain authorization_code + client_secret,
// which is the strongest flow Bosch allows for this public client.
export const STATIC_PKCE_VERIFIER = 'BoschEyesHomebridgePlugin-StaticVerifier-v1-xK9pQmNw7DyR';

// Pre-computed: BASE64URL(SHA256(STATIC_PKCE_VERIFIER))
const STATIC_PKCE_CHALLENGE = 'iKgRlRLGEjGhoPztbIEY-g6wNAP8lE2pPqEi7Q1mBbk';

export const AUTH_URL =
  `${KEYCLOAK_BASE}/auth?client_id=${CLIENT_ID}&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&code_challenge=${STATIC_PKCE_CHALLENGE}&code_challenge_method=S256`;

/** @deprecated Use STATIC_PKCE_VERIFIER + AUTH_URL instead */
export function generatePkce(): { verifier: string; challenge: string } {
  return { verifier: STATIC_PKCE_VERIFIER, challenge: STATIC_PKCE_CHALLENGE };
}

/** @deprecated Use AUTH_URL constant instead */
export function buildAuthUrl(_verifier?: string): string {
  return AUTH_URL;
}

async function tokenPost(params: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params });
  const res = await fetch(`${KEYCLOAK_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
}

/** Exchange PKCE authorization code for tokens (kept for migration). */
export function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  return tokenPost({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

/** Authenticate directly with username + password (Resource Owner Password Credentials grant). */
export function loginWithPassword(username: string, password: string): Promise<TokenSet> {
  return tokenPost({
    grant_type: 'password',
    username,
    password,
    scope: SCOPES,
  });
}

/** Refresh an expired access token using the long-lived refresh token. */
export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenPost({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}
