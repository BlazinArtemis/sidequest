# SideQuest

A hotkey-summoned game overlay for the dead air in AI-assisted calls.

Tools like Cluely capture your screen, send it to an LLM and surface an answer in
an invisible overlay. The documented failure mode across that whole category is
latency — seconds to tens of seconds of waiting while you still have to look
present on camera. SideQuest fills that window: press a hotkey, play Tetris, 2048
or Snake for twenty seconds, press it again, gone.

It has no AI in it. No screen capture, no audio, no network calls, no telemetry,
no accounts. It is a window that draws a game and asks the OS not to be recorded.

## What "invisible" actually means

This is the load-bearing claim, so it is stated precisely rather than flatly. It
all reduces to one Electron call, `setContentProtection(true)`, which maps to a
different OS primitive on each platform:

| Platform | Result |
|---|---|
| **Windows 10 build 19041+ / Windows 11** | `WDA_EXCLUDEFROMCAPTURE` — the window is **absent** from capture; what is behind it stays visible. Best case. |
| **Windows 10 before build 19041** | Falls back to `WDA_MONITOR` — content is hidden, but a **solid black rectangle** appears where the overlay sits. |
| **macOS 14 Sonoma and earlier** | `NSWindowSharingNone`, respected by CoreGraphics capture and by Chromium/WebRTC — Meet, Teams, Discord, Slack, OBS. |
| **macOS 15 Sequoia and later** | **Not honoured.** ScreenCaptureKit composites every visible window into the frame before an app can opt out. |
| **Linux** | No-op. There is no capture-exclusion flag on X11 or Wayland; the overlay is visible in every share. |

### How it works, and why only the compositor can do it

Worth understanding, because it explains exactly where the ceiling is.

Neither primitive blanks the window out. They make the **compositor build a
second frame for capture clients with this window omitted**, so the capturer
receives whatever is *behind* the overlay. It is camouflage, not erasure — and
it works because the compositor is the one process holding every window's
contents, so it is the only thing that can hand two different pictures to two
different consumers. `WDA_EXCLUDEFROMCAPTURE` is DWM doing this today;
`NSWindowSharingNone` was WindowServer doing it until macOS 15.

That is also why an application cannot reproduce it for itself. After macOS 15
there is one composite: any pixel we paint, both the user and the capturer see;
any pixel we don't, neither sees. An app painting "what should be behind me"
produces a window that is invisible to the viewer *and to the user* — an
elaborate way to close the window. Capturing the desktop ourselves to repaint it
does not help either, for the same reason, and it would require the Screen
Recording permission this app is built to avoid.

Windows shows the limit from the other side: `WDA_MONITOR` genuinely does
substitute content into the capture stream only — so the OS demonstrably *can*
differentiate — but the only value an app may put in that channel is black,
never arbitrary content. That restriction is deliberate. It exists to stop a
capture stream being made to show a scene that was never on the screen.

So on macOS 15+, no application can do this — not Cluely, not any of the
open-source clones, not Tauri. Apple's own Developer Technical Support says
there are no public APIs for preventing screen capture, and Electron's
implementation is two lines that set the one flag Apple stopped honouring. The
only remaining route is undocumented window-server calls, which this project
deliberately does not take: it breaks on every point release, cannot be cleanly
notarised, and the capability's main use is proctoring evasion.

**The app tells you which of these you are on.** A coloured badge sits in the
overlay footer at all times — green *Hidden from capture*, amber *Shows as a
black box*, red *Visible in shares* — resolved from the running OS version, not
from what the app would like to be true. Hover it for the reason; Settings
carries the full explanation and the workaround. An overlay that is visible in
the share looks identical to a hidden one from your side of the screen, so this
is the one piece of state the UI refuses to leave implicit.

### What to do instead, when content protection won't hold

1. **Demo on Windows 11.** Deterministic, current, easy to film.
2. **Put the overlay on a display you are not sharing.** Needs no API at all, so
   nothing can regress it — it works on macOS 15+, on Linux, everywhere. Settings
   → Display → *Secondary display*, or pick a specific monitor.
3. **Share a single window rather than the whole screen.** Window-scoped capture
   returns that window's content, not the region composited above it.

There is no auto-hide-when-capture-detected feature, and that is on purpose:
there is no public API to detect that another app is capturing, so every version
of it is a heuristic that fails silently — which is worse than no feature,
because you would trust it.

## Running it

```bash
npm install
npm run test:games      # pure game logic, no Electron needed (~50ms)
npm start               # dev run
npm test                # game logic + the Electron integration smoke test
```

The app has no Dock icon, no taskbar entry and no window at startup. **It lives
in the menu-bar / system-tray icon** — that is the only way to reach it, and to
quit it.

> **If `npm start` exits immediately, or `require('electron')` returns a string:**
> check for `ELECTRON_RUN_AS_NODE=1` in the environment. VS Code's integrated
> terminal inherits it from the extension host (which is itself Electron), and it
> makes the `electron` binary run as plain Node — no window, no `app`, no tray.
> Run `env -u ELECTRON_RUN_AS_NODE npm start`, or use a terminal outside the
> editor. This is an environment quirk, not a project setting, so it is not
> patched into the npm scripts.

### Packaging

```bash
npm run icons           # regenerate the tray glyph and the app icons
npm run build:mac       # dmg (arm64 + x64)
npm run build:win       # NSIS installer + portable exe
```

Every icon is generated from one shape definition in `build/make-tray-icon.js`
— the menu-bar template glyph, `icon.icns` and `icon.ico` — so there is no
binary artwork to keep in sync. `icon.icns` needs macOS (`iconutil`); the
generated files are committed, so a Windows build does not have to rebuild them.

For cold outreach the portable `.exe` is the better artefact than the installer:
it sidesteps installation entirely and an unsigned NSIS installer throws a
SmartScreen warning.

### Signing, honestly

There is no Developer ID or Windows certificate here, and that has consequences
worth knowing before you send a build to anyone.

With no identity in the keychain, electron-builder logs *"skipped macOS
application code signing"* and signs nothing — what it ships then carries only
the linker's ad-hoc signature on the main executable, with no sealed resources.
`spctl` rejects that outright ("code has no resources but signature indicates
they must be present"). `build/after-pack.js` closes that gap by ad-hoc signing
the bundle, so the `.app` is well-formed, passes `codesign --verify` and launches.

That is not the same as being distributable. A dmg downloaded from the internet
is quarantined, and without a Developer ID **and** notarisation, Gatekeeper will
still block the first launch — the recipient has to right-click → Open, or run
`xattr -dr com.apple.quarantine SideQuest.app`. Say that in the handover rather
than letting a reviewer hit it cold. If the build ever gets a real identity, the
hook detects it and leaves the signature alone.

## Controls

| Key | Does |
|---|---|
| `Cmd/Ctrl+Shift+G` | Show / hide the overlay |
| `Cmd/Ctrl+Shift+X` | Toggle click-through (mouse passes to the app underneath) |
| `Cmd/Ctrl+Shift+N` | Next game |
| `Cmd/Ctrl+Shift+Esc` | Panic hide — only ever hides, never summons |
| `Esc` | Hide (or close Settings) |
| `Tab` | Next game |
| `P` | Pause · `R` restart · `Cmd/Ctrl+,` settings |
| Arrows / WASD | Play. Tetris: `↑` rotate, `Space` hard drop |

All three global hotkeys are remappable in Settings. A combo already owned by
another app is refused and the previous binding is kept, rather than leaving you
with a hotkey that silently does nothing.

The overlay **takes keyboard focus** when shown. That is deliberate and is the
main design difference from a Cluely-style answer bar: arrow keys only reach a
focused window, and the two alternatives — registering arrows as global
shortcuts, or installing a native key hook — would respectively break every
other app on the machine, or turn this into software that reads all your
keystrokes.

## Games

Tetris (10×20, 7-bag randomiser, wall kicks, ghost piece, standard line-clear
scoring), 2048 (4×4, standard merge rules) and Snake (16×16, speeds up as it
eats). High scores persist per game.

Each game is a class with five members — `reset`, `input`, `tick`, `render`,
plus `id`/`score`/`gameOver`/`paused`. Games never touch the DOM, IPC or
persistence; the shell owns all of that, which is what lets `test/games.test.js`
run them in plain Node. Adding a fourth game is one file and one `<script>` tag.

## Privacy

No network calls, no telemetry, no analytics, no accounts, no capture of any
kind. The renderer runs under a CSP of `default-src 'none'` and has no Node
access. Config and high scores are a single JSON file in the OS user-data
directory.

**SideQuest requests no OS permissions at all** — not screen recording, not
microphone. Every Cluely-alike must request both, because they capture your
screen and listen to your call. This one has nothing to capture with.

## Layout

```
main.js                        lifecycle, tray, single-instance lock, display watch
preload.js                     the entire contextBridge surface
src/core/store.js              persisted config (zero dependencies)
src/core/stealth.js            content protection, always-on-top, per-OS verdict
src/managers/overlay.window.js the one window: create/show/hide/dock
src/managers/shortcuts.js      global hotkeys
src/ipc.js                     every renderer -> main handler; the trust boundary
renderer/overlay.html          shell markup, CSS, settings panel
renderer/overlay.js            RAF loop, key routing, score persistence
renderer/settings.js           settings panel, hotkey capture
renderer/games/*.js            tetris, g2048, snake
test/games.test.js             game logic, plain Node
test/smoke.electron.js         window/IPC/preload integration, real Electron
build/make-tray-icon.js        the gamepad shape + a small PNG encoder
build/make-app-icon.js         icon.icns / icon.ico from that same shape
```

There are **zero runtime dependencies** and Electron is pinned to an exact
version. Content-protection behaviour has regressed across Electron releases
more than once, so a version bump is not assumed safe — re-verify capture
behaviour on the demo machine after any bump.

Several things in `src/core/stealth.js` and `src/managers/overlay.window.js`
look redundant and are not: content protection is re-applied on every `show`
because Electron has regressed it across hide/show on Windows twice; the macOS
always-on-top level ladder exists because `screen-saver` and `pop-up-menu` are
rejected on some macOS/Electron combinations; `dt` is clamped in the RAF loop
because a stalled window hands you a multi-second delta that teleports the snake
across the board. Section 8 of the implementation spec has the full list.

## Verifying before you record

`npm test` covers everything a machine can check on one box. The manual matrix
below is the part it cannot — chiefly item 5, which is the entire product.

| # | Check | Expected |
|---|---|---|
| 1 | Press the hotkey | Overlay appears instantly at the dock corner, no flash |
| 2 | Press again | Hides; focus returns to the previous app |
| 3 | Play, hide mid-game, unhide | Exactly where you left it |
| 4 | Press `P`, hide, unhide | Still paused — a deliberate pause survives |
| 5 | Full-screen share in Zoom/Meet/Teams, watch from a second device, toggle | **Second device sees nothing appear** |
| 6 | Same, but share a single window | Also nothing (different capture path) |
| 7 | Toggle click-through, click the overlay | Click lands underneath; overlay stays visible |
| 8 | Move to a second monitor, toggle | Appears on the monitor the cursor is on |
| 9 | Full-screen Zoom on macOS, toggle | Floats above it without switching Spaces |
| 10 | Quit and relaunch | Game, dock, opacity and high scores all restored |
| 11 | Launch a second instance | It exits; the running one shows its overlay |
| 12 | Check Dock / taskbar / Cmd-Tab | No entry anywhere; tray icon only |
| 13 | Bind a hotkey another app owns | Refused, previous binding kept, warning shown |

Re-verify item 5 periodically rather than treating it as a one-time checkbox:
conferencing apps change their own capture pipelines, and OS point releases
change what the flag does.

## Licence

MIT, © 2026 Oluwaseyi Ajadi. Written from scratch. No code, assets or UI copy is
taken from Cluely, OpenCluely, cheating-daddy, Glass, Pluely or any other project
in this category — the Electron overlay *pattern* is shared because it is the
standard shape for this class of app, the implementation is not.
