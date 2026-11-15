export const PLATFORM_NAME = 'BoschEyesPlatform';
export const PLUGIN_NAME = 'homebridge-bosch-eyes';

export interface TokenStorage {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  pkceVerifier?: string; // kept for migration: cleared after first successful ROPC login
}

export interface CameraOverride {
  apiId: string;
  name?: string;
  maxStreams?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxFPS?: number;
}

export interface PlatformConfig {
  name?: string;
  // Paste the full redirect URL here after completing the browser auth flow
  authCallbackUrl?: string;
  cameras?: CameraOverride[];
  ffmpegPath?: string;
  debugStreaming?: boolean;
}
