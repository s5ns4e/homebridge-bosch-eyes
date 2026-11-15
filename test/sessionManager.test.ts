import { SessionManager } from '../src/sessionManager';
import type { BoschApiClient, LocalSessionResult } from '../src/boschApi';

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as any;

function makeApiClient(sessionOverride?: Partial<LocalSessionResult>): jest.Mocked<BoschApiClient> {
  return {
    openLocalSession: jest.fn().mockResolvedValue({
      user: 'cbs-test',
      password: 'secret',
      urls: ['127.0.0.1:1234'],
      maxSessionDuration: 3600,
      imageUrlScheme: '',
      ...sessionOverride,
    }),
    closeSession: jest.fn().mockResolvedValue(undefined),
    listCameras: jest.fn(),
  } as any;
}

describe('SessionManager.ensureSession', () => {
  it('opens a session and returns credentials', async () => {
    const api = makeApiClient();
    const sm = new SessionManager('cam-id', 'TestCam', api, mockLog);
    const session = await sm.ensureSession();

    expect(session.user).toBe('cbs-test');
    expect(session.password).toBe('secret');
    expect(session.proxyPort).toBeGreaterThan(0);

    await sm.close();
  });

  it('reuses an existing session on second call', async () => {
    const api = makeApiClient();
    const sm = new SessionManager('cam-id', 'TestCam', api, mockLog);

    const s1 = await sm.ensureSession();
    const s2 = await sm.ensureSession();

    expect(s1).toBe(s2);
    expect(api.openLocalSession).toHaveBeenCalledTimes(1);

    await sm.close();
  });

  it('deduplicates concurrent calls (no double open)', async () => {
    const api = makeApiClient();
    const sm = new SessionManager('cam-id', 'TestCam', api, mockLog);

    const [s1, s2] = await Promise.all([sm.ensureSession(), sm.ensureSession()]);
    expect(api.openLocalSession).toHaveBeenCalledTimes(1);
    expect(s1.user).toBe(s2.user);

    await sm.close();
  });
});

describe('SessionManager.getRtspUrl', () => {
  it('builds an RTSP URL with encoded credentials', async () => {
    const api = makeApiClient({ user: 'user@test', password: 'p@ss!word' });
    const sm = new SessionManager('cam-id', 'TestCam', api, mockLog);
    const session = await sm.ensureSession();
    const url = sm.getRtspUrl(session);

    expect(url).toMatch(/^rtsp:\/\//);
    expect(url).toContain('127.0.0.1');
    expect(url).toContain(encodeURIComponent('user@test'));
    expect(url).toContain(encodeURIComponent('p@ss!word'));

    await sm.close();
  });
});

describe('SessionManager.close', () => {
  it('calls the API closeSession', async () => {
    const api = makeApiClient();
    const sm = new SessionManager('cam-id', 'TestCam', api, mockLog);
    await sm.ensureSession();
    await sm.close();

    expect(api.closeSession).toHaveBeenCalledWith('cam-id');
  });

  it('is safe to call when no session is open', async () => {
    const api = makeApiClient();
    const sm = new SessionManager('cam-id', 'TestCam', api, mockLog);
    await expect(sm.close()).resolves.toBeUndefined();
  });
});
