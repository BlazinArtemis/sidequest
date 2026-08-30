// renderer/settings.js
// The settings panel. Lives in the same window and the same renderer as the
// game (spec 1.3: one window), so it has to coexist with the game's keyboard
// handling — hence the capture-phase listener and the sq:settings-* events
// that let the shell pause the board while the panel is up.
//
// Exposed as window.SQSettings so overlay.js can ask whether keys belong to it.

(function (root) {
  const panel = document.getElementById('settings');
  const openBtn = document.getElementById('settings-open');
  const closeBtn = document.getElementById('settings-close');

  const stealthCard = document.getElementById('stealth');
  const stealthHeadline = document.getElementById('stealth-headline');
  const stealthDetail = document.getElementById('stealth-detail');
  const stealthFix = document.getElementById('stealth-fix');

  const opacityInput = document.getElementById('opacity');
  const opacityVal = document.getElementById('opacity-val');
  const scaleInput = document.getElementById('scale');
  const scaleVal = document.getElementById('scale-val');
  const dockButtons = Array.from(document.querySelectorAll('[data-dock]'));
  const displaySelect = document.getElementById('display');
  const cpCheckbox = document.getElementById('content-protection');
  const cpNote = document.getElementById('cp-note');
  const CP_NOTE = cpNote ? cpNote.textContent : '';
  const petEnabled = document.getElementById('pet-enabled');
  const petIdle = document.getElementById('pet-idle');
  const petAvatarButtons = Array.from(document.querySelectorAll('#pet-avatar [data-avatar]'));
  const petPosition = document.getElementById('pet-position');
  const petScaleInput = document.getElementById('pet-scale');
  const petScaleVal = document.getElementById('pet-scale-val');
  const hotkeyButtons = Array.from(document.querySelectorAll('.hk'));
  const hotkeyNote = document.getElementById('hk-note');
  const buildLabel = document.getElementById('build');
  const quitBtn = document.getElementById('quit');

  let open = false;
  let recording = null; // { slot, button, previous } while capturing a combo
  let isMac = false;

  // ---- accelerator capture ---------------------------------------------
  // Electron accelerators are strings like "CommandOrControl+Shift+G". The
  // browser gives us a KeyboardEvent, so this is the translation layer.

  // e.code is deliberate over e.key: e.key reports the *result* of the
  // modifiers (Alt+G is "©" on macOS), which is not what registers.
  function keyToken(code) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
    if ((m = /^F(\d{1,2})$/.exec(code))) return code;
    if ((m = /^Arrow(Up|Down|Left|Right)$/.exec(code))) return m[1];

    const named = {
      Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab',
      Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
      Period: '.', Slash: '/', Backquote: '`'
    };
    return named[code] || null;
  }

  function accelFrom(e) {
    const mods = [];
    // CommandOrControl is the portable token: Cmd on macOS, Ctrl elsewhere.
    // Whichever key the user physically pressed, store the portable form so a
    // config file moved between machines still binds something sensible.
    if (isMac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl');
    if (isMac && e.ctrlKey) mods.push('Control');
    if (!isMac && e.metaKey) mods.push('Super');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');

    const key = keyToken(e.code);
    if (!key) return { pending: true };            // modifier held, no key yet
    // A bare key as a *global* shortcut would swallow that key in every other
    // app on the machine. Refuse rather than ship that.
    if (!mods.length) return { error: 'Needs at least one modifier.' };
    return { accelerator: mods.concat(key).join('+') };
  }

  function label(accelerator) {
    if (!accelerator) return 'unset';
    if (!isMac) return accelerator.replace(/CommandOrControl/g, 'Ctrl');
    return accelerator
      .replace(/CommandOrControl/g, '⌘')
      .replace(/Command/g, '⌘')
      .replace(/Control/g, '⌃')
      .replace(/Alt|Option/g, '⌥')
      .replace(/Shift/g, '⇧')
      .replace(/\+/g, '');
  }

  function stopRecording(button) {
    if (button) button.classList.remove('recording');
    recording = null;
  }

  async function commit(slot, button, accelerator) {
    const res = await root.sq.setHotkey(slot, accelerator);
    button.textContent = label(res.accelerator);
    button.dataset.accelerator = res.accelerator;
    if (res.ok) {
      hotkeyNote.textContent = '';
      hotkeyNote.classList.remove('warn');
    } else {
      // register() returns false when the OS or another app already owns the
      // combo; main reverts, so say so instead of leaving a dead hotkey.
      hotkeyNote.textContent = `${label(res.conflict)} is taken by another app — kept ${label(res.accelerator)}.`;
      hotkeyNote.classList.add('warn');
    }
  }

  // Capture phase: while the panel is up these keys are the panel's, and
  // while recording a combo every key is, or the game would react to the very
  // keys being bound.
  window.addEventListener('keydown', (e) => {
    if (recording) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        recording.button.textContent = label(recording.previous);
        stopRecording(recording.button);
        hotkeyNote.textContent = '';
        hotkeyNote.classList.remove('warn');
        return;
      }
      const result = accelFrom(e);
      if (result.pending) return;
      if (result.error) {
        hotkeyNote.textContent = result.error;
        hotkeyNote.classList.add('warn');
        return;
      }
      const { slot, button } = recording;
      stopRecording(button);
      commit(slot, button, result.accelerator);
      return;
    }

    if (open && e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, true);

  // Clicking anything else abandons a capture in progress. Without this the
  // button sits on "press keys…" indefinitely and the next keystroke anywhere
  // in the panel silently rebinds a hotkey.
  window.addEventListener('mousedown', (e) => {
    if (!recording || e.target === recording.button) return;
    recording.button.textContent = label(recording.previous);
    stopRecording(recording.button);
    hotkeyNote.textContent = '';
    hotkeyNote.classList.remove('warn');
  }, true);

  // ---- panel state ------------------------------------------------------
  function show() {
    if (open) return;
    open = true;
    panel.classList.add('show');
    document.body.classList.add('settings-open');
    hotkeyNote.textContent = '';
    hotkeyNote.classList.remove('warn');
    // Read config back rather than trusting what the panel last rendered: the
    // tray menu changes dock, display and click-through behind this panel.
    syncFromConfig();
    startIdlePolling();
    // The board would otherwise keep dropping pieces behind the panel.
    window.dispatchEvent(new CustomEvent('sq:settings-open'));
  }

  function close() {
    if (!open) return;
    open = false;
    if (recording) stopRecording(recording.button);
    panel.classList.remove('show');
    document.body.classList.remove('settings-open');
    stopIdlePolling();
    window.dispatchEvent(new CustomEvent('sq:settings-close'));
  }

  function toggle() { open ? close() : show(); }

  // ---- wiring -----------------------------------------------------------
  openBtn.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);
  quitBtn.addEventListener('click', () => root.sq.quit());

  // setOpacity both applies and persists, and a slider drag emits a stream of
  // input events — unthrottled that is dozens of config writes for one gesture.
  // 80ms is short enough that the window still appears to track the thumb.
  let opacityTimer = 0;
  opacityInput.addEventListener('input', () => {
    const pct = Number(opacityInput.value);
    opacityVal.textContent = `${pct}%`;
    clearTimeout(opacityTimer);
    opacityTimer = setTimeout(() => root.sq.setOpacity(pct / 100), 80);
  });

  // Same throttle rationale as opacity — a drag emits a stream of events and
  // each one resizes a window and writes the config.
  let scaleTimer = 0;
  scaleInput.addEventListener('input', () => {
    const pct = Number(scaleInput.value);
    scaleVal.textContent = `${pct}%`;
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(() => root.sq.setScale(pct / 100), 90);
  });

  dockButtons.forEach((b) => b.addEventListener('click', async () => {
    await root.sq.setDock(b.dataset.dock);
    dockButtons.forEach((o) => o.classList.toggle('on', o === b));
  }));

  displaySelect.addEventListener('change', () => {
    const v = displaySelect.value;
    root.sq.setDisplay(v === 'cursor' || v === 'secondary' ? v : Number(v));
  });

  cpCheckbox.addEventListener('change', async () => {
    // The handler used to echo the request back, so the box stayed ticked even
    // when the OS refused. Content protection is the product's central claim;
    // show what is actually in force.
    const res = await root.sq.setContentProtection(cpCheckbox.checked);
    cpCheckbox.checked = !!(res && res.applied);
    if (res && res.ok === false) {
      cpNote.textContent = 'The system refused this. Nothing is being excluded from capture.';
      cpNote.classList.add('warn');
    } else {
      cpNote.textContent = CP_NOTE;
      cpNote.classList.remove('warn');
    }
  });

  const petControls = [petIdle, petPosition, petScaleInput, ...petAvatarButtons];
  petEnabled.addEventListener('change', () => {
    root.sq.setPet({ enabled: petEnabled.checked });
    petControls.forEach((c) => { c.disabled = !petEnabled.checked; });
  });
  petIdle.addEventListener('change', () => root.sq.setPet({ idleSeconds: Number(petIdle.value) }));
  petPosition.addEventListener('change', () => root.sq.setPet({ position: petPosition.value }));

  petAvatarButtons.forEach((b) => b.addEventListener('click', async () => {
    const choice = b.dataset.avatar;
    await root.sq.setPet({ avatar: choice });
    petAvatarButtons.forEach((o) => o.classList.toggle('on', o === b));
    // overlay.js caches the choice for the next time the pet comes out.
    window.dispatchEvent(new CustomEvent('sq:pet-avatar', { detail: choice }));
  }));

  let petScaleTimer = 0;
  petScaleInput.addEventListener('input', () => {
    const pct = Number(petScaleInput.value);
    petScaleVal.textContent = `${pct}%`;
    clearTimeout(petScaleTimer);
    petScaleTimer = setTimeout(async () => {
      await root.sq.setPet({ scale: pct / 100 });
      window.dispatchEvent(new CustomEvent('sq:pet-scale', { detail: pct / 100 }));
      drawAvatarPreviews();
    }, 90);
  });

  // Live idle readout, polled only while the panel is open. This exists because
  // "the pet never showed up" has several indistinguishable causes, and seeing
  // the counter either climb or keep resetting tells them apart immediately.
  const idleLive = document.getElementById('idle-live');
  let idleTimer = 0;

  async function pollIdle() {
    try {
      const { idle, threshold, enabled } = await root.sq.petIdleNow();
      if (!enabled) {
        idleLive.textContent = 'Idle pet is switched off.';
        idleLive.classList.remove('warn');
      } else if (idle >= threshold) {
        idleLive.textContent = `Idle now: ${idle}s — past the ${threshold}s mark.`;
        idleLive.classList.remove('warn');
      } else {
        idleLive.textContent = `Idle now: ${idle}s of ${threshold}s. Counts up only while nothing touches the keyboard or mouse.`;
        idleLive.classList.remove('warn');
      }
    } catch (_) { /* window closing */ }
  }

  function startIdlePolling() {
    stopIdlePolling();
    pollIdle();
    idleTimer = setInterval(pollIdle, 1000);
  }

  function stopIdlePolling() {
    clearInterval(idleTimer);
    idleTimer = 0;
  }

  // Paint each avatar into its button so the choice shows the creature rather
  // than its name.
  function drawAvatarPreviews() {
    for (const b of petAvatarButtons) {
      const canvas = b.querySelector('canvas');
      if (!canvas || !root.SQPetPreview) continue;
      root.SQPetPreview(canvas.getContext('2d'), canvas.width, b.dataset.avatar);
    }
  }

  hotkeyButtons.forEach((b) => b.addEventListener('click', () => {
    if (recording) stopRecording(recording.button);
    recording = { slot: b.dataset.slot, button: b, previous: b.dataset.accelerator || '' };
    b.classList.add('recording');
    b.textContent = 'press keys…';
    hotkeyNote.textContent = 'Esc to cancel.';
    hotkeyNote.classList.remove('warn');
  }));

  async function refreshDisplays(preference) {
    const displays = await root.sq.listDisplays();
    displaySelect.innerHTML = '';

    const add = (value, text, disabled) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if (disabled) opt.disabled = true;
      displaySelect.appendChild(opt);
    };

    add('cursor', 'Follow cursor');
    // Offering "secondary" on a laptop-only session would be a setting that
    // silently does nothing, since displayFor() falls back to the cursor.
    add('secondary', displays.length > 1 ? 'Secondary display' : 'Secondary (none attached)', displays.length < 2);
    displays.forEach((d) => add(String(d.id), d.label));

    displaySelect.value = String(preference);
    // A display id saved while a monitor was attached is not in the list once
    // it is unplugged, which would leave the select blank.
    if (!displaySelect.value) displaySelect.value = 'cursor';
  }

  // Renders every control from the persisted config, so the panel is never
  // showing a value that main no longer holds.
  async function syncFromConfig() {
    const config = await root.sq.getConfig();

    const pct = Math.round((config.opacity ?? 0.95) * 100);
    opacityInput.value = pct;
    opacityVal.textContent = `${pct}%`;

    const scalePct = Math.round((config.scale ?? 1) * 100);
    scaleInput.value = scalePct;
    scaleVal.textContent = `${scalePct}%`;

    dockButtons.forEach((b) => b.classList.toggle('on', b.dataset.dock === config.dockPosition));
    cpCheckbox.checked = !!config.contentProtection;

    petEnabled.checked = !!config.petEnabled;
    petControls.forEach((c) => { c.disabled = !config.petEnabled; });
    // A stored value outside the preset list would leave the select blank.
    petIdle.value = String(config.petIdleSeconds);
    if (!petIdle.value) petIdle.value = '120';
    const chosen = config.petAvatar || 'random';
    petAvatarButtons.forEach((b) => b.classList.toggle('on', b.dataset.avatar === chosen));
    drawAvatarPreviews();

    const petPct = Math.round((config.petScale ?? 1) * 100);
    petScaleInput.value = petPct;
    petScaleVal.textContent = `${petPct}%`;

    petPosition.value = config.petPosition || 'cursor';
    if (!petPosition.value) petPosition.value = 'cursor';

    hotkeyButtons.forEach((b) => {
      const accelerator = config[b.dataset.slot] || '';
      b.dataset.accelerator = accelerator;
      if (!recording || recording.button !== b) b.textContent = label(accelerator);
    });

    await refreshDisplays(config.preferredDisplay);
    return config;
  }

  function renderStealth(caps) {
    stealthCard.className = caps.level;
    stealthHeadline.textContent = caps.headline;
    stealthDetail.textContent = caps.detail;
    stealthFix.textContent = caps.recommendation || '';
    buildLabel.textContent = `v${caps.version} · Electron ${caps.electron} · ${caps.osLabel}`;
  }

  // ---- boot -------------------------------------------------------------
  async function init() {
    // isMac has to land before any label() call, or hotkeys render with the
    // wrong glyphs on the first paint.
    const caps = await root.sq.capabilities();
    isMac = caps.platform === 'darwin';
    renderStealth(caps);
    await syncFromConfig();
  }

  root.sq.onOpenSettings(() => show());

  root.SQSettings = {
    init,
    show,
    close,
    toggle,
    isOpen: () => open
  };
})(window);
