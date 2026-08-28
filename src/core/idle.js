// src/core/idle.js
// Decides when the idle pet should come out. Pure logic, no Electron, so the
// timing rules can actually be tested rather than eyeballed by leaving the
// machine alone and hoping.
//
// The one input from the OS is "seconds since the last keyboard or mouse event
// anywhere on this machine" (powerMonitor.getSystemIdleTime). Everything else
// here is bookkeeping about whether we have already acted on this stretch.

class IdleWatcher {
  constructor(settings) {
    // settings: () => ({ enabled, idleSeconds })
    this.settings = settings;
    this.sentThisIdle = false;
  }

  // Returns true when the pet should be shown right now.
  //
  // systemIdle:     seconds since the last input, from the OS
  // overlayVisible: the game is already on screen
  // petVisible:     the pet is already out
  poll(systemIdle, { overlayVisible = false, petVisible = false } = {}) {
    const { enabled, idleSeconds } = this.settings();
    if (!enabled) return false;

    const threshold = Number(idleSeconds) > 0 ? Number(idleSeconds) : 120;

    // Any input at all ends the episode and re-arms the pet for the next one.
    if (systemIdle < threshold) {
      this.sentThisIdle = false;
      return false;
    }

    // One appearance per stretch of idleness. Without this the pet would come
    // back the moment it timed out, over and over, all the while the user is
    // away from the desk.
    if (this.sentThisIdle) return false;

    // Re-checked on every poll rather than latched the first time the threshold
    // is crossed: if the game happened to be open at that moment, an
    // edge-triggered version would burn the single chance and never send the
    // pet, even after the user hid the game and walked away.
    if (overlayVisible || petVisible) return false;

    return true;
  }

  // Called once the pet is actually on screen.
  markSent() { this.sentThisIdle = true; }
}

module.exports = { IdleWatcher };
