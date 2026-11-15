# homebridge-bosch-eyes

[![npm](https://img.shields.io/npm/v/homebridge-bosch-eyes)](https://www.npmjs.com/package/homebridge-bosch-eyes)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Homebridge plugin for **Bosch Smart Home Eyes cameras** — indoor and outdoor, 1st generation.

Cameras connect via the **Bosch Smart Home cloud API** using your Bosch / Single Key ID account. No Bosch Smart Home Controller (SHC) is needed.

---

## Features

- Auto-discovery of all cameras in your Bosch Smart Home account
- Snapshots (tile preview, refreshed periodically by Apple Home)
- Live video streaming via ffmpeg + HomeKit Secure Video-compatible SRTP
- Credentials rotate automatically — no manual RTSP configuration
- Motion sensor placeholder (always inactive; real events require Bosch push integration)

---

## Requirements

- [Homebridge](https://homebridge.io/) ≥ 2.0
- Node.js ≥ 18
- `ffmpeg` with `libx264` on the Homebridge host
- A Bosch Smart Home / [Single Key ID](https://singlekeyid.bosch.com) account with at least one Eyes camera

---

## Installation

Install via the **Homebridge UI** plugin search (search for `homebridge-bosch-eyes`), or:

```bash
npm install -g homebridge-bosch-eyes
```

---

## Configuration

Bosch uses a browser-based OAuth2 login (no direct username/password API). The one-time setup takes about 2 minutes:

1. Install the plugin and open its **settings** in the Homebridge UI.
2. Click the **"Click here to log in with your Bosch Single Key ID"** link at the top of the settings page. This opens the Bosch login page in a new tab.
3. **Log in** with your Bosch Smart Home / Single Key ID account.
4. After login the browser redirects to `https://www.bosch.com/boschcam?code=...` — **copy the full URL** from the address bar.
5. Paste it into the **Authorization Callback URL** field in the plugin settings and save. Restart Homebridge.
6. Cameras are discovered automatically. Wait a few seconds after restart for the cameras to appear in Apple Home. You can then **remove** the callback URL from the config.

Tokens are stored in `<homebridge-storage>/bosch-eyes-tokens.json` and refresh automatically — you only need to repeat this if the refresh token expires (typically after 1 year of no use).

Cameras are **auto-discovered** — no IP addresses, RTSP paths, or camera IDs are required.

### Optional: camera name overrides

By default cameras appear in Apple Home with the name set in your Bosch Smart Home account. To rename a camera or tune its stream quality, add an entry under **Camera Overrides** with the camera's API ID.

Find the API ID in Homebridge logs after the first successful run:

```
[Bosch Eyes] [My Camera] Camera accessory configured (Bosch ID: XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX)
```

### Manual config.json example

```json
{
  "platform": "BoschEyesPlatform",
  "name": "Bosch Eyes",
  "cameras": [
    {
      "apiId": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
      "name": "Garden",
      "maxStreams": 2,
      "maxWidth": 1280,
      "maxHeight": 720,
      "maxFPS": 15
    }
  ],
  "ffmpegPath": "",
  "debugStreaming": false
}
```

---

## How it works

```
Apple Home
    │  HomeKit Secure Video (SRTP)
    ▼
Homebridge + homebridge-bosch-eyes
    │  OAuth2 (Keycloak / Single Key ID)
    ▼
Bosch Smart Home Cloud API
    │  Returns rotating RTSP credentials + camera host
    ▼
TLS Proxy (localhost)  ←────  Camera on LAN (RTSPS/443)
    │  Plain RTSP (loopback)
    ▼
ffmpeg → H.264 SRTP → Apple Home
```

The plugin authenticates with the Bosch cloud API using your account credentials and receives per-session RTSP credentials that rotate with each session. A local TLS proxy bridges the camera's RTSPS stream (which uses a private Bosch CA) to plain RTSP on a loopback port for ffmpeg.

---

## Troubleshooting

### Camera tile shows broken icon / no image

Enable debug logging (`debugStreaming: true`) and check for ffmpeg errors in Homebridge logs.

### Authorization fails / "no code parameter"

- Make sure you copied the **full URL** from the browser address bar after the Bosch redirect, not just the page title or partial URL.
- The URL must start with `https://www.bosch.com/boschcam?code=...`
- If the error persists, delete `bosch-eyes-tokens.json` from the Homebridge storage directory and repeat the setup.

### `ffmpeg: command not found`

Install ffmpeg:

```bash
sudo apt install ffmpeg        # Debian / Ubuntu / Raspberry Pi OS
```

Or set `ffmpegPath` to the absolute path, e.g. `/usr/bin/ffmpeg`.

### Live stream works but Apple Home shows a stale thumbnail

Thumbnail refresh is controlled by Apple Home, not this plugin. The snapshot is taken on demand and refreshes approximately every 15 seconds in the Home app tile.

### Camera shows as "offline" after a while

Bosch session credentials expire after ~1 hour. The plugin automatically refreshes the session. If you see repeated offline errors, check Homebridge logs for token refresh failures.

---

## Development

```bash
git clone https://github.com/s5ns4e/homebridge-bosch-eyes
cd homebridge-bosch-eyes
npm install
npm run build
npm test
```

To test against real cameras, run the diagnostic script (requires tokens from a prior run or `--user`/`--pass`):

```bash
node scripts/test-camera.js
```

---

## Security notes

- Credentials are stored in Homebridge's `config.json` (plaintext). Secure access to your Homebridge host.
- OAuth tokens are cached in `<storage>/bosch-eyes-tokens.json`. Tokens are scoped to the Bosch Smart Home API and expire.
- The plugin uses `rejectUnauthorized: false` for the camera TLS connection because Bosch cameras use a private CA not in the system trust store. All camera connections are on the local network only.
- The OAuth client secret embedded in this plugin (`oss_residential_app`) is a public constant shared by all open-source Bosch Smart Home clients (ioBroker, Python-BSH-CLI, etc.). It is not a secret in the cryptographic sense.

---

## License

MIT © s5ns4e
