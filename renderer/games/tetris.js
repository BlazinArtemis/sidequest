// renderer/games/tetris.js
// Pure-logic Tetris. No DOM access except in render(ctx).
// Exposed as window.SQGames.tetris (classic <script> tag, no bundler).

(function (root) {
  const COLS = 10;
  const ROWS = 20;

  // Piece definitions as 4x4-agnostic matrices. Rotation = transpose + reverse rows.
  const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    O: [[1, 1], [1, 1]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]]
  };
  const KEYS = Object.keys(SHAPES);
  const COLORS = {
    I: '#5eead4', J: '#60a5fa', L: '#fbbf24', O: '#facc15',
    S: '#4ade80', T: '#c084fc', Z: '#f87171'
  };

  // Gravity in ms per row, indexed by level (0-9), then clamped.
  const GRAVITY = [800, 720, 630, 550, 470, 380, 300, 220, 130, 100, 80];

  // How long completed rows flash before the stack collapses. Without this the
  // clear happens inside one frame: the row is simply gone on the next paint,
  // which reads as "my line didn't clear" even though it did. Long enough to
  // register, short enough not to interrupt play.
  const CLEAR_MS = 260;

  // Lock delay. A piece that touches down does NOT lock immediately — you get
  // this long to still slide or rotate it, which is what makes the classic
  // "drop it, then tuck it sideways at the last moment" move possible. Each
  // successful move while grounded resets the timer, capped so you cannot stall
  // a piece forever by jiggling it.
  const LOCK_DELAY = 500;
  const MAX_LOCK_RESETS = 15;

  function rotate(matrix) {
    const n = matrix.length;
    const out = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) out[x][n - 1 - y] = matrix[y][x];
    }
    return out;
  }

  class Tetris {
    constructor() {
      this.id = 'tetris';
      this.name = 'Tetris';
      this.reset();
    }

    reset() {
      this.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
      this.bag = [];
      this.score = 0;
      this.lines = 0;
      this.level = 0;
      this.gameOver = false;
      this.paused = false;
      this.dropTimer = 0;
      // While set, the board is mid-clear: rows are flashing, gravity is
      // suspended and no new piece has spawned yet.
      this.clearing = null;
      this.spawn();
    }

    // 7-bag randomiser: fairer than pure random, standard in modern Tetris.
    nextKey() {
      if (this.bag.length === 0) {
        this.bag = KEYS.slice();
        for (let i = this.bag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
        }
      }
      return this.bag.pop();
    }

    spawn() {
      const key = this.nextKey();
      this.piece = {
        key,
        m: SHAPES[key].map((r) => r.slice()),
        x: Math.floor((COLS - SHAPES[key].length) / 2),
        y: 0
      };
      this.lockTimer = 0;
      this.lockResets = 0;
      // Deepest row this piece has reached. Falling to a new low refills the
      // reset budget, so a piece worked down a well keeps its slide window.
      this.lowestY = this.piece.y;
      // Immediate collision at spawn = topped out.
      if (this.collides(this.piece.m, this.piece.x, this.piece.y)) this.gameOver = true;
    }

    collides(m, px, py) {
      for (let y = 0; y < m.length; y++) {
        for (let x = 0; x < m[y].length; x++) {
          if (!m[y][x]) continue;
          const gx = px + x;
          const gy = py + y;
          if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
          if (gy >= 0 && this.grid[gy][gx]) return true;
        }
      }
      return false;
    }

    grounded() {
      return this.collides(this.piece.m, this.piece.x, this.piece.y + 1);
    }

    // Called after any successful move or rotation. While the piece is resting
    // on the stack this restarts the lock delay, which is the whole mechanism
    // behind sliding a piece into place after it has landed.
    touch() {
      if (!this.grounded()) return;
      if (this.lockResets >= MAX_LOCK_RESETS) return;
      this.lockResets++;
      this.lockTimer = 0;
    }

    move(dx) {
      if (this.gameOver || this.paused) return;
      if (!this.collides(this.piece.m, this.piece.x + dx, this.piece.y)) {
        this.piece.x += dx;
        this.touch();
      }
    }

    rotateCW() {
      if (this.gameOver || this.paused) return;
      const r = rotate(this.piece.m);
      // Wall kicks: try in place, then 1 and 2 cells either side.
      for (const dx of [0, -1, 1, -2, 2]) {
        if (!this.collides(r, this.piece.x + dx, this.piece.y)) {
          this.piece.m = r;
          this.piece.x += dx;
          this.touch();
          return;
        }
      }
    }

    softDrop() {
      if (this.gameOver || this.paused) return;
      if (!this.collides(this.piece.m, this.piece.x, this.piece.y + 1)) {
        this.piece.y += 1;
        this.score += 1;
        this.dropTimer = 0;
        if (this.piece.y > this.lowestY) {
          this.lowestY = this.piece.y;
          this.lockResets = 0;
        }
      }
      // Landing on the stack does NOT lock here. Holding ↓ to bring a piece
      // down and then tucking it sideways is the move this enables; locking on
      // contact would make it impossible.
    }

    hardDrop() {
      if (this.gameOver || this.paused) return;
      let dist = 0;
      while (!this.collides(this.piece.m, this.piece.x, this.piece.y + 1)) {
        this.piece.y += 1;
        dist++;
      }
      this.score += dist * 2;
      this.lock();
    }

    lock() {
      const { m, x, y, key } = this.piece;
      for (let ry = 0; ry < m.length; ry++) {
        for (let rx = 0; rx < m[ry].length; rx++) {
          if (!m[ry][rx]) continue;
          const gy = y + ry;
          const gx = x + rx;
          // Bounds are guaranteed by collides() for every move the player can
          // make, but writing grid[y][10] on a 10-wide row would silently widen
          // it to 11 rather than throwing, corrupting the board in a way that
          // is very hard to trace back here.
          if (gy < 0 || gy >= ROWS || gx < 0 || gx >= COLS) continue;
          this.grid[gy][gx] = key;
        }
      }

      const full = this.fullRows();
      if (full.length) {
        // Hold the completed rows on screen; tick() collapses them and spawns
        // the next piece once the flash has run.
        this.clearing = { rows: full, elapsed: 0 };
      } else {
        this.spawn();
      }
    }

    fullRows() {
      const rows = [];
      for (let y = 0; y < ROWS; y++) {
        if (this.grid[y].every((c) => c !== null)) rows.push(y);
      }
      return rows;
    }

    // Drop the given rows out of the stack and credit them. Split out from the
    // animation so the scoring rules stay directly testable.
    collapseRows(rows) {
      if (!rows.length) return;
      // Rebuild rather than splice in a loop: every splice+unshift shifts the
      // rows above it down by one, so a second index taken before the first
      // removal is already stale. Filtering sidesteps that entirely.
      const drop = new Set(rows);
      const kept = this.grid.filter((_, y) => !drop.has(y));
      while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(null));
      this.grid = kept;

      this.lines += rows.length;
      this.score += [0, 100, 300, 500, 800][rows.length] * (this.level + 1);
      this.level = Math.floor(this.lines / 10);
    }

    // Immediate clear, no animation. Kept because it is the honest unit of the
    // scoring rules and the test suite drives it directly.
    clearLines() {
      this.collapseRows(this.fullRows());
    }

    // action: 'left' | 'right' | 'down' | 'rotate' | 'drop' | 'pause' | 'restart'
    input(action) {
      if (action === 'restart') return this.reset();
      if (action === 'pause') { this.paused = !this.paused; return; }
      if (this.gameOver) return;
      // No piece exists between lock and the post-flash spawn.
      if (this.clearing) return;
      if (action === 'left') this.move(-1);
      else if (action === 'right') this.move(1);
      else if (action === 'down') this.softDrop();
      else if (action === 'rotate') this.rotateCW();
      else if (action === 'drop') this.hardDrop();
    }

    tick(dt) {
      if (this.gameOver || this.paused) return;

      // Rows are flashing: hold everything until the animation finishes, then
      // collapse and spawn. Gravity must not run here or the next piece would
      // start falling behind the flash.
      if (this.clearing) {
        this.clearing.elapsed += dt;
        if (this.clearing.elapsed >= CLEAR_MS) {
          const { rows } = this.clearing;
          this.clearing = null;
          this.collapseRows(rows);
          this.dropTimer = 0;
          this.spawn();
        }
        return;
      }

      // Resting on the stack: run the lock delay instead of gravity, so the
      // piece can still be slid or rotated until the timer runs out.
      if (this.grounded()) {
        this.lockTimer += dt;
        if (this.lockTimer >= LOCK_DELAY) this.lock();
        return;
      }

      // Airborne again (the player slid it off a ledge): cancel the countdown.
      this.lockTimer = 0;

      this.dropTimer += dt;
      const speed = GRAVITY[Math.min(this.level, GRAVITY.length - 1)];
      if (this.dropTimer >= speed) {
        this.dropTimer = 0;
        this.piece.y += 1;
        if (this.piece.y > this.lowestY) {
          this.lowestY = this.piece.y;
          this.lockResets = 0;
        }
      }
    }

    render(ctx, w, h, theme) {
      const cell = Math.floor(Math.min(w / COLS, h / ROWS));
      const ox = Math.floor((w - cell * COLS) / 2);
      const oy = Math.floor((h - cell * ROWS) / 2);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = theme.board;
      ctx.fillRect(ox, oy, cell * COLS, cell * ROWS);

      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      for (let x = 1; x < COLS; x++) {
        ctx.beginPath();
        ctx.moveTo(ox + x * cell + 0.5, oy);
        ctx.lineTo(ox + x * cell + 0.5, oy + ROWS * cell);
        ctx.stroke();
      }

      const block = (gx, gy, key) => {
        ctx.fillStyle = COLORS[key];
        ctx.fillRect(ox + gx * cell + 1, oy + gy * cell + 1, cell - 2, cell - 2);
      };

      const flashing = this.clearing ? new Set(this.clearing.rows) : null;

      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) if (this.grid[y][x]) block(x, y, this.grid[y][x]);
      }

      // Completed rows: strobe to white and shrink towards their centre line,
      // so a four-row clear reads as one deliberate event rather than the stack
      // teleporting down.
      if (flashing) {
        const t = Math.min(1, this.clearing.elapsed / CLEAR_MS);
        const pulse = 0.45 + 0.55 * Math.abs(Math.cos(t * Math.PI * 3));
        for (const y of flashing) {
          ctx.globalAlpha = pulse;
          ctx.fillStyle = '#ffffff';
          const shrink = Math.round((cell / 2) * t);
          ctx.fillRect(ox, oy + y * cell + shrink, cell * COLS, Math.max(1, cell - shrink * 2));
          ctx.globalAlpha = 1;
        }
      }

      if (!this.gameOver && !this.clearing) {
        const { m, x, y, key } = this.piece;
        // Ghost piece
        let gy = y;
        while (!this.collides(m, x, gy + 1)) gy++;
        ctx.globalAlpha = 0.22;
        for (let ry = 0; ry < m.length; ry++) {
          for (let rx = 0; rx < m[ry].length; rx++) if (m[ry][rx]) block(x + rx, gy + ry, key);
        }
        ctx.globalAlpha = 1;
        for (let ry = 0; ry < m.length; ry++) {
          for (let rx = 0; rx < m[ry].length; rx++) if (m[ry][rx]) block(x + rx, y + ry, key);
        }
      }
    }
  }

  root.SQGames = root.SQGames || {};
  root.SQGames.tetris = Tetris;
  if (typeof module !== 'undefined' && module.exports) module.exports = Tetris; // test harness only
})(typeof window !== 'undefined' ? window : globalThis);
