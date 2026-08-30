// preload.js
// contextIsolation is on, so the renderer sees exactly this object and nothing
// else — no ipcRenderer, no require, no process.

const { contextBridge, ipcRenderer } = require('electron');

// Wrap main -> renderer listeners so the renderer never receives the raw
// IpcRendererEvent (which leaks a sender handle across the bridge).
const on = (channel) => (cb) => {
  const wrapped = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('sq', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setGame: (game) => ipcRenderer.invoke('config:set-game', game),
  setDock: (dock) => ipcRenderer.invoke('config:set-dock', dock),
  setOpacity: (v) => ipcRenderer.invoke('config:set-opacity', v),
  setScale: (v) => ipcRenderer.invoke('config:set-scale', v),
  setDisplay: (pref) => ipcRenderer.invoke('config:set-display', pref),
  listDisplays: () => ipcRenderer.invoke('config:list-displays'),
  setHotkey: (key, accelerator) => ipcRenderer.invoke('config:set-hotkey', { key, accelerator }),
  setContentProtection: (on_) => ipcRenderer.invoke('config:set-content-protection', on_),
  setPet: (opts) => ipcRenderer.invoke('config:set-pet', opts),

  petPlay: () => ipcRenderer.invoke('pet:play'),
  petDismiss: () => ipcRenderer.invoke('pet:dismiss'),
  petInterest: () => ipcRenderer.invoke('pet:interest'),
  petInteractive: (on_) => ipcRenderer.invoke('pet:interactive', on_),
  petIdleNow: () => ipcRenderer.invoke('pet:idle-now'),

  getHighScore: (game) => ipcRenderer.invoke('score:get', game),
  submitScore: (game, score) => ipcRenderer.invoke('score:submit', { game, score }),

  hide: () => ipcRenderer.invoke('overlay:hide'),
  getState: () => ipcRenderer.invoke('overlay:get-state'),
  capabilities: () => ipcRenderer.invoke('overlay:capabilities'),
  quit: () => ipcRenderer.invoke('app:quit'),

  // One idempotent state push replaces overlay:shown / overlay:hidden /
  // overlay:pet-mode / overlay:click-through. Edge events could be missed —
  // none was sent at boot — and a missed edge left the renderer running a game
  // loop in a window it wrongly believed was on screen.
  onState: on('overlay:state'),
  onSetGame: on('overlay:set-game'),
  onOpenSettings: on('overlay:open-settings')
});
