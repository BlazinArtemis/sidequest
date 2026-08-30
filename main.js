// main.js — SideQuest entry point.
// Boot order matters: single-instance lock -> dock hidden -> window created
// hidden -> shortcuts. Anything that touches BrowserWindow must wait for
// app.whenReady().

const { app, Tray, Menu, nativeImage, screen, powerMonitor } = require('electron');
const path = require('path');

const { Store } = require('./src/core/store');
const { IdleWatcher } = require('./src/core/idle');
const stealth = require('./src/core/stealth');
const { OverlayWindow } = require('./src/managers/overlay.window');
const { registerShortcuts, unregisterAll } = require('./src/managers/shortcuts');
const { registerIpc } = require('./src/ipc');
const { GAMES } = require('./src/core/constants');

// A second instance would register the same global hotkeys and lose the race,
// leaving the user with a hotkey that does nothing.
//
// The exit has to say something. This app has no Dock icon and no window at
// startup, so a silent quit here is indistinguishable from "double-clicking the
// app does nothing" — with no way for the user to tell whether it launched, is
// already running, or is broken. The running instance shows its overlay via the
// 'second-instance' handler below, which is the visible half of this answer.
if (!app.requestSingleInstanceLock()) {
  console.log('[sidequest] another instance already holds the lock — showing it and exiting');
  app.quit();
  return;
}

let store = null;
let overlay = null;
let tray = null;
let shortcutResults = [];

// Prevents the app from showing in the Dock and in Cmd-Tab. Must run before
// the first window is created, so it goes here rather than in whenReady.
stealth.hideFromDock();

app.on('second-instance', () => {
  if (overlay) overlay.show();
});

app.whenReady().then(() => {
  store = new Store();
  overlay = new OverlayWindow(store);
  overlay.create();

  const applyShortcuts = () => registerShortcuts({
    store,
    overlay,
    onStateChanged: refreshTray,
    onCycleGame: () => {
      const current = store.get('lastGame');
      const next = GAMES[(GAMES.indexOf(current) + 1) % GAMES.length];
      store.set('lastGame', next);
      if (overlay.win && !overlay.win.isDestroyed()) {
        overlay.win.webContents.send('overlay:set-game', next);
      }
      // showPet() uses showInactive(), so isVisible() is true while the pet is
      // out — the old `!isVisible()` guard never fired and the user got a
      // silent game change behind a wandering snake. show() exits pet mode.
      if (!overlay.isVisible() || overlay.isPetMode()) overlay.show();
    }
  });

  shortcutResults = applyShortcuts();
  registerIpc({
    store,
    overlay,
    onShortcutsChanged: () => {
      shortcutResults = applyShortcuts();
      refreshTray();
      return shortcutResults;
    },
    onStateChanged: refreshTray
  });
  createTray();
  watchDisplays();
  watchIdle();
  console.log('[sidequest] ready — tray installed, overlay hidden');
}).catch((err) => {
  // Without this the app becomes unreachable AND unquittable: no window, no
  // Dock icon, no tray, just a process. process.on('uncaughtException') does
  // not catch promise rejections, so this handler is the only safety net.
  console.error('[sidequest] startup failed:', err && err.stack ? err.stack : err);
  try {
    if (!tray) createTray();
  } catch (trayErr) {
    console.error('[sidequest] tray could not be installed either:', trayErr.message);
    app.quit();
  }
});

// A throw in whenReady would otherwise leave a tray-less, window-less process
// running with no way to reach or quit it.
process.on('uncaughtException', (err) => {
  console.error('[sidequest] fatal:', err && err.stack ? err.stack : err);
});

// The same 16x16 glyph build/make-tray-icon.js generates, inlined as a last
// resort. With no Dock icon, no taskbar entry and no window at startup, an
// empty tray image is not a cosmetic problem — it is an app the user cannot
// reach or quit. electron-builder treats build/ as its buildResources
// directory, so a packaging change that drops the PNG would do exactly that.
const TRAY_FALLBACK =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaUlEQVR42mNgGAVUBSVA/BqI/wPx' +
  'aSCej4ZPQ+VeQ9WigBCo5HkgjoGy0XEAEFsg8UOQDdgMxPuBOAGIBYC4AYg/oxmQAzUExt9MqgH/' +
  'oWIgV8xGN4AYL4DweyCWAeJudC9QHIijgAIAACRcOdvjOajlAAAAAElFTkSuQmCC';

// With the Dock icon hidden there is no way back into the app except the tray,
// so the tray is not optional.
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'trayTemplate.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn('[tray] %s missing or unreadable — using the inline glyph', iconPath);
    image = nativeImage.createFromBuffer(Buffer.from(TRAY_FALLBACK, 'base64'));
  }
  if (stealth.IS_MAC) image.setTemplateImage(true);

  tray = new Tray(image);
  // Windows only: there, left-click is the expected show/hide gesture and the
  // menu lives on right-click. On macOS a left-click already opens the menu,
  // so binding this too would fight it.
  if (!stealth.IS_MAC) tray.on('click', () => overlay.toggle());
  refreshTray();
}

// "CommandOrControl+Shift+G" is the storage format, not something to show a
// user. The menu item's own `accelerator` field is not an option here: it would
// bind the key to the menu, competing with the global shortcut that already
// owns it. (renderer/settings.js has its own copy — main and the sandboxed
// renderer cannot share a module.)
function formatAccelerator(accelerator) {
  if (!accelerator) return 'unset';
  if (!stealth.IS_MAC) return accelerator.replace(/CommandOrControl/g, 'Ctrl');
  return accelerator
    .replace(/CommandOrControl|Command/g, '⌘')
    .replace(/Control/g, '⌃')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '');
}

// The menu is rebuilt rather than mutated because every checkbox in it mirrors
// state that a hotkey can change behind the menu's back — a statically built
// menu shows a stale tick the first time someone uses the click-through hotkey.
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;

  const failed = shortcutResults.filter((r) => !r.registered);
  tray.setToolTip(failed.length ? `SideQuest — ${failed.length} hotkey conflict(s)` : 'SideQuest');

  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const preferred = store.get('preferredDisplay');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show / hide  ${formatAccelerator(store.get('hotkey'))}`, click: () => overlay.toggle() },
    {
      label: `Click-through  ${formatAccelerator(store.get('clickThroughHotkey'))}`,
      type: 'checkbox',
      checked: overlay.clickThrough,
      click: () => { overlay.toggleClickThrough(); refreshTray(); }
    },
    { label: 'Settings…', click: () => overlay.openSettings() },
    { type: 'separator' },
    ...['bottom-right', 'bottom-left', 'top-right', 'top-left'].map((d) => ({
      label: `Dock: ${d}`,
      type: 'radio',
      checked: store.get('dockPosition') === d,
      click: () => { overlay.setDock(d); refreshTray(); }
    })),
    { type: 'separator' },
    {
      label: 'Display',
      submenu: [
        {
          label: 'Follow cursor',
          type: 'radio',
          checked: preferred === 'cursor',
          click: () => { overlay.setPreferredDisplay('cursor'); refreshTray(); }
        },
        {
          label: 'Secondary display',
          type: 'radio',
          checked: preferred === 'secondary',
          // Nothing to dock to on a laptop-only session; stealth.displayFor()
          // would silently fall back, so don't offer a choice that does nothing.
          enabled: displays.length > 1,
          click: () => { overlay.setPreferredDisplay('secondary'); refreshTray(); }
        },
        { type: 'separator' },
        ...displays.map((d) => ({
          label: `${d.size.width}×${d.size.height}${d.id === primaryId ? ' (primary)' : ''}`,
          type: 'radio',
          checked: preferred === d.id,
          click: () => { overlay.setPreferredDisplay(d.id); refreshTray(); }
        }))
      ]
    },
    { type: 'separator' },
    { label: 'Quit SideQuest', click: () => app.quit() }
  ]));
}

// Watch for the machine going idle and send the pet out.
//
// powerMonitor.getSystemIdleTime() is seconds since the last input anywhere on
// the system. It reads a counter the OS already keeps — it is not a key or
// mouse hook, and it needs no permission, which keeps the "asks for nothing"
// story in §2.4 intact.
function watchIdle() {
  const watcher = new IdleWatcher(() => ({
    enabled: store.get('petEnabled'),
    idleSeconds: store.get('petIdleSeconds')
  }));

  // 5s is well under the shortest selectable delay (30s), so the pet is never
  // more than one poll late.
  setInterval(() => {
    const due = watcher.poll(powerMonitor.getSystemIdleTime(), {
      overlayVisible: overlay.isVisible(),
      petVisible: overlay.isPetMode()
    });
    if (due && overlay.showPet()) watcher.markSent();
  }, 5000);
}

// Docking to a specific display id is only meaningful while that display is
// attached; re-resolve on any change so the overlay never lands off-screen.
function watchDisplays() {
  const onChange = () => {
    overlay.position();
    refreshTray();
  };
  screen.on('display-added', onChange);
  screen.on('display-removed', onChange);
  screen.on('display-metrics-changed', onChange);
}

// The overlay is hidden, not closed, so this fires only on a real quit.
app.on('window-all-closed', () => { if (!stealth.IS_MAC) app.quit(); });
app.on('will-quit', () => unregisterAll());
