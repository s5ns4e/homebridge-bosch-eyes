#!/usr/bin/env node
/**
 * Interactive test script for the Bosch Smart Home camera pipeline.
 *
 * Tests each step in order:
 *   1. OAuth2 — get tokens (via username/password or PKCE browser flow)
 *   2. Camera list  — confirm API access
 *   3. Session open — get rotating Digest credentials
 *   4. TLS proxy    — expose RTSPS as plain RTSP on localhost
 *   5. Print ffplay command to verify the stream
 *
 * Run from the project root after `npm run build`:
 *   node scripts/test-camera.js
 *   node scripts/test-camera.js --user you@example.com --pass yourpassword
 */

'use strict';

const { generatePkce, buildAuthUrl, exchangeCode, refreshTokens, loginWithPassword } = require('../dist/boschAuth');
const { BoschApiClient } = require('../dist/boschApi');
const { TlsProxy }       = require('../dist/tlsProxy');

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const TOKEN_FILE = path.join(__dirname, '.test-tokens.json');

// ── Minimal logger ───────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log('\x1b[32m[INFO]\x1b[0m ', ...a),
  warn:  (...a) => console.log('\x1b[33m[WARN]\x1b[0m ', ...a),
  error: (...a) => console.log('\x1b[31m[ERROR]\x1b[0m', ...a),
  debug: (...a) => process.env.DEBUG ? console.log('\x1b[90m[DEBUG]\x1b[0m', ...a) : undefined,
};

// ── Token persistence ────────────────────────────────────────────────────────
function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveTokens(data) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

// ── CLI args ─────────────────────────────────────────────────────────────────
let cliUser, cliPass;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--user') cliUser = process.argv[i + 1];
  if (process.argv[i] === '--pass') cliPass = process.argv[i + 1];
}

// ── Readline helper ──────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}
function pause(msg = 'Press Enter to stop...') {
  return new Promise(resolve => rl.question(msg, resolve));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[1m=== Bosch Eyes Camera Test ===\x1b[0m\n');

  // ── Step 1: Tokens ─────────────────────────────────────────────────────────
  let stored = loadTokens();
  let tokens = stored.tokens ?? null;

  if (tokens?.refreshToken) {
    if (Date.now() >= (tokens.expiresAt ?? 0)) {
      log.info('Access token expired — refreshing...');
      try {
        tokens = await refreshTokens(tokens.refreshToken);
        saveTokens({ ...stored, tokens });
        log.info('Token refreshed successfully.');
      } catch (err) {
        log.warn('Refresh failed, re-authenticating:', err.message);
        tokens = null;
        stored = {};
      }
    } else {
      log.info('Using cached tokens (expires in', Math.round((tokens.expiresAt - Date.now()) / 60000), 'min)');
    }
  }

  if (!tokens) {
    console.log('\n\x1b[1mStep 1 — Authenticate\x1b[0m');
    console.log('────────────────────────────────────────');

    if (cliUser && cliPass) {
      // Direct login via ROPC grant
      log.info('Logging in with username/password...');
      try {
        tokens = await loginWithPassword(cliUser, cliPass);
        saveTokens({ tokens });
        log.info('Login successful. Tokens saved to', TOKEN_FILE);
      } catch (err) {
        log.error('Login failed:', err.message);
        rl.close();
        process.exit(1);
      }
    } else {
      // PKCE browser flow
      const cliUrl = process.argv[2];
      let callbackUrl, verifier;

      if (cliUrl && stored.pkceVerifier) {
        callbackUrl = cliUrl.trim();
        verifier = stored.pkceVerifier;
        console.log('\n\x1b[1mStep 1 — Exchanging authorization code\x1b[0m');
      } else {
        const pkce = generatePkce();
        verifier = pkce.verifier;
        const authUrl = buildAuthUrl(verifier);
        saveTokens({ pkceVerifier: verifier });

        console.log('Open this URL in your browser:\n');
        console.log('\x1b[36m' + authUrl + '\x1b[0m');
        console.log('\nLog in with your Bosch Smart Home account.');
        console.log('After redirect, copy the full URL from your browser address bar.');
        console.log('(It starts with: https://www.bosch.com/boschcam?code=...)\n');
        console.log('Alternatively, re-run with credentials:');
        console.log('  node scripts/test-camera.js --user you@example.com --pass yourpassword\n');
        console.log('Or re-run with the callback URL as an argument:');
        console.log('  node scripts/test-camera.js "https://www.bosch.com/boschcam?..."\n');

        await pause('Press Enter to exit and re-run with credentials or the URL argument...');
        rl.close();
        process.exit(0);
      }

      let code;
      try {
        code = new URL(callbackUrl).searchParams.get('code');
      } catch {
        log.error('Invalid URL:', callbackUrl);
        process.exit(1);
      }
      if (!code) { log.error('No "code" parameter in URL'); process.exit(1); }

      log.info('Exchanging authorization code for tokens...');
      tokens = await exchangeCode(code, verifier);
      saveTokens({ tokens });
      log.info('Tokens saved to', TOKEN_FILE);
    }
  }

  // ── Step 2: List cameras ───────────────────────────────────────────────────
  console.log('\n\x1b[1mStep 2 — List cameras\x1b[0m');
  console.log('────────────────────────────────────────');

  let cameras;
  const getToken = async () => {
    if (Date.now() >= (tokens.expiresAt ?? 0)) {
      tokens = await refreshTokens(tokens.refreshToken);
      saveTokens({ tokens });
    }
    return tokens.accessToken;
  };
  const api = new BoschApiClient(getToken);

  try {
    cameras = await api.listCameras();
  } catch (err) {
    log.error('Failed to list cameras:', err.message);
    if (err.cause) log.error('  Cause:', err.cause);
    process.exit(1);
  }

  if (!cameras.length) {
    log.warn('No cameras found in your Bosch account.');
    process.exit(0);
  }

  cameras.forEach((c, i) => {
    console.log(`  [${i}] ${c.title} (ID: ${c.id}, FW: ${c.firmwareVersion ?? 'unknown'})`);
  });

  // ── Step 3: Pick a camera and open a LOCAL session ─────────────────────────
  console.log('\n\x1b[1mStep 3 — Open a live session\x1b[0m');
  console.log('────────────────────────────────────────');

  let cameraIndex = 0;
  if (cameras.length > 1) {
    const ans = (await ask(`Pick a camera [0–${cameras.length - 1}]: `)).trim();
    cameraIndex = parseInt(ans, 10);
    if (isNaN(cameraIndex) || cameraIndex < 0 || cameraIndex >= cameras.length) {
      log.error('Invalid selection'); process.exit(1);
    }
  }

  const camera = cameras[cameraIndex];
  log.info(`Opening LOCAL session for "${camera.title}" (${camera.id})...`);

  let session;
  try {
    session = await api.openLocalSession(camera.id);
  } catch (err) {
    log.error('Failed to open session:', err.message);
    process.exit(1);
  }

  console.log('\n  Session credentials:');
  console.log('    user    :', session.user);
  console.log('    password: (hidden)');
  console.log('    url     :', session.urls?.[0]);
  console.log('    expires : ' + session.maxSessionDuration + 's');

  // ── Step 4: Start TLS proxy ────────────────────────────────────────────────
  console.log('\n\x1b[1mStep 4 — Start TLS proxy\x1b[0m');
  console.log('────────────────────────────────────────');

  const urlEntry = session.urls[0];
  const colonIdx = urlEntry.lastIndexOf(':');
  const remoteHost = urlEntry.slice(0, colonIdx);
  const remotePort = parseInt(urlEntry.slice(colonIdx + 1), 10) || 443;

  log.info(`Bridging ${remoteHost}:${remotePort} (RTSPS) → 127.0.0.1:? (plain RTSP)...`);

  const proxy = new TlsProxy(remoteHost, remotePort, log, camera.title);
  let proxyPort;
  try {
    proxyPort = await proxy.start();
  } catch (err) {
    log.error('TLS proxy failed to start:', err.message);
    process.exit(1);
  }

  log.info(`TLS proxy running on 127.0.0.1:${proxyPort}`);

  // ── Step 5: Print test command ─────────────────────────────────────────────
  const u = encodeURIComponent(session.user);
  const p = encodeURIComponent(session.password);
  const rtspUrl = `rtsp://${u}:${p}@127.0.0.1:${proxyPort}/rtsp_tunnel?inst=1&enableaudio=0&fmtp=1&maxSessionDuration=3600`;

  console.log('\n\x1b[1mStep 5 — Test the stream\x1b[0m');
  console.log('────────────────────────────────────────');
  console.log('Open another terminal and run:\n');
  console.log('\x1b[36mffplay -rtsp_transport tcp "' + rtspUrl + '"\x1b[0m');
  console.log('\n  (Or paste into VLC: Media → Open Network Stream)\n');

  await pause('\nProxy is running. Press Enter to stop and close the session...');

  proxy.stop();
  try { await api.closeSession(camera.id); } catch { /* ignore */ }
  log.info('Session closed. Done.');
  rl.close();
}

main().catch(err => {
  console.error('\x1b[31mFatal error:\x1b[0m', err.message ?? err);
  process.exit(1);
});
