// test/store.test.js
// Config validation. Run with: npm run test:store
//
// The config file is plain JSON in a documented, user-writable location, so it
// is INPUT. Before validation existed, {"opacity":"abc"} threw inside
// win.setOpacity() during startup — inside a promise with no rejection handler
// — and left a process with no window and no tray: unreachable and unquittable.
// A truncated write from a hard power-off was enough to cause it.
//
// Runs in plain Node by stubbing the one Electron call store.js makes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-store-test-'));

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => SANDBOX } };
  return realLoad.call(this, request, ...rest);
};

const { Store, DEFAULTS } = require('../src/core/store');

const CONFIG = path.join(SANDBOX, 'config.json');
const withConfig = (raw) => {
  fs.writeFileSync(CONFIG, typeof raw === 'string' ? raw : JSON.stringify(raw));
  return new Store();
};

// ---- a valid config survives untouched ----
const valid = withConfig({
  hotkey: 'CommandOrControl+Alt+K',
  opacity: 0.5,
  scale: 1.2,
  lastGame: 'snake',
  dockPosition: 'top-left',
  petIdleSeconds: 300,
  highScores: { tetris: 1234, '2048': 8, snake: 0 }
});
assert.strictEqual(valid.get('hotkey'), 'CommandOrControl+Alt+K', 'valid accelerator kept');
assert.strictEqual(valid.get('opacity'), 0.5, 'valid opacity kept');
assert.strictEqual(valid.get('scale'), 1.2);
assert.strictEqual(valid.get('lastGame'), 'snake');
assert.strictEqual(valid.get('dockPosition'), 'top-left');
assert.strictEqual(valid.get('petIdleSeconds'), 300);
assert.strictEqual(valid.getHighScore('tetris'), 1234, 'valid high score kept');

// ---- the case that made the app unstartable ----
const s1 = withConfig({ opacity: 'abc' });
assert.strictEqual(typeof s1.get('opacity'), 'number', 'opacity must always be a number');
assert.ok(s1.get('opacity') >= 0.3 && s1.get('opacity') <= 1, 'opacity within range');

// ---- numbers are clamped, not rejected, so a near-miss keeps its intent ----
assert.strictEqual(withConfig({ opacity: 500 }).get('opacity'), 1, 'opacity clamps to max');
assert.strictEqual(withConfig({ opacity: -5 }).get('opacity'), 0.3, 'opacity clamps to min');
assert.strictEqual(withConfig({ opacity: 0 }).get('opacity'), 0.3, 'zero clamps, it is not "falsy so default"');
assert.strictEqual(withConfig({ scale: 99 }).get('scale'), 1.5, 'scale clamps to max');
assert.strictEqual(withConfig({ petScale: 0.01 }).get('petScale'), 0.7, 'petScale clamps to min');
assert.strictEqual(withConfig({ petIdleSeconds: -5 }).get('petIdleSeconds'), 15, 'idle seconds clamp');
// JSON.stringify turns NaN and Infinity into null, so null is the shape a
// corrupt numeric field actually arrives in. It must mean "use the default",
// not coerce to 0 and clamp to the floor.
assert.strictEqual(withConfig({ opacity: NaN }).get('opacity'), DEFAULTS.opacity, 'NaN (serialised as null) falls back');
assert.strictEqual(withConfig({ opacity: null }).get('opacity'), DEFAULTS.opacity, 'null falls back');
assert.strictEqual(withConfig({ opacity: '' }).get('opacity'), DEFAULTS.opacity, 'empty string falls back, not 0');
assert.strictEqual(withConfig({ opacity: true }).get('opacity'), DEFAULTS.opacity, 'boolean falls back, not 1');
assert.strictEqual(withConfig({ opacity: '0.6' }).get('opacity'), 0.6, 'a numeric string is still accepted');

// ---- enums fall back rather than passing an unknown value downstream ----
// An unrecognised lastGame used to leave the renderer with a blank canvas and
// no message, because load() returned early and never assigned a game.
assert.strictEqual(withConfig({ lastGame: 'doom' }).get('lastGame'), DEFAULTS.lastGame);
assert.strictEqual(withConfig({ dockPosition: 'banana' }).get('dockPosition'), DEFAULTS.dockPosition);
assert.strictEqual(withConfig({ petAvatar: 'dinosaur' }).get('petAvatar'), DEFAULTS.petAvatar);
assert.strictEqual(withConfig({ petPosition: 'nowhere' }).get('petPosition'), DEFAULTS.petPosition);

// ---- display preference accepts its three legitimate shapes ----
assert.strictEqual(withConfig({ preferredDisplay: 'cursor' }).get('preferredDisplay'), 'cursor');
assert.strictEqual(withConfig({ preferredDisplay: 'secondary' }).get('preferredDisplay'), 'secondary');
assert.strictEqual(withConfig({ preferredDisplay: 12345 }).get('preferredDisplay'), 12345, 'a display id is valid');
assert.strictEqual(withConfig({ preferredDisplay: 'moon' }).get('preferredDisplay'), DEFAULTS.preferredDisplay);

// ---- structural corruption of nested values ----
const arrScores = withConfig({ highScores: [1, 2, 3] });
assert.strictEqual(arrScores.getHighScore('tetris'), 0, 'an array where an object belongs falls back');
const strScore = withConfig({ highScores: { tetris: 'lots', snake: 40 } });
assert.strictEqual(strScore.getHighScore('tetris'), 0, 'a non-numeric score falls back');
assert.strictEqual(strScore.getHighScore('snake'), 40, 'a valid sibling still survives');
assert.strictEqual(withConfig({ highScores: { tetris: -7 } }).getHighScore('tetris'), 0, 'negative rejected');
assert.strictEqual(withConfig({ highScores: { tetris: 12.7 } }).getHighScore('tetris'), 12, 'floored');
assert.deepStrictEqual(withConfig({ windowPosition: null }).get('windowPosition'), { x: null, y: null });
assert.deepStrictEqual(withConfig({ windowPosition: { x: 'a', y: 2 } }).get('windowPosition'), { x: null, y: null });
assert.deepStrictEqual(withConfig({ windowPosition: { x: 5, y: 6 } }).get('windowPosition'), { x: 5, y: 6 });

// ---- accelerators ----
assert.strictEqual(withConfig({ hotkey: '' }).get('hotkey'), DEFAULTS.hotkey, 'empty accelerator rejected');
assert.strictEqual(withConfig({ hotkey: 42 }).get('hotkey'), DEFAULTS.hotkey, 'non-string rejected');
assert.strictEqual(withConfig({ hotkey: '  Alt+K  ' }).get('hotkey'), 'Alt+K', 'trimmed');

// ---- booleans ----
assert.strictEqual(withConfig({ contentProtection: 'yes' }).get('contentProtection'), true, 'non-boolean falls back to the default (true)');
assert.strictEqual(withConfig({ petEnabled: false }).get('petEnabled'), false, 'a real false is kept');

// ---- whole-file corruption ----
assert.strictEqual(withConfig('{ this is not json').get('hotkey'), DEFAULTS.hotkey, 'unparseable file');
assert.strictEqual(withConfig('null').get('hotkey'), DEFAULTS.hotkey, 'JSON null');
assert.strictEqual(withConfig('[1,2,3]').get('hotkey'), DEFAULTS.hotkey, 'JSON array');
assert.strictEqual(withConfig('""').get('hotkey'), DEFAULTS.hotkey, 'JSON string');

// ---- prototype pollution ----
// Keys are copied out by name from a fixed list, so a "__proto__" key in the
// file is never read at all. (The previous spread-merge was also safe, for the
// subtler reason that spread uses define rather than assign semantics.)
withConfig('{"__proto__":{"polluted":"yes"},"opacity":0.7}');
assert.strictEqual({}.polluted, undefined, 'Object.prototype must not be polluted');
assert.strictEqual(withConfig('{"__proto__":{"polluted":"yes"},"opacity":0.7}').get('opacity'), 0.7);
assert.strictEqual({}.polluted, undefined, 'still clean after a successful load');

// ---- set() validates on the way in too ----
const s2 = withConfig({});
s2.set('opacity', 'nonsense');
assert.strictEqual(s2.get('opacity'), DEFAULTS.opacity, 'a bad set cannot poison the file');
s2.set('lastGame', 'doom');
assert.strictEqual(s2.get('lastGame'), DEFAULTS.lastGame);
s2.set('opacity', 0.42);
assert.strictEqual(new Store().get('opacity'), 0.42, 'a good set round-trips through disk');

// ---- the write is atomic ----
assert.ok(fs.existsSync(CONFIG), 'config written');
assert.ok(!fs.existsSync(`${CONFIG}.tmp`), 'no temp file left behind');

// ---- unknown keys in the file are dropped, not carried forward ----
const extra = withConfig({ opacity: 0.6, somethingWeExtinguished: 'x' });
assert.strictEqual(extra.all().somethingWeExtinguished, undefined, 'unknown keys are not retained');
assert.strictEqual(extra.get('opacity'), 0.6);

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('All config-validation assertions passed.');
