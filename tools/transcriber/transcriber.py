#!/usr/bin/env python3
# transcriber.py - Speech-to-text sidecar for rdio-scanner.
#
# Watches a directory of WAV files (the same one the Uniden recorder writes
# into, or anywhere DirWatch ingests from) and transcribes each new call
# with faster-whisper. Writes a sibling `.txt` into a separate transcripts
# directory so rdio-scanner's DirWatch DeleteAfter can still purge the WAV
# without erasing the transcript.
#
# This is intentionally decoupled from rdio-scanner itself: no admin
# integration, no server changes. It produces a plain-text searchable
# archive of every call. Future iterations can render the transcripts back
# through TTS, push them into the call metadata, etc.
#
# License: GPL-3.0-or-later, same as rdio-scanner.

import argparse
import configparser
import logging
import os
import re
import shutil
import signal
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

try:
    from faster_whisper import WhisperModel
except ImportError as exc:
    sys.stderr.write(
        f"missing dependency: {exc.name}\n"
        "install with: pip3 install --break-system-packages faster-whisper\n"
        "system deps:  sudo apt-get install -y ffmpeg\n"
    )
    sys.exit(2)


LOG = logging.getLogger("transcriber")

DEFAULT_CONFIG_PATHS = (
    "transcriber.ini",
    "/etc/transcriber.ini",
)

# Filenames from uniden_recorder.py look like:
#   YYYYMMDD_HHMMSS_<syslbl>_<tglbl>_<tg>.wav
# This regex pulls the metadata back out so we can stamp it on the
# transcript header without having to parse the rdio-scanner DB.
_FNAME_META = re.compile(
    r"^(?P<date>\d{8})_(?P<time>\d{6})_(?P<sys>[^_]+)_(?P<tg>[^_]+)_(?P<id>\d+)$"
)


@dataclass
class CallMeta:
    """Best-effort metadata teased out of the .wav filename."""
    date_iso: str = ""
    sys_label: str = ""
    tg_label: str = ""
    tg_id: str = ""

    @classmethod
    def from_filename(cls, name: str) -> "CallMeta":
        stem = Path(name).stem
        m = _FNAME_META.match(stem)
        if not m:
            return cls()
        d, t = m.group("date"), m.group("time")
        date_iso = f"{d[:4]}-{d[4:6]}-{d[6:]}T{t[:2]}:{t[2:4]}:{t[4:]}"
        return cls(
            date_iso=date_iso,
            sys_label=m.group("sys"),
            tg_label=m.group("tg"),
            tg_id=m.group("id"),
        )


class Transcriber:
    def __init__(self, cfg: configparser.SectionProxy):
        self.watch_dir = Path(cfg.get("watch_dir", "/home/scanner/scanner-calls")).expanduser()
        self.transcripts_dir = Path(cfg.get("transcripts_dir", "/home/scanner/scanner-transcripts")).expanduser()
        self.model_name = cfg.get("model", "base.en")
        self.device = cfg.get("device", "cpu")
        self.compute_type = cfg.get("compute_type", "int8")
        self.language = cfg.get("language", "en") or None
        self.poll_seconds = max(1, cfg.getint("poll_seconds", 5))
        self.min_wav_seconds = cfg.getfloat("min_wav_seconds", 0.5)
        self.initial_prompt = cfg.get("initial_prompt", "").strip() or None
        self.beam_size = cfg.getint("beam_size", 1)
        # Drop short hallucinated tail "thanks for watching"-type segments.
        self.no_speech_threshold = cfg.getfloat("no_speech_threshold", 0.6)

        self.transcripts_dir.mkdir(parents=True, exist_ok=True)

        self._stop = threading.Event()
        self._model: Optional[WhisperModel] = None
        # In-memory record of paths we've already kicked off, so a slow
        # transcription doesn't get picked up a second time by the next poll.
        self._in_flight: set = set()

    # ---- public ---------------------------------------------------------

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)

        LOG.info("loading model %s (device=%s, compute=%s)...",
                 self.model_name, self.device, self.compute_type)
        t0 = time.time()
        try:
            self._model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute_type)
        except Exception as exc:
            LOG.error("model load failed: %s", exc)
            return 1
        LOG.info("model ready in %.1fs", time.time() - t0)
        LOG.info("watching %s, transcripts -> %s", self.watch_dir, self.transcripts_dir)

        while not self._stop.is_set():
            try:
                for wav in self._pending_wavs():
                    if self._stop.is_set():
                        break
                    self._process(wav)
            except Exception as exc:
                LOG.warning("poll cycle: %s", exc)
            self._sleep_interruptible(self.poll_seconds)
        return 0

    def stop(self) -> None:
        self._stop.set()

    # ---- queue -----------------------------------------------------------

    def _pending_wavs(self) -> Iterable[Path]:
        """Yield .wav files in the watch dir that don't yet have a transcript
        AND aren't already in flight."""
        if not self.watch_dir.is_dir():
            return
        for entry in self.watch_dir.iterdir():
            if entry.suffix.lower() != ".wav":
                continue
            if entry.name.endswith(".part"):
                continue
            if entry in self._in_flight:
                continue
            if self._transcript_path(entry).exists():
                continue
            yield entry

    def _transcript_path(self, wav: Path) -> Path:
        return self.transcripts_dir / (wav.stem + ".txt")

    # ---- one call --------------------------------------------------------

    def _process(self, wav: Path) -> None:
        self._in_flight.add(wav)
        try:
            # Copy first, transcribe second. Decouples us from DirWatch's
            # DeleteAfter: even if rdio-scanner ingests and deletes the wav
            # mid-transcription, the temp copy keeps us alive.
            tmp = self.transcripts_dir / (wav.stem + ".working.wav")
            try:
                shutil.copyfile(wav, tmp)
            except FileNotFoundError:
                # DirWatch ate it before we got to it; nothing to do.
                LOG.debug("wav vanished before copy: %s", wav.name)
                return
            except OSError as exc:
                LOG.warning("copy failed for %s: %s", wav.name, exc)
                return

            try:
                self._transcribe(wav, tmp)
            finally:
                try:
                    tmp.unlink(missing_ok=True)
                except Exception:
                    pass
        finally:
            self._in_flight.discard(wav)

    def _transcribe(self, original_wav: Path, working_copy: Path) -> None:
        assert self._model is not None
        meta = CallMeta.from_filename(original_wav.name)

        start = time.time()
        try:
            segments_iter, info = self._model.transcribe(
                str(working_copy),
                language=self.language,
                beam_size=self.beam_size,
                initial_prompt=self.initial_prompt,
                no_speech_threshold=self.no_speech_threshold,
                # `condition_on_previous_text=False` cuts down on Whisper's
                # tendency to repeat the previous utterance when given short,
                # clipped audio (very common for radio calls).
                condition_on_previous_text=False,
            )
        except Exception as exc:
            LOG.warning("transcribe failed for %s: %s", original_wav.name, exc)
            return

        if info.duration < self.min_wav_seconds:
            LOG.debug("skip %s: only %.2fs of audio", original_wav.name, info.duration)
            return

        # `segments_iter` is a generator; consuming it does the actual work.
        text_parts = []
        for seg in segments_iter:
            t = (seg.text or "").strip()
            if t:
                text_parts.append(t)
        text = " ".join(text_parts).strip()

        elapsed = time.time() - start

        if not text:
            LOG.info("no speech detected in %s (%.1fs audio, %.1fs work)",
                     original_wav.name, info.duration, elapsed)
            # Still write an empty marker so we don't keep retrying.
            text = "(no speech detected)"

        self._write_transcript(original_wav, meta, info.duration, elapsed, text)

        LOG.info("%s -> %.1fs audio / %.1fs work / %d chars",
                 original_wav.name, info.duration, elapsed, len(text))

    def _write_transcript(
        self,
        wav: Path,
        meta: CallMeta,
        audio_seconds: float,
        work_seconds: float,
        text: str,
    ) -> None:
        path = self._transcript_path(wav)
        tmp = path.with_suffix(path.suffix + ".tmp")
        header_bits = []
        if meta.date_iso:
            header_bits.append(meta.date_iso)
        if meta.sys_label:
            header_bits.append(f"sys={meta.sys_label}")
        if meta.tg_label:
            header_bits.append(f"tg={meta.tg_label}")
        if meta.tg_id:
            header_bits.append(f"tgid={meta.tg_id}")
        header_bits.append(f"audio={audio_seconds:.1f}s")
        header = "  ".join(header_bits)

        body = f"{header}\n{text}\n"

        try:
            tmp.write_text(body, encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:
            LOG.warning("could not write transcript %s: %s", path, exc)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

    # ---- signals ---------------------------------------------------------

    def _sleep_interruptible(self, seconds: float) -> None:
        end = time.time() + seconds
        while not self._stop.is_set() and time.time() < end:
            time.sleep(0.25)

    def _on_signal(self, signum, frame) -> None:
        LOG.info("signal %d received, shutting down", signum)
        self.stop()


def _load_config(path: Optional[str]) -> configparser.SectionProxy:
    parser = configparser.ConfigParser()
    candidates = [path] if path else list(DEFAULT_CONFIG_PATHS)
    chosen = None
    for cand in candidates:
        if cand and Path(cand).exists():
            chosen = cand
            break
    if chosen is None:
        LOG.warning("no config file found in %s; using built-in defaults", candidates)
        parser.read_dict({"transcriber": {}})
    else:
        parser.read(chosen)
        if "transcriber" not in parser:
            raise SystemExit(f"config {chosen!r} missing [transcriber] section")
    return parser["transcriber"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="rdio-scanner companion: faster-whisper transcripts of recorded calls")
    ap.add_argument("-c", "--config", help="path to .ini")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    ap.add_argument("--once", action="store_true",
                    help="process every pending wav once and exit (useful for backfills)")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    cfg = _load_config(args.config)
    t = Transcriber(cfg)

    if args.once:
        # One pass, no loop. Handy for transcribing a backlog after first
        # install without leaving the service running.
        t._stop.set()
        # Load model up front like run() does.
        LOG.info("loading model %s ...", t.model_name)
        t._model = WhisperModel(t.model_name, device=t.device, compute_type=t.compute_type)
        count = 0
        for wav in list(t._pending_wavs()):
            t._process(wav)
            count += 1
        LOG.info("--once: processed %d file(s)", count)
        return 0

    return t.run()


if __name__ == "__main__":
    sys.exit(main())
