import processing.serial.*;

Serial arduinoPort;
int[] samples;

void setup() {
  size(800, 400);

  println("Available serial ports:");
  printArray(Serial.list());
  String portName = Serial.list()[0]; // adjust the index to match your board
  arduinoPort = new Serial(this, portName, 115200);
  arduinoPort.bufferUntil('\n');

  samples = new int[width];
}

void draw() {
  background(255);
  stroke(0);
  noFill();
  beginShape();
  for (int i = 0; i < samples.length; i++) {
    float y = map(samples[i], 0, 1023, height - 20, 20);
    vertex(i, y);
  }
  endShape();
}

void serialEvent(Serial port) {
  String line = trim(port.readStringUntil('\n'));
  if (line == null || line.length() == 0) return;

  int value;
  try {
    value = Integer.parseInt(line);
  } catch (NumberFormatException e) {
    return;
  }

  arrayCopy(samples, 1, samples, 0, samples.length - 1);
  samples[samples.length - 1] = value;
}