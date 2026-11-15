import type { Logger } from 'homebridge';
import type { BoschApiClient } from './boschApi';
import { TlsProxy } from './tlsProxy';

// Refresh the session this many ms before it would expire
const REFRESH_HEADROOM_MS = 5 * 60 * 1000;

export interface LiveSession {
  user: string;
  password: string;
  cameraHost: string;
  proxyPort: number;
}

export class SessionManager {
  private session: (LiveSession & { proxy: TlsProxy }) | null = null;
  private sessionPromise: Promise<LiveSession & { proxy: TlsProxy }> | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private readonly cameraId: string,
    private readonly cameraName: string,
    private readonly api: BoschApiClient,
    private readonly log: Logger,
  ) {}

  /** Open a session if none is active, or return the existing one. */
  async ensureSession(): Promise<LiveSession> {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = this.openSession().finally(() => { this.sessionPromise = null; });
    }
    return this.sessionPromise;
  }

  private async openSession(): Promise<LiveSession & { proxy: TlsProxy }> {
    this.log.info(`[${this.cameraName}] Opening live session via Bosch cloud API...`);

    const result = await this.api.openLocalSession(this.cameraId);

    if (!result.user || !result.password || !result.urls?.length) {
      throw new Error(`[${this.cameraName}] Session response missing credentials or URLs`);
    }

    const urlEntry = result.urls[0]; // "host:port"
    const colonIdx = urlEntry.lastIndexOf(':');
    const host = urlEntry.slice(0, colonIdx);
    const port = parseInt(urlEntry.slice(colonIdx + 1), 10) || 443;

    const proxy = new TlsProxy(host, port, this.log, this.cameraName);
    const proxyPort = await proxy.start();

    this.session = { user: result.user, password: result.password, cameraHost: host, proxyPort, proxy };

    const refreshIn = (result.maxSessionDuration ?? 3600) * 1000 - REFRESH_HEADROOM_MS;
    this.log.info(
      `[${this.cameraName}] Session open — TLS proxy on 127.0.0.1:${proxyPort}, refreshes in ${Math.round(refreshIn / 60000)} min`,
    );

    this.watchdog = setTimeout(() => void this.refreshSession(), refreshIn);

    return this.session;
  }

  private async refreshSession(): Promise<void> {
    this.log.info(`[${this.cameraName}] Refreshing session...`);
    const expiredProxy = this.session?.proxy ?? null;
    this.session = null;

    try {
      await this.openSession();
      // Keep the old proxy briefly so any in-flight ffmpeg process can drain
      setTimeout(() => expiredProxy?.stop(), 15_000);
    } catch (err) {
      this.log.error(`[${this.cameraName}] Session refresh failed:`, (err as Error).message);
      expiredProxy?.stop();
    }
  }

  /** Build the plain RTSP URL for ffmpeg (via the local TLS proxy). ffmpeg handles Digest auth. */
  getRtspUrl(session: LiveSession): string {
    const u = encodeURIComponent(session.user);
    const p = encodeURIComponent(session.password);
    return (
      `rtsp://${u}:${p}@127.0.0.1:${session.proxyPort}` +
      `/rtsp_tunnel?inst=1&enableaudio=0&fmtp=1&maxSessionDuration=3600`
    );
  }

  /** Close the session and stop the TLS proxy. Called on Homebridge shutdown. */
  async close(): Promise<void> {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    const s = this.session;
    this.session = null;
    s?.proxy.stop();

    try {
      await this.api.closeSession(this.cameraId);
    } catch {
      // best-effort
    }

    this.log.debug(`[${this.cameraName}] Session closed`);
  }
}
