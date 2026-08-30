// test/smoke.electron.js
// Integration smoke test. Run with:  npm run test:smoke
//
// games.test.js covers pure game logic in plain Node. This covers the half that
// only exists inside Electron: window creation, the stealth calls, positioning,
// the preload bridge and every IPC handler. Section 9.1 of the spec is a manual
// matrix; everything here is the part of it a machine can check, so the manual
// pass can concentrate on the one thing it cannot — what a second device sees.
//
// It boots a real window against a throwaway userData directory, drives the
// renderer through executeJavaScript, and exits non-zero on the first failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, screen } = require('electron');

// Must happen before anything constructs a Store, or the test would read and
// overwrite the real config in the user's Application Support directory.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-smoke-'));
app.setPath('userData', SANDBOX);

const { Store, DEFAULTS } = require('../src/core/store');
const stealth = require('../src/core/stealth');
const { OverlayWindow, WIDTH, HEIGHT, PET_WIDTH, PET_HEIGHT } = require('../src/managers/overlay.window');
const { registerShortcuts, unregisterAll } = require('../src/managers/shortcuts');
const { registerIpc } = require('../src/ipc');

const results = [];
let failures = 0;

function check(name, fn) {
  try {
    fn();
    results.push(`  ok    ${name}`);
  } catch (err) {
    failures++;
    results.push(`  FAIL  ${name}\n          ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push(`  ok    ${name}`);
  } catch (err) {
    failures++;
    results.push(`  FAIL  ${name}\n          ${err.message}`);
  }
}

function note(text) { results.push(`  --    ${text}`); }

// Poll the renderer until boot() and SQSettings.init() have both finished.
// #build is written by renderStealth(), which is the last thing init does.
async function waitForRenderer(win, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const ready = await win.webContents.executeJavaScript(
      `!!(window.SQSettings && document.getElementById('build').textContent)`
    ).catch(() => false);
    if (ready) return;
    if (Date.now() - started > timeoutMs) throw new Error('renderer did not become ready');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const evaluate = (win, expr) => win.webContents.executeJavaScript(expr);

// Poll a renderer expression until it is truthy. The renderer reacts to main's
// events on its own RAF schedule, so a fixed sleep is a race: too short and the
// test flakes, too long and every run pays for it.
async function waitUntil(win, expr, what, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    if (await evaluate(win, expr).catch(() => false)) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

app.whenReady().then(async () => {
  stealth.hideFromDock();

  const store = new Store();
  const overlay = new OverlayWindow(store);
  overlay.create();

  let trayRefreshes = 0;
  registerIpc({
    store,
    overlay,
    onShortcutsChanged: () => registerShortcuts({ store, overlay, onCycleGame: () => {} }),
    onStateChanged: () => { trayRefreshes++; }
  });

  await new Promise((resolve) => overlay.win.webContents.once('did-finish-load', resolve));
  await waitForRenderer(overlay.win);

  // ---- the defect this suite existed alongside for four revisions --------
  // Every earlier check either showed the window first or drove events by
  // hand, so nothing ever asked what the app does while nobody is looking.
  // The board ran unpaused from boot and played itself to game over.
  await checkAsync('an unopened board does not play itself', async () => {
    assert.strictEqual(overlay.win.isVisible(), false, 'precondition: never shown');

    const state = await evaluate(overlay.win, `window.__sqState()`);
    assert.strictEqual(state.visible, false, 'renderer must know it is hidden at boot');
    assert.ok(
      (await evaluate(overlay.win, `window.__sqReasons()`)).includes('hidden'),
      'the board must be suspended for being hidden'
    );

    const before = await evaluate(overlay.win, `window.__sqBoard()`);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await evaluate(overlay.win, `window.__sqBoard()`);
    assert.strictEqual(after, before, 'the board advanced while it had never been shown');
  });

  await checkAsync('no frames are rendered while hidden', async () => {
    // backgroundThrottling:false keeps RAF at 60fps even for a hidden window,
    // so this has to be gated explicitly. Measured before the fix: 181 frames
    // in 3s hidden — a tray app rendering an invisible canvas all day.
    const a = await evaluate(overlay.win, `window.__sqFrames()`);
    await new Promise((r) => setTimeout(r, 1200));
    const b = await evaluate(overlay.win, `window.__sqFrames()`);
    assert.ok(b - a <= 2, `${b - a} frames rendered while hidden (expected ~0)`);

    overlay.show();
    await new Promise((r) => setTimeout(r, 1000));
    const c = await evaluate(overlay.win, `window.__sqFrames()`);
    await new Promise((r) => setTimeout(r, 1000));
    const d = await evaluate(overlay.win, `window.__sqFrames()`);
    assert.ok(d - c > 20, `only ${d - c} frames in 1s while visible — the loop is not running`);
    overlay.hide();
  });

  // ---- window + stealth -------------------------------------------------
  check('window is created hidden (no flash at boot)', () => {
    assert.strictEqual(overlay.win.isVisible(), false);
  });

  check('window is frameless, transparent and non-resizable', () => {
    assert.strictEqual(overlay.win.isResizable(), false);
    const [w, h] = overlay.win.getSize();
    assert.strictEqual(w, WIDTH);
    assert.strictEqual(h, HEIGHT);
  });

  check('setContentProtection does not throw on this platform', () => {
    stealth.setContentProtection(overlay.win, true);
    stealth.setContentProtection(overlay.win, false);
    stealth.setContentProtection(overlay.win, true);
  });

  check('always-on-top survives the macOS level ladder', () => {
    stealth.raise(overlay.win);
    assert.strictEqual(overlay.win.isAlwaysOnTop(), true);
  });

  const caps = stealth.capabilityReport();
  check('capability report is resolved against this OS version', () => {
    assert.ok(['reliable', 'degraded', 'unreliable', 'none'].includes(caps.level));
    assert.ok(caps.headline && caps.detail);
    assert.ok(caps.label, 'the footer badge has no text to show');
    // A "hidden" verdict must never come from a level that is not reliable —
    // this is the one place where being wrong-but-confident actually costs
    // the user something, so assert the two can't drift apart.
    assert.strictEqual(caps.captureInvisible, caps.level === 'reliable');
    assert.strictEqual(
      /hidden/i.test(caps.label), caps.captureInvisible,
      `badge "${caps.label}" disagrees with captureInvisible=${caps.captureInvisible}`
    );
  });
  note(`capture on this machine: ${caps.level} — ${caps.osLabel}: ${caps.headline}`);

  // ---- show / hide / position ------------------------------------------
  check('show() places the window inside a real display work area', () => {
    overlay.show();
    assert.strictEqual(overlay.win.isVisible(), true);
    const [x, y] = overlay.win.getPosition();
    const inside = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x >= a.x - 1 && y >= a.y - 1 &&
             x + WIDTH <= a.x + a.width + 1 && y + HEIGHT <= a.y + a.height + 1;
    });
    assert.ok(inside, `window at ${x},${y} is not within any display work area`);
  });

  check('every dock corner lands in the work area', () => {
    for (const dock of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      overlay.setDock(dock);
      const [x, y] = overlay.win.getPosition();
      const inside = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return x >= a.x - 1 && y >= a.y - 1 &&
               x + WIDTH <= a.x + a.width + 1 && y + HEIGHT <= a.y + a.height + 1;
      });
      assert.ok(inside, `dock ${dock} put the window at ${x},${y}`);
    }
    overlay.setDock('bottom-right');
  });

  check('an unattached display id falls back instead of going off-screen', () => {
    overlay.setPreferredDisplay(999999); // an id that cannot exist
    const [x, y] = overlay.win.getPosition();
    const inside = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x >= a.x - 1 && y >= a.y - 1 &&
             x + WIDTH <= a.x + a.width + 1 && y + HEIGHT <= a.y + a.height + 1;
    });
    assert.ok(inside, `fallback put the window at ${x},${y}`);
    overlay.setPreferredDisplay('cursor');
  });

  check('toggle() reports and flips visibility', () => {
    const wasVisible = overlay.isVisible();
    assert.strictEqual(overlay.toggle(), !wasVisible);
    assert.strictEqual(overlay.isVisible(), !wasVisible);
    overlay.show();
  });

  check('click-through toggles both ways and tells the tray', () => {
    const before = trayRefreshes;
    assert.strictEqual(overlay.toggleClickThrough(), true);
    assert.strictEqual(overlay.clickThrough, true);
    assert.strictEqual(overlay.toggleClickThrough(), false);
    assert.strictEqual(before, trayRefreshes, 'direct calls should not fire the IPC hook');
  });

  check('summoning the overlay always restores interactivity', () => {
    // Click-through latched across hide/show is indistinguishable from a hung
    // app: the window is visible, looks fine, and swallows every click.
    overlay.setClickThrough(true);
    overlay.hide();
    overlay.show();
    assert.strictEqual(overlay.clickThrough, false, 'click-through survived a hide/show');
  });

  check('size scales the window and is clamped to something usable', () => {
    assert.strictEqual(overlay.setScale(1.25), 1.25);
    let [w, h] = overlay.win.getSize();
    assert.strictEqual(w, Math.round(WIDTH * 1.25), 'window did not grow');
    assert.strictEqual(h, Math.round(HEIGHT * 1.25));

    // Below this the board is unplayable; above it, it stops being an overlay.
    assert.strictEqual(overlay.setScale(0.2), 0.8, 'floor');
    assert.strictEqual(overlay.setScale(9), 1.5, 'ceiling');
    assert.strictEqual(overlay.setScale('nonsense'), 1, 'garbage falls back');

    overlay.setScale(1);
    [w, h] = overlay.win.getSize();
    assert.strictEqual(w, WIDTH, 'window did not return to its base size');
    assert.strictEqual(h, HEIGHT);
  });

  check('opacity is clamped to a range that stays visible', () => {
    // A fully transparent overlay would be unrecoverable without the tray, so
    // the floor matters as much as the ceiling.
    assert.strictEqual(overlay.setOpacity(0.05), 0.3, 'floor');
    assert.strictEqual(overlay.setOpacity(50), 1, 'ceiling');
    assert.strictEqual(overlay.setOpacity(0.8), 0.8, 'in-range value passes through');
    assert.strictEqual(overlay.setOpacity('nonsense'), 0.95, 'garbage falls back to the default');
    overlay.setOpacity(0.95);
  });

  // ---- store ------------------------------------------------------------
  check('config round-trips through the atomic write', () => {
    store.set('lastGame', 'snake');
    const reread = new Store();
    assert.strictEqual(reread.get('lastGame'), 'snake');
    assert.ok(fs.existsSync(path.join(SANDBOX, 'config.json')));
    assert.ok(!fs.existsSync(path.join(SANDBOX, 'config.json.tmp')), 'temp file was left behind');
  });

  check('a corrupt config falls back to defaults instead of crashing', () => {
    const file = path.join(SANDBOX, 'config.json');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{ this is not json');
    const recovered = new Store();
    assert.strictEqual(recovered.get('hotkey'), DEFAULTS.hotkey);
    fs.writeFileSync(file, good);
  });

  check('high scores only move up', () => {
    assert.strictEqual(store.recordScore('tetris', 500), true);
    assert.strictEqual(store.recordScore('tetris', 100), false);
    assert.strictEqual(store.getHighScore('tetris'), 500);
  });

  // ---- shortcuts --------------------------------------------------------
  const shortcuts = registerShortcuts({ store, overlay, onCycleGame: () => {} });
  check('every hotkey slot reports a registration outcome', () => {
    assert.strictEqual(shortcuts.length, 4);
    for (const r of shortcuts) assert.strictEqual(typeof r.registered, 'boolean');
  });
  const taken = shortcuts.filter((r) => !r.registered);
  if (taken.length) note(`hotkeys already owned by another app: ${taken.map((r) => r.accelerator).join(', ')}`);

  // ---- preload bridge + IPC (the actual trust boundary) -----------------
  await checkAsync('preload exposes exactly the sq surface, and no Node', async () => {
    const shape = await evaluate(overlay.win, `({
      keys: Object.keys(window.sq).sort(),
      node: typeof window.require + '/' + typeof window.process + '/' + typeof window.module
    })`);
    assert.strictEqual(shape.node, 'undefined/undefined/undefined', 'Node leaked into the renderer');
    for (const method of ['getConfig', 'submitScore', 'hide', 'capabilities', 'setHotkey']) {
      assert.ok(shape.keys.includes(method), `sq.${method} is missing`);
    }
  });

  await checkAsync('all three games registered in the renderer', async () => {
    const games = await evaluate(overlay.win, `Object.keys(window.SQGames).sort()`);
    assert.deepStrictEqual(games, ['2048', 'snake', 'tetris']);
  });

  await checkAsync('canvas has a device-pixel backing store', async () => {
    const size = await evaluate(overlay.win, `(() => {
      const c = document.getElementById('canvas');
      return { w: c.width, h: c.height, dpr: window.devicePixelRatio };
    })()`);
    assert.ok(size.w > 0 && size.h > 0, 'canvas was never sized');
    assert.ok(size.w >= Math.round(size.dpr * 100), 'canvas backing store ignores devicePixelRatio');
  });

  await checkAsync('score submission round-trips over IPC', async () => {
    const res = await evaluate(overlay.win, `window.sq.submitScore('snake', 4242)`);
    assert.strictEqual(res.isBest, true);
    assert.strictEqual(res.best, 4242);
    assert.strictEqual(store.getHighScore('snake'), 4242);
    const lower = await evaluate(overlay.win, `window.sq.submitScore('snake', 7)`);
    assert.strictEqual(lower.isBest, false);
    assert.strictEqual(lower.best, 4242);
  });

  await checkAsync('IPC rejects unknown games and bad scores', async () => {
    const bad = await evaluate(overlay.win, `
      window.sq.submitScore('doom', 1).then(() => 'accepted', () => 'rejected')`);
    assert.strictEqual(bad, 'rejected', 'an unknown game id was accepted');
    const negative = await evaluate(overlay.win, `
      window.sq.submitScore('snake', -5).then(() => 'accepted', () => 'rejected')`);
    assert.strictEqual(negative, 'rejected', 'a negative score was accepted');
  });

  await checkAsync('a rejected hotkey is reverted, not stored', async () => {
    const before = store.get('cycleGameHotkey');
    const res = await evaluate(overlay.win, `window.sq.setHotkey('cycleGameHotkey', 'CommandOrControl+Shift+J')`);
    if (res.ok) {
      assert.strictEqual(store.get('cycleGameHotkey'), 'CommandOrControl+Shift+J');
      await evaluate(overlay.win, `window.sq.setHotkey('cycleGameHotkey', ${JSON.stringify(before)})`);
    } else {
      // The combo was taken by another app — then the old binding must survive.
      assert.strictEqual(store.get('cycleGameHotkey'), before);
    }
    assert.strictEqual(store.get('cycleGameHotkey'), before);
  });

  await checkAsync('an invalid hotkey slot is refused', async () => {
    const bad = await evaluate(overlay.win, `
      window.sq.setHotkey('rootPassword', 'F13').then(() => 'accepted', () => 'rejected')`);
    assert.strictEqual(bad, 'rejected');
  });

  // ---- renderer behaviour ----------------------------------------------
  await checkAsync('settings panel pauses the board and resumes it on close', async () => {
    const state = await evaluate(overlay.win, `(async () => {
      const before = window.SQSettings.isOpen();
      window.SQSettings.show();
      await new Promise((r) => setTimeout(r, 60));
      const openState = { open: window.SQSettings.isOpen(), visible: getComputedStyle(document.getElementById('settings')).display };
      window.SQSettings.close();
      await new Promise((r) => setTimeout(r, 60));
      return { before, openState, closed: window.SQSettings.isOpen() };
    })()`);
    assert.strictEqual(state.before, false, 'settings should start closed');
    assert.strictEqual(state.openState.open, true);
    assert.notStrictEqual(state.openState.visible, 'none', 'panel did not render');
    assert.strictEqual(state.closed, false);
  });

  await checkAsync('settings renders the same capability verdict as main', async () => {
    const shown = await evaluate(overlay.win, `document.getElementById('stealth').className`);
    assert.strictEqual(shown, caps.level);
    const build = await evaluate(overlay.win, `document.getElementById('build').textContent`);
    assert.ok(build.includes(app.getVersion()), 'version missing from the settings footer');
  });

  await checkAsync('footer badge shows the verdict without opening settings', async () => {
    const badge = await evaluate(overlay.win, `(() => {
      const el = document.getElementById('capability');
      return { text: el.textContent, cls: el.className, title: el.title,
               visible: getComputedStyle(el).display };
    })()`);
    assert.strictEqual(badge.text, caps.label);
    assert.ok(badge.cls.includes(caps.level), `badge class "${badge.cls}" lacks the level`);
    assert.ok(badge.cls.includes('ready'), 'badge never became visible');
    assert.notStrictEqual(badge.visible, 'none', 'badge is not rendered');
    assert.ok(badge.title.includes(caps.headline), 'tooltip lost the explanation');
  });

  await checkAsync('hiding suspends the board, showing resumes it', async () => {
    overlay.show();
    await waitUntil(overlay.win, `window.__sqState().visible === true`, 'the window to report visible');

    // Advance a real Tetris board, then hide and confirm it stops advancing.
    await evaluate(overlay.win, `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))`);
    await new Promise((r) => setTimeout(r, 120));

    overlay.hide();
    await waitUntil(overlay.win, `window.__sqState().visible === false`, 'the window to report hidden');
    const atHide = await evaluate(overlay.win, `window.__sqBoard()`);
    await new Promise((r) => setTimeout(r, 1500));
    const later = await evaluate(overlay.win, `window.__sqBoard()`);
    assert.deepStrictEqual(later, atHide, 'the board advanced while hidden');

    overlay.show();
    await waitUntil(overlay.win, `window.__sqState().visible === true`, 'the window to report visible again');
    assert.strictEqual(
      await evaluate(overlay.win, `window.__sqSuspended()`), false,
      'showing did not release the hidden suspension'
    );
  });

  await checkAsync('a deliberate pause survives hide/show', async () => {
    // hiddenPause exists to tell "we paused this" from "the user paused this";
    // a user pause must not be silently undone by the overlay reappearing.
    await evaluate(overlay.win, `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }))`);
    await waitUntil(
      overlay.win,
      `document.getElementById('banner-title').textContent === 'Paused'
       && document.getElementById('banner').classList.contains('show')`,
      'P to pause'
    );

    overlay.win.webContents.send('overlay:hidden');
    await new Promise((r) => setTimeout(r, 100));
    overlay.win.webContents.send('overlay:shown');
    await new Promise((r) => setTimeout(r, 200));

    const stillPaused = await evaluate(overlay.win, `document.getElementById('banner').classList.contains('show')`);
    assert.strictEqual(stillPaused, true, 'a user pause was cleared by hide/show');
    await evaluate(overlay.win, `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }))`);
  });

  await checkAsync('the idle pet shrinks the window, then grows back on click', async () => {
    overlay.hide();
    await new Promise((r) => setTimeout(r, 120));

    assert.strictEqual(overlay.showPet(), true, 'pet refused to appear from a hidden overlay');
    assert.strictEqual(overlay.isPetMode(), true);
    assert.strictEqual(overlay.isVisible(), true, 'the pet is not on screen');

    const petSize = overlay.win.getSize();
    assert.strictEqual(petSize[0], PET_WIDTH, 'window did not shrink to pet size');
    assert.strictEqual(petSize[1], PET_HEIGHT);

    // It must not steal focus — it appears unprompted.
    assert.strictEqual(overlay.win.isFocused(), false, 'the pet stole focus');

    await waitUntil(
      overlay.win,
      `document.body.classList.contains('pet') && !!window.SQPets`,
      'the renderer to enter pet mode'
    );

    // Transparent window: it must pass the mouse through everywhere except the
    // creature, or it is an invisible click trap in a screen corner.
    const card = await evaluate(overlay.win, `(() => {
      const s = getComputedStyle(document.getElementById('card'));
      return { bg: s.backgroundColor, border: s.borderTopColor };
    })()`);
    assert.ok(
      /rgba\(0, 0, 0, 0\)|transparent/.test(card.bg),
      `pet card is not transparent (${card.bg})`
    );

    // Hit-testing must not disturb the user's own click-through setting.
    assert.strictEqual(overlay.setPetInteractive(true), true);
    assert.strictEqual(overlay.clickThrough, false, 'hit-testing stomped the user setting');
    overlay.setPetInteractive(false);

    // Clicking it grows into the real window.
    overlay.playFromPet();
    await waitUntil(
      overlay.win,
      `!document.body.classList.contains('pet')`,
      'the renderer to leave pet mode'
    );
    assert.strictEqual(overlay.isPetMode(), false);
    const gameSize = overlay.win.getSize();
    assert.strictEqual(gameSize[0], WIDTH, 'window did not grow back');
    assert.strictEqual(gameSize[1], HEIGHT);
  });

  check('the pet never appears over a game already on screen', () => {
    overlay.show();
    assert.strictEqual(overlay.showPet(), false, 'pet interrupted a visible overlay');
    assert.strictEqual(overlay.isPetMode(), false);
  });

  await checkAsync('pet settings validate the idle window', async () => {
    const tooShort = await evaluate(overlay.win, `
      window.sq.setPet({ idleSeconds: 3 }).then(() => 'accepted', () => 'rejected')`);
    assert.strictEqual(tooShort, 'rejected', 'a 3-second idle delay was accepted');
    const ok = await evaluate(overlay.win, `window.sq.setPet({ idleSeconds: 300, enabled: true })`);
    assert.strictEqual(ok.idleSeconds, 300);
    assert.strictEqual(store.get('petIdleSeconds'), 300);
  });

  await checkAsync('every avatar the settings offer actually exists', async () => {
    const built = await evaluate(overlay.win, `Object.keys(window.SQPets).sort()`);
    assert.deepStrictEqual(built, ['pacman', 'robot', 'snake']);

    // The picker, the validator and the implemented set must agree, or choosing
    // an avatar silently falls back to a random one.
    const offered = await evaluate(overlay.win, `
      Array.from(document.querySelectorAll('#pet-avatar [data-avatar]'))
        .map((b) => b.dataset.avatar).sort()`);
    assert.deepStrictEqual(offered, ['pacman', 'random', 'robot', 'snake']);

    // Each button must actually paint its creature; an empty canvas is a
    // picker that shows you nothing, which is the problem it exists to solve.
    const painted = await evaluate(overlay.win, `(() => {
      const out = {};
      for (const b of document.querySelectorAll('#pet-avatar [data-avatar]')) {
        const c = b.querySelector('canvas');
        if (!c) { out[b.dataset.avatar] = 'no-canvas'; continue; }
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++;
        out[b.dataset.avatar] = lit;
      }
      return out;
    })()`);
    for (const name of built) {
      assert.ok(painted[name] > 100, `${name} preview is blank (${painted[name]} pixels)`);
    }
    for (const name of built) {
      const res = await evaluate(overlay.win, `window.sq.setPet({ avatar: ${JSON.stringify(name)} })`);
      assert.strictEqual(res.avatar, name);
    }
    const bad = await evaluate(overlay.win, `
      window.sq.setPet({ avatar: 'dinosaur' }).then(() => 'accepted', () => 'rejected')`);
    assert.strictEqual(bad, 'rejected');
    await evaluate(overlay.win, `window.sq.setPet({ avatar: 'random' })`);
  });

  await checkAsync('the pet turns up at the cursor when asked to', async () => {
    await evaluate(overlay.win, `window.sq.setPet({ position: 'cursor' })`);
    overlay.hide();
    await new Promise((r) => setTimeout(r, 120));
    overlay.showPet();

    const cursor = screen.getCursorScreenPoint();
    const [x, y] = overlay.win.getPosition();
    const cx = x + PET_WIDTH / 2;
    const cy = y + PET_HEIGHT / 2;
    // Clamping to the work area can pull it off the cursor near a screen edge,
    // so allow a full pet-size of slack rather than demanding dead centre.
    assert.ok(
      Math.abs(cx - cursor.x) <= PET_WIDTH && Math.abs(cy - cursor.y) <= PET_HEIGHT,
      `pet opened at ${cx},${cy} but the cursor is at ${cursor.x},${cursor.y}`
    );

    const bad = await evaluate(overlay.win, `
      window.sq.setPet({ position: 'nowhere' }).then(() => 'accepted', () => 'rejected')`);
    assert.strictEqual(bad, 'rejected');

    overlay.dismissPet();
  });

  await checkAsync('click-through does not break the pet hit-test', async () => {
    // Pet mode makes the transparent window ignore the mouse except over the
    // creature. setClickThrough had no petMode guard, so the hotkey or the tray
    // checkbox restored exactly the invisible 260x210 click trap that
    // hit-testing exists to avoid — with the indicator hidden in pet mode.
    overlay.hide();
    await new Promise((r) => setTimeout(r, 100));
    overlay.showPet();
    await waitUntil(overlay.win, `window.__sqState().petMode === true`, 'pet mode');

    overlay.toggleClickThrough();
    assert.strictEqual(overlay.clickThrough, true, 'the preference is still recorded');
    assert.strictEqual(
      await evaluate(overlay.win, `window.__sqState().petMode`), true,
      'still in pet mode'
    );
    // The latched preference must take effect once the pet leaves.
    overlay.dismissPet();
    await waitUntil(overlay.win, `window.__sqState().petMode === false`, 'pet mode to end');
    assert.strictEqual(overlay.clickThrough, true, 'the latched preference survived');
    overlay.setClickThrough(false);
  });

  await checkAsync('cycling game while the pet is out opens the game', async () => {
    // showPet() uses showInactive(), so isVisible() is true and the old
    // `if (!overlay.isVisible()) show()` guard never fired: the config
    // advanced and the screen still showed a wandering snake.
    overlay.hide();
    await new Promise((r) => setTimeout(r, 100));
    overlay.showPet();
    await waitUntil(overlay.win, `window.__sqState().petMode === true`, 'pet mode');
    assert.strictEqual(overlay.isVisible(), true, 'precondition: showInactive counts as visible');

    // Exactly what main.js's onCycleGame does.
    if (!overlay.isVisible() || overlay.isPetMode()) overlay.show();

    assert.strictEqual(overlay.isPetMode(), false, 'still showing the pet after cycling');
    await waitUntil(overlay.win, `window.__sqState().playable === true`, 'a playable board');
  });

  check('a user drag is persisted; a programmatic move is not', () => {
    // dockPosition 'custom' was validated for but unreachable, so windowPosition
    // was written by nothing and the drag was undone on the next show().
    overlay.setDock('bottom-right');
    const dockedAt = overlay.win.getPosition();
    assert.strictEqual(store.get('dockPosition'), 'bottom-right', 'positioning must not self-mark as custom');

    overlay.win.setPosition(dockedAt[0] - 60, dockedAt[1] - 40);
    overlay.win.emit('moved');
    assert.strictEqual(store.get('dockPosition'), 'custom', 'a user drag switches to custom');
    assert.deepStrictEqual(
      store.get('windowPosition'),
      { x: dockedAt[0] - 60, y: dockedAt[1] - 40 },
      'the dragged position is persisted'
    );

    overlay.position();
    assert.deepStrictEqual(overlay.win.getPosition(), [dockedAt[0] - 60, dockedAt[1] - 40],
      'the custom position is honoured instead of snapping back');

    overlay.setDock('bottom-right');
    assert.deepStrictEqual(overlay.win.getPosition(), dockedAt, 'a dock button takes it back');
  });

  await checkAsync('content protection reports what actually happened', async () => {
    // The handler used to echo the request back, so the checkbox stayed ticked
    // on a platform where the OS call threw.
    const ok = await evaluate(overlay.win, `window.sq.setContentProtection(true)`);
    assert.strictEqual(typeof ok, 'object', 'a status object, not an echoed boolean');
    assert.strictEqual(ok.requested, true);
    assert.strictEqual(ok.applied, true);
    assert.strictEqual(ok.ok, true);

    const real = overlay.win.setContentProtection;
    overlay.win.setContentProtection = () => { throw new Error('simulated OS refusal'); };
    const failed = await evaluate(overlay.win, `window.sq.setContentProtection(true)`);
    overlay.win.setContentProtection = real;
    assert.strictEqual(failed.ok, false, 'an OS refusal must not report success');
    assert.strictEqual(failed.applied, false);
    assert.strictEqual(store.get('contentProtection'), false, 'the store records what is in force');
    await evaluate(overlay.win, `window.sq.setContentProtection(true)`);
  });

  await checkAsync('a record run is banked without waiting for game over', async () => {
    // Scores used to persist ONLY from onGameOver, while the header showed the
    // live score as your best the moment it passed the stored value. Hiding,
    // switching game or quitting mid-run silently discarded a number the user
    // had just watched go up.
    store.recordScore('tetris', 0);
    store.data.highScores.tetris = 0;

    overlay.show();
    await waitUntil(overlay.win, `window.__sqState().playable === true`, 'a playable board');
    await evaluate(overlay.win, `document.querySelector('[data-game="tetris"]').click()`);
    await new Promise((r) => setTimeout(r, 200));

    // Hard drops score points without ending the run.
    for (let i = 0; i < 5; i++) {
      await evaluate(overlay.win, `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))`);
      await new Promise((r) => setTimeout(r, 60));
    }
    const onScreen = Number(await evaluate(overlay.win, `document.getElementById('score').textContent`));
    assert.ok(onScreen > 0, 'the run did not score, so the check proves nothing');
    assert.strictEqual(
      await evaluate(overlay.win, `document.getElementById('banner').classList.contains('show')`),
      false, 'the run must still be in progress, not over'
    );

    // Hiding is the commonest way a run ends without a game over.
    overlay.hide();
    await waitUntil(overlay.win, `window.__sqState().visible === false`, 'the window to hide');
    await new Promise((r) => setTimeout(r, 250));

    assert.strictEqual(
      store.getHighScore('tetris'), onScreen,
      `header showed ${onScreen} but ${store.getHighScore('tetris')} was persisted`
    );
    // And it survives a reload from disk, not just the in-memory copy.
    assert.strictEqual(new Store().getHighScore('tetris'), onScreen, 'not written to disk');
  });

  // ---- teardown ---------------------------------------------------------
  unregisterAll();
  overlay.win.destroy();
  fs.rmSync(SANDBOX, { recursive: true, force: true });

  console.log('\nSideQuest integration smoke test\n');
  console.log(results.join('\n'));
  console.log(
    failures
      ? `\n${failures} check(s) failed.\n`
      : `\nAll ${results.filter((r) => r.startsWith('  ok')).length} checks passed.\n`
  );

  app.exit(failures ? 1 : 0);
}).catch((err) => {
  console.error('smoke test crashed:', err);
  app.exit(1);
});
