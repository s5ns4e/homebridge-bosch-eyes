import net from 'net';
import tls from 'tls';
import type { Logger } from 'homebridge';

/**
 * Plain TCP → TLS bridge. Exposes the camera's RTSPS (port 443, private CA) as plain RTSP
 * on a random localhost port so ffmpeg can connect without TLS concerns.
 * ffmpeg handles RTSP Digest auth directly via credentials in the URL.
 */
export class TlsProxy {
  private server: net.Server | null = null;
  private port = 0;

  constructor(
    private readonly remoteHost: string,
    private readonly remotePort: number,
    private readonly log: Logger,
    private readonly label: string,
  ) {}

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((client) => {
        client.on('error', (err) => {
          this.log.debug(`[${this.label}] TLS proxy client error: ${err.message}`);
        });

        const upstream = tls.connect(
          {
            host: this.remoteHost,
            port: this.remotePort,
            // Bosch cameras use a private CA not in the system trust store
            rejectUnauthorized: false,
          },
          () => {
            this.log.debug(`[${this.label}] TLS proxy connected to ${this.remoteHost}:${this.remotePort}`);
          },
        );

        upstream.on('error', (err) => {
          this.log.warn(`[${this.label}] TLS upstream error: ${err.message}`);
          client.destroy();
        });

        client.pipe(upstream);
        upstream.pipe(client);

        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });

      this.server.on('error', (err) => {
        this.log.error(`[${this.label}] TLS proxy server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        this.port = addr.port;
        this.log.debug(`[${this.label}] TLS proxy listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.log.debug(`[${this.label}] TLS proxy stopped`);
    }
  }

  getPort(): number {
    return this.port;
  }
}
