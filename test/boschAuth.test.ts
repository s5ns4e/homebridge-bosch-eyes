import crypto from 'crypto';

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { generatePkce, buildAuthUrl, AUTH_URL, STATIC_PKCE_VERIFIER, loginWithPassword, refreshTokens } from '../src/boschAuth';

describe('generatePkce', () => {
  it('returns the static verifier and its S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toBe(STATIC_PKCE_VERIFIER);
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('challenge differs from verifier', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).not.toBe(challenge);
  });
});

describe('AUTH_URL / buildAuthUrl', () => {
  it('contains the static PKCE challenge', () => {
    const { challenge } = generatePkce();
    expect(AUTH_URL).toContain(`code_challenge=${challenge}`);
    expect(AUTH_URL).toContain('code_challenge_method=S256');
    expect(AUTH_URL).toContain('client_id=oss_residential_app');
  });

  it('targets the Bosch Keycloak endpoint', () => {
    expect(AUTH_URL).toContain('smarthome.authz.bosch.com');
  });

  it('buildAuthUrl returns AUTH_URL regardless of argument', () => {
    expect(buildAuthUrl('anything')).toBe(AUTH_URL);
    expect(buildAuthUrl()).toBe(AUTH_URL);
  });
});

function makeTokenResponse() {
  return {
    ok: true,
    text: async () => '',
    json: async () => ({
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
    }),
  };
}

describe('loginWithPassword', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('sends ROPC grant with username and password', async () => {
    mockFetch.mockResolvedValueOnce(makeTokenResponse());
    await loginWithPassword('user@example.com', 'secret123');
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/token');
    const body = options.body as string;
    expect(body).toContain('grant_type=password');
    expect(body).toContain('username=user%40example.com');
    expect(body).toContain('password=secret123');
  });

  it('returns a TokenSet with expiresAt in the future', async () => {
    mockFetch.mockResolvedValueOnce(makeTokenResponse());
    const before = Date.now();
    const result = await loginWithPassword('u', 'p');
    expect(result.accessToken).toBe('access-token-value');
    expect(result.refreshToken).toBe('refresh-token-value');
    expect(result.expiresAt).toBeGreaterThan(before);
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
    await expect(loginWithPassword('u', 'wrong')).rejects.toThrow('401');
  });
});

describe('refreshTokens', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('sends refresh_token grant', async () => {
    mockFetch.mockResolvedValueOnce(makeTokenResponse());
    await refreshTokens('my-refresh-token');
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = options.body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=my-refresh-token');
  });
});
