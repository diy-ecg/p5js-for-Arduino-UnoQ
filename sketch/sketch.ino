// Arduino UNO Q (STM32U585, Zephyr-based core) multi-channel ADC/DAC sampler
// with Bridge/RPC frame fetch. Generalizes the earlier single-channel
// DIY-ECG sketch (ecg_get_frame on A0 only) to up to 4 ADC channels plus
// 2 fixed-waveform DAC outputs. See the project's concept doc
// (Multichannel_ADC_Sampling.md) for the full design rationale.
//
// RPC methods (Bridge.provide):
//   adc_set_channels(pin_mask) -> uint8_t confirmed_mask
//     pin_mask: bit i (0..5) set => Ai is an active ADC channel, up to 4
//     bits may be set. Tag index 0..3 is assigned in ascending pin order
//     (lowest set bit = tag index 0).
//   adc_set_reference(volts) -> float applied_volts
//     Snaps to the nearest supported internal reference
//     (2.5 / 2.05 / 1.8 / 1.5 V).
//   adc_get_frame() -> MsgPack binary, no arguments (mirrors the original
//     ecg_get_frame -- the MCU decides how many pending samples to return,
//     the caller does not request a count).
//   dac_set_waveform(channel, waveform_type, freq_hz, amplitude) -> bool ok
//     channel: 0 (A0/DAC0) or 1 (A1/DAC1).
//     waveform_type: 0=off, 1=sine, 2=square, 3=triangle.
//     amplitude: 0..1, scaled to the DAC's 12-bit range around mid-scale.
//   dac_off(channel) -> bool ok
//
// Frame layout (little-endian), identical in shape to the original
// single-channel frame -- no per-frame channel bitmask; the channel's tag
// index lives in the top 2 bits of each 16-bit sample word instead:
//   [uint8 count][uint32 t0_ms][count * (uint16 tagged_value + uint8 dt_ms)]
//   tagged_value = (channel_index << 14) | (adc_value & 0x3FFF)
// dt_ms is the delta to the previous sample's timestamp, saturated at 255.
//
// Pin note: A0/A1 (DAC0/DAC1) can each act as EITHER an ADC input OR their
// DAC output, never both at once on the same pin -- see concept doc §3. A
// channel is only actually driven by the DAC if dac_set_waveform() has been
// called for it; otherwise the pin is free to use as a normal ADC channel
// (e.g. an external ECG amplifier wired to A0).

#include <Arduino.h>
#include <Arduino_RouterBridge.h>
#include <MsgPack.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <math.h>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const uint16_t SAMPLE_INTERVAL_US = 5000;  // 5 ms -> 200 Hz per channel (fixed for now)
const uint8_t  MAX_CHANNELS       = 4;     // hard ceiling: 2-bit channel tag (§2)
const uint16_t RING_SIZE          = 800;   // worst case: 4 channels x 200 Hz x ~1s
// Keeps a frame under the 256-byte Bridge limit: 1 (count) + 4 (t0) + 80*3 = 245 bytes.
// This also fixes the original single-channel bug where `count` was clamped to 255
// (the uint8_t max) instead of to what actually fits in one Bridge message.
const uint8_t  MAX_FRAME_SAMPLES  = 80;
const uint8_t  NUM_DAC_CHANNELS   = 2;     // A0/A1 = DAC0/DAC1

const uint8_t PIN_FOR_INDEX[6] = {A0, A1, A2, A3, A4, A5};

// ---------------------------------------------------------------------------
// ADC channel configuration and ring buffer
// ---------------------------------------------------------------------------
// Default: A2-A5 active (keeps A0/A1 free for DAC by default). Change via
// adc_set_channels() -- e.g. to include A0 for an externally wired sensor.
volatile uint8_t activeChannels[MAX_CHANNELS] = {2, 3, 4, 5};
volatile uint8_t numActiveChannels            = 4;

struct Sample {
  uint16_t tagged_value;
  uint32_t t_ms;
};

volatile Sample   ringBuf[RING_SIZE];
volatile uint16_t head       = 0;  // next write position
volatile uint16_t last_sent  = 0;  // position after last sent sample
volatile bool     overflowed = false;

static struct k_timer sampleTimer;
atomic_t timer_ticks = ATOMIC_INIT(0);
uint32_t sample_time_us = 0;

static void onSampleTimer(struct k_timer *timer_id) {
  (void)timer_id;
  atomic_inc(&timer_ticks);
}

// ---------------------------------------------------------------------------
// DAC waveform generation (phase accumulator per channel, stepped in the
// same tick loop as the ADC reads -- no second timer needed, see concept
// doc §5).
// ---------------------------------------------------------------------------
enum WaveformType : uint8_t { WAVE_OFF = 0, WAVE_SINE = 1, WAVE_SQUARE = 2, WAVE_TRIANGLE = 3 };

struct DacChannelState {
  WaveformType type = WAVE_OFF;
  float freq_hz      = 0;
  float amplitude    = 0;  // 0..1, scaled to the 12-bit DAC range around mid-scale
  float phase        = 0;  // radians, wrapped to [0, 2*PI)
};

DacChannelState dacState[NUM_DAC_CHANNELS];

const int DAC_MAX_CODE = 4095;  // 12-bit DAC, confirmed from the board's devicetree
const int DAC_MID_CODE = DAC_MAX_CODE / 2;

void stepDac(uint8_t ch) {
  DacChannelState &s = dacState[ch];

  if (s.type == WAVE_OFF) return;

  float value;  // -1..1
  switch (s.type) {
    case WAVE_SINE:
      value = sinf(s.phase);
      break;
    case WAVE_SQUARE:
      value = (s.phase < PI) ? 1.0f : -1.0f;
      break;
    case WAVE_TRIANGLE:
      value = (s.phase < PI) ? (-1.0f + (2.0f * s.phase / PI))
                              : (3.0f - (2.0f * s.phase / PI));
      break;
    default:
      value = 0;
  }

  int code = DAC_MID_CODE + (int)(value * s.amplitude * DAC_MID_CODE);
  code = constrain(code, 0, DAC_MAX_CODE);

  analogWrite(static_cast<dacPins>(ch), code);

  s.phase += 2.0f * PI * s.freq_hz * (SAMPLE_INTERVAL_US / 1000000.0f);
  if (s.phase >= 2.0f * PI) s.phase -= 2.0f * PI;
}

// ---------------------------------------------------------------------------
// Forward declarations (RPC handlers)
//
// NOTE: all Bridge/RPC-facing parameter and return types here are `int`,
// not `uint8_t`/other fixed-width types, even where the value is always
// small (e.g. a channel index 0..5). `uint8_t` caused the bridge/router
// layer to reject calls with "Wrong parameter in position: N (255)" on
// real hardware -- only int/float/str/bool were ever confirmed to work
// for Bridge.provide() parameter marshaling (see concept doc §1). Narrow
// to uint8_t/etc. only internally, after the RPC boundary.
// ---------------------------------------------------------------------------
void readAllChannels(uint32_t t_ms);
void pushSample(uint16_t tagged_value, uint32_t t_ms);
MsgPack::bin_t<uint8_t> adc_get_frame();
int adc_set_channels(int pinMask);
float adc_set_reference(float volts);
bool dac_set_waveform(int channel, int waveformType, float freq_hz, float amplitude);
bool dac_off(int channel);
bool digital_write(int pin, int value);
int digital_read(int pin);

void setup() {
  Bridge.begin();
  Bridge.provide("adc_get_frame", adc_get_frame);
  Bridge.provide("adc_set_channels", adc_set_channels);
  Bridge.provide("adc_set_reference", adc_set_reference);
  Bridge.provide("dac_set_waveform", dac_set_waveform);
  Bridge.provide("dac_off", dac_off);
  Bridge.provide("digital_write", digital_write);
  Bridge.provide("digital_read", digital_read);

  analogReadResolution(14);   // fixed 14-bit ADC, see concept doc §4
  analogWriteResolution(12);  // matches the DAC's true hardware resolution 1:1,
                              // so raw codes 0..4095 map through with no rescaling

  // Periodic 200 Hz tick using Zephyr kernel timer (shared by ADC reads and
  // DAC waveform stepping).
  k_timer_init(&sampleTimer, onSampleTimer, nullptr);
  k_timer_start(&sampleTimer,
                K_USEC(SAMPLE_INTERVAL_US),
                K_USEC(SAMPLE_INTERVAL_US));
  sample_time_us = 0;
}

void loop() {
  uint32_t pending_samples = atomic_set(&timer_ticks, 0);
  if (pending_samples == 0) {
    k_sleep(K_USEC(500));
  } else {
    while (pending_samples > 0) {
      sample_time_us += SAMPLE_INTERVAL_US;
      uint32_t t_ms = sample_time_us / 1000;

      readAllChannels(t_ms);
      for (uint8_t ch = 0; ch < NUM_DAC_CHANNELS; ch++) stepDac(ch);

      pending_samples--;
    }
  }
  // Bridge background thread handles RPC requests.
}

// Reads every currently active channel once, tagging each sample with its
// position (0..numActiveChannels-1) in the active list -- NOT a fixed
// pin-to-tag mapping, see concept doc §3.
void readAllChannels(uint32_t t_ms) {
  uint8_t n = numActiveChannels;
  for (uint8_t i = 0; i < n; i++) {
    uint16_t raw = analogRead(PIN_FOR_INDEX[activeChannels[i]]);
    uint16_t tagged = static_cast<uint16_t>((i << 14) | (raw & 0x3FFF));
    pushSample(tagged, t_ms);
  }
}

void pushSample(uint16_t tagged_value, uint32_t t_ms) {
  uint16_t next = head + 1;
  if (next == RING_SIZE) next = 0;

  // If the ring would overwrite unsent data, drop the oldest (move last_sent forward).
  if (next == last_sent) {
    uint16_t new_last_sent = last_sent + 1;
    if (new_last_sent == RING_SIZE) new_last_sent = 0;
    last_sent = new_last_sent;
    overflowed = true;
  }

  ringBuf[head].tagged_value = tagged_value;
  ringBuf[head].t_ms         = t_ms;
  head = next;
}

// RPC method to get the pending multi-channel frame as MsgPack binary.
MsgPack::bin_t<uint8_t> adc_get_frame() {
  noInterrupts();
  uint16_t tail = last_sent;
  uint16_t h    = head;
  bool     ovf  = overflowed;
  overflowed    = false;
  interrupts();

  MsgPack::bin_t<uint8_t> out;
  uint16_t count = (h >= tail) ? (h - tail) : (RING_SIZE - tail + h);
  if (count == 0) {
    return out;  // empty payload, no data
  }
  if (count > MAX_FRAME_SAMPLES) count = MAX_FRAME_SAMPLES;

  static uint8_t frame[1 + 4 + MAX_FRAME_SAMPLES * 3];
  size_t idx = 0;

  frame[idx++] = static_cast<uint8_t>(count);

  uint32_t t0 = ringBuf[tail].t_ms;
  frame[idx++] = t0 & 0xFF;
  frame[idx++] = (t0 >> 8) & 0xFF;
  frame[idx++] = (t0 >> 16) & 0xFF;
  frame[idx++] = (t0 >> 24) & 0xFF;

  uint16_t i_idx  = tail;
  uint32_t prev_t = t0;
  for (uint16_t i = 0; i < count; i++) {
    if (i_idx == RING_SIZE) i_idx = 0;

    uint16_t v = ringBuf[i_idx].tagged_value;
    uint32_t t = ringBuf[i_idx].t_ms;

    frame[idx++] = v & 0xFF;
    frame[idx++] = (v >> 8) & 0xFF;

    uint32_t dt = t - prev_t;
    frame[idx++] = (i == 0) ? 0 : (dt > 255 ? 255 : static_cast<uint8_t>(dt));
    prev_t = t;

    i_idx++;
  }

  noInterrupts();
  last_sent = (tail + count) % RING_SIZE;
  interrupts();

  if (ovf) {
    out.push_back(0x21);  // overflow marker, same convention as the original sketch
  }
  for (size_t i = 0; i < idx; i++) {
    out.push_back(frame[i]);
  }
  return out;
}

// Selects which of A0..A5 are active ADC channels, up to MAX_CHANNELS.
// pinMask bit i corresponds to Ai. Tag index 0..3 is assigned in ascending
// pin order among the set bits (lowest set bit = tag index 0).
int adc_set_channels(int pinMask) {
  uint8_t mask = static_cast<uint8_t>(pinMask);
  uint8_t newChannels[MAX_CHANNELS];
  uint8_t n = 0;
  for (uint8_t pin = 0; pin < 6 && n < MAX_CHANNELS; pin++) {
    if (mask & (1 << pin)) {
      newChannels[n++] = pin;
    }
  }

  noInterrupts();
  for (uint8_t i = 0; i < n; i++) activeChannels[i] = newChannels[i];
  numActiveChannels = n;
  head = 0;
  last_sent = 0;
  overflowed = false;  // reset ring buffer on channel-set change, see concept doc
  interrupts();

  int confirmedMask = 0;
  for (uint8_t i = 0; i < n; i++) confirmedMask |= (1 << activeChannels[i]);
  return confirmedMask;
}

// Global (all-channels) ADC reference voltage. Snaps to the nearest
// supported internal reference and returns the value actually applied --
// the caller must not assume the requested value was granted verbatim.
float adc_set_reference(float volts) {
  struct RefOption {
    float v;
    uint8_t mode;
  };
  static const RefOption options[] = {
      {2.5f, AR_INTERNAL2V5},
      {2.05f, AR_INTERNAL2V05},
      {1.8f, AR_INTERNAL1V8},
      {1.5f, AR_INTERNAL1V5},
  };

  const RefOption *best = &options[0];
  float bestDist = fabsf(volts - best->v);
  for (const auto &opt : options) {
    float dist = fabsf(volts - opt.v);
    if (dist < bestDist) {
      bestDist = dist;
      best = &opt;
    }
  }

  analogReference(best->mode);
  return best->v;
}

// Configures a fixed-waveform DAC output (A0=channel 0, A1=channel 1).
// waveformType: 0=off, 1=sine, 2=square, 3=triangle.
bool dac_set_waveform(int channel, int waveformType, float freq_hz, float amplitude) {
  if (channel < 0 || channel >= NUM_DAC_CHANNELS) return false;
  if (waveformType < 0 || waveformType > WAVE_TRIANGLE) return false;

  dacState[channel].type      = static_cast<WaveformType>(waveformType);
  dacState[channel].freq_hz   = freq_hz;
  dacState[channel].amplitude = constrain(amplitude, 0.0f, 1.0f);
  dacState[channel].phase     = 0;
  return true;
}

bool dac_off(int channel) {
  if (channel < 0 || channel >= NUM_DAC_CHANNELS) return false;
  dacState[channel].type = WAVE_OFF;
  analogWrite(static_cast<dacPins>(channel), DAC_MID_CODE);  // settle at mid-scale
  return true;
}

// Plain digital I/O, independent of the ADC/DAC channels above -- pin is a
// normal Arduino digital pin number (e.g. 13 for the onboard LED), not one
// of the A0..A5 indices used elsewhere in this sketch. One-shot calls, same
// as dac_off() -- no ring buffer, no streaming.
bool digital_write(int pin, int value) {
  if (pin < 0) return false;
  pinMode(pin, OUTPUT);
  digitalWrite(pin, value ? HIGH : LOW);
  return true;
}

int digital_read(int pin) {
  if (pin < 0) return -1;
  pinMode(pin, INPUT);
  return digitalRead(pin);
}
