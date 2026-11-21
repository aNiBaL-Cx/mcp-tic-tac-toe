import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError, MAX_CALLS_PER_GAME, Store } from '../src/game.ts';

const code = (c: string) => (e: GameError) => e.code === c;

test('game 1 starts with the human, game 2 with Claude', () => {
  const store = new Store();
  const g1 = store.start();
  assert.equal(g1.state, 'WAITING_FOR_HUMAN');
  assert.throws(() => store.start(), code('GAME_IN_PROGRESS'));
  // X wins on top row: X 0, O 3, X 1, O 4, X 2
  store.humanMove(0);
  store.play(g1.gameId, 3);
  store.humanMove(1);
  store.play(g1.gameId, 4);
  const end = store.humanMove(2);
  assert.equal(end.game?.state, 'X_WON');
  assert.deepEqual(end.game?.winLine, [0, 1, 2]);
  const g2 = store.start();
  assert.equal(g2.state, 'CLAUDE_TURN');
  assert.deepEqual(g2.score, { human: 1, claude: 0, draws: 0 });
});

test('Claude win and draw are detected', () => {
  const store = new Store();
  const g1 = store.start();
  for (const [x, o] of [[0, 4], [1, 2], [6, 3], [5, 7]]) {
    store.humanMove(x);
    store.play(g1.gameId, o);
  }
  assert.equal(store.humanMove(8).game?.state, 'DRAW'); // X0 X1 O2 / O3 O4 X5 / X6 O7 X8

  const g2 = store.start(); // Claude starts
  for (const [o, x] of [[4, 0], [2, 1]]) {
    store.play(g2.gameId, o);
    store.humanMove(x);
  }
  const win = store.play(g2.gameId, 6);
  assert.equal(win.state, 'O_WON');
  assert.throws(() => store.play(g2.gameId, 8), code('GAME_OVER'));
});

test('out-of-turn, occupied and invalid cells are rejected without state change', () => {
  const store = new Store();
  const { gameId } = store.start();
  assert.throws(() => store.play(gameId, 4), code('NOT_YOUR_TURN'));
  store.humanMove(4);
  assert.throws(() => store.humanMove(0), code('NOT_HUMAN_TURN'));
  const taken = store.play(gameId, 4);
  assert.equal(taken.ok, false);
  assert.equal('code' in taken && taken.code, 'CELL_TAKEN');
  assert.match(taken.message, /is taken/);
  assert.equal(taken.state, 'CLAUDE_TURN');
  store.play(gameId, 0);
  assert.throws(() => store.humanMove(0), code('INVALID_CELL'));
  assert.throws(() => store.humanMove(9), code('INVALID_CELL'));
  assert.equal(store.summary(gameId).invalidMoves, 1);
});

test('view never reveals hints, only board and free cells', () => {
  const store = new Store();
  const g = store.start();
  assert.deepEqual(g.freeCells, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(g.board, '0 | 1 | 2\n---------\n3 | 4 | 5\n---------\n6 | 7 | 8');
});

test('unknown and expired games; expiry frees a new start', () => {
  let t = 0;
  const store = new Store({ ttlMinutes: 1, now: () => t });
  assert.throws(() => store.getBoard('nope'), code('UNKNOWN_GAME'));
  const { gameId } = store.start();
  t = 61_000;
  assert.throws(() => store.getBoard(gameId), code('EXPIRED'));
  assert.throws(() => store.humanMove(0), code('NO_GAME'));
  assert.equal(store.summary(gameId).result, 'ABANDONED');
  assert.ok(store.start().gameId);
});

test('human wait time and summary', () => {
  let t = 0;
  const store = new Store({ now: () => t });
  const { gameId } = store.start();
  t = 5000;
  store.humanMove(4);
  store.play(gameId, 0, 'Hello!');
  t = 8000;
  store.humanMove(8);
  const s = store.summary(gameId);
  assert.deepEqual(s.humanWaitMs, [5000, 3000]);
  assert.equal(s.result, 'IN_PROGRESS');
  assert.equal(s.results.AUTONOMY_CONFIRMED_MANUALLY, null);
  assert.ok(!JSON.stringify(s).includes('Hello'), 'summary excludes Claude comments');
});

test('per-game call limit', () => {
  const store = new Store();
  const { gameId } = store.start();
  for (let i = 0; i < MAX_CALLS_PER_GAME; i++) store.recordCall(gameId, { tool: 'x', at: 0, durationMs: 0, ok: true });
  assert.throws(() => store.getBoard(gameId), code('CALL_LIMIT'));
  assert.notEqual(store.start().gameId, gameId, 'a game stuck at the limit does not block a new one');
});

test('human move rejects non-numeric cells', () => {
  const store = new Store();
  store.start();
  for (const cell of [null, '', [], true, '0']) assert.throws(() => store.humanMove(cell), code('INVALID_CELL'));
});
