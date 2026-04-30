#!/usr/bin/env python3
"""
Kokoro TTS wrapper for the Jarvis notch.

Reads UTF-8 text on stdin, writes audio bytes on stdout. By default produces
MP3 (32 kbps mono) via ffmpeg; with `--format wav` emits raw Kokoro-sampled
16-bit PCM. Exits 127 when `kokoro-onnx`/`soundfile` are missing OR when the
model paths haven't been configured, so the TS caller can fall back to `say`
without treating a missing dep as a real error.

Required env:
  KOKORO_MODEL_PATH    absolute path to kokoro-v0_19.onnx
  KOKORO_VOICES_PATH   absolute path to voices.bin
Optional env:
  KOKORO_LANG          default "en-us"

Typical setup:
  pip install kokoro-onnx soundfile
  curl -L -o ~/.cache/kokoro/kokoro-v0_19.onnx \\
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v0_19.onnx
  curl -L -o ~/.cache/kokoro/voices.bin \\
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/voices.bin
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile


def die(msg: str, code: int = 127) -> None:
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(code)


def main() -> None:
    parser = argparse.ArgumentParser(description="Kokoro TTS → stdout")
    parser.add_argument("--voice", default="af_sky")
    parser.add_argument("--format", default="mp3", choices=["mp3", "wav"])
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        die("empty input", code=2)

    try:
        from kokoro_onnx import Kokoro  # type: ignore
        import soundfile as sf  # type: ignore
    except Exception as exc:  # ImportError OR native lib issue
        die(f"kokoro-onnx missing: {exc}")

    model_path = os.environ.get("KOKORO_MODEL_PATH")
    voices_path = os.environ.get("KOKORO_VOICES_PATH")
    if not (model_path and voices_path):
        die("KOKORO_MODEL_PATH / KOKORO_VOICES_PATH env not set")
    if not (os.path.isfile(model_path) and os.path.isfile(voices_path)):
        die(f"Kokoro model/voices not found: {model_path} | {voices_path}")

    lang = os.environ.get("KOKORO_LANG", "en-us")

    try:
        kokoro = Kokoro(model_path, voices_path)
        samples, sample_rate = kokoro.create(
            text, voice=args.voice, speed=args.speed, lang=lang
        )
    except Exception as exc:
        die(f"synthesis failed: {exc}", code=1)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        sf.write(wav_path, samples, sample_rate, subtype="PCM_16")
        if args.format == "wav":
            with open(wav_path, "rb") as fh:
                shutil.copyfileobj(fh, sys.stdout.buffer)
            return
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            sys.stderr.write("ffmpeg missing; emitting WAV\n")
            with open(wav_path, "rb") as fh:
                shutil.copyfileobj(fh, sys.stdout.buffer)
            return
        proc = subprocess.Popen(
            [
                ffmpeg, "-y", "-loglevel", "error",
                "-i", wav_path,
                "-f", "mp3", "-b:a", "32k", "-ac", "1",
                "-",
            ],
            stdout=subprocess.PIPE,
        )
        assert proc.stdout is not None
        shutil.copyfileobj(proc.stdout, sys.stdout.buffer)
        code = proc.wait()
        if code != 0:
            sys.exit(code)
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
