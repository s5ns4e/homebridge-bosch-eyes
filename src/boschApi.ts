import https from 'https';

const CLOUD_API_HOST = 'residential.cbs.boschsecurity.com';
const CLOUD_API_BASE = `https://${CLOUD_API_HOST}`;

// Bosch cloud API uses a private CA ("Video CA 2A" / "Bosch ST Root CA") not in Node.js's
// default bundle. Use a per-host agent that still negotiates TLS but skips CA verification.
const boschCloudAgent = new https.Agent({ rejectUnauthorized: false });

export interface BoschCamera {
  id: string;
  title: string;
  hardwareVersion?: string;
  firmwareVersion?: string;
  macAddress?: string;
}

export interface LocalSessionResult {
  user: string;
  password: string;
  /** Array of "host:port" strings — use the first one. */
  urls: string[];
  /** Template like "https://{url}/snap.jpg" */
  imageUrlScheme: string;
  /** Seconds until session expires (typically 3600). */
  maxSessionDuration: number;
}

interface FetchLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

const REQUEST_TIMEOUT_MS = 15_000;

function cloudRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<FetchLike> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: CLOUD_API_HOST,
        port: 443,
        path,
        method,
        agent: boschCloudAgent,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(bodyStr !== undefined && { 'Content-Length': Buffer.byteLength(bodyStr) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            json: () => Promise.resolve(JSON.parse(text)),
            text: () => Promise.resolve(text),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Bosch API request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export class BoschApiClient {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  async listCameras(): Promise<BoschCamera[]> {
    const token = await this.getAccessToken();
    const res = await cloudRequest('GET', '/v11/video_inputs', token);
    if (!res.ok) throw new Error(`List cameras failed: ${res.status} — ${await res.text()}`);
    return res.json() as Promise<BoschCamera[]>;
  }

  async openLocalSession(id: string): Promise<LocalSessionResult> {
    const token = await this.getAccessToken();
    const res = await cloudRequest(
      'PUT',
      `/v11/video_inputs/${encodeURIComponent(id)}/connection`,
      token,
      { type: 'LOCAL', highQualityVideo: true },
    );
    if (res.status === 503) throw new Error('Camera offline or in privacy mode');
    if (res.status === 444) throw new Error('Session quota reached (max concurrent sessions exceeded)');
    if (!res.ok) throw new Error(`Open session failed: ${res.status} — ${await res.text()}`);
    return res.json() as Promise<LocalSessionResult>;
  }

  async closeSession(id: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await cloudRequest(
      'DELETE',
      `/v11/video_inputs/${encodeURIComponent(id)}/connection`,
      token,
    );
    // 404 = already closed — treat as success
    if (!res.ok && res.status !== 404) {
      throw new Error(`Close session failed: ${res.status}`);
    }
  }
}
