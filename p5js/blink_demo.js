"use strict";

// Classic Blink over digital I/O only -- see the README for wiring/resistor
// details and how to run this as your p5.js Web Editor project's main file.

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
