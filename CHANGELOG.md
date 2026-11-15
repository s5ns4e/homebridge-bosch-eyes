# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-15

### Added
- Initial public release
- Auto-discovery of Bosch Smart Home Eyes cameras via cloud API
- Username/password authentication (Bosch Single Key ID / ROPC grant)
- Automatic OAuth token refresh with password fallback
- TLS proxy for RTSPS → plain RTSP bridging (Bosch private CA support)
- ffmpeg-based snapshot (tile) and live stream (SRTP/H.264) support
- Per-camera name and stream quality overrides
- Motion sensor placeholder accessory
- Homebridge UI config schema (`config.schema.json`)
- Jest unit test suite
