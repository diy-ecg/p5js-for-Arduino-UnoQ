"use strict";

/**
 * Per-channel ADC objects with a minimal publish/subscribe interface, plus
 * the one-time RPC calls that configure the MCU (via the Python relay).
 *
 * Each active channel gets its own AdcChannel instance so that filter
 * state (registered via onData) lives in a separate closure per channel --
 * there is no code path by which two channels' state could mix.
 *
 * Classic (non-module) script: shares the top-level scope with the other
 * files. `socket` comes from transport.js -- connectBackend() must run
 * before setupADC()/setupDAC() are called. `RingBuffer` comes from
 * ring_buffer.js.
 */

// pin index (0..5 for A0..A5) -> AdcChannel, e.g. adc[2] for A2 -- this is
// what setupADC() returns and what sketch.js normally uses.
let activeAdcChannels = {};

// tag index (0..3, position among the currently active channels) ->
// AdcChannel -- this is what transport.js uses internally to demultiplex
// incoming frames. Tag index order matches sketch.ino's assignment:
// ascending pin order among the active channels (see concept doc §2/§3).
let activeAdcChannelOrder = [];

class AdcChannel {
  constructor(id, bufferSize) {
    this.id = id;
    this.buffer = new RingBuffer(bufferSize);
    this.listeners = [];
  }

  onData(fn) {
    this.listeners.push(fn);
  }

  // Called internally by transport.js when a frame is demultiplexed --
  // never call this directly from a sketch.
  _dispatch(samples, timestamps) {
    this.listeners.forEach((fn) => fn(samples, timestamps));
  }
}

/**
 * One-time ADC configuration, normally called once from setup().
 * options.channels: pin indices 0..5 for A0..A5, up to 4 of them.
 * options.bufferSize: ring buffer size per channel, in samples.
 * Returns a promise resolving to { pinIndex: AdcChannel, ... }.
 */
function setupADC({ channels, bufferSize }) {
  return new Promise((resolve, reject) => {
    socket.emit("configure_adc", { channels });
    socket.once("configure_adc_response", (result) => {
      if (!result || result.error) {
        reject(new Error((result && result.error) || "configure_adc failed"));
        return;
      }
      activeAdcChannels = {};
      activeAdcChannelOrder = [];
      result.channels.forEach((pinIndex) => {
        const channel = new AdcChannel(pinIndex, bufferSize);
        activeAdcChannels[pinIndex] = channel;
        activeAdcChannelOrder.push(channel);
      });
      resolve(activeAdcChannels);
    });
  });
}

/**
 * One-time DAC configuration for one channel (0 = A0, 1 = A1). Amplitude/
 * frequency are set once, not streamed -- see concept doc §5.
 * options.type: "sine" | "square" | "triangle" | "off".
 * options.freqHz, options.amplitude (0..1, raw-code fraction of full scale).
 */
function setupDAC(channel, { type, freqHz, amplitude }) {
  return new Promise((resolve, reject) => {
    socket.emit("configure_dac", { channel, type, freqHz, amplitude });
    socket.once("configure_dac_response", (result) => {
      if (!result || result.error) {
        reject(new Error((result && result.error) || "configure_dac failed"));
        return;
      }
      resolve(result);
    });
  });
}

function dacOff(channel) {
  return new Promise((resolve, reject) => {
    socket.emit("dac_off", { channel });
    socket.once("dac_off_response", (result) => {
      if (!result || result.error) {
        reject(new Error((result && result.error) || "dac_off failed"));
        return;
      }
      resolve(result);
    });
  });
}
