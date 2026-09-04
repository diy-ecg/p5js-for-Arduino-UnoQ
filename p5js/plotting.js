"use strict";

/**
 * Shared time-series plotting helper: a single line, x mapped to time,
 * y auto-scaled to whatever's currently in the buffer -- no fixed
 * resolution/voltage range assumed, so it works unchanged regardless of
 * the MCU's ADC/DAC resolution. Factored out so demos that plot a
 * channel's buffer don't each reimplement the same map() calls.
 *
 * Classic (non-module) script: shares the top-level scope with the other
 * files in this p5.js project.
 *
 * points: array of {t, v}, as returned by RingBuffer.toArray()
 * (ring_buffer.js) -- one channel's buffer, in this call's own units.
 * index/total: optional band layout -- splits the canvas into `total`
 * equal horizontal bands and draws into band `index` (0-based, top to
 * bottom), each with its own margin. Defaults to one full-canvas band.
 */
const PLOT_MARGIN = 10; // px reserved above/below each band

function plotGraph(points, index = 0, total = 1) {
  if (points.length < 2) return;

  const bandHeight = height / total;
  const yTop = index * bandHeight + PLOT_MARGIN;
  const yBottom = (index + 1) * bandHeight - PLOT_MARGIN;

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
