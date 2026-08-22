"""
Minimal circular buffer for raw multi-channel ADC samples/timestamps.

Filtering, per-channel demultiplexing (via the tagged sample encoding, see
the project's concept doc §2), and any adaptive/BPM-style processing happen
entirely in the browser (see python/webui/) so they can be tuned without
touching this Python side. This buffer's only remaining job is handing a
newly connecting browser client a window of recent history (see `adc_frame`
in main.py) -- everything else is a straight pass-through of raw RPC frames.
This module doesn't need to know about channels or tags at all; it just
stores whatever raw ints request_frame() returns.
"""
from __future__ import annotations


class RawRingBuffer:
    def __init__(self, length: int = 4000) -> None:
        self.length = length
        self.samples = [0.0] * self.length
        self.timestamps = [0.0] * self.length
        self.write_idx = 0
        self.filled = 0

    def add_samples(self, samples: list[int], timestamps: list[int]) -> None:
        for s_val, t_val in zip(samples, timestamps):
            self.samples[self.write_idx] = float(s_val)
            self.timestamps[self.write_idx] = float(t_val)
            self.write_idx = (self.write_idx + 1) % self.length
            if self.filled < self.length:
                self.filled += 1

    def last(self, n: int) -> tuple[list[float], list[float]]:
        """Return last n samples/timestamps as Python lists."""
        if n <= 0 or self.filled == 0:
            return [], []
        n = min(n, self.filled)
        start = (self.write_idx - n) % self.length
        end = self.write_idx
        if start < end:
            samples = self.samples[start:end]
            timestamps = self.timestamps[start:end]
        else:
            samples = self.samples[start:] + self.samples[:end]
            timestamps = self.timestamps[start:] + self.timestamps[:end]
        return samples.copy(), timestamps.copy()
