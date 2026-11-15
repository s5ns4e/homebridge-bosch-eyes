# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report them privately via GitHub's [Security Advisories](https://github.com/s5ns4e/homebridge-bosch-eyes/security/advisories/new) feature.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested remediation

You will receive a response within 72 hours. If the vulnerability is confirmed, a patch will be released and a CVE requested if applicable.

## Known Design Decisions

### TLS certificate verification disabled for camera connections

Bosch Smart Home Eyes cameras use a private Bosch CA that is not in the system trust store. The TLS proxy therefore uses `rejectUnauthorized: false` when connecting to the camera. This is an intentional trade-off for local network connections. The camera host/port are sourced from the authenticated Bosch cloud API.

### OAuth client secret

The `client_secret` for the `oss_residential_app` OAuth client is embedded in this plugin. This is a public constant shared by all open-source Bosch Smart Home clients (ioBroker, Python-BSH-CLI, etc.) and is not a secret in the cryptographic sense. It is used only for client identification, not authentication.

### Credential storage

This plugin uses a browser-based OAuth2 PKCE flow — your Bosch account password is never stored. OAuth tokens (access + refresh) are cached in `<homebridge-storage>/bosch-eyes-tokens.json` as plaintext. This is consistent with the security model of Homebridge itself. Secure your Homebridge host accordingly.
