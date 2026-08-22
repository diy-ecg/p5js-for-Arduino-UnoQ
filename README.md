# Uno Q Scope for p5.js

A four-channel oscilloscope for the Arduino UNO Q, split into a stable
backend and an interactive frontend, so you don't have to recompile an
Arduino App every time you want to change how your data gets filtered or
plotted.

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
close to the hardware — reading the ADC pins, generating the DAC waveform,
moving bytes across Bridge/RPC — becomes a small, stable **Arduino App**
that you flash and start once and then mostly leave alone. That's the
**backend**.

Everything you'd actually want to fiddle with while experimenting — which
channels to look at, what filters to run on them, how to draw them, what to
compute from them — moves into a **p5.js sketch** running in an ordinary
browser tab, talking to the backend over Socket.IO. Change the sketch, hit
the p5.js editor's play button, see the result immediately. No App Lab, no
recompiling the MCU sketch, no restarting the backend. That's the
**frontend**.

The backend doesn't know or care what happens to the data once it leaves
the board — it just relays raw, tagged ADC samples. All the actual
"oscilloscope" behavior — channel selection, filtering, R-peak/BPM
detection, plotting, CSV export — lives entirely on the p5.js side, in code
you're expected to read and rewrite, not a black box you configure.

## A small circle closes here

p5.js is the JavaScript descendant of **Processing** — and Processing was
one of the direct inspirations for the original Arduino IDE (by way of
Wiring, the framework Arduino's C/C++ dialect grew out of). So doing the
live-coding, fast-iteration half of this project in p5.js instead of in the
Arduino IDE itself isn't just a convenient choice of frontend technology —
it's going back to roughly where a lot of this started.

## What you actually get

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
   shared project: https://editor.p5js.org/diy-ecg/full/SzSsXanI7
2. Fork it into your own p5.js account (top-right in the editor), so you
   get your own editable copy with all the framework files already in
   place.
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

## Writing your own experiment: the simplest possible `sketch.js`

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
  connectAdcBackend();
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

### Beyond ADC/DAC: plain digital I/O

The backend/frontend split isn't specific to analog signals — the same
one-shot RPC shape used for `setupDAC()` covers `digitalWrite`/
`digitalRead` too (`p5js/digital_io.js`, `pin` is a normal Arduino digital
pin number, e.g. 13 for the onboard LED, not one of the A0–A5 indices used
elsewhere). Enough for the classic Blink, entirely from `sketch.js`, no
recompiling to change the blink rate:

```js
let lastToggle = 0;
let ledOn = false;

function draw() {
  if (millis() - lastToggle > 500) {
    ledOn = !ledOn;
    digitalWrite(13, ledOn);
    lastToggle = millis();
  }
}
```

`digitalWrite()`/`digitalRead()` both return promises (like `setupDAC()`),
so `await` them if you need to know the call actually completed — the
snippet above fires and forgets, which is fine for a blink.

`p5js/README.md` has the exact steps for getting these files into your own
p5.js Web Editor project, in case you're not starting from the shared link
above.
