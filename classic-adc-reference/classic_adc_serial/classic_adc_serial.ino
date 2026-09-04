// Classic reference for the ADC comparison post: a plain Arduino Uno R3
// sketch that samples A0 at 200 Hz and writes each raw value as one line
// of ASCII text over serial. Pair with classic_adc_plot.pde on the host
// computer -- see the folder's README for wiring and how to run both.

const unsigned long SAMPLE_INTERVAL_MS = 5; // 200 Hz
unsigned long lastSample = 0;

void setup() {
  Serial.begin(115200);
}

void loop() {
  unsigned long now = millis();
  if (now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    Serial.println(analogRead(A0));
  }
}
