#!/usr/bin/env bash
# update-rdio-scanner - one-shot in-place upgrade to the latest GitHub release.
#
# Usage:
#   sudo update-rdio-scanner               # latest release, auto-detect arch
#   sudo update-rdio-scanner v6.6.3-fork.5 # pin to a specific tag
#
# What it does:
#   1. Figures out the right release zip for this CPU (uname -m).
#   2. Asks the GitHub Releases API for the latest tag (or uses $1 if given).
#   3. Stops uniden-recorder and rdio-scanner.
#   4. Downloads the zip to /tmp, sanity-checks the size, extracts over the
#      install (defaults to /home/<the-service-user>/rdio-scanner; override
#      with RDIO_INSTALL_DIR=/some/path).
#   5. Restarts the services and prints the new version banner.
#
# What it preserves: your .ini files, the SQLite DB, anything in /etc.
# What it does NOT preserve: edits you made directly to files inside
# tools/ -- those come from the zip and get overwritten.

set -euo pipefail

OWNER="evilgenius79"
REPO="rdio-scanner"

# Resolve the install directory. Default to ~rdio-scanner of the user who
# owns /home/*/scanner-calls (the recorder output dir), or fall back to
# /home/$SUDO_USER/rdio-scanner, or /home/pi/rdio-scanner.
INSTALL_DIR="${RDIO_INSTALL_DIR:-}"
if [ -z "$INSTALL_DIR" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ -d "/home/$SUDO_USER/rdio-scanner" ]; then
    INSTALL_DIR="/home/$SUDO_USER/rdio-scanner"
  elif [ -d "/home/scanner/rdio-scanner" ]; then
    INSTALL_DIR="/home/scanner/rdio-scanner"
  elif [ -d "/home/pi/rdio-scanner" ]; then
    INSTALL_DIR="/home/pi/rdio-scanner"
  else
    echo "Could not auto-detect install dir; set RDIO_INSTALL_DIR=/path/to/rdio-scanner" >&2
    exit 1
  fi
fi
echo "Install dir: $INSTALL_DIR"

# Map kernel arch -> release asset arch.
case "$(uname -m)" in
  aarch64)        ARCH="arm64" ;;
  armv7l|armv6l)  ARCH="arm" ;;
  x86_64)         ARCH="amd64" ;;
  i386|i686)      ARCH="386" ;;
  *)
    echo "Unsupported CPU arch: $(uname -m)" >&2
    exit 1
    ;;
esac

# Tag: either pinned via $1 or the latest from the GitHub API.
TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/${OWNER}/${REPO}/releases/latest" \
          | grep '"tag_name"' | head -n1 | cut -d'"' -f4)
  if [ -z "$TAG" ]; then
    echo "Could not fetch the latest tag from GitHub" >&2
    exit 1
  fi
fi
echo "Target release: $TAG (arch: $ARCH)"

# Bail early if the running banner already shows this tag.
RUNNING=$(journalctl -u rdio-scanner --no-pager 2>/dev/null \
            | grep -oE 'Rdio Scanner v[0-9A-Za-z.+\-]+' | tail -n1 | sed 's/^Rdio Scanner //')
if [ -n "$RUNNING" ]; then
  echo "Currently running: $RUNNING"
  if [ "$RUNNING" = "$TAG" ]; then
    echo "Already on $TAG, nothing to do."
    exit 0
  fi
fi

ZIP="rdio-scanner-linux-${ARCH}-${TAG}.zip"
URL="https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${ZIP}"
TMP="/tmp/${ZIP}"

echo "Stopping services..."
systemctl stop uniden-recorder 2>/dev/null || true
systemctl stop transcriber 2>/dev/null || true
systemctl stop rdio-scanner 2>/dev/null || true

echo "Downloading $URL ..."
curl -fL -o "$TMP" "$URL"

# Sanity: anything under ~1MB is probably an HTML 404 page, not a real zip.
SIZE=$(stat -c %s "$TMP")
if [ "$SIZE" -lt 1000000 ]; then
  echo "Download too small ($SIZE bytes) -- did the tag exist on GitHub?" >&2
  rm -f "$TMP"
  systemctl start rdio-scanner 2>/dev/null || true
  exit 1
fi

# Extract OVER the install dir; -o overwrites without prompting. The
# .ini files, the SQLite DB and the .wav output dir are not inside the
# zip, so they survive.
echo "Extracting into $INSTALL_DIR ..."
unzip -q -o "$TMP" -d "$INSTALL_DIR/"
rm "$TMP"

# Make sure the resulting binary is executable -- some unzip versions on
# Linux drop the executable bit when extracting from a zip created on
# Windows / macOS hosts.
[ -f "$INSTALL_DIR/rdio-scanner" ] && chmod +x "$INSTALL_DIR/rdio-scanner"

echo "Starting services..."
systemctl start rdio-scanner
systemctl start uniden-recorder 2>/dev/null || true
systemctl start transcriber 2>/dev/null || true

# Give rdio-scanner a moment to log its startup banner.
sleep 2
NEW=$(journalctl -u rdio-scanner --since '30 sec ago' --no-pager 2>/dev/null \
        | grep -oE 'Rdio Scanner v[0-9A-Za-z.+\-]+' | tail -n1 | sed 's/^Rdio Scanner //')
if [ -n "$NEW" ]; then
  echo "Now running: $NEW"
else
  echo "Update complete; check 'systemctl status rdio-scanner' to confirm."
fi
