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
  let hiddenPause = false;   // paused because the overlay was hidden
  let settingsPause = false; // paused because the settings panel is up

  // One live instance per game, kept for the session. Switching tabs used to
  // construct a fresh board, which silently threw away a run in progress —
  // the games are now parked, not discarded.
  const instances = {};
  const submitted = {};      // id -> score already recorded for this game-over
  const switchPaused = {};   // id -> we paused it on the way out, so we may resume it

  let pet = null;            // the idle creature, when the window is pet-sized
  let petMode = false;

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

    // Park the outgoing board instead of abandoning it.
    if (game && gameId && gameId !== id && !game.paused && !game.gameOver) {
      game.input('pause');
      switchPaused[gameId] = true;
    }

    gameId = id;
    if (!instances[id]) instances[id] = new Ctor();
    game = instances[id];

    // Resume only what we paused on the way out — a board the player paused
    // with P stays paused, the same rule the hide/show path follows.
    if (switchPaused[id] && game.paused) {
      game.input('pause');
      switchPaused[id] = false;
    }

    hiddenPause = false;
    settingsPause = false;
    // Keys held during the switch belong to the old board.
    clearHeld();

    // The game tabs live in the header, which the settings panel does not
    // cover — so a game can be swapped while the panel is up. Without this the
    // new board would run behind the panel, and closing the panel would then
    // pause it (the resume path fires against a flag set for the old game).
    if (settingsOpen() && !game.paused && !game.gameOver) {
      game.input('pause');
      settingsPause = true;
    }

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
  function frame(now) {
    raf = requestAnimationFrame(frame);

    // Clamp dt: a backgrounded or stalled window can hand us a multi-second
    // delta, which would teleport the snake across the board on resume.
    const dt = Math.min(100, now - (last || now));
    last = now;

    // Pet mode owns the canvas: the games are parked and must not tick, or a
    // Tetris run would quietly top out while the creature wanders about.
    if (petMode) {
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
    game.tick(dt);
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
    // The pause was deliberate, so don't let unhiding undo it.
    hiddenPause = false;
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
    const order = ['tetris', '2048', 'snake'];
    load(order[(order.indexOf(gameId) + 1) % order.length]);
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

  window.sq.onHidden(() => {
    // Auto-pause so a hidden board isn't quietly losing the run.
    clearHeld();
    if (game && !game.paused && !game.gameOver) { game.input('pause'); hiddenPause = true; }
  });

  window.sq.onShown(() => {
    last = 0; // discard the dt accumulated while hidden
    if (game && hiddenPause && game.paused) { game.input('pause'); hiddenPause = false; }
    resize();
  });

  // Same rationale as the hide auto-pause: a board left running behind the
  // settings panel quietly loses the run while the user changes their opacity.
  window.addEventListener('sq:settings-open', () => {
    clearHeld();
    if (game && !game.paused && !game.gameOver) { game.input('pause'); settingsPause = true; }
  });

  window.addEventListener('sq:settings-close', () => {
    last = 0; // the panel may have been up for a while; drop the stale delta
    if (game && settingsPause && game.paused) { game.input('pause'); settingsPause = false; }
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

  window.sq.onPetMode((on) => {
    petMode = !!on;
    document.body.classList.toggle('pet', petMode);

    if (petMode) {
      // Park whatever was mid-run; the pet is not a reason to lose a game.
      if (game && !game.paused && !game.gameOver) {
        game.input('pause');
        switchPaused[gameId] = true;
      }
      clearHeld();
      pet = new (pickAvatar())(petScale);
    } else {
      pet = null;
      // The window changed size, so the canvas backing store is now wrong.
      if (game && switchPaused[gameId] && game.paused) {
        game.input('pause');
        switchPaused[gameId] = false;
      }
    }
    last = 0;
    // The resize happens in main; wait a frame so clientWidth reflects it.
    requestAnimationFrame(resize);
  });

  const card = document.getElementById('card');
  const petBubble = document.getElementById('pet-bubble');
  // Generous next to a ~7px snake: the target is a creature you point at, not
  // a button. Still far smaller than the window, which is the whole point.
  const PET_REACH = 34;
  let petNear = false;

  const petDismiss = document.getElementById('pet-dismiss');

  card.addEventListener('click', () => {
    if (petMode) window.sq.petPlay();
  });

  // Right-click anywhere on the creature shoos it away. Saying no has to be as
  // cheap as saying yes, and it cannot be "move the mouse away" — you have to
  // approach the thing to interact with it at all.
  card.addEventListener('contextmenu', (e) => {
    if (!petMode) return;
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
    if (!petMode || !pet) return;
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
    if (!petMode || !petNear) return;
    petNear = false;
    window.sq.petInteractive(false);
    petBubble.classList.remove('show');
    petDismiss.classList.remove('show');
  });

  window.sq.onClickThrough((on) => {
    ctDot.classList.toggle('on', !!on);
    document.body.classList.toggle('click-through', !!on);
    // When the mouse passes through, keyboard still works only if the window
    // has focus, so tell the user plainly what state they're in.
    hint.textContent = on
      ? 'click-through ON — mouse passes under, keys still play'
      : (HINTS[gameId] || '');
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

  (async function boot() {
    const cfg = await window.sq.getConfig();
    petAvatar = cfg.petAvatar || 'random';
    petScale = cfg.petScale || 1;
    await load(cfg.lastGame || 'tetris');
    raf = requestAnimationFrame(frame);
    // Settings render after the game so the first paint is the board, not
    // chrome — the panel is hidden until asked for anyway.
    await window.SQSettings.init();
    await showCapability();
  })();
})();
