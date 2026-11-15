#!/usr/bin/env bash
# Probes Bosch Eyes cameras for RTSP streams and HTTP snapshot endpoints.
# Run this on the Homebridge host before configuring the plugin.
#
# Usage:
#   chmod +x probe-cameras.sh
#   ./probe-cameras.sh --camera 192.168.1.100:LivingRoom --camera 192.168.1.101:Garden
#   ./probe-cameras.sh --camera 192.168.1.100 --user admin --pass SECRET
#   ./probe-cameras.sh --camera 192.168.1.100 --timeout 6

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
CAMERAS=()
CAMERA_NAMES=()
USERNAME=""
PASSWORD=""
TIMEOUT=5   # seconds per probe

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --user)   USERNAME="$2"; shift 2 ;;
    --pass)   PASSWORD="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --camera)
      IFS=':' read -r cam_ip cam_name <<< "$2"
      CAMERAS+=("$cam_ip")
      CAMERA_NAMES+=("${cam_name:-Camera$((${#CAMERAS[@]}))}")
      shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ ${#CAMERAS[@]} -eq 0 ]]; then
  echo "Usage: $0 --camera IP[:Name] [--camera IP[:Name]] [--user USER] [--pass PASS] [--timeout SECONDS]"
  echo "Example: $0 --camera 192.168.1.100:LivingRoom --camera 192.168.1.101:Garden --user admin --pass secret"
  exit 1
fi

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
info() { echo -e "  ${YELLOW}→${NC} $*"; }

# ── Dependency checks ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=== Dependency check ===${NC}"
for bin in ffprobe curl nc; do
  if command -v "$bin" &>/dev/null; then
    ok "$bin found at $(command -v "$bin")"
  else
    fail "$bin NOT found — install ffmpeg / curl / netcat"
  fi
done

# ── RTSP paths to try ────────────────────────────────────────────────────────
RTSP_PATHS=(
  "/live"
  "/stream1"
  "/stream2"
  "/h264Preview_01_main"
  "/h264Preview_01_sub"
  "/video"
  "/video.mp4"
  "/cam/realmonitor"
  "/livestream/ch00_0"
  "/mpeg4/media.amp"
)

# ── HTTP snapshot paths to try ───────────────────────────────────────────────
SNAPSHOT_PATHS=(
  "/snapshot.jpg"
  "/snap.jpg"
  "/tmpfs/snap.jpg"
  "/tmpfs/auto.jpg"
  "/cgi-bin/snapshot.cgi"
  "/cgi-bin/video.jpg"
  "/image/jpeg.cgi"
  "/jpg/image.jpg"
  "/webcapture.jpg"
  "/video/mjpg.cgi"
)

RTSP_PORTS=(554 8554 10554)
HTTP_PORTS=(80 8080 443)

# ── Helper: build RTSP URL with optional credentials ────────────────────────
rtsp_url() {
  local ip=$1 port=$2 path=$3
  if [[ -n "$USERNAME" && -n "$PASSWORD" ]]; then
    echo "rtsp://${USERNAME}:${PASSWORD}@${ip}:${port}${path}"
  else
    echo "rtsp://${ip}:${port}${path}"
  fi
}

# ── Helper: build HTTP URL ───────────────────────────────────────────────────
http_url() {
  local ip=$1 port=$2 path=$3
  if [[ "$port" == "443" ]]; then
    echo "https://${ip}${path}"
  else
    echo "http://${ip}:${port}${path}"
  fi
}

# ── Probe each camera ────────────────────────────────────────────────────────
FOUND_RTSP=()
FOUND_SNAP=()

for i in "${!CAMERAS[@]}"; do
  IP="${CAMERAS[$i]}"
  NAME="${CAMERA_NAMES[$i]}"

  echo ""
  echo -e "${BOLD}${CYAN}=== ${NAME} (${IP}) ===${NC}"

  # Port scan
  echo -e "\n${BOLD}  Port check:${NC}"
  for port in 554 8554 80 8080 443 8443; do
    if nc -z -w 2 "$IP" "$port" 2>/dev/null; then
      ok "port $port open"
    else
      fail "port $port closed"
    fi
  done

  # RTSP probe
  echo -e "\n${BOLD}  RTSP stream probe:${NC}"
  BEST_RTSP=""
  for port in "${RTSP_PORTS[@]}"; do
    if ! nc -z -w 2 "$IP" "$port" 2>/dev/null; then
      continue
    fi
    for path in "${RTSP_PATHS[@]}"; do
      url=$(rtsp_url "$IP" "$port" "$path")
      output=$(ffprobe \
        -v quiet \
        -rtsp_transport tcp \
        -timeout $((TIMEOUT * 1000000)) \
        -print_format json \
        -show_streams \
        "$url" 2>&1 || true)

      if echo "$output" | grep -q '"codec_type"'; then
        codec=$(echo "$output" | grep '"codec_name"' | head -1 | sed 's/.*: "\(.*\)".*/\1/')
        width=$(echo "$output" | grep '"width"' | head -1 | sed 's/[^0-9]//g')
        height=$(echo "$output" | grep '"height"' | head -1 | sed 's/[^0-9]//g')
        ok "FOUND stream at ${url}"
        info "  codec=${codec} resolution=${width}x${height}"
        BEST_RTSP="$url"
        break 2
      else
        fail "no stream: ${url}"
      fi
    done
  done

  if [[ -z "$BEST_RTSP" ]]; then
    info "No RTSP stream found. Try with --user admin --pass YOUR_PASSWORD if not already set."
  else
    FOUND_RTSP+=("$IP|$BEST_RTSP")
  fi

  # HTTP snapshot probe
  echo -e "\n${BOLD}  HTTP snapshot probe:${NC}"
  BEST_SNAP=""
  CURL_AUTH=()
  if [[ -n "$USERNAME" && -n "$PASSWORD" ]]; then
    CURL_AUTH=(-u "${USERNAME}:${PASSWORD}")
  fi

  for port in "${HTTP_PORTS[@]}"; do
    if ! nc -z -w 2 "$IP" "$port" 2>/dev/null; then
      continue
    fi
    for path in "${SNAPSHOT_PATHS[@]}"; do
      url=$(http_url "$IP" "$port" "$path")
      http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        --insecure \
        "${CURL_AUTH[@]+"${CURL_AUTH[@]}"}" \
        "$url" 2>/dev/null || echo "000")

      if [[ "$http_code" == "200" ]]; then
        ctype=$(curl -s -I --max-time "$TIMEOUT" --insecure \
          "${CURL_AUTH[@]+"${CURL_AUTH[@]}"}" \
          "$url" 2>/dev/null | grep -i "content-type" | head -1 | tr -d '\r')
        ok "FOUND snapshot at ${url} (${ctype})"
        BEST_SNAP="$url"
        break 2
      elif [[ "$http_code" == "401" ]]; then
        fail "401 Unauthorized: ${url} — set --user and --pass"
      else
        fail "HTTP ${http_code}: ${url}"
      fi
    done
  done

  if [[ -z "$BEST_SNAP" ]]; then
    info "No HTTP snapshot found — plugin will use ffmpeg frame extraction instead."
  else
    FOUND_SNAP+=("$IP|$BEST_SNAP")
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}=== Summary & recommended config ===${NC}"
echo ""

for i in "${!CAMERAS[@]}"; do
  IP="${CAMERAS[$i]}"
  NAME="${CAMERA_NAMES[$i]}"
  echo -e "${BOLD}  ${NAME} (${IP}):${NC}"

  rtsp_entry=$(printf '%s\n' "${FOUND_RTSP[@]:-}" | grep "^${IP}|" || true)
  snap_entry=$(printf '%s\n' "${FOUND_SNAP[@]:-}" | grep "^${IP}|" || true)

  if [[ -n "$rtsp_entry" ]]; then
    full_url="${rtsp_entry#*|}"
    path=$(echo "$full_url" | sed 's|rtsp://[^/]*/|/|')
    port=$(echo "$full_url" | sed 's|.*:\([0-9]*\)/.*|\1|')
    ok "rtspPath: \"${path}\"  rtspPort: ${port}"
  else
    fail "RTSP: not found — check credentials or try remaining paths manually"
  fi

  if [[ -n "$snap_entry" ]]; then
    ok "snapshotUrl: \"${snap_entry#*|}\""
  else
    info "snapshotUrl: leave empty (ffmpeg fallback)"
  fi
  echo ""
done
