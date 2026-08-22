"""
Socket.IO-only relay for multi-channel ADC/DAC data (no locally-served UI).

This module is a thin real-time relay: it polls raw samples from the MCU
over Bridge/RPC and forwards them to the browser unmodified over Socket.IO.
All signal processing (filters, adaptive-mean/BPM detection, per-channel
demultiplexing of the tagged sample encoding) and the UI itself live in a
p5.js Web Editor project (editor.p5js.org), not in this repo -- see the
project's concept doc (Multichannel_ADC_Sampling.md, "p5.js Web Editor as
the live-coding target") for why that works and what it requires. This
`WebUI` instance is deliberately given no `assets_dir_path`, so it serves
no static files at all -- just the Socket.IO endpoint at
`http://localhost:7000`.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from arduino.app_bricks.web_ui import WebUI
from arduino.app_utils import App

from arduino_q_bridge_rpc import ArduinoQRpcClient, open_rpc
from data_stream import RawRingBuffer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("adc")

PLOT_WINDOW = 800
STREAM_LENGTH = 4000
# Polling every 40ms --> 25 FPS
POLL_INTERVAL_S = 0.05
# Log a heartbeat every N seconds so a stalled data stream is visible even
# without errors (e.g. MCU stopped sampling but RPC calls still succeed).
HEARTBEAT_INTERVAL_S = 5.0
# Safety cap on how many frames to drain from the MCU ring buffer per poll
# tick -- normally 1-2 is enough; this just prevents an unbounded loop if
# something is very wrong.
MAX_DRAIN_FRAMES_PER_TICK = 20


class AdcWebServer:
    def __init__(self) -> None:
        # No assets_dir_path: WebUI skips static-file routing entirely when
        # the directory doesn't exist, leaving only the Socket.IO endpoint.
        #
        # cors_origins="" deliberately DISABLES WebUI's own FastAPI-level
        # CORSMiddleware (its default is "*", which would otherwise add
        # one). Reason: WebUI's internal fastapi_socketio.SocketManager
        # already applies its own, independent CORS handling to the
        # /socket.io routes (also defaulting to allow-all, but by echoing
        # the request's actual Origin rather than sending a literal "*").
        # With BOTH layers active, a cross-origin request gets TWO
        # Access-Control-Allow-Origin headers (e.g. "https://editor.p5js.org, *"),
        # which browsers reject outright as an invalid response -- this is
        # exactly what broke the p5.js Web Editor connection in practice.
        # We don't expose any other HTTP routes here, so disabling the
        # redundant outer layer and relying solely on the Socket.IO-level
        # one is sufficient and removes the conflict.
        self.ui = WebUI(cors_origins="")

        self.ui.on_connect(self._on_connect)
        self.ui.on_disconnect(self._on_disconnect)
        self.ui.on_message("clear_buffer", self._wrap(self._handle_clear_buffer))
        self.ui.on_message("request_status", self._wrap(self._handle_request_status))
        self.ui.on_message("configure_adc", self._wrap(self._handle_configure_adc))
        self.ui.on_message("configure_dac", self._wrap(self._handle_configure_dac))
        self.ui.on_message("dac_off", self._wrap(self._handle_dac_off))
        self.ui.on_message("digital_write", self._wrap(self._handle_digital_write))
        self.ui.on_message("digital_read", self._wrap(self._handle_digital_read))

        self.stream = RawRingBuffer(length=STREAM_LENGTH)
        self.client: ArduinoQRpcClient | None = None

        self.status = "Not connected"
        self.t0: float | None = None
        self.last_count = 0
        self.last_sampling_rate: float | None = None

        self.last_meta: dict[str, Any] | None = None
        self.lock = threading.RLock()
        self.stop_event = threading.Event()

        self.poll_thread = threading.Thread(target=self._poll_loop, daemon=True)

        # Diagnostics: only log status changes (not every poll), plus a
        # periodic heartbeat so a silently stalled stream is still visible.
        self._logged_status: str | None = None
        self._next_heartbeat = time.monotonic()
        self._samples_since_heartbeat = 0

    def start(self) -> None:
        log.info("stage=startup poll_interval_s=%.3f", POLL_INTERVAL_S)
        self.poll_thread.start()
        App.run()

    def _wrap(self, fn):
        def wrapper(*args):
            if len(args) == 2:
                return fn(args[0], args[1] or {})
            return fn(None, {})
        return wrapper

    def _poll_loop(self) -> None:
        next_tick = time.monotonic()
        while not self.stop_event.is_set():
            self._poll_once()
            self._log_heartbeat()
            next_tick += POLL_INTERVAL_S
            sleep_s = next_tick - time.monotonic()
            if sleep_s > 0:
                time.sleep(sleep_s)

    def _set_status(self, status: str) -> None:
        self.status = status
        if status != self._logged_status:
            log.info("stage=bridge_rpc status=%s", status)
            self._logged_status = status

    def _log_heartbeat(self) -> None:
        now = time.monotonic()
        if now < self._next_heartbeat:
            return
        self._next_heartbeat = now + HEARTBEAT_INTERVAL_S
        log.info(
            "stage=poll_loop samples_last_%.0fs=%d status=%s",
            HEARTBEAT_INTERVAL_S,
            self._samples_since_heartbeat,
            self.status,
        )
        self._samples_since_heartbeat = 0

    def _poll_once(self) -> bool:
        if self.client is None:
            try:
                self.client = open_rpc()
                self._set_status("Connected (Bridge RPC)")
            except Exception as exc:
                self._set_status(f"RPC error: {exc}")
                return False

        # Drain the MCU ring buffer fully each tick, not just once, so backlog
        # size no longer depends on POLL_INTERVAL_S -- this matters more, not
        # less, as channel count and sample rate increase (see concept doc §1).
        got_any = False
        for _ in range(MAX_DRAIN_FRAMES_PER_TICK):
            try:
                samples, timestamps = self.client.request_frame()
            except Exception as exc:
                self._set_status(f"RPC error: {exc}")
                self.client = None
                return got_any

            if not samples:
                break
            got_any = True
            self._handle_frame(samples, timestamps)

        return got_any

    def _handle_frame(self, samples: list[int], timestamps: list[int]) -> None:
        self._samples_since_heartbeat += len(samples)

        with self.lock:
            if self.t0 is None and timestamps:
                self.t0 = float(timestamps[0])

            self.stream.add_samples(samples, timestamps)
            self.last_count = len(samples)

            if len(timestamps) >= 2:
                span_ms = timestamps[-1] - timestamps[0]
                if span_ms > 0:
                    self.last_sampling_rate = (len(timestamps) - 1) / (span_ms / 1000.0)

            meta = {
                "status": self.status,
                "last_count": self.last_count,
                "sampling_rate_hz": self.last_sampling_rate,
            }

            delta = self._build_delta_payload(samples, timestamps)
            if not delta:
                return

            self.last_meta = meta

        self.ui.send_message("adc_meta", meta)
        self.ui.send_message("adc_delta", delta)

    def _on_connect(self, sid: str) -> None:
        log.info("stage=browser_socket connected sid=%s", sid)
        with self.lock:
            meta = self.last_meta
            payload = self._build_full_payload()
        if meta:
            self.ui.send_message("adc_meta", meta, room=sid)
        if payload:
            self.ui.send_message("adc_frame", payload, room=sid)

    def _on_disconnect(self, sid: str) -> None:
        log.info("stage=browser_socket disconnected sid=%s", sid)

    def _handle_clear_buffer(self, _sid, _payload):
        with self.lock:
            self.stream = RawRingBuffer(length=STREAM_LENGTH)
            self.t0 = None
            self.last_meta = None
        return {"cleared": True}

    def _handle_request_status(self, _sid, _payload):
        with self.lock:
            payload = self._build_full_payload()
        return payload or {"status": self.status}

    def _handle_configure_adc(self, _sid, payload):
        """payload: {"channels": [0..5, ...]} -- pin indices for A0..A5."""
        channels = payload.get("channels", [])
        if self.client is None:
            return {"error": "not connected"}
        try:
            confirmed = self.client.set_channels(channels)
        except Exception as exc:
            log.info("stage=configure_adc error=%s", exc)
            return {"error": str(exc)}
        log.info("stage=configure_adc channels=%s", confirmed)
        return {"channels": confirmed}

    def _handle_configure_dac(self, _sid, payload):
        """payload: {"channel": 0|1, "type": "sine"/"square"/"triangle"/"off",
        "freqHz": float, "amplitude": float}."""
        if self.client is None:
            return {"error": "not connected"}
        try:
            ok = self.client.set_dac_waveform(
                channel=payload.get("channel", 0),
                waveform=payload.get("type", "off"),
                freq_hz=payload.get("freqHz", 0.0),
                amplitude=payload.get("amplitude", 0.0),
            )
        except Exception as exc:
            log.info("stage=configure_dac error=%s", exc)
            return {"error": str(exc)}
        return {"ok": ok}

    def _handle_dac_off(self, _sid, payload):
        """payload: {"channel": 0|1}."""
        if self.client is None:
            return {"error": "not connected"}
        try:
            ok = self.client.dac_off(payload.get("channel", 0))
        except Exception as exc:
            log.info("stage=dac_off error=%s", exc)
            return {"error": str(exc)}
        return {"ok": ok}

    def _handle_digital_write(self, _sid, payload):
        """payload: {"pin": int, "value": bool}."""
        if self.client is None:
            return {"error": "not connected"}
        try:
            ok = self.client.digital_write(payload.get("pin", 0), payload.get("value", False))
        except Exception as exc:
            log.info("stage=digital_write error=%s", exc)
            return {"error": str(exc)}
        return {"ok": ok}

    def _handle_digital_read(self, _sid, payload):
        """payload: {"pin": int}."""
        if self.client is None:
            return {"error": "not connected"}
        try:
            value = self.client.digital_read(payload.get("pin", 0))
        except Exception as exc:
            log.info("stage=digital_read error=%s", exc)
            return {"error": str(exc)}
        return {"value": value}

    def _build_delta_payload(
        self, samples: list[float], timestamps: list[float]
    ) -> dict[str, Any] | None:
        count = len(samples)
        if count == 0:
            return None
        t0 = int(round(timestamps[0]))
        dts = [0] * count
        prev_t = t0
        for i in range(1, count):
            dt = int(round(timestamps[i] - prev_t))
            if dt < 0:
                dt = 0
            elif dt > 255:
                dt = 255
            dts[i] = dt
            prev_t = int(round(timestamps[i]))

        return {
            "t0": t0,
            "dt": dts,
            "y": [float(val) for val in samples],
        }

    def _build_full_payload(self) -> dict[str, Any] | None:
        y, t = self.stream.last(PLOT_WINDOW)
        if not y:
            return None
        if self.t0 is None and t:
            self.t0 = float(t[0])
        t0 = self.t0 or 0.0
        return {
            "plot_window": PLOT_WINDOW,
            "signal": {
                "t0": t0,
                "t": [ts - t0 for ts in t],
                "y": list(y),
            },
        }


def main() -> None:
    AdcWebServer().start()


if __name__ == "__main__":
    main()
