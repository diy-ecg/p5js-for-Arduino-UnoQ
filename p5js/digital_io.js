"use strict";

/**
 * Plain digital I/O, independent of the ADC/DAC channels in adc_channel.js.
 * `pin` is a normal Arduino digital pin number (e.g. 13 for the onboard
 * LED), not one of the A0..A5 indices used elsewhere.
 *
 * Same one-shot RPC shape as setupDAC()/dacOff() -- socket comes from
 * transport.js; connectBackend() must run before either of these.
 */

function digitalWrite(pin, value) {
  return new Promise((resolve, reject) => {
    socket.emit("digital_write", { pin, value });
    socket.once("digital_write_response", (result) => {
      if (!result || result.error) {
        reject(new Error((result && result.error) || "digital_write failed"));
        return;
      }
      resolve(result.ok);
    });
  });
}

function digitalRead(pin) {
  return new Promise((resolve, reject) => {
    socket.emit("digital_read", { pin });
    socket.once("digital_read_response", (result) => {
      if (!result || result.error) {
        reject(new Error((result && result.error) || "digital_read failed"));
        return;
      }
      resolve(result.value);
    });
  });
}
