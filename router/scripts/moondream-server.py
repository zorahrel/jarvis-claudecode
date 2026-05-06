#!/usr/bin/env python3
"""Moondream Station daemon for Jarvis.

Starts the Moondream Station REST server (vision local inference) on
http://127.0.0.1:2020 without going through the interactive REPL. Suitable
for launchd / systemd supervision alongside ChromaDB and OMEGA.

Env:
  MOONDREAM_MODEL   model id from the manifest, default 'moondream-2'
                    (~1.6B params, fits comfortably in 16-32 GB Macs).
                    Use 'moondream-3-preview-mlx' for higher quality on
                    48 GB+ Macs; the un-quantized MLX build needs ~30 GB
                    resident, the INT4 quantized build produced garbage
                    tokens in our M2 Max testing.
  MOONDREAM_PORT    REST port, default 2020
  MOONDREAM_HOST    bind host, default 127.0.0.1
  MOONDREAM_TIMEOUT inference timeout in seconds, default 180
  HF_TOKEN          optional HuggingFace token (pass-through, not stored).

The daemon foregrounds the uvicorn server thread; SIGTERM / SIGINT shut it
down cleanly.
"""

import os
import signal
import sys
import time

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


def log(msg: str) -> None:
    print(f"[moondream-server] {msg}", flush=True)


# Skip the REPL prompt by ensuring SOMETHING is set before the package looks.
# We keep it empty if no real token is provided — Moondream Station only uses
# HF_TOKEN as a Bearer header, not for auth gating, so 'skip' is safe.
os.environ.setdefault("HF_TOKEN", os.environ.get("HF_TOKEN", "skip"))

from moondream_station.core.config import ConfigManager  # noqa: E402
from moondream_station.core.manifest import ManifestManager  # noqa: E402
from moondream_station.core.models import ModelManager  # noqa: E402
from moondream_station.core.service import ServiceManager  # noqa: E402
from moondream_station.session import SessionState  # noqa: E402


MANIFEST_URL = (
    "https://m87-md-prod-assets.s3.us-west-2.amazonaws.com/"
    "station/mds2/production_manifest.json"
)


def main() -> int:
    target_model = os.environ.get("MOONDREAM_MODEL", "moondream-2")
    port = int(os.environ.get("MOONDREAM_PORT", "2020"))
    host = os.environ.get("MOONDREAM_HOST", "127.0.0.1")
    timeout = float(os.environ.get("MOONDREAM_TIMEOUT", "180"))

    config = ConfigManager()
    config.set("service_port", port)
    config.set("service_host", host)
    config.set("inference_timeout", timeout)
    # Make sure auto_start is on (defensive — REPL flag, harmless here).
    config.set("auto_start", True)

    manifest = ManifestManager(config)

    log(f"loading manifest from {MANIFEST_URL}")
    try:
        manifest.load_manifest(MANIFEST_URL, analytics=None, display=None)
    except Exception as e:
        log(f"manifest load failed: {e}")
        return 2

    models = ModelManager(config, manifest)
    available = models.list_models()
    if target_model not in available:
        log(f"model '{target_model}' not in manifest. Available: {available}")
        return 3

    is_supported, reason = models.is_model_supported(target_model)
    if not is_supported:
        log(f"model '{target_model}' not supported on this host: {reason}")
        return 4

    log(f"switching to model '{target_model}' (downloads backend on first run)")
    if not models.switch_model(target_model, display=None):
        log("switch_model returned False — backend setup failed")
        return 5

    session_state = SessionState()
    service = ServiceManager(config, manifest, session_state, analytics=None)

    log(f"starting REST server on http://{host}:{port}")
    if not service.start(target_model, port):
        log("service.start failed")
        return 6

    log(f"ready: model={target_model} endpoint=http://{host}:{port}/v1")

    stop = {"flag": False}

    def _handle(signum, _frame):
        log(f"received signal {signum}, shutting down")
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)

    try:
        while not stop["flag"]:
            if not service.is_running():
                log("service died unexpectedly")
                return 7
            time.sleep(1.0)
    finally:
        try:
            service.stop()
        except Exception as e:
            log(f"stop error: {e}")

    log("exited")
    return 0


if __name__ == "__main__":
    sys.exit(main())
