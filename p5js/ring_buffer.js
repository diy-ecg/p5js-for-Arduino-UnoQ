"use strict";

/**
 * Fixed-size, wrap-around ring buffer -- not a growing array, not
 * shift()-based. Stores whatever is pushed (in this project: {t, v}
 * objects, timestamp + filtered value) without caring about its type.
 *
 * Classic (non-module) script: shares the top-level scope with the other
 * files in this p5.js project.
 */

class RingBuffer {
  constructor(size) {
    this.size = size;
    this.data = new Array(size).fill(0);
    this.writeIndex = 0;
    this.count = 0; // how many entries have actually been written so far
  }

  push(value) {
    this.data[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.size;
    this.count = Math.min(this.count + 1, this.size);
  }

  // Returns entries in chronological order (oldest first) -- for plotting
  // or exporting the whole buffer.
  toArray() {
    if (this.count < this.size) return this.data.slice(0, this.count);
    return [...this.data.slice(this.writeIndex), ...this.data.slice(0, this.writeIndex)];
  }

  // O(1) accessor for just the most recent entry -- for a text/debug
  // readout that doesn't need the whole buffer reconstructed every time.
  last() {
    if (this.count === 0) return undefined;
    const idx = (this.writeIndex - 1 + this.size) % this.size;
    return this.data[idx];
  }
}
