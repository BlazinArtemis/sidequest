// renderer/games/snake.js
// Snake on a 16x16 grid. Fixed-step: tick(dt) accumulates until STEP_MS.

(function (root) {
  const N = 16;
  const START_STEP = 140;   // ms per move at the start
  const MIN_STEP = 70;      // fastest it ever gets
  const SPEEDUP = 3;        // ms shaved per food eaten
  const WRAP = true;        // edges wrap around; see advance()

  class Snake {
    constructor() {
      this.id = 'snake';
      this.name = 'Snake';
      this.reset();
    }

    reset() {
      this.body = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }];
      this.dir = { x: 1, y: 0 };
      // Queue of pending turns. Without this, two fast key presses inside one
      // step can reverse the snake into itself.
      this.queue = [];
      this.step = START_STEP;
      this.acc = 0;
      this.score = 0;
      this.gameOver = false;
      this.paused = false;
      this.placeFood();
    }

    placeFood() {
      const occupied = new Set(this.body.map((s) => `${s.x},${s.y}`));
      const free = [];
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) if (!occupied.has(`${x},${y}`)) free.push({ x, y });
      }
      this.food = free.length ? free[Math.floor(Math.random() * free.length)] : null;
    }

    input(action) {
      if (action === 'restart') return this.reset();
      if (action === 'pause') { this.paused = !this.paused; return; }
      if (this.gameOver || this.paused) return;
      const map = {
        up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
        left: { x: -1, y: 0 }, right: { x: 1, y: 0 }
      };
      const next = map[action];
      if (!next) return;
      const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
      if (next.x === -last.x && next.y === -last.y) return; // no 180s
      if (next.x === last.x && next.y === last.y) return;   // ignore repeats
      if (this.queue.length < 2) this.queue.push(next);
    }

    advance() {
      if (this.queue.length) this.dir = this.queue.shift();
      const head = { x: this.body[0].x + this.dir.x, y: this.body[0].y + this.dir.y };

      // Walls wrap instead of killing. This is a game played in twenty-second
      // bursts while half-watching a call: ending a run because you looked away
      // at the wrong moment is the clock's fault, not the player's. Running into
      // yourself still ends it, so there is a fail state that you own.
      // Flip WRAP to false for the classic walled game.
      if (WRAP) {
        head.x = (head.x + N) % N;
        head.y = (head.y + N) % N;
      } else if (head.x < 0 || head.x >= N || head.y < 0 || head.y >= N) {
        this.gameOver = true;
        return;
      }
      // The tail cell is about to be vacated, so it is only fatal if we are growing.
      const willGrow = this.food && head.x === this.food.x && head.y === this.food.y;
      const bodyToCheck = willGrow ? this.body : this.body.slice(0, -1);
      if (bodyToCheck.some((s) => s.x === head.x && s.y === head.y)) { this.gameOver = true; return; }

      this.body.unshift(head);
      if (willGrow) {
        this.score += 10;
        this.step = Math.max(MIN_STEP, this.step - SPEEDUP);
        this.placeFood();
      } else {
        this.body.pop();
      }
    }

    tick(dt) {
      if (this.gameOver || this.paused) return;
      this.acc += dt;
      while (this.acc >= this.step && !this.gameOver) {
        this.acc -= this.step;
        this.advance();
      }
    }

    render(ctx, w, h, theme) {
      const cell = Math.floor(Math.min(w, h) / N);
      const boardSize = cell * N;
      const ox = Math.floor((w - boardSize) / 2);
      const oy = Math.floor((h - boardSize) / 2);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = theme.board;
      ctx.fillRect(ox, oy, boardSize, boardSize);

      if (this.food) {
        ctx.fillStyle = '#f87171';
        ctx.beginPath();
        ctx.arc(ox + this.food.x * cell + cell / 2, oy + this.food.y * cell + cell / 2, cell * 0.32, 0, Math.PI * 2);
        ctx.fill();
      }

      this.body.forEach((s, i) => {
        ctx.fillStyle = i === 0 ? '#a7f3d0' : '#34d399';
        ctx.fillRect(ox + s.x * cell + 1, oy + s.y * cell + 1, cell - 2, cell - 2);
      });
    }
  }

  root.SQGames = root.SQGames || {};
  root.SQGames.snake = Snake;
  if (typeof module !== 'undefined' && module.exports) module.exports = Snake;
})(typeof window !== 'undefined' ? window : globalThis);
