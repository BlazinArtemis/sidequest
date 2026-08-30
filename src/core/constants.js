// src/core/constants.js
// The one definition of every enumerated value in the app.
//
// These used to be duplicated: GAMES lived in src/ipc.js, the renderer's
// cycle() had its own literal array, and the HINTS table had a third copy.
// All three agreed by luck. Drift would have desynchronised the Tab key from
// the cycle-game hotkey — the classic "works in one path, not the other" bug.
// The renderer receives this list over IPC rather than keeping its own.

const GAMES = ['tetris', '2048', 'snake'];
const DOCKS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'];
const HOTKEY_SLOTS = ['hotkey', 'clickThroughHotkey', 'cycleGameHotkey'];
const PET_AVATARS = ['snake', 'pacman', 'robot', 'random'];
const PET_POSITIONS = ['cursor', 'dock'];

module.exports = { GAMES, DOCKS, HOTKEY_SLOTS, PET_AVATARS, PET_POSITIONS };
