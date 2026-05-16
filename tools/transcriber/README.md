# Call transcriber (speech-to-text sidecar)

Optional companion to `tools/uniden-recorder/` (or any DirWatch-fed
recorder). Watches the directory of recorded WAVs and writes a plain-text
`.txt` transcript of each call into a separate transcripts directory,
using **faster-whisper** locally — no cloud, no API keys.

The transcripts directory is intentionally separate from the recorder
output so rdio-scanner's DirWatch `Delete After` can purge ingested WAVs
without erasing the transcripts.

## What you get

For every call WAV like `20260516_171500_Rushville_Sheriff-Dispatc_12219.wav`,
the transcriber writes `20260516_171500_Rushville_Sheriff-Dispatc_12219.txt`
with a header line and the transcribed text:

```
2026-05-16T17:15:00  sys=Rushville  tg=Sheriff-Dispatc  tgid=12219  audio=4.7s
Suspect heading northbound on Main Street, in pursuit.
```

That makes the entire archive searchable:

```sh
grep -lir 'warrant'        /home/scanner/scanner-transcripts/
grep -ir  'signal 12'      /home/scanner/scanner-transcripts/
grep -ir  'tg=Sheriff' /home/scanner/scanner-transcripts/ | grep -i fire
```

## Realistic expectations

Whisper is good but it is **not court-grade**. On police-scanner audio
expect:

- 10-codes mangled ("10-50" → "Tenfifty" or "1050")
- Local proper nouns (street names, towns, callsigns) wrong unless you
  prime them via `initial_prompt` in the .ini
- Short squelch tails sometimes hallucinated as "Thank you" / "Bye" —
  raise `no_speech_threshold` toward 0.8 if it's annoying
- Quiet or heavily noised calls returning `(no speech detected)`

For richer accuracy you can move to `small.en` or `medium.en` but they
get slow on a Pi 4 (medium ~real-time, large is unusable). Test
`base.en` first.

## Install (Raspberry Pi OS)

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg python3-pip

# faster-whisper bundles its own CTranslate2 backend.
pip3 install --break-system-packages faster-whisper

cd /home/scanner/rdio-scanner/tools/transcriber
cp transcriber.example.ini transcriber.ini
nano transcriber.ini    # set watch_dir, transcripts_dir, model, initial_prompt

# Smoke test before installing the service. First run downloads the
# model (~140MB for base.en) into ~/.cache/huggingface.
python3 transcriber.py -c transcriber.ini -v
```

You should see something like:

```
loading model base.en (device=cpu, compute=int8)...
model ready in 3.8s
watching /home/scanner/scanner-calls, transcripts -> /home/scanner/scanner-transcripts
20260516_171500_..._12219.wav -> 4.7s audio / 3.1s work / 64 chars
```

Once it looks healthy, install as a service:

```sh
sudo cp transcriber.service /etc/systemd/system/
# Edit User=, Group=, paths, and Environment=HOME= to match your install.
sudo nano /etc/systemd/system/transcriber.service
sudo systemctl daemon-reload
sudo systemctl enable --now transcriber
sudo journalctl -u transcriber -f
```

## Backfill mode

To transcribe every WAV already in `watch_dir` without leaving the
service running, use `--once`:

```sh
python3 transcriber.py -c transcriber.ini --once
```

Useful right after first install when there's a backlog, or after you
swap models and want existing transcripts redone (delete the old `.txt`
files first; the transcriber skips wavs whose transcript already exists).

## Tuning

- **Calls split or merged wrong** — that's the recorder, not the
  transcriber. Tweak `min_silence_ms` in `uniden-recorder.ini`.
- **Truncated transcripts** — bump `beam_size` to 3 or 5 (more CPU per
  call but the decoder considers more candidates).
- **"Thank you" / "Bye" appearing on silent calls** — raise
  `no_speech_threshold` to 0.7 or 0.8.
- **Local names always wrong** — fill in `initial_prompt` with your
  10-codes, agencies, towns, and a few common street names. Whisper
  doesn't *transcribe* the prompt; it just biases decoding toward that
  vocabulary.
- **CPU pegged** — switch `model` to `tiny.en` (much faster, slightly
  worse). The transcriber processes calls serially so worst case it
  falls behind; it'll catch up during quiet periods.

## What this daemon doesn't do (yet)

- Push transcripts back into rdio-scanner's DB / UI. The transcripts
  live as plain `.txt` files only.
- Render text-to-speech "clean" audio. That's a possible phase 2 once
  this proves transcripts are usable for your audio.
- Speaker diarization (who's talking). Whisper doesn't do this and the
  audio is usually one person per call anyway.

## Resource notes

| Model      | RAM   | Pi 4 CPU work per 10s call | Notes |
| ---------- | ----- | ---------------------------| ----- |
| tiny.en    | ~150M | ~2s                        | rough but legible |
| **base.en**| ~300M | **~5s**                    | **recommended starting point** |
| small.en   | ~750M | ~15s                       | noticeably more accurate |
| medium.en  | ~2.5G | ~40s                       | needs Pi 4 8GB or Pi 5 |
| large-v3   | ~4G   | not viable                 | use a real machine |

First model download lands in `~/.cache/huggingface/` and stays there.
Delete it if you want to free space (next run will re-download).
