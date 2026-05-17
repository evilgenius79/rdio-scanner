# Operator cheat sheet

Quick-reference commands for managing a rdio-scanner + uniden-recorder
deployment on a Raspberry Pi. Lives in the repo so it's at hand wherever
you've cloned (or grabbed a release).

If you're not the original installer and just inherited this stack: start
with the **One-screen sanity check** section at the bottom.

---

## Services

### Inspect

```sh
# Everything that auto-starts on boot
systemctl list-unit-files --type=service --state=enabled

# Everything currently running
systemctl list-units --type=service --state=running

# Only services that are failed (red)
systemctl --failed

# Detail on one specific service
systemctl status rdio-scanner
systemctl is-active rdio-scanner       # active / inactive / failed
systemctl is-enabled rdio-scanner      # enabled / disabled
```

### Start / stop / enable / disable

```sh
sudo systemctl start    <name>     # start now (won't survive reboot if disabled)
sudo systemctl stop     <name>     # stop now
sudo systemctl restart  <name>     # stop + start
sudo systemctl reload   <name>     # re-read config (if service supports it)

sudo systemctl enable   <name>     # autostart on boot (doesn't start now)
sudo systemctl disable  <name>     # remove from autostart (leaves running)

sudo systemctl enable  --now <name>   # enable AND start
sudo systemctl disable --now <name>   # disable AND stop
```

### After editing a unit file

```sh
sudo systemctl daemon-reload          # tell systemd to re-read unit files
sudo systemctl restart <name>         # apply changes
sudo systemctl reset-failed <name>    # clear "failed" status so it's not red
```

### Remove a service entirely

```sh
sudo systemctl disable --now <name>
sudo rm /etc/systemd/system/<name>.service
sudo systemctl daemon-reload
sudo systemctl reset-failed <name>
```

---

## Logs

```sh
sudo journalctl -u rdio-scanner -f             # follow live (Ctrl-C to exit)
sudo journalctl -u rdio-scanner -n 50          # last 50 lines
sudo journalctl -u rdio-scanner --since '5 min ago'
sudo journalctl -u rdio-scanner --since today
sudo journalctl -u rdio-scanner -p err         # only errors and worse
sudo journalctl -u rdio-scanner --no-pager     # don't open in less
```

Replace `rdio-scanner` with `uniden-recorder` or `transcriber` for the
other two.

---

## The specific services in this stack

```sh
sudo systemctl status rdio-scanner       # the web server + audio ingest
sudo systemctl status uniden-recorder    # GLG poll + WAV writer
sudo systemctl status transcriber        # faster-whisper STT (optional)

# All at once
systemctl is-active rdio-scanner uniden-recorder transcriber

# Built-in health dashboard
scanner-status
```

---

## Uniden recorder one-offs

```sh
# Discover hardware (no install of the service needed)
cd ~/rdio-scanner/tools/uniden-recorder
python3 uniden_recorder.py --list-serial
python3 uniden_recorder.py --list-audio

# Smoke-test the config without touching the service
python3 uniden_recorder.py -c uniden-recorder.ini -v

# Drop the wav backlog (e.g. after a config change that fixed filenames)
sudo systemctl stop uniden-recorder
rm -f /home/scanner/scanner-calls/*.wav
sudo systemctl start uniden-recorder
```

---

## Transcriber one-offs

```sh
# Backfill every wav that doesn't yet have a transcript, then exit
cd ~/rdio-scanner/tools/transcriber
python3 transcriber.py -c transcriber.ini --once

# Re-transcribe one specific call (deleting its transcript first)
rm /home/scanner/scanner-transcripts/<basename>.txt
# (the running service will pick it up on its next poll cycle)

# Search transcripts
grep -lir 'warrant'   /home/scanner/scanner-transcripts/
grep  -ir 'signal 12' /home/scanner/scanner-transcripts/
```

---

## Audio plumbing

```sh
# Lower the USB-dongle input gain (fixes piercing audio)
alsamixer      # F4 → switch to Capture, F6 → pick USB dongle, drop slider

# Make alsamixer changes persist after reboot
sudo alsactl store

# Inspect a captured WAV (clipping check, level analysis)
sox /home/scanner/scanner-calls/<file>.wav -n stats
```

If `Pk lev dB` reports `0.00` you're clipping at the sound card; nothing
the server can do will un-clip it. Drop the capture slider another 10%.

---

## Upgrading rdio-scanner in-place

### Quick "is there a new release?" check

```sh
LATEST=$(curl -fsSL https://api.github.com/repos/evilgenius79/rdio-scanner/releases/latest \
  | grep '"tag_name"' | head -n1 | cut -d'"' -f4)
echo "Latest release on GitHub: $LATEST"
# Cross-reference against the running server's banner:
sudo journalctl -u rdio-scanner --no-pager | grep -i 'Rdio Scanner v' | tail -1
```

If those two match, you're up to date — nothing to do.

### Update in-place (auto-detects arch and latest tag)

Copy-paste block. Stops the services, downloads the right zip for this
Pi, extracts over your existing install, restarts.

```sh
set -e
cd ~/rdio-scanner

# Pick the right release asset for this CPU
case "$(uname -m)" in
  aarch64) ARCH="arm64" ;;
  armv7l|armv6l) ARCH="arm" ;;
  x86_64) ARCH="amd64" ;;
  *) echo "Unsupported arch: $(uname -m)"; exit 1 ;;
esac

# Fetch the latest tag from GitHub Releases (no auth required)
LATEST=$(curl -fsSL https://api.github.com/repos/evilgenius79/rdio-scanner/releases/latest \
  | grep '"tag_name"' | head -n1 | cut -d'"' -f4)
[ -n "$LATEST" ] || { echo "Could not fetch latest tag"; exit 1; }
echo "Updating to $LATEST (arch: $ARCH)"

ZIP="rdio-scanner-linux-${ARCH}-${LATEST}.zip"
URL="https://github.com/evilgenius79/rdio-scanner/releases/download/${LATEST}/${ZIP}"

# Pause the live stack so we don't trip mid-write
sudo systemctl stop uniden-recorder rdio-scanner 2>/dev/null || true

# Download to /tmp, verify the size is sane, extract over the install
curl -fL -o "/tmp/${ZIP}" "$URL"
[ "$(stat -c %s "/tmp/${ZIP}")" -gt 1000000 ] || { echo "Download too small, aborting"; exit 1; }
unzip -o "/tmp/${ZIP}" -d ~/rdio-scanner/
rm "/tmp/${ZIP}"

# Bring everything back up
sudo systemctl start rdio-scanner uniden-recorder

# Confirm the new version started cleanly
sleep 2
sudo journalctl -u rdio-scanner --since '30 sec ago' --no-pager | grep -i 'Rdio Scanner v' | tail -1
```

### Make it a one-shot command

Save the block above as `/usr/local/bin/update-rdio-scanner`:

```sh
sudo nano /usr/local/bin/update-rdio-scanner   # paste the block, save
sudo chmod +x /usr/local/bin/update-rdio-scanner

# Then upgrades become:
sudo update-rdio-scanner
```

### What's preserved during the upgrade

- `uniden-recorder.ini`, `transcriber.ini` (in `.gitignore` / never in the zip)
- `rdio-scanner.db` and its `.wal` / `.shm` siblings (in your run dir, not the zip)
- `/etc/systemd/system/*.service` files (you copied them there; the upgrade doesn't touch /etc)

### What's NOT preserved

- Edits you made directly to `tools/*/uniden_recorder.py` etc. (those files come from the zip and get overwritten). Patches you want to keep should go upstream so the next release includes them.

---

## One-screen sanity check

```sh
# What's enabled / what's broken / what errored recently
systemctl list-unit-files --type=service --state=enabled
systemctl --failed
journalctl -p err --since '1 hour ago' --no-pager | tail -20

# Stack-specific
scanner-status                      # dashboard if you installed it
ls -lt ~/scanner-calls/ | head -5   # most recent WAVs
ls -lt ~/scanner-transcripts/ | head -5   # most recent transcripts
```

If the dashboard isn't installed yet, this is the one-liner version:

```sh
systemctl is-active rdio-scanner uniden-recorder transcriber; \
ls /home/scanner/scanner-calls/*.wav 2>/dev/null | wc -l; \
df -h /home/scanner | tail -1
```

---

## Useful one-liners

```sh
# Watch journals for ANY of the three services together (Ctrl-C to exit)
sudo journalctl -u rdio-scanner -u uniden-recorder -u transcriber -f

# Tail rdio-scanner errors only, live
sudo journalctl -u rdio-scanner -f -p err

# Count calls ingested in the last hour (rough; based on log lines)
sudo journalctl -u rdio-scanner --since '1 hour ago' --no-pager \
  | grep -c 'newcall:'

# Find the biggest WAVs (calls that ran long)
ls -lS /home/scanner/scanner-calls/ | head -5

# Disk by directory under your home
du -h --max-depth=1 /home/scanner | sort -h
```
