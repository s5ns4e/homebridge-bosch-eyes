import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { promises as fs } from 'fs';
import path from 'path';
import { PLATFORM_NAME, PLUGIN_NAME, PlatformConfig as BoschConfig, TokenStorage } from './settings';
import { AUTH_URL, exchangeCode, refreshTokens, STATIC_PKCE_VERIFIER } from './boschAuth';
import type { TokenSet } from './boschAuth';

import { BoschApiClient } from './boschApi';
import { SessionManager } from './sessionManager';
import { BoschEyesCameraAccessory } from './cameraAccessory';

export class BoschEyesPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];
  private readonly sessionManagers: SessionManager[] = [];
  private tokenSet: TokenSet | null = null;
  private readonly tokenFile: string;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig & BoschConfig,
    public readonly api: API,
  ) {
    this.tokenFile = path.join(api.user.storagePath(), 'bosch-eyes-tokens.json');
    this.log.debug('BoschEyesPlatform initializing');

    this.api.on('didFinishLaunching', () => {
      this.initialize().catch((err: Error) => {
        this.log.error('Fatal error during initialization:', err.message);
      });
    });
    this.api.on('shutdown', () => void this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async initialize(): Promise<void> {
    await this.loadTokenStorage();

    if (this.config.authCallbackUrl) {
      if (this.tokenSet) {
        this.log.info('Tokens already stored — authCallbackUrl in config is no longer needed. You can remove it.');
      } else {
        try {
          await this.handleAuthCallback(this.config.authCallbackUrl);
        } catch (err) {
          this.log.error('Failed to exchange authorization code:', (err as Error).message);
          return;
        }
      }
    }

    if (this.tokenSet?.refreshToken) {
      await this.discoverCameras();
      return;
    }

    this.startAuthFlow();
  }

  private startAuthFlow(): void {
    this.log.warn('='.repeat(72));
    this.log.warn('BOSCH EYES — Authorization required');
    this.log.warn('');
    this.log.warn('Open this URL in your browser (or click the link in the Homebridge plugin settings):');
    this.log.warn('');
    this.log.warn(AUTH_URL);
    this.log.warn('');
    this.log.warn('After login copy the FULL URL from the browser address bar');
    this.log.warn('(starts with: https://www.bosch.com/boschcam?code=...)');
    this.log.warn('and paste it into "Authorization Callback URL" in the plugin settings.');
    this.log.warn('='.repeat(72));
  }

  private async handleAuthCallback(callbackUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new Error(`Invalid authCallbackUrl: ${callbackUrl}`);
    }

    const code = url.searchParams.get('code');
    if (!code) throw new Error('authCallbackUrl contains no "code" parameter');

    this.log.info('Exchanging authorization code for tokens...');
    this.tokenSet = await exchangeCode(code, STATIC_PKCE_VERIFIER);
    await this.saveTokenStorage();
    this.log.info('Authorization successful! You can now remove "authCallbackUrl" from the plugin config.');
  }

  private async getAccessToken(): Promise<string> {
    if (!this.tokenSet) throw new Error('Not authenticated — complete the authorization flow first');

    if (Date.now() >= this.tokenSet.expiresAt) {
      this.log.debug('Access token expired, refreshing...');
      try {
        this.tokenSet = await refreshTokens(this.tokenSet.refreshToken);
        await this.saveTokenStorage();
      } catch (err) {
        this.log.error('Token refresh failed — re-authorization required:', (err as Error).message);
        this.tokenSet = null;
        await this.saveTokenStorage();
        this.startAuthFlow();
        throw err;
      }
    }

    return this.tokenSet.accessToken;
  }

  private async discoverCameras(): Promise<void> {
    const apiClient = new BoschApiClient(() => this.getAccessToken());

    let cameras;
    try {
      cameras = await apiClient.listCameras();
    } catch (err) {
      this.log.error('Failed to list cameras from Bosch API:', (err as Error).message);
      return;
    }

    if (cameras.length === 0) {
      this.log.warn('No cameras found in your Bosch Smart Home account.');
      return;
    }

    this.log.info(`Found ${cameras.length} camera(s): ${cameras.map(c => c.title).join(', ')}`);

    for (const camera of cameras) {
      const override = this.config.cameras?.find(c => c.apiId === camera.id);
      const displayName = override?.name ?? camera.title;
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${camera.id}`);

      const sessionManager = new SessionManager(camera.id, displayName, apiClient, this.log);
      this.sessionManagers.push(sessionManager);

      const existing = this.accessories.find(a => a.UUID === uuid);
      if (existing) {
        this.log.info('Restoring camera from cache:', displayName);
        existing.context.cameraId = camera.id;
        new BoschEyesCameraAccessory(this, existing, sessionManager, camera, override);
      } else {
        this.log.info('Adding new camera:', displayName);
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context.cameraId = camera.id;
        new BoschEyesCameraAccessory(this, accessory, sessionManager, camera, override);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    const liveUUIDs = cameras.map(c => this.api.hap.uuid.generate(`${PLUGIN_NAME}:${c.id}`));
    const stale = this.accessories.filter(a => !liveUUIDs.includes(a.UUID));
    this.log.info(`discoverCameras complete — cached: ${this.accessories.length}, live: ${cameras.length}, stale: ${stale.length}`);
    if (stale.length > 0) {
      this.log.info('Removing stale accessories:', stale.map(a => a.displayName).join(', '));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private async shutdown(): Promise<void> {
    this.log.debug('Closing all Bosch camera sessions...');
    await Promise.allSettled(this.sessionManagers.map(sm => sm.close()));
  }

  private async loadTokenStorage(): Promise<void> {
    try {
      const raw = await fs.readFile(this.tokenFile, 'utf-8');
      const data = JSON.parse(raw) as TokenStorage;
      if (data.accessToken && data.refreshToken && data.expiresAt) {
        this.tokenSet = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
        };
      }
      this.log.debug('Loaded token storage from disk');
    } catch {
      this.log.debug('No existing token storage found (first run or cleared)');
    }
  }

  private async saveTokenStorage(): Promise<void> {
    const data: TokenStorage = {
      accessToken: this.tokenSet?.accessToken,
      refreshToken: this.tokenSet?.refreshToken,
      expiresAt: this.tokenSet?.expiresAt,
    };
    try {
      await fs.writeFile(this.tokenFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.log.error('Failed to save token storage:', (err as Error).message);
    }
  }
}
