// renderer/overlay.js
// The shell: owns the canvas, the RAF loop, key routing and score persistence.
// Game modules know nothing about the DOM beyond the 2d context handed to them.

(function () {
  const THEME = { board: 'rgba(9, 11, 16, 0.55)', grid: 'rgba(255,255,255,0.05)' };

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const banner = document.getElementById('banner');
  const bannerTitle = document.getElementById('banner-title');
  const bannerSub = document.getElementById('banner-sub');
  const hint = document.getElementById('hint');
  const ctDot = document.getElementById('ct-dot');
  const capabilityEl = document.getElementById('capability');
  const bestWrap = document.getElementById('bestwrap');
  const pauseBtn = document.getElementById('pause');
  const tabs = Array.from(document.querySelectorAll('[data-game]'));

  // Kept short on purpose: the footer also carries the capability badge, which
  // is the one thing in this UI the user cannot afford to have truncated.
  const HINTS = {
    tetris: '↑ rotate · ←→ move · space drop',
    2048: '←↑→↓ slide · R restart',
    snake: '←↑→↓ steer · R restart'
  };

  let game = null;
  let gameId = null;
  let best = 0;
  let last = 0;
  let raf = 0;

  // One live instance per game, kept for the session. Switching tabs used to
  // construct a fresh board, which silently threw away a run in progress —
  // the games are now parked, not discarded.
  const instances = {};
  const submitted = {};      // id -> score already recorded for this game-over

  let pet = null;            // the idle creature, when the window is pet-sized
  let roster = [];           // canonical game order, supplied by main

  // Authoritative window state, owned by main. Never inferred here: the
  // renderer used to guess from edge events that were not sent at boot, which
  // is how an unopened board played itself to game over in the background.
  let winState = { visible: false, petMode: false, clickThrough: false, playable: false };
  const petMode = () => winState.petMode;

  // ---- suspension --------------------------------------------------------
  // A board advances only when nothing is suspending it. This replaces three
  // separate booleans (hiddenPause / settingsPause / switchPaused) that were
  // mutated from six handlers and had to encode "did we pause it, or did the
  // user?". Now the user's own pause is just game.paused, which the shell never
  // touches, and everything else is a named reason in this set.
  const suspensions = {};    // gameId -> Set of reason strings

  function reasons(id) {
    if (!suspensions[id]) suspensions[id] = new Set();
    return suspensions[id];
  }

  function suspend(id, reason) {
    if (!id) return;
    reasons(id).add(reason);
  }

  function release(id, reason) {
    if (!id) return;
    reasons(id).delete(reason);
  }

  // True when the board must not advance: the window is not showing a playable
  // game, the panel is over it, or the user paused it themselves.
  function halted() {
    if (!game || !gameId) return true;
    return reasons(gameId).size > 0 || game.paused || game.gameOver;
  }

  const settingsOpen = () => !!(window.SQSettings && window.SQSettings.isOpen());

  // ---- canvas sizing (HiDPI) -------------------------------------------
  // The canvas backing store must be sized in device pixels or everything is
  // blurry on Retina and on Windows display scaling.
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  // ---- game lifecycle ---------------------------------------------------
  async function load(id) {
    const Ctor = window.SQGames[id];
    if (!Ctor) return;

    // Park the outgoing board instead of abandoning it, and bank anything it
    // achieved — a record run left by switching tabs used to be lost.
    if (game && gameId && gameId !== id) {
      suspend(gameId, 'switched');
      persistScore(gameId, game.score);
    }

    gameId = id;
    if (!instances[id]) instances[id] = new Ctor();
    game = instances[id];
    release(id, 'switched');

    // Keys held during the switch belong to the old board.
    clearHeld();

    // Reasons that depend on current conditions rather than on transitions, so
    // they are recomputed on every load rather than tracked incrementally.
    syncSuspension();

    best = await window.sq.getHighScore(id);
    // A parked run may already be beating the stored best.
    if (game.score > best) best = game.score;
    bestEl.textContent = best;
    bestWrap.classList.toggle('beating', game.score > 0 && game.score >= best);
    hint.textContent = HINTS[id] || '';
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.game === id));

    banner.classList.remove('show');
    // Coming back to a finished board should still show that it finished.
    if (game.gameOver) showGameOver(false);

    last = 0;            // the parked board must not be charged for the gap
    pauseShown = null;   // force the pause button to re-read the new board
    syncPauseButton();
    window.sq.setGame(id);
    resize();
  }

  function showGameOver(isBest) {
    bannerTitle.textContent = isBest ? 'New best' : 'Game over';
    bannerSub.textContent = `${game.score} points — press R to play again`;
    banner.classList.add('show');
  }

  // Bank a score without waiting for game over.
  //
  // Scores used to persist ONLY from onGameOver, while the header showed the
  // live score as your best the moment it passed the stored value. Hide, switch
  // game or quit mid-run and the number you had just watched go up was never
  // written — silent loss, made worse by a UI that implied it was saved.
  // recordScore() only writes on an improvement, so this is idempotent.
  let lastPersisted = {};
  function persistScore(id, score) {
    if (!id || !Number.isFinite(score) || score <= 0) return;
    if (lastPersisted[id] === score) return;
    lastPersisted[id] = score;
    window.sq.submitScore(id, score).catch(() => {});
  }

  async function onGameOver() {
    if (submitted[gameId]) return;
    submitted[gameId] = true;
    const finished = gameId;
    const res = await window.sq.submitScore(finished, game.score);
    // The player may have switched tabs while the await was in flight.
    if (gameId !== finished) return;
    best = res.best;
    bestEl.textContent = best;
    showGameOver(res.isBest);
  }

  // ---- loop -------------------------------------------------------------
  // Frames are scheduled ONLY while the window is on screen.
  //
  // backgroundThrottling:false keeps the loop alive when the window is merely
  // unfocused (needed for click-through mode) — but it also defeated
  // throttling while HIDDEN, which is where this app spends almost all of its
  // life. Measured before this change: 60fps rendering into an invisible
  // canvas, all day, on a tray app meant to sit beside a video call.
  function scheduleFrames() {
    const shouldRun = winState.visible;
    if (shouldRun && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!shouldRun && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  let frameCount = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    frameCount++;

    // Clamp dt: a backgrounded or stalled window can hand us a multi-second
    // delta, which would teleport the snake across the board on resume.
    const dt = Math.min(100, now - (last || now));
    last = now;

    // Pet mode owns the canvas: the games are parked and must not tick, or a
    // Tetris run would quietly top out while the creature wanders about.
    if (petMode()) {
      if (pet) {
        pet.tick(dt, canvas.clientWidth, canvas.clientHeight);
        pet.render(ctx, canvas.clientWidth, canvas.clientHeight);
        // Bubble and dismiss button follow the creature around.
        if (petNear) {
          const r = pet.hitRadius();
          petBubble.style.left = `${pet.x}px`;
          petBubble.style.top = `${Math.max(16, pet.y - r - 6)}px`;
          petDismiss.style.left = `${pet.x + r + 2}px`;
          petDismiss.style.top = `${Math.max(2, pet.y - r - 12)}px`;
        }
      }
      return;
    }

    if (!game) return;

    drainRepeats(now);
    // The board advances only when nothing is suspending it. At boot that
    // includes 'hidden', which is why an unopened game no longer plays itself.
    if (!halted()) game.tick(dt);
    game.render(ctx, canvas.clientWidth, canvas.clientHeight, THEME);
    scoreEl.textContent = game.score;
    // Track the best live rather than only revealing it on game over: the
    // number is useless as a target if you only see it after the run ends.
    if (game.score > best) {
      best = game.score;
      bestEl.textContent = best;
      bestWrap.classList.add('beating');
    }
    syncPauseButton();

    if (game.gameOver) onGameOver();
    else if (game.paused && !banner.classList.contains('show')) {
      bannerTitle.textContent = 'Paused';
      bannerSub.textContent = 'P to resume';
      banner.classList.add('show');
    } else if (!game.paused && !game.gameOver) {
      banner.classList.remove('show');
    }
  }

  // ---- input ------------------------------------------------------------
  const KEYMAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down'
  };

  // Held-key auto-repeat, as [delay before repeating, interval], in ms.
  // The OS repeat is not usable for this: its ~500ms delay and user-configured
  // rate make a held ↓ feel broken rather than like a soft drop. Only Tetris
  // repeats — 2048 is turn-based, so a held key would fire off a burst of moves
  // the player never intended.
  const REPEAT = {
    left: [170, 45],
    right: [170, 45],
    down: [50, 35]   // soft drop: quick to engage, fast once it does
  };

  const held = new Map(); // action -> timestamp of its next repeat
  const clearHeld = () => held.clear();

  function actionFor(e) {
    let action = KEYMAP[e.code];
    // Tetris reads "up" as rotate and space as hard drop; the other two don't
    // use those, so the mapping is per-game rather than global.
    if (gameId === 'tetris') {
      if (action === 'up') action = 'rotate';
      if (e.code === 'Space') action = 'drop';
    }
    return action;
  }

  window.addEventListener('keydown', (e) => {
    if (!game) return;
    // settings.js owns the keyboard while its panel is up — it handles Esc in
    // the capture phase, and arrow keys there belong to the slider, not Tetris.
    if (settingsOpen()) return;
    // In pet mode `game` is a live parked board that is not on screen. Without
    // this, R would restart a hidden run and arrows would feed it input the
    // player could not see. showInactive() should mean the pet never holds
    // focus, but that is a macOS window-level detail, not a guarantee.
    if (petMode()) return;

    if (e.code === 'Escape') { window.sq.hide(); return; }
    if (e.code === 'Comma' && (e.metaKey || e.ctrlKey)) { window.SQSettings.show(); return; }
    if (e.code === 'KeyR') {
      game.input('restart');
      banner.classList.remove('show');
      submitted[gameId] = false;
      bestWrap.classList.remove('beating');
      clearHeld();
      return;
    }
    if (e.code === 'KeyP') { togglePause(); return; }
    if (e.code === 'Tab') { e.preventDefault(); cycle(); return; }

    const action = actionFor(e);
    if (!action) return;

    // Arrows and space scroll the page by default. In a fixed-size overlay
    // that manifests as the whole UI jumping a few pixels.
    e.preventDefault();

    // The OS is already repeating this key; our own timer owns the cadence.
    if (e.repeat) return;

    game.input(action);
    if (gameId === 'tetris' && REPEAT[action]) {
      held.set(action, performance.now() + REPEAT[action][0]);
    }
  });

  window.addEventListener('keyup', (e) => {
    const action = actionFor(e);
    if (action) held.delete(action);
  });

  // A key held while the window loses focus never delivers its keyup, which
  // would leave the piece sliding on its own when focus comes back.
  window.addEventListener('blur', clearHeld);

  function drainRepeats(now) {
    if (!held.size) return;
    if (!game || game.paused || game.gameOver) return;
    for (const [action, dueAt] of held) {
      if (now < dueAt) continue;
      game.input(action);
      held.set(action, now + REPEAT[action][1]);
    }
  }

  // Pausing was previously P-only and undiscoverable — nothing on screen said
  // it existed. The header button is the visible half; both routes land here so
  // the two can't disagree about state.
  function togglePause() {
    if (!game || game.gameOver) return;
    game.input('pause');
    // A held key must not keep firing into a paused board, and its keyup may
    // never arrive if the pause came from the button rather than the keyboard.
    clearHeld();
    // No bookkeeping needed any more: a user pause lives in game.paused, which
    // the shell never touches, so nothing can silently undo it.
    persistScore(gameId, game.score);
    syncPauseButton();
  }

  let pauseShown = null;
  function syncPauseButton() {
    const paused = !!(game && game.paused);
    // Called every frame, so only touch the DOM when the state actually flips.
    if (paused === pauseShown) return;
    pauseShown = paused;
    pauseBtn.textContent = paused ? '▶' : '❙❙';
    pauseBtn.title = paused ? 'Resume (P)' : 'Pause (P)';
    pauseBtn.classList.toggle('active', paused);
  }

  pauseBtn.addEventListener('click', togglePause);

  function cycle() {
    // roster comes from main (src/core/constants.js) so Tab and the cycle
    // hotkey can never iterate different lists.
    if (!roster.length) return;
    load(roster[(roster.indexOf(gameId) + 1) % roster.length]);
  }

  // The tabs sit in the header, which the settings panel does not cover — so
  // they stay clickable while it is open. Switching game behind a panel that
  // stays up looks like the click half-worked, so picking a game closes it.
  tabs.forEach((t) => t.addEventListener('click', () => {
    if (settingsOpen()) window.SQSettings.close();
    load(t.dataset.game);
  }));
  document.getElementById('hide').addEventListener('click', () => window.sq.hide());

  // ---- main-process events ---------------------------------------------
  window.sq.onSetGame((id) => load(id));

  // Recompute every suspension reason from current conditions. Idempotent, so
  // it can be called from anywhere without tracking who suspended what.
  function syncSuspension() {
    if (!gameId) return;
    const playable = winState.visible && !winState.petMode;
    if (playable) release(gameId, 'hidden'); else suspend(gameId, 'hidden');
    if (settingsOpen()) suspend(gameId, 'settings'); else release(gameId, 'settings');
    if (halted()) clearHeld();
  }

  // The single window-state handler. Main pushes this on every transition and
  // the renderer also asks for it at boot, so there is no edge to miss.
  window.sq.onState((next) => {
    const wasVisible = winState.visible;
    const wasPet = winState.petMode;
    winState = next || winState;

    document.body.classList.toggle('pet', winState.petMode);
    ctDot.classList.toggle('on', !!winState.clickThrough);
    hint.textContent = winState.clickThrough
      ? 'click-through ON — mouse passes under, keys still play'
      : (HINTS[gameId] || '');

    if (winState.petMode && !wasPet) enterPetMode();
    if (!winState.petMode && wasPet) leavePetMode();

    // Anything that just went off screen should bank what it earned.
    if (wasVisible && !winState.visible) persistScore(gameId, game && game.score);

    syncSuspension();
    if (winState.visible && !wasVisible) {
      last = 0;          // discard the delta accumulated while hidden
      resize();
    }
    scheduleFrames();
  });

  // Same rationale as the hidden reason: a board left running behind the
  // settings panel quietly loses the run while the user changes their opacity.
  window.addEventListener('sq:settings-open', () => {
    persistScore(gameId, game && game.score);
    syncSuspension();
  });

  window.addEventListener('sq:settings-close', () => {
    last = 0; // the panel may have been up for a while; drop the stale delta
    syncSuspension();
  });

  // ---- idle pet ---------------------------------------------------------
  let petAvatar = 'random';
  let petScale = 1;

  window.addEventListener('sq:pet-avatar', (e) => { petAvatar = e.detail; });
  window.addEventListener('sq:pet-scale', (e) => {
    petScale = e.detail;
    if (pet) pet.scale = petScale;
  });

  function pickAvatar() {
    const all = window.SQPets;
    if (petAvatar !== 'random' && all[petAvatar]) return all[petAvatar];
    const keys = Object.keys(all);
    return all[keys[Math.floor(Math.random() * keys.length)]];
  }

  // Pet mode is driven by the window-state handler above; these two just build
  // and tear down the creature. The board is parked by the 'hidden' suspension
  // reason, not here — the pet is never a reason to lose a run.
  function enterPetMode() {
    pet = new (pickAvatar())(petScale);
    last = 0;
    // The resize happens in main; wait a frame so clientWidth reflects it.
    requestAnimationFrame(resize);
  }

  function leavePetMode() {
    pet = null;
    petNear = false;
    petBubble.classList.remove('show');
    petDismiss.classList.remove('show');
    last = 0;
    requestAnimationFrame(resize);
  }

  const card = document.getElementById('card');
  const petBubble = document.getElementById('pet-bubble');
  // Generous next to a ~7px snake: the target is a creature you point at, not
  // a button. Still far smaller than the window, which is the whole point.
  const PET_REACH = 34;
  let petNear = false;

  const petDismiss = document.getElementById('pet-dismiss');

  card.addEventListener('click', () => {
    if (petMode()) window.sq.petPlay();
  });

  // Right-click anywhere on the creature shoos it away. Saying no has to be as
  // cheap as saying yes, and it cannot be "move the mouse away" — you have to
  // approach the thing to interact with it at all.
  card.addEventListener('contextmenu', (e) => {
    if (!petMode()) return;
    e.preventDefault();
    window.sq.petDismiss();
  });

  petDismiss.addEventListener('click', (e) => {
    e.stopPropagation();   // do not also count as "yes, let's play"
    window.sq.petDismiss();
  });

  // The window ignores the mouse while the cursor is away from the snake, so
  // these events arrive only because setIgnoreMouseEvents was given
  // `forward: true`. Without that this handler would never run.
  card.addEventListener('mousemove', (e) => {
    if (!petMode() || !pet) return;
    const near = Math.hypot(e.clientX - pet.x, e.clientY - pet.y) <= PET_REACH;
    if (near === petNear) return;
    petNear = near;
    // Become solid to the mouse only while actually over the creature.
    window.sq.petInteractive(near);
    petBubble.classList.toggle('show', near);
    petDismiss.classList.toggle('show', near);
    // Pointing at it counts as interest; don't let it wander off mid-approach.
    if (near) window.sq.petInterest();
  });

  card.addEventListener('mouseleave', () => {
    if (!petMode() || !petNear) return;
    petNear = false;
    window.sq.petInteractive(false);
    petBubble.classList.remove('show');
    petDismiss.classList.remove('show');
  });


  // ---- boot -------------------------------------------------------------
  // The badge answers "can they see this right now?" without opening Settings.
  // Wrong-but-confident is the failure that matters here, so it says what the
  // running OS actually does rather than what the app would like to be true.
  async function showCapability() {
    const caps = await window.sq.capabilities();
    capabilityEl.textContent = caps.label;
    capabilityEl.className = `ready ${caps.level}`;
    // The full explanation and the workaround live in Settings; the tooltip is
    // the middle step for someone who notices the badge and wants the why.
    capabilityEl.title = `${caps.headline}\n\n${caps.detail}` +
      (caps.recommendation ? `\n\n${caps.recommendation}` : '');
  }

  // Read-only diagnostics for the integration tests. No behaviour depends on
  // these; they exist because the window lifecycle is otherwise unobservable
  // from outside, which is precisely how a board that played itself while
  // hidden shipped with a green test suite.
  window.__sqState = () => ({ ...winState });
  window.__sqSuspended = () => halted();
  window.__sqReasons = () => (gameId ? [...reasons(gameId)] : []);
  window.__sqBoard = () => (game ? JSON.stringify(game) : null);
  window.__sqFrames = () => frameCount;

  (async function boot() {
    const cfg = await window.sq.getConfig();
    petAvatar = cfg.petAvatar || 'random';
    petScale = cfg.petScale || 1;
    roster = Array.isArray(cfg.games) && cfg.games.length ? cfg.games : Object.keys(window.SQGames);

    // Ask main what the window is doing BEFORE starting anything. Waiting for
    // a pushed event was the original defect: none is sent at boot, so the
    // renderer assumed it was visible and ran the game in a hidden window.
    winState = await window.sq.getState();
    document.body.classList.toggle('pet', winState.petMode);

    // A stored game id that no longer exists must not leave a blank canvas.
    const wanted = roster.includes(cfg.lastGame) ? cfg.lastGame : roster[0];
    await load(wanted);

    scheduleFrames();
    // Settings render after the game so the first paint is the board, not
    // chrome — the panel is hidden until asked for anyway.
    await window.SQSettings.init();
    await showCapability();
  })();
})();
