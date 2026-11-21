import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/game.ts';
import { startServers } from '../src/server.ts';

const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
let srv: Awaited<ReturnType<typeof startServers>>;
const clients: Client[] = [];

before(async () => {
  srv = await startServers({ store: new Store(), secret: SECRET, port: 0, controlPort: 0 });
});
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.close();
});

async function connect() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp/${SECRET}`)));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError ?? false, ...JSON.parse(r.content[0].text) };
}

const control = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${srv.controlPort}${path}`, init);
const humanMove = (cell: number) =>
  control('/api/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cell }) });

// fetch() cannot override Host/Origin freely, so use node:http.
function raw(path: string, headers: Record<string, string>, method = 'GET', body = '{"cell":0}'): Promise<number> {
  return new Promise((resolve, reject) =>
    request({ host: '127.0.0.1', port: srv.controlPort, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end(method === 'POST' ? body : undefined),
  );
}

test('initialize and discover tools over real MCP', async () => {
  const client = await connect();
  assert.equal(client.getServerVersion()?.name, 'mcp-tic-tac-toe');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_board', 'play_move', 'start_game']);
});

test('MCP requests without the authorized path are rejected', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const path of ['/mcp', '/mcp/wrong', `/mcp/${SECRET}x`, '/', '/api/move', '/api/state']) {
    const res = await fetch(`http://127.0.0.1:${srv.port}${path}`, { method: 'POST', headers, body });
    assert.equal(res.status, 404, path);
  }
});

test('control interface: board page served; bad Host, cross-origin and non-JSON moves rejected', async () => {
  const page = await control('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Tic-tac-toe/);
  const host = `127.0.0.1:${srv.controlPort}`;
  assert.equal(await raw('/api/state', { host: 'evil.example' }), 403);
  assert.equal(await raw('/api/move', { host, origin: 'https://evil.example', 'content-type': 'application/json' }, 'POST'), 403);
  assert.equal(await raw('/api/move', { host, 'content-type': 'text/plain' }, 'POST'), 415);
  assert.equal(await raw('/api/state', { host, 'x-forwarded-for': '203.0.113.7' }), 403);
});

test('control interface: malformed requests get 400 and do not crash the server', async () => {
  const host = `127.0.0.1:${srv.controlPort}`;
  assert.equal(await raw('//', { host }), 400);
  assert.equal(await raw('/games/%zz/summary', { host }), 400);
  assert.equal(await raw('/api/move', { host, 'content-type': 'application/json' }, 'POST', 'null'), 409); // rejected as a game error, not a crash
  assert.equal((await control('/api/state')).status, 200);
});

test('full game: human on web board, Claude via MCP, get_board wakes on human move', async () => {
  const client = await connect();
  const start = await call(client, 'start_game');
  const id = start.gameId;
  assert.equal(start.state, 'WAITING_FOR_HUMAN');

  const early = await call(client, 'play_move', { gameId: id, cell: 4 });
  assert.equal(early.code, 'NOT_YOUR_TURN');

  // X: 0, 1, 2 (wins). O: 3, 4.
  for (const [x, o] of [[0, 3], [1, 4]]) {
    const waiting = call(client, 'get_board', { gameId: id, waitSeconds: 5 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await humanMove(x)).status, 200);
    assert.equal((await waiting).state, 'CLAUDE_TURN');
    const taken = await call(client, 'play_move', { gameId: id, cell: x });
    assert.equal(taken.code, 'CELL_TAKEN');
    assert.equal((await call(client, 'play_move', { gameId: id, cell: o, comment: '<b>hi</b>' })).state, 'WAITING_FOR_HUMAN');
  }
  assert.equal((await humanMove(2)).status, 200);
  const end = await call(client, 'get_board', { gameId: id });
  assert.equal(end.state, 'X_WON');

  const board = await (await control('/api/state')).json();
  assert.equal(board.game.comment, '<b>hi</b>'); // rendered with textContent on the page
  assert.deepEqual(board.score, { human: 1, claude: 0, draws: 0 });

  const summary = await (await control(`/games/${id}/summary`)).json();
  assert.equal(summary.result, 'COMPLETED');
  assert.equal(summary.finalState, 'X_WON');
  assert.equal(summary.invalidMoves, 2);
  assert.equal(summary.calls.byTool.play_move, 5);
  assert.equal(summary.humanWaitMs.length, 3);
  assert.ok(!JSON.stringify(summary).includes(SECRET));
});

test('concurrent play_move calls: only one is accepted', async () => {
  const [a, b] = await Promise.all([connect(), connect()]);
  const g = await call(a, 'start_game'); // game 2: Claude starts
  assert.equal(g.state, 'CLAUDE_TURN');
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => call(i % 2 ? a : b, 'play_move', { gameId: g.gameId, cell: i % 9 })),
  );
  assert.equal(results.filter((r) => r.result === 'MOVE_ACCEPTED').length, 1);
  const view = await call(a, 'get_board', { gameId: g.gameId });
  assert.equal(view.freeCells.length, 8);
  assert.equal(view.state, 'WAITING_FOR_HUMAN');
});

test('invalid parameters and unknown game', async () => {
  const client = await connect();
  assert.equal((await call(client, 'get_board', { gameId: 'nope' })).code, 'UNKNOWN_GAME');
  const bad = (await client.callTool({ name: 'play_move', arguments: { gameId: 'x', cell: 12 } })) as { isError?: boolean };
  assert.equal(bad.isError, true);
});
