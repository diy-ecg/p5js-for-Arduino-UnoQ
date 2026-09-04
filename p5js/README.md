# Setting this up in the p5.js Web Editor

These files are the canonical source for the p5.js project. They don't run
locally here — they get transferred into a project on the [p5.js Web
Editor](https://editor.p5js.org/). That's only possible because of a few
specific properties of this exact setup: the sketch's preview runs in an
iframe on a different origin (`preview.p5js.org`) than the local backend
(`http://127.0.0.1:7000`), so it has to connect explicitly to that loopback
address rather than relying on same-origin defaults — and reaching a
loopback address from a page loaded over HTTPS is something browsers
specifically carve out an exception for, rather than something that works
in general. This folder's `index.html`/`transport.js` are already set up
for that; see the troubleshooting section below for what each fix here is
actually working around.

## One-time setup (already done for the shared project)

1. Create a new project on `editor.p5js.org` under your own account.
2. Use "Add File" in the file panel to upload the files in this folder
   (file picker or drag & drop). This folder's `index.html` already wires
   up all three demo files as `<script>` tags — `blink_demo.js` active,
   `dac-adc-demo.js` and `adc0_scope_demo.js` commented out. Comment/
   uncomment to pick which one runs, or rename whichever one you want to
   `sketch.js` to replace the editor's own auto-created default entirely.
3. **Important:** the Socket.IO client library isn't bundled by default in
   a p5.js Web Editor project. The project's `index.html` needs an extra
   `<script>` tag *before* the other `.js` files:
   ```html
   <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
   ```
   (already present in the `index.html` in this folder). Without it,
   `transport.js` fails with `io is not defined`. The version number
   should match whatever Socket.IO version `fastapi_socketio` uses
   server-side (`python/main.py`) — a client/server version mismatch is a
   good first suspect for connection trouble.
4. Save the project and publish/share it via "Share".

## Forking it for your own experiments

1. Open the shared link and **fork** it via **File > Duplicate** — you get
   your own, independently editable copy in your own p5.js account, with
   all the framework files already in place.
2. The sketch has to run in the same browser that's actually on the UNO Q
   (single-board mode) — it connects to `http://127.0.0.1:7000`, which is
   only reachable from that device itself. This has been tested with the
   preinstalled **Chromium**; the first time a sketch tries to reach the
   backend, Chromium shows a one-time button asking you to explicitly
   allow access to the local network — click it, and it's done for that
   sketch from then on.
3. The Python/MCU side needs to already be running on the UNO Q
   (`arduino-app-cli app start .` in the backend project's folder) before
   you hit run in the Web Editor — otherwise `connectBackend()` is
   trying to reach a server that isn't there yet.
4. For experimenting, only touch whichever demo file is active in
   `index.html` (`blink_demo.js`, `dac-adc-demo.js`, or
   `adc0_scope_demo.js`). The other eight files — the six framework files
   plus the two demo files you're not running — normally shouldn't need
   to change.

## Troubleshooting (hit while setting this up the first time)

- **`ReferenceError: connectBackend is not defined`** — one of the
  files was added via "Upload File" instead of "Create File". Upload is
  meant for assets (images, data) and does **not** automatically add the
  file as a `<script>` tag in `index.html`. Fix: check `index.html` for an
  actual, uncommented `<script src="...">` line for the 6 framework files
  plus whichever demo file you intend to run (plus the Socket.IO CDN tag)
  — otherwise the file shows up in the project but is never actually
  executed.
- **`Cross-Origin Request Blocked` / "CORS request did not succeed", status
  code `(null)`** — even though the server is reachable (a direct request
  to `http://127.0.0.1:7000/socket.io/?EIO=4&transport=polling` in a
  separate tab gets a response). Cause: `transport.js` initially used the
  hostname `localhost` instead of the loopback IP `127.0.0.1`. Browsers'
  mixed-content/local-network exemption for cross-origin requests to a
  loopback address is reliably granted for the literal IP, not guaranteed
  for the name `localhost`. Fix: set `BACKEND_URL` in `transport.js` to
  `http://127.0.0.1:7000` (already the case in this folder) — **fixes this
  particular symptom, but see the next point: that alone wasn't actually
  enough in practice.**
- **`CORS header 'Access-Control-Allow-Origin' does not match
  'https://editor.p5js.org, *'`** (two values in one header) — this was the
  actual root cause, once the `127.0.0.1` fix above alone didn't resolve
  the connection error. `arduino.app_bricks.web_ui.WebUI` applies CORS on
  two independent layers at once (its own FastAPI `CORSMiddleware`, plus
  the internal `fastapi_socketio.SocketManager`'s own CORS handling for
  `/socket.io`) — both independently add an `Access-Control-Allow-Origin`
  header, which the browser then rejects as invalid. Fix (already applied
  in `python/main.py`): `WebUI(cors_origins="")` — disables the outer,
  redundant FastAPI CORS layer entirely, leaving only the Socket.IO-level
  handling active. `transport.js` also forces plain WebSocket
  (`{transports: ["websocket"]}`), skipping the initial polling-handshake
  request altogether.
- **`SyntaxError: redeclaration of let adc`** (or similarly for other
  top-level variables) — your project's main file (e.g. `dac-adc-demo.js`)
  is included as a `<script>` tag **twice**, e.g. once via the editor's
  own auto-generated line in `<body>` and once more when manually adding
  the remaining scripts in `<head>`. Since all files share the same
  global scope, a script loaded twice produces exactly this error. Fix:
  search `index.html` for a duplicate `<script src="...">` line and
  remove one of them.
