"use strict";

/**
 * Everything filter-related: the generic stage/chain abstraction, biquad
 * filters (highpass/lowpass/notch) with runtime-computed coefficients
 * (Audio EQ Cookbook / RBJ formulas -- not a lookup table), and the ported
 * adaptive R-peak/BPM detector. See the concept doc §6 for the full
 * design rationale.
 *
 * Classic (non-module) script: shares the top-level scope with the other
 * files in this p5.js project.
 */

class FilterStage {
  constructor(name, processFn) {
    this.name = name;
    this.enabled = true;
    this.process = processFn; // (samples, timestamps) => filteredSamples
  }
}

class FilterChain {
  constructor() {
    this.stages = [];
  }

  add(stage) {
    this.stages.push(stage);
    return this; // allows chaining: new FilterChain().add(a).add(b)...
  }

  run(samples, timestamps) {
    let s = samples;
    for (const stage of this.stages) {
      if (stage.enabled) s = stage.process(s, timestamps);
    }
    return s;
  }
}

/**
 * Wires a FilterChain to a channel's incoming data: runs the chain over
 * every incoming batch and pushes the result into the channel's buffer.
 * This is the one thing every channel's onData callback needs to do, with
 * nothing channel-specific left in it (which chain, which channel, is
 * already visible at the call site) -- so it's a plain helper, not a
 * hidden pipeline: `attachFilter(adc[2], chain2)` in setup() is the whole
 * story, no magic beyond what's written here.
 *
 * chain is optional -- attachFilter(adc[4]) wires a channel straight
 * through with no filtering at all (equivalent to, but less to write
 * than, attachFilter(adc[4], new FilterChain())).
 *
 * Relies on a top-level `let paused` existing in the sketch (see
 * sketch.js) -- also gates data intake, not just drawing, so the buffer's
 * content stays consistent with what's shown while paused.
 */
function attachFilter(channel, chain = null) {
  channel.onData((samples, timestamps) => {
    if (paused) return;
    const filtered = chain ? chain.run(samples, timestamps) : samples;
    filtered.forEach((v, i) => channel.buffer.push({ t: timestamps[i], v }));
  });
}

// ---------------------------------------------------------------------
// Biquad filters: one shared difference-equation implementation (Direct
// Form I -- chosen over Direct Form II Transposed because it maps
// directly onto the taught formula, more transparent for a teaching
// project), three separate coefficient calculators.
// ---------------------------------------------------------------------

function makeBiquadStage(name, coeffs) {
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  return new FilterStage(name, (samples) =>
    samples.map((x) => {
      const y = coeffs.b0 * x + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      return y;
    })
  );
}

function lowpassCoeffs(f0, fs, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw0) / 2 / a0,
    b1: (1 - cosw0) / a0,
    b2: (1 - cosw0) / 2 / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpassCoeffs(f0, fs, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw0) / 2 / a0,
    b1: -(1 + cosw0) / a0,
    b2: (1 + cosw0) / 2 / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

function notchCoeffs(f0, fs, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cosw0) / a0,
    b2: 1 / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

// Q defaults: 0.707 (Butterworth) for HP/LP, 10 (narrowband) for the
// notch -- all exposed as parameters so they can be experimented with by
// editing the sketch and re-running it (no live reconfiguration).
function makeHighpass(f0, fs, Q = 0.707) {
  return makeBiquadStage("highpass", highpassCoeffs(f0, fs, Q));
}

function makeLowpass(f0, fs, Q = 0.707) {
  return makeBiquadStage("lowpass", lowpassCoeffs(f0, fs, Q));
}

function makeNotch(f0, fs, Q = 10) {
  return makeBiquadStage("notch", notchCoeffs(f0, fs, Q));
}

// ---------------------------------------------------------------------
// Adaptive filter: ported from the original single-channel R-peak/BPM
// detector. Deliberately NOT a biquad -- its own algorithm and state,
// same FilterStage interface so the chain treats it identically.
//
// Tracks a rolling window (up to 2s) of raw values via two monotonic
// deques for O(1) local max/min; sets a dynamic threshold halfway between
// the local mean and whichever extremum is further away (this also
// determines signal polarity); flags an R-peak candidate when a sample
// crosses that threshold and at least 250ms (physiological refractory
// period) have passed since the last one; on a peak, computes BPM from
// the R-R interval and briefly (0.05s) passes samples through unfiltered
// so the QRS spike isn't smeared by the baseline-smoothing moving average
// (0.2s window) that is output the rest of the time.
//
// State is per-call-instance (not a shared global), so each channel that
// includes makeAdaptive() in its chain gets an independent instance.
// bpm/threshold/polarity are readable as properties on the returned stage
// (e.g. `adaptive2.bpm`), since multiple channels could each run their
// own instance at once.
// ---------------------------------------------------------------------

function makeAdaptive(fs) {
  const WINDOW_SIZE = Math.round(0.2 * fs);
  const INHIBIT_TIME = Math.round(0.05 * fs);
  const MAX_WINDOW_SIZE = Math.round(2 * fs);
  const REFRACTORY_MS = 250;

  let buffer = new Array(WINDOW_SIZE).fill(0);
  let bufferIndex = 0,
    sumVal = 0;
  let filterDisabled = false,
    inhibitCounter = 0;
  let window = [],
    windowMax = [],
    windowMin = [],
    windowSum = 0;
  let peakPolarity = 1,
    lastRPeakTime = 0,
    prevRPeakTime = 0;

  function updateWindow(sample) {
    if (window.length === MAX_WINDOW_SIZE) {
      const old = window.shift();
      windowSum -= old;
      if (windowMax.length && old === windowMax[0]) windowMax.shift();
      if (windowMin.length && old === windowMin[0]) windowMin.shift();
    }
    window.push(sample);
    windowSum += sample;
    while (windowMax.length && windowMax[windowMax.length - 1] < sample) windowMax.pop();
    windowMax.push(sample);
    while (windowMin.length && windowMin[windowMin.length - 1] > sample) windowMin.pop();
    windowMin.push(sample);
  }

  function step(sample, t) {
    updateWindow(sample);
    const localMax = windowMax[0],
      localMin = windowMin[0];
    const localMean = windowSum / window.length;
    const distMax = localMax - localMean,
      distMin = localMean - localMin;

    let isCandidate;
    if (distMax >= distMin) {
      peakPolarity = 1;
      stage.threshold = localMean + 0.5 * distMax;
      isCandidate = sample > stage.threshold;
    } else {
      peakPolarity = -1;
      stage.threshold = localMean - 0.5 * distMin;
      isCandidate = sample < stage.threshold;
    }

    if (isCandidate && t - lastRPeakTime > REFRACTORY_MS) {
      prevRPeakTime = lastRPeakTime;
      lastRPeakTime = t;
      if (prevRPeakTime > 0) {
        const rr = lastRPeakTime - prevRPeakTime;
        if (rr > 0) {
          stage.bpm = Math.round(60000 / rr);
          stage.polarity = peakPolarity;
        }
      }
      filterDisabled = true;
      inhibitCounter = INHIBIT_TIME;
    }

    if (filterDisabled && inhibitCounter > 0) {
      inhibitCounter -= 1;
    } else {
      filterDisabled = false;
    }

    if (filterDisabled) return sample;

    sumVal = sumVal - buffer[bufferIndex] + sample;
    buffer[bufferIndex] = sample;
    const out = sumVal / WINDOW_SIZE;
    bufferIndex = (bufferIndex + 1) % WINDOW_SIZE;
    return out;
  }

  const stage = new FilterStage("adaptive", (samples, timestamps) =>
    samples.map((sample, i) => step(sample, timestamps[i]))
  );
  stage.bpm = 0;
  stage.threshold = null;
  stage.polarity = 1;
  return stage;
}
