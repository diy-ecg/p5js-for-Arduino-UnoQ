# p5.js for Arduino Uno Q

A pattern for building UNO Q apps: a small, stable Arduino App as the
backend, and a p5.js sketch you live-code in the browser as the frontend —
so you don't have to recompile and restart the whole app every time you
want to change what your code actually does. Two working examples are
included: a Blink demo (digital I/O) and a 4-channel oscilloscope
(ADC/DAC).

## The problem this solves

If you've used a classic Arduino Uno, you know the workflow: write some
code, hit upload, watch the serial monitor, tweak a threshold, upload
again. Not instant, but fast enough that you don't lose your train of
thought.

On the UNO Q, that loop gets a lot heavier. An "Arduino App" here isn't
just a sketch — it's a sketch *plus* a Linux-side backend (Python, in this
case), wired together and started through Arduino App Lab. Change one line
on either side and you're back to going through App Lab's full
build-and-start pipeline. That's fine for the parts of your code that
genuinely don't change often — pin wiring, sampling rate, the RPC surface —
but it's a real drag when what you actually want to iterate on is "does
this filter setting look better" or "let me try plotting this
differently."

## The idea

Split the project along exactly that line. Everything that has to live
close to the hardware — reading or writing a pin, moving bytes across
Bridge/RPC — becomes a small, stable **Arduino App** that you flash and
start once and then mostly leave alone. That's the **backend**.

Everything you'd actually want to fiddle with while experimenting — which
pins to use, what to do with their data, how to visualize it, what to
compute from it — moves into a **p5.js sketch** running in an ordinary
browser tab, talking to the backend over Socket.IO. Change the sketch, hit
the p5.js editor's play button, see the result immediately. No App Lab, no
recompiling the MCU sketch, no restarting the backend. That's the
**frontend**.

The backend doesn't know or care what happens to the data once it leaves
the board — it just relays raw values back and forth. All the actual
behavior — what a blink pattern looks like, channel selection, filtering,
plotting — lives entirely on the p5.js side, in code you're expected to
read and rewrite, not a black box you configure.

## A small circle closes here

p5.js is the JavaScript descendant of **Processing** — and Processing was
one of the direct inspirations for the original Arduino IDE (by way of
Wiring, the framework Arduino's C/C++ dialect grew out of). So doing the
live-coding, fast-iteration half of this project in p5.js instead of in the
Arduino IDE itself isn't just a convenient choice of frontend technology —
it's going back to roughly where a lot of this started.

## Example 1: Blink over digital I/O

The simplest possible version of the pattern: `digitalWrite`/
`digitalRead` as one-shot RPC calls (`p5js/digital_io.js`). `pin` is a
normal Arduino digital pin number, D0–D21. `digitalRead()` enables the
pin's internal pull-up, so a button wired pin-to-GND needs no external
resistor — same as on a classic Arduino.

Enough for the classic Blink, no recompiling needed to change the blink
rate. Wire an LED with a series resistor between the pin and GND — the
UNO Q's digital pins run at **3.3 V**, not 5 V, so the usual
`R = (3.3V − Vf_LED) / I_target` gives smaller values than you may be used
to from a classic Uno; ~220 Ω is a safe default for a standard
red/yellow/green LED (~6 mA):

```js
let lastToggle = 0;
let ledOn = false;

function setup() {
  createCanvas(200, 200);
  connectBackend();
}

function draw() {
  if (millis() - lastToggle > 500) {
    ledOn = !ledOn;
    digitalWrite(2, ledOn);   // matches wherever you wired the LED
    lastToggle = millis();
  }
}
```

`digitalWrite()`/`digitalRead()` both return promises, so `await` them if
you need to know the call actually completed — the snippet above fires
and forgets, which is fine for a blink. This exact code is also a real
file in this repo, `p5js/blink_demo.js`.

A quick naming note, since it comes up for both examples: in the p5.js
Web Editor, the file holding `setup()`/`draw()` is conventionally just
called `sketch.js` — a project only ever runs one. This repo keeps Example
1's and Example 2's content in two separate files (`blink_demo.js` and
`sketch.js`, respectively) so neither overwrites the other on disk, but
only one of them is ever actually your project's `sketch.js` at a time. To
run this example, copy `blink_demo.js`'s content into your project's
`sketch.js` (or start a separate project with just this file,
`digital_io.js`, and `transport.js`).

## Example 2: DAC/ADC

Out of the box: a 4-channel scope. Pick any subset of A0–A5 (up to four at
once) as ADC inputs, optionally drive a fixed sine/square/triangle wave out
of A0/A1 through the two onboard DAC channels, and — independently, per ADC
channel:

- run it through its own filter chain (highpass / lowpass / notch, or
  nothing at all),
- toggle individual filter stages on and off live, from checkboxes in the
  browser,
- plot it, and pause the whole sketch to freeze the view.

None of that is fixed. `p5js/sketch.js` is a starting point meant to be
read and edited, not a finished product handed to you.

Sampling itself, on the other hand, currently *is* fixed: **200 Hz per
active channel** (4 channels active means 800 raw ADC reads/sec in total,
not 200 total split across them) and a **fixed 14-bit ADC resolution**
(raw values 0–16383). Both are compile-time constants in `sketch.ino`, not
something you can change from `sketch.js` at runtime — changing either
means re-flashing the backend.

Two calls in `setup()` configure the hardware once and never need to run
again. `setupADC({ channels, bufferSize })` tells the backend which ADC
pins to sample and returns `adc`, a map from pin index to an `AdcChannel`
object, each holding its own fixed-size ring buffer. `setupDAC(channel,
{ type, freqHz, amplitude })` is the same idea for one DAC channel — a
one-shot RPC call, not something you touch again afterward.

Neither call by itself gets samples into a buffer, though. That's
`attachFilter(adc[channel], chain)` (from `filters.js`, also called once
in `setup()`): it subscribes to that channel's incoming data, runs it
through the given filter chain — or passes it through unchanged if no
chain is given, as channel 2 does below — and pushes the result into
`adc[channel].buffer`. `draw()` never touches the network or the filters
directly; every frame, it just reads whatever's currently in
`adc[channel].buffer.toArray()` and plots it — the buffer is kept up to
date in the background by `attachFilter()`'s subscription, independent of
how often `draw()` itself runs.

One easy-to-miss detail: `attachFilter()` also checks a top-level `paused`
variable on every incoming batch (so pausing also stops new data from
being written into the buffer, not just `draw()`) — that variable has to
exist in your sketch even if you never call `togglePause()`.

Below is the exact, current content of this repo's `p5js/sketch.js` —
this example's file, per the naming note above: A0 outputs a 3 Hz square
wave, split with a branched cable into both A2 and A3, so channel 2 shows
it raw and channel 3 shows the exact same signal through a lowpass you can
toggle on and off live.

```js
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
  plotChannel(adc[2].buffer.toArray(), 0, 2);
  plotChannel(adc[3].buffer.toArray(), 1, 2);

  noStroke();
  fill(0);
  text(`${frameRate().toFixed(1)} fps`, 10, 14);
}

function togglePause() {
  paused = !paused;
  paused ? noLoop() : loop();
}

/* ==================== Visualization -- replace freely ==================== */

// One band per channel, auto-scaled to the currently visible min/max.
// A fixed gap between bands keeps neighboring channels from touching.
const BAND_GAP = 10;

function plotChannel(points, index, total) {
  if (points.length < 2) return;
  const bandHeight = height / total;
  const yTop = index * bandHeight;
  const yBottom = yTop + bandHeight - BAND_GAP;

  const tMin = points[0].t,
    tMax = points[points.length - 1].t;
  let vMin = Infinity,
    vMax = -Infinity;
  points.forEach((p) => {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  });
  if (vMin === vMax) {
    vMin -= 1;
    vMax += 1;
  }

  noFill();
  stroke(0);
  beginShape();
  points.forEach((p) => {
    const x = map(p.t, tMin, tMax, 0, width);
    const y = map(p.v, vMin, vMax, yBottom, yTop);
    vertex(x, y);
  });
  endShape();
}
```

## Summary

Two examples, one small, consistent API on the frontend so far:

- `connectBackend()` — connects to the backend over Socket.IO; call once
  in `setup()`, before anything else.
- `digitalWrite(pin, value)` / `digitalRead(pin)` — plain digital I/O,
  one-shot RPC calls.
- `setupADC({ channels, bufferSize })` — selects the active ADC channels
  and returns `adc`, a map of `AdcChannel` objects.
- `setupDAC(channel, { type, freqHz, amplitude })` / `dacOff(channel)` —
  configure or turn off a fixed DAC waveform.
- `attachFilter(channel, chain)` — subscribes a channel to its incoming
  data, optionally running it through a `FilterChain` first, and writes
  the result into `channel.buffer`.
- `FilterChain`, plus `makeHighpass()` / `makeLowpass()` / `makeNotch()` /
  `makeAdaptive()` — the building blocks for the `chain` argument above.
- `adc[channel].buffer.toArray()` / `.last()` — read whatever a channel
  currently has buffered, for `draw()` to plot or do anything else with.

That's the whole surface right now, and it's deliberately small — this
repo is a proof of concept for the pattern, not a finished product.
Nothing about the split ties it to ADC/DAC or digital I/O specifically:
both examples follow the same recipe — a one-shot (or streaming) RPC
handler in `sketch.ino`, a matching Socket.IO message in the Python
relay, and a small wrapper function on the p5.js side — and any other
Arduino capability could be added the same way. I2C sensors, PWM, servos,
whatever else the UNO Q can do — if there's interest, this can keep
growing.

## Getting it running

**Backend — on the UNO Q itself:**

1. Download this repository as a ZIP from GitHub and unzip it on the UNO
   Q's Linux desktop.
2. Copy the unzipped folder into your Arduino App Lab apps directory — the
   same place your other Arduino Apps live. It should now show up as an
   app inside App Lab.
3. Start it from App Lab. This compiles and flashes `sketch/sketch.ino` and
   starts the Python relay, which listens on `http://127.0.0.1:7000`.

You only need to repeat this whole step when you actually change something
on the backend side (pin wiring, the RPC surface, the sampling rate).
Everything downstream of that doesn't need it.

**Frontend — in the browser, same machine:**

1. Open the preinstalled Chromium browser on the UNO Q and go to the
   shared project (the oscilloscope, Example 2 above):
   https://editor.p5js.org/diy-ecg/full/SzSsXanI7
2. Fork it into your own p5.js account (top-right in the editor), so you
   get your own editable copy with all the framework files already in
   place. For the Blink example instead, replace the forked project's
   `sketch.js` with `p5js/blink_demo.js`'s contents — same fork, same
   backend, no separate setup.
3. Hit run. The first time a sketch tries to reach the backend, Chromium
   shows a one-time button asking you to explicitly allow access to the
   local network — click it. From then on the sketch connects to
   `127.0.0.1:7000` automatically, and you should start seeing live data.

This setup assumes the browser and the backend run on the same machine —
tested on the UNO Q's own Linux desktop with the preinstalled Chromium.
The p5.js sketch's preview runs on a different origin than your local
backend and reaches it over a loopback address; the permission button
above is exactly Chromium's check for that. Click "allow" once per sketch
and it's done.

From here on, all further iteration happens in the p5.js editor — edit,
hit run, done. No App Lab involved. `p5js/README.md` has the exact steps
for getting these files into your own p5.js Web Editor project, in case
you're not starting from the shared link above.

## Repository layout

```
app.yaml, requirements.txt      backend  – Arduino App metadata
sketch/sketch.ino, sketch.yaml  backend  – MCU sketch: ADC sampling, DAC
                                            output, Bridge/RPC
python/                         backend  – Linux-side relay: pulls frames
                                            off Bridge/RPC, forwards them to
                                            the browser over Socket.IO,
                                            unmodified
p5js/                           frontend – the p5.js sketch and its
                                            supporting files
```

The backend only ever moves bytes around; it has no idea what a "channel,"
a "filter," or a "plot" is. All of that lives in `p5js/`.

## License

Two different licenses, split along the same backend/frontend line:

- **Backend** (`app.yaml`, `requirements.txt`, `sketch/`, `python/`) —
  [GPLv3](LICENSE). Same as the Linux kernel: commercial use is explicitly
  fine, but anyone who distributes this code or a modified version of it
  has to pass the source along under the same terms. GPLv3 specifically
  (not v2) because the sketch links against Zephyr (Apache License 2.0),
  and the FSF considers Apache 2.0 compatible with GPLv3 but not GPLv2.
- **Frontend** (`p5js/`) — [MIT](p5js/LICENSE). Fork it, modify it, use it
  commercially, no obligations beyond keeping the license notice.

p5.js itself is LGPL-2.1 — since this project only loads it from a CDN
rather than bundling or modifying it, that places no restriction on
either license above.
