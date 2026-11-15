const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const { generatePkce, buildAuthUrl, exchangeCode } = require('../dist/boschAuth');
const { promises: fs } = require('fs');
const path = require('path');

class BoschEyesUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/auth/status', this.getAuthStatus.bind(this));
    this.onRequest('/auth/url', this.generateAuthUrl.bind(this));
    this.onRequest('/auth/exchange', this.exchangeAuthCode.bind(this));
    this.ready();
  }

  get tokenFile() {
    return path.join(this.homebridgeStoragePath, 'bosch-eyes-tokens.json');
  }

  async loadTokenData() {
    try {
      return JSON.parse(await fs.readFile(this.tokenFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  async saveTokenData(data) {
    await fs.writeFile(this.tokenFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  async getAuthStatus() {
    const data = await this.loadTokenData();
    return {
      authenticated: !!(data.refreshToken),
      hasPkce: !!(data.pkceVerifier),
    };
  }

  async generateAuthUrl() {
    const existing = await this.loadTokenData();

    // Reuse a pending verifier so repeated clicks don't invalidate the previous one
    let verifier = existing.pkceVerifier;
    if (!verifier) {
      verifier = generatePkce().verifier;
      await this.saveTokenData({ ...existing, pkceVerifier: verifier });
    }

    return { url: buildAuthUrl(verifier) };
  }

  async exchangeAuthCode({ callbackUrl }) {
    const existing = await this.loadTokenData();

    if (!existing.pkceVerifier) {
      throw new Error('No PKCE verifier found. Click "Generate Login URL" first.');
    }

    let parsed;
    try {
      parsed = new URL(callbackUrl);
    } catch {
      throw new Error('Invalid URL — make sure you copied the full address from your browser address bar.');
    }

    const code = parsed.searchParams.get('code');
    if (!code) {
      throw new Error('No authorization code in URL. Copy the full redirect URL that starts with https://www.bosch.com/boschcam?code=...');
    }

    const tokens = await exchangeCode(code, existing.pkceVerifier);
    await this.saveTokenData({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });

    return { success: true };
  }
}

new BoschEyesUiServer();
