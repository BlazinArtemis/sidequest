// src/core/store.js
// Zero-dependency persisted config. Deliberately NOT electron-store:
// electron-store >= 9 is ESM-only and cannot be `require()`d from a CommonJS
// main process. (electron-store@8.2.0 is the last CJS release if you prefer
// the dependency.) This file is ~60 lines and removes the problem entirely.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  hotkey: 'CommandOrControl+Shift+G',
  clickThroughHotkey: 'CommandOrControl+Shift+X',
  cycleGameHotkey: 'CommandOrControl+Shift+N',
  opacity: 0.95,
  scale: 1,                       // window size multiplier, 0.8 – 1.5
  lastGame: 'tetris',
  dockPosition: 'bottom-right',   // top-left | top-right | bottom-left | bottom-right | custom
  // 'cursor'    -> the display the cursor is on (default)
  // 'secondary' -> any display that is not the primary one, if one exists
  // <number>    -> a specific Electron display id
  // On macOS 15 this is the ONLY reliable way to stay out of a full-screen
  // share: be on a display that is not the one being shared. See spec 2.6.
  preferredDisplay: 'cursor',
  windowPosition: { x: null, y: null }, // used only when dockPosition === 'custom'
  contentProtection: true,
  // Idle pet: after this many seconds of no input anywhere on the machine, a
  // small creature wanders into the corner and offers a game.
  petEnabled: true,
  petIdleSeconds: 120,
  petAvatar: 'random',            // snake | pacman | robot | random
  petScale: 1,                    // how big the creature is drawn, 0.7 – 1.8
  petPosition: 'cursor',          // cursor -> appears where you left the mouse
                                  // dock   -> uses the overlay's dock corner
  highScores: { tetris: 0, '2048': 0, snake: 0 }
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      // Shallow merge so a config written by an older build gains new keys.
      return {
        ...DEFAULTS,
        ...parsed,
        windowPosition: { ...DEFAULTS.windowPosition, ...(parsed.windowPosition || {}) },
        highScores: { ...DEFAULTS.highScores, ...(parsed.highScores || {}) }
      };
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Write-then-rename: a crash mid-write can never leave a truncated config.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  getHighScore(game) { return this.data.highScores[game] || 0; }

  // Returns true when this run beat the stored best, so the UI can celebrate.
  recordScore(game, score) {
    const best = this.getHighScore(game);
    if (score > best) {
      this.data.highScores[game] = score;
      this.save();
      return true;
    }
    return false;
  }

  all() { return JSON.parse(JSON.stringify(this.data)); }
}

module.exports = { Store, DEFAULTS };
