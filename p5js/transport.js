"use strict";

/**
 * Socket.IO transport: connects to the Python relay, decodes incoming ADC
 * frames (self-tagged samples, see the project's concept doc §2),
 * reconstructs a consistent relative time axis, demultiplexes by channel,
 * and dispatches into the matching AdcChannel's listeners.
 *
 * Classic (non-module) script: shares the top-level scope with the other
 * files. `activeAdcChannelOrder` comes from adc_channel.js.
 *
 * Connects to an EXPLICIT URL, not the bare io() same-origin default,
 * because a sketch running in the p5.js Web Editor executes on a
 * different origin (https://preview.p5js.org) than the local Socket.IO
 * backend. See the concept doc's "p5.js Web Editor as the live-coding
 * target" section for exactly why this specific cross-origin connection
 * works in this deployment (Firefox, single-board mode, same machine) and
 * what would need re-checking if that topology ever changes.
 *
 * IMPORTANT: use the literal loopback IP `127.0.0.1`, not the hostname
 * `localhost`. Firefox's mixed-content/local-network exemption for a
 * cross-origin request from an HTTPS page is reliably granted for
 * `127.0.0.1` -- the named host `localhost` is not guaranteed the same
 * treatment (confirmed the hard way: `127.0.0.1` works, `localhost`
 * silently fails with "CORS request did not succeed / status (null)",
 * which is Firefox's misleading label for a request blocked before it
 * ever reached the server -- verify with a direct, same-origin GET to
 * http://127.0.0.1:7000/socket.io/?EIO=4&transport=polling if this ever
 * needs re-diagnosing).
 *
 * Requires the Socket.IO client library to be loaded (e.g. via a
 * <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"> tag added
 * to this p5.js Web Editor project's index.html) -- it is NOT bundled by
 * default in a new p5.js Web Editor project.
 */

const ADC_BACKEND_URL = "http://127.0.0.1:7000";

let socket;
let baseT0 = null; // session-wide time anchor, used to build a consistent relative time axis
let lastMeta = null; // latest {status, last_count, sampling_rate_hz}, if a sketch wants to show it

function connectAdcBackend() {
  // Force WebSocket only, skipping Engine.IO's usual polling handshake.
  // The polling transport is a plain XHR request, which hit a browser
  // cross-origin block that a raw WebSocket connection may not (see the
  // concept doc's "p5.js Web Editor as the live-coding target" section
  // for the diagnosis history) -- if this still fails, the problem is
  // broader than the polling transport specifically.
  socket = io(ADC_BACKEND_URL, { transports: ["websocket"] });

  socket.on("connect", () => console.log("[transport] connected to", ADC_BACKEND_URL));
  socket.on("disconnect", () => {
    console.log("[transport] disconnected");
    baseT0 = null;
  });

  socket.on("adc_meta", (meta) => {
    lastMeta = meta;
  });
  socket.on("adc_frame", handleFullFrame);
  socket.on("adc_delta", handleDelta);
}

// Decodes one self-tagged sample: channel's tag index in the top 2 bits,
// raw ADC value (0..16383) in the lower 14 bits.
function decodeTagged(taggedValue) {
  return {
    channelIndex: (taggedValue >> 14) & 0x3,
    rawValue: taggedValue & 0x3fff,
  };
}

// Groups a frame's interleaved samples by channel (they can arrive in any
// order, see concept doc §2) and dispatches each channel's sub-sequence,
// still in chronological order, to its AdcChannel.
function demuxAndDispatch(values, timestamps) {
  const grouped = {}; // tagIndex -> { samples: [], timestamps: [] }
  for (let i = 0; i < values.length; i++) {
    const { channelIndex, rawValue } = decodeTagged(values[i]);
    if (!grouped[channelIndex]) grouped[channelIndex] = { samples: [], timestamps: [] };
    grouped[channelIndex].samples.push(rawValue);
    grouped[channelIndex].timestamps.push(timestamps[i]);
  }
  Object.keys(grouped).forEach((key) => {
    const channel = activeAdcChannelOrder[Number(key)];
    if (channel) channel._dispatch(grouped[key].samples, grouped[key].timestamps);
  });
}

// Full raw buffer snapshot (all active channels, still interleaved and
// tagged); sent once when a browser connects, to seed each channel's
// history. payload.signal.t is already relative to payload.signal.t0
// (computed server-side), so it doubles as this session's time anchor.
function handleFullFrame(payload) {
  if (!payload || !payload.signal) return;
  const sig = payload.signal;
  if (baseT0 === null) baseT0 = sig.t0;
  demuxAndDispatch(sig.y, sig.t);
}

// Incremental update: payload = { t0, y[], dt[] }. t0 is this specific
// batch's own first-sample timestamp (ms); dt[i] is the delta from the
// previous sample (dt[0] is always 0). Reconstructing absolute
// timestamps and converting to a session-relative axis (via baseT0) must
// happen here, once, so every AdcChannel and filter downstream sees a
// consistent clock regardless of which batch a sample arrived in.
function handleDelta(payload) {
  if (!payload || !payload.y || !payload.dt) return;
  if (baseT0 === null) baseT0 = payload.t0;

  let absoluteT = payload.t0;
  const timestamps = new Array(payload.y.length);
  for (let i = 0; i < payload.y.length; i++) {
    if (i > 0) absoluteT += payload.dt[i];
    timestamps[i] = absoluteT - baseT0;
  }
  demuxAndDispatch(payload.y, timestamps);
}
