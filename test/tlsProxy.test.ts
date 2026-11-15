import net from 'net';
import { TlsProxy } from '../src/tlsProxy';

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as any;

describe('TlsProxy', () => {
  it('start() returns a positive port number', async () => {
    const proxy = new TlsProxy('example.com', 443, mockLog, 'test');
    const port = await proxy.start();
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
    proxy.stop();
  });

  it('listens only on 127.0.0.1', async () => {
    const proxy = new TlsProxy('example.com', 443, mockLog, 'test');
    const port = await proxy.start();

    const local = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    expect(local).toBe(true);

    proxy.stop();
  });

  it('stop() can be called multiple times without throwing', () => {
    const proxy = new TlsProxy('example.com', 443, mockLog, 'test');
    expect(() => { proxy.stop(); proxy.stop(); }).not.toThrow();
  });

  it('getPort() returns 0 before start', () => {
    const proxy = new TlsProxy('example.com', 443, mockLog, 'test');
    expect(proxy.getPort()).toBe(0);
  });

  it('getPort() returns the listening port after start', async () => {
    const proxy = new TlsProxy('example.com', 443, mockLog, 'test');
    const port = await proxy.start();
    expect(proxy.getPort()).toBe(port);
    proxy.stop();
  });
});
