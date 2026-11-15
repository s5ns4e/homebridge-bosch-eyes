#!/usr/bin/env node
/**
 * Bosch Eyes camera probe — Node.js version (no extra deps, built-ins only).
 * Tests TCP port reachability, RTSP streams (via ffprobe), and HTTP snapshots.
 *
 * Usage:
 *   node probe-cameras.js --camera IP[:Name] [--camera IP[:Name]] [--user USER] [--pass PASS] [--timeout MS]
 *
 * Example:
 *   node probe-cameras.js --camera 192.168.1.100:LivingRoom --camera 192.168.1.101:Garden
 *   node probe-cameras.js --camera 192.168.1.100 --user admin --pass SECRET
 */

'use strict';

const { spawn, execFile } = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');

// ── CLI args ─────────────────────────────────────────────────────────────────

const CAMERAS = [];
let username = '';
let password = '';
let timeout = 5000;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--camera') {
    const val = args[++i] || '';
    const colonIdx = val.indexOf(':');
    const ip = colonIdx === -1 ? val : val.slice(0, colonIdx);
    const name = colonIdx === -1 ? `Camera${CAMERAS.length + 1}` : val.slice(colonIdx + 1);
    if (ip) CAMERAS.push({ name, ip });
  } else if (args[i] === '--user') {
    username = args[++i];
  } else if (args[i] === '--pass') {
    password = args[++i];
  } else if (args[i] === '--timeout') {
    timeout = parseInt(args[++i], 10);
  }
}

if (CAMERAS.length === 0) {
  console.error('Usage: node probe-cameras.js --camera IP[:Name] [--camera IP[:Name]] [--user USER] [--pass PASS] [--timeout MS]');
  console.error('Example: node probe-cameras.js --camera 192.168.1.100:LivingRoom --camera 192.168.1.101:Garden');
  process.exit(1);
}

// ── Constants ────────────────────────────────────────────────────────────────

const RTSP_PATHS = [
  '/live', '/stream1', '/stream2',
  '/h264Preview_01_main', '/h264Preview_01_sub',
  '/video', '/video.mp4',
  '/cam/realmonitor',
  '/livestream/ch00_0',
  '/mpeg4/media.amp',
];

const RTSP_PORTS = [554, 8554, 10554];

const SNAPSHOT_PATHS = [
  '/snapshot.jpg', '/snap.jpg',
  '/tmpfs/snap.jpg', '/tmpfs/auto.jpg',
  '/cgi-bin/snapshot.cgi', '/cgi-bin/video.jpg',
  '/image/jpeg.cgi', '/jpg/image.jpg',
  '/webcapture.jpg', '/video/mjpg.cgi',
];

const HTTP_PORTS = [80, 8080];
const HTTPS_PORTS = [443, 8443];

// ── Helpers ───────────────────────────────────────────────────────────────────

const G = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const R = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const Y = (s) => `\x1b[33m→\x1b[0m ${s}`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const C = (s) => `\x1b[1m\x1b[36m${s}\x1b[0m`;

function checkPort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

function probeRtsp(url, timeoutSec) {
  return new Promise((resolve) => {
    const ffArgs = [
      '-v', 'quiet',
      '-rtsp_transport', 'tcp',
      '-timeout', String(timeoutSec * 1_000_000),
      '-print_format', 'json',
      '-show_streams',
      url,
    ];
    let stdout = '';
    const ff = spawn('ffprobe', ffArgs);
    ff.stdout.on('data', (d) => { stdout += d; });
    const timer = setTimeout(() => { ff.kill(); resolve(null); }, (timeoutSec + 2) * 1000);
    ff.on('close', () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(stdout);
        if (json.streams && json.streams.length > 0) resolve(json.streams);
        else resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

function probeHttp(url, user, pass, timeoutMs) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'HEAD',
      timeout: timeoutMs,
      rejectUnauthorized: false,
    };
    if (user && pass) {
      opts.headers = {
        Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      };
    }
    const req = lib.request(opts, (res) => {
      resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '' });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function buildRtspUrl(ip, port, path) {
  if (username && password) {
    return `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${ip}:${port}${path}`;
  }
  return `rtsp://${ip}:${port}${path}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('');
  console.log(B('=== Dependency check ==='));

  await new Promise((resolve) => {
    execFile('ffprobe', ['-version'], (err, stdout) => {
      if (err) {
        console.log(R('ffprobe NOT found — install ffmpeg'));
      } else {
        const ver = stdout.split('\n')[0] || 'unknown';
        console.log(G(`ffprobe: ${ver}`));
      }
      resolve();
    });
  });

  const results = [];

  for (const cam of CAMERAS) {
    const { name, ip } = cam;
    console.log('');
    console.log(C(`=== ${name} (${ip}) ===`));

    console.log('\n' + B('  Port check:'));
    const allPorts = [554, 8554, 10554, 80, 8080, 443, 8443];
    const openPorts = new Set();
    for (const port of allPorts) {
      const open = await checkPort(ip, port, 2000);
      if (open) {
        console.log('  ' + G(`port ${port} open`));
        openPorts.add(port);
      } else {
        console.log('  ' + R(`port ${port} closed`));
      }
    }

    console.log('\n' + B('  RTSP stream probe:'));
    let bestRtsp = null;

    outer:
    for (const port of RTSP_PORTS) {
      if (!openPorts.has(port)) continue;
      for (const path of RTSP_PATHS) {
        const url = buildRtspUrl(ip, port, path);
        process.stdout.write(`    probing ${url} ... `);
        const streams = await probeRtsp(url, timeout / 1000);
        if (streams) {
          const video = streams.find((s) => s.codec_type === 'video');
          const detail = video
            ? `codec=${video.codec_name} ${video.width}x${video.height}`
            : `${streams.length} stream(s)`;
          console.log(G(`FOUND — ${detail}`));
          bestRtsp = { url, port, path };
          break outer;
        } else {
          console.log(R('no stream'));
        }
      }
    }

    if (!bestRtsp) {
      console.log('  ' + Y('No RTSP stream found. Try adding --user admin --pass YOUR_PASSWORD'));
    }

    console.log('\n' + B('  HTTP snapshot probe:'));
    let bestSnap = null;

    outerSnap:
    for (const port of [...HTTP_PORTS, ...HTTPS_PORTS]) {
      if (!openPorts.has(port)) continue;
      const scheme = HTTPS_PORTS.includes(port) ? 'https' : 'http';
      for (const path of SNAPSHOT_PATHS) {
        const url = `${scheme}://${ip}:${port}${path}`;
        process.stdout.write(`    probing ${url} ... `);
        const res = await probeHttp(url, username, password, timeout);
        if (!res) {
          console.log(R('no response'));
        } else if (res.status === 200) {
          console.log(G(`FOUND — HTTP 200 (${res.contentType})`));
          bestSnap = url;
          break outerSnap;
        } else if (res.status === 401) {
          console.log(R(`401 Unauthorized — set --user and --pass`));
        } else {
          console.log(R(`HTTP ${res.status}`));
        }
      }
    }

    if (!bestSnap) {
      console.log('  ' + Y('No HTTP snapshot found — plugin will use ffmpeg fallback.'));
    }

    results.push({ name, ip, bestRtsp, bestSnap });
  }

  console.log('');
  console.log(C('=== Summary ==='));
  console.log('');

  results.forEach(({ name, ip, bestRtsp, bestSnap }) => {
    console.log(B(`  ${name} (${ip}):`));
    if (bestRtsp) {
      console.log('  ' + G(`RTSP: ${bestRtsp.url}`));
    } else {
      console.log('  ' + R('RTSP: not found'));
    }
    if (bestSnap) {
      console.log('  ' + G(`Snapshot: ${bestSnap}`));
    } else {
      console.log('  ' + Y('Snapshot: not found (ffmpeg fallback will be used)'));
    }
    console.log('');
  });
})();
