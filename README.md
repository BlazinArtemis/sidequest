# SideQuest

I built SideQuest. It's a small overlay of mini-games — Tetris, 2048 and Snake —
that sits on top of whatever you're doing, with the option to hide it from screen
monitors (like Cluely), so you've got something to do in the moments AI tools
create: waiting on a prompt to finish, or half-listening in a meeting after your
part's done.

Press a hotkey, play for twenty seconds, press it again, gone.


## Games

**Tetris** — 10×20, 7-bag randomiser, wall kicks, ghost piece, proper line-clear
scoring. **2048** — 4×4, standard merge rules. **Snake** — 16×16, gets faster as
it eats. High scores are saved per game, and a run you leave mid-game is still
there when you come back.

Each game is one class with `reset` / `input` / `tick` / `render` and no idea the
rest of the app exists — no DOM, no IPC, no disk. That's why `test/games.test.js`
can run them in plain Node, and why adding a fourth game is one file and one
`<script>` tag.

## Controls

| Key | Does |
|---|---|
| `Cmd/Ctrl+Alt+G` | Show / hide the overlay |
| `Cmd/Ctrl+Alt+X` | Click-through — the mouse passes to the app underneath |
| `Cmd/Ctrl+Alt+J` | Next game |
| `Cmd/Ctrl+Shift+Esc` | Panic hide — only ever hides, never summons |
| `Esc` | Hide (or close Settings) |
| `Tab` | Next game |
| `P` pause · `R` restart | `Cmd/Ctrl+,` for settings |
| Arrows / WASD | Play. Tetris: `↑` rotate, `Space` hard drop |

The three global hotkeys are remappable in Settings. Pick one another app already
owns and it's refused, keeping your old binding — better than a hotkey that
silently does nothing.

The overlay takes keyboard focus when it's up, because arrow keys only reach a
focused window. The alternatives were registering arrow keys globally (breaks
every other app) or a native key hook (reads all your keystrokes). Neither felt
worth it for Snake.


## Running it

```bash
npm install
npm start               # dev run
npm test                # game logic + config + idle timing + Electron integration
```

No Dock icon, no taskbar entry, no window at startup. **It lives in the menu-bar
/ tray icon** — that's the only way to reach it, and to quit it.

> **`npm start` exits immediately?** Check for `ELECTRON_RUN_AS_NODE=1` in your
> environment. VS Code's integrated terminal inherits it, which makes the
> `electron` binary run as plain Node — no window, no tray, no clue. Run
> `env -u ELECTRON_RUN_AS_NODE npm start`.

### Packaging

```bash
npm run icons           # regenerate the tray glyph and app icons
npm run build:mac       # dmg (arm64 + x64)
npm run build:win       # NSIS installer + portable exe
```

Every icon is generated from one shape definition in `build/make-tray-icon.js`,
so there's no binary artwork to keep in sync. Builds aren't signed or notarised —
macOS will want a right-click → Open the first time, so warn whoever you send it
to before they hit it cold.

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
test/                          game logic and config in plain Node, plus a real
                               Electron integration suite
build/make-*-icon.js           the gamepad shape, and every icon built from it
```

Zero runtime dependencies, and Electron is pinned exactly — content protection
has regressed across Electron releases more than once, so re-check capture
behaviour after any bump.

A few things in `stealth.js` and `overlay.window.js` look redundant and aren't:
content protection is re-applied on every `show` because Windows has lost it
across hide/show twice; the macOS always-on-top level ladder exists because
`screen-saver` and `pop-up-menu` get rejected on some macOS/Electron combos; `dt`
is clamped in the RAF loop because a stalled window hands you a multi-second
delta that teleports the snake across the board.

## Before you demo it

`npm test` covers what a machine can check on one box. What it can't:

1. Share your full screen in Zoom/Meet/Teams, watch from a second device, toggle
   the overlay. **That's the whole product** — re-check it now and then, since
   conferencing apps keep changing their capture pipelines.
2. Second monitor: the overlay should appear on whichever one your cursor is on.
3. Full-screen Zoom on macOS: it should float above without switching Spaces.
4. Quit and relaunch: game, dock corner, opacity and high scores all restored.

## What's next

- More games.
- Possibly a hub for indie games, where people post theirs and we stream it.
  Streaming opens a real security surface, though, so that needs a design that
  answers for it before it's worth building.

## Licence

MIT, © 2026 Oluwaseyi Ajadi. Written from scratch — no code, assets or UI copy
taken from Cluely, OpenCluely, cheating-daddy, Glass, Pluely or anything else in
this category. The Electron overlay *pattern* is shared because it's the standard
shape for this kind of app; the implementation isn't.
