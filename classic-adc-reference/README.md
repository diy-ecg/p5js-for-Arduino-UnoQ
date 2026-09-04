# Classic reference: ADC over serial, Uno R3 + Processing

The "before" half of an upcoming ADC comparison post for
[p5.js for Arduino Uno Q](../README.md): what sampling an analog input and
plotting it over time looks like the classic way, on a classic Uno R3 with
a separate host computer.

- `classic_adc_serial/classic_adc_serial.ino` -- flashed to the Uno R3.
  Samples A0 at 200 Hz and writes each raw value (0-1023) as one line of
  ASCII text over serial, at 115200 baud.
- `classic_adc_plot/classic_adc_plot.pde` -- runs on the host computer in
  the Processing IDE. Opens the same serial port, parses each incoming
  line, and plots the last `width` samples (800, ~4 seconds at 200 Hz) as
  a scrolling line graph.

## Running it

1. Wire a signal into A0 on the Uno R3 (a potentiometer wiper between 5V
   and GND is the simplest test signal).
2. Open `classic_adc_serial/classic_adc_serial.ino` in the Arduino IDE,
   select the Uno R3's port, upload.
3. Open `classic_adc_plot/classic_adc_plot.pde` in the Processing IDE.
   `Serial.list()` is printed to the console on start -- if the sketch
   doesn't pick the right port automatically, change the `Serial.list()[0]`
   index in `setup()` to match.
4. Run the Processing sketch. Close the Arduino IDE's own Serial
   Monitor/Plotter first if it's open -- only one program can hold the
   serial port at a time, and the Processing sketch will fail to connect
   otherwise.

Two separate programs, two separate IDEs, a serial port to get right, and
a host computer to run all of it on -- that's before any actual plotting
logic. This is the baseline the p5.js-for-Arduino-UnoQ version in the
comparison post is measured against.
