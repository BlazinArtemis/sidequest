// src/core/store.js
// Zero-dependency persisted config. Deliberately NOT electron-store:
// electron-store >= 9 is ESM-only and cannot be `require()`d from a CommonJS
// main process. (electron-store@8.2.0 is the last CJS release if you prefer
// the dependency.)
//
// The config file is plain JSON in a documented, user-writable location, so
// its contents are INPUT, not state we can trust. Everything read back is
// validated against SCHEMA below — an unusable value falls back to its default
// rather than travelling on. Before that existed, `{"opacity":"abc"}` threw
// inside win.setOpacity() during startup, which happens inside a promise, and
// left a running process with no window and no tray icon: unreachable and
// unquittable. A truncated write from a hard power-off was enough to cause it.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { GAMES, DOCKS, PET_AVATARS, PET_POSITIONS } = require('./constants');

const DEFAULTS = {
  // These are registered with globalShortcut, which intercepts them SYSTEM-WIDE
  // ahead of the focused app. The previous defaults were Shift+Cmd+G and
  // Shift+Cmd+N, which are Finder's "Go to Folder" and "New Folder" (and
  // "Find Previous" almost everywhere) — so running SideQuest silently broke
  // them, with no Dock icon to blame. Cmd+Alt+<key> is conventionally free.
  hotkey: 'CommandOrControl+Alt+G',
  clickThroughHotkey: 'CommandOrControl+Alt+X',
  cycleGameHotkey: 'CommandOrControl+Alt+J',
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

// How each key is coerced back from disk. Anything that fails falls back to
// the default for that key; nothing here can throw.
const SCHEMA = {
  hotkey: accelerator,
  clickThroughHotkey: accelerator,
  cycleGameHotkey: accelerator,
  opacity: number(0.3, 1),
  scale: number(0.8, 1.5),
  lastGame: oneOf(GAMES),
  dockPosition: oneOf(DOCKS),
  preferredDisplay: displayPreference,
  windowPosition: point,
  contentProtection: boolean,
  petEnabled: boolean,
  petIdleSeconds: number(15, 3600),
  petAvatar: oneOf(PET_AVATARS),
  petScale: number(0.7, 1.8),
  petPosition: oneOf(PET_POSITIONS),
  highScores: scores
};

function number(min, max) {
  return (value, fallback) => {
    // Reject the values Number() would silently turn into a legitimate-looking
    // number: null -> 0, '' -> 0, true -> 1. An absent or nonsensical setting
    // means "use the default", not "use the minimum" — and JSON.stringify turns
    // NaN into null, so this is the shape a corrupt file actually arrives in.
    if (value === null || value === undefined || typeof value === 'boolean') return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    // A number that is merely out of range keeps its intent, so clamp it.
    return Math.min(max, Math.max(min, n));
  };
}

function oneOf(values) {
  return (value, fallback) => (values.includes(value) ? value : fallback);
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function accelerator(value, fallback) {
  // Electron throws on a malformed accelerator, and an empty one silently
  // registers nothing. Shape-check only; whether the OS grants it is reported
  // separately by registerShortcuts().
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length < 64 ? trimmed : fallback;
}

function displayPreference(value, fallback) {
  if (value === 'cursor' || value === 'secondary') return value;
  // A specific Electron display id. Whether that display is still attached is
  // resolved at use time by stealth.displayFor().
  if (Number.isInteger(value)) return value;
  return fallback;
}

function point(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const x = Number(value.x);
  const y = Number(value.y);
  // null/null is the legitimate "never dragged" state.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: null, y: null };
  return { x, y };
}

function scores(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  const out = { ...fallback };
  for (const game of GAMES) {
    const n = Number(value[game]);
    // Scores are non-negative integers; anything else keeps the default.
    if (Number.isFinite(n) && n >= 0) out[game] = Math.floor(n);
  }
  return out;
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = this.load();
  }

  load() {
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    } catch (_) {
      // Missing on first run, or truncated by a crash mid-write. Either way the
      // defaults are the right answer, and the next save() rewrites the file.
      parsed = {};
    }

    // Validate key by key rather than spreading the parsed object wholesale.
    // A missing key gains its default, so a config written by an older build
    // still loads.
    //
    // Note this also happens to be why the app has never been vulnerable to
    // prototype pollution: keys are copied out by name from a fixed list, so a
    // "__proto__" key in the file is never even looked at. The previous spread
    // was safe for a subtler reason (spread uses define, not assign, semantics)
    // — this is safe for an obvious one.
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      const fallback = DEFAULTS[key];
      const coerce = SCHEMA[key];
      out[key] = coerce ? coerce(parsed[key], fallback) : fallback;
    }
    return out;
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
    // Validate on the way in too, so a bad IPC payload cannot poison the file
    // for the next launch.
    const coerce = SCHEMA[key];
    this.data[key] = coerce ? coerce(value, DEFAULTS[key]) : value;
    this.save();
    return this.data[key];
  }

  getHighScore(game) { return this.data.highScores[game] || 0; }

  // Returns true when this run beat the stored best, so the UI can celebrate.
  // Only writes on an improvement, which makes it idempotent and safe to call
  // as often as the renderer likes.
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

module.exports = { Store, DEFAULTS, SCHEMA };
