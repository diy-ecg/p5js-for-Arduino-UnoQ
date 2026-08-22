"""
RPC transport and frame parser for the Arduino UNO Q Bridge endpoint.

The STM32 sketch exposes several methods via Bridge/RPC:
  adc_get_frame() -> MsgPack binary payload:
    [uint8 count][uint32 t0_ms][count * (uint16 tagged_value + uint8 dt_ms)]
    Optional leading 0x21 ('!') represents an overflow marker and is ignored.
    tagged_value packs a 2-bit channel index into its top bits (see the
    project's concept doc, §2) -- this module doesn't need to know about
    that; it decodes the wire format unchanged, same as it did for the
    single-channel case. Demultiplexing by channel happens client-side, in
    the browser.
  adc_set_channels(pin_mask) -> uint8_t confirmed_mask
  adc_set_reference(volts) -> float applied_volts
  dac_set_waveform(channel, waveform_type, freq_hz, amplitude) -> bool
  dac_off(channel) -> bool
  digital_write(pin, value) -> bool
  digital_read(pin) -> int (0 or 1)
"""
from __future__ import annotations

import struct

try:
    from arduino.app_utils import Bridge
except ImportError as exc:  # pragma: no cover - only relevant on non-UNO-Q hosts
    Bridge = None
    _bridge_import_error = exc
else:
    _bridge_import_error = None

# Keeps a frame under the 256-byte Bridge limit: 1 (count) + 4 (t0) + 80*3 = 245
# bytes. Must match MAX_FRAME_SAMPLES in sketch.ino.
MAX_SAMPLES = 80

WAVEFORM_CODES = {"off": 0, "sine": 1, "square": 2, "triangle": 3}


def parse_frame(resp: object) -> tuple[list[int], list[int]]:
    """Decode a binary frame into (samples, timestamps), dropping malformed frames."""
    if not resp:
        return [], []

    buf = bytes(resp)
    if buf[0] == 0x21 and len(buf) > 1:
        buf = buf[1:]

    if len(buf) < 1 + 4:
        return [], []

    count = buf[0]
    if count == 0 or count > MAX_SAMPLES:
        return [], []

    expected = 1 + 4 + count * 3
    if len(buf) != expected:
        return [], []

    offset = 1
    t0 = struct.unpack_from("<I", buf, offset)[0]
    offset += 4

    samples: list[int] = []
    timestamps: list[int] = []
    prev_t = t0
    for _ in range(count):
        sample = struct.unpack_from("<H", buf, offset)[0]
        offset += 2
        dt = buf[offset]
        offset += 1
        ts = prev_t + dt
        samples.append(sample)
        timestamps.append(ts)
        prev_t = ts
    return samples, timestamps


def channels_to_mask(channel_indices: list[int]) -> int:
    """Pack a list of pin indices (0..5 for A0..A5) into the bitmask adc_set_channels expects."""
    mask = 0
    for idx in channel_indices:
        if 0 <= idx <= 5:
            mask |= 1 << idx
    return mask


def mask_to_channels(mask: int) -> list[int]:
    """Inverse of channels_to_mask, for reporting the confirmed active list back to the browser."""
    return [i for i in range(6) if mask & (1 << i)]


class ArduinoQRpcClient:
    """Lightweight RPC client that mirrors the SerialPort API used by the viewer."""

    def __init__(self) -> None:
        if Bridge is None:
            raise ImportError(
                "arduino.app_utils.Bridge is not available; run on the UNO Q Linux side."
            ) from _bridge_import_error

    def request_frame(self) -> tuple[list[int], list[int]]:
        """Call the MCU RPC endpoint and parse the returned frame."""
        resp = Bridge.call("adc_get_frame")
        if resp is None:
            return [], []
        return parse_frame(resp)

    def set_channels(self, channel_indices: list[int]) -> list[int]:
        """Configure active ADC channels. Returns the confirmed active list."""
        mask = channels_to_mask(channel_indices)
        confirmed_mask = Bridge.call("adc_set_channels", mask)
        return mask_to_channels(int(confirmed_mask))

    def set_reference(self, volts: float) -> float:
        """Configure the (global, all-channels) ADC reference voltage."""
        return float(Bridge.call("adc_set_reference", float(volts)))

    def set_dac_waveform(self, channel: int, waveform: str, freq_hz: float, amplitude: float) -> bool:
        """Configure a fixed-waveform DAC output. waveform: off/sine/square/triangle."""
        code = WAVEFORM_CODES.get(waveform)
        if code is None:
            raise ValueError(f"unknown waveform {waveform!r}, expected one of {list(WAVEFORM_CODES)}")
        return bool(Bridge.call("dac_set_waveform", int(channel), code, float(freq_hz), float(amplitude)))

    def dac_off(self, channel: int) -> bool:
        return bool(Bridge.call("dac_off", int(channel)))

    def digital_write(self, pin: int, value: bool) -> bool:
        return bool(Bridge.call("digital_write", int(pin), int(bool(value))))

    def digital_read(self, pin: int) -> bool:
        return bool(Bridge.call("digital_read", int(pin)))

    def close(self) -> None:
        """Provided for API symmetry with SerialPort; nothing to close here."""
        return


def open_rpc() -> ArduinoQRpcClient:
    """Factory mirroring open_serial() from the legacy transport."""
    return ArduinoQRpcClient()
