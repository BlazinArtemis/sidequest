// test/idle.test.js
// The idle-pet timing rules. Run with: npm run test:idle
//
// These are the rules you would otherwise have to verify by leaving the machine
// alone for two minutes and watching, which is a slow and unreliable way to
// find out that a threshold is off by one.

const assert = require('assert');
const { IdleWatcher } = require('../src/core/idle');

const make = (over = {}) => {
  const settings = { enabled: true, idleSeconds: 120, ...over };
  return new IdleWatcher(() => settings);
};

// ---- the threshold is honoured exactly ----
let w = make({ idleSeconds: 120 });
assert.strictEqual(w.poll(0), false, 'active machine: no pet');
assert.strictEqual(w.poll(60), false, 'half way there: no pet');
assert.strictEqual(w.poll(119), false, 'one second short: no pet');
assert.strictEqual(w.poll(120), true, 'exactly at the threshold: pet');

w = make({ idleSeconds: 30 });
assert.strictEqual(w.poll(29), false, '30s setting, 29s idle: no pet');
assert.strictEqual(w.poll(30), true, '30s setting, 30s idle: pet');

// A changed setting takes effect on the next poll, without a restart.
const live = { enabled: true, idleSeconds: 600 };
const wl = new IdleWatcher(() => live);
assert.strictEqual(wl.poll(120), false, '10 min setting: 2 min is not enough');
live.idleSeconds = 60;
assert.strictEqual(wl.poll(120), true, 'lowering the setting applies immediately');

// ---- one appearance per stretch of idleness ----
w = make({ idleSeconds: 60 });
assert.strictEqual(w.poll(60), true, 'first time over the line');
w.markSent();
assert.strictEqual(w.poll(65), false, 'still idle: does not come back');
assert.strictEqual(w.poll(3600), false, 'idle for an hour: still only once');
// Any input re-arms it.
assert.strictEqual(w.poll(2), false, 'user came back');
assert.strictEqual(w.poll(60), true, 'idle again: pet returns');

// ---- never on top of a game that is already open ----
w = make({ idleSeconds: 60 });
assert.strictEqual(w.poll(300, { overlayVisible: true }), false, 'game is open: no pet');
assert.strictEqual(w.poll(300, { petVisible: true }), false, 'pet already out: not twice');

// The chance must NOT be consumed while the game was open. This is the bug the
// first version had: crossing the threshold with the overlay visible burned the
// single edge, so hiding the game and walking away produced nothing.
assert.strictEqual(w.poll(300, { overlayVisible: false }), true, 'pet comes once the game is hidden');

// ---- disabled means disabled ----
w = make({ enabled: false, idleSeconds: 30 });
assert.strictEqual(w.poll(9999), false, 'switched off: never');

// Re-enabling works without any other state change.
const toggle = { enabled: false, idleSeconds: 30 };
const wt = new IdleWatcher(() => toggle);
assert.strictEqual(wt.poll(120), false);
toggle.enabled = true;
assert.strictEqual(wt.poll(120), true, 're-enabling takes effect immediately');

// ---- a nonsense setting falls back rather than firing constantly ----
w = make({ idleSeconds: 0 });
assert.strictEqual(w.poll(10), false, 'zero delay must not mean "always"');
assert.strictEqual(w.poll(120), true, 'falls back to the 120s default');

console.log('All idle-timing assertions passed.');
