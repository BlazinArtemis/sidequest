// build/make-tray-icon.js
// Generates build/trayTemplate.png (16x16) and build/trayTemplate@2x.png (32x32).
//
// Run with: node build/make-tray-icon.js
//
// The tray glyph is the app's only art asset, so it is generated rather than
// checked in as an opaque blob — this way it is reviewable and reproducible.
// Zero dependencies: PNG is written by hand (zlib ships with Node).
//
// macOS template images must be black-and-transparent ONLY; the system tints
// them for light/dark menu bars. The "Template" suffix in the filename is what
// makes nativeImage.setTemplateImage(true) behave. Colour here would be ignored
// on macOS and would look wrong on Windows, so: black, varying alpha.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- geometry ---------------------------------------------------------
// A gamepad silhouette, described in a 16x16 unit space and scaled to the
// output size. Coverage is computed by supersampling, which is what gives the
// glyph clean edges at 16px where a hand-plotted bitmap would look ragged.
const UNITS = 16;
const SS = 8; // supersample factor per axis -> 64 samples per output pixel

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

// Signed-distance-ish helpers. Each returns true when the point is inside.
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return dist(x, y, cx, cy) <= r;
}

function inCircle(x, y, cx, cy, r) {
  return dist(x, y, cx, cy) <= r;
}

// True where the gamepad body is painted.
function inBody(x, y) {
  // Central slab plus two lobes, which reads as a controller at 16px far
  // better than a plain rounded rectangle does.
  return (
    inRoundedRect(x, y, 2.2, 5.4, 13.8, 10.6, 2.0) ||
    inCircle(x, y, 4.3, 8.0, 3.05) ||
    inCircle(x, y, 11.7, 8.0, 3.05)
  );
}

// True where controls are knocked back out of the body.
function inControls(x, y) {
  // D-pad on the left lobe.
  const dpad =
    inRoundedRect(x, y, 2.5, 7.45, 6.1, 8.55, 0.25) ||
    inRoundedRect(x, y, 3.75, 6.2, 4.85, 9.8, 0.25);
  // Two action buttons on the right lobe.
  const buttons =
    inCircle(x, y, 11.05, 6.95, 0.92) ||
    inCircle(x, y, 12.75, 9.05, 0.92);
  return dpad || buttons;
}

// True where the gamepad glyph is painted, in 16-unit space.
const inGlyph = (x, y) => inBody(x, y) && !inControls(x, y);

// Supersampled coverage (0..1) of an arbitrary shape for one output pixel.
// `shape` is a predicate in 16-unit space; `inset` shrinks the glyph towards
// the centre so the app icon can leave the margin macOS expects.
function coverageOf(shape, px, py, size, inset = 1) {
  const scale = UNITS / size;
  const c = UNITS / 2;
  let hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) * scale;
      const y = (py + (sy + 0.5) / SS) * scale;
      if (shape(c + (x - c) / inset, c + (y - c) / inset)) hits++;
    }
  }
  return hits / (SS * SS);
}

// Alpha (0..255) for one output pixel of the tray glyph.
function coverage(px, py, size) {
  return Math.round(coverageOf(inGlyph, px, py, size) * 255);
}

// ---- PNG writing ------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// shade(x, y, size) -> [r, g, b, a]. Defaults to the tray glyph: black, with
// the shape carried entirely by the alpha channel, as template images require.
function encodePng(size, shade) {
  const paint = shade || ((x, y, s) => [0, 0, 0, coverage(x, y, s)]);

  // Raw scanlines: one filter byte (0 = None) followed by RGBA pixels.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 4;
      const [r, g, b, a] = paint(x, y, size);
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const targets = [
  ['trayTemplate.png', 16],
  ['trayTemplate@2x.png', 32]
];

function main() {
  for (const [name, size] of targets) {
    const file = path.join(__dirname, name);
    fs.writeFileSync(file, encodePng(size));
    console.log(`wrote ${name} (${size}x${size})`);
  }
}

// Exported so the glyph can be proofed at a legible size without writing the
// real assets (`require('./make-tray-icon').encodePng(256)`), and so
// make-app-icon.js can reuse the same shape and the same PNG writer rather
// than keeping a second copy of the artwork that could drift out of step.
module.exports = { encodePng, coverage, coverageOf, inGlyph, inRoundedRect, UNITS };

if (require.main === module) main();
