"use strict";

// Demo: A0 outputs a 3 Hz square wave -- split it with a branched cable
// into both A2 and A3 so the ADC channels read the same signal. Channel 2
// shows it raw; channel 3 shows it through a lowpass you can toggle
// on/off live, to see it get smoothed.

const ADC_RATE_HZ = 200; // must match sketch.ino's fixed sampling rate
const BUFFER_SIZE = 800; // samples kept per channel (~4s at 200Hz)
const SQUARE_HZ = 3;
const LOWPASS_HZ = 8; // channel 3's filter cutoff
const TARGET_FPS = 60; // frameRate() target; measured fps shown top-left

let adc;
let chain3;
let paused = false;

async function setup() {
  createCanvas(800, 600);
  frameRate(TARGET_FPS);
  connectBackend();

  adc = await setupADC({ channels: [2, 3], bufferSize: BUFFER_SIZE });
  await setupDAC(0, { type: "square", freqHz: SQUARE_HZ, amplitude: 1.0 });

  // Channel 2: raw, for comparison
  attachFilter(adc[2]);

  // Channel 3: same signal, through a toggleable lowpass
  chain3 = new FilterChain().add(makeLowpass(LOWPASS_HZ, ADC_RATE_HZ));
  attachFilter(adc[3], chain3);

  const cb = createCheckbox(`Channel 3: lowpass @ ${LOWPASS_HZ}Hz`, chain3.stages[0].enabled);
  cb.changed(() => (chain3.stages[0].enabled = cb.checked()));

  createButton("Pause / Resume").mousePressed(togglePause);
}

function draw() {
  background(255);
  // plotGraph() now lives in plotting.js, shared with adc0_scope_demo.js --
  // used to be a local plotChannel() here, same signature.
  plotGraph(adc[2].buffer.toArray(), 0, 2);
  plotGraph(adc[3].buffer.toArray(), 1, 2);

  noStroke();
  fill(0);
  text(`${frameRate().toFixed(1)} fps`, 10, 14);
}

function togglePause() {
  paused = !paused;
  paused ? noLoop() : loop();
}
