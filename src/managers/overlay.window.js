// src/managers/overlay.window.js
// One window. Created hidden at boot, then shown/hidden by hotkey — creating
// it lazily on first hotkey press costs ~400ms of white flash, which is the
// one thing that would give the overlay away.

const path = require('path');
const { BrowserWindow, screen, shell } = require('electron');
const stealth = require('../core/stealth');

const WIDTH = 340;
const HEIGHT = 460;
// The idle pet is the same window shrunk down. A second BrowserWindow would
// need its own stealth flags, its own always-on-top ladder and its own
// positioning — the whole reason this app is one window (spec 1.3).
// Roomier than the creature needs, because the window is transparent and
// click-through except over the snake itself — so the extra area costs the user
// nothing and gives it somewhere to actually roam.
const PET_WIDTH = 260;
const PET_HEIGHT = 210;
const MARGIN = 24; // gap from the screen edge when docked

class OverlayWindow {
  constructor(store) {
    this.store = store;
    this.win = null;
    this.clickThrough = false;
    this.petMode = false;
  }

  // User size preference. Clamped rather than trusted: the games scale to
  // whatever they are given, but a 40%-size board is unplayable and a 300% one
  // stops being an overlay.
  scaleFactor() {
    const s = Number(this.store.get('scale'));
    return Number.isFinite(s) ? Math.min(1.5, Math.max(0.8, s)) : 1;
  }

  petScaleFactor() {
    const s = Number(this.store.get('petScale'));
    return Number.isFinite(s) ? Math.min(1.8, Math.max(0.7, s)) : 1;
  }

  // Current window size: base dimensions for the mode, times the user's scale.
  // A bigger creature needs a bigger window, or it spends its life pinned
  // against the edges instead of wandering.
  dims() {
    if (this.petMode) {
      const p = this.petScaleFactor();
      return { w: Math.round(PET_WIDTH * p), h: Math.round(PET_HEIGHT * p) };
    }
    const s = this.scaleFactor();
    return { w: Math.round(WIDTH * s), h: Math.round(HEIGHT * s) };
  }

  setPetScale(value) {
    const n = Number(value);
    const clamped = Number.isFinite(n) ? Math.min(1.8, Math.max(0.7, n)) : 1;
    this.store.set('petScale', clamped);
    if (this.petMode) {
      this.applySize();
      this.win.webContents.send('overlay:pet-scale', clamped);
    }
    return clamped;
  }

  setScale(value) {
    const n = Number(value);
    const clamped = Number.isFinite(n) ? Math.min(1.5, Math.max(0.8, n)) : 1;
    this.store.set('scale', clamped);
    this.applySize();
    return clamped;
  }

  create() {
    this.win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,              // never true — we position first, then show
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // The overlay must take key events (arrow keys drive the game), so
      // focusable stays true. This is the deliberate difference from a
      // Cluely-style answer bar, which never wants focus.
      focusable: true,
      acceptFirstMouse: true,
      ...(stealth.IS_MAC && {
        type: 'panel',           // floats above full-screen apps on macOS
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: -100, y: -100 }
      }),
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false // keep the game loop running when unfocused
      }
    });

    this.win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'overlay.html'));

    // A game overlay has no business navigating anywhere. Deny everything.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());

    stealth.applyStealth(this.win, {
      contentProtection: this.store.get('contentProtection')
    });

    this.win.setOpacity(this.store.get('opacity'));
    this.position();

    // Remember a free-dragged position so the window reopens where the user left it.
    this.win.on('moved', () => {
      if (this.store.get('dockPosition') !== 'custom') return;
      const [x, y] = this.win.getPosition();
      this.store.set('windowPosition', { x, y });
    });

    return this.win;
  }

  // Place the window according to the stored dock preference, on whichever
  // display the cursor is on. Always called BEFORE show() so the window never
  // flashes at its old coordinates.
  position() {
    if (!this.win || this.win.isDestroyed()) return;

    const { w, h } = this.dims();
    const dock = this.store.get('dockPosition');

    // The pet turns up where you left the mouse, which is where you are
    // actually looking. Clamped to the work area so it never straddles an edge.
    if (this.petMode && this.store.get('petPosition') === 'cursor') {
      const pt = screen.getCursorScreenPoint();
      const a = screen.getDisplayNearestPoint(pt).workArea;
      const x = Math.max(a.x, Math.min(a.x + a.width - w, Math.round(pt.x - w / 2)));
      const y = Math.max(a.y, Math.min(a.y + a.height - h, Math.round(pt.y - h / 2)));
      return this.win.setPosition(x, y);
    }

    // A free-dragged position belongs to the full-size window; the pet always
    // docks, so it never lands half off-screen at the saved coordinates.
    if (dock === 'custom' && !this.petMode) {
      const p = this.store.get('windowPosition');
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        // Guard against a saved position on a monitor that is no longer attached.
        const onScreen = screen.getAllDisplays().some((d) => {
          const b = d.workArea;
          return p.x >= b.x - w && p.x <= b.x + b.width && p.y >= b.y - h && p.y <= b.y + b.height;
        });
        if (onScreen) return this.win.setPosition(p.x, p.y);
      }
    }

    const { x: dx, y: dy, width, height } =
      stealth.displayFor(this.store.get('preferredDisplay')).workArea;
    const positions = {
      'top-left': [dx + MARGIN, dy + MARGIN],
      'top-right': [dx + width - w - MARGIN, dy + MARGIN],
      'bottom-left': [dx + MARGIN, dy + height - h - MARGIN],
      'bottom-right': [dx + width - w - MARGIN, dy + height - h - MARGIN]
    };
    const [x, y] = positions[dock] || positions['bottom-right'];
    this.win.setPosition(Math.round(x), Math.round(y));
  }

  // Resize between game and pet. The window is deliberately not resizable by
  // the user, so the flag has to be lifted for the programmatic change.
  applySize() {
    if (!this.win || this.win.isDestroyed()) return;
    const { w, h } = this.dims();
    this.win.setResizable(true);
    this.win.setSize(w, h);
    this.win.setResizable(false);
    this.position();
  }

  show() {
    if (!this.win || this.win.isDestroyed()) return;
    this.exitPet();            // always open at full size, never pet-sized
    this.applySize();          // sizes and positions before showing
    // Summoning the overlay always makes it interactive again. Leaving
    // click-through latched across a hide/show is indistinguishable from a
    // frozen app: the window is right there, looks normal, and ignores every
    // click, with nothing on screen explaining why.
    if (this.clickThrough) this.setClickThrough(false);
    this.win.show();
    this.win.focus();          // required: the game reads keydown in the renderer
    this.win.webContents.send('overlay:shown');
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) return;
    this.exitPet();
    // Tell the renderer first so it can auto-pause before the window vanishes;
    // otherwise a hidden Tetris board keeps dropping pieces.
    this.win.webContents.send('overlay:hidden');
    this.win.hide();
    this.applySize();
  }

  toggle() {
    if (!this.win || this.win.isDestroyed()) return false;

    // The hotkey pressed while the pet is out means "yes, let's play".
    if (this.petMode) { this.playFromPet(); return true; }

    if (this.win.isVisible()) {
      // Visible but unfocused means the user clicked another app, so the game
      // stopped taking keys (only a focused window receives them — see the
      // focusable note above). Hiding here would cost two presses to get back
      // to the thing they actually wanted, so take focus instead.
      if (!this.win.isFocused()) {
        if (this.clickThrough) this.setClickThrough(false);
        this.win.focus();
        this.win.webContents.send('overlay:shown');
        return true;
      }
      this.hide();
      return false;
    }

    this.show();
    return true;
  }

  isVisible() {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  isPetMode() { return this.petMode; }

  // ---- idle pet ---------------------------------------------------------
  // Shown when the machine has been idle a while: a small creature wandering
  // in the corner that opens the game if you click it.

  showPet() {
    if (!this.win || this.win.isDestroyed()) return false;
    if (this.petMode || this.isVisible()) return false;

    this.petMode = true;
    this.applySize();
    // The pet window is fully transparent, so by default the mouse passes
    // straight through it — otherwise it would be an invisible rectangle
    // eating clicks in a screen corner. The renderer hit-tests the cursor
    // against the snake and calls setPetInteractive(true) when you are on it.
    // `forward: true` is what keeps mousemove flowing so that can work at all.
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.webContents.send('overlay:pet-mode', true);
    // showInactive, not show: this appears unprompted, so it must never take
    // focus from whatever the user left on screen.
    this.win.showInactive();
    this.armPetLinger();
    return true;
  }

  // The pet leaves on its own if ignored. It deliberately does NOT leave when
  // the user becomes active: reaching for the mouse to click it *is* activity,
  // so dismissing on that would make the pet impossible to catch.
  armPetLinger(ms = 25000) {
    clearTimeout(this._petTimer);
    this._petTimer = setTimeout(() => this.dismissPet(), ms);
  }

  // Only meaningful in pet mode, where the window is transparent and ignores
  // the mouse except over the snake itself. Deliberately does NOT touch
  // this.clickThrough: that is the user's own setting, with its own tray
  // checkbox and on-screen state, and hit-testing must not stomp on it.
  setPetInteractive(on) {
    if (!this.win || this.win.isDestroyed() || !this.petMode) return false;
    this.win.setIgnoreMouseEvents(!on, { forward: true });
    return !!on;
  }

  // Leave pet mode without deciding what the window does next.
  exitPet() {
    clearTimeout(this._petTimer);
    if (!this.petMode) return;
    this.petMode = false;
    if (this.win && !this.win.isDestroyed()) {
      // Hand the mouse back to whatever the user actually chose.
      this.win.setIgnoreMouseEvents(this.clickThrough, { forward: true });
      this.win.webContents.send('overlay:pet-mode', false);
    }
  }

  dismissPet() {
    if (!this.petMode) return;
    this.exitPet();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    this.applySize();
  }

  // The pet was clicked: grow into the real window and hand over focus.
  playFromPet() {
    this.exitPet();
    this.show();
  }

  // Click-through: the overlay stays on screen but the mouse passes straight
  // to whatever is underneath. `forward: true` keeps mousemove events flowing
  // so the UI can still show hover states.
  setClickThrough(on) {
    if (!this.win || this.win.isDestroyed()) return this.clickThrough;
    this.clickThrough = !!on;
    this.win.setIgnoreMouseEvents(this.clickThrough, { forward: true });
    this.win.webContents.send('overlay:click-through', this.clickThrough);
    return this.clickThrough;
  }

  toggleClickThrough() { return this.setClickThrough(!this.clickThrough); }

  // Settings live inside the overlay rather than in a second window (spec 1.3:
  // one window is the whole point), so opening them means showing the overlay
  // and telling the renderer which panel to raise.
  openSettings() {
    if (!this.win || this.win.isDestroyed()) return;
    // Click-through would make the settings panel unclickable, which reads as
    // a frozen app rather than as a mode.
    if (this.clickThrough) this.setClickThrough(false);
    if (!this.isVisible()) this.show();
    else this.win.focus();
    this.win.webContents.send('overlay:open-settings');
  }

  setOpacity(value) {
    const v = Math.min(1, Math.max(0.3, Number(value) || 0.95));
    this.store.set('opacity', v);
    if (this.win && !this.win.isDestroyed()) this.win.setOpacity(v);
    return v;
  }

  setPreferredDisplay(preference) {
    this.store.set('preferredDisplay', preference);
    this.position();
    return preference;
  }

  setDock(dockPosition) {
    this.store.set('dockPosition', dockPosition);
    this.position();
    return dockPosition;
  }
}

module.exports = { OverlayWindow, WIDTH, HEIGHT, PET_WIDTH, PET_HEIGHT };
