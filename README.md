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
R-peak/BPM detection, plotting, CSV export — lives entirely on the p5.js
side, in code you're expected to read and rewrite, not a black box you
configure.

## A small circle closes here

p5.js is the JavaScript descendant of **Processing** — and Processing was
one of the direct inspirations for the original Arduino IDE (by way of
Wiring, the framework Arduino's C/C++ dialect grew out of). So doing the
live-coding, fast-iteration half of this project in p5.js instead of in the
Arduino IDE itself isn't just a convenient choice of frontend technology —
it's going back to roughly where a lot of this started.

## Example 1: Blink over digital I/O

The simplest possible version of the pattern: `digitalWrite`/
`digitalRead` as one-shot RPC calls (`p5js/digital_io.js`), no streaming,
no buffering. `pin` is a normal Arduino digital pin number D0–D21, not one
of the A0–A5 indices the oscilloscope example below uses. `digitalRead()`
enables the pin's internal pull-up, so a button wired pin-to-GND needs no
external resistor — same as on a classic Arduino.

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
file, `p5js/blink_demo.js` — since a p5.js Web Editor project only runs
one `sketch.js`, swap this in for whichever sketch.js content is
currently active (or start a separate project with just this file,
`digital_io.js`, and `transport.js`) to run it.

## Example 2: a 4-channel oscilloscope

Out of the box: a 4-channel scope. Pick any subset of A0–A5 (up to four at
once) as ADC inputs, optionally drive a fixed sine/square/triangle wave out
of A0/A1 through the two onboard DAC channels, and — independently, per ADC
channel:

- run it through its own filter chain (highpass / lowpass / notch, or the
  adaptive R-peak/BPM detector originally written for a DIY-ECG project —
  or nothing at all),
- toggle individual filter stages on and off live, from checkboxes in the
  browser,
- plot it, or send it to a scrolling text log instead of a plot,
- pause it and export it to CSV.

None of that is fixed. `p5js/sketch.js` is a starting point meant to be
read and edited, not a finished product handed to you.

Sampling itself, on the other hand, currently *is* fixed: **200 Hz per
active channel** (4 channels active means 800 raw ADC reads/sec in total,
not 200 total split across them) and a **fixed 14-bit ADC resolution**
(raw values 0–16383). Both are compile-time constants in `sketch.ino`, not
something you can change from `sketch.js` at runtime — changing either
means re-flashing the backend.

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
hit run, done. No App Lab involved.

## Writing your own oscilloscope experiment: the simplest possible `sketch.js`

The framework files (`adc_channel.js`, `ring_buffer.js`, `filters.js`,
`transport.js`) handle the plumbing — connecting, decoding frames,
demultiplexing by channel. `sketch.js` is the one file you're actually
meant to read and rewrite, and at its smallest it only needs four moves:
connect, pick a channel, hand its data to a buffer, plot the buffer. One
easy-to-miss detail: `filters.js`'s `attachFilter()` checks a top-level
`paused` variable on every incoming batch of samples (so pausing also
stops new data from being written into the buffer, not just `draw()`) —
that variable is expected to already exist in your sketch, even if you
never actually pause anything, so it has to be declared up front.

```js
let adc;
let paused = false;   // attachFilter() below expects this to exist, even if you never pause

async function setup() {
  createCanvas(800, 400);
  connectBackend();
  adc = await setupADC({ channels: [2], bufferSize: 400 });
  attachFilter(adc[2]);   // no filter chain given -- raw values go straight into the buffer
}

function draw() {
  background(255);
  plotChannel(adc[2].buffer.toArray(), 0, 1);
}

// plotChannel isn't part of the framework files either -- it lives here,
// in sketch.js, same as everything else above. One band per channel
// (just one, in this case), auto-scaled to the currently visible min/max.
function plotChannel(points, index, total) {
  if (points.length < 2) return;
  const bandHeight = height / total;
  const yTop = index * bandHeight;

  const tMin = points[0].t, tMax = points[points.length - 1].t;
  let vMin = Infinity, vMax = -Infinity;
  points.forEach((p) => {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  });
  if (vMin === vMax) { vMin -= 1; vMax += 1; }

  noFill();
  stroke(0);
  beginShape();
  points.forEach((p) => {
    const x = map(p.t, tMin, tMax, 0, width);
    const y = map(p.v, vMin, vMax, yTop + bandHeight, yTop);
    vertex(x, y);
  });
  endShape();
}
```

That's a complete, working single-channel scope — genuinely copy-pasteable
as it stands, nothing left implicit. Everything else — more channels,
filter chains, checkboxes to toggle them, CSV export — builds on exactly
this shape. See `p5js/sketch.js` in this repo for a fuller, self-contained
demo: A0 outputs a 3 Hz square wave, split with a branched cable into both
A2 and A3, so channel 2 shows it raw and channel 3 shows the exact same
signal through a lowpass you can toggle on and off live — `plotChannel`
there is the very same function, just called twice.

### Alternative to a plot: a scrolling text log

Modeled on the Arduino IDE's Serial Monitor — useful when a plot isn't
needed, or as a quick "is data actually arriving" check. Not part of the
demo in `p5js/sketch.js` (left out to keep it minimal), but a drop-in for
any channel: call `textChannel(id)` from `draw()` instead of that
channel's `plotChannel(...)` line.

```js
const textChannelLogs = {};

function textChannel(channelId) {
  if (!textChannelLogs[channelId]) {
    textChannelLogs[channelId] = {
      box: createDiv("").style("height", "150px").style("overflow-y", "scroll"),
      lines: [],
      lastT: null,
    };
  }
  const state = textChannelLogs[channelId];

  const latest = adc[channelId].buffer.last();
  if (!latest || latest.t === state.lastT) return; // nothing new since the last draw() call
  state.lastT = latest.t;

  state.lines.push(`t=${latest.t} ms  v=${latest.v.toFixed(1)}`);
  if (state.lines.length > 20) state.lines.shift();
  state.box.html(state.lines.join("<br>"));
  state.box.elt.scrollTop = state.box.elt.scrollHeight;
}
```

The box for a channel is created lazily, on the first call — a channel
that never uses this never gets one. And a line is only appended when
`buffer.last()` has actually advanced (deduped by timestamp) — otherwise
`draw()` running at 60 fps would spam dozens of near-identical lines per
second.

`p5js/README.md` has the exact steps for getting these files into your own
p5.js Web Editor project, in case you're not starting from the shared link
above.
