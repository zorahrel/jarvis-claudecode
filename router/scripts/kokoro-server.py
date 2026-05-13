#!/usr/bin/env python3
"""
Kokoro TTS HTTP server.

Loads the Kokoro v1.0 model + voice bank ONCE at startup and serves
synthesis requests over a tiny HTTP API. This avoids the ~2 s Python
cold-start + model-load tax we'd pay if Jarvis spawned a fresh
subprocess per reply — warm latency is ~0.3-0.9 s on a M-series MBP.

POST /tts
  Body : application/x-www-form-urlencoded with `text`, optional
         `voice` (default `im_nicola` = Italian male, Jarvis-friendly),
         optional `lang` (default `it`), optional `speed` (default 1.0)
  Reply: audio/mpeg MP3 streamed back via ffmpeg.

GET /health → 200 "ok" once the model is warm.

Default port 3344. Override with KOKORO_PORT env.
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_PATH = os.environ.get(
    "KOKORO_MODEL_PATH",
    os.path.expanduser("~/.cache/kokoro/kokoro-v1.0.onnx"),
)
VOICES_PATH = os.environ.get(
    "KOKORO_VOICES_PATH",
    os.path.expanduser("~/.cache/kokoro/voices-v1.0.bin"),
)
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "im_nicola")
DEFAULT_LANG = os.environ.get("KOKORO_LANG", "it")
PORT = int(os.environ.get("KOKORO_PORT", "3344"))

# Loaded at process boot, shared across requests under a lock since
# `kokoro_onnx.Kokoro.create` is not documented as thread-safe.
print(f"[kokoro] loading model {MODEL_PATH}...", file=sys.stderr, flush=True)
_t0 = time.time()
_kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
# Warm up the ONNX session so the first real request isn't slow.
_kokoro.create("a", voice=DEFAULT_VOICE, lang=DEFAULT_LANG)
print(f"[kokoro] ready in {time.time() - _t0:.1f}s", file=sys.stderr, flush=True)
_lock = threading.Lock()


def synth_mp3(text: str, voice: str, lang: str, speed: float) -> bytes:
    """Synthesize → WAV in memory → ffmpeg → MP3 bytes."""
    with _lock:
        samples, sr = _kokoro.create(text, voice=voice, lang=lang, speed=speed)
    wav_buf = io.BytesIO()
    sf.write(wav_buf, samples, sr, format="WAV")
    wav_buf.seek(0)
    # 32 kbps mono MP3 — same shape the rest of the Jarvis pipeline
    # serves so the WebView <audio> tag treats every engine's output
    # identically.
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-i", "pipe:0",
         "-f", "mp3", "-b:a", "32k", "-ac", "1",
         "pipe:1"],
        input=wav_buf.read(),
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg exit {proc.returncode}: {proc.stderr.decode('utf-8', 'ignore')[:200]}"
        )
    return proc.stdout


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[kokoro] {self.address_string()} - {fmt % args}\n")

    def do_GET(self) -> None:
        if self.path.startswith("/health"):
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        params = urllib.parse.parse_qs(raw)
        text = (params.get("text") or [""])[0].strip()
        voice = (params.get("voice") or [DEFAULT_VOICE])[0]
        lang = (params.get("lang") or [DEFAULT_LANG])[0]
        try:
            speed = float((params.get("speed") or ["1.0"])[0])
        except ValueError:
            speed = 1.0
        if not text:
            self.send_response(400)
            self.end_headers()
            return
        try:
            mp3 = synth_mp3(text, voice, lang, speed)
        except Exception as e:
            err = f"synth failed: {e}".encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(mp3)))
        self.end_headers()
        self.wfile.write(mp3)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[kokoro] listening on http://127.0.0.1:{PORT}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[kokoro] shutting down", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
