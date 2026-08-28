// build/make-app-icon.js
// Generates build/icon.icns (macOS) and build/icon.ico (Windows) from the same
// gamepad shape as the tray glyph.
//
// Run with: node build/make-app-icon.js   (or `npm run icons`)
//
// Without these, electron-builder ships the stock Electron icon — which on a
// portfolio artefact reads as unfinished the moment anyone opens the dmg.
//
// The tray glyph is black-on-transparent because macOS template images must be.
// An app icon is the opposite problem: it sits on the user's wallpaper, in the
// Finder and in the dmg, so it needs its own ground. Same silhouette, inverted
// treatment — a light gamepad on the app's dark card colour.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { encodePng, coverageOf, inGlyph, inRoundedRect, UNITS } = require('./make-tray-icon');

// Palette lifted from renderer/overlay.html so the icon and the overlay chrome
// are recognisably the same product.
const BG_TOP = [24, 27, 34];
const BG_BOTTOM = [13, 15, 20];
const GLYPH = [232, 234, 240];

// macOS icons are not edge-to-edge: the rounded square occupies roughly the
// middle 80% and the rest is transparent margin, which is what makes an icon
// sit correctly next to Apple's own in the Dock and Finder.
const PLATE_INSET = 0.10;   // fraction of the canvas left as margin per side
const PLATE_RADIUS = 0.225; // corner radius as a fraction of the canvas
const GLYPH_SCALE = 0.62;   // gamepad size relative to the plate

const plate = (x, y) => inRoundedRect(
  x, y,
  UNITS * PLATE_INSET, UNITS * PLATE_INSET,
  UNITS * (1 - PLATE_INSET), UNITS * (1 - PLATE_INSET),
  UNITS * PLATE_RADIUS
);

function shade(px, py, size) {
  const plateA = coverageOf(plate, px, py, size);
  if (plateA === 0) return [0, 0, 0, 0];

  // A vertical gradient so the plate does not read as a flat rectangle at
  // large sizes, where a solid fill looks cheap.
  const t = py / Math.max(1, size - 1);
  const bg = BG_TOP.map((c, i) => Math.round(c + (BG_BOTTOM[i] - c) * t));

  const glyphA = coverageOf(inGlyph, px, py, size, GLYPH_SCALE);
  const rgb = bg.map((c, i) => Math.round(c + (GLYPH[i] - c) * glyphA));

  return [rgb[0], rgb[1], rgb[2], Math.round(plateA * 255)];
}

// ---- macOS .icns ------------------------------------------------------
// iconutil takes a directory of exactly-named PNGs. It ships with macOS, so
// there is no dependency here, but it does mean .icns can only be built on a Mac.
const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
];

function buildIcns() {
  if (process.platform !== 'darwin') {
    console.log('skipping icon.icns — iconutil is macOS-only');
    return;
  }

  const dir = path.join(__dirname, 'icon.iconset');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Sizes repeat (32, 256 and 512 each appear twice), so render each distinct
  // size once — 1024x1024 at 64 samples per pixel is not free.
  const cache = new Map();
  for (const [name, size] of ICONSET) {
    if (!cache.has(size)) cache.set(size, encodePng(size, shade));
    fs.writeFileSync(path.join(dir, name), cache.get(size));
  }

  const out = path.join(__dirname, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote icon.icns (${ICONSET.length} representations)`);
}

// ---- Windows .ico -----------------------------------------------------
// An ICO is a small directory header followed by image payloads. Vista and
// later accept PNG payloads directly, which is why this needs no BMP encoder.
// electron-builder wants at least 256x256.
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function buildIco() {
  const images = ICO_SIZES.map((size) => ({ size, data: encodePng(size, shade) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    // 256 is encoded as 0 in a single byte — the format's own quirk.
    entry[0] = size >= 256 ? 0 : size; // width
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0;  // palette size (0 = truecolour)
    entry[3] = 0;  // reserved
    entry.writeUInt16LE(1, 4);   // colour planes
    entry.writeUInt16LE(32, 6);  // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  const out = path.join(__dirname, 'icon.ico');
  fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  console.log(`wrote icon.ico (${ICO_SIZES.join(', ')})`);
}

buildIcns();
buildIco();
