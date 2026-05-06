#!/usr/bin/env python3
"""
MLX-Audio TTS wrapper — reads UTF-8 text on stdin, writes MP3 on stdout.

Target model (default): `mlx-community/Voxtral-4B-TTS-2603-mlx-4bit` —
Mistral's 4B multilingual TTS in MLX 4-bit, with 20 preset voices
including `it_male` / `it_female`. ~2.8 GB peak RAM, RTF ~1.3x on
Apple Silicon (faster than real-time). Optionally swappable via env:

  JARVIS_TTS_MLX_MODEL   HuggingFace repo id
  JARVIS_TTS_MLX_VOICE   preset voice name (defaults to it_male)

Exits 127 when mlx-audio isn't installed so the TS caller can fall
back to `say`/AVSpeechSynthesizer without treating the missing dep
as a real error.
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


def find_mlx_cli() -> str | None:
    # `mlx_audio.tts.generate` lands in ~/Library/Python/3.x/bin which is
    # rarely on PATH. Look there first, then fall back to which().
    local = os.path.expanduser("~/Library/Python/3.14/bin/mlx_audio.tts.generate")
    if os.path.isfile(local):
        return local
    return shutil.which("mlx_audio.tts.generate")


def main() -> None:
    parser = argparse.ArgumentParser(description="MLX-Audio TTS → stdout MP3")
    parser.add_argument(
        "--model",
        default=os.environ.get("JARVIS_TTS_MLX_MODEL", "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit"),
    )
    parser.add_argument(
        "--voice",
        default=os.environ.get("JARVIS_TTS_MLX_VOICE", "it_male"),
    )
    parser.add_argument("--lang", default=os.environ.get("JARVIS_TTS_MLX_LANG", "it"))
    parser.add_argument("--format", default="mp3", choices=["mp3", "wav"])
    args = parser.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        die("empty input", code=2)

    cli = find_mlx_cli()
    if not cli:
        die("mlx-audio not installed (pip install --user mlx-audio tiktoken mistral-common)")

    with tempfile.TemporaryDirectory(prefix="jarvis-mlx-tts-") as tmp:
        prefix = os.path.join(tmp, "out")
        cmd = [
            cli,
            "--model", args.model,
            "--voice", args.voice,
            "--lang_code", args.lang,
            "--file_prefix", prefix,
            "--text", text,
            "--audio_format", "wav",
        ]
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            die(
                f"mlx-audio exit {proc.returncode}: {proc.stderr.decode(errors='replace')[:500]}",
                code=proc.returncode or 1,
            )
        wav = prefix + "_000.wav"
        if not os.path.isfile(wav):
            die("mlx-audio produced no output", code=1)

        if args.format == "wav":
            with open(wav, "rb") as fh:
                shutil.copyfileobj(fh, sys.stdout.buffer)
            return

        ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
        if not os.path.isfile(ffmpeg):
            sys.stderr.write("ffmpeg missing; emitting WAV\n")
            with open(wav, "rb") as fh:
                shutil.copyfileobj(fh, sys.stdout.buffer)
            return

        ff = subprocess.Popen(
            [ffmpeg, "-y", "-loglevel", "error", "-i", wav,
             "-f", "mp3", "-b:a", "96k", "-ac", "1", "-"],
            stdout=subprocess.PIPE,
        )
        assert ff.stdout is not None
        shutil.copyfileobj(ff.stdout, sys.stdout.buffer)
        code = ff.wait()
        if code != 0:
            sys.exit(code)


if __name__ == "__main__":
    main()
