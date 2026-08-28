// src/ipc.js
// Every renderer -> main call lives here. The renderer has no Node access,
// so this is the entire trust boundary; keep it small and validating.

const { ipcMain, app, screen, powerMonitor } = require('electron');
const stealth = require('./core/stealth');

const GAMES = ['tetris', '2048', 'snake'];
const DOCKS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'];
const HOTKEY_SLOTS = ['hotkey', 'clickThroughHotkey', 'cycleGameHotkey'];
const PET_AVATARS = ['snake', 'pacman', 'robot', 'random'];
const PET_POSITIONS = ['cursor', 'dock'];

function registerIpc({ store, overlay, onShortcutsChanged, onStateChanged }) {
  // Anything the tray also displays has to tell the tray when the renderer
  // changes it, or the two views of the same setting drift apart.
  const changed = () => { if (onStateChanged) onStateChanged(); };

  ipcMain.handle('config:get', () => store.all());

  ipcMain.handle('config:set-game', (_e, game) => {
    if (!GAMES.includes(game)) throw new Error(`unknown game: ${game}`);
    return store.set('lastGame', game);
  });

  ipcMain.handle('config:set-dock', (_e, dock) => {
    if (!DOCKS.includes(dock)) throw new Error(`unknown dock: ${dock}`);
    const result = overlay.setDock(dock);
    changed();
    return result;
  });

  ipcMain.handle('config:set-opacity', (_e, value) => overlay.setOpacity(value));
  ipcMain.handle('config:set-scale', (_e, value) => overlay.setScale(value));

  ipcMain.handle('config:set-display', (_e, preference) => {
    const ok = preference === 'cursor' || preference === 'secondary' || Number.isInteger(preference);
    if (!ok) throw new Error(`unknown display preference: ${preference}`);
    const result = overlay.setPreferredDisplay(preference);
    changed();
    return result;
  });

  ipcMain.handle('config:list-displays', () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      primary: d.id === primaryId,
      label: `${d.size.width}×${d.size.height}${d.id === primaryId ? ' (primary)' : ''}`
    }));
  });

  ipcMain.handle('config:set-hotkey', (_e, { key, accelerator }) => {
    if (!HOTKEY_SLOTS.includes(key)) throw new Error(`unknown hotkey slot: ${key}`);
    if (typeof accelerator !== 'string' || !accelerator.trim()) {
      throw new Error('accelerator must be a non-empty string');
    }

    // A combo already owned by the OS or another app registers as false rather
    // than throwing. Storing it anyway would leave the user with a hotkey that
    // silently does nothing, so try it, and put the old one back if it loses.
    const previous = store.get(key);
    store.set(key, accelerator.trim());
    let results = onShortcutsChanged ? onShortcutsChanged() : [];

    const outcome = results.find((r) => r.accelerator === accelerator.trim());
    if (outcome && !outcome.registered) {
      store.set(key, previous);
      results = onShortcutsChanged ? onShortcutsChanged() : [];
      return { ok: false, accelerator: previous, conflict: accelerator.trim(), results };
    }

    return { ok: true, accelerator: store.get(key), conflict: null, results };
  });

  ipcMain.handle('config:set-content-protection', (_e, enabled) => {
    store.set('contentProtection', !!enabled);
    stealth.setContentProtection(overlay.win, !!enabled);
    return !!enabled;
  });

  ipcMain.handle('score:get', (_e, game) => store.getHighScore(game));

  ipcMain.handle('score:submit', (_e, { game, score }) => {
    if (!GAMES.includes(game)) throw new Error(`unknown game: ${game}`);
    const n = Number(score);
    if (!Number.isFinite(n) || n < 0) throw new Error('invalid score');
    const isBest = store.recordScore(game, Math.floor(n));
    return { isBest, best: store.getHighScore(game) };
  });

  ipcMain.handle('overlay:hide', () => { overlay.hide(); return true; });

  ipcMain.handle('overlay:click-through', (_e, on) => {
    const result = overlay.setClickThrough(on);
    changed();
    return result;
  });

  ipcMain.handle('config:set-pet', (_e, { enabled, idleSeconds, avatar, position, scale } = {}) => {
    if (typeof enabled === 'boolean') store.set('petEnabled', enabled);

    if (idleSeconds !== undefined) {
      const n = Number(idleSeconds);
      // A few seconds would have the pet interrupting active work; an hour
      // means it effectively never appears.
      if (!Number.isFinite(n) || n < 15 || n > 3600) throw new Error('idleSeconds out of range');
      store.set('petIdleSeconds', Math.round(n));
    }

    if (avatar !== undefined) {
      if (!PET_AVATARS.includes(avatar)) throw new Error(`unknown avatar: ${avatar}`);
      store.set('petAvatar', avatar);
    }

    if (scale !== undefined) overlay.setPetScale(scale);

    if (position !== undefined) {
      if (!PET_POSITIONS.includes(position)) throw new Error(`unknown pet position: ${position}`);
      store.set('petPosition', position);
    }

    return {
      enabled: store.get('petEnabled'),
      idleSeconds: store.get('petIdleSeconds'),
      avatar: store.get('petAvatar'),
      position: store.get('petPosition'),
      scale: store.get('petScale')
    };
  });

  // The pet was clicked, or hovered. Hovering just buys it more time on screen.
  ipcMain.handle('pet:play', () => { overlay.playFromPet(); return true; });
  ipcMain.handle('pet:dismiss', () => { overlay.dismissPet(); return true; });
  ipcMain.handle('pet:interest', () => { overlay.armPetLinger(); return true; });
  ipcMain.handle('pet:interactive', (_e, on) => overlay.setPetInteractive(!!on));

  // Live idle counter, so the settings panel can show what the OS actually
  // reports. "The pet never appears" is otherwise undiagnosable: it looks
  // identical whether the threshold is wrong, the feature is off, or something
  // on the machine keeps resetting the idle timer.
  ipcMain.handle('pet:idle-now', () => ({
    idle: powerMonitor.getSystemIdleTime(),
    threshold: store.get('petIdleSeconds'),
    enabled: !!store.get('petEnabled')
  }));

  ipcMain.handle('overlay:capabilities', () => ({
    ...stealth.capabilityReport(),
    version: app.getVersion(),
    electron: process.versions.electron,
    displayCount: screen.getAllDisplays().length
  }));
  ipcMain.handle('app:quit', () => { app.quit(); return true; });
}

module.exports = { registerIpc, GAMES, DOCKS, HOTKEY_SLOTS, PET_AVATARS, PET_POSITIONS };
