// src/managers/shortcuts.js
// Global shortcuts are deliberately few. Arrow keys are NOT registered
// globally — they are read by the renderer while the overlay has focus.
// Grabbing arrows globally would break every other app on the machine.

const { globalShortcut } = require('electron');

function registerShortcuts({ store, overlay, onCycleGame, onStateChanged }) {
  globalShortcut.unregisterAll();

  // The tray menu shows a click-through tick, and this hotkey changes it from
  // outside the menu — without telling the tray, the tick goes stale the first
  // time the hotkey is used.
  const notify = () => { if (onStateChanged) onStateChanged(); };

  const bindings = [
    [store.get('hotkey'), 'toggle overlay', () => overlay.toggle()],
    [store.get('clickThroughHotkey'), 'toggle click-through', () => { overlay.toggleClickThrough(); notify(); }],
    [store.get('cycleGameHotkey'), 'cycle game', () => onCycleGame && onCycleGame()],
    // Panic key. Always hides, never shows — muscle memory under pressure
    // should only ever remove the overlay, never summon it.
    ['CommandOrControl+Shift+Escape', 'panic hide', () => overlay.hide()]
  ];

  const results = [];
  for (const [accelerator, label, handler] of bindings) {
    if (!accelerator) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, handler);
    } catch (err) {
      ok = false;
    }
    // register() returns false when the OS or another app already owns the
    // combo. Surface it — a silently dead hotkey looks like a broken app.
    results.push({ accelerator, label, registered: ok });
    if (!ok) console.warn(`[shortcuts] "${accelerator}" (${label}) is already taken by another app`);
  }
  return results;
}

function unregisterAll() {
  globalShortcut.unregisterAll();
}

module.exports = { registerShortcuts, unregisterAll };
