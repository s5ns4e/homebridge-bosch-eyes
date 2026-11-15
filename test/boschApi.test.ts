import https from 'https';
import { EventEmitter } from 'events';
import { BoschApiClient } from '../src/boschApi';

function makeReqMock(statusCode: number, body: string) {
  const req = new EventEmitter() as any;
  req.write = jest.fn();
  req.end = jest.fn(() => {
    setImmediate(() => {
      const res = new EventEmitter() as any;
      res.statusCode = statusCode;
      (req as any)._resCallback(res);
      setImmediate(() => {
        res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    });
  });
  req.destroy = jest.fn();
  return req;
}

let requestSpy: jest.SpyInstance;

beforeEach(() => {
  requestSpy = jest.spyOn(https, 'request').mockImplementation(((_opts: unknown, cb: (res: unknown) => void) => {
    const req = makeReqMock(200, JSON.stringify([]));
    req._resCallback = cb;
    return req;
  }) as any);
});

afterEach(() => {
  requestSpy.mockRestore();
});

describe('BoschApiClient.listCameras', () => {
  it('calls GET /v11/video_inputs', async () => {
    const cameras = [{ id: 'abc', title: 'Test Cam' }];
    requestSpy.mockImplementationOnce(((opts: any, cb: (res: any) => void) => {
      const req = makeReqMock(200, JSON.stringify(cameras));
      req._resCallback = cb;
      expect(opts.path).toBe('/v11/video_inputs');
      expect(opts.method).toBe('GET');
      return req;
    }) as any);

    const client = new BoschApiClient(async () => 'token');
    const result = await client.listCameras();
    expect(result).toEqual(cameras);
  });

  it('throws on non-2xx response', async () => {
    requestSpy.mockImplementationOnce(((_opts: any, cb: (res: any) => void) => {
      const req = makeReqMock(500, 'Internal Error');
      req._resCallback = cb;
      return req;
    }) as any);

    const client = new BoschApiClient(async () => 'token');
    await expect(client.listCameras()).rejects.toThrow('500');
  });
});

describe('BoschApiClient.openLocalSession', () => {
  it('calls PUT /v11/video_inputs/{id}/connection', async () => {
    const session = { user: 'u', password: 'p', urls: ['192.0.2.1:443'], maxSessionDuration: 3600, imageUrlScheme: '' };
    requestSpy.mockImplementationOnce(((opts: any, cb: (res: any) => void) => {
      const req = makeReqMock(200, JSON.stringify(session));
      req._resCallback = cb;
      expect(opts.method).toBe('PUT');
      expect(opts.path).toContain('/v11/video_inputs/');
      expect(opts.path).toContain('/connection');
      return req;
    }) as any);

    const client = new BoschApiClient(async () => 'token');
    const result = await client.openLocalSession('camera-id-1');
    expect(result.user).toBe('u');
  });

  it('throws descriptive error on 503', async () => {
    requestSpy.mockImplementationOnce(((_opts: any, cb: (res: any) => void) => {
      const req = makeReqMock(503, '');
      req._resCallback = cb;
      return req;
    }) as any);

    const client = new BoschApiClient(async () => 'token');
    await expect(client.openLocalSession('id')).rejects.toThrow('offline');
  });

  it('throws descriptive error on 444', async () => {
    requestSpy.mockImplementationOnce(((_opts: any, cb: (res: any) => void) => {
      const req = makeReqMock(444, '');
      req._resCallback = cb;
      return req;
    }) as any);

    const client = new BoschApiClient(async () => 'token');
    await expect(client.openLocalSession('id')).rejects.toThrow('quota');
  });
});

describe('BoschApiClient.closeSession', () => {
  it('succeeds silently on 404', async () => {
    requestSpy.mockImplementationOnce(((_opts: any, cb: (res: any) => void) => {
      const req = makeReqMock(404, '');
      req._resCallback = cb;
      return req;
    }) as any);

    const client = new BoschApiClient(async () => 'token');
    await expect(client.closeSession('id')).resolves.toBeUndefined();
  });
});
