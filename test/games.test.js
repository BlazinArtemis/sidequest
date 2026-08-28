const assert = require('assert');
const Tetris = require('../renderer/games/tetris.js');
const G2048 = require('../renderer/games/g2048.js');
const Snake = require('../renderer/games/snake.js');

// ---------- 2048 ----------
let c = G2048.collapse([2, 2, 2, 2]);
assert.deepStrictEqual(c.row, [4, 4, 0, 0], '2048: 2,2,2,2 -> 4,4');
assert.strictEqual(c.gained, 8);
c = G2048.collapse([2, 2, 4, 0]);
assert.deepStrictEqual(c.row, [4, 4, 0, 0], '2048: 2,2,4 -> 4,4');
c = G2048.collapse([4, 4, 8, 8]);
assert.deepStrictEqual(c.row, [8, 16, 0, 0]);
c = G2048.collapse([2, 0, 0, 2]);
assert.deepStrictEqual(c.row, [4, 0, 0, 0]);
c = G2048.collapse([0, 0, 0, 0]);
assert.strictEqual(c.moved, false, '2048: empty row does not count as a move');
c = G2048.collapse([4, 2, 0, 0]);
assert.strictEqual(c.moved, false, '2048: already-collapsed row does not count as a move');

const g = new G2048();
g.grid = [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
g.score = 0;
g.move('left');
assert.strictEqual(g.score, 4, '2048: score credited on merge');
assert.strictEqual(g.grid[0][0], 4);
// full board with no merges = game over
const g2 = new G2048();
g2.grid = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
assert.strictEqual(g2.hasMoves(), false, '2048: locked board reports no moves');
// Reaching 2048 wins but does NOT end the game — the spec calls for being able
// to keep playing past the win tile.
const gw = new G2048();
gw.grid = [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
gw.move('left');
assert.strictEqual(gw.won, true, '2048: 1024+1024 sets the win flag');
assert.strictEqual(gw.gameOver, false, '2048: winning does not end the game');
assert.strictEqual(gw.grid[0][0], 2048);

// ---------- Tetris ----------
const t = new Tetris();
assert.strictEqual(t.grid.length, 20);
assert.strictEqual(t.grid[0].length, 10);
// Piece never spawns out of bounds and never collides on an empty board
for (let i = 0; i < 200; i++) {
  const tt = new Tetris();
  assert.strictEqual(tt.gameOver, false, 'tetris: fresh board must not top out');
}
// 7-bag: 7 spawns cover all 7 keys exactly once
const seen = [];
const tb = new Tetris();
seen.push(tb.piece.key);
for (let i = 0; i < 6; i++) { tb.spawn(); seen.push(tb.piece.key); }
assert.strictEqual(new Set(seen).size, 7, 'tetris: 7-bag must yield 7 distinct pieces');
// Line clear
const tl = new Tetris();
tl.grid[19] = new Array(10).fill('T');
tl.grid[18] = new Array(10).fill('T');
tl.level = 0;
tl.clearLines();
assert.strictEqual(tl.lines, 2, 'tetris: two rows cleared');
assert.strictEqual(tl.score, 300, 'tetris: double = 300 at level 0');
assert.ok(tl.grid.every((r) => r.every((c2) => c2 === null)), 'tetris: board empty after clear');
assert.strictEqual(tl.grid.length, 20, 'tetris: row count preserved after clear');
// Hard drop lands and locks
const th = new Tetris();
th.piece = { key: 'O', m: [[1, 1], [1, 1]], x: 0, y: 0 };
th.hardDrop();
assert.strictEqual(th.grid[19][0], 'O', 'tetris: hard drop locks at floor');
assert.strictEqual(th.grid[18][1], 'O');
// Rotation stays inside walls
const tr = new Tetris();
tr.piece = { key: 'I', m: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], x: -1, y: 0 };
tr.rotateCW();
assert.ok(!tr.collides(tr.piece.m, tr.piece.x, tr.piece.y), 'tetris: rotation kicks off wall');
// Gravity locks a resting piece rather than hanging
const tg = new Tetris();
tg.piece = { key: 'O', m: [[1, 1], [1, 1]], x: 0, y: 18 };
tg.tick(1000);
assert.strictEqual(tg.grid[19][0], 'O', 'tetris: gravity locks piece on the floor');

// ---- lock delay: a landed piece can still be moved before it sets ----
// Touching down must not lock instantly, or the "drop it then tuck it
// sideways" move is impossible.
const tld = new Tetris();
tld.piece = { key: 'O', m: [[1, 1], [1, 1]], x: 0, y: 18 };
tld.lockTimer = 0; tld.lockResets = 0; tld.lowestY = 18;
tld.tick(200);
assert.strictEqual(tld.grid[19][0], null, 'tetris: piece has not locked yet at 200ms');
tld.input('right');
assert.strictEqual(tld.piece.x, 1, 'tetris: a grounded piece can still be moved');
tld.tick(400);
assert.strictEqual(tld.grid[19][0], null, 'tetris: moving reset the lock delay');
tld.tick(200);
assert.strictEqual(tld.grid[19][1], 'O', 'tetris: locks once the delay finally elapses');

// Soft drop onto the stack must not lock on contact
const tsd = new Tetris();
tsd.piece = { key: 'O', m: [[1, 1], [1, 1]], x: 0, y: 18 };
tsd.lockTimer = 0; tsd.lockResets = 0; tsd.lowestY = 18;
tsd.softDrop();
assert.strictEqual(tsd.grid[19][0], null, 'tetris: soft drop does not lock on contact');
tsd.input('right');
assert.strictEqual(tsd.piece.x, 1, 'tetris: can still tuck after a soft drop landing');

// Sliding off a ledge cancels the countdown and the piece keeps falling
const tledge = new Tetris();
tledge.grid[19][0] = 'T';
tledge.piece = { key: 'O', m: [[1, 1], [1, 1]], x: 0, y: 17 };
tledge.lockTimer = 0; tledge.lockResets = 0; tledge.lowestY = 17;
tledge.tick(300);
assert.strictEqual(tledge.lockTimer > 0, true, 'tetris: countdown running while grounded');
tledge.input('right');   // now over empty floor
tledge.tick(10);
assert.strictEqual(tledge.lockTimer, 0, 'tetris: countdown cancelled once airborne again');

// The reset budget is finite — a piece cannot be jiggled forever
const tstall = new Tetris();
tstall.piece = { key: 'O', m: [[1, 1], [1, 1]], x: 0, y: 18 };
tstall.lockTimer = 0; tstall.lockResets = 0; tstall.lowestY = 18;
for (let i = 0; i < 40; i++) {
  tstall.input(i % 2 ? 'left' : 'right');
  tstall.tick(60);
}
assert.strictEqual(tstall.grid[19].some((c) => c === 'O'), true, 'tetris: infinite stalling is capped');

// Hard drop still locks immediately, lock delay or not
const thd = new Tetris();
thd.piece = { key: 'O', m: [[1, 1], [1, 1]], x: 3, y: 0 };
thd.hardDrop();
assert.strictEqual(thd.grid[19][3], 'O', 'tetris: hard drop locks at once');
// Ten lines is one level, and a level must actually drop faster or the game
// never ramps.
const tv = new Tetris();
for (let y = 10; y < 20; y++) tv.grid[y] = new Array(10).fill('T');
tv.clearLines();
assert.strictEqual(tv.lines, 10, 'tetris: ten rows cleared');
assert.strictEqual(tv.level, 1, 'tetris: level advances every 10 lines');
const slowAtZero = (() => { const t0 = new Tetris(); t0.piece.y = 0; t0.tick(500); return t0.piece.y; })();
assert.strictEqual(slowAtZero, 0, 'tetris: level 0 has not dropped by 500ms');

// ---------- Snake ----------
const s = new Snake();
assert.strictEqual(s.body.length, 3);
s.input('down'); s.advance();
assert.deepStrictEqual(s.body[0], { x: 8, y: 9 }, 'snake: turns down');
// No 180-degree reversal
const s2 = new Snake();
s2.input('left');
assert.strictEqual(s2.queue.length, 0, 'snake: 180 rejected');
// Queued turns prevent same-tick reversal (right -> up -> left is legal, up then left)
const s3 = new Snake();
s3.input('up'); s3.input('left');
assert.strictEqual(s3.queue.length, 2, 'snake: two legal turns queue up');
s3.advance(); s3.advance();
assert.strictEqual(s3.gameOver, false, 'snake: queued turns do not self-collide');
// Edges wrap rather than kill
const s4 = new Snake();
s4.body = [{ x: 15, y: 8 }, { x: 14, y: 8 }];
s4.dir = { x: 1, y: 0 };
s4.food = { x: 0, y: 0 };
s4.advance();
assert.strictEqual(s4.gameOver, false, 'snake: wraps instead of dying at the wall');
assert.deepStrictEqual(s4.body[0], { x: 0, y: 8 }, 'snake: reappears on the far side');
// Wrapping works on every edge, and never lands off the board
const s4b = new Snake();
s4b.body = [{ x: 8, y: 0 }, { x: 8, y: 1 }];
s4b.dir = { x: 0, y: -1 };
s4b.food = { x: 3, y: 3 };
s4b.advance();
assert.deepStrictEqual(s4b.body[0], { x: 8, y: 15 }, 'snake: wraps upward to the bottom');
// Wrapping into your own body is still fatal — the fail state survives
// The wrapped-into cell must be mid-body, not the tail: the tail vacates on the
// same step, so following it round the edge is legal and must stay legal.
const s4c = new Snake();
s4c.body = [{ x: 15, y: 5 }, { x: 14, y: 5 }, { x: 0, y: 5 }, { x: 1, y: 5 }];
s4c.dir = { x: 1, y: 0 };
s4c.food = { x: 9, y: 9 };
s4c.advance();
assert.strictEqual(s4c.gameOver, true, 'snake: wrapping into yourself still ends the run');

const s4d = new Snake();
s4d.body = [{ x: 15, y: 5 }, { x: 14, y: 5 }, { x: 13, y: 5 }, { x: 0, y: 5 }];
s4d.dir = { x: 1, y: 0 };
s4d.food = { x: 9, y: 9 };
s4d.advance();
assert.strictEqual(s4d.gameOver, false, 'snake: wrapping onto the vacating tail is legal');
// Tail-follow is legal (tail vacates the cell in the same step)
const s5 = new Snake();
s5.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }];
s5.dir = { x: 0, y: 1 };
s5.food = { x: 0, y: 0 };
s5.advance();
assert.strictEqual(s5.gameOver, false, 'snake: may move into the vacating tail cell');
// Eating grows and scores
const s6 = new Snake();
s6.food = { x: 9, y: 8 };
const lenBefore = s6.body.length;
s6.advance();
assert.strictEqual(s6.body.length, lenBefore + 1, 'snake: grows on food');
assert.strictEqual(s6.score, 10);
// Fixed-step accumulator resolves multiple steps per frame without drift
const s7 = new Snake();
s7.tick(s7.step * 3 + 5);
assert.ok(s7.acc < s7.step, 'snake: accumulator drains');
// The queue is capped: a mash of arrow keys inside one step must not bank a
// sequence of turns that plays out over the following steps.
const s8 = new Snake();
s8.input('up'); s8.input('left'); s8.input('down'); s8.input('right');
assert.ok(s8.queue.length <= 2, 'snake: turn queue stays capped at 2');
// Food never lands under the snake, which would make it uneatable.
for (let i = 0; i < 200; i++) {
  const sf = new Snake();
  sf.body = [];
  for (let x = 0; x < 16; x++) sf.body.push({ x, y: 0 });
  sf.placeFood();
  assert.ok(sf.food, 'snake: food placed while space remains');
  assert.ok(
    !sf.body.some((b) => b.x === sf.food.x && b.y === sf.food.y),
    'snake: food must not spawn on the snake'
  );
}
// A completely full board has nowhere to put food; placeFood must not hang or
// return a bogus cell.
const sFull = new Snake();
sFull.body = [];
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) sFull.body.push({ x, y });
sFull.placeFood();
assert.strictEqual(sFull.food, null, 'snake: no food when the board is full');

// ---------- cross-cutting: the shell's contract with every game ----------
// overlay.js drives all three through the same five members and submits
// `score` on `gameOver`. A game missing one of these fails silently at runtime
// as a blank canvas, so assert the shape rather than trusting it.
for (const [id, Ctor] of [['tetris', Tetris], ['2048', G2048], ['snake', Snake]]) {
  const g3 = new Ctor();
  assert.strictEqual(g3.id, id, `${id}: id must match the highScores key`);
  assert.strictEqual(typeof g3.score, 'number', `${id}: score is read every frame`);
  assert.strictEqual(g3.gameOver, false, `${id}: must not start over`);
  assert.strictEqual(g3.paused, false, `${id}: must not start paused`);
  for (const method of ['reset', 'input', 'tick', 'render']) {
    assert.strictEqual(typeof g3[method], 'function', `${id}: ${method}() is required`);
  }
  // Every action the shell can send must be survivable by every game, even the
  // ones it does not use — overlay.js routes them generically.
  for (const action of ['left', 'right', 'up', 'down', 'rotate', 'drop', 'pause', 'restart']) {
    g3.input(action);
  }
  g3.input('pause'); // leave it running whatever the parity ended up
  if (g3.paused) g3.input('pause');
  g3.tick(16);
  assert.strictEqual(typeof g3.score, 'number', `${id}: score survived every action`);
}

// Pause must actually freeze the simulation, since hide/show relies on it.
const tp = new Tetris();
tp.input('pause');
const beforeY = tp.piece.y;
tp.tick(5000);
assert.strictEqual(tp.piece.y, beforeY, 'tetris: paused board does not fall');
const sp = new Snake();
sp.input('pause');
const headBefore = { ...sp.body[0] };
sp.tick(5000);
assert.deepStrictEqual(sp.body[0], headBefore, 'snake: paused snake does not move');

console.log('All game-logic assertions passed.');
