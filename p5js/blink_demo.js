"use strict";

/**
 * Alternative starter sketch: classic Blink, entirely over digital I/O
 * (no ADC channels at all). Only needs connectBackend() (transport.js)
 * and digitalWrite() (digital_io.js) -- the ADC/DAC framework files
 * (adc_channel.js, ring_buffer.js, filters.js) aren't used here.
 *
 * A p5.js Web Editor project only runs one file named sketch.js (wired up
 * via <script src="sketch.js"> in index.html). To run this demo instead
 * of the oscilloscope in sketch.js, replace sketch.js's contents with
 * this file's, or rename this file to sketch.js locally before
 * uploading a fresh project.
 *
 * Wiring: an LED with a series resistor between pin 2 and GND -- see the
 * README for the resistor math (UNO Q's digital pins run at 3.3V, not 5V).
 */

let lastToggle = 0;
let ledOn = false;

function setup() {
  createCanvas(200, 200);
  connectBackend();
}

function draw() {
  if (millis() - lastToggle > 500) {
    ledOn = !ledOn;
    digitalWrite(2, ledOn);
    lastToggle = millis();
  }
}
