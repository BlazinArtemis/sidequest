// src/core/stealth.js
// Everything that makes the overlay invisible to screen capture and sticky
// on top. Derived from OpenCluely's window.manager.js applyStealthMeasures(),
// minus the parts that exist only because it runs four windows at once.
//
// Platform reality (verified against Electron docs + issue tracker):
//   Windows 10 2004+ : setContentProtection -> SetWindowDisplayAffinity(
//                      WDA_EXCLUDEFROMCAPTURE). Window is fully absent from
//                      capture. Older Windows -> WDA_MONITOR, i.e. a BLACK BOX.
//   macOS <= 14      : NSWindow.sharingType = NSWindowSharingNone. Respected by
//                      CoreGraphics capture and by Chromium/WebRTC (Meet, Teams,
//                      Discord, Slack).
//   macOS 15+        : ScreenCaptureKit composites everything; sharingType is
//                      ignored by SCK-based capturers. No known workaround.
//   Linux            : no-op. The overlay WILL be visible in any share.
//
// Consequence for the demo: record on Windows 11, or on macOS <= 14.

const { app, screen } = require('electron');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// process.getSystemVersion() is Electron's, and it reports the OS version the
// user would recognise: "26.0.1" on macOS, "10.0.22631" on Windows. os.release()
// gives the kernel version instead (Darwin 25 for macOS 26), which then needs
// arithmetic that only holds until Apple renames something again — they already
// jumped macOS 15 to 26 while Darwin went 24 to 25.
const SYSTEM_VERSION = process.getSystemVersion();
const VERSION_PARTS = SYSTEM_VERSION.split('.').map((n) => parseInt(n, 10) || 0);
const MAC_MAJOR = IS_MAC ? VERSION_PARTS[0] : 0;
// Windows reports "10.0.<build>"; the build is what matters, not the 10.
const WIN_BUILD = IS_WIN ? VERSION_PARTS[2] : 0;

// macOS 15 Sequoia is where ScreenCaptureKit began compositing protected
// windows into the capture stream regardless of sharingType. Before it,
// WindowServer maintained a separate composite for capture clients with those
// windows omitted — which is what made the window appear to be replaced by
// whatever sat behind it. That second composite is what went away; see spec 2.5.
const MAC_SCK_VERSION = 15;

// Below this Windows build, content protection falls back from
// WDA_EXCLUDEFROMCAPTURE to WDA_MONITOR: hidden, but as a black rectangle.
const WIN_EXCLUDE_BUILD = 19041;

// macOS window levels, most aggressive first. Older Electron / macOS builds
// reject some of these, so we try in order and keep the first that sticks.
const MAC_LEVELS = ['screen-saver', 'pop-up-menu', 'floating'];

function raise(win) {
  if (!win || win.isDestroyed()) return;
  if (IS_MAC) {
    for (const level of MAC_LEVELS) {
      try {
        win.setAlwaysOnTop(true, level, 1);
        return;
      } catch (_) { /* try the next level */ }
    }
    win.setAlwaysOnTop(true);
  } else {
    win.setAlwaysOnTop(true);
  }
}

// Called once at creation.
function applyStealth(win, { contentProtection = true } = {}) {
  if (!win || win.isDestroyed()) return;

  raise(win);

  // Show over full-screen Zoom/Meet without yanking the user to another Space.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setSkipTaskbar(true);

  if (IS_MAC && typeof win.setHiddenInMissionControl === 'function') {
    try { win.setHiddenInMissionControl(true); } catch (_) {}
  }

  setContentProtection(win, contentProtection);

  // Re-assert on every show. Electron has repeatedly regressed content
  // protection across hide/show on Windows (electron#29085, electron#45868),
  // and always-on-top gets dropped when another app forces itself topmost.
  win.on('show', () => {
    raise(win);
    setContentProtection(win, contentProtection);
  });
  win.on('blur', () => setTimeout(() => raise(win), 50));

  // Cheap belt-and-braces. 5s is frequent enough that a lost topmost flag is
  // never visible for long, and rare enough to cost nothing measurable.
  const iv = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(iv);
    if (win.isVisible()) raise(win);
  }, 5000);
  win.on('closed', () => clearInterval(iv));
}

function setContentProtection(win, enabled) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(!!enabled);
  } catch (err) {
    console.warn('[stealth] setContentProtection unavailable:', err.message);
  }
}

// Keep the app out of the macOS Dock and out of Cmd-Tab. Equivalent to
// LSUIElement=1 but applied at runtime, so a dev run behaves like a build.
function hideFromDock() {
  if (IS_MAC && app.dock) {
    try { app.dock.hide(); } catch (_) {}
  }
}

// Optional cosmetic disguise, copied in spirit from OpenCluely's setupStealth().
// This only changes what Activity Monitor / Task Manager show. It is NOT a
// security measure and it does not affect capture behaviour.
function disguiseProcess(name = 'Terminal') {
  try {
    process.title = name;
    if (typeof app.setName === 'function') app.setName(name);
  } catch (_) {}
}

// The display the user is actually looking at (cursor wins over "primary").
function activeDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// Resolve the stored display preference to a real display, falling back to the
// cursor's display whenever the preferred one is not attached right now.
function displayFor(preference) {
  const all = screen.getAllDisplays();

  if (typeof preference === 'number') {
    const match = all.find((d) => d.id === preference);
    if (match) return match;
  }

  if (preference === 'secondary') {
    const primaryId = screen.getPrimaryDisplay().id;
    const other = all.find((d) => d.id !== primaryId);
    if (other) return other;
    // Single-monitor machine: nothing to fall back to but the one display.
  }

  return activeDisplay();
}

// What content protection actually does on THIS machine, not in general.
//
// The whole product claim lives here, so it is resolved against the running OS
// version rather than stated as a blanket "invisible to screen sharing". A
// claim that fails on the reviewer's laptop is worse than a narrower one that
// always holds (spec 2.2), and the UI shows this string verbatim.
//
// level: 'reliable' | 'degraded' | 'unreliable' | 'none'
// `label` is the glanceable footer badge; `headline`/`detail`/`recommendation`
// are the settings card. Both come from here so they can never disagree.
function capabilityReport() {
  if (IS_MAC) {
    const osLabel = `macOS ${MAC_MAJOR}`;

    if (MAC_MAJOR >= MAC_SCK_VERSION) {
      return {
        platform: 'darwin',
        osLabel,
        level: 'unreliable',
        captureInvisible: false,
        label: 'Visible in shares',
        headline: 'Not hidden from most capture on this macOS',
        detail:
          `${osLabel} composites every visible window into the capture stream ` +
          'before an app can opt out, so ScreenCaptureKit-based capturers ' +
          '(Meet, Teams, Discord, Slack, OBS) see this window despite content ' +
          'protection. No application can prevent this — the commercial tools ' +
          'cannot either.',
        recommendation:
          'Put the overlay on a display you are not sharing, or share a single ' +
          'window instead of the whole screen.'
      };
    }

    return {
      platform: 'darwin',
      osLabel,
      level: 'reliable',
      captureInvisible: true,
      label: 'Hidden from capture',
      headline: 'Hidden from screen capture',
      detail:
        `${osLabel} honours NSWindowSharingNone: WindowServer composites a ` +
        'separate frame for capture clients with this window left out, so the ' +
        'capturer receives whatever is behind it.',
      recommendation: 'Verify against the exact conferencing app before recording.'
    };
  }

  if (IS_WIN) {
    const osLabel = `Windows build ${WIN_BUILD || 'unknown'}`;

    if (WIN_BUILD && WIN_BUILD < WIN_EXCLUDE_BUILD) {
      return {
        platform: 'win32',
        osLabel,
        level: 'degraded',
        captureInvisible: false,
        label: 'Shows as a black box',
        headline: 'Hidden, but leaves a black rectangle',
        detail:
          'Windows 10 before build 19041 has no WDA_EXCLUDEFROMCAPTURE, so the ' +
          'window falls back to WDA_MONITOR: the content is hidden but a solid ' +
          'black box appears where the overlay sits.',
        recommendation: 'Update to Windows 10 2004+ or Windows 11, or use a second display.'
      };
    }

    return {
      platform: 'win32',
      osLabel,
      level: 'reliable',
      captureInvisible: true,
      label: 'Hidden from capture',
      headline: 'Hidden from screen capture',
      detail:
        'WDA_EXCLUDEFROMCAPTURE makes DWM composite the capture frame without ' +
        'this window, so the capturer receives what is behind it rather than a ' +
        'blank. This is the best case of any platform.',
      recommendation: 'Confirm on the demo machine before recording (spec 2.3).'
    };
  }

  return {
    platform: process.platform,
    osLabel: process.platform,
    level: 'none',
    captureInvisible: false,
    label: 'Visible in shares',
    headline: 'Visible in every screen share',
    detail:
      'Neither X11 nor Wayland has a capture-exclusion flag, so content ' +
      'protection is a no-op here.',
    recommendation: 'Use a display that is not being shared.'
  };
}

module.exports = {
  applyStealth,
  setContentProtection,
  raise,
  hideFromDock,
  disguiseProcess,
  activeDisplay,
  displayFor,
  capabilityReport,
  IS_MAC,
  IS_WIN
};
