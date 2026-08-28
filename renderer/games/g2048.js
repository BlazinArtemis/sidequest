// renderer/games/g2048.js
// 2048. Turn-based: tick() is a no-op, everything happens on input().
// File is named g2048.js because "2048.js" is a legal filename but an
// illegal bare identifier if it is ever imported as a module.

(function (root) {
  const N = 4;

  // Slide, then pop. Kept short: this sits in a window the player has seconds
  // for, so the animation has to read as responsive, not as a cutscene.
  const SLIDE_MS = 110;
  const POP_MS = 90;

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;

  const TILE_COLORS = {
    2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563',
    32: '#f67c5f', 64: '#f65e3b', 128: '#edcf72', 256: '#edcc61',
    512: '#edc850', 1024: '#edc53f', 2048: '#edc22e'
  };

  class G2048 {
    constructor() {
      this.id = '2048';
      this.name = '2048';
      this.reset();
    }

    reset() {
      this.grid = Array.from({ length: N }, () => new Array(N).fill(0));
      this.score = 0;
      this.gameOver = false;
      this.won = false;
      this.paused = false;
      this.anim = null;
      this.addTile();
      this.addTile();
    }

    // Returns the cell it filled, so the renderer can scale the new tile in
    // rather than having it blink into existence.
    addTile() {
      const empty = [];
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) if (this.grid[y][x] === 0) empty.push([x, y]);
      }
      if (!empty.length) return null;
      const [x, y] = empty[Math.floor(Math.random() * empty.length)];
      this.grid[y][x] = Math.random() < 0.9 ? 2 : 4;
      return { x, y };
    }

    // Collapse one row to the left. Returns { row, gained, moved, moves }.
    //
    // `moves` is the provenance of every tile: which index it started at and
    // which it ended at. The board alone cannot tell you that after the fact,
    // and without it there is nothing to animate — tiles would just teleport.
    static collapse(row) {
      const vals = [];
      for (let i = 0; i < row.length; i++) {
        if (row[i] !== 0) vals.push({ value: row[i], from: i });
      }

      const out = [];
      const moves = [];
      let gained = 0;

      for (let i = 0; i < vals.length; i++) {
        const to = out.length;
        if (vals[i + 1] && vals[i].value === vals[i + 1].value) {
          const merged = vals[i].value * 2;
          out.push(merged);
          gained += merged;
          // Both tiles travel to the same cell; the renderer stacks them there
          // and then pops the merged value once they arrive.
          moves.push({ from: vals[i].from, to, value: vals[i].value, merged: true });
          moves.push({ from: vals[i + 1].from, to, value: vals[i + 1].value, merged: true });
          i++; // skip the consumed tile — a tile merges at most once per move
        } else {
          out.push(vals[i].value);
          moves.push({ from: vals[i].from, to, value: vals[i].value, merged: false });
        }
      }

      while (out.length < N) out.push(0);
      const moved = out.some((v, i) => v !== row[i]);
      return { row: out, gained, moved, moves };
    }

    // Read the board as rows pointing in `dir`, so every move reuses collapse().
    lines(dir) {
      const res = [];
      for (let i = 0; i < N; i++) {
        const line = [];
        for (let j = 0; j < N; j++) {
          if (dir === 'left') line.push([j, i]);
          else if (dir === 'right') line.push([N - 1 - j, i]);
          else if (dir === 'up') line.push([i, j]);
          else line.push([i, N - 1 - j]); // down
        }
        res.push(line);
      }
      return res;
    }

    move(dir) {
      if (this.gameOver || this.paused) return false;
      let moved = false;
      const tiles = [];
      const mergedAt = new Set();

      for (const coords of this.lines(dir)) {
        const row = coords.map(([x, y]) => this.grid[y][x]);
        const r = G2048.collapse(row);
        if (r.moved) moved = true;
        this.score += r.gained;

        // Translate per-line indices back into board coordinates.
        for (const mv of r.moves) {
          const [fromX, fromY] = coords[mv.from];
          const [toX, toY] = coords[mv.to];
          tiles.push({ fromX, fromY, toX, toY, value: mv.value, merged: mv.merged });
          if (mv.merged) mergedAt.add(`${toX},${toY}`);
        }

        coords.forEach(([x, y], i) => { this.grid[y][x] = r.row[i]; });
      }

      if (moved) {
        const spawn = this.addTile();
        this.anim = { t: 0, tiles, mergedAt, spawn };
        if (!this.won && this.grid.some((r) => r.some((v) => v >= 2048))) this.won = true;
        if (!this.hasMoves()) this.gameOver = true;
      }
      return moved;
    }

    hasMoves() {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (this.grid[y][x] === 0) return true;
          if (x + 1 < N && this.grid[y][x] === this.grid[y][x + 1]) return true;
          if (y + 1 < N && this.grid[y][x] === this.grid[y + 1][x]) return true;
        }
      }
      return false;
    }

    input(action) {
      if (action === 'restart') return this.reset();
      if (action === 'pause') { this.paused = !this.paused; return; }
      if (['left', 'right', 'up', 'down'].includes(action)) this.move(action);
    }

    // The board itself is turn-based; only the animation has a clock.
    tick(dt) {
      if (!this.anim || this.paused) return;
      this.anim.t += dt;
      if (this.anim.t >= SLIDE_MS + POP_MS) this.anim = null;
    }

    render(ctx, w, h, theme) {
      const pad = 6;
      const size = Math.min(w, h);
      const cell = Math.floor((size - pad * (N + 1)) / N);
      const boardSize = cell * N + pad * (N + 1);
      const ox = Math.floor((w - boardSize) / 2);
      const oy = Math.floor((h - boardSize) / 2);

      const cellX = (x) => ox + pad + x * (cell + pad);
      const cellY = (y) => oy + pad + y * (cell + pad);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = theme.board;
      ctx.fillRect(ox, oy, boardSize, boardSize);

      // Empty slots, always: the sliding tiles are drawn over these.
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          ctx.fillStyle = theme.grid;
          ctx.fillRect(cellX(x), cellY(y), cell, cell);
        }
      }

      const tile = (px, py, v, scale) => {
        const s = cell * scale;
        const dx = px + (cell - s) / 2;
        const dy = py + (cell - s) / 2;
        ctx.fillStyle = TILE_COLORS[v] || '#3c3a32';
        ctx.fillRect(dx, dy, s, s);
        ctx.fillStyle = v <= 4 ? '#776e65' : '#f9f6f2';
        const base = v >= 1024 ? 0.30 : v >= 128 ? 0.36 : 0.44;
        ctx.font = `600 ${cell * base * scale}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(v), px + cell / 2, py + cell / 2);
      };

      const a = this.anim;

      // Sliding phase: draw the tiles as they were before the move, in transit.
      // The board already holds the post-move values, so it must not be drawn
      // here or merged results would appear before the tiles arrive.
      if (a && a.t < SLIDE_MS) {
        const e = easeOut(a.t / SLIDE_MS);
        for (const t of a.tiles) {
          tile(
            lerp(cellX(t.fromX), cellX(t.toX), e),
            lerp(cellY(t.fromY), cellY(t.toY), e),
            t.value,
            1
          );
        }
        return;
      }

      // Settled: the real board, with merges popping and the new tile growing in.
      const popT = a ? Math.min(1, (a.t - SLIDE_MS) / POP_MS) : 1;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const v = this.grid[y][x];
          if (!v) continue;

          let scale = 1;
          if (a) {
            if (a.mergedAt.has(`${x},${y}`)) {
              scale = 1 + 0.18 * Math.sin(popT * Math.PI); // overshoot and settle
            } else if (a.spawn && a.spawn.x === x && a.spawn.y === y) {
              scale = 0.3 + 0.7 * popT;
            }
          }
          tile(cellX(x), cellY(y), v, scale);
        }
      }
    }
  }

  root.SQGames = root.SQGames || {};
  root.SQGames['2048'] = G2048;
  if (typeof module !== 'undefined' && module.exports) module.exports = G2048;
})(typeof window !== 'undefined' ? window : globalThis);
