"use strict";

// Comparison demo for the ADC forum post: the p5.js-for-Arduino-UnoQ
// equivalent of classic-adc-reference/'s Uno R3 + Processing pair. Same
// shape -- one channel, raw values plotted over time -- so the two are a
// fair side-by-side. Single-channel version of dac-adc-demo.js's pattern,
// with the filter left out since there's nothing to compare it against
// here: DAC1 (A1) generates a 3 Hz square wave as something to sample,
// jumpered into A0 (bring a wire from A1 to A0 -- DAC1 can't also be read
// back as an ADC channel on its own pin).

const ADC_RATE_HZ = 200; // matches sketch.ino's fixed sampling rate --
// the same 200 Hz classic_adc_serial.ino samples at, no configuration
// needed on either side to make that true.
const BUFFER_SIZE = 800; // samples kept (~4s at 200Hz)
const SQUARE_HZ = 3; // DAC1's output frequency

let adc;
let paused = false; // attachFilter() (filters.js) gates on this

async function setup() {
  createCanvas(800, 400);
  connectBackend();

  adc = await setupADC({ channels: [0], bufferSize: BUFFER_SIZE });
  await setupDAC(1, { type: "square", freqHz: SQUARE_HZ, amplitude: 1.0 });
  attachFilter(adc[0]); // no chain -- raw samples straight into the buffer
}

function draw() {
  background(255);
  plotGraph(adc[0].buffer.toArray());
}
